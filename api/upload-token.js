/*
 * Issues permission to upload, and nothing else.
 *
 * The browser sends a manifest - names, sizes, declared types - and gets back
 * one presigned PUT URL per file. It then uploads straight to Blob storage.
 * The bytes never touch this function, which is the whole point: a Vercel
 * function's request body is capped at 4.5 MB, and a photo from a modern
 * phone can exceed that on its own.
 *
 * WHAT THE BROWSER NEVER RECEIVES
 * -------------------------------
 * BLOB_READ_WRITE_TOKEN, or anything derived from it that could be reused.
 * Each URL returned here is scoped by the storage layer to:
 *   - one exact pathname, which we choose - not the caller
 *   - one operation (put)
 *   - a maximum size
 *   - a content-type allowlist
 *   - a 30-minute expiry
 * So a token handed out for a 3 MB photo cannot be spent uploading a 2 GB
 * file, cannot overwrite anything, and stops working within the half hour.
 */

'use strict';

const L = require('./_lib.js');
const QL = require('./_quote-limit.js');
const QG = require('./_quote-guard.js');

function bad(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return bad(res, 405, 'Method not allowed.');
  }

  /* Cross-site browser POSTs refused. A filter, not the boundary. */
  if (!QG.originAllowed(req)) {
    QG.logReason('upload', 'origin');
    return QG.refuse(res, 403);
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ ok: false, notConfigured: true,
      error: 'File uploads are not configured on this deployment.' });
  }

  /* No upload permission without a working Turnstile configuration. */
  if (!QG.turnstileConfig(process.env).ok) {
    return res.status(503).json({ ok: false, notConfigured: true,
      error: 'File uploads are not configured on this deployment.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return bad(res, 400, 'Malformed request.'); }
  }
  if (!body || typeof body !== 'object') return bad(res, 400, 'Malformed request.');

  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return bad(res, 400, 'No files were listed.');

  const problem = L.checkManifest(files);
  if (problem) return bad(res, 413, problem);

  /* Supplemental signals, then THE BOUNDARY: a Turnstile token minted for
     the quote_upload action. It is single-use, so the browser asks Turnstile
     again for a separate quote_submit token before the final send - one
     token is never verified twice. */
  const signals = QG.checkFormSignals(body, process.env);
  if (!signals.ok) {
    QG.logReason('upload', signals.reason);
    return QG.refuse(res, 403);
  }
  const human = await QG.verifyTurnstile(body.turnstileToken, {
    action: QG.ACTIONS.upload, ip: QG.clientIp(req)
  });
  if (!human.ok) {
    QG.logReason('upload', human.reason);
    if (human.notConfigured) {
      return res.status(503).json({ ok: false, notConfigured: true,
        error: 'File uploads are not configured on this deployment.' });
    }
    return QG.refuse(res, human.status);
  }

  /* RATE LIMIT, burst and hourly together. After the manifest is validated
     and the request verified - so neither invalid nor unverified requests
     spend anybody's allowance - and before any upload permission is issued.
     See _quote-limit.js. */
  const limit = await QL.check(req, 'upload');
  if (limit.limited) return QL.reject(res, limit);

  /* Each file's upload ceiling is its OWN declared size, not the 25 MB
     per-file maximum. checkManifest() above has already proved every size is
     a safe positive integer within the per-file limit and that they sum to
     no more than MAX_TOTAL_BYTES, so the permissions issued below can never
     add up to more than the manifest was allowed to ask for. Before this, a
     caller could declare five tiny files and receive five 25 MB permissions -
     125 MB against a 75 MB limit. A customer's browser reports File.size
     exactly, and the upload is the raw file, so an honest upload fits. */
  const maxBytes = files.map(function (f) { return f.size; });

  let issueSignedToken, presignUrl;
  try {
    ({ issueSignedToken, presignUrl } = require('@vercel/blob'));
  } catch (err) {
    console.error('upload-token: @vercel/blob unavailable:', err && err.message);
    return bad(res, 503, 'File uploads are unavailable just now.');
  }

  const requestId = L.newRequestId();
  const now = new Date();
  const validUntil = Date.now() + L.UPLOAD_TOKEN_MS;

  const uploads = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const name = String(files[i].name);
      const pathname = L.blobPath(requestId, i, name, now);

      /* Scope the delegation to this one object, this one operation and this
         one file's validated declared size. A browser that understates a
         file only gets permission for the smaller number, and the storage
         layer refusing anything larger is the check that actually counts. */
      const signed = await issueSignedToken({
        token: process.env.BLOB_READ_WRITE_TOKEN,
        pathname: pathname,
        operations: ['put'],
        validUntil: validUntil,
        maximumSizeInBytes: maxBytes[i],
        allowedContentTypes: L.ALLOWED_CONTENT_TYPES
      });

      const presigned = await presignUrl(signed, {
        operation: 'put',
        pathname: pathname,
        access: 'private',
        validUntil: validUntil,
        maximumSizeInBytes: maxBytes[i],
        allowedContentTypes: L.ALLOWED_CONTENT_TYPES,
        /* Our pathname is already unique and unguessable; a random suffix
           would only make the name in the email harder to read. Overwrite
           stays off so a reused token cannot replace an existing object. */
        addRandomSuffix: false,
        allowOverwrite: false
      });

      uploads.push({
        name: name,
        pathname: pathname,
        uploadUrl: presigned.presignedUrl
      });
    }
  } catch (err) {
    console.error('upload-token: could not issue upload permission:', err && err.message);
    return bad(res, 502, 'We could not start the upload just now. Please try again.');
  }

  // Pathnames and URLs only. No filenames are logged, and no file content
  // exists here to log.
  console.log('upload-token: issued ' + uploads.length + ' for request ' + requestId);

  return res.status(200).json({
    ok: true,
    requestId: requestId,
    expiresAt: validUntil,
    uploads: uploads
  });
};
