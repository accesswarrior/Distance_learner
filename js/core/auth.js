// js/core/auth.js
// Handles signup / login / logout for the Werewolf game.
// Uses "werewolf_"-prefixed Firestore collections so this game's data
// never collides with other apps sharing the same Firebase project.

function usernameToEmail(username) {
  return username + "@werewolf.local";
}

// Letters, numbers, underscore, hyphen only. Blocks spaces, "@", and other
// characters that would otherwise produce a malformed synthetic email and
// surface as a confusing Firebase error instead of a clear message here.
const USERNAME_PATTERN = /^[a-z0-9_-]{3,20}$/;

// The auth screen is one shared form for both login and signup, but
// Display Name only ever matters when creating an account — a returning
// player already has one. This toggles which fields/buttons are visible
// so login stays a plain "username + PIN" form, exactly as before.
let authMode = 'login'; // 'login' | 'signup'

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  document.getElementById('display-name').style.display = isSignup ? 'block' : 'none';
  document.getElementById('signup-hint').style.display = isSignup ? 'block' : 'none';
  document.getElementById('login-btn').style.display = isSignup ? 'none' : 'block';
  document.getElementById('signup-btn').style.display = isSignup ? 'block' : 'none';
  document.getElementById('toggle-auth-mode-link').textContent =
    isSignup ? 'Already have an account? Log in' : "New here? Create an account";
  document.getElementById('auth-error').textContent = '';
}

document.getElementById('toggle-auth-mode-link').addEventListener('click', (e) => {
  e.preventDefault();
  setAuthMode(authMode === 'login' ? 'signup' : 'login');
});

setAuthMode('login'); // starting state: plain login, matches how it looked before

document.getElementById('signup-btn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim().toLowerCase();
  const displayName = document.getElementById('display-name').value.trim();
  const pin = document.getElementById('pin').value.trim();
  const errorEl = document.getElementById('auth-error');

  if (!username || !pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
    errorEl.textContent = "Username and 6-digit PIN are required.";
    return;
  }
  if (!USERNAME_PATTERN.test(username)) {
    errorEl.textContent = "Username must be 3-20 characters: letters, numbers, _ or - only.";
    return;
  }
  if (!displayName) {
    errorEl.textContent = "Enter a display name — it's what other players see in the game.";
    return;
  }

  const email = usernameToEmail(username);

  try {
    // No pre-check read here: an unauthenticated client can't (and
    // shouldn't be able to) read werewolf_usernames. Instead we let
    // Firebase Auth itself reject the duplicate via the synthetic email,
    // since "username@werewolf.local" can only exist once.
    const userCredential = await auth.createUserWithEmailAndPassword(email, pin);
    const uid = userCredential.user.uid;

    // These writes happen AFTER auth succeeds, so request.auth is now set
    // and matches the rules (create-only, uid must match the signed-in user).
    // `username` is the private login handle; `displayName` is the name
    // shown to other players in-game (they can be wildly different).
    await db.collection('werewolf_usernames').doc(username).set({ uid });
    await db.collection('werewolf_users').doc(uid).set({
      username: username,
      displayName: displayName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    errorEl.textContent = "";
    // main.js's onAuthStateChanged listener handles the screen switch.
  } catch (error) {
    console.error("Signup error:", error);
    if (error.code === 'auth/email-already-in-use') {
      errorEl.textContent = "Username already taken.";
    } else {
      errorEl.textContent = error.message;
    }
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
