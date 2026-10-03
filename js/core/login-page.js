// js/core/login-page.js
// Login page (index.html): email + password, Google, and "forgot password".

document.addEventListener('DOMContentLoaded', () => {
  wireAuthPage('signup.html');

  const emailInput = document.getElementById('email');

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    try {
      await logInWithEmail(emailInput.value, document.getElementById('password').value);
      // onAuthStateChanged (auth-page-common.js) performs the redirect.
    } catch (error) {
      showAuthError(error.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('forgot-link').addEventListener('click', async (e) => {
    e.preventDefault();
    showAuthError('');
    if (!emailInput.value.trim()) {
      showAuthError("Type your email above first, then tap \"Forgot password?\".");
      return;
    }
    try {
      await sendPasswordReset(emailInput.value);
      showAuthInfo("If an account exists for that email, a password reset link is on its way. Check your spam folder too.");
    } catch (error) {
      showAuthError(error.message);
    }
  });
});
