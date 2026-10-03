// In-memory Firebase compat stub, v2: email/password + Google + reset, dotted-path updates.
(function () {
  const store = new Map(), listeners = [];
  const DEL = { __del: true }, TS = { __ts: true };
  const clone = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  const setPath = (obj, path, val) => { const ks = path.split('.'); let o = obj; ks.slice(0, -1).forEach(k => { o[k] = o[k] || {}; o = o[k]; }); const last = ks[ks.length - 1]; if (val && val.__del) delete o[last]; else o[last] = val; };
  function apply(prev, data, merge) {
    const out = merge ? clone(prev || {}) : {};
    for (const [k, v] of Object.entries(data)) {
      if (k.includes('.')) setPath(out, k, v);
      else if (v && v.__del) delete out[k];
      else if (v && v.__ts) out[k] = 1700000000000;
      else if (v && v.__union) out[k] = [...new Set([...(out[k] || []), v.__union])];
      else out[k] = v;
    }
    return out;
  }
  const parent = p => p.split('/').slice(0, -1).join('/');
  const notify = path => listeners.slice().forEach(l => { if ((l.kind === 'doc' && l.path === path) || (l.kind === 'col' && parent(path) === l.path)) l.fire(); });
  const snapDoc = path => { const d = store.get(path); return { id: path.split('/').pop(), exists: d !== undefined, data: () => clone(d), ref: docRef(path) }; };
  const snapCol = path => { const docs = [...store.keys()].filter(k => parent(k) === path).map(snapDoc); return { docs, size: docs.length, forEach: fn => docs.forEach(fn) }; };
  const docRef = path => ({ path, id: path.split('/').pop(),
    get: async () => snapDoc(path),
    set: async (d, o) => { store.set(path, apply(store.get(path), d, o && o.merge)); notify(path); },
    update: async d => { if (!store.has(path)) { const e = new Error('not-found ' + path); e.code = 'not-found'; throw e; } store.set(path, apply(store.get(path), d, true)); notify(path); },
    delete: async () => { store.delete(path); notify(path); },
    collection: n => colRef(path + '/' + n),
    onSnapshot: cb => { const l = { kind: 'doc', path, fire: () => cb(snapDoc(path)) }; listeners.push(l); Promise.resolve().then(l.fire); return () => listeners.splice(listeners.indexOf(l), 1); } });
  const colRef = path => ({ path, doc: id => docRef(path + '/' + id), get: async () => snapCol(path),
    onSnapshot: cb => { const l = { kind: 'col', path, fire: () => cb(snapCol(path)) }; listeners.push(l); Promise.resolve().then(l.fire); return () => listeners.splice(listeners.indexOf(l), 1); } });
  const db = { collection: p => colRef(p),
    batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), delete: r => ops.push(() => r.delete()), commit: async () => { for (const op of ops) await op(); } }; } };

  // ---- auth ----
  const accounts = new Map();           // email -> { password, uid, displayName }
  const log = { resets: [], redirects: 0, popups: 0 };
  let authCb = null, current = null;
  const mkUser = (email, uid, displayName) => ({ uid, email, displayName: displayName || null,
    async updateProfile(p) { if (p.displayName !== undefined) this.displayName = p.displayName; } });
  const setUser = u => { current = u; authCb && authCb(u); };
  const err = (code) => { const e = new Error(code); e.code = code; return e; };
  let redirectError = window.__redirectError || null;
  const auth = {
    get currentUser() { return current; },
    onAuthStateChanged: cb => { authCb = cb; Promise.resolve().then(() => cb(current)); },
    signOut: async () => setUser(null),
    createUserWithEmailAndPassword: async (email, password) => {
      if (accounts.has(email)) throw err('auth/email-already-in-use');
      const uid = 'uid_' + (accounts.size + 1); accounts.set(email, { password, uid });
      const u = mkUser(email, uid); setUser(u); return { user: u };
    },
    signInWithEmailAndPassword: async (email, password) => {
      const a = accounts.get(email);
      if (!a || a.password !== password) throw err('auth/invalid-credential');
      setUser(mkUser(email, a.uid, a.displayName)); 
    },
    sendPasswordResetEmail: async email => { if (!accounts.has(email)) throw err('auth/user-not-found'); log.resets.push(email); },
    signInWithPopup: async () => {
      log.popups++;
      const mode = window.__googleMode || 'ok';
      if (mode === 'closed') throw err('auth/popup-closed-by-user');
      if (mode === 'blocked') throw err('auth/popup-blocked');
      if (mode.startsWith('error:')) throw err(mode.slice(6));
      const email = 'gina@gmail.com'; if (!accounts.has(email)) accounts.set(email, { password: null, uid: 'g_gina' });
      const u = mkUser(email, 'g_gina', 'Gina Google'); setUser(u); return { user: u };
    },
    signInWithRedirect: async () => { log.redirects++; },
    getRedirectResult: async () => { if (redirectError) throw err(redirectError); return { user: null }; }
  };
  function GoogleAuthProvider() { this.setCustomParameters = () => {}; }
  const authFn = () => auth; authFn.GoogleAuthProvider = GoogleAuthProvider;
  const fs = () => db; fs.FieldValue = { delete: () => DEL, serverTimestamp: () => TS, arrayUnion: v => ({ __union: v }) };
  window.firebase = { initializeApp() {}, auth: authFn, firestore: fs };
  window.__stub = { store, accounts, log, setUser, mkUser, auth };
  if (window.__seedUser) { const s = window.__seedUser; accounts.set(s.email, { password: s.password || 'password1', uid: s.uid }); current = mkUser(s.email, s.uid, s.displayName); }
})();
