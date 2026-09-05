/*
 * The browser half of App Check: assets/js/chat-app-check.js.
 *
 * WHAT THIS CAN AND CANNOT PROVE, STATED UP FRONT.
 *
 * It cannot mint a real App Check token, and neither can anything else in this
 * container. The production reCAPTCHA Enterprise key is restricted to
 * esthers.ca, and attestation is performed by a browser against the page's own
 * hostname - so a token can only be issued from a page actually served from
 * esthers.ca. That restriction is the protection, and weakening it to make a
 * test pass would be exactly the wrong trade.
 *
 * What it does prove is everything up to that boundary: that the configuration
 * is the real one, that Firebase and App Check are each initialised exactly
 * once, that the provider is handed the exact site key, that auto-refresh is
 * on, that two concurrent callers share one initialisation, that a failure
 * returns null instead of throwing, and that authorizedFetch attaches the
 * right header and nothing else.
 *
 * HOW. The module imports the Firebase SDK by dynamic import() from a
 * gstatic URL. Node cannot fetch that, and should not try - a unit test that
 * reaches the network is not a unit test. So the SDK specifiers are rewritten
 * to a local stub and the rewritten source imported as a data: URL. The
 * module's own logic runs unmodified; only where the SDK comes from changes.
 *
 * NO NETWORK. NO PRODUCTION CONTACT. NO CHAT REQUEST.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SRC_PATH = '/home/user/esthers/assets/js/chat-app-check.js';
const STUB_PATH = '/home/user/esthers/tests/chat-api/fixtures/firebase-sdk-stub.mjs';
const SRC = readFileSync(SRC_PATH, 'utf8');

/* The real values, written out here independently of the module so a silent
   edit to either side fails the test rather than agreeing with itself. */
const EXPECT = {
  apiKey: 'AIzaSyBUt0PMdhgQaztnobzrLE0PIndu0_4AYoU',
  authDomain: 'esther-s-chat.firebaseapp.com',
  projectId: 'esther-s-chat',
  appId: '1:688542251560:web:e32a494df80f71a7bdd31d',
  siteKey: '6LcZfKotAAAAAG3nYWcAxT6P_nWyTRJp9XXMw6C6'
};

/* Load the module with the SDK swapped for the local stub. Each call gets a
   fresh module instance, so the memoisation tests start from zero. */
let salt = 0;
async function loadModule() {
  salt += 1;
  const stub = pathToFileURL(STUB_PATH).href;
  const rewritten = SRC
    .replace(/const SDK_APP = [^;]+;/, `const SDK_APP = ${JSON.stringify(stub)};`)
    .replace(/const SDK_APP_CHECK = [^;]+;/, `const SDK_APP_CHECK = ${JSON.stringify(stub)};`)
    + `\n/* cache-bust ${salt} */\n`;
  const url = 'data:text/javascript;base64,' + Buffer.from(rewritten, 'utf8').toString('base64');
  const mod = await import(url);
  const stubMod = await import(stub);
  stubMod.reset();
  return { mod, stub: stubMod };
}

/*
 * The source with comments blanked out, and a second copy with the string
 * literals blanked out too.
 *
 * The assertions below that say "this does not appear in the module" have to
 * tell a use from a mention. This file explains itself at length: the prose
 * names /api/chat/* repeatedly, and a console.error message names
 * RECAPTCHA_ENTERPRISE_SITE_KEY. A plain substring search reads both as code
 * and fails on the documentation.
 *
 * So there are two views, and each test uses the stricter one it can:
 *
 *   NO_COMMENTS  comments gone, strings kept - for "no endpoint is hard-coded
 *                here", which must still catch fetch('/api/chat/start')
 *   CODE         comments and string bodies gone - for "this identifier is
 *                only used in one place", where a name inside a message is
 *                not a use
 *
 * Newlines survive both, so reported line numbers still match the real file.
 */
function blank(src, opts) {
  const keepStrings = Boolean(opts && opts.keepStrings);
  const gap = (ch) => (ch === '\n' ? '\n' : ' ');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += gap(src[i]);
      continue;
    }
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    const quote = src[i];
    if (quote === "'" || quote === '"' || quote === '`') {
      out += quote;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += keepStrings ? src.slice(i, i + 2) : (' ' + gap(src[i + 1] || ' '));
          i += 2;
          continue;
        }
        if (src[i] === quote) { out += quote; i += 1; break; }
        out += keepStrings ? src[i] : gap(src[i]);
        i += 1;
      }
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

const NO_COMMENTS = blank(SRC, { keepStrings: true });
const CODE = blank(SRC);

/* ============================================================ THE CONFIG */

describe('the public client configuration', () => {
  test('all four Firebase values are exactly the ones supplied', async () => {
    const { mod } = await loadModule();
    assert.equal(mod.FIREBASE_CONFIG.apiKey, EXPECT.apiKey);
    assert.equal(mod.FIREBASE_CONFIG.authDomain, EXPECT.authDomain);
    assert.equal(mod.FIREBASE_CONFIG.projectId, EXPECT.projectId);
    assert.equal(mod.FIREBASE_CONFIG.appId, EXPECT.appId);
  });

  test('the reCAPTCHA Enterprise site key is exactly the one supplied', async () => {
    const { mod } = await loadModule();
    assert.equal(mod.RECAPTCHA_ENTERPRISE_SITE_KEY, EXPECT.siteKey);
  });

  test('isConfigured() is now true', async () => {
    const { mod } = await loadModule();
    assert.equal(mod.isConfigured(), true);
  });

  test('no private or secret-shaped value is present in the file', () => {
    for (const forbidden of [
      'BEGIN PRIVATE KEY', 'PRIVATE KEY-----', 'privateKey', 'private_key',
      'client_email', 'clientEmail', 'serviceAccount', 'service_account',
      'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_APPCHECK_DEBUG_TOKEN', 'debugToken'
    ]) {
      assert.equal(SRC.includes(forbidden), false, 'must not contain ' + forbidden);
    }
  });

  test('the site key is used only to construct the reCAPTCHA provider', () => {
    /* Real uses only - CODE has the comments and the console.error message
       blanked, so a mention of the name in prose is not counted. Every
       remaining line, other than the declaration itself and the isConfigured()
       guard, must be the provider call. */
    const uses = CODE.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(x => x.line.includes('RECAPTCHA_ENTERPRISE_SITE_KEY'))
      .filter(x => !x.line.startsWith('export const RECAPTCHA_ENTERPRISE_SITE_KEY'));
    assert.ok(uses.length > 0, 'the site key must actually be used somewhere');
    for (const u of uses) {
      const ok = u.line.includes('ReCaptchaEnterpriseProvider')
              || u.line === 'RECAPTCHA_ENTERPRISE_SITE_KEY';   /* isConfigured() */
      assert.ok(ok, 'unexpected use of the site key at line ' + u.n + ': ' + u.line);
    }
  });

  test('the module embeds no chat API call and no Firestore listener', () => {
    /* NO_COMMENTS, not CODE: string literals are kept, so a hard-coded
       fetch('/api/chat/start') would still be caught. Only the prose - which
       names these endpoints because explaining them is the comment's job - is
       exempt. */
    for (const forbidden of [
      '/api/chat', 'chat/start', 'chat/send', 'signInAnonymously',
      'onSnapshot', 'getFirestore', 'collection(', 'firebase-firestore'
    ]) {
      assert.equal(NO_COMMENTS.includes(forbidden), false, 'must not contain ' + forbidden);
    }
  });
});

/* ==================================================== INITIALISATION PATH */

describe('initialisation', () => {
  test('Firebase initialises exactly once, App Check exactly once', async () => {
    const { mod, stub } = await loadModule();
    await mod.initAppCheck();
    assert.equal(stub.calls.initializeApp.length, 1);
    assert.equal(stub.calls.initializeAppCheck.length, 1);
  });

  test('initializeApp receives exactly the public config', async () => {
    const { mod, stub } = await loadModule();
    await mod.initAppCheck();
    assert.deepEqual(stub.calls.initializeApp[0], {
      apiKey: EXPECT.apiKey,
      authDomain: EXPECT.authDomain,
      projectId: EXPECT.projectId,
      appId: EXPECT.appId
    });
  });

  test('ReCaptchaEnterpriseProvider receives the exact site key', async () => {
    const { mod, stub } = await loadModule();
    await mod.initAppCheck();
    assert.equal(stub.calls.providerSiteKeys.length, 1);
    assert.equal(stub.calls.providerSiteKeys[0], EXPECT.siteKey);
    /* and the provider actually handed to initializeAppCheck is that one */
    const opts = stub.calls.initializeAppCheck[0].options;
    assert.equal(opts.provider.siteKey, EXPECT.siteKey);
  });

  test('auto-refresh is enabled', async () => {
    const { mod, stub } = await loadModule();
    await mod.initAppCheck();
    assert.equal(stub.calls.initializeAppCheck[0].options.isTokenAutoRefreshEnabled, true);
  });

  test('two concurrent callers share one initialisation', async () => {
    const { mod, stub } = await loadModule();
    const [a, b] = await Promise.all([mod.initAppCheck(), mod.initAppCheck()]);
    assert.equal(stub.calls.initializeApp.length, 1, 'no second Firebase app');
    assert.equal(stub.calls.initializeAppCheck.length, 1, 'no second reCAPTCHA challenge');
    assert.equal(a, b, 'both callers get the same instance');
  });

  test('a later call reuses the memoised instance', async () => {
    const { mod, stub } = await loadModule();
    const first = await mod.initAppCheck();
    const second = await mod.initAppCheck();
    assert.equal(first, second);
    assert.equal(stub.calls.initializeAppCheck.length, 1);
  });

  test('an existing Firebase app is reused rather than re-created', async () => {
    const { mod, stub } = await loadModule();
    stub.seedExistingApp();          /* something else already started one */
    await mod.initAppCheck();
    assert.equal(stub.calls.initializeApp.length, 0, 'initializeApp must not be called again');
    assert.equal(stub.calls.initializeAppCheck.length, 1);
  });

  test('emptying any config value stops it initialising at all', async () => {
    /* isConfigured() is the guard; prove it actually gates build(). */
    const stub = pathToFileURL(STUB_PATH).href;
    const broken = SRC
      .replace(/const SDK_APP = [^;]+;/, `const SDK_APP = ${JSON.stringify(stub)};`)
      .replace(/const SDK_APP_CHECK = [^;]+;/, `const SDK_APP_CHECK = ${JSON.stringify(stub)};`)
      .replace(/apiKey: '[^']*'/, "apiKey: ''");
    const url = 'data:text/javascript;base64,'
      + Buffer.from(broken + '\n/* broken */\n', 'utf8').toString('base64');
    const mod = await import(url);
    const stubMod = await import(stub);
    stubMod.reset();
    const original = console.error;
    console.error = () => {};
    let result;
    try { result = await mod.initAppCheck(); } finally { console.error = original; }
    assert.equal(result, null);
    assert.equal(stubMod.calls.initializeApp.length, 0);
    assert.equal(stubMod.calls.initializeAppCheck.length, 0);
  });
});

/* ============================================================ THE TOKEN */

describe('getAppCheckToken', () => {
  test('returns the token when the SDK issues one', async () => {
    const { mod, stub } = await loadModule();
    stub.setToken('a.real.looking.token');
    assert.equal(await mod.getAppCheckToken(), 'a.real.looking.token');
  });

  test('returns null - never throws - when attestation fails', async () => {
    const { mod, stub } = await loadModule();
    stub.setTokenError(new Error('reCAPTCHA refused: hostname not allowed'));
    /* This is the shape of the real failure from a host that is not
       esthers.ca, which is every host available to this test. */
    assert.equal(await mod.getAppCheckToken(), null);
  });

  test('returns null when initialisation itself failed', async () => {
    const { mod, stub } = await loadModule();
    stub.setInitError(new Error('SDK exploded'));
    /* build() logs this deliberately. Expected here, so keep it out of the
       test output where it would read as a real failure. */
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(await mod.getAppCheckToken(), null);
    } finally {
      console.error = original;
    }
  });

  test('does not force a refresh on every call', async () => {
    const { mod, stub } = await loadModule();
    stub.setToken('t.o.k');
    await mod.getAppCheckToken();
    assert.equal(stub.calls.getToken[0].forceRefresh, false);
  });
});

/* ======================================================= authorizedFetch */

describe('authorizedFetch', () => {
  function withFetch(fn) {
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (input, init) => { seen.push({ input, init }); return { ok: true }; };
    return fn(seen).finally(() => { globalThis.fetch = original; });
  }

  test('attaches X-Firebase-AppCheck when a token exists', async () => {
    const { mod, stub } = await loadModule();
    stub.setToken('h.e.a');
    await withFetch(async (seen) => {
      await mod.authorizedFetch('/api/chat/start', { method: 'POST' });
      assert.equal(seen[0].init.headers.get('X-Firebase-AppCheck'), 'h.e.a');
    });
  });

  test('sends no App Check header when there is no token', async () => {
    const { mod, stub } = await loadModule();
    stub.setTokenError(new Error('no attestation'));
    await withFetch(async (seen) => {
      await mod.authorizedFetch('/api/chat/start', { method: 'POST' });
      assert.equal(seen[0].init.headers.has('X-Firebase-AppCheck'), false);
    });
  });

  test('leaves existing headers intact', async () => {
    const { mod, stub } = await loadModule();
    stub.setToken('h.e.a');
    await withFetch(async (seen) => {
      await mod.authorizedFetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer id-token' }
      });
      const h = seen[0].init.headers;
      assert.equal(h.get('Content-Type'), 'application/json');
      assert.equal(h.get('Authorization'), 'Bearer id-token');
      assert.equal(h.get('X-Firebase-AppCheck'), 'h.e.a');
    });
  });

  test('never synthesises an Authorization header from the App Check token', async () => {
    const { mod, stub } = await loadModule();
    stub.setToken('h.e.a');
    await withFetch(async (seen) => {
      await mod.authorizedFetch('/api/chat/start', { method: 'POST' });
      assert.equal(seen[0].init.headers.has('Authorization'), false,
        'the ID token is a different credential and is the caller\'s job');
    });
  });

  test('preserves method and body', async () => {
    const { mod, stub } = await loadModule();
    stub.setToken('h.e.a');
    await withFetch(async (seen) => {
      await mod.authorizedFetch('/api/chat/start', { method: 'POST', body: '{"a":1}' });
      assert.equal(seen[0].init.method, 'POST');
      assert.equal(seen[0].init.body, '{"a":1}');
      assert.equal(seen[0].input, '/api/chat/start');
    });
  });

  test('the module itself calls no chat endpoint - the caller supplies the URL', () => {
    /* authorizedFetch is a transport. The URLs above are the TEST's, not the
       module's; the module must contain none of its own. */
    const body = NO_COMMENTS.slice(NO_COMMENTS.indexOf('export async function authorizedFetch'));
    assert.ok(body.length > 0, 'authorizedFetch must exist');
    assert.equal(/['"`]\/api\//.test(body), false,
      'authorizedFetch must not hard-code an endpoint');
  });
});
