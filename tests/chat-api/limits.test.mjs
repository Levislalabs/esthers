/*
 * Rate limiting and fail-closed configuration.
 *
 * These are the two behaviours that are invisible when they work and
 * catastrophic when they quietly stop working: a rate limit that silently
 * stops counting, and a deployment that comes up half-configured and serves
 * an unlimited endpoint rather than refusing.
 *
 * Everything here runs against the Firestore emulator under a demo- project.
 * No production credential, no real key, no real address.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import {
  db, handlerFor, call, wipe, uuid, anonToken, passwordToken, seedStaff,
  RATE_SECRET
} from './helpers.mjs';

const require = createRequire('/home/user/esthers/');
const RL = require('/home/user/esthers/api/_chat/rate-limit.js');
const FB = require('/home/user/esthers/api/_chat/firebase-admin.js');

/* assert.throws() returns nothing, so it cannot be used to inspect the error
   that was raised. This returns it. */
function caught(fn) {
  try { fn(); } catch (err) { return err; }
  assert.fail('expected this to throw, and it did not');
}

const START = '/home/user/esthers/api/chat/start.js';
const SEND = '/home/user/esthers/api/chat/send.js';
const CONVERSATIONS = '/home/user/esthers/api/admin/chat/conversations.js';
const STAFF_SEND = '/home/user/esthers/api/admin/chat/send.js';
const CLOSE = '/home/user/esthers/api/admin/chat/close.js';

const UID_A = 'anon-limit-a';
const UID_B = 'anon-limit-b';
const UID_C = 'anon-limit-c';
const STAFF_UID = 'staff-limit-1';
const IP = '198.51.100.77';

const TOKENS = {
  a: anonToken(UID_A),
  b: anonToken(UID_B),
  c: anonToken(UID_C),
  staff: passwordToken(STAFF_UID, 'manager@example.test')
};

const start = (opts) => handlerFor(START, TOKENS, opts);
const send = (opts) => handlerFor(SEND, TOKENS, opts);

const startBody = () => ({
  name: 'Riley Chen', email: 'riley@example.test',
  message: 'Do you fabricate custom flashing?', clientMessageId: uuid()
});

async function openConversation(token) {
  const res = await call(start(), { token: token || 'a', ip: IP, body: startBody() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return res.payload.conversationId;
}

async function countConversations() {
  return (await db().collection('chatConversations').get()).size;
}

async function rateLimitDocs() {
  const snap = await db().collection('chatRateLimits').get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

before(async () => { await wipe(); });
beforeEach(async () => {
  await wipe();
  await seedStaff(STAFF_UID, { isActive: true, role: 'admin' });
});
after(async () => { FB._reset(); });

/* ================================================== RATE LIMIT: THRESHOLDS */
describe('rate limit thresholds', () => {
  test('start_uid: the documented number of requests pass, the next is refused', async () => {
    const limit = RL.RULES.start_uid.limit;
    assert.equal(limit, 3, 'the test is written against the documented limit');

    for (let i = 0; i < limit; i += 1) {
      const res = await call(start(), { token: 'a', ip: IP, body: startBody() });
      assert.equal(res.statusCode, 200, 'request ' + (i + 1) + ' should pass');
    }

    const over = await call(start(), { token: 'a', ip: IP, body: startBody() });
    assert.equal(over.statusCode, 429);
    assert.equal(over.payload.code, 'rate_limited');
    assert.equal(over.payload.ok, false);
  });

  test('a refused request writes nothing', async () => {
    for (let i = 0; i < RL.RULES.start_uid.limit; i += 1) {
      await call(start(), { token: 'a', ip: IP, body: startBody() });
    }
    const created = await countConversations();

    const over = await call(start(), { token: 'a', ip: IP, body: startBody() });
    assert.equal(over.statusCode, 429);
    assert.equal(await countConversations(), created,
      'a rate-limited request must not still create the conversation');
  });

  test('Retry-After is present, and is a positive whole number of seconds', async () => {
    for (let i = 0; i < RL.RULES.start_uid.limit; i += 1) {
      await call(start(), { token: 'a', ip: IP, body: startBody() });
    }
    const over = await call(start(), { token: 'a', ip: IP, body: startBody() });

    const header = over.headers['retry-after'];
    assert.ok(header !== undefined, 'a 429 without Retry-After tells the client nothing');
    assert.match(String(header), /^[0-9]+$/);
    assert.ok(Number(header) > 0);
    assert.ok(Number(header) <= RL.RULES.start_uid.windowMs / 1000);
    assert.equal(over.payload.retryAfter, Number(header),
      'the body and the header must agree');
  });

  test('send_uid: the documented number pass, the next is refused', async () => {
    const id = await openConversation('b');
    const limit = RL.RULES.send_uid.limit;
    assert.equal(limit, 20);

    for (let i = 0; i < limit; i += 1) {
      const res = await call(send(), { token: 'b', ip: IP,
        body: { conversationId: id, message: 'Message ' + i, clientMessageId: uuid() } });
      assert.equal(res.statusCode, 200, 'send ' + (i + 1) + ' should pass');
    }

    const over = await call(send(), { token: 'b', ip: IP,
      body: { conversationId: id, message: 'one too many', clientMessageId: uuid() } });
    assert.equal(over.statusCode, 429);
    assert.ok(over.headers['retry-after'] !== undefined);
  });

  test('a fresh anonymous uid does not escape the per-IP bucket', async () => {
    /* This is the whole point of hashing the address at all. Anonymous Auth
       hands out a new uid on demand, so a per-uid limit alone is a speed bump
       for an honest retry loop and nothing else. */
    const perUid = RL.RULES.start_uid.limit;   /* 3 */
    const perIp = RL.RULES.start_ip.limit;     /* 8 */

    let accepted = 0;
    let refusal = null;
    for (const token of ['a', 'b', 'c']) {
      for (let i = 0; i < perUid; i += 1) {
        const res = await call(start(), { token, ip: IP, body: startBody() });
        if (res.statusCode === 200) { accepted += 1; continue; }
        refusal = refusal || res;
      }
    }

    assert.equal(accepted, perIp,
      'exactly the per-IP allowance should get through across three uids');
    assert.ok(refusal, 'the ninth start from one address must have been refused');
    assert.equal(refusal.statusCode, 429);
    assert.equal(await countConversations(), perIp);
  });

  test('an unrelated address is unaffected by another address hitting its limit', async () => {
    for (let i = 0; i < RL.RULES.start_ip.limit; i += 1) {
      const token = ['a', 'b', 'c'][Math.floor(i / RL.RULES.start_uid.limit)];
      await call(start(), { token, ip: IP, body: startBody() });
    }
    /* A different uid from a different address is a different customer. */
    const other = handlerFor(START, Object.assign({}, TOKENS, { d: anonToken('anon-limit-d') }));
    const res = await call(other, { token: 'd', ip: '203.0.113.200', body: startBody() });
    assert.equal(res.statusCode, 200, 'the limit must be per bucket, not global');
  });
});

/* ============================================= RATE LIMIT: SHARED COUNTER */
describe('rate limit is shared, not per-instance', () => {
  test('two independently built handlers observe the same Firestore counter', async () => {
    /* Each handlerFor() call builds a separate handler closure, which is what
       a second warm serverless instance is. If the counter lived in process
       memory this test would pass four requests instead of three. */
    const instanceOne = start();
    const instanceTwo = start();

    assert.equal((await call(instanceOne, { token: 'a', ip: IP, body: startBody() })).statusCode, 200);
    assert.equal((await call(instanceTwo, { token: 'a', ip: IP, body: startBody() })).statusCode, 200);
    assert.equal((await call(instanceOne, { token: 'a', ip: IP, body: startBody() })).statusCode, 200);

    const fourth = await call(instanceTwo, { token: 'a', ip: IP, body: startBody() });
    assert.equal(fourth.statusCode, 429,
      'the fourth request must be refused whichever instance receives it');
  });

  test('the counter survives being read back from Firestore directly', async () => {
    await call(start(), { token: 'a', ip: IP, body: startBody() });
    await call(start(), { token: 'a', ip: IP, body: startBody() });

    const docs = await rateLimitDocs();
    const uidBucket = docs.find((d) => d.data.scope === 'start_uid');
    assert.ok(uidBucket, 'a start must leave a start_uid bucket behind');
    assert.equal(uidBucket.data.count, 2);
  });
});

/* ================================================ RATE LIMIT: NO RAW IPs */
describe('rate limit documents hold no personal data', () => {
  test('neither the address nor the uid appears anywhere in the collection', async () => {
    await call(start(), { token: 'a', ip: IP, body: startBody() });
    const docs = await rateLimitDocs();
    assert.ok(docs.length >= 2, 'a start consumes a uid bucket and an IP bucket');

    for (const doc of docs) {
      const serialised = doc.id + ' ' + JSON.stringify(doc.data);
      assert.equal(serialised.includes(IP), false,
        'a raw IP address must never be stored: ' + doc.id);
      assert.equal(serialised.includes(UID_A), false,
        'the visitor uid must not be left browsable: ' + doc.id);
      assert.equal(serialised.includes('198.51.100'), false,
        'not even the network part of the address');
    }
  });

  test('a rate-limit document carries exactly four bookkeeping fields', async () => {
    await call(start(), { token: 'a', ip: IP, body: startBody() });
    for (const doc of await rateLimitDocs()) {
      assert.deepEqual(Object.keys(doc.data).sort(),
        ['count', 'scope', 'updatedAt', 'windowStart'],
        'nothing beyond the counter belongs in ' + doc.id);
    }
  });

  test('the same address under a different secret produces a different bucket', async () => {
    const a = RL.bucketId('start_ip', IP, RATE_SECRET);
    const b = RL.bucketId('start_ip', IP, 'a-completely-different-secret-value');
    assert.notEqual(a, b, 'the key must actually take part in the digest');
    assert.match(a, /^start_ip_[0-9a-f]{32}$/);
    assert.equal(a.includes(IP), false);
  });

  test('hashing fails closed when the secret is missing or too short', () => {
    assert.throws(() => RL.hashIdentifier(IP, undefined), RL.RateLimitConfigError);
    assert.throws(() => RL.hashIdentifier(IP, ''), RL.RateLimitConfigError);
    assert.throws(() => RL.hashIdentifier(IP, 'short'), RL.RateLimitConfigError);
    assert.doesNotThrow(() => RL.hashIdentifier(IP, RATE_SECRET));
  });
});

/* ================================================== RATE LIMIT: THE WINDOW */
describe('the fixed window', () => {
  test('the counter resets once the window has rolled', async () => {
    const rule = RL.RULES.send_uid;
    const t0 = 1700000000000;

    for (let i = 0; i < rule.limit; i += 1) {
      await RL.consume(db(), 'send_uid', 'window-subject', RATE_SECRET, { now: t0 });
    }
    await assert.rejects(
      () => RL.consume(db(), 'send_uid', 'window-subject', RATE_SECRET, { now: t0 }),
      RL.RateLimitError);

    /* One millisecond before the window ends: still refused. */
    await assert.rejects(
      () => RL.consume(db(), 'send_uid', 'window-subject', RATE_SECRET,
        { now: t0 + rule.windowMs - 1 }),
      RL.RateLimitError);

    /* At the boundary the window has rolled. */
    await RL.consume(db(), 'send_uid', 'window-subject', RATE_SECRET,
      { now: t0 + rule.windowMs });

    const docs = await rateLimitDocs();
    const bucket = docs.find((d) => d.data.scope === 'send_uid');
    assert.equal(bucket.data.count, 1, 'a rolled window starts again at one');
    assert.equal(bucket.data.windowStart, t0 + rule.windowMs);
  });

  test('one identity keeps exactly one document per scope, forever', async () => {
    /* The window start lives inside the document rather than in its id, so a
       long-lived visitor cannot accumulate a document per window. */
    const rule = RL.RULES.send_uid;
    for (let w = 0; w < 5; w += 1) {
      await RL.consume(db(), 'send_uid', 'long-lived', RATE_SECRET,
        { now: 1700000000000 + w * rule.windowMs });
    }
    const docs = (await rateLimitDocs()).filter((d) => d.data.scope === 'send_uid');
    assert.equal(docs.length, 1, 'five windows must not leave five documents');
  });

  test('an unknown scope is a programming error, not a silent free pass', async () => {
    await assert.rejects(
      () => RL.consume(db(), 'no_such_scope', 'x', RATE_SECRET),
      /unknown rate-limit scope/);
  });
});

/* ============================================ FAIL CLOSED: RATE-LIMIT SECRET */
describe('fail closed without CHAT_RATE_LIMIT_SECRET', () => {
  const noSecret = { env: { CHAT_RATE_LIMIT_SECRET: undefined } };
  const shortSecret = { env: { CHAT_RATE_LIMIT_SECRET: 'tooshort' } };

  test('chat/start refuses rather than running unlimited', async () => {
    const res = await call(start(noSecret), { token: 'a', ip: IP, body: startBody() });
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, 'not_configured');
    assert.equal(res.payload.notConfigured, true);
    assert.equal(await countConversations(), 0,
      'an unconfigured deployment must not still write the conversation');
  });

  test('a secret too short to be a secret is treated as absent', async () => {
    const res = await call(start(shortSecret), { token: 'a', ip: IP, body: startBody() });
    assert.equal(res.statusCode, 503);
    assert.equal(await countConversations(), 0);
  });

  test('chat/send refuses', async () => {
    const id = await openConversation('a');
    const res = await call(send(noSecret), { token: 'a', ip: IP,
      body: { conversationId: id, message: 'hello', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, 'not_configured');
  });

  test('the staff reply route refuses', async () => {
    const id = await openConversation('a');
    const handler = handlerFor(STAFF_SEND, TOKENS, noSecret);
    const res = await call(handler, { token: 'staff',
      body: { conversationId: id, message: 'reply', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 503);
  });

  test('the staff close route refuses', async () => {
    const id = await openConversation('a');
    const handler = handlerFor(CLOSE, TOKENS, noSecret);
    const res = await call(handler, { token: 'staff', body: { conversationId: id } });
    assert.equal(res.statusCode, 503);
    const snap = await db().collection('chatConversations').doc(id).get();
    assert.equal(snap.data().status, 'open', 'the close must not have happened anyway');
  });

  test('read-only staff routes still work: reading changes nothing', async () => {
    /* The secret guards mutation. Refusing the inbox as well would take the
       shop offline for no security gain. */
    await openConversation('a');
    const handler = handlerFor(CONVERSATIONS, TOKENS, noSecret);
    const res = await call(handler, { method: 'GET', token: 'staff' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.conversations.length, 1);
  });

  test('the 503 body carries no configuration detail', async () => {
    const res = await call(start(noSecret), { token: 'a', ip: IP, body: startBody() });
    const serialised = JSON.stringify(res.payload);
    assert.equal(serialised.includes('CHAT_RATE_LIMIT_SECRET'), false);
    assert.equal(serialised.includes('secret'), false);
    assert.equal(serialised.includes('esther-s-chat'), false);
  });
});

/* ========================================== FAIL CLOSED: FIREBASE CREDENTIALS */
describe('fail closed without Firebase credentials', () => {
  /* A stand-in for the Admin SDK that records whether it was ever asked to
     initialise. Nothing here contacts Firebase, and the key material below is
     a literal placeholder, not a key. */
  function fakeAdmin() {
    const calls = [];
    const app = { name: '[FAKE]' };
    return {
      calls,
      sdk: {
        app: {
          getApps: () => [],
          cert: (c) => ({ cert: c }),
          initializeApp: (opts) => { calls.push(opts); return app; }
        },
        firestore: { getFirestore: () => ({ fake: true }) },
        auth: { getAuth: () => ({ fake: true }) }
      }
    };
  }

  /* Structurally a PEM - the body must be base64 or readConfig now refuses
     it - but decodes to the ASCII text "NOT-A-REAL-KEY-placeholder-for-tests".
     It is a credential for nothing. */
  const GOOD_KEY = '-----BEGIN PRIVATE KEY-----\\n'
    + 'Tk9ULUEtUkVBTC1LRVktcGxhY2Vob2xkZXItZm9yLXRlc3Rz\\n'
    + '-----END PRIVATE KEY-----\\n';
  const goodEnv = () => ({
    FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: 'placeholder@example.iam.gserviceaccount.test',
    FIREBASE_PRIVATE_KEY: GOOD_KEY
  });

  beforeEach(() => { FB._reset(); });

  test('an empty environment is rejected before anything is initialised', () => {
    const admin = fakeAdmin();
    assert.throws(() => FB.initAdmin({ env: {}, sdk: admin.sdk }), FB.ChatConfigError);
    assert.equal(admin.calls.length, 0,
      'nothing may be initialised when the environment is incomplete');
  });

  test('THE ACCIDENTAL PROJECT: a different project id is refused', () => {
    /* The Admin SDK bypasses Firestore rules entirely, so a wrong project id
       is not caught by any rule - it would just quietly write somewhere else.
       This guard is the only thing standing between a typo and that. */
    const admin = fakeAdmin();
    const env = Object.assign(goodEnv(), { FIREBASE_PROJECT_ID: 'esthers-chat' });
    const err = caught(() => FB.initAdmin({ env, sdk: admin.sdk }));
    assert.ok(err instanceof FB.ChatConfigError);
    assert.equal(err.reason, 'unexpected_project');
    assert.equal(admin.calls.length, 0, 'the wrong project must never be opened');
  });

  test('a plausible neighbouring project id is still refused', () => {
    const admin = fakeAdmin();
    for (const wrong of ['esther-s-chat-dev', 'esther-s-chat ', 'Esther-S-Chat', 'demo-esther-s-chat']) {
      const env = Object.assign(goodEnv(), { FIREBASE_PROJECT_ID: wrong });
      let threw = false;
      try { FB.initAdmin({ env, sdk: admin.sdk }); } catch (e) { threw = e instanceof FB.ChatConfigError; }
      /* A trailing space is trimmed and is the same project, so it is allowed;
         everything else must be refused. */
      if (wrong.trim() === FB.EXPECTED_PROJECT_ID) {
        assert.equal(threw, false, wrong + ' is the right project with whitespace');
        FB._reset();
      } else {
        assert.equal(threw, true, wrong + ' must be refused');
      }
    }
  });

  test('each missing piece names itself with a short safe token', () => {
    const admin = fakeAdmin();
    const cases = [
      [{}, 'missing_project_id'],
      [{ FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID }, 'missing_client_email'],
      /* An address with no @ is now told apart from one that is absent. */
      [{ FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID, FIREBASE_CLIENT_EMAIL: 'nope' },
        'invalid_client_email_shape'],
      [{ FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID,
        FIREBASE_CLIENT_EMAIL: 'placeholder@example.test' },
        'missing_private_key']
    ];
    for (const [env, reason] of cases) {
      const err = caught(() => FB.initAdmin({ env, sdk: admin.sdk }));
      assert.ok(err instanceof FB.ChatConfigError);
      assert.equal(err.reason, reason);
    }
    assert.equal(admin.calls.length, 0);
  });

  test('a config error never quotes the credential it rejected', () => {
    const admin = fakeAdmin();
    const env = Object.assign(goodEnv(), { FIREBASE_PRIVATE_KEY: 'PRETEND-SECRET-MATERIAL' });
    const err = caught(() => FB.initAdmin({ env, sdk: admin.sdk }));
    assert.ok(err instanceof FB.ChatConfigError);
    const text = String(err.message) + ' ' + String(err.reason) + ' ' + String(err.stack);
    assert.equal(text.includes('PRETEND-SECRET-MATERIAL'), false,
      'the rejected value must not travel with the error');
    assert.equal(text.includes('placeholder@example.iam.gserviceaccount.test'), false,
      'nor the service account address');
  });

  test('a complete environment initialises exactly once and is then cached', () => {
    const admin = fakeAdmin();
    const first = FB.initAdmin({ env: goodEnv(), sdk: admin.sdk });
    const second = FB.initAdmin({ env: goodEnv(), sdk: admin.sdk });
    assert.equal(admin.calls.length, 1, 'a warm instance must not re-initialise');
    assert.equal(first, second);
    assert.equal(first.projectId, FB.EXPECTED_PROJECT_ID);
    assert.equal(admin.calls[0].projectId, FB.EXPECTED_PROJECT_ID);
  });

  test('an escaped-newline private key is repaired, a one-line one is refused', () => {
    const repaired = FB.normalisePrivateKey(GOOD_KEY);
    assert.ok(repaired.includes('\n'), 'escaped newlines must become real ones');
    assert.equal(repaired.includes('\\n'), false);
    assert.ok(repaired.endsWith('\n'));

    /* Wrapped in quotes by a dashboard that insists. */
    assert.ok(FB.normalisePrivateKey('"' + GOOD_KEY + '"').startsWith('-----BEGIN'));

    assert.equal(FB.normalisePrivateKey('-----BEGIN PRIVATE KEY----- abc -----END'), null,
      'a key with no newline at all is unusable');
    assert.equal(FB.normalisePrivateKey('not a key'), null);
    assert.equal(FB.normalisePrivateKey(undefined), null);
    assert.equal(FB.normalisePrivateKey(12345), null);
  });

  test('the expected project id is a constant, not an environment value', () => {
    /* A guard that compares the configured project against another configured
       value guards nothing. */
    assert.equal(FB.EXPECTED_PROJECT_ID, 'esther-s-chat');
    const source = require('fs')
      .readFileSync('/home/user/esthers/api/_chat/firebase-admin.js', 'utf8');
    assert.match(source, /const EXPECTED_PROJECT_ID = 'esther-s-chat';/);
  });
});
