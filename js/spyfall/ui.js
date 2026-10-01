// js/spyfall/ui.js
// The game screen: dealing, discussing, voting, spy guess, scored.
//
// Re-rendering rules (learned the hard way):
//   * The screen is rebuilt only when DATA changes (a snapshot arrives),
//     never on the 1-second timer. The timer only rewrites the clock text,
//     otherwise an open <select> or <details> would snap shut every second.
//   * Rebuilds keep the spy's half-chosen guess and which <details> are open.
//   * Who the operator is CHANGES every round, so the votes listener is
//     re-chosen whenever it changes (operator listens to all ballots,
//     everyone else only to their own — the rules allow nothing else).

let spyfallGameUnsubs = [];
let spyfallVotesUnsub = null;
let spyfallRoundUnsub = null;
let spyfallTimerHandle = null;

function clearSpyfallGameListeners() {
  spyfallGameUnsubs.forEach(u => u());
  spyfallGameUnsubs = [];
  if (spyfallVotesUnsub) { spyfallVotesUnsub(); spyfallVotesUnsub = null; }
  if (spyfallRoundUnsub) { spyfallRoundUnsub(); spyfallRoundUnsub = null; }
  if (spyfallTimerHandle) { clearInterval(spyfallTimerHandle); spyfallTimerHandle = null; }
}

function renderSpyfallGame(sessionId, uid) {
  clearSpyfallGameListeners();
  clearSpyfallLobbyListeners();   // lobby.js
  showScreen('game-screen');

  let session = {};
  let players = [];
  let myPrivate = {};
  let myVote = null;       // my own ballot (non-operators)
  let voteCount = 0;       // ballots in (operator)
  let votesMode = null;    // 'all' | 'own' — which votes listener is attached
  let roundListenerFor = null;
  let lastResult = null;   // rounds/{currentRound}, public once scored
  let cardVisible = false; // is my card showing on screen right now?
  let lastRound = null;
  let advanceKey = null;
  const advancing = new Set();

  // ---------- helpers ----------
  const me = () => players.find(p => p.id === uid);
  const isOperator = () => session.operatorId === uid;
  const participants = () => players.filter(p => p.inCurrentRound && p.active !== false && p.id !== session.operatorId);
  const iAmParticipant = () => !!(me() && me().inCurrentRound) && !isOperator();
  const nameOf = (id) => { const p = players.find(x => x.id === id); return p ? (p.displayName || 'Player') : 'Someone'; };
  // Ignore a card left over from an earlier round if snapshots arrive out of order.
  const myCardValid = () => myPrivate.role && myPrivate.roundNumber === session.currentRound;
  const timeLeft = (endsAt) => endsAt ? Math.max(0, Math.floor((endsAt - Date.now()) / 1000)) : null;
  const fmtTime = (s) => s == null ? '--:--' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const locationList = () => `<details class="sf-details"><summary>📋 Location list</summary><ul class="player-list">
      ${SPYFALL_LOCATIONS.map(l => `<li>${esc(l)}</li>`).join('')}</ul></details>`;

  function cardHtml() {
    if (!myCardValid()) return `<p class="hint-text">Dealing your card…</p>`;
    if (myPrivate.role === 'spy') {
      return `<div class="sf-card sf-spy"><h2>You are the SPY</h2>
        <p>Blend in. Ask questions that sound like you know the place.</p></div>`;
    }
    return `<div class="sf-card sf-agent"><h2>You are an AGENT</h2><p>The location is:</p>
      <p class="sf-location">${esc(myPrivate.location || '')}</p></div>`;
  }

  function peekHtml() {
    if (!myCardValid()) return '';
    return cardVisible
      ? `${cardHtml()}<button id="sf-hide-btn" class="secondary-btn">Hide my card</button>`
      : `<button id="sf-peek-btn" class="secondary-btn">👁 Check my card</button>`;
  }

  // ---------- operator automation ----------
  // Runs on every data change and every timer tick, but only does anything
  // on the operator's phone, and at most once per (round, state, step).
  function autoAdvance() {
    if (!isOperator() || session.status !== 'playing') return;

    const key = `${session.currentRound}:${session.roundState}`;
    if (key !== advanceKey) { advanceKey = key; advancing.clear(); }
    const once = (step, fn) => {
      if (advancing.has(step)) return;
      advancing.add(step);
      Promise.resolve().then(fn).catch(err => {
        console.error(`Spyfall step "${step}" failed:`, err);
        advancing.delete(step);   // allow a retry on the next tick
      });
    };

    if (session.roundState === 'dealing') {
      const seen = session.seenCardUids || [];
      const expected = participants().map(p => p.id);
      if (expected.length > 0 && expected.every(id => seen.includes(id))) {
        once('discuss', () => beginSpyfallDiscussion(sessionId));
      }
    } else if (session.roundState === 'discussing') {
      const left = timeLeft(session.discussionEndsAt);
      if (session.voteRequestedBy) {
        once('open-vote', () => openSpyfallVoting(sessionId, session.voteRequestedBy));
      } else if (left !== null && left <= 0) {
        // Time's up: the room must vote.
        once('open-vote', () => openSpyfallVoting(sessionId, session.operatorId));
      }
    } else if (session.roundState === 'voting') {
      const left = timeLeft(session.votingEndsAt);
      const expected = participants().length;
      if ((left !== null && left <= 0) || (expected > 0 && voteCount >= expected)) {
        once('close-vote', () => closeSpyfallVoting(sessionId));
      }
    } else if (session.roundState === 'guess') {
      const left = timeLeft(session.guessEndsAt);
      if (session.spyGuess !== undefined || (left !== null && left <= 0)) {
        once('resolve-guess', () => finishSpyfallRound(sessionId, { from: 'guess' }));
      }
    }
  }

  // ---------- views ----------
  function buildView() {
    const op = isOperator();
    const part = iAmParticipant();
    const state = session.roundState || 'idle';
    const opName = nameOf(session.operatorId);
    const header = `<div class="sf-header">${
      state === 'idle' ? `Next: round ${(session.currentRound || 0) + 1}` : `Round ${session.currentRound}`
    } · Operator: ${esc(opName)}${op ? ' (you)' : ''}</div>`;

    if (state === 'idle') {
      if (op) {
        return `${header}
          <p>You run this round and sit it out. Everyone else will get a card on their phone.</p>
          <button id="sf-deal-btn" class="primary-btn">Deal Round ${(session.currentRound || 0) + 1}</button>
          <p id="sf-deal-error" class="error-message"></p>`;
      }
      return `${header}<p class="hint-text sf-waiting">Waiting for ${esc(opName)} to deal…</p>`;
    }

    if (state === 'dealing') {
      const seen = session.seenCardUids || [];
      if (op) {
        const expected = participants().map(p => p.id);
        return `${header}<p>Waiting for players to see their cards…</p>
          <p class="hint-text">${seen.filter(id => expected.includes(id)).length} of ${expected.length} ready</p>
          <button id="sf-force-btn" class="secondary-btn">Start Discussion Anyway</button>`;
      }
      if (!part) return `${header}<p>You're sitting out this round.</p>`;
      if (seen.includes(uid)) {
        return `${header}<p>Card hidden. Waiting for the others…</p>${peekHtml()}`;
      }
      if (!cardVisible) {
        return `${header}<div class="sf-card-back"><div>
          <div class="sf-card-emoji">🎴</div><p>Make sure nobody can see your screen</p>
          <button id="sf-reveal-btn" class="primary-btn">Reveal my card</button></div></div>`;
      }
      return `${header}${cardHtml()}${locationList()}
        <button id="sf-gotit-btn" class="primary-btn">Got it — hide my card</button>`;
    }

    if (state === 'discussing') {
      let html = `${header}<div class="sf-timer" data-timer="discussionEndsAt">${fmtTime(timeLeft(session.discussionEndsAt))}</div>`;
      if (op) {
        html += `<p class="hint-text">Players can call a vote at any time. It opens automatically when the time runs out.</p>`;
      } else if (part) {
        html += `<p class="hint-text">Talk it out. Any player can ask for a vote.</p>`;
        html += session.voteRequestedBy
          ? `<p class="hint-text">A vote has been requested — opening…</p>`
          : `<button id="sf-callvote-btn" class="primary-btn">Call Vote</button>`;
        html += peekHtml();
      } else {
        html += `<p>You're sitting out this round.</p>`;
      }
      return html + locationList();
    }

    if (state === 'voting') {
      let html = `${header}<div class="sf-timer" data-timer="votingEndsAt">${fmtTime(timeLeft(session.votingEndsAt))}</div>
        <h2>Who is the spy?</h2>`;
      if (part) {
        html += `<ul class="player-list">` + participants().filter(p => p.id !== uid).map(p => {
          const sel = myVote === p.id;
          return `<li><button class="sf-vote-btn secondary-btn${sel ? ' selected' : ''}" data-uid="${esc(p.id)}">${esc(p.displayName || 'Player')}${sel ? ' ✔️' : ''}</button></li>`;
        }).join('') + `</ul>`;
        html += myVote ? `<p class="hint-text">Your vote is in. Tap another to change it.</p>` : '';
        html += peekHtml();
      } else if (op) {
        html += `<p class="hint-text">${voteCount} of ${participants().length} votes in. You don't vote — you're the operator.</p>`;
      } else {
        html += `<p>You're sitting out this round.</p>`;
      }
      return html;
    }

    if (state === 'guess') {
      const iAmSpy = myCardValid() && myPrivate.role === 'spy';
      let html = `${header}<div class="sf-timer-small" data-timer="guessEndsAt">${fmtTime(timeLeft(session.guessEndsAt))}</div>`;
      if (iAmSpy) {
        const submitted = session.spyGuess !== undefined;
        html += `<div class="sf-card sf-spy"><h2>You've been caught!</h2>
          <p>Name the location to steal the win.</p>
          <select id="sf-guess-select"${submitted ? ' disabled' : ''}>
            <option value="">-- pick the location --</option>
            ${SPYFALL_LOCATIONS.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}
          </select>
          <button id="sf-guess-btn" class="primary-btn"${submitted ? ' disabled' : ''}>${submitted ? 'Guess submitted' : 'Submit Guess'}</button>
          </div>`;
      } else {
        html += `<p>The spy has been caught and is guessing the location…</p>`;
      }
      return html;
    }

    if (state === 'scored') {
      if (!lastResult) return `${header}<p class="hint-text">Loading result…</p>`;
      const r = lastResult;
      const spy = nameOf(r.spyId);
      let headline, detail;
      if (!r.spyCaught) {
        headline = `<div class="sf-reveal-spy">🕵️ The spy wins!</div>`;
        detail = r.voteWasTied ? 'The vote was tied.'
          : r.accusationTargetId ? `${esc(nameOf(r.accusationTargetId))} was accused, but wasn't the spy.`
          : 'Nobody was accused.';
      } else if (r.spyGuessCorrect) {
        headline = `<div class="sf-reveal-spy">🕵️ The spy wins!</div>`;
        detail = `${esc(spy)} was caught but named the location: <em>${esc(r.spyGuess)}</em>.`;
      } else {
        headline = `<div class="sf-reveal-agents">🏆 The agents win!</div>`;
        detail = r.spyGuess
          ? `${esc(spy)} was caught and guessed <em>${esc(r.spyGuess)}</em> — wrong.`
          : `${esc(spy)} was caught and didn't guess in time.`;
      }
      let html = `${header}${headline}<p>${detail}</p>
        <p>The spy was <strong>${esc(spy)}</strong>. The location was <strong>${esc(r.locationId)}</strong>.</p>
        <h3>Scoreboard</h3><ul class="player-list">`;
      [...players].sort((a, b) => (b.score || 0) - (a.score || 0)).forEach(p => {
        const gain = (r.scores && r.scores[p.id]) || 0;
        html += `<li><span>${esc(p.displayName || 'Player')}${gain ? ` <small>+${gain}</small>` : ''}</span><span>${p.score || 0}</span></li>`;
      });
      html += `</ul>`;
      html += op
        ? `<button id="sf-next-btn" class="primary-btn">Next Round</button>`
        : `<p class="hint-text sf-waiting">Waiting for ${esc(opName)} to start the next round…</p>`;
      return html;
    }

    return `${header}<p>Loading…</p>`;
  }

  function render() {
    const el = document.getElementById('game-content');
    if (!el || !session.status || session.status === 'lobby') return;

    if (session.currentRound !== lastRound) { lastRound = session.currentRound; cardVisible = false; }

    // Keep what the player is in the middle of across the rebuild.
    const openDetails = [...el.querySelectorAll('details')].map(d => d.open);
    const guessEl = el.querySelector('#sf-guess-select');
    const guessValue = guessEl ? guessEl.value : '';

    el.innerHTML = buildView() +
      `<div class="sf-footer"><a class="link-btn secondary-btn" href="../hub.html">← All games</a>
       <button class="logout-btn secondary-btn">Log out</button></div>`;

    el.querySelectorAll('details').forEach((d, i) => { if (openDetails[i]) d.open = true; });
    const newGuessEl = el.querySelector('#sf-guess-select');
    if (newGuessEl && guessValue && !newGuessEl.disabled) newGuessEl.value = guessValue;

    wire(el);
  }

  function wire(el) {
    const on = (sel, fn) => { const n = el.querySelector(sel); if (n) n.addEventListener('click', fn); };

    on('#sf-deal-btn', async (e) => {
      e.target.disabled = true;
      try { await dealSpyfallRound(sessionId); }
      catch (err) {
        e.target.disabled = false;
        const out = document.getElementById('sf-deal-error');
        if (out) out.textContent = err.message || "Couldn't deal.";
      }
    });
    on('#sf-force-btn', () => beginSpyfallDiscussion(sessionId));
    on('#sf-reveal-btn', () => { cardVisible = true; render(); });
    on('#sf-gotit-btn', async () => {
      cardVisible = false;
      try { await markSpyfallCardSeen(sessionId, uid); }
      catch (err) { console.warn('Could not record seen card:', err); }
      render();
    });
    on('#sf-peek-btn', () => { cardVisible = true; render(); });
    on('#sf-hide-btn', () => { cardVisible = false; render(); });
    on('#sf-callvote-btn', async () => {
      const ok = await confirmAction({
        title: 'Call a vote?',
        message: 'This asks the operator to open voting for everyone. It cannot be undone.',
        confirmLabel: 'Call Vote'
      });
      if (ok) requestSpyfallVote(sessionId, uid).catch(err => console.warn('Vote request failed:', err));
    });
    el.querySelectorAll('.sf-vote-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetId = btn.dataset.uid;
        const ok = await confirmAction({
          title: `Vote for ${nameOf(targetId)}?`,
          message: 'You can change your vote any time before voting closes.',
          confirmLabel: 'Vote'
        });
        if (ok) submitSpyfallVote(sessionId, uid, targetId).catch(err => console.warn('Vote failed:', err));
      });
    });
    on('#sf-guess-btn', async () => {
      const sel = el.querySelector('#sf-guess-select');
      if (!sel || !sel.value) { alert('Pick a location.'); return; }
      try { await submitSpyfallGuess(sessionId, sel.value); }
      catch (err) { console.warn('Guess failed:', err); }
    });
    on('#sf-next-btn', (e) => { e.target.disabled = true; nextSpyfallRound(sessionId).catch(err => { e.target.disabled = false; console.error(err); }); });
  }

  function afterChange() { render(); autoAdvance(); }

  // ---------- listeners that depend on current data ----------
  function syncVotesListener() {
    const want = isOperator() ? 'all' : 'own';
    if (votesMode === want) return;
    if (spyfallVotesUnsub) { spyfallVotesUnsub(); spyfallVotesUnsub = null; }
    votesMode = want;
    voteCount = 0;
    myVote = null;
    const col = db.collection(`spyfall_sessions/${sessionId}/votes`);
    const onErr = (err) => console.warn('Votes listener error:', err);
    spyfallVotesUnsub = want === 'all'
      ? col.onSnapshot(snap => { voteCount = snap.size; afterChange(); }, onErr)
      : col.doc(uid).onSnapshot(doc => { myVote = doc.exists ? doc.data().targetId : null; afterChange(); }, onErr);
  }

  function syncRoundListener() {
    const n = session.currentRound;
    if (!n || roundListenerFor === n) return;
    if (spyfallRoundUnsub) { spyfallRoundUnsub(); spyfallRoundUnsub = null; }
    roundListenerFor = n;
    lastResult = null;
    spyfallRoundUnsub = db.collection(`spyfall_sessions/${sessionId}/rounds`).doc(String(n)).onSnapshot(
      doc => { lastResult = doc.exists ? doc.data() : null; afterChange(); },
      err => console.warn('Round listener error:', err)
    );
  }

  // ---------- listeners ----------
  spyfallGameUnsubs.push(
    db.collection('spyfall_sessions').doc(sessionId).onSnapshot(doc => {
      if (!doc.exists) {
        clearSpyfallGameListeners();
        clearCurrentSession(uid, 'spyfall').catch(() => {});
        showScreen('lobby-choice-screen');
        return;
      }
      session = doc.data() || {};
      if (session.status === 'lobby') {
        renderSpyfallLobby(sessionId, uid);
        return;
      }
      syncVotesListener();
      syncRoundListener();
      afterChange();
    })
  );

  spyfallGameUnsubs.push(
    db.collection(`spyfall_sessions/${sessionId}/players`).onSnapshot(snap => {
      players = [];
      snap.forEach(d => players.push({ id: d.id, ...d.data() }));
      afterChange();
    })
  );

  spyfallGameUnsubs.push(
    db.collection(`spyfall_sessions/${sessionId}/privatePlayers`).doc(uid).onSnapshot(doc => {
      myPrivate = doc.exists ? doc.data() : {};
      afterChange();
    }, err => console.warn('Private card listener error:', err))
  );

  // Clock: rewrite the countdown text only, and let the operator's automation tick.
  spyfallTimerHandle = setInterval(() => {
    autoAdvance();
    document.querySelectorAll('[data-timer]').forEach(n => {
      n.textContent = fmtTime(timeLeft(session[n.dataset.timer]));
    });
  }, 1000);
}
