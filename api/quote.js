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
const QL = require('./_quote-limit.js');
const QG = require('./_quote-guard.js');

/* Every ONLINE quote needs at least one project file. Worded for the
   customer; it deliberately says nothing about spam. */
const ATTACHMENT_REQUIRED =
  'Please attach at least one project photo, drawing, PDF, specification or ' +
  'other project file so we can review your quote request.';

function bad(res, status, message, extra) {
  return res.status(status).json(Object.assign({ ok: false, error: message }, extra || {}));
}

module.exports = async function handler(req, res) {
  // Readiness probe. The browser asks this on load so it knows whether to
  // offer real uploads or fall back. It reports booleans and limits - never
  // a secret, never a secret's length. The Turnstile SITE key is public by
  // design (it is embedded in every page that shows a widget), and the form
  // stamp is a signed timestamp: see _quote-guard.js.
  if (req.method === 'GET') {
    const ts = QG.turnstileConfig(process.env);
    /* Server sending needs a mailbox AND a working Turnstile configuration.
       Without Turnstile the form falls back to the customer's email app,
       which cannot be used to make this server send anything. */
    /* ...and storage: every online quote now carries at least one file, so
       a deployment that cannot take uploads cannot send quotes either. */
    const ready = Boolean(process.env.RESEND_API_KEY && process.env.QUOTE_TO && ts.ok &&
                          process.env.BLOB_READ_WRITE_TOKEN);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      ready: ready,
      uploads: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      turnstileSiteKey: ready ? ts.siteKey : null,
      formStamp: ready ? QG.issueFormStamp(process.env) : null,
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

  /* A browser's cross-site POST is refused outright. A script can forge or
     omit Origin, so this is a filter, never the boundary - Turnstile is. */
  if (!QG.originAllowed(req)) {
    QG.logReason('quote', 'origin');
    return QG.refuse(res, 403);
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

  /* No server-sent email without a working Turnstile configuration - ever.
     notConfigured makes the form fall back to the customer's email app. */
  const turnstile = QG.turnstileConfig(process.env);
  if (!turnstile.ok) {
    QG.logReason('quote', turnstile.reason);
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

  /* AT LEAST ONE PROJECT FILE. Esther's quotes physical work, so a photo,
     drawing, sketch or spec is what an estimate is made from - and a
     text-only request is also the cheapest thing for a spam bot to send.
     Checked here, server-side, before any bot check, rate limit, Blob
     lookup or email: an omitted, empty or non-array `files` is refused. The
     browser checks first too, but this is the rule. */
  if (claimed.length === 0) {
    return bad(res, 400, ATTACHMENT_REQUIRED, { attachmentRequired: true });
  }
  if (claimed.length > L.MAX_FILES) {
    return bad(res, 400, 'Please attach no more than ' + L.MAX_FILES + ' files.');
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    /* No storage means no way to carry the required file: fall back to the
       customer's email app, exactly like a missing mailbox. */
    return res.status(503).json({ ok: false, notConfigured: true,
      error: 'File uploads are not configured on this deployment.' });
  }

  /* Cheap structural checks on every claimed file, done BEFORE the rate
     limit so a malformed request is refused without spending anybody's
     allowance. Nothing here touches the network. */
  for (let i = 0; i < claimed.length; i++) {
    const f = claimed[i] || {};

    /* Refuse anything that is not shaped like a path we issue. Without
       this, a caller could name any object in the store and have a signed
       link to it emailed out. */
    if (!L.isOurBlobPath(f.pathname)) {
      console.error('quote: rejected a pathname that we did not issue');
      return bad(res, 400, 'We could not find one of your uploaded files. Please try again.');
    }
    if (!L.ALLOWED[L.extensionOf(f.pathname)]) {
      return bad(res, 415, 'One of those files is not a type we can open.');
    }
  }

  /* SUPPLEMENTAL BOT SIGNALS: honeypot and form age. Cheap, and they spend
     nobody's allowance. Never relied on alone - see _quote-guard.js. */
  const signals = QG.checkFormSignals(body, process.env);
  if (!signals.ok) {
    QG.logReason('quote', signals.reason);
    return QG.refuse(res, 403);
  }

  /* THE BOUNDARY: a single-use Turnstile token for the quote_submit action,
     verified with Cloudflare before anything is spent or sent. Fails closed. */
  const human = await QG.verifyTurnstile(body.turnstileToken, {
    action: QG.ACTIONS.quote, ip: QG.clientIp(req)
  });
  if (!human.ok) {
    QG.logReason('quote', human.reason);
    if (human.notConfigured) {
      return res.status(503).json({ ok: false, notConfigured: true,
        error: 'Quote email delivery is not configured on this deployment.' });
    }
    return QG.refuse(res, human.status);
  }

  /* RATE LIMIT, burst and hourly together. After validation and
     verification - so neither garbage nor unverified requests spend a real
     customer's allowance at the same address - and before anything
     expensive: the Blob lookups and signature reads below, and the email.
     See _quote-limit.js for the two layers and why the limiter fails open. */
  const limit = await QL.check(req, 'quote');
  if (limit.limited) return QL.reject(res, limit);

  let attachments = [];
  { /* every request reaching here claims 1..MAX_FILES files */
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
      /* Shape and type were already checked above, before the rate limit. */
      const pathname = claimed[i].pathname;
      const ext = L.extensionOf(pathname);

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

      /* A sampled content digest, so duplicate suppression can tell a
         revised drawing from a re-upload of the same one (see _lib.js
         contentDigest). Null when unreadable: then this request is simply
         not treated as a duplicate. */
      const digest = await L.contentDigest(link, info.size, verdict.head);
      if (!digest) console.warn('quote: content digest unavailable at index ' + i);

      attachments.push({
        filename: pathname.split('/').pop().replace(/^\d+-/, ''),
        size: info.size,
        human: L.humanSize(info.size),
        url: link,
        digest: digest
      });
    }
  }

  /* Belt and braces: nothing is emailed unless at least one file has passed
     EVERY check above - our path shape, allowed type, the object exists, is
     non-empty, within the per-file and combined limits, and its first bytes
     match its type. The loop returns on any failure, so this cannot fire
     today; it is here so a future edit cannot quietly reopen text-only
     sending. */
  if (attachments.length < 1 || attachments.length !== claimed.length) {
    console.error('quote: refusing to send without verified attachments');
    return bad(res, 400, ATTACHMENT_REQUIRED, { attachmentRequired: true });
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
  }

  const payload = {
    from: from,
    to: to,
    reply_to: email,
    subject: L.oneLine(body.subject || ('Quote request from ' + name), 200),
    text: fullText
  };

  /* DUPLICATE SUPPRESSION, immediately before the send, so the only way a
     reservation can fail to become an email is the provider call itself -
     and that path releases it. A duplicate is never reported as sent. */
  const dup = await QG.reserveDuplicate({
    name: name, email: email, text: text,
    /* Original file name + server-derived content digest per file. Never
       the random storage path, never anything the browser asserted. */
    files: attachments.map(function (a) { return { name: a.filename, digest: a.digest }; })
  });
  if (dup.duplicate) {
    QG.logReason('quote', 'duplicate');
    return QG.refuseDuplicate(res);
  }

  let providerResponse;
  try {
    providerResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    await dup.release();
    console.error('quote: provider unreachable');
    return bad(res, 502, 'We could not send your request just now. Please try again, or email us directly.');
  }

  if (!providerResponse.ok) {
    await dup.release();
    /* Status and the provider's error NAME only (an allow-listed shape).
       The error message can echo request fields such as an address. */
    let errName = '';
    try {
      const j = await providerResponse.json();
      if (j && typeof j.name === 'string' && /^[a-z_]{1,40}$/.test(j.name)) errName = j.name;
    } catch (e) { /* ignore */ }
    console.error('quote: provider rejected, status ' + providerResponse.status +
                  (errName ? ', error ' + errName : ''));
    return bad(res, 502, 'We could not send your request just now. Please try again, or email us directly.');
  }
  await dup.confirm();

  let sent = {};
  try { sent = await providerResponse.json(); } catch (e) { /* body is optional */ }

  // Counts and sizes only. No filenames, no URLs, no message body.
  console.log('quote: sent, files=' + attachments.length + ', bytes=' +
              attachments.reduce(function (n, a) { return n + a.size; }, 0));

  return res.status(200).json({ ok: true, id: sent && sent.id ? sent.id : null,
                                attachments: attachments.length });
};
