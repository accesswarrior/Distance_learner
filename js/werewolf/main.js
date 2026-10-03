// js/werewolf/main.js
// Boot + top-level routing for the Werewolf page.
//
// Login lives on the site's login page (index.html) and game choice on the
// hub (hub.html). This page assumes a signed-in player: anyone who isn't is
// sent back to the login page and returned here after signing in.

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
  const sessionId = await getCurrentSession(uid, 'werewolf'); // core/auth.js
  if (!sessionId) return false;

  const sessionRef = db.collection('werewolf_sessions').doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    await clearCurrentSession(uid, 'werewolf').catch(() => {});
    return false;
  }

  const sessionData = sessionDoc.data();
  const isMod = sessionData.moderatorId === uid;

  if (!isMod) {
    const playerDoc = await sessionRef.collection('players').doc(uid).get();
    if (!playerDoc.exists) {
      // Kicked from the lobby (doc deleted). Clear pointer.
      await clearCurrentSession(uid, 'werewolf').catch(() => {});
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
    if (!user) {
      currentDisplayName = null;
      // Clean up ALL listeners — game and lobby — before leaving for the login page.
      if (typeof clearGameListeners === 'function') clearGameListeners();
      if (typeof lobbyUnsubscribe === 'function' && lobbyUnsubscribe) {
        lobbyUnsubscribe();
        lobbyUnsubscribe = null;
      }
      goToLogin(); // core/auth.js — returns here after sign-in
      return;
    }

    try {
      const profile = await loadProfile(user); // core/auth.js
      currentDisplayName = profile.displayName;
      document.getElementById('welcome-username').textContent = currentDisplayName;

      const resumed = await tryResumeSession(user.uid);
      if (!resumed) showScreen('lobby-choice-screen');
    } catch (error) {
      // Offline / transient failure: fall back to the room-choice screen with
      // whatever name we can derive rather than leaving the spinner up forever.
      console.error('Could not start the Werewolf page:', error);
      currentDisplayName = currentDisplayName || user.displayName || (user.email || '').split('@')[0];
      document.getElementById('welcome-username').textContent = currentDisplayName;
      showScreen('lobby-choice-screen');
    }
  });

  document.getElementById('create-room-btn').addEventListener('click', async () => {
    const errorEl = document.getElementById('lobby-choice-error');
    errorEl.textContent = "";
    try {
      const uid = auth.currentUser.uid;
      const timerValue = document.getElementById('timer-select').value;
      const discussionTimerMinutes = timerValue ? parseInt(timerValue, 10) : null;
      const code = await createSession(uid, discussionTimerMinutes);
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
      const isMod = await joinSession(code, uid, currentDisplayName);
      await enterRoom(code, uid, isMod);
    } catch (error) {
      console.error("Join room error:", error);
      errorEl.textContent = error.message || "Couldn't join room.";
    }
  });
});
