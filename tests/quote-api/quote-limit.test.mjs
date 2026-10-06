/*
 * Rate limiting on the quote form (api/_quote-limit.js, api/quote.js,
 * api/upload-token.js).
 *
 * NO EMULATOR, NO NETWORK. The shared layer is exercised with the REAL
 * limiter from api/_chat/rate-limit.js running against a small in-memory
 * stand-in for Firestore, so the transaction and window logic under test is
 * the production code. No email is sent: Resend and Cloudflare Siteverify are
 * both played by the harness's fake fetch.
 *
 * Limits (api/_chat/rate-limit.js RULES), consumed together per kind:
 *   quote:  quote_burst_ip 2 / 5 min  +  quote_ip 4 / hour
 *   upload: upload_burst_ip 4 / 5 min +  upload_ip 10 / hour
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  QL, QG, RL, L, quoteHandler, uploadHandler, MB, HOUR, SECRET, sharedEnv,
  fakeDb, req, call, captureLogs, installFakeBlob, installFakeFetch, setEnv,
  validQuote, validUpload, passToken, freshIp, stamp
} from './harness.mjs';

const MIN5 = 5 * 60 * 1000;

let logs;
beforeEach(() => { logs = captureLogs(); });
afterEach(() => { logs.restore(); });

describe('the limits themselves', () => {
  test('quote and upload each have a burst and an hourly scope, separate from chat', () => {
    assert.deepEqual(QL.SCOPES, {
      quote: ['quote_burst_ip', 'quote_ip'],
      upload: ['upload_burst_ip', 'upload_ip']
    });
    assert.deepEqual(RL.RULES.quote_burst_ip, { limit: 2, windowMs: MIN5 });
    assert.deepEqual(RL.RULES.quote_ip, { limit: 4, windowMs: HOUR });
    assert.deepEqual(RL.RULES.upload_burst_ip, { limit: 4, windowMs: MIN5 });
    assert.deepEqual(RL.RULES.upload_ip, { limit: 10, windowMs: HOUR });
  });

  test('the chat limits are untouched', () => {
    assert.deepEqual(RL.RULES.start_uid, { limit: 3, windowMs: 10 * 60 * 1000 });
    assert.deepEqual(RL.RULES.start_ip, { limit: 8, windowMs: HOUR });
    assert.deepEqual(RL.RULES.send_uid, { limit: 20, windowMs: 60 * 1000 });
    assert.deepEqual(RL.RULES.send_ip, { limit: 60, windowMs: 60 * 1000 });
    assert.deepEqual(RL.RULES.staff_write, { limit: 60, windowMs: 60 * 1000 });
    assert.deepEqual(RL.RULES.staff_read, { limit: 120, windowMs: 60 * 1000 });
    assert.deepEqual(RL.RULES.replay_uid, { limit: 120, windowMs: 60 * 1000 });
  });

  test('an unknown kind is a programming error, not a silent pass', async () => {
    await assert.rejects(() => QL.check(req('1.2.3.4'), 'nope', { env: {} }));
  });
});

describe('in-memory layer (always on)', () => {
  test('BURST: two quotes inside five minutes, the third refused until the burst window ends', async () => {
    const memory = QL.createMemoryLimiter();
    const t0 = 1_000_000;
    assert.equal((await QL.check(req('203.0.113.5'), 'quote', { env: {}, memory, now: t0 })).limited, false);
    assert.equal((await QL.check(req('203.0.113.5'), 'quote', { env: {}, memory, now: t0 + 1000 })).limited, false);
    const r = await QL.check(req('203.0.113.5'), 'quote', { env: {}, memory, now: t0 + 60_000 });
    assert.equal(r.limited, true);
    assert.equal(r.retryAfterSeconds, (MIN5 - 60_000) / 1000);
  });

  test('HOURLY: four quotes an hour even when spaced past the burst window', async () => {
    const memory = QL.createMemoryLimiter();
    const t0 = 2_000_000;
    for (let i = 0; i < 4; i += 1) {
      const r = await QL.check(req('203.0.113.6'), 'quote', { env: {}, memory, now: t0 + i * MIN5 });
      assert.equal(r.limited, false, 'quote ' + (i + 1));
    }
    const r = await QL.check(req('203.0.113.6'), 'quote', { env: {}, memory, now: t0 + 4 * MIN5 });
    assert.equal(r.limited, true);
    assert.equal(r.retryAfterSeconds, (HOUR - 4 * MIN5) / 1000);
  });

  test('a refused request spends nothing: all-or-nothing across both scopes', async () => {
    const memory = QL.createMemoryLimiter();
    const t0 = 3_000_000;
    await QL.check(req('203.0.113.7'), 'quote', { env: {}, memory, now: t0 });
    await QL.check(req('203.0.113.7'), 'quote', { env: {}, memory, now: t0 });
    /* Ten refusals inside the burst window... */
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await QL.check(req('203.0.113.7'), 'quote', { env: {}, memory, now: t0 + 1 })).limited, true);
    }
    /* ...did not touch the hourly count: two more fit after the burst ends. */
    assert.equal((await QL.check(req('203.0.113.7'), 'quote', { env: {}, memory, now: t0 + MIN5 })).limited, false);
    assert.equal((await QL.check(req('203.0.113.7'), 'quote', { env: {}, memory, now: t0 + MIN5 + 1 })).limited, false);
    assert.equal((await QL.check(req('203.0.113.7'), 'quote', { env: {}, memory, now: t0 + 2 * MIN5 })).limited, true,
      'the fifth in the hour');
  });

  test('the windows roll over', async () => {
    const memory = QL.createMemoryLimiter();
    const t0 = 5_000_000;
    for (let i = 0; i < 4; i += 1) {
      await QL.check(req('203.0.113.8'), 'quote', { env: {}, memory, now: t0 + i * MIN5 });
    }
    assert.equal((await QL.check(req('203.0.113.8'), 'quote', { env: {}, memory, now: t0 + HOUR - 1 })).limited, true);
    assert.equal((await QL.check(req('203.0.113.8'), 'quote', { env: {}, memory, now: t0 + HOUR })).limited, false);
  });

  test('upload: four in a burst, ten an hour', async () => {
    const memory = QL.createMemoryLimiter();
    const t0 = 7_000_000;
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await QL.check(req('203.0.113.9'), 'upload', { env: {}, memory, now: t0 })).limited, false);
    }
    assert.equal((await QL.check(req('203.0.113.9'), 'upload', { env: {}, memory, now: t0 })).limited, true);
    let t = t0 + MIN5;
    for (let i = 0; i < 6; i += 1) {
      assert.equal((await QL.check(req('203.0.113.9'), 'upload', { env: {}, memory, now: t })).limited, false);
      if (i % 4 === 3) t += MIN5;
    }
    assert.equal((await QL.check(req('203.0.113.9'), 'upload', { env: {}, memory, now: t + MIN5 })).limited, true,
      'the eleventh in the hour');
  });

  test('different addresses and different kinds have their own buckets', async () => {
    const memory = QL.createMemoryLimiter();
    for (let i = 0; i < 2; i += 1) await QL.check(req('198.51.100.1'), 'quote', { env: {}, memory, now: 1 });
    assert.equal((await QL.check(req('198.51.100.1'), 'quote', { env: {}, memory, now: 2 })).limited, true);
    assert.equal((await QL.check(req('198.51.100.2'), 'quote', { env: {}, memory, now: 2 })).limited, false);
    assert.equal((await QL.check(req('198.51.100.1'), 'upload', { env: {}, memory, now: 2 })).limited, false);
  });

  test('1.2.3.4 and ::ffff:1.2.3.4 are one caller, not two allowances', async () => {
    const memory = QL.createMemoryLimiter();
    await QL.check(req('1.2.3.4'), 'quote', { env: {}, memory, now: 1 });
    await QL.check(req('::ffff:1.2.3.4'), 'quote', { env: {}, memory, now: 1 });
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

  test('holds across server instances (burst and hourly), which memory cannot', async () => {
    const db = fakeDb();
    const shared = { env: sharedEnv(), initAdmin: async () => ({ db }) };
    const at = (now) => Object.assign({ memory: QL.createMemoryLimiter(), now }, shared);
    /* Every request lands on a fresh "instance" with an empty memory table. */
    assert.equal((await QL.check(req('192.0.2.9'), 'quote', at(100))).limited, false);
    assert.equal((await QL.check(req('192.0.2.9'), 'quote', at(101))).limited, false);
    const burst = await QL.check(req('192.0.2.9'), 'quote', at(102));
    assert.equal(burst.limited, true);
    assert.ok(burst.retryAfterSeconds > 0);
    /* Past the burst window: two more, then the hourly cap. */
    assert.equal((await QL.check(req('192.0.2.9'), 'quote', at(100 + MIN5))).limited, false);
    assert.equal((await QL.check(req('192.0.2.9'), 'quote', at(101 + MIN5))).limited, false);
    const hourly = await QL.check(req('192.0.2.9'), 'quote', at(100 + 2 * MIN5));
    assert.equal(hourly.limited, true);
    assert.equal(hourly.retryAfterSeconds, Math.ceil((HOUR - 2 * MIN5) / 1000));
  });

  test('consumeMany is all-or-nothing: a refusal writes nothing', async () => {
    const db = fakeDb();
    await RL.consumeMany(db, ['quote_burst_ip', 'quote_ip'], 'x', SECRET, { now: 1 });
    await RL.consumeMany(db, ['quote_burst_ip', 'quote_ip'], 'x', SECRET, { now: 2 });
    const before = JSON.stringify([...db.docs.entries()]);
    await assert.rejects(() => RL.consumeMany(db, ['quote_burst_ip', 'quote_ip'], 'x', SECRET, { now: 3 }),
      (e) => e instanceof RL.RateLimitError && e.retryAfterSeconds > 0);
    assert.equal(JSON.stringify([...db.docs.entries()]), before, 'no bucket changed');
    await assert.rejects(() => RL.consumeMany(db, ['no_such_scope'], 'x', SECRET));
  });

  test('stores no raw address - document ids are an HMAC under a quote scope', async () => {
    const db = fakeDb();
    await QL.check(req('192.0.2.77'), 'quote',
      { env: sharedEnv(), memory: QL.createMemoryLimiter(), initAdmin: async () => ({ db }) });
    const entries = [...db.docs.entries()];
    assert.equal(entries.length, 2, 'one bucket per scope');
    for (const [path, doc] of entries) {
      assert.match(path, /^chatRateLimits\/quote_(burst_)?ip_[0-9a-f]{32}$/);
      assert.equal(JSON.stringify(doc).includes('192.0.2.77'), false);
      assert.equal(path.includes('192.0.2.77'), false);
    }
  });

  test('fails OPEN when Firestore errors, and logs only a reason token', async () => {
    const deps = {
      env: sharedEnv(),
      memory: QL.createMemoryLimiter(),
      initAdmin: async () => { const e = new Error('boom at 192.0.2.50'); e.code = 'unavailable'; throw e; }
    };
    assert.equal((await QL.check(req('192.0.2.50'), 'quote', deps)).limited, false);
    const joined = logs.text();
    assert.match(joined, /shared limiter unavailable, allowing: unavailable/);
    assert.equal(joined.includes('192.0.2.50'), false);
  });

  test('the memory layer still applies while the shared one is down', async () => {
    const memory = QL.createMemoryLimiter();
    const deps = { env: sharedEnv(), memory, initAdmin: async () => { throw new Error('down'); } };
    await QL.check(req('192.0.2.51'), 'quote', deps);
    await QL.check(req('192.0.2.51'), 'quote', deps);
    assert.equal((await QL.check(req('192.0.2.51'), 'quote', deps)).limited, true);
  });
});

/* ------------------------------------------------------------ endpoints */

/* Every way a manifest size can be wrong or dishonest. */
const BAD_SIZES = [0, -1, 1.5, NaN, Infinity, -Infinity, '3145728', '3e6', null, undefined,
  true, {}, [], 2 ** 53, 25 * MB + 1];

describe('the endpoints', () => {
  let blob, net, restoreEnv;
  beforeEach(() => { restoreEnv = setEnv(); blob = installFakeBlob(); net = installFakeFetch(); });
  afterEach(() => { blob.restore(); net.restore(); restoreEnv(); });

  /* ---------------------------------------------------------- /api/quote */

  test('/api/quote: malformed POSTs do not consume the allowance', async () => {
    const ip = freshIp();
    const malformed = [
      {}, 'not json at all', validQuote({ name: 'P' }),
      validQuote({ email: 'nope' }), validQuote({ text: '   ' }),
      validQuote({ text: 'x'.repeat(L.MAX_TEXT_CHARS + 1) }),
      validQuote({ files: [1, 2, 3, 4, 5, 6] }),
      validQuote({ files: [{ pathname: 'someone-elses/file.pdf' }] }),
      validQuote({ files: [null] }),
      validQuote({ files: [{ pathname: 'quotes/2026/09/' + 'a'.repeat(32) + '/1-x.exe' }] })
    ];
    for (let round = 0; round < 3 * 4; round += 1) {
      const out = await call(quoteHandler, req(ip, { body: malformed[round % malformed.length] }));
      assert.ok([400, 415].includes(out.statusCode), 'got ' + out.statusCode);
    }
    assert.equal(net.sent.length, 0);
    assert.equal(net.siteverify.length, 0, 'malformed requests never reach Cloudflare');
    assert.equal(blob.calls.head.length, 0, 'no Blob lookups for a malformed request');

    /* The real customer at the same address still gets the full burst. */
    for (let i = 0; i < 2; i += 1) {
      const out = await call(quoteHandler, req(ip, { body: validQuote() }));
      assert.equal(out.statusCode, 200, 'valid quote ' + (i + 1));
    }
    assert.equal(net.sent.length, 2);
  });

  test('/api/quote: unverified requests do not consume the allowance either', async () => {
    const ip = freshIp();
    for (let i = 0; i < 8; i += 1) {
      const out = await call(quoteHandler, req(ip, { body: validQuote({ turnstileToken: 'fail~invalid-input-response~' + i }) }));
      assert.equal(out.statusCode, 403);
    }
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await call(quoteHandler, req(ip, { body: validQuote() }))).statusCode, 200);
    }
  });

  test('/api/quote: two valid quotes in a burst, the third refused with 429 before any email', async () => {
    const ip = freshIp();
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await call(quoteHandler, req(ip, { body: validQuote() }))).statusCode, 200);
    }
    const out = await call(quoteHandler, req(ip, { body: validQuote() }));
    assert.equal(out.statusCode, 429);
    assert.equal(out.payload.ok, false);
    assert.equal(out.payload.rateLimited, true);
    assert.equal(out.payload.error, QL.CUSTOMER_MESSAGE);
    assert.ok(Number(out.headers['retry-after']) > 0);
    assert.ok(Number(out.headers['retry-after']) <= 300, 'the burst window, not the hour');
    assert.equal(net.sent.length, 2, 'the refused request sent nothing');
    assert.equal(logs.text().includes(ip), false, 'the address is never logged');
  });

  test('/api/quote: once limited, a well-formed quote with an attachment is refused BEFORE any Blob lookup', async () => {
    const ip = freshIp();
    for (let i = 0; i < 2; i += 1) await call(quoteHandler, req(ip, { body: validQuote() }));
    const out = await call(quoteHandler, req(ip, { body: validQuote({
      files: [{ pathname: 'quotes/2026/09/' + 'b'.repeat(32) + '/1-plan.pdf' }] }) }));
    assert.equal(out.statusCode, 429);
    assert.equal(blob.calls.head.length, 0);
  });

  test('/api/quote: readiness probe (GET) is never limited and publishes only public values', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      const out = await call(quoteHandler, req(ip, { method: 'GET' }));
      assert.equal(out.statusCode, 200);
      assert.equal(out.payload.ready, true);
      assert.equal(out.payload.turnstileSiteKey, process.env.TURNSTILE_SITE_KEY);
      assert.match(out.payload.formStamp, /^[0-9a-z]+\.[A-Za-z0-9_-]{43}$/);
      const raw = JSON.stringify(out.payload);
      assert.equal(raw.includes(process.env.TURNSTILE_SECRET_KEY), false, 'secret never returned');
      assert.equal(raw.includes(process.env.RESEND_API_KEY), false);
      assert.equal(raw.includes(process.env.CHAT_RATE_LIMIT_SECRET), false);
    }
  });

  test('/api/quote: an unconfigured mailbox still gets its 503 fallback, not a 429', async () => {
    delete process.env.RESEND_API_KEY;
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      const out = await call(quoteHandler, req(ip, { body: validQuote() }));
      assert.equal(out.statusCode, 503);
      assert.equal(out.payload.notConfigured, true);
    }
  });

  /* --------------------------------------------------- /api/upload-token */

  test('/api/upload-token: invalid manifests do not consume the allowance', async () => {
    const ip = freshIp();
    const invalid = [
      {}, 'garbage', validUpload([]), validUpload('x'),
      validUpload([{ name: 'a.pdf', size: 26 * MB }]),
      validUpload([{ name: 'a.exe', size: 1000 }]),
      validUpload([{ name: '', size: 1000 }]),
      validUpload(Array.from({ length: 6 }, (_, i) => ({ name: i + '.pdf', size: 1000 }))),
      validUpload(Array.from({ length: 4 }, (_, i) => ({ name: i + '.pdf', size: 20 * MB }))),
      ...BAD_SIZES.map((size) => validUpload([{ name: 'a.pdf', size }]))
    ];
    for (let round = 0; round < 40; round += 1) {
      const out = await call(uploadHandler, req(ip, { body: invalid[round % invalid.length] }));
      assert.ok([400, 413].includes(out.statusCode), 'got ' + out.statusCode);
    }
    assert.equal(blob.calls.issue.length, 0);
    assert.equal(blob.calls.presign.length, 0);
    assert.equal(net.siteverify.length, 0, 'invalid manifests never reach Cloudflare');

    /* The full burst allowance is still there. */
    for (let i = 0; i < 4; i += 1) {
      const out = await call(uploadHandler, req(ip, { body: validUpload() }));
      assert.equal(out.statusCode, 200, 'valid manifest ' + (i + 1));
    }
  });

  test('/api/upload-token: four valid manifests in a burst, the fifth refused before any permission', async () => {
    const ip = freshIp();
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await call(uploadHandler, req(ip, { body: validUpload() }))).statusCode, 200);
    }
    const issuedBefore = blob.calls.issue.length;
    const out = await call(uploadHandler, req(ip, { body: validUpload() }));
    assert.equal(out.statusCode, 429);
    assert.equal(out.payload.error, QL.CUSTOMER_MESSAGE);
    assert.ok(Number(out.headers['retry-after']) > 0);
    assert.equal(blob.calls.issue.length, issuedBefore, 'no permission issued once limited');
  });

  /* ------------------------------------------------- upload size ceiling */

  test('a declared 3 MB file gets a 3 MB permission, never a 25 MB one', async () => {
    const out = await call(uploadHandler, req(freshIp(),
      { body: validUpload([{ name: 'photo.jpg', size: 3 * MB }]) }));
    assert.equal(out.statusCode, 200);
    assert.equal(blob.calls.issue.length, 1);
    assert.equal(blob.calls.presign.length, 1);
    assert.equal(blob.calls.issue[0].maximumSizeInBytes, 3 * MB);
    assert.equal(blob.calls.presign[0].maximumSizeInBytes, 3 * MB);
    assert.ok(blob.calls.issue[0].maximumSizeInBytes < L.MAX_FILE_BYTES);
  });

  test('each file in a manifest gets its own declared size, in BOTH the token and the URL', async () => {
    const sizes = [1, 700 * 1024, 3 * MB, 10 * MB + 17, 12 * MB];
    const out = await call(uploadHandler, req(freshIp(),
      { body: validUpload(sizes.map((size, i) => ({ name: 'f' + i + '.pdf', size }))) }));
    assert.equal(out.statusCode, 200);
    assert.deepEqual(blob.calls.issue.map((c) => c.maximumSizeInBytes), sizes);
    assert.deepEqual(blob.calls.presign.map((c) => c.maximumSizeInBytes), sizes);
    assert.deepEqual(blob.calls.issue.map((c) => c.pathname), blob.calls.presign.map((c) => c.pathname));
  });

  test('five files can never be authorised beyond 75 MB in total', async () => {
    const atLimit = Array.from({ length: 5 }, (_, i) => ({ name: i + '.pdf', size: 15 * MB }));
    let out = await call(uploadHandler, req(freshIp(), { body: validUpload(atLimit) }));
    assert.equal(out.statusCode, 200);
    const total = blob.calls.issue.reduce((n, c) => n + c.maximumSizeInBytes, 0);
    assert.equal(total, L.MAX_TOTAL_BYTES);
    assert.ok(blob.calls.presign.reduce((n, c) => n + c.maximumSizeInBytes, 0) <= L.MAX_TOTAL_BYTES);

    const issued = blob.calls.issue.length;
    const over = atLimit.map((f) => ({ ...f }));
    over[4].size += 1;
    out = await call(uploadHandler, req(freshIp(), { body: validUpload(over) }));
    assert.equal(out.statusCode, 413);
    assert.equal(blob.calls.issue.length, issued);

    const tiny = Array.from({ length: 5 }, (_, i) => ({ name: i + '.pdf', size: 10 }));
    out = await call(uploadHandler, req(freshIp(), { body: validUpload(tiny) }));
    assert.equal(out.statusCode, 200);
    assert.deepEqual(blob.calls.issue.slice(-5).map((c) => c.maximumSizeInBytes), [10, 10, 10, 10, 10]);
  });

  test('a manipulated or invalid size is rejected before any permission is issued', async () => {
    for (const size of BAD_SIZES) {
      const out = await call(uploadHandler, req(freshIp(),
        { body: validUpload([{ name: 'a.pdf', size }]) }));
      assert.equal(out.statusCode, 413, 'size ' + String(size) + ' should be refused');
      const mixed = await call(uploadHandler, req(freshIp(),
        { body: validUpload([{ name: 'ok.pdf', size: 1000 }, { name: 'b.pdf', size }]) }));
      assert.equal(mixed.statusCode, 413);
    }
    assert.equal(blob.calls.issue.length, 0);
    assert.equal(blob.calls.presign.length, 0);
  });

  test('legitimate 25 MB files are still allowed when the combined total permits', async () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ name: i + '.pdf', size: L.MAX_FILE_BYTES }));
    const out = await call(uploadHandler, req(freshIp(), { body: validUpload(three) }));
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
