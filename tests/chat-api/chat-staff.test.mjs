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
    const WANT = '2026-09-06.1';
    const files = {
      'assets/js/chat.js': [/var CHAT_CLIENT_VERSION = '([^']+)';/],
      'assets/js/chat-customer.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/,
                                     /from '\.\/chat-app-check\.js\?v=([^']+)';/],
      'assets/js/chat-app-check.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/],
      'assets/js/chat-staff.js': [/export const CHAT_CLIENT_VERSION = '([^']+)';/,
                                  /from '\.\/chat-app-check\.js\?v=([^']+)';/],
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
                        'staff/chat/index.html']) {
      const src = readFileSync(ROOT + '/' + file, 'utf8');
      assert.equal(src.indexOf('2026-09-05.1'), -1,
        file + ' has no trace of the old version');
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

  test('a manager keeps it, and the header follows', async () => {
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

      assert.equal(session.selectedId, 'conv-a', 'still theirs to read');
      assert.equal(ui.thread.conversation.locationLabel,
        'Specialty Shop - Keith Street');
      assert.equal(ui.notice, 'Moved to Specialty Shop - Keith Street.');
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
