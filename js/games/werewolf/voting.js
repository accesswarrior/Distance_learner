// js/games/werewolf/voting.js
// In-app day-phase voting + manual moderator override + win-condition
// resolution + the Hunter's last shot.
//
// Secret ballot: only the voter and the moderator can read a vote doc —
// enforced by firestore.rules, not just the UI. Vote content is also
// validated server-side: only while voting is open, only against a living
// player who isn't the voter, and (during a runoff) only against one of
// the tied names.
//
// Tie handling: a top-tie opens a runoff where only the tied names are
// valid targets. A runoff tie ends the round with "still tied, nobody
// eliminated" rather than looping.
//
// Schema additions (all under werewolf_sessions/{sessionId}):
//   .votingOpen           -> bool
//   .voteEligibleTargets  -> [uid, ...] | absent (present only during a runoff)
//   .announcement         -> { type, ... } | null
//   .deathSeen            -> [uid, ...] (reset by every announcement producer)
//   .winner               -> 'werewolves' | 'villagers' | null
//   /votes/{voterId}      -> { targetId, updatedAt }

async function startVoting(sessionId) {
  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: true,
    announcement: null,
    deathSeen: [],
    voteEligibleTargets: firebase.firestore.FieldValue.delete()
  }, { merge: true });
  await batch.commit();
}

// Safe to call repeatedly — each player has exactly one vote doc.
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

async function revealVoting(sessionId) {
  const sessionDoc = await db.collection('werewolf_sessions').doc(sessionId).get();
  const wasRunoff = !!(sessionDoc.data() && sessionDoc.data().voteEligibleTargets);

  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const tally = {};
  votesSnap.forEach(doc => {
    const targetId = doc.data().targetId;
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  let topCount = 0;
  Object.values(tally).forEach(count => { if (count > topCount) topCount = count; });
  const topIds = Object.keys(tally).filter(id => tally[id] === topCount);

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
  const nameOf = id => {
    const p = players.find(pp => pp.id === id);
    return p ? (p.displayName || p.username) : 'Unknown';
  };

  let announcement = { type: 'none' };
  let nextVoteEligible = null;

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
    if (target && isWerewolf(target.role)) {
      await db.collection(`werewolf_sessions/${sessionId}/players`).doc(target.id).update({ alive: false });
      target.alive = false;
      announcement = { type: 'werewolf_out', name: target.displayName || target.username };
    }
  }

  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: !!nextVoteEligible,
    announcement: announcement,
    deathSeen: [], // fresh list for this reveal
    voteEligibleTargets: nextVoteEligible || firebase.firestore.FieldValue.delete()
  }, { merge: true });
  await batch.commit();

  await checkAndApplyWinner(sessionId, players);
}

// Moderator's manual override. Also used for a night kill resolved out loud.
async function eliminatePlayer(sessionId, uid) {
  await db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid).update({ alive: false });

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
  await checkAndApplyWinner(sessionId, players);
}

// Called after every elimination. Order matters: chief succession first
// (a promotion affects the win check), then a check for a newly-eliminated
// Hunter who hasn't fired — the round holds there.
async function checkAndApplyWinner(sessionId, players) {
  const successorId = pickChiefSuccessor(players);
  if (successorId) {
    await db.collection(`werewolf_sessions/${sessionId}/players`).doc(successorId).update({ role: 'chief_werewolf' });
    const successor = players.find(p => p.id === successorId);
    if (successor) successor.role = 'chief_werewolf';
  }

  const pendingHunterId = findPendingHunter(players);
  if (pendingHunterId) {
    const hunter = players.find(p => p.id === pendingHunterId);
    await db.collection('werewolf_sessions').doc(sessionId).update({
      pendingHunterShot: pendingHunterId,
      announcement: { type: 'hunter_pending', name: hunter ? (hunter.displayName || hunter.username) : 'A Hunter' }
    });
    return;
  }

  const winner = checkWinCondition(players);
  if (winner) {
    await db.collection('werewolf_sessions').doc(sessionId).update({ winner: winner });
  }
}

// The eliminated Hunter's one-time revenge shot. targetId optional (skip).
// Firestore rules allow this specific write to another player's doc ONLY
// while session.pendingHunterShot names the shooter.
//
// deathSeen is reset here because this write replaces the announcement with
// the shot result, which is itself an announcement the room needs to tap
// through.
async function fireHunterShot(sessionId, hunterId, targetId) {
  const hunterDoc = await db.collection(`werewolf_sessions/${sessionId}/players`).doc(hunterId).get();
  const hunterName = hunterDoc.exists
    ? (hunterDoc.data().displayName || hunterDoc.data().username)
    : 'The Hunter';

  const batch = db.batch();
  batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(hunterId), { hunterShotUsed: true });

  let announcement;
  if (targetId) {
    const targetDoc = await db.collection(`werewolf_sessions/${sessionId}/players`).doc(targetId).get();
    const targetName = targetDoc.exists
      ? (targetDoc.data().displayName || targetDoc.data().username)
      : 'someone';
    batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(targetId), { alive: false });
    announcement = { type: 'hunter_shot', hunterName: hunterName, targetName: targetName };
  } else {
    announcement = { type: 'hunter_skipped', hunterName: hunterName };
  }

  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    pendingHunterShot: firebase.firestore.FieldValue.delete(),
    announcement: announcement,
    deathSeen: []
  });
  await batch.commit();

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
  await checkAndApplyWinner(sessionId, players);
}
