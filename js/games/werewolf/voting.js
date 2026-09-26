// js/games/werewolf/voting.js
// In-app day-phase voting, manual moderator override, win-condition
// resolution, and the Hunter's last shot.
//
// STANDARD ELIMINATION RULE: the voted-out player dies, regardless of
// role. The announcement reveals whether they were a werewolf. This is a
// change from the earlier "missed votes cost nothing" variant.
//
// The announcement and pendingHunterShot are INDEPENDENT pieces of state.
// checkAndApplyWinner no longer overwrites the announcement when it
// detects a pending Hunter — the UI shows both.

async function startVoting(sessionId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (data.votingOpen) return;          // already open
  if (data.phase === 'night') return;   // not during night
  if (data.winner) return;

  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: true,
    announcement: firebase.firestore.FieldValue.delete(),
    deathSeen: [],
    voteEligibleTargets: firebase.firestore.FieldValue.delete()
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

async function revealVoting(sessionId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (!data.votingOpen) return;   // already resolved
  const wasRunoff = !!data.voteEligibleTargets;

  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const tally = {};
  votesSnap.forEach(doc => {
    const t = doc.data().targetId;
    tally[t] = (tally[t] || 0) + 1;
  });

  let topCount = 0;
  Object.values(tally).forEach(c => { if (c > topCount) topCount = c; });
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
    if (target && target.participationStatus !== 'removed') {
      deathIds.push(target.id);
      target.alive = false;
      announcement = isWerewolf(target.role)
        ? { type: 'werewolf_out', name: target.displayName || target.username }
        : { type: 'villager_out', name: target.displayName || target.username };
    }
  }

  const batch = db.batch();
  deathIds.forEach(id => {
    batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(id), { alive: false });
  });
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: !!nextVoteEligible,
    announcement: announcement,
    deathSeen: [],
    voteEligibleTargets: nextVoteEligible || firebase.firestore.FieldValue.delete()
  });
  await batch.commit();

  await checkAndApplyWinner(sessionId, players);
}

async function eliminatePlayer(sessionId, uid) {
  const ref = db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid);
  const doc = await ref.get();
  if (!doc.exists) return;
  if (doc.data().alive === false) return;   // already dead — idempotent

  await ref.update({ alive: false });

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));
  await checkAndApplyWinner(sessionId, players);
}

async function checkAndApplyWinner(sessionId, players) {
  const successorId = pickChiefSuccessor(players);
  if (successorId) {
    await db.collection(`werewolf_sessions/${sessionId}/players`).doc(successorId)
      .update({ role: 'chief_werewolf' });
    const successor = players.find(p => p.id === successorId);
    if (successor) successor.role = 'chief_werewolf';
  }

  const pendingHunterId = findPendingHunter(players);
  if (pendingHunterId) {
    // IMPORTANT: do NOT touch announcement. Whatever the caller set
    // (night_death, villager_out, werewolf_out, ...) stays visible. The
    // UI adds a separate "waiting for Hunter" line when pendingHunterShot
    // is set.
    await db.collection('werewolf_sessions').doc(sessionId).update({
      pendingHunterShot: pendingHunterId
    });
    return;
  }

  const winner = checkWinCondition(players);
  if (winner) {
    await db.collection('werewolf_sessions').doc(sessionId).update({ winner: winner });
  }
}

// Moderator escape hatch: resolve a pending Hunter shot without the
// Hunter's input (phone dead, player gone). Clears pendingHunterShot and
// posts a "skipped" announcement.
async function skipHunterShot(sessionId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  const hunterId = data.pendingHunterShot;
  if (!hunterId) return;

  const hunterDoc = await db.collection(`werewolf_sessions/${sessionId}/players`).doc(hunterId).get();
  const hunterName = hunterDoc.exists
    ? (hunterDoc.data().displayName || hunterDoc.data().username)
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
  await checkAndApplyWinner(sessionId, players);
}

async function fireHunterShot(sessionId, hunterId, targetId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  if (snap.data().pendingHunterShot !== hunterId) return;  // not the pending Hunter — bail

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
  playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));
  await checkAndApplyWinner(sessionId, players);
}
