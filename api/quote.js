/*
 * Quote request delivery.
 *
 * WHAT CHANGED, AND WHY
 * ---------------------
 * The first version of this endpoint took the customer's files as base64
 * inside the JSON request body. That worked, but it inherited a hard ceiling:
 * a Vercel function's request body is capped at 4.5 MB, and base64 inflates
 * binary by a third. In practice that meant about 3 MB of photos - less than
 * two pictures from a modern phone. Customers were being asked to shrink
 * ordinary files before they could ask for a price.
 *
 * Now the browser uploads each file straight to private Blob storage and
 * sends this endpoint only the pathnames. No file bytes pass through the
 * request body at all, so the 4.5 MB ceiling no longer applies to anything a
 * customer sends.
 *
 * WHAT THIS ENDPOINT STILL HAS TO DO
 * ----------------------------------
 * A pathname from a browser is a claim. Before anything is emailed this
 * checks, for every file: that the path is one we could have issued, that an
 * object really exists there, how big it actually is, and - by reading the
 * first 512 bytes back through a signed URL - that the file really is the
 * type its name claims. Only then are the download links generated.
 *
 * The links are time-limited and signed. No permanent public URL is ever
 * emailed, because a quote can carry photographs of somebody's house.
 */

'use strict';

const L = require('./_lib.js');

function bad(res, status, message, extra) {
  return res.status(status).json(Object.assign({ ok: false, error: message }, extra || {}));
}

module.exports = async function handler(req, res) {
  // Readiness probe. The browser asks this on load so it knows whether to
  // offer real uploads or fall back. It reports booleans and limits - never
  // a key, never a key's length.
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      ready: Boolean(process.env.RESEND_API_KEY && process.env.QUOTE_TO),
      uploads: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      limits: {
        maxFiles: L.MAX_FILES,
        maxFileBytes: L.MAX_FILE_BYTES,
        maxTotalBytes: L.MAX_TOTAL_BYTES,
        allowed: Object.keys(L.ALLOWED)
      }
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return bad(res, 405, 'Method not allowed.');
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = (process.env.QUOTE_TO || '').split(',')
    .map(function (s) { return s.trim(); }).filter(Boolean);
  const from = process.env.QUOTE_FROM || 'Esther\'s website <onboarding@resend.dev>';

  if (!apiKey || !to.length) {
    // 503, not 500: the request was fine, the mailbox is not connected.
    return res.status(503).json({ ok: false, notConfigured: true,
      error: 'Quote email delivery is not configured on this deployment.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return bad(res, 400, 'Malformed request.'); }
  }
  if (!body || typeof body !== 'object') return bad(res, 400, 'Malformed request.');

  // ---- fields. Only name and email are required, matching the form. ----
  const name = L.oneLine(body.name, 120);
  const email = String(body.email == null ? '' : body.email).trim();
  const text = String(body.text == null ? '' : body.text);

  if (name.trim().length < 2) return bad(res, 400, 'Please tell us who to address the quote to.');
  if (!L.isEmail(email)) return bad(res, 400, 'Please give us a valid email address.');
  if (!text.trim()) return bad(res, 400, 'The request was empty.');
  if (text.length > L.MAX_TEXT_CHARS) return bad(res, 400, 'That request is too long to send.');

  // ---- files: metadata only, and every claim in it is checked ----
  const claimed = Array.isArray(body.files) ? body.files : [];
  if (claimed.length > L.MAX_FILES) {
    return bad(res, 400, 'Please attach no more than ' + L.MAX_FILES + ' files.');
  }

  let attachments = [];
  if (claimed.length) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return bad(res, 503, 'File uploads are not configured on this deployment.');
    }

    let head, issueSignedToken, presignUrl;
    try {
      ({ head, issueSignedToken, presignUrl } = require('@vercel/blob'));
    } catch (err) {
      console.error('quote: @vercel/blob unavailable:', err && err.message);
      return bad(res, 503, 'We could not attach your files just now.');
    }

    const linkValidUntil = Date.now() + L.DOWNLOAD_LINK_MS;
    let total = 0;

    for (let i = 0; i < claimed.length; i++) {
      const f = claimed[i] || {};
      const pathname = f.pathname;

      /* Refuse anything that is not shaped like a path we issue. Without
         this, a caller could name any object in the store and have a signed
         link to it emailed out. */
      if (!L.isOurBlobPath(pathname)) {
        console.error('quote: rejected a pathname that we did not issue');
        return bad(res, 400, 'We could not find one of your uploaded files. Please try again.');
      }

      const ext = L.extensionOf(pathname);
      if (!L.ALLOWED[ext]) return bad(res, 415, 'One of those files is not a type we can open.');

      // Does an object actually exist there, and how big is it really?
      let info;
      try {
        info = await head(pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
      } catch (err) {
        console.error('quote: upload missing or unreadable at index ' + i);
        return bad(res, 409, 'One of your files did not finish uploading. ' +
          'Please try sending the request again.', { failedIndex: i });
      }

      if (!Number.isFinite(info.size) || info.size <= 0) {
        return bad(res, 409, 'One of your files arrived empty. Please try again.',
                   { failedIndex: i });
      }
      if (info.size > L.MAX_FILE_BYTES) {
        return bad(res, 413, 'One of your files is larger than ' +
          L.mb(L.MAX_FILE_BYTES) + ' MB.', { failedIndex: i });
      }
      total += info.size;
      if (total > L.MAX_TOTAL_BYTES) {
        return bad(res, 413, 'Those files come to more than ' +
          L.mb(L.MAX_TOTAL_BYTES) + ' MB together.');
      }

      // Signed, time-limited read link. This is what goes in the email.
      let link;
      try {
        const signed = await issueSignedToken({
          token: process.env.BLOB_READ_WRITE_TOKEN,
          pathname: pathname,
          operations: ['get'],
          validUntil: linkValidUntil
        });
        link = (await presignUrl(signed, {
          operation: 'get',
          pathname: pathname,
          access: 'private',
          validUntil: linkValidUntil
        })).presignedUrl;
      } catch (err) {
        console.error('quote: could not sign a download link:', err && err.message);
        return bad(res, 502, 'We could not prepare your files for sending. Please try again.');
      }

      /* The bytes never reach this function's request body, but half a
         kilobyte read back through the signed link is cheap - and it is the
         only way to know the file is what it claims to be. The extension and
         the browser's content type are both attacker-chosen. */
      const verdict = await L.verifySignature(link, ext);
      if (!verdict.ok) {
        console.error('quote: signature check failed at index ' + i + ': ' + verdict.reason);
        return bad(res, 415,
          'One of those files is not the type its name says it is, so we have not sent it. ' +
          'Please check the file and try again.', { failedIndex: i });
      }

      attachments.push({
        filename: pathname.split('/').pop().replace(/^\d+-/, ''),
        size: info.size,
        human: L.humanSize(info.size),
        url: link
      });
    }
  }

  // ---- compose ----
  let fullText = text;
  if (attachments.length) {
    const lines = ['', '', 'ATTACHMENTS / FILES', ''];
    attachments.forEach(function (a, i) {
      lines.push((i + 1) + '. ' + a.filename);
      lines.push('   ' + a.human);
      lines.push('   Download securely: ' + a.url);
      lines.push('');
    });
    lines.push('These links expire in ' + Math.round(L.DOWNLOAD_LINK_MS / 86400000) +
               ' days. The files are stored privately and are removed after ' +
               L.RETENTION_DAYS + ' days.');
    fullText += lines.join('\n');
  } else {
    fullText += '\n\nATTACHMENTS / FILES\n\nNone sent with this request.';
  }

  const payload = {
    from: from,
    to: to,
    reply_to: email,
    subject: L.oneLine(body.subject || ('Quote request from ' + name), 200),
    text: fullText
  };

  let providerResponse;
  try {
    providerResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('quote: provider unreachable:', err && err.message);
    return bad(res, 502, 'We could not send your request just now. Please try again, or email us directly.');
  }

  if (!providerResponse.ok) {
    let detail = '';
    try { detail = (await providerResponse.text()).slice(0, 300); } catch (e) { /* ignore */ }
    console.error('quote: provider rejected, status', providerResponse.status, detail);
    return bad(res, 502, 'We could not send your request just now. Please try again, or email us directly.');
  }

  let sent = {};
  try { sent = await providerResponse.json(); } catch (e) { /* body is optional */ }

  // Counts and sizes only. No filenames, no URLs, no message body.
  console.log('quote: sent, files=' + attachments.length + ', bytes=' +
              attachments.reduce(function (n, a) { return n + a.size; }, 0));

  return res.status(200).json({ ok: true, id: sent && sent.id ? sent.id : null,
                                attachments: attachments.length });
};
