/*
 * A stand-in for the THREE Firebase Web SDK modules the staff dashboard
 * loads: firebase-app, firebase-app-check and firebase-auth.
 *
 * NOT firebase-firestore. The staff dashboard must never load it, and a stub
 * that offered a Firestore surface would quietly make it possible to.
 *
 * WHY A STUB AT ALL. App Check attestation is a reCAPTCHA challenge performed
 * by a browser against the page's own hostname, and the production key is
 * restricted to esthers.ca; nothing in this container can mint a token.
 * Signing in for real would need a staff password, which no test should know.
 *
 * WHAT IT IS FOR. Two things the real SDK cannot give a test:
 *
 *   ORDER. Every call lands in one shared `order` array, so "App Check was
 *   initialised before Firebase Auth" is an assertion about observed
 *   behaviour rather than a reading of the source.
 *
 *   FAILURE. setSignInError and friends let a test say "and then the password
 *   was wrong" or "and then the session was revoked" and watch what the
 *   dashboard does about it.
 *
 * A separate file from firebase-sdk-full-stub.mjs on purpose: that one
 * belongs to the customer suite, which asserts exact call counts against it.
 * Growing it would couple two unrelated suites.
 *
 * STATE IS MODULE-LEVEL AND SHARED, because Node caches by URL and every
 * rewritten module is looking at this same instance. Hence reset().
 */

export const order = [];
export let signOutCalls = 0;

let apps = [];
let appCheckToken = 'stub.app.check.token';
let appCheckInitError = null;

let restoredUser = null;         /* what onAuthStateChanged reports */
let currentUser = null;
let signInError = null;
let signedInUser = null;

function record(name) { order.push(name); }

/* ------------------------------------------------- auth persistence */

export const browserSessionPersistence = { type: 'SESSION' };
export const browserLocalPersistence = { type: 'LOCAL' };
export const inMemoryPersistence = { type: 'NONE' };

export const persistenceChoices = [];
let persistenceFails = false;
export function persistenceErrorOn(flag) { persistenceFails = flag === true; }

export async function setPersistence(auth, persistence) {
  record('setPersistence');
  if (persistenceFails) throw new Error('stub: web storage unsupported');
  persistenceChoices.push(persistence && persistence.type);
  return undefined;
}


export function reset() {
  order.length = 0;
  signOutCalls = 0;
  apps = [];
  appCheckToken = 'stub.app.check.token';
  appCheckInitError = null;
  persistenceChoices.length = 0;
  persistenceFails = false;
  restoredUser = null;
  currentUser = null;
  signInError = null;
  signedInUser = {
    uid: 'staff-1',
    email: 'manager@esthers.ca',
    isAnonymous: false,
    getIdToken: async () => 'staff-id-token'
  };
}
reset();

/* ---------------------------------------------------------- controls */

export function seedRestoredUser(user) { restoredUser = user || null; }
export function setSignInError(err) { signInError = err || null; }
export function setSignedInUser(user) { signedInUser = user || null; }
export function setAppCheckToken(value) { appCheckToken = value; }
export function setAppCheckInitError(err) { appCheckInitError = err || null; }

/* ------------------------------------------------- firebase-app surface */

export function initializeApp(config) {
  record('initializeApp');
  const app = { name: '[DEFAULT]', options: config };
  apps = [app];
  return app;
}

export function getApps() {
  record('getApps');
  return apps.slice();
}

/* ------------------------------------------- firebase-app-check surface */

export class ReCaptchaEnterpriseProvider {
  constructor(siteKey) {
    record('ReCaptchaEnterpriseProvider');
    this.siteKey = siteKey;
  }
}

export function initializeAppCheck(app, options) {
  record('initializeAppCheck');
  if (appCheckInitError) throw appCheckInitError;
  return { app, options, __appCheck: true };
}

export async function getToken(appCheck, forceRefresh) {
  record('getAppCheckToken');
  return { token: appCheckToken };
}

/* ------------------------------------------------ firebase-auth surface */

export function getAuth(app) {
  record('getAuth');
  return { app, get currentUser() { return currentUser; } };
}

/*
 * Reports the restored session on the next tick, the way the real SDK does.
 * Asynchronous on purpose: a synchronous callback would hide exactly the race
 * the dashboard's restore() exists to survive.
 */
export function onAuthStateChanged(auth, next, error) {
  record('onAuthStateChanged');
  const timer = setTimeout(() => {
    currentUser = restoredUser;
    if (typeof next === 'function') next(restoredUser);
  }, 0);
  return function unsubscribeAuth() { clearTimeout(timer); };
}

export async function signInWithEmailAndPassword(auth, email, password) {
  record('signInWithEmailAndPassword');
  if (signInError) throw signInError;
  currentUser = signedInUser;
  return { user: currentUser };
}

export async function signOut(auth) {
  record('signOut');
  signOutCalls += 1;
  currentUser = null;
  restoredUser = null;
  return undefined;
}
