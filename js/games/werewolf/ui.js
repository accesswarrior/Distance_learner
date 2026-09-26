// js/games/werewolf/ui.js
// Renders the live game screen: role reveal + everything after Start Game.
//
// Two features worth calling out up front:
//
// 1. Reveal acknowledgements ("tap to confirm"). Every announcement that
//    needs the room's attention (a night death, a vote result, a hunter's
//    shot) is gated behind a per-player tap. session.deathSeen accumulates
//    the uids who've acked; the moderator's primary controls only
//    reappear when every living player is on that list. The moderator has
//    a Force button as an escape hatch (dead phone, player stepped out).
//
// 2. The potion-flag queue. The Witch can't write her own potion flags
//    (rules restrict player self-writes to `ready`), so she appends to
//    session.pendingPotionFlags. The moderator's client — the only one
//    allowed to write those fields — applies them and prunes the queue.

let gameUnsubscribers = [];

function clearGameListeners() {
  gameUnsubscribers.forEach(unsub => unsub());
  gameUnsubscribers = [];
}

function shownName(p) {
  return p.displayName || p.username;
}

function renderGameScreen(sessionId, playerId, isMod, myRole) {
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

  // Drumroll state
  let showingSuspense = false;
  let displayedAnnouncementKey = null;
  let suspenseTimer = null;

  // Ack state — was I in deathSeen at the moment I first saw this announcement?
  let pendingAckKey = null;
  let myDeathSeen = false;

  // ---------------------------------------------------------------
  // Announcement helpers
  // ---------------------------------------------------------------

  function announcementNeedsAck(a) {
    // 'hunter_pending' is itself a wait state; nothing for anyone to ack.
    return !!a && a.type !== 'hunter_pending';
  }

  function allAliveHaveSeen() {
    if (!announcementNeedsAck(sessionData.announcement)) return true;
    const seen = sessionData.deathSeen || [];
    return players.filter(p => p.alive !== false).every(p => seen.includes(p.id));
  }

  function acknowledgeAnnouncement() {
    if (!pendingAckKey) return;
    // Optimistic hide; the snapshot listener is the source of truth.
    pendingAckKey = null;
    render();
    db.collection('werewolf_sessions').doc(sessionId)
      .update({ deathSeen: firebase.firestore.FieldValue.arrayUnion(playerId) })
      .catch(err => console.warn('Could not record acknowledgement:', err));
  }

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

  // ---------------------------------------------------------------
  // Potion-flag queue (moderator applies; rules don't let the Witch)
  // ---------------------------------------------------------------

  let applyingPotionFlags = false;
  async function applyPendingPotionFlags(queue) {
    if (applyingPotionFlags || !queue || !queue.length) return;
    applyingPotionFlags = true;
    try {
      // Dedupe by witchUid — last intent wins.
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
  // Main render
  // ---------------------------------------------------------------

  function render() {
    const roleContent = document.getElementById('role-content');
    if (!roleContent) return;

    const me = players.find(p => p.id === playerId);
    const iAmAlive = !me || me.alive !== false;
    const alivePlayers = players.filter(p => p.alive !== false);
    const phase = sessionData.phase || 'day';
    const nightStep = sessionData.nightStep || null;

    // Hunter's pending shot takes over the Hunter's own screen entirely.
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

    // Role card
    const roleLabel = myRole ? myRole.replace(/_/g, ' ').toUpperCase() : '';
    let html = myRole
      ? `<div class="role-card">You are: <strong>${roleLabel}</strong>${iAmAlive ? '' : ' (eliminated)'}</div>`
      : `<div class="role-card">You are the <strong>Game Master</strong> \u2014 running this round.</div>`;

    // Top banner
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

    // Player ack button — only for the alive player who hasn't acked yet.
    const showAckButton = !isMod
      && iAmAlive
      && announcementNeedsAck(sessionData.announcement)
      && !showingSuspense
      && pendingAckKey === displayedAnnouncementKey;
    if (showAckButton) {
      html += `<button id="ack-announce-btn" class="primary-btn ack-btn">Tap to confirm you've seen this</button>`;
    }

    // Role composition (everyone)
    if (sessionData.roleComposition) {
      html += `<details class="composition-details"><summary>\u2139\ufe0f Role composition</summary><ul class="player-list">`;
      Object.entries(sessionData.roleComposition).forEach(([role, count]) => {
        html += `<li><span>${role.replace(/_/g, ' ')}</span><span>${count}</span></li>`;
      });
      html += `</ul></details>`;
    }

    if (isMod) {
      // ===================== MODERATOR =====================

      html += `<h3>All Roles</h3><ul class="player-list">`;
      players.forEach(p => {
        const eliminated = p.alive === false;
        html += `<li>
          <span>${shownName(p)}: ${p.role}${eliminated ? ' \u2014 eliminated' : ''}</span>
          ${!eliminated ? `<button class="eliminate-btn secondary-btn" data-uid="${p.id}">Eliminate</button>` : ''}
        </li>`;
      });
      html += `</ul>`;

      if (sessionData.roleComposition) {
        html += `<details class="composition-details"><summary>\ud83d\udcd6 What each role does</summary><ul class="player-list">`;
        Object.keys(sessionData.roleComposition).forEach(role => {
          html += `<li><span><strong>${role.replace(/_/g, ' ')}</strong>: ${ROLE_DESCRIPTIONS[role] || ''}</span></li>`;
        });
        html += `</ul></details>`;
      }

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
          // The ack gate. Primary controls only appear when every living
          // player has acked the last announcement — or there's nothing to
          // ack. Force button is the escape hatch.
          if (!allAliveHaveSeen()) {
            const seenCount = players.filter(p => p.alive !== false && (sessionData.deathSeen || []).includes(p.id)).length;
            const aliveCount = players.filter(p => p.alive !== false).length;
            html += `<p>\u23f3 Waiting for everyone to confirm the reveal (${seenCount} of ${aliveCount})...</p>`;
            html += `<button id="force-ack-btn" class="secondary-btn">Everyone has seen it \u2014 continue anyway</button>`;
          } else {
            html += `<button id="start-night-btn" class="primary-btn">Start Night</button>`;
            html += `<button id="start-voting-btn" class="primary-btn">Start Voting</button>`;
          }
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
      // ===================== PLAYER =====================

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
              witchWolfTargetFetched = true;
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

    // Event wiring
    const ackBtn = document.getElementById('ack-announce-btn');
    if (ackBtn) ackBtn.addEventListener('click', acknowledgeAnnouncement);

    const forceAckBtn = document.getElementById('force-ack-btn');
    if (forceAckBtn) {
      forceAckBtn.addEventListener('click', () => {
        db.collection('werewolf_sessions').doc(sessionId)
          .update({ deathSeen: players.filter(p => p.alive !== false).map(p => p.id) })
          .catch(err => console.warn('Could not force-continue:', err));
      });
    }

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
          if (myRole === 'seer') {
            // Two writes: mark the step done (public, carries no info),
            // then read the target's role (private to the Seer).
            await markSeerDone(sessionId);
            myNightSubmitted = true;
            const isWolf = await checkPlayer(sessionId, targetId);
            const target = players.find(p => p.id === targetId);
            seerCheckResult = { targetName: target ? shownName(target) : 'That player', isWerewolf: isWolf };
          } else {
            await submitNightAction(sessionId, myRole, targetId);
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

      // Rematch: status is back to 'lobby'. Send everyone back.
      if (newData.status === 'lobby') {
        clearGameListeners();
        renderLobby(sessionId, playerId, isMod);
        showScreen('lobby-screen');
        return;
      }

      // A fresh night step invalidates any local action state from the
      // previous step, and the moderator's cached nightActionsMap.
      if (newData.nightStep !== sessionData.nightStep || newData.phase !== sessionData.phase) {
        myNightSubmitted = false;
        seerCheckResult = null;
        witchWolfTargetName = null;
        witchWolfTargetFetched = false;
        nightActionsMap = {};
      }

      // Drumroll logic.
      if (suspenseTimer) { clearTimeout(suspenseTimer); suspenseTimer = null; }
      const newAnnouncement = newData.announcement || null;
      const newKey = newAnnouncement ? JSON.stringify(newAnnouncement) : null;
      const isGenuinelyNew = newKey && newKey !== displayedAnnouncementKey;
      const skipSuspense = newAnnouncement && newAnnouncement.type === 'hunter_pending';

      sessionData = newData;
      myDeathSeen = (sessionData.deathSeen || []).includes(playerId);

      if (isGenuinelyNew && !skipSuspense) {
        showingSuspense = true;
        render();
        suspenseTimer = setTimeout(() => {
          showingSuspense = false;
          displayedAnnouncementKey = newKey;
          // Arm the ack only now — the player has just seen the reveal.
          pendingAckKey = myDeathSeen ? null : newKey;
          suspenseTimer = null;
          render();
        }, 2200);
      } else {
        showingSuspense = false;
        displayedAnnouncementKey = newKey;
        // Already seen, or exempt (hunter_pending), or nothing to ack.
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

      // Non-moderator players move to the game screen once they have a role.
      const onLobbyScreen = document.getElementById('lobby-screen') &&
        document.getElementById('lobby-screen').classList.contains('active');
      if (onLobbyScreen) {
        const mine = players.find(p => p.id === playerId);
        if (mine && mine.role) renderGameScreen(sessionId, playerId, false, mine.role);
      }

      // Potion-flag queue: only the moderator applies and prunes.
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
