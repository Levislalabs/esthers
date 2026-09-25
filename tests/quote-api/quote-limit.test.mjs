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
import { fileURLToPath } from 'node:url';

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

/* ------------------------------------------------------------ endpoints */

const MB = 1024 * 1024;
const L = require('../../api/_lib.js');

/* A stand-in for @vercel/blob, installed in require's cache so the handlers'
   own lazy require('@vercel/blob') receives it. It records every call, so a
   test can prove what WOULD have been authorised and that nothing was
   authorised at all when a request is refused. No network is touched. */
/* fileURLToPath, not URL.pathname: on Windows .pathname gives
   "/D:/Esthers%20Sheet%20Metal/..." - percent-encoded, with a leading slash -
   which is not a filesystem path, so resolution fails there. */
const API_DIR = fileURLToPath(new URL('../../api/', import.meta.url));
const BLOB_PATH = require.resolve('@vercel/blob', { paths: [API_DIR] });
function installFakeBlob() {
  const calls = { issue: [], presign: [], head: [] };
  const saved = require.cache[BLOB_PATH];
  require.cache[BLOB_PATH] = {
    id: BLOB_PATH, filename: BLOB_PATH, loaded: true,
    exports: {
      async issueSignedToken(opts) { calls.issue.push(opts); return { signedFor: opts.pathname }; },
      async presignUrl(signed, opts) {
        calls.presign.push(opts);
        return { presignedUrl: 'https://blob.invalid/' + opts.pathname };
      },
      async head(pathname) { calls.head.push(pathname); throw new Error('not used'); }
    }
  };
  return { calls, restore() { if (saved) require.cache[BLOB_PATH] = saved; else delete require.cache[BLOB_PATH]; } };
}

/* Stands in for the Resend API. Counts sends; never reaches the network. */
function installFakeFetch() {
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(String(url));
    return { ok: true, status: 200, json: async () => ({ id: 'fake-' + sent.length }), text: async () => '' };
  };
  return { sent, restore() { globalThis.fetch = orig; } };
}

const validQuote = () => ({
  name: 'Pat Customer', email: 'pat@example.test', text: 'Flashing for a garage roof, 20 ft.'
});

/* Every way a manifest size can be wrong or dishonest. Each must be refused
   by checkManifest before any permission is issued. */
const BAD_SIZES = [0, -1, 1.5, NaN, Infinity, -Infinity, '3145728', '3e6', null, undefined,
  true, {}, [], 2 ** 53, 25 * MB + 1];

async function call(handler, r) { const out = res(); await handler(r, out); return out; }

describe('the endpoints', () => {
  const saved = {};
  const KEYS = ['RESEND_API_KEY', 'QUOTE_TO', 'QUOTE_FROM', 'BLOB_READ_WRITE_TOKEN', 'CHAT_RATE_LIMIT_SECRET',
    'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  let blob, mail;
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.RESEND_API_KEY = 'not-a-real-key';
    process.env.QUOTE_TO = 'shop@example.test';
    process.env.BLOB_READ_WRITE_TOKEN = 'not-a-real-token';
    blob = installFakeBlob();
    mail = installFakeFetch();
  });
  afterEach(() => {
    blob.restore();
    mail.restore();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  /* ---------------------------------------------------------- /api/quote */

  test('/api/quote: malformed POSTs do not consume the allowance', async () => {
    const ip = '203.0.113.100';
    const malformed = [
      {}, 'not json at all', { name: 'P', email: 'pat@example.test', text: 'x' },
      { name: 'Pat', email: 'nope', text: 'x' }, { name: 'Pat', email: 'pat@example.test', text: '   ' },
      { name: 'Pat', email: 'pat@example.test', text: 'x'.repeat(L.MAX_TEXT_CHARS + 1) },
      Object.assign(validQuote(), { files: [1, 2, 3, 4, 5, 6] }),
      Object.assign(validQuote(), { files: [{ pathname: 'someone-elses/file.pdf' }] }),
      Object.assign(validQuote(), { files: [null] }),
      Object.assign(validQuote(), { files: [{ pathname: 'quotes/2026/09/' + 'a'.repeat(32) + '/1-x.exe' }] })
    ];
    /* Three times the whole allowance in garbage. */
    for (let round = 0; round < 3 * RL.RULES.quote_ip.limit; round += 1) {
      const out = await call(quoteHandler, req(ip, { body: malformed[round % malformed.length] }));
      assert.ok([400, 415].includes(out.statusCode), 'got ' + out.statusCode);
    }
    assert.equal(mail.sent.length, 0);
    assert.equal(blob.calls.head.length, 0, 'no Blob lookups for a malformed request');

    /* The real customer at the same address still gets every send. */
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) {
      const out = await call(quoteHandler, req(ip, { body: validQuote() }));
      assert.equal(out.statusCode, 200, 'valid quote ' + (i + 1));
    }
    assert.equal(mail.sent.length, RL.RULES.quote_ip.limit);
  });

  test('/api/quote: valid requests consume it, and the 11th is refused with 429 before any email', async () => {
    const ip = '203.0.113.101';
    assert.equal(RL.RULES.quote_ip.limit, 10);
    for (let i = 0; i < 10; i += 1) {
      const out = await call(quoteHandler, req(ip, { body: validQuote() }));
      assert.equal(out.statusCode, 200);
    }
    const out = await call(quoteHandler, req(ip, { body: validQuote() }));
    assert.equal(out.statusCode, 429);
    assert.equal(out.payload.ok, false);
    assert.equal(out.payload.rateLimited, true);
    assert.equal(out.payload.error, QL.CUSTOMER_MESSAGE);
    assert.ok(Number(out.headers['retry-after']) > 0);
    assert.equal(mail.sent.length, 10, 'the refused request sent nothing');
    assert.equal(logs.lines.join('\n').includes(ip), false, 'the address is never logged');
  });

  test('/api/quote: a well-formed request with attachments is limited BEFORE any Blob lookup', async () => {
    const ip = '203.0.113.102';
    const withFile = () => Object.assign(validQuote(),
      { files: [{ pathname: 'quotes/2026/09/' + 'b'.repeat(32) + '/1-plan.pdf' }] });
    /* Spend the allowance on plain valid quotes, then send one with a file. */
    for (let i = 0; i < RL.RULES.quote_ip.limit; i += 1) await call(quoteHandler, req(ip, { body: validQuote() }));
    const out = await call(quoteHandler, req(ip, { body: withFile() }));
    assert.equal(out.statusCode, 429);
    assert.equal(blob.calls.head.length, 0);
  });

  test('/api/quote: readiness probe (GET) is never limited', async () => {
    const ip = '203.0.113.103';
    for (let i = 0; i < RL.RULES.quote_ip.limit + 5; i += 1) {
      const out = await call(quoteHandler, req(ip, { method: 'GET' }));
      assert.equal(out.statusCode, 200);
    }
  });

  test('/api/quote: an unconfigured mailbox still gets its 503 fallback, not a 429', async () => {
    delete process.env.RESEND_API_KEY;
    const ip = '203.0.113.104';
    for (let i = 0; i < RL.RULES.quote_ip.limit + 3; i += 1) {
      const out = await call(quoteHandler, req(ip, { body: validQuote() }));
      assert.equal(out.statusCode, 503);
      assert.equal(out.payload.notConfigured, true);
    }
  });

  /* --------------------------------------------------- /api/upload-token */

  test('/api/upload-token: invalid manifests do not consume the allowance', async () => {
    const ip = '203.0.113.110';
    const invalid = [
      {}, 'garbage', { files: [] }, { files: 'x' },
      { files: [{ name: 'a.pdf', size: 26 * MB }] },
      { files: [{ name: 'a.exe', size: 1000 }] },
      { files: [{ name: '', size: 1000 }] },
      { files: Array.from({ length: 6 }, (_, i) => ({ name: i + '.pdf', size: 1000 })) },
      { files: Array.from({ length: 4 }, (_, i) => ({ name: i + '.pdf', size: 20 * MB })) },
      ...BAD_SIZES.map((size) => ({ files: [{ name: 'a.pdf', size }] }))
    ];
    for (let round = 0; round < 2 * RL.RULES.upload_ip.limit; round += 1) {
      const out = await call(uploadHandler, req(ip, { body: invalid[round % invalid.length] }));
      assert.ok([400, 413].includes(out.statusCode), 'got ' + out.statusCode);
    }
    assert.equal(blob.calls.issue.length, 0);
    assert.equal(blob.calls.presign.length, 0);

    /* The full allowance is still there. */
    for (let i = 0; i < RL.RULES.upload_ip.limit; i += 1) {
      const out = await call(uploadHandler, req(ip, { body: { files: [{ name: 'a.pdf', size: 1000 }] } }));
      assert.equal(out.statusCode, 200, 'valid manifest ' + (i + 1));
    }
  });

  test('/api/upload-token: valid manifests consume it, and request 21 is refused before any permission', async () => {
    const ip = '203.0.113.111';
    assert.equal(RL.RULES.upload_ip.limit, 20);
    for (let i = 0; i < 20; i += 1) {
      const out = await call(uploadHandler, req(ip, { body: { files: [{ name: 'a.pdf', size: 1000 }] } }));
      assert.equal(out.statusCode, 200);
    }
    const issuedBefore = blob.calls.issue.length;
    const out = await call(uploadHandler, req(ip, { body: { files: [{ name: 'a.pdf', size: 1000 }] } }));
    assert.equal(out.statusCode, 429);
    assert.equal(out.payload.error, QL.CUSTOMER_MESSAGE);
    assert.ok(Number(out.headers['retry-after']) > 0);
    assert.equal(blob.calls.issue.length, issuedBefore, 'no permission issued once limited');
  });

  /* ------------------------------------------------- upload size ceiling */

  test('a declared 3 MB file gets a 3 MB permission, never a 25 MB one', async () => {
    const out = await call(uploadHandler, req('203.0.113.120',
      { body: { files: [{ name: 'photo.jpg', size: 3 * MB }] } }));
    assert.equal(out.statusCode, 200);
    assert.equal(blob.calls.issue.length, 1);
    assert.equal(blob.calls.presign.length, 1);
    assert.equal(blob.calls.issue[0].maximumSizeInBytes, 3 * MB);
    assert.equal(blob.calls.presign[0].maximumSizeInBytes, 3 * MB);
    assert.ok(blob.calls.issue[0].maximumSizeInBytes < L.MAX_FILE_BYTES);
  });

  test('each file in a manifest gets its own declared size, in BOTH the token and the URL', async () => {
    const sizes = [1, 700 * 1024, 3 * MB, 10 * MB + 17, 12 * MB];
    const out = await call(uploadHandler, req('203.0.113.121',
      { body: { files: sizes.map((size, i) => ({ name: 'f' + i + '.pdf', size })) } }));
    assert.equal(out.statusCode, 200);
    assert.deepEqual(blob.calls.issue.map((c) => c.maximumSizeInBytes), sizes);
    assert.deepEqual(blob.calls.presign.map((c) => c.maximumSizeInBytes), sizes);
    /* Token and URL are for the same object. */
    assert.deepEqual(blob.calls.issue.map((c) => c.pathname), blob.calls.presign.map((c) => c.pathname));
  });

  test('five files can never be authorised beyond 75 MB in total', async () => {
    /* Exactly at the combined limit: allowed, and the permissions sum to it. */
    const atLimit = Array.from({ length: 5 }, (_, i) => ({ name: i + '.pdf', size: 15 * MB }));
    let out = await call(uploadHandler, req('203.0.113.122', { body: { files: atLimit } }));
    assert.equal(out.statusCode, 200);
    const total = blob.calls.issue.reduce((n, c) => n + c.maximumSizeInBytes, 0);
    assert.equal(total, L.MAX_TOTAL_BYTES);
    assert.ok(blob.calls.presign.reduce((n, c) => n + c.maximumSizeInBytes, 0) <= L.MAX_TOTAL_BYTES);

    /* One byte over the combined limit: refused, nothing issued. */
    const issued = blob.calls.issue.length;
    const over = atLimit.map((f) => ({ ...f }));
    over[4].size += 1;
    out = await call(uploadHandler, req('203.0.113.123', { body: { files: over } }));
    assert.equal(out.statusCode, 413);
    assert.equal(blob.calls.issue.length, issued);

    /* The old hole: five tiny declared sizes used to get 5 x 25 MB = 125 MB. */
    const tiny = Array.from({ length: 5 }, (_, i) => ({ name: i + '.pdf', size: 10 }));
    out = await call(uploadHandler, req('203.0.113.124', { body: { files: tiny } }));
    assert.equal(out.statusCode, 200);
    const lastFive = blob.calls.issue.slice(-5).map((c) => c.maximumSizeInBytes);
    assert.deepEqual(lastFive, [10, 10, 10, 10, 10]);
  });

  test('a manipulated or invalid size is rejected before any permission is issued', async () => {
    let n = 0;
    for (const size of BAD_SIZES) {
      const out = await call(uploadHandler, req('198.51.100.' + (++n),
        { body: { files: [{ name: 'a.pdf', size }] } }));
      assert.equal(out.statusCode, 413, 'size ' + String(size) + ' should be refused');
      /* One bad entry poisons the whole manifest, even beside good ones. */
      const mixed = await call(uploadHandler, req('198.51.100.' + (++n),
        { body: { files: [{ name: 'ok.pdf', size: 1000 }, { name: 'b.pdf', size }] } }));
      assert.equal(mixed.statusCode, 413);
    }
    assert.equal(blob.calls.issue.length, 0);
    assert.equal(blob.calls.presign.length, 0);
  });

  test('legitimate 25 MB files are still allowed when the combined total permits', async () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ name: i + '.pdf', size: L.MAX_FILE_BYTES }));
    const out = await call(uploadHandler, req('203.0.113.125', { body: { files: three } }));
    assert.equal(out.statusCode, 200);
    assert.equal(out.payload.uploads.length, 3);
    assert.deepEqual(blob.calls.issue.map((c) => c.maximumSizeInBytes), [25 * MB, 25 * MB, 25 * MB]);
    assert.deepEqual(blob.calls.presign.map((c) => c.maximumSizeInBytes), [25 * MB, 25 * MB, 25 * MB]);
  });
});

describe('checkManifest, the size gate', () => {
  test('accepts only safe positive integers and returns null for a good manifest', () => {
    assert.equal(L.checkManifest([{ name: 'a.pdf', size: 1 }]), null);
    assert.equal(L.checkManifest([{ name: 'a.pdf', size: L.MAX_FILE_BYTES }]), null);
    for (const size of BAD_SIZES) {
      assert.equal(typeof L.checkManifest([{ name: 'a.pdf', size }]), 'string', String(size));
    }
  });
});
