// js/core/signup-page.js
// Sign-up page (signup.html): display name, email, password, or Google.

document.addEventListener('DOMContentLoaded', () => {
  wireAuthPage('index.html');
  setupShowPassword('show-password', ['password', 'confirm-password']);
  setupPasswordMeter('password', 'pw-meter-bar', 'pw-hint');
  setupConfirmMatch('password', 'confirm-password', 'confirm-hint');

  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');
    const btn = document.getElementById('signup-btn');
    btn.disabled = true;
    setAuthBusy(true);
    try {
      await signUpWithEmail({
        displayName: document.getElementById('display-name').value,
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
        confirmPassword: document.getElementById('confirm-password').value
      });
      goAfterLogin();
    } catch (error) {
      showAuthError(error.message);
      setAuthBusy(false);
      btn.disabled = false;
    }
  });
});
