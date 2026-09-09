// js/games/werewolf/voting.js
//
// Adds two moderator powers on top of the existing lobby/role-assignment
// flow, plus in-app voting:
//   1. Manual "Eliminate" — the moderator removes a player at any point
//      (a night kill decided out loud, someone who has to leave, etc).
//   2. In-app day-phase voting — players tap a name instead of the
//      point-on-3 method. The reveal deliberately hides everything except
//      "a Werewolf was voted out: X" or "Nobody was voted out" — never
//      who was leading, and never a non-Werewolf's name — so a survived
//      round doesn't quietly rule anyone out.
//
// Schema additions (all under werewolf_sessions/{sessionId}):
//   .votingOpen        -> bool
//   .announcement       -> { type: 'werewolf_out', name } | { type: 'none' } | null
//   .winner             -> 'werewolves' | 'villagers' | null
//   /votes/{voterId}    -> { targetId, updatedAt }  (cleared after every reveal)

// Opens a new voting round. Clears any stray vote docs from the previous
// round first, so a slow write from a prior reveal can't leak into this one.
async function startVoting(sessionId) {
  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: true,
    announcement: null
  }, { merge: true });
  await batch.commit();
}

// A player casts (or changes) their vote. Safe to call repeatedly — each
// player has exactly one vote doc, so re-tapping just overwrites the target.
async function castVote(sessionId, voterId, targetId) {
  await db.collection(`werewolf_sessions/${sessionId}/votes`).doc(voterId).set({
    targetId: targetId,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Moderator taps "Reveal Result" whenever they're ready (no turnout
// requirement). Tallies votes, and *only* eliminates + names the target if
// they're the single top vote-getter AND a Werewolf. In every other case
// (top target isn't a Werewolf, or there's a tie) nobody is eliminated and
// nothing about the tally is exposed — not the leader, not the count.
async function revealVoting(sessionId) {
  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const tally = {};
  votesSnap.forEach(doc => {
    const targetId = doc.data().targetId;
    tally[targetId] = (tally[targetId] || 0) + 1;
  });

  let topId = null;
  let topCount = 0;
  let tied = false;
  Object.entries(tally).forEach(([id, count]) => {
    if (count > topCount) {
      topId = id;
      topCount = count;
      tied = false;
    } else if (count === topCount) {
      tied = true;
    }
  });

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));

  let announcement = { type: 'none' };
  if (topId && !tied) {
    const target = players.find(p => p.id === topId);
    if (target && target.role === 'werewolf') {
      await db.collection(`werewolf_sessions/${sessionId}/players`).doc(topId).update({ alive: false });
      target.alive = false; // keep the local copy in sync for the win check below
      announcement = { type: 'werewolf_out', name: target.username };
    }
  }

  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: false,
    announcement: announcement
  }, { merge: true });
  await batch.commit();

  await checkAndApplyWinner(sessionId, players);
}

// Moderator's manual override: eliminate any player immediately, regardless
// of voting. Used for a night kill the group resolved out loud, or to pull
// someone who had to step away mid-game.
async function eliminatePlayer(sessionId, uid) {
  await db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid).update({ alive: false });

  const playersSnap = await db.collection(`werewolf_sessions/${sessionId}/players`).get();
  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
  await checkAndApplyWinner(sessionId, players);
}

async function checkAndApplyWinner(sessionId, players) {
  const winner = checkWinCondition(players); // from rules.js
  if (winner) {
    await db.collection('werewolf_sessions').doc(sessionId).update({ winner: winner });
  }
}
