// js/main.js

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

let currentUsername = null;

document.addEventListener('DOMContentLoaded', () => {
  showScreen('loading-screen');

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      const userDoc = await db.collection('werewolf_users').doc(user.uid).get();
      currentUsername = userDoc.exists ? userDoc.data().username : user.email.split('@')[0];
      document.getElementById('welcome-username').textContent = currentUsername;

      showScreen('lobby-choice-screen');
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
