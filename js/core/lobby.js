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
    <button id="ready-btn">Ready</button>
    ${isModerator ? `<button id="start-btn" disabled>Start Game (need ${READY_THRESHOLD}+ ready)</button>` : ''}
    <button class="logout-btn secondary-btn">Leave / Logout</button>
  `;

  // Detach any previous listener (e.g. if the player left and joined another room)
  // before attaching a new one, to avoid stacking duplicate listeners.
  if (lobbyUnsubscribe) {
    lobbyUnsubscribe();
    lobbyUnsubscribe = null;
  }

  lobbyUnsubscribe = db.collection(`werewolf_sessions/${sessionId}/players`)
    .onSnapshot(snapshot => {
      const playerList = document.getElementById('player-list');
      if (!playerList) return; // user has navigated away from the lobby screen

      playerList.innerHTML = '';
      let readyCount = 0;

      snapshot.forEach(doc => {
        const data = doc.data();
        const li = document.createElement('li');
        li.textContent = `${data.username} ${data.ready ? '✔️' : ''}`;
        playerList.appendChild(li);
        if (data.ready) readyCount++;

        // Non-moderator players don't call startGame() themselves, so this
        // listener is what moves them to the role screen once the
        // moderator assigns roles.
        const onLobbyScreen = document.getElementById('lobby-screen').classList.contains('active');
        if (!isModerator && doc.id === currentPlayerId && data.role && onLobbyScreen) {
          showRoleScreen(data.role, null);
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

  document.getElementById('ready-btn').addEventListener('click', toggleReady);
  if (isModerator) {
    document.getElementById('start-btn').addEventListener('click', startGame);
  }
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

  // The moderator jumps to the role screen immediately, with the full role list.
  const myIndex = players.findIndex(p => p.id === currentPlayerId);
  const myRole = roles[myIndex];
  showRoleScreen(myRole, players.map((p, i) => ({ name: p.username, role: roles[i] })));
}
