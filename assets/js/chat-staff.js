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
 * See INBOX_POLL_MS and THREAD_POLL_MS for the intervals and the arithmetic
 * behind them.
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
} from './chat-app-check.js?v=2026-09-05.1';

/* The chat client version. THE SAME STRING as CHAT_CLIENT_VERSION in
   chat.js, chat-customer.js and chat-app-check.js, and the same string as the
   ?v= in the import above and in staff/chat/index.html. One version for the
   whole local chat graph; a test pins every copy to the others. */
export const CHAT_CLIENT_VERSION = '2026-09-05.1';

/* Pinned by path, exactly as the customer transport loads it. No cache-busting
   query: gstatic already serves an exact version per URL. */
const SDK_AUTH = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-auth.js';

/* -------------------------------------------------------------- the API */

const API_CONVERSATIONS = '/api/admin/chat/conversations';
const API_MESSAGES = '/api/admin/chat/messages';
const API_SEND = '/api/admin/chat/send';
const API_CLOSE = '/api/admin/chat/close';

/* Server-side caps, repeated here only so the client never asks for more than
   the server will give and get a 400 for its trouble. */
const MAX_INBOX = 50;
const MAX_TRANSCRIPT = 200;
const MESSAGE_MAX = 2000;

/* ------------------------------------------------------------- polling */

/*
 * WHY THESE NUMBERS, AND WHAT THEY COST.
 *
 * Neither GET spends a rate-limit allowance - conversations.js and
 * messages.js both carry needsRateSecret: false - so the constraint is
 * Firestore document reads, not the API.
 *
 * INBOX, 15 s. One indexed query returning at most MAX_INBOX documents, and
 * in practice the number of OPEN conversations, which for a sheet-metal shop
 * is a handful. Four polls a minute against ten open threads is forty
 * document reads a minute per staff browser.
 *
 * THREAD, 8 s. One indexed query returning the whole transcript, because the
 * messages endpoint has no "since" parameter - it is all or nothing. A
 * thirty-message thread left open and VISIBLE therefore costs about 225
 * document reads a minute. That is the expensive one, and it is why the
 * visibility rules below are not a nicety: a hidden tab polls nothing at all,
 * so the cost exists only while somebody is actually looking at a thread.
 *
 * If this ever becomes a real bill, the fix is a `?since=` parameter on
 * /api/admin/chat/messages so a poll returns only what is new. That is a
 * backend change and deliberately not made here.
 */
const INBOX_POLL_MS = 15 * 1000;
const THREAD_POLL_MS = 8 * 1000;

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

    /* One request of each kind in flight at a time. A poll tick that lands on
       top of a manual refresh is two requests for one answer. */
    this.inboxLoading = false;
    this.threadLoading = false;
    this.sending = false;
    this.closing = false;

    this.inboxTimer = null;
    this.threadTimer = null;
    this.onVisibility = null;

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
    this.identity = { app: app, auth: auth, authMod: authMod, user: null };

    callUi(this.ui, 'onSignIn', (fields) => this.signIn(fields));
    callUi(this.ui, 'onSignOut', () => this.signOut());
    callUi(this.ui, 'onSelect', (id) => this.select(id));
    callUi(this.ui, 'onFilter', (value) => this.setFilter(value));
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
    this.inboxFailures = 0;
    this.threadFailures = 0;
    this.inboxLoading = false;
    this.threadLoading = false;
    this.sending = false;
    this.closing = false;
    callUi(this.ui, 'setStaff', null);
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
      this.loadInbox({ silent: true });
    }, INBOX_POLL_MS);

    this.threadTimer = this.deps.setInterval(() => {
      if (this.stopped || !this.staff) { this.stopWatch(); return; }
      if (this.isHidden()) return;
      if (!this.selectedId) return;         /* nothing open to refresh */
      this.loadThread(this.selectedId, { silent: true });
    }, THREAD_POLL_MS);

    const doc = this.deps.document();
    if (doc && typeof doc.addEventListener === 'function') {
      this.onVisibility = () => {
        if (this.stopped || !this.staff) return;
        if (this.isHidden()) return;
        /* Back from a hidden tab: catch up at once rather than waiting out
           the remainder of an interval that did nothing while away. */
        this.loadInbox({ silent: true });
        if (this.selectedId) this.loadThread(this.selectedId, { silent: true });
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
    if (this.threadTimer !== null) {
      this.deps.clearInterval(this.threadTimer);
      this.threadTimer = null;
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
    const base = kind === 'inbox' ? INBOX_POLL_MS : THREAD_POLL_MS;
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
    this.conversations = list.map(normaliseConversation).filter(Boolean);
    callUi(this.ui, 'renderInbox', this.conversations);
    callUi(this.ui, 'setSelected', this.selectedId);
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
  return {
    conversationId: id,
    customerName: text(raw.customerName),
    customerEmail: text(raw.customerEmail),
    status: raw.status === 'closed' ? 'closed' : 'open',
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
  INBOX_POLL_MS, THREAD_POLL_MS, MAX_BACKOFF_MS,
  MAX_INBOX, MAX_TRANSCRIPT, MESSAGE_MAX,
  API_CONVERSATIONS, API_MESSAGES, API_SEND, API_CLOSE,
  SIGN_IN_FAILED, MESSAGES_BY_CODE,
  StaffApiError, StaffNetworkError,
  normaliseConversation, normaliseMessage, defaultDeps
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
  const threadStatus = el('span', { class: 'sc__status', text: '' });
  const closeBtn = el('button', { class: 'sc__btn sc__btn--danger', type: 'button',
    text: 'Close conversation', hidden: 'hidden' });
  threadHead.appendChild(backBtn);
  threadHead.appendChild(threadWho);
  threadHead.appendChild(threadStatus);
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

  const starting = el('p', { class: 'sc__starting', role: 'status', text: 'Starting…' });

  root.appendChild(starting);
  root.appendChild(authView);
  root.appendChild(appView);
  root.appendChild(dialog);

  /* ---- state the view keeps ----------------------------------------- */
  let handlers = {};
  let selectedId = null;
  let closedNow = false;
  let composerEnabled = false;
  let sendBusy = false;
  let pendingConfirm = null;
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
        threadStatus.textContent = '';
        threadStatus.className = 'sc__status';
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
      threadStatus.textContent = closedNow ? 'Closed' : 'Open';
      threadStatus.className = 'sc__status sc__pill sc__pill--' + c.status;
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

    onSignIn: function (h) { handlers.signIn = h; },
    onSignOut: function (h) { handlers.signOut = h; },
    onSelect: function (h) { handlers.select = h; },
    onFilter: function (h) { handlers.filter = h; },
    onRefresh: function (h) { handlers.refresh = h; },
    onSend: function (h) { handlers.send = h; },
    onClose: function (h) { handlers.close = h; },
    onBack: function (h) { handlers.back = h; }
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
