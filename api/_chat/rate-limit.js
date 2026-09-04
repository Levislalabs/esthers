/*
 * Firestore-backed rate limiting.
 *
 * WHY FIRESTORE AND NOT MEMORY
 * A serverless function has no shared memory: every instance would keep its
 * own counter, and an attacker gets a fresh one just by being routed
 * elsewhere. The counter has to live where every instance can see it.
 * chatRateLimits is denied to every browser by the deployed rules, so only
 * the Admin SDK can read or write it.
 *
 * WHY THE IP IS HASHED, AND WHY IT IS NOT IDENTITY
 * A raw IP address is personal data and there is no reason to keep one. It is
 * HMAC'd with a server secret before it becomes part of a document id, so the
 * stored value cannot be reversed and cannot be correlated with anything by
 * somebody who later sees the database. The hash is a RATE-LIMIT DIMENSION
 * only - an office behind one NAT shares a bucket, and a determined caller
 * can change address - so it is never used to decide who anybody is.
 *
 * WHY BOTH UID AND IP
 * A browser can mint a fresh Anonymous Auth uid whenever it likes, so a
 * per-uid limit alone stops an honest retry loop and nothing else. The
 * hashed-IP limit is the layer that costs an abuser something. Neither is
 * sufficient alone; both are cheap.
 *
 * SHAPE OF THE WINDOW
 * Fixed window, with the window start held INSIDE the document rather than
 * in its id. That keeps exactly one document per identity per scope forever,
 * instead of one per identity per window accumulating without bound. A
 * request that arrives after the window has rolled resets the counter.
 */

'use strict';

const crypto = require('crypto');

const COLLECTION = 'chatRateLimits';

/*
 * The limits, as named constants.
 *
 * Chosen for a two-person sheet metal shop, not a social network. The
 * governing question was: what would a real customer, or somebody testing
 * this, plausibly do in a minute - and then leave clear headroom above it.
 *
 * START is the expensive action: it creates a conversation, and later it
 * will send Esther's an email. It is deliberately the tightest.
 * SEND has to survive somebody typing quickly in short bursts.
 * STAFF is generous because a staff member working through an inbox is
 * legitimate traffic; the limit exists to bound a compromised session, not
 * to pace anyone's day.
 */
const RULES = {
  /* new conversation, per anonymous uid */
  start_uid:   { limit: 3,  windowMs: 10 * 60 * 1000 },
  /* new conversation, per hashed IP - the layer a fresh uid cannot dodge */
  start_ip:    { limit: 8,  windowMs: 60 * 60 * 1000 },
  /* customer message, per anonymous uid */
  send_uid:    { limit: 20, windowMs:      60 * 1000 },
  /* customer message, per hashed IP */
  send_ip:     { limit: 60, windowMs:      60 * 1000 },
  /* any staff mutation (reply or close), per staff uid */
  staff_write: { limit: 60, windowMs:      60 * 1000 }
};

class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super('rate limited');
    this.name = 'RateLimitError';
    this.status = 429;
    this.code = 'rate_limited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class RateLimitConfigError extends Error {
  constructor() {
    super('chat backend is not configured: missing_rate_limit_secret');
    this.name = 'RateLimitConfigError';
    this.reason = 'missing_rate_limit_secret';
    this.notConfigured = true;
  }
}

/*
 * HMAC rather than a bare hash: a plain SHA-256 of an IPv4 address is
 * trivially reversible by enumerating the whole space, which is only four
 * billion guesses. With a secret key that stops being possible.
 *
 * Fails closed. A deployment without the secret cannot rate limit, and an
 * unlimited chat endpoint is worse than an unavailable one.
 */
function hashIdentifier(value, secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new RateLimitConfigError();
  }
  return crypto.createHmac('sha256', secret)
    .update(String(value))
    .digest('hex')
    .slice(0, 32);
}

/*
 * A document id that reveals nothing. The scope is readable so the collection
 * can be reasoned about; the identity half is an HMAC. A uid is hashed too -
 * it is not secret, but there is no reason to leave a browsable list of
 * visitor identifiers lying in a collection.
 */
function bucketId(scope, rawIdentifier, secret) {
  return scope + '_' + hashIdentifier(rawIdentifier, secret);
}

/*
 * Consume one unit against a bucket, atomically.
 *
 * A transaction is what makes this correct under concurrency: two requests
 * arriving together both read, both increment and both write, and without a
 * transaction one increment is lost and the limit is quietly wrong.
 *
 * Throws RateLimitError when the bucket is exhausted.
 */
async function consume(db, scope, rawIdentifier, secret, opts) {
  const rule = RULES[scope];
  if (!rule) throw new Error('unknown rate-limit scope: ' + scope);

  const now = (opts && opts.now) || Date.now();
  const ref = db.collection(COLLECTION).doc(bucketId(scope, rawIdentifier, secret));

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : {};

    const windowStart = typeof data.windowStart === 'number' ? data.windowStart : 0;
    const count = typeof data.count === 'number' ? data.count : 0;
    const expired = (now - windowStart) >= rule.windowMs;

    if (!expired && count >= rule.limit) {
      const retryMs = rule.windowMs - (now - windowStart);
      throw new RateLimitError(Math.max(1, Math.ceil(retryMs / 1000)));
    }

    tx.set(ref, {
      scope: scope,
      windowStart: expired ? now : windowStart,
      count: expired ? 1 : count + 1,
      /* Plain milliseconds, for a later cleanup job to sweep by. No
         identifier, no address, no uid - the id already carries the HMAC and
         nothing else about the caller is stored. */
      updatedAt: now
    });
  });
}

module.exports = {
  COLLECTION, RULES, RateLimitError, RateLimitConfigError,
  hashIdentifier, bucketId, consume
};
