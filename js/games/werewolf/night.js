// js/games/werewolf/night.js
//
// Sequenced private night actions, coordinated by the moderator.
// The moderator "activates" one role at a time; only the player holding
// that role (and the moderator) can act or see anything during that step.
//
// The other werewolves discuss out loud (they already know each other) and
// only the Chief Werewolf taps the agreed target into the app — so this
// module only ever needs one werewolf-side submission per night, alongside
// Doctor, Witch, and Seer.
//
// The Witch acts right after the Chief Werewolf on purpose: she's shown the
// werewolves' chosen victim (see getWolfTarget) and decides from there,
// which is the classic Witch ability — a specific, informed save, not a
// blind guess like the Doctor's.
//
// Schema additions (all under werewolf_sessions/{sessionId}):
//   .phase       -> 'night' | 'day'
//   .nightStep   -> null | 'doctor' | 'chief_werewolf' | 'witch' | 'seer' | 'done'
//   /nightActions/{role}  -> { targetId, updatedAt }             (doctor, chief_werewolf, seer's own check isn't stored)
//   /nightActions/witch   -> { action: 'save'|'poison'|'none', targetId?, updatedAt }
//   cleared at the start of every night, same pattern as /votes.
//
// endNight() is where the night actually resolves: Doctor's save OR the
// Witch's heal both block the werewolves' kill; the Witch's poison is
// independent and always lands, regardless of the Doctor. The moderator
// doesn't have to work any of that out by hand.

const NIGHT_ROLE_ORDER = ['doctor', 'chief_werewolf', 'witch', 'seer'];

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

// Moderator ends the night. This is where the kill(s) actually resolve.
// Mirrors revealVoting()'s pattern in voting.js — read everything, decide,
// write once.
async function endNight(sessionId) {
  const [doctorDoc, killDoc, witchDoc, playersSnap] = await Promise.all([
    db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('doctor').get(),
    db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('chief_werewolf').get(),
    db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('witch').get(),
    db.collection(`werewolf_sessions/${sessionId}/players`).get()
  ]);

  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
  const nameOf = id => {
    const p = players.find(pp => pp.id === id);
    return p ? (p.displayName || p.username) : 'Unknown';
  };

  const savedId = doctorDoc.exists ? doctorDoc.data().targetId : null;
  const killId = killDoc.exists ? killDoc.data().targetId : null;
  const witchAction = witchDoc.exists ? witchDoc.data() : { action: 'none' };

  // The werewolves' target survives if the Doctor happened to save that
  // exact person, OR the Witch used her heal potion (which is always
  // aimed at the werewolves' target, never a free pick).
  const wolfVictimSaved = !!killId && (killId === savedId || witchAction.action === 'save');

  const deathIds = new Set();
  if (killId && !wolfVictimSaved) deathIds.add(killId);
  // The Witch's poison is independent of the Doctor entirely — classic
  // Werewolf rule, nothing can block it once she's used it.
  if (witchAction.action === 'poison' && witchAction.targetId) deathIds.add(witchAction.targetId);

  let announcement = { type: 'no_night_death' };
  if (deathIds.size > 0) {
    const batch = db.batch();
    deathIds.forEach(id => {
      batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(id), { alive: false });
      const p = players.find(pp => pp.id === id);
      if (p) p.alive = false; // keep local copy in sync for the checks below
    });
    await batch.commit();
    announcement = { type: 'night_death', names: Array.from(deathIds).map(nameOf) };
  }

  await db.collection('werewolf_sessions').doc(sessionId).update({
    phase: 'day',
    nightStep: 'done',
    announcement: announcement
  });

  // From voting.js — also handles Chief succession and holds off the win
  // check if a Hunter just died and hasn't taken their shot yet.
  await checkAndApplyWinner(sessionId, players);
}

// The player currently holding the active role submits their target.
// Firestore rules enforce that only that exact player can write this doc.
// (Used by Doctor, Chief Werewolf, and Seer — Witch uses submitWitchAction
// below since her options aren't a plain target list.)
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

// Witch-only. Reads who the Chief Werewolf targeted tonight — Firestore
// rules grant this one specific cross-role read to the alive Witch only
// (see firestore.rules). Nothing else about other roles' actions is ever
// exposed to her.
async function getWolfTarget(sessionId) {
  const doc = await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('chief_werewolf').get();
  return doc.exists ? doc.data().targetId : null;
}

// Witch-only. `action` is 'save' (heals the werewolves' chosen victim —
// she's shown that name, it's not a free pick), 'poison' (targetId
// required, bypasses the Doctor entirely), or 'none'. Marks the relevant
// potion used immediately, from the Witch's own client, so her screen
// updates without waiting for the moderator to end the night.
async function submitWitchAction(sessionId, witchUid, action, targetId) {
  const write = { action: action, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
  if (action === 'poison') write.targetId = targetId;
  await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('witch').set(write);

  if (action === 'save') {
    await db.collection(`werewolf_sessions/${sessionId}/players`).doc(witchUid).update({ healPotionUsed: true });
  } else if (action === 'poison') {
    await db.collection(`werewolf_sessions/${sessionId}/players`).doc(witchUid).update({ poisonPotionUsed: true });
  }
}
