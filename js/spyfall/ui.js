// js/games/werewolf/ui.js
// Live game screen.
//
// Two architectural points worth keeping in mind:
//
// 1. The player's role is DERIVED from the live players array on every
//    render, never captured once. This is what makes Chief succession
//    work without a refresh.
//
// 2. Removed players (participationStatus === 'removed') are excluded
//    from every "who counts" calculation: ack gates, vote counts, night
//    target lists, Chief targeting. Their doc is preserved as history.
//
// Escaping: every interpolation of a user-supplied string (displayName,
// username, and anything derived from them) goes through esc(), which is
// defined in engine.js (loaded before this file). shownName() returns the
// raw name on purpose — escaping at the interpolation site avoids
// double-escaping when a name is compared, stored, or re-rendered.

let gameUnsubscribers = [];

function clearGameListeners() {
  gameUnsubscribers.forEach(u => u());
  gameUnsubscribers = [];
}

function shownName(p) {
  return p.displayName || p.username;
}

function renderGameScreen(sessionId, playerId, isMod) {
  clearGameListeners();
  showScreen('role-screen');

  let sessionData = {};
  let players = [];
  let voteCount = 0;
  let myVote = null;
  let nightActionsMap = {};
  let myNightSubmitted = false;
  let seerCheckResult = null;
  let witchWolfTargetName = null;
  let witchWolfTargetFetched = false;

  let showingSuspense = false;
  let displayedAnnouncementKey = null;
  let suspenseTimer = null;
  let pendingAckKey = null;
  let myDeathSeen = false;

  // ---------------------------------------------------------------
  // Derived sets — every "who counts" calculation goes through here.
  // ---------------------------------------------------------------

  function me() { return players.find(p => p.id === playerId); }
  function myRole() { const m = me(); return m ? (m.role || null) : null; }
  function iAmRemoved() { const m = me(); return !!m && m.participationStatus === 'removed'; }
  function iAmAlive() { const m = me(); return !!m && m.participationStatus !== 'removed' && m.alive !== false; }
  function activePlayers() { return players.filter(p => p.participationStatus !== 'removed'); }
  function livingActive() { return activePlayers().filter(p => p.alive !== false); }

  // ---------------------------------------------------------------
  // Acknowledgement
  // ---------------------------------------------------------------

  function announcementNeedsAck(a) {
    return !!a && a.type !== 'hunter_pending';
  }

  function allLivingActiveHaveSeen() {
    if (!announcementNeedsAck(sessionData.announcement)) return true;
    const seen = sessionData.deathSeen || [];
    return livingActive().every(p => seen.includes(p.id));
  }

  function acknowledgeAnnouncement() {
    if (!pendingAckKey) return;
    pendingAckKey = null;
    render();
    db.collection('werewolf_sessions').doc(sessionId)
      .update({ deathSeen: firebase.firestore.FieldValue.arrayUnion(playerId) })
      .catch(err => console.warn('Could not record acknowledgement:', err));
  }

  function renderAnnouncement(a) {
    if (a.type === 'werewolf_out') {
      return `<div class="banner reveal">\ud83d\udc3a A Werewolf was voted out: <strong>${esc(a.name)}</strong></div>`;
    }
    if (a.type === 'villager_out') {
      return `<div class="banner reveal">\ud83d\udc80 <strong>${esc(a.name)}</strong> was voted out \u2014 they were <em>not</em> a Werewolf.</div>`;
    }
    if (a.type === 'night_death') {
      const names = a.names.map(n => esc(n)).join(', ');
      return `<div class="banner reveal">\ud83d\udc80 <strong>${names}</strong> died during the night.</div>`;
    }
    if (a.type === 'no_night_death') {
      return `<div class="banner reveal">\u2600\ufe0f No one died last night.</div>`;
    }
    if (a.type === 'tie') {
      const names = a.names.map(n => esc(n)).join(', ');
      return `<div class="banner reveal">It's a tie between <strong>${names}</strong> \u2014 vote again, only between them.</div>`;
    }
    if (a.type === 'still_tied') {
      const names = a.names.map(n => esc(n)).join(', ');
      return `<div class="banner reveal">Still tied between <strong>${names}</strong> \u2014 no one is eliminated this round.</div>`;
    }
    if (a.type === 'hunter_pending') {
      return `<div class="banner">\ud83c\udff9 <strong>${esc(a.name)}</strong> was eliminated and is taking their final shot...</div>`;
    }
    if (a.type === 'hunter_shot') {
      return `<div class="banner reveal">\ud83c\udff9 ${esc(a.hunterName)}'s final shot eliminated <strong>${esc(a.targetName)}</strong>!</div>`;
    }
    if (a.type === 'hunter_skipped') {
      return `<div class="banner reveal">\ud83c\udff9 ${esc(a.hunterName)} chose not to take a final shot.</div>`;
    }
    return `<div class="banner reveal">Nobody was voted out.</div>`;
  }

  // ---------------------------------------------------------------
  // Potion-flag queue (moderator applies)
  // ---------------------------------------------------------------

  let applyingPotionFlags = false;
  async function applyPendingPotionFlags(queue) {
    if (applyingPotionFlags || !queue || !queue.length) return;
    applyingPotionFlags = true;
    try {
      const byWitch = {};
      queue.forEach(e => { byWitch[e.witchUid] = e; });
      const entries = Object.values(byWitch);

      const batch = db.batch();
      entries.forEach(e => {
        batch.update(
          db.collection(`werewolf_sessions/${sessionId}/players`).doc(e.witchUid),
          { [e.flag]: true }
        );
      });
      batch.update(db.collection('werewolf_sessions').doc(sessionId), {
        pendingPotionFlags: firebase.firestore.FieldValue.arrayRemove(...queue)
      });
      await batch.commit();
    } catch (err) {
      console.warn('Could not apply pending potion flags:', err);
    } finally {
      applyingPotionFlags = false;
    }
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  function render() {
    const roleContent = document.getElementById('role-content');
    if (!roleContent) return;

    const my = me();
    const role = myRole();
    const alive = iAmAlive();
    const removed = iAmRemoved();
    const living = livingActive();
    const phase = sessionData.phase || 'day';
    const nightStep = sessionData.nightStep || null;

    // ---- Removed player (spectator) screen ----
    if (!isMod && removed) {
      let html = `<div class="removed-banner">
        <strong>You were removed from this game.</strong><br>
        You can watch, but you can't act.
      </div>`;
      html += `<h3>Players</h3><ul class="player-list">`;
      players.forEach(p => {
        const elim = p.alive === false;
        const rm = p.participationStatus === 'removed';
        html += `<li><span>${esc(shownName(p))}${elim ? ' \u2014 dead' : ''}${rm ? ' \u2014 removed' : ''}</span></li>`;
      });
      html += `</ul>`;
      html += `<button class="logout-btn secondary-btn">Logout</button>`;
      roleContent.innerHTML = html;
      return;
    }

    // ---- Hunter's pending shot takes over the Hunter's screen ----
    if (!isMod && sessionData.pendingHunterShot === playerId) {
      let html = `<div class="banner">\ud83c\udff9 You've been eliminated \u2014 take your final shot!</div>`;
      html += `<h3>Choose someone to eliminate, or skip:</h3><ul class="player-list">`;
      living.forEach(p => {
        html += `<li><button class="hunter-target-btn secondary-btn" data-uid="${p.id}">${esc(shownName(p))}</button></li>`;
      });
      html += `</ul><button id="hunter-skip-btn" class="secondary-btn">Skip \u2014 don't shoot anyone</button>`;
      roleContent.innerHTML = html;
      document.querySelectorAll('.hunter-target-btn').forEach(btn => {
        btn.addEventListener('click', () => fireHunterShot(sessionId, playerId, btn.dataset.uid));
      });
      document.getElementById('hunter-skip-btn').addEventListener('click', () => fireHunterShot(sessionId, playerId, null));
      return;
    }

    const roleLabel = role ? role.replace(/_/g, ' ').toUpperCase() : '';
    let html = role
      ? `<div class="role-card">You are: <strong>${esc(roleLabel)}</strong>${alive ? '' : ' (eliminated)'}</div>`
      : `<div class="role-card">You are the <strong>Game Master</strong> \u2014 running this round.</div>`;

    // ---- Top banner ----
    if (sessionData.winner) {
      const side = sessionData.winner === 'werewolves' ? '\ud83d\udc3a Werewolves' : '\ud83e\uddd1\u200d\ud83c\udf3e Villagers';
      html += `<div class="banner winner-banner reveal">${side} win!</div>`;
    } else if (showingSuspense) {
      html += `<div class="banner suspense-banner">\ud83e\udd41 The moment of truth...</div>`;
    } else if (sessionData.announcement) {
      html += renderAnnouncement(sessionData.announcement);
    } else if (sessionData.pendingHunterShot) {
      const hunter = players.find(p => p.id === sessionData.pendingHunterShot);
      html += renderAnnouncement({ type: 'hunter_pending', name: hunter ? shownName(hunter) : 'A Hunter' });
    } else if (phase === 'night') {
      html += `<div class="banner">\ud83c\udf19 Night${nightStep && nightStep !== 'done' ? ` \u2014 ${esc(nightStep)} acting` : ''}</div>`;
    }

    if (sessionData.pendingHunterShot && !isMod) {
      html += `<p>\u23f3 Waiting for the Hunter's final shot...</p>`;
    }

    const showAck = !isMod && alive && announcementNeedsAck(sessionData.announcement)
      && !showingSuspense && pendingAckKey === displayedAnnouncementKey;
    if (showAck) {
      html += `<button id="ack-announce-btn" class="primary-btn ack-btn">Tap to confirm you've seen this</button>`;
    }

    if (sessionData.roleComposition) {
      html += `<details class="composition-details"><summary>\u2139\ufe0f Role composition</summary><ul class="player-list">`;
      Object.entries(sessionData.roleComposition).forEach(([r, c]) => {
        html += `<li><span>${esc(r.replace(/_/g, ' '))}</span><span>${c}</span></li>`;
      });
      html += `</ul></details>`;
    }

    if (isMod) {
      // ===================== MODERATOR =====================

      html += `<h3>All Roles</h3><ul class="player-list">`;
      players.forEach(p => {
        const dead = p.alive === false;
        const rm = p.participationStatus === 'removed';
        const statusNote = rm ? ' \u2014 removed' : (dead ? ' \u2014 dead' : '');
        html += `<li>
          <span>${esc(shownName(p))}: ${esc(p.role || '\u2014')}${statusNote}</span>
          ${!dead && !rm ? `<button class="eliminate-btn secondary-btn" data-uid="${p.id}">Eliminate</button>` : ''}
          ${!rm ? `<button class="remove-player-btn secondary-btn mini-btn" data-uid="${p.id}">Remove</button>` : ''}
        </li>`;
      });
      html += `</ul>`;

      if (sessionData.roleComposition) {
        html += `<details class="composition-details"><summary>\ud83d\udcd6 What each role does</summary><ul class="player-list">`;
        Object.keys(sessionData.roleComposition).forEach(r => {
          html += `<li><span><strong>${esc(r.replace(/_/g, ' '))}</strong>: ${esc(ROLE_DESCRIPTIONS[r] || '')}</span></li>`;
        });
        html += `</ul></details>`;
      }

      html += `<div class="narrator-box"><strong>\ud83c\udf99\ufe0f </strong>${narratorLine(sessionData, nightActionsMap)}</div>`;

      if (sessionData.pendingHunterShot) {
        const hunter = players.find(p => p.id === sessionData.pendingHunterShot);
        html += `<p>\u23f3 Waiting for ${hunter ? esc(shownName(hunter)) : 'the Hunter'} to take their final shot...</p>`;
        html += `<button id="skip-hunter-btn" class="secondary-btn">Skip Hunter Shot</button>`;
      } else if (!sessionData.winner) {
        if (phase === 'night') {
          html += `<div class="night-panel"><h3>Night sequence</h3>`;
          if (nightStep === 'done') {
            html += `<p>All night actions are in.</p><button id="end-night-btn" class="primary-btn">End Night</button>`;
          } else {
            const submitted = !!nightActionsMap[nightStep];
            const actor = players.find(p => p.role === nightStep && p.alive !== false && p.participationStatus !== 'removed');
            const actorLabel = submitted ? 'chosen'
              : actor ? 'waiting for their choice...'
              : 'no active player holds this role';
            html += `<p>Active: <strong>${esc(nightStep)}</strong> \u2014 ${actorLabel}</p>`;
            html += `<button id="advance-night-btn" class="primary-btn">${submitted || !actor ? 'Next' : 'Skip / Next'}</button>`;
          }
          if (nightActionsMap.doctor) {
            const saved = players.find(p => p.id === nightActionsMap.doctor.targetId);
            html += `<p class="hint-text">Doctor is protecting: ${saved ? esc(shownName(saved)) : '\u2014'}</p>`;
          }
          if (nightActionsMap.chief_werewolf) {
            const target = players.find(p => p.id === nightActionsMap.chief_werewolf.targetId);
            html += `<p class="hint-text">Chief Werewolf is targeting: ${target ? esc(shownName(target)) : '\u2014'}</p>`;
          }
          if (nightActionsMap.witch) {
            const w = nightActionsMap.witch;
            let label;
            if (w.action === 'save') {
              label = 'saving the werewolves\u2019 target';
            } else if (w.action === 'poison') {
              const p = players.find(pp => pp.id === w.targetId);
              label = `poisoning ${p ? esc(shownName(p)) : '\u2014'}`;
            } else {
              label = 'doing nothing tonight';
            }
            html += `<p class="hint-text">Witch is ${label}</p>`;
          }
          html += `</div>`;
        } else if (!sessionData.votingOpen) {
          if (!allLivingActiveHaveSeen()) {
            const seen = livingActive().filter(p => (sessionData.deathSeen || []).includes(p.id)).length;
            html += `<p>\u23f3 Waiting for everyone to confirm the reveal (${seen} of ${livingActive().length})...</p>`;
            html += `<button id="force-ack-btn" class="secondary-btn">Force Continue</button>`;
          } else {
            html += `<button id="start-night-btn" class="primary-btn">Start Night</button>`;
            html += `<button id="start-voting-btn" class="primary-btn">Start Voting</button>`;
          }
        } else {
          const runoffNames = sessionData.voteEligibleTargets
            ? sessionData.voteEligibleTargets.map(id => {
                const p = players.find(pp => pp.id === id);
                return p ? esc(shownName(p)) : 'Unknown';
              }).join(', ')
            : null;
          html += `<p>${voteCount} of ${livingActive().length} eligible alive players voted${runoffNames ? ` \u2014 runoff: ${runoffNames}` : ''}</p>`;
          html += `<button id="reveal-voting-btn" class="primary-btn">Reveal Result</button>`;
        }
      } else {
        html += `<button id="play-again-btn" class="primary-btn">Play Again (same room)</button>`;
      }
    } else {
      // ===================== PLAYER =====================

      html += `<h3>Players</h3><ul class="player-list">`;
      players.forEach(p => {
        const dead = p.alive === false;
        const rm = p.participationStatus === 'removed';
        html += `<li><span>${esc(shownName(p))}${dead ? ' \u2014 eliminated' : ''}${rm ? ' \u2014 removed' : ''}</span></li>`;
      });
      html += `</ul>`;

      if (sessionData.pendingHunterShot) {
        html += `<p>\u23f3 Waiting for the Hunter's final shot...</p>`;
      } else if (phase === 'night' && !sessionData.winner) {
        if (role === nightStep && alive) {
          if (role === 'witch') {
            if (!witchWolfTargetFetched) {
              witchWolfTargetFetched = true;
              getWolfTarget(sessionId).then(targetId => {
                const target = players.find(p => p.id === targetId);
                witchWolfTargetName = targetId ? (target ? shownName(target) : 'someone') : null;
                render();
              });
              html += `<p>Loading tonight's werewolf target...</p>`;
            } else if (!myNightSubmitted) {
              if (witchWolfTargetName) {
                html += `<h3>The Werewolves' target tonight: <strong>${esc(witchWolfTargetName)}</strong></h3>`;
                if (!my.healPotionUsed) {
                  html += `<button class="witch-save-btn primary-btn">Use Heal Potion \u2014 Save ${esc(witchWolfTargetName)}</button>`;
                }
              } else {
                html += `<p>Waiting for the Chief Werewolf to choose a target...</p>`;
              }
              if (!my.poisonPotionUsed) {
                html += `<p>Or use your Poison Potion:</p><ul class="player-list">`;
                living.filter(p => p.id !== playerId).forEach(p => {
                  html += `<li><button class="witch-poison-btn secondary-btn" data-uid="${p.id}">Poison ${esc(shownName(p))}</button></li>`;
                });
                html += `</ul>`;
              }
              html += `<button id="witch-none-btn" class="secondary-btn">Do nothing tonight</button>`;
            } else {
              html += `<p>Your choice is locked in.</p>`;
            }
          } else if (role === 'seer' && seerCheckResult) {
            html += `<div class="banner">${esc(seerCheckResult.targetName)} is ${seerCheckResult.isWerewolf ? 'a \ud83d\udc3a Werewolf' : 'not a Werewolf'}.</div>`;
          } else {
            const label = role === 'doctor' ? 'Choose someone to save:'
              : role === 'chief_werewolf' ? 'Choose someone to eliminate:'
              : 'Choose someone to check:';
            html += `<h3>${label}</h3><ul class="player-list" id="night-action-list">`;
            const candidates = role === 'chief_werewolf'
              ? living.filter(p => p.id !== playerId)
              : living;
            candidates.forEach(p => {
              html += `<li><button class="night-target-btn secondary-btn" data-uid="${p.id}">${esc(shownName(p))}</button></li>`;
            });
            html += `</ul>`;
            if (myNightSubmitted && role !== 'seer') html += `<p>Your choice is locked in.</p>`;
          }
        } else {
          html += `<p>Waiting for the moderator...</p>`;
        }
      } else if (sessionData.votingOpen && alive && !sessionData.winner) {
        const eligibleIds = sessionData.voteEligibleTargets || null;
        const heading = eligibleIds ? 'Runoff vote \u2014 pick one:' : 'Vote to eliminate:';
        html += `<h3>${heading}</h3><ul class="player-list" id="vote-list">`;
        living
          .filter(p => p.id !== playerId)
          .filter(p => !eligibleIds || eligibleIds.includes(p.id))
          .forEach(p => {
            const selected = myVote === p.id;
            html += `<li><button class="vote-btn secondary-btn${selected ? ' selected' : ''}" data-uid="${p.id}">${esc(shownName(p))}${selected ? ' \u2714\ufe0f' : ''}</button></li>`;
          });
        html += `</ul>`;
        if (myVote) html += `<p>Your vote is in \u2014 tap another name to change it.</p>`;
      }
    }

    html += `<button class="logout-btn secondary-btn">Logout</button>`;
    roleContent.innerHTML = html;

    // ---- Event wiring ----

    const ackBtn = document.getElementById('ack-announce-btn');
    if (ackBtn) ackBtn.addEventListener('click', acknowledgeAnnouncement);

    const forceAckBtn = document.getElementById('force-ack-btn');
    if (forceAckBtn) {
      forceAckBtn.addEventListener('click', () => {
        db.collection('werewolf_sessions').doc(sessionId)
          .update({ deathSeen: livingActive().map(p => p.id) })
          .catch(err => console.warn('Could not force-continue:', err));
      });
    }

    if (isMod) {
      document.querySelectorAll('.eliminate-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const p = players.find(pp => pp.id === btn.dataset.uid);
          const ok = await confirmAction({
            title: `Eliminate ${p ? shownName(p) : 'this player'}?`,
            message: 'They will be marked dead. Their role is not revealed to the room.',
            confirmLabel: 'Eliminate',
            danger: true
          });
          if (ok) eliminatePlayer(sessionId, btn.dataset.uid);
        });
      });
      document.querySelectorAll('.remove-player-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const p = players.find(pp => pp.id === btn.dataset.uid);
          const ok = await confirmAction({
            title: `Remove ${p ? shownName(p) : 'this player'} from the game?`,
            message: 'They will no longer participate. Their game history is preserved.',
            confirmLabel: 'Remove Player',
            danger: true
          });
          if (ok) removePlayerFromGame(sessionId, btn.dataset.uid);
        });
      });
      const startVotingBtn = document.getElementById('start-voting-btn');
      if (startVotingBtn) startVotingBtn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Start Voting?',
          message: 'Players will now vote for elimination.',
          confirmLabel: 'Start Voting'
        });
        if (ok) startVoting(sessionId);
      });
      const revealBtn = document.getElementById('reveal-voting-btn');
      if (revealBtn) revealBtn.addEventListener('click', async () => {
        const eligible = livingActive().length;
        const incomplete = voteCount < eligible;
        const msg = incomplete
          ? `Only ${voteCount} of ${eligible} eligible players have voted. Reveal anyway?`
          : 'This will finalize the current vote.';
        const ok = await confirmAction({
          title: 'Reveal Result?',
          message: msg,
          confirmLabel: 'Reveal Result'
        });
        if (ok) revealVoting(sessionId);
      });
      const startNightBtn = document.getElementById('start-night-btn');
      if (startNightBtn) startNightBtn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Start Night?',
          message: 'This will begin the night phase and activate the first role.',
          confirmLabel: 'Start Night'
        });
        if (ok) startNight(sessionId);
      });
      const advanceBtn = document.getElementById('advance-night-btn');
      if (advanceBtn) advanceBtn.addEventListener('click', () => advanceNight(sessionId, nightStep));
      const endNightBtn = document.getElementById('end-night-btn');
      if (endNightBtn) endNightBtn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'End Night?',
          message: 'This will resolve the submitted night actions and move to Day.',
          confirmLabel: 'End Night'
        });
        if (ok) endNight(sessionId);
      });
      const skipHunterBtn = document.getElementById('skip-hunter-btn');
      if (skipHunterBtn) skipHunterBtn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Skip the Hunter\u2019s shot?',
          message: 'Use this only if the Hunter cannot take their shot (phone dead, player gone).',
          confirmLabel: 'Skip Shot',
          danger: true
        });
        if (ok) skipHunterShot(sessionId);
      });
      const playAgainBtn = document.getElementById('play-again-btn');
      if (playAgainBtn) playAgainBtn.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Start a rematch?',
          message: 'The current game will be reset. Everyone will return to the lobby to re-ready.',
          confirmLabel: 'Play Again'
        });
        if (ok) resetSessionForRematch(sessionId);
      });
    } else {
      document.querySelectorAll('.vote-btn').forEach(btn => {
        btn.addEventListener('click', () => castVote(sessionId, playerId, btn.dataset.uid));
      });
      document.querySelectorAll('.night-target-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const targetId = btn.dataset.uid;
          const r = myRole();
          if (r === 'seer') {
            await markSeerDone(sessionId);
            myNightSubmitted = true;
            const isWolf = await checkPlayer(sessionId, targetId);
            const target = players.find(p => p.id === targetId);
            seerCheckResult = { targetName: target ? shownName(target) : 'That player', isWerewolf: isWolf };
          } else {
            await submitNightAction(sessionId, r, targetId);
            myNightSubmitted = true;
          }
          render();
        });
      });
      const witchSaveBtn = document.querySelector('.witch-save-btn');
      if (witchSaveBtn) {
        witchSaveBtn.addEventListener('click', async () => {
          await submitWitchAction(sessionId, playerId, 'save', null);
          myNightSubmitted = true;
          render();
        });
      }
      document.querySelectorAll('.witch-poison-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          await submitWitchAction(sessionId, playerId, 'poison', btn.dataset.uid);
          myNightSubmitted = true;
          render();
        });
      });
      const witchNoneBtn = document.getElementById('witch-none-btn');
      if (witchNoneBtn) {
        witchNoneBtn.addEventListener('click', async () => {
          await submitWitchAction(sessionId, playerId, 'none', null);
          myNightSubmitted = true;
          render();
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // Listeners
  // ---------------------------------------------------------------

  gameUnsubscribers.push(
    db.collection('werewolf_sessions').doc(sessionId).onSnapshot(doc => {
      const newData = doc.data() || {};

      if (newData.status === 'lobby') {
        clearGameListeners();
        renderLobby(sessionId, playerId, isMod);
        showScreen('lobby-screen');
        return;
      }

      if (newData.nightStep !== sessionData.nightStep || newData.phase !== sessionData.phase) {
        myNightSubmitted = false;
        seerCheckResult = null;
        witchWolfTargetName = null;
        witchWolfTargetFetched = false;
        nightActionsMap = {};
      }

      if (suspenseTimer) { clearTimeout(suspenseTimer); suspenseTimer = null; }
      const newAnnouncement = newData.announcement || null;
      const newKey = newAnnouncement ? JSON.stringify(newAnnouncement) : null;
      const isGenuinelyNew = newKey && newKey !== displayedAnnouncementKey;
      const skipSuspense = newAnnouncement && newAnnouncement.type === 'hunter_pending';

      sessionData = newData;
      myDeathSeen = (sessionData.deathSeen || []).includes(playerId);

      // Potion-flag queue: apply as soon as the queue is visible on the
      // session doc — don't rely on the players listener firing again,
      // because the two listeners' delivery order is not guaranteed.
      if (isMod && sessionData.pendingPotionFlags && sessionData.pendingPotionFlags.length) {
        applyPendingPotionFlags(sessionData.pendingPotionFlags);
      }

      if (isGenuinelyNew && !skipSuspense) {
        showingSuspense = true;
        render();
        suspenseTimer = setTimeout(() => {
          showingSuspense = false;
          displayedAnnouncementKey = newKey;
          pendingAckKey = myDeathSeen ? null : newKey;
          suspenseTimer = null;
          render();
        }, 2200);
      } else {
        showingSuspense = false;
        displayedAnnouncementKey = newKey;
        pendingAckKey = (!myDeathSeen && announcementNeedsAck(newAnnouncement) && !skipSuspense)
          ? newKey
          : null;
        render();
      }
    })
  );

  gameUnsubscribers.push(
    db.collection(`werewolf_sessions/${sessionId}/players`).onSnapshot(snapshot => {
      players = [];
      snapshot.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
      render();

      const onLobbyScreen = document.getElementById('lobby-screen') &&
        document.getElementById('lobby-screen').classList.contains('active');
      if (onLobbyScreen) {
        const m = players.find(p => p.id === playerId);
        if (m && m.role) renderGameScreen(sessionId, playerId, false);
      }

      // Belt-and-suspenders: the session listener above also checks the
      // queue, but if a players write lands first with the queue already
      // present, this fires the apply. The applyingPotionFlags guard
      // prevents double-application.
      if (isMod && sessionData.pendingPotionFlags && sessionData.pendingPotionFlags.length) {
        applyPendingPotionFlags(sessionData.pendingPotionFlags);
      }
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
}
