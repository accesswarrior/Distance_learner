// tests/run.js — end-to-end check of the pages against an in-memory Firebase stand-in.
// Usage: cd tests && npm install && npm test   (optionally: node run.js <path-to-site-root>)
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const stub = fs.readFileSync(path.join(__dirname, 'firebase-stub.js'));
const NAV = '\nnavigateTo = function (u) { window.__nav.push(u); };\n';
class Loader extends ResourceLoader {
  fetch(url, o) {
    if (url.includes('gstatic.com/firebasejs')) return Promise.resolve(url.includes('app-compat') ? stub : Buffer.from(''));
    const p = super.fetch(url.split('?')[0], o);
    return url.endsWith('/js/core/auth.js') ? p.then(b => Buffer.concat([b, Buffer.from(NAV)])) : p;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '   -> ' + JSON.stringify(extra))); };

async function open(page, { query = '', seedUser, googleMode, redirectError } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail && e.detail.message || e.message)));
  const dom = await JSDOM.fromFile(path.join(ROOT, page), {
    url: 'file://' + path.join(ROOT, page) + query, runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.__nav = []; w.__seedUser = seedUser; w.__googleMode = googleMode; w.__redirectError = redirectError; w.addEventListener('error', e => errors.push('window error: ' + e.message)); }
  });
  await sleep(350);
  const w = dom.window, d = w.document;
  return { w, d, errors, active: () => [...d.querySelectorAll('.screen.active')].map(s => s.id).join(','),
    set: (id, v) => { d.getElementById(id).value = v; },
    submit: async id => { d.getElementById(id).dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await sleep(250); },
    click: async el => { (typeof el === 'string' ? d.getElementById(el) : el).click(); await sleep(250); },
    text: id => d.getElementById(id).textContent,
    doc: p => w.__stub.store.get(p), nav: () => w.__nav };
}

(async () => {
  // ---------------- LOGIN PAGE ----------------
  console.log('Login page (index.html)');
  let t = await open('index.html', { query: '?next=games/spyfall.html' });
  check('signed-out visitor sees the login form', t.active() === 'auth-screen', t.active());
  check('link to sign-up carries ?next', t.d.getElementById('other-page-link').getAttribute('href') === 'signup.html?next=games%2Fspyfall.html', t.d.getElementById('other-page-link').getAttribute('href'));
  t.set('email', 'nobody@x.com'); t.set('password', 'whatever1'); await t.submit('login-form');
  check('unknown email -> generic message', t.text('auth-error') === 'Incorrect email or password.', t.text('auth-error'));
  t.set('email', 'not-an-email'); await t.submit('login-form');
  check('malformed email rejected', /valid email/.test(t.text('auth-error')), t.text('auth-error'));
  await t.click('forgot-link');
  t.set('email', ''); await t.click('forgot-link');
  check('forgot password needs an email first', /Type your email/.test(t.text('auth-error')), t.text('auth-error'));
  t.set('email', 'nobody@x.com'); await t.click('forgot-link');
  check('forgot password: same message for unknown email', /If an account exists/.test(t.text('auth-info')) && t.text('auth-error') === '', [t.text('auth-info'), t.text('auth-error')]);
  check('no console errors', t.errors.length === 0, t.errors);

  // ---------------- SIGN-UP PAGE ----------------
  console.log('Sign-up page (signup.html)');
  t = await open('signup.html', { query: '?next=games/werewolf.html' });
  check('shows the sign-up form', t.active() === 'auth-screen', t.active());
  check('link to login carries ?next', t.d.getElementById('other-page-link').getAttribute('href') === 'index.html?next=games%2Fwerewolf.html', t.d.getElementById('other-page-link').getAttribute('href'));
  const f = (n, e, p, c) => { t.set('display-name', n); t.set('email', e); t.set('password', p); t.set('confirm-password', c); };
  f('', 'ann@x.com', 'password1', 'password1'); await t.submit('signup-form');
  check('missing display name', /display name/.test(t.text('auth-error')), t.text('auth-error'));
  f('Ann', 'ann@', 'password1', 'password1'); await t.submit('signup-form');
  check('bad email', /valid email/.test(t.text('auth-error')), t.text('auth-error'));
  f('Ann', 'ann@x.com', 'short', 'short'); await t.submit('signup-form');
  check('short password', /at least 8/.test(t.text('auth-error')), t.text('auth-error'));
  f('Ann', 'ann@x.com', 'password1', 'password2'); await t.submit('signup-form');
  check('passwords must match', /don't match/.test(t.text('auth-error')), t.text('auth-error'));
  f('A'.repeat(30), 'ann@x.com', 'password1', 'password1'); await t.submit('signup-form');
  check('display name length capped at 24', /at most 24/.test(t.text('auth-error')), t.text('auth-error'));
  check('nothing created by failed attempts', t.w.__stub.accounts.size === 0 && t.nav().length === 0, [t.w.__stub.accounts.size, t.nav()]);
  f('  Ann   T. ', 'Ann@X.com ', 'password1', 'password1'); await t.submit('signup-form');
  check('sign-up succeeds, email normalised', t.w.__stub.accounts.has('ann@x.com'), [...t.w.__stub.accounts.keys()]);
  const u1 = t.doc('users/uid_1');
  check('account doc: only displayName+createdAt, name cleaned', u1 && Object.keys(u1).sort().join() === 'createdAt,displayName' && u1.displayName === 'Ann T.', u1);
  check('no email stored in the account doc', !JSON.stringify(u1).includes('@'), u1);
  check('redirects to the ?next page after sign-up', JSON.stringify(t.nav()) === '["games/werewolf.html"]', t.nav());
  check('no console errors', t.errors.length === 0, t.errors);

  // duplicate
  t = await open('signup.html');
  t.w.__stub.accounts.set('dup@x.com', { password: 'password1', uid: 'uid_9' });
  t.set('display-name', 'Dup'); t.set('email', 'dup@x.com'); t.set('password', 'password1'); t.set('confirm-password', 'password1'); await t.submit('signup-form');
  check('duplicate email -> friendly message, button re-enabled', /already exists/.test(t.text('auth-error')) && !t.d.getElementById('signup-btn').disabled, t.text('auth-error'));

  // ---------------- LOGIN success ----------------
  console.log('Login with email');
  t = await open('index.html');
  t.w.__stub.accounts.set('ann@x.com', { password: 'password1', uid: 'uid_1' });
  t.set('email', 'ann@x.com'); t.set('password', 'wrongpass1'); await t.submit('login-form');
  check('wrong password -> same generic message', t.text('auth-error') === 'Incorrect email or password.', t.text('auth-error'));
  t.set('password', 'password1'); await t.submit('login-form');
  check('correct login -> hub', JSON.stringify(t.nav()) === '["hub.html"]', t.nav());
  t.set('email', 'ann@x.com'); await t.click('forgot-link');
  check('reset email requested for a real account', JSON.stringify(t.w.__stub.log.resets) === '["ann@x.com"]', t.w.__stub.log.resets);

  // already signed in
  t = await open('index.html', { seedUser: { email: 'ann@x.com', uid: 'uid_1', displayName: 'Ann' } });
  check('already signed in -> straight to hub', JSON.stringify(t.nav()) === '["hub.html"]', t.nav());

  // ---------------- GOOGLE ----------------
  console.log('Google sign-in');
  t = await open('index.html', { query: '?next=hub.html', googleMode: 'ok' });
  await t.click('google-btn');
  check('popup success -> redirect to ?next', JSON.stringify(t.nav()) === '["hub.html"]', t.nav());
  check('no account doc yet (hub creates it)', t.doc('users/g_gina') === undefined);
  t = await open('signup.html', { googleMode: 'closed' });
  await t.click('google-btn');
  check('closing the popup is silent', t.text('auth-error') === '' && t.nav().length === 0 && !t.d.getElementById('google-btn').disabled, [t.text('auth-error'), t.nav()]);
  t = await open('index.html', { googleMode: 'blocked' });
  await t.click('google-btn');
  check('blocked popup falls back to redirect', t.w.__stub.log.redirects === 1, t.w.__stub.log.redirects);
  t = await open('index.html', { googleMode: 'error:auth/account-exists-with-different-credential' });
  await t.click('google-btn');
  check('same email already has a password -> clear message', /registered with a password/.test(t.text('auth-error')), t.text('auth-error'));
  t = await open('index.html', { redirectError: 'auth/unauthorized-domain' });
  check('failed redirect shows its error on return', /isn't authorised/.test(t.text('auth-error')) && t.active() === 'auth-screen', [t.text('auth-error'), t.active()]);

  // ---------------- HUB ----------------
  console.log('Hub (hub.html)');
  t = await open('hub.html');
  check('signed out -> sent to login with ?next=hub.html', JSON.stringify(t.nav()) === '["index.html?next=hub.html"]', t.nav());
  t = await open('hub.html', { seedUser: { email: 'gina@gmail.com', uid: 'g_gina', displayName: 'Gina Google' } });
  check('first Google visit creates the account doc from the Google name', t.doc('users/g_gina') && t.doc('users/g_gina').displayName === 'Gina Google', t.doc('users/g_gina'));
  check('hub greets by display name', t.text('hub-name') === 'Gina Google' && t.active() === 'hub-screen', [t.text('hub-name'), t.active()]);
  await t.click('edit-name-link');
  check('edit form opens pre-filled', t.d.getElementById('name-form').style.display === 'block' && t.d.getElementById('name-input').value === 'Gina Google');
  t.set('name-input', '   '); await t.submit('name-form');
  check('blank name rejected', /display name/.test(t.text('name-error')), t.text('name-error'));
  t.set('name-input', 'Gina G'); await t.submit('name-form');
  check('name saved to account doc + shown', t.doc('users/g_gina').displayName === 'Gina G' && t.text('hub-name') === 'Gina G', [t.doc('users/g_gina'), t.text('hub-name')]);
  check('no console errors', t.errors.length === 0, t.errors);

  // ---------------- WEREWOLF PAGE ----------------
  console.log('Werewolf page');
  t = await open('games/werewolf.html', { seedUser: { email: 'ann@x.com', uid: 'uid_1', displayName: 'Ann T.' } });
  check('signed-in player reaches room choice with their name', t.active() === 'lobby-choice-screen' && t.text('welcome-username') === 'Ann T.', [t.active(), t.text('welcome-username')]);
  check('profile doc created if missing', t.doc('users/uid_1') && t.doc('users/uid_1').displayName === 'Ann T.', t.doc('users/uid_1'));
  t.d.getElementById('timer-select').value = '4'; await t.click('create-room-btn');
  check('create room -> lobby', t.active() === 'lobby-screen', t.active());
  const code = [...t.w.__stub.store.keys()].find(k => /^werewolf_sessions\/[^/]+$/.test(k)).split('/')[1];
  const ses = t.doc('werewolf_sessions/' + code);
  check('session created for this moderator', ses.moderatorId === 'uid_1' && ses.status === 'lobby' && ses.discussionTimerMinutes === 4, ses);
  check('room pointer stored as users.currentSessions.werewolf', t.doc('users/uid_1').currentSessions && t.doc('users/uid_1').currentSessions.werewolf === code, t.doc('users/uid_1'));
  check('account doc keys are rule-legal', Object.keys(t.doc('users/uid_1')).every(k => ['displayName', 'createdAt', 'currentSessions'].includes(k)), t.doc('users/uid_1'));
  // another player joins via the real joinSession()
  await t.w.eval(`db.collection('users').doc('uid_2').set({ displayName: 'Bo', createdAt: 1 })`);
  await t.w.eval(`joinSession('${code}', 'uid_2', 'Bo')`);
  const pd = t.doc(`werewolf_sessions/${code}/players/uid_2`), rd = t.doc(`werewolf_sessions/${code}/roster/uid_2`);
  check('joiner docs have displayName and no username', pd.displayName === 'Bo' && rd.displayName === 'Bo' && !('username' in pd) && !('username' in rd) && rd.alive === true, [pd, rd]);
  check('joiner room pointer set', t.doc('users/uid_2').currentSessions.werewolf === code, t.doc('users/uid_2'));
  check('lobby lists the joiner by display name', /Bo/.test(t.d.getElementById('lobby-content').textContent), t.d.getElementById('lobby-content').textContent.slice(0, 200));
  check('no console errors', t.errors.length === 0, t.errors);

  // start a full 8-player game through real code
  for (let i = 3; i <= 9; i++) {
    await t.w.eval(`db.collection('users').doc('uid_${i}').set({ displayName: 'P${i}', createdAt: 1 })`);
    await t.w.eval(`joinSession('${code}', 'uid_${i}', 'P${i}')`);
  }
  for (let i = 2; i <= 9; i++) {
    await t.w.eval(`db.collection('werewolf_sessions/${code}/players').doc('uid_${i}').update({ready:true})`);
    await t.w.eval(`db.collection('werewolf_sessions/${code}/roster').doc('uid_${i}').update({ready:true})`);
  }
  await sleep(200);
  await t.click('start-btn'); await t.click(t.d.querySelector('.modal-confirm')); await sleep(500);
  check('Start Game works: game screen + roles dealt', t.active() === 'role-screen' && t.doc('werewolf_sessions/' + code).status === 'started', [t.active(), t.doc('werewolf_sessions/' + code).status]);
  check('moderator sees the narrator + role list with display names', /P3|Bo/.test(t.d.getElementById('role-content').textContent) && !!t.d.querySelector('.narrator-box'), '');
  check('no console errors after start', t.errors.length === 0, t.errors);
  // resume: reload the page as the moderator -> back in the game
  const t2 = await open('games/werewolf.html', { seedUser: { email: 'ann@x.com', uid: 'uid_1', displayName: 'Ann T.' } });
  // (fresh stub has no data, so only check it falls back cleanly to room choice)
  check('fresh load with no room -> room choice, no errors', t2.active() === 'lobby-choice-screen' && t2.errors.length === 0, [t2.active(), t2.errors]);

  // ---------------- SPYFALL PAGE ----------------
  console.log('Spyfall page');
  t = await open('games/spyfall.html', { seedUser: { email: 'ann@x.com', uid: 'uid_1', displayName: 'Ann T.' } });
  check('room choice with display name', t.active() === 'lobby-choice-screen' && t.text('welcome-username') === 'Ann T.', [t.active(), t.text('welcome-username')]);
  await t.click('create-room-btn');
  const scode = [...t.w.__stub.store.keys()].find(k => /^spyfall_sessions\/[^/]+$/.test(k)).split('/')[1];
  check('Spyfall session created, host in players, pointer under spyfall', t.doc(`spyfall_sessions/${scode}/players/uid_1`).displayName === 'Ann T.' && t.doc('users/uid_1').currentSessions.spyfall === scode, [t.doc(`spyfall_sessions/${scode}/players/uid_1`), t.doc('users/uid_1')]);
  check('lobby shown', /lobby/.test(t.active()), t.active());
  check('no console errors', t.errors.length === 0, t.errors);


  // ---------------- PASSWORD UI ----------------
  console.log('Password UI');
  t = await open('signup.html');
  const type = (id, v) => { const el = t.d.getElementById(id); el.value = v; el.dispatchEvent(new t.w.Event('input', { bubbles: true })); };
  const bar = () => t.d.getElementById('pw-meter-bar'), hint = () => t.text('pw-hint');
  check('before typing: tells you the minimum', /At least 8/.test(hint()), hint());
  type('password', 'abc');
  check('short: counts characters still needed', /5 more characters/.test(hint()) && bar().className.includes('pw-level-0'), [hint(), bar().className]);
  type('password', 'abcdefg');
  check('one short of the minimum uses singular', /1 more character to go/.test(hint()), hint());
  type('password', 'password');
  check('common password flagged weak', /very common/.test(hint()) && bar().className.includes('pw-level-1'), [hint(), bar().className]);
  type('password', 'zxcvbnmk');
  check('8 plain lowercase letters = weak', bar().className.includes('pw-level-1'), bar().className);
  type('password', 'Passw0rd!x');
  check('mixed 10 chars = okay', /Okay/.test(hint()) && bar().className.includes('pw-level-2') && bar().style.width === '50%', [hint(), bar().className, bar().style.width]);
  type('password', 'purple-elephant-9');
  check('long passphrase = strong, bar full', /Strong/.test(hint()) && bar().style.width === '100%', [hint(), bar().style.width]);
  type('password', '');
  check('cleared: bar empties', bar().style.width === '0%', bar().style.width);
  type('password', 'purple-elephant-9'); type('confirm-password', 'purple-eleph');
  check("mismatch shown live", /don't match/.test(t.text('confirm-hint')) && t.d.getElementById('confirm-hint').className.includes('pw-nomatch'), t.text('confirm-hint'));
  type('confirm-password', 'purple-elephant-9');
  check('match shown live', /match/.test(t.text('confirm-hint')) && t.d.getElementById('confirm-hint').className.includes('pw-match'), t.text('confirm-hint'));
  type('confirm-password', ''); 
  check('confirm hint clears when empty', t.text('confirm-hint') === '', t.text('confirm-hint'));
  const pwType = () => [t.d.getElementById('password').type, t.d.getElementById('confirm-password').type].join();
  check('hidden by default', pwType() === 'password,password', pwType());
  t.d.getElementById('show-password').click(); t.d.getElementById('show-password').dispatchEvent(new t.w.Event('change'));
  await sleep(50);
  check('Show password reveals both fields', pwType() === 'text,text', pwType());
  t.d.getElementById('show-password').click(); t.d.getElementById('show-password').dispatchEvent(new t.w.Event('change'));
  check('unticking hides them again', pwType() === 'password,password', pwType());
  check('no console errors', t.errors.length === 0, t.errors);
  t = await open('index.html');
  t.d.getElementById('show-password').click(); await sleep(50);
  check('login page: Show password reveals the field', t.d.getElementById('password').type === 'text', t.d.getElementById('password').type);
  check('login page: no console errors', t.errors.length === 0, t.errors);


  // ---------------- BRANDING ----------------
  console.log('Branding');
  for (const page of ['index.html', 'signup.html', 'hub.html', 'games/werewolf.html', 'games/spyfall.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    check(page + ': titled Hijinks, has favicon, no old name', /<title>[^<]*Hijinks/.test(html) && /rel="icon"/.test(html) && !/classroom/i.test(html), page);
  }
  const cfg = fs.readFileSync(path.join(ROOT, 'js/core/firebaseConfig.js'), 'utf8');
  check('Firebase config is filled in (no placeholders)', !/YOUR_/.test(cfg.replace(/startsWith\('YOUR_'\)/, '')) , 'placeholders remain');
  check('firebase.json points at firestore.rules', JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).firestore.rules === 'firestore.rules');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
