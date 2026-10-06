/*
 * Shared test plumbing for the quote-form suites. NO NETWORK, NO EMULATOR.
 *
 * - fakeDb():        just enough Firestore for transactions, get/set/delete.
 * - installFakeBlob: a stand-in for @vercel/blob in require's cache that
 *                    records every permission that WOULD have been issued.
 * - installFakeFetch: plays BOTH remote services the endpoints call:
 *     Cloudflare Siteverify - tokens describe their own verdict, and every
 *                             token is single-use exactly as Cloudflare
 *                             enforces it (a second use gets
 *                             "timeout-or-duplicate");
 *     Resend                - records each email that would have been sent.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const QL = require('../../api/_quote-limit.js');
export const QG = require('../../api/_quote-guard.js');
export const RL = require('../../api/_chat/rate-limit.js');
export const FB = require('../../api/_chat/firebase-admin.js');
export const L = require('../../api/_lib.js');
export const quoteHandler = require('../../api/quote.js');
export const uploadHandler = require('../../api/upload-token.js');

export const MB = 1024 * 1024;
export const HOUR = 60 * 60 * 1000;
export const SECRET = 'test-rate-limit-secret-not-real-0123456789';
/* Shaped like real Turnstile keys, so action and hostname ARE enforced. */
export const SITE_KEY = '0x4AAAAAAAsitekey-not-real';
export const TURNSTILE_SECRET = '0x4AAAAAAAsecret-not-real-0000000';

/* PEM-shaped placeholder, a credential for nothing (same as the chat suite). */
const GOOD_KEY = '-----BEGIN PRIVATE KEY-----\\n'
  + 'Tk9ULUEtUkVBTC1LRVktcGxhY2Vob2xkZXItZm9yLXRlc3Rz\\n'
  + '-----END PRIVATE KEY-----\\n';
export const sharedEnv = () => ({
  FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: 'placeholder@example.iam.gserviceaccount.test',
  FIREBASE_PRIVATE_KEY: GOOD_KEY,
  CHAT_RATE_LIMIT_SECRET: SECRET
});

/* ------------------------------------------------------------ Firestore */

export function fakeDb() {
  const docs = new Map();
  let chain = Promise.resolve();
  const refFor = (name, id) => {
    const path = name + '/' + id;
    return {
      path,
      async set(v) { docs.set(path, { ...v }); },
      async delete() { docs.delete(path); }
    };
  };
  return {
    docs,
    collection(name) { return { doc(id) { return refFor(name, id); } }; },
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

/* -------------------------------------------------------- req / res / logs */

export function req(ip, extra) {
  return Object.assign({
    method: 'POST',
    headers: {
      'x-vercel-forwarded-for': ip,
      host: 'www.esthers.ca',
      origin: 'https://www.esthers.ca'
    },
    body: {}
  }, extra || {});
}

export function res() {
  return {
    statusCode: 200, headers: {}, payload: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    json(p) { this.payload = p; return this; }
  };
}

export async function call(handler, r) { const out = res(); await handler(r, out); return out; }

export function captureLogs() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) {
    console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  }
  return { lines, text: () => lines.join('\n'), restore() { Object.assign(console, orig); } };
}

/* ----------------------------------------------------------- @vercel/blob */

const API_DIR = fileURLToPath(new URL('../../api/', import.meta.url));
const BLOB_PATH = require.resolve('@vercel/blob', { paths: [API_DIR] });

/*
 * Objects that "exist" in Blob storage: pathname -> { size, bytes }.
 * head() reports size; the signature read (a GET of the presigned URL,
 * answered by installFakeFetch) returns bytes. Anything not registered does
 * not exist.
 */
export const blobObjects = new Map();

/* First bytes of each supported type, as the server's sniff() expects. */
export const MAGIC = {
  pdf: Buffer.from('%PDF-1.7\n%fake drawing\n'),
  jpg: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46]),
  png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(8)]),
  dwg: Buffer.from('AC1032\0\0\0\0'),
  dxf: Buffer.from('  0\r\nSECTION\r\n  2\r\nHEADER\r\n'),
  doc: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]),
  docx: Buffer.from([0x50, 0x4B, 0x03, 0x04, 20, 0, 6, 0])
};

let blobSeq = 0;
/* Registers an uploaded object and returns its pathname, shaped exactly like
   one /api/upload-token would issue. `bytes` defaults to the right magic. */
export function storedFile(filename, opts) {
  const o = opts || {};
  blobSeq += 1;
  const id = (blobSeq.toString(16) + 'f'.repeat(32)).slice(0, 32);
  const pathname = 'quotes/2026/10/' + id + '/' + (o.index || 1) + '-' + filename;
  const ext = filename.split('.').pop().toLowerCase();
  const bytes = o.bytes || MAGIC[ext === 'jpeg' ? 'jpg' : ext] || Buffer.from('????');
  blobObjects.set(pathname, { size: o.size != null ? o.size : bytes.length + 1000, bytes });
  return pathname;
}

export function installFakeBlob() {
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
      async head(pathname) {
        calls.head.push(pathname);
        const o = blobObjects.get(pathname);
        if (!o) throw new Error('BlobNotFoundError');
        return { size: o.size, pathname };
      }
    }
  };
  return { calls, restore() { if (saved) require.cache[BLOB_PATH] = saved; else delete require.cache[BLOB_PATH]; } };
}

/* ------------------------------------------------- Siteverify + Resend */

let tokenSeq = 0;
/* A token that Siteverify will accept for `action` on `hostname`. */
export function passToken(action, hostname) {
  tokenSeq += 1;
  return 'pass~' + action + '~' + (hostname || 'www.esthers.ca') + '~' + tokenSeq;
}

/*
 * siteverify modes (set fake.mode):
 *   'normal'   - verdict from the token:
 *                  pass~<action>~<hostname>~<n>   success
 *                  fail~<error-code>~<n>          success:false, that code
 *                single-use enforced.
 *   'down'     - network error on every call
 *   '5xx'      - HTTP 503 on every call
 *   'garbage'  - HTTP 200 with a non-JSON body
 *   'weird'    - HTTP 200 JSON without a boolean success
 *   'flaky'    - first call network error, then normal
 */
export function installFakeFetch() {
  const orig = globalThis.fetch;
  const fake = {
    mode: 'normal',
    siteverify: [],       /* URLSearchParams of every Siteverify call */
    sent: [],             /* every Resend payload */
    resendStatus: 200,
    used: new Set(),
    challengeTs: null,    /* override challenge_ts */
    restore() { globalThis.fetch = orig; }
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === QG.SITEVERIFY_URL) {
      const params = new URLSearchParams(String(init && init.body));
      fake.siteverify.push(params);
      if (fake.mode === 'down') throw new Error('ECONNRESET');
      if (fake.mode === 'flaky' && fake.siteverify.length === 1) throw new Error('ECONNRESET');
      if (fake.mode === '5xx') return { ok: false, status: 503, json: async () => ({}) };
      if (fake.mode === 'garbage') return { ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } };
      if (fake.mode === 'weird') return { ok: true, status: 200, json: async () => ({ hello: 1 }) };

      /* Cloudflare knows only the real secret (and any dummy a test opts in). */
      if (params.get('secret') !== TURNSTILE_SECRET &&
          params.get('secret') !== fake.acceptSecret) {
        return { ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['invalid-input-secret'] }) };
      }
      const token = params.get('response') || '';
      /* Cloudflare idempotency: a retry with the same key is the same check. */
      const idem = params.get('idempotency_key');
      if (fake.used.has(token) && fake.lastIdem.get(token) !== idem) {
        return { ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) };
      }
      fake.used.add(token);
      fake.lastIdem.set(token, idem);
      const parts = token.split('~');
      if (parts[0] === 'pass') {
        return { ok: true, status: 200, json: async () => ({
          success: true,
          challenge_ts: fake.challengeTs || new Date().toISOString(),
          hostname: parts[2], 'error-codes': [], action: parts[1], cdata: ''
        }) };
      }
      if (parts[0] === 'fail') {
        return { ok: true, status: 200, json: async () => ({ success: false, 'error-codes': [parts[1]] }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) };
    }
    if (u.startsWith('https://blob.invalid/')) {   /* signature read via the presigned URL */
      const o = blobObjects.get(u.slice('https://blob.invalid/'.length));
      if (!o) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 206, arrayBuffer: async () => o.bytes.buffer.slice(
        o.bytes.byteOffset, o.bytes.byteOffset + Math.min(o.bytes.length, 512)) };
    }
    if (u === 'https://api.resend.com/emails') {
      fake.sent.push(JSON.parse(init.body));
      if (fake.resendStatus !== 200) {
        return { ok: false, status: fake.resendStatus,
          json: async () => ({ name: 'validation_error', message: 'bad reply_to pat@example.test' }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'fake-' + fake.sent.length }) };
    }
    throw new Error('unexpected fetch in test: ' + u);
  };
  fake.lastIdem = new Map();
  return fake;
}

/* ------------------------------------------------------------- env */

const KEYS = ['RESEND_API_KEY', 'QUOTE_TO', 'QUOTE_FROM', 'BLOB_READ_WRITE_TOKEN',
  'CHAT_RATE_LIMIT_SECRET', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY',
  'TURNSTILE_ALLOWED_HOSTNAMES', 'VERCEL_ENV'];

/* A fully configured deployment WITHOUT Firebase: shared layers are off, so
   the in-memory limiter and duplicate layer are what the endpoints use. */
export function setEnv() {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.RESEND_API_KEY = 'not-a-real-key';
  process.env.QUOTE_TO = 'shop@example.test';
  process.env.BLOB_READ_WRITE_TOKEN = 'not-a-real-token';
  process.env.CHAT_RATE_LIMIT_SECRET = SECRET;
  process.env.TURNSTILE_SITE_KEY = SITE_KEY;
  process.env.TURNSTILE_SECRET_KEY = TURNSTILE_SECRET;
  return function restore() {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  };
}

/* A form stamp issued `ageMs` ago (default 10 s - a plausible human). */
export function stamp(ageMs) {
  return QG.issueFormStamp(process.env, Date.now() - (ageMs == null ? 10000 : ageMs));
}

let quoteSeq = 0;
/* A complete, valid, verifiable quote body - now WITH one uploaded project
   file, because every online quote must carry at least one. Each body has
   distinct text so the duplicate layer does not interfere unless a test
   means it to. */
export function validQuote(over) {
  quoteSeq += 1;
  return Object.assign({
    name: 'Pat Customer', email: 'pat@example.test',
    text: 'Flashing for a garage roof, 20 ft. Request #' + quoteSeq + '-' + Math.random(),
    files: [{ pathname: storedFile('plan.pdf') }],
    turnstileToken: passToken(QG.ACTIONS.quote),
    formStamp: stamp(),
    hp: ''
  }, over || {});
}

export function validUpload(files, over) {
  return Object.assign({
    files: files || [{ name: 'a.pdf', size: 1000 }],
    turnstileToken: passToken(QG.ACTIONS.upload),
    formStamp: stamp(),
    hp: ''
  }, over || {});
}

let ipSeq = 0;
/* A fresh documentation-range address per call, so tests never share a bucket. */
export function freshIp() {
  ipSeq += 1;
  return '198.18.' + ((ipSeq >> 8) & 255) + '.' + (ipSeq & 255);
}
