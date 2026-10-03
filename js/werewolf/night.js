// js/werewolf/night.js
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
  if (data.votingOpen) return;           // never overlap voting and night
  if (data.pendingHunterShot) return;    // Hunter must resolve first

  const nightSnap = await db.collection(`werewolf_sessions/${sessionId}/nightActions`).get();
  const batch = db.batch();
  nightSnap.forEach(doc => batch.delete(doc.ref));
  // Clear the previous day's announcement + ack list. Otherwise the stale
  // announcement keeps ui.js's ack gate ("Waiting for everyone else to see
  // this...") switched on all night, which sits ABOVE the night-action UI
  // in the player render chain and would block every night action after
  // the first night.
  batch.update(db.collection('werewolf_sessions').doc(sessionId), {
    phase: 'night',
    nightStep: NIGHT_ROLE_ORDER[0],
    announcement: firebase.firestore.FieldValue.delete(),
    deathSeen: [],
    discussionTimerEndsAt: firebase.firestore.FieldValue.delete()
  });
  await batch.commit();
}

async function advanceNight(sessionId, currentStep) {
  const snap = await db.collection('werewolf_sessions').doc(sessionId).get();
  const data = snap.data() || {};
  if (data.phase !== 'night') return;
  if (data.nightStep !== currentStep) return; // reject stale moderator buttons
  if (data.nightStep === 'done') return;

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
    return p ? (p.displayName) : 'Unknown';
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
      batch.update(db.collection(`werewolf_sessions/${sessionId}/roster`).doc(id), { alive: false });
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

// Returns true if the write landed, false if it was rejected (so the UI
// doesn't show "locked in" for a choice that was never recorded).
async function submitNightAction(sessionId, role, targetId) {
  try {
    await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc(role).set({
      targetId: targetId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (err) {
    console.warn('Night action rejected by security rules:', err);
    alert('That choice could not be recorded — the night step may have already moved on.');
    return false;
  }
}

async function markSeerDone(sessionId) {
  try {
    await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('seer').set({
      done: true,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (err) {
    console.warn('Could not mark Seer step done:', err);
    return false;
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

// Consumed ONLY by the moderator's client (see ui.js's session listener).
// The Witch can't write her own player doc beyond `ready`, so her potion
// use is queued as { witchUid, flag, at } entries in the session doc's
// pendingPotionFlags array (submitWitchAction below adds to it). The
// moderator applies each flag to the Witch's actual player doc under her
// own full write authority, then clears the queue.
async function applyPendingPotionFlags(sessionId, flags) {
  if (!flags || !flags.length) return;
  const batch = db.batch();
  const seen = new Set(); // avoid redundant writes if a flag got queued twice
  flags.forEach(entry => {
    const key = entry.witchUid + ':' + entry.flag;
    if (seen.has(key)) return;
    seen.add(key);
    batch.update(db.collection(`werewolf_sessions/${sessionId}/players`).doc(entry.witchUid), {
      [entry.flag]: true
    });
  });
  batch.update(db.collection('werewolf_sessions').doc(sessionId), { pendingPotionFlags: [] });
  await batch.commit();
}

// Returns true only if BOTH writes land. The second write (queuing the
// potion-used flag for the moderator to apply — see applyPendingPotionFlags)
// used to be fire-and-forget: if it failed while the first write succeeded,
// her nightActions/witch doc would still resolve the potion's effect at
// endNight, but healPotionUsed/poisonPotionUsed would never actually get
// set — leaving the button enabled again next night and letting her use
// the "same" potion twice. Both writes are awaited now, and the caller
// (ui.js) only marks her choice as locked in when this returns true.
async function submitWitchAction(sessionId, witchUid, action, targetId) {
  const write = { action: action, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
  if (action === 'poison') write.targetId = targetId;

  try {
    await db.collection(`werewolf_sessions/${sessionId}/nightActions`).doc('witch').set(write);

    if (action === 'save' || action === 'poison') {
      const entry = {
        witchUid: witchUid,
        flag: action === 'save' ? 'healPotionUsed' : 'poisonPotionUsed',
        at: Date.now()
      };
      await db.collection('werewolf_sessions').doc(sessionId)
        .update({ pendingPotionFlags: firebase.firestore.FieldValue.arrayUnion(entry) });
    }
    return true;
  } catch (err) {
    console.warn('Witch action rejected or incomplete:', err);
    alert('That choice could not be recorded — the night step may have already moved on.');
    return false;
  }
}
