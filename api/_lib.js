/*
 * Shared rules for the quote upload path.
 *
 * Files whose name begins with an underscore are not turned into routes by
 * Vercel, so this is a plain module rather than an endpoint.
 *
 * Everything that decides whether a file is acceptable lives here, so the
 * token endpoint and the quote endpoint cannot drift apart and disagree
 * about what is allowed.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------- limits
//
// These are CUSTOMER limits, not transport limits. The old ceiling was an
// accident of architecture: files were base64'd into the function's request
// body, and Vercel caps that at 4.5 MB. Uploads now go straight from the
// browser to Blob storage, which takes files up to 5 TB, so the numbers below
// are a judgement about what a quote request should reasonably carry rather
// than what the plumbing can survive.
const MAX_FILES = 5;
const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 25 MB per file
const MAX_TOTAL_BYTES = 75 * 1024 * 1024;  // 75 MB combined
const MAX_TEXT_CHARS = 20000;

// How long a customer has to finish uploading after asking for permission.
const UPLOAD_TOKEN_MS = 30 * 60 * 1000;          // 30 minutes

// How long the download links in the quote email keep working.
const DOWNLOAD_LINK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// How long uploads are kept before they are eligible for deletion.
const RETENTION_DAYS = 30;

// The types the drawing field has always advertised. Deliberately narrow:
// this is a quote form, not a file host.
const ALLOWED = {
  pdf:  'application/pdf',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
  dwg:  'image/vnd.dwg',
  dxf:  'image/vnd.dxf',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

/* Every content type the signed upload token will permit. Vercel enforces
   this at the storage layer, so a token issued for a photo cannot be spent
   uploading something else. HEIC files are handed over by some phones with
   no type at all, hence the octet-stream entry - the signature check after
   upload is what actually settles the question. */
const ALLOWED_CONTENT_TYPES = Object.keys(ALLOWED)
  .map(function (k) { return ALLOWED[k]; })
  .filter(function (v, i, a) { return a.indexOf(v) === i; })
  .concat(['application/octet-stream']);

// ------------------------------------------------------------ signatures
//
// The upload no longer passes through this server, so the bytes cannot be
// sniffed on the way in. Instead each finished upload is checked with a
// 512-byte ranged read before the email goes out - see verifySignature().
// The extension and the browser's content type remain untrusted throughout.

function startsWith(buf, bytes, offset) {
  const at = offset || 0;
  if (buf.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
}

function ascii(buf, at, len) {
  if (buf.length < at + len) return '';
  return buf.slice(at, at + len).toString('latin1');
}

function sniff(buf) {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(buf, [0xFF, 0xD8, 0xFF])) return 'jpg';
  if (startsWith(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'png';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'webp';

  if (ascii(buf, 4, 4) === 'ftyp') {
    const brand = ascii(buf, 8, 4);
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].indexOf(brand) !== -1) {
      return 'heic';
    }
  }

  if (startsWith(buf, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return 'doc';   // OLE2
  if (startsWith(buf, [0x50, 0x4B, 0x03, 0x04])) return 'docx';                          // ZIP
  if (ascii(buf, 0, 4) === 'AC10') return 'dwg';
  if (ascii(buf, 0, 22) === 'AutoCAD Binary DXF\r\n\x1a\x00') return 'dxf';

  // A text DXF has no signature. Accept it only when the head of the file is
  // printable ASCII and opens the way the format requires.
  const head = buf.slice(0, 256).toString('latin1');
  if (/^[\s\r\n]*(0|999)[\r\n]/.test(head) && /SECTION|HEADER|AutoCAD/i.test(head)) {
    if (!/[\x00-\x08\x0E-\x1F]/.test(head)) return 'dxf';
  }
  return null;
}

// ------------------------------------------------------------- filenames

function extensionOf(filename) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

/*
 * Original names are worth keeping - "north-elevation.pdf" tells the counter
 * something "file-1.pdf" does not. They are cleaned, never trusted: no
 * directory separators, no control characters, no leading dots, bounded
 * length. The result is only ever a single path SEGMENT; the directory it
 * lands in is chosen by us, so a name cannot steer where the file is written.
 */
function safeName(raw, ext, index) {
  let name = String(raw == null ? '' : raw);
  name = name.replace(/^.*[\\\/]/, '');
  name = name.replace(/[\x00-\x1F\x7F]/g, '');
  name = name.replace(/[^A-Za-z0-9 ._-]/g, '_');
  name = name.replace(/^[.\s]+/, '');
  name = name.replace(/\s+/g, ' ').trim();

  let base = name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  if (!base) base = 'file-' + (index + 1);
  if (base.length > 80) base = base.slice(0, 80);
  return base + '.' + ext;
}

/*
 * Where a quote's files live.
 *
 *   quotes/YYYY/MM/<random request id>/<n>-<safe filename>
 *
 * The date segments make manual or automated cleanup by age a matter of
 * listing a prefix. The request id is 16 random bytes, so paths cannot be
 * guessed or enumerated, and - importantly - nothing about the customer
 * appears in the path. Their name and email belong in the email, not in a
 * storage key that might be read by anyone who ever sees a URL.
 */
function newRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

function blobPrefix(requestId, now) {
  const d = now || new Date();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return 'quotes/' + d.getUTCFullYear() + '/' + mm + '/' + requestId + '/';
}

function blobPath(requestId, index, filename, now) {
  const ext = extensionOf(filename);
  return blobPrefix(requestId, now) + (index + 1) + '-' + safeName(filename, ext, index);
}

/* A pathname coming back from the browser is a claim, not a fact. It has to
   look exactly like something we would have issued, or it is refused - which
   stops a caller naming some other object in the store and having it emailed
   out. */
function isOurBlobPath(p) {
  return typeof p === 'string' &&
         /^quotes\/\d{4}\/(0[1-9]|1[0-2])\/[0-9a-f]{32}\/[1-5]-[A-Za-z0-9 ._-]{1,90}$/.test(p) &&
         p.indexOf('..') === -1;
}

// -------------------------------------------------------------- checking

/*
 * Validates the manifest the browser sends before any upload starts, so an
 * oversized or unsupported file is refused before a single byte moves.
 * Returns a customer-facing sentence, or null when the selection is fine.
 */
function checkManifest(files) {
  if (!Array.isArray(files)) return 'We could not read the list of files.';
  if (files.length > MAX_FILES) {
    return 'Please attach no more than ' + MAX_FILES + ' files.';
  }
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    const name = String(f.name == null ? '' : f.name);
    const size = Number(f.size);

    if (!name.trim()) return 'One of the files has no name.';
    if (!Number.isFinite(size) || size <= 0) {
      return '"' + name + '" looks empty.';
    }
    if (!ALLOWED[extensionOf(name)]) {
      return '"' + name + '" is not a file type we can open. ' +
             'Please send a PDF, image, DWG, DXF or Word file.';
    }
    if (size > MAX_FILE_BYTES) {
      return '"' + name + '" is larger than ' + mb(MAX_FILE_BYTES) +
             ' MB. Please send that one to us by email instead.';
    }
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) {
    return 'Those files come to more than ' + mb(MAX_TOTAL_BYTES) +
           ' MB together. Please attach the important ones and email the rest.';
  }
  return null;
}

function mb(bytes) { return Math.round(bytes / 1024 / 1024); }

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* Header injection guard: a subject or a display name must never be able to
   introduce a new header line. */
function oneLine(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 200);
}

function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

/*
 * Reads the first 512 bytes of a finished upload through its presigned URL
 * and checks that the file really is what its name claims. The bytes never
 * enter the function's REQUEST body - which is the limit that forced the old
 * architecture - and half a kilobyte per file is cheap enough to do on every
 * request.
 */
async function verifySignature(presignedGetUrl, expectedExt) {
  let res;
  try {
    res = await fetch(presignedGetUrl, { headers: { Range: 'bytes=0-511' } });
  } catch (err) {
    return { ok: false, reason: 'unreachable' };
  }
  if (!res.ok && res.status !== 206) return { ok: false, reason: 'unreadable' };

  const head = Buffer.from(await res.arrayBuffer());
  const kind = sniff(head);
  if (!kind) return { ok: false, reason: 'unrecognised' };

  // jpg and jpeg are the same thing; everything else must match exactly.
  const want = expectedExt === 'jpeg' ? 'jpg' : expectedExt;
  if (kind !== want) return { ok: false, reason: 'mismatch', found: kind };
  return { ok: true, kind: kind };
}

module.exports = {
  MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_TEXT_CHARS,
  UPLOAD_TOKEN_MS, DOWNLOAD_LINK_MS, RETENTION_DAYS,
  ALLOWED, ALLOWED_CONTENT_TYPES,
  sniff, extensionOf, safeName,
  newRequestId, blobPrefix, blobPath, isOurBlobPath,
  checkManifest, mb, humanSize, oneLine, isEmail, verifySignature
};
