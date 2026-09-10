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

  const sessionData = sessionDoc.data();
  const isMod = sessionData.moderatorId === uid;

  if (!isMod) {
    const playerRef = sessionRef.collection('players').doc(uid);
    const existingPlayerDoc = await playerRef.get();

    // A brand-new player can only join while the room is still in the lobby.
    // Someone who is ALREADY in this game — logged out or switched devices
    // mid-round and is re-entering the code — can always get back in,
    // no matter what phase the game is in. This is what lets a player who
    // accidentally left, or lost connection, walk back in with the same code
    // instead of being told the room is "full" / "already started".
    if (sessionData.status !== 'lobby' && !existingPlayerDoc.exists) {
      throw new Error("This game has already started.");
    }

    if (!existingPlayerDoc.exists) {
      await playerRef.set({
        username: username,
        ready: false,
        role: null,
        alive: true
      });
    }
    // else: they're already in the room — leave their role/alive/ready as is.
  }

  // Remember which room this account is in, so a later re-login (same
  // device or a new one) can drop them straight back into it.
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
