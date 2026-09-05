/*
 * Test harness for the chat API.
 *
 * NO PRODUCTION CONTACT. The Admin SDK is pointed at the local Firestore
 * emulator through FIRESTORE_EMULATOR_HOST and initialised against a
 * demo- project id, which Firebase refuses to let reach a real service. No
 * credential, no service-account key and no real staff password is involved.
 * The production project id appears in the suite only as a string compared
 * against the project guard - it is never used as a connection target.
 *
 * Token verification is injected rather than mocked at the module level, so
 * the tests exercise the real auth code path with a stand-in verifier.
 */

import { createRequire } from 'module';
const require = createRequire('/home/user/esthers/');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

/*
 * One emulator namespace PER TEST FILE.
 *
 * node --test runs test files in parallel processes, and wipe() deletes whole
 * collections. Sharing a single project id would let one file's teardown
 * delete another file's fixtures mid-assertion - a flaky suite that reports
 * security failures which are not real, which is worse than no suite at all.
 * A distinct demo- project per file gives each process its own namespace
 * inside the same emulator. Every one of them starts with "demo-", which is
 * what makes Firebase refuse to let the SDK reach a real service.
 */
function namespaceForThisFile() {
  const entry = String(process.argv[1] || '');
  const base = entry.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const safe = base.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return 'demo-esthers-chat' + (safe ? '-' + safe : '');
}

const PROJECT_ID = namespaceForThisFile();

/* firebase-admin 14 is modular only: the old single admin.* namespace is
   gone, so the app, Firestore and Auth entry points are imported separately -
   exactly as api/_chat/firebase-admin.js does. */
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp: FsTimestamp } = require('firebase-admin/firestore');

let app = null;
export function db() {
  if (!app) {
    const existing = getApps();
    app = existing.length ? existing[0] : initializeApp({ projectId: PROJECT_ID });
  }
  return getFirestore(app);
}

export const Timestamp = FsTimestamp;
export const RATE_SECRET = 'test-rate-limit-secret-not-real-0123456789';

/* ------------------------------------------------------------ fake tokens */

/* The verifier stands in for admin.auth().verifyIdToken. It returns exactly
   the shape the real one does - notably firebase.sign_in_provider, which is
   what both the API and the deployed rules key on. */
export function makeVerifier(tokens) {
  return async (token) => {
    if (!Object.prototype.hasOwnProperty.call(tokens, token)) {
      /* Shaped like the real thing: firebase-admin rejects a bad token with
         a FirebaseAuthError carrying an auth/* code, and the API now tells
         those apart from a verifier that has genuinely broken. A bare Error
         here would exercise the wrong branch. */
      throw firebaseAuthError('auth/argument-error');
    }
    return tokens[token];
  };
}

/* A stand-in FirebaseAuthError. Note name === 'Error': firebase-admin does
   not override it, which is why the code, not the name, is what classifies. */
export function firebaseAuthError(code) {
  const err = new Error('Decoding Firebase ID token failed.');
  err.code = code;
  return err;
}

export const anonToken = (uid) => ({ uid, firebase: { sign_in_provider: 'anonymous' } });
export const passwordToken = (uid, email) =>
  ({ uid, email, firebase: { sign_in_provider: 'password' } });

/* --------------------------------------------------------- fake req / res */

export function makeReq(opts = {}) {
  return {
    method: opts.method || 'POST',
    headers: Object.assign(
      { host: 'www.esthers.ca' },
      opts.token ? { authorization: 'Bearer ' + opts.token } : {},
      /* App Check travels in its own header, never in Authorization. Passing
         appCheck: false or omitting it sends none, which is what every test
         written before App Check existed does - and what a browser that has
         not yet been given the client module does too. */
      opts.appCheck ? { 'x-firebase-appcheck': opts.appCheck } : {},
      opts.headers || {}),
    body: opts.body,
    query: opts.query || {},
    socket: { remoteAddress: opts.ip || '203.0.113.10' }
  };
}

export function makeRes() {
  const res = { statusCode: 0, payload: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.payload = o; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  return res;
}

/* A stand-in for getAppCheck(app).verifyToken.

   Accepts the tokens named in `valid` and refuses everything else the way
   the real one does - a FirebaseAppCheckError carrying an app-check/* code.
   The resolved shape mirrors VerifyAppCheckTokenResponse so appIdOf() is
   exercised on the same field the SDK actually populates. */
export const APP_CHECK_OK = 'valid-app-check-token.aaaa.bbbb';
export const APP_CHECK_BAD = 'invalid-app-check-token.cccc.dddd';
export const APP_CHECK_APP_ID = '1:000000000000:web:0000000000000000000000';

export function makeAppCheckVerifier(valid = [APP_CHECK_OK]) {
  return async (token) => {
    if (valid.indexOf(token) === -1) throw appCheckError('app-check-token-expired');
    return {
      appId: APP_CHECK_APP_ID,
      token: { app_id: APP_CHECK_APP_ID, aud: [], iss: '', sub: APP_CHECK_APP_ID,
               exp: 0, iat: 0 }
    };
  };
}

export function appCheckError(code) {
  const err = new Error('Decoding App Check token failed.');
  err.code = code;
  return err;
}

/*
 * Builds a handler with the emulator db and stand-in verifiers wired in.
 *
 * opts.appCheckEnforced   true sets CHAT_APP_CHECK_ENFORCED for this handler
 * opts.appCheckValid      array of tokens the stand-in verifier accepts
 * opts.verifyAppCheckToken   replace the verifier outright, or pass null to
 *                            simulate the module having failed to load
 */
export function handlerFor(routeModulePath, tokens, opts = {}) {
  const mod = require(routeModulePath);
  const firestore = db();
  const env = Object.assign({ CHAT_RATE_LIMIT_SECRET: RATE_SECRET }, opts.env || {});
  if (opts.appCheckEnforced) env.CHAT_APP_CHECK_ENFORCED = '1';

  const verifyAppCheckToken = Object.prototype.hasOwnProperty.call(opts, 'verifyAppCheckToken')
    ? opts.verifyAppCheckToken
    : makeAppCheckVerifier(opts.appCheckValid);

  return mod.forTest({
    initAdmin: () => ({ db: firestore, auth: null, app: null, projectId: PROJECT_ID }),
    verifyIdToken: makeVerifier(tokens),
    verifyAppCheckToken: verifyAppCheckToken,
    env: env,
    now: opts.now || (() => Timestamp.now())
  });
}

export async function call(handler, reqOpts) {
  const req = makeReq(reqOpts);
  const res = makeRes();
  await handler(req, res);
  return res;
}

/* ------------------------------------------------------------- utilities */

export async function wipe() {
  const firestore = db();
  for (const c of ['chatConversations', 'chatMessages', 'chatRateLimits', 'staff']) {
    const snap = await firestore.collection(c).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
}

export async function seedStaff(uid, fields = {}) {
  await db().collection('staff').doc(uid).set(Object.assign(
    { email: 'manager@example.test', displayName: 'Test Staff', isActive: true, role: 'admin' },
    fields));
}

export const uuid = () => globalThis.crypto.randomUUID();

export async function countMessages(conversationId) {
  const snap = await db().collection('chatMessages')
    .where('conversationId', '==', conversationId).get();
  return snap.size;
}

export async function getConversation(conversationId) {
  const snap = await db().collection('chatConversations').doc(conversationId).get();
  return snap.exists ? snap.data() : null;
}
