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
const {
  initAdmin, serverNow, ChatConfigError, ChatInitError,
  DIAGNOSTIC_TOKENS, describeConfigShape, describeRuntime
} = require('./firebase-admin.js');
const { AuthError, authenticateCustomer, authenticateStaff } = require('./auth.js');
const { ValidationError } = require('./validation.js');
const { ServiceError } = require('./service.js');
const RL = require('./rate-limit.js');

const RATE_SECRET_ENV = 'CHAT_RATE_LIMIT_SECRET';

/* RateLimitConfigError's token. It lives in rate-limit.js rather than the
   firebase-admin allow-list, so safeReason() admits it explicitly. */
const RATE_SECRET_REASON = 'missing_rate_limit_secret';

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

  /*
   * Missing or malformed deployment configuration. 503, not 500: the request
   * was fine, the deployment is unfinished. The reason is an allow-listed
   * token from firebase-admin.js and can never contain part of a credential.
   *
   * The shape suffix is a fixed set of field names with 0/1 values and
   * nothing else, so it says WHICH structural check failed without
   * disclosing any value. It is what turns "not configured" into something
   * actionable from a production log alone.
   */
  if (err instanceof ChatConfigError || err instanceof RL.RateLimitConfigError ||
      (err && err.notConfigured)) {
    console.error('chat: not configured [' + route + '] ' + safeReason(err)
      + ' ' + safeShape() + ' ' + safeRuntime());
    return H.fail(res, 503, 'not_configured',
      'Online messaging is temporarily unavailable.', { notConfigured: true });
  }

  /*
   * The SDK failed for a reason that is NOT the environment's fault - a
   * missing module, a bad app option, this code being wrong. Still a 500,
   * but with a token that says which stage died instead of the bare word
   * "Error", which is all the previous version could manage: every
   * firebase-admin error carries name === 'Error'.
   */
  if (err instanceof ChatInitError) {
    console.error('chat: init failed [' + route + '] ' + safeReason(err)
      + ' ' + safeShape() + ' ' + safeRuntime());
    return H.fail(res, 500, 'server_error',
      'Something went wrong at our end. Please try again.');
  }

  /* Anything else. An allow-listed token only - never err.message, never
     err.stack, never err.cause, never the error object. */
  console.error('chat: unhandled [' + route + '] ' + classifyRuntimeError(err));
  return H.fail(res, 500, 'server_error',
    'Something went wrong at our end. Please try again.');
}

/* Only ever an allow-listed token. An unrecognised reason is replaced, not
   printed, so a future error class cannot smuggle text into the log. */
function safeReason(err) {
  const reason = err && typeof err.reason === 'string' ? err.reason : '';
  if (reason === RATE_SECRET_REASON) return reason;
  return DIAGNOSTIC_TOKENS.indexOf(reason) === -1 ? 'unknown_initialization_error' : reason;
}

/* describeConfigShape() reads process.env structurally. If it ever throws,
   the diagnostic must not become the outage. */
function safeShape() {
  try { return 'shape=' + describeConfigShape(); } catch (err) { return 'shape=unavailable'; }
}

/* The Node major version and which SDK modules loaded. All public facts -
   nothing here is derived from a credential. This is what tells a missing
   package apart from a package the runtime could not evaluate. */
function safeRuntime() {
  try { return 'runtime=' + describeRuntime(); } catch (err) { return 'runtime=unavailable'; }
}

/*
 * A closed vocabulary for unexpected runtime failures.
 *
 * err.name is NOT logged directly. It is usually harmless, but it is
 * attacker- and library-influenced text, and the whole point of this file is
 * that nothing unvetted reaches a log line.
 */
const RUNTIME_TOKENS = {
  TypeError: 'runtime_type_error',
  RangeError: 'runtime_range_error',
  ReferenceError: 'runtime_reference_error',
  SyntaxError: 'runtime_syntax_error',
  ChatConfigError: 'unknown_initialization_error',
  ChatInitError: 'unknown_initialization_error'
};

function classifyRuntimeError(err) {
  if (!err) return 'unknown_error';
  const name = typeof err.name === 'string' ? err.name : '';
  if (Object.prototype.hasOwnProperty.call(RUNTIME_TOKENS, name)) return RUNTIME_TOKENS[name];
  /* A Firestore/gRPC failure arrives with a numeric code and name 'Error'. */
  if (typeof err.code === 'number') return 'firestore_call_failed';
  return 'unknown_error';
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
      /* initAdmin() is asynchronous now that the SDK is loaded by import().
         Awaiting is what keeps a Promise from being handed on as if it were
         the Admin object; an injected test dependency returning a plain
         object awaits harmlessly. */
      const admin = await ((options.deps && options.deps.initAdmin)
        ? options.deps.initAdmin()
        : initAdmin());

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
