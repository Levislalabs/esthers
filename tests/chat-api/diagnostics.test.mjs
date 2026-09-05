/*
 * Safe production initialisation diagnostics.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * Production answered POST /api/chat/start with 500 server_error and logged
 * only:
 *
 *     chat: unhandled [chat/start] Error
 *
 * which names nothing. Two causes together:
 *
 *   1. firebase-admin's FirebaseAppError does NOT override .name - it is
 *      literally the string "Error" - and the handler logged err.name.
 *   2. respondToError() recognised only this project's own ChatConfigError,
 *      so every error thrown by the SDK during initialisation fell through
 *      to the generic 500 branch.
 *
 * The tests below pin both the classification and, just as importantly, what
 * must NEVER appear in a log line.
 *
 * NO PRODUCTION FIREBASE CONTACT. The only private key here is generated at
 * run time by this file and thrown away; it is a credential for nothing.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import crypto from 'node:crypto';
import { db, handlerFor, makeReq, makeRes, wipe, uuid, anonToken } from './helpers.mjs';

const require = createRequire('/home/user/esthers/');
const FB = require('/home/user/esthers/api/_chat/firebase-admin.js');

const START = '/home/user/esthers/api/chat/start.js';
const CONVERSATIONS = '/home/user/esthers/api/admin/chat/conversations.js';

/* A throwaway keypair, generated here and never stored. Structurally a real
   PEM, so the "valid shape" paths are exercised honestly rather than against
   a hand-written string that only looks right. */
const { privateKey: REAL_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const ESCAPED_PEM = REAL_PEM.replace(/\n/g, '\\n');
const CLIENT_EMAIL = 'chat-api@esther-s-chat.iam.gserviceaccount.com';

const goodEnv = (over = {}) => Object.assign({
  FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY: ESCAPED_PEM,
  CHAT_RATE_LIMIT_SECRET: 'a-test-rate-limit-secret-0123456789'
}, over);

/* Records the SDK calls without contacting anything. */
function fakeSdk(overrides = {}) {
  const calls = [];
  const app = { name: '[FAKE]' };
  return {
    calls,
    sdk: {
      app: {
        getApps: overrides.getApps || (() => []),
        cert: overrides.cert || ((c) => { calls.push('cert'); return { cert: c }; }),
        initializeApp: overrides.initializeApp
          || ((o) => { calls.push('initializeApp'); return app; })
      },
      firestore: { getFirestore: overrides.getFirestore || (() => ({ fake: true })) },
      auth: { getAuth: overrides.getAuth || (() => ({ fake: true })) }
    }
  };
}

/* A stand-in for a firebase-admin FirebaseAppError: note name === 'Error',
   which is the whole reason the production log said nothing. */
function firebaseAppError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.cause = new Error('SECRET-CAUSE-MATERIAL-MUST-NOT-BE-LOGGED');
  return err;
}

/* Async-aware: initAdmin() became asynchronous when the SDK moved to
   literal dynamic import(). */
async function caught(fn) {
  try { await fn(); } catch (err) { return err; }
  assert.fail('expected a throw, got none');
}

/* Captures console.error so a test can assert on the literal log line. */
function captureLog(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then((value) => { console.error = original; return { lines, value }; })
    .catch((err) => { console.error = original; throw err; });
}

beforeEach(() => { FB._reset(); });
afterEach(() => { FB._reset(); });

/* ================================================ THE ROOT CAUSE, PINNED */
describe('the root cause', () => {
  test('a firebase-admin error really does carry the name "Error"', () => {
    const err = firebaseAppError('app/invalid-credential', 'Failed to parse private key.');
    assert.equal(err.name, 'Error',
      'this is why logging err.name produced "chat: unhandled [chat/start] Error"');
  });

  test('an SDK failure is now classified instead of falling through', async () => {
    const admin = fakeSdk({
      cert: () => { throw firebaseAppError('app/invalid-credential', 'Failed to parse private key.'); }
    });
    const err = await caught(() => FB.initAdmin({ env: goodEnv(), sdk: admin.sdk }));
    assert.ok(err instanceof FB.ChatInitError);
    assert.equal(err.reason, 'invalid_private_key_pem');
    assert.equal(err.notConfigured, true, 'a bad key is the environment, so 503');
  });
});

/* ================================================== STRUCTURAL VALIDATION */
describe('structural configuration validation', () => {
  const reasonFor = async (env) => {
    const admin = fakeSdk();
    const err = await caught(() => FB.initAdmin({ env, sdk: admin.sdk }));
    assert.ok(err instanceof FB.ChatConfigError, 'expected a config error');
    assert.equal(admin.calls.length, 0, 'nothing may be initialised');
    return err.reason;
  };

  test('missing project id', async () => {
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PROJECT_ID: '' })), 'missing_project_id');
  });

  test('wrong project id', async () => {
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PROJECT_ID: 'some-other-project' })),
      'unexpected_project');
  });

  test('missing client email', async () => {
    assert.equal(await reasonFor(goodEnv({ FIREBASE_CLIENT_EMAIL: '' })), 'missing_client_email');
  });

  test('malformed client email', async () => {
    for (const bad of ['nope', 'a@b', 'a b@c.com', '@example.com', 'a@', 'a@@b.com']) {
      assert.equal(await reasonFor(goodEnv({ FIREBASE_CLIENT_EMAIL: bad })),
        'invalid_client_email_shape', bad + ' should be refused');
    }
  });

  test('a plain human address is accepted structurally, and flagged in the shape', () => {
    /* Not fatal: Google's service-account domain is not ours to depend on.
       The shape line is where a human address becomes visible. */
    assert.equal(FB.inspectClientEmailShape('ejay@esthers.ca'), null);
    assert.match(FB.describeConfigShape(goodEnv({ FIREBASE_CLIENT_EMAIL: 'ejay@esthers.ca' })),
      /svcacct:0/);
    assert.match(FB.describeConfigShape(goodEnv()), /svcacct:1/);
  });

  test('missing private key', async () => {
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PRIVATE_KEY: '' })), 'missing_private_key');
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PRIVATE_KEY: '   ' })), 'missing_private_key');
  });

  test('a value that is not a PEM at all', async () => {
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PRIVATE_KEY: 'just some text' })),
      'private_key_not_pem');
  });

  test('a PEM whose newlines were never applied', async () => {
    /* The classic Vercel mistake: the value is stored with real BEGIN/END
       markers but as a single line, so crypto cannot parse it. */
    const oneLine = REAL_PEM.replace(/\n/g, ' ');
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PRIVATE_KEY: oneLine })),
      'private_key_single_line');
  });

  test('a truncated PEM - BEGIN present, END missing', async () => {
    const truncated = REAL_PEM.split('\n').slice(0, 4).join('\n') + '\n';
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PRIVATE_KEY: truncated })),
      'private_key_pem_truncated');
  });

  test('a PEM whose body is not base64', async () => {
    const corrupt = '-----BEGIN PRIVATE KEY-----\nNOT valid base64 !!!\n-----END PRIVATE KEY-----\n';
    assert.equal(await reasonFor(goodEnv({ FIREBASE_PRIVATE_KEY: corrupt })),
      'private_key_body_not_base64');
  });

  test('escaped \\n normalisation works, exactly once', () => {
    const normalised = FB.normalisePrivateKey(ESCAPED_PEM);
    assert.equal(normalised, REAL_PEM, 'the escaped form must round-trip to the real PEM');
    assert.equal(normalised.includes('\\n'), false, 'no escape may survive');
    assert.equal(FB.inspectPrivateKeyShape(normalised), null);
    /* Normalising an already-real PEM must not change it. */
    assert.equal(FB.normalisePrivateKey(REAL_PEM), REAL_PEM);
  });

  test('a real-newline PEM works, quoted or not, CRLF or not', () => {
    assert.equal(FB.normalisePrivateKey(REAL_PEM), REAL_PEM);
    assert.equal(FB.normalisePrivateKey('"' + ESCAPED_PEM + '"'), REAL_PEM);
    assert.equal(FB.normalisePrivateKey(REAL_PEM.replace(/\n/g, '\r\n')), REAL_PEM);
    assert.equal(FB.inspectPrivateKeyShape(FB.normalisePrivateKey(REAL_PEM)), null);
  });

  test('a fully valid configuration initialises', async () => {
    const admin = fakeSdk();
    const result = await FB.initAdmin({ env: goodEnv(), sdk: admin.sdk });
    assert.deepEqual(admin.calls, ['cert', 'initializeApp']);
    assert.equal(result.projectId, FB.EXPECTED_PROJECT_ID);
  });
});

/* ================================================== ERROR CLASSIFICATION */
describe('SDK error classification', () => {
  const failAt = async (stage, err) => {
    FB._reset();
    const admin = fakeSdk({ [stage]: () => { throw err; } });
    return caught(() => FB.initAdmin({ env: goodEnv(), sdk: admin.sdk }));
  };

  test('a private-key parse failure', async () => {
    const e = await failAt('cert', firebaseAppError('app/invalid-credential',
      'Failed to parse private key.'));
    assert.equal(e.reason, 'invalid_private_key_pem');
    assert.equal(e.notConfigured, true);
  });

  test('a service-account object missing a field', async () => {
    const e = await failAt('cert', firebaseAppError('app/invalid-credential',
      'Service account object must contain a string "client_email" property.'));
    assert.equal(e.reason, 'invalid_service_account_credential');
    assert.equal(e.notConfigured, true);
  });

  test('a duplicate app is NOT the environment\'s fault', async () => {
    const e = await failAt('initializeApp', firebaseAppError('app/invalid-app-options',
      'An existing app named "[DEFAULT]" already exists'));
    assert.equal(e.reason, 'firebase_admin_invalid_app_options');
    assert.equal(e.notConfigured, false, 'this is our bug, so 500 not 503');
  });

  test('Firestore and Auth name their own stage', async () => {
    assert.equal((await failAt('getFirestore', new Error('boom'))).reason,
      'firebase_firestore_initialize_failed');
    assert.equal((await failAt('getAuth', new Error('boom'))).reason,
      'firebase_auth_initialize_failed');
  });

  test('a missing module is recognised', () => {
    const err = new Error('Cannot find module');
    err.code = 'MODULE_NOT_FOUND';
    assert.equal(FB.classifyInitError(err).reason, 'firebase_admin_module_missing');
    assert.equal(FB.classifyInitError(err).configCaused, false);
  });

  test('an unrecognised failure falls back, it does not invent a token', async () => {
    const e = await failAt('getApps', new Error('something nobody predicted'));
    assert.equal(e.reason, 'firebase_admin_initialize_failed');
    assert.equal(FB.classifyInitError(new Error('x')).reason, 'unknown_initialization_error');
  });

  test('every emitted reason is on the allow-list', async () => {
    const errors = [
      await failAt('cert', firebaseAppError('app/invalid-credential', 'Failed to parse private key.')),
      await failAt('cert', firebaseAppError('app/invalid-credential', 'Service account object')),
      await failAt('initializeApp', firebaseAppError('app/invalid-app-options', 'dup')),
      await failAt('initializeApp', firebaseAppError('app/network-error', 'net')),
      await failAt('getFirestore', new Error('boom')),
      await failAt('getAuth', new Error('boom'))
    ];
    for (const e of errors) {
      assert.ok(FB.DIAGNOSTIC_TOKENS.includes(e.reason), 'not allow-listed: ' + e.reason);
    }
  });

  test('an unvetted reason cannot be smuggled into an error', () => {
    const e = new FB.ChatInitError('; rm -rf / ; leak=' + CLIENT_EMAIL, true);
    assert.equal(e.reason, 'unknown_initialization_error');
    assert.equal(e.message.includes(CLIENT_EMAIL), false);
  });

  test('nothing is caught and continued - every branch rethrows', async () => {
    const admin = fakeSdk({ cert: () => { throw firebaseAppError('app/invalid-credential', 'Failed to parse private key.'); } });
    await assert.rejects(() => FB.initAdmin({ env: goodEnv(), sdk: admin.sdk }));
    /* And nothing was memoised, so the next request re-checks rather than
       serving a half-built app. */
    const admin2 = fakeSdk();
    const ok = await FB.initAdmin({ env: goodEnv(), sdk: admin2.sdk });
    assert.equal(ok.projectId, FB.EXPECTED_PROJECT_ID);
  });
});

/* =============================================== THE SHAPE LINE IS SAFE */
describe('the config shape line', () => {
  test('it is nothing but fixed field names and 0/1', () => {
    const shape = FB.describeConfigShape(goodEnv());
    assert.match(shape, /^[a-z_]+:[01](,[a-z_]+:[01])*$/,
      'no other character may ever appear: ' + shape);
    for (const field of FB.SHAPE_FIELDS) assert.ok(shape.includes(field + ':'));
  });

  test('it contains no part of any value', () => {
    const shape = FB.describeConfigShape(goodEnv());
    const body = REAL_PEM.split('\n')[1];
    for (const secret of [REAL_PEM, ESCAPED_PEM, body, body.slice(0, 12),
      CLIENT_EMAIL, 'esther-s-chat', 'a-test-rate-limit-secret-0123456789',
      'gserviceaccount', 'BEGIN']) {
      assert.equal(shape.includes(secret), false, 'shape leaked: ' + secret.slice(0, 16));
    }
  });

  test('it discloses no length or count', () => {
    const long = FB.describeConfigShape(goodEnv());
    const short = FB.describeConfigShape(goodEnv({
      FIREBASE_PRIVATE_KEY: ESCAPED_PEM, FIREBASE_CLIENT_EMAIL: 'a@b.co' }));
    assert.equal(long.replace(/svcacct:1/, 'svcacct:0'), short,
      'only the boolean flags may differ, never a size');
    assert.equal(/[2-9]/.test(long), false, 'no digit other than 0 or 1');
  });

  test('it actually distinguishes the failure modes', () => {
    assert.match(FB.describeConfigShape(goodEnv()), /key_body:1/);
    assert.match(FB.describeConfigShape(goodEnv({ FIREBASE_PRIVATE_KEY: '' })),
      /key:0,key_begin:0/);
    assert.match(FB.describeConfigShape(goodEnv({
      FIREBASE_PRIVATE_KEY: REAL_PEM.replace(/\n/g, ' ') })), /key:1,key_begin:0/);
    assert.match(FB.describeConfigShape(goodEnv({
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nnot base64 !!\n-----END PRIVATE KEY-----\n' })),
      /key_begin:1,key_end:1,key_multiline:1,key_body:0/);
    assert.match(FB.describeConfigShape(goodEnv({ FIREBASE_PROJECT_ID: 'wrong' })), /pid:1,pid_ok:0/);
    assert.match(FB.describeConfigShape(goodEnv({ CHAT_RATE_LIMIT_SECRET: 'short' })), /secret:0/);
  });
});

/* ============================================ END-TO-END THROUGH A ROUTE */
describe('what a production request actually gets', () => {
  /* A handler built with a REAL initAdmin over a fake SDK, so the whole
     path - gate order, classification, response, log line - is exercised. */
  function routeWith(env, sdkOverrides) {
    const mod = require(START);
    const admin = fakeSdk(sdkOverrides);
    return mod.forTest({
      initAdmin: () => FB.initAdmin({ env, sdk: admin.sdk }),
      verifyIdToken: async () => { throw new Error('should never be reached'); },
      env: env
    });
  }

  async function callNoAuth(handler, method = 'POST') {
    const req = makeReq({ method });
    delete req.headers.authorization;
    delete req.headers.origin;
    const res = makeRes();
    await handler(req, res);
    return res;
  }

  test('a broken private key -> 503 not_configured, with a real diagnostic', async () => {
    const handler = routeWith(goodEnv(), {
      cert: () => { throw firebaseAppError('app/invalid-credential', 'Failed to parse private key.'); }
    });
    const { lines, value: res } = await captureLog(() => callNoAuth(handler));

    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, 'not_configured');
    assert.equal(res.payload.error, 'Online messaging is temporarily unavailable.');
    assert.equal(res.payload.notConfigured, true);

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^chat: not configured \[chat\/start\] invalid_private_key_pem shape=/);
    assert.equal(lines[0].includes('unhandled'), false,
      'this is exactly the line that used to say only "Error"');
  });

  test('missing project id -> 503 and a structural token', async () => {
    const handler = routeWith(goodEnv({ FIREBASE_PROJECT_ID: '' }));
    const { lines, value: res } = await captureLog(() => callNoAuth(handler));
    assert.equal(res.statusCode, 503);
    assert.match(lines[0], /missing_project_id shape=pid:0,pid_ok:0/);
  });

  test('missing rate-limit secret -> 503 on the mutating route', async () => {
    const handler = routeWith(goodEnv({ CHAT_RATE_LIMIT_SECRET: undefined }));
    const { lines, value: res } = await captureLog(() => callNoAuth(handler));
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, 'not_configured');
    assert.match(lines[0], /missing_rate_limit_secret shape=/);
    assert.match(lines[0], /secret:0/);
  });

  test('a NON-config init failure stays 500, with a stage token', async () => {
    const handler = routeWith(goodEnv(), {
      getFirestore: () => { throw new Error('firestore exploded'); }
    });
    const { lines, value: res } = await captureLog(() => callNoAuth(handler));
    assert.equal(res.statusCode, 500);
    assert.equal(res.payload.code, 'server_error');
    assert.match(lines[0], /^chat: init failed \[chat\/start\] firebase_firestore_initialize_failed/);
    assert.equal(lines[0].includes('firestore exploded'), false);
  });

  test('an unknown runtime fault stays 500 with an allow-listed token', async () => {
    const mod = require(START);
    const handler = mod.forTest({
      initAdmin: () => { const e = new TypeError('x is not a function'); throw e; },
      verifyIdToken: async () => ({}), env: goodEnv()
    });
    const { lines, value: res } = await captureLog(() => callNoAuth(handler));
    assert.equal(res.statusCode, 500);
    assert.equal(res.payload.code, 'server_error');
    assert.match(lines[0], /^chat: unhandled \[chat\/start\] runtime_type_error runtime=/);
    assert.equal(lines[0].includes('is not a function'), false, 'no message may leak');
  });

  test('A CORRECT CONFIGURATION REACHES 401 missing_authorization', async () => {
    /* The point of the whole exercise: with the environment right, an
       unauthenticated probe must get past every configuration gate and be
       refused by authentication instead. */
    const handler = routeWith(goodEnv());
    const { lines, value: res } = await captureLog(() => callNoAuth(handler));
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'missing_authorization');
    assert.equal(res.payload.error, 'Sign-in is required.');
    assert.deepEqual(lines, [], 'a healthy refusal logs nothing at all');
  });

  test('a wrong method is still 405, before any of this', async () => {
    const handler = routeWith(goodEnv());
    const res = await callNoAuth(handler, 'GET');
    assert.equal(res.statusCode, 405);
  });
});

/* ================================================= NOTHING SENSITIVE LOGS */
describe('no diagnostic ever contains anything sensitive', () => {
  test('not the private key, its body, its escaped form, or the email', async () => {
    const handler = (() => {
      const mod = require(START);
      const admin = fakeSdk({
        cert: () => { throw firebaseAppError('app/invalid-credential',
          'Failed to parse private key: ' + REAL_PEM); }
      });
      return mod.forTest({
        initAdmin: () => FB.initAdmin({ env: goodEnv(), sdk: admin.sdk }),
        verifyIdToken: async () => ({}), env: goodEnv()
      });
    })();

    const req = makeReq({ method: 'POST', ip: '203.0.113.42',
      body: { name: 'Jordan Ellis', email: 'jordan@example.test',
        message: 'a private message body', clientMessageId: uuid() },
      headers: { authorization: 'Bearer a.fake.id.token' } });
    const res = makeRes();
    const { lines } = await captureLog(() => handler(req, res));

    const all = lines.join('\n');
    const body = REAL_PEM.split('\n')[1];
    for (const secret of [
      REAL_PEM, ESCAPED_PEM, body, body.slice(0, 20), 'BEGIN PRIVATE KEY',
      CLIENT_EMAIL, 'gserviceaccount', 'jordan@example.test', 'Jordan Ellis',
      'a private message body', 'a.fake.id.token', 'Bearer', '203.0.113.42',
      'a-test-rate-limit-secret-0123456789', 'SECRET-CAUSE-MATERIAL'
    ]) {
      assert.equal(all.includes(secret), false,
        'LEAKED into the log: ' + secret.slice(0, 24));
    }
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.stringify(res.payload).includes('PRIVATE KEY'), false);
  });

  test('no console.error in the chat API interpolates raw error data', () => {
    /* Scoped to the LOGGING statements on purpose. handler.js does pass
       err.message to H.fail() for AuthError, ValidationError and
       ServiceError - but those are this project's own classes carrying
       hand-written customer sentences ("Sign-in is required."), which are
       meant to be shown. What must never happen is an arbitrary error's
       message, stack or cause reaching a LOG. */
    const fs = require('fs');
    const forbidden = ['.message', '.stack', '.cause', 'JSON.stringify',
      'String(err', 'err.name', 'inspect('];
    const files = ['handler.js', 'firebase-admin.js', 'service.js', 'auth.js',
      'rate-limit.js', 'validation.js', 'http.js'];

    let checked = 0;
    for (const name of files) {
      const source = fs.readFileSync('/home/user/esthers/api/_chat/' + name, 'utf8');
      /* Every console.* call, including ones spanning two lines. */
      const calls = source.match(/console\.[a-z]+\([\s\S]{0,400}?\);/g) || [];
      for (const call of calls) {
        checked += 1;
        for (const bad of forbidden) {
          assert.equal(call.includes(bad), false,
            name + ' logs raw error data (' + bad + '): ' + call.slice(0, 120));
        }
      }
    }
    assert.ok(checked >= 3, 'expected to have inspected some log calls, saw ' + checked);

    const handler = fs.readFileSync('/home/user/esthers/api/_chat/handler.js', 'utf8');
    assert.ok(handler.includes('classifyRuntimeError'),
      'the runtime path must go through the allow-list');
    assert.ok(handler.includes('safeReason'), 'the config path must too');
  });

  test('ChatInitError does not carry the originating error along', async () => {
    const admin = fakeSdk({
      cert: () => { throw firebaseAppError('app/invalid-credential', 'Failed to parse private key.'); }
    });
    const err = await caught(() => FB.initAdmin({ env: goodEnv(), sdk: admin.sdk }));
    assert.equal(err.cause, undefined, 'a cause chain is what gets stringified later');
    assert.equal(err.original, undefined);
    assert.equal(String(err.stack).includes('SECRET-CAUSE-MATERIAL'), false);
  });

  test('the 503 body still says nothing about the deployment', async () => {
    const handler = (() => {
      const mod = require(START);
      return mod.forTest({
        initAdmin: () => FB.initAdmin({ env: goodEnv({ FIREBASE_PROJECT_ID: 'wrong' }),
          sdk: fakeSdk().sdk }),
        verifyIdToken: async () => ({}), env: goodEnv()
      });
    })();
    const req = makeReq({ method: 'POST' });
    delete req.headers.authorization;
    const res = makeRes();
    await captureLog(() => handler(req, res));
    const payload = JSON.stringify(res.payload);
    for (const leak of ['esther-s-chat', 'FIREBASE', 'unexpected_project', 'shape=']) {
      assert.equal(payload.includes(leak), false, 'response leaked ' + leak);
    }
  });
});

/* ================================== THE STAFF ROUTE BEHAVES THE SAME WAY */
describe('the staff route is diagnosed identically', () => {
  test('a broken key gives 503 there too, and a correct one gives 401', async () => {
    const mod = require(CONVERSATIONS);
    const broken = mod.forTest({
      initAdmin: () => FB.initAdmin({ env: goodEnv(), sdk: fakeSdk({
        cert: () => { throw firebaseAppError('app/invalid-credential', 'Failed to parse private key.'); }
      }).sdk }),
      verifyIdToken: async () => ({}), env: goodEnv()
    });
    const req1 = makeReq({ method: 'GET' });
    delete req1.headers.authorization;
    const res1 = makeRes();
    const { lines } = await captureLog(() => broken(req1, res1));
    assert.equal(res1.statusCode, 503);
    assert.match(lines[0], /\[admin\/chat\/conversations\] invalid_private_key_pem/);

    FB._reset();
    const healthy = mod.forTest({
      initAdmin: () => FB.initAdmin({ env: goodEnv(), sdk: fakeSdk().sdk }),
      verifyIdToken: async () => { throw new Error('unreachable'); }, env: goodEnv()
    });
    const req2 = makeReq({ method: 'GET' });
    delete req2.headers.authorization;
    const res2 = makeRes();
    await healthy(req2, res2);
    assert.equal(res2.statusCode, 401);
    assert.equal(res2.payload.code, 'missing_authorization');
  });
});

/* ============================================ NO PRODUCTION DATA WRITTEN */
describe('diagnostics write nothing', () => {
  test('none of these paths creates a document', async () => {
    await wipe();
    const mod = require(START);
    for (const env of [goodEnv(), goodEnv({ FIREBASE_PROJECT_ID: '' }),
      goodEnv({ CHAT_RATE_LIMIT_SECRET: undefined })]) {
      FB._reset();
      const handler = mod.forTest({
        initAdmin: () => ({ db: db(), auth: null, app: null, projectId: 'demo' }),
        verifyIdToken: async () => { throw new Error('no'); },
        env: env
      });
      const req = makeReq({ method: 'POST' });
      delete req.headers.authorization;
      await captureLog(() => handler(req, makeRes()));
    }
    assert.equal((await db().collection('chatConversations').get()).size, 0);
    assert.equal((await db().collection('chatMessages').get()).size, 0);
    assert.equal((await db().collection('chatRateLimits').get()).size, 0);
  });
});
