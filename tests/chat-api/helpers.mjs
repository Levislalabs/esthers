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
      throw new Error('invalid token');
    }
    return tokens[token];
  };
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

/* Builds a handler with the emulator db and a stand-in verifier wired in. */
export function handlerFor(routeModulePath, tokens, opts = {}) {
  const mod = require(routeModulePath);
  const firestore = db();
  return mod.forTest({
    initAdmin: () => ({ db: firestore, auth: null, app: null, projectId: PROJECT_ID }),
    verifyIdToken: makeVerifier(tokens),
    env: Object.assign({ CHAT_RATE_LIMIT_SECRET: RATE_SECRET }, opts.env || {}),
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
