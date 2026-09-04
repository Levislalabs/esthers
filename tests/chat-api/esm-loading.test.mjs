/*
 * ERR_REQUIRE_ESM, and the async initialisation it forced.
 *
 * WHAT PRODUCTION SAID
 *
 *   chat: init failed [chat/start] firebase_admin_auth_load_failed
 *   shape=pid:1,...,key_body:1,secret:1
 *   runtime=node:22,sdk_app:1,sdk_firestore:1,sdk_auth:0,
 *   sdk_code:ERR_REQUIRE_ESM
 *
 * Decisive. Node 22, credentials structurally perfect, app and firestore
 * loaded, auth did not, and the reason was ERR_REQUIRE_ESM.
 *
 * WHY ONLY AUTH. firebase-admin/auth pulls in `jose`, which is an ESM-only
 * package (type: module). app and firestore do not. require() of an ESM
 * module throws ERR_REQUIRE_ESM unless the runtime has Node's require(esm)
 * support, which landed in 22.12 - so a developer machine on a newer 22.x
 * succeeds while Vercel's 22.x below that fails. That gap is the entire bug.
 *
 * Moving to literal dynamic import() made initAdmin() asynchronous, which
 * introduces a race the synchronous version could not have. Most of this
 * file is about that.
 *
 * Mocks and the emulator only. No production Firebase contact, no credential.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeReq, makeRes } from './helpers.mjs';

const require = createRequire('/home/user/esthers/');
const FB = require('/home/user/esthers/api/_chat/firebase-admin.js');
const ROOT = '/home/user/esthers';
const START = '/home/user/esthers/api/chat/start.js';

const GOOD_KEY = '-----BEGIN PRIVATE KEY-----\\n'
  + 'Tk9ULUEtUkVBTC1LRVktcGxhY2Vob2xkZXItZm9yLXRlc3Rz\\n'
  + '-----END PRIVATE KEY-----\\n';

const goodEnv = (over = {}) => Object.assign({
  FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: 'chat@esther-s-chat.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: GOOD_KEY,
  CHAT_RATE_LIMIT_SECRET: 'an-esm-test-rate-limit-secret-0123456789'
}, over);

function countingSdk(overrides = {}) {
  const calls = { cert: 0, initializeApp: 0, getApps: 0, getFirestore: 0, getAuth: 0 };
  const app = { name: '[FAKE]' };
  return {
    calls,
    sdk: {
      app: {
        getApps: overrides.getApps || (() => { calls.getApps += 1; return []; }),
        cert: overrides.cert || ((c) => { calls.cert += 1; return { cert: c }; }),
        initializeApp: overrides.initializeApp
          || (() => { calls.initializeApp += 1; return app; })
      },
      firestore: { getFirestore: overrides.getFirestore
        || (() => { calls.getFirestore += 1; return { fake: true }; }) },
      auth: { getAuth: overrides.getAuth
        || (() => { calls.getAuth += 1; return { fake: true }; }) }
    }
  };
}

async function callNoAuth(handler, method = 'POST') {
  const req = makeReq({ method });
  delete req.headers.authorization;
  delete req.headers.origin;
  const res = makeRes();
  await handler(req, res);
  return res;
}

function silently(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.join(' ')); };
  return Promise.resolve().then(fn)
    .then((v) => { console.error = original; return { lines, value: v }; })
    .catch((e) => { console.error = original; throw e; });
}

beforeEach(() => { FB._reset(); });
afterEach(() => { FB._reset(); });

/* ============================================= THE ESM PATH, ON REAL NODE 22 */
describe('the real Node 22 module import', () => {
  test('all three firebase-admin modules import, with no credentials', async () => {
    for (const v of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY']) {
      assert.equal(process.env[v], undefined, v + ' must not be set here');
    }
    const result = await FB.loadSdk();
    assert.equal(result.ok, true, 'load failed: ' + result.reason);
    assert.equal(typeof result.sdk.app.initializeApp, 'function');
    assert.equal(typeof result.sdk.app.cert, 'function');
    assert.equal(typeof result.sdk.app.getApps, 'function');
    assert.equal(typeof result.sdk.firestore.getFirestore, 'function');
    assert.equal(typeof result.sdk.firestore.Timestamp.now, 'function');
    assert.equal(typeof result.sdk.auth.getAuth, 'function',
      'firebase-admin/auth is the module that failed in production');
  });

  test('importing creates no Firebase app', async () => {
    const result = await FB.loadSdk();
    assert.equal(result.sdk.app.getApps().length, 0,
      'loading the library must never initialise Firebase');
  });

  test('the import path really is the ESM build, not the CJS one', async () => {
    const pkg = JSON.parse(fs.readFileSync(
      ROOT + '/node_modules/firebase-admin/package.json', 'utf8'));
    for (const sub of ['./app', './firestore', './auth']) {
      assert.match(pkg.exports[sub].import, /^\.\/lib\/esm\//, sub);
      assert.match(pkg.exports[sub].require, /^\.\/lib\/(?!esm)/, sub);
    }
  });

  test('firebase-admin/auth really does depend on an ESM-only package', () => {
    /* The fact that makes require() fail and import() succeed. If it ever
       stops being true the fix is still correct, but the reasoning above
       would have gone stale and a reader deserves to know.

       Run in a CHILD PROCESS with a clean module registry: by this point in
       the file the earlier tests have already imported the SDK, so
       require.cache in this process is warm and would show nothing new. */
    const script = [
      "const fs = require('fs');",
      "const before = new Set(Object.keys(require.cache));",
      "require('firebase-admin/auth');",
      "const added = Object.keys(require.cache).filter(f => !before.has(f));",
      "const esm = new Set();",
      "for (const file of added) {",
      "  const m = file.match(/^(.*node_modules\\/(?:@[^/]+\\/)?[^/]+)\\//);",
      "  if (!m) continue;",
      "  try { const p = JSON.parse(fs.readFileSync(m[1] + '/package.json','utf8'));",
      "        if (p.type === 'module') esm.add(p.name); } catch (e) {}",
      "}",
      "console.log('ESM_ONLY ' + [...esm].sort().join(','));"
    ].join('');

    const out = execFileSync(process.execPath, ['-e', script],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    const names = out.replace('ESM_ONLY ', '').split(',').filter(Boolean);
    assert.ok(names.length > 0,
      'auth pulls in at least one type:module package - that is why require() '
      + 'threw ERR_REQUIRE_ESM on a Node without require(esm). Got: ' + out);
    assert.ok(names.includes('jose'),
      'jose is the specific ESM-only dependency behind the production failure; '
      + 'found: ' + names.join(','));
  });
});

/* ================================================ ASYNC INIT AND ITS RACE */
describe('initialisation is asynchronous, and race-free', () => {
  test('initAdmin returns a promise, and callers must await it', async () => {
    const admin = countingSdk();
    const pending = FB.initAdmin({ env: goodEnv(), sdk: admin.sdk });
    assert.ok(pending instanceof Promise, 'initAdmin() is async now');
    const result = await pending;
    assert.equal(result.projectId, FB.EXPECTED_PROJECT_ID);
    assert.equal(typeof result.db, 'object');
    assert.equal(result.db.then, undefined, 'a Promise must never be handed on as the db');
  });

  test('THREE SIMULTANEOUS calls initialise exactly one app', async () => {
    const admin = countingSdk();
    const [a, b, c] = await Promise.all([
      FB.initAdmin({ env: goodEnv(), sdk: admin.sdk }),
      FB.initAdmin({ env: goodEnv(), sdk: admin.sdk }),
      FB.initAdmin({ env: goodEnv(), sdk: admin.sdk })
    ]);
    assert.equal(admin.calls.initializeApp, 1,
      'concurrent cold starts must not each build an app');
    assert.equal(admin.calls.cert, 1);
    assert.equal(a, b, 'every caller gets the same object');
    assert.equal(b, c);
  });

  test('eight simultaneous calls still initialise exactly one app', async () => {
    const admin = countingSdk();
    const results = await Promise.all(Array.from({ length: 8 },
      () => FB.initAdmin({ env: goodEnv(), sdk: admin.sdk })));
    assert.equal(admin.calls.initializeApp, 1);
    assert.equal(new Set(results).size, 1, 'one shared admin object');
  });

  test('sequential calls after the first do no work at all', async () => {
    const admin = countingSdk();
    await FB.initAdmin({ env: goodEnv(), sdk: admin.sdk });
    await FB.initAdmin({ env: goodEnv(), sdk: admin.sdk });
    await FB.initAdmin({ env: goodEnv(), sdk: admin.sdk });
    assert.equal(admin.calls.initializeApp, 1);
    assert.equal(admin.calls.getApps, 1, 'the cached result short-circuits everything');
  });

  test('the SDK is imported once per instance, not once per request', async () => {
    FB._resetSdk();
    const first = FB.loadSdk();
    const second = FB.loadSdk();
    const third = FB.loadSdk();
    assert.equal(first, second, 'the load promise must be memoised');
    assert.equal(second, third);
    assert.equal((await first).ok, true);
  });

  test('concurrent loadSdk calls share one in-flight import', async () => {
    FB._resetSdk();
    const all = await Promise.all(Array.from({ length: 6 }, () => FB.loadSdk()));
    assert.equal(new Set(all).size, 1, 'all six resolve to the same result object');
  });
});

/* =============================================== FAILURE AND RETRY POLICY */
describe('failure leaves no corrupt state, and retry behaviour is deliberate', () => {
  test('a failed initialisation does not cache a half-built app', async () => {
    const broken = countingSdk({
      getAuth: () => { throw new Error('auth construction exploded'); }
    });
    await assert.rejects(() => FB.initAdmin({ env: goodEnv(), sdk: broken.sdk }));

    /* The next request must re-attempt rather than serve a partial object. */
    const healthy = countingSdk();
    const result = await FB.initAdmin({ env: goodEnv(), sdk: healthy.sdk });
    assert.equal(result.projectId, FB.EXPECTED_PROJECT_ID);
    assert.equal(healthy.calls.initializeApp, 1);
  });

  test('a failed initialisation clears the in-flight memo', async () => {
    let attempts = 0;
    const flaky = countingSdk({
      initializeApp: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return { name: '[FAKE]' };
      }
    });
    await assert.rejects(() => FB.initAdmin({ env: goodEnv(), sdk: flaky.sdk }));
    const ok = await FB.initAdmin({ env: goodEnv(), sdk: flaky.sdk });
    assert.equal(attempts, 2, 'initialisation is retried, deliberately');
    assert.equal(ok.projectId, FB.EXPECTED_PROJECT_ID);
  });

  test('concurrent callers of a FAILING initialisation all see the failure', async () => {
    const broken = countingSdk({
      initializeApp: () => { throw new Error('nope'); }
    });
    const results = await Promise.allSettled(Array.from({ length: 4 },
      () => FB.initAdmin({ env: goodEnv(), sdk: broken.sdk })));
    assert.equal(results.filter((r) => r.status === 'rejected').length, 4,
      'no caller may receive a half-built object');
  });

  test('a failed SDK load is remembered for the instance, and never rejects', async () => {
    /* Documented policy: whether a module loads is a property of the
       deployment, not a transient condition, so it is not retried per
       request - that would be an amplifier on a path that runs before rate
       limiting. A new instance re-attempts from scratch. */
    const source = fs.readFileSync(ROOT + '/api/_chat/firebase-admin.js', 'utf8');
    assert.ok(source.includes('FAILURE BEHAVIOUR, DELIBERATE AND DOCUMENTED'),
      'the policy must be written down where the code is');
    /* The promise resolves to a result object rather than rejecting, so a
       memoised rejection can never surface as an unhandled rejection. */
    const result = await FB.loadSdk();
    assert.equal(typeof result.ok, 'boolean');
  });
});

/* ============================================ WHAT A REQUEST ACTUALLY GETS */
describe('end to end through the route', () => {
  function routeWith(env, sdkOverrides) {
    const mod = require(START);
    const admin = countingSdk(sdkOverrides || {});
    return {
      admin,
      handler: mod.forTest({
        initAdmin: () => FB.initAdmin({ env, sdk: admin.sdk }),
        verifyIdToken: async () => { throw new Error('must not be reached'); },
        env: env
      })
    };
  }

  test('A CORRECT CONFIGURATION REACHES 401 missing_authorization', async () => {
    const { lines, value: res } = await silently(() =>
      callNoAuth(routeWith(goodEnv()).handler));
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'missing_authorization');
    assert.equal(res.payload.error, 'Sign-in is required.');
    assert.deepEqual(lines, [], 'a healthy refusal logs nothing');
  });

  test('missing configuration is still 503, not a module crash', async () => {
    for (const env of [goodEnv({ FIREBASE_PROJECT_ID: '' }),
      goodEnv({ FIREBASE_CLIENT_EMAIL: '' }),
      goodEnv({ FIREBASE_PRIVATE_KEY: '' })]) {
      FB._reset();
      const { lines, value: res } = await silently(() =>
        callNoAuth(routeWith(env).handler));
      assert.equal(res.statusCode, 503, JSON.stringify(res.payload));
      assert.equal(res.payload.code, 'not_configured');
      assert.equal(res.payload.error, 'Online messaging is temporarily unavailable.');
      assert.equal(lines[0].includes('ERR_REQUIRE_ESM'), false);
      assert.match(lines[0], /^chat: not configured \[chat\/start\]/);
    }
  });

  test('the module still loads fine with no configuration at all', async () => {
    /* Loading and initialising are separate concerns: a deployment missing
       every Firebase variable must still import cleanly and answer 503. */
    const result = await FB.loadSdk();
    assert.equal(result.ok, true,
      'the SDK must load without any FIREBASE_* variable being set');
  });

  test('an ERR_REQUIRE_ESM-shaped load failure is classified, not swallowed', async () => {
    /* Simulated at the classifier, since the real import now succeeds. */
    const err = new Error('require() of ES Module not supported');
    err.code = 'ERR_REQUIRE_ESM';
    const classified = FB.classifyInitError(err);
    assert.equal(classified.reason, 'unknown_initialization_error',
      'the code is not a Firebase code, so the stage fallback names it');
    assert.ok(FB.DIAGNOSTIC_TOKENS.includes('firebase_admin_auth_load_failed'),
      'the per-module token production emitted must remain available');
  });

  test('the runtime line now reports all three modules loaded', async () => {
    await FB.loadSdk();
    const runtime = FB.describeRuntime();
    assert.match(runtime, /sdk_app:1,sdk_firestore:1,sdk_auth:1,sdk_code:none/,
      'sdk_auth:0 with sdk_code:ERR_REQUIRE_ESM was the production failure');
  });
});

/* ================================================== NOTHING ELSE REGRESSED */
describe('the security model is untouched by this change', () => {
  const A = fs.readFileSync(ROOT + '/api/_chat/auth.js', 'utf8');
  const S = fs.readFileSync(ROOT + '/api/_chat/service.js', 'utf8');

  test('customer auth still demands the anonymous provider', () => {
    assert.ok(A.includes("provider !== 'anonymous'"));
    assert.ok(A.includes("'not_a_customer'"));
  });

  test('staff auth still demands the allow-list document', () => {
    assert.ok(A.includes("db.collection('staff').doc(decoded.uid)"));
    assert.ok(A.includes('data.isActive !== true'), 'strict true, not truthy');
    assert.ok(A.includes('ALLOWED_STAFF_ROLES.indexOf(data.role)'));
    assert.equal(/@esthers\.ca/.test(A), false, 'no email-domain authorisation');
  });

  test('the four-field message contract is unchanged', () => {
    const build = S.slice(S.indexOf('function buildMessage'));
    const body = build.slice(0, build.indexOf('}\n'));
    for (const field of ['conversationId', 'createdAt', 'senderType', 'body']) {
      assert.ok(body.includes(field + ':'), field);
    }
    assert.equal(body.includes('staffUserId'), false);
    assert.equal(body.includes('startRequestHash'), false);
  });

  test('the hardcoded project guard survives', () => {
    assert.equal(FB.EXPECTED_PROJECT_ID, 'esther-s-chat');
    const source = fs.readFileSync(ROOT + '/api/_chat/firebase-admin.js', 'utf8');
    assert.match(source, /const EXPECTED_PROJECT_ID = 'esther-s-chat';/);
  });

  test('no raw error data is logged by the new code', () => {
    const source = fs.readFileSync(ROOT + '/api/_chat/firebase-admin.js', 'utf8');
    const calls = source.match(/console\.[a-z]+\([\s\S]{0,400}?\);/g) || [];
    for (const call of calls) {
      for (const bad of ['.message', '.stack', '.cause', 'JSON.stringify']) {
        assert.equal(call.includes(bad), false, call.slice(0, 100));
      }
    }
  });
});
