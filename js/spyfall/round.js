// js/spyfall/round.js
// Round flow: deal, discuss, vote, (spy guess), score, rotate.
//
//   idle -> dealing -> discussing -> voting -> guess -> scored -> (next round) idle
//                                         \------------^ (spy not caught goes straight to scored)
//
// WHO WRITES WHAT — the same queue pattern Werewolf uses:
//   * The OPERATOR's client is the only one that advances the round, reads the
//     secret (location + spy), counts votes and awards points.
//   * Everyone else only writes small "queue" facts the rules allow:
//       - a participant: "I've seen my card"    (seenCardUids)
//       - a participant: "please call a vote"   (voteRequestedBy)
//       - a participant: their own ballot       (votes/{uid})
//       - the caught spy: their guess           (spyGuess)
//     The operator reads those and applies them. In particular the spy never
//     decides whether their own guess was right: they can't even read the
//     secret, so the check has to happen on the operator's side.

// ---------- Operator: DEAL ----------

async function dealSpyfallRound(sessionId) {
  const sessionRef = db.collection('spyfall_sessions').doc(sessionId);
  const [sessionSnap, playersSnap, votesSnap] = await Promise.all([
    sessionRef.get(),
    sessionRef.collection('players').get(),
    sessionRef.collection('votes').get()
  ]);
  const session = sessionSnap.data() || {};
  // Guard against a double tap dealing twice (which would change the spy mid-round).
  if (session.status !== 'playing' || session.roundState !== 'idle') return false;

  const players = [];
  playersSnap.forEach(d => players.push({ id: d.id, ...d.data() }));

  // Only people fixed in the join order at Start can take part, so a stray or
  // late player document can never become a participant who never sees a card.
  const inOrder = new Set(session.playerOrder || []);
  const participantIds = players
    .filter(p => inOrder.has(p.id) && p.active !== false && p.id !== session.operatorId)
    .map(p => p.id);
  if (participantIds.length < SPYFALL_MIN_PARTICIPANTS) {
    throw new Error(`Need at least ${SPYFALL_MIN_PARTICIPANTS} players besides the operator.`);
  }

  const location = pickSpyfallLocation(session.usedLocations);
  const spyId = pickSpyfallSpy(participantIds);
  const roundNum = (session.currentRound || 0) + 1;
  const del = firebase.firestore.FieldValue.delete();

  const batch = db.batch();

  // The truth: operator-only.
  batch.set(sessionRef.collection('secrets').doc('current'), {
    locationId: location,
    spyId: spyId,
    roundNumber: roundNum
  });

  // Each participant's private card. `roundNumber` lets their client ignore a
  // card left over from an earlier round if snapshots arrive out of order.
  players.forEach(p => {
    const privRef = sessionRef.collection('privatePlayers').doc(p.id);
    if (participantIds.includes(p.id)) {
      batch.set(privRef, {
        role: p.id === spyId ? 'spy' : 'agent',
        location: p.id === spyId ? null : location,
        roundNumber: roundNum
      });
    } else {
      batch.delete(privRef);   // e.g. last round's spy who is now the operator
    }
    batch.update(sessionRef.collection('players').doc(p.id), {
      inCurrentRound: participantIds.includes(p.id)
    });
  });

  // Last round's ballots must not leak into this round's count.
  votesSnap.forEach(d => batch.delete(d.ref));

  batch.update(sessionRef, {
    roundState: 'dealing',
    currentRound: roundNum,
    seenCardUids: [],
    voteRequestedBy: del,
    voteCallerId: del,
    votingEndsAt: del,
    discussionEndsAt: del,
    guessEndsAt: del,
    spyGuess: del,
    spyGuessCorrect: del,
    roundWinner: del,
    accusationTargetId: del,
    voteTally: del,
    spyCaught: del,
    voteWasTied: del,
    usedLocations: firebase.firestore.FieldValue.arrayUnion(location)
  });

  await batch.commit();
  return true;
}

// ---------- Operator: DISCUSS ----------

async function beginSpyfallDiscussion(sessionId) {
  const ref = db.collection('spyfall_sessions').doc(sessionId);
  const snap = await ref.get();
  if ((snap.data() || {}).roundState !== 'dealing') return false;
  await ref.update({
    roundState: 'discussing',
    discussionEndsAt: Date.now() + SPYFALL_DISCUSSION_SECONDS * 1000
  });
  return true;
}

// ---------- Operator: open the vote ----------
// Triggered by a participant's request (voteRequestedBy) or by the
// discussion timer running out.

async function openSpyfallVoting(sessionId, callerId) {
  const ref = db.collection('spyfall_sessions').doc(sessionId);
  const [snap, votesSnap] = await Promise.all([ref.get(), ref.collection('votes').get()]);
  if ((snap.data() || {}).roundState !== 'discussing') return false;

  const batch = db.batch();
  votesSnap.forEach(d => batch.delete(d.ref));
  batch.update(ref, {
    roundState: 'voting',
    voteCallerId: callerId,
    votingEndsAt: Date.now() + SPYFALL_VOTE_SECONDS * 1000,
    voteRequestedBy: firebase.firestore.FieldValue.delete()
  });
  await batch.commit();
  return true;
}

// ---------- Operator: close the vote ----------

async function closeSpyfallVoting(sessionId) {
  const ref = db.collection('spyfall_sessions').doc(sessionId);
  const [sessionSnap, votesSnap, playersSnap, secretSnap] = await Promise.all([
    ref.get(),
    ref.collection('votes').get(),
    ref.collection('players').get(),
    ref.collection('secrets').doc('current').get()
  ]);
  const session = sessionSnap.data() || {};
  if (session.roundState !== 'voting') return false;

  const participantIds = [];
  playersSnap.forEach(d => { if (d.data().inCurrentRound) participantIds.push(d.id); });
  const votes = [];
  votesSnap.forEach(d => votes.push({ voterId: d.id, targetId: (d.data() || {}).targetId }));

  const { tally, accusedId, tied } = tallySpyfallVotes(votes, participantIds);
  const spyId = secretSnap.exists ? secretSnap.data().spyId : null;
  const caught = accusedId !== null && accusedId === spyId;

  const voteInfo = {
    accusationTargetId: accusedId,
    voteTally: tally,
    spyCaught: caught,
    voteWasTied: tied
  };

  if (caught) {
    // The spy gets one chance to name the location.
    await ref.update({
      roundState: 'guess',
      ...voteInfo,
      guessEndsAt: Date.now() + SPYFALL_GUESS_SECONDS * 1000
    });
  } else {
    await finishSpyfallRound(sessionId, { from: 'voting', voteInfo });
  }
  return true;
}

// ---------- Operator: SCORE ----------
// One transaction: re-checks the round state, awards the points, records the
// round and flips to 'scored' atomically. If the operator's client triggers
// this twice (a timer tick racing a snapshot), the second run sees
// 'scored' and does nothing — points can never be awarded twice.

async function finishSpyfallRound(sessionId, { from, voteInfo }) {
  const ref = db.collection('spyfall_sessions').doc(sessionId);
  const secretRef = ref.collection('secrets').doc('current');

  return db.runTransaction(async (tx) => {
    const sessionSnap = await tx.get(ref);
    const session = sessionSnap.data() || {};
    if (session.roundState !== from) return false;

    const secretSnap = await tx.get(secretRef);
    if (!secretSnap.exists) throw new Error('Round secret is missing.');
    const secret = secretSnap.data();

    const players = [];
    for (const id of (session.playerOrder || [])) {
      const snap = await tx.get(ref.collection('players').doc(id));
      if (snap.exists) players.push({ id, ...snap.data() });
    }
    const participantIds = players.filter(p => p.inCurrentRound).map(p => p.id);

    const info = voteInfo || {
      accusationTargetId: session.accusationTargetId || null,
      voteTally: session.voteTally || {},
      spyCaught: !!session.spyCaught,
      voteWasTied: !!session.voteWasTied
    };

    const guess = info.spyCaught ? (session.spyGuess || '') : '';
    const spyGuessCorrect = info.spyCaught && isSpyfallGuessCorrect(guess, secret.locationId);
    const roundWinner = (!info.spyCaught || spyGuessCorrect) ? 'spies' : 'agents';

    const scores = computeSpyfallRoundScores({
      spyId: secret.spyId,
      playerIds: participantIds,
      spyCaught: info.spyCaught,
      spyGuessCorrect
    });

    players.forEach(p => {
      const pts = scores[p.id] || 0;
      if (pts) tx.update(ref.collection('players').doc(p.id), { score: (p.score || 0) + pts });
    });

    tx.set(ref.collection('rounds').doc(String(session.currentRound)), {
      roundNumber: session.currentRound,
      locationId: secret.locationId,
      spyId: secret.spyId,
      operatorId: session.operatorId,
      accusationTargetId: info.accusationTargetId,
      voteTally: info.voteTally,
      voteWasTied: info.voteWasTied,
      spyCaught: info.spyCaught,
      spyGuess: guess || null,
      spyGuessCorrect,
      winner: roundWinner,
      scores,
      endedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    tx.update(ref, {
      roundState: 'scored',
      ...(voteInfo || {}),
      spyGuessCorrect,
      roundWinner
    });
    return true;
  });
}

// ---------- Operator: NEXT ROUND ----------

async function nextSpyfallRound(sessionId) {
  const ref = db.collection('spyfall_sessions').doc(sessionId);
  const [sessionSnap, playersSnap] = await Promise.all([ref.get(), ref.collection('players').get()]);
  const session = sessionSnap.data() || {};
  if (session.roundState !== 'scored') return false;

  const activeIds = new Set();
  playersSnap.forEach(d => { if (d.data().active !== false) activeIds.add(d.id); });

  // Rotate the operator forward through the fixed join order.
  const order = session.playerOrder || [];
  let idx = order.indexOf(session.operatorId);
  let nextOperatorId = session.operatorId;
  for (let i = 0; i < order.length; i++) {
    idx = (idx + 1) % order.length;
    if (activeIds.has(order[idx])) { nextOperatorId = order[idx]; break; }
  }

  await ref.update({ roundState: 'idle', operatorId: nextOperatorId });
  return true;
}

// ---------- Players: the small facts they're allowed to write ----------

function markSpyfallCardSeen(sessionId, uid) {
  return db.collection('spyfall_sessions').doc(sessionId).update({
    seenCardUids: firebase.firestore.FieldValue.arrayUnion(uid)
  });
}

function requestSpyfallVote(sessionId, uid) {
  return db.collection('spyfall_sessions').doc(sessionId).update({ voteRequestedBy: uid });
}

function submitSpyfallVote(sessionId, voterId, targetId) {
  return db.collection(`spyfall_sessions/${sessionId}/votes`).doc(voterId).set({
    targetId: targetId,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

function submitSpyfallGuess(sessionId, guess) {
  return db.collection('spyfall_sessions').doc(sessionId).update({ spyGuess: String(guess || '').slice(0, 60) });
}
