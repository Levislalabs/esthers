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
const STUB_PATH = ROOT + '/tests/chat-api/fixtures/firebase-staff-stub.mjs';

const STAFF_SRC = readFileSync(STAFF_PATH, 'utf8');
const APP_CHECK_SRC = readFileSync(APP_CHECK_PATH, 'utf8');
const CUSTOMER_SRC = readFileSync(CUSTOMER_PATH, 'utf8');
const WIDGET_SRC = readFileSync(WIDGET_PATH, 'utf8');
const PAGE_SRC = readFileSync(PAGE_PATH, 'utf8');
const CSS_SRC = readFileSync(CSS_PATH, 'utf8');

const STUB_URL = pathToFileURL(STUB_PATH).href;

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
  ui.onSignIn = (h) => { ui.handlers.signIn = h; };
  ui.onSignOut = (h) => { ui.handlers.signOut = h; };
  ui.onSelect = (h) => { ui.handlers.select = h; };
  ui.onFilter = (h) => { ui.handlers.filter = h; };
  ui.onRefresh = (h) => { ui.handlers.refresh = h; };
  ui.onSend = (h) => { ui.handlers.send = h; };
  ui.onClose = (h) => { ui.handlers.close = h; };
  ui.onBack = (h) => { ui.handlers.back = h; };
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

const CONV_A = {
  conversationId: 'conv-a', customerName: 'Dana Fraser',
  customerEmail: 'dana@example.com', status: 'open',
  createdAt: 1000, lastMessageAt: 5000, messageCount: 3, staffLastReadAt: null
};
const CONV_B = {
  conversationId: 'conv-b', customerName: 'Sam Okafor',
  customerEmail: 'sam@example.com', status: 'open',
  createdAt: 900, lastMessageAt: 4000, messageCount: 1, staffLastReadAt: null
};
const INBOX_OK = { ok: true, conversations: [CONV_A, CONV_B], status: 'open', limit: 50 };
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
        assert.equal(session.inboxTimer, null, 'timers stopped');
        assert.equal(session.threadTimer, null);
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
      '/api/admin/chat/send'
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
  test('the intervals are the documented ones', async () => {
    const { mod } = await load();
    const { clock, fetcher } = await signedIn(mod);
    try {
      assert.deepEqual(clock.intervals(), [8000, 15000],
        'thread 8s, inbox 15s');
      assert.equal(mod._internals.INBOX_POLL_MS, 15 * 1000);
      assert.equal(mod._internals.THREAD_POLL_MS, 8 * 1000);
      assert.equal(clock.visibilityListeners(), 1);
    } finally {
      fetcher.restore();
    }
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
        'the inbox caught up');
      assert.ok(after.some((u) => u.indexOf('/api/admin/chat/messages') === 0),
        'and so did the open thread');
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

  test('changing the selected thread moves the poll with it', async () => {
    const { mod } = await load();
    const { session, clock, fetcher } = await signedIn(mod);
    try {
      session.select('conv-a');
      await tick();
      session.select('conv-b');
      await tick();

      const before = fetcher.seen.length;
      clock.fireAll();
      await tick();
      const asked = fetcher.seen.slice(before)
        .filter((r) => r.input.indexOf('/api/admin/chat/messages') === 0)
        .map((r) => r.input);
      assert.equal(asked.length, 1);
      assert.match(asked[0], /conversationId=conv-b/);
      assert.equal(/conversationId=conv-a/.test(asked[0]), false,
        'the abandoned thread is not still being polled');
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
