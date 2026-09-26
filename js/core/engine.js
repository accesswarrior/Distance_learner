// js/core/engine.js
// Session lifecycle: creating and joining Werewolf rooms.
//
// Player doc schema:
//   { username, displayName, ready, participationStatus, role?, alive?, ... }
//
// participationStatus: 'active' | 'removed'. Missing = 'active'.
//   - active  : in the game. May be alive or dead.
//   - removed : no longer participating. Excluded from win conditions,
//               ack gates, vote counts, night target lists, and Chief
//               succession. Their doc is preserved as historical record.
//
// Removed ≠ dead. A disconnected player is neither. Only the moderator's
// explicit "Remove from game" action moves a player to 'removed'.
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

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

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

async function createSession(uid, username, displayName) {
  let code;
  let attempts = 0;
  while (attempts < 5) {
    code = generateRoomCode();
    const existing = await db.collection('werewolf_sessions').doc(code).get();
    if (!existing.exists) break;
    attempts++;
  }

  await db.collection('werewolf_sessions').doc(code).set({
    moderatorId: uid,
    status: 'lobby',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    pendingPotionFlags: []
  });

  await db.collection('werewolf_users').doc(uid).update({ currentSessionId: code });
  return code;
}

async function joinSession(code, uid, username, displayName) {
  const sessionRef = db.collection('werewolf_sessions').doc(code);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    throw new Error("Room not found. Check the code and try again.");
  }

  const sessionData = sessionDoc.data();
  const isMod = sessionData.moderatorId === uid;

  if (!isMod) {
    const playerRef = sessionRef.collection('players').doc(uid);
    const existingPlayerDoc = await playerRef.get();

    if (sessionData.status !== 'lobby' && !existingPlayerDoc.exists) {
      throw new Error("This game has already started.");
    }

    if (!existingPlayerDoc.exists) {
      await playerRef.set({
        username: username,
        displayName: displayName,
        ready: false,
        participationStatus: 'active'
      });
    }
  }

  await db.collection('werewolf_users').doc(uid).update({ currentSessionId: code });
  return isMod;
}

// Moderator: remove an active-game player. Preserves their doc (role,
// history) but excludes them from all future game calculations.
async function removePlayerFromGame(sessionId, uid) {
  await db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid).update({
    participationStatus: 'removed',
    alive: false
  });
}

// Moderator: Play Again. Players removed during the last round are dropped
// from the roster entirely. Everyone else is reset to a fresh lobby state
// and must re-ready.
async function resetSessionForRematch(sessionId) {
  const [playersSnap, votesSnap, nightSnap] = await Promise.all([
    db.collection(`werewolf_sessions/${sessionId}/players`).get(),
    db.collection(`werewolf_sessions/${sessionId}/votes`).get(),
    db.collection(`werewolf_sessions/${sessionId}/nightActions`).get()
  ]);

  const batch = db.batch();
  playersSnap.forEach(doc => {
    const data = doc.data();
    if (data.participationStatus === 'removed') {
      batch.delete(doc.ref);
    } else {
      batch.update(doc.ref, {
        role: null,
        alive: true,
        ready: false,
        participationStatus: 'active',
        healPotionUsed: firebase.firestore.FieldValue.delete(),
        poisonPotionUsed: firebase.firestore.FieldValue.delete(),
        hunterShotUsed: firebase.firestore.FieldValue.delete()
      });
    }
  });
  votesSnap.forEach(doc => batch.delete(doc.ref));
  nightSnap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    status: 'lobby',
    phase: firebase.firestore.FieldValue.delete(),
    nightStep: firebase.firestore.FieldValue.delete(),
    votingOpen: false,
    voteEligibleTargets: firebase.firestore.FieldValue.delete(),
    announcement: firebase.firestore.FieldValue.delete(),
    deathSeen: firebase.firestore.FieldValue.delete(),
    winner: firebase.firestore.FieldValue.delete(),
    pendingHunterShot: firebase.firestore.FieldValue.delete(),
    pendingPotionFlags: [],
    roleComposition: firebase.firestore.FieldValue.delete()
  }, { merge: true });
  await batch.commit();
}

// Pre-game only. Removes from the lobby roster entirely.
async function kickPlayer(sessionId, uid) {
  await db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid).delete();
}
