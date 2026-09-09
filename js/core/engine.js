// js/core/engine.js
// Session lifecycle: creating and joining Werewolf rooms.
//
// Collection layout (all namespaced under "werewolf_"):
//   werewolf_sessions/{sessionId}                -> { moderatorId, status, createdAt }
//   werewolf_sessions/{sessionId}/players/{uid}  -> { username, ready, role, alive }
//   werewolf_users/{uid}                         -> { username, createdAt, currentSessionId }
//
// NOTE: the moderator (room creator) is intentionally NOT written into the
// players subcollection. The moderator runs the round and is never dealt a
// role themselves — `werewolf_sessions/{sessionId}.moderatorId` is the only
// record of who's running the room. See README "In-game moderator controls".
//
// `werewolf_users/{uid}.currentSessionId` is how a player (or moderator) who
// gets logged out — or logs in on a different device — is dropped back into
// the room they were in, instead of landing on the room-choice screen. It's
// set whenever someone creates or joins a room, and cleared when it's no
// longer valid (room gone, or they were removed from the lobby).

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

  // The moderator does NOT get a players/{uid} doc — they're not a player,
  // so they must never end up in the role-assignment pool. Their identity
  // as moderator lives solely on the session doc's moderatorId field.

  // Remember which room this account is in, so a later re-login (same
  // device or a new one) can drop them straight back into it.
  await db.collection('werewolf_users').doc(uid).update({ currentSessionId: code });

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

  const isMod = sessionDoc.data().moderatorId === uid;

  // The moderator rejoining their own room by code (e.g. resuming on a new
  // device) still shouldn't get a players/{uid} doc — see createSession.
  if (!isMod) {
    await sessionRef.collection('players').doc(uid).set({
      username: username,
      ready: false,
      role: null,
      alive: true
    }, { merge: true });
  }

  await db.collection('werewolf_users').doc(uid).update({ currentSessionId: code });

  return isMod;
}

// Lets the moderator remove a player from the lobby roster entirely —
// e.g. a no-show, a duplicate join, or someone who backed out. This is
// how the moderator adjusts the total headcount before Start Game; the
// live "X players in room" count updates automatically because it's
// just a listener on this same collection.
async function kickPlayer(sessionId, uid) {
  await db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid).delete();
}
