/*
 * A stand-in for the FOUR Firebase Web SDK modules the customer chat loads:
 * firebase-app, firebase-app-check, firebase-auth and firebase-firestore.
 *
 * WHY ONE FILE FOR FOUR MODULES. The test rewrites all four gstatic
 * specifiers to point here, so this has to export the union of their
 * surfaces. The modules under test only name a dozen functions between
 * them, and those are what they get.
 *
 * WHY A STUB AT ALL. A unit test that reaches the network is not a unit
 * test, and the real SDK could not help here anyway: App Check attestation
 * is a reCAPTCHA challenge performed by a browser against the page's own
 * hostname, and the production key is restricted to esthers.ca. Nothing in
 * this container can mint a token, and weakening that restriction to make a
 * test pass would be exactly the wrong trade.
 *
 * WHAT IT IS FOR. Two things the real SDK cannot give a test:
 *
 *   ORDER. Every call lands in one shared `order` array, so "App Check was
 *   initialised before signInAnonymously" is an assertion about observed
 *   behaviour rather than a reading of the source.
 *
 *   FAILURE. setTokenError, setSignInError, failNextSnapshot and the rest
 *   let a test say "and then attestation was refused" or "and then the
 *   rules said no" and watch what the module does about it.
 *
 * A separate file from firebase-sdk-stub.mjs on purpose: that one belongs
 * to app-check-client.test.mjs, which asserts exact call counts against it.
 * Growing it would couple two unrelated suites.
 *
 * STATE IS MODULE-LEVEL AND SHARED, because Node caches by URL and every
 * rewritten module is looking at this same instance. Hence reset().
 */

/* ------------------------------------------------------------ recorder */

/* Mutated in place, never reassigned: a test holds `stub.calls` across a
   reset(), so swapping in a fresh object would leave it inspecting the old
   one. */
export const calls = {
  initializeApp: [],
  initializeAppCheck: [],
  providerSiteKeys: [],
  getAppCheckToken: [],
  getAuth: [],
  signInAnonymously: [],
  onAuthStateChanged: [],
  getIdToken: [],
  getFirestore: [],
  collection: [],
  where: [],
  orderBy: [],
  limit: [],
  query: [],
  onSnapshot: [],
  unsubscribe: []
};

/* One flat log of SDK calls in the order they happened. The ordering
   assertions read this and nothing else. */
export const order = [];

function record(name, detail) {
  order.push(name);
  if (calls[name]) calls[name].push(detail === undefined ? {} : detail);
}

/* ------------------------------------------------------------- controls */

let apps = [];
let appCheckToken = 'stub.app.check.token';
let appCheckTokenError = null;
let appCheckInitError = null;

let currentUser = null;
let restoredUser = null;          /* what onAuthStateChanged reports */
let authStateError = false;
let signInError = null;
let signedInUser = { uid: 'anon-uid-1', getIdToken: async () => 'id-token-1' };
let idTokenError = null;

let snapshotHandlers = [];
let nextSnapshotError = null;
let unsubscribeThrows = false;

export function reset() {
  for (const key of Object.keys(calls)) calls[key].length = 0;
  order.length = 0;
  apps = [];
  appCheckToken = 'stub.app.check.token';
  appCheckTokenError = null;
  appCheckInitError = null;
  currentUser = null;
  restoredUser = null;
  authStateError = false;
  signInError = null;
  signedInUser = { uid: 'anon-uid-1', getIdToken: async () => 'id-token-1' };
  idTokenError = null;
  snapshotHandlers = [];
  nextSnapshotError = null;
  unsubscribeThrows = false;
}

/* Another module on the page already started Firebase. */
export function seedExistingApp(app) {
  apps = [app || { name: '[DEFAULT]', seeded: true }];
}

export function setAppCheckToken(value) {
  appCheckToken = value;
  appCheckTokenError = null;
}

export function setAppCheckTokenError(err) {
  appCheckTokenError = err || new Error('stub: attestation refused');
}

/* Make initializeAppCheck() throw - an SDK that loaded but could not start.
   chat-app-check.js turns this into a null App Check instance, which is the
   condition chat-customer.js must refuse to sign in under. */
export function setAppCheckInitError(err) {
  appCheckInitError = err || new Error('stub: app check init failed');
}

/* A persisted anonymous session that the SDK restores asynchronously. This
   is the case that makes resolveUser() wait instead of minting a second
   account, so it has its own control. */
export function seedRestoredUser(user) {
  restoredUser = user || { uid: 'restored-uid', getIdToken: async () => 'restored-token' };
}

/* auth.currentUser already populated, synchronously. */
export function seedCurrentUser(user) {
  currentUser = user || { uid: 'current-uid', getIdToken: async () => 'current-token' };
}

export function setAuthStateError() {
  authStateError = true;
}

export function setSignInError(err) {
  signInError = err || new Error('stub: sign-in refused');
}

export function setSignedInUser(user) {
  signedInUser = user;
}

export function setIdTokenError(err) {
  idTokenError = err || new Error('stub: token refused');
}

export function setUnsubscribeThrows() {
  unsubscribeThrows = true;
}

/* The next onSnapshot() call fails immediately through its error callback,
   the way Firestore reports a rules refusal. */
export function failNextSnapshot(err) {
  nextSnapshotError = err || { code: 'permission-denied' };
}

/* Deliver a snapshot to every live listener. `docs` are plain
   { id, data } objects; data() is provided so they look like the
   QueryDocumentSnapshots the real SDK hands over. */
export function emitSnapshot(docs) {
  const snapshot = {
    docs: (docs || []).map((d) => ({ id: d.id, data: () => d.data }))
  };
  for (const h of snapshotHandlers.slice()) {
    if (typeof h.next === 'function') h.next(snapshot);
  }
}

/* Push an error into every live listener, as Firestore does when a
   subscription dies after it has been running. */
export function emitListenerError(err) {
  for (const h of snapshotHandlers.slice()) {
    if (typeof h.error === 'function') h.error(err || { code: 'unavailable' });
  }
}

export function liveListenerCount() {
  return snapshotHandlers.length;
}

/* ------------------------------------------------- firebase-app surface */

export function initializeApp(config) {
  record('initializeApp', config);
  const app = { name: '[DEFAULT]', options: config };
  apps.push(app);
  return app;
}

export function getApps() {
  return apps.slice();
}

/* ------------------------------------------- firebase-app-check surface */

export class ReCaptchaEnterpriseProvider {
  constructor(siteKey) {
    this.siteKey = siteKey;
    record('providerSiteKeys', siteKey);
  }
}

export function initializeAppCheck(app, options) {
  record('initializeAppCheck', { app, options });
  if (appCheckInitError) throw appCheckInitError;
  return { __appCheck: true, app, options };
}

export async function getToken(appCheck, forceRefresh) {
  record('getAppCheckToken', { appCheck, forceRefresh });
  if (appCheckTokenError) throw appCheckTokenError;
  return { token: appCheckToken };
}

/* ------------------------------------------------ firebase-auth surface */

export function getAuth(app) {
  record('getAuth', { app });
  return {
    app: app,
    get currentUser() { return currentUser; }
  };
}

/*
 * Reports the restored session on the next tick, the way the real SDK does.
 * Asynchronous on purpose: a synchronous callback would hide exactly the
 * race resolveUser() exists to survive.
 */
export function onAuthStateChanged(auth, next, error) {
  record('onAuthStateChanged', {});
  if (authStateError) {
    throw new Error('stub: auth state listener refused');
  }
  const timer = setTimeout(() => {
    if (typeof next === 'function') next(restoredUser);
  }, 0);
  return function unsubscribeAuth() {
    clearTimeout(timer);
  };
}

export async function signInAnonymously(auth) {
  record('signInAnonymously', {});
  if (signInError) throw signInError;
  currentUser = signedInUser;
  if (currentUser && idTokenError) {
    currentUser = Object.assign({}, currentUser, {
      getIdToken: async () => { throw idTokenError; }
    });
  }
  return { user: currentUser };
}

/* ------------------------------------------- firebase-firestore surface */

export function getFirestore(app) {
  record('getFirestore', { app });
  return { __db: true, app };
}

export function collection(db, path) {
  record('collection', { db, path });
  return { __collection: path };
}

export function where(field, op, value) {
  record('where', { field, op, value });
  return { __where: [field, op, value] };
}

export function orderBy(field, direction) {
  record('orderBy', { field, direction });
  return { __orderBy: [field, direction] };
}

export function limit(n) {
  record('limit', { n });
  return { __limit: n };
}

export function query(base, ...constraints) {
  record('query', { base, constraints });
  return { __query: true, base, constraints };
}

export function onSnapshot(q, next, error) {
  record('onSnapshot', { q });
  if (nextSnapshotError) {
    const err = nextSnapshotError;
    nextSnapshotError = null;
    /* Firestore reports a rules refusal through the error callback, not by
       throwing out of onSnapshot(). Asynchronously, so the caller has
       finished wiring itself up first. */
    setTimeout(() => { if (typeof error === 'function') error(err); }, 0);
    return function unsubscribeDead() {};
  }
  const handler = { next, error };
  snapshotHandlers.push(handler);
  return function unsubscribe() {
    record('unsubscribe', {});
    if (unsubscribeThrows) throw new Error('stub: unsubscribe refused');
    const i = snapshotHandlers.indexOf(handler);
    if (i !== -1) snapshotHandlers.splice(i, 1);
  };
}

/*
 * DELIBERATELY ABSENT: addDoc, setDoc, updateDoc, deleteDoc, doc, writeBatch,
 * runTransaction, serverTimestamp.
 *
 * Not an oversight. The customer cannot write to Firestore - the rules deny
 * create, update and delete outright - so chat-customer.js must never reach
 * for one of these. If it ever does, it will fail here loudly rather than
 * quietly working against a stub that was too accommodating.
 */
