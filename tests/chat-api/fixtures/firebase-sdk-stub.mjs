/*
 * A stand-in for the two Firebase Web SDK modules that
 * assets/js/chat-app-check.js loads from gstatic.
 *
 * WHY A STUB AND NOT THE REAL SDK.
 *
 * The module under test imports firebase-app.js and firebase-app-check.js by
 * URL. Fetching those in a unit test would be wrong twice over: it puts the
 * network in the middle of a test that is supposed to be about our own logic,
 * and the real SDK could not do anything useful here anyway. App Check
 * attestation is a reCAPTCHA Enterprise challenge performed by a browser
 * against the page's own hostname, and the production site key is restricted
 * to esthers.ca. No token can be issued from this container, and the correct
 * response to that is to test up to the boundary - not to weaken the domain
 * restriction so a test can pass.
 *
 * So the test rewrites the two SDK specifiers to point here. Both point to
 * this one file, which is why it exports the union of the two modules'
 * surfaces; the module under test only ever names four functions and one
 * class, and those are what it gets.
 *
 * Everything else here exists to let a test say "and then attestation failed"
 * or "another module already started Firebase" and see what our code does.
 *
 * STATE IS MODULE-LEVEL AND SHARED. Node caches this by URL, so the rewritten
 * copy of chat-app-check.js and the test file are looking at the same object -
 * which is the point, and also why every test calls reset() first.
 */

/* ------------------------------------------------------------ recorder */

/*
 * Mutated in place, never reassigned: the test holds `stub.calls` across a
 * reset(), so swapping in a fresh object would leave it inspecting the old one.
 */
export const calls = {
  initializeApp: [],      /* the config object, as passed                  */
  initializeAppCheck: [], /* { app, options }                              */
  providerSiteKeys: [],   /* every site key a provider was constructed on  */
  getToken: []            /* { appCheck, forceRefresh }                    */
};

/* ------------------------------------------------------------- controls */

let apps = [];
let token = 'stub.app.check.token';
let tokenError = null;
let initError = null;

/* Back to a clean slate: no apps, no injected failures, nothing recorded. */
export function reset() {
  calls.initializeApp.length = 0;
  calls.initializeAppCheck.length = 0;
  calls.providerSiteKeys.length = 0;
  calls.getToken.length = 0;
  apps = [];
  token = 'stub.app.check.token';
  tokenError = null;
  initError = null;
}

/* Pretend another module on the page already called initializeApp(). This is
   the case chat-app-check.js guards with getApps() - calling initializeApp a
   second time with a different config is an error in the real SDK. */
export function seedExistingApp(app) {
  apps = [app || { name: '[DEFAULT]', seeded: true }];
}

/* What getToken() should resolve with. */
export function setToken(value) {
  token = value;
  tokenError = null;
}

/* Make getToken() reject - a refused attestation, an offline browser, a
   hostname the reCAPTCHA key does not cover. */
export function setTokenError(err) {
  tokenError = err || new Error('stub: attestation refused');
}

/* Make initializeAppCheck() throw, standing in for an SDK that loaded but
   could not start. */
export function setInitError(err) {
  initError = err || new Error('stub: initialisation failed');
}

/* ------------------------------------------------- firebase-app surface */

export function initializeApp(config) {
  calls.initializeApp.push(config);
  const app = { name: '[DEFAULT]', options: config };
  apps.push(app);
  return app;
}

export function getApps() {
  return apps.slice();
}

/* ------------------------------------------- firebase-app-check surface */

/*
 * The real provider keeps its site key private. This one keeps it on the
 * instance so a test can assert that the provider actually handed to
 * initializeAppCheck() was built on the expected key - not merely that some
 * provider somewhere was.
 */
export class ReCaptchaEnterpriseProvider {
  constructor(siteKey) {
    this.siteKey = siteKey;
    calls.providerSiteKeys.push(siteKey);
  }
}

export function initializeAppCheck(app, options) {
  calls.initializeAppCheck.push({ app, options });
  if (initError) throw initError;
  return { __appCheck: true, app, options };
}

export async function getToken(appCheck, forceRefresh) {
  calls.getToken.push({ appCheck, forceRefresh });
  if (tokenError) throw tokenError;
  return { token };
}
