// js/main.js
// Boot + top-level routing.

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

let currentUsername = null;
let currentDisplayName = null;

async function enterRoom(sessionId, uid, isMod) {
  const sessionDoc = await db.collection('werewolf_sessions').doc(sessionId).get();
  if (!sessionDoc.exists) {
    showScreen('lobby-choice-screen');
    return;
  }
  const sessionData = sessionDoc.data();

  if (sessionData.status === 'lobby') {
    renderLobby(sessionId, uid, isMod);
    showScreen('lobby-screen');
    return;
  }
  if (sessionData.status === 'starting') {
    if (isMod) {
      try {
        await recoverStartingGame(sessionId);
        const refreshed = await db.collection('werewolf_sessions').doc(sessionId).get();
        if (refreshed.exists && refreshed.data().status === 'started') {
          renderGameScreen(sessionId, uid, true);
          return;
        }
      } catch (err) {
        console.error('Could not recover starting game:', err);
      }
    }
    // Either a regular player caught this narrow in-between window, or the
    // moderator's own recovery attempt above didn't resolve it (still
    // mid-batch on another tab, e.g.). Don't just strand them on a static
    // screen — listen for the session to leave 'starting' and route from
    // there, same as a moderator's recovery would have.
    showScreen('loading-screen');
    const unsub = db.collection('werewolf_sessions').doc(sessionId)
      .onSnapshot(doc => {
        if (!doc.exists) { unsub(); showScreen('lobby-choice-screen'); return; }
        const d = doc.data();
        if (d.status === 'started') {
          unsub();
          renderGameScreen(sessionId, uid, isMod);
        } else if (d.status === 'lobby') {
          unsub();
          renderLobby(sessionId, uid, isMod);
          showScreen('lobby-screen');
        }
        // still 'starting': keep waiting, nothing to do yet.
      }, err => console.warn('Could not watch starting session:', err));
    gameUnsubscribers.push(unsub);
    return;
  }
  renderGameScreen(sessionId, uid, isMod);
}

async function tryResumeSession(uid) {
  const userDoc = await db.collection('werewolf_users').doc(uid).get();
  const sessionId = userDoc.exists ? userDoc.data().currentSessionId : null;
  if (!sessionId) return false;

  const sessionRef = db.collection('werewolf_sessions').doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    await db.collection('werewolf_users').doc(uid)
      .update({ currentSessionId: firebase.firestore.FieldValue.delete() })
      .catch(() => {});
    return false;
  }

  const sessionData = sessionDoc.data();
  const isMod = sessionData.moderatorId === uid;

  if (!isMod) {
    const playerDoc = await sessionRef.collection('players').doc(uid).get();
    if (!playerDoc.exists) {
      // Kicked from the lobby (doc deleted). Clear pointer.
      await db.collection('werewolf_users').doc(uid)
        .update({ currentSessionId: firebase.firestore.FieldValue.delete() })
        .catch(() => {});
      return false;
    }
    // If removed during an active game, the doc still exists — resume as
    // a spectator. renderGameScreen handles the removed state.
  }

  await enterRoom(sessionId, uid, isMod);
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  showScreen('loading-screen');

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      const userDoc = await db.collection('werewolf_users').doc(user.uid).get();
      currentUsername = userDoc.exists ? userDoc.data().username : user.email.split('@')[0];
      currentDisplayName = userDoc.exists
        ? (userDoc.data().displayName || currentUsername)
        : currentUsername;
      document.getElementById('welcome-username').textContent = currentDisplayName;

      const resumed = await tryResumeSession(user.uid);
      if (!resumed) showScreen('lobby-choice-screen');
    } else {
      currentUsername = null;
      // Clean up ALL listeners — game and lobby — before showing auth.
      if (typeof clearGameListeners === 'function') clearGameListeners();
      if (typeof lobbyUnsubscribe === 'function' && lobbyUnsubscribe) {
        lobbyUnsubscribe();
        lobbyUnsubscribe = null;
      }
      showScreen('auth-screen');
    }
  });

  document.getElementById('create-room-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('lobby-choice-error');
    errorEl.textContent = "";
    try {
      const uid = auth.currentUser.uid;
      const timerValue = document.getElementById('timer-select').value;
      const discussionTimerMinutes = timerValue ? parseInt(timerValue, 10) : null;
      const code = await createSession(uid, currentUsername, currentDisplayName, discussionTimerMinutes);
      renderLobby(code, uid, true);
      showScreen('lobby-screen');
    } catch (error) {
      console.error("Create room error:", error);
      errorEl.textContent = "Couldn't create room. Try again.";
    }
  });

  document.getElementById('join-room-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('lobby-choice-error');
    const codeInput = document.getElementById('join-code-input');
    const code = codeInput.value.trim().toUpperCase();
    errorEl.textContent = "";

    if (!code) { errorEl.textContent = "Enter a room code."; return; }

    try {
      const uid = auth.currentUser.uid;
      const isMod = await joinSession(code, uid, currentUsername, currentDisplayName);
      await enterRoom(code, uid, isMod);
    } catch (error) {
      console.error("Join room error:", error);
      errorEl.textContent = error.message || "Couldn't join room.";
    }
  });
});
