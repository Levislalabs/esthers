/*
 * Lazy, cached Firebase Admin initialisation.
 *
 * TWO THINGS THIS FILE EXISTS TO PREVENT
 *
 * 1. A build that fails because a Preview deployment has no production
 *    credentials. Nothing here runs at import time - the first API request
 *    is what initialises the app, and a request that finds no credentials
 *    gets a clean 503 rather than the deployment falling over.
 *
 * 2. Writing to the wrong Firebase project. The Admin SDK bypasses Firestore
 *    Security Rules completely, so a misconfigured FIREBASE_PROJECT_ID would
 *    not be caught by any rule - it would just quietly write somewhere else.
 *    initAdmin() refuses to start unless the project id is the one this code
 *    was written for.
 *
 * NO CREDENTIAL IS STORED IN THIS REPOSITORY. Everything comes from the
 * environment, and nothing here logs, returns or echoes a key.
 *
 * The SDK is reached through its modular entry points - firebase-admin/app,
 * /firestore and /auth. firebase-admin 14 removed the old single-namespace
 * export, so admin.firestore(app) and admin.credential.cert() no longer
 * exist; getFirestore(app) and cert() are the replacements.
 */

'use strict';

/* The only project these endpoints may ever touch. A deliberate constant
   rather than a free-form env value: the guard is worthless if the thing it
   compares against is also configurable at deploy time. */
const EXPECTED_PROJECT_ID = 'esther-s-chat';

const ENV = {
  projectId:  'FIREBASE_PROJECT_ID',
  clientEmail:'FIREBASE_CLIENT_EMAIL',
  privateKey: 'FIREBASE_PRIVATE_KEY'
};

/* Cached across invocations of a warm serverless instance. */
let cached = null;

class ChatConfigError extends Error {
  constructor(reason) {
    super('chat backend is not configured: ' + reason);
    this.name = 'ChatConfigError';
    this.reason = reason;      /* short token, safe to log */
    this.notConfigured = true;
  }
}

/*
 * A private key in an environment variable almost always arrives with its
 * newlines escaped, because most dashboards cannot hold a literal multi-line
 * value. Some paste it wrapped in quotes as well. Both are normalised here.
 *
 * The key itself is never logged, never returned and never included in an
 * error message - only the fact that it was unusable.
 */
function normalisePrivateKey(raw) {
  if (typeof raw !== 'string') return null;
  let key = raw.trim();
  if (key.length < 2) return null;

  /* A value pasted with surrounding quotes. */
  const first = key[0];
  if ((first === '"' || first === "'") && key[key.length - 1] === first) {
    key = key.slice(1, -1);
  }

  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

  if (key.indexOf('-----BEGIN') === -1 || key.indexOf('PRIVATE KEY-----') === -1) {
    return null;
  }
  if (key.indexOf('\n') === -1) return null;      /* still one line: unusable */
  return key.endsWith('\n') ? key : key + '\n';
}

function readConfig(env) {
  const source = env || process.env;
  const projectId = (source[ENV.projectId] || '').trim();
  const clientEmail = (source[ENV.clientEmail] || '').trim();
  const privateKey = normalisePrivateKey(source[ENV.privateKey]);

  if (!projectId) throw new ChatConfigError('missing_project_id');
  if (projectId !== EXPECTED_PROJECT_ID) throw new ChatConfigError('unexpected_project');
  if (!clientEmail || clientEmail.indexOf('@') === -1) {
    throw new ChatConfigError('missing_client_email');
  }
  if (!privateKey) throw new ChatConfigError('missing_or_malformed_private_key');

  return { projectId, clientEmail, privateKey };
}

/*
 * Returns { app, db, auth }. Throws ChatConfigError when the environment is
 * incomplete, which every handler turns into a 503 rather than a 500 - the
 * request was fine, the deployment is not finished.
 */
function initAdmin(deps) {
  if (cached) return cached;

  const config = readConfig(deps && deps.env);
  const sdk = (deps && deps.sdk) || {
    app: require('firebase-admin/app'),
    firestore: require('firebase-admin/firestore'),
    auth: require('firebase-admin/auth')
  };

  /* A warm instance may already hold an app from a previous request. */
  const existing = sdk.app.getApps();
  const app = (existing && existing.length) ? existing[0] : sdk.app.initializeApp({
    credential: sdk.app.cert({
      projectId: config.projectId,
      clientEmail: config.clientEmail,
      privateKey: config.privateKey
    }),
    projectId: config.projectId
  });

  cached = {
    app: app,
    db: sdk.firestore.getFirestore(app),
    auth: sdk.auth.getAuth(app),
    projectId: config.projectId
  };
  return cached;
}

/*
 * The server's clock, as a Firestore Timestamp.
 *
 * Kept here so no other file has to reach into the SDK directly, and so a
 * test can substitute a fixed clock without stubbing a module.
 */
function serverNow() {
  return require('firebase-admin/firestore').Timestamp.now();
}

/* Tests only: drop the memoised app so a fresh configuration can be read. */
function _reset() { cached = null; }

module.exports = {
  EXPECTED_PROJECT_ID, ENV,
  ChatConfigError, normalisePrivateKey, readConfig, initAdmin, serverNow, _reset
};
