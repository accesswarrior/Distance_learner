// js/games/werewolf/ui.js
//
// Renders the post-lobby "game screen": role reveal, plus everything that
// happens after Start Game — moderator's eliminate/voting/night controls,
// the player's own voting or night-action UI, and any announcement or
// winner banner. Stays live via Firestore listeners so roles, eliminations,
// and night/day phase changes update in real time on every phone.

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
  let nightActionsMap = {};   // moderator-only: { role: { targetId } }
  let myNightSubmitted = false; // did I already act during the current step
  let seerCheckResult = null;   // local-only, never written to Firestore

  function renderAnnouncement(a) {
    if (a.type === 'werewolf_out') {
      return `<div class="banner">🐺 A Werewolf was voted out: <strong>${a.name}</strong></div>`;
    }
    if (a.type === 'night_death') {
      return `<div class="banner">💀 <strong>${a.name}</strong> died during the night.</div>`;
    }
    if (a.type === 'no_night_death') {
      return `<div class="banner">☀️ No one died last night.</div>`;
    }
    if (a.type === 'tie') {
      return `<div class="banner">It's a tie between <strong>${a.names.join(', ')}</strong> — vote again, only between them.</div>`;
    }
    if (a.type === 'still_tied') {
      return `<div class="banner">Still tied between <strong>${a.names.join(', ')}</strong> — no one is eliminated this round.</div>`;
    }
    return `<div class="banner">Nobody was voted out.</div>`;
  }

  function render() {
    const roleContent = document.getElementById('role-content');
    if (!roleContent) return; // navigated away

    const me = players.find(p => p.id === playerId);
    const iAmAlive = !me || me.alive !== false;
    const alivePlayers = players.filter(p => p.alive !== false);
    const phase = sessionData.phase || 'day'; // sessions started before this feature default to day
    const nightStep = sessionData.nightStep || null;

    // Moderators are never dealt a role, so myRole is null for them —
    // show a distinct card instead of a player role card.
    const roleLabel = myRole ? myRole.replace(/_/g, ' ').toUpperCase() : '';
    let html = myRole
      ? `<div class="role-card">You are: <strong>${roleLabel}</strong>${iAmAlive ? '' : ' (eliminated)'}</div>`
      : `<div class="role-card">You are the <strong>Game Master</strong> — running this round.</div>`;

    if (sessionData.winner) {
      const side = sessionData.winner === 'werewolves' ? '🐺 Werewolves' : '🧑‍🌾 Villagers';
      html += `<div class="banner winner-banner">${side} win!</div>`;
    } else if (phase === 'night') {
      html += `<div class="banner">🌙 Night${nightStep && nightStep !== 'done' ? ` — ${nightStep} acting` : ''}</div>`;
    } else if (sessionData.announcement) {
      html += renderAnnouncement(sessionData.announcement);
    }

    if (isMod) {
      html += `<h3>All Roles</h3><ul class="player-list">`;
      players.forEach(p => {
        const eliminated = p.alive === false;
        html += `<li>
          <span>${shownName(p)}: ${p.role}${eliminated ? ' — eliminated' : ''}</span>
          ${!eliminated ? `<button class="eliminate-btn secondary-btn" data-uid="${p.id}">Eliminate</button>` : ''}
        </li>`;
      });
      html += `</ul>`;

      if (!sessionData.winner) {
        if (phase === 'night') {
          html += `<div class="night-panel"><h3>Night sequence</h3>`;
          if (nightStep === 'done') {
            html += `<p>All night actions are in.</p><button id="end-night-btn" class="primary-btn">End Night</button>`;
          } else {
            const submitted = !!nightActionsMap[nightStep];
            html += `<p>Active: <strong>${nightStep}</strong> — ${submitted ? '✔️ chosen' : 'waiting for their choice...'}</p>`;
            html += `<button id="advance-night-btn" class="primary-btn">${submitted ? 'Next' : 'Skip / Next'}</button>`;
          }
          if (nightActionsMap.doctor) {
            const saved = players.find(p => p.id === nightActionsMap.doctor.targetId);
            html += `<p class="hint-text">Doctor is protecting: ${saved ? shownName(saved) : '—'}</p>`;
          }
          if (nightActionsMap.chief_werewolf) {
            const target = players.find(p => p.id === nightActionsMap.chief_werewolf.targetId);
            html += `<p class="hint-text">Chief Werewolf is targeting: ${target ? shownName(target) : '—'}</p>`;
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
          html += `<p>${voteCount} of ${alivePlayers.length} alive players voted${runoffNames ? ` — runoff: ${runoffNames}` : ''}</p>`;
          html += `<button id="reveal-voting-btn" class="primary-btn">Reveal Result</button>`;
        }
      }
    } else if (phase === 'night' && !sessionData.winner) {
      if (myRole === nightStep && iAmAlive) {
        if (myRole === 'seer' && seerCheckResult) {
          html += `<div class="banner">${seerCheckResult.targetName} is ${seerCheckResult.isWerewolf ? 'a 🐺 Werewolf' : 'not a Werewolf'}.</div>`;
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
      const heading = eligibleIds ? 'Runoff vote — pick one:' : 'Vote to eliminate:';
      html += `<h3>${heading}</h3><ul class="player-list" id="vote-list">`;
      alivePlayers
        .filter(p => p.id !== playerId)
        .filter(p => !eligibleIds || eligibleIds.includes(p.id))
        .forEach(p => {
        const selected = myVote === p.id;
        html += `<li><button class="vote-btn secondary-btn${selected ? ' selected' : ''}" data-uid="${p.id}">${shownName(p)}${selected ? ' ✔️' : ''}</button></li>`;
      });
      html += `</ul>`;
      if (myVote) html += `<p>Your vote is in — tap another name to change it.</p>`;
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
    }
  }

  gameUnsubscribers.push(
    db.collection('werewolf_sessions').doc(sessionId).onSnapshot(doc => {
      const newData = doc.data() || {};
      // A fresh night step (or leaving night phase) invalidates any
      // in-progress local action state from the previous step.
      if (newData.nightStep !== sessionData.nightStep || newData.phase !== sessionData.phase) {
        myNightSubmitted = false;
        seerCheckResult = null;
      }
      sessionData = newData;
      render();
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
    // Moderator can see which night role has acted (and the Doctor's
    // save target, to cross-check against the werewolves' out-loud kill)
    // but never a Seer's check target — Firestore rules don't expose that.
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
