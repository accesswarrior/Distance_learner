// js/core/lobby.js
// Waiting room. Only in play while session.status === 'lobby'.

let currentSessionId = null;
let currentPlayerId = null;
let isModerator = false;
let lobbyUnsubscribe = null;

const READY_THRESHOLD = 8;

function renderLobby(sessionId, playerId, isMod) {
  currentSessionId = sessionId;
  currentPlayerId = playerId;
  isModerator = isMod;

  const lobbyContent = document.getElementById('lobby-content');
  lobbyContent.innerHTML = `
    <h2>Game Lobby</h2>
    <p>Room Code: <strong id="room-code-display">${sessionId}</strong></p>
    <p id="player-count-display">0 players in room</p>
    <ul class="player-list" id="player-list"></ul>
    ${isModerator
      ? `<button id="start-btn" disabled>Start Game (need ${READY_THRESHOLD}+ ready)</button>`
      : `<button id="ready-btn">Ready</button>`}
    <button class="logout-btn secondary-btn">Leave / Logout</button>
  `;

  if (lobbyUnsubscribe) { lobbyUnsubscribe(); lobbyUnsubscribe = null; }

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

  lobbyUnsubscribe = db.collection(`werewolf_sessions/${sessionId}/players`)
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
        const shown = data.displayName || data.username;
        li.innerHTML = `<span>${esc(shown)} ${data.ready ? '✔️' : ''}</span>` +
          (canKick ? `<button class="kick-btn secondary-btn" data-uid="${doc.id}">Remove</button>` : '');
        playerList.appendChild(li);
        if (data.ready) readyCount++;

        const onLobbyScreen = document.getElementById('lobby-screen').classList.contains('active');
        if (!isModerator && doc.id === currentPlayerId && data.role && onLobbyScreen) {
          renderGameScreen(currentSessionId, currentPlayerId, false);
        }
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

  if (isModerator) {
    document.getElementById('start-btn').addEventListener('click', startGame);
  } else {
    document.getElementById('ready-btn').addEventListener('click', toggleReady);
  }
}

async function handleRemovedFromLobby() {
  if (lobbyUnsubscribe) { lobbyUnsubscribe(); lobbyUnsubscribe = null; }
  await db.collection('werewolf_users').doc(currentPlayerId)
    .update({ currentSessionId: firebase.firestore.FieldValue.delete() })
    .catch(() => {});
  alert("You're no longer in this room — either the moderator removed you, or the game started without you because you weren't marked Ready.");
  showScreen('lobby-choice-screen');
}

async function toggleReady() {
  const ref = db.collection(`werewolf_sessions/${currentSessionId}/players`).doc(currentPlayerId);
  const doc = await ref.get();
  await ref.update({ ready: !(doc.data().ready || false) });
}

async function startGame() {
  const ok = await confirmAction({
    title: 'Start the game?',
    message: 'Only players who have marked themselves Ready will be dealt a role. Everyone else will be removed from the room.',
    confirmLabel: 'Start Game'
  });
  if (!ok) return;

  const sessionRef = db.collection('werewolf_sessions').doc(currentSessionId);

  const playersSnapshot = await sessionRef.collection('players').get();
  const readyPlayers = [];
  const notReadyRefs = [];
  playersSnapshot.forEach(doc => {
    if (doc.id === currentPlayerId) return;
    if (doc.data().ready) readyPlayers.push({ id: doc.id, ...doc.data() });
    else notReadyRefs.push(doc.ref);
  });

  if (readyPlayers.length < READY_THRESHOLD) {
    alert(`Need at least ${READY_THRESHOLD} ready players to start.`);
    return;
  }

  const roles = assignRoles(readyPlayers.length);

  const batch = db.batch();
  batch.update(sessionRef, {
    status: 'started',
    pendingPotionFlags: []
  });
  readyPlayers.forEach((player, index) => {
    const role = roles[index];
    const update = { role: role, alive: true, participationStatus: 'active' };
    if (role === 'witch')  { update.healPotionUsed = false; update.poisonPotionUsed = false; }
    if (role === 'hunter') { update.hunterShotUsed = false; }
    batch.update(sessionRef.collection('players').doc(player.id), update);
  });
  notReadyRefs.forEach(ref => batch.delete(ref));
  batch.set(sessionRef, { roleComposition: roleComposition(roles) }, { merge: true });
  await batch.commit();

  renderGameScreen(currentSessionId, currentPlayerId, true);
}
