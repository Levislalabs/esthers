/*
 * R2 audit fixes, server side:
 *   - duplicate suppression tells a REVISED file from a re-upload of the same
 *     one, using a server-derived content digest (api/_lib.js contentDigest);
 *   - Turnstile challenge_ts is validated FAIL-CLOSED (api/_quote-guard.js).
 *
 * NO NETWORK. Blob objects are virtual (harness.mjs): same seed = same bytes,
 * different seed = different bytes, every byte range servable. Siteverify and
 * Resend are fakes.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  QG, L, quoteHandler, req, call, captureLogs, installFakeBlob, installFakeFetch,
  setEnv, validQuote, passToken, freshIp, storedFile, blobObjects, stamp, sharedEnv,
  fakeDb, MB, TURNSTILE_SECRET
} from './harness.mjs';

let logs, blob, net, restoreEnv;
beforeEach(() => {
  logs = captureLogs();
  restoreEnv = setEnv();
  blob = installFakeBlob();
  net = installFakeFetch();
});
afterEach(() => { net.restore(); blob.restore(); restoreEnv(); logs.restore(); });

const quote = (body, ip) => call(quoteHandler, req(ip || freshIp(), { body }));
/* The same request again, as a browser would resend it: fresh token + stamp. */
const again = (base, over) => Object.assign({}, base,
  { turnstileToken: passToken(QG.ACTIONS.quote), formStamp: stamp() }, over || {});

/* ======================================= DUPLICATES: CONTENT, NOT JUST NAME */

describe('duplicate suppression distinguishes file CONTENT', () => {
  test('same name + same content + same quote -> duplicate', async () => {
    const base = validQuote({ files: [{ pathname: storedFile('plan.pdf', { seed: 'rev-A' }) }] });
    assert.equal((await quote(base)).statusCode, 200);
    const out = await quote(again(base));
    assert.equal(out.statusCode, 409);
    assert.equal(out.payload.duplicate, true);
    assert.equal(net.sent.length, 1);
  });

  test('same name + CHANGED content + same quote -> ALLOWED (a revised drawing)', async () => {
    const base = validQuote({ files: [{ pathname: storedFile('plan.pdf', { seed: 'rev-A' }) }] });
    assert.equal((await quote(base)).statusCode, 200);
    const revised = again(base, { files: [{ pathname: storedFile('plan.pdf', { seed: 'rev-B' }) }] });
    const out = await quote(revised);
    assert.equal(out.statusCode, 200, JSON.stringify(out.payload));
    assert.equal(net.sent.length, 2);
  });

  /* The hardest realistic revisions: identical header, identical length,
     only the MIDDLE or only the END changed. Everything else byte-identical. */
  for (const [label, region] of [
    ['only the MIDDLE changed', (size) => ({ from: size / 2 - 300, to: size / 2 + 300 })],
    ['only the END changed', (size) => ({ from: size - 400, to: size })]
  ]) {
    test('same name + same SIZE + same first 512 bytes, ' + label + ' -> ALLOWED', async () => {
      const size = 200_000;
      const a = storedFile('plan.pdf', { seed: 'same', size, regions: [Object.assign({ seed: 'rev-A' }, region(size))] });
      const b = storedFile('plan.pdf', { seed: 'same', size, regions: [Object.assign({ seed: 'rev-B' }, region(size))] });
      assert.equal(L.SAMPLE_BYTES, 512);
      /* Prove the setup: identical first 512 bytes, identical size. */
      const head = async (p) => (await L.verifySignature('https://blob.invalid/' + p, 'pdf')).head.subarray(0, 512);
      assert.deepEqual(await head(a), await head(b));
      const base = validQuote({ files: [{ pathname: a }] });
      assert.equal((await quote(base)).statusCode, 200);
      assert.equal((await quote(again(base, { files: [{ pathname: b }] }))).statusCode, 200);
      assert.equal(net.sent.length, 2);
    });
  }

  test('re-upload at a DIFFERENT random Blob path with identical content -> duplicate', async () => {
    const first = storedFile('plan.pdf', { seed: 'same-bytes' });
    const second = storedFile('plan.pdf', { seed: 'same-bytes' });
    assert.notEqual(first, second, 'two different storage paths');
    const base = validQuote({ files: [{ pathname: first }] });
    assert.equal((await quote(base)).statusCode, 200);
    assert.equal((await quote(again(base, { files: [{ pathname: second }] }))).statusCode, 409);
    assert.equal(net.sent.length, 1);
  });

  test('a large file re-uploaded with identical content is still a duplicate (sampled digest)', async () => {
    const size = 24 * MB;
    const base = validQuote({ files: [{ pathname: storedFile('scan.pdf', { seed: 'big', size }) }] });
    assert.equal((await quote(base)).statusCode, 200);
    assert.equal((await quote(again(base, { files: [{ pathname: storedFile('scan.pdf', { seed: 'big', size }) }] }))).statusCode, 409);
    /* Only small ranges were read: never the whole 24 MB. */
    for (const r of net.ranges) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(r);
      assert.ok(m && Number(m[2]) - Number(m[1]) + 1 <= 1024, 'small range only: ' + r);
    }
  });

  test('changed filename (same content) and an added file are allowed; order does not matter', async () => {
    const base = validQuote({ files: [
      { pathname: storedFile('plan.pdf', { seed: 'p', index: 1 }) },
      { pathname: storedFile('photo.jpg', { seed: 'j', index: 2 }) }] });
    assert.equal((await quote(base)).statusCode, 200);
    /* Same two files, re-uploaded, other order -> duplicate */
    assert.equal((await quote(again(base, { files: [
      { pathname: storedFile('photo.jpg', { seed: 'j', index: 1 }) },
      { pathname: storedFile('plan.pdf', { seed: 'p', index: 2 }) }] }))).statusCode, 409);
    /* Renamed file -> allowed */
    assert.equal((await quote(again(base, { files: [
      { pathname: storedFile('plan-v2.pdf', { seed: 'p', index: 1 }) },
      { pathname: storedFile('photo.jpg', { seed: 'j', index: 2 }) }] }))).statusCode, 200);
    /* Added file -> allowed */
    assert.equal((await quote(again(base, { files: [
      { pathname: storedFile('plan.pdf', { seed: 'p', index: 1 }) },
      { pathname: storedFile('photo.jpg', { seed: 'j', index: 2 }) },
      { pathname: storedFile('roof.jpg', { seed: 'r', index: 3 }) }] }))).statusCode, 200);
    assert.equal(net.sent.length, 3);
  });

  test('if the content samples cannot be read, the request is NOT treated as a duplicate', async () => {
    const base = validQuote({ files: [{ pathname: storedFile('plan.pdf', { seed: 'x' }) }] });
    assert.equal((await quote(base)).statusCode, 200);
    net.rangeMode = 'fail-samples';
    /* Identical content, but the middle/end reads fail: sent, not silently dropped. */
    const out = await quote(again(base, { files: [{ pathname: storedFile('plan.pdf', { seed: 'x' }) }] }));
    assert.equal(out.statusCode, 200);
    assert.equal(net.sent.length, 2);
    assert.match(logs.text(), /content digest unavailable at index 0/);
  });

  test('Firestore duplicate document holds no customer text, name, email or file content', async () => {
    const db = fakeDb();
    const p = storedFile('secret-plan.pdf', { seed: 'priv' });
    const v = await L.verifySignature('https://blob.invalid/' + p, 'pdf');
    const digest = await L.contentDigest('https://blob.invalid/' + p, blobObjects.get(p).size, v.head);
    assert.match(digest, /^[0-9a-f]{64}$/, 'a REAL digest, so the check below is not vacuous');
    const r = await QG.reserveDuplicate(
      { name: 'Secret Name', email: 'secret@example.test', text: 'secret quote text',
        files: [{ name: 'secret-plan.pdf', digest }] },
      { env: sharedEnv(), now: 1, memory: QG.createMemoryDuplicates(), initAdmin: async () => ({ db }) });
    await r.confirm(2);
    const [[path, doc]] = [...db.docs.entries()];
    assert.match(path, /^quoteDuplicates\/[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(doc).sort(), ['at', 'expireAt', 'status']);
    const raw = (path + JSON.stringify(doc)).toLowerCase();
    for (const s of ['secret name', 'secret@example.test', 'secret quote text', 'secret-plan', String(digest)]) {
      assert.equal(raw.includes(s), false, s);
    }
  });
});

describe('contentDigest (api/_lib.js)', () => {
  const url = (p) => 'https://blob.invalid/' + p;

  test('identical content -> identical digest; any changed sample -> different; 64 hex', async () => {
    const a = storedFile('a.pdf', { seed: 's', size: 50_000 });
    const b = storedFile('b.pdf', { seed: 's', size: 50_000 });
    const c = storedFile('c.pdf', { seed: 't', size: 50_000 });
    const d = storedFile('d.pdf', { seed: 's', size: 50_001 });
    const sig = async (p) => {
      const v = await L.verifySignature(url(p), 'pdf');
      assert.equal(v.ok, true);
      return L.contentDigest(url(p), blobObjects.get(p).size, v.head);
    };
    const [da, db, dc, dd] = [await sig(a), await sig(b), await sig(c), await sig(d)];
    assert.match(da, /^[0-9a-f]{64}$/);
    assert.equal(da, db);
    assert.notEqual(da, dc);
    assert.notEqual(da, dd, 'size is part of it');
  });

  test('small files (<= 1536 bytes) are hashed in full with one extra range read', async () => {
    const p = storedFile('tiny.pdf', { seed: 'z', size: 1200 });
    const v = await L.verifySignature(url(p), 'pdf');
    const before = net.ranges.length;
    assert.match(await L.contentDigest(url(p), 1200, v.head), /^[0-9a-f]{64}$/);
    assert.deepEqual(net.ranges.slice(before), ['bytes=512-1199']);
  });

  test('a server that ignores Range is never read whole: digest is null', async () => {
    const p = storedFile('a.pdf', { seed: 'q', size: 9000 });
    const v = await L.verifySignature(url(p), 'pdf');
    net.rangeMode = 'ignore';
    assert.equal(await L.contentDigest(url(p), 9000, v.head), null);
  });

  test('bad inputs give null, never a throw', async () => {
    assert.equal(await L.contentDigest(url('x'), 0, Buffer.alloc(1)), null);
    assert.equal(await L.contentDigest(url('x'), -5, Buffer.alloc(1)), null);
    assert.equal(await L.contentDigest(url('x'), 1.5, Buffer.alloc(1)), null);
    assert.equal(await L.contentDigest(url('x'), 100, 'not a buffer'), null);
    assert.equal(await L.contentDigest(url('x'), 100, Buffer.alloc(10)), null, 'head shorter than it should be');
  });
});

/* ======================================== challenge_ts, FAIL CLOSED */

describe('Turnstile challenge_ts is validated fail-closed (real secret)', () => {
  function refused(out) {
    assert.equal(out.statusCode, 403);
    assert.equal(out.payload.verificationFailed, true);
    assert.equal(out.payload.error, QG.VERIFY_MESSAGE);
    assert.equal(/challenge|timestamp|siteverify/i.test(JSON.stringify(out.payload)), false,
      'no provider internals');
  }

  test('success:true but challenge_ts MISSING -> refused', async () => {
    net.challengeTs = net.OMIT;
    refused(await quote(validQuote()));
    assert.equal(net.sent.length, 0);
    assert.match(logs.text(), /refused: turnstile_bad_timestamp/);
  });

  test('challenge_ts null / empty / number / object -> refused', async () => {
    for (const v of [null, '', 1733500000, { t: 1 }, ['2026-10-06T00:00:00Z']]) {
      net.tsValue = v;
      refused(await quote(validQuote()));
    }
    assert.equal(net.sent.length, 0);
  });

  test('challenge_ts an unparseable string -> refused', async () => {
    for (const v of ['yesterday', 'not-a-date', '2026-13-45T99:99:99Z', 'NaN']) {
      net.tsValue = v;
      refused(await quote(validQuote()));
    }
    assert.equal(net.sent.length, 0);
  });

  test('stale (older than the permitted age) -> refused', async () => {
    net.tsValue = new Date(Date.now() - QG.TOKEN_MAX_AGE_MS - 1000).toISOString();
    refused(await quote(validQuote()));
    assert.match(logs.text(), /refused: turnstile_stale/);
  });

  test('implausibly in the future -> refused; small clock skew -> accepted', async () => {
    net.tsValue = new Date(Date.now() + QG.TOKEN_FUTURE_SKEW_MS + 5000).toISOString();
    refused(await quote(validQuote()));
    net.tsValue = new Date(Date.now() + 20_000).toISOString();
    assert.equal((await quote(validQuote())).statusCode, 200);
  });

  test('a valid recent timestamp -> accepted', async () => {
    net.tsValue = new Date(Date.now() - 60_000).toISOString();
    assert.equal((await quote(validQuote())).statusCode, 200);
    delete net.tsValue;
    assert.equal((await quote(validQuote())).statusCode, 200);
    assert.equal(net.sent.length, 2);
  });

  test('the same rules hold at the module level', async () => {
    const env = { TURNSTILE_SITE_KEY: 'x-site', TURNSTILE_SECRET_KEY: TURNSTILE_SECRET };
    const now = Date.parse('2026-10-06T12:00:00Z');
    const verdict = async (body) => QG.verifyTurnstile('tok-' + Math.random(), {
      action: QG.ACTIONS.quote, env, now,
      fetch: async () => ({ ok: true, status: 200, json: async () => Object.assign(
        { success: true, action: QG.ACTIONS.quote, hostname: 'www.esthers.ca' }, body) })
    });
    assert.equal((await verdict({})).reason, 'turnstile_bad_timestamp');
    assert.equal((await verdict({ challenge_ts: null })).reason, 'turnstile_bad_timestamp');
    assert.equal((await verdict({ challenge_ts: 'garbage' })).reason, 'turnstile_bad_timestamp');
    assert.equal((await verdict({ challenge_ts: '2026-10-06T12:05:00Z' })).reason, 'turnstile_bad_timestamp');
    assert.equal((await verdict({ challenge_ts: '2026-10-06T11:54:00Z' })).reason, 'turnstile_stale');
    assert.equal((await verdict({ challenge_ts: '2026-10-06T11:59:00Z' })).ok, true);
  });
});

describe('challenge_ts with Cloudflare DUMMY keys (preview only; refused in production)', () => {
  test('dummy secret: an ABSENT timestamp is tolerated (dummy response body is undocumented)', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    net.acceptSecret = '1x0000000000000000000000000000000AA';
    net.challengeTs = net.OMIT;
    assert.equal((await quote(validQuote())).statusCode, 200);
  });

  test('dummy secret: a PRESENT but bad timestamp is still refused', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    net.acceptSecret = '1x0000000000000000000000000000000AA';
    for (const v of [null, 'garbage', new Date(Date.now() - QG.TOKEN_MAX_AGE_MS - 1000).toISOString()]) {
      net.tsValue = v;
      assert.equal((await quote(validQuote())).statusCode, 403, String(v));
    }
  });

  test('the dummy exemption can never apply in production', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    net.challengeTs = net.OMIT;
    const out = await quote(validQuote());
    assert.equal(out.statusCode, 503);
    assert.equal(net.sent.length, 0);
  });
});
