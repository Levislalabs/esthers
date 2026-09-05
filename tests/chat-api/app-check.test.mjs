/*
 * Firebase App Check on the custom chat API.
 *
 * NO PRODUCTION CONTACT AND NO REAL APP CHECK TOKEN. A genuine token can only
 * be minted by a real browser passing a reCAPTCHA Enterprise challenge, so
 * requiring one here would make the suite unrunnable. The verifier is injected
 * exactly the way the ID-token verifier already is - the real app-check.js
 * code path runs, with a stand-in for the one call that would leave the
 * machine. That is the same technique the rest of this suite uses, and it is
 * why these tests exercise the real gate rather than a mock of it.
 *
 * WHAT THIS FILE IS REALLY FOR. App Check is additive. The danger in adding a
 * gate to a backend whose authorisation is already proven is not that the new
 * gate fails open - it is that the new gate quietly becomes the ONLY gate,
 * because it runs first and everything behind it stops being reached. Most of
 * the assertions below are therefore about what App Check must NOT do.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  handlerFor, call, wipe, seedStaff, uuid, anonToken, passwordToken,
  APP_CHECK_OK, APP_CHECK_BAD, APP_CHECK_APP_ID, makeAppCheckVerifier
} from './helpers.mjs';

import { createRequire } from 'module';
const require = createRequire('/home/user/esthers/');
const AC = require('/home/user/esthers/api/_chat/app-check.js');

const START = '/home/user/esthers/api/chat/start.js';
const STAFF_LIST = '/home/user/esthers/api/admin/chat/conversations.js';
const STAFF_SEND = '/home/user/esthers/api/admin/chat/send.js';

const CUST = 'cust-appcheck-1';
const STAFF = 'staff-appcheck-1';
const TOKENS = {
  'cust-tok': anonToken(CUST),
  'staff-tok': passwordToken(STAFF, 'manager@example.test')
};

const goodBody = () => ({
  name: 'Test Person',
  email: 'person@example.test',
  message: 'Do you make curved flashing?',
  clientMessageId: uuid()
});

/* Enforced customer route. */
const enforcedStart = (opts = {}) =>
  handlerFor(START, TOKENS, Object.assign({ appCheckEnforced: true }, opts));
/* Enforcement off - the state this ships in. */
const stagedStart = (opts = {}) => handlerFor(START, TOKENS, opts);

before(async () => { await wipe(); await seedStaff(STAFF); });
beforeEach(async () => { await seedStaff(STAFF); });

/* ==================================================== THE MODULE ITSELF */

describe('the App Check contract', () => {
  test('the header is Firebase\'s own spelling, and is read case-insensitively', () => {
    assert.equal(AC.APP_CHECK_HEADER, 'X-Firebase-AppCheck');
    assert.equal(AC.APP_CHECK_HEADER_KEY, 'x-firebase-appcheck');
    /* Node lower-cases incoming header names, so the key is what we look up. */
    assert.equal(
      AC.readAppCheckToken({ headers: { 'x-firebase-appcheck': ' abc.def.ghi ' } }),
      'abc.def.ghi');
  });

  test('a repeated header is refused rather than guessed at', () => {
    assert.equal(AC.readAppCheckToken({ headers: { 'x-firebase-appcheck': ['a.b.c', 'd.e.f'] } }),
      null);
  });

  test('the token is never read from Authorization, a query or a body', () => {
    assert.equal(AC.readAppCheckToken({
      headers: { authorization: 'Bearer a.b.c' },
      query: { appCheck: 'a.b.c' },
      body: { appCheckToken: 'a.b.c' }
    }), null);
  });

  test('enforcement is off unless the environment says otherwise', () => {
    for (const v of [undefined, '', '0', 'false', 'off', 'no', 'ture', ' ', 'enforce']) {
      assert.equal(AC.isEnforced({ CHAT_APP_CHECK_ENFORCED: v }), false, String(v));
    }
    for (const v of ['1', 'true', 'TRUE', ' on ', 'yes', 'enforced']) {
      assert.equal(AC.isEnforced({ CHAT_APP_CHECK_ENFORCED: v }), true, String(v));
    }
  });

  test('nothing in a request can switch enforcement off', () => {
    /* The switch reads only the environment. There is no request-shaped
       input to isEnforced at all, which is the property being asserted. */
    assert.equal(AC.isEnforced({ CHAT_APP_CHECK_ENFORCED: '1' }), true);
    assert.equal(AC.isEnforced.length, 1);
    /* The function body only - comments after it are prose and legitimately
       use the word "request". */
    const src = require('fs').readFileSync(
      '/home/user/esthers/api/_chat/app-check.js', 'utf8');
    const start = src.indexOf('function isEnforced');
    const body = src.slice(start, src.indexOf('\n}', start));
    for (const bad of ['req', 'query', 'body', 'header']) {
      assert.equal(body.includes(bad), false,
        'isEnforced must not read ' + bad + ', found in: ' + body);
    }
  });

  test('an oversized or non-JWT token is refused without a network call', () => {
    assert.equal(AC.looksLikeToken('a.b.c'), true);
    assert.equal(AC.looksLikeToken('not-a-jwt'), false);
    assert.equal(AC.looksLikeToken('a.b'), false);
    assert.equal(AC.looksLikeToken('a.b.c.d'), false);
    assert.equal(AC.looksLikeToken('a.b.' + 'x'.repeat(AC.MAX_TOKEN_CHARS)), false);
    assert.equal(AC.looksLikeToken(''), false);
    assert.equal(AC.looksLikeToken(null), false);
  });

  test('with enforcement ON and no verifier, it refuses - it does not let requests past',
    async () => {
      await assert.rejects(
        () => AC.verifyAppCheck({
          req: { headers: { 'x-firebase-appcheck': 'a.b.c' } },
          env: { CHAT_APP_CHECK_ENFORCED: '1' },
          verifyToken: null
        }),
        (err) => err.chatErrorKind === 'app_check' && err.code === 'app_check_unavailable');
    });

  test('with enforcement OFF it only observes, and never throws', async () => {
    const boom = async () => { throw new Error('verifier exploded'); };
    const r = await AC.verifyAppCheck({
      req: { headers: { 'x-firebase-appcheck': 'a.b.c' } }, env: {}, verifyToken: boom });
    assert.equal(r.enforced, false);
    assert.equal(r.outcome, 'rejected');
  });

  test('an unknown outcome cannot reach a log', () => {
    assert.equal(AC.safeOutcome('valid'), 'valid');
    assert.equal(AC.safeOutcome('<script>'), 'rejected');
  });
});

/* ======================================================= CUSTOMER ROUTES */

describe('customer routes with App Check enforced', () => {
  test('a missing App Check token is refused', async () => {
    const res = await call(enforcedStart(), { token: 'cust-tok', body: goodBody() });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_required');
  });

  test('an invalid App Check token is refused', async () => {
    const res = await call(enforcedStart(),
      { token: 'cust-tok', appCheck: APP_CHECK_BAD, body: goodBody() });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_invalid');
  });

  test('a malformed App Check token is refused', async () => {
    const res = await call(enforcedStart(),
      { token: 'cust-tok', appCheck: 'not-a-jwt', body: goodBody() });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_invalid');
  });

  test('valid App Check + INVALID Firebase Auth is still refused', async () => {
    const res = await call(enforcedStart(),
      { token: 'no-such-token', appCheck: APP_CHECK_OK, body: goodBody() });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'invalid_token');
  });

  test('valid App Check + NO Firebase Auth is still refused', async () => {
    const res = await call(enforcedStart(), { appCheck: APP_CHECK_OK, body: goodBody() });
    assert.equal(res.statusCode, 401);
    assert.notEqual(res.payload.code, 'app_check_required');
  });

  test('valid App Check + valid anonymous auth succeeds', async () => {
    const res = await call(enforcedStart(),
      { token: 'cust-tok', appCheck: APP_CHECK_OK, body: goodBody() });
    assert.equal(res.statusCode, 200);
    assert.ok(res.payload.conversationId);
  });

  test('the anonymous-provider rule still applies behind App Check', async () => {
    const res = await call(enforcedStart(),
      { token: 'staff-tok', appCheck: APP_CHECK_OK, body: goodBody() });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'not_a_customer');
  });

  test('a spoofed customerUid is still refused behind App Check', async () => {
    const res = await call(enforcedStart(), {
      token: 'cust-tok', appCheck: APP_CHECK_OK,
      body: Object.assign(goodBody(), { customerUid: 'someone-else' })
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'forbidden_field');
  });
});

/* ========================================================== STAFF ROUTES */

describe('staff routes with App Check enforced', () => {
  const listing = (opts = {}) =>
    handlerFor(STAFF_LIST, TOKENS, Object.assign({ appCheckEnforced: true }, opts));

  test('a missing App Check token is refused', async () => {
    const res = await call(listing(), { method: 'GET', token: 'staff-tok' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_required');
  });

  test('an invalid App Check token is refused', async () => {
    const res = await call(listing(),
      { method: 'GET', token: 'staff-tok', appCheck: APP_CHECK_BAD });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_invalid');
  });

  test('valid App Check + invalid staff auth is refused', async () => {
    const res = await call(listing(),
      { method: 'GET', token: 'no-such-token', appCheck: APP_CHECK_OK });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'invalid_token');
  });

  test('valid App Check + valid active admin staff succeeds', async () => {
    const res = await call(listing(),
      { method: 'GET', token: 'staff-tok', appCheck: APP_CHECK_OK });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.payload.conversations));
  });

  test('a deactivated staff member is still refused behind App Check', async () => {
    await seedStaff(STAFF, { isActive: false });
    const res = await call(listing(),
      { method: 'GET', token: 'staff-tok', appCheck: APP_CHECK_OK });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'staff_inactive');
  });

  test('a non-admin role is still refused behind App Check', async () => {
    await seedStaff(STAFF, { role: 'viewer' });
    const res = await call(listing(),
      { method: 'GET', token: 'staff-tok', appCheck: APP_CHECK_OK });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'staff_role');
  });

  test('an anonymous customer cannot reach a staff route with a good App Check token',
    async () => {
      const res = await call(listing(),
        { method: 'GET', token: 'cust-tok', appCheck: APP_CHECK_OK });
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.code, 'not_staff');
    });
});

/* ============================================ THE TWO TOKENS ARE DISTINCT */

describe('an App Check token and an ID token cannot stand in for each other', () => {
  test('an App Check token in Authorization does not authenticate anyone', async () => {
    const res = await call(enforcedStart(), {
      appCheck: APP_CHECK_OK,
      headers: { authorization: 'Bearer ' + APP_CHECK_OK },
      body: goodBody()
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'invalid_token');
  });

  test('an ID token in the App Check header does not attest the app', async () => {
    const res = await call(enforcedStart(), {
      token: 'cust-tok',
      appCheck: 'cust-tok',              /* a real ID token, wrong channel */
      body: goodBody()
    });
    assert.equal(res.statusCode, 401);
    /* Refused as an App Check failure - it never reaches the ID-token check. */
    assert.ok(res.payload.code.indexOf('app_check') === 0, res.payload.code);
  });

  test('one valid App Check token does not grant a second identity', async () => {
    /* The same attestation, two different customers: each is still bound to
       its own verified uid, and neither can act as the other. */
    const A = { 'a-tok': anonToken('cust-A'), 'b-tok': anonToken('cust-B') };
    const h = handlerFor(START, A, { appCheckEnforced: true });
    const ra = await call(h, { token: 'a-tok', appCheck: APP_CHECK_OK, body: goodBody() });
    const rb = await call(h, { token: 'b-tok', appCheck: APP_CHECK_OK, body: goodBody() });
    assert.equal(ra.statusCode, 200);
    assert.equal(rb.statusCode, 200);
    assert.notEqual(ra.payload.conversationId, rb.payload.conversationId);
  });
});

/* ================================== EVERYTHING ELSE IS STILL IN FRONT OF IT */

describe('App Check did not become the only gate', () => {
  test('a cross-origin request is refused before App Check is even consulted',
    async () => {
      const res = await call(enforcedStart(), {
        token: 'cust-tok', appCheck: APP_CHECK_OK,
        headers: { origin: 'https://attacker.example' },
        body: goodBody()
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.code, 'cross_origin');
    });

  test('a disallowed method is refused before App Check', async () => {
    const res = await call(enforcedStart(),
      { method: 'DELETE', token: 'cust-tok', appCheck: APP_CHECK_OK });
    assert.equal(res.statusCode, 405);
  });

  test('payload validation still runs behind App Check', async () => {
    const res = await call(enforcedStart(), {
      token: 'cust-tok', appCheck: APP_CHECK_OK,
      body: Object.assign(goodBody(), { email: 'not-an-email' })
    });
    assert.equal(res.statusCode, 400);
  });

  test('the rate limit still runs behind App Check', async () => {
    const h = handlerFor(START, TOKENS, { appCheckEnforced: true });
    let limited = null;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const res = await call(h, {
        token: 'cust-tok', appCheck: APP_CHECK_OK, body: goodBody(),
        ip: '203.0.113.77'
      });
      if (res.statusCode === 429) limited = res;
    }
    assert.ok(limited, 'the per-uid/per-ip limit must still trip with App Check enforced');
    assert.equal(limited.payload.code, 'rate_limited');
    assert.ok(limited.headers['retry-after']);
  });

  test('a valid App Check token does not buy extra rate-limit allowance', async () => {
    /* Same identity, fresh attestation each time: the limiter keys on the
       verified uid and the address, never on the App Check token. */
    const h = handlerFor(START, TOKENS, { appCheckEnforced: true });
    let seen429 = false;
    for (let i = 0; i < 12 && !seen429; i += 1) {
      const res = await call(h, {
        token: 'cust-tok', appCheck: APP_CHECK_OK, body: goodBody(), ip: '203.0.113.78'
      });
      if (res.statusCode === 429) seen429 = true;
    }
    assert.equal(seen429, true);
  });
});

/* =========================================== THE STAGED (SHIPPING) STATE */

describe('with enforcement off - the state this ships in', () => {
  /*
   * A uid and an address of their own.
   *
   * The rate-limit assertions above deliberately exhaust CUST's allowance, and
   * the limiter keys on the verified uid and the address - so reusing either
   * here would fail these tests with a 429 that says nothing about App Check.
   * That is the limiter working, not a defect, but it belongs in its own test.
   */
  let n = 0;
  /* start_uid allows 3 conversations per uid per 10 minutes, so a suite of
     five starts sharing one identity would fail its fourth test on the rate
     limit rather than on anything to do with App Check. A fresh uid and a
     fresh address per test keeps each assertion about the thing it names. */
  function freshStaged(opts = {}) {
    n += 1;
    const uid = 'cust-staged-' + n;
    const tokens = { 'staged-tok': anonToken(uid) };
    return {
      uid,
      ip: '203.0.113.' + (90 + n),
      handler: handlerFor(START, tokens, opts)
    };
  }

  test('a request with no App Check token still works', async () => {
    const g = freshStaged();
    const res = await call(g.handler, { token: 'staged-tok', body: goodBody(), ip: g.ip });
    assert.equal(res.statusCode, 200);
  });

  test('a request with an INVALID App Check token still works, and is noted', async () => {
    const lines = [];
    const original = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    let res;
    try {
      const g = freshStaged();
      res = await call(g.handler, {
        token: 'staged-tok', appCheck: APP_CHECK_BAD, body: goodBody(), ip: g.ip });
    } finally { console.log = original; }
    assert.equal(res.statusCode, 200);
    assert.ok(lines.some(l => l.includes('app check observed') && l.includes('rejected')),
      'the rollout needs to see that a client sent a token the verifier refused');
  });

  test('a valid token is observed, so the rollout can tell clients are ready', async () => {
    const lines = [];
    const original = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
      const g = freshStaged();
      await call(g.handler, {
        token: 'staged-tok', appCheck: APP_CHECK_OK, body: goodBody(), ip: g.ip });
    } finally { console.log = original; }
    assert.ok(lines.some(l => l.includes('app check observed') && l.includes('valid')));
  });

  test('the observation line carries no token, uid, email or message', async () => {
    const lines = [];
    const original = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    const body = goodBody();
    const g = freshStaged();
    try {
      await call(g.handler, { token: 'staged-tok', appCheck: APP_CHECK_OK, body, ip: g.ip });
    } finally { console.log = original; }
    const log = lines.join('\n');
    for (const secret of [APP_CHECK_OK, APP_CHECK_APP_ID, 'staged-tok', g.uid,
      body.email, body.name, body.message]) {
      assert.equal(log.includes(secret), false, 'leaked: ' + secret);
    }
  });

  test('a deployment whose App Check module never loaded still serves chat', async () => {
    /* verifyAppCheckToken: null is what a failed firebase-admin/app-check
       import looks like. With enforcement off that must not be an outage. */
    const g = freshStaged({ verifyAppCheckToken: null });
    const res = await call(g.handler, { token: 'staged-tok', body: goodBody(), ip: g.ip });
    assert.equal(res.statusCode, 200);
  });

  test('...but the same deployment refuses everything once enforcement is on', async () => {
    const g = freshStaged({ appCheckEnforced: true, verifyAppCheckToken: null });
    const res = await call(g.handler, { token: 'staged-tok', appCheck: APP_CHECK_OK,
      body: goodBody(), ip: g.ip });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_unavailable');
  });
});

/* ============================================================ THE WIRING */

describe('the gate is wired into every chat route, not just the ones tested above', () => {
  const ROUTES = [
    'api/chat/start.js', 'api/chat/send.js',
    'api/admin/chat/conversations.js', 'api/admin/chat/messages.js',
    'api/admin/chat/send.js', 'api/admin/chat/close.js'
  ];

  test('every route is built by createHandler, which owns the gate', () => {
    const fs = require('fs');
    for (const r of ROUTES) {
      const src = fs.readFileSync('/home/user/esthers/' + r, 'utf8');
      assert.ok(src.includes('createHandler'), r + ' must go through createHandler');
    }
    const handler = fs.readFileSync('/home/user/esthers/api/_chat/handler.js', 'utf8');
    assert.ok(handler.includes('AC.verifyAppCheck'),
      'createHandler must call the App Check gate');
  });

  test('the gate runs after configuration and before authentication', () => {
    const src = require('fs').readFileSync(
      '/home/user/esthers/api/_chat/handler.js', 'utf8');
    const origin = src.indexOf('H.sameOrigin');
    const init = src.indexOf('initAdmin()');
    const gate = src.indexOf('AC.verifyAppCheck');
    const auth = src.indexOf('authenticateCustomer(verifyIdToken');
    assert.ok(origin < gate, 'same-origin first');
    assert.ok(init < gate, 'configuration before the gate');
    assert.ok(gate < auth, 'App Check before authentication');
  });

  test('a staff write route enforces it too', async () => {
    const h = handlerFor(STAFF_SEND, TOKENS, { appCheckEnforced: true });
    const res = await call(h, {
      token: 'staff-tok',
      body: { conversationId: 'x'.repeat(20), message: 'hello', clientMessageId: uuid() }
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_required');
  });
});
