/*
 * Rate limiting on the quote form (api/_quote-limit.js, api/quote.js,
 * api/upload-token.js).
 *
 * NO EMULATOR, NO NETWORK. The shared layer is exercised with the REAL
 * limiter from api/_chat/rate-limit.js running against a small in-memory
 * stand-in for Firestore, so the transaction and window logic under test is
 * the production code. No email is sent: every handler request here is
 * refused before the provider would be called.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const QL = require('../../api/_quote-limit.js');
const RL = require('../../api/_chat/rate-limit.js');
const FB = require('../../api/_chat/firebase-admin.js');
const quoteHandler = require('../../api/quote.js');
const uploadHandler = require('../../api/upload-token.js');

const SECRET = 'test-rate-limit-secret-not-real-0123456789';
const HOUR = 60 * 60 * 1000;

/* Same placeholder as the chat suite: PEM-shaped, a credential for nothing. */
const GOOD_KEY = '-----BEGIN PRIVATE KEY-----\\n'
  + 'Tk9ULUEtUkVBTC1LRVktcGxhY2Vob2xkZXItZm9yLXRlc3Rz\\n'
  + '-----END PRIVATE KEY-----\\n';
const sharedEnv = () => ({
  FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: 'placeholder@example.iam.gserviceaccount.test',
  FIREBASE_PRIVATE_KEY: GOOD_KEY,
  CHAT_RATE_LIMIT_SECRET: SECRET
});

/* Just enough of Firestore for RL.consume: collection().doc(), and a
   transaction with get/set. Serialised, which is what a transaction gives. */
function fakeDb() {
  const docs = new Map();
  let chain = Promise.resolve();
  return {
    docs,
    collection(name) {
      return { doc(id) { return { path: name + '/' + id }; } };
    },
    runTransaction(fn) {
      const run = chain.then(() => fn({
        async get(ref) {
          const v = docs.get(ref.path);
          return { exists: v !== undefined, data: () => (v ? { ...v } : undefined) };
        },
        set(ref, value) { docs.set(ref.path, { ...value }); }
      }));
      chain = run.catch(() => {});
      return run;
    }
  };
}

function req(ip, extra) {
  return Object.assign({
    method: 'POST',
    headers: { 'x-vercel-forwarded-for': ip },
    body: {}
  }, extra || {});
}

function res() {
  return {
    statusCode: 200, headers: {}, payload: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    json(p) { this.payload = p; return this; }
  };
}

/* Captures console output so tests can assert nothing identifying is logged. */
function captureLogs() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) {
    console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  }
  return { lines, restore() { Object.assign(console, orig); } };
}

let logs;
beforeEach(() => { logs = captureLogs(); FB._reset(); });
afterEach(() => { logs.restore(); });

describe('the limits themselves', () => {
  test('quote and upload scopes exist and are separate from every chat scope', () => {
    assert.deepEqual(QL.SCOPES, { quote: 'quote_ip', upload: 'upload_ip' });
    assert.equal(RL.RULES.quote_ip.limit, 10);
    assert.equal(RL.RULES.quote_ip.windowMs, HOUR);
    assert.equal(RL.RULES.upload_ip.limit, 20);
    assert.equal(RL.RULES.upload_ip.windowMs, HOUR);
  });

  test('an unknown kind is a programming error, not a silent pass', async () => {
    await assert.rejects(() => QL.check(req('1.2.3.4'), 'nope', { env: {} }));
  });
});

describe('in-memory layer (always on)', () => {
  test('allows up to the limit, then refuses with a retry time', async () => {
    const memory = QL.createMemoryLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) {
      const r = await QL.check(req('203.0.113.5'), 'quote', { env: {}, memory, now: t0 + i });
      assert.equal(r.limited, false, 'request ' + (i + 1) + ' should pass');
    }
    const r = await QL.check(req('203.0.113.5'), 'quote', { env: {}, memory, now: t0 + 60_000 });
    assert.equal(r.limited, true);
    assert.equal(r.retryAfterSeconds, (HOUR - 60_000) / 1000);
  });

  test('the window rolls over', async () => {
    const memory = QL.createMemoryLimiter();
    const t0 = 5_000_000;
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) {
      await QL.check(req('203.0.113.6'), 'quote', { env: {}, memory, now: t0 });
    }
    assert.equal((await QL.check(req('203.0.113.6'), 'quote', { env: {}, memory, now: t0 + HOUR - 1 })).limited, true);
    assert.equal((await QL.check(req('203.0.113.6'), 'quote', { env: {}, memory, now: t0 + HOUR })).limited, false);
  });

  test('different addresses and different scopes have their own buckets', async () => {
    const memory = QL.createMemoryLimiter();
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) {
      await QL.check(req('198.51.100.1'), 'quote', { env: {}, memory, now: 1 });
    }
    assert.equal((await QL.check(req('198.51.100.1'), 'quote', { env: {}, memory, now: 2 })).limited, true);
    assert.equal((await QL.check(req('198.51.100.2'), 'quote', { env: {}, memory, now: 2 })).limited, false);
    assert.equal((await QL.check(req('198.51.100.1'), 'upload', { env: {}, memory, now: 2 })).limited, false);
  });

  test('1.2.3.4 and ::ffff:1.2.3.4 are one caller, not two allowances', async () => {
    const memory = QL.createMemoryLimiter();
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) {
      await QL.check(req(i % 2 ? '1.2.3.4' : '::ffff:1.2.3.4'), 'quote', { env: {}, memory, now: 1 });
    }
    assert.equal((await QL.check(req('1.2.3.4'), 'quote', { env: {}, memory, now: 2 })).limited, true);
  });

  test('the table is bounded however many addresses arrive', async () => {
    const memory = QL.createMemoryLimiter();
    for (let i = 0; i < QL.MEMORY_MAX_ENTRIES + 500; i += 1) {
      const ip = '10.' + ((i >> 16) & 255) + '.' + ((i >> 8) & 255) + '.' + (i & 255);
      await QL.check(req(ip), 'quote', { env: {}, memory, now: 1 });
    }
    assert.ok(memory.size() <= QL.MEMORY_MAX_ENTRIES);
  });
});

describe('shared Firestore layer', () => {
  test('is skipped entirely when the chat environment is not configured', async () => {
    let called = 0;
    const deps = {
      env: { CHAT_RATE_LIMIT_SECRET: SECRET }, /* secret but no Firebase */
      memory: QL.createMemoryLimiter(),
      initAdmin: async () => { called += 1; return { db: fakeDb() }; }
    };
    assert.equal((await QL.check(req('1.1.1.1'), 'quote', deps)).limited, false);
    assert.equal(called, 0);
    assert.equal(QL.sharedConfigured({}), false);
    assert.equal(QL.sharedConfigured(Object.assign(sharedEnv(), { CHAT_RATE_LIMIT_SECRET: 'short' })), false);
    assert.equal(QL.sharedConfigured(sharedEnv()), true);
  });

  test('holds across server instances, which the memory layer cannot', async () => {
    const db = fakeDb();
    const shared = { env: sharedEnv(), initAdmin: async () => ({ db }) };
    const limit = RL.RULES.quote_ip.limit;
    /* Every request lands on a fresh "instance" with an empty memory table. */
    for (let i = 0; i < limit; i += 1) {
      const r = await QL.check(req('192.0.2.9'), 'quote',
        Object.assign({ memory: QL.createMemoryLimiter(), now: 100 + i }, shared));
      assert.equal(r.limited, false);
    }
    const r = await QL.check(req('192.0.2.9'), 'quote',
      Object.assign({ memory: QL.createMemoryLimiter(), now: 200 }, shared));
    assert.equal(r.limited, true);
    assert.ok(r.retryAfterSeconds > 0);
  });

  test('stores no raw address - document ids are an HMAC under a quote scope', async () => {
    const db = fakeDb();
    await QL.check(req('192.0.2.77'), 'quote',
      { env: sharedEnv(), memory: QL.createMemoryLimiter(), initAdmin: async () => ({ db }) });
    const [[path, doc]] = [...db.docs.entries()];
    assert.match(path, /^chatRateLimits\/quote_ip_[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(doc).includes('192.0.2.77'), false);
    assert.equal(path.includes('192.0.2.77'), false);
  });

  test('fails OPEN when Firestore errors, and logs only a reason token', async () => {
    const deps = {
      env: sharedEnv(),
      memory: QL.createMemoryLimiter(),
      initAdmin: async () => { const e = new Error('boom at 192.0.2.50'); e.code = 'unavailable'; throw e; }
    };
    assert.equal((await QL.check(req('192.0.2.50'), 'quote', deps)).limited, false);
    const joined = logs.lines.join('\n');
    assert.match(joined, /shared limiter unavailable, allowing: unavailable/);
    assert.equal(joined.includes('192.0.2.50'), false);
  });

  test('the memory layer still applies while the shared one is down', async () => {
    const memory = QL.createMemoryLimiter();
    const deps = { env: sharedEnv(), memory, initAdmin: async () => { throw new Error('down'); } };
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) await QL.check(req('192.0.2.51'), 'quote', deps);
    assert.equal((await QL.check(req('192.0.2.51'), 'quote', deps)).limited, true);
  });
});

describe('the endpoints', () => {
  const saved = {};
  const KEYS = ['RESEND_API_KEY', 'QUOTE_TO', 'BLOB_READ_WRITE_TOKEN', 'CHAT_RATE_LIMIT_SECRET',
    'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.RESEND_API_KEY = 'not-a-real-key';
    process.env.QUOTE_TO = 'shop@example.test';
    process.env.BLOB_READ_WRITE_TOKEN = 'not-a-real-token';
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  test('/api/quote returns 429 with Retry-After and a customer sentence once the limit is spent', async () => {
    const ip = '203.0.113.200';
    /* Empty bodies: each is refused with 400 before any email could be sent,
       but every one still counts - validity is not a way around the limit. */
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) {
      const r = res();
      await quoteHandler(req(ip), r);
      assert.equal(r.statusCode, 400);
    }
    const r = res();
    await quoteHandler(req(ip), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.payload.ok, false);
    assert.equal(r.payload.rateLimited, true);
    assert.equal(r.payload.error, QL.CUSTOMER_MESSAGE);
    assert.ok(Number(r.headers['retry-after']) > 0);
    assert.equal(logs.lines.join('\n').includes(ip), false, 'the address is never logged');
  });

  test('/api/quote readiness probe (GET) is never limited', async () => {
    const ip = '203.0.113.201';
    for (let i = 0; i < RL.RULES.quote_ip.limit + 5; i += 1) {
      const r = res();
      await quoteHandler(req(ip, { method: 'GET' }), r);
      assert.equal(r.statusCode, 200);
    }
  });

  test('an unconfigured mailbox still gets its 503 fallback, not a 429', async () => {
    delete process.env.RESEND_API_KEY;
    const ip = '203.0.113.202';
    for (let i = 0; i < RL.RULES.quote_ip.limit + 3; i += 1) {
      const r = res();
      await quoteHandler(req(ip), r);
      assert.equal(r.statusCode, 503);
      assert.equal(r.payload.notConfigured, true);
    }
  });

  test('/api/upload-token returns 429 once its own limit is spent', async () => {
    const ip = '203.0.113.210';
    for (let i = 0; i < RL.RULES.upload_ip.limit; i += 1) {
      const r = res();
      await uploadHandler(req(ip), r);
      assert.equal(r.statusCode, 400); /* no files listed */
    }
    const r = res();
    await uploadHandler(req(ip), r);
    assert.equal(r.statusCode, 429);
    assert.equal(r.payload.error, QL.CUSTOMER_MESSAGE);
  });
});
