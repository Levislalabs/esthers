/*
 * Rate limiting for the quote form: /api/quote and /api/upload-token.
 *
 * WHY THIS EXISTS
 * Both endpoints are live and anonymous. Without a limit, anybody can POST
 * /api/quote in a loop: every call sends an email through the Resend account,
 * which floods Esther's inbox and burns the sending quota that real
 * customers' quotes depend on. /api/upload-token has the same shape of
 * problem with storage instead of email.
 *
 * TWO LAYERS, BECAUSE ONE OF THEM IS NOT SWITCHED ON YET
 *
 *   1. In-memory, per server instance. Always on, needs no configuration.
 *      On its own it is weak - a serverless deployment runs several
 *      instances and each keeps its own count (see the note at the top of
 *      _chat/rate-limit.js) - but it stops the simple case of one script
 *      hammering the endpoint, and it works from the moment this deploys.
 *      It is PARTIAL protection only: gap G1 is not closed in production
 *      until layer 2 is configured and verified (docs/QUOTE_UPLOADS.md).
 *
 *   2. Shared, in Firestore, reusing the chat system's limiter
 *      (_chat/rate-limit.js) with its own quote_* / upload_* scopes. Every
 *      instance sees the same counter, so this is the layer that really
 *      holds. It turns itself on once the chat environment variables
 *      (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY and
 *      CHAT_RATE_LIMIT_SECRET) are set in Vercel. Until then it is skipped.
 *
 * FAILS OPEN, ON PURPOSE - THE OPPOSITE OF CHAT
 * The chat API refuses to run without its limiter, because an unlimited chat
 * endpoint is worse than an unavailable one. The quote form is different: it
 * is how the business gets work, it was running before any limiter existed,
 * and losing a real customer's request because Firestore hiccuped is the
 * worse outcome. So if the shared layer is unconfigured or errors, the
 * request is allowed (the in-memory layer still applies) and the failure is
 * logged as a reason token.
 *
 * PRIVACY
 * Same rules as chat. No raw IP is stored anywhere - not even in memory: the
 * in-memory layer HMACs the address with a random key generated per
 * instance, and the shared layer HMACs it with CHAT_RATE_LIMIT_SECRET. The
 * address is never logged. It is a rate-limit dimension, never identity.
 */

'use strict';

const crypto = require('crypto');
const H = require('./_chat/http.js');
const RL = require('./_chat/rate-limit.js');
const FB = require('./_chat/firebase-admin.js');

const SCOPES = {
  quote: 'quote_ip',
  upload: 'upload_ip'
};

/* Upper bound on the in-memory table, so a flood of distinct addresses
   cannot grow an instance's memory without limit. */
const MEMORY_MAX_ENTRIES = 5000;

const CUSTOMER_MESSAGE =
  'We have received several requests from your connection in a short time, ' +
  'so we have paused this one. Please wait a while and try again, or email ' +
  'or phone us directly - we would still like to hear from you.';

/* ------------------------------------------------------ in-memory layer */

function createMemoryLimiter() {
  /* Random per instance and never stored, so the keys in this table cannot
     be reversed into addresses even by somebody reading a heap dump. */
  const key = crypto.randomBytes(32);
  const buckets = new Map();

  function id(scope, identifier) {
    return crypto.createHmac('sha256', key)
      .update(scope + '\n' + String(identifier))
      .digest('hex')
      .slice(0, 32);
  }

  function prune(now) {
    for (const [k, b] of buckets) {
      const rule = RL.RULES[b.scope];
      if (!rule || now - b.windowStart >= rule.windowMs) buckets.delete(k);
    }
    /* Still full: drop the oldest. A Map iterates in insertion order. */
    while (buckets.size >= MEMORY_MAX_ENTRIES) {
      buckets.delete(buckets.keys().next().value);
    }
  }

  /* Same fixed-window arithmetic as RL.consume, so the two layers agree. */
  function consume(scope, identifier, now) {
    const rule = RL.RULES[scope];
    if (!rule) throw new Error('unknown rate-limit scope: ' + scope);

    const k = id(scope, identifier);
    let b = buckets.get(k);
    if (b && now - b.windowStart >= rule.windowMs) b = null;

    if (b && b.count >= rule.limit) {
      const retryMs = rule.windowMs - (now - b.windowStart);
      return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    }

    if (!b) {
      if (buckets.size >= MEMORY_MAX_ENTRIES) prune(now);
      buckets.set(k, { scope: scope, windowStart: now, count: 1 });
    } else {
      b.count += 1;
    }
    return { limited: false };
  }

  return { consume: consume, size: function () { return buckets.size; } };
}

const defaultMemory = createMemoryLimiter();

/* --------------------------------------------------------- shared layer */

/* True only when everything the Firestore limiter needs is present. Checked
   WITHOUT loading the SDK, so an unconfigured deployment pays nothing. */
function sharedConfigured(env) {
  const secret = env.CHAT_RATE_LIMIT_SECRET;
  if (typeof secret !== 'string' || secret.length < 16) return false;
  try {
    FB.readConfig(env);
    return true;
  } catch (e) {
    return false;
  }
}

function reasonOf(err) {
  if (err && typeof err.reason === 'string') return err.reason;
  if (err && typeof err.code === 'string') return err.code;
  return (err && err.name) || 'unknown';
}

/* ----------------------------------------------------------- the check */

/*
 * Consumes one request for `kind` ('quote' or 'upload') from the caller's
 * address. Resolves to { limited: false } or
 * { limited: true, retryAfterSeconds }. Never rejects.
 *
 * deps is for tests only: { env, now, memory, initAdmin, consume }.
 */
async function check(req, kind, deps) {
  const d = deps || {};
  const scope = SCOPES[kind];
  if (!scope) throw new Error('unknown quote limit kind: ' + kind);

  const env = d.env || process.env;
  const now = d.now || Date.now();
  const memory = d.memory || defaultMemory;
  /* No address at all should not happen on Vercel. If it does, those
     requests share one bucket rather than going unlimited. */
  const ip = H.clientIp(req) || 'unknown';

  const local = memory.consume(scope, ip, now);
  if (local.limited) {
    console.warn('quote-limit: ' + scope + ' limited (instance)');
    return local;
  }

  if (!sharedConfigured(env)) return { limited: false };

  try {
    const admin = await (d.initAdmin ? d.initAdmin() : FB.initAdmin());
    await (d.consume || RL.consume)(admin.db, scope, ip, env.CHAT_RATE_LIMIT_SECRET, { now: now });
    return { limited: false };
  } catch (err) {
    if (err instanceof RL.RateLimitError || (err && err.chatErrorKind === 'rate_limit')) {
      console.warn('quote-limit: ' + scope + ' limited (shared)');
      return { limited: true, retryAfterSeconds: err.retryAfterSeconds };
    }
    /* Fail open - see the header. A reason token only, never the error
       message, which could carry details of the request. */
    console.error('quote-limit: shared limiter unavailable, allowing: ' + reasonOf(err));
    return { limited: false };
  }
}

/* Writes the 429. The form already shows `error` to the customer. */
function reject(res, result) {
  const seconds = Math.max(1, Math.ceil(Number(result.retryAfterSeconds) || 60));
  res.setHeader('Retry-After', String(seconds));
  return res.status(429).json({
    ok: false,
    rateLimited: true,
    retryAfterSeconds: seconds,
    error: CUSTOMER_MESSAGE
  });
}

module.exports = {
  SCOPES, MEMORY_MAX_ENTRIES, CUSTOMER_MESSAGE,
  createMemoryLimiter, sharedConfigured, check, reject
};
