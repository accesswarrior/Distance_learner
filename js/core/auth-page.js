// js/core/auth-page.js
// Wiring for the login / sign-up page (index.html). All the account logic
// lives in auth.js; this file only connects it to the form.

let authMode = 'login'; // 'login' | 'signup'
let signingUp = false;  // true while a signup (auth user + profile docs) is in flight

// One shared form for login and signup. Display Name only matters when
// creating an account, so this toggles which fields/buttons are visible.
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

document.addEventListener('DOMContentLoaded', () => {
  showScreen('loading-screen');
  setAuthMode('login');

  const errorEl = document.getElementById('auth-error');

  // Already signed in (or just signed in) -> straight on to the hub, or back
  // to the page they were trying to reach. While a signup is running we hold
  // off: Firebase reports "signed in" the instant the auth user exists, which
  // is BEFORE the profile documents are written, and navigating away at that
  // moment could cancel those writes.
  auth.onAuthStateChanged((user) => {
    if (signingUp) return;
    if (user) goAfterLogin();
    else showScreen('auth-screen');
  });

  document.getElementById('toggle-auth-mode-link').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode(authMode === 'login' ? 'signup' : 'login');
  });

  document.getElementById('signup-btn').addEventListener('click', async () => {
    errorEl.textContent = '';
    signingUp = true;
    try {
      await signUpAccount({
        username: document.getElementById('username').value,
        displayName: document.getElementById('display-name').value,
        pin: document.getElementById('pin').value
      });
      goAfterLogin();
    } catch (error) {
      errorEl.textContent = error.message;
      signingUp = false;
      // If the auth user was created but a later step failed, they are
      // signed in; reloading the page will move them on.
    }
  });

  document.getElementById('login-btn').addEventListener('click', async () => {
    errorEl.textContent = '';
    try {
      await logInAccount(
        document.getElementById('username').value,
        document.getElementById('pin').value
      );
      // onAuthStateChanged above performs the redirect.
    } catch (error) {
      errorEl.textContent = error.message;
    }
  });
});
