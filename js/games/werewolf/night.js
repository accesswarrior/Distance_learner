// js/games/werewolf/night.js
// Sequenced private night actions, coordinated by the moderator.
//
// The moderator activates one role at a time. Only the player holding that
// role can act during that step.
//
// The other werewolves discuss out loud; only the Chief Werewolf taps the
// agreed target into the app.
//
// The Witch acts right after the Chief on purpose — she's shown the
// werewolves' chosen victim (via getWolfTarget) and decides from there.
//
// The Seer never writes anything but a bare `{done: true}` marker:
// checkPlayer() reads the target's player doc directly (Firestore rules
// grant that read to exactly one person) and the answer lives only in the
// Seer's local screen state. Not even the moderator can see who was
// checked or what came back.
//
// Potion flags (healPotionUsed, poisonPotionUsed) are game-authoritative
// fields, so the Witch cannot self-write them. Instead she appends to
// session.pendingPotionFlags; the moderator's client (which CAN write
// those fields) applies them and prunes the queue. See ui.js.
//
// Schema additions (all under werewolf_sessions/{sessionId}):
//   .phase       -> 'night' | 'day'
//   .nightStep   -> null | 'doctor' | 'chief_werewolf' | 'witch' | 'seer' | 'done'
//   /nightActions/{role} -> { targetId, updatedAt }   (doctor, chief_werewolf)
//                        -> { done: true, updatedAt } (seer — no target)
//                        -> { action, targetId?, updatedAt } (witch)
//   cleared at the start of every night, same pattern as /votes.

const NIGHT_ROLE_ORDER = ['doctor', 'chief_werewolf', 'witch', 'seer'];

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

async function advanceNight(sessionId, currentStep) {
  const idx = NIGHT_ROLE_ORDER.indexOf(currentStep);
  const next = (idx === -1 || idx === NIGHT_ROLE_ORDER.length - 1)
    ? 'done'
    : NIGHT_ROLE_ORDER[idx + 1];
  await db.collection('werewolf_sessions').doc(sessionId).update({ nightStep: next });
}

// Resolves the night: Doctor's save OR Witch's heal both block the
// werewolves' kill; the Witch's poison is independent.
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

  const savedId    = doctorDoc.exists ? doctorDoc.data().targetId : null;
  const killId     = killDoc.exists   ? killDoc.data().targetId   : null;
  const witchAction = witchDoc.exists ? witchDoc.data() : { action: 'none' };

  const wolfVictimSaved = !!killId && (killId === savedId || witchAction.action === 'save');

  const deathIds = new Set();
  if (killId && !wolfVictimSaved) deathIds.add(killId);
  if (witchAction.action === 'poison' && witchAction.targetId) deathIds.add(witchAction.targetId);

  let announcement = { type: 'no_night_death' };
  if (deathIds.size > 0) {
    const batch = db.batch();
    deathIds.forEach(id => {
      batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(id), { alive: false });
      const p = players.find(pp => pp.id === id);
      if (p) p.alive = false;
    });
    await batch.commit();
    announcement = { type: 'night_death', names: Array.from(deathIds).map(nameOf) };
  }

  await db.collection('werewolf_sessions').doc(sessionId).update({
    phase: 'day',
    nightStep: 'done',
    announcement: announcement,
    deathSeen: [] // fresh list for this reveal
  });

  await checkAndApplyWinner(sessionId, players);
}

// Doctor and Chief Werewolf only. The Seer uses markSeerDone (below); the
// Witch uses submitWitchAction.
async function submitNightAction(sessionId, role, targetId) {
  try {
    await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc(role).set({
      targetId: targetId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn('Night action rejected by security rules:', err);
    alert('That choice could not be recorded — the night step may have already moved on.');
  }
}

// Seer-only. Marks the Seer's step as completed WITHOUT recording a target.
// The moderator's listener sees {done: true} but has no way to learn who was
// checked or what the answer was.
async function markSeerDone(sessionId) {
  try {
    await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('seer').set({
      done: true,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn('Could not mark Seer step done:', err);
  }
}

// Seer-only. Reads one target's role directly — Firestore rules allow this
// ONLY for the alive Seer in this session. The result is returned to the
// caller and shown locally; it is never written back to Firestore.
async function checkPlayer(sessionId, targetId) {
  const doc = await db.collection(`werewolf_sessions/${sessionId}/players`).doc(targetId).get();
  return doc.exists ? isWerewolf(doc.data().role) : null;
}

// Witch-only. Reads who the Chief Werewolf targeted tonight.
async function getWolfTarget(sessionId) {
  const doc = await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('chief_werewolf').get();
  return doc.exists ? doc.data().targetId : null;
}

// Witch-only. `action` is 'save' | 'poison' | 'none'. Writes her action doc
// and, for save/poison, appends an entry to session.pendingPotionFlags.
// The moderator's client applies the flag onto her player doc.
async function submitWitchAction(sessionId, witchUid, action, targetId) {
  const write = { action: action, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
  if (action === 'poison') write.targetId = targetId;
  await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('witch').set(write);

  if (action === 'save' || action === 'poison') {
    const entry = {
      witchUid: witchUid,
      flag: action === 'save' ? 'healPotionUsed' : 'poisonPotionUsed',
      at: Date.now()
    };
    db.collection('werewolf_sessions').doc(sessionId)
      .update({ pendingPotionFlags: firebase.firestore.FieldValue.arrayUnion(entry) })
      .catch(err => console.warn('Could not queue potion flag update:', err));
  }
}
