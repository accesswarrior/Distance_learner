// js/spyfall/lobby.js
// The waiting room: players join and ready up, the operator starts.
// Listens to the SESSION as well as the players, so when the operator
// presses Start every phone moves into the game on its own.

let spyfallLobbyUnsubs = [];

function clearSpyfallLobbyListeners() {
  spyfallLobbyUnsubs.forEach(u => u());
  spyfallLobbyUnsubs = [];
}

function renderSpyfallLobby(sessionId, uid) {
  clearSpyfallLobbyListeners();
  showScreen('lobby-screen');

  const el = document.getElementById('lobby-content');
  el.innerHTML = `
    <h2>Spyfall Lobby</h2>
    <p>Room Code: <strong id="spyfall-code">${esc(sessionId)}</strong></p>
    <p id="spyfall-count">0 players</p>
    <ul class="player-list" id="spyfall-player-list"></ul>
    <p class="hint-text" id="spyfall-lobby-hint"></p>
    <button id="spyfall-ready-btn" class="secondary-btn">Ready</button>
    <button id="spyfall-start-btn" class="primary-btn" style="display:none;">Start Session</button>
    <p id="spyfall-lobby-error" class="error-message"></p>
    <a class="link-btn secondary-btn" href="../hub.html">← All games</a>
    <button class="logout-btn secondary-btn">Log out</button>
  `;

  let session = {};
  let players = [];

  function update() {
    const list = document.getElementById('spyfall-player-list');
    if (!list) return;
    const isOperator = session.operatorId === uid;
    const others = players.filter(p => p.id !== session.operatorId);
    const readyCount = others.filter(p => p.ready).length;

    list.innerHTML = players.map(p => {
      const tag = p.id === session.operatorId ? ' (operator)' : '';
      const ready = p.id !== session.operatorId && p.ready ? ' ✔️' : '';
      return `<li><span>${esc(p.displayName || 'Player')}${tag}${ready}${p.id === uid ? ' — you' : ''}</span></li>`;
    }).join('');
    document.getElementById('spyfall-count').textContent =
      `${players.length} player${players.length === 1 ? '' : 's'}`;

    const readyBtn = document.getElementById('spyfall-ready-btn');
    const startBtn = document.getElementById('spyfall-start-btn');
    const hint = document.getElementById('spyfall-lobby-hint');
    if (isOperator) {
      readyBtn.style.display = 'none';
      startBtn.style.display = 'block';
      const enough = others.length >= SPYFALL_MIN_PARTICIPANTS && readyCount === others.length;
      startBtn.disabled = !enough;
      startBtn.textContent = `Start Session (${readyCount}/${others.length} ready)`;
      hint.textContent = `You run round 1 and sit it out. Need ${SPYFALL_MIN_PARTICIPANTS}+ other players, all ready.`;
    } else {
      readyBtn.style.display = 'block';
      startBtn.style.display = 'none';
      const mine = players.find(p => p.id === uid);
      readyBtn.textContent = (mine && mine.ready) ? 'Not Ready' : 'Ready';
      hint.textContent = 'Waiting for the operator to start.';
    }
  }

  spyfallLobbyUnsubs.push(
    db.collection('spyfall_sessions').doc(sessionId).onSnapshot(doc => {
      if (!doc.exists) {
        clearSpyfallLobbyListeners();
        clearCurrentSession(uid, 'spyfall').catch(() => {});
        showScreen('lobby-choice-screen');
        return;
      }
      session = doc.data() || {};
      if (session.status === 'playing') {
        renderSpyfallGame(sessionId, uid);   // ui.js — also clears these lobby listeners
        return;
      }
      update();
    })
  );

  spyfallLobbyUnsubs.push(
    db.collection(`spyfall_sessions/${sessionId}/players`).onSnapshot(snap => {
      players = [];
      snap.forEach(d => players.push({ id: d.id, ...d.data() }));
      players.sort((a, b) => spyfallJoinedAtMillis(a) - spyfallJoinedAtMillis(b) || a.id.localeCompare(b.id));
      update();
    })
  );

  document.getElementById('spyfall-ready-btn').addEventListener('click', async () => {
    const mine = players.find(p => p.id === uid);
    if (!mine) return;
    try {
      await db.collection(`spyfall_sessions/${sessionId}/players`).doc(uid).update({ ready: !mine.ready });
    } catch (e) { console.warn('Could not toggle ready:', e); }
  });

  document.getElementById('spyfall-start-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('spyfall-lobby-error');
    errorEl.textContent = '';
    const ok = await confirmAction({
      title: 'Start the session?',
      message: 'You will run round 1 and sit it out. The operator rotates every round after that.',
      confirmLabel: 'Start'
    });
    if (!ok) return;
    try {
      await startSpyfallSession(sessionId);   // everyone's lobby listener then moves to the game
    } catch (e) {
      console.error(e);
      errorEl.textContent = e.message || "Couldn't start the session.";
    }
  });
}
