/*
 * Firebase Admin packaging: can the deployed function actually LOAD the SDK?
 *
 * WHAT PRODUCTION SAID
 *
 *   chat: init failed [chat/start] firebase_admin_module_missing
 *   shape=pid:1,pid_ok:1,...,key_body:1,secret:1
 *
 * Every structural configuration check passed, so this was never a credential
 * problem. The token said the SDK could not be loaded.
 *
 * WHAT THAT TOKEN ACTUALLY MEANT
 *
 * It was the FALLBACK reason of a single wrapper around all three requires,
 * so it was emitted both for "the package is absent" and for "the package is
 * present and threw while loading" - two faults with completely different
 * fixes. These tests pin the split, and pin the packaging facts that a
 * deployment depends on.
 *
 * Emulator/mocks only. No production Firebase contact.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const require = createRequire('/home/user/esthers/');
const FB = require('/home/user/esthers/api/_chat/firebase-admin.js');
const ROOT = '/home/user/esthers';

/* ================================================== THE MANIFEST AND LOCK */
describe('firebase-admin is a production dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(ROOT + '/package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync(ROOT + '/package-lock.json', 'utf8'));

  test('declared under dependencies, not devDependencies', () => {
    assert.equal(pkg.dependencies['firebase-admin'], '14.3.0',
      'exact pin, no caret - a range would let a deploy pick a different major');
    assert.equal((pkg.devDependencies || {})['firebase-admin'], undefined,
      'a devDependency is not installed for a production function');
  });

  test('the lockfile marks it as production', () => {
    const entry = lock.packages['node_modules/firebase-admin'];
    assert.ok(entry, 'firebase-admin must be in the lockfile');
    assert.equal(entry.version, '14.3.0');
    assert.notEqual(entry.dev, true,
      'dev:true here would mean npm install --omit=dev skips it entirely');
    assert.equal(lock.packages[''].dependencies['firebase-admin'], '14.3.0');
  });

  test('its transitive Firestore dependency is production too', () => {
    const fsEntry = lock.packages['node_modules/@google-cloud/firestore'];
    assert.ok(fsEntry, '@google-cloud/firestore must be locked');
    assert.notEqual(fsEntry.dev, true);
  });

  test('npm resolves it with devDependencies omitted', () => {
    const out = execFileSync('npm', ['ls', '--omit=dev', 'firebase-admin'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /firebase-admin@14\.3\.0/);
    assert.equal(out.includes('UNMET'), false);
    assert.equal(out.includes('invalid'), false);
  });
});

/* ============================================== THE THREE SUBPATH EXPORTS */
describe('the modular entry points resolve', () => {
  test('firebase-admin/app, /firestore and /auth all resolve', () => {
    for (const spec of ['firebase-admin/app', 'firebase-admin/firestore',
      'firebase-admin/auth']) {
      const resolved = require.resolve(spec);
      assert.ok(resolved.includes('node_modules/firebase-admin'), spec);
      assert.ok(fs.existsSync(resolved), spec + ' resolved to a missing file');
    }
  });

  test('each exposes the function this code actually calls', () => {
    const app = require('firebase-admin/app');
    for (const fn of ['cert', 'getApps', 'initializeApp']) {
      assert.equal(typeof app[fn], 'function', 'firebase-admin/app.' + fn);
    }
    assert.equal(typeof require('firebase-admin/firestore').getFirestore, 'function');
    assert.equal(typeof require('firebase-admin/firestore').Timestamp.now, 'function');
    assert.equal(typeof require('firebase-admin/auth').getAuth, 'function');
  });

  test('the package declares a require condition for each subpath', () => {
    /* An exports map with only "import" would make require() throw
       ERR_PACKAGE_PATH_NOT_EXPORTED, which is one of the faults the new
       per-module tokens distinguish. */
    const pkg = JSON.parse(fs.readFileSync(
      ROOT + '/node_modules/firebase-admin/package.json', 'utf8'));
    for (const sub of ['./app', './firestore', './auth']) {
      assert.ok(pkg.exports[sub].require, sub + ' has no require condition');
    }
    assert.equal(pkg.engines.node, '>=22',
      'the runtime requirement this deployment has to satisfy');
  });
});

/* ============================================== STATICALLY TRACEABLE LOADS */
describe('the SDK is loaded by literal dynamic import, never require', () => {
  const source = fs.readFileSync(ROOT + '/api/_chat/firebase-admin.js', 'utf8');
  /* Comments are stripped: this file discusses require() and import() in
     prose, and matching that would make the test lie in both directions. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('THE ERR_REQUIRE_ESM REGRESSION: no require() of any SDK module', () => {
    /* firebase-admin/auth pulls in `jose`, which is ESM-only. require()ing it
       throws ERR_REQUIRE_ESM on any Node without require(esm) support, which
       landed in 22.12 - and Vercel's Node 22.x was below that. Going back to
       require() here would reproduce the production 500 exactly. */
    for (const spec of ['firebase-admin/app', 'firebase-admin/firestore',
      'firebase-admin/auth']) {
      assert.equal(code.includes("require('" + spec + "')"), false,
        'require(' + spec + ') is what caused ERR_REQUIRE_ESM in production');
      assert.equal(code.includes('require("' + spec + '")'), false, spec);
    }
  });

  test('all three use literal import(), consistently', () => {
    for (const spec of ['firebase-admin/app', 'firebase-admin/firestore',
      'firebase-admin/auth']) {
      assert.ok(code.includes("import('" + spec + "')"),
        'expected a literal dynamic import of ' + spec);
    }
  });

  test('every specifier is a literal string, never a variable', () => {
    const dynamicImport = code.match(/[^.\w]import\(\s*(?!['"])/g) || [];
    assert.equal(dynamicImport.length, 0,
      'import(someVariable) cannot be traced into a function bundle: '
      + JSON.stringify(dynamicImport));
    const dynamicRequire = code.match(/require\(\s*(?!['"])/g) || [];
    assert.equal(dynamicRequire.length, 0, JSON.stringify(dynamicRequire));
    assert.ok(code.includes("import('firebase-admin/app')"),
      'the comment-stripper must not have eaten the real code');
  });

  test('the imports sit together in one loader, not scattered', () => {
    assert.ok(code.includes('async function importSdk()'));
    const loader = code.slice(code.indexOf('async function importSdk()'));
    for (const spec of ['app', 'firestore', 'auth']) {
      assert.ok(loader.slice(0, 900).includes("import('firebase-admin/" + spec + "')"),
        spec + ' must be loaded by the shared loader');
    }
  });

  test('nothing loads the removed pre-v14 monolithic namespace', () => {
    assert.equal(code.includes("require('firebase-admin')"), false,
      'firebase-admin 14 has no single-namespace export');
    assert.equal(code.includes("import('firebase-admin')"), false);
  });
});

/* ============================ LOADING NEEDS NO CREDENTIALS, INIT IS LAZY */
describe('module loading needs no credentials and initialises nothing', () => {
  test('the SDK modules load with no credentials present', async () => {
    /* Importing api/_chat/firebase-admin.js at the top of this file loaded
       them, with no FIREBASE_* variable set anywhere in this test run. */
    for (const v of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY']) {
      assert.equal(process.env[v], undefined, v + ' must not be set for this test');
    }
    const result = await FB.loadSdk();
    assert.equal(result.ok, true, 'reason: ' + result.reason);
    assert.equal(typeof result.sdk.app.initializeApp, 'function');
    assert.equal(typeof result.sdk.firestore.getFirestore, 'function');
    assert.equal(typeof result.sdk.auth.getAuth, 'function',
      'THE MODULE THAT FAILED IN PRODUCTION');
  });

  test('loadSdk() does not create an app, and imports only once', async () => {
    const appMod = (await FB.loadSdk()).sdk.app;
    const before = appMod.getApps().length;
    const a = FB.loadSdk(); const b = FB.loadSdk();
    assert.equal(a, b, 'the load promise must be memoised, not re-run');
    await a; await b;
    assert.equal(appMod.getApps().length, before,
      'loading the library must not initialise Firebase');
  });

  test('initialisation is still lazy: no env read at import time', () => {
    /* A fresh child process imports the module with an empty environment. If
       anything credential-related ran at import, this would throw. */
    const script =
      "const m = require('" + ROOT + "/api/_chat/firebase-admin.js');" +
      "m.loadSdk().then(async (r) => {" +
      "  if (!r.ok) throw new Error('sdk load failed: ' + r.reason);" +
      "  const app = (await import('firebase-admin/app'));" +
      "  if (app.getApps().length !== 0) throw new Error('app created by loading');" +
      "  console.log('IMPORT_OK ' + m.describeRuntime());" +
      "});";
    const env = Object.assign({}, process.env);
    for (const v of ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_PRIVATE_KEY', 'CHAT_RATE_LIMIT_SECRET']) delete env[v];

    const out = execFileSync(process.execPath, ['-e', script],
      { cwd: ROOT, encoding: 'utf8', env: env });
    assert.match(out, /^IMPORT_OK /, out);
    assert.match(out, /sdk_app:1,sdk_firestore:1,sdk_auth:1,sdk_code:none/,
      'all three modules must load with no configuration at all');
  });

  test('repeated initAdmin calls reuse one app rather than duplicating it', async () => {
    FB._reset();
    let inits = 0;
    const sdk = {
      app: {
        getApps: () => [],
        cert: (c) => ({ cert: c }),
        initializeApp: () => { inits += 1; return { name: '[FAKE]' }; }
      },
      firestore: { getFirestore: () => ({ fake: true }) },
      auth: { getAuth: () => ({ fake: true }) }
    };
    const env = {
      FIREBASE_PROJECT_ID: FB.EXPECTED_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: 'x@esther-s-chat.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\n'
        + 'Tk9ULUEtUkVBTC1LRVktcGxhY2Vob2xkZXItZm9yLXRlc3Rz\\n'
        + '-----END PRIVATE KEY-----\\n'
    };
    const a = await FB.initAdmin({ env, sdk });
    const b = await FB.initAdmin({ env, sdk });
    const c = await FB.initAdmin({ env, sdk });
    assert.equal(inits, 1, 'a warm instance must not build a second app');
    assert.equal(a, b); assert.equal(b, c);
    assert.equal(a.projectId, FB.EXPECTED_PROJECT_ID);
    FB._reset();
  });

  test('the project guard is still a hardcoded constant', () => {
    assert.equal(FB.EXPECTED_PROJECT_ID, 'esther-s-chat');
    const source = fs.readFileSync(ROOT + '/api/_chat/firebase-admin.js', 'utf8');
    assert.match(source, /const EXPECTED_PROJECT_ID = 'esther-s-chat';/);
  });
});

/* ================================= THE SHARPENED MODULE-FAILURE DIAGNOSTIC */
describe('a module failure now names itself precisely', () => {
  test('the runtime line reports Node and which modules loaded', async () => {
    await FB.loadSdk();
    const runtime = FB.describeRuntime();
    assert.match(runtime,
      /^node:\d{1,3},sdk_app:[01],sdk_firestore:[01],sdk_auth:[01],sdk_code:[A-Za-z_]+$/,
      runtime);
    assert.match(runtime, /sdk_app:1,sdk_firestore:1,sdk_auth:1,sdk_code:none/);
  });

  test('the Node major version is visible, which settles the >=22 question', async () => {
    const major = Number(FB.describeRuntime().match(/^node:(\d+)/)[1]);
    assert.equal(major, Number(process.versions.node.split('.')[0]));
    assert.ok(major >= 22, 'this test run itself satisfies firebase-admin 14');
  });

  test('the runtime line contains nothing sensitive', async () => {
    await FB.loadSdk();
    const runtime = FB.describeRuntime();
    for (const secret of ['esther-s-chat', 'PRIVATE', 'gserviceaccount', '@',
      'FIREBASE', 'secret']) {
      assert.equal(runtime.includes(secret), false, 'leaked: ' + secret);
    }
  });

  test('every per-module token is on the allow-list', () => {
    for (const which of ['app', 'firestore', 'auth']) {
      for (const suffix of ['_not_found', '_load_failed']) {
        assert.ok(FB.DIAGNOSTIC_TOKENS.includes('firebase_admin_' + which + suffix),
          which + suffix);
      }
    }
    assert.ok(FB.DIAGNOSTIC_TOKENS.includes('firebase_admin_module_missing'),
      'kept available, as the previous deployment emitted it');
  });

  test('not-found and threw-while-loading are different tokens', () => {
    /* The whole point: these have different fixes. "Not found" is a
       packaging problem; "load failed" is usually the runtime being wrong
       for the package - firebase-admin 14 needs Node >= 22. */
    assert.notEqual('firebase_admin_app_not_found', 'firebase_admin_app_load_failed');
    const source = fs.readFileSync(ROOT + '/api/_chat/firebase-admin.js', 'utf8');
    assert.ok(source.includes("NOT_FOUND_CODES.indexOf(code) !== -1"),
      'the split must be driven by the error code');
    assert.ok(source.includes("'MODULE_NOT_FOUND'"));
    assert.ok(source.includes("'ERR_PACKAGE_PATH_NOT_EXPORTED'"));
  });

  test('the code classifier is declared before the loader that uses it', () => {
    /* NOT_FOUND_CODES is a const, so reaching noteModuleFailure() before its
       initialiser would hit the temporal dead zone - and only ever on the
       failure path, which is exactly when the diagnostic is needed. */
    const source = fs.readFileSync(ROOT + '/api/_chat/firebase-admin.js', 'utf8');
    assert.ok(source.indexOf('const NOT_FOUND_CODES')
      < source.indexOf("import('firebase-admin/app')"),
      'the constants must be initialised before any load can fail');
  });
});
