/*
 * Who is calling, proved rather than claimed.
 *
 * Identity comes from one place only: a Firebase ID token verified by the
 * Admin SDK. No endpoint ever accepts a uid, an email, a role or a
 * senderType from a request body. Those are claims; this file produces
 * facts.
 *
 * The verifier is injected so tests can exercise every branch without a real
 * Firebase project, real tokens or real staff passwords.
 */

'use strict';

const { tagStage } = require('./stages.js');

/* Roles the staff allow-list may currently carry. A role outside this set is
   refused rather than assumed harmless - adding 'agent' later is a
   deliberate edit here, not something a new Firestore value grants itself. */
const ALLOWED_STAFF_ROLES = ['admin'];

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;   /* 401 unauthenticated | 403 unauthorised */
    this.code = code;
    /* A stable marker the handler can recognise WITHOUT instanceof. If this
       module ever ends up loaded twice - two bundles, two module instances -
       instanceof silently stops matching and a well-formed 401 turns into a
       500 with no explanation. The tag survives that. */
    this.chatErrorKind = 'auth';
  }
}

/*
 * Strict Bearer parsing.
 *
 * Refuses a missing header, a wrong scheme, an empty token, and a header that
 * arrived more than once - a repeated Authorization header is ambiguous, and
 * guessing which one to honour is exactly the kind of leniency that turns
 * into a bypass.
 */
function parseBearer(headerValue) {
  if (Array.isArray(headerValue)) {
    throw new AuthError(401, 'bad_authorization', 'Sign-in is required.');
  }
  if (typeof headerValue !== 'string' || !headerValue) {
    throw new AuthError(401, 'missing_authorization', 'Sign-in is required.');
  }
  const parts = headerValue.split(' ');
  if (parts.length !== 2) {
    throw new AuthError(401, 'bad_authorization', 'Sign-in is required.');
  }
  if (parts[0] !== 'Bearer') {
    throw new AuthError(401, 'bad_authorization', 'Sign-in is required.');
  }
  const token = parts[1].trim();
  if (!token) {
    throw new AuthError(401, 'bad_authorization', 'Sign-in is required.');
  }
  return token;
}

/*
 * The sign-in provider, read from the shape the Admin SDK actually returns.
 * A decoded ID token carries firebase.sign_in_provider; the same string the
 * deployed Firestore rules test. Reading it in one place keeps the API and
 * the rules agreeing on what "a customer" means.
 */
function providerOf(decoded) {
  return decoded && decoded.firebase && typeof decoded.firebase.sign_in_provider === 'string'
    ? decoded.firebase.sign_in_provider
    : null;
}

/*
 * A customer: signed in, and signed in ANONYMOUSLY.
 *
 * Esther's staff hold real Email/Password accounts in the same Firebase
 * project. A check for "is authenticated" would hand them the customer
 * endpoints; this checks the provider, so a staff token is refused with 403
 * rather than quietly accepted.
 */
async function authenticateCustomer(verifyIdToken, authorizationHeader) {
  const token = parseBearer(authorizationHeader);
  const decoded = await verifyToken(verifyIdToken, token,
    'Your session has expired. Please reload the page.');

  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
    throw tagStage(
      new AuthError(401, 'invalid_token', 'Your session has expired. Please reload the page.'),
      'auth_customer_uid_missing');
  }

  const provider = providerOf(decoded);
  if (provider !== 'anonymous') {
    throw tagStage(
      new AuthError(403, 'not_a_customer', 'This endpoint is for website visitors.'),
      'auth_customer_provider_check_failed');
  }
  return { uid: decoded.uid, provider: provider };
}

/*
 * Firebase auth error codes that mean THE TOKEN IS BAD.
 *
 * Deliberately an allow-list. Everything on it is the caller's problem and
 * earns a 401; anything else is treated as OUR problem and becomes a 500.
 */
const CLIENT_TOKEN_ERROR_CODES = [
  'auth/argument-error',
  'auth/invalid-argument',
  'auth/invalid-id-token',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-credential',
  'auth/session-cookie-expired',
  'auth/session-cookie-revoked',
  'auth/user-disabled',
  'auth/user-not-found'
];

/*
 * Verify a token, and TELL A BAD TOKEN APART FROM A BROKEN VERIFIER.
 *
 * This used to catch everything and answer 401 "your session has expired".
 * That is right for an expired token and badly wrong for anything else: an
 * SDK fault, a network failure reaching Google's keys, or a programming
 * mistake such as auth.verifyIdToken not being a function all told the
 * customer to reload the page, logged nothing, and looked identical to
 * ordinary traffic. A real internal failure must not wear a 401.
 *
 * Both branches still refuse the request. Nothing is let through either way.
 */
async function verifyToken(verifyIdToken, token, expiredMessage) {
  try {
    return await verifyIdToken(token);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (CLIENT_TOKEN_ERROR_CODES.indexOf(code) !== -1) {
      throw tagStage(new AuthError(401, 'invalid_token', expiredMessage),
        'auth_token_verify_failed');
    }
    /* Unrecognised: the verifier itself failed. Fail closed, but honestly -
       a 500 the log can name, not a 401 that blames the visitor. The
       original error is rethrown so the handler classifies it; the stage is
       what says where it happened. */
    throw tagStage(err, 'auth_token_verify_internal_error');
  }
}

/*
 * A staff member: signed in, and present and active on the Firestore
 * allow-list.
 *
 * Authorisation is the staff/{uid} document and nothing else. Not the email
 * domain, not a claim in the token, not anything the browser sent. The
 * document is read with the Admin SDK, which bypasses Security Rules - which
 * is why the deployed rules can deny every browser read of that collection
 * without breaking this.
 */
async function authenticateStaff(verifyIdToken, db, authorizationHeader) {
  const token = parseBearer(authorizationHeader);

  const decoded = await verifyToken(verifyIdToken, token,
    'Your session has expired. Please sign in again.');

  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
    throw tagStage(
      new AuthError(401, 'invalid_token', 'Your session has expired. Please sign in again.'),
      'auth_customer_uid_missing');
  }

  /* An anonymous session is a customer, never staff, however the request was
     addressed. Checked before the lookup so a customer uid never becomes a
     staff document read. */
  if (providerOf(decoded) === 'anonymous') {
    throw new AuthError(403, 'not_staff', 'This account is not authorised.');
  }

  let snap;
  try {
    snap = await db.collection('staff').doc(decoded.uid).get();
  } catch (err) {
    /* Firestore failed while reading the allow-list. Not an authorisation
       decision - refusing here would look like "you are not staff". */
    throw tagStage(err, 'auth_staff_lookup_failed');
  }
  if (!snap.exists) {
    throw new AuthError(403, 'not_staff', 'This account is not authorised.');
  }
  const data = snap.data() || {};

  /* Strict true. A truthy string or a 1 is not an authorisation. */
  if (data.isActive !== true) {
    throw new AuthError(403, 'staff_inactive', 'This account is not authorised.');
  }
  if (ALLOWED_STAFF_ROLES.indexOf(data.role) === -1) {
    throw new AuthError(403, 'staff_role', 'This account is not authorised.');
  }

  return { uid: decoded.uid, role: data.role, displayName: data.displayName || null };
}

module.exports = {
  ALLOWED_STAFF_ROLES, CLIENT_TOKEN_ERROR_CODES, AuthError, verifyToken,
  parseBearer, providerOf, authenticateCustomer, authenticateStaff
};
