// js/core/auth.js
// Account + navigation helpers shared by EVERY page (login, hub, each game).
//
// Nothing in here touches the DOM at load time, so it is safe to include on
// any page. The only listener it adds is one delegated click handler for
// elements with class "logout-btn", which works wherever such a button exists.
//
// Accounts live in the original "werewolf_"-named collections. The names are
// legacy but they now hold the platform-wide account (one signup, one login,
// one display name for every game), and renaming them would orphan every
// existing account — so they stay as they are. The synthetic login email
// domain ("@werewolf.local") is kept for the same reason.

const ACCOUNTS_COLLECTION  = 'werewolf_users';
const USERNAMES_COLLECTION = 'werewolf_usernames';

function usernameToEmail(username) {
  return username + "@werewolf.local";
}

// Letters, numbers, underscore, hyphen only. Blocks spaces, "@", and other
// characters that would otherwise produce a malformed synthetic email and
// surface as a confusing Firebase error instead of a clear message here.
const USERNAME_PATTERN = /^[a-z0-9_-]{3,20}$/;

// ---------- Sign up / log in / log out ----------

// Creates the Firebase Auth user, then the two account documents.
// Throws an Error with a player-friendly message on any validation or auth
// failure. The caller must NOT navigate away until this promise resolves,
// otherwise the page unload can cancel the account-document writes.
async function signUpAccount({ username, displayName, pin }) {
  username    = (username || '').trim().toLowerCase();
  displayName = (displayName || '').trim();
  pin         = (pin || '').trim();

  if (!username || !/^\d{6}$/.test(pin)) {
    throw new Error("Username and 6-digit PIN are required.");
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("Username must be 3-20 characters: letters, numbers, _ or - only.");
  }
  if (!displayName) {
    throw new Error("Enter a display name — it's what other players see in the game.");
  }

  let credential;
  try {
    // No pre-check read: an unauthenticated client can't (and shouldn't be
    // able to) read the usernames collection. Firebase Auth itself rejects a
    // duplicate, since "username@werewolf.local" can only exist once.
    credential = await auth.createUserWithEmailAndPassword(usernameToEmail(username), pin);
  } catch (error) {
    console.error("Signup error:", error);
    if (error.code === 'auth/email-already-in-use') throw new Error("Username already taken.");
    throw new Error(error.message);
  }

  const uid = credential.user.uid;
  try {
    // These writes happen AFTER auth succeeds, so request.auth is set and
    // matches the rules (create-only, uid must match the signed-in user).
    // `username` is the private login handle; `displayName` is what other
    // players see in-game (they can be wildly different).
    await db.collection(USERNAMES_COLLECTION).doc(username).set({ uid });
    await db.collection(ACCOUNTS_COLLECTION).doc(uid).set({
      username,
      displayName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    // The login itself worked. Don't strand the player: loadProfile() below
    // recreates a missing profile document (display name defaults to the
    // username) the next time any page loads.
    console.warn("Account created but profile documents could not be saved yet:", error);
  }
  return credential.user;
}

async function logInAccount(username, pin) {
  username = (username || '').trim().toLowerCase();
  pin      = (pin || '').trim();
  if (!username || !pin) throw new Error("Enter username and 6-digit PIN.");
  try {
    await auth.signInWithEmailAndPassword(usernameToEmail(username), pin);
  } catch (error) {
    console.error("Login error:", error);
    throw new Error("Invalid username or PIN.");
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

// Returns { username, displayName } for a signed-in Firebase user. If the
// profile document is missing (e.g. the network dropped between account
// creation and the profile write), recreates it so later writes that assume
// it exists (like the session pointer below) don't fail.
async function loadProfile(user) {
  const fallback = (user.email || '').split('@')[0] || 'player';
  const ref = db.collection(ACCOUNTS_COLLECTION).doc(user.uid);
  const snap = await ref.get();

  if (!snap.exists) {
    try {
      await ref.set({
        username: fallback,
        displayName: fallback,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.warn("Could not recreate missing profile:", error);
    }
    return { username: fallback, displayName: fallback };
  }

  const data = snap.data() || {};
  return {
    username: data.username || fallback,
    displayName: data.displayName || data.username || fallback
  };
}

// ---------- "Which room am I in?" pointers ----------
//
// One pointer PER GAME, stored as a map on the account document:
//   currentSessions: { werewolf: 'ABCDE', spyfall: 'XYZ12' }
// so being in a room for one game never overwrites another game's pointer.
//
// Compatibility: before there was more than one game, the pointer was a
// single `currentSessionId` field, and it always meant Werewolf. Werewolf's
// pointer is therefore ALSO read from / written to that field, so the
// previous deployment and this one agree about where a player is while both
// run against the same Firebase project. Drop the legacy field once the old
// site is retired.

const LEGACY_POINTER_GAME = 'werewolf';

async function getCurrentSession(uid, game) {
  const snap = await db.collection(ACCOUNTS_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  const mapped = data.currentSessions && data.currentSessions[game];
  if (mapped) return mapped;
  return game === LEGACY_POINTER_GAME ? (data.currentSessionId || null) : null;
}

function setCurrentSession(uid, game, code) {
  const update = { [`currentSessions.${game}`]: code };
  if (game === LEGACY_POINTER_GAME) update.currentSessionId = code;
  return db.collection(ACCOUNTS_COLLECTION).doc(uid).update(update);
}

function clearCurrentSession(uid, game) {
  const del = firebase.firestore.FieldValue.delete();
  const update = { [`currentSessions.${game}`]: del };
  if (game === LEGACY_POINTER_GAME) update.currentSessionId = del;
  return db.collection(ACCOUNTS_COLLECTION).doc(uid).update(update);
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

// Only same-site pages we know about may be used as a post-login destination,
// so a crafted ?next= link can never send someone to another website.
function safeNextPath(path) {
  return (typeof path === 'string' && /^(hub\.html|games\/[a-z0-9-]+\.html)$/.test(path))
    ? path : null;
}

function goToLogin() {
  const next = safeNextPath(document.body.dataset.page);
  window.location.replace(siteRoot() + 'index.html' + (next ? '?next=' + encodeURIComponent(next) : ''));
}

function goToHub() {
  window.location.replace(siteRoot() + 'hub.html');
}

// Used by the login page only (it sits at the site root).
function goAfterLogin() {
  const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));
  window.location.replace(next || 'hub.html');
}
