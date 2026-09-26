// js/games/werewolf/ui.js
//
// Renders the post-lobby "game screen": role reveal, plus everything that
// happens after Start Game — moderator's eliminate/voting/night controls,
// the player's own voting or night-action UI, and any announcement or
// winner banner. Stays live via Firestore listeners so roles, eliminations,
// and night/day phase changes update in real time on every phone.
//
// Reveals (a vote result, a night death, a Hunter's shot) don't render the
// instant Firestore delivers them — they hold behind a brief "drumroll"
// suspense banner first (see the session listener below), so a room full
// of phones reveals the result together instead of piecemeal as each
// device's listener happens to fire.

let gameUnsubscribers = [];

function clearGameListeners() {
  gameUnsubscribers.forEach(unsub => unsub());
  gameUnsubscribers = [];
}

// The name shown to other players is always displayName (set at signup);
// username is a private login handle and is never surfaced in-game.
function shownName(p) {
  return p.displayName || p.username;
}

// sessionId/playerId/isMod/myRole are enough to drive the whole screen —
// everything else (roster, alive status, votes, night actions, winner) is
// pulled live.
function renderGameScreen(sessionId, playerId, isMod, myRole) {
  clearGameListeners();
  showScreen('role-screen');

  let sessionData = {};
  let players = [];
  let voteCount = 0;
  let myVote = null;
  let nightActionsMap = {};      // moderator-only: { role: { targetId } }
  let myNightSubmitted = false;  // did I already act during the current step
  let seerCheckResult = null;    // local-only, never written to Firestore
  let witchWolfTargetName = null;
  let witchWolfTargetFetched = false;

  // Drumroll state: we don't show a new announcement the instant it
  // arrives — we hold it behind a suspense banner for a couple seconds
  // first. 'hunter_pending' is exempt (it IS a waiting state, no need to
  // suspense a "please wait").
  let showingSuspense = false;
  let displayedAnnouncementKey = null;
  let suspenseTimer = null;

  function renderAnnouncement(a) {
    if (a.type === 'werewolf_out') {
      return `<div class="banner reveal">\ud83d\udc3a A Werewolf was voted out: <strong>${a.name}</strong></div>`;
    }
    if (a.type === 'night_death') {
      return `<div class="banner reveal">\ud83d\udc80 <strong>${a.names.join(', ')}</strong> died during the night.</div>`;
    }
    if (a.type === 'no_night_death') {
      return `<div class="banner reveal">\u2600\ufe0f No one died last night.</div>`;
    }
    if (a.type === 'tie') {
      return `<div class="banner reveal">It's a tie between <strong>${a.names.join(', ')}</strong> \u2014 vote again, only between them.</div>`;
    }
    if (a.type === 'still_tied') {
      return `<div class="banner reveal">Still tied between <strong>${a.names.join(', ')}</strong> \u2014 no one is eliminated this round.</div>`;
    }
    if (a.type === 'hunter_pending') {
      return `<div class="banner">\ud83c\udff9 <strong>${a.name}</strong> was eliminated and is taking their final shot...</div>`;
    }
    if (a.type === 'hunter_shot') {
      return `<div class="banner reveal">\ud83c\udff9 ${a.hunterName}'s final shot eliminated <strong>${a.targetName}</strong>!</div>`;
    }
    if (a.type === 'hunter_skipped') {
      return `<div class="banner reveal">\ud83c\udff9 ${a.hunterName} chose not to take a final shot.</div>`;
    }
    return `<div class="banner reveal">Nobody was voted out.</div>`;
  }

  function render() {
    const roleContent = document.getElementById('role-content');
    if (!roleContent) return; // navigated away

    const me = players.find(p => p.id === playerId);
    const iAmAlive = !me || me.alive !== false;
    const alivePlayers = players.filter(p => p.alive !== false);
    const phase = sessionData.phase || 'day'; // sessions started before this feature default to day
    const nightStep = sessionData.nightStep || null;

    // A Hunter's revenge shot takes over the whole screen for the Hunter
    // themselves, regardless of day/night phase or suspense — it can
    // happen any time they're eliminated, and it needs their input now.
    if (!isMod && sessionData.pendingHunterShot === playerId) {
      let html = `<div class="banner">\ud83c\udff9 You've been eliminated \u2014 take your final shot!</div>`;
      html += `<h3>Choose someone to eliminate, or skip:</h3><ul class="player-list">`;
      alivePlayers.forEach(p => {
        html += `<li><button class="hunter-target-btn secondary-btn" data-uid="${p.id}">${shownName(p)}</button></li>`;
      });
      html += `</ul><button id="hunter-skip-btn" class="secondary-btn">Skip \u2014 don't shoot anyone</button>`;
      roleContent.innerHTML = html;
      document.querySelectorAll('.hunter-target-btn').forEach(btn => {
        btn.addEventListener('click', () => fireHunterShot(sessionId, playerId, btn.dataset.uid));
      });
      document.getElementById('hunter-skip-btn').addEventListener('click', () => fireHunterShot(sessionId, playerId, null));
      return;
    }

    // Moderators are never dealt a role, so myRole is null for them —
    // show a distinct card instead of a player role card.
    const roleLabel = myRole ? myRole.replace(/_/g, ' ').toUpperCase() : '';
    let html = myRole
      ? `<div class="role-card">You are: <strong>${roleLabel}</strong>${iAmAlive ? '' : ' (eliminated)'}</div>`
      : `<div class="role-card">You are the <strong>Game Master</strong> \u2014 running this round.</div>`;

    if (sessionData.winner) {
      const side = sessionData.winner === 'werewolves' ? '\ud83d\udc3a Werewolves' : '\ud83e\uddd1\u200d\ud83c\udf3e Villagers';
      html += `<div class="banner winner-banner reveal">${side} win!</div>`;
    } else if (showingSuspense) {
      html += `<div class="banner suspense-banner">\ud83e\udd41 The moment of truth...</div>`;
    } else if (sessionData.pendingHunterShot) {
      html += renderAnnouncement(sessionData.announcement || { type: 'hunter_pending', name: 'A Hunter' });
    } else if (phase === 'night') {
      html += `<div class="banner">\ud83c\udf19 Night${nightStep && nightStep !== 'done' ? ` \u2014 ${nightStep} acting` : ''}</div>`;
    } else if (sessionData.announcement) {
      html += renderAnnouncement(sessionData.announcement);
    }

    // Aggregate role counts only ("5 Werewolves, 1 Seer..."), never who has
    // what. Visible to everyone, tucked into a native collapsible so it
    // doesn't clutter smaller games where it's obvious anyway.
    if (sessionData.roleComposition) {
      html += `<details class="composition-details"><summary>\u2139\ufe0f Role composition</summary><ul class="player-list">`;
      Object.entries(sessionData.roleComposition).forEach(([role, count]) => {
        html += `<li><span>${role.replace(/_/g, ' ')}</span><span>${count}</span></li>`;
      });
      html += `</ul></details>`;
    }

    if (isMod) {
      html += `<h3>All Roles</h3><ul class="player-list">`;
      players.forEach(p => {
        const eliminated = p.alive === false;
        html += `<li>
          <span>${shownName(p)}: ${p.role}${eliminated ? ' \u2014 eliminated' : ''}</span>
          ${!eliminated ? `<button class="eliminate-btn secondary-btn" data-uid="${p.id}">Eliminate</button>` : ''}
        </li>`;
      });
      html += `</ul>`;

      // Moderator-only reference: what each role in play actually does.
      // Never shown to players, who only ever see their own role.
      if (sessionData.roleComposition) {
        html += `<details class="composition-details"><summary>\ud83d\udcd6 What each role does</summary><ul class="player-list">`;
        Object.keys(sessionData.roleComposition).forEach(role => {
          html += `<li><span><strong>${role.replace(/_/g, ' ')}</strong>: ${ROLE_DESCRIPTIONS[role] || ''}</span></li>`;
        });
        html += `</ul></details>`;
      }

      // The narrator line — what to say and do right now, in plain
      // language, computed fresh from the same state the buttons below
      // use, so it can never fall out of sync with them.
      html += `<div class="narrator-box"><strong>\ud83c\udf99\ufe0f </strong>${narratorLine(sessionData, nightActionsMap)}</div>`;

      if (sessionData.pendingHunterShot) {
        const hunter = players.find(p => p.id === sessionData.pendingHunterShot);
        html += `<p>\u23f3 Waiting for ${hunter ? shownName(hunter) : 'the Hunter'} to take their final shot...</p>`;
      } else if (!sessionData.winner) {
        if (phase === 'night') {
          html += `<div class="night-panel"><h3>Night sequence</h3>`;
          if (nightStep === 'done') {
            html += `<p>All night actions are in.</p><button id="end-night-btn" class="primary-btn">End Night</button>`;
          } else {
            const submitted = !!nightActionsMap[nightStep];
            html += `<p>Active: <strong>${nightStep}</strong> \u2014 ${submitted ? '\u2714\ufe0f chosen' : 'waiting for their choice...'}</p>`;
            html += `<button id="advance-night-btn" class="primary-btn">${submitted ? 'Next' : 'Skip / Next'}</button>`;
          }
          if (nightActionsMap.doctor) {
            const saved = players.find(p => p.id === nightActionsMap.doctor.targetId);
            html += `<p class="hint-text">Doctor is protecting: ${saved ? shownName(saved) : '\u2014'}</p>`;
          }
          if (nightActionsMap.chief_werewolf) {
            const target = players.find(p => p.id === nightActionsMap.chief_werewolf.targetId);
            html += `<p class="hint-text">Chief Werewolf is targeting: ${target ? shownName(target) : '\u2014'}</p>`;
          }
          if (nightActionsMap.witch) {
            const w = nightActionsMap.witch;
            const label = w.action === 'save' ? 'saving the werewolves\u2019 target'
              : w.action === 'poison' ? `poisoning ${(players.find(p => p.id === w.targetId) || {}).displayName || (players.find(p => p.id === w.targetId) || {}).username || '\u2014'}`
              : 'doing nothing tonight';
            html += `<p class="hint-text">Witch is ${label}</p>`;
          }
          html += `</div>`;
        } else if (!sessionData.votingOpen) {
          html += `<button id="start-night-btn" class="primary-btn">Start Night</button>`;
          html += `<button id="start-voting-btn" class="primary-btn">Start Voting</button>`;
        } else {
          const runoffNames = sessionData.voteEligibleTargets
            ? sessionData.voteEligibleTargets.map(id => {
                const p = players.find(pp => pp.id === id);
                return p ? shownName(p) : 'Unknown';
              }).join(', ')
            : null;
          html += `<p>${voteCount} of ${alivePlayers.length} alive players voted${runoffNames ? ` \u2014 runoff: ${runoffNames}` : ''}</p>`;
          html += `<button id="reveal-voting-btn" class="primary-btn">Reveal Result</button>`;
        }
      } else {
        html += `<button id="play-again-btn" class="primary-btn">Play Again (same room)</button>`;
      }
    } else {
      // Regular players never see roles, but they can always see who's
      // currently in the game and who's already been eliminated.
      html += `<h3>Players</h3><ul class="player-list">`;
      players.forEach(p => {
        const eliminated = p.alive === false;
        html += `<li><span>${shownName(p)}${eliminated ? ' \u2014 eliminated' : ''}</span></li>`;
      });
      html += `</ul>`;

      if (sessionData.pendingHunterShot) {
        html += `<p>\u23f3 Waiting for the Hunter's final shot...</p>`;
      } else if (phase === 'night' && !sessionData.winner) {
        if (myRole === nightStep && iAmAlive) {
          if (myRole === 'witch') {
            if (!witchWolfTargetFetched) {
              witchWolfTargetFetched = true; // guard: fetch once per step, not every render
              getWolfTarget(sessionId).then(targetId => {
                const target = players.find(p => p.id === targetId);
                witchWolfTargetName = targetId ? (target ? shownName(target) : 'someone') : 'nobody (no kill chosen yet)';
                render();
              });
              html += `<p>Loading tonight's werewolf target...</p>`;
            } else if (!myNightSubmitted) {
              html += `<h3>The Werewolves' target tonight: <strong>${witchWolfTargetName}</strong></h3>`;
              if (!me.healPotionUsed) {
                html += `<button class="witch-save-btn primary-btn">Use Heal Potion \u2014 Save ${witchWolfTargetName}</button>`;
              }
              if (!me.poisonPotionUsed) {
                html += `<p>Or use your Poison Potion instead:</p><ul class="player-list">`;
                alivePlayers.filter(p => p.id !== playerId).forEach(p => {
                  html += `<li><button class="witch-poison-btn secondary-btn" data-uid="${p.id}">Poison ${shownName(p)}</button></li>`;
                });
                html += `</ul>`;
              }
              html += `<button id="witch-none-btn" class="secondary-btn">Do nothing tonight</button>`;
            } else {
              html += `<p>Your choice is locked in.</p>`;
            }
          } else if (myRole === 'seer' && seerCheckResult) {
            html += `<div class="banner">${seerCheckResult.targetName} is ${seerCheckResult.isWerewolf ? 'a \ud83d\udc3a Werewolf' : 'not a Werewolf'}.</div>`;
          } else {
            const label = myRole === 'doctor' ? 'Choose someone to save:'
              : myRole === 'chief_werewolf' ? 'Choose someone to eliminate:'
              : 'Choose someone to check:';
            html += `<h3>${label}</h3><ul class="player-list" id="night-action-list">`;
            alivePlayers.forEach(p => {
              html += `<li><button class="night-target-btn secondary-btn" data-uid="${p.id}">${shownName(p)}</button></li>`;
            });
            html += `</ul>`;
            if (myNightSubmitted && myRole !== 'seer') {
              html += `<p>Your choice is locked in.</p>`;
            }
          }
        } else {
          html += `<p>Waiting for the moderator...</p>`;
        }
      } else if (sessionData.votingOpen && iAmAlive && !sessionData.winner) {
        const eligibleIds = sessionData.voteEligibleTargets || null;
        const heading = eligibleIds ? 'Runoff vote \u2014 pick one:' : 'Vote to eliminate:';
        html += `<h3>${heading}</h3><ul class="player-list" id="vote-list">`;
        alivePlayers
          .filter(p => p.id !== playerId)
          .filter(p => !eligibleIds || eligibleIds.includes(p.id))
          .forEach(p => {
            const selected = myVote === p.id;
            html += `<li><button class="vote-btn secondary-btn${selected ? ' selected' : ''}" data-uid="${p.id}">${shownName(p)}${selected ? ' \u2714\ufe0f' : ''}</button></li>`;
          });
        html += `</ul>`;
        if (myVote) html += `<p>Your vote is in \u2014 tap another name to change it.</p>`;
      }
    }

    html += `<button class="logout-btn secondary-btn">Logout</button>`;
    roleContent.innerHTML = html;

    if (isMod) {
      document.querySelectorAll('.eliminate-btn').forEach(btn => {
        btn.addEventListener('click', () => eliminatePlayer(sessionId, btn.dataset.uid));
      });
      const startVotingBtn = document.getElementById('start-voting-btn');
      if (startVotingBtn) startVotingBtn.addEventListener('click', () => startVoting(sessionId));
      const revealBtn = document.getElementById('reveal-voting-btn');
      if (revealBtn) revealBtn.addEventListener('click', () => revealVoting(sessionId));
      const startNightBtn = document.getElementById('start-night-btn');
      if (startNightBtn) startNightBtn.addEventListener('click', () => startNight(sessionId));
      const advanceBtn = document.getElementById('advance-night-btn');
      if (advanceBtn) advanceBtn.addEventListener('click', () => advanceNight(sessionId, nightStep));
      const endNightBtn = document.getElementById('end-night-btn');
      if (endNightBtn) endNightBtn.addEventListener('click', () => endNight(sessionId));
      const playAgainBtn = document.getElementById('play-again-btn');
      if (playAgainBtn) playAgainBtn.addEventListener('click', () => resetSessionForRematch(sessionId));
    } else {
      document.querySelectorAll('.vote-btn').forEach(btn => {
        btn.addEventListener('click', () => castVote(sessionId, playerId, btn.dataset.uid));
      });
      document.querySelectorAll('.night-target-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const targetId = btn.dataset.uid;
          await submitNightAction(sessionId, myRole, targetId);
          myNightSubmitted = true;
          if (myRole === 'seer') {
            const isWolf = await checkPlayer(sessionId, targetId);
            const target = players.find(p => p.id === targetId);
            seerCheckResult = { targetName: target ? shownName(target) : 'That player', isWerewolf: isWolf };
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

  gameUnsubscribers.push(
    db.collection('werewolf_sessions').doc(sessionId).onSnapshot(doc => {
      const newData = doc.data() || {};

      // Moderator hit "Play Again" — status is back to 'lobby'. Send
      // everyone (including the moderator's own client) back to the lobby
      // to re-ready, rather than leaving them staring at a finished round.
      if (newData.status === 'lobby') {
        clearGameListeners();
        renderLobby(sessionId, playerId, isMod);
        showScreen('lobby-screen');
        return;
      }

      // A fresh night step (or leaving night phase) invalidates any
      // in-progress local action state from the previous step.
      if (newData.nightStep !== sessionData.nightStep || newData.phase !== sessionData.phase) {
        myNightSubmitted = false;
        seerCheckResult = null;
        witchWolfTargetName = null;
        witchWolfTargetFetched = false;
      }

      // Drumroll: hold a genuinely new announcement behind a suspense
      // banner for a moment before revealing it, so the room reveals
      // together instead of piecemeal. 'hunter_pending' skips this — it's
      // already itself a waiting state.
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

  gameUnsubscribers.push(
    db.collection(`werewolf_sessions/${sessionId}/players`).onSnapshot(snapshot => {
      players = [];
      snapshot.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
      render();

      // Non-moderator players don't call startGame() themselves, so this
      // listener is what moves them to the game screen once the
      // moderator assigns roles.
      const onLobbyScreen = document.getElementById('lobby-screen') &&
        document.getElementById('lobby-screen').classList.contains('active');
      if (onLobbyScreen) {
        const mine = players.find(p => p.id === playerId);
        if (mine && mine.role) renderGameScreen(sessionId, playerId, false, mine.role);
      }
    })
  );

  if (isMod) {
    // Moderator only ever sees a live count of how many have voted so
    // far — never who, and never the running tally per player.
    gameUnsubscribers.push(
      db.collection(`werewolf_sessions/${sessionId}/votes`).onSnapshot(snapshot => {
        voteCount = snapshot.size;
        render();
      })
    );
    // Moderator can see which night role has acted (and the Doctor's save
    // target / Witch's action, to cross-check against the werewolves'
    // out-loud kill) but never a Seer's check target — Firestore rules
    // don't expose that.
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
