// js/games/werewolf/voting.js
//
// Adds two moderator powers on top of the existing lobby/role-assignment
// flow, plus in-app voting:
//   1. Manual "Eliminate" — the moderator removes a player at any point
//      (someone who has to leave, an off-app correction, etc).
//   2. In-app day-phase voting — players tap a name instead of the
//      point-on-3 method. If the top vote-getter is a Werewolf (or the
//      Chief Werewolf) they're eliminated and named. If the top vote-getter
//      is NOT a werewolf, nothing happens and nothing is revealed — not the
//      leader, not the count — so a wrong guess doesn't leak information
//      for free. A tie for the top spot is its own case: see below.
//
// Tie handling: if two or more players are tied for the most votes, nobody
// is eliminated yet. Instead the tied names are announced, and the very
// next vote automatically re-opens as a runoff where those tied players
// are the *only* valid targets (everyone can still vote, just not for
// themselves). If that runoff also ties, we stop there — announce "still
// tied, nobody eliminated" — rather than looping forever; the moderator can
// always run a fresh full vote later if they want to try again.
//
// Schema additions (all under werewolf_sessions/{sessionId}):
//   .votingOpen           -> bool
//   .voteEligibleTargets  -> [uid, ...] | absent  (present only during a runoff)
//   .announcement         -> { type, name/names } | null
//     types: 'werewolf_out' | 'none' | 'tie' | 'still_tied' |
//            'night_death' | 'no_night_death'
//   .winner               -> 'werewolves' | 'villagers' | null
//   /votes/{voterId}      -> { targetId, updatedAt }  (cleared after every reveal)

// Opens a new, unrestricted voting round (not a runoff). Clears any stray
// vote docs from the previous round first, so a slow write from a prior
// reveal can't leak into this one.
async function startVoting(sessionId) {
  const votesSnap = await db.collection(`werewolf_sessions/${sessionId}/votes`).get();
  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: true,
    announcement: null,
    voteEligibleTargets: firebase.firestore.FieldValue.delete()
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
// requirement). Tallies votes, then handles three cases: a clear top
// vote-getter, a tie (opens a runoff among just the tied names), or a tie
// that happened *during* a runoff (stops there instead of looping).
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
  let nextVoteEligible = null; // set only when we're opening a runoff

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
    if (target && isWerewolf(target.role)) { // isWerewolf from rules.js
      await db.collection(`werewolf_sessions/${sessionId}/players`).doc(target.id).update({ alive: false });
      target.alive = false; // keep the local copy in sync for the win check below
      announcement = { type: 'werewolf_out', name: target.displayName || target.username };
    }
  }

  const batch = db.batch();
  votesSnap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    votingOpen: !!nextVoteEligible, // stays open only when rolling straight into a runoff
    announcement: announcement,
    voteEligibleTargets: nextVoteEligible || firebase.firestore.FieldValue.delete()
  }, { merge: true });
  await batch.commit();

  await checkAndApplyWinner(sessionId, players);
}

// Moderator's manual override: eliminate any player immediately, regardless
// of voting. Used for someone who had to step away mid-game, etc.
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
