/*
 * Firebase App Check for the custom chat API.
 *
 * WHY THIS FILE EXISTS
 *
 * App Check answers a question Firebase Auth cannot: "is this request coming
 * from OUR app, or from a script someone wrote against our API?" Firebase Auth
 * proves WHO the caller is; App Check proves WHAT is calling.
 *
 * Enabling App Check in the Firebase console protects Google's own services -
 * Firestore, Storage, and the rest - once enforcement is switched on there.
 * It does NOTHING for these endpoints. /api/chat/* and /api/admin/chat/* are
 * ordinary Vercel functions; Google never sees them. For a custom backend the
 * contract is explicit and manual:
 *
 *   the browser asks the App Check SDK for a token and sends it on the request
 *   the server verifies that token with the Admin SDK before doing any work
 *
 * That second half is this file.
 *
 * APP CHECK IS ADDITIVE. It never replaces anything. A request still has to
 * pass the same-origin check, carry a valid Firebase ID token, use the
 * anonymous provider (customer) or hold an active admin staff document
 * (staff), survive payload validation and spend a rate-limit allowance. App
 * Check is one more gate in front of all of that, not a substitute for any of
 * it. A caller holding a perfectly valid App Check token and nothing else gets
 * a 401 from the ID-token check immediately after.
 */

'use strict';

/*
 * THE HEADER.
 *
 * X-Firebase-AppCheck is Firebase's own convention for passing an App Check
 * token to a backend it does not control, and it is what the Firebase
 * documentation for custom backends uses. It is worth being precise about why
 * this is a convention and not an API: the Admin SDK never reads a header.
 * verifyToken() takes a raw string, so extracting it is entirely this
 * application's job, and any header name would work. Matching Firebase's
 * spelling means anyone who has read their docs already knows where to look.
 *
 * Node lower-cases incoming header names, so the lookup key is lower-case
 * while the name the client sends is the canonical mixed-case spelling.
 */
const APP_CHECK_HEADER = 'X-Firebase-AppCheck';
const APP_CHECK_HEADER_KEY = 'x-firebase-appcheck';

/*
 * THE ENFORCEMENT SWITCH.
 *
 * Deliberately an environment variable and nothing else. It is set in the
 * Vercel dashboard, it is never read from the request, and there is no query
 * parameter, header or body field anywhere in this file that can turn
 * enforcement off. A caller cannot opt out of a gate they cannot address.
 *
 * WHY A SWITCH AT ALL. The public chat frontend is not connected yet, so no
 * browser is sending App Check tokens today. Making verification mandatory
 * the moment this lands would reject every request from the production
 * diagnostics probe and from all ~200 existing test call sites - it would
 * break a backend that is already proven, to protect a surface nobody can
 * reach. The switch lets the server-side half ship, be tested and be observed
 * before it starts refusing anything.
 *
 * Recognised values are an explicit allow-list. Anything else - unset, empty,
 * a typo, "yes", "TRUE " with a stray space (trimmed and lower-cased first) -
 * leaves enforcement OFF. That is the safe default while chat is dark, and it
 * is exactly the wrong default once chat is live, which is why enforcement is
 * a named item on the launch checklist in docs/CHAT_APP_CHECK.md rather than
 * something anyone is expected to remember.
 */
const ENFORCE_ENV = 'CHAT_APP_CHECK_ENFORCED';
const ENFORCE_TRUE = ['1', 'true', 'on', 'yes', 'enforced'];

function isEnforced(env) {
  const raw = ((env || process.env) || {})[ENFORCE_ENV];
  return ENFORCE_TRUE.indexOf(String(raw == null ? '' : raw).trim().toLowerCase()) !== -1;
}

/*
 * A refusal. Shaped like AuthError so handler.js already knows how to answer
 * it: chatErrorKind is the stable tag that survives a module being loaded
 * twice, and status/code/message are what reach the browser.
 *
 * 401 rather than 403. The request is unauthenticated as far as app identity
 * goes, and a client that refreshes its App Check token and retries may well
 * succeed - which is what 401 means and 403 does not.
 */
class AppCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppCheckError';
    this.status = 401;
    this.code = code;
    this.chatErrorKind = 'app_check';
  }
}

/* The customer-facing sentence. Identical for every failure mode: the client
   cannot act differently on "missing" than on "expired" - in both cases it
   refreshes and retries - and one sentence gives an attacker nothing to
   probe with. The distinction that matters lives in the log, as a token. */
const REFUSED = 'This request could not be verified. Please reload the page and try again.';

/*
 * Read the token off the request.
 *
 * Returns the trimmed string, or null. Deliberately narrow: only this one
 * header is consulted. The Authorization header is NOT a fallback, and no
 * query parameter or body field is either - an App Check token and a Firebase
 * ID token are different credentials proving different things, and letting
 * one arrive in the other's channel is how they end up being confused for
 * each other.
 */
function readAppCheckToken(req) {
  const headers = (req && req.headers) || {};
  const raw = headers[APP_CHECK_HEADER_KEY];
  /* A repeated header arrives as an array. Two App Check tokens on one
     request is not something our client does; refuse rather than pick. */
  if (Array.isArray(raw)) return null;
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return token === '' ? null : token;
}

/*
 * A cheap structural check before spending a network call.
 *
 * An App Check token is a JWT: three base64url segments separated by dots.
 * This rejects obvious rubbish locally so a flood of malformed tokens cannot
 * be turned into a flood of outbound verification calls. It proves nothing
 * about validity - verifyToken() is the only thing that does that - it just
 * refuses input that could not possibly be a token.
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_CHARS = 4096;

function looksLikeToken(token) {
  return typeof token === 'string'
    && token.length > 0
    && token.length <= MAX_TOKEN_CHARS
    && JWT_SHAPE.test(token);
}

/*
 * Allow-listed outcome tokens. The same discipline the rest of this backend
 * uses: what reaches a log is chosen from a fixed list, never derived from
 * the request, the token or an error message.
 */
const OUTCOMES = [
  'absent',            /* no header, enforcement off  */
  'valid',             /* verified                    */
  'malformed',         /* not JWT-shaped              */
  'rejected',          /* the verifier refused it     */
  'unavailable',       /* no verifier to call         */
  'observe_failed'     /* observation threw, ignored  */
];

function safeOutcome(outcome) {
  return OUTCOMES.indexOf(outcome) === -1 ? 'rejected' : outcome;
}

/*
 * Verify - or, while enforcement is off, merely observe.
 *
 * options:
 *   req          the incoming request, for the header
 *   env          environment to read the switch from (tests inject one)
 *   verifyToken  async (token) => decoded, normally
 *                getAppCheck(app).verifyToken bound in handler.js
 *
 * Returns { enforced, outcome, appId } and throws AppCheckError only when
 * enforcement is on.
 *
 * FAIL CLOSED. With enforcement on, every path that is not a successful
 * verification throws: no token, a malformed token, a token the verifier
 * refused, and - importantly - no verifier at all. That last case is the one
 * worth stating out loud: if firebase-admin/app-check fails to load, the
 * verifier is null, and the choice is between letting every request through
 * unverified or refusing every request. It refuses. A chat outage is
 * recoverable; silently serving an unprotected API because a module failed to
 * import is not.
 *
 * FAIL OPEN, DELIBERATELY, WHILE ENFORCEMENT IS OFF. Nothing in the observe
 * path can reject a request or raise an error - the whole branch is wrapped -
 * because its only job is to answer "are real clients sending valid tokens
 * yet?" before anyone flips the switch.
 */
async function verifyAppCheck(options) {
  const opts = options || {};
  const enforced = isEnforced(opts.env);
  const token = readAppCheckToken(opts.req);
  const verify = typeof opts.verifyToken === 'function' ? opts.verifyToken : null;

  if (!enforced) {
    if (!token) return { enforced: false, outcome: 'absent', appId: null };
    if (!verify) return { enforced: false, outcome: 'unavailable', appId: null };
    if (!looksLikeToken(token)) return { enforced: false, outcome: 'malformed', appId: null };
    try {
      const decoded = await verify(token);
      return { enforced: false, outcome: 'valid', appId: appIdOf(decoded) };
    } catch (err) {
      /* Observation must never become an outage. */
      return { enforced: false, outcome: 'rejected', appId: null };
    }
  }

  if (!token) {
    throw new AppCheckError('app_check_required', REFUSED);
  }
  if (!looksLikeToken(token)) {
    throw new AppCheckError('app_check_invalid', REFUSED);
  }
  if (!verify) {
    /* No verifier and enforcement on: refuse. See the note above. */
    throw new AppCheckError('app_check_unavailable', REFUSED);
  }

  let decoded;
  try {
    decoded = await verify(token);
  } catch (err) {
    /* Every failure the verifier can produce - expired, wrong project,
       malformed signature, network - collapses to one refusal. The error is
       not attached, logged or rethrown: firebase-admin puts detail in
       message and cause, and neither belongs anywhere near a response. */
    throw new AppCheckError('app_check_invalid', REFUSED);
  }

  if (!decoded || typeof decoded !== 'object') {
    throw new AppCheckError('app_check_invalid', REFUSED);
  }

  return { enforced: true, outcome: 'valid', appId: appIdOf(decoded) };
}

/*
 * The Firebase App ID out of a verification result, or null.
 *
 * verifyToken() resolves to { appId, token: DecodedAppCheckToken }, and the
 * decoded token repeats it as app_id. Both shapes are accepted so an injected
 * test verifier can return either. The value is not used for authorisation -
 * it is only ever a log field - so a missing one is not an error.
 */
function appIdOf(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;
  if (typeof decoded.appId === 'string') return decoded.appId;
  const inner = decoded.token;
  if (inner && typeof inner === 'object' && typeof inner.app_id === 'string') {
    return inner.app_id;
  }
  return null;
}

module.exports = {
  APP_CHECK_HEADER, APP_CHECK_HEADER_KEY, ENFORCE_ENV, ENFORCE_TRUE,
  MAX_TOKEN_CHARS, OUTCOMES,
  AppCheckError, isEnforced, readAppCheckToken, looksLikeToken,
  safeOutcome, appIdOf, verifyAppCheck
};
