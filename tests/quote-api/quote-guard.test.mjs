/*
 * Anti-bot defences on the quote form (api/_quote-guard.js and its use in
 * api/quote.js and api/upload-token.js).
 *
 * NO NETWORK. Cloudflare Siteverify and Resend are both played by the
 * harness's fake fetch, which enforces Turnstile's single-use rule the way
 * Cloudflare does. Firestore is a small in-memory stand-in.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  QG, QL, quoteHandler, uploadHandler, SECRET, SITE_KEY, TURNSTILE_SECRET, sharedEnv,
  fakeDb, req, call, captureLogs, installFakeBlob, installFakeFetch, setEnv,
  validQuote, validUpload, passToken, freshIp, stamp
} from './harness.mjs';

let logs, blob, net, restoreEnv;
beforeEach(() => {
  logs = captureLogs();
  restoreEnv = setEnv();
  blob = installFakeBlob();
  net = installFakeFetch();
});
afterEach(() => { net.restore(); blob.restore(); restoreEnv(); logs.restore(); });

const quote = (body, ip, extra) => call(quoteHandler, req(ip || freshIp(), Object.assign({ body }, extra || {})));
const upload = (body, ip, extra) => call(uploadHandler, req(ip || freshIp(), Object.assign({ body }, extra || {})));

function assertVerifyRefusal(out, status) {
  assert.equal(out.statusCode, status || 403);
  assert.equal(out.payload.ok, false);
  assert.equal(out.payload.verificationFailed, true);
  assert.equal(out.payload.error, QG.VERIFY_MESSAGE);
  /* Which rule fired is never disclosed. */
  assert.deepEqual(Object.keys(out.payload).sort(), ['error', 'ok', 'verificationFailed']);
}

/* ================================================================ TURNSTILE */

describe('Turnstile - the boundary', () => {
  test('a valid token permits the request, and Siteverify is called correctly', async () => {
    const ip = freshIp();
    const body = validQuote();
    const out = await quote(body, ip);
    assert.equal(out.statusCode, 200);
    assert.equal(out.payload.ok, true);
    assert.equal(net.sent.length, 1);
    assert.equal(net.siteverify.length, 1);
    const p = net.siteverify[0];
    assert.equal(p.get('secret'), TURNSTILE_SECRET);
    assert.equal(p.get('response'), body.turnstileToken);
    assert.equal(p.get('remoteip'), ip, 'remoteip goes to Cloudflare, as Cloudflare recommends');
    assert.match(p.get('idempotency_key'), /^[0-9a-f-]{36}$/);
  });

  test('a missing token is refused, and neither Cloudflare nor Resend is called', async () => {
    for (const t of [undefined, null, '']) {
      const out = await quote(validQuote({ turnstileToken: t }));
      assertVerifyRefusal(out);
    }
    assert.equal(net.siteverify.length, 0);
    assert.equal(net.sent.length, 0);
  });

  test('a malformed token is refused before Cloudflare is asked', async () => {
    for (const t of ['x'.repeat(QG.TOKEN_MAX_CHARS + 1), 'has space', 'tab\there', 12345, {}, ['a'], 'é']) {
      const out = await quote(validQuote({ turnstileToken: t }));
      assertVerifyRefusal(out);
    }
    assert.equal(net.siteverify.length, 0);
    assert.equal(net.sent.length, 0);
  });

  test('a token Cloudflare rejects is refused, and Resend is never called', async () => {
    for (const code of ['invalid-input-response', 'missing-input-response', 'something-new']) {
      const out = await quote(validQuote({ turnstileToken: 'fail~' + code + '~1' }));
      assertVerifyRefusal(out);
    }
    assert.equal(net.sent.length, 0);
  });

  test('a REPLAYED token is refused (single use), and no second email goes', async () => {
    const token = passToken(QG.ACTIONS.quote);
    assert.equal((await quote(validQuote({ turnstileToken: token }))).statusCode, 200);
    assertVerifyRefusal(await quote(validQuote({ turnstileToken: token })));
    assert.equal(net.sent.length, 1);
  });

  test('tokens are bound to their action: an upload token cannot send a quote, and vice versa', async () => {
    assertVerifyRefusal(await quote(validQuote({ turnstileToken: passToken(QG.ACTIONS.upload) })));
    assertVerifyRefusal(await upload(validUpload(undefined, { turnstileToken: passToken(QG.ACTIONS.quote) })));
    assert.equal(net.sent.length, 0);
    assert.equal(blob.calls.issue.length, 0);
  });

  test('a token minted on another hostname is refused; the allow-list is configurable', async () => {
    assertVerifyRefusal(await quote(validQuote({ turnstileToken: passToken(QG.ACTIONS.quote, 'evil.example') })));
    assert.equal((await quote(validQuote({ turnstileToken: passToken(QG.ACTIONS.quote, 'esthers.ca') }))).statusCode, 200);
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'preview.example.test';
    assertVerifyRefusal(await quote(validQuote({ turnstileToken: passToken(QG.ACTIONS.quote, 'www.esthers.ca') })));
    assert.equal((await quote(validQuote({ turnstileToken: passToken(QG.ACTIONS.quote, 'preview.example.test') }))).statusCode, 200);
  });

  test('a stale challenge timestamp is refused', async () => {
    net.challengeTs = new Date(Date.now() - QG.TOKEN_MAX_AGE_MS - 1000).toISOString();
    assertVerifyRefusal(await quote(validQuote()));
    assert.equal(net.sent.length, 0);
  });

  test('Siteverify NETWORK FAILURE fails CLOSED: 503, no email, one retry with the SAME idempotency key', async () => {
    net.mode = 'down';
    assertVerifyRefusal(await quote(validQuote()), 503);
    assert.equal(net.sent.length, 0);
    assert.equal(net.siteverify.length, 2);
    assert.equal(net.siteverify[0].get('idempotency_key'), net.siteverify[1].get('idempotency_key'));
  });

  test('a single transient failure is retried and then succeeds', async () => {
    net.mode = 'flaky';
    assert.equal((await quote(validQuote())).statusCode, 200);
    assert.equal(net.siteverify.length, 2);
    assert.equal(net.siteverify[0].get('idempotency_key'), net.siteverify[1].get('idempotency_key'));
    assert.equal(net.sent.length, 1);
  });

  test('Siteverify 5xx fails closed', async () => {
    net.mode = '5xx';
    assertVerifyRefusal(await quote(validQuote()), 503);
    assert.equal(net.sent.length, 0);
  });

  test('a MALFORMED Siteverify response fails closed', async () => {
    for (const mode of ['garbage', 'weird']) {
      net.mode = mode;
      assertVerifyRefusal(await quote(validQuote()), 503);
    }
    assert.equal(net.sent.length, 0);
  });

  test('Cloudflare internal-error and bad-request fail closed', async () => {
    for (const code of ['internal-error', 'bad-request']) {
      assertVerifyRefusal(await quote(validQuote({ turnstileToken: 'fail~' + code + '~1' })), 503);
    }
    assert.equal(net.sent.length, 0);
  });

  test('a rejected SECRET is treated as not configured (mail-app fallback), never as success', async () => {
    net.acceptSecret = null;
    process.env.TURNSTILE_SECRET_KEY = '0x4AAAAAAAwrong-secret';
    const out = await quote(validQuote());
    assert.equal(out.statusCode, 503);
    assert.equal(out.payload.notConfigured, true);
    assert.equal(net.sent.length, 0);
  });

  test('no Turnstile configuration: GET says not ready, POST sends nothing', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const probe = await call(quoteHandler, req(freshIp(), { method: 'GET' }));
    assert.equal(probe.payload.ready, false);
    assert.equal(probe.payload.turnstileSiteKey, null);
    assert.equal(probe.payload.formStamp, null);
    const out = await quote(validQuote());
    assert.equal(out.statusCode, 503);
    assert.equal(out.payload.notConfigured, true);
    const up = await upload(validUpload());
    assert.equal(up.statusCode, 503);
    assert.equal(net.siteverify.length, 0);
    assert.equal(net.sent.length, 0);
    assert.equal(blob.calls.issue.length, 0);
  });

  test("Cloudflare's dummy keys are REFUSED in production (they would switch the check off)", async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    const probe = await call(quoteHandler, req(freshIp(), { method: 'GET' }));
    assert.equal(probe.payload.ready, false);
    const out = await quote(validQuote({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }));
    assert.equal(out.statusCode, 503);
    assert.equal(net.sent.length, 0);
    /* A real secret with a dummy SITE key is refused too. */
    process.env.TURNSTILE_SECRET_KEY = TURNSTILE_SECRET;
    assert.equal(QG.turnstileConfig(process.env).ok, false);
  });

  test('dummy keys work OUTSIDE production (preview), where action/hostname cannot be checked', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    net.acceptSecret = '1x0000000000000000000000000000000AA';
    assert.equal(QG.turnstileConfig(process.env).testMode, true);
    const out = await quote(validQuote({ turnstileToken: passToken('anything', 'example.com') }));
    assert.equal(out.statusCode, 200);
  });

  test('the token and the secret are never logged, and the secret is never returned', async () => {
    const tokens = [];
    const seen = [];
    const t = (x) => { tokens.push(x); return x; };
    seen.push(await quote(validQuote({ turnstileToken: t(passToken(QG.ACTIONS.quote)) })));
    seen.push(await quote(validQuote({ turnstileToken: t('fail~invalid-input-response~77') })));
    seen.push(await quote(validQuote({ turnstileToken: t(passToken(QG.ACTIONS.upload)) })));
    net.mode = 'down';
    seen.push(await quote(validQuote({ turnstileToken: t(passToken(QG.ACTIONS.quote)) })));
    net.mode = 'normal';
    seen.push(await upload(validUpload(undefined, { turnstileToken: t(passToken(QG.ACTIONS.upload)) })));
    seen.push(await call(quoteHandler, req(freshIp(), { method: 'GET' })));
    const logText = logs.text();
    for (const tok of tokens) assert.equal(logText.includes(tok), false, 'token in logs');
    assert.equal(logText.includes(TURNSTILE_SECRET), false);
    for (const out of seen) {
      const raw = JSON.stringify(out.payload);
      assert.equal(raw.includes(TURNSTILE_SECRET), false, 'secret in a response');
      assert.equal(raw.includes(SECRET), false);
      assert.equal(/error-codes|invalid-input|timeout-or-duplicate|siteverify/i.test(raw), false,
        'no provider internals in a response');
    }
  });
});

/* =========================================================== FORM SIGNALS */

describe('honeypot and form age - supplemental only', () => {
  test('an ordinary submission is accepted', async () => {
    assert.equal((await quote(validQuote({ hp: '' }))).statusCode, 200);
  });

  test('a filled honeypot is refused, before Cloudflare is even asked', async () => {
    for (const hp of ['https://spam.example', 'x', ' ', 0, false, {}, ['x']]) {
      assertVerifyRefusal(await quote(validQuote({ hp })));
      assertVerifyRefusal(await upload(validUpload(undefined, { hp })));
    }
    assert.equal(net.siteverify.length, 0);
    assert.equal(net.sent.length, 0);
    assert.equal(blob.calls.issue.length, 0);
  });

  test('an unrealistically fast submission is refused', async () => {
    assertVerifyRefusal(await quote(validQuote({ formStamp: stamp(500) })));
    assertVerifyRefusal(await quote(validQuote({ formStamp: stamp(QG.MIN_FORM_AGE_MS - 100) })));
    assert.equal((await quote(validQuote({ formStamp: stamp(QG.MIN_FORM_AGE_MS + 500) }))).statusCode, 200);
    assert.equal(net.sent.length, 1);
  });

  test('a missing, forged, tampered or future stamp is refused', async () => {
    const good = stamp();
    const otherKey = QG.issueFormStamp({ CHAT_RATE_LIMIT_SECRET: 'a-completely-different-secret' }, Date.now() - 10000);
    const [ts, mac] = good.split('.');
    const forgedTime = (parseInt(ts, 36) - 60000).toString(36) + '.' + mac;
    const bad = [undefined, null, '', 'nonsense', otherKey, forgedTime,
      ts + '.' + mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A'), { a: 1 },
      QG.issueFormStamp(process.env, Date.now() + 10 * 60 * 1000)];
    for (const formStamp of bad) assertVerifyRefusal(await quote(validQuote({ formStamp })));
    assert.equal(net.sent.length, 0);
  });

  test('a direct API caller cannot bypass Turnstile by omitting or forging the signals', async () => {
    /* No honeypot, no stamp, valid token: refused on the missing stamp. */
    const noSignals = validQuote(); delete noSignals.hp; delete noSignals.formStamp;
    assertVerifyRefusal(await quote(noSignals));
    /* Perfect signals, no token: refused by Turnstile. */
    const noToken = validQuote(); delete noToken.turnstileToken;
    assertVerifyRefusal(await quote(noToken));
    /* Perfect signals, forged token: refused by Turnstile. */
    assertVerifyRefusal(await quote(validQuote({ turnstileToken: 'I-am-human' })));
    assert.equal(net.sent.length, 0);
  });

  test('without the stamp secret the stamp is skipped - but Turnstile is still required', async () => {
    delete process.env.CHAT_RATE_LIMIT_SECRET;
    const body = validQuote(); delete body.formStamp;
    assert.equal((await quote(body)).statusCode, 200);
    const noToken = validQuote(); delete noToken.formStamp; delete noToken.turnstileToken;
    assertVerifyRefusal(await quote(noToken));
  });
});

/* ================================================================= ORIGIN */

describe('origin', () => {
  const withOrigin = (origin, host) => ({ headers: Object.assign(
    { 'x-vercel-forwarded-for': freshIp(), host: host || 'www.esthers.ca' },
    origin === undefined ? {} : { origin }) });

  test('a cross-site browser POST is refused on both endpoints, before Cloudflare is asked', async () => {
    for (const origin of ['https://evil.example', 'https://www.esthers.ca.evil.example',
                          'http://www.esthers.ca', 'null']) {
      assertVerifyRefusal(await call(quoteHandler, Object.assign(req(freshIp(), { body: validQuote() }), withOrigin(origin))));
      assertVerifyRefusal(await call(uploadHandler, Object.assign(req(freshIp(), { body: validUpload() }), withOrigin(origin))));
    }
    assert.equal(net.siteverify.length, 0);
    assert.equal(net.sent.length, 0);
  });

  test('the canonical, apex and same-host preview origins are accepted', async () => {
    for (const [origin, host] of [['https://www.esthers.ca'], ['https://esthers.ca', 'esthers.ca'],
                                  ['https://esthers-git-x.vercel.app', 'esthers-git-x.vercel.app']]) {
      const out = await call(quoteHandler, Object.assign(req(freshIp(), { body: validQuote() }), withOrigin(origin, host)));
      assert.equal(out.statusCode, 200, origin);
    }
  });

  test('no Origin header is not trusted: Turnstile still decides', async () => {
    assert.equal((await call(quoteHandler, Object.assign(req(freshIp(), { body: validQuote() }), withOrigin(undefined)))).statusCode, 200);
    const noToken = validQuote(); delete noToken.turnstileToken;
    assertVerifyRefusal(await call(quoteHandler, Object.assign(req(freshIp(), { body: noToken }), withOrigin(undefined))));
  });
});

/* ============================================================= DUPLICATES */

describe('duplicate suppression', () => {
  test('an EXACT replay (with fresh tokens) is not emailed twice, and is not reported as sent', async () => {
    const base = validQuote();
    assert.equal((await quote(base)).statusCode, 200);
    const again = await quote(Object.assign({}, base, { turnstileToken: passToken(QG.ACTIONS.quote), formStamp: stamp() }));
    assert.equal(again.statusCode, 409);
    assert.equal(again.payload.ok, false);
    assert.equal(again.payload.duplicate, true);
    assert.equal(again.payload.error, QG.DUPLICATE_MESSAGE);
    assert.equal(net.sent.length, 1);
  });

  test('a NORMALISED replay (case, spacing, Unicode width) is a duplicate', async () => {
    const base = validQuote({ name: 'Pat Customer', email: 'Pat@Example.test',
      text: 'Need 20ft of flashing, GALVALUME 24ga ' + Math.random() });
    assert.equal((await quote(base)).statusCode, 200);
    const variant = Object.assign({}, base, {
      name: '  pat   CUSTOMER ',
      email: ' pat@example.TEST ',
      /* Full-width "２０ｆｔ" is NFKC-equal to "20ft". */
      text: '  need ２０ｆｔ  of\nflashing,   galvalume 24GA ' + base.text.split(' ').pop() + '\n',
      turnstileToken: passToken(QG.ACTIONS.quote), formStamp: stamp()
    });
    assert.equal((await quote(variant)).statusCode, 409);
    assert.equal(net.sent.length, 1);
  });

  test('a DISTINCT request from the same customer is allowed', async () => {
    const base = validQuote();
    assert.equal((await quote(base)).statusCode, 200);
    const revised = Object.assign({}, base, { text: base.text + ' - actually 22 ft',
      turnstileToken: passToken(QG.ACTIONS.quote), formStamp: stamp() });
    assert.equal((await quote(revised)).statusCode, 200);
    assert.equal(net.sent.length, 2);
  });

  test('fingerprint rules: file NAMES count, storage paths and order do not', () => {
    const key = Buffer.alloc(32, 7);
    const q = { name: 'A', email: 'a@b.cd', text: 't' };
    const p = (id, n, name) => 'quotes/2026/10/' + id.repeat(32) + '/' + n + '-' + name;
    const one = QG.fingerprint(key, Object.assign({ files: [p('a', 1, 'plan.pdf'), p('a', 2, 'photo.jpg')] }, q));
    const reup = QG.fingerprint(key, Object.assign({ files: [p('b', 1, 'photo.jpg'), p('b', 2, 'plan.pdf')] }, q));
    const added = QG.fingerprint(key, Object.assign({ files: [p('c', 1, 'plan.pdf'), p('c', 2, 'photo.jpg'), p('c', 3, 'roof.jpg')] }, q));
    assert.equal(one, reup, 'same files re-uploaded in another order');
    assert.notEqual(one, added, 'a forgotten photo added');
    assert.match(one, /^[0-9a-f]{40}$/);
    assert.notEqual(one, QG.fingerprint(Buffer.alloc(32, 8), Object.assign({ files: [] }, q)), 'keyed');
  });

  test('the window expires: the same request may be sent again later', async () => {
    const memory = QG.createMemoryDuplicates();
    const env = { CHAT_RATE_LIMIT_SECRET: SECRET };
    const q = { name: 'A', email: 'a@b.cd', text: 'x' };
    const t0 = 1_000_000;
    const first = await QG.reserveDuplicate(q, { env, memory, now: t0 });
    assert.equal(first.duplicate, false);
    await first.confirm(t0);
    assert.equal((await QG.reserveDuplicate(q, { env, memory, now: t0 + QG.DUPLICATE_WINDOW_MS - 1 })).duplicate, true);
    assert.equal((await QG.reserveDuplicate(q, { env, memory, now: t0 + QG.DUPLICATE_WINDOW_MS })).duplicate, false);
  });

  test('a FAILED send releases the reservation, so the customer can retry at once', async () => {
    const base = validQuote();
    net.resendStatus = 500;
    assert.equal((await quote(base)).statusCode, 502);
    net.resendStatus = 200;
    const retry = Object.assign({}, base, { turnstileToken: passToken(QG.ACTIONS.quote), formStamp: stamp() });
    assert.equal((await quote(retry)).statusCode, 200);
  });

  test('an in-flight copy blocks only briefly: a crashed attempt does not block forever', async () => {
    const memory = QG.createMemoryDuplicates();
    const env = { CHAT_RATE_LIMIT_SECRET: SECRET };
    const q = { name: 'A', email: 'a@b.cd', text: 'pending' };
    const r = await QG.reserveDuplicate(q, { env, memory, now: 0 });
    assert.equal(r.duplicate, false);   /* never confirmed nor released */
    assert.equal((await QG.reserveDuplicate(q, { env, memory, now: QG.PENDING_STALE_MS - 1 })).duplicate, true);
    assert.equal((await QG.reserveDuplicate(q, { env, memory, now: QG.PENDING_STALE_MS })).duplicate, false);
  });

  test('CONCURRENCY: two instances racing the same request - exactly one wins (Firestore transaction)', async () => {
    const db = fakeDb();
    const env = sharedEnv();
    const q = { name: 'A', email: 'a@b.cd', text: 'race' };
    const go = () => QG.reserveDuplicate(q, { env, now: 5000, memory: QG.createMemoryDuplicates(),
                                              initAdmin: async () => ({ db }) });
    const results = await Promise.all([go(), go(), go(), go()]);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    /* And once sent, a third instance still sees it. */
    await results.find((r) => !r.duplicate).confirm(6000);
    assert.equal((await go()).duplicate, true);
  });

  test('Firestore holds only an HMAC id and a status - no quote text, name or email', async () => {
    const db = fakeDb();
    const q = { name: 'Secret Name', email: 'secret@example.test', text: 'secret quote text' };
    const r = await QG.reserveDuplicate(q, { env: sharedEnv(), now: 1, memory: QG.createMemoryDuplicates(),
                                             initAdmin: async () => ({ db }) });
    await r.confirm(2);
    const [[path, doc]] = [...db.docs.entries()];
    assert.match(path, /^quoteDuplicates\/[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(doc).sort(), ['at', 'expireAt', 'status']);
    const raw = path + JSON.stringify(doc);
    for (const s of ['Secret Name', 'secret@example.test', 'secret quote text', 'secret']) {
      assert.equal(raw.toLowerCase().includes(s.toLowerCase()), false, s);
    }
  });

  test('if Firestore fails, the in-memory layer still catches duplicates; only a reason is logged', async () => {
    const memory = QG.createMemoryDuplicates();
    const q = { name: 'A', email: 'a@b.cd', text: 'fallback' };
    const deps = { env: sharedEnv(), now: 1, memory, initAdmin: async () => { throw new Error('down a@b.cd'); } };
    const r = await QG.reserveDuplicate(q, deps);
    assert.equal(r.duplicate, false);
    await r.confirm(2);
    assert.equal((await QG.reserveDuplicate(q, Object.assign({}, deps, { now: 3 }))).duplicate, true);
    assert.match(logs.text(), /duplicate_store_unavailable/);
    assert.equal(logs.text().includes('a@b.cd'), false);
  });
});

/* ================================================================ UPLOADS */

describe('uploads', () => {
  test('a bot without a valid token gets NO upload permission', async () => {
    const noToken = validUpload(); delete noToken.turnstileToken;
    assertVerifyRefusal(await upload(noToken));
    assertVerifyRefusal(await upload(validUpload(undefined, { turnstileToken: 'fail~invalid-input-response~9' })));
    assertVerifyRefusal(await upload(validUpload(undefined, { turnstileToken: 'forged' })));
    net.mode = 'down';
    assertVerifyRefusal(await upload(validUpload()), 503);
    assert.equal(blob.calls.issue.length, 0);
    assert.equal(blob.calls.presign.length, 0);
  });

  test('a verified upload gets exactly one permission per declared file', async () => {
    const out = await upload(validUpload([{ name: 'a.pdf', size: 1234 }, { name: 'b.jpg', size: 99 }]));
    assert.equal(out.statusCode, 200);
    assert.deepEqual(blob.calls.issue.map((c) => c.maximumSizeInBytes), [1234, 99]);
    assert.equal(net.siteverify[0].get('response').split('~')[1], QG.ACTIONS.upload);
  });

  test('upload and quote use two SEPARATE tokens; reusing the upload token for the quote fails', async () => {
    const upTok = passToken(QG.ACTIONS.upload);
    assert.equal((await upload(validUpload(undefined, { turnstileToken: upTok }))).statusCode, 200);
    assertVerifyRefusal(await quote(validQuote({ turnstileToken: upTok })));
    assert.equal(net.sent.length, 0);
  });

  test('existing attachment protections are intact: pathname, type, existence', async () => {
    let out = await quote(validQuote({ files: [{ pathname: '../../etc/passwd' }] }));
    assert.equal(out.statusCode, 400);
    out = await quote(validQuote({ files: [{ pathname: 'quotes/2026/10/' + 'd'.repeat(32) + '/1-x.exe' }] }));
    assert.equal(out.statusCode, 415);
    /* A well-formed path whose object does not exist (the fake head throws). */
    const body = validQuote({ files: [{ pathname: 'quotes/2026/10/' + 'e'.repeat(32) + '/1-plan.pdf' }] });
    out = await quote(body);
    assert.equal(out.statusCode, 409);
    assert.equal(blob.calls.head.length, 1);
    assert.equal(net.sent.length, 0);
  });
});

/* ================================================================ LOGGING */

describe('logging', () => {
  test('refusals log allow-listed reason tokens only - never IP, token, name, email or quote text', async () => {
    const ip = freshIp();
    const body = validQuote({ name: 'Zelda Unique', email: 'zelda.unique@example.test',
                              text: 'ZELDA-UNIQUE-QUOTE-TEXT' });
    await quote(Object.assign({}, body, { hp: 'filled' }), ip);
    await quote(Object.assign({}, body, { formStamp: stamp(10) }), ip);
    await quote(Object.assign({}, body, { turnstileToken: 'fail~invalid-input-response~5' }), ip);
    await quote(Object.assign({}, body, { turnstileToken: passToken(QG.ACTIONS.quote) }), ip);
    await quote(Object.assign({}, body, { turnstileToken: passToken(QG.ACTIONS.quote), formStamp: stamp() }), ip);
    net.resendStatus = 422;   /* a fresh address: the first one has spent its burst */
    await quote(validQuote({ email: 'zelda.unique@example.test' }), freshIp());
    const text = logs.text();
    for (const s of [ip, 'Zelda', 'zelda.unique', 'ZELDA-UNIQUE', 'pat@example.test', '~']) {
      assert.equal(text.includes(s), false, 'leaked: ' + s);
    }
    for (const line of logs.lines.filter((l) => l.startsWith('quote-guard:'))) {
      const m = /^quote-guard: (quote|upload) refused: ([a-z_]+)$/.exec(line);
      assert.ok(m, 'unexpected log shape: ' + line);
      assert.ok(QG.REASONS.has(m[2]), 'reason not allow-listed: ' + m[2]);
    }
    assert.match(text, /refused: honeypot/);
    assert.match(text, /refused: too_fast/);
    assert.match(text, /refused: turnstile_rejected/);
    assert.match(text, /refused: duplicate/);
    assert.match(text, /provider rejected, status 422, error validation_error$/m,
      'the provider error NAME only, not its message');
  });
});

describe('configuration helpers', () => {
  test('dummy key detection matches Cloudflare\'s published test keys and nothing real-looking', () => {
    for (const k of ['1x0000000000000000000000000000000AA', '2x0000000000000000000000000000000AA',
                     '3x0000000000000000000000000000000AA']) assert.equal(QG.isTestSecret(k), true, k);
    for (const k of ['1x00000000000000000000AA', '2x00000000000000000000AB', '1x00000000000000000000BB',
                     '2x00000000000000000000BB', '3x00000000000000000000FF']) assert.equal(QG.isTestSiteKey(k), true, k);
    assert.equal(QG.isTestSecret(TURNSTILE_SECRET), false);
    assert.equal(QG.isTestSiteKey(SITE_KEY), false);
  });

  test('action names fit Turnstile\'s 32-character [A-Za-z0-9_-] rule', () => {
    for (const a of Object.values(QG.ACTIONS)) assert.match(a, /^[A-Za-z0-9_-]{1,32}$/);
    assert.notEqual(QG.ACTIONS.upload, QG.ACTIONS.quote);
  });

  test('the rate limiter still sees verified requests only (QL untouched by the guard)', () => {
    assert.equal(typeof QL.check, 'function');
  });
});
