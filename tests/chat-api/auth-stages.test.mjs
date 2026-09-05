/*
 * Stage diagnostics for AUTHENTICATED requests.
 *
 * WHERE THIS CAME FROM
 *
 * The unauthenticated probe now reaches 401 cleanly, so the function loads,
 * the SDK loads and the configuration is valid. The first authenticated
 * request then produced:
 *
 *     chat: unhandled [chat/start] unknown_error
 *
 * with "External APIs: No outgoing requests".
 *
 * An authenticated /api/chat/start passes through token verification, a
 * provider check, an idempotency read, two rate-limit transactions and a
 * write transaction. One word - unknown_error - cannot tell those apart, and
 * the next production test must not spend itself learning nothing again.
 *
 * These tests pin: which stage each failure reports, that expected auth
 * failures stay 4xx while genuine server faults become 5xx, and that no
 * token, email, name, message or address can reach a log.
 *
 * Mocks and the emulator only. No production Firebase contact.
 */

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import {
  db, makeReq, makeRes, wipe, uuid, anonToken, passwordToken, seedStaff,
  firebaseAuthError, RATE_SECRET
} from './helpers.mjs';

const require = createRequire('/home/user/esthers/');
const ROOT = '/home/user/esthers';
const STAGES = require('/home/user/esthers/api/_chat/stages.js');
const AUTH = require('/home/user/esthers/api/_chat/auth.js');
const FB = require('/home/user/esthers/api/_chat/firebase-admin.js');
const START = '/home/user/esthers/api/chat/start.js';

/* Sentinels. If any of these ever reaches a log line, the test fails. */
const FAKE_TOKEN = 'SUPER_SECRET_FAKE_ID_TOKEN_DO_NOT_LOG';
const FAKE_EMAIL = 'do-not-log-me@example.test';
const FAKE_NAME = 'Sentinel Customer Name';
const FAKE_MESSAGE = 'SENTINEL_MESSAGE_BODY_MUST_NOT_APPEAR';
const FAKE_IP = '198.51.100.231';
const CUST = 'anon-stage-1';

const goodBody = () => ({
  name: FAKE_NAME, email: FAKE_EMAIL,
  message: FAKE_MESSAGE, clientMessageId: uuid()
});

/* Builds the real handler with injected dependencies, so the whole pipeline
   runs: gates, auth, stages, the real error classification. */
function route(opts = {}) {
  const mod = require(START);
  return mod.forTest({
    initAdmin: () => ({
      db: opts.db || db(), auth: null, app: null, projectId: 'demo' }),
    verifyIdToken: opts.verifyIdToken
      || (async (token) => {
        if (token !== FAKE_TOKEN) throw firebaseAuthError('auth/argument-error');
        return anonToken(CUST);
      }),
    env: Object.assign({ CHAT_RATE_LIMIT_SECRET: RATE_SECRET }, opts.env || {}),
    now: opts.now
  });
}

async function call(handler, over = {}) {
  const req = makeReq(Object.assign({
    method: 'POST', body: goodBody(), ip: FAKE_IP,
    headers: { authorization: 'Bearer ' + FAKE_TOKEN, host: 'www.esthers.ca' }
  }, over));
  if (over.noAuth) delete req.headers.authorization;
  const res = makeRes();
  const lines = [];
  const original = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await handler(req, res); } finally { console.error = original; }
  return { res, lines, log: lines.join('\n') };
}

/* A Firestore stand-in whose chosen operation explodes. */
function brokenDb(which, err) {
  const real = db();
  const boom = () => { throw err; };
  return {
    collection(name) {
      const c = real.collection(name);
      if (which === 'get') {
        return { doc: (id) => ({ get: boom, id: id }) };
      }
      return c;
    },
    runTransaction(fn) {
      if (which === 'transaction') return Promise.reject(err);
      return real.runTransaction(fn);
    }
  };
}

/*
 * Load the SDK for real, once.
 *
 * These handlers inject initAdmin (to reach the emulator) but NOT `now`, so
 * the production serverNow() runs - and that reads the Timestamp class off
 * the module the SDK loader populates. Without this the real clock path is
 * never exercised anywhere in the suite, which is precisely the sort of gap
 * that only shows up in production.
 */
before(async () => {
  const loaded = await FB.loadSdk();
  assert.equal(loaded.ok, true, 'the SDK must load: ' + loaded.reason);
});

beforeEach(async () => { await wipe(); });
afterEach(async () => { await wipe(); });

/* ============================================== THE ALLOW-LIST ITSELF */
describe('the stage vocabulary', () => {
  test('every stage is a fixed constant, never derived from a request', () => {
    for (const s of STAGES.STAGES) {
      assert.match(s, /^[a-z_]+$/, 'stages must be plain lowercase tokens: ' + s);
    }
    assert.ok(STAGES.STAGES.includes('auth_token_verify_failed'));
    assert.ok(STAGES.STAGES.includes('auth_token_verify_internal_error'));
    assert.ok(STAGES.STAGES.includes('chat_start_transaction_failed'));
    assert.ok(STAGES.STAGES.includes('unknown_authenticated_error'));
  });

  test('an unvetted stage cannot be smuggled in', () => {
    const err = STAGES.tagStage(new Error('x'), 'leak=' + FAKE_TOKEN);
    assert.equal(err.chatStage, 'unknown_authenticated_error');
    assert.equal(STAGES.stageOf(err), 'unknown_authenticated_error');
    assert.equal(String(err.chatStage).includes(FAKE_TOKEN), false);
  });

  test('the first stage wins - an inner label is not overwritten', () => {
    const err = STAGES.tagStage(new Error('x'), 'chat_start_transaction_failed');
    STAGES.tagStage(err, 'unknown_authenticated_error');
    assert.equal(err.chatStage, 'chat_start_transaction_failed',
      'the specific inner stage is the useful one');
  });

  test('runStage rethrows - it never swallows or converts', async () => {
    const original = new Error('boom');
    await assert.rejects(
      () => STAGES.runStage('chat_start_transaction_failed', () => { throw original; }),
      (err) => err === original && err.chatStage === 'chat_start_transaction_failed');
  });

  test('tagging a frozen error does not itself throw', () => {
    const frozen = Object.freeze(new Error('frozen'));
    assert.doesNotThrow(() => STAGES.tagStage(frozen, 'firestore_operation_failed'));
  });
});

/* ================== EXPECTED AUTH FAILURES STAY 4xx, FAULTS BECOME 5xx */
describe('a bad token and a broken verifier are told apart', () => {
  test('missing Authorization -> 401, unchanged', async () => {
    const { res } = await call(route(), { noAuth: true });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'missing_authorization');
  });

  test('malformed bearer -> 401, unchanged', async () => {
    const { res } = await call(route(), { headers: { authorization: 'Token abc' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'bad_authorization');
  });

  for (const code of AUTH.CLIENT_TOKEN_ERROR_CODES) {
    test('a Firebase "' + code + '" stays a 401', async () => {
      const handler = route({
        verifyIdToken: async () => { throw firebaseAuthError(code); } });
      const { res, log } = await call(handler);
      assert.equal(res.statusCode, 401, code);
      assert.equal(res.payload.code, 'invalid_token');
      assert.equal(log, '', 'an ordinary bad token is not a server incident');
    });
  }

  test('an expired token is a 401, not a 500', async () => {
    const handler = route({
      verifyIdToken: async () => { throw firebaseAuthError('auth/id-token-expired'); } });
    const { res } = await call(handler);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'invalid_token');
  });

  test('AN UNEXPECTED VERIFIER FAULT IS A 500, NOT A MISLEADING 401', async () => {
    /* This is the behaviour change that matters. A TypeError because
       auth.verifyIdToken is not a function, an SDK internal error, or a
       network failure reaching Google's keys used to tell the customer
       "your session has expired" and log nothing at all. */
    const handler = route({
      verifyIdToken: async () => { throw new TypeError('auth.verifyIdToken is not a function'); } });
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 500);
    assert.equal(res.payload.code, 'server_error');
    assert.match(log, /^chat: auth failed \[chat\/start\] auth_token_verify_internal_error /);
    assert.equal(log.includes('is not a function'), false, 'no message may leak');
  });

  test('a Firebase internal error is a 500 too', async () => {
    const handler = route({
      verifyIdToken: async () => { throw firebaseAuthError('auth/internal-error'); } });
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 500);
    assert.match(log, /auth_token_verify_internal_error/);
  });

  test('either way, nothing is let through - both refuse the request', async () => {
    for (const thrown of [firebaseAuthError('auth/id-token-expired'), new Error('mystery')]) {
      const handler = route({ verifyIdToken: async () => { throw thrown; } });
      const { res } = await call(handler);
      assert.ok(res.statusCode >= 401, 'must never succeed: ' + res.statusCode);
      assert.equal(await (await db().collection('chatConversations').get()).size, 0);
    }
  });

  test('a verified token with no uid -> 401 and a named stage', async () => {
    const handler = route({
      verifyIdToken: async () => ({ firebase: { sign_in_provider: 'anonymous' } }) });
    const { res } = await call(handler);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'invalid_token');
  });

  test('a non-anonymous provider -> 403, unchanged', async () => {
    const handler = route({
      verifyIdToken: async () => passwordToken('staff-1', 'manager@example.test') });
    const { res } = await call(handler);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'not_a_customer');
  });

  test('a verified anonymous token progresses to the next stage', async () => {
    const { res } = await call(route());
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.ok(res.payload.conversationId);
  });
});

/* ============================================ EACH STAGE NAMES ITSELF */
describe('each stage of an authenticated request names itself', () => {
  const boom = () => {
    const e = new Error('deliberate');
    e.code = 'SOMETHING_NOT_A_NUMBER';
    return e;
  };

  test('the idempotency lookup', async () => {
    const handler = route({ db: brokenDb('get', boom()) });
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 500);
    assert.match(log, /^chat: service failed \[chat\/start\] idempotency_lookup_failed /);
  });

  test('the rate-limit transaction', async () => {
    /* The idempotency read succeeds, the transaction does not. */
    const real = db();
    const failing = {
      collection: (n) => real.collection(n),
      runTransaction: () => Promise.reject(boom())
    };
    const handler = route({ db: failing });
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 500);
    assert.match(log, /^chat: service failed \[chat\/start\] rate_limit_check_failed /);
  });

  test('the start transaction', async () => {
    /* Let the rate limiter through, then fail the conversation write. */
    const real = db();
    let transactions = 0;
    const failing = {
      collection: (n) => real.collection(n),
      runTransaction: (fn) => {
        transactions += 1;
        if (transactions <= 2) return real.runTransaction(fn);
        return Promise.reject(boom());
      }
    };
    const handler = route({ db: failing });
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 500);
    assert.match(log, /^chat: service failed \[chat\/start\] chat_start_transaction_failed /);
  });

  test('request validation reports a 400, not a stage-500', async () => {
    const { res, log } = await call(route(),
      { body: { name: '', email: 'x', message: '', clientMessageId: 'nope' } });
    assert.equal(res.statusCode, 400);
    assert.equal(log, '', 'a bad request body is not a server incident');
  });

  test('a rate-limited request is still a clean 429', async () => {
    const handler = route();
    for (let i = 0; i < 3; i += 1) await call(handler);
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 429);
    assert.equal(res.payload.code, 'rate_limited');
    assert.equal(log, '', 'hitting a limit is not a server incident');
  });

  test('every logged stage is on the allow-list', async () => {
    const handler = route({ db: brokenDb('get', boom()) });
    const { log } = await call(handler);
    const stage = log.split('] ')[1].split(' ')[0];
    assert.ok(STAGES.STAGES.includes(stage), 'not allow-listed: ' + stage);
  });

  test('the runtime segment is still attached for context', async () => {
    const handler = route({ db: brokenDb('get', boom()) });
    const { log } = await call(handler);
    assert.match(log, /runtime=node:\d+,sdk_app:[01],sdk_firestore:[01],sdk_auth:[01],sdk_code:[a-z_A-Z]+/);
  });
});

/* ===================== A 4xx MUST SURVIVE LOSING instanceof =========== */
describe('a classified error is recognised by tag, not only by instanceof', () => {
  test('every chat error class carries a stable kind marker', () => {
    const V = require('/home/user/esthers/api/_chat/validation.js');
    const S = require('/home/user/esthers/api/_chat/service.js');
    const RL = require('/home/user/esthers/api/_chat/rate-limit.js');
    assert.equal(new AUTH.AuthError(401, 'x', 'y').chatErrorKind, 'auth');
    assert.equal(new V.ValidationError('x', 'y').chatErrorKind, 'validation');
    assert.equal(new S.ServiceError(404, 'x', 'y').chatErrorKind, 'service');
    assert.equal(new RL.RateLimitError(30).chatErrorKind, 'rate_limit');
  });

  test('an AuthError-shaped object from a foreign module still yields 401', () => {
    /* If this file were ever loaded twice, instanceof would stop matching
       and a well-formed 401 would become a 500 unknown_error - which is
       indistinguishable from the fault being diagnosed here. */
    const H = require('/home/user/esthers/api/_chat/handler.js');
    const foreign = new Error('Sign-in is required.');
    foreign.name = 'AuthError';
    foreign.status = 401;
    foreign.code = 'missing_authorization';
    foreign.chatErrorKind = 'auth';
    assert.equal(H.kindOf(foreign), 'auth');

    const res = makeRes();
    H.respondToError(res, foreign, 'chat/start');
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'missing_authorization');
  });

  test('an unknown kind marker is ignored, not trusted', () => {
    const H = require('/home/user/esthers/api/_chat/handler.js');
    const fake = new Error('x');
    fake.chatErrorKind = 'admin';
    assert.equal(H.kindOf(fake), null);
  });
});

/* ================================= NOTHING SENSITIVE REACHES A LOG */
describe('no request data can appear in a diagnostic', () => {
  const SENTINELS = [FAKE_TOKEN, FAKE_EMAIL, FAKE_NAME, FAKE_MESSAGE, FAKE_IP,
    CUST, RATE_SECRET, 'Bearer', 'SENTINEL', 'DO_NOT_LOG'];

  test('not through a broken verifier', async () => {
    const handler = route({
      verifyIdToken: async (token) => { throw new Error('token was ' + token); } });
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 500);
    for (const s of SENTINELS) {
      assert.equal(log.includes(s), false, 'LEAKED into the log: ' + s);
    }
    assert.equal(JSON.stringify(res.payload).includes(FAKE_TOKEN), false);
  });

  test('not through a failing Firestore stage', async () => {
    const err = new Error(FAKE_MESSAGE + ' ' + FAKE_EMAIL);
    err.code = 'NOT_A_NUMBER';
    const handler = route({ db: brokenDb('get', err) });
    const { res, log } = await call(handler);
    assert.equal(res.statusCode, 500);
    for (const s of SENTINELS) {
      assert.equal(log.includes(s), false, 'LEAKED into the log: ' + s);
    }
  });

  test('not through a successful request either', async () => {
    const { res, log } = await call(route());
    assert.equal(res.statusCode, 200);
    assert.equal(log, '', 'a healthy request logs nothing at all');
    const payload = JSON.stringify(res.payload);
    for (const s of [FAKE_TOKEN, FAKE_EMAIL, FAKE_NAME, FAKE_MESSAGE, FAKE_IP, CUST]) {
      assert.equal(payload.includes(s), false, 'response leaked ' + s);
    }
  });

  test('the stage layer itself logs nothing and stores no request data', () => {
    const source = fs.readFileSync(ROOT + '/api/_chat/stages.js', 'utf8');
    assert.equal(/console\./.test(source), false, 'stages.js must not log');
    for (const bad of ['.message', '.stack', '.cause', 'JSON.stringify']) {
      assert.equal(source.includes(bad), false, 'stages.js must not touch ' + bad);
    }
  });

  test('no console call in api/_chat interpolates raw error data', () => {
    for (const name of ['handler.js', 'stages.js', 'auth.js', 'firebase-admin.js',
      'service.js', 'validation.js', 'http.js', 'rate-limit.js']) {
      const src = fs.readFileSync(ROOT + '/api/_chat/' + name, 'utf8');
      const calls = src.match(/console\.[a-z]+\([\s\S]{0,400}?\);/g) || [];
      for (const c of calls) {
        for (const bad of ['.message', '.stack', '.cause', 'JSON.stringify',
          'err.name', 'token', 'body']) {
          assert.equal(c.includes(bad), false, name + ' logs ' + bad + ': ' + c.slice(0, 90));
        }
      }
    }
  });
});

/* ============================== SECURITY MODEL UNCHANGED */
describe('nothing about authorisation was weakened', () => {
  const A = fs.readFileSync(ROOT + '/api/_chat/auth.js', 'utf8');

  test('verification is still delegated to the Admin SDK', () => {
    assert.ok(A.includes('await verifyIdToken(token)'));
    for (const bad of ['jsonwebtoken', 'decodeJwt', 'createVerify', 'jwks-rsa',
      'skipVerification', 'alg']) {
      assert.equal(A.includes(bad), false, 'auth.js must not do its own JWT work');
    }
  });

  test('the anonymous-provider rule is intact', () => {
    assert.ok(A.includes("provider !== 'anonymous'"));
    assert.ok(A.includes("'not_a_customer'"));
  });

  test('staff authorisation is intact', () => {
    assert.ok(A.includes("db.collection('staff').doc(decoded.uid)"));
    assert.ok(A.includes('data.isActive !== true'));
    assert.ok(A.includes('ALLOWED_STAFF_ROLES.indexOf(data.role)'));
  });

  test('a uid is never taken from the request body', async () => {
    const { res } = await call(route(),
      { body: Object.assign(goodBody(), { customerUid: 'attacker-uid' }) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'forbidden_field');
  });

  test('the jwks-rsa jose override is untouched', () => {
    const pkg = JSON.parse(fs.readFileSync(ROOT + '/package.json', 'utf8'));
    assert.deepEqual(pkg.overrides, { 'jwks-rsa': { jose: '^5.10.0' } });
    assert.equal(pkg.dependencies['firebase-admin'], '14.3.0');
  });
});
