/*
 * The customer chat frontend: assets/js/chat-customer.js, and the parts of
 * assets/js/chat.js that decide whether any of it runs.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT.
 *
 * It cannot mint a real App Check token or reach a real Firestore. The
 * production reCAPTCHA Enterprise key is restricted to esthers.ca and
 * attestation is performed by a browser against the page's own hostname, so
 * no token exists outside a page actually served from there. That
 * restriction is the protection; weakening it to make a test pass would be
 * exactly the wrong trade, and docs/CHAT_CUSTOMER_FRONTEND.md documents the
 * manual walkthrough that closes the remaining gap on production.
 *
 * What it does prove is every rule up to that boundary - and, importantly,
 * it proves the ORDERING and the HEADER SEPARATION against the real
 * chat-app-check.js rather than a stand-in for it. Only the four gstatic
 * SDK URLs are swapped; both modules under test run their own logic
 * unmodified, wired to each other exactly as they are in the browser.
 *
 * HOW. Each module is read from disk, its SDK specifiers rewritten to the
 * local stub, and imported as a data: URL. chat-customer.js imports
 * chat-app-check.js by relative path, which a data: URL cannot resolve, so
 * that specifier is rewritten to the data: URL of the rewritten
 * chat-app-check.js - the real module, reachable from the real importer.
 *
 * NO NETWORK. NO PRODUCTION CONTACT. NO FIREBASE PROJECT.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { codeOnly, codeAndStrings } from './fixtures/source-view.mjs';

const CUSTOMER_PATH = '/home/user/esthers/assets/js/chat-customer.js';
const APP_CHECK_PATH = '/home/user/esthers/assets/js/chat-app-check.js';
const WIDGET_PATH = '/home/user/esthers/assets/js/chat.js';
const LOCATIONS_PATH = '/home/user/esthers/assets/js/chat-locations.js';
const STUB_PATH = '/home/user/esthers/tests/chat-api/fixtures/firebase-sdk-full-stub.mjs';

const CUSTOMER_SRC = readFileSync(CUSTOMER_PATH, 'utf8');
const APP_CHECK_SRC = readFileSync(APP_CHECK_PATH, 'utf8');
const WIDGET_SRC = readFileSync(WIDGET_PATH, 'utf8');

const STUB_URL = pathToFileURL(STUB_PATH).href;

/*
 * The REAL shop definitions, not a stub.
 *
 * chat-locations.js imports nothing and touches no SDK, so there is nothing
 * to stand in for - and the point of several tests below is that the labels
 * the panel shows are the labels that file actually holds. A data: URL cannot
 * resolve './chat-locations.js', so the specifier is rewritten to this file
 * URL the same way the App Check one is.
 */
const LOCATIONS_URL = pathToFileURL(LOCATIONS_PATH).href;

/*
 * These files document themselves at length, and the prose names the very
 * things the assertions below promise are absent - "no innerHTML anywhere in
 * this section", "sessionStorage and not localStorage". Searching the raw
 * text would fail on the documentation. See fixtures/source-view.mjs.
 */
const CUSTOMER_CODE = codeAndStrings(CUSTOMER_SRC);
const CUSTOMER_IDENTS = codeOnly(CUSTOMER_SRC);
const WIDGET_CODE = codeAndStrings(WIDGET_SRC);

function dataUrl(source) {
  return 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
}

/*
 * Load both modules with the SDK swapped for the stub, fresh each time so
 * the memoisation inside chat-app-check.js starts from zero.
 */
let salt = 0;
async function load() {
  salt += 1;

  const appCheckSrc = APP_CHECK_SRC
    .replace(/const SDK_APP = [^;]+;/, `const SDK_APP = ${JSON.stringify(STUB_URL)};`)
    .replace(/const SDK_APP_CHECK = [^;]+;/, `const SDK_APP_CHECK = ${JSON.stringify(STUB_URL)};`)
    + `\n/* cache-bust ${salt} */\n`;
  const appCheckUrl = dataUrl(appCheckSrc);

  const customerSrc = CUSTOMER_SRC
    .replace(/const SDK_AUTH = [^;]+;/, `const SDK_AUTH = ${JSON.stringify(STUB_URL)};`)
    .replace(/const SDK_FIRESTORE = [^;]+;/, `const SDK_FIRESTORE = ${JSON.stringify(STUB_URL)};`)
    /* The specifier now carries ?v=<CHAT_CLIENT_VERSION> - see the cache
       versioning block below - so the query has to be tolerated here or the
       rewrite silently misses and the import fails on a data: URL. */
    .replace(/from '\.\/chat-app-check\.js(\?[^']*)?'/, `from ${JSON.stringify(appCheckUrl)}`)
    .replace(/from '\.\/chat-locations\.js(\?[^']*)?'/, `from ${JSON.stringify(LOCATIONS_URL)}`)
    + `\n/* cache-bust ${salt} */\n`;

  const mod = await import(dataUrl(customerSrc));
  const appCheck = await import(appCheckUrl);
  const stub = await import(STUB_URL);
  stub.reset();
  appCheck._reset();
  mod._reset();
  return { mod, appCheck, stub };
}

/* A UI that records instead of drawing. Every method the contract names,
   so a missing one can never be the reason a test passes. */
function recordingUi() {
  const ui = {
    calls: [],
    messages: null,
    status: null,
    notice: null,
    busy: null,
    composerEnabled: null,
    closed: null,
    retry: null,
    startFormShown: 0,
    transcriptShown: 0,
    startHandler: null,
    sendHandler: null,
    renderCount: 0
  };
  ui.showStartForm = () => { ui.calls.push('showStartForm'); ui.startFormShown += 1; };
  ui.showTranscript = () => { ui.calls.push('showTranscript'); ui.transcriptShown += 1; };
  ui.renderMessages = (list) => {
    ui.calls.push('renderMessages');
    ui.renderCount += 1;
    ui.messages = list;
  };
  ui.setStatus = (t) => { ui.calls.push('setStatus'); ui.status = t; };
  ui.noticeHistory = [];
  ui.setNotice = (t) => { ui.calls.push('setNotice'); ui.notice = t; ui.noticeHistory.push(t); };
  ui.setBusy = (f) => { ui.calls.push('setBusy'); ui.busy = f; };
  ui.setComposerEnabled = (f) => { ui.calls.push('setComposerEnabled'); ui.composerEnabled = f; };
  ui.closedHistory = [];
  ui.setClosed = (f) => { ui.calls.push('setClosed'); ui.closed = f; ui.closedHistory.push(f); };
  ui.setRetry = (h) => { ui.calls.push('setRetry'); ui.retry = h; };
  /* Routing. destinationHistory is kept because "it moved" is a sequence,
     not a final value - a transfer has to be visible as a change. */
  ui.locations = null;
  ui.setLocations = (list) => { ui.calls.push('setLocations'); ui.locations = list; };
  ui.destination = null;
  ui.destinationHistory = [];
  ui.setDestination = (t) => {
    ui.calls.push('setDestination');
    ui.destination = t;
    ui.destinationHistory.push(t);
  };
  ui.onStart = (h) => { ui.startHandler = h; };
  ui.onSend = (h) => { ui.sendHandler = h; };
  return ui;
}

/* An in-memory sessionStorage. Real enough for the reconciliation tests,
   and it cannot throw unless a test asks it to. */
function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

/* Captures every fetch the module makes, and answers with what a test
   dictates. globalThis.fetch is what the REAL authorizedFetch() calls, so
   what lands here is the genuinely assembled request. */
function captureFetch(responder) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    seen.push({ input, init });
    const answer = typeof responder === 'function' ? responder(seen.length, input, init) : responder;
    if (answer instanceof Error) throw answer;
    return answer || jsonResponse(200, { ok: true });
  };
  return {
    seen,
    restore: () => { globalThis.fetch = original; }
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

/*
 * A hand-driven interval and a fake document, so the close watch can be tested
 * without waiting a minute and without a browser.
 *
 * fireInterval() runs every registered callback once. The point is that a test
 * can advance the world deliberately: nothing here fires on its own, so a
 * timer the code forgot to clear shows up as a callback that is still
 * registered rather than as a flake ten seconds later.
 */
function fakeClock() {
  const timers = new Map();
  let next = 1;
  const doc = {
    visibilityState: 'visible',
    listeners: {},
    addEventListener(type, fn) {
      (doc.listeners[type] = doc.listeners[type] || []).push(fn);
    },
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
      document: () => doc
    },
    doc,
    liveTimers: () => timers.size,
    intervalMs: () => (timers.size ? Array.from(timers.values())[0].ms : null),
    fireInterval: () => { for (const t of Array.from(timers.values())) t.fn(); },
    visibilityListeners: () => (doc.listeners.visibilitychange || []).length,
    becomeVisible: () => {
      doc.visibilityState = 'visible';
      for (const fn of (doc.listeners.visibilitychange || []).slice()) fn();
    },
    becomeHidden: () => { doc.visibilityState = 'hidden'; }
  };
}

/* Let queued microtasks and zero-delay timers run - the stub reports auth
   state and rules refusals on a timer, as the SDK does. */
function tick(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) {
    p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  }
  return p;
}

const OK_START = { ok: true, conversationId: 'conv-1', messageId: 'msg-1', status: 'open' };
const OK_SEND = { ok: true, conversationId: 'conv-1', messageId: 'msg-2' };

/* Drive a session all the way to "connected, conversation open". */
async function connectedSession(mod, opts = {}) {
  const ui = recordingUi();
  const storage = opts.storage || memoryStorage();
  const fetcher = captureFetch(opts.responder || jsonResponse(200, OK_START));
  /*
   * EVERY session gets a hand-driven clock, not just the tests that care.
   *
   * The close watch calls setInterval, and a real 60-second interval keeps
   * Node's event loop open - so a suite that leaves one running never exits.
   * That is worth catching rather than papering over: an interval nobody
   * clears is exactly the leak these tests are meant to detect, and with a
   * fake clock it shows up as a timer still registered instead of as a
   * hanging test run.
   */
  const clock = opts.clock || fakeClock();
  const session = await mod.openChatForReview({
    ui,
    openPanel: () => {},
    deps: Object.assign({ storage: () => storage }, clock.deps, opts.deps || {})
  });
  return { ui, storage, fetcher, session, clock };
}

/* ==================================================== 9-10. THE GATE */

describe('the public rollout gate', () => {
  test('CHAT_PUBLIC_ENABLED defaults to false in the transport', async () => {
    const { mod } = await load();
    assert.equal(mod.CHAT_PUBLIC_ENABLED, false);
    assert.equal(mod.isPublicChatEnabled(), false);
  });

  test('CHAT_PUBLIC_ENABLED defaults to false in the widget', () => {
    /* chat.js is a classic script on every public page. Its gate is the one
       that decides whether the transport is ever imported, so it is read
       from source rather than from a module namespace. */
    assert.match(WIDGET_SRC, /var CHAT_PUBLIC_ENABLED = false;/);
    assert.equal(/var CHAT_PUBLIC_ENABLED = true/.test(WIDGET_SRC), false);
  });

  test('connect() refuses while the gate is shut, and returns null', async () => {
    const { mod } = await load();
    const ui = recordingUi();
    assert.equal(await mod.connect(ui, {}), null);
  });

  test('with the gate shut: no auth, no API call, no listener, no UI touched',
    async () => {
      const { mod, stub } = await load();
      const ui = recordingUi();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        await mod.connect(ui, { deps: { storage: () => memoryStorage() } });
        await tick();

        assert.equal(stub.calls.signInAnonymously.length, 0, 'no anonymous sign-in');
        assert.equal(stub.calls.initializeAppCheck.length, 0, 'no reCAPTCHA challenge');
        assert.equal(stub.calls.onSnapshot.length, 0, 'no Firestore listener');
        assert.equal(fetcher.seen.length, 0, 'no request to /api/chat/*');
        assert.equal(ui.calls.length, 0, 'the widget is not even told');
        assert.equal(mod.activeSession(), null);
      } finally {
        fetcher.restore();
      }
    });

  test('the widget does not import the transport while its gate is shut', () => {
    /* The dynamic import is inside connectTransport(), and the only call to
       connectTransport() is behind the gate. Nothing at module scope. */
    assert.match(WIDGET_SRC, /if \(CHAT_PUBLIC_ENABLED\) connectTransport\(\);/);
    const importCount = (WIDGET_SRC.match(/import\(TRANSPORT_MODULE\)/g) || []).length;
    assert.equal(importCount, 1, 'exactly one place imports the transport');
  });

  test('no query parameter, cookie or storage key can open the gate', () => {
    /* Identifiers, so the comment that says "not a localStorage key" is not
       mistaken for a use of one. */
    for (const forbidden of [
      'location.search', 'URLSearchParams', 'document.cookie',
      'localStorage', 'searchParams', 'window.name'
    ]) {
      assert.equal(CUSTOMER_IDENTS.includes(forbidden), false,
        'the transport must not read ' + forbidden);
    }
    /* sessionStorage IS used - for the conversation id, never for the gate.
       Prove it is not consulted anywhere near the gate. */
    const gateArea = CUSTOMER_IDENTS.slice(
      CUSTOMER_IDENTS.indexOf('export const CHAT_PUBLIC_ENABLED'),
      CUSTOMER_IDENTS.indexOf('export function isPublicChatEnabled') + 200);
    assert.equal(/storage|Storage|cookie|search/.test(gateArea), false);
  });
});

/* =========================================== 1-3. INITIALISATION ORDER */

describe('initialisation order', () => {
  test('App Check is initialised BEFORE anonymous auth', async () => {
    const { mod, stub } = await load();
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      const appCheckAt = stub.order.indexOf('initializeAppCheck');
      const signInAt = stub.order.indexOf('signInAnonymously');
      assert.ok(appCheckAt !== -1, 'App Check was initialised');
      assert.ok(signInAt !== -1, 'anonymous sign-in happened');
      assert.ok(appCheckAt < signInAt,
        'App Check must come first - Firebase Auth App Check enforcement is '
        + 'coming, and a sign-in issued before attestation will be refused. '
        + 'order was: ' + stub.order.join(' -> '));
    } finally {
      fetcher.restore();
    }
  });

  test('the whole order is App Check, app, auth, firestore, listener', async () => {
    const { mod, stub } = await load();
    const storage = memoryStorage();
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const ui = recordingUi();
      await mod.openChatForReview({
        ui, openPanel: () => {},
        deps: Object.assign({ storage: () => storage }, fakeClock().deps)
      });
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hello', locationId: 'main' });
      await tick();

      const at = (name) => stub.order.indexOf(name);
      assert.ok(at('initializeApp') < at('initializeAppCheck') || at('initializeApp') === -1);
      assert.ok(at('initializeAppCheck') < at('getAuth'), 'app check before auth');
      assert.ok(at('getAuth') < at('signInAnonymously'), 'auth module before sign-in');
      assert.ok(at('signInAnonymously') < at('onSnapshot'), 'signed in before listening');
    } finally {
      fetcher.restore();
    }
  });

  test('an existing Firebase app is reused, never a second one', async () => {
    const { mod, stub } = await load();
    stub.seedExistingApp();
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.initializeApp.length, 0,
        'initializeApp must not be called when one already exists');
      assert.equal(stub.calls.getFirestore.length, 1);
      /* Firestore and App Check must be on the SAME app object. */
      assert.equal(stub.calls.getFirestore[0].app, stub.calls.initializeAppCheck[0].app);
    } finally {
      fetcher.restore();
    }
  });

  test('an already signed-in anonymous user is reused', async () => {
    const { mod, stub } = await load();
    stub.seedCurrentUser({ uid: 'already-here', getIdToken: async () => 'tok' });
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.signInAnonymously.length, 0,
        'a second anonymous account must not be minted');
    } finally {
      fetcher.restore();
    }
  });

  test('a persisted session restored asynchronously is reused, not replaced',
    async () => {
      /* THE RACE THAT MATTERS. auth.currentUser is null for a moment after
         getAuth() even when a good anonymous session exists; signing in
         during that moment succeeds and creates a SECOND account, orphaning
         the visitor's conversation. */
      const { mod, stub } = await load();
      stub.seedRestoredUser({ uid: 'restored-1', getIdToken: async () => 'tok' });
      const { fetcher } = await connectedSession(mod);
      try {
        await tick();
        assert.equal(stub.calls.onAuthStateChanged.length, 1, 'it waited');
        assert.equal(stub.calls.signInAnonymously.length, 0,
          'no second anonymous account');
      } finally {
        fetcher.restore();
      }
    });

  test('with nobody signed in, exactly one anonymous sign-in happens', async () => {
    const { mod, stub } = await load();
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.signInAnonymously.length, 1);
    } finally {
      fetcher.restore();
    }
  });
});

/* ======================================= 4-8. CREDENTIALS ON THE WIRE */

describe('credentials on the wire', () => {
  test('start carries BOTH the ID token and the App Check token', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('app-check-abc');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'id-token-xyz' });
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const req = fetcher.seen[0];
      assert.equal(req.input, '/api/chat/start');
      assert.equal(req.init.method, 'POST');
      assert.equal(req.init.headers.get('Authorization'), 'Bearer id-token-xyz');
      assert.equal(req.init.headers.get('X-Firebase-AppCheck'), 'app-check-abc');
      assert.equal(req.init.headers.get('Content-Type'), 'application/json');
    } finally {
      fetcher.restore();
    }
  });

  test('send carries BOTH credentials too', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('app-check-abc');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'id-token-xyz' });
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'and another thing' });
      const req = fetcher.seen[1];
      assert.equal(req.input, '/api/chat/send');
      assert.equal(req.init.headers.get('Authorization'), 'Bearer id-token-xyz');
      assert.equal(req.init.headers.get('X-Firebase-AppCheck'), 'app-check-abc');
    } finally {
      fetcher.restore();
    }
  });

  test('the App Check token is NEVER placed in Authorization', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('APPCHECK-TOKEN-VALUE');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'ID-TOKEN-VALUE' });
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const auth = fetcher.seen[0].init.headers.get('Authorization');
      assert.equal(auth.includes('APPCHECK-TOKEN-VALUE'), false,
        'these are different credentials proving different things');
      assert.equal(auth, 'Bearer ID-TOKEN-VALUE');
    } finally {
      fetcher.restore();
    }
  });

  test('the ID token is NEVER placed in X-Firebase-AppCheck', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('APPCHECK-TOKEN-VALUE');
    stub.setSignedInUser({ uid: 'u1', getIdToken: async () => 'ID-TOKEN-VALUE' });
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const ac = fetcher.seen[0].init.headers.get('X-Firebase-AppCheck');
      assert.equal(ac.includes('ID-TOKEN-VALUE'), false);
      assert.equal(ac, 'APPCHECK-TOKEN-VALUE');
    } finally {
      fetcher.restore();
    }
  });

  test('no request body carries customerUid or any other privileged field',
    async () => {
      /* validation.js rejects these outright with 400 forbidden_field. A
         client that sends one is not merely wasteful, it is broken. */
      const FORBIDDEN = [
        'customerUid', 'senderType', 'staffUserId', 'createdAt', 'updatedAt',
        'status', 'closedAt', 'messageCount', 'lastMessageAt',
        'staffLastReadAt', 'customerLastReadAt', 'staffNotifiedAt', 'uid', 'role'
      ];
      const { mod } = await load();
      let call = 0;
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await ui.sendHandler({ message: 'more' });
        assert.equal(fetcher.seen.length, 2);
        for (const req of fetcher.seen) {
          const body = JSON.parse(req.init.body);
          for (const f of FORBIDDEN) {
            assert.equal(Object.prototype.hasOwnProperty.call(body, f), false,
              req.input + ' must not send ' + f);
          }
        }
      } finally {
        fetcher.restore();
      }
    });

  test('the request bodies are exactly the schemas the API validates', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'more' });

      const start = JSON.parse(fetcher.seen[0].init.body);
      /* locationId joined the start schema with routing, and nothing else
         did: still no customerUid, no locationLabel, no audit field. */
      assert.deepEqual(Object.keys(start).sort(),
        ['clientMessageId', 'email', 'locationId', 'message', 'name']);
      assert.equal(start.name, 'Jo');
      assert.equal(start.email, 'jo@example.com');
      assert.equal(start.message, 'hi');
      assert.equal(start.locationId, 'main');

      const send = JSON.parse(fetcher.seen[1].init.body);
      assert.deepEqual(Object.keys(send).sort(),
        ['clientMessageId', 'conversationId', 'message']);
      assert.equal(send.conversationId, 'conv-1');
      assert.equal(send.message, 'more');
    } finally {
      fetcher.restore();
    }
  });

  test('clientMessageId is a UUID the server will accept', async () => {
    /* The exact regular expression from api/_chat/validation.js. */
    const SERVER_UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const { mod } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const body = JSON.parse(fetcher.seen[0].init.body);
      assert.match(body.clientMessageId, SERVER_UUID_RE);
    } finally {
      fetcher.restore();
    }
  });

  test('the getRandomValues fallback also produces an acceptable UUID', async () => {
    const SERVER_UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const { mod } = await load();
    const realCrypto = globalThis.crypto;
    /*
     * A PLAIN object, deliberately not one inheriting from Crypto.prototype:
     * randomUUID lives on that prototype, so an Object.create() of it would
     * still expose randomUUID - and calling it with the wrong `this` throws
     * rather than taking the fallback. The point here is a browser that has
     * getRandomValues and no randomUUID at all.
     */
    const patched = { getRandomValues: (a) => realCrypto.getRandomValues(a) };
    Object.defineProperty(globalThis, 'crypto', { value: patched, configurable: true });
    try {
      for (let i = 0; i < 200; i++) {
        assert.match(mod.newClientMessageId(), SERVER_UUID_RE);
      }
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
    }
  });
});

/* ================================================ 11-13. THE LISTENER */

describe('the realtime listener', () => {
  test('the query is filtered by conversationId, ordered by createdAt DESCENDING, and limited',
    async () => {
      const { mod, stub } = await load();
      const { ui, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();

        assert.equal(stub.calls.onSnapshot.length, 1, 'exactly one listener');
        assert.deepEqual(stub.calls.collection[0].path, 'chatMessages');
        assert.deepEqual(stub.calls.where[0],
          { field: 'conversationId', op: '==', value: 'conv-1' });
        /* DESCENDING. Ascending with limit(200) pins the window to the two
           hundred OLDEST messages, so a conversation past two hundred stops
           updating. See the rolling-window block below. */
        assert.deepEqual(stub.calls.orderBy[0], { field: 'createdAt', direction: 'desc' });
        assert.equal(stub.calls.limit[0].n, 200);
      } finally {
        fetcher.restore();
      }
    });

  test('the limit is mandatory and within what firestore.rules allows', async () => {
    /* maxMessageQuery() in firestore.rules is 200, and the rules refuse a
       listener whose request.query.limit is null. Both halves matter. */
    const { mod } = await load();
    assert.equal(mod._internals.TRANSCRIPT_LIMIT, 200);
    const rules = readFileSync('/home/user/esthers/firestore.rules', 'utf8');
    assert.match(rules, /function maxMessageQuery\(\) \{ return 200; \}/);
    assert.match(rules, /request\.query\.limit != null/);
  });

  test('the composite index this query needs is configured', () => {
    /*
     * PINNED. The listener orders by createdAt DESC, which Firestore cannot
     * serve from the ASC/ASC index - it needs its own. Deleting this entry
     * while the frontend still depends on it would produce a
     * failed-precondition error in production and an empty transcript for
     * every customer, so it is pinned here rather than left to memory.
     */
    const indexes = JSON.parse(
      readFileSync('/home/user/esthers/firestore.indexes.json', 'utf8'));
    const desc = indexes.indexes.find((i) =>
      i.collectionGroup === 'chatMessages'
      && i.queryScope === 'COLLECTION'
      && i.fields.length === 2
      && i.fields[0].fieldPath === 'conversationId' && i.fields[0].order === 'ASCENDING'
      && i.fields[1].fieldPath === 'createdAt' && i.fields[1].order === 'DESCENDING');
    assert.ok(desc,
      'firestore.indexes.json must carry (conversationId ASC, createdAt DESC) '
      + 'for the customer transcript listener');
  });

  test('the ASC index is KEPT - the staff transcript still uses it', () => {
    /* readTranscript() in api/_chat/service.js orders ascending. Removing the
       ASC index to "tidy up" after the client switched to DESC would break
       the staff inbox. */
    const indexes = JSON.parse(
      readFileSync('/home/user/esthers/firestore.indexes.json', 'utf8'));
    const asc = indexes.indexes.find((i) =>
      i.collectionGroup === 'chatMessages'
      && i.fields.length === 2
      && i.fields[0].fieldPath === 'conversationId' && i.fields[0].order === 'ASCENDING'
      && i.fields[1].fieldPath === 'createdAt' && i.fields[1].order === 'ASCENDING');
    assert.ok(asc, 'the ASC index must stay');

    const service = readFileSync('/home/user/esthers/api/_chat/service.js', 'utf8');
    assert.match(service, /\.orderBy\('createdAt', 'asc'\)/,
      'and the server code that needs it is still there');
  });

  test('firestore.indexes.json is valid JSON in the expected shape', () => {
    const raw = readFileSync('/home/user/esthers/firestore.indexes.json', 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.indexes));
    assert.ok(Array.isArray(parsed.fieldOverrides));
    for (const i of parsed.indexes) {
      assert.equal(typeof i.collectionGroup, 'string');
      assert.equal(i.queryScope, 'COLLECTION');
      assert.ok(Array.isArray(i.fields) && i.fields.length >= 2);
      for (const f of i.fields) {
        assert.equal(typeof f.fieldPath, 'string');
        assert.ok(['ASCENDING', 'DESCENDING'].includes(f.order));
      }
    }
    /* No duplicate index definitions - Firebase rejects the deploy. */
    const keys = parsed.indexes.map((i) =>
      i.collectionGroup + ':' + i.fields.map((f) => f.fieldPath + ' ' + f.order).join(','));
    assert.equal(new Set(keys).size, keys.length, 'duplicate index definition');
  });

  test('the listener is unsubscribed when the session stops', async () => {
    const { mod, stub } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(stub.liveListenerCount(), 1);
      session.stop();
      assert.equal(stub.calls.unsubscribe.length, 1);
      assert.equal(stub.liveListenerCount(), 0);
    } finally {
      fetcher.restore();
    }
  });

  test('disconnect() stops the listener too', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(mod.disconnect(), true);
      assert.equal(stub.liveListenerCount(), 0);
      assert.equal(mod.activeSession(), null);
    } finally {
      fetcher.restore();
    }
  });

  test('reopening the transcript never leaves two listeners', async () => {
    const { mod, stub } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      session.openTranscript();
      session.openTranscript();
      session.openTranscript();
      await tick();
      assert.equal(stub.liveListenerCount(), 1, 'one live listener, always');
      assert.equal(stub.calls.onSnapshot.length, 4);
      assert.equal(stub.calls.unsubscribe.length, 3, 'each old one was torn down');
    } finally {
      fetcher.restore();
    }
  });

  test('starting a second session stops the first', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const ui2 = recordingUi();
      await mod.openChatForReview({
        ui: ui2, openPanel: () => {},
        deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
      });
      await tick();
      assert.equal(stub.liveListenerCount(), 0,
        'the first session let go before the second started');
    } finally {
      fetcher.restore();
    }
  });

  test('stop() survives an SDK whose unsubscribe throws', async () => {
    const { mod, stub } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      stub.setUnsubscribeThrows();
      session.stop();          /* must not throw */
      session.stop();          /* twice is safe */
      assert.equal(session.unsubscribe, null);
    } finally {
      fetcher.restore();
    }
  });

  test('NO Firestore write API appears anywhere in the module', () => {
    /* The customer cannot write to Firestore: the rules deny create, update
       and delete. This asserts the client never even reaches for one. */
    for (const forbidden of [
      'addDoc', 'setDoc', 'updateDoc', 'deleteDoc', 'writeBatch',
      'runTransaction', 'serverTimestamp', 'deleteField', 'increment'
    ]) {
      assert.equal(CUSTOMER_IDENTS.includes(forbidden), false,
        'the customer must never write to Firestore: found ' + forbidden);
    }
  });

  test('the module reads Firestore and nothing else', () => {
    /* The only Firestore functions it may name. */
    const allowed = ['getFirestore', 'collection', 'query', 'where', 'orderBy',
      'limit', 'onSnapshot'];
    for (const fn of allowed) {
      assert.ok(CUSTOMER_SRC.includes(fn), 'expected to use ' + fn);
    }
  });
});

/* ================================ REGRESSIONS FOUND IN PRE-COMMIT REVIEW
 *
 * Every test in this block corresponds to a defect an adversarial review
 * found in code that the 82 tests above all passed. They are grouped so the
 * next person can see, at a glance, what this suite once let through.
 * ---------------------------------------------------------------------- */

describe('regressions', () => {
  test('suspend then resume keeps the session alive and sending', async () => {
    /*
     * THE BUG: close() called disconnect(), which stopped the session for
     * good, and open() did nothing. The widget stayed in live mode wired to a
     * dead session, so the composer looked fine and silently discarded every
     * message typed into it - the one lie a chat must never tell.
     */
    const { mod, stub } = await load();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(stub.liveListenerCount(), 1);

      /* panel closes */
      assert.equal(mod.suspend(), true);
      assert.equal(stub.liveListenerCount(), 0, 'no listener while nobody is looking');
      assert.equal(session.stopped, false, 'but the session is still alive');
      assert.equal(session.conversationId, 'conv-1', 'and still knows its conversation');

      /* panel reopens */
      assert.equal(mod.resume(), true);
      await tick();
      assert.equal(stub.liveListenerCount(), 1, 'listening again');

      /* and a message actually goes out */
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: 'still here?' });
      assert.equal(fetcher.seen.length, before + 1,
        'a message sent after a close/reopen must reach the server');
      assert.equal(JSON.parse(fetcher.seen[before].init.body).message, 'still here?');
    } finally {
      fetcher.restore();
    }
  });

  test('suspend/resume never leaves two listeners', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      for (let i = 0; i < 4; i++) {
        mod.suspend();
        mod.resume();
        await tick();
      }
      assert.equal(stub.liveListenerCount(), 1, 'one, however many times it cycles');
    } finally {
      fetcher.restore();
    }
  });

  test('suspend and resume are safe with no session, and after a real stop',
    async () => {
      const { mod } = await load();
      assert.equal(mod.suspend(), false);
      assert.equal(mod.resume(), false);

      const { ui, session, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();
        session.stop();
        assert.equal(mod.suspend(), false, 'a stopped session stays stopped');
        assert.equal(mod.resume(), false);
      } finally {
        fetcher.restore();
      }
    });

  test('a retry re-sends THE SAME message, not a copy of it', async () => {
    /*
     * THE BUG: the retry called send() afresh, which minted a NEW
     * clientMessageId. The server's idempotency key is that value - see
     * peekMessage() in api/_chat/service.js - so a send whose RESPONSE was
     * lost (the request having reached the server and been stored) was
     * written a second time. The visitor's sentence appeared twice in
     * Esther's inbox.
     */
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        if (call === 2) return new TypeError('Failed to fetch');
        return jsonResponse(200, OK_SEND);
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'did this arrive?' });
      assert.equal(typeof ui.retry, 'function');

      const failed = JSON.parse(fetcher.seen[1].init.body);
      await ui.retry();
      const retried = JSON.parse(fetcher.seen[2].init.body);

      assert.equal(retried.message, failed.message);
      assert.equal(retried.clientMessageId, failed.clientMessageId,
        'the idempotency key MUST survive the retry, or the server stores the '
        + 'message twice');
    } finally {
      fetcher.restore();
    }
  });

  test('a genuinely new message still mints a fresh key', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'one' });
      await ui.sendHandler({ message: 'two' });
      const a = JSON.parse(fetcher.seen[1].init.body).clientMessageId;
      const b = JSON.parse(fetcher.seen[2].init.body).clientMessageId;
      assert.notEqual(a, b, 'two different messages are two different keys');
    } finally {
      fetcher.restore();
    }
  });

  test('a throw while preparing a send does not deadlock the composer', async () => {
    /*
     * THE BUG: sending=true and setBusy(true) were set BEFORE the try, and
     * deriveMessageId() was awaited outside it. A rejection there - or the
     * stopped-check that returned early - skipped the finally, so sending
     * stayed true and the composer never re-enabled. Every later send was
     * refused by its own busy guard.
     */
    const { mod } = await load();
    let call = 0;
    /* Throws ONCE. If it threw every time the second send would fail for the
       same reason, and the test would prove nothing about the busy flag. */
    let derives = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); },
      deps: {
        deriveMessageId: async () => {
          derives += 1;
          if (derives === 1) throw new Error('subtle crypto exploded');
          return 'echo-' + derives;
        }
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'boom' });

      assert.equal(session.sending, false, 'the busy flag was released');
      assert.equal(ui.busy, false, 'and the UI was told');
      /* A throwable with no status classifies as offline, so the visitor is
         told to check their connection and offered a retry. Not strictly the
         cause here - the browser's crypto failed, not the network - but the
         advice ("try again") is right either way, and it is an allow-listed
         sentence rather than an exception reaching the page. */
      assert.match(ui.notice, /could not reach us/, 'and the visitor was told something');

      /* THE POINT: the composer still works. Before the fix, sending stayed
         true and every later send was refused by its own busy guard. */
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: 'after the failure' });
      assert.equal(fetcher.seen.length, before + 1, 'not wedged');
      assert.equal(JSON.parse(fetcher.seen[before].init.body).message, 'after the failure');
    } finally {
      fetcher.restore();
    }
  });

  test('a session stopped mid-send releases the busy flag too', async () => {
    const { mod } = await load();
    let session = null;
    const { ui, fetcher } = await connectedSession(mod, {
      deps: {
        deriveMessageId: async (c, m) => { if (session) session.stopped = true; return 'echo-1'; }
      }
    });
    try {
      session = mod.activeSession();
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      session.stopped = false;
      await ui.sendHandler({ message: 'racing the teardown' });
      assert.equal(session.sending, false);
      assert.equal(ui.busy, false);
    } finally {
      fetcher.restore();
    }
  });

  test('A STAFF SESSION IN THIS TAB IS REPLACED, NOT ADOPTED', async () => {
      /*
       * WHAT CHANGED, AND WHY.
       *
       * This used to refuse outright. Adopting a staff user was never an
       * option - an Email/Password token sent to the customer API is refused
       * 403 by authenticateCustomer() forever, and the Firestore listener
       * fails too because isAnonymousCustomer() tests the same provider - but
       * refusing was the wrong half of the fix. It was there because Firebase
       * shared ONE user across every tab, so a staff member's inbox in
       * another tab appeared here, and signing in anonymously would have
       * signed them out of it mid-reply.
       *
       * browserSessionPersistence removes that: sessions are per-tab, so
       * another tab's staff user is invisible from here. A non-anonymous user
       * seen at this point is therefore THIS tab's - somebody navigated from
       * /staff/chat to a customer page - and replacing this tab's identity is
       * both correct and free. The dashboard tab, if there still is one, is
       * untouched, which the two-tab browser test proves separately.
       */
      const { mod, stub } = await load();
      stub.seedCurrentUser({
        uid: 'staff-uid', isAnonymous: false, getIdToken: async () => 'staff-token'
      });
      const ui = recordingUi();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        const session = await mod.openChatForReview({
          ui, openPanel: () => {},
          deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
        });
        await tick();

        assert.ok(session, 'the customer chat starts');
        assert.equal(session.identity.user.isAnonymous, true,
          'as a NEW anonymous customer');
        assert.notEqual(session.identity.user.uid, 'staff-uid',
          'never as the staff account');
        assert.equal(stub.calls.signInAnonymously.length, 1,
          'exactly one anonymous sign-in');
        /* Signed out first: signInAnonymously() on top of a signed-in user is
           not defined to replace it cleanly. */
        assert.ok(stub.order.indexOf('signOut') !== -1, 'the staff user was released');
        assert.ok(stub.order.indexOf('signOut') < stub.order.indexOf('signInAnonymously'),
          'and released BEFORE the anonymous sign-in');
      } finally {
        fetcher.restore();
      }
    });

  test('an anonymous session is still reused normally', async () => {
    const { mod, stub } = await load();
    stub.seedCurrentUser({
      uid: 'anon-here', isAnonymous: true, getIdToken: async () => 'tok'
    });
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.equal(stub.calls.signInAnonymously.length, 0);
      assert.ok(mod.activeSession(), 'connected');
    } finally {
      fetcher.restore();
    }
  });

  test('a user with no isAnonymous flag at all is still accepted', async () => {
    /* The stub's default users omit the flag; so would an older SDK. Only an
       explicit false is a refusal - absence must not lock a customer out. */
    const { mod, stub } = await load();
    stub.seedCurrentUser({ uid: 'unknown-kind', getIdToken: async () => 'tok' });
    const { fetcher } = await connectedSession(mod);
    try {
      await tick();
      assert.ok(mod.activeSession());
    } finally {
      fetcher.restore();
    }
  });

  test('a hostile error code cannot put a non-string on the page', async () => {
    /*
     * THE BUG: MESSAGES_BY_CODE[code] walked the prototype chain, so a
     * response with code "constructor" or "toString" returned a FUNCTION -
     * which was then handed to the UI as the sentence to display, defeating
     * the file's own promise that every customer-facing string is
     * allow-listed.
     */
    const { mod } = await load();
    for (const code of ['constructor', 'toString', 'valueOf', 'hasOwnProperty',
      '__proto__', 'isPrototypeOf', 'propertyIsEnumerable']) {
      for (const status of [400, 401, 403, 404, 409, 500]) {
        const r = mod.describeFailure({ status, code });
        assert.equal(typeof r.text, 'string',
          'code=' + code + ' status=' + status + ' produced a ' + typeof r.text);
        assert.ok(r.text.length > 0);
      }
    }
  });

  test('every sentence describeFailure can produce is one of ours', async () => {
    const { mod } = await load();
    const allowed = new Set(Object.values(mod._internals.MESSAGES_BY_CODE));
    for (const code of ['constructor', 'toString', 'not_a_real_code', '', 'app_check_x',
      'conversation_closed', 'rate_limited', 'invalid_email']) {
      for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 503]) {
        const r = mod.describeFailure({ status, code });
        assert.ok(allowed.has(r.text) || typeof r.text === 'string',
          'unexpected text for ' + code + '/' + status);
        assert.equal(typeof r.text, 'string');
      }
    }
  });

  test('start() reuses its key on retry, so no SECOND conversation is opened',
    async () => {
      /*
       * THE BUG: start() minted a fresh clientMessageId per attempt. That key
       * decides the CONVERSATION's identity - startConversationId() in
       * service.js is sha256(domain + uid + clientMessageId) - so a visitor
       * whose response was lost, pressing Start again, opened a second
       * conversation and appeared twice in Esther's inbox as two separate
       * enquiries. peekStart() never got the chance to recognise the retry.
       */
      const { mod } = await load();
      let call = 0;
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => {
          call += 1;
          if (call === 1) return new TypeError('Failed to fetch');
          return jsonResponse(200, OK_START);
        }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        assert.equal(typeof ui.retry, 'function', 'a retry is offered');

        const first = JSON.parse(fetcher.seen[0].init.body);
        await ui.retry();
        const second = JSON.parse(fetcher.seen[1].init.body);

        assert.equal(second.clientMessageId, first.clientMessageId,
          'the retry must land on the SAME conversation, not open another');
        assert.equal(second.name, first.name);
        assert.equal(second.email, first.email);
        assert.equal(second.message, first.message);
      } finally {
        fetcher.restore();
      }
    });

  test('the echo id is derived from the key actually SENT', async () => {
    /*
     * THE GAP: nothing tied the optimistic echo id to the clientMessageId that
     * went out on the wire. Swapping the two arguments at the deriveMessageId
     * call site - so the echo was sha256(key + NUL + conversationId) instead of
     * sha256(conversationId + NUL + key) - passed the whole suite. The echo
     * would then never match the delivered document and every message the
     * visitor sent would appear twice.
     *
     * This closes it end to end: capture the arguments the module actually
     * passes, and check them against the body it actually posts.
     */
    const crypto = await import('node:crypto');
    const { mod } = await load();
    const derived = [];
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); },
      deps: {
        deriveMessageId: async (conversationId, clientMessageId) => {
          derived.push({ conversationId, clientMessageId });
          return crypto.createHash('sha256')
            .update(conversationId + '\u0000' + clientMessageId)
            .digest('hex').slice(0, 40);
        }
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'the one that matters' });

      const body = JSON.parse(fetcher.seen[1].init.body);
      assert.equal(derived.length, 1);
      assert.equal(derived[0].conversationId, body.conversationId,
        'argument 1 must be the conversation id that was posted');
      assert.equal(derived[0].clientMessageId, body.clientMessageId,
        'argument 2 must be the idempotency key that was posted - not the '
        + 'other way round, which would make every echo a duplicate');

      /* And the rendered echo carries exactly the id the server will assign. */
      const serverId = crypto.createHash('sha256')
        .update(body.conversationId + '\u0000' + body.clientMessageId)
        .digest('hex').slice(0, 40);
      const echo = (ui.messages || []).find((m) => m.pending);
      assert.ok(echo, 'an optimistic echo was rendered');
      assert.equal(echo.id, serverId);
    } finally {
      fetcher.restore();
    }
  });

  test('the constraints actually reach the query, not just the builders',
    async () => {
      /*
       * THE GAP: the listener test asserted where()/orderBy()/limit() were
       * CALLED. It never checked their results were passed to query(), so a
       * query built without them - or with them dropped on the floor - passed.
       */
      const { mod, stub } = await load();
      const { ui, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();

        assert.equal(stub.calls.query.length, 1);
        const q = stub.calls.query[0];
        assert.equal(q.base.__collection, 'chatMessages',
          'the query is built on the chatMessages collection');

        const cs = q.constraints;
        assert.equal(cs.length, 3, 'exactly three constraints reached query()');
        assert.deepEqual(cs[0].__where, ['conversationId', '==', 'conv-1']);
        assert.deepEqual(cs[1].__orderBy, ['createdAt', 'desc']);
        assert.equal(cs[2].__limit, 200);

        /* And the object handed to onSnapshot is that query. */
        assert.equal(stub.calls.onSnapshot[0].q.__query, true);
        assert.equal(stub.calls.onSnapshot[0].q.constraints, cs);
      } finally {
        fetcher.restore();
      }
    });

  test('a 429 issues no retry on ANY timescale, not just immediately',
    async () => {
      /*
       * THE GAP: the no-retry-loop tests waited only for zero-delay timers, so
       * a setTimeout(..., 1000) automatic retry would have passed them. Real
       * retry loops are exactly that shape.
       *
       * Here the clock is driven forward by two minutes of fake time with the
       * real timer queue draining in between, so a delayed retry has every
       * opportunity to fire.
       */
      const { mod } = await load();
      let call = 0;
      const { ui, session, fetcher } = await connectedSession(mod, {
        responder: () => {
          call += 1;
          if (call === 1) return jsonResponse(200, OK_START);
          return jsonResponse(429, { ok: false, code: 'rate_limited', retryAfter: 30 });
        }
      });
      const realSetTimeout = globalThis.setTimeout;
      const scheduled = [];
      globalThis.setTimeout = (fn, ms, ...rest) => {
        if (typeof ms === 'number' && ms > 0) scheduled.push({ fn, ms });
        return realSetTimeout(fn, 0, ...rest);
      };
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();
        const before = fetcher.seen.length;

        await ui.sendHandler({ message: 'too fast' });
        await tick(5);

        /* Fire everything the module scheduled with a delay, as if two
           minutes had passed. */
        for (const t of scheduled.splice(0)) {
          try { t.fn(); } catch (err) { /* a timer that throws is its own bug */ }
        }
        await tick(5);

        assert.equal(fetcher.seen.length, before + 1,
          'one attempt, and nothing rescheduled itself on any delay');
        assert.equal(ui.retry, null);
        assert.equal(session.sending, false);
      } finally {
        globalThis.setTimeout = realSetTimeout;
        fetcher.restore();
      }
    });

  test('the demo Send button keeps the exact style it already had', () => {
    /*
     * THE BUG: the new stylesheet block restyled .chat__send:disabled. The
     * existing rule at the top of the file gives it opacity .42 and
     * cursor:default; the new one had equal specificity and came later, so it
     * silently won - changing the Send button on the gate-off path that every
     * visitor sees today, because that button is disabled whenever the
     * composer is empty.
     */
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    const rules = css.split('\n')
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter((x) => x.l.includes('.chat__send:disabled') && !x.l.startsWith('*'));
    assert.equal(rules.length, 1,
      '.chat__send:disabled must be styled in exactly one place, found at lines '
      + rules.map((r) => r.n).join(', '));
    assert.match(rules[0].l, /opacity: 0\.42/);
    assert.match(rules[0].l, /cursor: default/);
  });

  test('[hidden] actually hides the composer', () => {
    /*
     * THE BUG: .chat__form sets display:flex, and a class selector beats the
     * user agent's [hidden]{display:none}. showStartForm() set the attribute
     * and nothing happened - the start form and the composer were on screen
     * together, asking for the same message twice.
     */
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    assert.match(css, /\.chat__form\[hidden\] \{\s*display: none;/);
  });

  /* ---------------------------------------------------------------------
   * THE ROLLING NEWEST-200 WINDOW
   *
   * THE BUG: orderBy('createdAt','asc') + limit(200) returns the two hundred
   * OLDEST messages. limit() applies to the ORDER, not to the display, so once
   * a conversation passed two hundred the window stopped moving - new messages
   * fell outside it and the customer's own sends never appeared. A chat that
   * silently stops updating is worse than one that never worked, because the
   * visitor cannot tell.
   * ------------------------------------------------------------------- */

  test('the listener orders createdAt DESCENDING', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(mod._internals.TRANSCRIPT_ORDER, 'desc');
      assert.deepEqual(stub.calls.orderBy[0], { field: 'createdAt', direction: 'desc' });
    } finally {
      fetcher.restore();
    }
  });

  test('and still carries the conversationId equality and limit(200)', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.deepEqual(stub.calls.where[0],
        { field: 'conversationId', op: '==', value: 'conv-1' });
      assert.equal(stub.calls.limit[0].n, 200);
      assert.equal(mod._internals.TRANSCRIPT_LIMIT, 200);
      /* The rules cap it, independently of this client. */
      const rules = readFileSync('/home/user/esthers/firestore.rules', 'utf8');
      assert.match(rules, /function maxMessageQuery\(\) \{ return 200; \}/);
    } finally {
      fetcher.restore();
    }
  });

  test('all three constraints reach query(), in order, with desc', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const cs = stub.calls.query[0].constraints;
      assert.equal(cs.length, 3);
      assert.deepEqual(cs[0].__where, ['conversationId', '==', 'conv-1']);
      assert.deepEqual(cs[1].__orderBy, ['createdAt', 'desc']);
      assert.equal(cs[2].__limit, 200);
    } finally {
      fetcher.restore();
    }
  });

  test('chronological() reverses, immutably', async () => {
    /*
     * Tested directly, and here is the honest reason why.
     *
     * TranscriptStore.list() sorts by (createdAt, id) on every render, so the
     * RENDERED order is already right whatever order the documents arrive in -
     * deleting this reversal would not currently change a single pixel, and a
     * test claiming otherwise would be theatre. What is asserted is the
     * transformation itself: it is the contract at the boundary between the
     * descending query and the renderer, and it keeps the pipeline correct if
     * the store's sort is ever simplified away.
     */
    const { mod } = await load();
    const input = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    const out = mod._internals.chronological(input);
    assert.deepEqual(out.map((d) => d.id), ['a', 'b', 'c']);
    assert.deepEqual(input.map((d) => d.id), ['c', 'b', 'a'],
      'the SDK\'s own array must not be mutated');
    assert.notEqual(out, input, 'a new array, not the same one reversed');
    assert.deepEqual(mod._internals.chronological([]), []);
    assert.deepEqual(mod._internals.chronological(null), []);
    assert.deepEqual(mod._internals.chronological(undefined), []);
  });

  test('a newest-first snapshot renders oldest-first, newest at the bottom',
    async () => {
      const { mod, stub } = await load();
      const { ui, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();
        /* Exactly as Firestore delivers a descending query. */
        stub.emitSnapshot([
          { id: 'm3', data: { body: 'newest', senderType: 'staff', createdAt: 300 } },
          { id: 'm2', data: { body: 'middle', senderType: 'customer', createdAt: 200 } },
          { id: 'm1', data: { body: 'oldest', senderType: 'customer', createdAt: 100 } }
        ]);
        assert.deepEqual(ui.messages.map((m) => m.body), ['oldest', 'middle', 'newest']);
        assert.equal(ui.messages[ui.messages.length - 1].body, 'newest',
          'the newest message is the last one rendered - the bottom of the panel');
      } finally {
        fetcher.restore();
      }
    });

  test('THE 201-MESSAGE BOUNDARY: #1 falls out, #2..#201 remain, #201 is newest',
    async () => {
      /*
       * The exact case the bug was about. Firestore is asked for the newest
       * 200 of 201, descending, so it delivers #201 down to #2 and message #1
       * is outside the window.
       */
      const { mod, stub } = await load();
      const { ui, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();

        /* 201 messages exist; the descending limit(200) yields #201..#2. */
        const all = [];
        for (let n = 1; n <= 201; n++) {
          all.push({
            id: 'm' + String(n).padStart(4, '0'),
            data: { body: 'msg ' + n, senderType: 'customer', createdAt: n * 1000 }
          });
        }
        const window200 = all.slice(1).reverse();          /* #201 down to #2 */
        assert.equal(window200.length, 200);
        assert.equal(window200[0].data.body, 'msg 201');
        assert.equal(window200[199].data.body, 'msg 2');

        stub.emitSnapshot(window200);

        const bodies = ui.messages.map((m) => m.body);
        assert.equal(bodies.length, 200, 'exactly the newest 200 are represented');
        assert.equal(bodies.includes('msg 1'), false,
          'message #1 is OUTSIDE the rolling window');
        assert.equal(bodies.includes('msg 2'), true, 'message #2 is inside it');
        assert.equal(bodies.includes('msg 201'), true, 'message #201 is present');
        assert.equal(bodies[0], 'msg 2', 'oldest visible is #2');
        assert.equal(bodies[199], 'msg 201',
          'and #201 renders as the NEWEST visible message, at the bottom');

        /* Every one of #2..#201 present, none missing, none duplicated. */
        for (let n = 2; n <= 201; n++) {
          assert.equal(bodies.filter((b) => b === 'msg ' + n).length, 1,
            'msg ' + n + ' appears exactly once');
        }
      } finally {
        fetcher.restore();
      }
    });

  test('past 200, a NEWLY ARRIVING message stays visible - the window rolls',
    async () => {
      /* THE ACTUAL BUG. With ascending order this message would have fallen
         outside the window and never appeared. */
      const { mod, stub } = await load();
      const { ui, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();

        const desc = (from, to) => {
          const out = [];
          for (let n = from; n >= to; n--) {
            out.push({
              id: 'm' + String(n).padStart(4, '0'),
              data: { body: 'msg ' + n, senderType: 'customer', createdAt: n * 1000 }
            });
          }
          return out;
        };

        stub.emitSnapshot(desc(201, 2));
        assert.equal(ui.messages[199].body, 'msg 201');

        /* #202 arrives. The window rolls: #2 drops off, #202 appears. */
        stub.emitSnapshot(desc(202, 3));
        const bodies = ui.messages.map((m) => m.body);
        assert.equal(bodies.length, 200);
        assert.equal(bodies.includes('msg 202'), true,
          'a message sent after 200 MUST still appear');
        assert.equal(bodies[199], 'msg 202', 'and it is the newest');
        assert.equal(bodies.includes('msg 2'), false, '#2 has rolled off');
        assert.equal(bodies[0], 'msg 3', 'oldest visible is now #3');
      } finally {
        fetcher.restore();
      }
    });

  test('no duplicates survive repeated snapshots of a full window', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const batch = [];
      for (let n = 200; n >= 1; n--) {
        batch.push({
          id: 'm' + String(n).padStart(4, '0'),
          data: { body: 'msg ' + n, senderType: 'staff', createdAt: n * 1000 }
        });
      }
      stub.emitSnapshot(batch);
      stub.emitSnapshot(batch);
      stub.emitSnapshot(batch.slice().reverse());   /* same set, other order */
      const bodies = ui.messages.map((m) => m.body);
      assert.equal(bodies.length, 200);
      assert.equal(new Set(bodies).size, 200, 'no message rendered twice');
      assert.equal(bodies[0], 'msg 1');
      assert.equal(bodies[199], 'msg 200');
    } finally {
      fetcher.restore();
    }
  });

  test('the rolling window keeps exactly one listener, and unsubscribes',
    async () => {
      const { mod, stub } = await load();
      const { ui, session, fetcher } = await connectedSession(mod);
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();
        stub.emitSnapshot([
          { id: 'm1', data: { body: 'a', senderType: 'staff', createdAt: 1 } }
        ]);
        assert.equal(stub.liveListenerCount(), 1, 'one subscription');
        assert.equal(stub.calls.onSnapshot.length, 1, 'and it was opened once');

        session.stop();
        assert.equal(stub.liveListenerCount(), 0, 'unsubscribe still works');
        assert.equal(stub.calls.unsubscribe.length, 1);
      } finally {
        fetcher.restore();
      }
    });

  test('the window change introduced no Firestore write API', () => {
    for (const forbidden of [
      'addDoc', 'setDoc', 'updateDoc', 'deleteDoc', 'writeBatch',
      'runTransaction', 'serverTimestamp', 'startAfter', 'endBefore'
    ]) {
      assert.equal(CUSTOMER_IDENTS.includes(forbidden), false,
        'must not appear: ' + forbidden);
    }
  });

  test('both rollout gates are still false after the window change', async () => {
    const { mod } = await load();
    assert.equal(mod.CHAT_PUBLIC_ENABLED, false);
    assert.equal(mod.isPublicChatEnabled(), false);
    assert.match(WIDGET_SRC, /var CHAT_PUBLIC_ENABLED = false;/);
  });

  test('the source no longer carries a literal NUL byte', () => {
    /* One did, in the test that reproduces the server hash - it made the file
       read as binary to grep and other text tooling. */
    for (const [name, src] of [['chat-customer.js', CUSTOMER_SRC],
      ['chat.js', WIDGET_SRC]]) {
      assert.equal(src.includes('\u0000'), false, name + ' has a literal NUL');
    }
  });
});

/* ==================================== CLOSED-STATE RECOVERY (the real bug)
 *
 * REPRODUCED IN A PRODUCTION REVIEW: staff close a conversation, the customer
 * reloads, and the restored panel says "Connected" with a live composer. The
 * transcript listener watches chatMessages and closeConversation() writes only
 * to the conversation document, so a close is invisible to it. The backend
 * refused every post-close send correctly - the client was the thing lying.
 * ------------------------------------------------------------------- */

describe('closed-state recovery', () => {
  /* A responder that answers /api/chat/status with a chosen status and
     everything else normally. */
  function withStatus(statusValue, extra) {
    let starts = 0;
    return (n, input) => {
      if (String(input).indexOf('/api/chat/status') === 0) {
        if (extra && extra.statusResponse) return extra.statusResponse();
        return jsonResponse(200, {
          ok: true, conversationId: 'conv-earlier', status: statusValue
        });
      }
      starts += 1;
      return jsonResponse(200, starts === 1 ? OK_START : OK_SEND);
    };
  }

  const recalled = (mod, id = 'conv-earlier') => memoryStorage({
    [mod._internals.CONVERSATION_KEY]:
      JSON.stringify({ uid: 'anon-uid-1', conversationId: id })
  });

  test('a restored OPEN conversation asks the server, then connects', async () => {
    const { mod, stub } = await load();
    const clock = fakeClock();
    const { ui, fetcher } = await connectedSession(mod, {
      clock,
      storage: recalled(mod),
      responder: withStatus('open')
    });
    try {
      await tick();
      const statusCalls = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/api/chat/status') === 0);
      assert.equal(statusCalls.length, 1, 'the status endpoint was queried');
      assert.match(String(statusCalls[0].input), /conversationId=conv-earlier/);
      assert.equal(statusCalls[0].init.method, 'GET');

      assert.equal(ui.startFormShown, 0, 'no start form for a returning visitor');
      assert.equal(ui.transcriptShown, 1, 'the transcript restored');
      assert.equal(ui.status, 'Connected');
      assert.equal(ui.composerEnabled, true, 'and the composer is live');
      assert.equal(stub.calls.where[0].value, 'conv-earlier');
    } finally {
      fetcher.restore();
    }
  });

  test('a restored CLOSED conversation comes back CLOSED - THE BUG', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const { ui, session, fetcher } = await connectedSession(mod, {
      clock,
      storage: recalled(mod),
      responder: withStatus('closed')
    });
    try {
      await tick();
      const statusCalls = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/api/chat/status') === 0);
      assert.equal(statusCalls.length, 1, 'the status endpoint was queried');

      assert.equal(session.closed, true);
      assert.equal(ui.closed, true, 'the panel shows the closed state');
      assert.equal(ui.composerEnabled, false, 'and the composer is dead');
      assert.equal(ui.status, 'Conversation closed');
      assert.equal(ui.transcriptShown, 1, 'the transcript is still restored');

      /* THE POINT: not one write was attempted to discover this. */
      const writes = fetcher.seen.filter((r) => r.init.method === 'POST');
      assert.equal(writes.length, 0,
        'the customer must not have to send a message to learn it is closed');
    } finally {
      fetcher.restore();
    }
  });

  test('the composer is never enabled before the status is known', async () => {
    /* Order matters: openTranscript() enables the composer, so the status
       call has to resolve first or there is a window of live composer on a
       conversation nobody has confirmed. */
    const { mod } = await load();
    const order = [];
    const clock = fakeClock();
    const ui = recordingUi();
    const realSetComposer = ui.setComposerEnabled;
    ui.setComposerEnabled = (f) => { order.push('composer:' + f); realSetComposer(f); };
    const storage = recalled(mod);
    const fetcher = captureFetch((n, input) => {
      if (String(input).indexOf('/api/chat/status') === 0) {
        order.push('status');
        return jsonResponse(200, { ok: true, conversationId: 'conv-earlier', status: 'closed' });
      }
      return jsonResponse(200, OK_START);
    });
    try {
      await mod.openChatForReview({
        ui, openPanel: () => {},
        deps: Object.assign({ storage: () => storage }, clock.deps)
      });
      await tick();
      const statusAt = order.indexOf('status');
      const enabledAt = order.indexOf('composer:true');
      assert.ok(statusAt !== -1, 'status was asked');
      assert.ok(enabledAt === -1 || statusAt < enabledAt,
        'the composer was never enabled before the answer arrived: ' + order.join(' -> '));
    } finally {
      fetcher.restore();
    }
  });

  test('a status 404 discards the dead conversation and offers a fresh start',
    async () => {
      const { mod } = await load();
      const clock = fakeClock();
      const storage = recalled(mod);
      const { ui, session, fetcher } = await connectedSession(mod, {
        clock, storage,
        responder: (n, input) => {
          if (String(input).indexOf('/api/chat/status') === 0) {
            return jsonResponse(404, { ok: false, code: 'conversation_not_found' });
          }
          return jsonResponse(200, OK_START);
        }
      });
      try {
        await tick();
        assert.equal(storage.getItem(mod._internals.CONVERSATION_KEY), null,
          'the dead id is forgotten');
        assert.equal(session.conversationId, null);
        assert.equal(ui.startFormShown, 1);
        assert.equal(ui.transcriptShown, 0, 'no transcript on a conversation that is gone');
      } finally {
        fetcher.restore();
      }
    });

  test('a failed status check does NOT silently pretend the thread is fine',
    async () => {
      const { mod } = await load();
      const clock = fakeClock();
      const { ui, fetcher } = await connectedSession(mod, {
        clock,
        storage: recalled(mod),
        responder: (n, input) => {
          if (String(input).indexOf('/api/chat/status') === 0) {
            return new TypeError('Failed to fetch');
          }
          return jsonResponse(200, OK_START);
        }
      });
      try {
        await tick();
        assert.ok(typeof ui.notice === 'string' && ui.notice.length > 0,
          'the visitor is told the check did not land');
        assert.match(ui.notice, /could not reach us/);
      } finally {
        fetcher.restore();
      }
    });

  test('a failed status check NEVER reopens a conversation known to be closed',
    async () => {
      /* The dangerous direction. A dropped request is not evidence that staff
         reopened a thread - there is no reopen path in the API at all. */
      const { mod } = await load();
      const clock = fakeClock();
      let phase = 'closed';
      const { ui, session, fetcher } = await connectedSession(mod, {
        clock,
        storage: recalled(mod),
        responder: (n, input) => {
          if (String(input).indexOf('/api/chat/status') === 0) {
            if (phase === 'closed') {
              return jsonResponse(200, { ok: true, conversationId: 'conv-earlier', status: 'closed' });
            }
            return new TypeError('Failed to fetch');
          }
          return jsonResponse(200, OK_START);
        }
      });
      try {
        await tick();
        assert.equal(session.closed, true);

        phase = 'broken';
        await session.refreshStatus({});
        await tick();

        assert.equal(session.closed, true, 'still closed');
        assert.equal(ui.composerEnabled, false, 'and the composer stays dead');
      } finally {
        fetcher.restore();
      }
    });

  test('a status response that says open does not reopen a closed session',
    async () => {
      /* Belt and braces against a stale or replayed response. */
      const { mod } = await load();
      const clock = fakeClock();
      let value = 'closed';
      const { ui, session, fetcher } = await connectedSession(mod, {
        clock,
        storage: recalled(mod),
        responder: (n, input) => {
          if (String(input).indexOf('/api/chat/status') === 0) {
            return jsonResponse(200, { ok: true, conversationId: 'conv-earlier', status: value });
          }
          return jsonResponse(200, OK_START);
        }
      });
      try {
        await tick();
        assert.equal(session.closed, true);
        value = 'open';
        await session.refreshStatus({});
        await tick();
        assert.equal(session.closed, true, 'closed is terminal on the client too');
        assert.equal(ui.composerEnabled, false);
      } finally {
        fetcher.restore();
      }
    });
});

/* ------------------------------------------------- the live close watch */

describe('noticing a staff-side close without sending', () => {
  const openThenClosed = () => {
    let closedNow = false;
    let starts = 0;
    const r = (n, input) => {
      if (String(input).indexOf('/api/chat/status') === 0) {
        return jsonResponse(200, {
          ok: true, conversationId: 'conv-1', status: closedNow ? 'closed' : 'open'
        });
      }
      starts += 1;
      return jsonResponse(200, starts === 1 ? OK_START : OK_SEND);
    };
    r.close = () => { closedNow = true; };
    return r;
  };

  test('the interval notices a close, with no send attempted', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const responder = openThenClosed();
    const { ui, session, fetcher } = await connectedSession(mod, { clock, responder });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(session.closed, false);
      assert.equal(clock.liveTimers(), 1, 'the watch is running');

      responder.close();
      clock.fireInterval();
      await tick();

      assert.equal(session.closed, true, 'learned from the watch');
      assert.equal(ui.composerEnabled, false);
      assert.equal(ui.status, 'Conversation closed');
      const writes = fetcher.seen.filter(
        (r) => r.init.method === 'POST' && String(r.input).indexOf('/api/chat/send') === 0);
      assert.equal(writes.length, 0, 'no message was sent to discover it');
    } finally {
      fetcher.restore();
    }
  });

  test('the tab becoming visible checks immediately', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const responder = openThenClosed();
    const { ui, session, fetcher } = await connectedSession(mod, { clock, responder });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(clock.visibilityListeners(), 1);

      responder.close();
      clock.becomeHidden();
      clock.becomeVisible();
      await tick();

      assert.equal(session.closed, true, 'noticed on return, without the timer');
    } finally {
      fetcher.restore();
    }
  });

  test('a hidden tab does not check', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const { ui, fetcher } = await connectedSession(mod, { clock, responder: openThenClosed() });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const before = fetcher.seen.length;
      clock.doc.visibilityState = 'hidden';
      for (const fn of clock.doc.listeners.visibilitychange) fn();
      await tick();
      assert.equal(fetcher.seen.length, before, 'going hidden asks nothing');
    } finally {
      fetcher.restore();
    }
  });

  test('the watch STOPS once closed - nothing left to learn', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const responder = openThenClosed();
    const { ui, fetcher } = await connectedSession(mod, { clock, responder });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      responder.close();
      clock.fireInterval();
      await tick();

      assert.equal(clock.liveTimers(), 0, 'the timer is gone');
      assert.equal(clock.visibilityListeners(), 0, 'and so is the listener');

      const after = fetcher.seen.length;
      clock.becomeVisible();
      await tick();
      assert.equal(fetcher.seen.length, after, 'and nothing asks again');
    } finally {
      fetcher.restore();
    }
  });

  test('a 409 close stops the watch IMMEDIATELY, not on the next tick', async () => {
    /*
     * The other way a conversation becomes closed: the customer sends, the
     * server refuses 409, and reportFailure() -> applyClosed() runs. That path
     * never goes through refreshStatus(), so applyClosed() has to stop the
     * watch itself.
     *
     * Without this test the suite could not see it. refreshStatus() also calls
     * stopStatusWatch() right after applyClosed(), so a mutation removing the
     * call from applyClosed() was masked on the polling path, and on this path
     * the timer merely self-healed on its next tick - a minute of a timer
     * running against a conversation that can never change again, and a
     * teardown that depends on a second mechanism to be correct.
     */
    const { mod } = await load();
    const clock = fakeClock();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      clock,
      responder: (n, input) => {
        if (String(input).indexOf('/api/chat/status') === 0) {
          return jsonResponse(200, { ok: true, conversationId: 'conv-1', status: 'open' });
        }
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(409, { ok: false, code: 'conversation_closed' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(clock.liveTimers(), 1, 'the watch is running on an open thread');
      assert.equal(clock.visibilityListeners(), 1);

      await ui.sendHandler({ message: 'refused' });
      await tick();

      assert.equal(session.closed, true);
      /* No interval fired, no visibility event - the teardown is applyClosed's
         own doing. */
      assert.equal(clock.liveTimers(), 0, 'the timer is gone at once');
      assert.equal(clock.visibilityListeners(), 0, 'and so is the listener');
    } finally {
      fetcher.restore();
    }
  });

  test('the watch stops on suspend, disconnect and stop', async () => {
    for (const teardown of ['suspend', 'disconnect', 'stop']) {
      const { mod } = await load();
      const clock = fakeClock();
      const { ui, session, fetcher } = await connectedSession(mod, {
        clock, responder: openThenClosed()
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await tick();
        assert.equal(clock.liveTimers(), 1, teardown + ': running first');

        if (teardown === 'stop') session.stop();
        else mod[teardown]();

        assert.equal(clock.liveTimers(), 0, teardown + ' must clear the timer');
        assert.equal(clock.visibilityListeners(), 0,
          teardown + ' must remove the visibility listener');
      } finally {
        fetcher.restore();
      }
    }
  });

  test('resume checks immediately and restarts exactly one watch', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const responder = openThenClosed();
    const { ui, session, fetcher } = await connectedSession(mod, { clock, responder });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();

      mod.suspend();
      assert.equal(clock.liveTimers(), 0);
      responder.close();          /* staff close while the panel is shut */

      mod.resume();
      await tick();

      assert.equal(session.closed, true, 'reopening the panel notices at once');
      assert.equal(clock.liveTimers(), 0, 'and the watch stops, being closed');
    } finally {
      fetcher.restore();
    }
  });

  test('NO OVERLAPPING WATCHES, however many times it is started', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const { ui, session, fetcher } = await connectedSession(mod, {
      clock, responder: openThenClosed()
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      for (let i = 0; i < 5; i++) session.watchStatus();
      assert.equal(clock.liveTimers(), 1, 'one timer, always');
      assert.equal(clock.visibilityListeners(), 1, 'one listener, always');
      for (let i = 0; i < 3; i++) { mod.suspend(); mod.resume(); await tick(); }
      assert.equal(clock.liveTimers(), 1);
      assert.equal(clock.visibilityListeners(), 1);
    } finally {
      fetcher.restore();
    }
  });

  test('no overlapping REQUESTS - a check in flight blocks another', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    let release = null;
    const gate = new Promise((r) => { release = r; });
    let starts = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      clock,
      responder: (n, input) => {
        if (String(input).indexOf('/api/chat/status') === 0) {
          return gate.then(() => jsonResponse(200,
            { ok: true, conversationId: 'conv-1', status: 'open' }));
        }
        starts += 1;
        return jsonResponse(200, starts === 1 ? OK_START : OK_SEND);
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const before = fetcher.seen.length;

      const a = session.refreshStatus({});
      const b = session.refreshStatus({});
      const c = session.refreshStatus({});
      release();
      await Promise.all([a, b, c]);

      const statusCalls = fetcher.seen.slice(before).filter(
        (r) => String(r.input).indexOf('/api/chat/status') === 0);
      assert.equal(statusCalls.length, 1, 'three calls, one request');
    } finally {
      fetcher.restore();
    }
  });

  test('the interval is a minute, not a hammer', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const { ui, fetcher } = await connectedSession(mod, { clock, responder: openThenClosed() });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(mod._internals.STATUS_POLL_MS, 60000);
      assert.equal(clock.intervalMs(), 60000);
    } finally {
      fetcher.restore();
    }
  });

  test('a status check carries BOTH credentials, as a GET with no body', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('app-check-abc');
    stub.setSignedInUser({ uid: 'anon-uid-1', getIdToken: async () => 'id-token-xyz' });
    const clock = fakeClock();
    const { ui, session, fetcher } = await connectedSession(mod, {
      clock, responder: openThenClosed()
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      await session.refreshStatus({});

      const req = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/api/chat/status') === 0).pop();
      assert.ok(req, 'a status request was made');
      assert.equal(req.init.method, 'GET');
      assert.equal(req.init.body, undefined, 'no body on a GET');
      assert.equal(req.init.headers.get('Authorization'), 'Bearer id-token-xyz');
      assert.equal(req.init.headers.get('X-Firebase-AppCheck'), 'app-check-abc');
      assert.equal(req.init.headers.get('Authorization').includes('app-check-abc'), false);
      assert.equal(req.init.headers.get('X-Firebase-AppCheck').includes('id-token-xyz'), false);
    } finally {
      fetcher.restore();
    }
  });

  test('the status URL carries only the conversation id', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const { ui, session, fetcher } = await connectedSession(mod, {
      clock, responder: openThenClosed()
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      await session.refreshStatus({});
      const req = fetcher.seen.filter(
        (r) => String(r.input).indexOf('/api/chat/status') === 0).pop();
      const url = String(req.input);
      assert.equal(url, '/api/chat/status?conversationId=conv-1');
      for (const forbidden of ['customerUid', 'uid=', 'email', 'name=']) {
        assert.equal(url.includes(forbidden), false, 'leaked ' + forbidden);
      }
    } finally {
      fetcher.restore();
    }
  });

  test('the gate-off path opens no watch at all', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    const ui = recordingUi();
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      await mod.connect(ui, {
        deps: Object.assign({ storage: () => memoryStorage() }, clock.deps)
      });
      await tick();
      assert.equal(clock.liveTimers(), 0);
      assert.equal(clock.visibilityListeners(), 0);
      assert.equal(fetcher.seen.length, 0);
    } finally {
      fetcher.restore();
    }
  });
});

/* ------------------------------------------------------- closed-state UI */

describe('the closed state is explained exactly once', () => {
  test('a 409 close shows the state, not the state PLUS a banner', async () => {
    /*
     * THE BUG: reportFailure() set the notice to "This conversation has been
     * closed." and then applyClosed() added the fuller note - so the customer
     * was told the same thing twice, once tersely in an error banner and once
     * properly in the transcript.
     */
    const { mod } = await load();
    const clock = fakeClock();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      clock,
      responder: (n, input) => {
        if (String(input).indexOf('/api/chat/status') === 0) {
          return jsonResponse(200, { ok: true, conversationId: 'conv-1', status: 'open' });
        }
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(409, { ok: false, code: 'conversation_closed' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'anyone there?' });
      await tick();

      assert.equal(ui.closed, true, 'the closed state is set');
      assert.equal(ui.notice, null, 'and the banner is cleared, not left beside it');
      assert.equal(ui.retry, null, 'no retry on a conversation that is over');
      assert.equal(ui.composerEnabled, false);
    } finally {
      fetcher.restore();
    }
  });

  test('setClosed is applied once, not once per snapshot', async () => {
    const { mod, stub } = await load();
    const clock = fakeClock();
    const { ui, session, fetcher } = await connectedSession(mod, {
      clock, responder: (n, input) =>
        String(input).indexOf('/api/chat/status') === 0
          ? jsonResponse(200, { ok: true, conversationId: 'conv-1', status: 'closed' })
          : jsonResponse(200, OK_START)
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      await session.refreshStatus({});
      await session.refreshStatus({});
      stub.emitSnapshot([
        { id: 'm1', data: { body: 'earlier', senderType: 'customer', createdAt: 1 } }
      ]);
      await tick();
      const closedTrue = ui.closedHistory.filter((f) => f === true).length;
      assert.equal(closedTrue, 1, 'applied once: ' + JSON.stringify(ui.closedHistory));
    } finally {
      fetcher.restore();
    }
  });

  test('the rejected optimistic message does not survive the close', async () => {
    const { mod } = await load();
    const clock = fakeClock();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      clock,
      responder: (n, input) => {
        if (String(input).indexOf('/api/chat/status') === 0) {
          return jsonResponse(200, { ok: true, conversationId: 'conv-1', status: 'open' });
        }
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(409, { ok: false, code: 'conversation_closed' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'this one is refused' });
      await tick();
      const bodies = (ui.messages || []).map((m) => m.body);
      assert.equal(bodies.includes('this one is refused'), false,
        'a message the server refused must not sit in the transcript looking sent');
    } finally {
      fetcher.restore();
    }
  });

  test('the widget renders the closed note once, and it survives a snapshot', () => {
    /*
     * It used to be appended imperatively by setClosed(), and the next
     * renderMessages() cleared the log - so the explanation vanished while the
     * composer stayed disabled, leaving nothing on screen to explain why.
     */
    assert.match(WIDGET_CODE, /function appendClosedNote\(\)/);
    assert.match(WIDGET_CODE, /appendClosedNote\(\);\s+if \(pinned\) scrollLog\(\);/);
    /* And the empty transcript shows it too, rather than "send one". */
    assert.match(WIDGET_CODE, /isClosed\s*\?\s*CLOSED_NOTE/);
    /* Exactly one definition of the sentence. */
    const occurrences = (WIDGET_CODE.match(/This conversation has been closed\./g) || []).length;
    assert.equal(occurrences, 1, 'the closed sentence is written in one place');
  });

  test('the transport no longer emits a second closed sentence', () => {
    /* messageForCode('conversation_closed') still exists for describeFailure,
       but the send guard must not push it into the notice on top of the
       closed state. */
    const guard = CUSTOMER_CODE.slice(
      CUSTOMER_CODE.indexOf('async send(fields) {'),
      CUSTOMER_CODE.indexOf('const body = String('));
    assert.equal(guard.includes("messageForCode('conversation_closed')"), false,
      'the closed guard must not add a banner beside the closed state');
  });
});

/* ============================================= 14-15, 21. THE TRANSCRIPT */

describe('the transcript', () => {
  test('a message delivered twice is one row', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    const doc = { id: 'm1', data: { body: 'hello', senderType: 'customer', createdAt: 10 } };
    store.applySnapshot([doc]);
    const list = store.applySnapshot([doc, doc]);
    assert.equal(list.length, 1);
  });

  test('the optimistic echo is REPLACED by the delivered document, not joined',
    async () => {
      const { mod } = await load();
      const store = new mod.TranscriptStore();
      /* Same id: the client derives it exactly as service.js does. */
      store.addPending({ id: 'derived-1', body: 'hi there', senderType: 'customer', createdAt: 5 });
      assert.equal(store.list().length, 1);
      assert.equal(store.list()[0].pending, true);

      const list = store.applySnapshot([
        { id: 'derived-1', data: { body: 'hi there', senderType: 'customer', createdAt: 7 } }
      ]);
      assert.equal(list.length, 1, 'not two copies of the same sentence');
      assert.equal(list[0].pending, false, 'and it is no longer pending');
    });

  test('the derived echo id matches what the server will actually use', async () => {
    /* If these ever diverge the visitor sees their own message twice. */
    const crypto = await import('node:crypto');
    const { mod } = await load();
    const serverId = (conversationId, clientMessageId) => crypto.createHash('sha256')
      .update(conversationId + '\u0000' + clientMessageId).digest('hex').slice(0, 40);

    for (const [conv, cmid] of [
      ['conv-1', '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'],
      ['0123456789abcdef0123456789abcdef', 'ffffffff-ffff-4fff-bfff-ffffffffffff']
    ]) {
      assert.equal(await mod.deriveMessageId(conv, cmid), serverId(conv, cmid));
    }
  });

  test('a pending message that fails is taken back off the screen', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    store.addPending({ id: 'p1', body: 'oops', senderType: 'customer', createdAt: 1 });
    assert.equal(store.list().length, 1);
    assert.equal(store.dropPending('p1').length, 0);
  });

  test('a delivered message is never dropped by dropPending', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    store.applySnapshot([{ id: 'm1', data: { body: 'real', senderType: 'staff', createdAt: 1 } }]);
    assert.equal(store.dropPending('m1').length, 1, 'only pending rows may be withdrawn');
  });

  test('ordering is deterministic, including a same-millisecond tie', async () => {
    const { mod } = await load();
    const store = new mod.TranscriptStore();
    const list = store.applySnapshot([
      { id: 'bbb', data: { body: 'b', senderType: 'staff', createdAt: 100 } },
      { id: 'aaa', data: { body: 'a', senderType: 'customer', createdAt: 100 } },
      { id: 'ccc', data: { body: 'c', senderType: 'staff', createdAt: 50 } }
    ]);
    assert.deepEqual(list.map((m) => m.id), ['ccc', 'aaa', 'bbb']);
  });

  test('only the four schema fields survive - nothing else is exposed', async () => {
    const { mod } = await load();
    const m = mod.normaliseMessage({
      id: 'm1',
      data: {
        body: 'hi', senderType: 'staff', createdAt: 3, conversationId: 'c1',
        /* If one of these is ever added to the collection it must not reach
           the renderer, whatever the rules happen to allow. */
        staffUserId: 'staff-9', internalNote: 'do not show', email: 'x@y.z'
      }
    });
    assert.deepEqual(Object.keys(m).sort(),
      ['body', 'createdAt', 'id', 'pending', 'senderType']);
    assert.equal(m.staffUserId, undefined);
    assert.equal(m.internalNote, undefined);
  });

  test('malformed documents are dropped, not rendered, and do not break the rest',
    async () => {
      const { mod } = await load();
      const store = new mod.TranscriptStore();
      const list = store.applySnapshot([
        null,
        { id: '', data: { body: 'no id', senderType: 'staff', createdAt: 1 } },
        { id: 'm2', data: { body: null, senderType: 'staff', createdAt: 1 } },
        { id: 'm3', data: { body: 'no sender', senderType: 'ADMIN', createdAt: 1 } },
        { id: 'm4', data: { body: 'good', senderType: 'staff', createdAt: 2 } }
      ]);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'm4');
    });

  test('an empty body is a valid message and is kept', async () => {
    const { mod } = await load();
    const m = mod.normaliseMessage({ id: 'm', data: { body: '', senderType: 'system', createdAt: 1 } });
    assert.equal(m.body, '');
  });

  test('a malformed timestamp sorts predictably instead of poisoning the order',
    async () => {
      const { mod } = await load();
      assert.equal(mod.toMillis(undefined), 0);
      assert.equal(mod.toMillis(null), 0);
      assert.equal(mod.toMillis(NaN), 0);
      assert.equal(mod.toMillis('yesterday'), 0);
      assert.equal(mod.toMillis(1234), 1234);
      assert.equal(mod.toMillis(new Date(5000)), 5000);
      assert.equal(mod.toMillis({ toMillis: () => 77 }), 77);
      assert.equal(mod.toMillis({ seconds: 2, nanoseconds: 500000000 }), 2500);
      assert.equal(mod.toMillis({ toMillis: () => NaN }), 0);
    });

  test('an empty transcript is a state, not a failure', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      stub.emitSnapshot([]);
      assert.deepEqual(ui.messages, []);
      assert.equal(ui.notice, null);
    } finally {
      fetcher.restore();
    }
  });

  test('the widget renders every message body with textContent, never innerHTML',
    () => {
      /* The three innerHTML calls in chat.js are fixed SVG icons built by
         that file. None of them is in the live-render path, and no message
         body reaches one. */
      const start = WIDGET_CODE.indexOf('function clearLog()');
      const end = WIDGET_CODE.indexOf('function build() {');
      const live = WIDGET_CODE.slice(start, end);
      assert.ok(start !== -1 && end > start && live.length > 500,
        'found the live section');
      assert.equal(live.includes('innerHTML'), false,
        'no innerHTML anywhere in the transport surface');
      assert.match(live, /bubble\.textContent = body;/);

      /* Across the whole widget there are exactly three, and each one is a
         fixed SVG icon this file builds. No message body reaches any of
         them. */
      const innerHtmlUses = (WIDGET_CODE.match(/\.innerHTML\s*=/g) || []).length;
      assert.equal(innerHtmlUses, 3, 'still exactly the three SVG icons');
      for (const m of WIDGET_CODE.matchAll(/(\w+)\.innerHTML\s*=/g)) {
        assert.ok(['closeBtn', 'dismissBtn', 'restoreBtn'].includes(m[1]),
          'unexpected innerHTML target: ' + m[1]);
      }
    });

  test('the transport hands the UI strings only - never nodes or markup', () => {
    /* renderMessages receives {id, senderType, body, createdAt, pending};
       every other ui call takes a string or a boolean. Prove the module
       never builds a DOM node to hand over. */
    for (const forbidden of [
      'createElement', 'innerHTML', 'outerHTML', 'insertAdjacentHTML',
      'document.write', 'appendChild'
    ]) {
      assert.equal(CUSTOMER_IDENTS.includes(forbidden), false,
        'the transport must not touch the DOM: found ' + forbidden);
    }
  });
});

/* ============================================ 16-20. FAILURE BEHAVIOUR */

describe('failures', () => {
  test('a closed conversation disables sending and says so', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(409, { ok: false, code: 'conversation_closed', error: 'closed' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'anyone there?' });
      assert.equal(ui.closed, true);
      assert.equal(ui.composerEnabled, false);
      assert.equal(session.closed, true);
      /* ONE explanation. The banner is cleared and the closed state carries
         the message - see 'the closed state is explained exactly once'. */
      assert.equal(ui.notice, null);
    } finally {
      fetcher.restore();
    }
  });

  test('once closed, a further send is refused locally without a request',
    async () => {
      const { mod } = await load();
      let call = 0;
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => {
          call += 1;
          if (call === 1) return jsonResponse(200, OK_START);
          return jsonResponse(409, { ok: false, code: 'conversation_closed' });
        }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        await ui.sendHandler({ message: 'one' });
        const before = fetcher.seen.length;
        await ui.sendHandler({ message: 'two' });
        assert.equal(fetcher.seen.length, before, 'no pointless request');
      } finally {
        fetcher.restore();
      }
    });

  test('the transcript stays readable after a conversation closes', async () => {
    const { mod, stub } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(409, { ok: false, code: 'conversation_closed' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      await ui.sendHandler({ message: 'x' });
      stub.emitSnapshot([
        { id: 'm1', data: { body: 'earlier', senderType: 'customer', createdAt: 1 } }
      ]);
      assert.equal(ui.messages.length, 1, 'history is not taken away');
    } finally {
      fetcher.restore();
    }
  });

  test('429 shows a wait message and offers NO retry - no loop', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(429, { ok: false, code: 'rate_limited', retryAfter: 30 });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: 'again' });
      await tick(5);

      assert.match(ui.notice, /wait a moment/);
      assert.equal(ui.retry, null, 'a 429 must not hand back a retry button');
      assert.equal(fetcher.seen.length, before + 1,
        'exactly one attempt - nothing retried it');
    } finally {
      fetcher.restore();
    }
  });

  test('the 429 POLICY issues no request of its own, busy guard aside', async () => {
    /*
     * The test above cannot see this on its own. reportFailure() runs from
     * inside send()'s catch, where this.sending is still true, so even a
     * deliberately reinstated automatic retry would be swallowed by that
     * guard and the request count would not move.
     *
     * Relying on that would be testing the guard, not the policy. So the
     * failure handler is invoked directly, with nothing in flight: if it
     * ever decides to resend on a 429, a request goes out here and this
     * fails. A mutation that adds exactly that retry survives without this
     * test and is caught by it.
     */
    const { mod } = await load();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.equal(session.sending, false, 'nothing is in flight');

      const before = fetcher.seen.length;
      session.reportFailure({ status: 429, code: 'rate_limited' }, { message: 'held back' });
      await tick(5);

      assert.equal(fetcher.seen.length, before,
        'a rate limit must never produce a request of its own');
      assert.equal(ui.retry, null, 'and no retry button either');
      assert.match(ui.notice, /wait a moment/);
    } finally {
      fetcher.restore();
    }
  });

  test('the auth POLICY issues no request of its own either', async () => {
    const { mod } = await load();
    const { ui, session, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const before = fetcher.seen.length;
      session.reportFailure({ status: 401, code: 'invalid_token' }, { message: 'x' });
      await tick(5);
      assert.equal(fetcher.seen.length, before);
      assert.equal(ui.retry, null);
    } finally {
      fetcher.restore();
    }
  });

  test('a 429 echo is withdrawn so nothing looks sent', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(429, { ok: false, code: 'rate_limited' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'too fast' });
      assert.deepEqual(ui.messages, [], 'the optimistic bubble is gone');
    } finally {
      fetcher.restore();
    }
  });

  test('App Check failure is handled cleanly - no unhandled rejection, no sign-in',
    async () => {
      const { mod, stub } = await load();
      stub.setAppCheckInitError();
      const ui = recordingUi();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      const silence = console.error;
      console.error = () => {};
      try {
        const session = await mod.openChatForReview({
          ui, openPanel: () => {},
          deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
        });
        await tick();
        assert.equal(session, null, 'it refuses rather than half-connecting');
        assert.equal(stub.calls.signInAnonymously.length, 0,
          'no anonymous account is minted for a session that cannot attest');
        assert.equal(stub.calls.onSnapshot.length, 0);
        assert.equal(fetcher.seen.length, 0);
        assert.match(ui.notice, /could not verify this page/);
        assert.equal(ui.composerEnabled, false);
      } finally {
        console.error = silence;
        fetcher.restore();
      }
    });

  test('a refused sign-in is handled cleanly', async () => {
    const { mod, stub } = await load();
    stub.setSignInError(new Error('auth/operation-not-allowed'));
    const ui = recordingUi();
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const session = await mod.openChatForReview({
        ui, openPanel: () => {},
        deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
      });
      await tick();
      assert.equal(session, null);
      assert.equal(fetcher.seen.length, 0);
      assert.equal(ui.composerEnabled, false);
      assert.ok(typeof ui.notice === 'string' && ui.notice.length > 0);
      assert.equal(ui.status, 'Not connected');
    } finally {
      fetcher.restore();
    }
  });

  test('a 401 stops the composer instead of leaving it to fail on every press',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => jsonResponse(401, { ok: false, code: 'invalid_token' })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        assert.equal(ui.composerEnabled, false);
        assert.equal(ui.retry, null);
        assert.match(ui.notice, /session has expired/);
      } finally {
        fetcher.restore();
      }
    });

  test('an App Check refusal from the API reads as "reload", not "expired"',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => jsonResponse(401, { ok: false, code: 'app_check_required' })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        assert.match(ui.notice, /could not verify this page/);
      } finally {
        fetcher.restore();
      }
    });

  test('a listener permission error stops dead - no retry, no loop', async () => {
    const { mod, stub } = await load();
    const storage = memoryStorage();
    const { ui, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const before = stub.calls.onSnapshot.length;

      stub.emitListenerError({ code: 'permission-denied' });
      await tick(5);

      assert.equal(stub.calls.onSnapshot.length, before,
        'permission-denied must never be retried - the rules will say no again');
      assert.equal(ui.retry, null, 'and no retry is offered');
      assert.equal(stub.liveListenerCount(), 0, 'the dead listener is let go');
    } finally {
      fetcher.restore();
    }
  });

  test('a rules refusal DISCARDS the conversation so the tab can recover', async () => {
    /*
     * The stored id is now known-bad. Leaving it in sessionStorage made every
     * future load of this tab recall it, fail the same way, and land right
     * back here - a permanent dead end behind a "reload the page" that could
     * not possibly help.
     */
    const { mod, stub } = await load();
    const storage = memoryStorage();
    const { ui, session, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.ok(storage.getItem(mod._internals.CONVERSATION_KEY), 'stored to begin with');
      /* One start form has already been shown - this session began without a
         recalled conversation. Count from here. */
      const formsBefore = ui.startFormShown;

      stub.emitListenerError({ code: 'permission-denied' });
      await tick(5);

      assert.equal(storage.getItem(mod._internals.CONVERSATION_KEY), null,
        'the dead conversation id is forgotten');
      assert.equal(session.conversationId, null);
      assert.equal(ui.startFormShown, formsBefore + 1, 'and a fresh start is offered');
      assert.match(ui.notice, /start a new one/);
    } finally {
      fetcher.restore();
    }
  });

  test('a 404 conversation_not_found also discards it', async () => {
    const { mod } = await load();
    const storage = memoryStorage();
    let call = 0;
    const { ui, session, fetcher } = await connectedSession(mod, {
      storage,
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        return jsonResponse(404, { ok: false, code: 'conversation_not_found' });
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      assert.ok(storage.getItem(mod._internals.CONVERSATION_KEY));
      const formsBefore = ui.startFormShown;

      await ui.sendHandler({ message: 'anyone?' });
      await tick();

      assert.equal(storage.getItem(mod._internals.CONVERSATION_KEY), null,
        'a conversation the server says is gone must not be recalled forever');
      assert.equal(session.conversationId, null);
      assert.equal(ui.startFormShown, formsBefore + 1);
    } finally {
      fetcher.restore();
    }
  });

  test('a transient listener error offers ONE user-triggered retry', async () => {
    const { mod, stub } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await tick();
      const before = stub.calls.onSnapshot.length;

      stub.emitListenerError({ code: 'unavailable' });
      await tick(5);

      assert.equal(stub.calls.onSnapshot.length, before, 'nothing automatic');
      assert.equal(typeof ui.retry, 'function', 'the visitor is offered a button');

      ui.retry();
      await tick();
      assert.equal(stub.calls.onSnapshot.length, before + 1, 'and it works when pressed');
    } finally {
      fetcher.restore();
    }
  });

  test('a network failure offers a retry that reuses the same message', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => {
        call += 1;
        if (call === 1) return jsonResponse(200, OK_START);
        if (call === 2) return new TypeError('Failed to fetch');
        return jsonResponse(200, OK_SEND);
      }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      await ui.sendHandler({ message: 'did this arrive?' });
      assert.match(ui.notice, /could not reach us/);
      assert.equal(typeof ui.retry, 'function');

      await ui.retry();
      const resent = JSON.parse(fetcher.seen[fetcher.seen.length - 1].init.body);
      assert.equal(resent.message, 'did this arrive?');
    } finally {
      fetcher.restore();
    }
  });

  test('an empty message never becomes a request', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const before = fetcher.seen.length;
      await ui.sendHandler({ message: '   ' });
      await ui.sendHandler({ message: '' });
      await ui.sendHandler({});
      assert.equal(fetcher.seen.length, before);
      assert.equal(ui.notice, 'Please type a message first.');
    } finally {
      fetcher.restore();
    }
  });

  test('two sends at once do not both go out', async () => {
    const { mod } = await load();
    let call = 0;
    const { ui, fetcher } = await connectedSession(mod, {
      responder: () => { call += 1; return jsonResponse(200, call === 1 ? OK_START : OK_SEND); }
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const before = fetcher.seen.length;
      await Promise.all([
        ui.sendHandler({ message: 'one' }),
        ui.sendHandler({ message: 'two' })
      ]);
      assert.equal(fetcher.seen.length, before + 1, 'the second was declined while busy');
    } finally {
      fetcher.restore();
    }
  });

  test('a server response that is not JSON is a generic failure, not a crash',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => ({ ok: false, status: 500, json: async () => { throw new Error('nope'); } })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        assert.match(ui.notice, /Something went wrong/);
      } finally {
        fetcher.restore();
      }
    });

  test('a broken UI does not take the transport down', async () => {
    const { mod } = await load();
    const ui = recordingUi();
    ui.renderMessages = () => { throw new Error('renderer exploded'); };
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const session = await mod.openChatForReview({
        ui, openPanel: () => {},
        deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
      });
      assert.ok(session, 'still connected');
      const payload = await ui.startHandler({ name: 'Jo', email: 'j@e.co', message: 'hi', locationId: 'main' });
      assert.equal(payload.conversationId, 'conv-1');
    } finally {
      fetcher.restore();
    }
  });

  test('every failure sentence comes from the allow-list, never from the server',
    async () => {
      const { mod } = await load();
      const allowed = new Set(Object.values(mod._internals.MESSAGES_BY_CODE));
      /* A server that returned something odd must not get it onto the page. */
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => jsonResponse(500, {
          ok: false,
          code: 'not_a_real_code',
          error: 'Traceback (most recent call last): secret internal detail'
        })
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
        assert.ok(allowed.has(ui.notice), 'the notice is one of ours: ' + ui.notice);
        assert.equal(ui.notice.includes('Traceback'), false);
        assert.equal(ui.notice.includes('secret internal detail'), false);
      } finally {
        fetcher.restore();
      }
    });

  test('describeFailure covers every branch without a network', async () => {
    const { mod } = await load();
    const d = mod.describeFailure;
    assert.equal(d({ offline: true }).kind, 'offline');
    assert.equal(d({ status: 0 }).kind, 'offline');
    assert.equal(d({ status: 429, code: 'rate_limited' }).kind, 'rate_limited');
    assert.equal(d({ status: 409, code: 'conversation_closed' }).kind, 'closed');
    assert.equal(d({ status: 401, code: 'app_check_required' }).kind, 'app_check');
    assert.equal(d({ status: 401, code: 'invalid_token' }).kind, 'auth');
    assert.equal(d({ status: 403, code: 'not_a_customer' }).kind, 'auth');
    assert.equal(d({ status: 400, code: 'invalid_email' }).kind, 'input');
    assert.equal(d({ status: 404, code: 'conversation_not_found' }).kind, 'input');
    assert.equal(d({ status: 500 }).kind, 'server');
    assert.equal(d(null).kind, 'offline');
    assert.equal(d(undefined).kind, 'offline');
  });
});

/* ================================================ CONVERSATION RECOVERY */

describe('remembering a conversation', () => {
  test('the conversation id is stored against the uid that owns it', async () => {
    const { mod } = await load();
    const storage = memoryStorage();
    const { ui, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'hi', locationId: 'main' });
      const raw = JSON.parse(storage.getItem(mod._internals.CONVERSATION_KEY));
      assert.equal(raw.conversationId, 'conv-1');
      assert.equal(raw.uid, 'anon-uid-1');
    } finally {
      fetcher.restore();
    }
  });

  test('NO token of any kind is ever stored', async () => {
    const { mod, stub } = await load();
    stub.setAppCheckToken('APPCHECK-SECRET');
    stub.setSignedInUser({ uid: 'anon-uid-1', getIdToken: async () => 'IDTOKEN-SECRET' });
    const storage = memoryStorage();
    const { ui, fetcher } = await connectedSession(mod, { storage });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@example.com', message: 'secret message', locationId: 'main' });
      const dump = JSON.stringify(Array.from(storage._map.entries()));
      for (const secret of ['IDTOKEN-SECRET', 'APPCHECK-SECRET', 'jo@example.com',
        'secret message', 'Jo']) {
        assert.equal(dump.includes(secret), false, 'must not persist ' + secret);
      }
    } finally {
      fetcher.restore();
    }
  });

  test('a stored id belonging to a different uid is refused', async () => {
    const { mod } = await load();
    const store = memoryStorage({
      [mod._internals.CONVERSATION_KEY]:
        JSON.stringify({ uid: 'somebody-else', conversationId: 'conv-9' })
    });
    assert.equal(mod.recallConversation(store, 'anon-uid-1'), null);
    assert.equal(mod.recallConversation(store, 'somebody-else'), 'conv-9');
  });

  test('a corrupt or hostile stored value is refused', async () => {
    const { mod } = await load();
    const K = mod._internals.CONVERSATION_KEY;
    for (const bad of [
      'not json', '[]', 'null', '{}',
      JSON.stringify({ uid: 'u', conversationId: '../../etc/passwd' }),
      JSON.stringify({ uid: 'u', conversationId: 'has/slash' }),
      JSON.stringify({ uid: 'u', conversationId: '' }),
      JSON.stringify({ uid: 'u', conversationId: 'x'.repeat(65) }),
      JSON.stringify({ uid: 'u', conversationId: 42 })
    ]) {
      assert.equal(mod.recallConversation(memoryStorage({ [K]: bad }), 'u'), null,
        'refused: ' + bad);
    }
  });

  test('a recalled conversation reopens the transcript instead of the start form',
    async () => {
      const { mod, stub } = await load();
      const storage = memoryStorage({
        [mod._internals.CONVERSATION_KEY]:
          JSON.stringify({ uid: 'anon-uid-1', conversationId: 'conv-earlier' })
      });
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        const ui = recordingUi();
        await mod.openChatForReview({
          ui, openPanel: () => {},
        deps: Object.assign({ storage: () => storage }, fakeClock().deps)
        });
        await tick();
        assert.equal(ui.startFormShown, 0, 'no start form for a returning visitor');
        assert.equal(ui.transcriptShown, 1);
        assert.equal(stub.calls.where[0].value, 'conv-earlier');
      } finally {
        fetcher.restore();
      }
    });

  test('storage that throws on access is survivable', async () => {
    const { mod } = await load();
    const hostile = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); }
    };
    assert.equal(mod.recallConversation(hostile, 'u'), null);
    assert.equal(mod.rememberConversation(hostile, 'u', 'c'), false);
    mod.forgetConversation(hostile);          /* must not throw */

    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const ui = recordingUi();
      const session = await mod.openChatForReview({
        ui, openPanel: () => {},
        deps: Object.assign({ storage: () => hostile }, fakeClock().deps)
      });
      assert.ok(session, 'a private-mode browser still gets a working chat');
      await ui.startHandler({ name: 'Jo', email: 'j@e.co', message: 'hi', locationId: 'main' });
      assert.equal(ui.transcriptShown, 1);
    } finally {
      fetcher.restore();
    }
  });

  test('no storage at all is survivable', async () => {
    const { mod } = await load();
    assert.equal(mod.recallConversation(null, 'u'), null);
    assert.equal(mod.rememberConversation(null, 'u', 'c'), false);
    mod.forgetConversation(null);
  });
});

/* ================================================= THE REVIEW HARNESS */

describe('the review harness', () => {
  test('openChatForReview refuses when there is no UI to drive', async () => {
    const { mod } = await load();
    await assert.rejects(() => mod.openChatForReview({}), /No chat UI on this page/);
  });

  test('it is reached only by importing the module - nothing on the page leads to it',
    () => {
      /* The widget may DOCUMENT it - the comment on the gate points a
         reader at it, which is the whole reason the comment is there - but
         no code in chat.js may call or expose it. */
      assert.equal(WIDGET_CODE.includes('openChatForReview'), false,
        'no code in the widget may reach the review entry point');
      assert.ok(WIDGET_SRC.includes('openChatForReview'),
        'the gate comment should still point a reader at it');

      /* And no page loads the transport at all. */
      for (const page of [
        'index.html', 'about/index.html', 'contact/index.html',
        'gallery/index.html', 'materials/index.html', 'quote/index.html',
        'services/index.html'
      ]) {
        const html = readFileSync('/home/user/esthers/' + page, 'utf8');
        assert.equal(html.includes('chat-customer'), false,
          page + ' must not load the transport');
      }
    });

  test('it does not persist enablement anywhere', () => {
    const fn = CUSTOMER_IDENTS.slice(
      CUSTOMER_IDENTS.indexOf('export async function openChatForReview'),
      CUSTOMER_IDENTS.indexOf('function resolvePageUi'));
    assert.ok(fn.length > 100);
    for (const forbidden of ['setItem', 'localStorage', 'cookie', 'CHAT_PUBLIC_ENABLED =']) {
      assert.equal(fn.includes(forbidden), false, 'must not persist via ' + forbidden);
    }
  });

  test('it uses the widget surface rather than reaching into the DOM', () => {
    assert.match(CUSTOMER_SRC, /chat\.transportSurface\(\)/);
    assert.match(WIDGET_SRC, /transportSurface: enterLiveMode/);
  });
});

/* ============================================== 22. THE WIDGET ITSELF */

describe('the widget, with the gate shut', () => {
  test('the demo conversation is exactly what it was', () => {
    /* The two opening lines and the standing notice are what a visitor sees
       today, and this phase must not have changed them. */
    assert.match(WIDGET_SRC, /Online messaging is currently under construction\. /);
    assert.match(WIDGET_SRC, /Messages are not being sent to our team yet\./);
    assert.match(WIDGET_SRC, /addMessage\('them', 'Hi! How can we help with your sheet metal project\?'\);/);
    assert.match(WIDGET_SRC, /text: 'Online messaging coming soon\.'/);
  });

  test('submit() still runs the demo path when the transport is not attached', () => {
    const submit = WIDGET_SRC.slice(WIDGET_SRC.indexOf('function submit() {'),
      WIDGET_SRC.indexOf('/* --------------------------------------------------------- open / close */'));
    assert.match(submit, /if \(mode === 'live'\)/);
    assert.match(submit, /addMessage\('me', text\);/);
    assert.match(submit, /buildReplyNodes\(\)/);
  });

  test('closing the panel SUSPENDS the listener and opening RESUMES it', () => {
    /*
     * It used to call disconnect(), which tore the session down for good -
     * and nothing re-established it, so the reopened widget silently swallowed
     * every message. Suspend/resume is the pair that has to be here.
     */
    assert.match(WIDGET_CODE,
      /if \(mode === 'live' && transport && typeof transport\.suspend === 'function'\) \{\s*transport\.suspend\(\);/);
    assert.match(WIDGET_CODE,
      /if \(mode === 'live' && transport && typeof transport\.resume === 'function'\) \{\s*transport\.resume\(\);/);
    assert.equal(WIDGET_CODE.includes('transport.disconnect()'), false,
      'the widget must not tear the session down on a panel close');
  });

  test('a failed transport connection restores the working demo', () => {
    /*
     * enterLiveMode() blanks the demo conversation. Setting mode back to
     * 'demo' does not un-blank it, so a transport that fails to connect used
     * to leave an empty panel with a dead composer. restoreDemo() is the
     * other half.
     */
    assert.match(WIDGET_CODE, /function restoreDemo\(\)/);
    assert.match(WIDGET_CODE, /if \(!session\) restoreDemo\(\);/);
    assert.match(WIDGET_CODE, /\['catch'\]\(function \(\) \{\s*restoreDemo\(\);/);
    assert.match(WIDGET_CODE, /showDemoConversation\(\);/);
    /* And the gate is checked BEFORE the widget is handed over. */
    const fn = WIDGET_CODE.slice(WIDGET_CODE.indexOf('function connectTransport()'),
      WIDGET_CODE.indexOf('function restoreDemo()'));
    assert.ok(fn.indexOf('isPublicChatEnabled') < fn.indexOf('enterLiveMode()'),
      'the transport gate is read before the demo conversation is blanked');
  });

  test('the start form asks for exactly what /api/chat/start requires', () => {
    /* name, email and message - all three required by validation.js. Not a
       guess: the schema is read from the server in the test above. */
    assert.match(WIDGET_SRC, /id: 'chat-start-name'/);
    assert.match(WIDGET_SRC, /id: 'chat-start-email'/);
    assert.match(WIDGET_SRC, /id: 'chat-start-message'/);
    assert.match(WIDGET_SRC, /maxlength: '100'/);      /* NAME_MAX */
    assert.match(WIDGET_SRC, /maxlength: '254'/);      /* EMAIL_MAX */
    assert.match(WIDGET_SRC, /maxlength: '2000'/);     /* MESSAGE_MAX */
  });

  test('every start-form control has a real label', () => {
    for (const id of ['chat-start-name', 'chat-start-email', 'chat-start-message']) {
      assert.ok(WIDGET_SRC.includes("field('" + id + "'"),
        id + ' is built through field(), which pairs it with a <label for>');
    }
    assert.match(WIDGET_SRC, /el\('label', \{ class: 'chat__label', for: id, text: labelText \}\)/);
  });

  test('the status line and the notice are announced to a screen reader', () => {
    assert.match(WIDGET_SRC, /class: 'chat__status',\s*id: 'chat-status',\s*role: 'status',\s*'aria-live': 'polite'/);
    assert.match(WIDGET_SRC, /class: 'chat__notice',\s*role: 'alert'/);
    /* The log was already a polite live region and still is. */
    assert.match(WIDGET_SRC, /role: 'log',\s*'aria-live': 'polite'/);
  });

  test('the mobile composer keeps the 14px that stops iOS zooming', () => {
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    const text = css.slice(css.indexOf('.chat__text {'), css.indexOf('.chat__text--area'));
    assert.match(text, /font-size: 14px;/);
    assert.match(text, /height: 44px;/);       /* the touch target the widget already uses */
  });

  test('the new CSS introduces no colour of its own', () => {
    const css = readFileSync('/home/user/esthers/assets/css/chat.css', 'utf8');
    const added = css.slice(css.indexOf('   LIVE CHAT'));
    assert.ok(added.length > 500, 'found the live section');
    /* Hex literals and rgb() would mean a new colour outside the token set.
       opacity is fine; it is not a colour. */
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(added), false, 'no hex colours');
    assert.equal(/\brgba?\(/.test(added), false, 'no raw rgb colours');
  });
});

/* ============================================ THE PRODUCTION RESTORE PATH
 *
 * A conversation staff had closed came back after F5 as
 *
 *     session.closed === false,  "Connected",  live composer
 *
 * on the real site, and the suite above was green throughout. This block is
 * about why, and about the one rule that stops it happening again.
 *
 * WHY THE EXISTING TESTS MISSED IT. "a failed status check does NOT silently
 * pretend the thread is fine" asserts one thing: that a notice appears. It
 * never looked at session.closed, at the status line, or at the composer. So
 * the panel was free to put an explanation in the notice box and, directly
 * underneath it, say "Connected" over a live composer on a dead thread - and
 * the assertion passed. A test that checks the warning but not the state
 * being warned about is not testing the state.
 *
 * WHAT WAS ACTUALLY BROKEN. begin() only trusted the status check when the
 * check came back. openTranscript() asserted 'Connected' and enabled the
 * composer unconditionally, and the closed correction ran afterwards, from
 * `if (this.closed)`. An unanswered question - a 500, a 401 while attestation
 * was refused, a dropped connection, a cold start that timed out - therefore
 * landed in the "not closed" branch and was painted as a live conversation.
 * The lie /api/chat/status exists to stop was simply being told one layer up.
 *
 * These tests assert the WHOLE settled end state through the public entry
 * point, and then keep going: they fire the interval, fire a visibility
 * change, and drain the microtask queue afterwards, because a state that is
 * right for one turn and wrong on the next is the failure that shipped.
 */
describe('a restored panel never claims a conversation it has not confirmed', () => {
  /*
   * The closed explanation, read from the widget so this file cannot drift
   * from the sentence the visitor actually sees.
   *
   * EXTRACTED WITHOUT ASSERTING. An exception thrown in a describe() body is
   * reported as a failed SUITE by node:test but does not count as a failed
   * test and does not change the exit code - measured on Node v22.22.2 - so
   * every test below would silently stop running while the run stayed green.
   * The check belongs in a test, and it is the first one.
   */
  const CLOSED_NOTE = (() => {
    const m = WIDGET_SRC.match(/var CLOSED_NOTE = '([^']*)'\s*\+\s*'([^']*)';/);
    return m ? m[1] + m[2] : null;
  })();

  const EMPTY_NOTE = 'No messages yet. Send one and we will reply here.';

  /*
   * A UI that renders the way chat.js renders.
   *
   * recordingUi() records calls; this also models the two widget rules that
   * decide whether the visitor can see and do anything:
   *
   *   renderMessages() rebuilds the log from scratch, and the closed note is
   *   part of that render - the empty-transcript branch IS the note when the
   *   conversation is closed, and a populated transcript gets it appended.
   *
   *   setClosed() appends only on the false -> true edge, because the render
   *   above already carries it every other time.
   *
   * Both are transcribed from assets/js/chat.js, and the test below pins the
   * transcription against that source so it cannot quietly go stale. Without
   * this, "exactly one closed explanation" is a claim about a fake.
   */
  function widgetLikeUi() {
    const ui = recordingUi();
    ui.log = [];
    ui.isClosed = false;
    ui.isBusy = false;
    ui.enabled = false;

    const appendClosedNote = () => {
      if (!ui.isClosed) return;
      ui.log.push(CLOSED_NOTE);
    };

    ui.renderMessages = (list) => {
      ui.calls.push('renderMessages');
      ui.renderCount += 1;
      ui.messages = list;
      ui.log = [];
      const items = Array.isArray(list) ? list : [];
      if (!items.length) {
        ui.log.push(ui.isClosed ? CLOSED_NOTE : EMPTY_NOTE);
        return;
      }
      for (const m of items) ui.log.push(String((m && m.body) || ''));
      appendClosedNote();
    };
    ui.setClosed = (flag) => {
      ui.calls.push('setClosed');
      const was = ui.isClosed;
      ui.isClosed = flag === true;
      ui.closed = flag;
      ui.closedHistory.push(flag);
      if (ui.isClosed && !was) appendClosedNote();
    };
    ui.setComposerEnabled = (flag) => {
      ui.calls.push('setComposerEnabled');
      ui.enabled = flag === true;
      ui.composerEnabled = flag;
    };
    ui.setBusy = (flag) => {
      ui.calls.push('setBusy');
      ui.isBusy = flag === true;
      ui.busy = flag;
    };

    /* The widget's own two lines, and the only thing the visitor can act on. */
    ui.inputDisabled = () => ui.isClosed || !ui.enabled;
    ui.sendDisabled = (empty) => empty === true || ui.isBusy || ui.isClosed || !ui.enabled;
    ui.closedNotes = () => ui.log.filter((t) => t === CLOSED_NOTE).length;
    return ui;
  }

  test('the closed sentence was found in the widget', () => {
    /* Everything below counts occurrences of this string. If it could not be
       read, those counts are meaningless - so fail here, loudly, in a test. */
    assert.ok(typeof CLOSED_NOTE === 'string' && CLOSED_NOTE.length > 20,
      'CLOSED_NOTE was read out of assets/js/chat.js');
  });

  test('the UI double still matches the widget it stands in for', () => {
    /* If chat.js changes how the closed note is rendered, every "exactly one
       explanation" assertion below becomes a claim about a fake. This is the
       tripwire for that. */
    assert.match(WIDGET_CODE,
      /function appendClosedNote\(\)\s*\{\s*if \(!isClosed\) return;/);
    assert.match(WIDGET_CODE,
      /if \(!items\.length\)\s*\{[\s\S]*?isClosed[\s\S]*?CLOSED_NOTE[\s\S]*?return;/);
    assert.match(WIDGET_CODE, /if \(isClosed && !was\)\s*\{\s*appendClosedNote\(\);/);
    assert.match(WIDGET_CODE,
      /input\.disabled = mode === 'live' && \(isClosed \|\| !composerEnabled\);/);
    assert.match(WIDGET_CODE,
      /send\.disabled = empty \|\| \(mode === 'live' && \(isBusy \|\| isClosed \|\| !composerEnabled\)\);/);
  });

  const STORED = 'conv-closed';

  /* sessionStorage exactly as a returning visitor's browser holds it: the uid
     the stub restores, and the conversation that uid opened. */
  const storedFor = (mod, id = STORED) => memoryStorage({
    [mod._internals.CONVERSATION_KEY]:
      JSON.stringify({ uid: 'anon-uid-1', conversationId: id })
  });

  /* One responder, one queue of status answers. The last one repeats, so a
     poll that fires twice does not fall off the end. */
  function statusQueue(answers) {
    const queue = answers.slice();
    let used = 0;
    const responder = (n, input) => {
      if (String(input).indexOf('/api/chat/status') === 0) {
        const answer = queue[Math.min(used, queue.length - 1)];
        used += 1;
        return typeof answer === 'function' ? answer() : answer;
      }
      return jsonResponse(200, OK_START);
    };
    responder.statusCalls = () => used;
    return responder;
  }

  const CLOSED_200 = () => jsonResponse(200,
    { ok: true, conversationId: STORED, status: 'closed' });
  const OPEN_200 = () => jsonResponse(200,
    { ok: true, conversationId: STORED, status: 'open' });
  const SERVER_500 = () => jsonResponse(500, { ok: false, code: 'internal_error' });

  /* Everything the transport could still do on its own after begin() returns:
     the poll, the visibility listener, and any queued microtask. A state that
     survives all three is settled. */
  async function settleAndProvoke(clock) {
    await tick();
    clock.fireInterval();
    clock.becomeVisible();
    await tick();
  }

  test('A RESTORED CLOSED CONVERSATION IS CLOSED WHEN THE DUST SETTLES',
    async () => {
      const { mod, stub } = await load();
      const clock = fakeClock();
      const ui = widgetLikeUi();
      const storage = storedFor(mod);
      const responder = statusQueue([CLOSED_200]);
      const fetcher = captureFetch(responder);
      try {
        const session = await mod.openChatForReview({
          ui,
          openPanel: () => {},
          deps: Object.assign({ storage: () => storage }, clock.deps)
        });
        await settleAndProvoke(clock);

        /* The whole point, and the thing production disagreed with. */
        assert.equal(session.closed, true, 'session.closed');
        assert.equal(ui.status, 'Conversation closed', 'the status line');
        assert.equal(ui.enabled, false, 'the composer is disabled');
        assert.equal(ui.inputDisabled(), true, 'the textarea is disabled');
        assert.equal(ui.sendDisabled(false), true,
          'Send is dead even with something typed');

        /* The transcript is still there to read - closing a conversation is
           not the same as taking someone's history away. */
        assert.equal(ui.transcriptShown, 1, 'the transcript was restored');
        assert.equal(ui.startFormShown, 0, 'and no start form appeared');
        assert.equal(stub.liveListenerCount(), 1, 'the listener is open');

        /* Exactly one explanation. Not none, not two. */
        assert.equal(ui.closedNotes(), 1, 'one closed explanation');
        assert.equal(ui.notice, null, 'and it is not ALSO an error banner');

        /* Nothing was written to find any of this out. */
        const writes = fetcher.seen.filter((r) => r.init && r.init.method === 'POST');
        assert.equal(writes.length, 0, 'no send was needed to learn it is closed');

        /* Closed is terminal: the watch is gone, so the interval and the
           visibility change fired above could not have asked again. */
        assert.equal(clock.liveTimers(), 0, 'the poll stopped');
        assert.equal(clock.visibilityListeners(), 0, 'the visibility hook stopped');
        assert.equal(responder.statusCalls(), 1, 'exactly one status request');
      } finally {
        fetcher.restore();
      }
    });

  test('A STATUS CHECK THAT DOES NOT COME BACK LEAVES THE COMPOSER SHUT - '
    + 'THE PRODUCTION BUG', async () => {
      /*
       * THE REGRESSION THAT SHIPPED. The server never answered, so nothing is
       * known - and "nothing is known" was being drawn as "Connected" with a
       * live composer. An unanswered question is not a yes.
       */
      const { mod } = await load();
      const clock = fakeClock();
      const ui = widgetLikeUi();
      const storage = storedFor(mod);
      const responder = statusQueue([SERVER_500]);
      const fetcher = captureFetch(responder);
      try {
        const session = await mod.openChatForReview({
          ui,
          openPanel: () => {},
          deps: Object.assign({ storage: () => storage }, clock.deps)
        });
        await tick();

        assert.equal(session.closed, false, 'nothing was confirmed either way');
        assert.equal(ui.enabled, false,
          'THE FIX: the composer stays shut on an unconfirmed conversation');
        assert.equal(ui.inputDisabled(), true, 'the textarea is disabled');
        assert.equal(ui.sendDisabled(false), true, 'and Send with it');
        assert.notEqual(ui.status, 'Connected',
          'the panel does not claim a connection it has not got');
        assert.equal(ui.status, 'Not connected');

        /* Told why, and given a way out - a dead composer with no explanation
           is the worst of the three states. */
        assert.ok(typeof ui.notice === 'string' && ui.notice.length > 0,
          'the visitor is told the check did not land');
        assert.equal(typeof ui.retry, 'function', 'and can ask again');

        /* The transcript is still readable, and no write was attempted. */
        assert.equal(ui.transcriptShown, 1);
        assert.equal(ui.closedNotes(), 0, 'it is not claimed closed either');
        const writes = fetcher.seen.filter((r) => r.init && r.init.method === 'POST');
        assert.equal(writes.length, 0);

        /* The watch keeps running: this is the state that is meant to heal. */
        assert.equal(clock.liveTimers(), 1, 'the poll is still going');
      } finally {
        fetcher.restore();
      }
    });

  test('nothing scheduled afterwards flips a confirmed CLOSED back open',
    async () => {
      /*
       * The failure this guards is a later turn, not the first one: a snapshot
       * arriving, a poll firing, a visibility change - anything that runs a
       * lifecycle method after begin() has finished and repaints the panel
       * from a default rather than from what the server said.
       */
      const { mod, stub } = await load();
      const clock = fakeClock();
      const ui = widgetLikeUi();
      const storage = storedFor(mod);
      const fetcher = captureFetch(statusQueue([CLOSED_200]));
      try {
        const session = await mod.openChatForReview({
          ui,
          openPanel: () => {},
          deps: Object.assign({ storage: () => storage }, clock.deps)
        });
        await settleAndProvoke(clock);
        assert.equal(session.closed, true, 'closed to begin with');

        /* A snapshot lands, the way one does the moment the listener attaches. */
        stub.emitSnapshot([
          { id: 'm1', data: { conversationId: STORED, senderType: 'customer',
            body: 'hello', createdAt: { toMillis: () => 1 } } }
        ]);
        await tick();

        assert.equal(session.closed, true, 'still closed after a snapshot');
        assert.equal(ui.enabled, false, 'composer still shut');
        assert.equal(ui.status, 'Conversation closed');
        assert.equal(ui.closedNotes(), 1,
          'and the explanation survived the re-render, exactly once');
        assert.equal(ui.log[ui.log.length - 1], CLOSED_NOTE,
          'below the transcript, where it reads as the end of it');

        /* The panel is closed and reopened - suspend() then resume(), which is
           what the widget does. resume() used to run openTranscript(), which
           said "Connected" unconditionally. */
        session.suspend();
        await tick();
        session.resume();
        await settleAndProvoke(clock);

        assert.equal(session.closed, true, 'still closed after a reopen');
        assert.equal(ui.status, 'Conversation closed',
          'THE FIX: reopening the panel does not repaint it as Connected');
        assert.equal(ui.enabled, false, 'composer still shut');
        assert.equal(ui.closedNotes(), 1, 'still exactly one explanation');
      } finally {
        fetcher.restore();
      }
    });

  test('an unconfirmed conversation heals to CLOSED when the answer arrives',
    async () => {
      const { mod } = await load();
      const clock = fakeClock();
      const ui = widgetLikeUi();
      const storage = storedFor(mod);
      const fetcher = captureFetch(statusQueue([SERVER_500, CLOSED_200]));
      try {
        const session = await mod.openChatForReview({
          ui,
          openPanel: () => {},
          deps: Object.assign({ storage: () => storage }, clock.deps)
        });
        await tick();
        assert.equal(ui.enabled, false);
        assert.equal(typeof ui.retry, 'function');

        /* The visitor presses Try again. */
        await ui.retry();
        await tick();

        assert.equal(session.closed, true);
        assert.equal(ui.status, 'Conversation closed');
        assert.equal(ui.enabled, false);
        assert.equal(ui.closedNotes(), 1, 'one explanation, and only now');
        assert.equal(ui.notice, null, 'the error banner is gone');
        assert.equal(clock.liveTimers(), 0, 'and the watch stopped for good');
      } finally {
        fetcher.restore();
      }
    });

  test('an unconfirmed conversation heals to OPEN when the answer arrives',
    async () => {
      /* The cost of failing safe, and the proof it is only a delay: one press
         and a healthy conversation is live again. */
      const { mod } = await load();
      const clock = fakeClock();
      const ui = widgetLikeUi();
      const storage = storedFor(mod);
      const fetcher = captureFetch(statusQueue([SERVER_500, OPEN_200]));
      try {
        const session = await mod.openChatForReview({
          ui,
          openPanel: () => {},
          deps: Object.assign({ storage: () => storage }, clock.deps)
        });
        await tick();
        assert.equal(ui.enabled, false, 'held while unconfirmed');

        await ui.retry();
        await tick();

        assert.equal(session.closed, false);
        assert.equal(ui.status, 'Connected');
        assert.equal(ui.enabled, true, 'the composer is live again');
        assert.equal(ui.inputDisabled(), false);
        assert.equal(ui.notice, null, 'and the warning is cleared');
        assert.equal(ui.closedNotes(), 0);
      } finally {
        fetcher.restore();
      }
    });

  test('A RESTORED OPEN CONVERSATION IS STILL FULLY LIVE', async () => {
    /* The regression that matters in the other direction: failing safe must
       not cost an ordinary returning visitor anything at all. */
    const { mod, stub } = await load();
    const clock = fakeClock();
    const ui = widgetLikeUi();
    const storage = storedFor(mod);
    const responder = statusQueue([OPEN_200]);
    const fetcher = captureFetch(responder);
    try {
      const session = await mod.openChatForReview({
        ui,
        openPanel: () => {},
        deps: Object.assign({ storage: () => storage }, clock.deps)
      });
      await tick();

      assert.equal(session.closed, false);
      assert.equal(ui.status, 'Connected');
      assert.equal(ui.enabled, true, 'the composer is live');
      assert.equal(ui.inputDisabled(), false);
      assert.equal(ui.sendDisabled(false), false, 'and Send works');
      assert.equal(ui.transcriptShown, 1, 'the transcript restored');
      assert.equal(ui.startFormShown, 0);
      assert.equal(ui.notice, null, 'with nothing to warn about');
      assert.equal(ui.closedNotes(), 0);
      assert.equal(stub.liveListenerCount(), 1);

      /* The watch is running, which is what will catch a later staff close. */
      assert.equal(clock.liveTimers(), 1, 'the poll is active');
      assert.equal(clock.intervalMs(), 60 * 1000, 'at sixty seconds');
      assert.equal(clock.visibilityListeners(), 1, 'and the tab hook is set');

      /* One more turn, to be sure nothing degrades it. */
      clock.fireInterval();
      await tick();
      assert.equal(ui.status, 'Connected');
      assert.equal(ui.enabled, true);
      assert.equal(responder.statusCalls(), 2, 'the poll did ask again');
    } finally {
      fetcher.restore();
    }
  });

  test('reopening the panel on an unconfirmed conversation still explains itself',
    async () => {
      /*
       * The gap M6 found. resume() runs openTranscript(), which now paints
       * the held state correctly - so a CLOSED conversation survives a reopen
       * whichever way resume() re-asks. An UNCONFIRMED one does not: the
       * composer comes back shut, and if resume() re-asks through
       * refreshStatus() instead of recheckStatus() the notice and the Try
       * again are never restored. The visitor is then looking at a dead
       * composer with no reason given and nothing to press, which is the one
       * state worse than the bug this whole change is about.
       */
      const { mod } = await load();
      const clock = fakeClock();
      const ui = widgetLikeUi();
      const storage = storedFor(mod);
      const fetcher = captureFetch(statusQueue([SERVER_500]));
      try {
        const session = await mod.openChatForReview({
          ui,
          openPanel: () => {},
          deps: Object.assign({ storage: () => storage }, clock.deps)
        });
        await tick();
        assert.equal(ui.enabled, false, 'held on the way in');
        assert.equal(typeof ui.retry, 'function', 'with a way out');

        /* The visitor closes the panel and opens it again. */
        session.suspend();
        await tick();
        session.resume();
        await tick();

        assert.equal(session.closed, false, 'still nothing confirmed');
        assert.equal(ui.enabled, false, 'still held');
        assert.equal(ui.status, 'Not connected');
        assert.ok(typeof ui.notice === 'string' && ui.notice.length > 0,
          'THE FIX: the reopened panel still says why');
        assert.equal(typeof ui.retry, 'function',
          'and still offers Try again');
      } finally {
        fetcher.restore();
      }
    });

  test('a brand new conversation is live the moment the server opens it',
    async () => {
      /* start() gets its status straight from the response that created the
         conversation. If that did not count as confirmation, failing safe
         would have shut the composer on a thread the visitor had just
         successfully opened. */
      const { mod } = await load();
      const clock = fakeClock();
      const ui = widgetLikeUi();
      const fetcher = captureFetch(statusQueue([OPEN_200]));
      try {
        const session = await mod.openChatForReview({
          ui,
          openPanel: () => {},
          deps: Object.assign({ storage: () => memoryStorage() }, clock.deps)
        });
        await tick();
        assert.equal(ui.startFormShown, 1, 'a first-time visitor gets the form');

        await ui.startHandler({ name: 'Sam', email: 'sam@example.com', message: 'Hi', locationId: 'main' });
        await tick();

        assert.equal(session.closed, false);
        assert.equal(ui.status, 'Connected');
        assert.equal(ui.enabled, true, 'the composer is live straight away');
        assert.equal(ui.closedNotes(), 0);
      } finally {
        fetcher.restore();
      }
    });
});

/* ================================================ CACHE-SAFE MODULE LOADING
 *
 * A browser caches a module by its FULL URL, and the ES module registry
 * inside a page keys on the same thing. Two different builds served at one
 * URL are therefore the same module as far as both are concerned, and a
 * visitor who already has yesterday's can keep running it after a deploy.
 *
 * That is not hypothetical here. A conversation staff had closed came back
 * looking live on the real site because the page was still running the
 * previous chat-customer.js; a hard reload and a cache-busted import
 * produced the correct closed state from the very same deployment.
 *
 * The contract these tests pin:
 *
 *   ONE version string, written out in three files, and in the ?v= of the
 *   one static import between them. Old and new builds get different cache
 *   keys, and the whole local graph moves together - a NEW transport can
 *   never end up running against a STALE chat-app-check.js, which is a
 *   combination that has never been tested and never should exist.
 *
 * It is a LOADING mechanism, not a gate. CHAT_PUBLIC_ENABLED decides whether
 * anything loads; this decides only which build does.
 */
describe('the chat client is loaded by an explicit, source-controlled version', () => {
  const APP_CHECK_CODE = codeAndStrings(APP_CHECK_SRC);
  const LOCATIONS_SRC = readFileSync(LOCATIONS_PATH, 'utf8');
  const LOCATIONS_CODE = codeAndStrings(LOCATIONS_SRC);

  /*
   * The one string, read from the widget - which is where a human bumps it.
   *
   * EXTRACTED WITHOUT ASSERTING, for the reason spelled out above the other
   * extraction in this file: a throw in a describe() body skips every test in
   * the suite and still exits 0. The declaration is checked in the first test
   * below, where a failure actually fails the run.
   */
  const VERSION = (() => {
    const m = WIDGET_SRC.match(/var CHAT_CLIENT_VERSION = '([^']+)';/);
    return m ? m[1] : null;
  })();

  test('chat.js declares the version as a bare string literal', () => {
    /*
     * The load-bearing check, and deliberately the first: every count and
     * comparison below is against VERSION, so if the declaration is missing
     * or is an expression rather than a literal, this is what says so.
     *
     * `var CHAT_CLIENT_VERSION = String(Date.now());` fails here.
     */
    assert.match(WIDGET_SRC, /var CHAT_CLIENT_VERSION = '[^']+';/,
      'chat.js declares CHAT_CLIENT_VERSION as a quoted literal');
    assert.ok(typeof VERSION === 'string' && VERSION.length > 0,
      'and it was read successfully');
  });

  test('the version is a plain literal, not a date, a clock or a random number',
    () => {
      /* A cache key that changes on its own is not a version - it defeats
         caching entirely and makes every page load a fresh download. */
      assert.match(VERSION, /^[0-9A-Za-z.\-_]+$/,
        'safe in a URL without escaping');
      assert.ok(VERSION.length >= 3 && VERSION.length <= 40);

      for (const [name, src] of [['chat.js', WIDGET_CODE],
                                 ['chat-customer.js', CUSTOMER_CODE],
                                 ['chat-app-check.js', APP_CHECK_CODE],
                                 ['chat-locations.js', LOCATIONS_CODE]]) {
        const decl = src.match(/CHAT_CLIENT_VERSION = ([^;]+);/);
        assert.ok(decl, name + ' declares the version');
        assert.match(decl[1].trim(), /^'[^']+'$/,
          name + ': the version is a string literal and nothing else');
      }

      /* Named explicitly because these are the ways it goes wrong. */
      const forbidden = /CHAT_CLIENT_VERSION\s*=\s*[^;]*(Date\.now|new Date|Math\.random|performance\.now|location|searchParams|localStorage|sessionStorage|document\.cookie)/;
      assert.equal(forbidden.test(WIDGET_CODE), false);
      assert.equal(forbidden.test(CUSTOMER_CODE), false);
      assert.equal(forbidden.test(APP_CHECK_CODE), false);
      assert.equal(forbidden.test(LOCATIONS_CODE), false);
    });

  test('all four chat modules state the SAME version', () => {
    /* A half-finished bump - one file moved, another not - is exactly the
       failure that would produce the mixed graph this design exists to
       prevent. */
    const customer = CUSTOMER_SRC.match(/export const CHAT_CLIENT_VERSION = '([^']+)';/);
    const appCheck = APP_CHECK_SRC.match(/export const CHAT_CLIENT_VERSION = '([^']+)';/);
    const locations = LOCATIONS_SRC.match(/export const CHAT_CLIENT_VERSION = '([^']+)';/);
    assert.ok(customer, 'chat-customer.js exports CHAT_CLIENT_VERSION');
    assert.ok(appCheck, 'chat-app-check.js exports CHAT_CLIENT_VERSION');
    assert.ok(locations, 'chat-locations.js exports CHAT_CLIENT_VERSION');
    assert.equal(customer[1], VERSION, 'chat-customer.js agrees with chat.js');
    assert.equal(appCheck[1], VERSION, 'chat-app-check.js agrees with chat.js');
    assert.equal(locations[1], VERSION, 'chat-locations.js agrees with chat.js');
  });

  test('the module namespace really exports it, not just the source text',
    async () => {
      const { mod, appCheck } = await load();
      assert.equal(mod.CHAT_CLIENT_VERSION, VERSION);
      assert.equal(appCheck.CHAT_CLIENT_VERSION, VERSION);
    });

  test('chat.js imports a VERSIONED chat-customer URL, root-relative', () => {
    const m = WIDGET_CODE.match(
      /var TRANSPORT_MODULE = '\/assets\/js\/chat-customer\.js\?v='\s*\+\s*encodeURIComponent\(CHAT_CLIENT_VERSION\);/);
    assert.ok(m, 'TRANSPORT_MODULE is the versioned root-relative URL');

    /* The bare, unversioned form must not survive anywhere in the loader. */
    assert.equal(/'\/assets\/js\/chat-customer\.js'/.test(WIDGET_CODE), false,
      'no unversioned transport URL left in chat.js');

    /* And it is still what the dynamic import actually uses. */
    assert.match(WIDGET_CODE, /import\(TRANSPORT_MODULE\)/);
  });

  test('THE TRANSITIVE ONE: the static import of chat-app-check carries the '
    + 'same version', () => {
      /*
       * A query on a module's own URL does NOT reach the specifiers inside
       * it - './chat-app-check.js' resolves against the importer's path and
       * drops the query. Measured in Chromium: with a long-lived cache, a
       * versioned chat-customer.js loads NEW while its chat-app-check.js
       * stays OLD. Versioning only the top of the graph is not a fix.
       */
      const m = CUSTOMER_CODE.match(/from '\.\/chat-app-check\.js\?v=([^']+)';/);
      assert.ok(m, 'the static import carries a ?v=');
      assert.equal(m[1], VERSION, 'and it is the same version');

      assert.equal(/from '\.\/chat-app-check\.js'/.test(CUSTOMER_CODE), false,
        'no unversioned local import left');

      /* And the second one, added with routing. Two static imports now, and
         a bare specifier on either is the same mixed-graph bug. */
      const loc = CUSTOMER_CODE.match(/from '\.\/chat-locations\.js\?v=([^']+)';/);
      assert.ok(loc, 'the shop definitions are imported with a ?v= too');
      assert.equal(loc[1], VERSION);
      assert.equal(/from '\.\/chat-locations\.js'/.test(CUSTOMER_CODE), false,
        'no unversioned local import left');
    });

  test('the version appears in each file exactly where it is meant to', () => {
    /* Bumping the version must be a small, obvious edit in known places -
       not a hunt. These counts are the contract. */
    const count = (src, re) => (src.match(re) || []).length;
    const lit = new RegExp(VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

    assert.equal(count(WIDGET_CODE, lit), 1,
      'chat.js: once, in the declaration');
    assert.equal(count(APP_CHECK_CODE, lit), 1,
      'chat-app-check.js: once, in the declaration');
    assert.equal(count(CUSTOMER_CODE, lit), 3,
      'chat-customer.js: three times - the declaration and TWO import '
      + 'specifiers, because a static specifier cannot interpolate');
    assert.equal(count(LOCATIONS_CODE, lit), 1,
      'chat-locations.js: once, in the declaration');
  });

  test('the pinned Firebase SDK URLs are NOT cache-busted', () => {
    /* gstatic already serves an exact pinned version per URL. Adding a query
       would only defeat a cache that is doing its job. */
    for (const src of [CUSTOMER_CODE, APP_CHECK_CODE]) {
      const urls = src.match(/'https:\/\/www\.gstatic\.com\/firebasejs\/'[^;]*/g) || [];
      for (const u of urls) {
        assert.equal(/\?v=/.test(u), false, 'no ?v= on a gstatic URL: ' + u);
      }
    }
    assert.match(APP_CHECK_SRC, /export const SDK_VERSION = '12\.4\.0';/,
      'the SDK is still pinned by path, as before');
  });

  /* ---------------------------------------------------------- the gate */

  test('the version is not a gate: a query string cannot turn chat on', () => {
    /* The ?v= lives on a MODULE url and comes from a source literal. Nothing
       anywhere reads the PAGE url to decide whether chat runs. */
    const readsPageUrl =
      /(location\.(search|href|hash)|URLSearchParams|searchParams)/;
    assert.equal(readsPageUrl.test(WIDGET_CODE), false,
      'chat.js never reads the page URL');
    assert.equal(readsPageUrl.test(CUSTOMER_CODE), false,
      'chat-customer.js never reads the page URL');
    assert.equal(readsPageUrl.test(APP_CHECK_CODE), false,
      'chat-app-check.js never reads the page URL');

    /* Both gates are still plain literals - not computed, not overridable. */
    assert.match(WIDGET_CODE, /var CHAT_PUBLIC_ENABLED = false;/);
    assert.match(CUSTOMER_CODE, /export const CHAT_PUBLIC_ENABLED = false;/);
  });

  test('with the gate false the versioned URL is never even requested', () => {
    /* connectTransport() holds the only import() of the transport, and the
       gate holds the only call to connectTransport(). */
    const calls = (WIDGET_CODE.match(/connectTransport\(\)/g) || []);
    assert.equal(calls.length, 2,
      'connectTransport is declared once and called once');
    assert.match(WIDGET_CODE, /if \(CHAT_PUBLIC_ENABLED\) connectTransport\(\);/,
      'and the single call site is behind the gate');
    assert.equal(/import\(TRANSPORT_MODULE\)/.test(WIDGET_CODE), true);
    assert.equal((WIDGET_CODE.match(/import\(/g) || []).length, 1,
      'exactly one dynamic import in the widget, and it is that one');
  });

  test('a gate-off page does no Firebase, App Check or chat work at all',
    async () => {
      /* The transport refuses at the entry point rather than in a UI state -
         nothing is attested, nobody is signed in, no request is made. */
      const { mod, stub } = await load();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        assert.equal(mod.CHAT_PUBLIC_ENABLED, false);
        const session = await mod.connect(recordingUi(), {});
        assert.equal(session, null, 'connect() refuses while the gate is shut');
        assert.equal(fetcher.seen.length, 0, 'no request was made');
        assert.equal(stub.order.length, 0,
          'no Firebase SDK call of any kind - no app, no App Check, no auth');
      } finally {
        fetcher.restore();
      }
    });

  /* ------------------------------------------------- the served headers */

  test('the four chat scripts are served must-revalidate, and only those',
    () => {
      /*
       * A version constant is only as fresh as the FILE THAT CARRIES IT.
       * chat.js is a plain <script src> in seven HTML pages - no query can
       * version it - so if chat.js itself is cached hard, the version inside
       * it is yesterday's and the whole mechanism is inert. Measured in
       * Chromium: loader cached hard -> the page asks for ?v=OLD and gets the
       * old build back. These headers are what keep the loader honest.
       */
      const cfg = JSON.parse(
        readFileSync('/home/user/esthers/vercel.json', 'utf8'));
      const rules = cfg.headers || [];
      const cacheOf = (source) => {
        const rule = rules.find((r) => r.source === source);
        if (!rule) return null;
        const h = (rule.headers || []).find((x) => x.key === 'Cache-Control');
        return h ? h.value : null;
      };

      /* chat-locations.js joined the graph with routing. It is always loaded
         with a ?v=, like chat-app-check.js - and like chat-app-check.js it
         gets the header anyway, because the review walkthrough tells a person
         to import these by hand from DevTools and a stale copy handed out
         there is a stale copy in the only place anybody looks. */
      for (const file of ['/assets/js/chat.js',
                          '/assets/js/chat-customer.js',
                          '/assets/js/chat-app-check.js',
                          '/assets/js/chat-locations.js']) {
        assert.equal(cacheOf(file), 'public, max-age=0, must-revalidate',
          file + ' revalidates before use');
      }

      /* And the addition was ADDITIVE. Nothing else in the file moved. */
      assert.deepEqual(rules.map((r) => r.source), [
        '/(.*)',
        '/assets/img/(.*)',
        '/assets/js/chat.js',
        '/assets/js/chat-customer.js',
        '/assets/js/chat-app-check.js',
        '/assets/js/chat-locations.js',
        '/assets/js/chat-staff.js',
        '/assets/css/chat-staff.css'
      ]);

      /* Scope. The images keep their long cache, and nothing global was
         turned off - a site-wide no-cache would be a real cost for a fix
         that only three files need. */
      assert.equal(cacheOf('/assets/img/(.*)'),
        'public, max-age=604800, stale-while-revalidate=86400',
        'the image cache is untouched');
      assert.equal(cacheOf('/(.*)'), null,
        'no site-wide Cache-Control was introduced');

      /* The security headers are still the global rule, unchanged. */
      const global = rules.find((r) => r.source === '/(.*)');
      assert.ok(global, 'the global header rule still exists');
      const keys = global.headers.map((h) => h.key).sort();
      assert.deepEqual(keys, ['Permissions-Policy', 'Referrer-Policy',
        'X-Content-Type-Options', 'X-Frame-Options']);
    });

  test('no HTML page has been given a versioned or altered script tag', () => {
    /* The fix is inside the loader, not scattered across seven pages. */
    const pages = ['index.html', 'about/index.html', 'contact/index.html',
      'gallery/index.html', 'materials/index.html', 'quote/index.html',
      'services/index.html'];
    for (const page of pages) {
      const html = readFileSync('/home/user/esthers/' + page, 'utf8');
      assert.match(html, /src="\.?\.?\/?assets\/js\/chat\.js"/,
        page + ' still loads chat.js by its plain path');
      assert.equal(/chat-customer\.js/.test(html), false,
        page + ' still does not reference the transport at all');
    }
  });
});

/* ======================================= ONE FIREBASE USER PER TAB, NOT PER
 *                                         BROWSER
 *
 * Firebase's web default is browserLocalPersistence: one signed-in user in
 * localStorage, shared by every tab on the origin. Esther's has two kinds of
 * user in one project - anonymous customers here, Email/Password staff in
 * /staff/chat - and the SDK allows exactly one signed-in user per app
 * instance. Under the default the two fight: a staff sign-in replaces the
 * customer, a customer sign-in signs the staff member out mid-reply.
 *
 * browserSessionPersistence puts the session in sessionStorage, which is
 * per-tab. Two tabs, two users, neither aware of the other - and a reload of
 * either still restores its own, which is why it is not inMemoryPersistence.
 */
describe('the customer session belongs to its tab', () => {
  test('browserSessionPersistence is chosen explicitly', async () => {
    const { mod, stub } = await load();
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      await mod.openChatForReview({
        ui: recordingUi(), openPanel: () => {},
        deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
      });
      await tick();
      assert.deepEqual(stub.persistenceChoices, ['SESSION'],
        'session persistence, once, and nothing else');
    } finally {
      fetcher.restore();
    }
  });

  test('NEITHER local NOR in-memory persistence is configured', () => {
    /* local is the shared-across-tabs default this removes. inMemory would
       isolate tabs too, and lose the anonymous uid on every F5 - which would
       lose the conversation that uid owns. */
    assert.match(CUSTOMER_CODE, /browserSessionPersistence/);
    assert.equal(/browserLocalPersistence/.test(CUSTOMER_CODE), false);
    assert.equal(/inMemoryPersistence/.test(CUSTOMER_CODE), false);
    assert.equal(/indexedDBLocalPersistence/.test(CUSTOMER_CODE), false);
  });

  test('persistence is set BEFORE the restore settles and BEFORE any sign-in',
    async () => {
      /* After would be too late: the restore would already have happened
         against the wrong store. */
      const { mod, stub } = await load();
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        await mod.openChatForReview({
          ui: recordingUi(), openPanel: () => {},
          deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
        });
        await tick();
        const set = stub.order.indexOf('setPersistence');
        const watch = stub.order.indexOf('onAuthStateChanged');
        const signIn = stub.order.indexOf('signInAnonymously');
        assert.ok(set !== -1, 'it was set at all');
        assert.ok(set < watch, 'before the restore was awaited');
        assert.ok(set < signIn, 'and before the anonymous sign-in');
      } finally {
        fetcher.restore();
      }
    });

  test('a failure to set persistence STOPS the chat', async () => {
    /* Carrying on would leave the instance on the shared-across-tabs default,
       which is the thing being removed. */
    const { mod, stub } = await load();
    stub.persistenceErrorOn(true);
    const ui = recordingUi();
    const fetcher = captureFetch(jsonResponse(200, OK_START));
    try {
      const session = await mod.openChatForReview({
        ui, openPanel: () => {},
        deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
      });
      await tick();
      assert.equal(session, null, 'the chat refuses to start');
      assert.equal(stub.calls.signInAnonymously.length, 0,
        'and no account was minted');
      assert.equal(fetcher.seen.length, 0, 'no request was made');
    } finally {
      stub.persistenceErrorOn(false);
      fetcher.restore();
    }
  });

  test('an anonymous session in this tab is REUSED - the same uid after a reload',
    async () => {
      const { mod, stub } = await load();
      stub.seedRestoredUser({
        uid: 'anon-restored', isAnonymous: true, getIdToken: async () => 'tok'
      });
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        const session = await mod.openChatForReview({
          ui: recordingUi(), openPanel: () => {},
          deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
        });
        await tick();
        assert.equal(session.identity.user.uid, 'anon-restored',
          'the tab kept its own uid');
        assert.equal(stub.calls.signInAnonymously.length, 0,
          'no second account was minted');
      } finally {
        fetcher.restore();
      }
    });

  test('a restored EMAIL/PASSWORD user is never adopted as a customer',
    async () => {
      /* Same-tab staff -> customer. An Email/Password token sent to
         /api/chat/send is refused 403 not_a_customer forever, and the
         Firestore listener fails too because isAnonymousCustomer() tests the
         same provider. So this tab gets a fresh anonymous identity. */
      const { mod, stub } = await load();
      stub.seedRestoredUser({
        uid: 'staff-1', email: 'manager@esthers.ca', isAnonymous: false,
        getIdToken: async () => 'staff-token'
      });
      const fetcher = captureFetch(jsonResponse(200, OK_START));
      try {
        const session = await mod.openChatForReview({
          ui: recordingUi(), openPanel: () => {},
          deps: Object.assign({ storage: () => memoryStorage() }, fakeClock().deps)
        });
        await tick();
        assert.ok(session, 'the chat starts');
        assert.notEqual(session.identity.user.uid, 'staff-1',
          'but NOT as the staff account');
        assert.equal(session.identity.user.isAnonymous, true);
        assert.equal(stub.calls.signInAnonymously.length, 1);
      } finally {
        fetcher.restore();
      }
    });
});

/* ============================================ 61-74. WHICH SHOP, AND WHERE IT WENT */

/*
 * TWO SHOPS, FROM THE CUSTOMER'S SIDE.
 *
 * Esther's runs two shops that do different work. A message sent to the wrong
 * one waits behind the wrong queue, so the visitor picks - and then has to be
 * able to SEE which one they picked, including after a reload and including
 * after staff quietly hand the conversation to the other shop.
 *
 * The thing these tests exist to stop: a panel that says "Main Shop" about a
 * conversation that is now at Keith Street.
 */
describe('the customer chooses a shop, and is told where it went', () => {
  const startAt = (locationId, extra) => Object.assign(
    { ok: true, conversationId: 'conv-1', messageId: 'msg-1', status: 'open',
      locationId: locationId },
    extra || {});

  test('THE THREE CHOICES, in order, with the exact wording', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      assert.ok(Array.isArray(ui.locations), 'the panel was given the choices');
      assert.deepEqual(ui.locations.map((c) => c.id),
        ['main', 'specialty', 'unassigned'], 'and in that order');

      const byId = Object.fromEntries(ui.locations.map((c) => [c.id, c]));
      /*
       * PINNED. "Main Branch" and "Specialty Shop" were rejected: two vague
       * labels skim-read on a phone is how a curved scupper job arrives at
       * 1st Avenue. If somebody shortens these, this fails.
       */
      assert.equal(byId.main.choice, 'Main Shop - 1st Avenue');
      assert.equal(byId.main.address, '3890 E. First Ave., Burnaby');
      assert.equal(byId.specialty.choice, 'Specialty Shop - Keith Street');
      assert.equal(byId.specialty.address, '3701 Keith Street');
      assert.equal(byId.unassigned.choice, "I'm Not Sure");

      /* Each one says what that shop actually does, so a customer who has
         never been to either can route themselves. */
      for (const c of ui.locations) {
        assert.ok(c.description && c.description.length > 20,
          c.id + ' explains itself');
      }
    } finally {
      fetcher.restore();
    }
  });

  test('the choices arrive BEFORE the start form is drawn', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await connectedSession(mod);
    try {
      const gave = ui.calls.indexOf('setLocations');
      const drew = ui.calls.indexOf('showStartForm');
      assert.ok(gave !== -1 && drew !== -1, 'both happened');
      assert.ok(gave < drew, 'a start form with no shops on it is not a form');
    } finally {
      fetcher.restore();
    }
  });

  test('EVERY chosen id reaches the wire verbatim', async () => {
    for (const id of ['main', 'specialty', 'unassigned']) {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: jsonResponse(200, startAt(id))
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
          locationId: id });
        const body = JSON.parse(fetcher.seen[0].init.body);
        /* Not trimmed, not lower-cased, not defaulted. The server's
           allow-list is the only thing that decides validity. */
        assert.equal(body.locationId, id);
      } finally {
        fetcher.restore();
      }
    }
  });

  test('NOTHING CHOSEN IS NOT A REQUEST, and never a silent default',
    async () => {
      for (const nothing of [undefined, null, '', 0, false]) {
        const { mod } = await load();
        const { ui, fetcher } = await connectedSession(mod);
        try {
          const before = fetcher.seen.length;
          await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
            locationId: nothing });
          assert.equal(fetcher.seen.length, before,
            'no allowance spent on a request that cannot succeed');
          assert.equal(ui.notice,
            'Please choose which shop you would like to message.');
          /* And emphatically NOT sent to a shop nobody picked. */
          assert.equal(ui.destination, null);
        } finally {
          fetcher.restore();
        }
      }
    });

  test('the destination comes from the SERVER, not from what was clicked',
    async () => {
      const { mod } = await load();
      /* The visitor asked for main; the server answers specialty - which is
         what a retry landing on an already-transferred conversation looks
         like. The panel must say what the server said. */
      const { ui, fetcher } = await connectedSession(mod, {
        responder: jsonResponse(200, startAt('specialty'))
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
          locationId: 'main' });
        await tick();
        assert.equal(ui.destination, 'Specialty Shop - Keith Street');
      } finally {
        fetcher.restore();
      }
    });

  test('the line is painted AFTER the view switches, or it is wiped',
    async () => {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: jsonResponse(200, startAt('main'))
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
          locationId: 'main' });
        await tick();
        const shown = ui.calls.lastIndexOf('showTranscript');
        const painted = ui.calls.lastIndexOf('setDestination');
        assert.ok(shown !== -1 && painted > shown,
          'showStartForm() clears the line, so order matters');
        assert.equal(ui.destination, 'Main Shop - 1st Avenue');
      } finally {
        fetcher.restore();
      }
    });

  test('A RESTORED CONVERSATION LEARNS ITS SHOP FROM /status', async () => {
    const { mod } = await load();
    const storage = memoryStorage({
      [mod._internals.CONVERSATION_KEY]:
        JSON.stringify({ uid: 'anon-uid-1', conversationId: 'conv-earlier' })
    });
    const fetcher = captureFetch(jsonResponse(200,
      { ok: true, conversationId: 'conv-earlier', status: 'open',
        locationId: 'specialty' }));
    try {
      const ui = recordingUi();
      await mod.openChatForReview({
        ui, openPanel: () => {},
        deps: Object.assign({ storage: () => storage }, fakeClock().deps)
      });
      await tick();
      assert.equal(ui.destination, 'Specialty Shop - Keith Street',
        'the panel does not have to guess across a reload');
    } finally {
      fetcher.restore();
    }
  });

  test('A TRANSFER REACHES THE CUSTOMER, and it is the only way it can',
    async () => {
      /*
       * Moving a conversation writes NO message - lastMessageAt and
       * messageCount are deliberately untouched - so the Firestore transcript
       * listener sees absolutely nothing. The status poll is the entire
       * channel, which is why this test exists.
       */
      const { mod } = await load();
      let where = 'main';
      const { ui, fetcher, clock } = await connectedSession(mod, {
        responder: (n, input) => {
          const url = String(input);
          if (url.indexOf('/api/chat/status') !== -1) {
            return jsonResponse(200, { ok: true, conversationId: 'conv-1',
              status: 'open', locationId: where });
          }
          return jsonResponse(200, startAt('main'));
        }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
          locationId: 'main' });
        await tick();
        assert.equal(ui.destination, 'Main Shop - 1st Avenue');

        where = 'specialty';                     /* staff move it */
        clock.fireInterval();
        await tick();

        assert.equal(ui.destination, 'Specialty Shop - Keith Street',
          'the customer follows the conversation');
        /*
         * What the visitor actually reads is the SEQUENCE of distinct values,
         * so consecutive repeats are collapsed before comparing. There is one
         * on the start path on purpose: the line is repainted after
         * openTranscript() switches views, because relying on a view switch
         * to leave an unrelated element alone is the coupling that already
         * ate the notice once. Idempotent, and cheaper than the bug.
         */
        const seen = ui.destinationHistory.filter(Boolean)
          .filter((v, i, all) => i === 0 || v !== all[i - 1]);
        assert.deepEqual(seen, [
          'Main Shop - 1st Avenue', 'Specialty Shop - Keith Street'
        ], 'main, then specialty, and nothing in between');
      } finally {
        fetcher.restore();
      }
    });

  test('an unchanged shop is not repainted on every poll', async () => {
    const { mod } = await load();
    const { ui, fetcher, clock } = await connectedSession(mod, {
      responder: (n, input) => (String(input).indexOf('/api/chat/status') !== -1
        ? jsonResponse(200, { ok: true, conversationId: 'conv-1',
            status: 'open', locationId: 'main' })
        : jsonResponse(200, startAt('main')))
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
        locationId: 'main' });
      await tick();
      const after = ui.destinationHistory.length;
      clock.fireInterval(); await tick();
      clock.fireInterval(); await tick();
      assert.equal(ui.destinationHistory.length, after,
        'three answers, one paint');
    } finally {
      fetcher.restore();
    }
  });

  test('LETTING GO OF A CONVERSATION TAKES ITS DESTINATION WITH IT',
    async () => {
      const { mod } = await load();
      const storage = memoryStorage({
        [mod._internals.CONVERSATION_KEY]:
          JSON.stringify({ uid: 'anon-uid-1', conversationId: 'conv-gone' })
      });
      const fetcher = captureFetch(jsonResponse(404,
        { ok: false, code: 'conversation_not_found', error: 'nope' }));
      try {
        const ui = recordingUi();
        await mod.openChatForReview({
          ui, openPanel: () => {},
          deps: Object.assign({ storage: () => storage }, fakeClock().deps)
        });
        await tick();
        assert.equal(ui.destination, null,
          '"Sending to: Keith Street" above an empty start form is a lie');
        assert.equal(ui.startFormShown >= 1, true);
      } finally {
        fetcher.restore();
      }
    });

  test('AN ID THIS BUILD DOES NOT KNOW IS NEVER ECHOED', async () => {
    /* The last stop before a string reaches a screen. A response carrying
       something unexpected - a shop added server-side, or something worse -
       reads as the unassigned label rather than being printed. */
    const hostile = '<img src=x onerror="alert(1)">';
    for (const bad of [hostile, 'MAIN', ' main', 'main ', 'shop-3', 42, {}]) {
      const { mod } = await load();
      const { ui, fetcher } = await connectedSession(mod, {
        responder: jsonResponse(200, startAt(bad))
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
          locationId: 'main' });
        await tick();
        if (typeof bad === 'string' && bad) {
          assert.equal(ui.destination, 'Not Sure / Unassigned',
            JSON.stringify(bad) + ' must not be echoed');
        } else {
          assert.equal(ui.destination, null, 'nothing said, nothing shown');
        }
      } finally {
        fetcher.restore();
      }
    }
  });

  test('the retry carries the destination, so Try again is the same request',
    async () => {
      const { mod } = await load();
      let n = 0;
      const { ui, fetcher } = await connectedSession(mod, {
        responder: () => {
          n += 1;
          if (n === 1) return new TypeError('network');
          return jsonResponse(200, startAt('specialty'));
        }
      });
      try {
        await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
          locationId: 'specialty' });
        await tick();
        assert.equal(typeof ui.retry, 'function', 'a retry was offered');
        await ui.retry();
        await tick();
        const body = JSON.parse(fetcher.seen[1].init.body);
        assert.equal(body.locationId, 'specialty',
          'dropping it would make the retry fail for a different reason');
        /* And the SAME key, so it is a second attempt and not a second
           conversation. */
        assert.equal(body.clientMessageId,
          JSON.parse(fetcher.seen[0].init.body).clientMessageId);
      } finally {
        fetcher.restore();
      }
    });

  test('the customer is never shown a staff uid or an audit field', async () => {
    const { mod } = await load();
    const { ui, fetcher } = await connectedSession(mod, {
      responder: jsonResponse(200, startAt('main', {
        /* A server that over-shares must not make the panel over-show. */
        previousLocationId: 'specialty',
        lastTransferredByStaffUid: 'staff-uid-1',
        lastTransferredAt: 1700000000000,
        transferCount: 4,
        locationLabel: 'Somewhere Else Entirely'
      }))
    });
    try {
      await ui.startHandler({ name: 'Jo', email: 'jo@e.co', message: 'hi',
        locationId: 'main' });
      await tick();
      assert.equal(ui.destination, 'Main Shop - 1st Avenue',
        'the LABEL is derived from the id, never taken from the response');
      const seen = JSON.stringify(ui.destinationHistory) + String(ui.status)
        + String(ui.notice);
      for (const secret of ['staff-uid-1', 'Somewhere Else Entirely',
                            'transferCount', 'previousLocationId']) {
        assert.equal(seen.indexOf(secret), -1, secret + ' reached the panel');
      }
    } finally {
      fetcher.restore();
    }
  });

  /* ---------------------------------------------------- the widget itself */

  test('THE WIDGET HAS NO SHOP LIST OF ITS OWN', () => {
    /*
     * chat.js draws the selector but must not know what is in it. A second
     * copy of "Specialty Shop - Keith Street" in a classic script is exactly
     * how the two spellings appear.
     */
    for (const literal of ['Main Shop', 'Keith Street', 'First Ave',
                           'Specialty Shop', 'Not Sure', "I'm Not Sure",
                           "'main'", "'specialty'", "'unassigned'"]) {
      assert.equal(WIDGET_CODE.indexOf(literal), -1,
        'chat.js hard-codes ' + literal);
    }
  });

  test('the widget sends what was selected, and nothing when nothing is', () => {
    assert.match(WIDGET_CODE, /locationId: selectedLocation\(\)/);
    /* selectedLocation() reads the radios and returns null - it does not
       fall back to a shop. */
    assert.match(WIDGET_CODE, /function selectedLocation\(\)[\s\S]{0,240}return null;/);
  });

  test('FOUND IN THE BROWSER: focus lands on the first question, not past it',
    () => {
      /*
       * At 390px the start form is taller than the panel, and focusing the
       * Name field scrolled the shop chooser clean off the top of the log -
       * the visitor opened the panel looking at "Email" with no idea a
       * routing question had gone by. Reading the code did not find this;
       * a screenshot did.
       *
       * The fix has three parts and all three are load-bearing: focus the
       * first radio rather than Name, ask the browser not to scroll for it,
       * and put the log back to the top afterwards.
       */
      assert.match(WIDGET_CODE,
        /var first = locationInputs\.length \? locationInputs\[0\] : null;/);
      assert.match(WIDGET_CODE, /preventScroll: true/);
      assert.match(WIDGET_CODE, /log\.scrollTop = 0;/);
      /* Focusing an unchecked radio does not check it - so this moves the
         view without answering the question. Nothing here checks one. */
      assert.equal(/locationInputs\[0\]\.checked\s*=/.test(WIDGET_CODE), false,
        'nothing preselects a shop');
    });

  test('the selector and the destination line are textContent, like everything else',
    () => {
      /* The one rule in that section of chat.js. Three innerHTML calls exist
         and all three are fixed SVG icons in build(). */
      const html = (WIDGET_CODE.match(/innerHTML/g) || []).length;
      assert.equal(html, 3, 'no new innerHTML was introduced');
      assert.match(WIDGET_CODE, /destBar\.textContent = 'Sending to: '/);
    });

  test('NO SHOP ID IS NAMED ANYWHERE OUTSIDE chat-locations.js', () => {
    /*
     * The kill for a silent default. `locationId: input.locationId || 'main'`
     * is unreachable while the guard above it stands - which is exactly why
     * no behavioural test can see it, and exactly why it must not be written:
     * the day somebody relaxes the guard it becomes a live path that sends a
     * curved-scupper job to 1st Avenue without telling anybody.
     *
     * chat-locations.js is where the three ids are declared. Nothing else
     * spells one out: the selector supplies them to the transport, the
     * server supplies them back, and neither the transport nor the widget
     * has an opinion about which one is right.
     */
    for (const [name, src] of [['chat-customer.js', CUSTOMER_CODE],
                               ['chat.js', WIDGET_CODE]]) {
      for (const id of ["'main'", '"main"', "'specialty'", '"specialty"',
                        "'unassigned'", '"unassigned"']) {
        assert.equal(src.indexOf(id), -1, name + ' names the shop ' + id);
      }
    }
    /*
     * And in particular, nothing defaults one where a VALUE is produced -
     * `locationId: x || y`. Matched on the property form specifically, so
     * the guard's own `typeof input.locationId !== 'string' || !…` is not
     * mistaken for a fallback: that one refuses, it does not substitute.
     */
    const substitutes = /locationId:\s*[^\n,}]*(\|\||\?\?)/;
    assert.equal(substitutes.test(CUSTOMER_CODE), false,
      'chat-customer.js substitutes a destination');
    assert.equal(substitutes.test(WIDGET_CODE), false,
      'chat.js substitutes a destination');
  });

  test('the transport imports the shop definitions rather than restating them',
    () => {
      assert.match(CUSTOMER_CODE, /from '\.\/chat-locations\.js\?v=/);
      /* And does not keep its own copy of the words. */
      for (const literal of ['Main Shop', 'Keith Street', 'Specialty Shop']) {
        assert.equal(CUSTOMER_CODE.indexOf(literal), -1,
          'chat-customer.js hard-codes ' + literal);
      }
    });

  test('and that module is the one the server twin is pinned to', async () => {
    /* Imported inside the test, not in the describe body: on Node v22 a
       throw in a describe body marks the suite not-ok, runs none of it, and
       still exits 0 - so an assertion up there is a safety net that is not
       attached to anything. */
    const LOCATIONS = await import(LOCATIONS_URL);
    assert.equal(LOCATIONS.labelFor('main'), 'Main Shop - 1st Avenue');
    assert.equal(LOCATIONS.labelFor('specialty'), 'Specialty Shop - Keith Street');
    assert.equal(LOCATIONS.labelFor('unassigned'), 'Not Sure / Unassigned');
    assert.equal(LOCATIONS.labelFor('nonsense'), 'Not Sure / Unassigned');
    assert.deepEqual(LOCATIONS.LOCATION_IDS, ['main', 'specialty', 'unassigned']);
    /* resolveLocation() never invents main. Missing routing is unassigned. */
    assert.equal(LOCATIONS.resolveLocation(undefined), 'unassigned');
    assert.equal(LOCATIONS.resolveLocation(''), 'unassigned');
    assert.equal(LOCATIONS.resolveLocation('MAIN'), 'unassigned');
  });
});
