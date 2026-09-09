// js/core/lobby.js

let currentSessionId = null;
let currentPlayerId = null;
let isModerator = false;
let lobbyUnsubscribe = null;

const READY_THRESHOLD = 8; // minimum ready players before the moderator can start

// Render the waiting room for a given session and attach a real-time listener.
function renderLobby(sessionId, playerId, isMod) {
  currentSessionId = sessionId;
  currentPlayerId = playerId;
  isModerator = isMod;

  const lobbyContent = document.getElementById('lobby-content');
  lobbyContent.innerHTML = `
    <h2>Game Lobby</h2>
    <p>Room Code: <strong id="room-code-display">${sessionId}</strong></p>
    <p id="player-count-display">0 players in room</p>
    <ul class="player-list" id="player-list">
      <!-- Players are listed here in real time -->
    </ul>
    ${isModerator
      ? `<button id="start-btn" disabled>Start Game (need ${READY_THRESHOLD}+ ready)</button>`
      : `<button id="ready-btn">Ready</button>`}
    <button class="logout-btn secondary-btn">Leave / Logout</button>
  `;

  // Detach any previous listener (e.g. if the player left and joined another room)
  // before attaching a new one, to avoid stacking duplicate listeners.
  if (lobbyUnsubscribe) {
    lobbyUnsubscribe();
    lobbyUnsubscribe = null;
  }

  // Moderator can remove a no-show or duplicate join before Start Game.
  // Attached once (delegated on the static <ul>, not rebuilt per snapshot)
  // so it never stacks duplicate listeners across re-renders.
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
      if (!playerList) return; // user has navigated away from the lobby screen

      // Non-moderator players have a players/{uid} doc for as long as
      // they're in the room. If it's gone, the moderator kicked them —
      // clean up the stale "resume this room" pointer and send them back
      // to the room-choice screen instead of leaving them stuck staring
      // at a lobby they're no longer part of.
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
        li.innerHTML = `<span>${data.username} ${data.ready ? '✔️' : ''}</span>` +
          (canKick ? `<button class="kick-btn secondary-btn" data-uid="${doc.id}">Remove</button>` : '');
        playerList.appendChild(li);
        if (data.ready) readyCount++;

        // Non-moderator players don't call startGame() themselves, so this
        // listener is what moves them to the game screen once the
        // moderator assigns roles.
        const onLobbyScreen = document.getElementById('lobby-screen').classList.contains('active');
        if (!isModerator && doc.id === currentPlayerId && data.role && onLobbyScreen) {
          renderGameScreen(currentSessionId, currentPlayerId, false, data.role);
        }
      });

      const totalPlayers = snapshot.size;
      const countDisplay = document.getElementById('player-count-display');
      if (countDisplay) {
        countDisplay.textContent = `${totalPlayers} player${totalPlayers === 1 ? '' : 's'} in room (${readyCount} ready)`;
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
    .catch(() => {}); // best-effort; not worth blocking on
  alert("You were removed from the room by the moderator.");
  showScreen('lobby-choice-screen');
}

async function toggleReady() {
  const playerRef = db.collection(`werewolf_sessions/${currentSessionId}/players`).doc(currentPlayerId);
  const doc = await playerRef.get();
  const current = doc.data().ready || false;
  await playerRef.update({ ready: !current });
}

async function startGame() {
  const playersSnapshot = await db.collection(`werewolf_sessions/${currentSessionId}/players`).get();
  const players = [];
  playersSnapshot.forEach(doc => players.push({ id: doc.id, ...doc.data() }));

  const roles = assignRoles(players.length); // from js/games/werewolf/rules.js

  const batch = db.batch();
  players.forEach((player, index) => {
    batch.update(
      db.collection(`werewolf_sessions/${currentSessionId}/players`).doc(player.id),
      { role: roles[index], alive: true }
    );
  });
  await batch.commit();
  await db.collection('werewolf_sessions').doc(currentSessionId).update({ status: 'started' });

  // The moderator jumps to the game screen immediately, with the full role list
  // and the eliminate/voting controls. The moderator never has a players/{uid}
  // doc (they're not dealt a role), so pass null rather than an undefined role.
  renderGameScreen(currentSessionId, currentPlayerId, true, null);
}
