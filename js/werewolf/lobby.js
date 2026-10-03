// js/werewolf/lobby.js
// Waiting room. Only in play while session.status === 'lobby'.
//
// Listens to the PUBLIC /roster collection, not /players. A regular
// player reads their private players/{uid} document separately; an
// unfiltered /players collection query is not permitted by the private
// document rules. /roster is safe for everyone to read in full,
// since it never contains role or potion/hunter state. See engine.js's
// header comment for the full schema split.

let currentSessionId = null;
let currentPlayerId = null;
let isModerator = false;
let lobbyUnsubscribe = null;
let lobbyUnsubscribe_ownRole = null;

const READY_THRESHOLD = 8;

function renderLobby(sessionId, playerId, isMod) {
  currentSessionId = sessionId;
  currentPlayerId = playerId;
  isModerator = isMod;

  if (!isMod) {
    db.collection(`werewolf_sessions/${sessionId}/players`).doc(playerId).get().then(doc => {
      if (!doc.exists) {
        clearCurrentSession(playerId, 'werewolf').catch(() => {});
        showScreen('lobby-choice-screen');
      }
    }).catch(() => {});
  }

  const lobbyContent = document.getElementById('lobby-content');
  lobbyContent.innerHTML = `
    <h2>Game Lobby</h2>
    <p>Room Code: <strong id="room-code-display">${esc(sessionId)}</strong></p>
    <p id="player-count-display">0 players in room</p>
    <ul class="player-list" id="player-list"></ul>
    ${isModerator
      ? `<button id="start-btn" disabled>Start Game (need ${READY_THRESHOLD}+ ready)</button>`
      : `<button id="ready-btn">Ready</button>`}
    <button class="how-to-play-btn">❓ How to Play</button>
    <a class="link-btn secondary-btn" href="../hub.html">← All games</a>
    <button class="logout-btn secondary-btn">Log out</button>
  `;

  // renderLobby runs again every time this session returns to the lobby —
  // not just on first join, but on every "Play Again" rematch too — so
  // both listeners from any PREVIOUS call must be torn down here, not just
  // the roster one. Leaving lobbyUnsubscribe_ownRole running would stack
  // one more live snapshot subscription per phone on every rematch.
  if (lobbyUnsubscribe) { lobbyUnsubscribe(); lobbyUnsubscribe = null; }
  if (lobbyUnsubscribe_ownRole) { lobbyUnsubscribe_ownRole(); lobbyUnsubscribe_ownRole = null; }

  if (isModerator) {
    document.getElementById('player-list').addEventListener('click', (e) => {
      if (e.target.classList.contains('kick-btn')) {
        kickPlayer(currentSessionId, e.target.dataset.uid);
      }
    });
  }

  // Guard against a spurious "you were removed" if the very first snapshot
  // arrives before our own join write has echoed locally — we only treat a
  // missing self as a genuine removal AFTER we've seen ourselves at least
  // once. The moderator has no player doc, so this branch never fires for
  // them.
  let sawMyself = false;

  lobbyUnsubscribe = db.collection(`werewolf_sessions/${sessionId}/roster`)
    .onSnapshot(snapshot => {
      const playerList = document.getElementById('player-list');
      if (!playerList) return;

      const selfPresent = snapshot.docs.some(doc => doc.id === currentPlayerId);
      if (selfPresent) sawMyself = true;

      if (!isModerator && sawMyself && !selfPresent) {
        handleRemovedFromLobby();
        return;
      }

      playerList.innerHTML = '';
      let readyCount = 0;

      snapshot.forEach(doc => {
        const data = doc.data();
        const li = document.createElement('li');
        const canKick = isModerator && doc.id !== currentPlayerId;
        const shown = data.displayName;
        li.innerHTML = `<span>${esc(shown)} ${data.ready ? '✔️' : ''}</span>` +
          (canKick ? `<button class="kick-btn secondary-btn" data-uid="${doc.id}">Remove</button>` : '');
        playerList.appendChild(li);
        if (data.ready) readyCount++;
      });

      const total = snapshot.size;
      const countDisplay = document.getElementById('player-count-display');
      if (countDisplay) {
        countDisplay.textContent =
          `${total} player${total === 1 ? '' : 's'} in room (${readyCount} ready)`;
      }

      const startBtn = document.getElementById('start-btn');
      if (isModerator && startBtn) {
        startBtn.disabled = readyCount < READY_THRESHOLD;
      }
    });

  // Roles are assigned on the PRIVATE /players doc, which a regular
  // player can read only their own copy of — so their own doc's onSnapshot
  // (not the roster listener above) is what notices a role has landed and
  // moves them from the lobby to the game screen.
  if (!isModerator) {
    lobbyUnsubscribe_ownRole = db.collection(`werewolf_sessions/${sessionId}/players`).doc(playerId)
      .onSnapshot(doc => {
        const data = doc.data();
        const onLobbyScreen = document.getElementById('lobby-screen').classList.contains('active');
        if (data && data.role && onLobbyScreen) {
          renderGameScreen(sessionId, playerId, false);
        }
      });
  }

  if (isModerator) {
    document.getElementById('start-btn').addEventListener('click', startGame);
  } else {
    document.getElementById('ready-btn').addEventListener('click', toggleReady);
  }
}

async function handleRemovedFromLobby() {
  if (lobbyUnsubscribe) { lobbyUnsubscribe(); lobbyUnsubscribe = null; }
  if (lobbyUnsubscribe_ownRole) { lobbyUnsubscribe_ownRole(); lobbyUnsubscribe_ownRole = null; }
  await clearCurrentSession(currentPlayerId, 'werewolf').catch(() => {});
  alert("You're no longer in this room — either the moderator removed you, or the game started without you because you weren't marked Ready.");
  showScreen('lobby-choice-screen');
}

async function toggleReady() {
  const playerRef = db.collection(`werewolf_sessions/${currentSessionId}/players`).doc(currentPlayerId);
  const rosterRef = db.collection(`werewolf_sessions/${currentSessionId}/roster`).doc(currentPlayerId);
  const doc = await playerRef.get();
  if (!doc.exists) {
    await clearCurrentSession(currentPlayerId, 'werewolf').catch(() => {});
    showScreen('lobby-choice-screen');
    return;
  }
  const data = doc.data() || {};
  if (data.participationStatus === 'removed') {
    showScreen('lobby-choice-screen');
    return;
  }
  const newReady = !(data.ready || false);
  const batch = db.batch();
  batch.update(playerRef, { ready: newReady });
  batch.set(rosterRef, { ready: newReady }, { merge: true });
  await batch.commit();
}

async function startGame() {
  const ok = await confirmAction({
    title: 'Start the game?',
    message: 'Only players who have marked themselves Ready will be dealt a role. Everyone else will be removed from the room.',
    confirmLabel: 'Start Game'
  });
  if (!ok) return;

  const sessionRef = db.collection('werewolf_sessions').doc(currentSessionId);

  // Flip status to 'starting' FIRST, in its own write, before reading the
  // roster inside dealAndStart(). joinSession() refuses to add a new player
  // once status isn't 'lobby', so this closes the window where someone could
  // join between "read the roster" and "assign roles" and end up with a
  // players/{uid} doc that never gets a role. Bundling this flip into the
  // SAME batch as the role assignment would reopen that exact race.
  await sessionRef.update({ status: 'starting', pendingPotionFlags: [] });

  const result = await dealAndStart(currentSessionId, currentPlayerId); // engine.js
  if (!result.ok) {
    alert(`Need at least ${READY_THRESHOLD} ready players to start.`);
    return;
  }

  renderGameScreen(currentSessionId, currentPlayerId, true);
}
