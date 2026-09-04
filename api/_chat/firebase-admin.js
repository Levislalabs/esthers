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

/*
 * EVERY TOKEN THIS FILE IS ALLOWED TO PUT IN A LOG.
 *
 * The log line is built only from this list. Nothing derived from an
 * environment variable, an error message, an error cause or a stack ever
 * reaches it. A reason that is not in this list is a bug, and _assertToken()
 * turns it into 'unknown_initialization_error' rather than letting an
 * unvetted string escape.
 */
const DIAGNOSTIC_TOKENS = [
  /* structural, decided before the SDK is touched at all */
  'missing_project_id',
  'unexpected_project',
  'missing_client_email',
  'invalid_client_email_shape',
  'missing_private_key',
  'private_key_not_pem',
  'private_key_pem_truncated',
  'private_key_single_line',
  'private_key_body_not_base64',
  /* the SDK rejected something */
  'invalid_private_key_pem',
  'invalid_service_account_credential',
  'firebase_admin_module_missing',
  /* Per-module, and telling "the package is not there" apart from "the
     package is there and threw while loading". The old single token could
     not distinguish those, and they have completely different fixes. */
  'firebase_admin_app_not_found',
  'firebase_admin_app_load_failed',
  'firebase_admin_firestore_not_found',
  'firebase_admin_firestore_load_failed',
  'firebase_admin_auth_not_found',
  'firebase_admin_auth_load_failed',
  'firebase_admin_invalid_app_options',
  'firebase_admin_initialize_failed',
  'firebase_firestore_initialize_failed',
  'firebase_auth_initialize_failed',
  /* last resort */
  'unknown_initialization_error'
];

function _assertToken(reason) {
  return DIAGNOSTIC_TOKENS.indexOf(reason) === -1 ? 'unknown_initialization_error' : reason;
}

/* A configuration problem: the request was fine, the deployment is not
   finished. Always a 503. */
class ChatConfigError extends Error {
  constructor(reason) {
    super('chat backend is not configured: ' + _assertToken(reason));
    this.name = 'ChatConfigError';
    this.reason = _assertToken(reason);   /* allow-listed token, safe to log */
    this.notConfigured = true;
  }
}

/*
 * The Admin SDK itself threw while starting up.
 *
 * Split from ChatConfigError because the two mean different things to
 * whoever is looking at the log: configCaused means the environment is
 * wrong and the fix is in the Vercel dashboard (503), while anything else
 * is a fault in this code or the platform (500).
 *
 * The originating error is deliberately NOT attached. firebase-admin wraps
 * the underlying crypto failure in `cause`, and a cause chain is exactly the
 * kind of thing that gets stringified into a log by a future edit.
 */
class ChatInitError extends Error {
  constructor(reason, configCaused) {
    super('chat backend failed to initialise: ' + _assertToken(reason));
    this.name = 'ChatInitError';
    this.reason = _assertToken(reason);
    this.notConfigured = !!configCaused;
  }
}

/* ------------------------------------------------------------------------
 * THE SDK MODULES, LOADED AT MODULE SCOPE.
 *
 * Three require() calls with LITERAL specifiers, at the top level of the
 * module. That is the most conventional and most reliably traceable position
 * there is: Vercel bundles a function by static analysis of its dependency
 * graph, and a literal specifier at module scope is the case every version of
 * every bundler handles.
 *
 * LOADING THE LIBRARY NEEDS NO CREDENTIALS. Nothing here reads an
 * environment variable, parses a key or contacts Google. initializeApp() and
 * cert() still happen lazily, on the first request, inside initAdmin() - so a
 * Preview deployment with no production secrets still BUILDS and still
 * answers, failing closed with not_configured.
 *
 * Wrapped in try/catch, and each module separately, for two reasons:
 *
 *   1. An uncaught throw here would crash the function at cold start, before
 *      any handler could run, and the platform's generic invocation failure
 *      would tell us nothing. Recording it instead lets the first request
 *      answer with a precise, allow-listed diagnostic.
 *   2. The previous code loaded all three inside one wrapper whose FALLBACK
 *      token was firebase_admin_module_missing. That token was therefore
 *      emitted for a genuinely absent package AND for a package that was
 *      present but threw while loading - two very different faults with two
 *      very different fixes. Splitting them is the point.
 *
 * These are declared after DIAGNOSTIC_TOKENS on purpose: module scope runs
 * top to bottom, and moduleFailure() consults that list.
 * --------------------------------------------------------------------- */
let sdkApp = null;
let sdkFirestore = null;
let sdkAuth = null;
let sdkLoadFailure = null;      /* allow-listed token, or null */
let sdkLoadCode = 'none';       /* allow-listed error-code class, or 'none' */

/*
 * Node's module-resolution error codes. Fixed constants from the runtime,
 * not data of ours, so naming one in a log discloses nothing.
 */
const NOT_FOUND_CODES = [
  'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_INVALID_MODULE_SPECIFIER', 'ERR_PACKAGE_IMPORT_NOT_DEFINED'
];
const OTHER_LOAD_CODES = ['ERR_REQUIRE_ESM', 'ERR_DLOPEN_FAILED', 'ERR_INVALID_ARG_TYPE'];

try { sdkApp = require('firebase-admin/app'); }
catch (err) { noteModuleFailure('app', err); }

try { sdkFirestore = require('firebase-admin/firestore'); }
catch (err) { noteModuleFailure('firestore', err); }

try { sdkAuth = require('firebase-admin/auth'); }
catch (err) { noteModuleFailure('auth', err); }

function noteModuleFailure(which, err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  const name = err && typeof err.name === 'string' ? err.name : '';
  const notFound = NOT_FOUND_CODES.indexOf(code) !== -1;

  /* First failure wins: the later modules depend on the first, so a cascade
     tells us less than the thing that actually broke. */
  if (!sdkLoadFailure) {
    sdkLoadFailure = 'firebase_admin_' + which + (notFound ? '_not_found' : '_load_failed');
    /* An allow-listed classification of the error code - never the message. */
    if (notFound || OTHER_LOAD_CODES.indexOf(code) !== -1) sdkLoadCode = code;
    else if (name === 'SyntaxError') sdkLoadCode = 'syntax_error';
    else sdkLoadCode = 'other';
  }
}

/*
 * The loaded SDK, or a precise failure.
 *
 * Note there is no require() in here at all any more: by the time a request
 * arrives the modules are either loaded or known to have failed.
 */
function loadSdk() {
  if (sdkLoadFailure) throw new ChatInitError(sdkLoadFailure, false);
  return { app: sdkApp, firestore: sdkFirestore, auth: sdkAuth };
}

/*
 * What the runtime looks like, for the log. Node's major version and which
 * modules loaded - all public facts, none of them derived from a secret.
 */
function describeRuntime() {
  const major = String((process.versions && process.versions.node) || '')
    .split('.')[0].replace(/[^0-9]/g, '').slice(0, 3) || 'unknown';
  return 'node:' + major
    + ',sdk_app:' + (sdkApp ? '1' : '0')
    + ',sdk_firestore:' + (sdkFirestore ? '1' : '0')
    + ',sdk_auth:' + (sdkAuth ? '1' : '0')
    + ',sdk_code:' + sdkLoadCode;
}

/*
 * A private key in an environment variable almost always arrives with its
 * newlines escaped, because most dashboards cannot hold a literal multi-line
 * value. Some paste it wrapped in quotes as well. Both are normalised here,
 * exactly once.
 *
 * The key itself is never logged, never returned in an error and never
 * included in a message - only the fact that it was unusable.
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

/*
 * Structural inspection of a normalised private key.
 *
 * Returns an allow-listed token naming what is wrong, or null when the shape
 * is right. This exists so a production log can distinguish "the environment
 * variable never held a proper PEM" from "the PEM looked right and the
 * crypto library still rejected it" - two very different fixes, and
 * previously indistinguishable.
 *
 * NOTHING derived from the value is returned. Not a length, not a fragment,
 * not a character count.
 */
const PEM_BEGIN = /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----$/;
const PEM_END = /^-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----$/;

function inspectPrivateKeyShape(key) {
  if (typeof key !== 'string' || !key) return 'missing_private_key';

  const lines = key.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2) return 'private_key_single_line';
  if (!PEM_BEGIN.test(lines[0].trim())) return 'private_key_not_pem';
  if (!PEM_END.test(lines[lines.length - 1].trim())) return 'private_key_pem_truncated';

  const body = lines.slice(1, -1).join('');
  if (!body) return 'private_key_pem_truncated';
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return 'private_key_body_not_base64';
  return null;
}

/*
 * A service-account address, checked for shape only.
 *
 * Deliberately not strict about the domain: Google's service-account domain
 * has changed before, and refusing a valid deployment because a hostname
 * moved would be a worse failure than the one this is diagnosing.
 */
function inspectClientEmailShape(email) {
  if (!email) return 'missing_client_email';
  if (/\s/.test(email)) return 'invalid_client_email_shape';
  const parts = email.split('@');
  if (parts.length !== 2) return 'invalid_client_email_shape';
  if (!parts[0] || !parts[1] || parts[1].indexOf('.') === -1) {
    return 'invalid_client_email_shape';
  }
  return null;
}

/*
 * A value-free description of the configuration's shape, for the log.
 *
 * EVERY FIELD IS A BOOLEAN rendered as 0 or 1, built from a fixed list of
 * names. No length, no count, no fragment and no substring of any value can
 * reach it by construction - the only characters that can appear are the
 * fixed field names and the digits 0 and 1.
 *
 * This is what turns "something failed" into "the key is present and starts
 * correctly but its body is not base64", without disclosing anything: which
 * structural checks a VALID key passes is already public knowledge.
 */
const SHAPE_FIELDS = ['pid', 'pid_ok', 'email', 'email_ok', 'svcacct', 'key',
  'key_begin', 'key_end', 'key_multiline', 'key_body', 'secret'];

function describeConfigShape(env) {
  const source = env || process.env;
  const projectId = String(source[ENV.projectId] || '').trim();
  const clientEmail = String(source[ENV.clientEmail] || '').trim();
  const rawKey = source[ENV.privateKey];
  const key = normalisePrivateKey(rawKey);
  const keyShape = key ? inspectPrivateKeyShape(key) : 'missing_private_key';
  const secret = source.CHAT_RATE_LIMIT_SECRET;

  const flags = {
    pid: !!projectId,
    pid_ok: projectId === EXPECTED_PROJECT_ID,
    email: !!clientEmail,
    email_ok: inspectClientEmailShape(clientEmail) === null,
    /* A soft signal only, never fatal: a human address here is a common
       mistake and worth seeing, but the domain is not ours to depend on. */
    svcacct: /\.iam\.gserviceaccount\.com$/.test(clientEmail),
    key: typeof rawKey === 'string' && rawKey.trim() !== '',
    key_begin: !!key && keyShape !== 'private_key_not_pem'
      && keyShape !== 'private_key_single_line',
    key_end: !!key && keyShape !== 'private_key_pem_truncated'
      && keyShape !== 'private_key_not_pem' && keyShape !== 'private_key_single_line',
    key_multiline: typeof key === 'string' && key.indexOf('\n') !== -1,
    key_body: keyShape === null,
    secret: typeof secret === 'string' && secret.length >= 16
  };

  return SHAPE_FIELDS.map((name) => name + ':' + (flags[name] ? '1' : '0')).join(',');
}

/*
 * Map an error thrown by the Admin SDK onto an allow-listed token.
 *
 * The error's `message` is READ here to tell two cases apart, and is never
 * logged or returned. firebase-admin gives every one of these the name
 * "Error" - FirebaseAppError does not override it - which is precisely why
 * the previous log line said only "Error" and identified nothing.
 */
function classifyInitError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = err && typeof err.message === 'string' ? err.message : '';

  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      || code === 'ERR_MODULE_NOT_FOUND') {
    return { reason: 'firebase_admin_module_missing', configCaused: false };
  }
  if (code === 'app/invalid-credential') {
    /* "Failed to parse private key." - the PEM reached crypto and crypto
       refused it. Distinct from a service-account object missing a field. */
    if (message.indexOf('private key') !== -1) {
      return { reason: 'invalid_private_key_pem', configCaused: true };
    }
    return { reason: 'invalid_service_account_credential', configCaused: true };
  }
  if (code === 'app/invalid-app-options') {
    return { reason: 'firebase_admin_invalid_app_options', configCaused: false };
  }
  if (code.indexOf('app/') === 0) {
    return { reason: 'firebase_admin_initialize_failed', configCaused: false };
  }
  return { reason: 'unknown_initialization_error', configCaused: false };
}

function readConfig(env) {
  const source = env || process.env;
  const projectId = (source[ENV.projectId] || '').trim();
  const clientEmail = (source[ENV.clientEmail] || '').trim();
  const rawKey = source[ENV.privateKey];
  const privateKey = normalisePrivateKey(rawKey);

  if (!projectId) throw new ChatConfigError('missing_project_id');
  if (projectId !== EXPECTED_PROJECT_ID) throw new ChatConfigError('unexpected_project');

  const emailProblem = inspectClientEmailShape(clientEmail);
  if (emailProblem) throw new ChatConfigError(emailProblem);

  /* Distinguish "not set at all" from "set but not a usable PEM". */
  if (typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new ChatConfigError('missing_private_key');
  }
  if (!privateKey) {
    /* normalisePrivateKey refused it: either no PEM markers, or still one
       line because the \n escapes were never applied. */
    throw new ChatConfigError(
      String(rawKey).indexOf('PRIVATE KEY-----') === -1
        ? 'private_key_not_pem'
        : 'private_key_single_line');
  }
  const keyProblem = inspectPrivateKeyShape(privateKey);
  if (keyProblem) throw new ChatConfigError(keyProblem);

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

  /*
   * Each SDK call is wrapped separately so a failure names the STAGE it
   * happened in. Previously all of this was bare, every one of these errors
   * carried the name "Error", and respondToError() did not recognise any of
   * them - so a mistyped credential and a missing module produced the same
   * useless line: "chat: unhandled [chat/start] Error".
   *
   * Nothing is caught and continued. Every branch rethrows.
   */
  /* Already loaded at module scope, or a precise per-module failure. */
  const sdk = (deps && deps.sdk) || loadSdk();

  /* A warm instance may already hold an app from a previous request. */
  const existing = stage('firebase_admin_initialize_failed', false,
    () => sdk.app.getApps());

  let app;
  if (existing && existing.length) {
    app = existing[0];
  } else {
    /* cert() is where a malformed private key is actually rejected: it
       parses the PEM locally, before any network call, which is why a
       broken key shows up with no outgoing request having been made. */
    const credential = stage('invalid_service_account_credential', true, () =>
      sdk.app.cert({
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey
      }));

    app = stage('firebase_admin_initialize_failed', false, () =>
      sdk.app.initializeApp({ credential: credential, projectId: config.projectId }));
  }

  const db = stage('firebase_firestore_initialize_failed', false,
    () => sdk.firestore.getFirestore(app));
  const auth = stage('firebase_auth_initialize_failed', false,
    () => sdk.auth.getAuth(app));

  cached = { app: app, db: db, auth: auth, projectId: config.projectId };
  return cached;
}

/*
 * Run one initialisation step, converting anything it throws into a
 * ChatInitError carrying an allow-listed token.
 *
 * classifyInitError() gets first refusal, because a recognised Firebase code
 * says more than the call site does; fallbackReason is used only when the
 * error is not one the classifier knows.
 */
function stage(fallbackReason, fallbackConfigCaused, fn) {
  try {
    return fn();
  } catch (err) {
    const classified = classifyInitError(err);
    if (classified.reason === 'unknown_initialization_error') {
      throw new ChatInitError(fallbackReason, fallbackConfigCaused);
    }
    throw new ChatInitError(classified.reason, classified.configCaused);
  }
}

/*
 * The server's clock, as a Firestore Timestamp.
 *
 * Kept here so no other file has to reach into the SDK directly, and so a
 * test can substitute a fixed clock without stubbing a module.
 */
function serverNow() {
  if (!sdkFirestore) throw new ChatInitError(sdkLoadFailure || 'firebase_admin_firestore_not_found', false);
  return sdkFirestore.Timestamp.now();
}

/* Tests only: drop the memoised app so a fresh configuration can be read. */
function _reset() { cached = null; }

module.exports = {
  EXPECTED_PROJECT_ID, ENV, DIAGNOSTIC_TOKENS, SHAPE_FIELDS,
  loadSdk, describeRuntime,
  ChatConfigError, ChatInitError,
  normalisePrivateKey, inspectPrivateKeyShape, inspectClientEmailShape,
  describeConfigShape, classifyInitError,
  readConfig, initAdmin, serverNow, _reset
};
