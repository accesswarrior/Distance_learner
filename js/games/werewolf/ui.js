// js/werewolf/ui.js
// Renders everything after Start Game: role reveal, moderator controls,
// voting, night actions, reveals, and the win screen.
//
// TWO separate live data sources back this screen:
//   players — the PRIVATE /players collection for the moderator, and the
//     single private players/{uid} document for a regular player. Firestore
//     does NOT filter a collection query down to documents the requester can
//     read; an unfiltered collection query is rejected when its rule cannot
//     be proven for every document.
//   roster — the PUBLIC /roster collection. Safe for anyone to read in
//     full (name + alive/participation status only, never role). Every
//     screen element that needs OTHER players — the persistent roster,
//     vote targets, night-action targets — is built from this, not from
//     `players`. See engine.js's header comment for the full schema split.
//
// myRole() is a function, not a captured value, and is re-evaluated on
// every render — this is what makes Chief Werewolf succession show up on
// the newly-promoted player's own screen without needing a refresh.

let gameUnsubscribers = [];
let timerInterval = null;

function clearGameListeners() {
  gameUnsubscribers.forEach(u => u());
  gameUnsubscribers = [];
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// Which announcement types represent a "reveal" that the room should
// acknowledge before the moderator can move on. 'hunter_pending' is itself
// a waiting state, not a reveal, so it's excluded.
function announcementNeedsAck(announcement) {
  return !!announcement && announcement.type !== 'hunter_pending';
}

// Static reference modal — no game state, no Firestore reads. Same content
// for everyone (players and moderator alike), reachable from the lobby and
// from the game screen. Built with document.createElement the same way
// engine.js's confirmAction() builds its overlay, so it behaves the same
// way whichever screen it's opened from.
function showHowToPlayModal() {
  const roleRows = Object.entries(ROLE_DESCRIPTIONS)
    .map(([r, desc]) => `<li><span><strong>${esc(r.replace(/_/g, ' '))}</strong>: ${esc(desc)}</span></li>`)
    .join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay how-to-play-overlay';
  overlay.innerHTML = `
    <div class="modal-card large">
      <h3>How to Play</h3>
      <p>A round has three parts, repeated until one side wins:</p>
      <h4>🌙 Night</h4>
      <p>Everyone closes their eyes except whoever is acting. Roles act one at a time, always in the same order: Doctor, then the Werewolves' Chief, then Witch, then Seer. Nobody without a night action does anything during this part.</p>
      <h4>☀️ Day</h4>
      <p>Everyone wakes up, hears what happened overnight, and discusses out loud who they suspect.</p>
      <h4>🗳️ Vote</h4>
      <p>Everyone votes on their own phone. If the group's top pick is a Werewolf, that player is out. If not, nobody is — no name or count is revealed either way, so a wrong guess gives nothing away. If the vote ties, the tied players go to one runoff vote; if that ties too, nobody is out.</p>
      <p>Villagers win once every Werewolf is gone. Werewolves win once they equal or outnumber everyone left.</p>
      <h4>The roles</h4>
      <ul class="player-list">${roleRows}</ul>
      <div class="narrator-box">🎙️ Whoever creates the room runs the game as moderator. You don't need to memorize any of this to do that — once the game starts, a live narrator box tells the moderator exactly what to say and do at each step, in order. Switching who's moderating mid-game isn't supported yet, so decide before tapping "Create Room."</div>
      <button class="primary-btn how-to-play-close">Got it</button>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => document.body.removeChild(overlay);
  overlay.querySelector('.how-to-play-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

// Delegated listener, same pattern as auth.js's logout-btn: covers the
// button however many times lobby.js or ui.js's render() redraw it.
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('how-to-play-btn')) {
    showHowToPlayModal();
  }
});

function renderGameScreen(sessionId, playerId, isMod) {
  clearGameListeners();
  showScreen('role-screen');

  let sessionData = {};
  let players = [];            // private docs — see file header
  let roster = [];             // public docs — see file header
  let werewolfTeamIds = null;  // null = no confirmed data yet (not fetched, in flight, or failed); [] / array = confirmed data
  let voteCount = 0;
  let myVote = null;
  let nightActionsMap = {};       // moderator-only
  let myNightSubmitted = false;   // did I already act during the current step
  let seerCheckResult = null;     // local-only, never written to Firestore
  let witchWolfTargetName = null;
  let witchWolfTargetId = null;
  let witchWolfTargetFetched = false;

  // Drumroll: hold a genuinely new announcement behind a suspense banner
  // for a moment before revealing it.
  let showingSuspense = false;
  let displayedAnnouncementKey = null;
  let suspenseTimer = null;

  // Purely cosmetic, one-shot animation flags. Set to true right before a
  // render() that should show something new, then read-and-cleared inside
  // render() itself so a later render() (e.g. the 1s discussion-timer
  // tick, which redraws the same DOM from scratch every time) doesn't
  // replay the animation for content that hasn't actually changed.
  let lastKnownRole = null;   // tracks OUR OWN role doc — see the single-
                               // doc listener below, not the render loop.
  let roleCardFlip = false;   // role first appears / mine to see
  let roleCardGlow = false;   // promoted to Chief mid-game (succession)
  let sessionListenerPrimed = false; // false until the session listener's
                                      // first snapshot, so that first
                                      // snapshot never reads as a "change"
  let phaseOverlayTimer = null;

  function triggerPhaseOverlay(phase) {
    const el = document.getElementById('phase-overlay');
    if (!el) return;
    el.textContent = phase === 'night' ? '🌙' : '☀️';
    el.classList.add('visible');
    if (phaseOverlayTimer) clearTimeout(phaseOverlayTimer);
    phaseOverlayTimer = setTimeout(() => el.classList.remove('visible'), 900);
  }

  function myPrivateDoc() {
    return players.find(p => p.id === playerId) || {};
  }
  function myRole() {
    return myPrivateDoc().role || null;
  }
  function rosterOf(id) {
    return roster.find(p => p.id === id);
  }
  function activeRoster() {
    return roster.filter(p => p.participationStatus !== 'removed');
  }
  function aliveActiveRoster() {
    return activeRoster().filter(p => p.alive !== false);
  }

  // werewolfTeamIds stays null until we have REAL data — including while a
  // fetch is in flight and if it fails. A separate flag (not the data
  // itself) guards against re-fetching, so "no data yet" can never be
  // confused with "confirmed empty team": the Chief's target list is only
  // ever built once werewolfTeamIds is an actual array, never during or
  // after a failed fetch. This fails CLOSED — on a network error the Chief
  // just sees "loading" indefinitely rather than an unfiltered roster that
  // could let them target their own team. (A server-side check in
  // firestore.rules is the actual guarantee; this is the UX half of it.)
  let werewolfTeamFetchStarted = false;
  function fetchWerewolfTeamIfNeeded() {
    const role = myRole();
    if (werewolfTeamFetchStarted) return;
    if (role !== 'werewolf' && role !== 'chief_werewolf') return;
    werewolfTeamFetchStarted = true;
    db.collection(`werewolf_sessions/${sessionId}/secrets`).doc('werewolfTeam').get()
      .then(doc => { werewolfTeamIds = doc.exists ? (doc.data().ids || []) : []; render(); })
      .catch(err => {
        console.warn('Could not load werewolf team — leaving target list closed:', err);
        werewolfTeamFetchStarted = false; // allow a retry on the next render
        render();
      });
  }

  function renderAnnouncement(a) {
    if (a.type === 'werewolf_out') {
      return `<div class="banner reveal">🐺 A Werewolf was voted out: <strong>${esc(a.name)}</strong></div>`;
    }
    if (a.type === 'none') {
      return `<div class="banner reveal">Nobody was voted out.</div>`;
    }
    if (a.type === 'night_death') {
      return `<div class="banner reveal">💀 <strong>${a.names.map(esc).join(', ')}</strong> died during the night.</div>`;
    }
    if (a.type === 'no_night_death') {
      return `<div class="banner reveal">☀️ No one died last night.</div>`;
    }
    if (a.type === 'tie') {
      return `<div class="banner reveal">It's a tie between <strong>${a.names.map(esc).join(', ')}</strong> — vote again, only between them.</div>`;
    }
    if (a.type === 'still_tied') {
      return `<div class="banner reveal">Still tied between <strong>${a.names.map(esc).join(', ')}</strong> — no one is eliminated this round.</div>`;
    }
    if (a.type === 'hunter_pending') {
      return `<div class="banner">🏹 <strong>${esc(a.name)}</strong> has been eliminated and is choosing a final target before leaving the game...</div>`;
    }
    if (a.type === 'hunter_shot') {
      return `<div class="banner reveal">🏹 ${esc(a.hunterName)}'s final shot eliminated <strong>${esc(a.targetName)}</strong>!</div>`;
    }
    if (a.type === 'hunter_skipped') {
      return `<div class="banner reveal">🏹 ${esc(a.hunterName)} chose not to take a final shot.</div>`;
    }
    return '';
  }

  function render() {
    const roleContent = document.getElementById('role-content');
    if (!roleContent) return; // navigated away

    const myRec = myPrivateDoc();
    const myRosterEntry = rosterOf(playerId);
    const isRemoved = !!myRosterEntry && myRosterEntry.participationStatus === 'removed';
    const iAmAlive = !!myRosterEntry && !isRemoved && myRosterEntry.alive !== false;
    const phase = sessionData.phase || 'day';
    const nightStep = sessionData.nightStep || null;
    const role = myRole();

    // A Hunter's revenge shot takes over the whole screen for the Hunter
    // themselves, regardless of phase or suspense.
    if (!isMod && sessionData.pendingHunterShot === playerId) {
      let html = `<div class="banner">🏹 You've been eliminated — take your final shot before you leave the game!</div>`;
      html += `<h3>Choose someone to eliminate, or skip:</h3><ul class="player-list">`;
      aliveActiveRoster().filter(p => p.id !== playerId).forEach(p => {
        html += `<li><button class="hunter-target-btn secondary-btn" data-uid="${p.id}">${shownName(p)}</button></li>`;
      });
      html += `</ul><button id="hunter-skip-btn" class="secondary-btn">Skip — don't shoot anyone</button>`;
      roleContent.innerHTML = html;
      document.querySelectorAll('.hunter-target-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const target = rosterOf(btn.dataset.uid);
          const ok = await confirmAction({
            title: 'Take your final shot?',
            message: `Eliminate ${target ? (target.displayName || target.username) : 'this player'}? This cannot be undone.`,
            confirmLabel: 'Fire',
            danger: true
          });
          if (ok) {
            fireHunterShot(sessionId, playerId, btn.dataset.uid)
              .catch(err => { console.error('Hunter shot failed:', err); alert('Your shot could not be recorded. Tell the moderator.'); });
          }
        });
      });
      document.getElementById('hunter-skip-btn').addEventListener('click', () => {
        fireHunterShot(sessionId, playerId, null)
          .catch(err => { console.error('Hunter skip failed:', err); alert('That could not be recorded. Tell the moderator.'); });
      });
      return;
    }

    const roleLabel = role ? role.replace(/_/g, ' ').toUpperCase() : '';
    const roleCardClass = ['role-card', roleCardFlip && 'flip-in', roleCardGlow && 'succession-glow']
      .filter(Boolean).join(' ');
    roleCardFlip = false;
    roleCardGlow = false;
    let html = role
      ? `<div class="${roleCardClass}">You are: <strong>${roleLabel}</strong>${isRemoved ? ' — removed from the game' : (iAmAlive ? '' : ' — eliminated')}</div>`
      : `<div class="${roleCardClass}">You are the <strong>Game Master</strong> — running this round.</div>`;
    html += `<button class="how-to-play-btn">❓ How to Play</button>`;
    if (isRemoved && !isMod) {
      html += `<div class="banner">You have been removed from this game. You can watch, but you can no longer vote or take game actions.</div>`;
    }

    // The ack gate only exists during the day. (startNight also clears the
    // announcement, but this guard means a stale one can never hide the
    // night-action UI.) Count acks from currently-active players only, so a
    // removed player's earlier ack can't let the gate open early.
    const seenIds = sessionData.deathSeen || [];
    const needsAck = announcementNeedsAck(sessionData.announcement) && !sessionData.winner && phase !== 'night';
    const ackedCount = activeRoster().filter(p => seenIds.includes(p.id)).length;
    const totalActive = activeRoster().length;
    const iHaveAcked = seenIds.includes(playerId);

    if (sessionData.winner) {
      const side = sessionData.winner === 'werewolves' ? '🐺 Werewolves' : '🧑‍🌾 Villagers';
      html += `<div class="banner winner-banner reveal">${side} win!</div>`;
    } else if (showingSuspense) {
      html += `<div class="banner suspense-banner">🥁 The moment of truth...</div>`;
    } else if (sessionData.announcement && phase !== 'night') {
      html += renderAnnouncement(sessionData.announcement);
    } else if (phase === 'night') {
      html += `<div class="banner">🌙 Night${nightStep && nightStep !== 'done' ? ` — ${nightStep.replace(/_/g,' ')} acting` : ''}</div>`;
    }

    // Discussion timer — visible to everyone once the moderator starts it.
    if (sessionData.discussionTimerEndsAt && !sessionData.winner) {
      const remainingMs = sessionData.discussionTimerEndsAt - Date.now();
      if (remainingMs > 0) {
        const m = Math.floor(remainingMs / 60000);
        const s = Math.floor((remainingMs % 60000) / 1000);
        html += `<div class="timer-display">⏱ Discussion: ${m}:${s.toString().padStart(2, '0')}</div>`;
      } else {
        html += `<div class="timer-display">⏱ Time's up!</div>`;
      }
    }

    if (sessionData.roleComposition) {
      html += `<details class="composition-details"><summary>ℹ️ Role composition</summary><ul class="player-list">`;
      Object.entries(sessionData.roleComposition).forEach(([r, count]) => {
        html += `<li><span>${r.replace(/_/g, ' ')}</span><span>${count}</span></li>`;
      });
      html += `</ul></details>`;
    }

    if (isMod) {
      html += `<h3>All Roles</h3><ul class="player-list">`;
      players.forEach(p => {
        const eliminated = p.alive === false;
        const removed = p.participationStatus === 'removed';
        html += `<li>
          <span>${shownName(p)}: ${esc(p.role || '?')}${eliminated ? ' — eliminated' : ''}${removed ? ' (removed)' : ''}</span>
          ${(!eliminated && !removed) ? `<button class="eliminate-btn secondary-btn" data-uid="${p.id}">Eliminate</button>` : ''}
          ${!removed ? `<button class="remove-player-btn danger-btn mini-btn" data-uid="${p.id}">Remove</button>` : ''}
        </li>`;
      });
      html += `</ul>`;

      if (sessionData.roleComposition) {
        html += `<details class="composition-details"><summary>📖 What each role does</summary><ul class="player-list">`;
        Object.keys(sessionData.roleComposition).forEach(r => {
          html += `<li><span><strong>${r.replace(/_/g, ' ')}</strong>: ${esc(ROLE_DESCRIPTIONS[r] || '')}</span></li>`;
        });
        html += `</ul></details>`;
      }

      html += `<div class="narrator-box"><strong>🎙️ </strong>${esc(narratorLine(sessionData, nightActionsMap))}</div>`;

      if (sessionData.pendingHunterShot) {
        const hunter = rosterOf(sessionData.pendingHunterShot);
        html += `<p class="waiting-text">⏳ Waiting for ${hunter ? shownName(hunter) : 'the Hunter'} to take their final shot...</p>`;
        html += `<button id="skip-hunter-btn" class="secondary-btn">Skip Hunter Shot</button>`;
      } else if (needsAck && ackedCount < totalActive) {
        html += `<p class="waiting-text">⏳ Waiting for everyone to see this — ${ackedCount} of ${totalActive} have tapped "I've seen this."</p>`;
        html += `<button id="force-ack-btn" class="secondary-btn">Force Continue</button>`;
      } else if (!sessionData.winner) {
        if (phase === 'night') {
          html += `<div class="night-panel"><h3>Night sequence</h3>`;
          if (nightStep === 'done') {
            html += `<p>All night actions are in.</p><button id="end-night-btn" class="primary-btn">End Night</button>`;
          } else {
            const submitted = !!nightActionsMap[nightStep];
            html += `<p>Active: <strong>${nightStep.replace(/_/g,' ')}</strong> — ${submitted ? '✔️ chosen' : 'waiting for their choice...'}</p>`;
            html += `<button id="advance-night-btn" class="primary-btn">${submitted ? 'Next' : 'Skip / Next'}</button>`;
          }
          if (nightActionsMap.doctor) {
            const saved = rosterOf(nightActionsMap.doctor.targetId);
            html += `<p class="hint-text">Doctor is protecting: ${saved ? shownName(saved) : '—'}</p>`;
          }
          if (nightActionsMap.chief_werewolf) {
            const target = rosterOf(nightActionsMap.chief_werewolf.targetId);
            html += `<p class="hint-text">Chief Werewolf is targeting: ${target ? shownName(target) : '—'}</p>`;
          }
          if (nightActionsMap.witch) {
            const w = nightActionsMap.witch;
            const label = w.action === 'save' ? 'saving the werewolves\u2019 target'
              : w.action === 'poison' ? `poisoning ${shownName(rosterOf(w.targetId))}`
              : 'doing nothing tonight';
            html += `<p class="hint-text">Witch is ${label}</p>`;
          }
          html += `</div>`;
        } else if (!sessionData.votingOpen) {
          html += `<button id="start-night-btn" class="primary-btn">Start Night</button>`;
          html += `<button id="start-voting-btn" class="primary-btn">Start Voting</button>`;
          if (sessionData.discussionTimerMinutes && !sessionData.discussionTimerEndsAt) {
            html += `<button id="start-timer-btn" class="secondary-btn">Start Discussion Timer (${sessionData.discussionTimerMinutes} min)</button>`;
          }
        } else {
          const runoffNames = sessionData.voteEligibleTargets
            ? sessionData.voteEligibleTargets.map(id => shownName(rosterOf(id))).join(', ')
            : null;
          const eligibleVoters = aliveActiveRoster().length;
          const allVotesIn = voteCount >= eligibleVoters && eligibleVoters > 0;
          html += `<p>${voteCount} of ${eligibleVoters} eligible players voted${runoffNames ? ` — runoff: ${runoffNames}` : ''}</p>`;
          if (allVotesIn) {
            html += `<button id="reveal-voting-btn" class="primary-btn">Reveal Result</button>`;
          } else {
            html += `<button id="force-reveal-voting-btn" class="secondary-btn">Force Reveal</button>`;
            html += `<p class="hint-text">Normal reveal unlocks when every eligible player has voted.</p>`;
          }
        }
      } else {
        html += `<button id="play-again-btn" class="primary-btn">Play Again (same room)</button>`;
      }
    } else {
      // Regular players never see roles, but can always see who's in the
      // game and who's eliminated — from the safe, public roster.
      html += `<h3>Players</h3><ul class="player-list">`;
      activeRoster().forEach(p => {
        const eliminated = p.alive === false;
        html += `<li><span>${shownName(p)}${eliminated ? ' — eliminated' : ''}</span></li>`;
      });
      html += `</ul>`;

      if (sessionData.pendingHunterShot) {
        html += `<p class="waiting-text">⏳ Waiting for the Hunter's final shot...</p>`;
      } else if (needsAck && !iHaveAcked) {
        html += `<button id="ack-btn" class="primary-btn ack-btn">I've seen this</button>`;
      } else if (needsAck) {
        html += `<p class="waiting-text">Waiting for everyone else to see this...</p>`;
      } else if (phase === 'night' && !sessionData.winner) {
        if (role === nightStep && iAmAlive) {
          if (role === 'witch') {
            if (!witchWolfTargetFetched) {
              witchWolfTargetFetched = true;
              getWolfTarget(sessionId).then(targetId => {
                const target = rosterOf(targetId);
                witchWolfTargetId = targetId || null;
                witchWolfTargetName = targetId ? (target ? (target.displayName || target.username) : 'someone') : 'nobody (no kill chosen yet)';
                render();
              });
              html += `<p>Loading tonight's werewolf target...</p>`;
            } else if (!myNightSubmitted) {
              if (!witchWolfTargetId) {
                html += `<p class="hint-text waiting-text">The Chief Werewolf has not chosen a target yet. You cannot use the Heal Potion until there is an actual target.</p>`;
                html += `<button id="witch-recheck-btn" class="secondary-btn">Check again</button>`;
              } else {
                html += `<h3>The Werewolves' target tonight: <strong>${esc(witchWolfTargetName)}</strong></h3>`;
                if (!myRec.healPotionUsed) {
                  html += `<button class="witch-save-btn primary-btn">Use Heal Potion — Save ${esc(witchWolfTargetName)}</button>`;
                }
              }
              if (!myRec.poisonPotionUsed) {
                html += `<p>Or use your Poison Potion instead:</p><ul class="player-list">`;
                aliveActiveRoster().filter(p => p.id !== playerId).forEach(p => {
                  html += `<li><button class="witch-poison-btn secondary-btn" data-uid="${p.id}">Poison ${shownName(p)}</button></li>`;
                });
                html += `</ul>`;
              }
              html += `<button id="witch-none-btn" class="secondary-btn">Do nothing tonight</button>`;
            } else {
              html += `<p>Your choice is locked in.</p>`;
            }
          } else if (role === 'seer') {
            if (seerCheckResult) {
              html += `<div class="banner">${esc(seerCheckResult.targetName)} is ${seerCheckResult.isWerewolf ? 'a 🐺 Werewolf' : 'not a Werewolf'}.</div>`;
            } else {
              html += `<h3>Choose someone to check:</h3><ul class="player-list">`;
              aliveActiveRoster().filter(p => p.id !== playerId).forEach(p => {
                html += `<li><button class="night-target-btn secondary-btn" data-uid="${p.id}">${shownName(p)}</button></li>`;
              });
              html += `</ul>`;
            }
          } else if (role === 'chief_werewolf') {
            fetchWerewolfTeamIfNeeded();
            if (werewolfTeamIds === null) {
              html += `<p>Loading your pack...</p>`;
            } else if (!myNightSubmitted) {
              const targets = aliveActiveRoster().filter(p => !werewolfTeamIds.includes(p.id));
              html += `<h3>Choose someone to eliminate:</h3><p class="hint-text">Fellow werewolves aren't shown here — you can't target your own pack.</p><ul class="player-list">`;
              targets.forEach(p => {
                html += `<li><button class="night-target-btn secondary-btn" data-uid="${p.id}">${shownName(p)}</button></li>`;
              });
              html += `</ul>`;
            } else {
              html += `<p>Your choice is locked in.</p>`;
            }
          } else if (role === 'doctor') {
            if (!myNightSubmitted) {
              html += `<h3>Choose someone to save:</h3><ul class="player-list">`;
              aliveActiveRoster().forEach(p => {
                html += `<li><button class="night-target-btn secondary-btn" data-uid="${p.id}">${shownName(p)}</button></li>`;
              });
              html += `</ul>`;
            } else {
              html += `<p>Your choice is locked in.</p>`;
            }
          }
        } else if (nightStep === 'chief_werewolf' && (role === 'werewolf') && iAmAlive) {
          // Ordinary werewolves get no action, but they should know their
          // pack so the out-loud discussion actually works.
          fetchWerewolfTeamIfNeeded();
          if (werewolfTeamIds && werewolfTeamIds.length) {
            const names = werewolfTeamIds.filter(id => id !== playerId).map(id => shownName(rosterOf(id))).join(', ');
            html += `<p>🐺 It's the werewolves' turn. Your fellow werewolves: <strong>${names || '(just you and the Chief)'}</strong>. Discuss quietly, then wait for the Chief to choose.</p>`;
          } else {
            html += `<p>🐺 It's the werewolves' turn. Discuss quietly, then wait for the Chief to choose.</p>`;
          }
        } else {
          html += `<p class="waiting-text">Waiting for the moderator...</p>`;
        }
      } else if (sessionData.votingOpen && iAmAlive && !sessionData.winner) {
        const eligibleIds = sessionData.voteEligibleTargets || null;
        const heading = eligibleIds ? 'Runoff vote — pick one:' : 'Vote to eliminate:';
        html += `<h3>${heading}</h3><ul class="player-list" id="vote-list">`;
        aliveActiveRoster()
          .filter(p => p.id !== playerId)
          .filter(p => !eligibleIds || eligibleIds.includes(p.id))
          .forEach(p => {
            const selected = myVote === p.id;
            html += `<li><button class="vote-btn secondary-btn${selected ? ' selected' : ''}" data-uid="${p.id}">${shownName(p)}${selected ? ' ✔️' : ''}</button></li>`;
          });
        html += `</ul>`;
        if (myVote) html += `<p>Your vote is in — tap another name to change it.</p>`;
      }
    }

    if (isMod && myRosterEntry === undefined) {
      // moderator has no roster/player doc — nothing extra to show here
    }

    html += `<a class="link-btn secondary-btn" href="../hub.html">← All games</a>`;
    html += `<button class="logout-btn secondary-btn">Log out</button>`;
    // Every render rebuilds the DOM from scratch; remember which <details>
    // panels were open so a redraw doesn't snap them shut under the user.
    const openDetails = Array.from(roleContent.querySelectorAll('details')).map(d => d.open);
    roleContent.innerHTML = html;
    roleContent.querySelectorAll('details').forEach((d, i) => { if (openDetails[i]) d.open = true; });

    if (isMod) {
      document.querySelectorAll('.eliminate-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const target = players.find(p => p.id === btn.dataset.uid);
          const ok = await confirmAction({
            title: 'Eliminate this player?',
            message: `${shownNamePlain(target)} will be marked eliminated. Their role is not revealed to the room.`,
            confirmLabel: 'Eliminate',
            danger: true
          });
          if (ok) eliminatePlayer(sessionId, btn.dataset.uid);
        });
      });
      document.querySelectorAll('.remove-player-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const target = players.find(p => p.id === btn.dataset.uid);
          const ok = await confirmAction({
            title: 'Remove this player from the game?',
            message: `${shownNamePlain(target)} will be removed entirely — excluded from voting, win checks, and Chief succession. They can still watch.`,
            confirmLabel: 'Remove',
            danger: true
          });
          if (ok) removePlayerFromGame(sessionId, btn.dataset.uid);
        });
      });
      const startVotingBtn = document.getElementById('start-voting-btn');
      if (startVotingBtn) startVotingBtn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Start voting?', message: 'Players will now vote on who to eliminate.', confirmLabel: 'Start Voting' });
        if (ok) startVoting(sessionId);
      });
      const revealBtn = document.getElementById('reveal-voting-btn');
      if (revealBtn) revealBtn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Reveal the vote?', message: 'This locks in the current tally.', confirmLabel: 'Reveal' });
        if (ok) revealVoting(sessionId, false);
      });
      const forceRevealBtn = document.getElementById('force-reveal-voting-btn');
      if (forceRevealBtn) forceRevealBtn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Force reveal with missing votes?', message: 'Not every eligible player has voted. Reveal the current tally anyway?', confirmLabel: 'Force Reveal', danger: true });
        if (ok) revealVoting(sessionId, true);
      });
      const startNightBtn = document.getElementById('start-night-btn');
      if (startNightBtn) startNightBtn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Start night?', message: 'This begins the night sequence with the Doctor.', confirmLabel: 'Start Night' });
        if (ok) startNight(sessionId);
      });
      const advanceBtn = document.getElementById('advance-night-btn');
      if (advanceBtn) advanceBtn.addEventListener('click', async () => {
        const submitted = !!nightActionsMap[nightStep];
        if (!submitted) {
          const ok = await confirmAction({ title: `Skip ${nightStep.replace(/_/g, ' ')}?`, message: 'This role has not submitted an action. Skip this step and continue?', confirmLabel: 'Skip' });
          if (!ok) return;
        }
        advanceNight(sessionId, nightStep);
      });
      const endNightBtn = document.getElementById('end-night-btn');
      if (endNightBtn) endNightBtn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'End night?', message: 'This will resolve the night actions and move the game to day.', confirmLabel: 'End Night' });
        if (ok) endNight(sessionId);
      });
      const playAgainBtn = document.getElementById('play-again-btn');
      if (playAgainBtn) playAgainBtn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Start a rematch?', message: 'The current game will be reset and everyone who remains will need to Ready again.', confirmLabel: 'Play Again' });
        if (ok) resetSessionForRematch(sessionId);
      });
      const skipHunterBtn = document.getElementById('skip-hunter-btn');
      if (skipHunterBtn) skipHunterBtn.addEventListener('click', async () => {
        const ok = await confirmAction({ title: 'Skip the Hunter\u2019s shot?', message: 'Use this only if their phone is unavailable.', confirmLabel: 'Skip', danger: true });
        if (ok) skipHunterShot(sessionId);
      });
      const forceAckBtn = document.getElementById('force-ack-btn');
      if (forceAckBtn) forceAckBtn.addEventListener('click', () => {
        db.collection('werewolf_sessions').doc(sessionId).update({
          deathSeen: activeRoster().map(p => p.id)
        }).catch(err => console.warn('Force continue failed:', err));
      });
      const startTimerBtn = document.getElementById('start-timer-btn');
      if (startTimerBtn) startTimerBtn.addEventListener('click', () => {
        const minutes = sessionData.discussionTimerMinutes || 3;
        db.collection('werewolf_sessions').doc(sessionId).update({
          discussionTimerEndsAt: Date.now() + minutes * 60000
        }).catch(err => console.warn('Could not start timer:', err));
      });
    } else {
      const ackBtn = document.getElementById('ack-btn');
      if (ackBtn) ackBtn.addEventListener('click', () => {
        db.collection('werewolf_sessions').doc(sessionId).update({
          deathSeen: firebase.firestore.FieldValue.arrayUnion(playerId)
        }).catch(err => console.warn('Acknowledgment failed:', err));
      });
      document.querySelectorAll('.vote-btn').forEach(btn => {
        btn.addEventListener('click', () => castVote(sessionId, playerId, btn.dataset.uid));
      });
      document.querySelectorAll('.night-target-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const targetId = btn.dataset.uid;
          const target = rosterOf(targetId);
          const label = role === 'doctor' ? 'save' : role === 'chief_werewolf' ? 'eliminate' : 'check';
          const ok = await confirmAction({
            title: `Confirm your choice`,
            message: `${label.charAt(0).toUpperCase() + label.slice(1)} ${target ? (target.displayName || target.username) : 'this player'} tonight?`,
            confirmLabel: label.charAt(0).toUpperCase() + label.slice(1),
            danger: role === 'chief_werewolf'
          });
          if (!ok) return;

          if (role === 'seer') {
            // The Seer's target is never written to nightActions/seer —
            // only { done: true } is, via markSeerDone. checkPlayer() does
            // its own narrowly-permitted one-off read instead.
            const isWolf = await checkPlayer(sessionId, targetId);
            seerCheckResult = { targetName: target ? (target.displayName || target.username) : 'That player', isWerewolf: isWolf };
            await markSeerDone(sessionId);
          } else {
            const landed = await submitNightAction(sessionId, role, targetId);
            if (!landed) return;
          }
          myNightSubmitted = true;
          render();
        });
      });
      const witchSaveBtn = document.querySelector('.witch-save-btn');
      if (witchSaveBtn) {
        witchSaveBtn.addEventListener('click', async () => {
          const ok = await confirmAction({
            title: 'Use your Heal Potion?',
            message: `Save ${witchWolfTargetName}? This uses your only Heal Potion for the game.`,
            confirmLabel: 'Save'
          });
          if (!ok) return;
          if (!(await submitWitchAction(sessionId, playerId, 'save', null))) return;
          myNightSubmitted = true;
          render();
        });
      }
      document.querySelectorAll('.witch-poison-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const target = rosterOf(btn.dataset.uid);
          const ok = await confirmAction({
            title: 'Use your Poison Potion?',
            message: `Poison ${target ? (target.displayName || target.username) : 'this player'}? This cannot be undone and uses your only Poison Potion for the game.`,
            confirmLabel: 'Poison',
            danger: true
          });
          if (!ok) return;
          if (!(await submitWitchAction(sessionId, playerId, 'poison', btn.dataset.uid))) return;
          myNightSubmitted = true;
          render();
        });
      });
      const witchRecheckBtn = document.getElementById('witch-recheck-btn');
      if (witchRecheckBtn) {
        witchRecheckBtn.addEventListener('click', () => {
          witchWolfTargetFetched = false; // next render re-reads the Chief's target
          render();
        });
      }
      const witchNoneBtn = document.getElementById('witch-none-btn');
      if (witchNoneBtn) {
        witchNoneBtn.addEventListener('click', async () => {
          if (!(await submitWitchAction(sessionId, playerId, 'none', null))) return;
          myNightSubmitted = true;
          render();
        });
      }
    }
  }

  function shownNamePlain(p) {
    return p ? (p.displayName || p.username || 'this player') : 'this player';
  }

  gameUnsubscribers.push(
    db.collection('werewolf_sessions').doc(sessionId).onSnapshot(doc => {
      const newData = doc.data() || {};

      if (newData.status === 'lobby') {
        clearGameListeners();
        renderLobby(sessionId, playerId, isMod);
        showScreen('lobby-screen');
        return;
      }

      if (newData.status === 'starting') {
        const roleContent = document.getElementById('role-content');
        if (roleContent) roleContent.innerHTML = `<div class="role-card">Starting the game...</div><p class="hint-text">The moderator is dealing roles. This screen will update automatically.</p>`;
        return;
      }

      // The Hunter's own client can't see roles, so after firing it just
      // raises this flag; the moderator runs the real succession/win check.
      if (isMod && newData.pendingWinRecheck) {
        applyPendingWinRecheck(sessionId)
          .catch(err => console.warn('Could not apply queued win check:', err));
      }

      // Moderator applies queued Witch potion-used flags — she can't write
      // her own player doc beyond `ready`, so her intent is queued here.
      if (isMod && newData.pendingPotionFlags && newData.pendingPotionFlags.length) {
        applyPendingPotionFlags(sessionId, newData.pendingPotionFlags)
          .catch(err => console.warn('Could not apply queued potion flags:', err));
      }

      if (newData.nightStep !== sessionData.nightStep || newData.phase !== sessionData.phase) {
        myNightSubmitted = false;
        seerCheckResult = null;
        witchWolfTargetName = null;
        witchWolfTargetId = null;
        witchWolfTargetFetched = false;
      }

      // Cosmetic only: flash a moon/sun overlay when the phase actually
      // flips. Guarded on sessionListenerPrimed so the first snapshot after
      // opening the game screen (sessionData starts as {}) never counts as
      // a "transition" — only a later, genuine flip does.
      if (sessionListenerPrimed && newData.phase !== sessionData.phase
          && (newData.phase === 'night' || newData.phase === 'day')) {
        triggerPhaseOverlay(newData.phase);
      }
      sessionListenerPrimed = true;

      if (suspenseTimer) { clearTimeout(suspenseTimer); suspenseTimer = null; }
      const newAnnouncement = newData.announcement || null;
      const newKey = newAnnouncement ? JSON.stringify(newAnnouncement) : null;
      const isGenuinelyNew = newKey && newKey !== displayedAnnouncementKey;
      const skipSuspense = newAnnouncement && newAnnouncement.type === 'hunter_pending';

      sessionData = newData;

      if (isGenuinelyNew && !skipSuspense) {
        showingSuspense = true;
        render();
        suspenseTimer = setTimeout(() => {
          showingSuspense = false;
          displayedAnnouncementKey = newKey;
          suspenseTimer = null;
          render();
        }, 2200);
      } else {
        showingSuspense = false;
        displayedAnnouncementKey = newKey;
        render();
      }
    })
  );

  if (isMod) {
    gameUnsubscribers.push(
      db.collection(`werewolf_sessions/${sessionId}/players`).onSnapshot(snapshot => {
        players = [];
        snapshot.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
        render();
      }, err => console.warn('Could not read player records:', err))
    );
  } else {
    gameUnsubscribers.push(
      db.collection(`werewolf_sessions/${sessionId}/players`).doc(playerId).onSnapshot(doc => {
        const newRole = doc.exists ? (doc.data().role || null) : null;
        // Firestore only fires this callback on an actual data change, so
        // there's no risk of these flags flipping true on an unrelated
        // render() (e.g. the discussion-timer's 1s tick lives in render(),
        // not here).
        if (newRole && !lastKnownRole) {
          roleCardFlip = true;   // role just became visible to us
        } else if (newRole === 'chief_werewolf' && lastKnownRole && lastKnownRole !== 'chief_werewolf') {
          roleCardGlow = true;   // promoted mid-game via Chief succession
        }
        lastKnownRole = newRole;
        players = doc.exists ? [{ id: doc.id, ...doc.data() }] : [];
        render();
      }, err => console.warn('Could not read private player record:', err))
    );
  }

  gameUnsubscribers.push(
    db.collection(`werewolf_sessions/${sessionId}/roster`).onSnapshot(snapshot => {
      roster = [];
      snapshot.forEach(doc => roster.push({ id: doc.id, ...doc.data() }));
      render();
    })
  );

  if (isMod) {
    gameUnsubscribers.push(
      db.collection(`werewolf_sessions/${sessionId}/votes`).onSnapshot(snapshot => {
        voteCount = snapshot.size;
        render();
      })
    );
    gameUnsubscribers.push(
      db.collection(`werewolf_sessions/${sessionId}/nightActions`).onSnapshot(snapshot => {
        nightActionsMap = {};
        snapshot.forEach(doc => { nightActionsMap[doc.id] = doc.data(); });
        render();
      })
    );
  } else {
    gameUnsubscribers.push(
      db.collection(`werewolf_sessions/${sessionId}/votes`).doc(playerId).onSnapshot(doc => {
        myVote = doc.exists ? doc.data().targetId : null;
        render();
      })
    );
  }

  // Drives the discussion-timer countdown display; harmless no-op re-render
  // the rest of the time.
  timerInterval = setInterval(() => {
    const endsAt = sessionData.discussionTimerEndsAt;
    if (endsAt && !sessionData.winner && Date.now() < endsAt + 1500) render();
  }, 1000);
}
