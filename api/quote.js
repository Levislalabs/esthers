/*
 * Quote request delivery.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Until now the quote form built a mailto: link. A mailto: URI carries a
 * subject and a body and nothing else - the scheme has no attachment field,
 * and no mail client invents one. So a customer who picked three photos got
 * an email listing three FILENAMES and no pictures. That was never a bug in
 * the sending code; there was no sending code. The files never left the
 * browser.
 *
 * This endpoint is the missing half. The browser posts the request as JSON
 * with each file base64-encoded, and this function checks it and hands it to
 * the email provider with real attachments.
 *
 * DESIGN NOTES
 * ------------
 * - No dependencies. Node's global fetch talks to the provider's REST API
 *   directly, so the project keeps its no-npm, no-build-step promise.
 * - The API key is read from the environment and never appears in source,
 *   in a response, or in a log line.
 * - The email is sent as PLAIN TEXT only. Nothing a visitor types is ever
 *   interpreted as markup, which removes the injection question rather than
 *   trying to escape its way out of it.
 * - Every limit is enforced HERE. The browser checks the same things first,
 *   but only to give a faster, kinder message - client-side validation is a
 *   convenience, not a control.
 */

'use strict';

// ---------------------------------------------------------------- limits
//
// Vercel caps a serverless function's request body at 4.5 MB. Base64 grows
// binary by 4/3, so the raw total has to stay under roughly 3.3 MB for the
// encoded payload plus the JSON around it to fit. 3 MB leaves headroom.
const MAX_FILES = 5;
const MAX_FILE_BYTES = 2.5 * 1024 * 1024;   // 2.5 MB per file
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;    // 3 MB across all files
const MAX_TEXT_CHARS = 20000;

// The types the drawing field has always advertised. Kept deliberately
// narrow: this is a quote form, not a file host.
const ALLOWED = {
  pdf:  { mime: 'application/pdf' },
  jpg:  { mime: 'image/jpeg' },
  jpeg: { mime: 'image/jpeg' },
  png:  { mime: 'image/png' },
  heic: { mime: 'image/heic' },
  webp: { mime: 'image/webp' },
  dwg:  { mime: 'image/vnd.dwg' },
  dxf:  { mime: 'image/vnd.dxf' },
  doc:  { mime: 'application/msword' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
};

// ------------------------------------------------------------ signatures
//
// The extension and the browser-supplied MIME type are both attacker-chosen,
// so neither decides anything. What the bytes actually are decides.

function startsWith(buf, bytes, offset) {
  var at = offset || 0;
  if (buf.length < at + bytes.length) return false;
  for (var i = 0; i < bytes.length; i++) {
    if (buf[at + i] !== bytes[i]) return false;
  }
  return true;
}

function ascii(buf, at, len) {
  if (buf.length < at + len) return '';
  return buf.slice(at, at + len).toString('latin1');
}

function sniff(buf) {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf';           // %PDF
  if (startsWith(buf, [0xFF, 0xD8, 0xFF])) return 'jpg';
  if (startsWith(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'webp';

  // ISO base media: "ftyp" at offset 4, brand at offset 8.
  if (ascii(buf, 4, 4) === 'ftyp') {
    var brand = ascii(buf, 8, 4);
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].indexOf(brand) !== -1) {
      return 'heic';
    }
  }

  if (startsWith(buf, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return 'doc';  // OLE2
  if (startsWith(buf, [0x50, 0x4B, 0x03, 0x04])) return 'docx';                          // ZIP
  if (ascii(buf, 0, 4) === 'AC10') return 'dwg';
  if (ascii(buf, 0, 22) === 'AutoCAD Binary DXF\r\n\x1a\x00') return 'dxf';

  // A text DXF has no signature. Accept it only when the head of the file is
  // printable ASCII and opens the way the format requires - a group code,
  // then SECTION. Anything else falls through and is rejected.
  var head = buf.slice(0, 256).toString('latin1');
  if (/^[\s\r\n]*(0|999)[\r\n]/.test(head) && /SECTION|HEADER|AutoCAD/i.test(head)) {
    if (!/[\x00-\x08\x0E-\x1F]/.test(head)) return 'dxf';
  }
  return null;
}

// ------------------------------------------------------------- filenames
//
// Original names are worth keeping - "north-elevation.pdf" tells the counter
// something "attachment-1.pdf" does not. They are cleaned, not trusted: no
// directory separators, no control characters, no leading dots, bounded
// length, and an extension that matches what the bytes turned out to be.

function safeName(raw, ext, index) {
  var name = String(raw == null ? '' : raw);
  name = name.replace(/^.*[\\\/]/, '');          // strip any path
  name = name.replace(/[\x00-\x1F\x7F]/g, '');   // strip control characters
  name = name.replace(/[^A-Za-z0-9 ._-]/g, '_'); // keep a conservative set
  name = name.replace(/^[.\s]+/, '');            // no leading dots or space
  name = name.replace(/\s+/g, ' ').trim();

  var base = name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  if (!base) base = 'attachment-' + (index + 1);
  if (base.length > 80) base = base.slice(0, 80);
  return base + '.' + ext;
}

// ------------------------------------------------------------------ util

function bad(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

/* Header injection guard: a subject or a display name must never be able to
   introduce a new header line. */
function oneLine(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 200);
}

// --------------------------------------------------------------- handler

module.exports = async function handler(req, res) {
  // Readiness probe. The browser asks this so it can fall back to the old
  // mailto: flow instead of failing, when the mailbox is not wired up yet.
  // It reports a boolean and nothing else - never the key, never its length.
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      ready: Boolean(process.env.RESEND_API_KEY && process.env.QUOTE_TO),
      limits: {
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_TOTAL_BYTES,
        allowed: Object.keys(ALLOWED)
      }
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return bad(res, 405, 'Method not allowed.');
  }

  var apiKey = process.env.RESEND_API_KEY;
  var to = (process.env.QUOTE_TO || '').split(',').map(function (s) { return s.trim(); })
             .filter(Boolean);
  var from = process.env.QUOTE_FROM || 'Esther\'s website <onboarding@resend.dev>';

  if (!apiKey || !to.length) {
    // 503, not 500: the request was fine, the mailbox is not connected yet.
    // The browser turns this into the old mailto: path rather than telling
    // the customer their request failed.
    return res.status(503).json({ ok: false, notConfigured: true,
      error: 'Quote email delivery is not configured on this deployment.' });
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return bad(res, 400, 'Malformed request.'); }
  }
  if (!body || typeof body !== 'object') return bad(res, 400, 'Malformed request.');

  // ---- fields. Only name and email are required, matching the form. ----
  var name = oneLine(body.name, 120);
  var email = String(body.email == null ? '' : body.email).trim();
  var text = String(body.text == null ? '' : body.text);

  if (name.trim().length < 2) return bad(res, 400, 'Please tell us who to address the quote to.');
  if (!isEmail(email)) return bad(res, 400, 'Please give us a valid email address.');
  if (!text.trim()) return bad(res, 400, 'The request was empty.');
  if (text.length > MAX_TEXT_CHARS) return bad(res, 400, 'That request is too long to send.');

  // ---- files ----
  var files = Array.isArray(body.files) ? body.files : [];
  if (files.length > MAX_FILES) {
    return bad(res, 400, 'Please attach no more than ' + MAX_FILES + ' files.');
  }

  var attachments = [];
  var total = 0;

  for (var i = 0; i < files.length; i++) {
    var f = files[i] || {};
    if (typeof f.data !== 'string' || !f.data) {
      return bad(res, 400, 'One of the files could not be read. Please try selecting it again.');
    }

    // Reject anything that is not clean base64 before allocating for it.
    var b64 = f.data.replace(/^data:[^;,]*;base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      return bad(res, 400, 'One of the files could not be read. Please try selecting it again.');
    }
    // Size is checked from the ENCODED length first, so an oversized upload
    // is refused before it is decoded into memory.
    var approx = Math.floor(b64.length * 3 / 4);
    if (approx > MAX_FILE_BYTES) {
      return bad(res, 413, 'Each file needs to be under ' +
        Math.round(MAX_FILE_BYTES / 1024 / 1024 * 10) / 10 + ' MB.');
    }

    var buf = Buffer.from(b64, 'base64');
    if (!buf.length) {
      return bad(res, 400, 'One of the files was empty.');
    }
    if (buf.length > MAX_FILE_BYTES) {
      return bad(res, 413, 'Each file needs to be under ' +
        Math.round(MAX_FILE_BYTES / 1024 / 1024 * 10) / 10 + ' MB.');
    }

    total += buf.length;
    if (total > MAX_TOTAL_BYTES) {
      return bad(res, 413, 'Those files come to more than ' +
        Math.round(MAX_TOTAL_BYTES / 1024 / 1024) + ' MB together. ' +
        'Please send the largest ones by email instead.');
    }

    // The bytes decide the type. The extension and the browser's MIME string
    // are ignored for this purpose.
    var kind = sniff(buf);
    if (!kind || !ALLOWED[kind]) {
      return bad(res, 415, 'We can take PDF, JPG, PNG, HEIC, WebP, DWG, DXF and Word files. ' +
        'One of those files is not a type we can open.');
    }

    attachments.push({
      filename: safeName(f.name, kind === 'jpg' ? 'jpg' : kind, i),
      content: buf.toString('base64'),
      content_type: ALLOWED[kind].mime
    });
  }

  // ---- hand it to the provider ----
  var payload = {
    from: from,
    to: to,
    reply_to: email,
    subject: oneLine(body.subject || ('Quote request from ' + name), 200),
    text: text
  };
  if (attachments.length) payload.attachments = attachments;

  var providerResponse;
  try {
    providerResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    // Log the shape of the failure, never the payload.
    console.error('quote: provider unreachable:', err && err.message);
    return bad(res, 502, 'We could not send your request just now. Please try again, or email us directly.');
  }

  if (!providerResponse.ok) {
    var detail = '';
    try { detail = (await providerResponse.text()).slice(0, 300); } catch (e) { /* ignore */ }
    console.error('quote: provider rejected, status', providerResponse.status, detail);
    return bad(res, 502, 'We could not send your request just now. Please try again, or email us directly.');
  }

  var sent = {};
  try { sent = await providerResponse.json(); } catch (e) { /* body is optional */ }

  // Counts and sizes only. No filenames, no file content, no message body.
  console.log('quote: sent, attachments=' + attachments.length + ', bytes=' + total);

  return res.status(200).json({ ok: true, id: sent && sent.id ? sent.id : null,
                                attachments: attachments.length });
};

// Exported so the test harness can exercise the validation directly.
module.exports._internal = { sniff: sniff, safeName: safeName, ALLOWED: ALLOWED,
                             MAX_FILES: MAX_FILES, MAX_FILE_BYTES: MAX_FILE_BYTES,
                             MAX_TOTAL_BYTES: MAX_TOTAL_BYTES };
