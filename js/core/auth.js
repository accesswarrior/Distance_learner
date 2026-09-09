// js/core/auth.js
// Handles signup / login / logout for the Werewolf game.
// Uses "werewolf_"-prefixed Firestore collections so this game's data
// never collides with other apps sharing the same Firebase project.

function usernameToEmail(username) {
  return username + "@werewolf.local";
}

document.getElementById('signup-btn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim().toLowerCase();
  const pin = document.getElementById('pin').value.trim();
  const errorEl = document.getElementById('auth-error');

  if (!username || !pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
    errorEl.textContent = "Username and 6-digit PIN are required.";
    return;
  }

  const email = usernameToEmail(username);

  try {
    const usernameDoc = await db.collection('werewolf_usernames').doc(username).get();
    if (usernameDoc.exists) {
      errorEl.textContent = "Username already taken.";
      return;
    }

    const userCredential = await auth.createUserWithEmailAndPassword(email, pin);
    const uid = userCredential.user.uid;

    await db.collection('werewolf_usernames').doc(username).set({ uid });
    await db.collection('werewolf_users').doc(uid).set({
      username: username,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    errorEl.textContent = "";
    // main.js's onAuthStateChanged listener handles the screen switch.
  } catch (error) {
    console.error("Signup error:", error);
    errorEl.textContent = error.message;
  }
});

document.getElementById('login-btn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim().toLowerCase();
  const pin = document.getElementById('pin').value.trim();
  const errorEl = document.getElementById('auth-error');

  if (!username || !pin) {
    errorEl.textContent = "Enter username and 6-digit PIN.";
    return;
  }

  const email = usernameToEmail(username);

  try {
    await auth.signInWithEmailAndPassword(email, pin);
    errorEl.textContent = "";
  } catch (error) {
    console.error("Login error:", error);
    errorEl.textContent = "Invalid username or PIN.";
  }
});

// Delegated listener: any element with class "logout-btn" signs the user out.
// This covers the static logout button on the lobby-choice screen AND the
// one lobby.js injects dynamically into the waiting room, without ever
// creating duplicate-ID conflicts.
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('logout-btn')) {
    auth.signOut();
  }
});
