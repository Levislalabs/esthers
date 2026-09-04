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

  let decoded;
  try {
    decoded = await verifyIdToken(token);
  } catch (err) {
    throw new AuthError(401, 'invalid_token', 'Your session has expired. Please reload the page.');
  }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
    throw new AuthError(401, 'invalid_token', 'Your session has expired. Please reload the page.');
  }

  const provider = providerOf(decoded);
  if (provider !== 'anonymous') {
    throw new AuthError(403, 'not_a_customer', 'This endpoint is for website visitors.');
  }
  return { uid: decoded.uid, provider: provider };
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

  let decoded;
  try {
    decoded = await verifyIdToken(token);
  } catch (err) {
    throw new AuthError(401, 'invalid_token', 'Your session has expired. Please sign in again.');
  }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
    throw new AuthError(401, 'invalid_token', 'Your session has expired. Please sign in again.');
  }

  /* An anonymous session is a customer, never staff, however the request was
     addressed. Checked before the lookup so a customer uid never becomes a
     staff document read. */
  if (providerOf(decoded) === 'anonymous') {
    throw new AuthError(403, 'not_staff', 'This account is not authorised.');
  }

  const snap = await db.collection('staff').doc(decoded.uid).get();
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
  ALLOWED_STAFF_ROLES, AuthError,
  parseBearer, providerOf, authenticateCustomer, authenticateStaff
};
