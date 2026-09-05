/* =========================================================================
 * Esther's - Firebase App Check for the browser.
 *
 * ####################################################################
 * ##                                                                ##
 * ##  NOT LOADED BY ANY PAGE. No <script> tag references this file. ##
 * ##                                                                ##
 * ##  It exists so the client half of App Check is written, reviewed ##
 * ##  and ready before the chat frontend is connected. Nothing here  ##
 * ##  runs until something imports it, and nothing does yet. The     ##
 * ##  mascot still says "Online messaging coming soon."              ##
 * ##                                                                ##
 * ####################################################################
 *
 * WHAT THIS IS FOR
 *
 * App Check proves a request came from the real Esther's website rather than
 * from a script someone pointed at the API. It does not identify a person -
 * Firebase Auth does that - it identifies the app.
 *
 * There are two consumers, and they are protected differently:
 *
 *   Firestore (if the customer ever reads it directly)
 *       Google enforces App Check itself, once enforcement is switched on in
 *       the Firebase console. Initialising App Check here is all the client
 *       has to do; the SDK attaches the token to its own requests.
 *
 *   /api/chat/* and /api/admin/chat/* on Vercel
 *       Google never sees these. Nothing is automatic. The token has to be
 *       fetched with getToken() and sent as a header, and the server has to
 *       verify it with the Admin SDK. authorizedFetch() below is that half.
 *
 * WHY IT LOADS ON DEMAND
 *
 * The Firebase Web SDK and a reCAPTCHA Enterprise challenge are a real cost -
 * a few hundred KB and a network round trip - and every page of this site
 * carries the mascot. Loading all of that on the home page so that a visitor
 * who never opens chat can pay for it would be a poor trade. Everything here
 * is behind a dynamic import that runs the first time chat actually needs a
 * token, and never before.
 *
 * Plain ES module on the site's no-build architecture: the browser loads it
 * as-is, the way it loads every other file here.
 * ========================================================================= */

'use strict';

/* -------------------------------------------------------------------------
 * CONFIGURATION - MUST BE FILLED IN BEFORE THIS CAN RUN
 *
 * Every value below is PUBLIC browser configuration. A Firebase web config
 * and a reCAPTCHA site key are designed to be readable in page source; they
 * are identifiers, not secrets, and Firebase publishes them in its own
 * documentation examples. What protects the project is App Check enforcement,
 * the Firestore rules, the API's own authentication and the fact that the
 * production reCAPTCHA key is restricted to the esthers.ca domain.
 *
 * WHAT IS A SECRET, AND MUST NEVER APPEAR IN THIS FILE OR ANY FILE UNDER
 * assets/: the service-account private key, the client email, any Firebase
 * Admin credential, and any App Check debug token. Those live only in Vercel
 * environment variables and in a developer's own browser.
 *
 * These are deliberately left empty. An invented site key would fail at the
 * worst possible moment - silently, in production, as a token that never
 * verifies - so the module refuses to start instead. See isConfigured().
 * ---------------------------------------------------------------------- */

export const FIREBASE_CONFIG = {
  apiKey: '',              /* from Firebase console > Project settings > Your apps */
  authDomain: '',          /* usually esther-s-chat.firebaseapp.com               */
  projectId: 'esther-s-chat',
  appId: ''                /* the "Esther's Website" web app's App ID             */
};

/*
 * The reCAPTCHA Enterprise SITE key for "Esther's Website".
 *
 * The site key, not the API key and not the secret: reCAPTCHA Enterprise
 * issues a public site key for the browser and a separate private key that
 * never leaves Google Cloud. Only the site key belongs here.
 *
 * The production key is restricted to esthers.ca. That restriction is what
 * makes it safe to publish, and it is also why localhost must never be added
 * to it - see the debug-token note in docs/CHAT_APP_CHECK.md.
 */
export const RECAPTCHA_ENTERPRISE_SITE_KEY = '';

/*
 * Where the Firebase Web SDK comes from.
 *
 * Firebase's own ESM CDN build, pinned to an exact version. Pinned rather than
 * floating because an unpinned SDK is a third party who can change the code
 * running on the site without anyone deciding to ship anything.
 */
const SDK_VERSION = '12.4.0';
const SDK_APP = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-app.js';
const SDK_APP_CHECK = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-app-check.js';

/* The header the Vercel API reads. Must match APP_CHECK_HEADER in
   api/_chat/app-check.js - Firebase's own spelling for custom backends. */
export const APP_CHECK_HEADER = 'X-Firebase-AppCheck';

/* -------------------------------------------------------------------- state */

/*
 * Exactly once, and shared.
 *
 * initializeApp() throws on a second call with a different config, and
 * initializeAppCheck() would set up a second attestation provider - two
 * reCAPTCHA challenges for one page. Both are memoised as promises rather
 * than values so that two callers arriving in the same tick share one
 * initialisation instead of racing to create two.
 */
let appCheckPromise = null;

export function isConfigured() {
  return Boolean(
    FIREBASE_CONFIG.apiKey &&
    FIREBASE_CONFIG.authDomain &&
    FIREBASE_CONFIG.projectId &&
    FIREBASE_CONFIG.appId &&
    RECAPTCHA_ENTERPRISE_SITE_KEY
  );
}

/*
 * Initialise Firebase and App Check, once.
 *
 * Resolves to the App Check instance, or null when the module is not
 * configured or the SDK could not be loaded. NULL IS A NORMAL RETURN, not an
 * exception: a visitor whose network blocked the CDN should see the chat's
 * ordinary "temporarily unavailable" message, not an unhandled rejection.
 */
export async function initAppCheck() {
  if (appCheckPromise) return appCheckPromise;
  appCheckPromise = build();
  return appCheckPromise;
}

async function build() {
  if (!isConfigured()) {
    /* Deliberately loud in the console and harmless on the page. This state
       is a deployment mistake, and it should be obvious to whoever made it. */
    console.error('Esther\'s: Firebase App Check is not configured. ' +
      'Fill in FIREBASE_CONFIG and RECAPTCHA_ENTERPRISE_SITE_KEY in ' +
      'assets/js/chat-app-check.js before enabling chat.');
    return null;
  }

  let appMod, acMod;
  try {
    /* Literal specifiers, loaded in parallel. */
    [appMod, acMod] = await Promise.all([import(SDK_APP), import(SDK_APP_CHECK)]);
  } catch (err) {
    console.error('Esther\'s: the Firebase SDK could not be loaded.');
    return null;
  }

  try {
    /* getApps() first: another module on the page may already have started
       the same Firebase app, and initializeApp() twice is an error. */
    const existing = appMod.getApps();
    const app = existing.length ? existing[0] : appMod.initializeApp(FIREBASE_CONFIG);

    return acMod.initializeAppCheck(app, {
      provider: new acMod.ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
      /* The SDK refreshes the token before it expires - the TTL on this
         project is an hour - so a long-lived chat session does not start
         failing halfway through a conversation. */
      isTokenAutoRefreshEnabled: true
    });
  } catch (err) {
    console.error('Esther\'s: Firebase App Check could not be initialised.');
    return null;
  }
}

/*
 * The current App Check token, or null.
 *
 * null is returned - never thrown - for every failure: not configured, SDK
 * unavailable, attestation refused, offline. The caller decides what to do,
 * and while enforcement is off the API will still answer, which is exactly
 * what makes the staged rollout possible.
 */
export async function getAppCheckToken() {
  let appCheck;
  try {
    appCheck = await initAppCheck();
  } catch (err) {
    return null;
  }
  if (!appCheck) return null;

  try {
    const mod = await import(SDK_APP_CHECK);
    const result = await mod.getToken(appCheck, /* forceRefresh */ false);
    return (result && typeof result.token === 'string' && result.token) ? result.token : null;
  } catch (err) {
    /* An attestation failure is not something a visitor can act on, and the
       message can carry reCAPTCHA detail. Swallow it. */
    return null;
  }
}

/*
 * fetch() with the App Check header attached when one is available.
 *
 * THIS IS THE WHOLE POINT OF THE CLIENT HALF. Firestore gets its App Check
 * token automatically; a Vercel function does not, because Google is not in
 * that request path. Every call to /api/chat/* and /api/admin/chat/* should
 * go through here.
 *
 * It does NOT attach the Firebase ID token. That is a different credential
 * proving a different thing, it belongs in the Authorization header, and the
 * caller owns it - keeping the two apart here mirrors the server, which
 * refuses to read either one out of the other's channel.
 *
 * A missing token is not fatal: the request is sent without the header. While
 * enforcement is off the server accepts it and records the miss, which is how
 * the rollout learns whether real clients are attesting successfully. Once
 * enforcement is on the same request is refused with 401 app_check_required -
 * the client behaviour does not change, the server's answer does.
 */
export async function authorizedFetch(input, init) {
  const options = Object.assign({}, init);
  const headers = new Headers((init && init.headers) || {});

  const token = await getAppCheckToken();
  if (token) headers.set(APP_CHECK_HEADER, token);

  options.headers = headers;
  return fetch(input, options);
}

/* Tests and the eventual chat module may need to start from scratch. */
export function _reset() {
  appCheckPromise = null;
}
