// js/core/ui-helpers.js
// Game-agnostic UI helpers shared by every game page. No game rules, no
// Firestore. Extracted verbatim from the original engine.js / main.js /
// ui.js so Werewolf behaves exactly as before.

// ---------- Screen switching (was in main.js) ----------

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

// ---------- HTML escaping (was in engine.js) ----------
//
// esc() lives here (loaded before ui.js) because both this file's
// confirmAction() and every interpolation in ui.js need it. It escapes the
// five characters that can break out of element content or attribute
// values. Escaping is done at each interpolation site, NOT inside
// shownName(), so a raw value stored in state is never pre-escaped and
// can't be double-escaped if it's later compared or re-rendered.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Room codes (was in engine.js) ----------

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ---------- Confirmation modal (was in engine.js) ----------

// Promise-based confirmation modal. Used by the moderator UI before any
// consequential action. The rules and state guards are the real defense;
// this is the "did you mean to?" layer. Title and message are escaped
// because callers sometimes build them from user-supplied display names.
function confirmAction({ title, message, confirmLabel, danger }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        <div class="modal-actions">
          <button class="secondary-btn modal-cancel">Cancel</button>
          <button class="${danger ? 'danger-btn' : 'primary-btn'} modal-confirm">${esc(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (result) => {
      document.body.removeChild(overlay);
      resolve(result);
    };
    overlay.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.modal-confirm').addEventListener('click', () => close(true));
  });
}

// ---------- Display names (was in ui.js) ----------

function shownName(p) {
  return esc(p ? (p.displayName || 'Unknown') : 'Unknown');
}
