// js/core/lobby.js
// Waiting room rendering + the listeners that fire when a game starts.

let currentSessionId = null;
let currentPlayerId = null;
let isModerator = false;
let lobbyUnsubscribe = null;

const READY_THRESHOLD = 8; // minimum ready players before the moderator can start

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

  if (lobbyUnsubscribe) {
    lobbyUnsubscribe();
    lobbyUnsubscribe = null;
  }

  // Delegated on the static <ul>, so we never stack listeners across
  // re-renders.
  if (isModerator) {
    document.getElementById('player-list').addEventListener('click', (e) => {
      if (e.target.classList.contains('kick-btn')) {
        kickPlayer(currentSessionId, e.target.dataset.uid);
      }
    });
  }

  lobbyUnsubscribe = db.collection(`werewolf_sessions/${sessionId}/players`)
    .onSnapshot(snapshot => {
      const playerList = document.getElementById('player-list');
      if (!playerList) return; // navigated away

      // Non-moderator whose player doc is gone = kicked. Clean up the
      // stale resume pointer and send them home.
      if (!isModerator && !snapshot.docs.some(doc => doc.id === currentPlayerId)) {
        handleRemovedFromLobby();
        return;
      }

      playerList.innerHTML = '';
      let readyCount = 0;

      snapshot.forEach(doc => {
        const data = doc.data();
        const li = document.createElement('li');
        const canKick = isModerator && doc.id !== currentPlayerId;
        const shownName = data.displayName || data.username;
        li.innerHTML = `<span>${shownName} ${data.ready ? '✔️' : ''}</span>` +
          (canKick ? `<button class="kick-btn secondary-btn" data-uid="${doc.id}">Remove</button>` : '');
        playerList.appendChild(li);
        if (data.ready) readyCount++;

        // Non-moderator players don't call startGame() themselves, so this
        // is what moves them to the game screen once roles are assigned.
        const onLobbyScreen = document.getElementById('lobby-screen').classList.contains('active');
        if (!isModerator && doc.id === currentPlayerId && data.role && onLobbyScreen) {
          renderGameScreen(currentSessionId, currentPlayerId, false, data.role);
        }
      });

      const totalPlayers = snapshot.size;
      const countDisplay = document.getElementById('player-count-display');
      if (countDisplay) {
        countDisplay.textContent =
          `${totalPlayers} player${totalPlayers === 1 ? '' : 's'} in room (${readyCount} ready)`;
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
  if (lobbyUnsubscribe) {
    lobbyUnsubscribe();
    lobbyUnsubscribe = null;
  }
  await db.collection('werewolf_users').doc(currentPlayerId)
    .update({ currentSessionId: firebase.firestore.FieldValue.delete() })
    .catch(() => {});
  alert("You're no longer in this room — either the moderator removed you, or the game started without you because you weren't marked Ready.");
  showScreen('lobby-choice-screen');
}

async function toggleReady() {
  const playerRef = db.collection(`werewolf_sessions/${currentSessionId}/players`).doc(currentPlayerId);
  const doc = await playerRef.get();
  const current = doc.data().ready || false;
  await playerRef.update({ ready: !current });
}

async function startGame() {
  // Flip status first, so joinSession() closes to new players. There is
  // still a hairline race if a join is already mid-flight the instant this
  // write lands; fixing it fully would need a transaction.
  await db.collection('werewolf_sessions').doc(currentSessionId).update({ status: 'started' });

  // Only players who readied up get a role. Everyone else is removed the
  // same way a kick would remove them.
  const playersSnapshot = await db.collection(`werewolf_sessions/${currentSessionId}/players`).get();
  const readyPlayers = [];
  const notReadyRefs = [];
  playersSnapshot.forEach(doc => {
    if (doc.id === currentPlayerId) return; // defensive: stray moderator doc
    if (doc.data().ready) {
      readyPlayers.push({ id: doc.id, ...doc.data() });
    } else {
      notReadyRefs.push(doc.ref);
    }
  });

  const roles = assignRoles(readyPlayers.length); // rules.js

  const batch = db.batch();
  readyPlayers.forEach((player, index) => {
    const role = roles[index];
    const update = { role: role, alive: true };
    if (role === 'witch')  { update.healPotionUsed = false; update.poisonPotionUsed = false; }
    if (role === 'hunter') { update.hunterShotUsed = false; }
    batch.update(
      db.collection(`werewolf_sessions/${currentSessionId}/players`).doc(player.id),
      update
    );
  });
  notReadyRefs.forEach(ref => batch.delete(ref));
  batch.set(db.collection('werewolf_sessions').doc(currentSessionId), {
    roleComposition: roleComposition(roles)
  }, { merge: true });
  await batch.commit();

  renderGameScreen(currentSessionId, currentPlayerId, true, null);
}
