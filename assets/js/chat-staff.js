/* =========================================================================
 * THE STAFF CHAT INBOX
 *
 * The internal tool that replaces the DevTools commands used to validate the
 * chat backend. It signs a staff member in, lists open conversations, opens
 * one, sends replies and closes threads.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE CUSTOMER TRANSPORT
 *
 * The customer reads their own transcript straight out of Firestore with
 * onSnapshot(), because firestore.rules can express "this anonymous uid owns
 * this conversation" precisely. Staff CANNOT, and deliberately so: a staff
 * member is allowed to read EVERY conversation, and the rule that would say
 * so ("is this uid in the staff collection, and active, and of an allowed
 * role") would hand the whole chatConversations collection - customerEmail,
 * staffNotifiedAt, startRequestHash and every field a later phase adds - to
 * any browser holding a staff session. So firestore.rules denies staff every
 * chat read, this module never touches Firestore, and everything goes through
 * /api/admin/chat/* where the server decides what to serialise.
 *
 * The consequence is that there is no live listener here, so the inbox polls.
 * See INBOX_POLL_MS for the one interval, and reconcileSelected() for why the
 * open transcript does not need one of its own.
 *
 * THE ORDER, WHICH IS THE SAME ORDER THE SERVER CHECKS IN
 *
 *   1. APP CHECK          is this our page?
 *   2. the shared app     the one instance chat-app-check.js memoises
 *   3. Firebase Auth      Email/Password, the staff account
 *   4. the staff API      is this account actually authorised staff?
 *   5. only then          the inbox appears
 *
 * Step 4 is not decoration. A valid Firebase sign-in proves somebody has an
 * account in this project; it does not prove they are staff. The backend
 * answers that from staff/{uid}.isActive and .role, and this module treats
 * the first successful API call as the authorisation - it never guesses from
 * an email address or a domain.
 *
 * WHAT IS NEVER STORED
 *
 * The password (it exists only as the value of an input, passed straight to
 * the SDK), the ID token, and the App Check token. None is written to
 * localStorage, sessionStorage, a cookie, a query string, a DOM attribute or
 * a log line. Firebase Auth keeps its own session in its own storage, which
 * is what makes a page refresh work - see restore() below.
 * ========================================================================= */

import {
  SDK_VERSION,
  getFirebaseApp,
  initAppCheck,
  authorizedFetch
} from './chat-app-check.js?v=2026-09-06.1';

/*
 * The three shops, for DISPLAY only.
 *
 * Which shops this account may see is decided by the server and arrives in
 * every inbox answer as `locations`. This module supplies the names to put
 * beside those ids, and nothing else: no filter drawn from it grants access,
 * and hiding a row here would be theatre - the row was never in the response.
 *
 * Same ?v= as the import above, for the same measured reason: a query on this
 * module's own URL does not reach its specifiers.
 */
import * as LOC from './chat-locations.js?v=2026-09-06.1';

/* The chat client version. THE SAME STRING as CHAT_CLIENT_VERSION in
   chat.js, chat-customer.js and chat-app-check.js, and the same string as the
   ?v= in the import above and in staff/chat/index.html. One version for the
   whole local chat graph; a test pins every copy to the others. */
export const CHAT_CLIENT_VERSION = '2026-09-06.1';

/* Pinned by path, exactly as the customer transport loads it. No cache-busting
   query: gstatic already serves an exact version per URL. */
const SDK_AUTH = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-auth.js';

/* -------------------------------------------------------------- the API */

const API_CONVERSATIONS = '/api/admin/chat/conversations';
const API_MESSAGES = '/api/admin/chat/messages';
const API_SEND = '/api/admin/chat/send';
const API_CLOSE = '/api/admin/chat/close';
const API_TRANSFER = '/api/admin/chat/transfer';

/* Server-side caps, repeated here only so the client never asks for more than
   the server will give and get a 400 for its trouble. */
const MAX_INBOX = 50;
const MAX_TRANSCRIPT = 200;
const MESSAGE_MAX = 2000;

/* ------------------------------------------------------------- polling */

/*
 * ONE TIMER, AND IT ONLY READS SUMMARIES.
 *
 * Neither GET spends a rate-limit allowance - conversations.js and
 * messages.js both carry needsRateSecret: false - so the constraint is
 * Firestore document reads.
 *
 * THE INBOX POLL, 15 s. One indexed query returning at most MAX_INBOX
 * conversation documents, and in practice the number of OPEN threads, which
 * for a sheet-metal shop is a handful. Only while the tab is visible.
 *
 * THERE IS NO THREAD TIMER. There used to be: every 8 seconds it re-read the
 * ENTIRE transcript, because /api/admin/chat/messages has no "since"
 * parameter and is all-or-nothing. A thirty-message thread left open cost
 * roughly 225 document reads a minute to discover, almost always, that
 * nothing had changed.
 *
 * It does not need a timer, because the inbox poll ALREADY carries the answer.
 * Every conversation in that response includes lastMessageAt and
 * messageCount, and service.js updates both in the SAME transaction that
 * writes a message - startConversation() sets them, sendCustomerMessage() and
 * sendStaffMessage() both bump them, and each returns early WITHOUT bumping
 * on an idempotent replay, so the count matches the stored messages exactly.
 * Those two fields plus status are therefore a reliable "did anything happen
 * to this conversation" signal, and the transcript is fetched only when they
 * move. See threadMarker and reconcileSelected() below.
 */
const INBOX_POLL_MS = 15 * 1000;

/*
 * Failure backoff. A poll that fails does not simply keep firing on schedule
 * into whatever is broken - the interval doubles per consecutive failure up
 * to the cap, and resets the moment a request succeeds. Without this, an
 * outage turns every open dashboard into a retry storm at exactly the moment
 * the service can least afford one.
 */
const MAX_BACKOFF_MS = 2 * 60 * 1000;

/* --------------------------------------------------------------- errors */

const GENERIC = 'Something went wrong. Please try again in a moment.';
const OFFLINE = 'We could not reach the server. Check your connection.';
const RELOAD = 'This page could not be verified. Please reload and try again.';
const SIGNED_OUT = 'Your session has ended. Please sign in again.';
const NOT_AUTHORISED = 'This account is not authorised for the staff inbox.';

/*
 * The sign-in message is deliberately ONE sentence for every failure the
 * Identity Platform can return - wrong password, no such user, malformed
 * address, a disabled account. Telling a stranger which of those it was turns
 * the form into an account-existence oracle.
 */
const SIGN_IN_FAILED = 'That email address and password did not match. '
  + 'Please check both and try again.';

const MESSAGES_BY_CODE = {
  not_staff: NOT_AUTHORISED,
  staff_inactive: NOT_AUTHORISED,
  staff_role: NOT_AUTHORISED,
  invalid_token: SIGNED_OUT,
  conversation_not_found: 'That conversation no longer exists.',
  conversation_closed: 'That conversation has been closed.',
  /* Routing. invalid_location is a bug in this page, not something a staff
     member can act on, so it says what they can do rather than what broke. */
  invalid_location: 'That shop could not be selected. Please reload and try again.',
  invalid_message: 'That message could not be sent. Check the length and try again.',
  rate_limited: 'That is a lot of messages at once. Please wait a moment.',
  cross_origin: RELOAD
};

class StaffApiError extends Error {
  constructor(status, code) {
    super('staff api ' + status);
    this.name = 'StaffApiError';
    this.status = status;
    this.code = typeof code === 'string' ? code : '';
  }
}

class StaffNetworkError extends Error {
  constructor() {
    super('network');
    this.name = 'StaffNetworkError';
  }
}

/*
 * Turn a thrown thing into something a person can read, plus a KIND the
 * caller can branch on. 'auth' is the one that matters: it means the server
 * has stopped believing this session, and the dashboard must stop showing
 * privileged data rather than leave it on screen behind a warning.
 */
export function describeFailure(err) {
  if (err instanceof StaffNetworkError) {
    return { code: 'network', text: OFFLINE, kind: 'offline' };
  }
  if (!(err instanceof StaffApiError)) {
    return { code: 'unexpected', text: GENERIC, kind: 'server' };
  }
  const code = err.code || '';
  const known = Object.prototype.hasOwnProperty.call(MESSAGES_BY_CODE, code)
    ? MESSAGES_BY_CODE[code]
    : null;

  if (code.indexOf('app_check') === 0) {
    return { code: code, text: RELOAD, kind: 'app_check' };
  }
  if (err.status === 401 || err.status === 403) {
    return { code: code || 'invalid_token', text: known || SIGNED_OUT, kind: 'auth' };
  }
  if (err.status === 429) {
    return { code: code || 'rate_limited', text: known || MESSAGES_BY_CODE.rate_limited,
      kind: 'input' };
  }
  if (err.status >= 400 && err.status < 500) {
    return { code: code || 'server_error', text: known || GENERIC, kind: 'input' };
  }
  return { code: code || 'server_error', text: known || GENERIC, kind: 'server' };
}

/* ------------------------------------------------------------ requests */

/*
 * TWO CREDENTIALS, TWO HEADERS, NEVER SWAPPED.
 *
 * Authorization carries the Firebase ID token and nothing else. The App Check
 * token is attached by authorizedFetch() in chat-app-check.js, under
 * X-Firebase-AppCheck, and this function never sees it - which is the point:
 * a header this code cannot read is a header this code cannot put in the
 * wrong place. The server refuses to read either one out of the other's
 * channel, and a test asserts the separation from the assembled request.
 */
async function apiRequest(deps, method, path, body, user) {
  let idToken;
  try {
    /* No forceRefresh: the SDK already refreshes a token near expiry, and
       forcing it on every poll is a network round trip per tick. */
    idToken = await user.getIdToken();
  } catch (err) {
    throw new StaffApiError(401, 'invalid_token');
  }
  if (typeof idToken !== 'string' || !idToken) {
    throw new StaffApiError(401, 'invalid_token');
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
    if (body !== null && body !== undefined) init.body = JSON.stringify(body);
    res = await deps.authorizedFetch(path, init);
  } catch (err) {
    /* fetch() rejects for a dropped connection, DNS or CORS - never for a
       4xx. So this branch is genuinely "the request did not happen". */
    throw new StaffNetworkError();
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }

  if (res.ok && payload && payload.ok === true) return payload;

  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  throw new StaffApiError(res.status || 500, code);
}

const apiGet = (deps, path, user) => apiRequest(deps, 'GET', path, null, user);
const apiPost = (deps, path, body, user) => apiRequest(deps, 'POST', path, body, user);

/* ---------------------------------------------------------- identifiers */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/*
 * The same generator the customer transport uses, and for the same reason:
 * validation.js on the server tests the value against exactly the regular
 * expression above, and randomUUID() needs a secure context that an older
 * browser may not provide. Both paths produce something the server accepts.
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

/* --------------------------------------------------------------- the ui */

/* A broken renderer must not take the dashboard down with it. */
function callUi(ui, method, arg, arg2) {
  if (!ui || typeof ui[method] !== 'function') return undefined;
  try {
    return ui[method](arg, arg2);
  } catch (err) {
    return undefined;
  }
}

/* ------------------------------------------------------- the dashboard */

export class StaffDashboard {
  constructor(ui, deps) {
    this.ui = ui;
    this.deps = deps;

    this.identity = null;         /* { app, auth, authMod, user } */
    this.staff = null;            /* set once the API has authorised us */
    this.stopped = false;

    this.filter = 'open';
    this.conversations = [];
    this.selectedId = null;
    this.thread = null;           /* { conversation, messages } */

    /*
     * The shops this account may see, exactly as the server last said.
     *
     * READ FROM THE ANSWER, NEVER DECIDED HERE. It arrives on every inbox
     * response and is used for one thing: knowing which filter chips to draw
     * and whether to draw any at all. Nothing in this file grants access, and
     * a conversation this account may not see was never in the list to hide.
     */
    this.locations = [];

    /*
     * A VIEW filter, and only a view filter.
     *
     * null is "all the shops I can see". Setting it hides rows that are
     * already on this page, in this tab, from somebody the server has already
     * decided may read them. It is a convenience for a manager watching both
     * shops at once, it is not a boundary, and it deliberately does not
     * travel to the server: /api/admin/chat/conversations takes no location
     * parameter, so there is no request shape in which a browser can ask for
     * a shop it is not entitled to.
     */
    this.locationFilter = null;

    this.transferring = false;

    /* One request of each kind in flight at a time. A poll tick that lands on
       top of a manual refresh is two requests for one answer. */
    this.inboxLoading = false;
    this.threadLoading = false;
    this.sending = false;
    this.closing = false;

    this.inboxTimer = null;
    this.onVisibility = null;

    /*
     * What the summary looked like when the transcript was last read:
     * { conversationId, lastMessageAt, messageCount, status }.
     *
     * The exact normalised primitives the backend returned - numbers and a
     * string, never a formatted date. lastMessageAt is 0 rather than null
     * when absent, which is a stable value to compare, and timestamps are NOT
     * assumed unique: this is a change detector, not a cursor.
     */
    this.threadMarker = null;

    this.inboxFailures = 0;
    this.threadFailures = 0;
  }

  /* ------------------------------------------------------- lifecycle */

  /*
   * Bring the page up. App Check FIRST, always - before any account exists,
   * before any token is minted, and before a single API call.
   */
  async begin() {
    callUi(this.ui, 'setPhase', 'starting');

    const appCheck = await this.deps.initAppCheck();
    if (this.stopped) return this;
    if (!appCheck) {
      /* Fail closed and say so. Every staff endpoint enforces App Check, so
         without a token nothing here can work; letting somebody type a
         password into a form that cannot possibly succeed is worse than
         saying no. */
      callUi(this.ui, 'setPhase', 'signed-out');
      callUi(this.ui, 'setAuthError', RELOAD);
      return this;
    }

    const app = await this.deps.getFirebaseApp();
    if (this.stopped) return this;
    if (!app) {
      callUi(this.ui, 'setPhase', 'signed-out');
      callUi(this.ui, 'setAuthError', GENERIC);
      return this;
    }

    const authMod = await this.deps.loadAuth();
    if (this.stopped) return this;
    const auth = authMod.getAuth(app);

    /*
     * ONE FIREBASE USER PER TAB, NOT PER BROWSER - and set BEFORE anything
     * signs in or is restored.
     *
     * Firebase's web default is browserLocalPersistence: one signed-in user
     * shared by every tab on the origin. This project has two kinds of user -
     * anonymous customers and Email/Password staff - and the SDK allows one
     * signed-in user per app instance, so under the default a staff sign-in
     * here would replace a customer's anonymous session in another tab, and a
     * customer starting a chat would sign the staff member out mid-reply.
     *
     * browserSessionPersistence puts the session in sessionStorage, which is
     * per-tab: two tabs, two independent users. A reload of THIS tab still
     * restores THIS staff session, which is why it is not inMemoryPersistence.
     *
     * A rejection is fatal on purpose. If setPersistence() fails the instance
     * keeps the default, which is the cross-tab bleed this removes - and a
     * staff token in shared storage is the worse half of that. Better a sign-in
     * screen that says so than an isolation guarantee that quietly is not one.
     */
    try {
      if (typeof authMod.setPersistence !== 'function'
          || !authMod.browserSessionPersistence) {
        throw new Error('persistence unavailable');
      }
      await authMod.setPersistence(auth, authMod.browserSessionPersistence);
    } catch (err) {
      if (this.stopped) return this;
      callUi(this.ui, 'setPhase', 'signed-out');
      callUi(this.ui, 'setAuthError', GENERIC);
      return this;
    }
    if (this.stopped) return this;

    this.identity = { app: app, auth: auth, authMod: authMod, user: null };

    callUi(this.ui, 'onSignIn', (fields) => this.signIn(fields));
    callUi(this.ui, 'onSignOut', () => this.signOut());
    callUi(this.ui, 'onSelect', (id) => this.select(id));
    callUi(this.ui, 'onFilter', (value) => this.setFilter(value));
    callUi(this.ui, 'onLocationFilter', (value) => this.setLocationFilter(value));
    callUi(this.ui, 'onTransfer', () => this.requestTransfer());
    callUi(this.ui, 'onRefresh', () => this.refreshAll());
    callUi(this.ui, 'onSend', (fields) => this.send(fields));
    callUi(this.ui, 'onClose', () => this.requestClose());
    callUi(this.ui, 'onBack', () => this.select(null));

    await this.restore();
    return this;
  }

  /*
   * A page refresh with a live Firebase session.
   *
   * The SDK restores an existing session asynchronously, so currentUser is
   * routinely null for a moment after getAuth() even when the browser has a
   * perfectly good one. Reading it directly here would show the sign-in form
   * to somebody who is already signed in, every single refresh.
   */
  async restore() {
    callUi(this.ui, 'setPhase', 'checking');
    let user = null;
    try {
      user = await this.deps.currentUser(this.identity.authMod, this.identity.auth);
    } catch (err) {
      user = null;
    }
    if (this.stopped) return false;

    if (!user) {
      callUi(this.ui, 'setPhase', 'signed-out');
      return false;
    }

    /*
     * AN ANONYMOUS USER IS A CUSTOMER, IN THIS TAB.
     *
     * Per-tab persistence means another tab's customer cannot appear here, so
     * this is the same-tab case: somebody used the chat panel on the website
     * and then navigated THIS tab to /staff/chat. That anonymous identity has
     * no business being offered to the staff API - the server would refuse it
     * 403 not_staff, correctly, but asking is pointless and the answer would
     * read like "your staff account is not authorised", which is a lie.
     *
     * Let it go and show the sign-in form. Signing in as staff below will
     * replace this tab's identity, which is the intended transition.
     */
    if (user.isAnonymous === true) {
      try {
        await this.identity.authMod.signOut(this.identity.auth);
      } catch (err) {
        /* Already gone. The phase below is what matters. */
      }
      this.identity.user = null;
      callUi(this.ui, 'setPhase', 'signed-out');
      return false;
    }

    return this.authorise(user);
  }

  /*
   * Sign in with an email address and a password.
   *
   * The password is handed straight to the SDK and never stored, echoed,
   * logged, or kept on this object. The only place it exists is the value of
   * the input the visitor typed it into, which the UI clears afterwards.
   */
  async signIn(fields) {
    if (this.stopped || !this.identity) return false;
    const email = String((fields && fields.email) || '').trim();
    const password = String((fields && fields.password) || '');
    if (!email || !password) {
      callUi(this.ui, 'setAuthError', 'Enter your email address and password.');
      return false;
    }

    callUi(this.ui, 'setAuthBusy', true);
    callUi(this.ui, 'setAuthError', null);
    try {
      const credential = await this.identity.authMod.signInWithEmailAndPassword(
        this.identity.auth, email, password);
      if (this.stopped) return false;
      const user = credential && credential.user ? credential.user : null;
      if (!user) {
        callUi(this.ui, 'setAuthError', SIGN_IN_FAILED);
        return false;
      }
      return await this.authorise(user);
    } catch (err) {
      /* ONE message for every sign-in failure. See SIGN_IN_FAILED. */
      callUi(this.ui, 'setAuthError', SIGN_IN_FAILED);
      return false;
    } finally {
      callUi(this.ui, 'setAuthBusy', false);
      callUi(this.ui, 'clearPassword');
    }
  }

  /*
   * A Firebase account is not a staff account.
   *
   * The only thing that decides this is the backend, and the way it decides
   * is by answering - or refusing - a real staff request. So the first inbox
   * load IS the authorisation check: a 403 here means not staff, inactive, or
   * the wrong role, and the dashboard never appears.
   */
  async authorise(user) {
    this.identity.user = user;
    callUi(this.ui, 'setPhase', 'checking');

    let payload;
    try {
      payload = await apiGet(this.deps,
        API_CONVERSATIONS + '?status=' + encodeURIComponent(this.filter)
          + '&limit=' + MAX_INBOX,
        user);
    } catch (err) {
      if (this.stopped) return false;
      const described = describeFailure(err);
      /* Not staff, inactive, wrong role, or a session the server no longer
         accepts - all of it ends the same way: signed out, with nothing
         privileged left on the page. */
      if (described.kind === 'auth') {
        await this.denyAccess(described.text);
        return false;
      }
      callUi(this.ui, 'setPhase', 'signed-out');
      callUi(this.ui, 'setAuthError', described.text);
      return false;
    }
    if (this.stopped) return false;

    this.staff = { email: user.email || null, uid: user.uid || null };
    this.applyInbox(payload);
    callUi(this.ui, 'setStaff', { email: this.staff.email });
    callUi(this.ui, 'setPhase', 'ready');
    this.watch();
    return true;
  }

  /*
   * The server said no, mid-session.
   *
   * Everything privileged comes off the screen first, then Firebase Auth is
   * signed out, then the form comes back with a reason. In that order: a
   * revoked session must not leave a customer's name and email sitting on a
   * shop monitor behind a warning banner.
   */
  async denyAccess(text) {
    this.clearPrivilegedState();
    try {
      if (this.identity && this.identity.authMod && this.identity.auth) {
        await this.identity.authMod.signOut(this.identity.auth);
      }
    } catch (err) {
      /* Already gone, or the SDK refused. The UI state above is what
         protects the data; this is tidying. */
    }
    if (this.identity) this.identity.user = null;
    callUi(this.ui, 'setPhase', 'signed-out');
    callUi(this.ui, 'setAuthError', text || SIGNED_OUT);
  }

  /* Timers off, data gone, UI blanked. Called from every exit. */
  clearPrivilegedState() {
    this.stopWatch();
    this.staff = null;
    this.conversations = [];
    this.selectedId = null;
    this.thread = null;
    this.threadMarker = null;
    /*
     * WHICH SHOPS THIS ACCOUNT COULD SEE IS PRIVILEGED TOO. Leaving the
     * filter chips up after a sign-out would tell whoever walks up to the
     * screen next that the person before them handled both shops - and the
     * next account to sign in would inherit somebody else's filter.
     */
    this.locations = [];
    this.locationFilter = null;
    this.transferring = false;
    this.inboxFailures = 0;
    this.threadFailures = 0;
    this.inboxLoading = false;
    this.threadLoading = false;
    this.sending = false;
    this.closing = false;
    callUi(this.ui, 'setStaff', null);
    callUi(this.ui, 'setLocationFilters', []);
    callUi(this.ui, 'setLocationFilter', null);
    callUi(this.ui, 'renderInbox', []);
    callUi(this.ui, 'renderThread', null);
    callUi(this.ui, 'setSelected', null);
    callUi(this.ui, 'setNotice', null);
  }

  async signOut() {
    this.clearPrivilegedState();
    try {
      if (this.identity && this.identity.authMod && this.identity.auth) {
        await this.identity.authMod.signOut(this.identity.auth);
      }
    } catch (err) {
      /* Nothing useful to say, and the state is already cleared. */
    }
    if (this.identity) this.identity.user = null;
    callUi(this.ui, 'setPhase', 'signed-out');
    callUi(this.ui, 'setAuthError', null);
    return true;
  }

  /* Tear down completely - the page is going away. */
  stop() {
    this.stopped = true;
    this.stopWatch();
    return true;
  }

  /* ---------------------------------------------------------- polling */

  /*
   * Two timers and a visibility hook.
   *
   * Idempotent: it clears before it arms, so calling it twice cannot leave
   * two intervals or two listeners behind.
   */
  watch() {
    if (this.stopped || !this.staff) return false;
    this.stopWatch();

    this.inboxTimer = this.deps.setInterval(() => {
      if (this.stopped || !this.staff) { this.stopWatch(); return; }
      if (this.isHidden()) return;          /* nobody is looking */
      /* The ONLY timer. The open thread rides on this one's answer - see
         reconcileSelected(). */
      this.loadInbox({ silent: true });
    }, INBOX_POLL_MS);

    const doc = this.deps.document();
    if (doc && typeof doc.addEventListener === 'function') {
      this.onVisibility = () => {
        if (this.stopped || !this.staff) return;
        if (this.isHidden()) return;
        /* Back from a hidden tab: catch up at once rather than waiting out
           the remainder of an interval that did nothing while away. The
           transcript follows only if the summary moved while we were away. */
        this.loadInbox({ silent: true });
      };
      doc.addEventListener('visibilitychange', this.onVisibility);
    }
    return true;
  }

  stopWatch() {
    if (this.inboxTimer !== null) {
      this.deps.clearInterval(this.inboxTimer);
      this.inboxTimer = null;
    }
    if (this.onVisibility) {
      const doc = this.deps.document();
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', this.onVisibility);
      }
      this.onVisibility = null;
    }
  }

  isHidden() {
    const doc = this.deps.document();
    return !!(doc && doc.hidden === true);
  }

  /* A poll that keeps failing backs off; one that succeeds resets. */
  shouldSkip(kind) {
    const failures = kind === 'inbox' ? this.inboxFailures : this.threadFailures;
    if (failures === 0) return false;
    const base = INBOX_POLL_MS;
    const wait = Math.min(base * Math.pow(2, failures), MAX_BACKOFF_MS);
    const last = kind === 'inbox' ? this.inboxFailedAt : this.threadFailedAt;
    return typeof last === 'number' && (this.deps.now() - last) < wait;
  }

  noteFailure(kind) {
    if (kind === 'inbox') {
      this.inboxFailures += 1;
      this.inboxFailedAt = this.deps.now();
    } else {
      this.threadFailures += 1;
      this.threadFailedAt = this.deps.now();
    }
  }

  noteSuccess(kind) {
    if (kind === 'inbox') { this.inboxFailures = 0; this.inboxFailedAt = null; }
    else { this.threadFailures = 0; this.threadFailedAt = null; }
  }

  /* ------------------------------------------------------------ inbox */

  async loadInbox(options) {
    const opts = options || {};
    if (this.stopped || !this.staff) return false;
    if (this.inboxLoading) return false;              /* one at a time */
    if (opts.silent && this.shouldSkip('inbox')) return false;

    const wantedFilter = this.filter;
    this.inboxLoading = true;
    if (!opts.silent) callUi(this.ui, 'setInboxBusy', true);
    try {
      const payload = await apiGet(this.deps,
        API_CONVERSATIONS + '?status=' + encodeURIComponent(wantedFilter)
          + '&limit=' + MAX_INBOX,
        this.identity.user);
      if (this.stopped) return false;
      /* The filter changed while this was in flight, so this answer is the
         wrong list. Same shape as the thread hand-off below: discard it and
         run the one that was actually asked for. */
      if (this.filter !== wantedFilter) {
        this.inboxLoading = false;
        return this.loadInbox(opts);
      }
      this.noteSuccess('inbox');
      this.applyInbox(payload);
      if (!opts.silent) callUi(this.ui, 'setNotice', null);
      return true;
    } catch (err) {
      if (this.stopped) return false;
      this.noteFailure('inbox');
      return await this.reportFailure(err, opts);
    } finally {
      this.inboxLoading = false;
      if (!opts.silent) callUi(this.ui, 'setInboxBusy', false);
    }
  }

  applyInbox(payload) {
    const list = payload && Array.isArray(payload.conversations)
      ? payload.conversations
      : [];
    /*
     * THE WHOLE AUTHORISED LIST IS KEPT, and the view filter is applied only
     * on the way to the screen.
     *
     * Filtering this array instead would make a conversation the manager has
     * merely filtered out look ABSENT to reconcileSelected(), which treats
     * absence as a change and would re-read its transcript on every tick.
     * The change detector must see what the server sent, not what is being
     * shown.
     */
    this.conversations = list.map(normaliseConversation).filter(Boolean);
    this.applyLocations(payload && payload.locations);
    callUi(this.ui, 'renderInbox', this.visibleConversations());
    callUi(this.ui, 'setSelected', this.selectedId);
    this.reconcileSelected();
  }

  /* ------------------------------------------------------------ shops */

  /*
   * Which shops this account may see, from the server's own answer.
   *
   * The chips are drawn only when there is a choice to make: one shop is not
   * a filter, it is the whole inbox, and a row of one button that changes
   * nothing is noise on a shop monitor. A stale filter for a shop that is no
   * longer in the set is dropped rather than left selected and empty.
   */
  applyLocations(raw) {
    const next = Array.isArray(raw)
      ? raw.filter((id) => typeof id === 'string' && id)
      : [];
    const changed = next.length !== this.locations.length
      || next.some((id, i) => id !== this.locations[i]);
    this.locations = next;

    if (this.locationFilter && next.indexOf(this.locationFilter) === -1) {
      this.locationFilter = null;
      callUi(this.ui, 'setLocationFilter', null);
    }
    if (!changed) return false;

    callUi(this.ui, 'setLocationFilters', next.length > 1
      ? next.map((id) => ({ id: id, label: LOC.labelFor(id) }))
      : []);
    return true;
  }

  /* What renderInbox() is given: the authorised list, minus whatever the
     view filter is hiding right now. */
  visibleConversations() {
    if (!this.locationFilter) return this.conversations;
    return this.conversations.filter((c) => c.locationId === this.locationFilter);
  }

  setLocationFilter(value) {
    const next = (typeof value === 'string' && value
      && this.locations.indexOf(value) !== -1) ? value : null;
    if (next === this.locationFilter) return false;
    this.locationFilter = next;
    callUi(this.ui, 'setLocationFilter', next);
    /*
     * NO REQUEST. The rows are already here and already authorised; this
     * decides which of them are drawn. Re-fetching would spend a round trip
     * to receive the identical list.
     */
    callUi(this.ui, 'renderInbox', this.visibleConversations());
    callUi(this.ui, 'setSelected', this.selectedId);
    return true;
  }

  /*
   * Does the open transcript need re-reading?
   *
   * This is what replaced the eight-second thread timer. The inbox answer
   * already says everything needed to decide: if the selected conversation's
   * lastMessageAt, messageCount and status are all exactly what they were
   * when the transcript was read, nothing has been written to it and there is
   * nothing to fetch. Almost every tick takes that branch.
   *
   * THREE FIELDS, NOT TWO. lastMessageAt and messageCount move together on
   * every message write, but closeConversation() writes only status, closedAt
   * and updatedAt - a close leaves both message fields untouched. Without
   * status in the marker, a thread closed from another device would stay
   * looking open here until somebody clicked it.
   *
   * A SELECTED CONVERSATION MISSING FROM THE LIST IS ALSO A CHANGE. The inbox
   * is filtered by status, so a thread closing while the Open filter is on
   * makes it disappear rather than reappear as closed. Absence is therefore
   * the signal, and one transcript read settles it - /messages fetches by id
   * and does not filter by status, so it returns the real state.
   */
  reconcileSelected() {
    if (this.stopped || !this.staff || !this.selectedId) return false;
    /* No marker means no transcript has been read yet; select() and the
       explicit paths do that, not this. */
    if (!this.threadMarker || this.threadMarker.conversationId !== this.selectedId) {
      return false;
    }

    const now = this.conversations.find(
      (c) => c.conversationId === this.selectedId) || null;

    if (now) {
      if (sameSummary(this.threadMarker, now)) return false;        /* nothing happened */
    } else if (this.threadMarker.status !== this.filter) {
      /*
       * ABSENT, AND WE ALREADY KNOW WHY.
       *
       * A thread we have read and know is closed will never appear in the
       * Open list again. Treating that permanent absence as a change would
       * re-read the whole transcript on every single tick, forever - which is
       * worse than the timer this design replaced, and is exactly what the
       * first version of this did until a test counted the requests.
       *
       * Absence only means something when the marker says the conversation
       * SHOULD still be in this list. Then it is read once, the answer
       * updates the marker, and the next tick takes the branch above.
       */
      return false;
    }

    this.noteSuccess('thread');
    this.loadThread(this.selectedId, { silent: true });
    return true;
  }

  setFilter(value) {
    const next = value === 'closed' ? 'closed' : 'open';
    if (next === this.filter) return false;
    this.filter = next;
    callUi(this.ui, 'setFilter', next);
    this.noteSuccess('inbox');
    /* If a load is already in flight it is for the OLD filter, and the guard
       in loadInbox() would refuse this one. loadInbox() notices the mismatch
       when it lands and re-runs itself - see the check on this.filter there. */
    this.loadInbox({});
    return true;
  }

  /*
   * Refresh, because a person pressed the button.
   *
   * Explicit, so it does NOT consult the marker: somebody pressing Refresh
   * wants to be sure, and "I decided nothing had changed" is not the answer
   * they asked for. Both the inbox and the open transcript are re-read.
   */
  refreshAll() {
    this.noteSuccess('inbox');
    this.noteSuccess('thread');
    this.loadInbox({});
    if (this.selectedId) this.loadThread(this.selectedId, {});
    return true;
  }

  /* ----------------------------------------------------------- thread */

  select(conversationId) {
    if (this.stopped) return false;
    const id = typeof conversationId === 'string' && conversationId
      ? conversationId
      : null;
    if (id === this.selectedId) return false;

    this.selectedId = id;
    this.thread = null;
    this.threadMarker = null;
    this.noteSuccess('thread');
    callUi(this.ui, 'setSelected', id);
    callUi(this.ui, 'renderThread', null);
    if (!id) return true;                 /* back to the inbox; poll idles */
    this.loadThread(id, {});
    return true;
  }

  async loadThread(conversationId, options) {
    const opts = options || {};
    if (this.stopped || !this.staff) return false;
    if (!conversationId) return false;
    if (this.threadLoading) return false;
    if (opts.silent && this.shouldSkip('thread')) return false;

    this.threadLoading = true;
    if (!opts.silent) callUi(this.ui, 'setThreadBusy', true);
    try {
      const payload = await apiGet(this.deps,
        API_MESSAGES + '?conversationId=' + encodeURIComponent(conversationId)
          + '&limit=' + MAX_TRANSCRIPT,
        this.identity.user);
      if (this.stopped) return false;
      /*
       * The visitor moved on while this was in flight.
       *
       * Throwing the answer away is correct - rendering it would replace the
       * thread they are looking at now with the one they left. But throwing
       * it away is not ENOUGH: the load they actually wanted was refused by
       * the single-flight guard above, so without this the new thread never
       * loads at all and the panel sits empty. Hand off to it here, once the
       * guard has been released in the finally block below.
       */
      if (this.selectedId !== conversationId) {
        const wanted = this.selectedId;
        if (wanted) {
          this.threadLoading = false;
          this.loadThread(wanted, opts);
        }
        return false;
      }
      this.noteSuccess('thread');
      this.applyThread(payload);
      if (!opts.silent) callUi(this.ui, 'setNotice', null);
      return true;
    } catch (err) {
      if (this.stopped) return false;
      this.noteFailure('thread');
      const described = describeFailure(err);
      if (described.code === 'conversation_not_found') {
        /* Gone. Drop it rather than leave a dead thread on screen. */
        this.selectedId = null;
        this.thread = null;
        this.threadMarker = null;
        callUi(this.ui, 'setSelected', null);
        callUi(this.ui, 'renderThread', null);
        callUi(this.ui, 'setNotice', described.text);
        this.loadInbox({ silent: true });
        return false;
      }
      return await this.reportFailure(err, opts);
    } finally {
      this.threadLoading = false;
      if (!opts.silent) callUi(this.ui, 'setThreadBusy', false);
    }
  }

  applyThread(payload) {
    const conversation = normaliseConversation(payload && payload.conversation);
    const messages = payload && Array.isArray(payload.messages)
      ? payload.messages.map(normaliseMessage).filter(Boolean)
      : [];
    /* The server returns them oldest-first already; sorting again costs
       nothing and means a future ordering change cannot silently scramble
       a transcript. */
    messages.sort((a, b) => (a.createdAt - b.createdAt) || (a.messageId < b.messageId ? -1 : 1));
    this.thread = { conversation: conversation, messages: messages };

    /*
     * The marker comes from THIS response, not from the inbox row that
     * triggered the fetch: it is the summary as it stood at the moment the
     * transcript was actually read, which is the only thing a later inbox
     * answer can honestly be compared against.
     */
    this.threadMarker = conversation ? markerFor(conversation) : null;

    callUi(this.ui, 'renderThread', this.thread);
  }

  isClosed() {
    return !!(this.thread && this.thread.conversation
      && this.thread.conversation.status === 'closed');
  }

  /* ------------------------------------------------------------- send */

  async send(fields) {
    if (this.stopped || !this.staff) return null;
    if (this.sending) return null;                 /* the double-click guard */
    if (!this.selectedId) return null;
    if (this.isClosed()) {
      callUi(this.ui, 'setNotice', MESSAGES_BY_CODE.conversation_closed);
      return null;
    }

    const raw = String((fields && fields.message) || '');
    const message = raw.trim();
    if (!message) return null;
    if (message.length > MESSAGE_MAX) {
      callUi(this.ui, 'setNotice',
        'That reply is too long. Please shorten it to ' + MESSAGE_MAX + ' characters.');
      return null;
    }

    /*
     * THE KEY IS PER MESSAGE, NOT PER ATTEMPT.
     *
     * peekMessage() on the server returns the original result for a request
     * it has already stored, so a retry that carries the SAME key cannot
     * append a second copy of the same reply. A retry with a fresh key would
     * be a different message and would be written twice - which is why the
     * key travels with the retry rather than being minted again.
     */
    const clientMessageId = (fields && typeof fields.clientMessageId === 'string'
      && fields.clientMessageId)
      ? fields.clientMessageId
      : this.deps.newClientMessageId();

    const conversationId = this.selectedId;
    this.sending = true;
    callUi(this.ui, 'setSendBusy', true);
    callUi(this.ui, 'setNotice', null);
    try {
      const payload = await apiPost(this.deps, API_SEND, {
        conversationId: conversationId,
        message: message,
        clientMessageId: clientMessageId
      }, this.identity.user);
      if (this.stopped) return null;

      callUi(this.ui, 'clearComposer');
      /* Refresh once rather than guessing what the server stored. The reply
         appears with the id and timestamp the server actually gave it. */
      this.noteSuccess('thread');
      await this.loadThread(conversationId, { silent: true });
      this.loadInbox({ silent: true });
      return payload;
    } catch (err) {
      if (this.stopped) return null;
      const described = describeFailure(err);
      if (described.kind === 'auth') {
        await this.denyAccess(described.text);
        return null;
      }
      if (described.code === 'conversation_closed') {
        /* Somebody closed it while this reply was being typed. Reconcile. */
        callUi(this.ui, 'setNotice', described.text);
        this.noteSuccess('thread');
        await this.loadThread(conversationId, { silent: true });
        return null;
      }
      callUi(this.ui, 'setNotice', described.text);
      /*
       * NO AUTOMATIC RETRY. A send that fails ambiguously may well have been
       * stored - it is the response that was lost - so retrying is a decision
       * for the person, not the code. The key is handed back so that when
       * they do press Try again it is the SAME message, not a second one.
       */
      callUi(this.ui, 'setRetry', () => this.send({
        message: message,
        clientMessageId: clientMessageId
      }));
      return null;
    } finally {
      this.sending = false;
      callUi(this.ui, 'setSendBusy', false);
    }
  }

  /* ------------------------------------------------------------ close */

  /*
   * Closing is consequential - the customer can no longer write - so it goes
   * through a confirmation the person has to answer. The UI owns the dialog;
   * this only asks for one and acts on the answer.
   */
  requestClose() {
    if (this.stopped || !this.staff || !this.selectedId) return false;
    if (this.isClosed() || this.closing) return false;
    callUi(this.ui, 'confirmClose', () => this.close());
    return true;
  }

  async close() {
    if (this.stopped || !this.staff || !this.selectedId) return false;
    if (this.closing) return false;
    const conversationId = this.selectedId;

    this.closing = true;
    callUi(this.ui, 'setCloseBusy', true);
    callUi(this.ui, 'setNotice', null);
    try {
      await apiPost(this.deps, API_CLOSE, { conversationId: conversationId },
        this.identity.user);
      if (this.stopped) return false;
      this.noteSuccess('thread');
      await this.loadThread(conversationId, { silent: true });
      this.loadInbox({ silent: true });
      return true;
    } catch (err) {
      if (this.stopped) return false;
      const described = describeFailure(err);
      if (described.kind === 'auth') {
        await this.denyAccess(described.text);
        return false;
      }
      /*
       * Already closed is not a catastrophe - close is idempotent on the
       * server, and this branch only fires if something else disagrees.
       * Either way the honest move is to go and look.
       */
      callUi(this.ui, 'setNotice', described.text);
      this.noteSuccess('thread');
      await this.loadThread(conversationId, { silent: true });
      return false;
    } finally {
      this.closing = false;
      callUi(this.ui, 'setCloseBusy', false);
    }
  }

  /* --------------------------------------------------------- transfer */

  /*
   * Hand this conversation to the other shop.
   *
   * WHY IT IS NOT A COPY. The conversationId does not change, the transcript
   * does not move, and the customer keeps writing into the same thread. A
   * misroute is a routing mistake, not a reason to make somebody re-explain
   * a curved scupper to a second person.
   *
   * The destinations offered are ALL THREE shops minus the one it is at -
   * not the ones this account is authorised for. Main-only staff who find a
   * Keith Street job in their inbox must be able to send it to Keith Street,
   * and requiring destination access would mean only a manager could ever
   * fix a misroute. The server agrees: transferConversation() authorises the
   * SOURCE and not the destination. What they do not get is a way in - the
   * moment it lands, their ordinary read rules apply again.
   */
  requestTransfer() {
    if (this.stopped || !this.staff || !this.selectedId) return false;
    if (this.transferring || this.isClosed()) return false;
    const from = this.thread && this.thread.conversation
      ? this.thread.conversation.locationId
      : null;
    const options = LOC.LOCATION_IDS
      .filter((id) => id !== from)
      .map((id) => ({ id: id, label: LOC.labelFor(id) }));
    if (!options.length) return false;
    callUi(this.ui, 'confirmTransfer', options, (id) => this.transfer(id));
    return true;
  }

  async transfer(locationId) {
    if (this.stopped || !this.staff || !this.selectedId) return false;
    if (this.transferring) return false;
    /* The dialog only ever offers the three, but the handler is reachable
       from a console and the request is not worth making without one. */
    if (!LOC.isLocationId(locationId)) return false;

    const conversationId = this.selectedId;
    this.transferring = true;
    callUi(this.ui, 'setTransferBusy', true);
    callUi(this.ui, 'setNotice', null);
    try {
      const payload = await apiPost(this.deps, API_TRANSFER, {
        conversationId: conversationId,
        locationId: locationId
      }, this.identity.user);
      if (this.stopped) return false;

      /*
       * IT MAY HAVE JUST LEFT THIS ACCOUNT'S REACH, and that is the normal
       * case: main-only staff sending a job to Keith Street cannot read it
       * afterwards. Reading the transcript again would be a 404 dressed up
       * as an error, so the honest move is to let go of it deliberately and
       * SAY where it went - a row vanishing from an inbox with no
       * explanation is how people conclude they deleted something.
       *
       * The label comes from the id we asked for, through labelFor(), not
       * from payload.locationLabel: no server string reaches the screen.
       */
      const landed = LOC.resolveLocation(payload && payload.locationId);
      const mine = this.locations.indexOf(landed) !== -1;
      if (!mine) {
        this.selectedId = null;
        this.thread = null;
        this.threadMarker = null;
        callUi(this.ui, 'setSelected', null);
        callUi(this.ui, 'renderThread', null);
        callUi(this.ui, 'setNotice',
          'Moved to ' + LOC.labelFor(landed)
            + '. It is no longer in your inbox.');
        this.loadInbox({ silent: true });
        return true;
      }

      callUi(this.ui, 'setNotice', 'Moved to ' + LOC.labelFor(landed) + '.');
      this.noteSuccess('thread');
      await this.loadThread(conversationId, { silent: true });
      this.loadInbox({ silent: true });
      return true;
    } catch (err) {
      if (this.stopped) return false;
      const described = describeFailure(err);
      if (described.kind === 'auth') {
        await this.denyAccess(described.text);
        return false;
      }
      /*
       * NO AUTOMATIC RETRY, for the same reason as a send: an ambiguous
       * failure may already have moved it, and moving it twice is a second
       * decision. Go and look instead - loadThread() answers both "it did
       * move" and "it is gone from this account" honestly.
       */
      callUi(this.ui, 'setNotice', described.text);
      this.noteSuccess('thread');
      await this.loadThread(conversationId, { silent: true });
      this.loadInbox({ silent: true });
      return false;
    } finally {
      this.transferring = false;
      callUi(this.ui, 'setTransferBusy', false);
    }
  }

  /* --------------------------------------------------------- failures */

  async reportFailure(err, options) {
    const described = describeFailure(err);
    if (described.kind === 'auth') {
      await this.denyAccess(described.text);
      return false;
    }
    /* A silent poll does not shout. It has already backed off, and the next
       successful tick clears whatever was on screen. */
    if (!options || !options.silent) {
      callUi(this.ui, 'setNotice', described.text);
    }
    return false;
  }
}

/* ------------------------------------------------------- normalisation */

/*
 * EVERY FIELD BELOW IS UNTRUSTED. customerName, customerEmail and body are
 * whatever a member of the public typed into a form. They are normalised to
 * strings here and rendered with textContent by the UI - never as markup,
 * never through innerHTML, anywhere.
 */
function normaliseConversation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.conversationId === 'string' ? raw.conversationId : '';
  if (!id) return null;
  /*
   * THE LABEL IS DERIVED, NOT TAKEN.
   *
   * The response carries locationLabel too, and it is ignored on purpose. The
   * id is one of three known strings; the label is a sentence that goes on a
   * screen. Deriving it here means the only location text this page can ever
   * display is one of the three in chat-locations.js - an id this build does
   * not know reads as "Not Sure / Unassigned" rather than being echoed - and
   * renaming a shop stays a one-file copy edit instead of a deploy that has
   * to land on both sides at once.
   */
  const locationId = LOC.resolveLocation(raw.locationId);
  return {
    conversationId: id,
    customerName: text(raw.customerName),
    customerEmail: text(raw.customerEmail),
    status: raw.status === 'closed' ? 'closed' : 'open',
    locationId: locationId,
    locationLabel: LOC.labelFor(locationId),
    createdAt: millis(raw.createdAt),
    lastMessageAt: millis(raw.lastMessageAt),
    messageCount: typeof raw.messageCount === 'number' && raw.messageCount >= 0
      ? raw.messageCount
      : 0
  };
}

function normaliseMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.messageId === 'string' ? raw.messageId : '';
  if (!id) return null;
  return {
    messageId: id,
    conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : '',
    senderType: raw.senderType === 'staff' ? 'staff'
      : (raw.senderType === 'system' ? 'system' : 'customer'),
    body: text(raw.body),
    createdAt: millis(raw.createdAt)
  };
}

/*
 * The change marker for one conversation. Exact normalised primitives, so a
 * comparison is === on three values and nothing is parsed or formatted.
 */
function markerFor(conversation) {
  return {
    conversationId: conversation.conversationId,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messageCount,
    status: conversation.status,
    /*
     * FOUR FIELDS NOW. A transfer writes locationId, previousLocationId and
     * the audit stamps, and deliberately touches NEITHER lastMessageAt NOR
     * messageCount - nothing was said, so nothing pretends a message
     * arrived. It does not change status either. Without locationId here, a
     * conversation handed to the other shop while a manager had it open
     * would keep showing the old shop in the header until they clicked
     * something, and a reply typed into it would be a reply to a thread they
     * no longer hold.
     */
    locationId: conversation.locationId
  };
}

function sameSummary(marker, conversation) {
  return marker.conversationId === conversation.conversationId
    && marker.lastMessageAt === conversation.lastMessageAt
    && marker.messageCount === conversation.messageCount
    && marker.status === conversation.status
    && marker.locationId === conversation.locationId;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function millis(value) {
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

/* ------------------------------------------------------------- the deps */

/*
 * Resolve the signed-in user, tolerating the SDK's asynchronous restore.
 *
 * onAuthStateChanged fires once with the restored user or with null. Reading
 * currentUser directly would race that and show the sign-in form to somebody
 * who is already signed in.
 */
function currentUser(authMod, auth) {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = null;
    const finish = (user) => {
      if (settled) return;
      settled = true;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (err) { /* already gone */ }
      }
      resolve(user || null);
    };
    try {
      unsubscribe = authMod.onAuthStateChanged(auth, finish, () => finish(null));
    } catch (err) {
      finish(auth && auth.currentUser ? auth.currentUser : null);
    }
  });
}

function defaultDeps(overrides) {
  const d = {
    initAppCheck: initAppCheck,
    getFirebaseApp: getFirebaseApp,
    loadAuth: () => import(SDK_AUTH),
    authorizedFetch: authorizedFetch,
    newClientMessageId: newClientMessageId,
    currentUser: currentUser,
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
    document: () => (typeof globalThis.document === 'undefined' ? null : globalThis.document),
    now: () => Date.now()
  };
  return Object.assign(d, overrides || {});
}

/* ------------------------------------------------------- the entry point */

let current = null;

export async function startStaffChat(ui, options) {
  if (current) {
    current.stop();
    current = null;
  }
  const session = new StaffDashboard(ui, defaultDeps(options && options.deps));
  current = session;
  await session.begin();
  return session;
}

export function activeSession() {
  return current;
}

/* Tests import the pieces directly; nothing here is used by the page. */
export const _internals = {
  INBOX_POLL_MS, MAX_BACKOFF_MS,
  MAX_INBOX, MAX_TRANSCRIPT, MESSAGE_MAX,
  API_CONVERSATIONS, API_MESSAGES, API_SEND, API_CLOSE,
  SIGN_IN_FAILED, MESSAGES_BY_CODE,
  StaffApiError, StaffNetworkError,
  normaliseConversation, normaliseMessage, defaultDeps,
  markerFor, sameSummary
};

/* =========================================================================
 * THE PAGE
 *
 * Everything above is the controller and knows nothing about the DOM; it
 * drives a `ui` object of plain methods. This is the implementation of that
 * object for staff/chat/index.html, and it is the only code here that touches
 * an element.
 *
 * THE ONE RULE. Every value that came from a customer - a name, an email
 * address, a message body - reaches the page through textContent or through
 * el()'s `text` option, which is textContent underneath. innerHTML is not
 * used anywhere in this file, for anything, and a test greps for it. A
 * customer who types a <script> tag into the chat sees a <script> tag on the
 * staff screen, spelled out, doing nothing.
 * ========================================================================= */

function el(tag, opts) {
  const node = document.createElement(tag);
  const o = opts || {};
  for (const key of Object.keys(o)) {
    if (key === 'text') {
      node.textContent = String(o[key] == null ? '' : o[key]);
    } else if (key === 'class') {
      node.className = o[key];
    } else {
      node.setAttribute(key, String(o[key]));
    }
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/*
 * Timestamps.
 *
 * Local time, because the only people reading this are in the shop. A
 * message from today shows the time; anything older shows the date too, so
 * "9:14 am" can never be mistaken for last Tuesday.
 */
function stamp(ms, now) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const today = new Date(now || Date.now());
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + time;
}

export function buildUi(root) {
  if (!root) return null;

  /* ---- the shell ---------------------------------------------------- */
  clear(root);

  const authView = el('section', { class: 'sc__auth', 'aria-labelledby': 'sc-auth-h' });
  const authForm = el('form', { class: 'sc__auth-form', novalidate: 'novalidate' });
  authForm.appendChild(el('h1', { id: 'sc-auth-h', class: 'sc__auth-title',
    text: "Esther's Sheet Metal — Staff Chat" }));
  authForm.appendChild(el('p', { class: 'sc__auth-sub',
    text: 'Sign in with your staff account to see customer messages.' }));

  const emailLabel = el('label', { class: 'sc__field', for: 'sc-email' });
  emailLabel.appendChild(el('span', { class: 'sc__label', text: 'Email address' }));
  const emailInput = el('input', {
    id: 'sc-email', class: 'sc__input', type: 'email', name: 'email',
    autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false',
    required: 'required'
  });
  emailLabel.appendChild(emailInput);

  const passLabel = el('label', { class: 'sc__field', for: 'sc-password' });
  passLabel.appendChild(el('span', { class: 'sc__label', text: 'Password' }));
  const passInput = el('input', {
    id: 'sc-password', class: 'sc__input', type: 'password', name: 'password',
    autocomplete: 'current-password', required: 'required'
  });
  passLabel.appendChild(passInput);

  const authError = el('p', { class: 'sc__auth-error', role: 'alert', hidden: 'hidden' });
  const authSubmit = el('button', { class: 'sc__btn sc__btn--primary',
    type: 'submit', text: 'Sign in' });

  authForm.appendChild(emailLabel);
  authForm.appendChild(passLabel);
  authForm.appendChild(authError);
  authForm.appendChild(authSubmit);
  authView.appendChild(authForm);

  /* ---- the app ------------------------------------------------------ */
  const appView = el('div', { class: 'sc__app', hidden: 'hidden' });

  const bar = el('header', { class: 'sc__bar' });
  bar.appendChild(el('span', { class: 'sc__brand', text: "Esther's Sheet Metal" }));
  bar.appendChild(el('span', { class: 'sc__brand-sub', text: 'Staff Chat' }));
  const who = el('span', { class: 'sc__who' });
  const signOutBtn = el('button', { class: 'sc__btn sc__btn--quiet', type: 'button',
    text: 'Sign out' });
  bar.appendChild(who);
  bar.appendChild(signOutBtn);
  appView.appendChild(bar);

  const notice = el('p', { class: 'sc__notice', role: 'status', 'aria-live': 'polite',
    hidden: 'hidden' });
  const retryBtn = el('button', { class: 'sc__btn sc__btn--quiet sc__retry',
    type: 'button', text: 'Try again', hidden: 'hidden' });
  notice.appendChild(retryBtn);
  appView.appendChild(notice);

  const cols = el('div', { class: 'sc__cols' });

  /* inbox */
  const inbox = el('section', { class: 'sc__inbox', 'aria-labelledby': 'sc-inbox-h' });
  const inboxHead = el('div', { class: 'sc__inbox-head' });
  inboxHead.appendChild(el('h2', { id: 'sc-inbox-h', class: 'sc__h2', text: 'Conversations' }));

  const filterGroup = el('div', { class: 'sc__filter', role: 'group',
    'aria-label': 'Show conversations' });
  const openBtn = el('button', { class: 'sc__chip', type: 'button', text: 'Open',
    'aria-pressed': 'true', 'data-filter': 'open' });
  const closedBtn = el('button', { class: 'sc__chip', type: 'button', text: 'Closed',
    'aria-pressed': 'false', 'data-filter': 'closed' });
  filterGroup.appendChild(openBtn);
  filterGroup.appendChild(closedBtn);
  inboxHead.appendChild(filterGroup);

  const refreshBtn = el('button', { class: 'sc__btn sc__btn--quiet', type: 'button',
    text: 'Refresh' });
  inboxHead.appendChild(refreshBtn);
  inbox.appendChild(inboxHead);

  /*
   * The shop chips, for an account that can see more than one.
   *
   * Hidden entirely when there is nothing to choose between - which is every
   * account assigned to a single shop, and is the common case. A VIEW
   * control: it hides rows already on this page, from somebody the server
   * already decided may read them. It grants nothing, and the list it filters
   * arrived filtered.
   *
   * "All" is a real button rather than the absence of a selection, so the way
   * back is as obvious as the way in.
   */
  const locFilter = el('div', { class: 'sc__filter sc__filter--loc', role: 'group',
    'aria-label': 'Show shops', hidden: 'hidden' });
  const locAllBtn = el('button', { class: 'sc__chip', type: 'button', text: 'All shops',
    'aria-pressed': 'true', 'data-location': '' });
  /* Between the head and the list: appended now, and the list follows. */
  inbox.appendChild(locFilter);

  const inboxList = el('ul', { class: 'sc__list', 'aria-live': 'polite',
    'aria-busy': 'false' });
  inbox.appendChild(inboxList);
  cols.appendChild(inbox);

  /* thread */
  const thread = el('section', { class: 'sc__thread', 'aria-labelledby': 'sc-thread-h' });
  const threadHead = el('div', { class: 'sc__thread-head' });
  const backBtn = el('button', { class: 'sc__btn sc__btn--quiet sc__back', type: 'button',
    text: 'Back to inbox' });
  const threadWho = el('div', { class: 'sc__thread-who' });
  const threadName = el('h2', { id: 'sc-thread-h', class: 'sc__h2', text: 'No conversation selected' });
  const threadEmail = el('p', { class: 'sc__thread-email', text: '' });
  threadWho.appendChild(threadName);
  threadWho.appendChild(threadEmail);
  /*
   * WHICH SHOP THIS THREAD IS AT, spelled out in the header.
   *
   * A manager watching both inboxes is one careless reply away from
   * answering as the wrong shop, and the transfer button lives right beside
   * this - so the destination has to be readable before the button is
   * pressed, not after. Text, never colour alone.
   */
  /* hidden from the start: before the first renderThread() there is no
     conversation and so no shop, and an empty bordered pill beside "No
     conversation selected" is a stray mark somebody has to explain. Caught
     in browser QA. */
  const threadLoc = el('span', { class: 'sc__loc sc__loc--head', text: '',
    hidden: 'hidden' });
  const threadStatus = el('span', { class: 'sc__status', text: '' });
  const transferBtn = el('button', { class: 'sc__btn sc__btn--quiet', type: 'button',
    text: 'Move to other shop', hidden: 'hidden' });
  const closeBtn = el('button', { class: 'sc__btn sc__btn--danger', type: 'button',
    text: 'Close conversation', hidden: 'hidden' });
  threadHead.appendChild(backBtn);
  threadHead.appendChild(threadWho);
  threadHead.appendChild(threadLoc);
  threadHead.appendChild(threadStatus);
  threadHead.appendChild(transferBtn);
  threadHead.appendChild(closeBtn);
  thread.appendChild(threadHead);

  const log = el('div', { class: 'sc__log', role: 'log', 'aria-live': 'polite',
    'aria-label': 'Conversation transcript', tabindex: '0' });
  thread.appendChild(log);

  const composer = el('form', { class: 'sc__composer', novalidate: 'novalidate' });
  const replyLabel = el('label', { class: 'sc__sr', for: 'sc-reply', text: 'Your reply' });
  const replyInput = el('textarea', { id: 'sc-reply', class: 'sc__text', rows: '3',
    placeholder: 'Write a reply…', maxlength: String(MESSAGE_MAX) });
  const sendBtn = el('button', { class: 'sc__btn sc__btn--primary', type: 'submit',
    text: 'Send' });
  composer.appendChild(replyLabel);
  composer.appendChild(replyInput);
  composer.appendChild(sendBtn);
  thread.appendChild(composer);
  cols.appendChild(thread);

  appView.appendChild(cols);

  /* ---- the confirmation --------------------------------------------- */
  const dialog = el('dialog', { class: 'sc__dialog', 'aria-labelledby': 'sc-dlg-h' });
  dialog.appendChild(el('h2', { id: 'sc-dlg-h', class: 'sc__dlg-title',
    text: 'Close this conversation?' }));
  dialog.appendChild(el('p', { class: 'sc__dlg-body',
    text: 'The customer will no longer be able to send new messages. '
      + 'The conversation stays readable for both of you.' }));
  const dlgRow = el('div', { class: 'sc__dlg-row' });
  const dlgCancel = el('button', { class: 'sc__btn sc__btn--quiet', type: 'button',
    text: 'Keep it open' });
  const dlgConfirm = el('button', { class: 'sc__btn sc__btn--danger', type: 'button',
    text: 'Close conversation' });
  dlgRow.appendChild(dlgCancel);
  dlgRow.appendChild(dlgConfirm);
  dialog.appendChild(dlgRow);

  /* ---- the transfer dialog ------------------------------------------
     A separate dialog from the close confirmation, because it asks a
     different kind of question: not "are you sure" but "where to". The
     destinations are filled in by confirmTransfer() - this file has no list
     of shops of its own. */
  const xfer = el('dialog', { class: 'sc__dialog', 'aria-labelledby': 'sc-xfer-h' });
  xfer.appendChild(el('h2', { id: 'sc-xfer-h', class: 'sc__dlg-title',
    text: 'Move this conversation?' }));
  xfer.appendChild(el('p', { class: 'sc__dlg-body',
    text: 'The customer keeps the same conversation and the whole transcript '
      + 'goes with it. Nothing is copied and nothing is lost. If the shop you '
      + 'choose is not one of yours, it will leave your inbox.' }));
  const xferChoices = el('div', { class: 'sc__dlg-choices', role: 'radiogroup',
    'aria-label': 'Move to which shop' });
  xfer.appendChild(xferChoices);
  const xferRow = el('div', { class: 'sc__dlg-row' });
  const xferCancel = el('button', { class: 'sc__btn sc__btn--quiet', type: 'button',
    text: 'Leave it here' });
  const xferConfirm = el('button', { class: 'sc__btn sc__btn--primary', type: 'button',
    text: 'Move conversation' });
  xferRow.appendChild(xferCancel);
  xferRow.appendChild(xferConfirm);
  xfer.appendChild(xferRow);

  const starting = el('p', { class: 'sc__starting', role: 'status', text: 'Starting…' });

  root.appendChild(starting);
  root.appendChild(authView);
  root.appendChild(appView);
  root.appendChild(dialog);
  root.appendChild(xfer);

  /* ---- state the view keeps ----------------------------------------- */
  let handlers = {};
  let selectedId = null;
  let closedNow = false;
  let composerEnabled = false;
  let sendBusy = false;
  let pendingConfirm = null;
  let pendingTransfer = null;      /* run(locationId) once one is chosen */
  let xferInputs = [];
  let lastFocus = null;

  function syncSend() {
    const empty = replyInput.value.trim().length === 0;
    replyInput.disabled = !composerEnabled || closedNow;
    sendBtn.disabled = empty || sendBusy || !composerEnabled || closedNow;
  }

  /* ---- wiring -------------------------------------------------------- */
  authForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (typeof handlers.signIn === 'function') {
      handlers.signIn({ email: emailInput.value, password: passInput.value });
    }
  });
  signOutBtn.addEventListener('click', function () {
    if (typeof handlers.signOut === 'function') handlers.signOut();
  });
  refreshBtn.addEventListener('click', function () {
    if (typeof handlers.refresh === 'function') handlers.refresh();
  });
  openBtn.addEventListener('click', function () {
    if (typeof handlers.filter === 'function') handlers.filter('open');
  });
  closedBtn.addEventListener('click', function () {
    if (typeof handlers.filter === 'function') handlers.filter('closed');
  });
  backBtn.addEventListener('click', function () {
    if (typeof handlers.back === 'function') handlers.back();
  });
  closeBtn.addEventListener('click', function () {
    if (typeof handlers.close === 'function') handlers.close();
  });
  transferBtn.addEventListener('click', function () {
    if (typeof handlers.transfer === 'function') handlers.transfer();
  });
  locAllBtn.addEventListener('click', function () {
    if (typeof handlers.locationFilter === 'function') handlers.locationFilter(null);
  });
  composer.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (typeof handlers.send === 'function') handlers.send({ message: replyInput.value });
  });
  replyInput.addEventListener('input', syncSend);
  /* Enter sends, Shift+Enter makes a new line. The composer is a textarea so
     a reply can be more than one line, and Send stays reachable by Tab. */
  replyInput.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    if (sendBtn.disabled) return;
    if (typeof handlers.send === 'function') handlers.send({ message: replyInput.value });
  });

  dlgCancel.addEventListener('click', function () { closeDialog(); });
  dlgConfirm.addEventListener('click', function () {
    const run = pendingConfirm;
    closeDialog();
    if (typeof run === 'function') run();
  });
  /* Escape closes it - <dialog> fires cancel - and focus goes back where it
     came from either way. */
  dialog.addEventListener('cancel', function (ev) {
    ev.preventDefault();
    closeDialog();
  });

  function closeDialog() {
    pendingConfirm = null;
    try { if (dialog.open) dialog.close(); } catch (err) { /* older engine */ }
    dialog.removeAttribute('open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
  }

  xferCancel.addEventListener('click', function () { closeTransfer(); });
  xferConfirm.addEventListener('click', function () {
    const run = pendingTransfer;
    let chosen = null;
    for (let i = 0; i < xferInputs.length; i++) {
      if (xferInputs[i].checked) { chosen = xferInputs[i].value; break; }
    }
    /* Nothing picked is not a reason to close the question. Leave the dialog
       up so the answer is still there to give. */
    if (!chosen) return;
    closeTransfer();
    if (typeof run === 'function') run(chosen);
  });
  xfer.addEventListener('cancel', function (ev) {
    ev.preventDefault();
    closeTransfer();
  });

  function closeTransfer() {
    pendingTransfer = null;
    try { if (xfer.open) xfer.close(); } catch (err) { /* older engine */ }
    xfer.removeAttribute('open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
  }

  /* ---- the ui contract ----------------------------------------------- */
  return {
    setPhase: function (phase) {
      starting.hidden = phase !== 'starting' && phase !== 'checking';
      starting.textContent = phase === 'checking' ? 'Checking your account…' : 'Starting…';
      authView.hidden = phase !== 'signed-out';
      appView.hidden = phase !== 'ready';
      if (phase === 'signed-out') {
        passInput.value = '';
        if (typeof emailInput.focus === 'function') {
          setTimeout(function () { emailInput.focus(); }, 30);
        }
      }
    },

    setAuthBusy: function (flag) {
      const busy = flag === true;
      authSubmit.disabled = busy;
      authSubmit.textContent = busy ? 'Signing in…' : 'Sign in';
      emailInput.disabled = busy;
      passInput.disabled = busy;
    },

    setAuthError: function (textValue) {
      if (textValue == null || textValue === '') {
        authError.textContent = '';
        authError.hidden = true;
        return;
      }
      authError.textContent = String(textValue);
      authError.hidden = false;
    },

    clearPassword: function () { passInput.value = ''; },

    setStaff: function (staff) {
      who.textContent = staff && staff.email ? String(staff.email) : '';
    },

    setNotice: function (textValue) {
      if (textValue == null || textValue === '') {
        notice.hidden = true;
        clear(notice);
        notice.appendChild(retryBtn);
        retryBtn.hidden = true;
        return;
      }
      clear(notice);
      notice.appendChild(document.createTextNode(String(textValue)));
      notice.appendChild(retryBtn);
      notice.hidden = false;
    },

    setRetry: function (handler) {
      if (typeof handler !== 'function') {
        retryBtn.hidden = true;
        retryBtn.onclick = null;
        return;
      }
      retryBtn.hidden = false;
      retryBtn.onclick = function () { retryBtn.hidden = true; handler(); };
    },

    setFilter: function (value) {
      const isOpen = value !== 'closed';
      openBtn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
      closedBtn.setAttribute('aria-pressed', isOpen ? 'false' : 'true');
    },

    /*
     * Draw the shop chips, or take the whole row away.
     *
     * An empty list hides it: one shop is not a choice, and an account with
     * no shops has nothing to filter. The chips are rebuilt rather than
     * patched, which is a handful of buttons and removes a whole class of
     * stale-node bug.
     */
    setLocationFilters: function (list) {
      const items = Array.isArray(list) ? list : [];
      clear(locFilter);
      if (!items.length) {
        locFilter.hidden = true;
        return;
      }
      locFilter.appendChild(locAllBtn);
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id) continue;
        const chip = el('button', {
          class: 'sc__chip', type: 'button',
          /* text: - textContent underneath, like everything else here. */
          text: String(item.label == null ? item.id : item.label),
          'aria-pressed': 'false',
          'data-location': item.id
        });
        chip.addEventListener('click', function () {
          if (typeof handlers.locationFilter === 'function') {
            handlers.locationFilter(item.id);
          }
        });
        locFilter.appendChild(chip);
      }
      locFilter.hidden = false;
    },

    setLocationFilter: function (id) {
      const want = typeof id === 'string' && id ? id : '';
      const chips = locFilter.querySelectorAll('.sc__chip');
      for (let i = 0; i < chips.length; i++) {
        const match = chips[i].getAttribute('data-location') === want;
        chips[i].setAttribute('aria-pressed', match ? 'true' : 'false');
      }
    },

    setInboxBusy: function (flag) {
      inboxList.setAttribute('aria-busy', flag === true ? 'true' : 'false');
      refreshBtn.disabled = flag === true;
    },

    setThreadBusy: function (flag) {
      log.setAttribute('aria-busy', flag === true ? 'true' : 'false');
    },

    renderInbox: function (list) {
      clear(inboxList);
      const items = Array.isArray(list) ? list : [];
      if (!items.length) {
        const li = el('li', { class: 'sc__empty' });
        li.appendChild(el('p', { class: 'sc__empty-text',
          text: 'No conversations here yet.' }));
        inboxList.appendChild(li);
        return;
      }
      const now = Date.now();
      for (const c of items) {
        const li = el('li', { class: 'sc__row-wrap' });
        const btn = el('button', {
          class: 'sc__row', type: 'button',
          'data-id': c.conversationId,
          'aria-pressed': c.conversationId === selectedId ? 'true' : 'false'
        });
        /* text: - textContent underneath. A name of "<img onerror=…>" is a
           name, not markup. */
        btn.appendChild(el('span', { class: 'sc__row-name',
          text: c.customerName || 'Someone' }));
        btn.appendChild(el('span', { class: 'sc__row-email', text: c.customerEmail }));
        const meta = el('span', { class: 'sc__row-meta' });
        /*
         * WHICH SHOP, ON EVERY ROW. A manager sees both inboxes in one list,
         * and a row that does not say where it belongs is a row that gets
         * answered by whoever reads it first. Spelled out, never colour
         * alone - and the label was derived from the id by
         * normaliseConversation(), so it is one of exactly three strings.
         */
        meta.appendChild(el('span', {
          class: 'sc__loc sc__loc--' + c.locationId,
          text: c.locationLabel
        }));
        meta.appendChild(el('span', { class: 'sc__row-time',
          text: stamp(c.lastMessageAt, now) }));
        /* The status word is spelled out as well as coloured - never colour
           alone. */
        meta.appendChild(el('span', {
          class: 'sc__pill sc__pill--' + c.status,
          text: c.status === 'closed' ? 'Closed' : 'Open'
        }));
        meta.appendChild(el('span', { class: 'sc__row-count',
          text: c.messageCount === 1 ? '1 message' : c.messageCount + ' messages' }));
        btn.appendChild(meta);
        btn.addEventListener('click', function () {
          if (typeof handlers.select === 'function') handlers.select(c.conversationId);
        });
        li.appendChild(btn);
        inboxList.appendChild(li);
      }
    },

    setSelected: function (id) {
      selectedId = typeof id === 'string' && id ? id : null;
      const rows = inboxList.querySelectorAll('.sc__row');
      for (let i = 0; i < rows.length; i++) {
        const match = rows[i].getAttribute('data-id') === selectedId;
        rows[i].setAttribute('aria-pressed', match ? 'true' : 'false');
      }
      root.setAttribute('data-view', selectedId ? 'thread' : 'inbox');
    },

    renderThread: function (data) {
      clear(log);
      if (!data || !data.conversation) {
        closedNow = false;
        composerEnabled = false;
        threadName.textContent = 'No conversation selected';
        threadEmail.textContent = '';
        threadLoc.textContent = '';
        threadLoc.hidden = true;
        threadStatus.textContent = '';
        threadStatus.className = 'sc__status';
        transferBtn.hidden = true;
        closeBtn.hidden = true;
        log.appendChild(el('p', { class: 'sc__empty-text',
          text: 'Choose a conversation on the left to read it.' }));
        syncSend();
        return;
      }

      const c = data.conversation;
      closedNow = c.status === 'closed';
      composerEnabled = !closedNow;
      threadName.textContent = c.customerName || 'Someone';
      threadEmail.textContent = c.customerEmail || '';
      threadLoc.textContent = c.locationLabel || '';
      threadLoc.className = 'sc__loc sc__loc--head sc__loc--' + c.locationId;
      threadLoc.hidden = !c.locationLabel;
      threadStatus.textContent = closedNow ? 'Closed' : 'Open';
      threadStatus.className = 'sc__status sc__pill sc__pill--' + c.status;
      /* A closed conversation does not change shop - the server refuses it
         with conversation_closed - so the button is not offered. */
      transferBtn.hidden = closedNow;
      closeBtn.hidden = closedNow;

      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (!messages.length) {
        log.appendChild(el('p', { class: 'sc__empty-text',
          text: 'No messages in this conversation yet.' }));
      } else {
        const now = Date.now();
        for (const m of messages) {
          if (m.senderType === 'system') {
            log.appendChild(el('p', { class: 'sc__sys', text: m.body }));
            continue;
          }
          const mine = m.senderType === 'staff';
          const wrap = el('div', { class: 'sc__msg sc__msg--' + (mine ? 'staff' : 'cust') });
          /* textContent. The whole reason this branch exists. */
          wrap.appendChild(el('p', { class: 'sc__bubble', text: m.body }));
          const foot = el('p', { class: 'sc__msg-meta' });
          foot.appendChild(el('span', { class: 'sc__msg-who',
            text: mine ? "Esther's" : (c.customerName || 'Customer') }));
          foot.appendChild(el('span', { class: 'sc__msg-time',
            text: stamp(m.createdAt, now) }));
          wrap.appendChild(foot);
          log.appendChild(wrap);
        }
      }

      if (closedNow) {
        log.appendChild(el('p', { class: 'sc__sys sc__sys--closed',
          text: 'This conversation is closed. The customer can still read it '
            + 'but cannot send new messages.' }));
      }
      log.scrollTop = log.scrollHeight;
      syncSend();
    },

    setSendBusy: function (flag) {
      sendBusy = flag === true;
      sendBtn.textContent = sendBusy ? 'Sending…' : 'Send';
      syncSend();
    },

    setCloseBusy: function (flag) {
      closeBtn.disabled = flag === true;
      closeBtn.textContent = flag === true ? 'Closing…' : 'Close conversation';
    },

    setTransferBusy: function (flag) {
      transferBtn.disabled = flag === true;
      transferBtn.textContent = flag === true ? 'Moving…' : 'Move to other shop';
    },

    clearComposer: function () {
      replyInput.value = '';
      syncSend();
    },

    confirmClose: function (run) {
      pendingConfirm = typeof run === 'function' ? run : null;
      lastFocus = document.activeElement;
      try {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', 'open');
      } catch (err) {
        dialog.setAttribute('open', 'open');
      }
      /* Focus the safe option, not the destructive one. */
      setTimeout(function () {
        if (typeof dlgCancel.focus === 'function') dlgCancel.focus();
      }, 20);
    },

    /*
     * Ask which shop, then hand the answer back.
     *
     * The destinations come from the controller - this file has no list of
     * shops - and are drawn as real radios inside a real <dialog>, so
     * arrow-key navigation, Escape and the focus trap all come from the
     * platform rather than from a reimplementation of it.
     *
     * NOTHING IS PRESELECTED. A default here is a mis-click away from
     * sending a conversation to a shop nobody chose.
     */
    confirmTransfer: function (options, run) {
      const items = Array.isArray(options) ? options : [];
      pendingTransfer = typeof run === 'function' ? run : null;
      xferInputs = [];
      clear(xferChoices);

      for (let i = 0; i < items.length; i++) {
        const item = items[i] || {};
        if (typeof item.id !== 'string' || !item.id) continue;
        const inputId = 'sc-xfer-' + i;
        const radio = el('input', { type: 'radio', id: inputId,
          class: 'sc__dlg-radio', name: 'sc-xfer-to' });
        radio.value = item.id;
        xferInputs.push(radio);
        const label = el('label', { class: 'sc__dlg-choice', for: inputId });
        label.appendChild(radio);
        label.appendChild(el('span', { class: 'sc__dlg-choice-text',
          text: String(item.label == null ? item.id : item.label) }));
        xferChoices.appendChild(label);
      }

      lastFocus = document.activeElement;
      try {
        if (typeof xfer.showModal === 'function') xfer.showModal();
        else xfer.setAttribute('open', 'open');
      } catch (err) {
        xfer.setAttribute('open', 'open');
      }
      /* The safe option, again. Nothing moves until somebody picks a shop
         and presses the other button. */
      if (typeof xferCancel.focus === 'function') xferCancel.focus();
    },

    onSignIn: function (h) { handlers.signIn = h; },
    onSignOut: function (h) { handlers.signOut = h; },
    onSelect: function (h) { handlers.select = h; },
    onFilter: function (h) { handlers.filter = h; },
    onRefresh: function (h) { handlers.refresh = h; },
    onSend: function (h) { handlers.send = h; },
    onClose: function (h) { handlers.close = h; },
    onBack: function (h) { handlers.back = h; },
    onLocationFilter: function (h) { handlers.locationFilter = h; },
    onTransfer: function (h) { handlers.transfer = h; }
  };
}

/*
 * Mount on the staff page, and nowhere else.
 *
 * The guard is the element: no #staff-chat, no dashboard. In Node - where the
 * tests import this module - there is no document at all, so nothing runs and
 * the controller above can be exercised with a recording ui instead.
 */
export function mount() {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('staff-chat');
  if (!root) return null;
  const ui = buildUi(root);
  if (!ui) return null;
  return startStaffChat(ui, {});
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(); });
  } else {
    mount();
  }
}
