/*
 * THE STAFF CHAT INBOX: assets/js/chat-staff.js, staff/chat/index.html and
 * assets/css/chat-staff.css.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT.
 *
 * It cannot mint a real App Check token or sign a real staff account in. The
 * reCAPTCHA Enterprise key is restricted to esthers.ca and attestation is
 * performed by a browser against the page's own hostname, so no token exists
 * outside a page served from there; and nothing in this container knows a
 * staff password, nor should it. docs/STAFF_CHAT_DASHBOARD.md carries the
 * manual walkthrough that closes the remaining gap on production.
 *
 * What it does prove is every rule up to that boundary, against the REAL
 * chat-app-check.js rather than a stand-in - so the ORDER (App Check before
 * anything) and the HEADER SEPARATION (ID token in Authorization, App Check
 * token in X-Firebase-AppCheck, never swapped) are assertions about observed
 * behaviour rather than a reading of the source.
 *
 * HOW. Each module is read from disk, its SDK specifiers rewritten to the
 * local stub, and imported as a data: URL. chat-staff.js imports
 * chat-app-check.js by relative path, which a data: URL cannot resolve, so
 * that specifier is rewritten to the data: URL of the rewritten
 * chat-app-check.js - the real module, reachable from the real importer.
 *
 * NO NETWORK. NO PRODUCTION CONTACT. NO FIREBASE PROJECT. NO PASSWORDS.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { codeOnly, codeAndStrings } from './fixtures/source-view.mjs';

const ROOT = '/home/user/esthers';
const STAFF_PATH = ROOT + '/assets/js/chat-staff.js';
const APP_CHECK_PATH = ROOT + '/assets/js/chat-app-check.js';
const CUSTOMER_PATH = ROOT + '/assets/js/chat-customer.js';
const WIDGET_PATH = ROOT + '/assets/js/chat.js';
const PAGE_PATH = ROOT + '/staff/chat/index.html';
const CSS_PATH = ROOT + '/assets/css/chat-staff.css';
const LOCATIONS_PATH = ROOT + '/assets/js/chat-locations.js';
const ALERTS_PATH = ROOT + '/assets/js/chat-staff-alerts.js';
const STUB_PATH = ROOT + '/tests/chat-api/fixtures/firebase-staff-stub.mjs';

const STAFF_SRC = readFileSync(STAFF_PATH, 'utf8');
const APP_CHECK_SRC = readFileSync(APP_CHECK_PATH, 'utf8');
const CUSTOMER_SRC = readFileSync(CUSTOMER_PATH, 'utf8');
const WIDGET_SRC = readFileSync(WIDGET_PATH, 'utf8');
const PAGE_SRC = readFileSync(PAGE_PATH, 'utf8');
const CSS_SRC = readFileSync(CSS_PATH, 'utf8');

const STUB_URL = pathToFileURL(STUB_PATH).href;

/* The real shop definitions - see the same note in chat-customer.test.mjs.
   Nothing to stub: the file imports nothing, and the labels it holds are
   exactly what these tests are checking reaches the screen. */
const LOCATIONS_URL = pathToFileURL(LOCATIONS_PATH).href;

/* The real alert engine, not a stub: its dedupe, cooldown and wording are
   exactly what several tests below are checking. Every browser API it uses
   is injectable, so it runs in Node unchanged. */
const ALERTS_URL = pathToFileURL(ALERTS_PATH).href;

/* The reminder cooldown, read from the module rather than restated, so a
   change to it moves these tests with it instead of breaking them. */
const REMINDER_WINDOW = (await import(ALERTS_URL)).REMINDER_MS;

/* Read as CODE - comments blanked, string literals kept - for the same reason
   every other source assertion in this file is: these modules explain
   themselves at length and the prose names the very things they promise not
   to do. */
const ALERTS_CODE = codeAndStrings(readFileSync(ALERTS_PATH, 'utf8'));

/* These files document themselves at length, and the prose names the very
   things the assertions promise are absent - "no innerHTML anywhere in this
   file". Searching the raw text would fail on the documentation. */
const STAFF_CODE = codeAndStrings(STAFF_SRC);
const STAFF_IDENTS = codeOnly(STAFF_SRC);

function dataUrl(source) {
  return 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
}

let salt = 0;
async function load() {
  salt += 1;

  const appCheckSrc = APP_CHECK_SRC
    .replace(/const SDK_APP = [^;]+;/, `const SDK_APP = ${JSON.stringify(STUB_URL)};`)
    .replace(/const SDK_APP_CHECK = [^;]+;/, `const SDK_APP_CHECK = ${JSON.stringify(STUB_URL)};`)
    + `\n/* cache-bust ${salt} */\n`;
  const appCheckUrl = dataUrl(appCheckSrc);

  const staffSrc = STAFF_SRC
    .replace(/const SDK_AUTH = [^;]+;/, `const SDK_AUTH = ${JSON.stringify(STUB_URL)};`)
    .replace(/from '\.\/chat-app-check\.js(\?[^']*)?'/, `from ${JSON.stringify(appCheckUrl)}`)
    .replace(/from '\.\/chat-locations\.js(\?[^']*)?'/, `from ${JSON.stringify(LOCATIONS_URL)}`)
    .replace(/from '\.\/chat-staff-alerts\.js(\?[^']*)?'/, `from ${JSON.stringify(ALERTS_URL)}`)
    + `\n/* cache-bust ${salt} */\n`;

  const mod = await import(dataUrl(staffSrc));
  const appCheck = await import(appCheckUrl);
  const stub = await import(STUB_URL);
  stub.reset();
  appCheck._reset();
  return { mod, appCheck, stub };
}

/* A ui that records instead of drawing. Every method the controller can call,
   so a missing one can never be the reason a test passes. */
function recordingUi() {
  const ui = {
    calls: [],
    phase: null, phases: [],
    authError: null, authErrors: [],
    authBusy: null,
    passwordCleared: 0,
    staff: null, staffHistory: [],
    notice: null, notices: [],
    retry: null,
    filter: null,
    inboxBusy: null, threadBusy: null,
    inbox: null, inboxRenders: 0,
    selected: null, selections: [],
    thread: null, threadRenders: 0,
    sendBusy: null, closeBusy: null,
    composerCleared: 0,
    confirmRequests: 0, lastConfirm: null,
    locationFilters: null, locationFiltersHistory: [],
    locationFilter: null, locationFilterHistory: [],
    transferBusy: null,
    transferRequests: 0, lastTransferOptions: null, lastTransfer: null,
    handlers: {}
  };
  ui.setPhase = (p) => { ui.calls.push('setPhase:' + p); ui.phase = p; ui.phases.push(p); };
  ui.setAuthBusy = (f) => { ui.calls.push('setAuthBusy'); ui.authBusy = f; };
  ui.setAuthError = (t) => { ui.calls.push('setAuthError'); ui.authError = t; ui.authErrors.push(t); };
  ui.clearPassword = () => { ui.calls.push('clearPassword'); ui.passwordCleared += 1; };
  ui.setStaff = (s) => { ui.calls.push('setStaff'); ui.staff = s; ui.staffHistory.push(s); };
  ui.setNotice = (t) => { ui.calls.push('setNotice'); ui.notice = t; ui.notices.push(t); };
  ui.setRetry = (h) => { ui.calls.push('setRetry'); ui.retry = h; };
  ui.setFilter = (v) => { ui.calls.push('setFilter'); ui.filter = v; };
  ui.setInboxBusy = (f) => { ui.calls.push('setInboxBusy'); ui.inboxBusy = f; };
  ui.setThreadBusy = (f) => { ui.calls.push('setThreadBusy'); ui.threadBusy = f; };
  ui.renderInbox = (l) => { ui.calls.push('renderInbox'); ui.inbox = l; ui.inboxRenders += 1; };
  ui.setSelected = (id) => { ui.calls.push('setSelected'); ui.selected = id; ui.selections.push(id); };
  ui.renderThread = (t) => { ui.calls.push('renderThread'); ui.thread = t; ui.threadRenders += 1; };
  ui.setSendBusy = (f) => { ui.calls.push('setSendBusy'); ui.sendBusy = f; };
  ui.setCloseBusy = (f) => { ui.calls.push('setCloseBusy'); ui.closeBusy = f; };
  ui.clearComposer = () => { ui.calls.push('clearComposer'); ui.composerCleared += 1; };
  ui.confirmClose = (run) => {
    ui.calls.push('confirmClose');
    ui.confirmRequests += 1;
    ui.lastConfirm = run;
  };
  ui.setLocationFilters = (l) => {
    ui.calls.push('setLocationFilters');
    ui.locationFilters = l;
    ui.locationFiltersHistory.push(l);
  };
  ui.alertStatus = null;
  ui.setAlertStatus = (st) => { ui.calls.push('setAlertStatus'); ui.alertStatus = st; };
  ui.unreadCounts = null;
  ui.setUnreadCounts = (c) => { ui.calls.push('setUnreadCounts'); ui.unreadCounts = c; };
  ui.setLocationFilter = (v) => {
    ui.calls.push('setLocationFilter');
    ui.locationFilter = v;
    ui.locationFilterHistory.push(v);
  };
  ui.setTransferBusy = (f) => { ui.calls.push('setTransferBusy'); ui.transferBusy = f; };
  ui.confirmTransfer = (options, run) => {
    ui.calls.push('confirmTransfer');
    ui.transferRequests += 1;
    ui.lastTransferOptions = options;
    ui.lastTransfer = run;
  };
  ui.onSignIn = (h) => { ui.handlers.signIn = h; };
  ui.onSignOut = (h) => { ui.handlers.signOut = h; };
  ui.onSelect = (h) => { ui.handlers.select = h; };
  ui.onFilter = (h) => { ui.handlers.filter = h; };
  ui.onRefresh = (h) => { ui.handlers.refresh = h; };
  ui.onSend = (h) => { ui.handlers.send = h; };
  ui.onClose = (h) => { ui.handlers.close = h; };
  ui.onBack = (h) => { ui.handlers.back = h; };
  ui.onLocationFilter = (h) => { ui.handlers.locationFilter = h; };
  ui.onTransfer = (h) => { ui.handlers.transfer = h; };
  return ui;
}

/* A hand-driven clock. Nothing fires on its own, so a timer the code forgot
   to clear shows up as a callback still registered rather than as a flake. */
function fakeClock() {
  const timers = new Map();
  let next = 1;
  let clock = 1000;
  const doc = {
    hidden: false,
    listeners: {},
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = doc.listeners[type] || [];
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    }
  };
  return {
    deps: {
      setInterval: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
      clearInterval: (id) => { timers.delete(id); },
      document: () => doc,
      now: () => clock
    },
    doc,
    advance: (ms) => { clock += ms; },
    liveTimers: () => timers.size,
    intervals: () => Array.from(timers.values()).map((t) => t.ms).sort((a, b) => a - b),
    fireAll: () => { for (const t of Array.from(timers.values())) t.fn(); },
    visibilityListeners: () => (doc.listeners.visibilitychange || []).length,
    hide: () => { doc.hidden = true; },
    show: () => {
      doc.hidden = false;
      for (const fn of (doc.listeners.visibilitychange || []).slice()) fn();
    }
  };
}

function captureFetch(responder) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    seen.push({ input: String(input), init });
    const answer = typeof responder === 'function' ? responder(seen.length, String(input), init) : responder;
    if (answer instanceof Error) throw answer;
    return answer || jsonResponse(200, { ok: true });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function tick(times = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

/* One at each shop, so the ordinary rendering paths in this suite carry a
   real destination rather than only the legacy no-locationId case - which
   has its own tests. locationLabel is sent by the API and deliberately
   ignored by the client, which is also asserted below. */
const CONV_A = {
  conversationId: 'conv-a', customerName: 'Dana Fraser',
  customerEmail: 'dana@example.com', status: 'open',
  locationId: 'main', locationLabel: 'Main Shop - 1st Avenue',
  createdAt: 1000, lastMessageAt: 5000, messageCount: 3, staffLastReadAt: null
};
const CONV_B = {
  conversationId: 'conv-b', customerName: 'Sam Okafor',
  customerEmail: 'sam@example.com', status: 'open',
  locationId: 'specialty', locationLabel: 'Specialty Shop - Keith Street',
  createdAt: 900, lastMessageAt: 4000, messageCount: 1, staffLastReadAt: null
};
/* A manager: authorised for all three, which is what makes the filter chips
   appear at all. Single-shop accounts get their own tests. */
const INBOX_OK = { ok: true, conversations: [CONV_A, CONV_B], status: 'open',
  limit: 50, locations: ['main', 'specialty', 'unassigned'] };
const THREAD_OK = {
  ok: true,
  conversation: CONV_A,
  messages: [
    { messageId: 'm1', conversationId: 'conv-a', senderType: 'customer',
      body: 'Do you cut stainless?', createdAt: 1000 },
    { messageId: 'm2', conversationId: 'conv-a', senderType: 'staff',
      body: 'We do. What thickness?', createdAt: 2000 }
  ],
  limit: 200
};

/* Answers every staff endpoint sensibly; a test overrides what it cares about. */
function staffApi(overrides) {
  const o = overrides || {};
  return (n, input) => {
    if (input.indexOf('/api/admin/chat/conversations') === 0) {
      return o.conversations ? o.conversations(n, input) : jsonResponse(200, INBOX_OK);
    }
    if (input.indexOf('/api/admin/chat/messages') === 0) {
      return o.messages ? o.messages(n, input) : jsonResponse(200, THREAD_OK);
    }
    if (input.indexOf('/api/admin/chat/send') === 0) {
      return o.send ? o.send(n, input) : jsonResponse(200,
        { ok: true, messageId: 'm3', conversationId: 'conv-a' });
    }
    if (input.indexOf('/api/admin/chat/close') === 0) {
      return o.close ? o.close(n, input) : jsonResponse(200,
        { ok: true, conversationId: 'conv-a', status: 'closed' });
    }
    if (input.indexOf('/api/admin/chat/transfer') === 0) {
      return o.transfer ? o.transfer(n, input) : jsonResponse(200,
        { ok: true, conversationId: 'conv-a', locationId: 'specialty',
          locationLabel: 'Specialty Shop - Keith Street',
          previousLocationId: 'main',
          previousLocationLabel: 'Main Shop - 1st Avenue', changed: true });
    }
    return jsonResponse(500, { ok: false, code: 'unexpected_call' });
  };
}

/* Drive the dashboard to a signed-in, authorised inbox. */
async function signedIn(mod, opts = {}) {
  const ui = recordingUi();
  const clock = opts.clock || fakeClock();
  const fetcher = captureFetch(opts.responder || staffApi());
  const session = await mod.startStaffChat(ui,
    { deps: Object.assign({}, clock.deps, opts.deps || {}) });
  await tick();
  if (!opts.alreadySignedIn) {
    await ui.handlers.signIn({ email: 'manager@esthers.ca', password: 'not-a-real-password' });
    await tick();
  }
  return { ui, clock, fetcher, session };
}

/* ==================================================== 1-10. AUTH / SECURITY */

describe('the staff dashboard authenticates before it shows anything', () => {
  test('APP CHECK RUNS FIRST - before auth, before any staff request',
    async () => {
      const { mod, stub } = await load();
      const clock = fakeClock();
      const fetcher = captureFetch(staffApi());
      try {
        await mod.startStaffChat(recordingUi(), { deps: clock.deps });
        await tick();
        /* Observed order, from the real chat-app-check.js driving the stub. */
        const first = stub.order.indexOf('initializeAppCheck');
        const app = stub.order.indexOf('initializeApp');
        const auth = stub.order.indexOf('getAuth');
        assert.ok(first !== -1, 'App Check was initialised');
        assert.ok(app !== -1 && app < first, 'the shared app came first');
        assert.ok(auth === -1 || first < auth, 'App Check preceded Firebase Auth');
        assert.equal(fetcher.seen.length, 0,
          'and not one staff request was made before sign-in');
      } finally {
        fetcher.restore();
      }
    });

  test('a page with no Firebase session shows the sign-in form and loads nothing',
    async () => {
      const { mod } = await load();
      const clock = fakeClock();
      const fetcher = captureFetch(staffApi());
      try {
        const session = await mod.startStaffChat(recordingUi(), { deps: clock.deps });
        await tick();
        assert.equal(session.ui.phase, 'signed-out');
        assert.equal(session.conversations.length, 0);
        assert.equal(fetcher.seen.length, 0, 'no privileged request without a session');
        assert.equal(clock.liveTimers(), 0, 'and no polling');
      } finally {
        fetcher.restore();
      }
    });

  test('a valid ACTIVE staff account reaches the inbox', async () => {
    const { mod } = await load();
    const { ui, session, fetcher } = await signedIn(mod);
    try {
      assert.equal(ui.phase, 'ready');
      assert.equal(session.conversations.length, 2);
      assert.deepEqual(ui.staff, { email: 'manager@esthers.ca' });
    } finally {
      fetcher.restore();
    }
  });

  test('an INACTIVE staff account is refused and left signed out', async () => {
    const { mod, stub } = await load();
    const { ui, session, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => jsonResponse(403, { ok: false, code: 'staff_inactive' })
      })
    });
    try {
      assert.equal(ui.phase, 'signed-out');
      assert.match(String(ui.authError), /not authorised/i);
      assert.equal(session.conversations.length, 0, 'nothing privileged was kept');
      assert.equal(ui.inbox && ui.inbox.length, 0, 'and nothing was rendered');
      assert.ok(stub.signOutCalls >= 1, 'Firebase Auth was signed out too');
    } finally {
      fetcher.restore();
    }
  });

  test('a WRONG-ROLE staff account is refused', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => jsonResponse(403, { ok: false, code: 'staff_role' })
      })
    });
    try {
      assert.equal(ui.phase, 'signed-out');
      assert.match(String(ui.authError), /not authorised/i);
    } finally {
      fetcher.restore();
    }
  });

  test('an account with NO staff document is refused', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => jsonResponse(403, { ok: false, code: 'not_staff' })
      })
    });
    try {
      assert.equal(ui.phase, 'signed-out');
      assert.match(String(ui.authError), /not authorised/i);
    } finally {
      fetcher.restore();
    }
  });

  test('AN ANONYMOUS CUSTOMER SESSION CANNOT DRIVE THE STAFF DASHBOARD',
    async () => {
      /*
       * The dashboard never inspects the provider itself - the server does,
       * and answers 403 not_staff for an anonymous uid before it even reads
       * the staff collection. What this asserts is that the client HONOURS
       * that answer rather than showing an inbox anyway.
       */
      const { mod, stub } = await load();
      stub.seedRestoredUser({
        uid: 'anon-uid-1', email: null, isAnonymous: true,
        getIdToken: async () => 'anon-token'
      });
      const clock = fakeClock();
      const fetcher = captureFetch(staffApi({
        conversations: () => jsonResponse(403, { ok: false, code: 'not_staff' })
      }));
      try {
        const session = await mod.startStaffChat(recordingUi(), { deps: clock.deps });
        await tick();
        assert.equal(session.ui.phase, 'signed-out');
        assert.equal(session.staff, null);
        assert.equal(session.conversations.length, 0);
        assert.equal(clock.liveTimers(), 0, 'no polling for an unauthorised session');
      } finally {
        fetcher.restore();
      }
    });

  test('a refusal MID-SESSION clears the privileged view, then signs out',
    async () => {
      const { mod, stub } = await load();
      let phase = 'ok';
      const { ui, session, fetcher } = await signedIn(mod, {
        responder: staffApi({
          conversations: () => phase === 'ok'
            ? jsonResponse(200, INBOX_OK)
            : jsonResponse(401, { ok: false, code: 'invalid_token' })
        })
      });
      try {
        assert.equal(ui.phase, 'ready');
        assert.equal(ui.inbox.length, 2, 'customer names were on screen');

        phase = 'revoked';
        await session.loadInbox({});
        await tick();

        assert.equal(session.conversations.length, 0, 'state cleared');
        assert.equal(ui.inbox.length, 0, 'AND the view was blanked');
        assert.equal(ui.thread, null);
        assert.equal(ui.staff, null);
        assert.equal(ui.phase, 'signed-out');
        assert.ok(stub.signOutCalls >= 1);
        assert.equal(session.inboxTimer, null, 'the timer stopped');
        assert.equal(session.threadMarker, null, 'and the change marker cleared');
      } finally {
        fetcher.restore();
      }
    });

  test('a page refresh with a live Firebase session restores the inbox',
    async () => {
      const { mod, stub } = await load();
      stub.seedRestoredUser({
        uid: 'staff-1', email: 'manager@esthers.ca', isAnonymous: false,
        getIdToken: async () => 'staff-id-token'
      });
      const clock = fakeClock();
      const fetcher = captureFetch(staffApi());
      try {
        const session = await mod.startStaffChat(recordingUi(), { deps: clock.deps });
        await tick();
        assert.equal(session.ui.phase, 'ready', 'no sign-in form for a live session');
        assert.equal(session.conversations.length, 2);
      } finally {
        fetcher.restore();
      }
    });

  test('every sign-in failure gives the SAME message - no account oracle',
    async () => {
      const { mod, stub } = await load();
      const seen = new Set();
      for (const code of ['auth/wrong-password', 'auth/user-not-found',
                          'auth/invalid-email', 'auth/user-disabled']) {
        const clock = fakeClock();
        const fetcher = captureFetch(staffApi());
        try {
          stub.reset();
          stub.setSignInError(Object.assign(new Error(code), { code }));
          const ui = recordingUi();
          await mod.startStaffChat(ui, { deps: clock.deps });
          await tick();
          await ui.handlers.signIn({ email: 'someone@example.com', password: 'x' });
          await tick();
          seen.add(String(ui.authError));
          assert.equal(ui.phase, 'signed-out');
        } finally {
          fetcher.restore();
        }
      }
      assert.equal(seen.size, 1,
        'one sentence for every failure: ' + JSON.stringify(Array.from(seen)));
    });

  test('the password is never stored, echoed or kept', async () => {
    const { mod } = await load();
    const { ui, session, fetcher } = await signedIn(mod);
    try {
      const dump = JSON.stringify(session, (k, v) =>
        (typeof v === 'function' ? '[fn]' : v));
      assert.equal(dump.indexOf('not-a-real-password'), -1,
        'the password is nowhere on the session object');
      assert.ok(ui.passwordCleared >= 1, 'and the field was cleared');

      /* And it never left in a request body either. */
      for (const r of fetcher.seen) {
        const body = r.init && r.init.body ? String(r.init.body) : '';
        assert.equal(body.indexOf('not-a-real-password'), -1);
        assert.equal(body.toLowerCase().indexOf('password'), -1);
      }
    } finally {
      fetcher.restore();
    }
  });

  test('NO token or password touches storage, cookies or a URL', () => {
    /* Source-level, because the only honest way to prove a thing never
       happens is that the code to do it is not there. */
    assert.equal(/localStorage/.test(STAFF_CODE), false, 'no localStorage');
    assert.equal(/sessionStorage/.test(STAFF_CODE), false, 'no sessionStorage');
    assert.equal(/document\.cookie/.test(STAFF_CODE), false, 'no cookies');
    assert.equal(/indexedDB/i.test(STAFF_CODE), false, 'no IndexedDB');

    /* No credential is ever put in a query string. The only two things
       appended to a URL are a conversation id and a status filter. */
    const appended = STAFF_CODE.match(/encodeURIComponent\(([^)]*)\)/g) || [];
    for (const a of appended) {
      assert.equal(/token|password|secret|auth/i.test(a), false,
        'nothing credential-shaped in a URL: ' + a);
    }
    /* And nothing is logged. */
    assert.equal(/console\.(log|info|warn|error|debug)/.test(STAFF_CODE), false,
      'the module logs nothing at all');
  });
});

/* ============================================== 11-18. THE API CONTRACTS */

describe('the dashboard speaks the existing staff API exactly', () => {
  const urlsFor = (fetcher, path) =>
    fetcher.seen.filter((r) => r.input.indexOf(path) === 0);

  test('the inbox uses GET /api/admin/chat/conversations with status and limit',
    async () => {
      const { mod } = await load();
      const { fetcher } = await signedIn(mod);
      try {
        const calls = urlsFor(fetcher, '/api/admin/chat/conversations');
        assert.ok(calls.length >= 1);
        assert.equal(calls[0].init.method, 'GET');
        assert.equal(calls[0].init.body, undefined, 'a GET carries no body');
        assert.match(calls[0].input, /[?&]status=open(&|$)/);
        assert.match(calls[0].input, /[?&]limit=50(&|$)/,
          'limit is the server maximum, MAX_INBOX');
      } finally {
        fetcher.restore();
      }
    });

  test('the transcript uses GET /api/admin/chat/messages with conversationId',
    async () => {
      const { mod } = await load();
      const { session, fetcher } = await signedIn(mod);
      try {
        session.select('conv-a');
        await tick();
        const calls = urlsFor(fetcher, '/api/admin/chat/messages');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.method, 'GET');
        assert.equal(calls[0].init.body, undefined);
        assert.match(calls[0].input, /[?&]conversationId=conv-a(&|$)/);
        assert.match(calls[0].input, /[?&]limit=200(&|$)/,
          'limit is MAX_TRANSCRIPT');
      } finally {
        fetcher.restore();
      }
    });

  test('a reply uses POST /api/admin/chat/send with exactly three fields',
    async () => {
      const { mod } = await load();
      const { session, fetcher } = await signedIn(mod);
      try {
        session.select('conv-a');
        await tick();
        await session.send({ message: 'On its way.' });
        await tick();

        const calls = urlsFor(fetcher, '/api/admin/chat/send');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.method, 'POST');
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(Object.keys(body).sort(),
          ['clientMessageId', 'conversationId', 'message']);
        assert.equal(body.conversationId, 'conv-a');
        assert.equal(body.message, 'On its way.');
        /* senderType is the server's to set; sending it is rejected outright
           by requireNoPrivilegedFields. */
        assert.equal(body.senderType, undefined);
        assert.equal(body.staffUserId, undefined);
      } finally {
        fetcher.restore();
      }
    });

  test('closing uses POST /api/admin/chat/close with only conversationId',
    async () => {
      const { mod } = await load();
      const { session, fetcher } = await signedIn(mod);
      try {
        session.select('conv-a');
        await tick();
        await session.close();
        await tick();

        const calls = urlsFor(fetcher, '/api/admin/chat/close');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.method, 'POST');
        const body = JSON.parse(calls[0].init.body);
        assert.deepEqual(Object.keys(body), ['conversationId']);
        assert.equal(body.conversationId, 'conv-a');
        assert.equal(body.status, undefined, "status is the server's to set");
      } finally {
        fetcher.restore();
      }
    });

  test('EVERY request carries BOTH credentials, in their own headers',
    async () => {
      const { mod } = await load();
      const { session, fetcher } = await signedIn(mod);
      try {
        session.select('conv-a');
        await tick();
        await session.send({ message: 'hello' });
        await session.close();
        await tick();

        assert.ok(fetcher.seen.length >= 4, 'all four endpoints exercised');
        for (const r of fetcher.seen) {
          const h = r.init.headers;
          const auth = h.get ? h.get('authorization') : h['Authorization'];
          const ac = h.get ? h.get('x-firebase-appcheck') : h['X-Firebase-AppCheck'];
          assert.ok(auth && auth.indexOf('Bearer ') === 0,
            'Authorization is a bearer ID token: ' + r.input);
          assert.ok(ac, 'X-Firebase-AppCheck is attached: ' + r.input);

          /* THE SEPARATION. Neither token is in the other's channel. */
          assert.equal(auth.indexOf('stub.app.check.token'), -1,
            'the App Check token is NOT in Authorization');
          assert.notEqual(ac.indexOf('stub.app.check.token'), -1,
            'the App Check token IS in its own header');
          assert.equal(ac.indexOf('Bearer'), -1,
            'the ID token is NOT in X-Firebase-AppCheck');
        }
      } finally {
        fetcher.restore();
      }
    });

  test('the App Check header is never assembled by this module', () => {
    /* It comes from authorizedFetch() in chat-app-check.js. A header this
       file cannot name is a header it cannot put in the wrong place. */
    assert.equal(/X-Firebase-AppCheck/i.test(STAFF_CODE), false);
    assert.match(STAFF_CODE, /authorizedFetch/);
  });

  test('clientMessageId is a v4 UUID the server will accept', async () => {
    const { mod } = await load();
    /* The server's own regular expression, from api/_chat/validation.js. */
    const SERVER_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (let i = 0; i < 40; i++) {
      assert.match(mod.newClientMessageId(), SERVER_RE);
    }
    const validation = readFileSync(ROOT + '/api/_chat/validation.js', 'utf8');
    assert.ok(validation.indexOf(SERVER_RE.source) !== -1,
      'and that IS the expression the server uses, not a copy that has drifted');
  });

  test('NO DIRECT FIRESTORE ACCESS OF ANY KIND', () => {
    /*
     * The whole reason this dashboard is server-mediated. firestore.rules
     * gives a staff browser no chat read at all, and this is the test that
     * stops somebody "fixing" a latency complaint by opening one.
     */
    for (const api of ['getFirestore', 'collection', 'doc', 'query', 'where',
                       'orderBy', 'limit', 'onSnapshot', 'getDocs', 'getDoc',
                       'setDoc', 'addDoc', 'updateDoc', 'deleteDoc',
                       'writeBatch', 'runTransaction', 'serverTimestamp']) {
      assert.equal(new RegExp('\\b' + api + '\\s*\\(').test(STAFF_IDENTS), false,
        'the staff module must not call ' + api + '()');
    }
    assert.equal(/firebase-firestore/.test(STAFF_CODE), false,
      'and it never even loads the Firestore SDK');
    assert.equal(/chatConversations|chatMessages/.test(STAFF_IDENTS), false,
      'nor names a chat collection in code');
  });

  test('every chat request goes to /api/admin/chat/*', () => {
    const paths = (STAFF_CODE.match(/'\/api\/[^']*'/g) || [])
      .map((s) => s.replace(/'/g, ''));
    assert.deepEqual(paths.sort(), [
      '/api/admin/chat/close',
      '/api/admin/chat/conversations',
      '/api/admin/chat/messages',
      '/api/admin/chat/read',
      '/api/admin/chat/send',
      '/api/admin/chat/transfer'
    ]);
  });
});

/* ============================================== 19-30. RENDERING AND STATE */

describe('the dashboard renders hostile content as text', () => {
  const HOSTILE_NAME = '<img src=x onerror="alert(1)">';
  const HOSTILE_EMAIL = '"><script>alert(2)</script>@example.com';
  const HOSTILE_BODY = '<script>alert(3)</script><b>bold</b>';

  test('NO innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    assert.equal(/innerHTML/.test(STAFF_CODE), false);
    assert.equal(/outerHTML/.test(STAFF_CODE), false);
    assert.equal(/insertAdjacentHTML/.test(STAFF_CODE), false);
    assert.equal(/document\.write/.test(STAFF_CODE), false);
    /* And nothing that evaluates a string. */
    assert.equal(/\beval\s*\(/.test(STAFF_IDENTS), false);
    assert.equal(/new Function\s*\(/.test(STAFF_IDENTS), false);
  });

  test('a hostile customer name, email and body survive normalisation as text',
    async () => {
      const { mod } = await load();
      const { session, ui, fetcher } = await signedIn(mod, {
        responder: staffApi({
          conversations: () => jsonResponse(200, {
            ok: true, status: 'open', limit: 50,
            conversations: [Object.assign({}, CONV_A, {
              customerName: HOSTILE_NAME, customerEmail: HOSTILE_EMAIL
            })]
          }),
          messages: () => jsonResponse(200, {
            ok: true, limit: 200,
            conversation: Object.assign({}, CONV_A, {
              customerName: HOSTILE_NAME, customerEmail: HOSTILE_EMAIL
            }),
            messages: [{ messageId: 'm1', conversationId: 'conv-a',
              senderType: 'customer', body: HOSTILE_BODY, createdAt: 1 }]
          })
        })
      });
      try {
        session.select('conv-a');
        await tick();
        /* The controller hands the UI the exact characters - unescaped,
           unmangled - and the UI's contract is textContent. Nothing here
           tries to sanitise, because sanitising is what goes wrong. */
        assert.equal(ui.inbox[0].customerName, HOSTILE_NAME);
        assert.equal(ui.inbox[0].customerEmail, HOSTILE_EMAIL);
        assert.equal(ui.thread.messages[0].body, HOSTILE_BODY);
        assert.equal(ui.thread.conversation.customerName, HOSTILE_NAME);
      } finally {
        fetcher.restore();
      }
    });

  test('the UI writes customer values through text/textContent only', () => {
    /* The three places a customer value reaches the page. */
    assert.match(STAFF_CODE, /text: c\.customerName \|\| 'Someone'/);
    assert.match(STAFF_CODE, /text: c\.customerEmail/);
    assert.match(STAFF_CODE, /text: m\.body/);
    assert.match(STAFF_CODE, /threadName\.textContent = c\.customerName/);
    assert.match(STAFF_CODE, /threadEmail\.textContent = c\.customerEmail/);
    /* el() assigns textContent for `text`, and setAttribute otherwise. */
    assert.match(STAFF_CODE,
      /node\.textContent = String\(o\[key\] == null \? '' : o\[key\]\)/);
  });

  test('a non-string body or name cannot smuggle an object through', async () => {
    const { mod } = await load();
    const norm = mod._internals.normaliseMessage(
      { messageId: 'm', body: { toString: () => 'nope' }, senderType: 'customer' });
    assert.equal(norm.body, '', 'anything not a string becomes an empty string');
    const conv = mod._internals.normaliseConversation(
      { conversationId: 'c', customerName: 12345, messageCount: -4 });
    assert.equal(conv.customerName, '');
    assert.equal(conv.messageCount, 0, 'a negative count is not rendered');
  });

  test('messages render oldest-first, whatever order they arrive in',
    async () => {
      const { mod } = await load();
      const { session, ui, fetcher } = await signedIn(mod, {
        responder: staffApi({
          messages: () => jsonResponse(200, {
            ok: true, limit: 200, conversation: CONV_A,
            messages: [
              { messageId: 'm3', conversationId: 'conv-a', senderType: 'staff', body: 'third', createdAt: 3000 },
              { messageId: 'm1', conversationId: 'conv-a', senderType: 'customer', body: 'first', createdAt: 1000 },
              { messageId: 'm2', conversationId: 'conv-a', senderType: 'customer', body: 'second', createdAt: 2000 }
            ]
          })
        })
      });
      try {
        session.select('conv-a');
        await tick();
        assert.deepEqual(ui.thread.messages.map((m) => m.body),
          ['first', 'second', 'third']);
      } finally {
        fetcher.restore();
      }
    });

  test('selecting a conversation sets and clears the selection', async () => {
    const { mod } = await load();
    const { session, ui, fetcher } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      assert.equal(ui.selected, 'conv-a');
      assert.equal(session.selectedId, 'conv-a');
      assert.ok(ui.thread, 'the thread rendered');

      session.select(null);
      await tick();
      assert.equal(ui.selected, null);
      assert.equal(ui.thread, null, 'and the thread was blanked');
    } finally {
      fetcher.restore();
    }
  });

  test('a reply that lands while another is in flight is refused', async () => {
    const { mod } = await load();
    let sends = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { session, fetcher } = await signedIn(mod, {
      responder: staffApi({
        send: async () => {
          sends += 1;
          await gate;
          return jsonResponse(200, { ok: true, messageId: 'm9', conversationId: 'conv-a' });
        }
      })
    });
    try {
      session.select('conv-a');
      await tick();
      const first = session.send({ message: 'one' });
      await tick(1);
      const second = await session.send({ message: 'two' });
      assert.equal(second, null, 'the second press did nothing');
      release();
      await first;
      await tick();
      assert.equal(sends, 1, 'exactly one request left the browser');
    } finally {
      fetcher.restore();
    }
  });

  test('a failed send offers a retry that reuses the SAME clientMessageId',
    async () => {
      /*
       * The idempotency contract. peekMessage() on the server returns the
       * stored result for a key it has seen, so the same key cannot append a
       * second copy - and a fresh key would.
       */
      const { mod } = await load();
      let attempt = 0;
      const ids = [];
      const { session, ui, fetcher } = await signedIn(mod, {
        responder: staffApi({
          send: (n, input) => {
            attempt += 1;
            return attempt === 1
              ? jsonResponse(500, { ok: false, code: 'server_error' })
              : jsonResponse(200, { ok: true, messageId: 'm9', conversationId: 'conv-a' });
          }
        })
      });
      try {
        session.select('conv-a');
        await tick();
        await session.send({ message: 'important' });
        await tick();
        assert.equal(typeof ui.retry, 'function', 'a retry was offered');

        await ui.retry();
        await tick();

        for (const r of fetcher.seen) {
          if (r.input.indexOf('/api/admin/chat/send') !== 0) continue;
          ids.push(JSON.parse(r.init.body).clientMessageId);
        }
        assert.equal(ids.length, 2, 'two attempts');
        assert.equal(ids[0], ids[1],
          'ONE message, two attempts - the key travelled with the retry');
      } finally {
        fetcher.restore();
      }
    });

  test('there is NO automatic retry for an ambiguous send failure',
    async () => {
      /*
       * A send that times out may well have been stored - it is the RESPONSE
       * that was lost. Retrying on the machine's initiative is how a customer
       * gets told the same thing twice, so the retry is a button, not a timer.
       * Asserted from behaviour: a failed send must produce exactly one
       * request and then wait for a person.
       */
      const { mod } = await load();
      let sends = 0;
      const clock = fakeClock();
      const { session, ui, fetcher } = await signedIn(mod, {
        clock,
        responder: staffApi({
          send: () => { sends += 1; return jsonResponse(500, { ok: false, code: 'server_error' }); }
        })
      });
      try {
        session.select('conv-a');
        await tick();
        await session.send({ message: 'important' });
        await tick();
        assert.equal(sends, 1, 'one attempt');

        /* Every timer the module owns fires, twice, and nothing re-sends. */
        clock.fireAll();
        clock.fireAll();
        await tick();
        assert.equal(sends, 1, 'no timer resent it');
        assert.equal(typeof ui.retry, 'function', 'a person is offered the choice');

        /* And no scheduling call exists anywhere near send(). */
        assert.equal(/setTimeout\([^)]*send/.test(STAFF_CODE), false);
      } finally {
        fetcher.restore();
      }
    });

  test('closing REQUIRES a confirmation before any request is made', async () => {
    const { mod } = await load();
    const { session, ui, fetcher } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();

      const before = fetcher.seen.filter((r) =>
        r.input.indexOf('/api/admin/chat/close') === 0).length;
      session.requestClose();
      await tick();
      assert.equal(ui.confirmRequests, 1, 'the dialog was asked for');
      assert.equal(fetcher.seen.filter((r) =>
        r.input.indexOf('/api/admin/chat/close') === 0).length, before,
        'and NOTHING was sent until it was answered');

      await ui.lastConfirm();
      await tick();
      assert.equal(fetcher.seen.filter((r) =>
        r.input.indexOf('/api/admin/chat/close') === 0).length, before + 1);
    } finally {
      fetcher.restore();
    }
  });

  test('a closed thread disables the composer and hides Close', async () => {
    const { mod } = await load();
    const closed = Object.assign({}, CONV_A, { status: 'closed' });
    const { session, ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        messages: () => jsonResponse(200,
          { ok: true, limit: 200, conversation: closed, messages: THREAD_OK.messages })
      })
    });
    try {
      session.select('conv-a');
      await tick();
      assert.equal(session.isClosed(), true);
      assert.equal(ui.thread.conversation.status, 'closed');

      /* And a send is refused locally, without a request. */
      const before = fetcher.seen.length;
      const result = await session.send({ message: 'too late' });
      assert.equal(result, null);
      assert.equal(fetcher.seen.length, before, 'no request was made');

      /* As is a close. */
      assert.equal(session.requestClose(), false);
      assert.equal(ui.confirmRequests, 0);
    } finally {
      fetcher.restore();
    }
  });

  test('an already-closed answer reconciles rather than alarming', async () => {
    const { mod } = await load();
    let closed = false;
    const { session, ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        send: () => jsonResponse(409, { ok: false, code: 'conversation_closed' }),
        messages: () => jsonResponse(200, {
          ok: true, limit: 200,
          conversation: Object.assign({}, CONV_A, { status: closed ? 'closed' : 'open' }),
          messages: THREAD_OK.messages
        })
      })
    });
    try {
      session.select('conv-a');
      await tick();
      closed = true;                       /* somebody else closed it */
      await session.send({ message: 'hello?' });
      await tick();
      assert.match(String(ui.notice), /closed/i, 'said so plainly');
      assert.equal(session.isClosed(), true, 'and the thread caught up');
      assert.equal(ui.phase, 'ready', 'it is not treated as catastrophic');
    } finally {
      fetcher.restore();
    }
  });

  test('an empty inbox and an empty thread both render', async () => {
    const { mod } = await load();
    const { session, ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => jsonResponse(200,
          { ok: true, conversations: [], status: 'open', limit: 50 }),
        messages: () => jsonResponse(200,
          { ok: true, limit: 200, conversation: CONV_A, messages: [] })
      })
    });
    try {
      assert.deepEqual(ui.inbox, [], 'an empty inbox is a render, not a crash');
      session.select('conv-a');
      await tick();
      assert.deepEqual(ui.thread.messages, []);
    } finally {
      fetcher.restore();
    }
  });

  test('an API failure is reported without tearing the session down', async () => {
    const { mod } = await load();
    let fail = false;
    const { session, ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => fail
          ? jsonResponse(500, { ok: false, code: 'server_error' })
          : jsonResponse(200, INBOX_OK)
      })
    });
    try {
      fail = true;
      await session.loadInbox({});
      await tick();
      assert.ok(typeof ui.notice === 'string' && ui.notice.length > 0);
      assert.equal(ui.phase, 'ready', 'a 500 is not a sign-out');
      assert.equal(session.staff !== null, true);
    } finally {
      fetcher.restore();
    }
  });

  test('signing out clears the inbox, the thread and the timers', async () => {
    const { mod, stub } = await load();
    const { session, ui, clock, fetcher } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      assert.ok(clock.liveTimers() > 0);

      await session.signOut();
      await tick();

      assert.equal(session.staff, null);
      assert.equal(session.conversations.length, 0);
      assert.equal(session.thread, null);
      assert.equal(session.selectedId, null);
      assert.equal(ui.inbox.length, 0);
      assert.equal(ui.thread, null);
      assert.equal(ui.staff, null);
      assert.equal(ui.phase, 'signed-out');
      assert.equal(clock.liveTimers(), 0, 'no timer survived');
      assert.equal(clock.visibilityListeners(), 0, 'nor the visibility hook');
      assert.ok(stub.signOutCalls >= 1);
    } finally {
      fetcher.restore();
    }
  });
});

/* ==================================================== 31-37. THE POLLING */

describe('polling is conservative and stops when it should', () => {
  test('THERE IS EXACTLY ONE TIMER, AND IT IS THE INBOX', async () => {
    /*
     * The eight-second full-transcript timer is gone. It re-read every
     * message in the open thread to discover, almost always, that nothing had
     * changed - see reconcileSelected() for what replaced it.
     */
    const { mod } = await load();
    const { session, clock, fetcher } = await signedIn(mod);
    try {
      assert.deepEqual(clock.intervals(), [15000], 'one timer, fifteen seconds');
      assert.equal(clock.liveTimers(), 1);
      assert.equal(mod._internals.INBOX_POLL_MS, 15 * 1000);
      assert.equal(mod._internals.THREAD_POLL_MS, undefined,
        'the thread interval constant is gone, not merely unused');
      assert.equal(clock.visibilityListeners(), 1);

      /* And opening a thread does not add one. */
      session.select('conv-a');
      await tick();
      assert.deepEqual(clock.intervals(), [15000],
        'still one timer with a thread open');
    } finally {
      fetcher.restore();
    }
  });

  test('no independent thread interval remains anywhere in the source', () => {
    assert.equal(/THREAD_POLL_MS/.test(STAFF_CODE), false);
    assert.equal(/threadTimer/.test(STAFF_CODE), false);
    /* setInterval is called exactly once, and it is the inbox. */
    assert.equal((STAFF_CODE.match(/deps\.setInterval\(/g) || []).length, 1);
  });

  test('a tick with nothing selected does not fetch a transcript', async () => {
    const { mod } = await load();
    const { clock, fetcher } = await signedIn(mod);
    try {
      const before = fetcher.seen.filter((r) =>
        r.input.indexOf('/api/admin/chat/messages') === 0).length;
      clock.fireAll();
      await tick();
      assert.equal(fetcher.seen.filter((r) =>
        r.input.indexOf('/api/admin/chat/messages') === 0).length, before,
        'the thread poll idles while no thread is open');
    } finally {
      fetcher.restore();
    }
  });

  test('a HIDDEN tab polls nothing at all', async () => {
    const { mod } = await load();
    const { session, clock, fetcher } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      const before = fetcher.seen.length;

      clock.hide();
      clock.fireAll();
      clock.fireAll();
      clock.fireAll();
      await tick();

      assert.equal(fetcher.seen.length, before,
        'three ticks against a hidden tab, zero requests');
    } finally {
      fetcher.restore();
    }
  });

  test('coming back to a visible tab refreshes IMMEDIATELY', async () => {
    const { mod } = await load();
    const { session, clock, fetcher } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      const before = fetcher.seen.length;

      clock.hide();
      clock.fireAll();
      await tick();
      assert.equal(fetcher.seen.length, before, 'nothing while away');

      clock.show();
      await tick();
      const after = fetcher.seen.slice(before).map((r) => r.input);
      assert.ok(after.some((u) => u.indexOf('/api/admin/chat/conversations') === 0),
        'the inbox caught up at once');
      /* The transcript does NOT follow automatically - the summary is
         unchanged, so there is nothing to re-read. That is the whole point of
         the change-driven design; the change case is tested separately. */
      assert.equal(after.filter((u) => u.indexOf('/api/admin/chat/messages') === 0).length,
        0, 'and the unchanged transcript was left alone');
    } finally {
      fetcher.restore();
    }
  });

  test('polls never overlap - one of each in flight at a time', async () => {
    const { mod } = await load();
    let inboxCalls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { session, clock, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: async () => {
          inboxCalls += 1;
          if (inboxCalls > 1) await gate;
          return jsonResponse(200, INBOX_OK);
        }
      })
    });
    try {
      const before = inboxCalls;
      clock.fireAll();      /* starts one, which blocks on the gate */
      await tick(1);
      clock.fireAll();      /* must be refused while the first is in flight */
      clock.fireAll();
      await tick(1);
      assert.equal(inboxCalls, before + 1,
        'three ticks, one request');
      release();
      await tick();
    } finally {
      fetcher.restore();
    }
  });

  test('change detection follows the selection, and never the one left behind',
    async () => {
      const { mod } = await load();
      /* conv-b's summary advances; conv-a's does not. */
      let bump = 0;
      const { session, clock, fetcher } = await signedIn(mod, {
        responder: staffApi({
          conversations: () => jsonResponse(200, {
            ok: true, status: 'open', limit: 50,
            conversations: [
              CONV_A,
              Object.assign({}, CONV_B, { lastMessageAt: 4000 + bump,
                messageCount: 1 + bump })
            ]
          }),
          messages: (n, input) => jsonResponse(200, {
            ok: true, limit: 200,
            conversation: input.indexOf('conv-b') !== -1
              ? Object.assign({}, CONV_B, { lastMessageAt: 4000 + bump,
                  messageCount: 1 + bump })
              : CONV_A,
            messages: []
          })
        })
      });
      try {
        session.select('conv-a');
        await tick();
        session.select('conv-b');
        await tick();

        bump = 1;                        /* something happened, to conv-b */
        const before = fetcher.seen.length;
        clock.fireAll();
        await tick();

        const asked = fetcher.seen.slice(before)
          .filter((r) => r.input.indexOf('/api/admin/chat/messages') === 0)
          .map((r) => r.input);
        assert.equal(asked.length, 1, 'one transcript read');
        assert.match(asked[0], /conversationId=conv-b/, 'for the OPEN thread');
        assert.equal(/conversationId=conv-a/.test(asked[0]), false,
          'the abandoned thread is never re-read');
      } finally {
        fetcher.restore();
      }
    });

  test('a late answer for an abandoned thread is discarded', async () => {
    const { mod } = await load();
    let release;
    const gate = new Promise((r) => { release = r; });
    const { session, ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        messages: async (n, input) => {
          if (input.indexOf('conv-a') !== -1) {
            await gate;
            return jsonResponse(200, { ok: true, limit: 200, conversation: CONV_A,
              messages: [{ messageId: 'stale', conversationId: 'conv-a',
                senderType: 'customer', body: 'STALE', createdAt: 1 }] });
          }
          return jsonResponse(200, { ok: true, limit: 200, conversation: CONV_B,
            messages: [{ messageId: 'fresh', conversationId: 'conv-b',
              senderType: 'customer', body: 'FRESH', createdAt: 1 }] });
        }
      })
    });
    try {
      session.select('conv-a');
      await tick(1);
      session.select('conv-b');
      await tick();
      release();
      await tick();
      assert.equal(session.selectedId, 'conv-b');
      assert.equal(ui.thread.messages[0].body, 'FRESH',
        'the answer for the thread we left did not overwrite the one we are on');
    } finally {
      fetcher.restore();
    }
  });

  test('repeated failures back off instead of hammering', async () => {
    const { mod } = await load();
    let calls = 0;
    const clock = fakeClock();
    const { session, fetcher } = await signedIn(mod, {
      clock,
      responder: staffApi({
        conversations: () => {
          calls += 1;
          return calls === 1
            ? jsonResponse(200, INBOX_OK)
            : jsonResponse(500, { ok: false, code: 'server_error' });
        }
      })
    });
    try {
      clock.fireAll();                 /* fails; backoff begins */
      await tick();
      const afterFirstFailure = calls;
      assert.equal(session.inboxFailures, 1);

      clock.advance(1000);             /* well inside the backoff window */
      clock.fireAll();
      await tick();
      assert.equal(calls, afterFirstFailure, 'the tick was skipped');

      clock.advance(mod._internals.MAX_BACKOFF_MS);
      clock.fireAll();
      await tick();
      assert.equal(calls, afterFirstFailure + 1, 'and resumes once it has waited');
    } finally {
      fetcher.restore();
    }
  });

  test('a manual refresh clears the backoff and asks at once', async () => {
    const { mod } = await load();
    let calls = 0;
    const clock = fakeClock();
    const { session, fetcher } = await signedIn(mod, {
      clock,
      responder: staffApi({
        conversations: () => {
          calls += 1;
          return calls === 1
            ? jsonResponse(200, INBOX_OK)
            : jsonResponse(500, { ok: false, code: 'server_error' });
        }
      })
    });
    try {
      clock.fireAll();
      await tick();
      const stalled = calls;
      session.refreshAll();
      await tick();
      assert.equal(calls, stalled + 1, 'a person asking is not a retry storm');
    } finally {
      fetcher.restore();
    }
  });
});

/* ================================================ 38-41. ROLLOUT SAFETY */

describe('the staff dashboard changes nothing about the customer rollout', () => {
  test('both customer chat gates are still FALSE', () => {
    assert.match(WIDGET_SRC, /var CHAT_PUBLIC_ENABLED = false;/);
    assert.equal(/var CHAT_PUBLIC_ENABLED = true/.test(WIDGET_SRC), false);
    assert.match(CUSTOMER_SRC, /export const CHAT_PUBLIC_ENABLED = false;/);
    assert.equal(/export const CHAT_PUBLIC_ENABLED = true/.test(CUSTOMER_SRC), false);
  });

  test('the staff module has no gate of its own to confuse them with', () => {
    /* Staff chat is not gated by a constant - it is gated by the backend
       refusing anybody who is not staff. A second boolean here would be a
       second thing to get wrong. */
    assert.equal(/CHAT_PUBLIC_ENABLED/.test(STAFF_CODE), false);
  });

  test('no public page links to or loads the staff dashboard', () => {
    const pages = ['index.html', 'about/index.html', 'contact/index.html',
      'gallery/index.html', 'materials/index.html', 'quote/index.html',
      'services/index.html'];
    for (const page of pages) {
      const html = readFileSync(ROOT + '/' + page, 'utf8');
      assert.equal(/chat-staff/.test(html), false, page + ' does not load it');
      assert.equal(/staff\/chat/.test(html), false, page + ' does not link to it');
    }
  });

  test('the staff page is noindex and loads nothing from the marketing site',
    () => {
      assert.match(PAGE_SRC,
        /<meta name="robots" content="noindex,nofollow,noarchive">/);
      /* Standalone: no site.css, no base.css, no site.js - so it cannot be
         broken by, or break, a customer-facing page. */
      assert.equal(/site\.css|base\.css|home\.css|site\.js|util\.js/.test(PAGE_SRC), false);
      assert.equal(/chat-customer\.js|assets\/js\/chat\.js/.test(PAGE_SRC), false,
        'and it does not pull in the customer transport');
      /* No inline script: everything executable is a versioned file. */
      assert.equal(/<script(?![^>]*\bsrc=)/.test(PAGE_SRC), false);
    });

  test('NO BROWSER, STAFF OR OTHERWISE, MAY READ chatConversations', () => {
    /*
     * The staff dashboard exists precisely BECAUSE staff have no direct read.
     * The rule that would grant one - "is this uid in the staff collection,
     * active, and of an allowed role" - would hand every field of every
     * conversation to any browser holding a staff session, including the ones
     * a later phase adds. So the collection is denied outright, and this is
     * the test that notices if that ever changes.
     */
    const rules = readFileSync(ROOT + '/firestore.rules', 'utf8');

    /* The deny is explicit, and it is what these assertions pin. */
    assert.match(rules,
      /match \/chatConversations\/\{conversationId\} \{\s*allow read, write: if false;/,
      'chatConversations denies every browser read and write outright');

    /* The staff allow-list is server-only too: a browser must not be able to
       read its own staff document and decide for itself that it is
       authorised. Only the Admin SDK sees it. */
    assert.match(rules,
      /match \/staff\/\{staffUid\} \{\s*allow read, write: if false;/,
      'the staff allow-list is not browser-readable either');

    /* And nothing anywhere grants a read on the strength of being staff. */
    assert.equal(/allow[^;]*:\s*if[^;]*staff/i.test(rules), false,
      'no rule anywhere is conditioned on staff membership');
  });
});

/* ============================================= THE CACHE VERSION CONTRACT */

describe('the staff bundle joins the existing chat version contract', () => {
  const VERSION = (() => {
    const m = WIDGET_SRC.match(/var CHAT_CLIENT_VERSION = '([^']+)';/);
    return m ? m[1] : null;
  })();

  test('chat.js still declares the version as a bare literal', () => {
    assert.match(WIDGET_SRC, /var CHAT_CLIENT_VERSION = '[^']+';/);
    assert.ok(typeof VERSION === 'string' && VERSION.length > 0);
  });

  test('the staff module shares the ONE chat client version', () => {
    /*
     * Shared rather than separate. chat-staff.js imports chat-app-check.js,
     * so it is part of the same local module graph: a separate
     * STAFF_CHAT_CLIENT_VERSION would still have to be bumped whenever the
     * shared dependency moved, which is two strings to keep in step instead
     * of one, for no extra guarantee.
     */
    const decl = STAFF_SRC.match(/export const CHAT_CLIENT_VERSION = '([^']+)';/);
    assert.ok(decl, 'chat-staff.js declares it');
    assert.equal(decl[1], VERSION);

    const imp = STAFF_CODE.match(/from '\.\/chat-app-check\.js\?v=([^']+)';/);
    assert.ok(imp, 'and versions its transitive import');
    assert.equal(imp[1], VERSION,
      'with the same version - a query does not reach a static specifier');
  });

  test('the page requests the versioned script and stylesheet', () => {
    assert.ok(PAGE_SRC.indexOf(
      'src="/assets/js/chat-staff.js?v=' + VERSION + '"') !== -1,
      'the module URL is versioned');
    assert.ok(PAGE_SRC.indexOf(
      'href="/assets/css/chat-staff.css?v=' + VERSION + '"') !== -1,
      'and so is the stylesheet');
    assert.equal(/chat-staff\.js"/.test(PAGE_SRC), false,
      'no unversioned form left');
  });

  test('the staff files revalidate, and no global cache rule was added', () => {
    const cfg = JSON.parse(readFileSync(ROOT + '/vercel.json', 'utf8'));
    const rules = cfg.headers || [];
    const cacheOf = (source) => {
      const rule = rules.find((r) => r.source === source);
      if (!rule) return null;
      const h = (rule.headers || []).find((x) => x.key === 'Cache-Control');
      return h ? h.value : null;
    };
    for (const file of ['/assets/js/chat.js', '/assets/js/chat-customer.js',
                        '/assets/js/chat-app-check.js', '/assets/js/chat-staff.js',
                        '/assets/css/chat-staff.css']) {
      assert.equal(cacheOf(file), 'public, max-age=0, must-revalidate', file);
    }
    assert.equal(cacheOf('/assets/img/(.*)'),
      'public, max-age=604800, stale-while-revalidate=86400',
      'the image cache is untouched');
    assert.equal(cacheOf('/(.*)'), null, 'no site-wide Cache-Control');
  });

  test('the staff page is actually served - .vercelignore no longer hides it',
    () => {
      const ignore = readFileSync(ROOT + '/.vercelignore', 'utf8');
      const lines = ignore.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && l.charAt(0) !== '#');
      assert.equal(lines.indexOf('staff/'), -1,
        'staff/ is no longer excluded from the deployment');
      assert.equal(lines.indexOf('staff'), -1);
      /* And the things that must stay unserved still are. */
      for (const kept of ['supabase/', 'docs/', 'tests/', 'firestore.rules',
                          'firestore.indexes.json', '.vercelignore']) {
        assert.notEqual(lines.indexOf(kept), -1, kept + ' is still excluded');
      }
    });

  test('the pinned Firebase SDK URL is not cache-busted', () => {
    const urls = STAFF_CODE.match(/'https:\/\/www\.gstatic\.com\/firebasejs\/'[^;]*/g) || [];
    assert.equal(urls.length, 1, 'exactly one SDK URL - firebase-auth');
    assert.equal(/\?v=/.test(urls[0]), false);
    assert.match(STAFF_CODE, /firebase-auth\.js/);
  });
});

/* ============================================== ACCESSIBILITY AND LAYOUT */

describe('the page is usable with a keyboard and on a phone', () => {
  test('every input has a label and the transcript is a live region', () => {
    assert.match(STAFF_CODE, /el\('label', \{ class: 'sc__field', for: 'sc-email' \}\)/);
    assert.match(STAFF_CODE, /el\('label', \{ class: 'sc__field', for: 'sc-password' \}\)/);
    assert.match(STAFF_CODE, /for: 'sc-reply'/);
    assert.match(STAFF_CODE, /role: 'log'/);
    assert.match(STAFF_CODE, /'aria-live': 'polite'/);
    assert.match(STAFF_CODE, /role: 'alert'/);        /* the sign-in error */
    assert.match(STAFF_CODE, /role: 'status'/);
  });

  test('the confirmation traps focus, restores it, and answers Escape', () => {
    assert.match(STAFF_CODE, /dialog\.showModal\(\)/);
    assert.match(STAFF_CODE, /dialog\.addEventListener\('cancel'/);
    assert.match(STAFF_CODE, /lastFocus = document\.activeElement/);
    assert.match(STAFF_CODE, /lastFocus\.focus\(\)/);
    /* Focus lands on the safe option, not the destructive one. */
    assert.match(STAFF_CODE, /dlgCancel\.focus\(\)/);
  });

  test('nothing depends on colour alone', () => {
    /* Status is a word as well as a colour; the selected row has an edge and
       a weight change as well as a tint; a staff bubble is labelled. */
    assert.match(STAFF_CODE, /text: c\.status === 'closed' \? 'Closed' : 'Open'/);
    assert.match(STAFF_CODE, /text: mine \? "Esther's"/);
    assert.match(CSS_SRC, /\.sc__row\[aria-pressed="true"\][\s\S]{0,200}border-left-color/);
    assert.match(CSS_SRC, /font-weight: 700/);
  });

  test('the stylesheet is responsive and has real touch targets', () => {
    assert.match(CSS_SRC, /@media \(max-width: 720px\)/);
    assert.match(CSS_SRC, /min-height: 44px/);
    assert.match(CSS_SRC, /:focus-visible/);
    /* 16px on the inputs, or iOS zooms the page when one takes focus. */
    assert.match(CSS_SRC, /font: 16px\/1\.4 var\(--sc-sans\)/);
    /* A pasted 500-character word must wrap, not widen the page. */
    assert.match(CSS_SRC, /overflow-wrap: anywhere/);
    assert.match(PAGE_SRC, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  });

  test('the mobile view is one column at a time, with a way back', () => {
    assert.match(CSS_SRC, /\.sc__root\[data-view="inbox"\] \.sc__thread \{ display: none; \}/);
    assert.match(CSS_SRC, /\.sc__root\[data-view="thread"\] \.sc__inbox \{ display: none; \}/);
    assert.match(STAFF_CODE, /text: 'Back to inbox'/);
    assert.match(STAFF_CODE, /root\.setAttribute\('data-view'/);
  });
});

/* ======================================= ONE FIREBASE USER PER TAB, NOT PER
 *                                         BROWSER
 *
 * Firebase's web default is browserLocalPersistence: one signed-in user in
 * localStorage, shared by every tab on the origin. This project has two kinds
 * of user - anonymous customers and Email/Password staff - and the SDK allows
 * exactly one signed-in user per app instance. Under the default, a staff
 * sign-in in one tab replaces the customer in another, and a customer
 * starting a chat signs the staff member out mid-reply.
 *
 * browserSessionPersistence puts the session in sessionStorage, which is
 * per-tab. What these tests pin is that the choice is made DELIBERATELY, and
 * made BEFORE anybody is signed in or restored - after would be too late,
 * because the restore has already happened against the wrong store.
 */
describe('the staff dashboard keeps its Firebase session to its own tab', () => {
  test('browserSessionPersistence is chosen explicitly', async () => {
    const { mod, stub } = await load();
    const clock = fakeClock();
    const fetcher = captureFetch(staffApi());
    try {
      await mod.startStaffChat(recordingUi(), { deps: clock.deps });
      await tick();
      assert.deepEqual(stub.persistenceChoices, ['SESSION'],
        'session persistence, once, and nothing else');
    } finally {
      fetcher.restore();
    }
  });

  test('NEITHER local NOR in-memory persistence is configured', () => {
    /*
     * local is the shared-across-tabs default this exists to remove.
     * inMemory would isolate tabs too - and lose the session on every F5,
     * which would make a staff member sign in again after each reload.
     */
    assert.match(STAFF_CODE, /browserSessionPersistence/);
    assert.equal(/browserLocalPersistence/.test(STAFF_CODE), false);
    assert.equal(/inMemoryPersistence/.test(STAFF_CODE), false);
    assert.equal(/indexedDBLocalPersistence/.test(STAFF_CODE), false);
  });

  test('persistence is set BEFORE any sign-in and BEFORE the restore settles',
    async () => {
      const { mod, stub } = await load();
      const clock = fakeClock();
      const fetcher = captureFetch(staffApi());
      try {
        const ui = recordingUi();
        await mod.startStaffChat(ui, { deps: clock.deps });
        await tick();
        await ui.handlers.signIn({ email: 'manager@esthers.ca', password: 'x' });
        await tick();

        const set = stub.order.indexOf('setPersistence');
        const watch = stub.order.indexOf('onAuthStateChanged');
        const signIn = stub.order.indexOf('signInWithEmailAndPassword');
        assert.ok(set !== -1, 'it was set at all');
        assert.ok(set < watch, 'before the restore was awaited');
        assert.ok(set < signIn, 'and before the Email/Password sign-in');
      } finally {
        fetcher.restore();
      }
    });

  test('a failure to set persistence STOPS the dashboard', async () => {
    /*
     * Not tolerated. If setPersistence() rejects the instance keeps the
     * default, which is the cross-tab bleed this removes - and a staff token
     * in shared storage is the worse half of that. A sign-in screen that says
     * something went wrong is better than an isolation guarantee that quietly
     * is not one.
     */
    const { mod, stub } = await load();
    stub.persistenceErrorOn(true);
    const clock = fakeClock();
    const fetcher = captureFetch(staffApi());
    try {
      const session = await mod.startStaffChat(recordingUi(), { deps: clock.deps });
      await tick();
      assert.equal(session.ui.phase, 'signed-out');
      assert.ok(typeof session.ui.authError === 'string' && session.ui.authError.length > 0);
      assert.equal(fetcher.seen.length, 0, 'and nothing privileged was requested');
      assert.equal(clock.liveTimers(), 0);
    } finally {
      stub.persistenceErrorOn(false);
      fetcher.restore();
    }
  });

  test('AN ANONYMOUS RESTORED USER IS A CUSTOMER, NOT STAFF', async () => {
    /*
     * Same-tab customer -> staff. Per-tab persistence means another tab's
     * customer cannot appear here, so an anonymous user at this point is one
     * this tab created on the website before navigating to /staff/chat.
     * It is released and the sign-in form is shown - the staff API is never
     * asked, because asking would earn a 403 that reads like "your staff
     * account is not authorised", which is a lie.
     */
    const { mod, stub } = await load();
    stub.seedRestoredUser({
      uid: 'anon-uid-1', email: null, isAnonymous: true,
      getIdToken: async () => 'anon-token'
    });
    const clock = fakeClock();
    const fetcher = captureFetch(staffApi());
    try {
      const session = await mod.startStaffChat(recordingUi(), { deps: clock.deps });
      await tick();
      assert.equal(session.ui.phase, 'signed-out', 'the staff sign-in form');
      assert.equal(session.staff, null);
      assert.equal(fetcher.seen.length, 0,
        'the staff API was never asked about a customer identity');
      assert.ok(stub.signOutCalls >= 1, 'the anonymous identity was released');
      assert.equal(clock.liveTimers(), 0, 'and nothing is polling');
    } finally {
      fetcher.restore();
    }
  });

  test('a restored EMAIL/PASSWORD user is reused, but still checked by the '
    + 'backend', async () => {
      /*
       * The reuse is what makes F5 work. The check is what makes it safe: a
       * non-anonymous Firebase session is a reason to ASK the staff API, never
       * a reason to skip it.
       */
      const { mod, stub } = await load();
      stub.seedRestoredUser({
        uid: 'staff-1', email: 'manager@esthers.ca', isAnonymous: false,
        getIdToken: async () => 'staff-id-token'
      });
      const clock = fakeClock();
      const fetcher = captureFetch(staffApi());
      try {
        const session = await mod.startStaffChat(recordingUi(), { deps: clock.deps });
        await tick();
        assert.equal(session.ui.phase, 'ready', 'the session was reused');
        assert.equal(stub.order.indexOf('signInWithEmailAndPassword'), -1,
          'without asking for a password again');
        assert.ok(fetcher.seen.some((r) =>
          r.input.indexOf('/api/admin/chat/conversations') === 0),
          'AND the backend was still asked to authorise it');
      } finally {
        fetcher.restore();
      }
    });

  test('a restored Email/Password user the backend rejects gets no inbox',
    async () => {
      /* Provider alone, an email address, or an @esthers.ca domain authorise
         nothing. Only staff/{uid} does. */
      const { mod, stub } = await load();
      stub.seedRestoredUser({
        uid: 'someone-else', email: 'someone@esthers.ca', isAnonymous: false,
        getIdToken: async () => 'a-real-token'
      });
      const clock = fakeClock();
      const fetcher = captureFetch(staffApi({
        conversations: () => jsonResponse(403, { ok: false, code: 'not_staff' })
      }));
      try {
        const session = await mod.startStaffChat(recordingUi(), { deps: clock.deps });
        await tick();
        assert.equal(session.ui.phase, 'signed-out');
        assert.equal(session.staff, null);
        assert.match(String(session.ui.authError), /not authorised/i);
      } finally {
        fetcher.restore();
      }
    });
});

/* ================================ READ EFFICIENCY: THE TRANSCRIPT IS FETCHED
 *                                  WHEN SOMETHING HAPPENED, AND NOT OTHERWISE
 *
 * The old design re-read the whole transcript every eight seconds. The new one
 * reads the inbox summary every fifteen and compares three fields; the
 * transcript is fetched only when they move. These tests count requests,
 * because a design whose whole purpose is to make fewer of them should be
 * measured in requests.
 */
describe('the open transcript is re-read only when it actually changed', () => {
  /* Thirty messages, so a needless reload would be an expensive one. */
  const THIRTY = [];
  for (let i = 0; i < 30; i++) {
    THIRTY.push({ messageId: 'm' + i, conversationId: 'conv-a',
      senderType: i % 2 ? 'staff' : 'customer', body: 'line ' + i, createdAt: 1000 + i });
  }

  /* A world whose summary only moves when a test says so. */
  function world() {
    const state = { lastMessageAt: 5000, messageCount: 30, status: 'open',
      messages: THIRTY.slice(), inboxCalls: 0, messageCalls: 0 };
    const summary = () => Object.assign({}, CONV_A, {
      lastMessageAt: state.lastMessageAt,
      messageCount: state.messageCount,
      status: state.status
    });
    state.responder = staffApi({
      conversations: () => {
        state.inboxCalls += 1;
        const c = summary();
        return jsonResponse(200, {
          ok: true, status: c.status, limit: 50,
          conversations: c.status === 'open' ? [c] : []
        });
      },
      messages: () => {
        state.messageCalls += 1;
        return jsonResponse(200,
          { ok: true, limit: 200, conversation: summary(), messages: state.messages });
      }
    });
    return state;
  }

  test('NO CHANGE: many ticks, and the transcript is read exactly ONCE',
    async () => {
      const { mod } = await load();
      const w = world();
      const clock = fakeClock();
      const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
      try {
        session.select('conv-a');
        await tick();
        assert.equal(w.messageCalls, 1, 'the initial load');
        assert.equal(session.thread.messages.length, 30);

        /* Twenty polls. Nothing has been written to the conversation. */
        for (let i = 0; i < 20; i++) { clock.fireAll(); await tick(1); }
        await tick();

        assert.equal(w.messageCalls, 1,
          'STILL one - twenty ticks read no messages at all');
        assert.ok(w.inboxCalls >= 20, 'while the summary was checked every time');
      } finally {
        fetcher.restore();
      }
    });

  test('CHANGE: the summary advances and the transcript reloads exactly once',
    async () => {
      const { mod } = await load();
      const w = world();
      const clock = fakeClock();
      const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
      try {
        session.select('conv-a');
        await tick();
        assert.equal(w.messageCalls, 1);

        /* A customer writes. */
        w.lastMessageAt = 6000;
        w.messageCount = 31;
        w.messages = THIRTY.concat([{ messageId: 'm30', conversationId: 'conv-a',
          senderType: 'customer', body: 'one more', createdAt: 6000 }]);

        clock.fireAll();
        await tick();
        assert.equal(w.messageCalls, 2, 'exactly one extra read');
        assert.equal(session.thread.messages.length, 31, 'and the new line is there');

        /* And it settles again. */
        for (let i = 0; i < 5; i++) { clock.fireAll(); await tick(1); }
        await tick();
        assert.equal(w.messageCalls, 2, 'no further reads once it is caught up');
      } finally {
        fetcher.restore();
      }
    });

  test('MULTIPLE CHANGES: one read each, never two for the same change',
    async () => {
      const { mod } = await load();
      const w = world();
      const clock = fakeClock();
      const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
      try {
        session.select('conv-a');
        await tick();
        for (let n = 1; n <= 3; n++) {
          w.lastMessageAt = 5000 + n * 1000;
          w.messageCount = 30 + n;
          clock.fireAll();
          await tick();
          clock.fireAll();               /* a second tick, same state */
          await tick();
          assert.equal(w.messageCalls, 1 + n,
            'change ' + n + ': one read, and the repeat tick added none');
        }
      } finally {
        fetcher.restore();
      }
    });

  test('A CLOSE IS A CHANGE, even though no message was written', async () => {
    /*
     * closeConversation() writes status, closedAt and updatedAt - and NOT
     * lastMessageAt or messageCount. Two fields would have missed it entirely
     * and left a closed thread looking open until somebody clicked it. Hence
     * status in the marker.
     */
    const { mod } = await load();
    const w = world();
    const clock = fakeClock();
    const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      assert.equal(session.isClosed(), false);
      assert.equal(w.messageCalls, 1);

      /* Somebody closes it elsewhere. The message fields do not move, and it
         drops out of the Open filter. */
      w.status = 'closed';
      clock.fireAll();
      await tick();

      assert.equal(w.messageCalls, 2, 'the disappearance triggered one read');
      assert.equal(session.isClosed(), true, 'and the thread caught up');
    } finally {
      fetcher.restore();
    }
  });

  test('the marker is the raw primitives, not a formatted string', async () => {
    const { mod } = await load();
    const w = world();
    const clock = fakeClock();
    const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      assert.deepEqual(session.threadMarker, {
        conversationId: 'conv-a', lastMessageAt: 5000, messageCount: 30,
        status: 'open', locationId: 'main'
      });
      assert.equal(typeof session.threadMarker.lastMessageAt, 'number');
      assert.equal(typeof session.threadMarker.messageCount, 'number');

      /* A null lastMessageAt normalises to 0 - a stable value to compare, not
         a NaN or an undefined that would look like a change every tick. */
      const m = mod._internals.markerFor(
        mod._internals.normaliseConversation({ conversationId: 'x', lastMessageAt: null }));
      assert.equal(m.lastMessageAt, 0);
      assert.equal(mod._internals.sameSummary(m,
        mod._internals.normaliseConversation({ conversationId: 'x', lastMessageAt: null })),
        true, 'and two absent timestamps compare equal');
    } finally {
      fetcher.restore();
    }
  });

  test('a HIDDEN tab reads neither the inbox nor the transcript', async () => {
    const { mod } = await load();
    const w = world();
    const clock = fakeClock();
    const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      const inbox = w.inboxCalls;
      const msgs = w.messageCalls;

      clock.hide();
      /* Even with something genuinely new waiting. */
      w.lastMessageAt = 9000;
      w.messageCount = 31;
      for (let i = 0; i < 5; i++) { clock.fireAll(); await tick(1); }
      await tick();

      assert.equal(w.inboxCalls, inbox, 'no summary reads');
      assert.equal(w.messageCalls, msgs, 'and therefore no transcript reads');

      /* And coming back catches up: one inbox read, and one transcript read
         BECAUSE the summary moved while we were away. */
      clock.show();
      await tick();
      assert.equal(w.inboxCalls, inbox + 1);
      assert.equal(w.messageCalls, msgs + 1);
    } finally {
      fetcher.restore();
    }
  });

  test('MANUAL REFRESH re-reads both, marker or no marker', async () => {
    /* A person pressing Refresh wants certainty, not "I decided nothing had
       changed". */
    const { mod } = await load();
    const w = world();
    const clock = fakeClock();
    const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      const inbox = w.inboxCalls;
      const msgs = w.messageCalls;

      session.refreshAll();
      await tick();

      assert.equal(w.inboxCalls, inbox + 1, 'the inbox was re-read');
      assert.equal(w.messageCalls, msgs + 1,
        'and so was the transcript, despite an unchanged summary');
    } finally {
      fetcher.restore();
    }
  });

  test('SEND updates the thread at once, without waiting for a poll',
    async () => {
      const { mod } = await load();
      const w = world();
      const clock = fakeClock();
      const { session, fetcher } = await signedIn(mod, { clock, responder: w.responder });
      try {
        session.select('conv-a');
        await tick();
        const msgs = w.messageCalls;

        await session.send({ message: 'on its way' });
        await tick();

        assert.equal(w.messageCalls, msgs + 1,
          'exactly one transcript read, immediately');
        /* And no runaway: further ticks with an unchanged summary add none. */
        clock.fireAll(); await tick();
        clock.fireAll(); await tick();
        assert.equal(w.messageCalls, msgs + 1, 'no duplicate request loop');
      } finally {
        fetcher.restore();
      }
    });

  test('CLOSE updates immediately and then stops re-reading', async () => {
    const { mod } = await load();
    const w = world();
    const clock = fakeClock();
    const { session, fetcher } = await signedIn(mod, {
      clock,
      responder: staffApi({
        conversations: () => {
          w.inboxCalls += 1;
          return jsonResponse(200, { ok: true, status: 'open', limit: 50,
            conversations: w.status === 'open'
              ? [Object.assign({}, CONV_A, { lastMessageAt: w.lastMessageAt,
                  messageCount: w.messageCount, status: w.status })]
              : [] });
        },
        messages: () => {
          w.messageCalls += 1;
          return jsonResponse(200, { ok: true, limit: 200,
            conversation: Object.assign({}, CONV_A, { lastMessageAt: w.lastMessageAt,
              messageCount: w.messageCount, status: w.status }),
            messages: w.messages });
        },
        close: () => { w.status = 'closed'; return jsonResponse(200,
          { ok: true, conversationId: 'conv-a', status: 'closed' }); }
      })
    });
    try {
      session.select('conv-a');
      await tick();
      const msgs = w.messageCalls;

      await session.close();
      await tick();
      assert.equal(session.isClosed(), true, 'closed at once');
      assert.equal(w.messageCalls, msgs + 1, 'one read to confirm it');

      /* A closed thread has nothing further to learn: the marker now says
         closed, and the conversation is gone from the Open list, so absence
         is expected rather than a change. */
      const settled = w.messageCalls;
      for (let i = 0; i < 5; i++) { clock.fireAll(); await tick(1); }
      await tick();
      assert.equal(w.messageCalls, settled,
        'and no further transcript reads for a closed thread');
    } finally {
      fetcher.restore();
    }
  });

  test('reconciliation never fires two overlapping transcript reads', async () => {
    const { mod } = await load();
    const w = world();
    let release;
    const gate = new Promise((r) => { release = r; });
    const clock = fakeClock();
    let gated = false;
    const { session, fetcher } = await signedIn(mod, {
      clock,
      responder: staffApi({
        conversations: () => {
          w.inboxCalls += 1;
          return jsonResponse(200, { ok: true, status: 'open', limit: 50,
            conversations: [Object.assign({}, CONV_A, { lastMessageAt: w.lastMessageAt,
              messageCount: w.messageCount })] });
        },
        messages: async () => {
          w.messageCalls += 1;
          if (gated) await gate;
          return jsonResponse(200, { ok: true, limit: 200,
            conversation: Object.assign({}, CONV_A, { lastMessageAt: w.lastMessageAt,
              messageCount: w.messageCount }),
            messages: w.messages });
        }
      })
    });
    try {
      session.select('conv-a');
      await tick();
      gated = true;
      w.lastMessageAt = 7000; w.messageCount = 31;

      clock.fireAll(); await tick(1);      /* starts a read, which blocks */
      const inFlight = w.messageCalls;
      clock.fireAll(); await tick(1);      /* must be refused */
      clock.fireAll(); await tick(1);
      assert.equal(w.messageCalls, inFlight, 'three ticks, one read');

      release();
      await tick();
    } finally {
      fetcher.restore();
    }
  });
});

/* ================================================== THE VERSION BUMP */

describe('the whole local chat graph moved to one new version', () => {
  test('every local chat module and the staff page agree', () => {
    const WANT = '2026-09-07.1';
    const files = {
      'assets/js/chat.js': [/var CHAT_CLIENT_VERSION = '([^']+)';/],
      'assets/js/chat-customer.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/,
                                     /from '\.\/chat-app-check\.js\?v=([^']+)';/,
                                     /from '\.\/chat-locations\.js\?v=([^']+)';/],
      'assets/js/chat-app-check.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/],
      /* chat-locations.js and chat-staff-alerts.js carry the version too, and
         were not checked here before. A module left behind is exactly the
         mixed graph this suite exists to prevent, so they are checked now. */
      'assets/js/chat-locations.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/],
      'assets/js/chat-staff-alerts.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/],
      'assets/js/chat-staff.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/,
                                  /from '\.\/chat-app-check\.js\?v=([^']+)';/,
                                  /from '\.\/chat-locations\.js\?v=([^']+)';/,
                                  /from '\.\/chat-staff-alerts\.js\?v=([^']+)';/],
      'staff/chat/index.html': [/chat-staff\.js\?v=([^"]+)"/,
                                /chat-staff\.css\?v=([^"]+)"/]
    };
    for (const file of Object.keys(files)) {
      const src = readFileSync(ROOT + '/' + file, 'utf8');
      for (const re of files[file]) {
        const m = src.match(re);
        assert.ok(m, file + ' matches ' + re);
        assert.equal(m[1], WANT, file + ' is on ' + WANT);
      }
    }
  });

  test('no module is left behind on the previous version', () => {
    for (const file of ['assets/js/chat.js', 'assets/js/chat-customer.js',
                        'assets/js/chat-app-check.js', 'assets/js/chat-staff.js',
                        'assets/js/chat-locations.js',
                        'assets/js/chat-staff-alerts.js',
                        'staff/chat/index.html']) {
      const src = readFileSync(ROOT + '/' + file, 'utf8');
      for (const stale of ['2026-09-05.1', '2026-09-06.1', '2026-09-06.2']) {
        assert.equal(src.indexOf(stale), -1,
          file + ' has no trace of ' + stale);
      }
    }
  });

  test('the pinned Firebase SDK is still 12.4.0 and still not cache-busted',
    () => {
      const appCheck = readFileSync(ROOT + '/assets/js/chat-app-check.js', 'utf8');
      assert.match(appCheck, /export const SDK_VERSION = '12\.4\.0';/);
      for (const file of ['assets/js/chat-customer.js', 'assets/js/chat-app-check.js',
                          'assets/js/chat-staff.js']) {
        const src = codeAndStrings(readFileSync(ROOT + '/' + file, 'utf8'));
        const urls = src.match(/'https:\/\/www\.gstatic\.com\/firebasejs\/'[^;]*/g) || [];
        assert.ok(urls.length >= 1, file + ' loads the SDK');
        for (const u of urls) {
          assert.equal(/\?v=/.test(u), false, file + ': no ?v= on ' + u);
        }
      }
    });
});

/* ==================================== 83-100. TWO SHOPS, FROM THE STAFF SIDE */

/*
 * ROUTING AND HANDOVER ON THE DASHBOARD.
 *
 * Three things have to be true at once: a staff member can see which shop
 * every conversation belongs to, a manager watching both can narrow the view
 * without that narrowing being mistaken for a permission, and a misrouted
 * conversation can be handed over - keeping its id and its transcript - even
 * to a shop the person handing it over cannot read.
 *
 * WHAT IS NOT TESTED HERE, BECAUSE IT IS NOT HERE: which shops this account
 * may see. That is decided by api/_chat/locations.js and proven against the
 * real emulator in tests/chat-api/locations.test.mjs. Everything below is
 * about what the page does with the answer.
 */
describe('the dashboard shows which shop, and can hand a thread over', () => {
  const inboxWith = (conversations, locations) => jsonResponse(200, {
    ok: true, status: 'open', limit: 50,
    conversations: conversations,
    locations: locations
  });

  /* ------------------------------------------------------ what is shown */

  test('EVERY ROW CARRIES ITS SHOP, as a derived label', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await signedIn(mod);
    try {
      const rows = Object.fromEntries(ui.inbox.map((c) => [c.conversationId, c]));
      assert.equal(rows['conv-a'].locationId, 'main');
      assert.equal(rows['conv-a'].locationLabel, 'Main Shop - 1st Avenue');
      assert.equal(rows['conv-b'].locationId, 'specialty');
      assert.equal(rows['conv-b'].locationLabel, 'Specialty Shop - Keith Street');
    } finally {
      fetcher.restore();
    }
  });

  test('THE LABEL IS DERIVED, NOT TAKEN FROM THE RESPONSE', async () => {
    /*
     * The API sends locationLabel and this page ignores it. The id is one of
     * three known strings; the label is a sentence that goes on a monitor.
     * Deriving it means the only location text this build can display is one
     * of its own three.
     */
    const { mod } = await load();
    const { ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => inboxWith([
          Object.assign({}, CONV_A, {
            locationId: 'main',
            locationLabel: '<img src=x onerror="alert(1)">'
          })
        ], ['main'])
      })
    });
    try {
      assert.equal(ui.inbox[0].locationLabel, 'Main Shop - 1st Avenue');
      assert.equal(JSON.stringify(ui.inbox).indexOf('onerror'), -1);
    } finally {
      fetcher.restore();
    }
  });

  test('A CONVERSATION FROM BEFORE ROUTING READS AS UNASSIGNED, never main',
    async () => {
      const { mod } = await load();
      const legacy = Object.assign({}, CONV_A);
      delete legacy.locationId;
      delete legacy.locationLabel;
      const { ui, fetcher } = await signedIn(mod, {
        responder: staffApi({ conversations: () => inboxWith([legacy], ['main']) })
      });
      try {
        assert.equal(ui.inbox[0].locationId, 'unassigned');
        assert.equal(ui.inbox[0].locationLabel, 'Not Sure / Unassigned');
      } finally {
        fetcher.restore();
      }
    });

  test('an id this build does not know is never echoed', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => inboxWith([
          Object.assign({}, CONV_A, { locationId: 'third-shop-<script>' })
        ], ['main'])
      })
    });
    try {
      assert.equal(ui.inbox[0].locationId, 'unassigned');
      assert.equal(ui.inbox[0].locationLabel, 'Not Sure / Unassigned');
    } finally {
      fetcher.restore();
    }
  });

  /* ------------------------------------------------------- the chips */

  test('A MANAGER GETS CHIPS; A SINGLE-SHOP ACCOUNT GETS NONE', async () => {
    for (const [locations, expected] of [
      [['main', 'specialty', 'unassigned'], 3],
      [['main'], 0],
      [['specialty'], 0],
      [[], 0],
      [undefined, 0]
    ]) {
      const { mod } = await load();
      const { ui, fetcher } = await signedIn(mod, {
        responder: staffApi({ conversations: () => inboxWith([CONV_A], locations) })
      });
      try {
        const drawn = ui.locationFilters || [];
        assert.equal(drawn.length, expected,
          JSON.stringify(locations) + ' -> ' + expected + ' chips');
        if (expected) {
          assert.deepEqual(drawn.map((c) => c.label), [
            'Main Shop - 1st Avenue',
            'Specialty Shop - Keith Street',
            'Not Sure / Unassigned'
          ], 'the full labels, in the canonical order');
        }
      } finally {
        fetcher.restore();
      }
    }
  });

  test('the chips come from the SERVER answer, not from a role or an email',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await signedIn(mod, {
        responder: staffApi({
          conversations: () => inboxWith([CONV_A, CONV_B], ['main', 'specialty'])
        })
      });
      try {
        assert.deepEqual((ui.locationFilters || []).map((c) => c.id),
          ['main', 'specialty'], 'exactly what was authorised');
        /*
         * And nothing in this file decides it. No email is treated as
         * privileged, and no role is mapped to a set of shops - the answer
         * is read straight out of the response the server sent.
         */
        assert.match(STAFF_CODE,
          /applyLocations\(payload && payload\.locations\)/);
        assert.equal(/manager@esthers|@esthers\.ca/.test(STAFF_CODE), false,
          'no address is treated as privileged');
        assert.equal(/\.role\b|'admin'|"admin"/.test(STAFF_CODE), false,
          'no role is mapped to a set of shops');
      } finally {
        fetcher.restore();
      }
    });

  test('FILTERING IS A VIEW, NOT A REQUEST', async () => {
    const { mod } = await load();
    const { ui, fetcher, session } = await signedIn(mod);
    try {
      const before = fetcher.seen.length;
      assert.equal(session.setLocationFilter('specialty'), true);
      assert.equal(fetcher.seen.length, before,
        'the rows are already here and already authorised');
      assert.deepEqual(ui.inbox.map((c) => c.conversationId), ['conv-b']);
      assert.equal(ui.locationFilter, 'specialty');

      /* Back to everything. */
      session.setLocationFilter(null);
      assert.deepEqual(ui.inbox.map((c) => c.conversationId).sort(),
        ['conv-a', 'conv-b']);
      assert.equal(fetcher.seen.length, before, 'still no request');
    } finally {
      fetcher.restore();
    }
  });

  test('a filter for a shop this account cannot see is refused', async () => {
    const { mod } = await load();
    const { ui, fetcher, session } = await signedIn(mod, {
      responder: staffApi({ conversations: () => inboxWith([CONV_A], ['main']) })
    });
    try {
      assert.equal(session.setLocationFilter('specialty'), false);
      assert.equal(session.locationFilter, null);
      assert.deepEqual(ui.inbox.map((c) => c.conversationId), ['conv-a'],
        'and nothing was hidden by the attempt');
    } finally {
      fetcher.restore();
    }
  });

  test('THE FILTER NEVER HIDES A ROW FROM THE CHANGE DETECTOR', async () => {
    /*
     * The trap this avoids. If the filter narrowed session.conversations
     * rather than only the render, a conversation the manager had merely
     * filtered out would look ABSENT to reconcileSelected() - which treats
     * absence as a change - and its transcript would be re-read on every
     * fifteen-second tick, forever.
     */
    const { mod } = await load();
    const { ui, fetcher, clock, session } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      session.setLocationFilter('specialty');       /* hides conv-a */
      assert.deepEqual(ui.inbox.map((c) => c.conversationId), ['conv-b']);
      assert.equal(session.conversations.length, 2,
        'the authorised list is intact underneath');

      const reads = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/api/admin/chat/messages') !== -1).length;
      clock.fireAll(); await tick();
      clock.fireAll(); await tick();
      const after = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/api/admin/chat/messages') !== -1).length;
      assert.equal(after, reads, 'two ticks, no transcript re-read');
    } finally {
      fetcher.restore();
    }
  });

  test('signing out takes the chips and the filter with them', async () => {
    const { mod } = await load();
    const { ui, fetcher, session } = await signedIn(mod);
    try {
      session.setLocationFilter('main');
      await session.signOut();
      await tick();
      assert.deepEqual(ui.locationFilters, [],
        'which shops the last person handled is not for the next one to read');
      assert.equal(ui.locationFilter, null);
      assert.equal(session.locations.length, 0);
      assert.equal(session.locationFilter, null);
    } finally {
      fetcher.restore();
    }
  });

  /* --------------------------------------------------- the marker */

  test('LOCATIONID IS IN THE RECONCILIATION MARKER', async () => {
    const { mod } = await load();
    const { fetcher, session } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      assert.equal(session.threadMarker.locationId, 'main');
      /* Four fields, and a change in any one of them is a change. */
      assert.deepEqual(Object.keys(session.threadMarker).sort(),
        ['conversationId', 'lastMessageAt', 'locationId', 'messageCount', 'status']);
    } finally {
      fetcher.restore();
    }
  });

  test('A TRANSFER IS INVISIBLE WITHOUT IT, and visible with it', async () => {
    /*
     * A transfer writes locationId and the audit stamps, and deliberately
     * touches neither lastMessageAt nor messageCount - nothing was said. A
     * marker of those two alone would leave the old shop's copy of the header
     * on screen, and a reply typed into a thread this account no longer holds.
     */
    const { mod } = await load();
    let where = 'main';
    const summary = () => Object.assign({}, CONV_A, { locationId: where });
    const { fetcher, clock, session } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => inboxWith([summary()], ['main', 'specialty', 'unassigned']),
        messages: () => jsonResponse(200,
          { ok: true, limit: 200, conversation: summary(), messages: [] })
      })
    });
    try {
      session.select('conv-a');
      await tick();
      const reads = () => fetcher.seen.filter(
        (r) => String(r.input).indexOf('/api/admin/chat/messages') !== -1).length;
      const before = reads();

      /* Nothing moved: no re-read. */
      clock.fireAll(); await tick();
      assert.equal(reads(), before, 'an unchanged conversation is not re-read');

      /* Somebody else moved it. lastMessageAt and messageCount are the same. */
      where = 'specialty';
      clock.fireAll(); await tick();
      assert.equal(reads(), before + 1, 'the move was noticed');
      assert.equal(session.threadMarker.locationId, 'specialty');
      assert.equal(session.thread.conversation.locationLabel,
        'Specialty Shop - Keith Street');
    } finally {
      fetcher.restore();
    }
  });

  /* ------------------------------------------------------ handing over */

  test('THE DESTINATIONS OFFERED ARE THE OTHER TWO SHOPS - not the ones this '
    + 'account can read', async () => {
      /*
       * Main-only staff who find a Keith Street job in their inbox must be
       * able to send it to Keith Street. Requiring destination access would
       * mean only a manager could ever fix a misroute, which is the opposite
       * of the point. The server agrees: it authorises the SOURCE.
       */
      const { mod } = await load();
      const { ui, fetcher, session } = await signedIn(mod, {
        responder: staffApi({ conversations: () => inboxWith([CONV_A], ['main']) })
      });
      try {
        session.select('conv-a');
        await tick();
        assert.equal(session.requestTransfer(), true);
        assert.equal(ui.transferRequests, 1);
        assert.deepEqual(ui.lastTransferOptions.map((o) => o.id),
          ['specialty', 'unassigned'], 'everywhere but where it already is');
        assert.deepEqual(ui.lastTransferOptions.map((o) => o.label),
          ['Specialty Shop - Keith Street', 'Not Sure / Unassigned']);
      } finally {
        fetcher.restore();
      }
    });

  test('the request is exactly conversationId and locationId', async () => {
    const { mod } = await load();
    const { ui, fetcher, session } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      session.requestTransfer();
      await ui.lastTransfer('specialty');
      await tick();

      const call = fetcher.seen.find(
        (r) => String(r.input).indexOf('/api/admin/chat/transfer') !== -1);
      assert.ok(call, 'it was sent');
      assert.equal(call.init.method, 'POST');
      const body = JSON.parse(call.init.body);
      /* No previousLocationId, no transferredBy, no staff uid: every audit
         field is the server's to write, and requireNoPrivilegedFields()
         refuses a body that tries. */
      assert.deepEqual(Object.keys(body).sort(), ['conversationId', 'locationId']);
      assert.equal(body.conversationId, 'conv-a');
      assert.equal(body.locationId, 'specialty');
      /* Both credentials, in their own channels, like every other staff
         request. */
      const h = call.init.headers;
      const auth = h.get ? h.get('authorization') : h['Authorization'];
      const ac = h.get ? h.get('x-firebase-appcheck') : h['X-Firebase-AppCheck'];
      assert.match(String(auth), /^Bearer /);
      assert.ok(ac, 'the App Check token is attached');
      assert.equal(String(ac).indexOf('Bearer'), -1, 'and not swapped');
    } finally {
      fetcher.restore();
    }
  });

  test('A DESTINATION THIS BUILD DOES NOT KNOW IS NOT SENT', async () => {
    const { mod } = await load();
    const { fetcher, session } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      const before = fetcher.seen.length;
      for (const bad of ['MAIN', ' main', 'shop-3', '', null, undefined, 7, {}]) {
        assert.equal(await session.transfer(bad), false, JSON.stringify(bad));
      }
      assert.equal(fetcher.seen.length, before, 'nothing left the browser');
    } finally {
      fetcher.restore();
    }
  });

  test('MOVING IT OUT OF REACH LETS GO OF IT, AND SAYS WHERE IT WENT',
    async () => {
      /*
       * The normal case for single-shop staff. Reading the transcript again
       * would be a 404 dressed up as an error, and a row vanishing with no
       * explanation is how people conclude they deleted something.
       */
      const { mod } = await load();
      const { ui, fetcher, session } = await signedIn(mod, {
        responder: staffApi({ conversations: () => inboxWith([CONV_A], ['main']) })
      });
      try {
        session.select('conv-a');
        await tick();
        session.requestTransfer();
        await ui.lastTransfer('specialty');
        await tick();

        assert.equal(session.selectedId, null, 'let go of deliberately');
        assert.equal(session.thread, null);
        assert.equal(session.threadMarker, null);
        assert.equal(ui.selected, null);
        assert.equal(ui.thread, null);
        assert.equal(ui.notice,
          'Moved to Specialty Shop - Keith Street. It is no longer in your inbox.');
        /* No transcript read after the move: it would only 404. */
        const readsAfter = fetcher.seen.slice(
          fetcher.seen.findIndex(
            (r) => String(r.input).indexOf('/transfer') !== -1))
          .filter((r) => String(r.input).indexOf('/api/admin/chat/messages') !== -1);
        assert.equal(readsAfter.length, 0);
      } finally {
        fetcher.restore();
      }
    });

  test('A MANAGER LETS GO OF IT TOO, so the destination keeps its alert',
    async () => {
      /*
       * CHANGED DELIBERATELY WHEN NOTIFICATIONS SHIPPED.
       *
       * A handoff raises attention for the DESTINATION shop. If a manager who
       * can read both shops kept the thread selected, the next poll would
       * re-render it, the render would acknowledge the new version, and the
       * destination's unread flag would be cleared by the very person who
       * handed the work over - before anybody at Keith Street had seen it.
       *
       * Deselecting is the smallest reliable fix: nothing re-renders, so
       * nothing acknowledges. Re-opening is an intentional act, and an
       * intentional act IS somebody looking.
       */
      const { mod } = await load();
      let where = 'main';
      const summary = () => Object.assign({}, CONV_A, { locationId: where });
      const { ui, fetcher, session } = await signedIn(mod, {
        responder: staffApi({
          conversations: () => inboxWith([summary()], ['main', 'specialty', 'unassigned']),
          messages: () => jsonResponse(200,
            { ok: true, limit: 200, conversation: summary(), messages: [] }),
          transfer: () => {
            where = 'specialty';
            return jsonResponse(200, { ok: true, conversationId: 'conv-a',
              locationId: 'specialty', previousLocationId: 'main', changed: true });
          }
        })
      });
      try {
        session.select('conv-a');
        await tick();
        session.requestTransfer();
        await ui.lastTransfer('specialty');
        await tick();

        assert.equal(session.selectedId, null, 'let go of, even by a manager');
        assert.equal(session.thread, null);
        assert.equal(ui.thread, null);
        /* And they are told it is still theirs to open - a manager losing the
           thread with no explanation reads as an error. */
        assert.equal(ui.notice, 'Moved to Specialty Shop - Keith Street. '
          + 'Open it again if you need to keep working on it.');
      } finally {
        fetcher.restore();
      }
    });

  test('THE LABEL IN THE CONFIRMATION IS DERIVED, NOT ECHOED', async () => {
    const { mod } = await load();
    const { ui, fetcher, session } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => inboxWith([CONV_A], ['main']),
        transfer: () => jsonResponse(200, { ok: true, conversationId: 'conv-a',
          locationId: 'specialty',
          locationLabel: '<script>alert(1)</script>', changed: true })
      })
    });
    try {
      session.select('conv-a');
      await tick();
      session.requestTransfer();
      await ui.lastTransfer('specialty');
      await tick();
      assert.equal(ui.notice,
        'Moved to Specialty Shop - Keith Street. It is no longer in your inbox.');
      assert.equal(JSON.stringify(ui.notices).indexOf('script'), -1);
    } finally {
      fetcher.restore();
    }
  });

  test('a closed conversation is not offered a move', async () => {
    const { mod } = await load();
    const closed = Object.assign({}, CONV_A, { status: 'closed' });
    const { ui, fetcher, session } = await signedIn(mod, {
      responder: staffApi({
        conversations: () => inboxWith([closed], ['main', 'specialty', 'unassigned']),
        messages: () => jsonResponse(200,
          { ok: true, limit: 200, conversation: closed, messages: [] })
      })
    });
    try {
      session.setFilter('closed');
      await tick();
      session.select('conv-a');
      await tick();
      assert.equal(session.isClosed(), true);
      assert.equal(session.requestTransfer(), false,
        'the server refuses it with conversation_closed; do not ask');
      assert.equal(ui.transferRequests, 0);
    } finally {
      fetcher.restore();
    }
  });

  test('ONE MOVE AT A TIME, and a failure goes and looks', async () => {
    const { mod } = await load();
    const { ui, fetcher, session } = await signedIn(mod, {
      responder: staffApi({
        transfer: () => jsonResponse(409, { ok: false,
          code: 'conversation_closed', error: 'closed' })
      })
    });
    try {
      session.select('conv-a');
      await tick();
      const before = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/transfer') !== -1).length;

      const a = session.transfer('specialty');
      const b = session.transfer('unassigned');   /* refused: one in flight */
      await Promise.all([a, b]);
      await tick();

      const after = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/transfer') !== -1).length;
      assert.equal(after, before + 1, 'a double-click is one request');
      assert.equal(ui.notice, 'That conversation has been closed.');
      assert.equal(ui.transferBusy, false, 'and the button came back');
      /* NO AUTOMATIC RETRY. An ambiguous failure may already have moved it. */
      assert.equal(ui.retry, null);
    } finally {
      fetcher.restore();
    }
  });

  test('a revoked session mid-move clears the screen rather than warning',
    async () => {
      const { mod } = await load();
      const { ui, fetcher, session } = await signedIn(mod, {
        responder: staffApi({
          transfer: () => jsonResponse(403, { ok: false, code: 'not_staff',
            error: 'no' })
        })
      });
      try {
        session.select('conv-a');
        await tick();
        await session.transfer('specialty');
        await tick();
        assert.equal(ui.phase, 'signed-out');
        assert.equal(ui.thread, null);
        assert.equal(ui.inbox.length, 0);
      } finally {
        fetcher.restore();
      }
    });

  /* ----------------------------------------------------- the source */

  test('FOUND IN THE BROWSER: no empty shop pill before a thread is chosen',
    () => {
      /*
       * .sc__loc is a bordered pill. Built without the hidden attribute it
       * rendered as a stray empty capsule beside "No conversation selected"
       * on first paint, before renderThread() had ever run. Caught in a
       * screenshot, not by reading this.
       */
      assert.match(STAFF_CODE,
        /const threadLoc = el\('span', \{ class: 'sc__loc sc__loc--head', text: '',\s*hidden: 'hidden' \}\)/);
    });

  test('the dashboard still has ZERO direct Firestore access', () => {
    /* Routing added an endpoint, not a door. */
    for (const forbidden of ['getFirestore', 'onSnapshot', 'collection(',
                             'doc(', 'firebase-firestore']) {
      assert.equal(STAFF_CODE.indexOf(forbidden), -1,
        'chat-staff.js reaches for ' + forbidden);
    }
  });

  test('no shop name is written into the dashboard', () => {
    for (const literal of ['Main Shop', 'Keith Street', 'First Ave',
                           'Specialty Shop', 'Not Sure']) {
      assert.equal(STAFF_CODE.indexOf(literal), -1,
        'chat-staff.js hard-codes ' + literal);
    }
    assert.match(STAFF_CODE, /from '\.\/chat-locations\.js\?v=/);
  });

  test('still no innerHTML, and the badge is textContent like everything else',
    () => {
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/
        .test(STAFF_CODE), false);
    });
});

/* ============================ 108-160. LOUD ALERTS AND UNREAD, ON THE PAGE */

/*
 * MAKING IT HARD TO MISS A CUSTOMER.
 *
 * The shop is not watching a browser tab. Somebody is at a brake, or on the
 * phone, or in another program - and a message that waits forty minutes is a
 * customer who phoned somebody else. These tests are about the noise, and
 * about the one thing that must stop it: an authorised person actually
 * opening the conversation.
 *
 * WHAT IS NOT TESTED HERE: whether a given account may see a given
 * conversation. That is decided by the server and proven against the real
 * emulator in tests/chat-api/unread.test.mjs. Everything below is what the
 * page does with an answer it has already been given.
 */
describe('the shop is told, until somebody looks', () => {
  const UNREAD = (over) => Object.assign({
    conversationId: 'c-new', customerName: 'John Smith',
    customerEmail: 'john@example.com', status: 'open',
    locationId: 'main', locationLabel: 'Main Shop - 1st Avenue',
    lastMessageAt: 5000, messageCount: 2,
    unread: true, attentionVersion: 4, lastAttentionType: 'customer_message',
    lastAttentionAt: 5000
  }, over || {});

  /*
   * A fake browser: a clock we drive, storage we can inspect, a Notification
   * constructor that records instead of popping, and an AudioContext that
   * counts oscillators instead of making a noise. Every one of these is
   * injected, because none of them can be driven honestly otherwise.
   */
  function fakeBrowser(over) {
    const o = over || {};
    const state = {
      now: 1000000,
      notifications: [],
      requested: 0,
      sounds: 0,
      title: "Esther's Staff Chat",
      store: new Map(),
      audioFails: o.audioFails === true
    };
    function Notif(title, opts) {
      const o2 = opts || {};
      /*
       * The platform throws TypeError for renotify WITHOUT a tag - measured
       * in a real Chromium build, see the QA notes. The fake throws for the
       * same input, so a call site that forgot the tag fails here rather than
       * on a shop computer.
       */
      if (o2.renotify === true && (typeof o2.tag !== 'string' || o2.tag === '')) {
        throw new TypeError('renotify without a tag');
      }
      state.notifications.push({ title: title, body: o2.body,
        tag: o2.tag, renotify: o2.renotify });
    }
    Notif.permission = o.permission || 'granted';
    Notif.requestPermission = async () => {
      state.requested += 1;
      Notif.permission = o.grantOnRequest === false ? 'denied' : 'granted';
      return Notif.permission;
    };
    state.Notif = Notif;

    state.deps = {
      now: () => state.now,
      storage: () => (o.noStorage ? null : {
        getItem: (k) => (state.store.has(k) ? state.store.get(k) : null),
        setItem: (k, v) => { state.store.set(k, String(v)); },
        removeItem: (k) => { state.store.delete(k); }
      }),
      document: () => ({
        get title() { return state.title; },
        set title(v) { state.title = v; }
      }),
      notificationApi: () => (o.noNotificationApi ? null : Notif),
      audioContext: () => {
        if (state.audioFails) return null;
        return {
          state: 'running',
          currentTime: 0,
          resume: () => {},
          createOscillator: () => ({
            type: '', frequency: { value: 0 },
            connect: () => {}, start: () => { state.sounds += 1; }, stop: () => {}
          }),
          createGain: () => ({
            gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
            connect: () => {}
          }),
          destination: {}
        };
      }
    };
    /* Three oscillators per chime - see CHIME in chat-staff-alerts.js. */
    state.chimes = () => state.sounds / 3;
    return state;
  }

  async function alertsFor(browser) {
    const { createAlerts } = await import(ALERTS_URL);
    return createAlerts({ deps: browser.deps });
  }

  /* ---------------------------------------------------- the alert engine */

  test('NO ALERT FOR A CONVERSATION THAT IS ALREADY READ', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.sounds = 0; b.notifications.length = 0;

    const out = alerts.observe([UNREAD({ unread: false })]);
    assert.equal(out.unreadCount, 0);
    assert.deepEqual(out.fired, []);
    assert.equal(b.notifications.length, 0);
    assert.equal(b.chimes(), 0);
  });

  test('ONE INITIAL ALERT PER conversationId + attentionVersion', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.sounds = 0; b.notifications.length = 0;

    /* The same poll answer, ten times over. */
    for (let i = 0; i < 10; i += 1) alerts.observe([UNREAD()]);
    assert.equal(b.notifications.length, 1, 'ten polls, one alert');
    assert.equal(b.chimes(), 1);
    assert.deepEqual(alerts._pending(), ['c-new:4']);
  });

  test('a NEW version is a new alert', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.sounds = 0; b.notifications.length = 0;

    alerts.observe([UNREAD({ attentionVersion: 4 })]);
    alerts.observe([UNREAD({ attentionVersion: 4 })]);
    assert.equal(b.notifications.length, 1);

    /* The customer wrote again. */
    alerts.observe([UNREAD({ attentionVersion: 5 })]);
    assert.equal(b.notifications.length, 2, 'the second message is heard');
    /* And the old key is gone, so it cannot remind about a version that is
       no longer outstanding. */
    assert.deepEqual(alerts._pending(), ['c-new:5']);
  });

  test('THE EXACT SHOP NAME IS IN EVERY NOTIFICATION', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    alerts.observe([
      UNREAD({ conversationId: 'a', locationId: 'main',
        locationLabel: 'Main Shop - 1st Avenue' }),
      UNREAD({ conversationId: 'b', locationId: 'specialty',
        locationLabel: 'Specialty Shop - Keith Street',
        customerName: 'ABC Construction' }),
      UNREAD({ conversationId: 'c', locationId: 'unassigned',
        locationLabel: 'Not Sure / Unassigned', customerName: 'Pat' })
    ]);

    assert.equal(b.notifications[0].title,
      'New customer message — Main Shop - 1st Avenue');
    assert.equal(b.notifications[0].body, 'John Smith is waiting for a reply.');
    assert.equal(b.notifications[1].title,
      'New customer message — Specialty Shop - Keith Street');
    assert.equal(b.notifications[1].body,
      'ABC Construction is waiting for a reply.');
    assert.equal(b.notifications[2].title,
      'New customer message — Not Sure / Unassigned');
    assert.equal(b.notifications[2].body, 'Pat is waiting for a reply.');
  });

  test('NO CUSTOMER MESSAGE TEXT IS EVER IN A NOTIFICATION', async () => {
    /*
     * A native notification lands on whatever screen the browser is on, and a
     * shop monitor faces the counter. Making a message impossible to MISS
     * does not require putting its contents in front of whoever is standing
     * there before a staff member has opened the thread.
     *
     * The engine is handed a conversation carrying every field-name a message
     * body might arrive under. None of them reaches a notification.
     */
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    const secret = 'THE-QUOTE-IS-FOUR-THOUSAND-DOLLARS';
    alerts.observe([UNREAD({
      lastMessagePreview: secret, messagePreview: secret, preview: secret,
      lastMessageBody: secret, lastMessageText: secret, snippet: secret,
      body: secret, message: secret,
      customerEmail: 'john@example.com'
    })]);

    const n = b.notifications[0];
    const whole = JSON.stringify(n);
    assert.equal(whole.indexOf(secret), -1, 'message text reached a notification');
    assert.equal(whole.indexOf('@example.com'), -1, 'the email leaked');
    assert.equal(n.body, 'John Smith is waiting for a reply.');
  });

  test('A CONVERSATION WITH NO NAME STILL SAYS SOMEBODY IS WAITING',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      for (const nameless of [undefined, null, '', '   ', 42]) {
        b.notifications.length = 0;
        alerts.observe([UNREAD({ conversationId: 'n' + String(nameless),
          customerName: nameless })]);
        assert.equal(b.notifications[0].body,
          'A customer is waiting for a reply.', JSON.stringify(nameless));
      }
    });

  test('A TRANSFER IS NOT ANNOUNCED AS A NEW MESSAGE', async () => {
    /* Sending somebody looking for words the customer never wrote is worse
       than not telling them at all. */
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    alerts.observe([UNREAD({ lastAttentionType: 'transfer',
      locationLabel: 'Specialty Shop - Keith Street',
      customerName: 'ABC Construction' })]);
    assert.equal(b.notifications[0].title,
      'Conversation transferred — Specialty Shop - Keith Street');
    assert.equal(b.notifications[0].body,
      'ABC Construction — this conversation was moved to your shop.');
    assert.equal(b.notifications[0].body.indexOf('waiting for a reply'), -1,
      'a handoff is not described as a new message');
  });

  /* ------------------------------------------------------------------------
   * THE PLATFORM IDENTITY.
   *
   * THIS SECTION EXISTS BECAUSE OF A PRODUCTION BUG, and the test it replaces
   * is the one that certified the bug as correct.
   *
   * The old code tagged every notification with the conversation id alone and
   * sent renotify:false. A platform treats a repeated tag as the SAME
   * notification and replaces it in place; with renotify false that
   * replacement is silent. On Windows, Chrome raised a banner for the first
   * notification of a tag and quietly rewrote it for every one after. The
   * chime still played - it is Web Audio in this file and owes the
   * notification nothing - so the symptom was "sound but no banner".
   *
   * Counting notifications, which is what the rest of this suite does, could
   * never have caught it: the count was always right. What was wrong was the
   * IDENTITY, so these tests assert identities.
   * --------------------------------------------------------------------- */

  /* Every notification must carry a non-empty tag AND renotify:true. The
     fake constructor throws on renotify without a tag, exactly as Chromium
     does, so this is a real constraint and not a formality. */
  function assertFreshBanner(n, why) {
    assert.equal(typeof n.tag, 'string', why + ': has a tag');
    assert.notEqual(n.tag, '', why + ': the tag is not empty');
    assert.equal(n.renotify, true, why + ': renotify re-alerts on a collision');
  }

  test('FIVE TEST ALERT PRESSES ARE FIVE DISTINCT NOTIFICATIONS', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    const tags = [];
    for (let i = 0; i < 5; i += 1) {
      /* Real presses land on the same millisecond in a test and often in
         life. The identity must not depend on the clock moving. */
      const r = alerts.test();
      assert.equal(r.shown, true, 'press ' + (i + 1) + ' showed something');
      tags.push(r.tag);
    }

    assert.equal(b.notifications.length, 5, 'five constructor calls');
    for (const n of b.notifications) assertFreshBanner(n, 'test alert');
    assert.equal(new Set(b.notifications.map(n => n.tag)).size, 5,
      'FIVE DISTINCT TAGS - nothing for the platform to collapse');
    assert.equal(new Set(tags).size, 5, 'and the caller is told each identity');
  });

  test('the test alert stays inert: no API call, no unread, no read ack',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      b.notifications.length = 0;

      const before = alerts._pending().slice();
      alerts.test();
      alerts.test();

      assert.deepEqual(alerts._pending(), before,
        'the dedupe ledger is untouched - no invented unread');
      assert.equal(b.title, "Esther's Staff Chat",
        'and no unread count appears in the tab title');
    });

  test('A SECOND MESSAGE IN THE SAME THREAD IS A SECOND BANNER', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    /* Two genuine customer messages, one conversation. This is the case the
       shop cares about most and the one the old tag silently swallowed. */
    alerts.observe([UNREAD({ attentionVersion: 4 })]);
    alerts.observe([UNREAD({ attentionVersion: 5 })]);

    assert.equal(b.notifications.length, 2, 'two notification attempts');
    for (const n of b.notifications) assertFreshBanner(n, 'new message');
    assert.equal(b.notifications[0].tag, 'esthers-chat:c-new:v4');
    assert.equal(b.notifications[1].tag, 'esthers-chat:c-new:v5');
    assert.notEqual(b.notifications[0].tag, b.notifications[1].tag,
      'VERSION 5 DOES NOT SILENTLY REPLACE VERSION 4');
  });

  test('ten polls of one version are one notification, with one identity',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      b.notifications.length = 0;

      for (let i = 0; i < 10; i += 1) {
        /* Well inside the reminder cooldown, so nothing here is a reminder. */
        b.now += 1000;
        alerts.observe([UNREAD({ attentionVersion: 7 })]);
      }
      assert.equal(b.notifications.length, 1,
        'the application dedupe is still conversationId + attentionVersion');
      assert.equal(b.notifications[0].tag, 'esthers-chat:c-new:v7');
    });

  test('EACH REMINDER IS ITS OWN BANNER, NOT A REWRITE OF THE LAST',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      b.notifications.length = 0;

      alerts.observe([UNREAD()]);              /* initial */
      b.now += REMINDER_WINDOW;
      alerts.observe([UNREAD()]);              /* reminder 1 */
      b.now += REMINDER_WINDOW;
      alerts.observe([UNREAD()]);              /* reminder 2 */

      assert.equal(b.notifications.length, 3);
      for (const n of b.notifications) assertFreshBanner(n, 'reminder');
      const tags = b.notifications.map(n => n.tag);
      assert.deepEqual(tags, [
        'esthers-chat:c-new:v4',
        'esthers-chat:c-new:v4:r1',
        'esthers-chat:c-new:v4:r2'
      ], 'the reminder sequence keeps each nudge distinct');
      assert.equal(new Set(tags).size, 3, 'three identities, three banners');
    });

  test('a transfer raises its own fresh identity too', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    alerts.observe([UNREAD({ attentionVersion: 4 })]);
    alerts.observe([UNREAD({ attentionVersion: 5,
      lastAttentionType: 'transfer',
      locationId: 'specialty',
      locationLabel: 'Specialty Shop - Keith Street',
      customerName: 'ABC Construction' })]);

    assert.equal(b.notifications.length, 2);
    const n = b.notifications[1];
    assertFreshBanner(n, 'transfer');
    assert.equal(n.tag, 'esthers-chat:c-new:v5');
    assert.notEqual(n.tag, b.notifications[0].tag,
      'the handover is not a silent rewrite of the message before it');
    assert.equal(n.title, 'Conversation transferred — Specialty Shop - Keith Street');
    assert.equal(n.body, 'ABC Construction — this conversation was moved to your shop.');
  });

  test('READ STOPS EVERYTHING, AND A LATER VERSION STILL GETS THROUGH',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      b.notifications.length = 0;

      alerts.observe([UNREAD({ attentionVersion: 4 })]);
      assert.equal(b.notifications.length, 1);

      /* Somebody looked - on this computer or the other one. */
      alerts.observe([UNREAD({ attentionVersion: 4, unread: false })]);
      b.now += REMINDER_WINDOW * 3;
      alerts.observe([UNREAD({ attentionVersion: 4, unread: false })]);
      assert.equal(b.notifications.length, 1, 'no popup, no reminder');
      assert.equal(b.title, "Esther's Staff Chat", 'and the badge is gone');

      /* The customer writes again. That is a new event and must be heard. */
      alerts.observe([UNREAD({ attentionVersion: 5 })]);
      assert.equal(b.notifications.length, 2);
      assert.equal(b.notifications[1].tag, 'esthers-chat:c-new:v5');
    });

  test('the identity carries no customer message text and no preview',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      b.notifications.length = 0;

      alerts.observe([UNREAD({
        lastMessagePreview: 'the quote for the flashing is too high',
        lastMessage: 'the quote for the flashing is too high'
      })]);
      const n = b.notifications[0];
      for (const field of [n.tag, n.title, n.body]) {
        assert.equal(field.indexOf('flashing'), -1,
          'no customer words reach the platform, not even in the tag');
        assert.equal(field.indexOf('quote'), -1);
      }
      assert.equal(n.tag, 'esthers-chat:c-new:v4',
        'the tag is ids and a version, nothing else');
    });

  test('the ledger stays bounded: it holds only what is unread right now',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();

      /* Fifty reminders on one conversation. The reminder SEQUENCE grows, but
         it lives inside the one entry that is already there - no new keys. */
      for (let i = 0; i < 50; i += 1) {
        alerts.observe([UNREAD()]);
        b.now += REMINDER_WINDOW;
      }
      assert.equal(alerts._pending().length, 1, 'one unread, one ledger entry');

      alerts.observe([UNREAD({ unread: false })]);
      assert.equal(alerts._pending().length, 0, 'read empties it');
    });

  test('HOSTILE CUSTOMER TEXT CANNOT INJECT ANYTHING', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    alerts.observe([UNREAD({
      customerName: '<img src=x onerror="alert(1)">\nsecond\x07line'
    })]);
    const n = b.notifications[0];
    /* It survives as TEXT - the Notification API renders a body as text, not
       markup, and every other destination is textContent. What is stripped is
       the control characters and the newline, which would only make a
       notification unreadable. */
    assert.equal(n.body,
      '<img src=x onerror="alert(1)"> second line is waiting for a reply.');
    assert.equal(n.body.indexOf('\n'), -1, 'flattened');
    assert.equal(n.body.indexOf('\x07'), -1, 'no terminal bell');
    assert.ok(n.body.length < 400, 'and bounded');
  });

  test('AN OVERSIZED OR HOSTILE SHOP LABEL IS BOUNDED TOO', async () => {
    /*
     * The label reaching this module is derived by chat-staff.js from the
     * location id, so in production it is one of exactly three strings. That
     * is a promise made in another file, and this is the seatbelt: even
     * handed something arbitrary, a notification title stays a readable line
     * rather than four kilobytes with a newline in it.
     */
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    alerts.observe([UNREAD({
      locationLabel: 'X'.repeat(4000) + '\nsecond\x07line' })]);
    const t = b.notifications[0].title;
    assert.ok(t.length < 200, 'bounded: ' + t.length);
    assert.equal(t.indexOf('\n'), -1, 'flattened');
    assert.equal(t.indexOf('\x07'), -1, 'no terminal bell');
    assert.match(t, /^New customer message — X+$/);
  });

  test('a very long name or message cannot make a notification unreadable',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      b.notifications.length = 0;
      alerts.observe([UNREAD({ customerName: 'N'.repeat(4000) })]);
      assert.ok(b.notifications[0].body.length <= 260);
    });

  /* ------------------------------------------------------- the reminders */

  test('NO REMINDER BEFORE THE COOLDOWN', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    alerts.observe([UNREAD()]);
    assert.equal(b.notifications.length, 1, 'the initial alert');

    /* Every fifteen seconds for just under three minutes. */
    for (let t = 15000; t < REMINDER_WINDOW; t += 15000) {
      b.now += 15000;
      alerts.observe([UNREAD()]);
    }
    assert.equal(b.notifications.length, 1, 'and not one more');
  });

  test('A REMINDER AFTER THE COOLDOWN, AND THEN AGAIN', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;

    alerts.observe([UNREAD()]);
    b.now += REMINDER_WINDOW;
    const out = alerts.observe([UNREAD()]);
    assert.equal(out.fired.length, 1);
    assert.equal(out.fired[0].kind, 'reminder');
    assert.equal(b.notifications.length, 2);

    /* And it keeps going while it stays unread. */
    b.now += REMINDER_WINDOW;
    alerts.observe([UNREAD()]);
    assert.equal(b.notifications.length, 3);
  });

  test('THE REMINDER STOPS THE MOMENT THE SERVER SAYS SOMEBODY LOOKED',
    async () => {
      /*
       * The core promise. Another computer marked it read; this browser's
       * next poll returns unread=false; the reminder stops here without this
       * machine doing anything at all.
       */
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      b.notifications.length = 0;

      alerts.observe([UNREAD()]);
      assert.deepEqual(alerts._pending(), ['c-new:4']);

      /* Somebody in the office opened it. */
      alerts.observe([UNREAD({ unread: false })]);
      assert.deepEqual(alerts._pending(), [], 'nothing is owed any more');

      b.now += REMINDER_WINDOW * 3;
      alerts.observe([UNREAD({ unread: false })]);
      assert.equal(b.notifications.length, 1, 'the initial one, and no more');
    });

  test('a closed conversation never alerts or reminds', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;
    const out = alerts.observe([UNREAD({ status: 'closed' })]);
    assert.equal(out.unreadCount, 0);
    assert.equal(b.notifications.length, 0);
  });

  /* -------------------------------------------------------- mute, prefs */

  test('MUTED SILENCES THE SOUND, NOT THE UNREAD STATE', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    alerts.setMuted(true);
    b.sounds = 0; b.notifications.length = 0;

    const out = alerts.observe([UNREAD()]);
    assert.equal(b.chimes(), 0, 'no sound');
    assert.equal(b.notifications.length, 1, 'but the popup still appears');
    assert.equal(out.unreadCount, 1, 'and the count is unchanged');
    assert.equal(b.title, "\u{1F534} (1) Esther's Staff Chat", 'and so is the title');
  });

  test('ONLY TWO HARMLESS BOOLEANS ARE STORED', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();
    alerts.setMuted(true);
    alerts.observe([UNREAD()]);

    assert.deepEqual(Array.from(b.store.keys()), ['esthers.staff.alerts'],
      'one namespaced key, and only one');
    const stored = JSON.parse(b.store.get('esthers.staff.alerts'));
    assert.deepEqual(Object.keys(stored).sort(), ['alertsEnabled', 'muted']);
    assert.equal(stored.alertsEnabled, true);
    assert.equal(stored.muted, true);

    /* Nothing that could be a credential, an identity, or a customer. */
    const dump = JSON.stringify(Array.from(b.store.entries()));
    for (const secret of ['token', 'Bearer', 'password', 'uid', 'John Smith',
                          'chimney', 'appcheck', 'AppCheck', '@example',
                          'waiting for a reply']) {
      assert.equal(dump.indexOf(secret), -1, secret + ' was persisted');
    }
  });

  test('the preference survives a reload; the audio unlock does not', async () => {
    const b = fakeBrowser();
    const first = await alertsFor(b);
    await first.enable();
    assert.equal(first.status().audio, true);

    /* A new page load, same storage. */
    const second = await alertsFor(b);
    assert.equal(second.status().enabled, true, 'the preference is remembered');
    assert.equal(second.status().audio, false,
      'but a browser requires a fresh gesture per page load, and we say so');
  });

  test('unreadable stored preferences fall back to quiet', async () => {
    const b = fakeBrowser();
    b.store.set('esthers.staff.alerts', 'not json at all');
    const alerts = await alertsFor(b);
    assert.equal(alerts.status().enabled, false);
    assert.equal(alerts.status().muted, false);
  });

  test('blocked storage does not break anything', async () => {
    const b = fakeBrowser({ noStorage: true });
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.notifications.length = 0;
    alerts.observe([UNREAD()]);
    assert.equal(b.notifications.length, 1, 'alerts still work');
  });

  /* ------------------------------------------------- permission fallback */

  test('PERMISSION DENIED KEEPS THE SOUND, THE BADGE AND THE TITLE', async () => {
    const b = fakeBrowser({ permission: 'denied' });
    const alerts = await alertsFor(b);
    await alerts.enable();
    b.sounds = 0; b.notifications.length = 0;

    const out = alerts.observe([UNREAD()]);
    assert.equal(b.notifications.length, 0, 'no desktop popup, as expected');
    assert.equal(b.chimes(), 1, 'but the sound still plays');
    assert.equal(out.unreadCount, 1);
    assert.equal(b.title, "\u{1F534} (1) Esther's Staff Chat");
    assert.equal(alerts.status().permission, 'denied');
  });

  test('a denial is not re-prompted', async () => {
    const b = fakeBrowser({ permission: 'denied' });
    const alerts = await alertsFor(b);
    await alerts.enable();
    await alerts.enable();
    await alerts.enable();
    assert.equal(b.requested, 0, 'the browser would refuse anyway');
  });

  test('NO NOTIFICATION API AT ALL DEGRADES SAFELY', async () => {
    const b = fakeBrowser({ noNotificationApi: true });
    const alerts = await alertsFor(b);
    const st = await alerts.enable();
    assert.equal(st.supported, false);
    assert.equal(st.permission, 'unsupported');

    b.sounds = 0;
    const out = alerts.observe([UNREAD()]);
    assert.equal(b.chimes(), 1, 'sound still works');
    assert.equal(out.unreadCount, 1);
    assert.equal(b.title, "\u{1F534} (1) Esther's Staff Chat");
  });

  test('no audio device degrades safely too', async () => {
    const b = fakeBrowser({ audioFails: true });
    const alerts = await alertsFor(b);
    const st = await alerts.enable();
    assert.equal(st.audio, false);
    b.notifications.length = 0;
    alerts.observe([UNREAD()]);
    assert.equal(b.notifications.length, 1, 'the popup still appears');
  });

  /* ------------------------------------------------------------- title */

  test('THE TAB TITLE CARRIES THE UNREAD COUNT, AND GIVES IT BACK', async () => {
    const b = fakeBrowser();
    const alerts = await alertsFor(b);
    await alerts.enable();

    alerts.observe([UNREAD({ conversationId: 'a' }), UNREAD({ conversationId: 'b' })]);
    assert.equal(b.title, "\u{1F534} (2) Esther's Staff Chat");

    alerts.observe([UNREAD({ conversationId: 'a' })]);
    assert.equal(b.title, "\u{1F534} (1) Esther's Staff Chat");

    alerts.observe([]);
    assert.equal(b.title, "Esther's Staff Chat", 'restored exactly');
  });

  test('reset puts the title back, so a signed-out page tells no tales',
    async () => {
      const b = fakeBrowser();
      const alerts = await alertsFor(b);
      await alerts.enable();
      alerts.observe([UNREAD()]);
      assert.match(b.title, /^\u{1F534} \(1\)/u);
      alerts.reset();
      assert.equal(b.title, "Esther's Staff Chat");
      assert.deepEqual(alerts._pending(), []);
    });
});

/* ================= 161-190. WHAT COUNTS AS READING, AND WHEN WE POLL */

/*
 * "READ" MEANS SOMEBODY ACTUALLY OPENED IT.
 *
 * Not that it appeared in a list. Not that a poll returned it. Not that a
 * notification popped. Not that a background tab fetched something. A person
 * looked at a transcript, on a screen that was in front of them.
 *
 * Every test below is one of the ways that could go wrong, and each of them
 * would silently lose a customer: the shop would stop being reminded about a
 * message nobody has read.
 */
describe('reading is looking, and nothing else', () => {
  const CONV_UNREAD = Object.assign({}, CONV_A, {
    unread: true, attentionVersion: 4, lastAttentionType: 'customer_message',
    lastAttentionAt: 5000
  });

  const openInbox = (list, locations) => jsonResponse(200, {
    ok: true, status: 'open', limit: 50,
    conversations: list,
    locations: locations || ['main', 'specialty', 'unassigned']
  });

  /* Records every read acknowledgement, so a test can assert on exactly what
     was acknowledged and how often - or that nothing was. */
  function world(over) {
    const o = over || {};
    const w = {
      conversation: o.conversation || CONV_UNREAD,
      reads: [],
      messageCalls: 0,
      inboxCalls: 0,
      attentionCalls: 0
    };
    w.responder = (n, input, init) => {
      const url = String(input);
      if (url.indexOf('/api/admin/chat/conversations') === 0) {
        w.inboxCalls += 1;
        if (url.indexOf('status=open') !== -1) w.attentionCalls += 1;
        const closed = url.indexOf('status=closed') !== -1;
        return openInbox(closed ? [] : [w.conversation]);
      }
      if (url.indexOf('/api/admin/chat/messages') === 0) {
        w.messageCalls += 1;
        if (o.threadFails) return jsonResponse(500, { ok: false, code: 'server_error' });
        return jsonResponse(200, { ok: true, limit: 200,
          conversation: w.conversation, messages: [] });
      }
      if (url.indexOf('/api/admin/chat/read') === 0) {
        w.reads.push(JSON.parse(init.body));
        return jsonResponse(200, { ok: true, conversationId: 'conv-a',
          attentionVersion: w.conversation.attentionVersion,
          readVersion: w.conversation.attentionVersion, unread: false });
      }
      if (url.indexOf('/api/admin/chat/transfer') === 0) {
        return jsonResponse(200, { ok: true, conversationId: 'conv-a',
          locationId: 'specialty', previousLocationId: 'main', changed: true });
      }
      return jsonResponse(500, { ok: false, code: 'unexpected_call' });
    };
    return w;
  }

  /* --------------------------------------------- what does NOT mark read */

  test('APPEARING IN THE INBOX IS NOT READING IT', async () => {
    const { mod } = await load();
    const w = world();
    const { ui, fetcher, clock } = await signedIn(mod, { responder: w.responder });
    try {
      /* Several polls. The row is there, unread, the whole time. */
      clock.fireAll(); await tick();
      clock.fireAll(); await tick();
      assert.equal(w.reads.length, 0, 'nothing was acknowledged');
      assert.equal(ui.inbox[0].unread, true, 'and it still says so');
    } finally {
      fetcher.restore();
    }
  });

  test('A HIDDEN TAB NEVER MARKS ANYTHING READ', async () => {
    /*
     * The one that would quietly break the whole feature: a background tab
     * that fetched a transcript and acknowledged it would clear the shop's
     * unread flag having shown nobody anything.
     */
    const { mod } = await load();
    const w = world();
    const { fetcher, clock, session } = await signedIn(mod, { responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      assert.equal(w.reads.length, 1, 'visible: acknowledged once');

      clock.hide();
      w.conversation = Object.assign({}, CONV_UNREAD, { attentionVersion: 5 });
      /* Force a transcript render while hidden - the path a reconciliation
         would take if visibility were not checked. */
      await session.loadThread('conv-a', { silent: true });
      await tick();
      assert.equal(w.reads.length, 1, 'hidden: NOT acknowledged');
    } finally {
      fetcher.restore();
    }
  });

  test('A FAILED TRANSCRIPT REQUEST NEVER MARKS READ', async () => {
    const { mod } = await load();
    const w = world({ threadFails: true });
    const { fetcher, session } = await signedIn(mod, { responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      assert.ok(w.messageCalls >= 1, 'it really did try');
      assert.equal(w.reads.length, 0, 'and acknowledged nothing');
    } finally {
      fetcher.restore();
    }
  });

  test('CHANGING SELECTION BEFORE THE ANSWER LANDS MARKS NOTHING', async () => {
    /*
     * Acknowledging here would mark the WRONG conversation read - the one the
     * person clicked away from, which they may never have seen.
     */
    const { mod } = await load();
    const w = world();
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = false;
    const { fetcher, session } = await signedIn(mod, {
      responder: async (n, input, init) => {
        if (String(input).indexOf('/api/admin/chat/messages') === 0 && gated) {
          await gate;
        }
        return w.responder(n, input, init);
      }
    });
    try {
      gated = true;
      session.select('conv-a');
      await tick(1);
      /* The person clicks away while the transcript is still in flight. */
      session.select(null);
      release();
      await tick();
      assert.equal(w.reads.length, 0, 'the one they left is not marked read');
    } finally {
      fetcher.restore();
    }
  });

  test('THE SELECTION CHECK IN acknowledgeRead HOLDS BY ITSELF', async () => {
    /*
     * loadThread() already discards a response that lands after the selection
     * moved, so through the ordinary path this second check never fires -
     * which means deleting it is invisible end to end. Mutation testing said
     * so. It is the copy that matters: it is what stands between a late
     * answer and the WRONG conversation being marked read.
     */
    const { mod } = await load();
    const w = world();
    const { fetcher, session } = await signedIn(mod, { responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      const before = w.reads.length;

      /* Hand it a transcript for a conversation that is NOT selected. */
      session.selectedId = 'somebody-else';
      await session.acknowledgeRead({ conversationId: 'conv-a',
        attentionVersion: 9 });
      assert.equal(w.reads.length, before, 'refused, on its own');

      /* And it accepts the selected one, so the refusal above is the check
         and not a function that refuses everything. */
      session.selectedId = 'conv-a';
      await session.acknowledgeRead({ conversationId: 'conv-a',
        attentionVersion: 9 });
      assert.equal(w.reads.length, before + 1);
      assert.equal(w.reads[before].attentionVersion, 9);
    } finally {
      fetcher.restore();
    }
  });

  /* ------------------------------------------------ what DOES mark read */

  test('A VISIBLE RENDER MARKS EXACTLY THE VERSION IT RENDERED', async () => {
    const { mod } = await load();
    const w = world();
    const { ui, fetcher, session } = await signedIn(mod, { responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      assert.equal(w.reads.length, 1);
      assert.deepEqual(w.reads[0],
        { conversationId: 'conv-a', attentionVersion: 4 },
        'exactly two fields, and the version that was on screen');
      /* And the row stops shouting immediately, rather than after a poll. */
      assert.equal(ui.inbox[0].unread, false);
      assert.equal(session.unreadCounts().total, 0);
    } finally {
      fetcher.restore();
    }
  });

  test('the same version is not acknowledged twice by one tab', async () => {
    const { mod } = await load();
    const w = world();
    const { fetcher, clock, session } = await signedIn(mod, { responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      assert.equal(w.reads.length, 1);

      /* Several reconciliation re-reads of an unchanged thread. */
      for (let i = 0; i < 3; i += 1) {
        await session.loadThread('conv-a', { silent: true });
        await tick();
      }
      assert.equal(w.reads.length, 1, 'one request, not four');
    } finally {
      fetcher.restore();
    }
  });

  test('a NEWER version IS acknowledged when it is rendered', async () => {
    const { mod } = await load();
    const w = world();
    const { fetcher, session } = await signedIn(mod, { responder: w.responder });
    try {
      session.select('conv-a');
      await tick();
      w.conversation = Object.assign({}, CONV_UNREAD, { attentionVersion: 5 });
      await session.loadThread('conv-a', {});
      await tick();
      assert.equal(w.reads.length, 2);
      assert.equal(w.reads[1].attentionVersion, 5);
    } finally {
      fetcher.restore();
    }
  });

  test('a failing read acknowledgement is silent and does not retry-storm',
    async () => {
      const { mod } = await load();
      const w = world();
      const { ui, fetcher, clock, session } = await signedIn(mod, {
        responder: (n, input, init) => {
          if (String(input).indexOf('/api/admin/chat/read') === 0) {
            w.reads.push(JSON.parse(init.body));
            return new TypeError('network');
          }
          return w.responder(n, input, init);
        }
      });
      try {
        session.select('conv-a');
        await tick();
        const after = w.reads.length;
        assert.equal(after, 1);
        /* Nothing on screen depends on it, so nothing is said about it. */
        assert.equal(ui.notice, null);
        assert.equal(ui.retry, null);
        /* And it does not hammer: the next poll re-renders nothing new. */
        clock.fireAll(); await tick();
        clock.fireAll(); await tick();
        assert.ok(w.reads.length <= after + 1, 'no storm');
      } finally {
        fetcher.restore();
      }
    });

  /* -------------------------------------------------- transfer handover */

  test('THE PERSON WHO TRANSFERS DOES NOT ACKNOWLEDGE THE DESTINATION',
    async () => {
      /*
       * A handoff raises attention for the DESTINATION shop. If the thread
       * stayed selected, the next poll would re-render it and the render
       * would acknowledge the new version - clearing Keith Street's unread
       * flag before anybody there had seen it. Deselecting is what stops it.
       */
      const { mod } = await load();
      const w = world();
      const { ui, fetcher, clock, session } = await signedIn(mod, {
        responder: w.responder });
      try {
        session.select('conv-a');
        await tick();
        const before = w.reads.length;

        session.requestTransfer();
        await ui.lastTransfer('specialty');
        await tick();

        assert.equal(session.selectedId, null, 'let go of');
        assert.equal(ui.thread, null, 'and the transcript is off the screen');

        /* The destination's new attention arrives on the next poll. */
        w.conversation = Object.assign({}, CONV_UNREAD,
          { attentionVersion: 5, lastAttentionType: 'transfer',
            locationId: 'specialty',
            locationLabel: 'Specialty Shop - Keith Street' });
        clock.fireAll(); await tick();
        clock.fireAll(); await tick();

        assert.equal(w.reads.length, before,
          'the transferring computer acknowledged nothing further');
        assert.equal(ui.inbox[0].unread, true, 'Keith Street still has it');
      } finally {
        fetcher.restore();
      }
    });

  test('a thread moved out of reach is cleared from the screen', async () => {
    const { mod } = await load();
    const w = world();
    const { ui, fetcher, session } = await signedIn(mod, {
      responder: (n, input, init) => {
        const url = String(input);
        if (url.indexOf('/api/admin/chat/conversations') === 0) {
          return jsonResponse(200, { ok: true, status: 'open', limit: 50,
            conversations: [w.conversation], locations: ['main'] });
        }
        return w.responder(n, input, init);
      }
    });
    try {
      session.select('conv-a');
      await tick();
      session.requestTransfer();
      await ui.lastTransfer('specialty');
      await tick();
      assert.equal(session.selectedId, null);
      assert.equal(ui.thread, null);
      assert.equal(ui.notice, 'Moved to Specialty Shop - Keith Street. '
        + 'It is no longer in your inbox.');
    } finally {
      fetcher.restore();
    }
  });

  /* --------------------------------------------------- another computer */

  test("ANOTHER COMPUTER'S READ CLEARS THIS ONE ON THE NEXT POLL", async () => {
    const { mod } = await load();
    const w = world();
    const { ui, fetcher, clock, session } = await signedIn(mod, {
      responder: w.responder });
    try {
      clock.fireAll(); await tick();
      assert.equal(ui.inbox[0].unread, true);
      assert.equal(session.unreadCounts().total, 1);

      /* The office computer opened it. Nothing happens on THIS machine. */
      w.conversation = Object.assign({}, CONV_UNREAD, { unread: false });
      clock.fireAll(); await tick();

      assert.equal(ui.inbox[0].unread, false, 'the badge goes');
      assert.equal(session.unreadCounts().total, 0, 'and so does the count');
      assert.equal(w.reads.length, 0, 'without this machine acknowledging anything');
    } finally {
      fetcher.restore();
    }
  });

  /* ------------------------------------------------ the polling contract */

  test('A HIDDEN TAB WITH ALERTS ON CHECKS THE OPEN LIST, AND NOTHING ELSE',
    async () => {
      const { mod } = await load();
      const w = world();
      const { fetcher, clock, session } = await signedIn(mod, {
        responder: w.responder });
      try {
        await session.enableAlerts();
        session.select('conv-a');
        await tick();
        const msgs = w.messageCalls;

        clock.hide();
        /* Half rate: two 15-second ticks per background check. */
        clock.fireAll(); await tick();
        const afterOne = w.attentionCalls;
        clock.fireAll(); await tick();
        assert.equal(w.attentionCalls, afterOne + 1, '30 seconds, one check');

        clock.fireAll(); await tick();
        clock.fireAll(); await tick();
        assert.equal(w.attentionCalls, afterOne + 2, 'and one more');

        assert.equal(w.messageCalls, msgs,
          'NO TRANSCRIPT WAS FETCHED WHILE HIDDEN');
      } finally {
        fetcher.restore();
      }
    });

  test('A HIDDEN TAB WITH ALERTS OFF STILL DOES NOTHING AT ALL', async () => {
    /* The behaviour this page had before notifications existed, preserved
       exactly for anybody who does not want them. */
    const { mod } = await load();
    const w = world();
    const { fetcher, clock } = await signedIn(mod, { responder: w.responder });
    try {
      const before = w.inboxCalls;
      clock.hide();
      for (let i = 0; i < 6; i += 1) { clock.fireAll(); await tick(); }
      assert.equal(w.inboxCalls, before, 'not one request');
    } finally {
      fetcher.restore();
    }
  });

  test('THE CLOSED VIEW STILL HEARS ABOUT A NEW OPEN CONVERSATION', async () => {
    /*
     * Alerts must not depend on which tab of the inbox happens to be
     * rendered. Somebody reviewing Closed still needs to hear a customer.
     *
     * The customer arrives AFTER the switch to Closed, so a stale copy of the
     * open list from before the switch cannot make this pass - the monitor
     * has to actually go and look while the rendered list is the closed one.
     */
    const { mod } = await load();
    let open = [];
    const w = world();
    const { ui, fetcher, clock, session } = await signedIn(mod, {
      responder: (n, input, init) => {
        const url = String(input);
        if (url.indexOf('/api/admin/chat/conversations') === 0) {
          const closed = url.indexOf('status=closed') !== -1;
          if (!closed) w.attentionCalls += 1;
          return openInbox(closed ? [] : open);
        }
        return w.responder(n, input, init);
      }
    });
    try {
      session.setFilter('closed');
      await tick();
      assert.deepEqual(ui.inbox, [], 'the closed list is empty');
      assert.equal(session.unreadCounts().total, 0, 'and nobody is waiting yet');

      /* NOW a customer writes, while Closed is what is on screen. */
      open = [CONV_UNREAD];
      clock.fireAll(); await tick();

      /* The rendered list is still the closed one... */
      assert.deepEqual(ui.inbox, [], 'still showing Closed');
      /* ...but the monitor went and looked, and knows somebody is waiting. */
      assert.equal(session.openConversations.length, 1);
      assert.equal(session.unreadCounts().total, 1);
    } finally {
      fetcher.restore();
    }
  });

  test('NO OVERLAPPING BACKGROUND CHECKS', async () => {
    const { mod } = await load();
    const w = world();
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = false;
    const { fetcher, clock, session } = await signedIn(mod, {
      responder: async (n, input, init) => {
        if (String(input).indexOf('status=open') !== -1 && gated) await gate;
        return w.responder(n, input, init);
      }
    });
    try {
      await session.enableAlerts();
      clock.hide();
      gated = true;

      clock.fireAll(); await tick(1);
      clock.fireAll(); await tick(1);      /* starts one, which blocks */
      const inFlight = w.attentionCalls;
      for (let i = 0; i < 6; i += 1) { clock.fireAll(); await tick(1); }
      assert.equal(w.attentionCalls, inFlight, 'many ticks, one request');

      release();
      await tick();
    } finally {
      fetcher.restore();
    }
  });

  test('A DEAD NETWORK BACKS OFF RATHER THAN STORMING', async () => {
    const { mod } = await load();
    let calls = 0;
    let dead = false;
    const { fetcher, clock, session } = await signedIn(mod, {
      responder: (n, input) => {
        if (String(input).indexOf('status=open') !== -1) {
          calls += 1;
          /* The network dies only once the tab is in the background, so the
             dashboard is genuinely signed in and polling first. */
          if (dead) return new TypeError('network');
        }
        return jsonResponse(200, { ok: true, status: 'open', limit: 50,
          conversations: [], locations: ['main'] });
      }
    });
    try {
      await session.enableAlerts();
      clock.hide();
      dead = true;
      const before = calls;
      /* Twenty ticks - five minutes of wall clock - against a dead network. */
      for (let i = 0; i < 20; i += 1) { clock.fireAll(); await tick(1); }
      const attempts = calls - before;
      assert.ok(attempts > 0, 'it did try');
      assert.ok(attempts <= 4, 'but backed off rather than storming: ' + attempts);
    } finally {
      fetcher.restore();
    }
  });

  /* ------------------------------------------------------- the test alert */

  test('THE TEST ALERT TOUCHES NO CONVERSATION AND CALLS NO API', async () => {
    const { mod } = await load();
    const w = world();
    const { ui, fetcher, session } = await signedIn(mod, { responder: w.responder });
    try {
      await session.enableAlerts();
      const before = fetcher.seen.length;
      /* There is one genuinely unread conversation in this world already.
         The point is that the test alert does not CHANGE that - it neither
         invents unread state nor clears any. */
      const unreadBefore = session.unreadCounts().total;
      assert.equal(unreadBefore, 1, 'a real customer is waiting');

      session.testAlert();

      const extra = fetcher.seen.slice(before).map((r) => String(r.input));
      assert.equal(fetcher.seen.length, before,
        'NO request of any kind, saw: ' + JSON.stringify(extra));
      assert.equal(w.reads.length, 0, 'and nothing was marked read');
      assert.equal(session.unreadCounts().total, unreadBefore,
        'no unread invented, and none cleared');
      assert.equal(session.selectedId, null);
      assert.equal(ui.thread, null);
    } finally {
      fetcher.restore();
    }
  });

  test('signing out puts the title back and forgets the counts', async () => {
    const { mod } = await load();
    const w = world();
    const { ui, fetcher, clock, session } = await signedIn(mod, {
      responder: w.responder });
    try {
      clock.fireAll(); await tick();
      assert.equal(session.unreadCounts().total, 1);

      await session.signOut();
      await tick();
      assert.equal(session.unreadCounts().total, 0);
      assert.equal(session.openConversations.length, 0);
      assert.deepEqual(ui.unreadCounts, { total: 0, byLocation: {} });
    } finally {
      fetcher.restore();
    }
  });

  /* ------------------------------------------------------------- source */

  test('the dashboard still has ZERO direct Firestore access', () => {
    /* Notifications added a module, not a door. */
    for (const forbidden of ['getFirestore', 'onSnapshot', 'collection(',
                             'doc(', 'getDocs', 'getDoc', 'setDoc', 'addDoc',
                             'updateDoc', 'deleteDoc', 'firebase-firestore']) {
      assert.equal(STAFF_CODE.indexOf(forbidden), -1,
        'chat-staff.js reaches for ' + forbidden);
      assert.equal(ALERTS_CODE.indexOf(forbidden), -1,
        'chat-staff-alerts.js reaches for ' + forbidden);
    }
  });

  test('THE ALERT MODULE MAKES NO REQUESTS AND HOLDS NO CREDENTIAL', () => {
    /*
     * It is handed conversations the server already authorised and turns them
     * into sound and text. If it could fetch, it would be a second, untested
     * path to customer data.
     */
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'authorizedFetch',
                             'getIdToken', 'Authorization', 'AppCheck',
                             '/api/']) {
      assert.equal(ALERTS_CODE.indexOf(forbidden), -1,
        'chat-staff-alerts.js reaches for ' + forbidden);
    }
    /* And no field that could carry a message body is read at all. */
    for (const f of ['lastMessagePreview', 'messagePreview', 'lastMessageBody',
                     'lastMessageText', 'snippet', 'excerpt']) {
      assert.equal(ALERTS_CODE.indexOf(f), -1,
        'chat-staff-alerts.js reads ' + f);
    }
    /* And it writes exactly one namespaced preference key. */
    const keys = ALERTS_CODE.match(/setItem\(([^,]+),/g) || [];
    assert.equal(keys.length, 1, 'one setItem, and only one');
    assert.match(ALERTS_CODE, /const PREF_KEY = 'esthers\.staff\.alerts';/);
  });

  test('no innerHTML anywhere, in either module', () => {
    for (const src of [STAFF_CODE, ALERTS_CODE]) {
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/
        .test(src), false);
    }
  });

  test('the poll intervals are what the design says they are', () => {
    assert.match(STAFF_CODE, /const INBOX_POLL_MS = 15 \* 1000;/);
    assert.match(STAFF_CODE, /const HIDDEN_ATTENTION_POLL_MS = 30 \* 1000;/);
    /* Still ONE timer. The background check rides the same interval at half
       rate rather than arming a second one. */
    assert.equal((STAFF_CODE.match(/deps\.setInterval/g) || []).length, 1);
    assert.equal(/THREAD_POLL_MS|threadTimer/.test(STAFF_CODE), false);
  });
});
