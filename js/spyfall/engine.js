// js/spyfall/engine.js
// Session lifecycle for Spyfall: create, join, start.
// (Round flow lives in round.js.)
//
// "Which room am I in?" is the shared per-game pointer from core/auth.js,
// stored as currentSessions.spyfall — it never touches Werewolf's pointer.

async function createSpyfallSession(uid, displayName) {
  let code;
  let attempts = 0;
  while (attempts < 5) {
    code = generateRoomCode();
    const existing = await db.collection('spyfall_sessions').doc(code).get();
    if (!existing.exists) break;
    attempts++;
  }

  await db.collection('spyfall_sessions').doc(code).set({
    moderatorId: uid,            // original creator — for reference only
    operatorId: uid,             // whoever runs the CURRENT round (rotates)
    status: 'lobby',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    currentRound: 0,
    roundState: 'idle',
    playerOrder: [],             // fixed when the operator presses Start
    usedLocations: []
  });

  await db.collection(`spyfall_sessions/${code}/players`).doc(uid).set(newSpyfallPlayer(displayName));
  await setCurrentSession(uid, 'spyfall', code);   // core/auth.js
  return code;
}

async function joinSpyfallSession(code, uid, displayName) {
  const sessionRef = db.collection('spyfall_sessions').doc(code);
  const sessionDoc = await sessionRef.get();
  if (!sessionDoc.exists) throw new Error("Session not found.");

  const data = sessionDoc.data();
  const playerRef = sessionRef.collection('players').doc(uid);
  const existing = await playerRef.get();

  if (!existing.exists) {
    if (data.status !== 'lobby') {
      throw new Error("This session has already started.");
    }
    const playersSnap = await sessionRef.collection('players').get();
    if (playersSnap.size >= SPYFALL_MAX_PLAYERS) {
      throw new Error("This session is full.");
    }
    await playerRef.set(newSpyfallPlayer(displayName));
  }

  await setCurrentSession(uid, 'spyfall', code);
  return code;
}

// The exact field set the Firestore rules accept when a player joins
// (score must be 0, active true). Keep the two in step.
function newSpyfallPlayer(displayName) {
  return {
    displayName: displayName || 'Player',
    ready: false,
    score: 0,
    active: true,
    inCurrentRound: true,
    joinedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

function spyfallJoinedAtMillis(p) {
  const t = p.joinedAt;
  if (t && typeof t.toMillis === 'function') return t.toMillis();
  return typeof t === 'number' ? t : 0;
}

// Operator: lobby -> playing. Fixes the rotation order (join order) here,
// so players never need write access to the session document just to join.
async function startSpyfallSession(sessionId) {
  const ref = db.collection('spyfall_sessions').doc(sessionId);
  const [sessionSnap, playersSnap] = await Promise.all([ref.get(), ref.collection('players').get()]);
  const session = sessionSnap.data() || {};
  if (session.status !== 'lobby') return false;

  const players = [];
  playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));
  const others = players.filter(p => p.id !== session.operatorId);
  if (others.length < SPYFALL_MIN_PARTICIPANTS || !others.every(p => p.ready)) {
    throw new Error(`Need at least ${SPYFALL_MIN_PARTICIPANTS} other players, all ready.`);
  }

  const playerOrder = players
    .sort((a, b) => spyfallJoinedAtMillis(a) - spyfallJoinedAtMillis(b) || a.id.localeCompare(b.id))
    .map(p => p.id);

  await ref.update({ status: 'playing', playerOrder, currentRound: 0, roundState: 'idle' });
  return true;
}
