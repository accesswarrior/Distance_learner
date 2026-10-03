// js/werewolf/engine.js
// Session lifecycle: creating and joining Werewolf rooms.
// (esc(), generateRoomCode() and confirmAction() now live in js/core/ui-helpers.js.)
//
// Every player is recorded in TWO parallel documents, same uid, same
// collection depth, deliberately split by sensitivity:
//
//   players/{uid} (PRIVATE) -> { displayName, ready,
//     participationStatus, role?, alive?, healPotionUsed?, ... }
//   roster/{uid}  (PUBLIC)  -> { displayName, ready,
//     participationStatus, alive }
//
// Firestore security rules are NOT filters: a collection query is rejected
// outright unless its rule can be proven for every document the query
// could return. A regular player can only satisfy /players' read rule for
// their own document, so they must read players/{theirUid} directly and
// must never run a collection query on /players. Every screen that needs
// to show "who's in this game, who's alive, who can I vote for" reads from
// /roster, which is safe for anyone to read in full because it never
// contains role or potion/hunter state.
// /players stays the single source of truth for game logic (checkWinCondition,
// succession, etc.) and is only ever read in full by the moderator or by a
// role's own narrowly-scoped exception (the Seer's one-target check).
//
// Both documents are written together everywhere alive/ready/
// participationStatus changes, so they never drift apart — see
// syncRosterFields() below.
//
// participationStatus: 'active' | 'removed'. Missing = 'active'.
//   - active  : in the game. May be alive or dead.
//   - removed : no longer participating. Excluded from win conditions,
//               ack gates, vote counts, night target lists, and Chief
//               succession. Their doc is preserved as historical record.
//
// Removed ≠ dead. A disconnected player is neither. Only the moderator's
// explicit "Remove from game" action moves a player to 'removed'.

// Writes the given subset of fields (alive / ready / participationStatus)
// to the PUBLIC roster doc, mirroring what just changed on the PRIVATE
// player doc. Called alongside every players/{uid} write that touches one
// of those three fields, so the two documents never drift apart.
function syncRosterFields(sessionId, uid, fields, batch) {
  const ref = db.collection(`werewolf_sessions/${sessionId}/roster`).doc(uid);
  if (batch) {
    batch.set(ref, fields, { merge: true });
  }
  return ref;
}

// discussionTimerMinutes: null (no timer) or one of 3/4/5 — chosen once,
// at room creation, and applies to every day-discussion round. See
// ui.js's timer display and narrator.js's mention of it.
async function createSession(uid, discussionTimerMinutes) {
  let code;
  let attempts = 0;
  while (attempts < 5) {
    code = generateRoomCode();
    const existing = await db.collection('werewolf_sessions').doc(code).get();
    if (!existing.exists) break;
    attempts++;
  }

  await db.collection('werewolf_sessions').doc(code).set({
    moderatorId: uid,
    status: 'lobby',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    pendingPotionFlags: [],
    discussionTimerMinutes: discussionTimerMinutes || null
  });

  await setCurrentSession(uid, 'werewolf', code);
  return code;
}

async function joinSession(code, uid, displayName) {
  const sessionRef = db.collection('werewolf_sessions').doc(code);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    throw new Error("Room not found. Check the code and try again.");
  }

  const sessionData = sessionDoc.data();
  const isMod = sessionData.moderatorId === uid;

  if (!isMod) {
    const playerRef = sessionRef.collection('players').doc(uid);
    const existingPlayerDoc = await playerRef.get();

    if (sessionData.status !== 'lobby' && !existingPlayerDoc.exists) {
      throw new Error("This game has already started.");
    }

    if (!existingPlayerDoc.exists) {
      const batch = db.batch();
      batch.set(playerRef, {
        displayName: displayName,
        ready: false,
        participationStatus: 'active'
      });
      batch.set(sessionRef.collection('roster').doc(uid), {
        displayName: displayName,
        ready: false,
        participationStatus: 'active',
        alive: true
      });
      await batch.commit();
    }
  }

  await setCurrentSession(uid, 'werewolf', code);
  return isMod;
}

// Moderator: remove an active-game player. Preserves their doc (role,
// history) but excludes them from all future game calculations.
async function removePlayerFromGame(sessionId, uid) {
  const sessionRef = db.collection('werewolf_sessions').doc(sessionId);
  const playerRef = sessionRef.collection('players').doc(uid);
  const rosterRef = sessionRef.collection('roster').doc(uid);
  const [sessionSnap, playerSnap] = await Promise.all([sessionRef.get(), playerRef.get()]);
  if (!playerSnap.exists) return;

  const sessionData = sessionSnap.data() || {};
  const playerData = playerSnap.data() || {};
  if (playerData.participationStatus === 'removed') return;

  const batch = db.batch();
  batch.update(playerRef, { participationStatus: 'removed', alive: false });
  syncRosterFields(sessionId, uid, { participationStatus: 'removed', alive: false }, batch);

  // A removed participant must not leave behind a vote or a pending Hunter
  // state that can block the game.
  if (sessionData.votingOpen) {
    batch.delete(sessionRef.collection('votes').doc(uid));
  }
  if (sessionData.pendingHunterShot === uid) {
    batch.update(sessionRef, {
      pendingHunterShot: firebase.firestore.FieldValue.delete(),
      announcement: { type: 'hunter_skipped', hunterName: playerData.displayName || 'The Hunter' },
      deathSeen: []
    });
  }

  await batch.commit();

  // Removal has the same game-state consequences as death for succession
  // and win-condition purposes. In particular, removing the Chief must
  // immediately promote an eligible living Werewolf.
  const playersSnap = await sessionRef.collection('players').get();
  const players = [];
  playersSnap.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
  await checkAndApplyWinner(sessionId, players);
}

// Starts the game: the single dealing path used by BOTH the Start button
// (lobby.js startGame) and crash recovery (recoverStartingGame below).
//
// Caller has already flipped the session to status 'starting' (which makes
// joinSession refuse new joiners, closing the race with the roster read here).
// `moderatorUid` is excluded from the deal: the moderator never has a player doc.
//
// Returns { ok: true } or { ok: false, readyCount } when too few players are
// ready (the session is put back to 'lobby' in that case).
async function dealAndStart(sessionId, moderatorUid) {
  const sessionRef = db.collection('werewolf_sessions').doc(sessionId);
  const playersSnap = await sessionRef.collection('players').get();

  const readyPlayers = [];
  const notReadyIds = [];
  playersSnap.forEach(doc => {
    if (doc.id === moderatorUid) return;
    const p = { id: doc.id, ...doc.data() };
    if (p.ready) readyPlayers.push(p);
    else notReadyIds.push(p.id);
  });

  if (readyPlayers.length < READY_THRESHOLD) {
    await sessionRef.update({ status: 'lobby' });
    return { ok: false, readyCount: readyPlayers.length };
  }

  // If roles were already committed before a crash, don't deal a second set;
  // just finish the transition.
  const alreadyDealt = readyPlayers.every(p => !!p.role && p.alive !== undefined);
  if (alreadyDealt) {
    await sessionRef.update({ status: 'started', phase: 'day' });
    return { ok: true };
  }

  const deal = buildDeal(readyPlayers.map(p => p.id)); // rules.js
  const batch = db.batch();
  readyPlayers.forEach(p => {
    batch.update(sessionRef.collection('players').doc(p.id), deal.perPlayer[p.id]);
    syncRosterFields(sessionId, p.id, { alive: true, participationStatus: 'active' }, batch);
  });
  notReadyIds.forEach(uid => {
    batch.delete(sessionRef.collection('players').doc(uid));
    batch.delete(sessionRef.collection('roster').doc(uid));
  });
  // The Chief's (and any Werewolf's) own client reads this to exclude
  // teammates from a kill-target list — see firestore.rules for who else can
  // read it (nobody outside the werewolf side).
  batch.set(sessionRef.collection('secrets').doc('werewolfTeam'), { ids: deal.werewolfTeamIds });
  batch.set(sessionRef, { status: 'started', phase: 'day', roleComposition: deal.composition }, { merge: true });
  await batch.commit();
  return { ok: true };
}

// Recover a game that was left in 'starting' before the role-assignment
// batch committed. The moderator can safely call this after reconnecting.
async function recoverStartingGame(sessionId) {
  const sessionRef = db.collection('werewolf_sessions').doc(sessionId);
  const snap = await sessionRef.get();
  const data = snap.data() || {};
  if (data.status !== 'starting') return false;
  const result = await dealAndStart(sessionId, data.moderatorId);
  return result.ok;
}

// Moderator: Play Again. Players removed during the last round are dropped
// from the roster entirely. Everyone else is reset to a fresh lobby state
// and must re-ready.
async function resetSessionForRematch(sessionId) {
  const [playersSnap, votesSnap, nightSnap] = await Promise.all([
    db.collection(`werewolf_sessions/${sessionId}/players`).get(),
    db.collection(`werewolf_sessions/${sessionId}/votes`).get(),
    db.collection(`werewolf_sessions/${sessionId}/nightActions`).get()
  ]);

  const batch = db.batch();
  playersSnap.forEach(doc => {
    const data = doc.data();
    const rosterRef = db.collection(`werewolf_sessions/${sessionId}/roster`).doc(doc.id);
    if (data.participationStatus === 'removed') {
      batch.delete(doc.ref);
      batch.delete(rosterRef);
    } else {
      batch.update(doc.ref, {
        role: null,
        alive: true,
        ready: false,
        participationStatus: 'active',
        healPotionUsed: firebase.firestore.FieldValue.delete(),
        poisonPotionUsed: firebase.firestore.FieldValue.delete(),
        hunterShotUsed: firebase.firestore.FieldValue.delete()
      });
      batch.set(rosterRef, { alive: true, ready: false, participationStatus: 'active' }, { merge: true });
    }
  });
  votesSnap.forEach(doc => batch.delete(doc.ref));
  nightSnap.forEach(doc => batch.delete(doc.ref));
  batch.delete(db.collection(`werewolf_sessions/${sessionId}/secrets`).doc('werewolfTeam'));
  batch.set(db.collection('werewolf_sessions').doc(sessionId), {
    status: 'lobby',
    phase: firebase.firestore.FieldValue.delete(),
    nightStep: firebase.firestore.FieldValue.delete(),
    votingOpen: false,
    voteEligibleTargets: firebase.firestore.FieldValue.delete(),
    announcement: firebase.firestore.FieldValue.delete(),
    deathSeen: firebase.firestore.FieldValue.delete(),
    winner: firebase.firestore.FieldValue.delete(),
    pendingHunterShot: firebase.firestore.FieldValue.delete(),
    pendingWinRecheck: firebase.firestore.FieldValue.delete(),
    pendingPotionFlags: [],
    roleComposition: firebase.firestore.FieldValue.delete(),
    discussionTimerEndsAt: firebase.firestore.FieldValue.delete()
  }, { merge: true });
  await batch.commit();
}

// Pre-game only. Removes from the lobby roster entirely.
async function kickPlayer(sessionId, uid) {
  const batch = db.batch();
  batch.delete(db.collection(`werewolf_sessions/${sessionId}/players`).doc(uid));
  batch.delete(db.collection(`werewolf_sessions/${sessionId}/roster`).doc(uid));
  await batch.commit();
}
