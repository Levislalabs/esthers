/*
 * Anti-bot defences for the quote form: /api/quote and /api/upload-token.
 *
 * WHY THIS EXISTS
 * Production received automated quote spam: several valid-looking requests
 * from generated names inside a few minutes. The per-IP limit could not stop
 * it - 10 an hour still lets a bot send several in a burst, and a bot that
 * rotates addresses is never limited at all. What was missing was any proof
 * that a human, in a browser, on our page, made the request.
 *
 * THE LAYERS, IN THE ORDER THE ENDPOINTS APPLY THEM
 *   1. Origin        a browser's cross-site POST is refused. Header-only, so
 *                    trivially forged by a script - a filter, not a boundary.
 *   2. Form signals  a honeypot field real people never fill, and a signed
 *                    form-start stamp that must be at least a few seconds
 *                    old. Both are SUPPLEMENTAL: a direct API caller can
 *                    forge or omit them, which is why (3) exists.
 *   3. Turnstile     THE BOUNDARY. A Cloudflare Turnstile token, verified
 *                    server-side with Siteverify before any email is sent or
 *                    upload permission issued. Single-use, five-minute life,
 *                    bound to an action name. Fails CLOSED.
 *   4. Rate limits   burst + hourly, per hashed IP (_quote-limit.js).
 *   5. Duplicates    the same request inside a short window is not emailed
 *                    twice (quote only; see the section below).
 *
 * PRIVACY AND LOGGING
 * No raw IP is stored. The visitor's IP is passed to Cloudflare as Siteverify's
 * optional `remoteip`, as Cloudflare recommends, and nowhere else. Logs carry
 * allow-listed reason tokens only - never a token, a secret, a quote body, a
 * name or an email address.
 */

'use strict';

const crypto = require('crypto');
const H = require('./_chat/http.js');
const FB = require('./_chat/firebase-admin.js');

/* ------------------------------------------------------------ constants */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/* One action per endpoint, so a token minted for an upload cannot be spent
   on a quote email, or the other way round. Turnstile allows 32 characters of
   [A-Za-z0-9_-]. */
const ACTIONS = { upload: 'quote_upload', quote: 'quote_submit' };

/* Where the real widget is served. Overridable for a preview that uses a real
   (non-test) key: TURNSTILE_ALLOWED_HOSTNAMES=a.example,b.example. */
const DEFAULT_HOSTNAMES = ['esthers.ca', 'www.esthers.ca'];

const TOKEN_MAX_CHARS = 2048;              /* Cloudflare's documented maximum */
const VERIFY_TIMEOUT_MS = 5000;            /* per Siteverify attempt */
const VERIFY_ATTEMPTS = 2;                 /* one retry, same idempotency key */
/* Cloudflare already refuses a token older than 300 s. This is a second,
   local check on challenge_ts, with 30 s of slack for clock skew. */
const TOKEN_MAX_AGE_MS = 330 * 1000;
/* A challenge_ts this far in the future is not clock skew, it is wrong. */
const TOKEN_FUTURE_SKEW_MS = 60 * 1000;

/* A person cannot read and fill this form in under three seconds. */
const MIN_FORM_AGE_MS = 3000;
/* Clock-skew allowance for a stamp that appears to come from the future. */
const STAMP_FUTURE_SLACK_MS = 60 * 1000;

/* Duplicate suppression. A request already emailed is not emailed again
   within DUPLICATE_WINDOW_MS; one still in flight blocks a copy for at most
   PENDING_STALE_MS, after which a crashed attempt no longer blocks a retry. */
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
const PENDING_STALE_MS = 2 * 60 * 1000;
const DUPLICATE_COLLECTION = 'quoteDuplicates';
const MEMORY_MAX_ENTRIES = 5000;

const VERIFY_MESSAGE =
  "We couldn't verify this request. Please try again, or contact the shop directly.";
const DUPLICATE_MESSAGE =
  'We already received this exact request a few minutes ago, so it has not been ' +
  'sent again. If something needs changing, edit the request and send it, or ' +
  'contact the shop directly.';

/* Every reason a log line may carry. Anything else is logged as "other", so a
   future code path cannot accidentally write request data into a log. */
const REASONS = new Set([
  'origin', 'honeypot', 'form_stamp_missing', 'form_stamp_invalid', 'too_fast',
  'turnstile_not_configured', 'turnstile_test_key_in_production',
  'turnstile_missing', 'turnstile_malformed', 'turnstile_rejected',
  'turnstile_expired_or_reused', 'turnstile_wrong_action', 'turnstile_wrong_hostname',
  'turnstile_stale', 'turnstile_bad_timestamp', 'turnstile_unavailable', 'turnstile_bad_response',
  'turnstile_secret_rejected', 'turnstile_bad_request',
  'duplicate', 'duplicate_store_unavailable', 'form_stamp_unconfigured'
]);

function logReason(endpoint, reason) {
  const r = REASONS.has(reason) ? reason : 'other';
  console.warn('quote-guard: ' + endpoint + ' refused: ' + r);
}

/* ------------------------------------------------------- configuration */

/* Cloudflare's published dummy keys. They pass (or fail) unconditionally,
   so one reaching production would switch the boundary off. */
function isTestSecret(s) { return typeof s === 'string' && /^[123]x0+AA$/.test(s); }
function isTestSiteKey(s) { return typeof s === 'string' && /^[123]x0+(AA|AB|BB|FF)$/.test(s); }

function turnstileConfig(env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const secret = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (!siteKey || !secret) return { ok: false, reason: 'turnstile_not_configured' };

  if (env.VERCEL_ENV === 'production' && (isTestSecret(secret) || isTestSiteKey(siteKey))) {
    return { ok: false, reason: 'turnstile_test_key_in_production' };
  }

  const listed = String(env.TURNSTILE_ALLOWED_HOSTNAMES || '')
    .split(',').map(function (h) { return h.trim().toLowerCase(); }).filter(Boolean);

  return {
    ok: true,
    siteKey: siteKey,
    secret: secret,
    hostnames: listed.length ? listed : DEFAULT_HOSTNAMES,
    /* Dummy secrets return whatever action/hostname Cloudflare's test service
       chooses, so those two bindings are only checked with a real secret. */
    testMode: isTestSecret(secret)
  };
}

/* --------------------------------------------------------- Turnstile */

function looksLikeToken(t) {
  return typeof t === 'string' && t.length > 0 && t.length <= TOKEN_MAX_CHARS &&
         /^[\x21-\x7e]+$/.test(t);
}

async function postOnce(fetchFn, body) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, VERIFY_TIMEOUT_MS) : null;
  try {
    return await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
      signal: ctrl ? ctrl.signal : undefined
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
 * Verifies a Turnstile token with Cloudflare. Never throws.
 *
 * Resolves { ok: true } or { ok: false, reason, status, notConfigured? }.
 * status is 403 for a token that is missing, forged, reused or expired, and
 * 503 when verification itself could not be carried out. Both FAIL CLOSED:
 * a Turnstile outage stops server-sent quotes rather than letting them all
 * through - the page still offers the phone numbers and copy-to-email.
 *
 * opts: { action, ip, env, fetch, now }
 */
async function verifyTurnstile(token, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cfg = turnstileConfig(env);
  if (!cfg.ok) return { ok: false, reason: cfg.reason, status: 503, notConfigured: true };

  if (token == null || token === '') return { ok: false, reason: 'turnstile_missing', status: 403 };
  if (!looksLikeToken(token)) return { ok: false, reason: 'turnstile_malformed', status: 403 };

  const fetchFn = o.fetch || globalThis.fetch;
  const params = new URLSearchParams();
  params.set('secret', cfg.secret);
  params.set('response', token);
  if (o.ip) params.set('remoteip', o.ip);
  /* Same key on the retry, so Cloudflare treats it as the same validation
     and a token is not refused as "already spent" by our own retry. */
  params.set('idempotency_key', crypto.randomUUID());
  const body = params.toString();

  let res = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    try {
      res = await postOnce(fetchFn, body);
      if (res && res.status >= 500) { res = null; continue; }
      break;
    } catch (err) {
      res = null;              /* network error or our timeout; try once more */
    }
  }
  if (!res) return { ok: false, reason: 'turnstile_unavailable', status: 503 };

  let data;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.success !== 'boolean') {
    return { ok: false, reason: 'turnstile_bad_response', status: 503 };
  }

  if (data.success !== true) {
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    const has = function (c) { return codes.indexOf(c) !== -1; };
    if (has('missing-input-secret') || has('invalid-input-secret')) {
      return { ok: false, reason: 'turnstile_secret_rejected', status: 503, notConfigured: true };
    }
    if (has('internal-error')) return { ok: false, reason: 'turnstile_unavailable', status: 503 };
    if (has('bad-request')) return { ok: false, reason: 'turnstile_bad_request', status: 503 };
    if (has('timeout-or-duplicate')) {
      return { ok: false, reason: 'turnstile_expired_or_reused', status: 403 };
    }
    return { ok: false, reason: 'turnstile_rejected', status: 403 };
  }

  if (!cfg.testMode) {
    if (data.action !== o.action) {
      return { ok: false, reason: 'turnstile_wrong_action', status: 403 };
    }
    const host = typeof data.hostname === 'string' ? data.hostname.toLowerCase() : '';
    if (cfg.hostnames.indexOf(host) === -1) {
      return { ok: false, reason: 'turnstile_wrong_hostname', status: 403 };
    }
  }

  /*
   * challenge_ts - FAIL CLOSED. Cloudflare already refuses a token older than
   * 300 s; this is a local, defensive check on the success response itself.
   * With a REAL secret it is mandatory: missing, non-string, unparseable,
   * older than TOKEN_MAX_AGE_MS or more than TOKEN_FUTURE_SKEW_MS in the
   * future -> refused.
   *
   * With a Cloudflare DUMMY secret (preview/local only - refused in
   * production by turnstileConfig) a timestamp that IS present is checked the
   * same way, but an absent one is tolerated: Cloudflare does not document
   * the dummy response body, so requiring it there could break preview
   * testing without protecting anything real.
   */
  const now = o.now != null ? o.now : Date.now();
  const rawTs = data.challenge_ts;
  if (rawTs === undefined && cfg.testMode) return { ok: true };
  if (typeof rawTs !== 'string' || rawTs === '') {
    return { ok: false, reason: 'turnstile_bad_timestamp', status: 403 };
  }
  const ts = Date.parse(rawTs);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'turnstile_bad_timestamp', status: 403 };
  if (ts - now > TOKEN_FUTURE_SKEW_MS) return { ok: false, reason: 'turnstile_bad_timestamp', status: 403 };
  if (now - ts > TOKEN_MAX_AGE_MS) return { ok: false, reason: 'turnstile_stale', status: 403 };

  return { ok: true };
}

/* ----------------------------------------------------- form signals */

/*
 * A key for this module's HMACs (form stamps and duplicate fingerprints),
 * derived from CHAT_RATE_LIMIT_SECRET with a fixed label, so it is a
 * different key from the one the rate limiter uses with the same secret.
 * Null when the secret is not configured.
 */
function guardKey(env) {
  const secret = env.CHAT_RATE_LIMIT_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) return null;
  return crypto.createHmac('sha256', secret).update('esthers-quote-guard-v1').digest();
}

function stampMac(key, ts) {
  return crypto.createHmac('sha256', key).update('form-stamp|' + ts).digest('base64url');
}

/* Issued by GET /api/quote when the page loads. "<ms base36>.<mac>". */
function issueFormStamp(env, now) {
  const key = guardKey(env || process.env);
  if (!key) return null;
  const ts = String(Math.floor(now != null ? now : Date.now()));
  return Number(ts).toString(36) + '.' + stampMac(key, ts);
}

/*
 * Supplemental bot signals. Resolves { ok: true } or { ok: false, reason }.
 * Neither signal is a boundary - both can be forged by a script that reads
 * this file - but each costs a naive bot something and costs a person nothing.
 */
function checkFormSignals(body, env, now) {
  const b = body || {};
  /* The honeypot. Absent is fine (a direct caller simply has no such field);
     anything other than an empty string means something filled it in. */
  if (b.hp !== undefined && b.hp !== null && b.hp !== '') return { ok: false, reason: 'honeypot' };

  const key = guardKey(env || process.env);
  if (!key) return { ok: true, note: 'form_stamp_unconfigured' };

  const stamp = b.formStamp;
  if (stamp == null || stamp === '') return { ok: false, reason: 'form_stamp_missing' };
  const m = typeof stamp === 'string' && /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(stamp);
  if (!m) return { ok: false, reason: 'form_stamp_invalid' };

  const tsNum = parseInt(m[1], 36);
  if (!Number.isSafeInteger(tsNum)) return { ok: false, reason: 'form_stamp_invalid' };
  const expected = Buffer.from(stampMac(key, String(tsNum)));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'form_stamp_invalid' };
  }

  const age = (now != null ? now : Date.now()) - tsNum;
  if (age < -STAMP_FUTURE_SLACK_MS) return { ok: false, reason: 'form_stamp_invalid' };
  if (age < MIN_FORM_AGE_MS) return { ok: false, reason: 'too_fast' };
  return { ok: true };
}

/* --------------------------------------------- duplicate suppression */

/*
 * NORMALISATION. A text field is Unicode-NFKC normalised, lower-cased, every
 * run of whitespace collapsed to one space, and trimmed. So "Flashing  20FT"
 * and "flashing 20ft\n" are the same request; "flashing 22ft" is not.
 * The email is trimmed and lower-cased.
 *
 * ATTACHMENTS (v2). Each file contributes its original file NAME (normalised
 * as above) AND a server-derived CONTENT DIGEST (L.contentDigest: SHA-256 of
 * the stored size plus 512-byte samples from the start, middle and end), and
 * the pairs are sorted. Consequences:
 *   - the same file re-uploaded (new random storage path, same bytes)  -> same
 *   - a REVISED file under the same name (different bytes)             -> differs
 *   - a forgotten photo added, or a file renamed                        -> differs
 * The random storage path is never used (it would defeat suppression), and
 * nothing the browser asserts is used either - the digest is computed by the
 * server from what is actually stored. A file whose digest could not be read
 * contributes a random nonce instead, so that request is NEVER treated as a
 * duplicate: failing towards sending, not towards dropping a real quote.
 *
 * Only the HMAC of that material is ever stored. No quote text, name or
 * email address is kept for this purpose.
 */
function normaliseText(v) {
  return String(v == null ? '' : v).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* files: [{ name, digest }]. A missing digest becomes a fresh random nonce. */
function fileEntriesOf(files) {
  return (files || []).map(function (f) {
    const name = normaliseText(f && f.name);
    const digest = (f && typeof f.digest === 'string' && /^[0-9a-f]{64}$/.test(f.digest))
      ? f.digest
      : 'unknown:' + crypto.randomBytes(16).toString('hex');
    return name + '\u0002' + digest;
  }).sort();
}

function fingerprint(key, q) {
  const material = [
    'v2',
    normaliseText(q.name),
    String(q.email == null ? '' : q.email).trim().toLowerCase(),
    normaliseText(q.text),
    fileEntriesOf(q.files).join('\u0000')
  ].join('\u0001');
  return crypto.createHmac('sha256', key).update(material).digest('hex').slice(0, 40);
}

/* Per-instance fallback, so duplicates are still caught within one instance
   when Firestore is unconfigured or failing. Bounded like the rate limiter. */
function createMemoryDuplicates() {
  const key = crypto.randomBytes(32);   /* used when there is no guard key */
  const entries = new Map();

  function decide(entry, now) {
    if (!entry) return false;
    if (entry.status === 'sent') return now - entry.at < DUPLICATE_WINDOW_MS;
    return now - entry.at < PENDING_STALE_MS;
  }

  return {
    key: key,
    reserve: function (fp, now) {
      if (decide(entries.get(fp), now)) return false;
      if (entries.size >= MEMORY_MAX_ENTRIES) {
        for (const [k, e] of entries) if (!decide(e, now)) entries.delete(k);
        while (entries.size >= MEMORY_MAX_ENTRIES) entries.delete(entries.keys().next().value);
      }
      entries.set(fp, { status: 'pending', at: now });
      return true;
    },
    confirm: function (fp, now) { entries.set(fp, { status: 'sent', at: now }); },
    release: function (fp) { entries.delete(fp); },
    size: function () { return entries.size; }
  };
}

const defaultMemoryDuplicates = createMemoryDuplicates();

function sharedConfigured(env) {
  if (!guardKey(env)) return false;
  try { FB.readConfig(env); return true; } catch (e) { return false; }
}

/*
 * Reserves a quote's fingerprint before the email is sent.
 *
 * Resolves { duplicate: true } when the same request was emailed inside the
 * window, or is in flight right now; otherwise { duplicate: false, confirm,
 * release }. The caller MUST call confirm() after the provider accepts the
 * email and release() if sending fails, so a failed attempt never blocks the
 * customer's retry and nothing is ever reported as sent when it was not.
 *
 * The Firestore reservation is a transaction, so two copies arriving at once
 * cannot both win. Firestore errors fall back to the in-memory layer (logged):
 * Turnstile and the rate limits still bound what can be sent.
 *
 * deps for tests: { env, now, memory, initAdmin }
 */
async function reserveDuplicate(q, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const now = d.now != null ? d.now : Date.now();
  const memory = d.memory || defaultMemoryDuplicates;
  const key = guardKey(env) || memory.key;
  const fp = fingerprint(key, q);

  if (!memory.reserve(fp, now)) return { duplicate: true };

  let ref = null;
  if (sharedConfigured(env)) {
    try {
      const admin = await (d.initAdmin ? d.initAdmin() : FB.initAdmin());
      ref = admin.db.collection(DUPLICATE_COLLECTION).doc(fp);
      const won = await admin.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const e = snap.exists ? (snap.data() || {}) : null;
        if (e && typeof e.at === 'number') {
          if (e.status === 'sent' && now - e.at < DUPLICATE_WINDOW_MS) return false;
          if (e.status === 'pending' && now - e.at < PENDING_STALE_MS) return false;
        }
        tx.set(ref, {
          status: 'pending',
          at: now,
          /* For an optional Firestore TTL policy on this collection. */
          expireAt: new Date(now + DUPLICATE_WINDOW_MS)
        });
        return true;
      });
      if (!won) {
        memory.release(fp);
        return { duplicate: true };
      }
    } catch (err) {
      ref = null;
      logReason('quote', 'duplicate_store_unavailable');
    }
  }

  return {
    duplicate: false,
    confirm: async function (when) {
      const t = when != null ? when : Date.now();
      memory.confirm(fp, t);
      if (ref) {
        try {
          await ref.set({ status: 'sent', at: t, expireAt: new Date(t + DUPLICATE_WINDOW_MS) });
        } catch (e) { logReason('quote', 'duplicate_store_unavailable'); }
      }
    },
    release: async function () {
      memory.release(fp);
      if (ref) {
        try { await ref.delete(); } catch (e) { logReason('quote', 'duplicate_store_unavailable'); }
      }
    }
  };
}

/* ------------------------------------------------------- responses */

function refuse(res, status) {
  return res.status(status === 503 ? 503 : 403).json({
    ok: false, verificationFailed: true, error: VERIFY_MESSAGE
  });
}

function refuseDuplicate(res) {
  return res.status(409).json({ ok: false, duplicate: true, error: DUPLICATE_MESSAGE });
}

module.exports = {
  SITEVERIFY_URL, ACTIONS, DEFAULT_HOSTNAMES, TOKEN_MAX_CHARS, TOKEN_MAX_AGE_MS,
  TOKEN_FUTURE_SKEW_MS,
  MIN_FORM_AGE_MS, DUPLICATE_WINDOW_MS, PENDING_STALE_MS, DUPLICATE_COLLECTION,
  VERIFY_MESSAGE, DUPLICATE_MESSAGE, REASONS,
  isTestSecret, isTestSiteKey, turnstileConfig, verifyTurnstile,
  guardKey, issueFormStamp, checkFormSignals,
  normaliseText, fingerprint, createMemoryDuplicates, reserveDuplicate,
  originAllowed: H.sameOrigin, clientIp: H.clientIp, logReason, refuse, refuseDuplicate
};
