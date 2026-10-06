/*
 * Every ONLINE quote must carry at least one project file
 * (api/quote.js ATTACHMENT_REQUIRED), and every existing attachment check
 * still applies to it.
 *
 * NO NETWORK. Blob objects, their first bytes, Cloudflare Siteverify and
 * Resend are all played by the harness.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  QG, L, quoteHandler, uploadHandler, MB, req, call, captureLogs,
  installFakeBlob, installFakeFetch, setEnv, validQuote, validUpload,
  passToken, freshIp, storedFile, blobObjects, MAGIC
} from './harness.mjs';

const ATTACHMENT_REQUIRED =
  'Please attach at least one project photo, drawing, PDF, specification or ' +
  'other project file so we can review your quote request.';

let logs, blob, net, restoreEnv;
beforeEach(() => {
  logs = captureLogs();
  restoreEnv = setEnv();
  blob = installFakeBlob();
  net = installFakeFetch();
});
afterEach(() => { net.restore(); blob.restore(); restoreEnv(); logs.restore(); });

const quote = (body, ip) => call(quoteHandler, req(ip || freshIp(), { body }));

function assertAttachmentRequired(out) {
  assert.equal(out.statusCode, 400);
  assert.equal(out.payload.ok, false);
  assert.equal(out.payload.attachmentRequired, true);
  assert.equal(out.payload.error, ATTACHMENT_REQUIRED);
  /* Customer-safe: nothing about spam, bots or verification. */
  assert.equal(/spam|bot|verif|turnstile|captcha/i.test(out.payload.error), false);
}

/* ============================================== AT LEAST ONE FILE */

describe('an online quote must carry at least one project file', () => {
  test('1. files: [] is refused', async () => {
    assertAttachmentRequired(await quote(validQuote({ files: [] })));
  });

  test('2. an omitted or non-array files field is refused', async () => {
    const omitted = validQuote(); delete omitted.files;
    assertAttachmentRequired(await quote(omitted));
    for (const files of [null, undefined, 'plan.pdf', {}, { length: 1 }, 0, true]) {
      assertAttachmentRequired(await quote(validQuote({ files })));
    }
  });

  test('3. a zero-file request never reaches Resend, Cloudflare or Blob, and spends no allowance', async () => {
    const ip = freshIp();
    for (let i = 0; i < 6; i += 1) {
      assertAttachmentRequired(await quote(validQuote({ files: [] }), ip));
    }
    assert.equal(net.sent.length, 0, 'no email');
    assert.equal(net.siteverify.length, 0, 'no Turnstile token spent');
    assert.equal(blob.calls.head.length, 0, 'no Blob lookup');
    /* The burst allowance (2) is untouched for the same address. */
    assert.equal((await quote(validQuote(), ip)).statusCode, 200);
    assert.equal((await quote(validQuote(), ip)).statusCode, 200);
  });

  test('4. a zero-file request leaves no duplicate reservation behind', async () => {
    const body = validQuote({ files: [] });
    assertAttachmentRequired(await quote(body));
    /* The same customer, same words, now with a file: goes straight through. */
    const withFile = Object.assign({}, body, {
      files: [{ pathname: storedFile('site-photo.jpg') }],
      turnstileToken: passToken(QG.ACTIONS.quote)
    });
    const out = await quote(withFile);
    assert.equal(out.statusCode, 200);
    assert.equal(out.payload.attachments, 1);
    assert.equal(net.sent.length, 1);
  });

  test('the rule holds even when every other check would also fail (it is checked first)', async () => {
    assertAttachmentRequired(await quote(validQuote({ files: [], hp: 'bot', turnstileToken: '' })));
    assert.equal(net.siteverify.length, 0);
  });

  test('no storage configured -> not configured (email-app fallback), never a text-only send', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const probe = await call(quoteHandler, req(freshIp(), { method: 'GET' }));
    assert.equal(probe.payload.ready, false, 'cannot carry a file, so not ready');
    assert.equal(probe.payload.turnstileSiteKey, null);
    const out = await quote(validQuote());
    assert.equal(out.statusCode, 503);
    assert.equal(out.payload.notConfigured, true);
    assert.equal(net.sent.length, 0);
  });
});

/* ============================================== ACCEPTED FILE TYPES */

describe('every allowed project-file type is accepted on its own', () => {
  for (const [label, filename] of [
    ['7. one JPG photo', 'site-photo.jpg'], ['JPEG spelling', 'roof.jpeg'],
    ['8. one PDF', 'plan.pdf'], ['9a. one DWG drawing', 'elevation.dwg'],
    ['9b. one DXF drawing', 'flashing.dxf'], ['one PNG', 'sketch.png'],
    ['one HEIC phone photo', 'IMG_0042.heic'], ['one WEBP', 'detail.webp'],
    ['one DOC spec', 'spec.doc'], ['one DOCX spec', 'spec.docx']
  ]) {
    test(label + ' succeeds and is linked in the email', async () => {
      const out = await quote(validQuote({ files: [{ pathname: storedFile(filename) }] }));
      assert.equal(out.statusCode, 200, JSON.stringify(out.payload));
      assert.equal(out.payload.attachments, 1);
      assert.equal(net.sent.length, 1);
      const text = net.sent[0].text;
      assert.ok(text.includes(filename), 'file name in the email');
      assert.ok(text.includes('https://blob.invalid/quotes/'), 'signed download link in the email');
      assert.equal(text.includes('None sent with this request'), false);
    });
  }

  test('the server allow-list is still the authority (unchanged)', () => {
    assert.deepEqual(Object.keys(L.ALLOWED).sort(),
      ['doc', 'docx', 'dwg', 'dxf', 'heic', 'jpeg', 'jpg', 'pdf', 'png', 'webp']);
  });
});

/* ======================================= EXISTING CHECKS STILL APPLY */

describe('every existing attachment check still applies', () => {
  test('10. an unsupported file type is refused, before Cloudflare is asked', async () => {
    for (const name of ['setup.exe', 'archive.zip', 'drawing.svg', 'page.html', 'noext']) {
      const out = await quote(validQuote({ files: [{ pathname: storedFile(name) }] }));
      assert.ok([400, 415].includes(out.statusCode), name + ' -> ' + out.statusCode);
    }
    assert.equal(net.siteverify.length, 0);
    assert.equal(net.sent.length, 0);
  });

  test('a path we did not issue is refused', async () => {
    for (const pathname of ['../../etc/passwd', 'someone-elses/plan.pdf', 'quotes/2026/10/short/1-a.pdf',
                            'quotes/2026/13/' + 'a'.repeat(32) + '/1-a.pdf', 42, null]) {
      const out = await quote(validQuote({ files: [{ pathname }] }));
      assert.equal(out.statusCode, 400);
    }
    assert.equal(net.sent.length, 0);
  });

  test('11. a well-formed path whose Blob object does not exist is refused, no email', async () => {
    const pathname = storedFile('plan.pdf');
    blobObjects.delete(pathname);
    const out = await quote(validQuote({ files: [{ pathname }] }));
    assert.equal(out.statusCode, 409);
    assert.equal(out.payload.failedIndex, 0);
    assert.equal(net.sent.length, 0);
  });

  test('an EMPTY uploaded object is refused', async () => {
    const out = await quote(validQuote({ files: [{ pathname: storedFile('plan.pdf', { size: 0 }) }] }));
    assert.equal(out.statusCode, 409);
    assert.equal(net.sent.length, 0);
  });

  test('12. a signature mismatch is refused (the bytes, not the name, decide)', async () => {
    const cases = [
      storedFile('photo.jpg', { bytes: MAGIC.pdf }),          /* a PDF named .jpg */
      storedFile('plan.pdf', { bytes: Buffer.from('MZ\x90\x00 not a pdf') }), /* an .exe named .pdf */
      storedFile('drawing.dwg', { bytes: MAGIC.png }),
      storedFile('spec.docx', { bytes: Buffer.from('plain text') })
    ];
    for (const pathname of cases) {
      const out = await quote(validQuote({ files: [{ pathname }] }));
      assert.equal(out.statusCode, 415, pathname);
    }
    assert.equal(net.sent.length, 0);
  });

  test('one bad file sinks the whole request - a good file beside it is not sent alone', async () => {
    const good = storedFile('plan.pdf', { index: 1 });
    const bad = storedFile('photo.jpg', { index: 2, bytes: MAGIC.pdf });
    const out = await quote(validQuote({ files: [{ pathname: good }, { pathname: bad }] }));
    assert.equal(out.statusCode, 415);
    assert.equal(out.payload.failedIndex, 1);
    assert.equal(net.sent.length, 0);
  });

  test('13a. more than five files is refused', async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ pathname: storedFile('p' + i + '.pdf', { index: (i % 5) + 1 }) }));
    const out = await quote(validQuote({ files }));
    assert.equal(out.statusCode, 400);
    assert.equal(net.sent.length, 0);
  });

  test('13b. a file over 25 MB (by its REAL stored size) is refused', async () => {
    const out = await quote(validQuote({ files: [{ pathname: storedFile('big.pdf', { size: 25 * MB + 1 }) }] }));
    assert.equal(out.statusCode, 413);
    assert.equal(net.sent.length, 0);
  });

  test('13c. files over 75 MB combined are refused', async () => {
    const files = Array.from({ length: 4 }, (_, i) => ({ pathname: storedFile('f' + i + '.pdf', { index: i + 1, size: 20 * MB }) }));
    const out = await quote(validQuote({ files }));
    assert.equal(out.statusCode, 413);
    assert.equal(net.sent.length, 0);
  });

  test('13d. exactly at the limits is allowed: five files, 75 MB total, one at 25 MB', async () => {
    const sizes = [25 * MB, 20 * MB, 15 * MB, 10 * MB, 5 * MB];
    const files = sizes.map((size, i) => ({ pathname: storedFile('f' + i + '.pdf', { index: i + 1, size }) }));
    const out = await quote(validQuote({ files }));
    assert.equal(out.statusCode, 200);
    assert.equal(out.payload.attachments, 5);
  });
});

/* =========================================== THE TWO-TOKEN LIFECYCLE */

describe('14. an attached quote uses two fresh Turnstile tokens', () => {
  test('upload (token A, quote_upload) -> files stored -> quote (token B, quote_submit) -> email', async () => {
    const ip = freshIp();
    const tokenA = passToken(QG.ACTIONS.upload);
    const up = await call(uploadHandler, req(ip, { body: validUpload(
      [{ name: 'site-photo.jpg', size: MAGIC.jpg.length }, { name: 'plan.pdf', size: MAGIC.pdf.length }],
      { turnstileToken: tokenA }) }));
    assert.equal(up.statusCode, 200);
    /* The browser PUTs each file to its permission; the fake store holds them. */
    up.payload.uploads.forEach((u) => {
      const ext = u.pathname.split('.').pop();
      blobObjects.set(u.pathname, { size: MAGIC[ext].length, bytes: MAGIC[ext] });
    });

    const tokenB = passToken(QG.ACTIONS.quote);
    assert.notEqual(tokenA, tokenB);
    const out = await call(quoteHandler, req(ip, { body: validQuote({
      files: up.payload.uploads.map((u) => ({ pathname: u.pathname })), turnstileToken: tokenB }) }));
    assert.equal(out.statusCode, 200);
    assert.equal(out.payload.attachments, 2);

    const verified = net.siteverify.map((p) => p.get('response'));
    assert.deepEqual(verified, [tokenA, tokenB], 'exactly two verifications, two different tokens');
    assert.deepEqual(verified.map((t) => t.split('~')[1]), ['quote_upload', 'quote_submit']);
    assert.equal(net.sent.length, 1);
  });

  test('re-using token A for the quote is refused, so there is no one-token path', async () => {
    const tokenA = passToken(QG.ACTIONS.upload);
    assert.equal((await call(uploadHandler, req(freshIp(), { body: validUpload(undefined, { turnstileToken: tokenA }) }))).statusCode, 200);
    const out = await quote(validQuote({ turnstileToken: tokenA }));
    assert.equal(out.statusCode, 403);
    assert.equal(net.sent.length, 0);
  });
});
