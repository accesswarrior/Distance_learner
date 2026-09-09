// js/core/engine.js
// Session lifecycle: creating and joining Werewolf rooms.
//
// Collection layout (all namespaced under "werewolf_"):
//   werewolf_sessions/{sessionId}                -> { moderatorId, status, createdAt }
//   werewolf_sessions/{sessionId}/players/{uid}  -> { username, ready, role, alive }

function generateRoomCode() {
  // Excludes 0/O/1/I to avoid visual confusion when players read the code aloud.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function createSession(uid, username) {
  let code;
  let attempts = 0;

  // Retry a handful of times on the rare chance of a room-code collision.
  while (attempts < 5) {
    code = generateRoomCode();
    const existing = await db.collection('werewolf_sessions').doc(code).get();
    if (!existing.exists) break;
    attempts++;
  }

  await db.collection('werewolf_sessions').doc(code).set({
    moderatorId: uid,
    status: 'lobby',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  await db.collection('werewolf_sessions').doc(code)
    .collection('players').doc(uid).set({
      username: username,
      ready: false,
      role: null,
      alive: true
    });

  return code;
}

async function joinSession(code, uid, username) {
  const sessionRef = db.collection('werewolf_sessions').doc(code);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    throw new Error("Room not found. Check the code and try again.");
  }

  if (sessionDoc.data().status !== 'lobby') {
    throw new Error("This game has already started.");
  }

  await sessionRef.collection('players').doc(uid).set({
    username: username,
    ready: false,
    role: null,
    alive: true
  }, { merge: true });

  return sessionDoc.data().moderatorId === uid;
}

// Lets the moderator remove a player from the lobby roster entirely —
// e.g. a no-show, a duplicate join, or someone who backed out. This is
// how the moderator adjusts the total headcount before Start Game; the
// live "X players in room" count updates automatically because it's
// just a listener on this same collection.
async function kickPlayer(sessionId, uid) {
  await db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid).delete();
}
