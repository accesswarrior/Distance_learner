// js/core/auth.js
// Account + navigation helpers shared by EVERY page (login, sign-up, hub,
// each game).
//
// Players sign in with an email + password, or with Google. Nothing in here
// touches the DOM at load time, so it is safe to include on any page. The
// only listener it adds is one delegated click handler for elements with
// class "logout-btn", which works wherever such a button exists.
//
// The account document lives in `users/{uid}`:
//   { displayName, createdAt, currentSessions?: { werewolf?: code, spyfall?: code } }
// It deliberately does NOT hold the email: the rules let a player read only
// their own account document, and the email is always available from the
// signed-in Firebase user (user.email).

const ACCOUNTS_COLLECTION = 'users';

const MIN_PASSWORD_LENGTH = 8;
const MAX_DISPLAY_NAME_LENGTH = 24;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Friendly error messages ----------
//
// Wrong-password and unknown-email deliberately share one message, so the
// login form can't be used to discover which emails have accounts.

function authErrorMessage(error) {
  switch (error && error.code) {
    case 'auth/email-already-in-use':
      return "An account with this email already exists. Try logging in instead.";
    case 'auth/invalid-email':
      return "That email address doesn't look right.";
    case 'auth/weak-password':
      return `Choose a stronger password (at least ${MIN_PASSWORD_LENGTH} characters).`;
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return "Incorrect email or password.";
    case 'auth/too-many-requests':
      return "Too many attempts. Wait a few minutes and try again.";
    case 'auth/network-request-failed':
      return "Network problem. Check your connection and try again.";
    case 'auth/user-disabled':
      return "This account has been disabled.";
    case 'auth/account-exists-with-different-credential':
      return "This email is already registered with a password. Log in with your email and password instead.";
    case 'auth/unauthorized-domain':
      return "This website isn't authorised for Google sign-in yet. Ask the site owner to add it in Firebase.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function cleanEmail(email) {
  email = (email || '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error("Enter a valid email address.");
  return email;
}

function cleanDisplayName(name) {
  name = (name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error("Enter a display name — it's what other players see in the game.");
  if (name.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }
  return name;
}

// ---------- Sign up / log in / log out ----------

// Creates the Firebase Auth user, then the account document.
// Throws an Error with a player-friendly message on any validation or auth
// failure. The caller must NOT navigate away until this promise resolves,
// otherwise the page unload can cancel the account-document write.
async function signUpWithEmail({ displayName, email, password, confirmPassword }) {
  displayName = cleanDisplayName(displayName);
  email = cleanEmail(email);
  password = password || '';

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password !== confirmPassword) {
    throw new Error("The two passwords don't match.");
  }

  let credential;
  try {
    credential = await auth.createUserWithEmailAndPassword(email, password);
  } catch (error) {
    console.error("Signup error:", error);
    throw new Error(authErrorMessage(error));
  }

  const user = credential.user;

  // Keep the chosen name on the Auth user too. If the account-document write
  // below fails, loadProfile() rebuilds the document from this name.
  try {
    await user.updateProfile({ displayName });
  } catch (error) {
    console.warn("Could not save the display name on the Auth user:", error);
  }

  try {
    // Runs AFTER auth succeeds, so request.auth is set and matches the
    // create rule (uid must equal the signed-in user).
    await db.collection(ACCOUNTS_COLLECTION).doc(user.uid).set({
      displayName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.warn("Account created but the profile could not be saved yet:", error);
  }
  return user;
}

async function logInWithEmail(email, password) {
  email = cleanEmail(email);
  if (!password) throw new Error("Enter your password.");
  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (error) {
    console.error("Login error:", error);
    throw new Error(authErrorMessage(error));
  }
}

// Google sign-in. Works for both "log in" and "sign up": the first time an
// email is used, Firebase creates the account; loadProfile() then creates
// the account document with the Google name as the starting display name.
//
// Resolves with the user, or null if nothing signed in (the player closed
// the popup, or we fell back to a full-page redirect that is now leaving).
async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const result = await auth.signInWithPopup(provider);
    return result.user;
  } catch (error) {
    if (error.code === 'auth/popup-closed-by-user' ||
        error.code === 'auth/cancelled-popup-request') {
      return null;
    }
    // Some phones and in-app browsers block popups: use a full-page redirect.
    if (error.code === 'auth/popup-blocked' ||
        error.code === 'auth/operation-not-supported-in-this-environment') {
      await auth.signInWithRedirect(provider);
      return null;
    }
    console.error("Google sign-in error:", error);
    throw new Error(authErrorMessage(error));
  }
}

// Call once when the login / sign-up page loads, to surface an error from a
// redirect-based Google sign-in. (A successful one is picked up by
// onAuthStateChanged like any other sign-in.)
async function finishGoogleRedirect() {
  try {
    await auth.getRedirectResult();
  } catch (error) {
    console.error("Google redirect error:", error);
    throw new Error(authErrorMessage(error));
  }
}

// Always resolves the same way whether or not the email has an account, so
// the form can't be used to find out who is registered.
async function sendPasswordReset(email) {
  email = cleanEmail(email);
  try {
    await auth.sendPasswordResetEmail(email);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return;
    console.error("Password reset error:", error);
    throw new Error(authErrorMessage(error));
  }
}

function logOut() {
  return auth.signOut();
}

// Any element with class "logout-btn" signs the user out. Delegated, so it
// covers buttons that lobby.js / ui.js re-render on every state change.
// Each page's onAuthStateChanged handler then sends the user to the login page.
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('logout-btn')) {
    logOut();
  }
});

// ---------- Profile ----------

// Returns { displayName } for a signed-in Firebase user, creating the account
// document if there isn't one yet. That is the normal path for a first-time
// Google sign-in (there is no sign-up step) and the recovery path if the
// document write at sign-up was lost.
async function loadProfile(user) {
  const fallback = (
    user.displayName || (user.email || '').split('@')[0] || 'Player'
  ).trim().slice(0, MAX_DISPLAY_NAME_LENGTH) || 'Player';

  const ref = db.collection(ACCOUNTS_COLLECTION).doc(user.uid);
  const snap = await ref.get();

  if (!snap.exists) {
    try {
      await ref.set({
        displayName: fallback,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.warn("Could not create the missing profile:", error);
    }
    return { displayName: fallback };
  }

  const data = snap.data() || {};
  return { displayName: data.displayName || fallback };
}

// Lets a player change the name other players see (hub page). Returns the
// cleaned name that was saved.
async function updateDisplayName(uid, name) {
  name = cleanDisplayName(name);
  await db.collection(ACCOUNTS_COLLECTION).doc(uid).update({ displayName: name });
  try {
    if (auth.currentUser && auth.currentUser.uid === uid) {
      await auth.currentUser.updateProfile({ displayName: name });
    }
  } catch (error) {
    console.warn("Could not update the display name on the Auth user:", error);
  }
  return name;
}

// ---------- "Which room am I in?" pointers ----------
//
// One pointer PER GAME, stored as a map on the account document:
//   currentSessions: { werewolf: 'ABCDE', spyfall: 'XYZ12' }
// so being in a room for one game never overwrites another game's pointer.

async function getCurrentSession(uid, game) {
  const snap = await db.collection(ACCOUNTS_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return (data.currentSessions && data.currentSessions[game]) || null;
}

// update(): the account document always exists by this point, because every
// page calls loadProfile() (which creates it if missing) before any room code.
function setCurrentSession(uid, game, code) {
  return db.collection(ACCOUNTS_COLLECTION).doc(uid)
    .update({ [`currentSessions.${game}`]: code });
}

function clearCurrentSession(uid, game) {
  return db.collection(ACCOUNTS_COLLECTION).doc(uid)
    .update({ [`currentSessions.${game}`]: firebase.firestore.FieldValue.delete() });
}

// ---------- Page navigation ----------
//
// Every page declares where it lives:
//   <body data-root="../" data-page="games/werewolf.html">
// data-root is the path from this page back to the site root; data-page is
// this page's own path from the root (used for "come back here after login").

function siteRoot() {
  return (document.body && document.body.dataset.root) || '';
}

// Every page change goes through here (one place to hook in tests).
function navigateTo(url) {
  window.location.replace(url);
}

// Only same-site pages we know about may be used as a post-login destination,
// so a crafted ?next= link can never send someone to another website.
function safeNextPath(path) {
  return (typeof path === 'string' && /^(hub\.html|games\/[a-z0-9-]+\.html)$/.test(path))
    ? path : null;
}

function goToLogin() {
  const next = safeNextPath(document.body.dataset.page);
  navigateTo(siteRoot() + 'index.html' + (next ? '?next=' + encodeURIComponent(next) : ''));
}

function goToHub() {
  navigateTo(siteRoot() + 'hub.html');
}

// Used by the login and sign-up pages (both sit at the site root).
function goAfterLogin() {
  const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));
  navigateTo(next || 'hub.html');
}
