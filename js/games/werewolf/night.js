// js/games/werewolf/night.js
// Sequenced private night actions, coordinated by the moderator.
//
// Key invariants:
//   - Only the alive player holding the active role can write their action.
//   - The Seer stores { done: true } only — never who was checked.
//   - The Witch stores { action, targetId? } and queues potion-flag
//     intents; the moderator's client applies the flags.
//   - endNight() resolves kills without touching the announcement that
//     checkAndApplyWinner may have set for a pending Hunter.

const NIGHT_ROLE_ORDER = ['doctor', 'chief_werewolf', 'witch', 'seer'];

async function startNight(sessionId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (data.phase === 'night') return;   // already in night — no-op
  if (data.winner) return;              // game over

  const nightSnap = await db.collection(`werewolf_sessions/${sessionId}/nightActions`).get();
  const batch = db.batch();
  nightSnap.forEach(doc => batch.delete(doc.ref));
  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    phase: 'night',
    nightStep: NIGHT_ROLE_ORDER[0]
  });
  await batch.commit();
}

async function advanceNight(sessionId, currentStep) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (data.phase !== 'night') return;

  const idx = NIGHT_ROLE_ORDER.indexOf(currentStep);
  const next = (idx === -1 || idx === NIGHT_ROLE_ORDER.length - 1)
    ? 'done'
    : NIGHT_ROLE_ORDER[idx + 1];
  await db.collection('werewolf_sessions').doc(sessionId).update({ nightStep: next });
}

async function endNight(sessionId) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (data.phase !== 'night' || data.nightStep !== 'done') return;

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

  const savedId     = doctorDoc.exists ? doctorDoc.data().targetId : null;
  const killId      = killDoc.exists   ? killDoc.data().targetId   : null;
  const witchAction = witchDoc.exists  ? witchDoc.data() : { action: 'none' };

  const wolfVictimSaved = !!killId && (killId === savedId || witchAction.action === 'save');

  const deathIds = new Set();
  if (killId && !wolfVictimSaved) deathIds.add(killId);
  if (witchAction.action === 'poison' && witchAction.targetId) deathIds.add(witchAction.targetId);

  // Only mark dead players who are active. A removed player can't be killed.
  const actuallyDyingIds = new Set();
  deathIds.forEach(id => {
    const p = players.find(pp => pp.id === id);
    if (p && p.participationStatus !== 'removed') actuallyDyingIds.add(id);
  });

  let announcement = { type: 'no_night_death' };
  if (actuallyDyingIds.size > 0) {
    const batch = db.batch();
    actuallyDyingIds.forEach(id => {
      batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(id), { alive: false });
      const p = players.find(pp => pp.id === id);
      if (p) p.alive = false;
    });
    await batch.commit();
    announcement = { type: 'night_death', names: Array.from(actuallyDyingIds).map(nameOf) };
  }

  await db.collection('werewolf_sessions').doc(sessionId).update({
    phase: 'day',
    nightStep: 'done',
    announcement: announcement,
    deathSeen: []
  });

  await checkAndApplyWinner(sessionId, players);
}

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

async function checkPlayer(sessionId, targetId) {
  const doc = await db.collection(`werewolf_sessions/${sessionId}/players`).doc(targetId).get();
  return doc.exists ? isWerewolf(doc.data().role) : null;
}

async function getWolfTarget(sessionId) {
  const doc = await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('chief_werewolf').get();
  return doc.exists ? doc.data().targetId : null;
}

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
