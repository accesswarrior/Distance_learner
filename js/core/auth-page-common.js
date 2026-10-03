// js/core/auth-page-common.js
// Wiring shared by the login page (index.html) and the sign-up page
// (signup.html): the Google button, the link to the other page, the error
// line, and "already signed in -> move on". The account logic itself lives
// in auth.js; login-page.js and signup-page.js add what is specific to each.

let authBusy = false; // true while a sign-up (auth user + profile write) is in flight

// While a sign-up runs, Firebase reports "signed in" the instant the auth
// user exists, which is BEFORE the account document is written. Navigating
// away at that moment could cancel the write, so the redirect waits.
function setAuthBusy(value) { authBusy = value; }

// "?next=games/werewolf.html" carried from one auth page to the other, so a
// player who arrived from a game link still lands there after signing up.
function nextQuery() {
  const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));
  return next ? '?next=' + encodeURIComponent(next) : '';
}

function showAuthError(message) {
  document.getElementById('auth-error').textContent = message || '';
  const info = document.getElementById('auth-info');
  if (info && message) info.textContent = '';
}

function showAuthInfo(message) {
  const info = document.getElementById('auth-info');
  if (info) info.textContent = message || '';
  if (message) document.getElementById('auth-error').textContent = '';
}

// otherPage: 'signup.html' on the login page, 'index.html' on the sign-up page.
function wireAuthPage(otherPage) {
  showScreen('loading-screen');

  document.getElementById('other-page-link').href = otherPage + nextQuery();

  const googleBtn = document.getElementById('google-btn');
  googleBtn.addEventListener('click', async () => {
    showAuthError('');
    googleBtn.disabled = true;
    try {
      await signInWithGoogle();
      // On success onAuthStateChanged below performs the redirect.
    } catch (error) {
      showAuthError(error.message);
    } finally {
      googleBtn.disabled = false;
    }
  });

  // Back from a full-page Google redirect that failed: show why.
  finishGoogleRedirect().catch(error => showAuthError(error.message));

  // Already signed in (or just signed in) -> on to the hub, or back to the
  // page they were trying to reach.
  auth.onAuthStateChanged((user) => {
    if (authBusy) return;
    if (user) goAfterLogin();
    else showScreen('auth-screen');
  });
}
