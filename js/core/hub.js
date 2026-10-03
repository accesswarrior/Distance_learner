// js/core/hub.js
// The game picker (hub.html). Signed-out visitors are sent to the login page.

document.addEventListener('DOMContentLoaded', () => {
  showScreen('loading-screen');

  const nameEl    = document.getElementById('hub-name');
  const editLink  = document.getElementById('edit-name-link');
  const nameForm  = document.getElementById('name-form');
  const nameInput = document.getElementById('name-input');
  const nameError = document.getElementById('name-error');

  function setEditing(editing) {
    nameForm.style.display = editing ? 'block' : 'none';
    editLink.parentElement.style.display = editing ? 'none' : 'block';
    nameError.textContent = '';
    if (editing) { nameInput.value = nameEl.textContent; nameInput.focus(); }
  }

  editLink.addEventListener('click', (e) => { e.preventDefault(); setEditing(true); });
  document.getElementById('name-cancel-btn').addEventListener('click', () => setEditing(false));

  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    nameError.textContent = '';
    const btn = document.getElementById('name-save-btn');
    btn.disabled = true;
    try {
      nameEl.textContent = await updateDisplayName(auth.currentUser.uid, nameInput.value);
      setEditing(false);
    } catch (error) {
      nameError.textContent = error.message || "Couldn't save the name. Try again.";
    } finally {
      btn.disabled = false;
    }
  });

  auth.onAuthStateChanged(async (user) => {
    if (!user) { goToLogin(); return; }

    let name = user.displayName || (user.email || '').split('@')[0] || 'player';
    try {
      name = (await loadProfile(user)).displayName;
    } catch (error) {
      // Offline or a transient error: the hub still works with the fallback name.
      console.warn('Could not load profile for the hub:', error);
    }
    nameEl.textContent = name;
    showScreen('hub-screen');
  });
});
