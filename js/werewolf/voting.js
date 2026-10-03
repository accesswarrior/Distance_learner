// js/werewolf/voting.js
// In-app day-phase voting, manual moderator override, win-condition
// resolution, and the Hunter's last shot.
//
// ELIMINATION RULE (reverted to the original house rule): the day vote
// only kills and names someone if they're a confirmed Werewolf (or Chief).
// If the top vote-getter isn't a werewolf, nothing happens and nothing is
// revealed — no name, no count. A wrongly-voted innocent survives with no
// information leaked. This is deliberate: it keeps trust and consensus
// central to the day phase instead of turning every vote into a free
// reveal regardless of whether the group guessed right.
//
// The announcement and pendingHunterShot are INDEPENDENT pieces of state.
// checkAndApplyWinner never overwrites the announcement when it detects a
// pending Hunter — the UI shows both at once.
//
// Two different resolution paths exist for the SAME underlying logic:
//   - checkAndApplyWinner() — used by every MODERATOR-invoked elimination
//     (revealVoting, eliminatePlayer, endNight's night.js call, and
//     skipHunterShot). The moderator can write anything, so this applies
//     Chief succession and the winner directly, in separate small writes.
//   - fireHunterShot() — the ONE non-moderator caller. A Hunter's client
//     can't read other players' roles or write `role`/`winner`, so it just
//     records the shot and raises pendingWinRecheck; the moderator's client
//     then runs checkAndApplyWinner() with full data (applyPendingWinRecheck,
//     consumed from ui.js's session listener).

async function startVoting(sessionId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (data.votingOpen) return;          // already open
  if ((data.phase || 'day') !== 'day') return; // voting is a day-phase state (missing phase = day)
  if (data.pendingHunterShot) return;    // Hunter must resolve first
  if (data.winner) return;

  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: true,
    announcement: firebase.firestore.FieldValue.delete(),
    deathSeen: [],
    voteEligibleTargets: firebase.firestore.FieldValue.delete(),
    discussionTimerEndsAt: firebase.firestore.FieldValue.delete()
  });
  await batch.commit();
}

async function castVote(sessionId, voterId, targetId) {
  try {
    await db.collection(`werewolf_sessions/${sessionId}/votes`).doc(voterId).set({
      targetId: targetId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn('Vote rejected by security rules:', err);
    alert('That vote could not be recorded — voting may have just closed.');
  }
}

async function revealVoting(sessionId, force = false) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (!data.votingOpen) return;   // already resolved
  const wasRunoff = !!data.voteEligibleTargets;

  const [votesSnap, playersSnap] = await Promise.all([
    db.collection(`werewolf_sessions/${sessionId}/votes`).get(),
    db.collection(`werewolf_sessions/${sessionId}/players`).get()
  ]);
  const eligibleVoterIds = new Set();
  const players = [];
  playersSnap.forEach(doc => {
    const p = { id: doc.id, ...doc.data() };
    players.push(p);
    if (p.participationStatus !== 'removed' && p.alive !== false) eligibleVoterIds.add(p.id);
  });
  const validVotes = [];
  votesSnap.forEach(doc => {
    if (eligibleVoterIds.has(doc.id)) validVotes.push(doc);
  });
  if (!force && validVotes.length < eligibleVoterIds.size) return;

  const tally = {};
  validVotes.forEach(doc => {
    const t = doc.data().targetId;
    tally[t] = (tally[t] || 0) + 1;
  });

  let topCount = 0;
  Object.values(tally).forEach(c => { if (c > topCount) topCount = c; });
  const topIds = Object.keys(tally).filter(id => tally[id] === topCount);

  const nameOf = id => {
    const p = players.find(pp => pp.id === id);
    return p ? (p.displayName) : 'Unknown';
  };

  let announcement = { type: 'none' };
  let nextVoteEligible = null;
  const deathIds = [];

  if (topIds.length > 1) {
    const tiedNames = topIds.map(nameOf);
    if (wasRunoff) {
      announcement = { type: 'still_tied', names: tiedNames };
    } else {
      announcement = { type: 'tie', names: tiedNames };
      nextVoteEligible = topIds;
    }
  } else if (topIds.length === 1) {
    const target = players.find(p => p.id === topIds[0]);
    if (target && target.participationStatus !== 'removed' && isWerewolf(target.role)) {
      deathIds.push(target.id);
      target.alive = false;
      announcement = { type: 'werewolf_out', name: target.displayName };
    }
    // else: top vote-getter isn't a Werewolf. Nothing is eliminated,
    // nothing is revealed — see the file header for why.
  }

  const batch = db.batch();
  deathIds.forEach(id => {
    batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(id), { alive: false });
    batch.update(db.collection(`werewolf_sessions/${sessionId}/roster`).doc(id), { alive: false });
  });
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: !!nextVoteEligible,
    announcement: announcement,
    deathSeen: [],
    voteEligibleTargets: nextVoteEligible || firebase.firestore.FieldValue.delete(),
    discussionTimerEndsAt: firebase.firestore.FieldValue.delete()
  });
  await batch.commit();

  await checkAndApplyWinner(sessionId, players);
}

async function eliminatePlayer(sessionId, uid) {
  const ref = db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid);
  const doc = await ref.get();
  if (!doc.exists) return;
  if (doc.data().alive === false) return;   // already dead — idempotent

  const batch = db.batch();
  batch.update(ref, { alive: false });
  batch.update(db.collection(`werewolf_sessions/${sessionId}/roster`).doc(uid), { alive: false });
  const sessionSnap = await db.collection('werewolf_sessions').doc(sessionId).get();
  if ((sessionSnap.data() || {}).votingOpen) {
    batch.delete(db.collection(`werewolf_sessions/${sessionId}/votes`).doc(uid));
  }
  await batch.commit();

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));
  await checkAndApplyWinner(sessionId, players);
}

// Pure — no Firestore reads or writes. Given the current players (with any
// local mutations for a death already applied by the caller), figures out
// what should happen next. Callers decide HOW to apply it, since a
// moderator and a firing Hunter have different write permissions.
function resolveOutcome(players) {
  const successorId = pickChiefSuccessor(players); // from rules.js
  if (successorId) {
    const successor = players.find(p => p.id === successorId);
    if (successor) successor.role = 'chief_werewolf'; // for the checks below; caller writes it for real
  }

  const pendingHunterId = findPendingHunter(players); // from rules.js
  if (pendingHunterId) {
    return { successorId: successorId || null, pendingHunterShot: pendingHunterId, winner: null };
  }

  return { successorId: successorId || null, pendingHunterShot: null, winner: checkWinCondition(players) };
}

// Moderator-authority path. Used by every elimination that originates from
// the moderator's own client (revealVoting, eliminatePlayer, endNight,
// skipHunterShot) — none of them need the queuing fireHunterShot uses,
// because the moderator can write role/winner directly.
async function checkAndApplyWinner(sessionId, players) {
  const outcome = resolveOutcome(players);

  if (outcome.successorId) {
    await db.collection(`werewolf_sessions/${sessionId}/players`).doc(outcome.successorId)
      .update({ role: 'chief_werewolf' });
  }

  if (outcome.pendingHunterShot) {
    // IMPORTANT: do NOT touch announcement here. Whatever the caller set
    // (night_death, werewolf_out, ...) stays visible; the UI adds a
    // separate "waiting for Hunter" line when pendingHunterShot is set.
    await db.collection('werewolf_sessions').doc(sessionId).update({
      pendingHunterShot: outcome.pendingHunterShot
    });
    return;
  }

  if (outcome.winner) {
    await db.collection('werewolf_sessions').doc(sessionId).update({
      winner: outcome.winner,
      votingOpen: false,
      voteEligibleTargets: firebase.firestore.FieldValue.delete()
    });
  }
}

// Moderator escape hatch: resolve a pending Hunter shot without the
// Hunter's input (phone dead, player gone). Moderator-invoked, so it calls
// checkAndApplyWinner() directly — no queue needed, unlike fireHunterShot().
async function skipHunterShot(sessionId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  const hunterId = data.pendingHunterShot;
  if (!hunterId) return;

  const hunterDoc = await db.collection(`werewolf_sessions/${sessionId}/players`).doc(hunterId).get();
  const hunterName = hunterDoc.exists
    ? (hunterDoc.data().displayName)
    : 'The Hunter';

  const batch = db.batch();
  batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(hunterId), { hunterShotUsed: true });
  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    pendingHunterShot: firebase.firestore.FieldValue.delete(),
    announcement: { type: 'hunter_skipped', hunterName: hunterName },
    deathSeen: []
  });
  await batch.commit();

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));
  const hunter = players.find(p => p.id === hunterId);
  if (hunter) hunter.hunterShotUsed = true;
  await checkAndApplyWinner(sessionId, players);
}

// Fired from the HUNTER'S OWN client — the one non-moderator resolution
// path in the game. It deliberately touches ONLY what firestore.rules
// grants a pending Hunter, and reads ONLY what a Hunter is allowed to read:
//   - the PUBLIC roster (names) — never a /players collection query. A
//     regular player's collection query on /players is rejected outright
//     by Firestore (the rule can't be proven for every document), which is
//     exactly what broke the previous version of this function.
//   - writes: their own hunterShotUsed, the target's alive (players AND
//     roster), and session { pendingHunterShot, announcement, deathSeen,
//     pendingWinRecheck }.
// A Hunter's client can't see anyone's role, so it can't decide Chief
// succession or the winner. It raises pendingWinRecheck instead, and the
// moderator's always-listening client runs the full check (see
// applyPendingWinRecheck below and ui.js's session listener).
async function fireHunterShot(sessionId, hunterId, targetId) {
  const sessionRef = db.collection('werewolf_sessions').doc(sessionId);
  const snap = await sessionRef.get();
  if ((snap.data() || {}).pendingHunterShot !== hunterId) return; // not the pending Hunter — bail

  const rosterName = async (uid, fallback) => {
    const d = await db.collection(`werewolf_sessions/${sessionId}/roster`).doc(uid).get();
    return d.exists ? (d.data().displayName || fallback) : fallback;
  };

  const hunterName = await rosterName(hunterId, 'The Hunter');
  const batch = db.batch();
  batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(hunterId), { hunterShotUsed: true });

  let announcement;
  if (targetId) {
    const targetName = await rosterName(targetId, 'someone');
    batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(targetId), { alive: false });
    batch.update(db.collection(`werewolf_sessions/${sessionId}/roster`).doc(targetId), { alive: false });
    announcement = { type: 'hunter_shot', hunterName: hunterName, targetName: targetName };
  } else {
    announcement = { type: 'hunter_skipped', hunterName: hunterName };
  }

  batch.update(sessionRef, {
    pendingHunterShot: firebase.firestore.FieldValue.delete(),
    announcement: announcement,
    deathSeen: [],
    pendingWinRecheck: true
  });
  await batch.commit();
}

// Consumed ONLY by the moderator's client (ui.js session listener). Runs
// the same succession / chained-Hunter / win check every other elimination
// gets, with full read access to /players, then clears the flag. The
// in-flight guard stops the listener (which fires more than once per
// change) from running it twice concurrently.
let winRecheckInFlight = false;
async function applyPendingWinRecheck(sessionId) {
  if (winRecheckInFlight) return;
  winRecheckInFlight = true;
  try {
    const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
    const players = [];
    playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));
    await checkAndApplyWinner(sessionId, players);
    await db.collection('werewolf_sessions').doc(sessionId)
      .update({ pendingWinRecheck: firebase.firestore.FieldValue.delete() });
  } finally {
    winRecheckInFlight = false;
  }
}
