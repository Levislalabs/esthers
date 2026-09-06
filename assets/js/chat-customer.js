/* =========================================================================
 * Esther's - the customer half of chat: identity, transport and transcript.
 *
 * ####################################################################
 * ##                                                                ##
 * ##  PUBLIC CHAT IS OFF. CHAT_PUBLIC_ENABLED is false below, and   ##
 * ##  nothing in this file runs until something imports it. No page ##
 * ##  imports it. Ordinary visitors still see the mascot saying     ##
 * ##  "Online messaging coming soon."                               ##
 * ##                                                                ##
 * ##  It exists so the real flow can be reviewed, and exercised by  ##
 * ##  hand from DevTools on esthers.ca, before it is switched on.   ##
 * ##  See openChatForReview() at the foot of this file.             ##
 * ##                                                                ##
 * ####################################################################
 *
 * WHAT THIS FILE IS
 *
 * chat.js owns the widget: the mascot, the panel, dragging, focus, the CSS
 * classes. This file owns everything the widget cannot see - who the visitor
 * is, how a message reaches Esther's, and how a reply comes back. The two
 * meet at a small interface (the `ui` object, documented under THE UI
 * CONTRACT below) so that neither has to know how the other works, and so
 * every rule in here can be tested without a browser.
 *
 * THE SHAPE OF THE SYSTEM, AND WHY IT IS ASYMMETRIC
 *
 *   customer WRITE  ->  POST /api/chat/{start,send}  ->  Admin SDK -> Firestore
 *   customer READ   ->  onSnapshot() straight at Firestore, no server involved
 *
 * Writes go through the API because that is where authorisation, validation,
 * rate limiting and idempotency live, and because a browser must never be
 * able to write a transcript. Reads go direct because a realtime transcript
 * is what a chat IS, and polling an API for it would be slower, chattier and
 * worse in every way. The asymmetry is the design, not an inconsistency.
 *
 * The customer therefore CANNOT write to Firestore - firestore.rules denies
 * create, update and delete outright - and this file imports no Firestore
 * write function at all. That absence is asserted by test.
 *
 * INITIALISATION ORDER IS A SECURITY PROPERTY
 *
 *   1. App Check      attest that this is the real site
 *   2. Firebase app   the one shared instance, from chat-app-check.js
 *   3. anonymous auth prove who (well: which browser) is asking
 *   4. API + listener the actual work
 *
 * App Check comes first and the order is not negotiable. Firebase
 * Authentication App Check enforcement is OFF today and will be turned ON;
 * on that day, a signInAnonymously() issued before attestation is a request
 * Google refuses. Writing the order correctly now means that switch is a
 * console setting rather than a code change made under pressure.
 *
 * Plain ES module on the site's no-build architecture, and the same pinned
 * Firebase SDK version as chat-app-check.js - imported from it rather than
 * repeated, so the two can never drift apart.
 * ========================================================================= */

import {
  SDK_VERSION,
  getFirebaseApp,
  initAppCheck,
  authorizedFetch
} from './chat-app-check.js?v=2026-09-06.1';

/*
 * The three shops, for display and for a client-side sanity check only.
 *
 * The SERVER decides what a valid destination is - api/_chat/locations.js has
 * its own copy and validates every start against it, and does not import this
 * file or anything else a browser can reach. What this import buys is that the
 * selector, the "Sending to:" line and the ids that go on the wire all come
 * from one place instead of being retyped here.
 *
 * Same ?v= as the import above, and for the same measured reason: a query on
 * this module's own URL does not reach its specifiers.
 */
import * as LOC from './chat-locations.js?v=2026-09-06.1';

/*
 * The chat client version. THE SAME STRING as CHAT_CLIENT_VERSION in
 * chat.js and in chat-app-check.js, and the same string as the ?v= in the
 * import directly above. A test pins all four to each other.
 *
 * WHY THE IMPORT ABOVE CARRIES IT TOO, AND CANNOT JUST INHERIT IT.
 *
 * A query string on a module's own URL does NOT propagate to the specifiers
 * inside it: './chat-app-check.js' resolves against the importer's path and
 * drops the query, so a page loading chat-customer.js?v=NEW would fetch
 * chat-app-check.js with no version at all. Measured in Chromium, not
 * assumed: with a long-lived cache that produces a NEW transport running
 * against a STALE App Check module - a mixed graph, which is worse than
 * either build on its own because it has never been tested.
 *
 * A static import specifier has to be a literal, so the version is written
 * out rather than interpolated. That is the cost of the guarantee, and the
 * test is what keeps the copies honest.
 */
export const CHAT_CLIENT_VERSION = '2026-09-06.1';

/* -------------------------------------------------------------------------
 * THE ROLLOUT GATE
 *
 * False, and it must stay false until the launch checklist in
 * docs/CHAT_APP_CHECK.md is finished. While it is false:
 *
 *   - no Firebase Auth session is created
 *   - no reCAPTCHA challenge is issued
 *   - no request is made to /api/chat/*
 *   - no Firestore listener is opened
 *
 * A source constant on purpose. It cannot be flipped by a query string, a
 * cookie, a localStorage key or anything else a visitor can reach - turning
 * chat on is a commit, a review and a deploy, which is the correct weight for
 * the decision. connect() refuses when it is false; the ONLY other way in is
 * openChatForReview(), which a person has to type into a console.
 * ---------------------------------------------------------------------- */
export const CHAT_PUBLIC_ENABLED = false;

export function isPublicChatEnabled() {
  return CHAT_PUBLIC_ENABLED === true;
}

/* ------------------------------------------------------------------ SDK */

/* Same version as chat-app-check.js, taken FROM it. Two independently
   pinned copies of the Firebase SDK on one page is two copies of a large
   library and, worse, two incompatible ideas of what an app instance is. */
const SDK_AUTH = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-auth.js';
const SDK_FIRESTORE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-firestore.js';

/* ------------------------------------------------------------ constants */

const MESSAGES_COLLECTION = 'chatMessages';

/*
 * The transcript ceiling. It is not a nicety: firestore.rules REFUSES a
 * listener that supplies no limit, and refuses one above 200 -
 * maxMessageQuery() there. A query without .limit() is denied outright, so
 * this constant is load-bearing rather than defensive.
 */
const TRANSCRIPT_LIMIT = 200;

/*
 * DESCENDING, so limit(200) is a rolling window on the NEWEST two hundred
 * rather than a fixed view of the oldest two hundred. See subscribeTranscript()
 * for why that distinction is the difference between a working chat and one
 * that silently stops updating. Requires the (conversationId ASC, createdAt
 * DESC) composite index.
 */
const TRANSCRIPT_ORDER = 'desc';

const API_START = '/api/chat/start';
const API_SEND = '/api/chat/send';
const API_STATUS = '/api/chat/status';

/*
 * How often an OPEN conversation re-checks whether staff have closed it.
 *
 * Closing writes only to the conversation document, which no browser may read,
 * so the transcript listener cannot see it. This is the backstop that notices.
 *
 * SIXTY SECONDS, and the number is a judgement rather than a constraint. The
 * cost of being late is small - the customer sees "Connected" for up to a
 * minute after a close, and if they send in that window the API refuses them
 * and the UI corrects itself immediately, which is what happened before this
 * fix and was never wrong, only rude. The cost of being eager is a request per
 * customer per interval, forever, on a read that exists to notice something
 * that happens once. A minute is slow enough to be nearly free and quick
 * enough that nobody types a paragraph into a dead thread.
 *
 * The timer is the SECONDARY signal. The primary ones cost nothing: the
 * restore path checks before enabling anything, and the tab becoming visible
 * again checks immediately - which covers the common shape of "customer left
 * the tab, staff closed the thread, customer came back".
 */
const STATUS_POLL_MS = 60 * 1000;

/* Where a recovered conversation id is remembered. Per TAB, deliberately:
   see rememberConversation() for why this is sessionStorage and not
   localStorage, and for what is NOT stored here. */
const CONVERSATION_KEY = 'esthers.chat.conversation';

/*
 * The separator in the two server-side hashes, reproduced exactly.
 * service.js joins with a NUL because neither a uid nor a UUID can contain
 * one, which makes the concatenation unambiguous. Written as an escape so no
 * literal control character sits in this source file.
 */
const NUL = '\u0000';

/* ------------------------------------------------------- what a person reads
 *
 * EVERY customer-facing sentence is in this table, and the only way to
 * produce one is to look up an allow-listed code. The server's own `error`
 * string is deliberately NOT displayed, even though it is written for a
 * person: echoing a server-supplied string into the page is a habit that
 * works right up until the day some error path returns something it should
 * not have. Unknown code, unknown status, no response at all - they all land
 * on the same generic sentence.
 * ---------------------------------------------------------------------- */

const GENERIC = 'Something went wrong at our end. Please try again in a moment.';
const RELOAD = 'We could not verify this page. Please reload and try again.';
const EXPIRED = 'Your session has expired. Please reload the page.';
const OFFLINE = 'We could not reach us just now. Check your connection and try again.';
const BUSY = 'You have sent a lot of messages just now. Please wait a moment before sending another.';
const UNAVAILABLE = 'Messaging is unavailable right now. Please call us or use the Quote Request form.';

/*
 * A lookup that cannot be walked into the prototype chain.
 *
 * `code` comes off a JSON response, so it can be any string a server - or
 * anything pretending to be one - chooses to send. MESSAGES_BY_CODE[code]
 * with code = 'constructor' or 'toString' returns a FUNCTION, and that
 * function would have been handed to the UI as the sentence to display. The
 * table promises every customer-facing string is allow-listed; an own-property
 * check is what makes that true rather than nearly true.
 */
function messageForCode(code) {
  if (typeof code !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(MESSAGES_BY_CODE, code)) return null;
  const text = MESSAGES_BY_CODE[code];
  return typeof text === 'string' ? text : null;
}

const MESSAGES_BY_CODE = {
  /* App identity - the page could not prove it is ours. */
  app_check_required: RELOAD,
  app_check_invalid: RELOAD,
  app_check_unavailable: RELOAD,

  /* Session. */
  missing_authorization: EXPIRED,
  bad_authorization: EXPIRED,
  invalid_token: EXPIRED,
  not_a_customer: RELOAD,
  /* The visitor's own input. These are the only ones a person can act on,
     so they are the only ones that say anything specific. */
  invalid_name: 'Please give us a name we can use.',
  invalid_email: 'Please give us an email address we can reply to.',
  empty_message: 'Please type a message first.',
  invalid_message: 'That message contains characters we cannot send.',
  message_too_long: 'That message is too long. Please shorten it a little.',
  forbidden_field: GENERIC,
  invalid_client_message_id: GENERIC,
  invalid_conversation_id: 'We could not find that conversation. Please start a new one.',
  /* Routing. Actionable: the selector is right there, so say what to do. */
  invalid_location: 'Please choose which shop you would like to message.',

  /* Conversation state. */
  conversation_not_found: 'We could not find that conversation. Please start a new one.',
  conversation_closed: 'This conversation has been closed.',
  idempotency_conflict: GENERIC,

  /* Pace. */
  rate_limited: BUSY,

  /* Ours. */
  service_unavailable: GENERIC,
  server_error: GENERIC
};

/*
 * Turn a failure into { code, text, kind } and nothing else.
 *
 * `kind` is what the caller branches on; `text` is what a person reads.
 * Pure, so the whole table is testable without a network.
 */
export function describeFailure(failure) {
  const f = failure || {};
  const status = typeof f.status === 'number' ? f.status : 0;
  const code = typeof f.code === 'string' ? f.code : '';

  if (f.offline === true || status === 0) {
    return { code: 'offline', text: OFFLINE, kind: 'offline' };
  }
  if (status === 429) {
    return { code: 'rate_limited', text: BUSY, kind: 'rate_limited' };
  }
  if (code === 'conversation_closed') {
    return { code: code, text: messageForCode(code), kind: 'closed' };
  }
  if (code.indexOf('app_check') === 0) {
    return { code: code, text: RELOAD, kind: 'app_check' };
  }
  if (status === 401 || status === 403) {
    return {
      code: code || 'invalid_token',
      text: messageForCode(code) || EXPIRED,
      kind: 'auth'
    };
  }
  if (status === 400 || status === 404 || status === 409) {
    return {
      code: code || 'server_error',
      text: messageForCode(code) || GENERIC,
      kind: 'input'
    };
  }
  return { code: code || 'server_error', text: messageForCode(code) || GENERIC, kind: 'server' };
}

/* An API refusal, carrying only what describeFailure() is allowed to read. */
class ChatApiError extends Error {
  constructor(status, code, retryAfter) {
    super('chat api ' + status);
    this.name = 'ChatApiError';
    this.status = status;
    this.code = typeof code === 'string' ? code : '';
    this.retryAfter = typeof retryAfter === 'number' ? retryAfter : null;
  }
}

/* A request that never reached a server. Distinct from a 500: the visitor
   can usefully retry this one, and telling them so is the difference between
   "try again" and "we are broken". */
class ChatNetworkError extends Error {
  constructor() {
    super('chat network');
    this.name = 'ChatNetworkError';
    this.status = 0;
    this.offline = true;
  }
}

/* ------------------------------------------------------------ identifiers */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*
 * The idempotency key for one outbound message.
 *
 * randomUUID() where it exists, and a getRandomValues() version 4 otherwise -
 * randomUUID needs a secure context, and while esthers.ca is https, a module
 * that throws on an older browser instead of degrading is a module that
 * chooses to be broken. Both paths produce something validation.js accepts;
 * a test checks the fallback against the server's own regular expression.
 */
export function newClientMessageId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    const id = c.randomUUID();
    if (UUID_RE.test(id)) return id;
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;          /* version 4 */
    b[8] = (b[8] & 0x3f) | 0x80;          /* variant 10xx */
    const hex = [];
    for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-'
      + hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-'
      + hex.slice(10, 16).join('');
  }
  throw new Error('no source of randomness');
}

/*
 * The document id the server WILL give this message.
 *
 * service.js derives it as sha256(conversationId + NUL + clientMessageId)
 * truncated to 40 hex characters, and that is reproduced exactly here -
 * separator included, which is why NUL is a named constant rather than a
 * character typed twice in two files.
 *
 * It is what makes an optimistic echo safe: the message we put on screen the
 * instant Send is pressed carries the same id as the document the listener
 * delivers a moment later, so the merge in TranscriptStore replaces it rather
 * than showing the visitor their own sentence twice.
 *
 * Returns null when SubtleCrypto is unavailable. The caller then simply does
 * not echo, and the message appears when the listener delivers it - slower,
 * still correct, never duplicated.
 */
export async function deriveMessageId(conversationId, clientMessageId) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') return null;
  const encoded = new TextEncoder().encode(conversationId + NUL + clientMessageId);
  let digest;
  try {
    digest = await subtle.digest('SHA-256', encoded);
  } catch (err) {
    return null;
  }
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, 40);
}

/* ------------------------------------------------------- transcript store
 *
 * Pure, and separate from anything that draws. It holds the messages the
 * listener has delivered plus any still in flight, keyed by id, and answers
 * one question: what should be on screen, in what order?
 * ---------------------------------------------------------------------- */

export class TranscriptStore {
  constructor() {
    this.byId = new Map();
  }

  /*
   * Replace everything with what the listener just delivered.
   *
   * A Firestore snapshot is the WHOLE result set, not a delta, so replacing
   * is correct and is also what stops a duplicate: a message that arrives
   * twice in two snapshots is one entry in the map both times.
   *
   * Pending messages are carried across, minus any the snapshot now
   * contains - that is the optimistic echo being retired by the real thing.
   */
  applySnapshot(docs) {
    const pending = [];
    for (const m of this.byId.values()) if (m.pending) pending.push(m);
    this.byId = new Map();
    for (const doc of docs || []) {
      const m = normaliseMessage(doc);
      if (m) this.byId.set(m.id, m);
    }
    for (const p of pending) if (!this.byId.has(p.id)) this.byId.set(p.id, p);
    return this.list();
  }

  /* An optimistic echo. Same id the server will use, so it is replaced
     rather than joined by the delivered document. */
  addPending(message) {
    const m = normaliseMessage(message);
    if (!m || !m.id) return this.list();
    m.pending = true;
    this.byId.set(m.id, m);
    return this.list();
  }

  /* A send that failed for good. Take the echo back off the screen rather
     than leaving a message the visitor believes was delivered. */
  dropPending(id) {
    const m = this.byId.get(id);
    if (m && m.pending) this.byId.delete(id);
    return this.list();
  }

  hasPending() {
    for (const m of this.byId.values()) if (m.pending) return true;
    return false;
  }

  clear() {
    this.byId = new Map();
    return this.list();
  }

  /*
   * Deterministic order.
   *
   * createdAt first, then id as the tie-break. The tie-break is not
   * decoration: two messages written in the same millisecond would otherwise
   * swap places between renders, and a transcript that reorders itself while
   * you read it is worse than one that is slightly wrong.
   */
  list() {
    const all = Array.from(this.byId.values());
    all.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return all;
  }
}

/*
 * One message, reduced to the four things the transcript may contain.
 *
 * An ALLOW-LIST, not a copy. firestore.rules lets the customer read the
 * whole message document, and the schema promises it holds only
 * conversationId, createdAt, senderType and body - but a promise upstream is
 * not a reason to hand whatever arrives to the renderer. If a field is ever
 * added to that collection it stops here.
 *
 * A malformed document is dropped rather than rendered: null body, missing
 * senderType, a createdAt that is not a time. One bad row must not empty the
 * transcript.
 */
export function normaliseMessage(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const id = typeof doc.id === 'string' && doc.id ? doc.id : null;
  if (!id) return null;

  const data = doc.data && typeof doc.data === 'object' ? doc.data : doc;
  const body = typeof data.body === 'string' ? data.body : null;
  if (body === null) return null;

  const senderType = data.senderType === 'customer' || data.senderType === 'staff'
    || data.senderType === 'system'
    ? data.senderType
    : null;
  if (!senderType) return null;

  return {
    id: id,
    senderType: senderType,
    body: body,
    createdAt: toMillis(data.createdAt),
    pending: false
  };
}

/*
 * Firestore Timestamp, Date, or number, to milliseconds.
 *
 * 0 rather than null for anything unreadable, so sorting stays total. A
 * message with an unreadable time sorts to the top, which is visible and
 * therefore fixable; NaN would poison the comparator and shuffle the whole
 * transcript.
 */
export function toMillis(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  if (typeof value.toMillis === 'function') {
    const n = value.toMillis();
    return typeof n === 'number' && isFinite(n) ? n : 0;
  }
  if (value instanceof Date) {
    const n = value.getTime();
    return isFinite(n) ? n : 0;
  }
  if (typeof value.seconds === 'number') {
    const ns = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
    return value.seconds * 1000 + Math.floor(ns / 1e6);
  }
  return 0;
}

/* --------------------------------------------------------------- storage
 *
 * The conversation id, and NOTHING else.
 *
 * WHAT IS NEVER STORED: the Firebase ID token, the App Check token, the
 * visitor's name, their email, or any message. Tokens are short-lived
 * credentials that belong in memory; the rest is the transcript's business
 * and the transcript lives in Firestore.
 *
 * WHY sessionStorage. The conversation id is not a credential - ownership is
 * checked against the verified uid on every read and write, by the API and
 * again by firestore.rules - so this is convenience, not access. Per-tab is
 * the honest lifetime for that convenience: a reload keeps your thread, a
 * shared or public machine does not hand it to the next person.
 *
 * The stored record carries the uid it belongs to and is refused if that
 * does not match the session actually signed in. Firebase can hand a browser
 * a different anonymous uid - cleared storage, a new profile - and reusing
 * another uid's conversation id would produce a listener the rules deny and
 * a send the API 404s. Checking is cheaper than explaining.
 *
 * Every access is wrapped: private modes and blocked-storage settings throw
 * on read, not only on write.
 * ---------------------------------------------------------------------- */

export function rememberConversation(store, uid, conversationId) {
  if (!store || !uid || !conversationId) return false;
  try {
    store.setItem(CONVERSATION_KEY, JSON.stringify({ uid: uid, conversationId: conversationId }));
    return true;
  } catch (err) {
    return false;
  }
}

export function recallConversation(store, uid) {
  if (!store || !uid) return null;
  let raw;
  try {
    raw = store.getItem(CONVERSATION_KEY);
  } catch (err) {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.uid !== uid) return null;                       /* somebody else's */
  const id = parsed.conversationId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

export function forgetConversation(store) {
  if (!store) return;
  try {
    store.removeItem(CONVERSATION_KEY);
  } catch (err) {
    /* Nothing to do, and nothing worth telling anyone. */
  }
}

/* --------------------------------------------------------------- identity */

/*
 * The steps, in the order the comment at the top of this file insists on.
 * Broken out so a test can assert the order by observing the SDK, rather
 * than by reading the code and hoping.
 */
async function establishIdentity(deps) {
  /* 1. APP CHECK, FIRST, ALWAYS. */
  const appCheck = await deps.initAppCheck();
  if (!appCheck) {
    /*
     * Fail closed, and do it here rather than three calls later.
     *
     * App Check enforcement is already ON for /api/chat/*, so without a
     * token every write is going to be refused anyway. Stopping now means
     * we do not mint an anonymous Firebase account for a session that
     * cannot send anything - an account that would then sit in the project
     * forever, attached to nothing.
     */
    throw new ChatApiError(401, 'app_check_unavailable', null);
  }

  /* 2. THE SHARED APP. Memoised inside chat-app-check.js; this is the same
        instance App Check just attached itself to, never a second one. */
  const app = await deps.getFirebaseApp();
  if (!app) throw new ChatApiError(503, 'service_unavailable', null);

  /* 3. ANONYMOUS AUTH, IN THIS TAB ONLY. */
  const authMod = await deps.loadAuth();
  const auth = authMod.getAuth(app);
  await applySessionPersistence(authMod, auth);
  const user = await resolveUser(authMod, auth);
  if (!user || typeof user.uid !== 'string' || !user.uid) {
    throw new ChatApiError(401, 'invalid_token', null);
  }

  return { app: app, auth: auth, authMod: authMod, user: user };
}

/*
 * ONE FIREBASE USER PER TAB, NOT PER BROWSER.
 *
 * Firebase's web default is browserLocalPersistence: one signed-in user
 * shared by every tab on the origin, in localStorage. Esther's has TWO kinds
 * of user in one project - anonymous customers and Email/Password staff - and
 * the SDK allows exactly one signed-in user per app instance. Under the
 * default, a staff member signing into /staff/chat in one tab would replace
 * the anonymous customer in another tab, and a customer starting a chat would
 * sign the staff member out mid-reply.
 *
 * browserSessionPersistence puts the session in sessionStorage, which is
 * per-tab. Two tabs, two independent users, neither aware of the other - and
 * a reload of either tab still restores its own user, which is why this is
 * not inMemoryPersistence.
 *
 * NOT WRAPPED IN A TOLERANT try/catch, deliberately. If setPersistence()
 * rejects - blocked web storage, usually - the instance keeps the DEFAULT,
 * which is the shared-across-tabs behaviour this exists to remove. Silently
 * carrying on would restore the exact bug. Failing here surfaces as a chat
 * that will not start, which is honest and which the panel already handles.
 */
async function applySessionPersistence(authMod, auth) {
  if (!authMod || typeof authMod.setPersistence !== 'function'
      || !authMod.browserSessionPersistence) {
    throw new ChatApiError(503, 'service_unavailable', null);
  }
  await authMod.setPersistence(auth, authMod.browserSessionPersistence);
}

/*
 * The signed-in anonymous user, reusing one if there already is one.
 *
 * THE WAIT IS THE WHOLE POINT. auth.currentUser is null for a moment after
 * getAuth() even when this browser has a perfectly good persisted anonymous
 * session, because the SDK restores it asynchronously. Calling
 * signInAnonymously() during that moment does not fail - it succeeds, and
 * mints a SECOND anonymous account. The visitor loses their conversation
 * (the old uid owned it), Esther's inbox gains a stranger, and the project
 * accumulates an orphan account per reload. So: settle first, sign in only
 * if there is genuinely nobody there.
 */
async function resolveUser(authMod, auth) {
  let existing = auth.currentUser;
  if (!existing) existing = await settleAuthState(authMod, auth);

  /* An anonymous user in this tab is OUR user. Reuse it - that is what makes
     a reload keep the same uid, and the conversation it owns. */
  if (existing && existing.isAnonymous !== false) return existing;

  if (existing) {
    /*
     * A NON-ANONYMOUS user, in this tab.
     *
     * With per-tab persistence a staff session in ANOTHER tab is invisible
     * from here, so this is the same-tab case: somebody was on /staff/chat
     * and navigated this tab to a customer page. Replacing this tab's
     * identity is the right answer and costs the staff member nothing - the
     * dashboard tab, if they still have one, is untouched.
     *
     * Sign out FIRST. signInAnonymously() on top of a signed-in user is not
     * defined to replace it cleanly, and being explicit is cheap.
     */
    try {
      await authMod.signOut(auth);
    } catch (err) {
      /* Already gone, or the SDK refused. The sign-in below is what matters. */
    }
  }

  const credential = await authMod.signInAnonymously(auth);
  const user = (credential && credential.user) || auth.currentUser || null;
  if (!user || user.isAnonymous === false) {
    throw new ChatApiError(401, 'invalid_token', null);
  }
  return user;
}

/*
 * THE WAIT IS THE WHOLE POINT. auth.currentUser is null for a moment after
 * getAuth() even when this tab has a perfectly good session, because the SDK
 * restores it asynchronously. Signing in during that moment does not fail -
 * it succeeds, and mints a SECOND anonymous account. The visitor loses their
 * conversation (the old uid owned it), Esther's inbox gains a stranger, and
 * the project accumulates an orphan account per reload.
 */
function settleAuthState(authMod, auth) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      resolve(value || null);
    };
    try {
      unsubscribe = authMod.onAuthStateChanged(auth, (u) => finish(u), () => finish(null));
    } catch (err) {
      finish(null);
    }
  });
}

/* ------------------------------------------------------------------ API */

/*
 * One POST to the chat API, carrying BOTH credentials and keeping them apart.
 *
 *   Authorization: Bearer <Firebase ID token>   who
 *   X-Firebase-AppCheck: <App Check token>      what
 *
 * The App Check header is not set here at all - authorizedFetch() attaches
 * it. That is deliberate: there is exactly one place in this codebase that
 * knows how to obtain and attach an App Check token, and duplicating it here
 * is how the two would eventually disagree. The ID token is set here and
 * only here, and never goes anywhere near the App Check header.
 */
async function apiPost(deps, path, body, user) {
  return apiRequest(deps, 'POST', path, body, user);
}

/*
 * A GET, with the same two credentials and the same refusal handling.
 * Separate from apiPost only so a caller cannot accidentally send a body on a
 * GET, which some runtimes drop and others reject.
 */
async function apiGet(deps, path, user) {
  return apiRequest(deps, 'GET', path, null, user);
}

async function apiRequest(deps, method, path, body, user) {
  let idToken;
  try {
    /* No forceRefresh. The SDK already refreshes a token that is close to
       expiry; forcing it on every send is a network round trip per message
       to solve a problem the SDK does not have. */
    idToken = await user.getIdToken();
  } catch (err) {
    throw new ChatApiError(401, 'invalid_token', null);
  }
  if (typeof idToken !== 'string' || !idToken) {
    throw new ChatApiError(401, 'invalid_token', null);
  }

  let res;
  try {
    const init = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken
      }
    };
    /* No body on a GET. */
    if (body !== null && body !== undefined) init.body = JSON.stringify(body);
    res = await deps.authorizedFetch(path, init);
  } catch (err) {
    /* fetch() rejects for a dropped connection, DNS, CORS - never for a 4xx.
       So this branch is genuinely "the request did not happen". */
    throw new ChatNetworkError();
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }

  if (res.ok && payload && payload.ok === true) return payload;

  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  const retryAfter = payload && typeof payload.retryAfter === 'number'
    ? payload.retryAfter
    : null;
  throw new ChatApiError(res.status || 500, code, retryAfter);
}

/* ------------------------------------------------------------- listener */

/*
 * The transcript listener.
 *
 * THE QUERY IS EXACTLY WHAT THE RULES ALLOW, AND NO WIDER:
 *
 *   where('conversationId', '==', id)   confines it to one conversation
 *   orderBy('createdAt', 'desc')        NEWEST first - see below
 *   limit(200)                          MANDATORY - see below
 *
 * WHY DESCENDING, WHEN THE TRANSCRIPT READS OLDEST-FIRST.
 *
 * Because limit() applies to the ORDER, not to the display. Ascending with
 * limit(200) returns the two hundred OLDEST messages - so the moment a
 * conversation passes two hundred, the window stops moving: new messages fall
 * outside it and the customer's own sends simply never appear. A chat that
 * silently stops updating after a long conversation is worse than one that
 * never worked, because the visitor has no way to tell.
 *
 * Descending with the same limit is a ROLLING WINDOW on the newest two
 * hundred, which is what a live transcript wants. The documents arrive
 * newest-first and chronological() below turns them back the right way up.
 *
 * This is NOT pagination. There is no history beyond the newest two hundred
 * and no way to ask for more; that is a separate feature if it is ever wanted.
 *
 * Firestore evaluates a query against the documents it COULD return, not the
 * ones that happen to exist, so a listener that is not confined to one
 * conversation is refused outright rather than quietly narrowed. Dropping
 * the where clause does not leak the database; it produces permission-denied.
 *
 * The limit is not a nicety either. firestore.rules requires
 * request.query.limit to be non-null and <= 200, so a listener without one
 * is denied. A direct listener bypasses the API and therefore every rate
 * limit that lives there, which is exactly why the ceiling is in the rules
 * and not merely here.
 *
 * THIS QUERY NEEDS ITS OWN COMPOSITE INDEX: (conversationId ASC, createdAt
 * DESC), added to firestore.indexes.json alongside the existing ASC/ASC one.
 * conversationId is an equality filter so its direction stays ASCENDING;
 * createdAt has to be DESCENDING to serve a descending orderBy. The ASC/ASC
 * index is kept - the staff transcript endpoint in service.js still uses it.
 *
 * THE INDEX IS NOT DEPLOYED YET. Until it is, this listener will fail in
 * production with a failed-precondition error naming the missing index.
 * Deploying it is a step on the launch checklist, not something this change
 * performs.
 *
 * OWNERSHIP IS NOT CHECKED HERE, AND MUST NOT BE. The rules resolve it
 * server-side: ownsConversation() reads chatConversations/{id}.customerUid
 * and compares it to request.auth.uid. Nothing the browser sends can change
 * that answer, and a check in this file would be decoration - it would
 * reassure a reader while protecting nothing.
 */
function subscribeTranscript(fs, db, conversationId, handlers) {
  const q = fs.query(
    fs.collection(db, MESSAGES_COLLECTION),
    fs.where('conversationId', '==', conversationId),
    fs.orderBy('createdAt', TRANSCRIPT_ORDER),
    fs.limit(TRANSCRIPT_LIMIT)
  );
  return fs.onSnapshot(q, handlers.next, handlers.error);
}

/*
 * The snapshot's documents, oldest-first.
 *
 * The listener asks for the newest 200, so Firestore hands them back
 * newest-first. The transcript reads top-to-bottom oldest-to-newest, so they
 * are turned around here, at the one point where the query's order meets the
 * renderer's.
 *
 * IMMUTABLE. slice() first: snapshot.docs belongs to the SDK, and reversing it
 * in place would corrupt a structure Firestore may reuse.
 *
 * WORTH BEING HONEST ABOUT WHAT THIS DOES AND DOES NOT GUARANTEE.
 * TranscriptStore.list() sorts by (createdAt, id) on every render, so the
 * rendered order is already correct whatever order the documents arrive in -
 * removing this reversal would not currently change a single pixel. It is here
 * because the store's sort is the store's business: this function is the
 * contract at the boundary, it keeps the pipeline correct if that sort is ever
 * simplified away, and it means a reader of subscribeTranscript() does not have
 * to go and check what happens two files later.
 */
function chronological(docs) {
  return (Array.isArray(docs) ? docs : []).slice().reverse();
}

/* ------------------------------------------------------------ THE UI CONTRACT
 *
 * chat.js implements this; tests substitute a recorder. Every method is
 * optional - a caller that only wants the transport can pass {} - so a
 * missing one is a no-op rather than a crash halfway through a send.
 *
 *   showStartForm()               ask for name, email and first message
 *   showTranscript()              switch to the conversation view
 *   renderMessages(list)          [{id, senderType, body, createdAt, pending}]
 *   setStatus(text)               the line under the title in the header
 *   setNotice(text | null)        an inline sentence; null clears it
 *   setBusy(flag)                 a send is in flight
 *   setComposerEnabled(flag)      may the visitor type and send?
 *   setClosed(flag)               the conversation is finished
 *   setRetry(handler | null)      offer ONE user-triggered retry
 *   setLocations(choices)         [{id, label, choice, address, description}]
 *                                 the shops to offer, in order; drawn once
 *   setDestination(text | null)   the "Sending to:" line; null clears it
 *   onStart(handler)              handler({name, email, message, locationId})
 *   onSend(handler)               handler({message})
 *
 * Text only. Nothing in this file hands the UI markup, a node, or anything
 * but a string - chat.js renders every one of them with textContent, and the
 * contract being "strings" is what keeps that true.
 * ---------------------------------------------------------------------- */

function callUi(ui, method, arg) {
  if (!ui || typeof ui[method] !== 'function') return undefined;
  try {
    return ui[method](arg);
  } catch (err) {
    /* A broken renderer must not take the transport down with it. */
    return undefined;
  }
}

/* ------------------------------------------------------------- the session */

/*
 * One live customer chat. There is at most one per page, held in `current`
 * below, and starting another stops the first - which is what makes a
 * duplicate listener impossible rather than merely unlikely.
 */
class CustomerChatSession {
  constructor(ui, deps) {
    this.ui = ui;
    this.deps = deps;
    this.store = new TranscriptStore();
    this.identity = null;
    this.db = null;
    this.fs = null;
    this.conversationId = null;
    /*
     * Which shop this conversation is at, ALWAYS as told by the server -
     * never as remembered from what the visitor picked. Staff can move a
     * conversation to the other shop without anybody sending a message, so
     * the only honest source is the last /api/chat/start or /api/chat/status
     * answer. null means nobody has said yet, and the panel shows no
     * destination at all rather than guessing one.
     */
    this.locationId = null;
    this.unsubscribe = null;
    this.closed = false;
    this.stopped = false;
    this.sending = false;
    this.listenerFailed = false;
    /* The staff-close backstop. See STATUS_POLL_MS and watchStatus(). */
    this.statusTimer = null;
    this.statusChecking = false;
    this.statusErrorText = null;
    this.onVisibility = null;
    /*
     * Has the SERVER told us what this conversation is?
     *
     * Not "is it open" - `closed` answers that. This answers the prior
     * question of whether anybody has said. False means nothing has been
     * confirmed yet, and paintConversationState() refuses to draw a live
     * conversation on an unanswered question. See the comment there.
     */
    this.statusKnown = false;
  }

  /* ---------------------------------------------------------- lifecycle */

  async begin() {
    callUi(this.ui, 'setStatus', 'Connecting...');
    callUi(this.ui, 'setComposerEnabled', false);

    this.identity = await establishIdentity(this.deps);
    if (this.stopped) return this;

    this.fs = await this.deps.loadFirestore();
    if (this.stopped) return this;
    this.db = this.fs.getFirestore(this.identity.app);

    /* Wire the UI only once identity exists. A Send button that works before
       there is anyone to send as is a race with a confusing failure at the
       end of it. */
    callUi(this.ui, 'onStart', (fields) => this.start(fields));
    callUi(this.ui, 'onSend', (fields) => this.send(fields));

    /* The shops to choose from, in the order chat-locations.js lists them.
       Handed over once, before either view is shown, so the start form has
       them the first time it is drawn. */
    callUi(this.ui, 'setLocations', LOC.customerChoices());

    const recalled = this.deps.recallConversation(this.deps.storage(), this.identity.user.uid);
    if (recalled) {
      this.conversationId = recalled;
      /*
       * ASK THE SERVER WHAT THIS CONVERSATION ACTUALLY IS, BEFORE ANYTHING
       * ELSE IS ENABLED.
       *
       * THE BUG THIS FIXES. A restored conversation used to go straight to
       * openTranscript(), which says "Connected" and enables the composer. The
       * transcript listener only watches chatMessages, and closing a
       * conversation writes no message - so a thread staff had closed came back
       * after a reload looking completely live. The customer could type, press
       * Send, and only then be told. The backend refused correctly throughout;
       * the client was the thing telling the lie.
       *
       * The status call happens BEFORE openTranscript() rather than alongside
       * it, so there is no window in which the composer is enabled on a
       * conversation we have not confirmed.
       */
      const known = await this.refreshStatus({ initial: true });
      if (this.stopped) return this;
      if (known === 'gone') return this;      /* discarded; start form shown */
      this.openTranscript();
      /* AFTER openTranscript(), which switches views. refreshStatus() has
         already learned where this conversation is; this is what puts it on
         the screen, including when staff moved it while the tab was shut. */
      this.paintDestination();
      if (this.closed) {
        this.applyClosed();
      } else {
        /* The check did not land. openTranscript() has already left the
           composer shut - see paintConversationState() - so all that is left
           is to say why and offer a way to ask again. AFTER openTranscript(),
           which clears the notice. */
        if (known === 'unknown') this.holdUnconfirmed();
        this.watchStatus();
      }
    } else {
      callUi(this.ui, 'setStatus', 'Send us a message');
      callUi(this.ui, 'showStartForm');
    }
    return this;
  }

  /* -------------------------------------------------------- close watch */

  /*
   * Ask the server whether this conversation is still open.
   *
   * Returns 'open', 'closed', 'gone' (the server says it does not exist or is
   * not ours - the session discards it and offers a fresh start), or 'unknown'
   * when the question could not be answered.
   *
   * 'unknown' NEVER REOPENS A CLOSED CONVERSATION. A dropped request is not
   * evidence that staff reopened a thread - there is no reopen path in the API
   * at all - so a failed check leaves whatever we already knew in place. The
   * failure mode of a flaky network must not be a composer that comes back to
   * life on a dead conversation.
   */
  async refreshStatus(options) {
    const opts = options || {};
    if (this.stopped || !this.conversationId) return 'unknown';
    /* One in flight at a time. A visibility change during the interval tick
       must not produce two overlapping requests. */
    if (this.statusChecking) return 'unknown';
    this.statusChecking = true;
    this.statusErrorText = null;
    /* Captured before the await: whether the conversation was already
       confirmed decides whether a 'open' answer has anything to repaint. */
    const wasKnown = this.statusKnown;

    try {
      const payload = await apiGet(
        this.deps,
        API_STATUS + '?conversationId=' + encodeURIComponent(this.conversationId),
        this.identity.user);
      if (this.stopped) return 'unknown';

      /*
       * WHERE IT IS NOW. This is the only channel a transfer has to the
       * customer: moving a conversation writes no message, so the transcript
       * listener sees nothing at all. Recorded before the open/closed branch
       * so a conversation that was moved AND closed still says both.
       */
      this.applyLocation(payload.locationId);

      if (payload.status === 'closed') {
        this.statusKnown = true;
        if (!this.closed) {
          /* Learned WITHOUT the customer having to send anything. */
          this.applyClosed();
          this.stopStatusWatch();
        }
        return 'closed';
      }
      this.statusKnown = true;
      /* Only when this ANSWERS an open question - see applyOpen(). */
      if (!wasKnown && !this.closed && !this.listenerFailed) this.applyOpen();
      return 'open';
    } catch (err) {
      const described = describeFailure(err);
      /* The server says this conversation is not ours or no longer exists.
         Same treatment as a rules refusal: let it go and offer a fresh start,
         rather than leaving a dead id that fails identically forever. */
      if (described.code === 'conversation_not_found'
          || described.code === 'invalid_conversation_id') {
        this.discardConversation();
        return 'gone';
      }
      /*
       * Recorded, NOT painted here.
       *
       * openTranscript() clears the notice as part of switching to the
       * transcript view, and on the restore path it runs immediately after
       * this - so a notice set here was wiped a moment later and the visitor
       * was told nothing at all. begin() shows it once the view has settled.
       */
      this.statusErrorText = described.text;
      return 'unknown';
    } finally {
      this.statusChecking = false;
    }
  }

  /*
   * Ask again, because the visitor pressed Try again.
   *
   * ONE REQUEST PER PRESS. A button somebody has to push is not a retry loop,
   * and there is no timer behind this - the sixty-second watch is a separate
   * thing and keeps running underneath.
   *
   * Nothing is repainted optimistically on the way in. paintConversationState()
   * already left the panel saying it is not connected, which stays true for as
   * long as the question is unanswered; the retry button disappearing is what
   * tells the visitor the press registered.
   */
  async recheckStatus() {
    if (this.stopped || !this.conversationId) return 'unknown';
    if (!this.closed) {
      callUi(this.ui, 'setNotice', null);
      callUi(this.ui, 'setRetry', null);
    }
    const known = await this.refreshStatus({});
    if (this.stopped) return known;
    /* 'closed' and 'open' both repainted themselves on the way through
       refreshStatus(); 'gone' discarded the conversation. Only an unanswered
       question is left to report. */
    if (known === 'unknown' && !this.closed) this.holdUnconfirmed();
    return known;
  }

  /*
   * Nothing was confirmed. Say so, and leave a way out.
   *
   * The composer is already shut by paintConversationState() - this only adds
   * the explanation and the button, so a visitor is never looking at a dead
   * composer with no reason given and nothing to press.
   */
  holdUnconfirmed() {
    if (this.statusErrorText) callUi(this.ui, 'setNotice', this.statusErrorText);
    callUi(this.ui, 'setRetry', () => this.recheckStatus());
  }

  /*
   * Start noticing a staff-side close.
   *
   * Two signals, cheapest first:
   *
   *   VISIBILITY. Free, event-driven, and it covers the common shape - the
   *   customer switches tabs, staff close the thread, the customer comes back.
   *   No timer fires and nothing is polled to get this one.
   *
   *   A SLOW TIMER. The backstop for a customer who simply sits on the page.
   *   Sixty seconds; see STATUS_POLL_MS for why that number.
   *
   * Idempotent: calling it twice does not produce two timers or two listeners.
   * Never started on a conversation already known closed - closed is terminal,
   * there is no reopen path in the API, so there is nothing further to learn.
   */
  watchStatus() {
    if (this.stopped || this.closed || !this.conversationId) return false;
    this.stopStatusWatch();

    this.statusTimer = this.deps.setInterval(() => {
      if (this.stopped || this.closed) { this.stopStatusWatch(); return; }
      this.refreshStatus({});
    }, STATUS_POLL_MS);

    const doc = this.deps.document();
    if (doc && typeof doc.addEventListener === 'function') {
      this.onVisibility = () => {
        if (this.stopped || this.closed) return;
        if (doc.visibilityState === 'visible') this.refreshStatus({});
      };
      doc.addEventListener('visibilitychange', this.onVisibility);
    }
    return true;
  }

  /* Stop both signals. Safe to call twice, and called from every teardown
     path so a closed panel, a stopped session and a closed conversation all
     leave nothing running. */
  stopStatusWatch() {
    if (this.statusTimer !== null) {
      this.deps.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.onVisibility) {
      const doc = this.deps.document();
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', this.onVisibility);
      }
      this.onVisibility = null;
    }
  }

  /*
   * Tear down completely. Called when the panel closes, when the module is
   * disposed, and before anything that would otherwise open a second
   * listener. Safe to call twice.
   */
  stop() {
    this.stopped = true;
    this.stopTranscript();
    this.stopStatusWatch();
    this.store.clear();
    callUi(this.ui, 'setRetry', null);
  }

  /*
   * Stop listening, but stay alive.
   *
   * The panel closing is not the end of a conversation - it is the visitor
   * looking at something else for a minute. Tearing the whole session down
   * there was wrong twice over: it dropped the identity and conversation the
   * session had already established, and nothing re-established them, so the
   * next time the panel opened the composer looked fine and quietly discarded
   * every message typed into it.
   *
   * Suspending keeps the identity, the conversation and the transcript, and
   * stops only the thing that costs something while nobody is watching.
   */
  suspend() {
    if (this.stopped) return false;
    this.stopTranscript();
    /* Nobody is looking, so nothing needs noticing. The timer and the
       visibility listener both stop with the listener. */
    this.stopStatusWatch();
    return true;
  }

  resume() {
    if (this.stopped) return false;
    if (!this.conversationId) return true;
    this.openTranscript();
    /*
     * Reopening the panel is exactly when a stale "Connected" would be seen,
     * so check immediately rather than waiting up to a minute for the timer.
     * openTranscript() has already painted whatever was last confirmed -
     * including "Conversation closed", which it used to overwrite with
     * "Connected" - and recheckStatus() corrects it or explains why it could
     * not.
     */
    this.recheckStatus();
    this.watchStatus();
    return true;
  }

  stopTranscript() {
    if (typeof this.unsubscribe === 'function') {
      try {
        this.unsubscribe();
      } catch (err) {
        /* An SDK that throws on unsubscribe has already stopped. */
      }
    }
    this.unsubscribe = null;
  }

  /* ------------------------------------------------------------ reading */

  openTranscript() {
    /* Unconditionally, before every subscribe. Two listeners on one
       conversation is double the reads, double the renders, and a bug that
       only shows up after the fourth time somebody reopens the panel. */
    this.stopTranscript();
    if (this.stopped || !this.conversationId) return;

    this.listenerFailed = false;
    callUi(this.ui, 'showTranscript');
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setRetry', null);
    /* Before renderMessages(), which reads the widget's closed flag to decide
       whether the transcript carries the closed explanation. */
    this.paintConversationState();
    callUi(this.ui, 'renderMessages', this.store.list());

    this.unsubscribe = subscribeTranscript(this.fs, this.db, this.conversationId, {
      next: (snapshot) => this.onSnapshot(snapshot),
      error: (err) => this.onListenerError(err)
    });
  }

  onSnapshot(snapshot) {
    if (this.stopped) return;
    const docs = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [];
    /* Newest-first off the wire, oldest-first into the transcript. */
    const list = this.store.applySnapshot(chronological(docs).map(readDoc));
    callUi(this.ui, 'renderMessages', list);
  }

  /*
   * The listener stopped.
   *
   * onSnapshot's error callback means the subscription is DEAD, not
   * degraded, so there is nothing to wait for - the only question is
   * whether resubscribing could possibly help.
   *
   * permission-denied: no. The rules said no and they will say no again;
   * retrying is a loop that bills a read every time round. Stop, say so
   * plainly, offer no retry.
   *
   * anything else: maybe - a dropped connection, a token that expired
   * mid-listen. Offer the visitor a button. NOT a timer: an automatic
   * reconnect loop against a listener that is failing for a structural
   * reason is exactly the runaway this rule exists to prevent.
   */
  onListenerError(err) {
    if (this.stopped) return;
    this.stopTranscript();
    this.listenerFailed = true;

    const code = err && typeof err.code === 'string' ? err.code : '';
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      /*
       * The rules said no and will say no again, so there is nothing to
       * retry. But the stored id is now known-bad, and leaving it in place
       * would make every future load of this tab land right back here. Drop
       * it and offer a fresh start - which is a recovery the visitor can
       * actually perform, unlike "reload the page".
       */
      callUi(this.ui, 'setStatus', 'Not connected');
      callUi(this.ui, 'setNotice',
        'We could not load that conversation. You can start a new one below.');
      this.discardConversation();
      return;
    }

    callUi(this.ui, 'setStatus', 'Not connected');
    callUi(this.ui, 'setNotice', 'The connection dropped. New replies may not appear.');
    callUi(this.ui, 'setRetry', () => this.openTranscript());
  }

  /* ------------------------------------------------------------ writing */

  /*
   * Open a conversation.
   *
   * fields.clientMessageId, when present, is a RETRY of an attempt that
   * already minted one.
   *
   * THIS KEY DECIDES THE CONVERSATION'S IDENTITY, not just the message's.
   * startConversationId() in service.js is
   * sha256(domain + uid + clientMessageId), so a fresh key is a fresh
   * conversation - which is exactly what peekStart() exists to prevent. A
   * visitor whose response was lost, pressing Start again, would open a
   * SECOND conversation and appear twice in Esther's inbox as two different
   * enquiries. Reusing the key makes the retry land on the same document,
   * where the server recognises it.
   */
  async start(fields) {
    if (this.stopped || this.sending) return null;
    const input = fields || {};

    /*
     * NOTHING CHOSEN, NOTHING SENT.
     *
     * Only that one case is refused here. Whether a given id is a real shop
     * is the server's question - api/_chat/locations.js has the allow-list
     * and this file does not get a vote - and a client that is one deploy
     * behind must not refuse a destination the server has just added. What
     * this catches is the case no server round trip improves: the visitor
     * has not picked, so ask them to, immediately and without spending their
     * rate-limit allowance on a request that cannot succeed.
     *
     * NOT DEFAULTED. Choosing a shop on their behalf is exactly how a
     * curved-scupper job ends up at 1st Avenue.
     */
    if (typeof input.locationId !== 'string' || !input.locationId) {
      callUi(this.ui, 'setNotice', messageForCode('invalid_location'));
      callUi(this.ui, 'setRetry', null);
      return null;
    }

    this.sending = true;
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setBusy', true);

    const clientMessageId = (input && typeof input.clientMessageId === 'string'
      && input.clientMessageId)
      ? input.clientMessageId
      : this.deps.newClientMessageId();
    try {
      const payload = await apiPost(this.deps, API_START, {
        name: String(input.name == null ? '' : input.name),
        email: String(input.email == null ? '' : input.email),
        message: String(input.message == null ? '' : input.message),
        clientMessageId: clientMessageId,
        /*
         * Whatever the selector produced, unaltered. NOT normalised, NOT
         * defaulted to a shop here: the server's allow-list is the only
         * definition of a valid destination, and quietly substituting one
         * would send a curved-scupper job to the wrong shop rather than
         * showing the visitor the sentence that tells them to pick.
         */
        locationId: input.locationId
      }, this.identity.user);

      if (this.stopped) return null;
      this.conversationId = payload.conversationId;
      this.closed = payload.status === 'closed';
      /* From the response, not from input.locationId. A retried start lands
         on an existing conversation, and the server answers with where that
         conversation actually is - which may no longer be what was asked
         for. */
      this.applyLocation(payload.locationId);
      /* Straight from the response that created it: as confirmed as a status
         gets, and set BEFORE openTranscript() paints from it. */
      this.statusKnown = true;
      this.deps.rememberConversation(
        this.deps.storage(), this.identity.user.uid, this.conversationId);
      this.openTranscript();
      this.paintDestination();   /* after the view switch - see begin() */
      if (this.closed) this.applyClosed();
      else this.watchStatus();
      return payload;
    } catch (err) {
      /* The key travels with the retry, so pressing Try again re-attempts THIS
         conversation rather than opening another one. */
      this.reportFailure(err, {
        start: {
          name: input.name,
          email: input.email,
          message: input.message,
          /* The destination travels with the retry too. Dropping it here
             would turn Try again into a request the server refuses for a
             different reason than the one that failed. */
          locationId: input.locationId,
          clientMessageId: clientMessageId
        }
      });
      return null;
    } finally {
      this.sending = false;
      callUi(this.ui, 'setBusy', false);
    }
  }

  /*
   * Send one message.
   *
   * fields.clientMessageId, when present, is a RETRY of an attempt that
   * already minted one - see the note on the idempotency key below.
   */
  async send(fields) {
    if (this.stopped || this.sending) return null;
    if (!this.conversationId) return null;
    if (this.closed) {
      /* Already closed and the panel already says so. Do not add a banner
         repeating it - the composer is disabled, so this is a path only a
         programmatic caller reaches. */
      return null;
    }

    const body = String((fields && fields.message) == null ? '' : fields.message).trim();
    if (!body) {
      callUi(this.ui, 'setNotice', messageForCode('empty_message'));
      return null;
    }

    /*
     * THE IDEMPOTENCY KEY IS PER MESSAGE, NOT PER ATTEMPT.
     *
     * This is the whole point of having one. When a send times out or the
     * connection drops, the request may well have reached the server and been
     * stored - it is the RESPONSE that was lost. Retrying with a fresh key
     * makes that message a different message, and peekMessage() in service.js
     * never fires: the customer's sentence is written twice and Esther's reads
     * it twice.
     *
     * So a retry carries the key its first attempt minted, and the server
     * recognises it and returns the original result instead of appending.
     * Only a genuinely new message mints a new one.
     */
    const clientMessageId = (fields && typeof fields.clientMessageId === 'string'
      && fields.clientMessageId)
      ? fields.clientMessageId
      : this.deps.newClientMessageId();

    this.sending = true;
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setBusy', true);

    /*
     * EVERYTHING from here is inside try/finally, including deriving the echo
     * id. It was not, and that was a deadlock: newClientMessageId() throws on
     * a browser with no crypto, deriveMessageId() can reject, and the
     * stopped-check below returns early - each one left sending=true forever
     * and a composer that never re-enabled.
     */
    let echoId = null;
    try {
      echoId = await this.deps.deriveMessageId(this.conversationId, clientMessageId);
      if (this.stopped) return null;

      if (echoId) {
        callUi(this.ui, 'renderMessages', this.store.addPending({
          id: echoId,
          senderType: 'customer',
          body: body,
          createdAt: this.deps.now()
        }));
      }

      return await apiPost(this.deps, API_SEND, {
        conversationId: this.conversationId,
        message: body,
        clientMessageId: clientMessageId
      }, this.identity.user);
    } catch (err) {
      /* Take the echo back down. Leaving it would tell the visitor their
         message was sent when it was not, which is the one lie a chat must
         never tell. */
      if (echoId) callUi(this.ui, 'renderMessages', this.store.dropPending(echoId));
      /* The key travels with the retry, so pressing Try again re-sends THIS
         message rather than a copy of it. */
      this.reportFailure(err, { message: body, clientMessageId: clientMessageId });
      return null;
    } finally {
      this.sending = false;
      callUi(this.ui, 'setBusy', false);
    }
  }

  /* ------------------------------------------------------------ failures */

  /*
   * One place where a failure becomes something a person reads.
   *
   * NOTHING IS RETRIED AUTOMATICALLY, and 429 in particular is not. A retry
   * on rate_limited is by definition a request the server has just said is
   * too many; doing it on a timer turns one impatient visitor into a loop.
   * A retry is offered as a button - the visitor decides - and only for the
   * one kind where trying again could actually work.
   */
  reportFailure(err, retryContext) {
    const described = describeFailure(err);
    callUi(this.ui, 'setNotice', described.text);

    if (described.kind === 'closed') {
      this.applyClosed();
      return;
    }
    /*
     * The conversation is GONE, not merely unavailable: deleted, or an id this
     * uid does not own. Telling the visitor to "start a new one" while the
     * dead id stays in sessionStorage makes that impossible - every reload
     * recalls it and lands here again, and the tab is a permanent dead end.
     * Forget it, so the next load offers the start form.
     */
    if (described.code === 'conversation_not_found'
        || described.code === 'invalid_conversation_id') {
      this.discardConversation();
      return;
    }
    if (described.kind === 'auth' || described.kind === 'app_check') {
      /* Reloading is the fix, and this session cannot perform it. Stop
         rather than leave a composer that will fail on every press. */
      callUi(this.ui, 'setComposerEnabled', false);
      callUi(this.ui, 'setRetry', null);
      return;
    }
    if (described.kind === 'rate_limited') {
      /* Explicitly no retry handler. The wait is the point. */
      callUi(this.ui, 'setRetry', null);
      return;
    }
    if (described.kind === 'offline' && retryContext && retryContext.start) {
      /* Same key, so this re-attempts the conversation rather than opening a
         second one. */
      callUi(this.ui, 'setRetry', () => this.start(retryContext.start));
      return;
    }
    if (described.kind === 'offline' && retryContext && retryContext.message) {
      callUi(this.ui, 'setRetry', () => this.send({
        message: retryContext.message,
        /* The SAME key the failed attempt used. Without this the retry is a
           second message, not a second attempt at the first one. */
        clientMessageId: retryContext.clientMessageId
      }));
      return;
    }
    callUi(this.ui, 'setRetry', null);
  }

  /*
   * Let go of a conversation this session can no longer use, and offer a
   * fresh start rather than a dead transcript.
   */
  discardConversation() {
    this.stopTranscript();
    this.stopStatusWatch();
    this.conversationId = null;
    this.closed = false;
    /* Nothing is confirmed about a conversation this session no longer has. */
    this.statusKnown = false;
    /* Including where it was. Leaving "Sending to: Keith Street" above a
       blank start form would attach a destination to a conversation that no
       longer exists, and the visitor has not chosen one yet. */
    this.locationId = null;
    this.paintDestination();
    this.store.clear();
    this.deps.forgetConversation(this.deps.storage());
    callUi(this.ui, 'setRetry', null);
    callUi(this.ui, 'setStatus', 'Send us a message');
    callUi(this.ui, 'showStartForm');
  }

  /* ------------------------------------------------------------- routing */

  /*
   * Record what the server said about this conversation's shop, and repaint
   * only if it actually moved.
   *
   * NOT VALIDATED INTO A DEFAULT. An id the client does not recognise is
   * still recorded, because the server is the authority on what the shops
   * are and a client one deploy behind must not silently relabel a real
   * destination as "Not Sure". labelFor() decides what such an id READS as,
   * which is where an unknown value stops - it is never echoed to the screen.
   */
  applyLocation(locationId) {
    const next = typeof locationId === 'string' && locationId ? locationId : null;
    if (next === this.locationId) return false;
    this.locationId = next;
    this.paintDestination();
    return true;
  }

  /*
   * Put the destination on the screen, or take it off.
   *
   * A LABEL, NEVER AN ID. labelFor() maps the three known ids to their exact
   * names and everything else - including anything a hostile response might
   * carry - to 'Not Sure / Unassigned'. Nothing from the wire reaches the
   * panel as text, which is what keeps this line safe without the UI having
   * to sanitise it.
   */
  paintDestination() {
    callUi(this.ui, 'setDestination',
      this.locationId ? LOC.labelFor(this.locationId) : null);
  }

  applyClosed() {
    this.closed = true;
    this.statusKnown = true;
    /* Nothing left to learn: there is no reopen path in the API, so closed is
       terminal and the watch can stop for good. */
    this.stopStatusWatch();
    /*
     * ONE explanation, not two.
     *
     * This used to run straight after setNotice('This conversation has been
     * closed.') on the 409 path, and then setClosed() added its own, fuller
     * note - so the customer was told the same thing twice, once tersely in an
     * error banner and once properly in the transcript. The banner is cleared
     * here: the closed state is a state, not an error, and the panel says so
     * in one place.
     */
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setRetry', null);
    /* The transcript stays readable - the rules still permit reading a
       closed conversation's messages, and taking somebody's history away
       the moment it ends would be gratuitous. Only writing stops. */
    callUi(this.ui, 'setClosed', true);
    callUi(this.ui, 'setComposerEnabled', false);
    callUi(this.ui, 'setStatus', 'Conversation closed');
  }

  /*
   * The server confirmed the conversation is OPEN, and we did not know that a
   * moment ago.
   *
   * Only ever called on that transition. A routine sixty-second poll on a
   * conversation already known open has nothing to repaint, and repainting
   * anyway would clear a notice and a Try again that onListenerError() put up
   * for an entirely different problem.
   */
  applyOpen() {
    this.statusKnown = true;
    /* Closed is terminal. There is no reopen path in the API, so an 'open'
       answer on a conversation already known closed is not a state change -
       it is a bug somewhere else, and this is not the place to act on it. */
    if (this.closed) return;
    callUi(this.ui, 'setNotice', null);
    callUi(this.ui, 'setRetry', null);
    callUi(this.ui, 'setClosed', false);
    callUi(this.ui, 'setComposerEnabled', true);
    callUi(this.ui, 'setStatus', 'Connected');
  }

  /*
   * Draw the conversation from the only thing entitled to decide it: the last
   * definitive answer the SERVER gave.
   *
   * THE BUG THIS FIXES. openTranscript() used to say 'Connected' and enable
   * the composer unconditionally, and begin() only corrected that afterwards
   * IF the status check had come back. So a check that did not come back - a
   * 500, a 401 while attestation was being refused, a dropped connection, a
   * cold start that timed out - left the panel claiming a live conversation
   * on a thread staff had closed. The visitor typed, pressed Send, and only
   * then found out. That is precisely the lie /api/chat/status was added to
   * stop telling; it was simply being told one layer further up, on the path
   * where the endpoint had not answered.
   *
   * AN UNANSWERED QUESTION IS NOT A YES. Three states, and exactly one of
   * them opens the composer:
   *
   *   closed   terminal. The composer is dead and the transcript says why.
   *   open     confirmed. The ordinary live conversation.
   *   unknown  nothing was confirmed. The transcript stays readable, the
   *            composer stays shut, and holdUnconfirmed() supplies the reason
   *            and a Try again.
   *
   * Failing this way costs a visitor on a healthy conversation one press of a
   * button during an outage. Failing the other way costs a visitor on a closed
   * conversation a message they believe they sent.
   */
  paintConversationState() {
    if (this.closed) {
      callUi(this.ui, 'setClosed', true);
      callUi(this.ui, 'setComposerEnabled', false);
      callUi(this.ui, 'setStatus', 'Conversation closed');
      return;
    }
    if (!this.statusKnown) {
      callUi(this.ui, 'setComposerEnabled', false);
      callUi(this.ui, 'setStatus', 'Not connected');
      return;
    }
    callUi(this.ui, 'setComposerEnabled', true);
    callUi(this.ui, 'setStatus', 'Connected');
  }
}

/* Firestore hands back a QueryDocumentSnapshot; normaliseMessage() wants a
   plain { id, data }. Kept separate so the store can be tested with plain
   objects and never needs to know the SDK exists. */
function readDoc(doc) {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? doc.data() : doc.data;
  return { id: doc.id, data: data };
}

/* --------------------------------------------------------- the entry points */

let current = null;

/*
 * The default wiring. Every one of these is overridable, which is what lets
 * the whole session be tested without a network, a browser or a clock.
 */
function defaultDeps(overrides) {
  const d = {
    initAppCheck: initAppCheck,
    getFirebaseApp: getFirebaseApp,
    loadAuth: () => import(SDK_AUTH),
    loadFirestore: () => import(SDK_FIRESTORE),
    authorizedFetch: authorizedFetch,
    newClientMessageId: newClientMessageId,
    deriveMessageId: deriveMessageId,
    rememberConversation: rememberConversation,
    recallConversation: recallConversation,
    forgetConversation: forgetConversation,
    storage: () => {
      try {
        return globalThis.sessionStorage || null;
      } catch (err) {
        return null;      /* blocked-storage settings throw on ACCESS */
      }
    },
    /* Injectable so a test can drive the close watch without waiting a
       minute, and so a non-browser environment has no timers at all. */
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
    document: () => (typeof globalThis.document === 'undefined' ? null : globalThis.document),
    now: () => Date.now()
  };
  return Object.assign(d, overrides || {});
}

/*
 * Connect the customer chat.
 *
 * REFUSES WHILE THE GATE IS SHUT. This is the function ordinary page code
 * would call, and while CHAT_PUBLIC_ENABLED is false it returns null having
 * touched nothing: no auth, no attestation, no request, no listener. That
 * refusal is the gate - not a UI state, not a hidden panel, but the entry
 * point declining to do anything at all.
 */
export async function connect(ui, options) {
  if (!isPublicChatEnabled()) return null;
  return startSession(ui, options);
}

/*
 * The review harness. THE ONLY WAY IN WHILE THE GATE IS SHUT.
 *
 * Deliberately awkward to reach: it is an export of a module no page loads,
 * so using it means opening DevTools and typing an import. There is no query
 * parameter, no cookie, no storage key and no hidden control that reaches
 * it, and calling it changes nothing that outlives the page - reload and the
 * site is exactly as it was for everybody, including you.
 *
 *   const m = await import('/assets/js/chat-customer.js');
 *   const session = await m.openChatForReview();
 *
 * See docs/CHAT_CUSTOMER_FRONTEND.md for the full walkthrough.
 */
export async function openChatForReview(options) {
  const opts = options || {};
  const ui = opts.ui || resolvePageUi();
  if (!ui) {
    throw new Error(
      'No chat UI on this page. openChatForReview() needs the widget from ' +
      'chat.js, or an explicit { ui } to drive.');
  }
  if (typeof opts.openPanel === 'function') opts.openPanel();
  else openPageChatPanel();
  return startSession(ui, opts);
}

/* The widget's own driver, if chat.js is on the page. Reached through the
   documented namespace rather than by digging through the DOM, so the widget
   remains free to change how it is built. */
function resolvePageUi() {
  const CM = globalThis.CM;
  const chat = CM && CM.chat;
  return chat && typeof chat.transportSurface === 'function' ? chat.transportSurface() : null;
}

function openPageChatPanel() {
  const CM = globalThis.CM;
  const chat = CM && CM.chat;
  if (chat && typeof chat.open === 'function') chat.open();
}

async function startSession(ui, options) {
  /* At most one. Starting a second without stopping the first is how two
     listeners on one conversation happen. */
  if (current) {
    current.stop();
    current = null;
  }
  const session = new CustomerChatSession(ui, defaultDeps(options && options.deps));
  current = session;
  try {
    await session.begin();
  } catch (err) {
    const described = describeFailure(err);
    callUi(ui, 'setStatus', 'Not connected');
    callUi(ui, 'setNotice', described.kind === 'server' ? UNAVAILABLE : described.text);
    callUi(ui, 'setComposerEnabled', false);
    session.stop();
    if (current === session) current = null;
    return null;
  }
  return session;
}

/*
 * Stop listening while the panel is closed, and pick up again when it opens.
 *
 * This is what the widget calls, NOT disconnect(). A closed panel must not
 * hold a Firestore listener - it bills a read for every message arriving at a
 * widget nobody is looking at - but it must not lose the conversation either.
 */
export function suspend() {
  return current ? current.suspend() : false;
}

export function resume() {
  return current ? current.resume() : false;
}

/* Stop for good, and let the session go. A reviewer who is finished calls
   this; the panel closing does NOT - see suspend() above. */
export function disconnect() {
  if (!current) return false;
  current.stop();
  current = null;
  return true;
}

export function activeSession() {
  return current;
}

/* Tests need a clean module between cases. */
export function _reset() {
  if (current) current.stop();
  current = null;
}

/* Exported for the tests that prove the listener asks for exactly what the
   rules require, and for anyone reading firestore.rules alongside this. */
export const _internals = {
  MESSAGES_COLLECTION,
  TRANSCRIPT_LIMIT,
  TRANSCRIPT_ORDER,
  chronological,
  API_START,
  API_SEND,
  API_STATUS,
  STATUS_POLL_MS,
  CONVERSATION_KEY,
  MESSAGES_BY_CODE,
  NUL,
  subscribeTranscript,
  readDoc,
  CustomerChatSession,
  defaultDeps
};
