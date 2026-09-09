// js/games/werewolf/ui.js
//
// Renders the post-lobby "game screen": role reveal, plus everything that
// happens after Start Game — moderator's eliminate/voting controls, the
// player's own voting UI, and any announcement or winner banner. Unlike
// the old static showRoleScreen(), this stays live via Firestore listeners
// so both roles and eliminations update in real time on every phone.

let gameUnsubscribers = [];

function clearGameListeners() {
  gameUnsubscribers.forEach(unsub => unsub());
  gameUnsubscribers = [];
}

// sessionId/playerId/isMod/myRole are enough to drive the whole screen —
// everything else (roster, alive status, votes, winner) is pulled live.
function renderGameScreen(sessionId, playerId, isMod, myRole) {
  clearGameListeners();
  showScreen('role-screen');

  let sessionData = {};
  let players = [];
  let voteCount = 0;
  let myVote = null;

  function renderAnnouncement(a) {
    if (a.type === 'werewolf_out') {
      return `<div class="banner">\ud83d\udc3a A Werewolf was voted out: <strong>${a.name}</strong></div>`;
    }
    return `<div class="banner">Nobody was voted out.</div>`;
  }

  function render() {
    const roleContent = document.getElementById('role-content');
    if (!roleContent) return; // navigated away

    const me = players.find(p => p.id === playerId);
    const iAmAlive = !me || me.alive !== false;
    const alivePlayers = players.filter(p => p.alive !== false);

    // Moderators are never dealt a role, so myRole is null for them —
    // show a distinct card instead of a player role card.
    let html = myRole
      ? `<div class="role-card">You are: <strong>${myRole.toUpperCase()}</strong>${iAmAlive ? '' : ' (eliminated)'}</div>`
      : `<div class="role-card">You are the <strong>Game Master</strong> — running this round.</div>`;

    if (sessionData.winner) {
      const side = sessionData.winner === 'werewolves' ? '\ud83d\udc3a Werewolves' : '\ud83e\uddd1\u200d\ud83c\udf3e Villagers';
      html += `<div class="banner winner-banner">${side} win!</div>`;
    } else if (sessionData.announcement) {
      html += renderAnnouncement(sessionData.announcement);
    }

    if (isMod) {
      html += `<h3>All Roles</h3><ul class="player-list">`;
      players.forEach(p => {
        const eliminated = p.alive === false;
        html += `<li>
          <span>${p.username}: ${p.role}${eliminated ? ' \u2014 eliminated' : ''}</span>
          ${!eliminated ? `<button class="eliminate-btn secondary-btn" data-uid="${p.id}">Eliminate</button>` : ''}
        </li>`;
      });
      html += `</ul>`;

      if (!sessionData.winner) {
        if (!sessionData.votingOpen) {
          html += `<button id="start-voting-btn" class="primary-btn">Start Voting</button>`;
        } else {
          html += `<p>${voteCount} of ${alivePlayers.length} alive players voted</p>`;
          html += `<button id="reveal-voting-btn" class="primary-btn">Reveal Result</button>`;
        }
      }
    } else if (sessionData.votingOpen && iAmAlive && !sessionData.winner) {
      html += `<h3>Vote to eliminate:</h3><ul class="player-list" id="vote-list">`;
      alivePlayers.filter(p => p.id !== playerId).forEach(p => {
        const selected = myVote === p.id;
        html += `<li><button class="vote-btn secondary-btn${selected ? ' selected' : ''}" data-uid="${p.id}">${p.username}${selected ? ' \u2714\ufe0f' : ''}</button></li>`;
      });
      html += `</ul>`;
      if (myVote) html += `<p>Your vote is in \u2014 tap another name to change it.</p>`;
    }

    html += `<button class="logout-btn secondary-btn">Logout</button>`;
    roleContent.innerHTML = html;

    if (isMod) {
      document.querySelectorAll('.eliminate-btn').forEach(btn => {
        btn.addEventListener('click', () => eliminatePlayer(sessionId, btn.dataset.uid));
      });
      const startBtn = document.getElementById('start-voting-btn');
      if (startBtn) startBtn.addEventListener('click', () => startVoting(sessionId));
      const revealBtn = document.getElementById('reveal-voting-btn');
      if (revealBtn) revealBtn.addEventListener('click', () => revealVoting(sessionId));
    } else {
      document.querySelectorAll('.vote-btn').forEach(btn => {
        btn.addEventListener('click', () => castVote(sessionId, playerId, btn.dataset.uid));
      });
    }
  }

  gameUnsubscribers.push(
    db.collection('werewolf_sessions').doc(sessionId).onSnapshot(doc => {
      sessionData = doc.data() || {};
      render();
    })
  );

  gameUnsubscribers.push(
    db.collection(`werewolf_sessions/${sessionId}/players`).onSnapshot(snapshot => {
      players = [];
      snapshot.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
      render();
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
  } else {
    gameUnsubscribers.push(
      db.collection(`werewolf_sessions/${sessionId}/votes`).doc(playerId).onSnapshot(doc => {
        myVote = doc.exists ? doc.data().targetId : null;
        render();
      })
    );
  }
}
