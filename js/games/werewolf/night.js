// js/games/werewolf/night.js
//
// Sequenced private night actions, coordinated by the moderator.
// The moderator "activates" one role at a time; only the player holding
// that role (and the moderator) can act or see anything during that step.
//
// The other werewolves discuss out loud (they already know each other) and
// only the Chief Werewolf taps the agreed target into the app — so this
// module only ever needs one werewolf-side submission per night, alongside
// Doctor and Seer. Add more to NIGHT_ROLE_ORDER if you add roles that need
// the same treatment (e.g. a Bodyguard).
//
// Schema additions (all under werewolf_sessions/{sessionId}):
//   .phase       -> 'night' | 'day'
//   .nightStep   -> null | 'doctor' | 'chief_werewolf' | 'seer' | 'done'
//   /nightActions/{role}  -> { targetId, updatedAt }
//   cleared at the start of every night, same pattern as /votes.
//
// endNight() is where the night actually resolves: it compares the
// Doctor's save against the Chief Werewolf's kill target and applies (or
// skips) the elimination automatically — the moderator doesn't have to
// work that out by hand.

const NIGHT_ROLE_ORDER = ['doctor', 'chief_werewolf', 'seer'];

// Moderator taps "Start Night". Clears last night's actions and opens
// the sequence at the first role in NIGHT_ROLE_ORDER.
async function startNight(sessionId) {
  const snap = await db.collection(`werewolf_sessions/${sessionId}/nightActions`).get();
  const batch = db.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    phase: 'night',
    nightStep: NIGHT_ROLE_ORDER[0]
  }, { merge: true });
  await batch.commit();
}

// Moderator advances to the next role, or to 'done' after the last one.
// The moderator can always advance even if the current role hasn't
// submitted yet (e.g. that role isn't in play this game).
async function advanceNight(sessionId, currentStep) {
  const idx = NIGHT_ROLE_ORDER.indexOf(currentStep);
  const next = (idx === -1 || idx === NIGHT_ROLE_ORDER.length - 1) ? 'done' : NIGHT_ROLE_ORDER[idx + 1];
  await db.collection('werewolf_sessions').doc(sessionId).update({ nightStep: next });
}

// Moderator ends the night. This is where the kill actually resolves:
// if the Chief Werewolf's target wasn't the Doctor's save, that player is
// eliminated automatically and named in the announcement; if it was saved
// (or nobody was targeted), nobody dies. Mirrors revealVoting()'s pattern
// in voting.js — read everything, decide, write once.
async function endNight(sessionId) {
  const [doctorDoc, killDoc, playersSnap] = await Promise.all([
    db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('doctor').get(),
    db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('chief_werewolf').get(),
    db.collection(`werewolf_sessions/${sessionId}/players`).get()
  ]);

  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));

  const savedId = doctorDoc.exists ? doctorDoc.data().targetId : null;
  const killId = killDoc.exists ? killDoc.data().targetId : null;

  let announcement = { type: 'no_night_death' };
  if (killId && killId !== savedId) {
    const victim = players.find(p => p.id === killId);
    if (victim && victim.alive !== false) {
      await db.collection(`werewolf_sessions/${sessionId}/players`).doc(killId).update({ alive: false });
      victim.alive = false; // keep local copy in sync for the win check below
      announcement = { type: 'night_death', name: victim.displayName || victim.username };
    }
  }

  await db.collection('werewolf_sessions').doc(sessionId).update({
    phase: 'day',
    nightStep: 'done',
    announcement: announcement
  });

  await checkAndApplyWinner(sessionId, players); // from voting.js
}

// The player currently holding the active role submits their target.
// Firestore rules enforce that only that exact player can write this doc.
async function submitNightAction(sessionId, role, targetId) {
  await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc(role).set({
    targetId: targetId,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Seer-only. Reads one target's role directly — Firestore rules allow this
// ONLY for the alive player currently holding 'seer' in this session (see
// firestore.rules). The result is returned to the caller and shown locally;
// it is never written back to Firestore, so it can't leak via a listener.
async function checkPlayer(sessionId, targetId) {
  const doc = await db.collection(`werewolf_sessions/${sessionId}/players`).doc(targetId).get();
  return doc.exists ? isWerewolf(doc.data().role) : null; // isWerewolf from rules.js
}
