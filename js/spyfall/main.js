// js/spyfall/main.js
// Boot for the Spyfall page: profile, resume, create/join.
//
// Login lives on index.html and game choice on hub.html. This page assumes a
// signed-in player; anyone who isn't is sent to the login page and returned
// here afterwards.

let spyfallCurrentDisplayName = null;

// Send the player to the right screen for a room they're already in.
function enterSpyfallRoom(sessionId, uid, status) {
  if (status === 'playing') renderSpyfallGame(sessionId, uid);
  else renderSpyfallLobby(sessionId, uid);
}

async function tryResumeSpyfall(uid) {
  const sessionId = await getCurrentSession(uid, 'spyfall'); // core/auth.js
  if (!sessionId) return false;

  const sessionRef = db.collection('spyfall_sessions').doc(sessionId);
  const sessionDoc = await sessionRef.get();
  if (!sessionDoc.exists) {
    await clearCurrentSession(uid, 'spyfall').catch(() => {});
    return false;
  }

  const playerDoc = await sessionRef.collection('players').doc(uid).get();
  if (!playerDoc.exists) {
    await clearCurrentSession(uid, 'spyfall').catch(() => {});
    return false;
  }

  enterSpyfallRoom(sessionId, uid, sessionDoc.data().status);
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  showScreen('loading-screen');

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      clearSpyfallGameListeners();
      clearSpyfallLobbyListeners();
      goToLogin(); // core/auth.js — returns here after sign-in
      return;
    }

    try {
      const profile = await loadProfile(user); // core/auth.js
      spyfallCurrentDisplayName = profile.displayName;
      document.getElementById('welcome-username').textContent = profile.displayName;

      const resumed = await tryResumeSpyfall(user.uid);
      if (!resumed) showScreen('lobby-choice-screen');
    } catch (error) {
      console.error('Could not start the Spyfall page:', error);
      spyfallCurrentDisplayName = spyfallCurrentDisplayName || user.displayName || (user.email || '').split('@')[0];
      document.getElementById('welcome-username').textContent = spyfallCurrentDisplayName;
      showScreen('lobby-choice-screen');
    }
  });

  document.getElementById('create-room-btn').addEventListener('click', async () => {
    const err = document.getElementById('lobby-choice-error');
    err.textContent = '';
    try {
      const uid = auth.currentUser.uid;
      const code = await createSpyfallSession(uid, spyfallCurrentDisplayName);
      renderSpyfallLobby(code, uid);
    } catch (e) {
      console.error(e);
      err.textContent = "Couldn't create session. Try again.";
    }
  });

  document.getElementById('join-room-btn').addEventListener('click', async () => {
    const err = document.getElementById('lobby-choice-error');
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    err.textContent = '';
    if (!code) { err.textContent = 'Enter a room code.'; return; }
    try {
      const uid = auth.currentUser.uid;
      await joinSpyfallSession(code, uid, spyfallCurrentDisplayName);
      const sessionDoc = await db.collection('spyfall_sessions').doc(code).get();
      enterSpyfallRoom(code, uid, sessionDoc.data().status);
    } catch (e) {
      console.error(e);
      err.textContent = e.message || "Couldn't join session.";
    }
  });
});
