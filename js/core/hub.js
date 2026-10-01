// js/core/hub.js
// The game picker (hub.html). Signed-out visitors are sent to the login page.

document.addEventListener('DOMContentLoaded', () => {
  showScreen('loading-screen');

  auth.onAuthStateChanged(async (user) => {
    if (!user) { goToLogin(); return; }

    let name = (user.email || '').split('@')[0] || 'player';
    try {
      name = (await loadProfile(user)).displayName;
    } catch (error) {
      // Offline or a transient error: the hub still works with the fallback name.
      console.warn('Could not load profile for the hub:', error);
    }
    document.getElementById('hub-name').textContent = name;
    showScreen('hub-screen');
  });
});
