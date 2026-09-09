// js/main.js

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

let currentUsername = null;

// If this account was in a room when it got logged out (or logs in from a
// different device), drop it straight back into that room instead of the
// room-choice screen. Returns true if a resume happened.
async function tryResumeSession(uid) {
  const userDoc = await db.collection('werewolf_users').doc(uid).get();
  const sessionId = userDoc.exists ? userDoc.data().currentSessionId : null;
  if (!sessionId) return false;

  const sessionRef = db.collection('werewolf_sessions').doc(sessionId);
  const sessionDoc = await sessionRef.get();

  // Room no longer exists — clear the stale pointer and fall back normally.
  if (!sessionDoc.exists) {
    await db.collection('werewolf_users').doc(uid)
      .update({ currentSessionId: firebase.firestore.FieldValue.delete() })
      .catch(() => {});
    return false;
  }

  const sessionData = sessionDoc.data();
  const isMod = sessionData.moderatorId === uid;
  let myRole = null;

  if (!isMod) {
    const playerDoc = await sessionRef.collection('players').doc(uid).get();
    if (!playerDoc.exists) {
      // Was removed from the lobby (or never actually a player) — stale pointer.
      await db.collection('werewolf_users').doc(uid)
        .update({ currentSessionId: firebase.firestore.FieldValue.delete() })
        .catch(() => {});
      return false;
    }
    myRole = playerDoc.data().role || null;
  }

  if (sessionData.status === 'lobby') {
    renderLobby(sessionId, uid, isMod);
    showScreen('lobby-screen');
  } else {
    renderGameScreen(sessionId, uid, isMod, myRole); // this call shows 'role-screen' itself
  }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  showScreen('loading-screen');

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      const userDoc = await db.collection('werewolf_users').doc(user.uid).get();
      currentUsername = userDoc.exists ? userDoc.data().username : user.email.split('@')[0];
      document.getElementById('welcome-username').textContent = currentUsername;

      const resumed = await tryResumeSession(user.uid);
      if (!resumed) {
        showScreen('lobby-choice-screen');
      }
    } else {
      currentUsername = null;

      // Clean up any live Firestore listener from a previous lobby session.
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
      const code = await createSession(uid, currentUsername);
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

    if (!code) {
      errorEl.textContent = "Enter a room code.";
      return;
    }

    try {
      const uid = auth.currentUser.uid;
      const isMod = await joinSession(code, uid, currentUsername);
      renderLobby(code, uid, isMod);
      showScreen('lobby-screen');
    } catch (error) {
      console.error("Join room error:", error);
      errorEl.textContent = error.message || "Couldn't join room.";
    }
  });
});
