/*
 * The wrapper every chat endpoint runs inside.
 *
 * Putting the gates here rather than in six separate files means a route
 * cannot accidentally be written without one. The order is deliberate and
 * cheapest-first: method, origin, body, configuration, authentication,
 * authorisation, rate limit, then the work.
 *
 * Rate limiting comes AFTER authentication on purpose. It writes a Firestore
 * document, so letting an unauthenticated caller trigger it would hand them a
 * free write amplifier.
 */

'use strict';

const H = require('./http.js');
const { initAdmin, serverNow, ChatConfigError } = require('./firebase-admin.js');
const { AuthError, authenticateCustomer, authenticateStaff } = require('./auth.js');
const { ValidationError } = require('./validation.js');
const { ServiceError } = require('./service.js');
const RL = require('./rate-limit.js');

const RATE_SECRET_ENV = 'CHAT_RATE_LIMIT_SECRET';

/*
 * Errors are translated here, once. A handler never sends a Firebase message
 * or a stack trace to a browser: anything unrecognised becomes a flat 500
 * with a generic sentence, and the detail goes to the log as a short code.
 */
function respondToError(res, err, route) {
  if (err instanceof RL.RateLimitError) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
    return H.fail(res, 429, err.code,
      'You have sent a lot of messages just now. Please wait a moment and try again.',
      { retryAfter: err.retryAfterSeconds });
  }
  if (err instanceof AuthError) return H.fail(res, err.status, err.code, err.message);
  if (err instanceof ValidationError) return H.fail(res, err.status, err.code, err.message);
  if (err instanceof ServiceError) return H.fail(res, err.status, err.code, err.message);

  /* Missing or malformed deployment configuration. 503, not 500: the request
     was fine, the deployment is unfinished. The reason is a short token and
     never contains any part of a credential. */
  if (err instanceof ChatConfigError || err instanceof RL.RateLimitConfigError ||
      (err && err.notConfigured)) {
    console.error('chat: not configured [' + route + '] ' + (err.reason || 'unknown'));
    return H.fail(res, 503, 'not_configured',
      'Online messaging is not available just now.', { notConfigured: true });
  }

  /* Anything else. Log the shape, never the content: no message body, no
     email address, no token, no address. */
  console.error('chat: unhandled [' + route + '] ' + (err && err.name ? err.name : 'Error'));
  return H.fail(res, 500, 'server_error',
    'Something went wrong at our end. Please try again.');
}

/*
 * options:
 *   route     short name, used only in logs
 *   methods   allowed HTTP methods
 *   actor     'customer' | 'staff' | 'none'
 *   needsRateSecret  true when the route will consume a rate limit
 *   run(ctx)  the endpoint body
 */
function createHandler(options) {
  return async function handler(req, res) {
    try {
      if (!H.methodAllowed(req, res, options.methods)) return;

      /* Same-origin only. A browser attaches Origin to cross-site requests,
         so a mismatch is a genuine refusal; an absent Origin is not treated
         as proof of anything and authentication still applies below. */
      if (!H.sameOrigin(req)) {
        return H.fail(res, 403, 'cross_origin', 'This request was refused.');
      }

      const body = H.parseBody(req);
      if (body === null) {
        return H.fail(res, 400, 'malformed_body', 'That request could not be read.');
      }

      /* Lazy: nothing touched Firebase at import time, so a Preview
         deployment without credentials still builds and still answers. */
      const admin = (options.deps && options.deps.initAdmin)
        ? options.deps.initAdmin()
        : initAdmin();

      const db = admin.db;
      const verifyIdToken = (options.deps && options.deps.verifyIdToken)
        ? options.deps.verifyIdToken
        : (token) => admin.auth.verifyIdToken(token, true);

      let rateSecret = null;
      if (options.needsRateSecret) {
        rateSecret = ((options.deps && options.deps.env) || process.env)[RATE_SECRET_ENV];
        if (typeof rateSecret !== 'string' || rateSecret.length < 16) {
          throw new RL.RateLimitConfigError();
        }
      }

      let actor = null;
      if (options.actor === 'customer') {
        actor = await authenticateCustomer(verifyIdToken, req.headers.authorization);
      } else if (options.actor === 'staff') {
        actor = await authenticateStaff(verifyIdToken, db, req.headers.authorization);
      }

      const now = (options.deps && options.deps.now) ? options.deps.now : serverNow;

      await options.run({
        req, res, body, db, actor, rateSecret,
        ip: H.clientIp(req),
        deps: { now },
        query: req.query || {}
      });
    } catch (err) {
      return respondToError(res, err, options.route);
    }
  };
}

module.exports = { RATE_SECRET_ENV, createHandler, respondToError };
