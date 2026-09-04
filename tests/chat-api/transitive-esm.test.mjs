/*
 * The transitive ERR_REQUIRE_ESM: jwks-rsa 4 requiring jose 6.
 *
 * WHAT PRODUCTION SAID, AFTER we had already converted every one of OUR
 * firebase-admin loads to literal dynamic import():
 *
 *   chat: init failed [chat/start] firebase_admin_auth_load_failed
 *   runtime=node:22,sdk_app:1,sdk_firestore:1,sdk_auth:0,
 *   sdk_code:ERR_REQUIRE_ESM
 *
 * Unchanged. Which was the useful part: it proved the failing require() was
 * not ours.
 *
 * THE ACTUAL CHAIN
 *
 *   firebase-admin/auth
 *     -> firebase-admin/lib/auth/token-verifier.js
 *       -> firebase-admin/lib/utils/jwt.js
 *         -> jwks-rsa/src/index.js
 *           -> jwks-rsa/src/JwksClient.js
 *             -> jwks-rsa/src/utils.js  line 1:  const jose = require('jose');
 *
 * jwks-rsa 4.1.0 is type:"commonjs" and requires jose. Its nested jose 6 is
 * type:"module". require() of ESM throws ERR_REQUIRE_ESM unless the runtime
 * has Node's require(esm), which landed in 22.12 - and jwks-rsa's own engines
 * field says exactly that: "^20.19.0 || ^22.12.0 || >= 23.0.0".
 *
 * Our import() could never have fixed this. import() controls how WE load
 * firebase-admin; it cannot change a require() written inside a dependency
 * four levels down.
 *
 * THE FIX: a scoped npm override pinning jose to the 5.x line FOR jwks-rsa
 * ONLY. jose 5 ships a CommonJS build, so jwks-rsa's require() succeeds on
 * every Node 22 with no reliance on require(esm) at all.
 *
 * Mocks and real local crypto only. No production Firebase contact.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const require = createRequire('/home/user/esthers/');
const ROOT = '/home/user/esthers';

/* Runs a script in a child Node with native require(esm) DISABLED, which is
   how Vercel's Node 22.x below 22.12 behaves. This is the whole point: the
   fix must not depend on the runtime rescuing a bad require(). */
function inLegacyNode(script) {
  return execFileSync(process.execPath,
    ['--no-experimental-require-module', '--input-type=module', '-e', script],
    { cwd: ROOT, encoding: 'utf8' }).trim();
}

/* ============================================== THE OVERRIDE IS DECLARED */
describe('the scoped jose override', () => {
  const pkg = JSON.parse(fs.readFileSync(ROOT + '/package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync(ROOT + '/package-lock.json', 'utf8'));

  test('package.json pins jose for jwks-rsa, and only for jwks-rsa', () => {
    assert.deepEqual(pkg.overrides, { 'jwks-rsa': { jose: '^5.10.0' } },
      'the override must stay narrow - a bare "jose" key would repin it '
      + 'everywhere, including for packages that are fine on 6');
  });

  test('firebase-admin itself is NOT downgraded', () => {
    assert.equal(pkg.dependencies['firebase-admin'], '14.3.0',
      'the fix is one transitive pin, not a major-version retreat');
    assert.equal(pkg.dependencies['@vercel/blob'], '^2.8.0', 'quote flow untouched');
  });

  test('the lockfile resolves jwks-rsa to a 5.x jose', () => {
    const nested = lock.packages['node_modules/jwks-rsa/node_modules/jose'];
    const hoisted = lock.packages['node_modules/jose'];
    const effective = nested || hoisted;
    assert.ok(effective, 'jose must be in the lockfile');
    assert.match(effective.version, /^5\./,
      'jose 6 under jwks-rsa is the bug: got ' + effective.version);
    assert.notEqual(effective.dev, true, 'it is a production dependency');
  });

  test('jwks-rsa still declares ^6 - the override is what changes it', () => {
    const jwks = lock.packages['node_modules/jwks-rsa'];
    assert.equal(jwks.version, '4.1.0');
    assert.match(jwks.dependencies.jose, /\^6\./,
      'upstream still wants 6; we are deliberately overriding it');
  });
});

/* ================================================ THE INSTALLED TREE */
describe('the installed dependency tree', () => {
  test('the jose that jwks-rsa loads is CommonJS, not ESM-only', () => {
    const resolved = createRequire(ROOT + '/node_modules/jwks-rsa/src/utils.js')
      .resolve('jose');
    const root = resolved.replace(/(node_modules\/jose)\/.*/, '$1');
    const pkg = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'));
    assert.match(pkg.version, /^5\./, 'jwks-rsa must resolve jose 5');
    assert.notEqual(pkg.type, 'module',
      'type:"module" here is precisely what made require() throw');
  });

  test('the four jose functions jwks-rsa calls all exist in this version', () => {
    /* jwks-rsa/src/utils.js uses importJWK and exportSPKI;
       jwks-rsa/src/integrations/passport.js uses decodeJwt and
       decodeProtectedHeader. A pin that dropped any of these would break
       token verification rather than fix it. */
    const jose = createRequire(ROOT + '/node_modules/jwks-rsa/src/utils.js')('jose');
    for (const fn of ['importJWK', 'exportSPKI', 'decodeJwt', 'decodeProtectedHeader']) {
      assert.equal(typeof jose[fn], 'function', 'jose.' + fn + ' is missing');
    }
  });

  test('the require() that failed is still there upstream, unchanged', () => {
    /* We did not patch a dependency. If a future jwks-rsa switches to
       import(), this assertion is the reminder that the override can go. */
    const utils = fs.readFileSync(ROOT + '/node_modules/jwks-rsa/src/utils.js', 'utf8');
    assert.match(utils, /^const jose = require\('jose'\);/m,
      'the upstream CommonJS require of jose - the exact failing statement');
  });

  test('jwks-rsa is reached eagerly from firebase-admin/auth', () => {
    const out = execFileSync(process.execPath, ['-e',
      "require('firebase-admin/auth');"
      + "const f=Object.keys(require.cache).filter(k=>k.includes('node_modules/jwks-rsa'));"
      + "console.log(f.length);"], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.ok(Number(out) > 0,
      'auth loads jwks-rsa at import time, which is why the failure was at load');
  });
});

/* ====================== THE ACCEPTANCE GATE: require(esm) DISABLED */
describe('loading without Node require(esm) support', () => {
  test('THE GATE: all three modules import with require(esm) disabled', () => {
    const out = inLegacyNode(
      "const [a,f,u] = await Promise.all(["
      + "import('firebase-admin/app'),"
      + "import('firebase-admin/firestore'),"
      + "import('firebase-admin/auth')]);"
      + "console.log([typeof a.initializeApp, typeof f.getFirestore,"
      + " typeof u.getAuth, a.getApps().length].join('|'));");
    assert.equal(out, 'function|function|function|0',
      'this is the exact condition Vercel runs under, and the exact failure '
      + 'the production log reported');
  });

  test('and it needs no credentials and creates no app', () => {
    const out = inLegacyNode(
      "for (const v of ['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL',"
      + "'FIREBASE_PRIVATE_KEY']) if (process.env[v]) throw new Error('set: '+v);"
      + "const a = await import('firebase-admin/app');"
      + "await import('firebase-admin/auth');"
      + "console.log('apps=' + a.getApps().length);");
    assert.equal(out, 'apps=0');
  });

  test('our own loader reaches 401, not a module error, on that runtime', () => {
    const out = inLegacyNode(
      "const { createRequire } = await import('module');"
      + "const req = createRequire('" + ROOT + "/');"
      + "const crypto = await import('node:crypto');"
      + "process.env.FIREBASE_PROJECT_ID='esther-s-chat';"
      + "process.env.FIREBASE_CLIENT_EMAIL='x@esther-s-chat.iam.gserviceaccount.com';"
      + "process.env.FIREBASE_PRIVATE_KEY=crypto.generateKeyPairSync('rsa',"
      + "{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},"
      + "publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey.replace(/\\n/g,'\\\\n');"
      + "process.env.CHAT_RATE_LIMIT_SECRET='a-legacy-node-probe-secret-0123456789';"
      + "const h = req('" + ROOT + "/api/chat/start.js');"
      + "const res={statusCode:0,payload:null,headers:{},"
      + "status(c){this.statusCode=c;return this;},json(o){this.payload=o;return this;},"
      + "setHeader(){return this;},getHeader(){}};"
      + "await h({method:'POST',headers:{host:'www.esthers.ca'},body:{},query:{},"
      + "socket:{remoteAddress:'203.0.113.1'}}, res);"
      + "console.log(res.statusCode + ' ' + res.payload.code);");
    assert.equal(out, '401 missing_authorization',
      'the production acceptance gate');
  });
});

/* ================================ TOKEN VERIFICATION IS NOT WEAKENED */
describe('JWT verification still works, and still refuses', () => {
  test('jwks-rsa converts a real JWKS entry to SPKI using jose 5', async () => {
    /* This is the actual code path firebase-admin uses to turn Google's
       published JWKS into a key it can verify a signature with. If the pin
       had broken it, tokens would stop verifying - so it is exercised here
       with real crypto rather than assumed. */
    const utils = require('jwks-rsa/src/utils');
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });

    const keys = await utils.retrieveSigningKeys(
      [Object.assign({}, jwk, { kid: 'regression-kid', alg: 'RS256', use: 'sig' })]);

    assert.equal(keys.length, 1);
    assert.equal(keys[0].kid, 'regression-kid');
    const spki = keys[0].publicKey || keys[0].rsaPublicKey;
    assert.match(String(spki), /^-----BEGIN PUBLIC KEY-----/,
      'a real SPKI PEM, produced through jose 5');
  });

  test('the exported key actually verifies a signature made with its pair', async () => {
    /* Not just "a PEM came out" - it must be the RIGHT key. */
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const utils = require('jwks-rsa/src/utils');
    const jwk = publicKey.export({ format: 'jwk' });
    const keys = await utils.retrieveSigningKeys(
      [Object.assign({}, jwk, { kid: 'sig-kid', alg: 'RS256', use: 'sig' })]);
    const spki = keys[0].publicKey || keys[0].rsaPublicKey;

    const payload = Buffer.from('esthers chat signature check');
    const signature = crypto.sign('sha256', payload, privateKey);
    assert.equal(crypto.verify('sha256', payload, spki, signature), true,
      'the round-tripped key must verify a genuine signature');
    assert.equal(
      crypto.verify('sha256', Buffer.from('tampered'), spki, signature), false,
      'and must reject a tampered payload');
  });

  test('verifyIdToken still refuses malformed tokens', async () => {
    const { initializeApp, cert, getApps, deleteApp } =
      await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const name = 'verify-regression-' + Date.now();
    const app = initializeApp({
      credential: cert({ projectId: 'esther-s-chat',
        clientEmail: 'x@esther-s-chat.iam.gserviceaccount.com', privateKey }),
      projectId: 'esther-s-chat'
    }, name);

    const auth = getAuth(app);
    for (const bad of ['garbage', 'a.b.c', '', 'Bearer x']) {
      await assert.rejects(() => auth.verifyIdToken(bad),
        'a malformed token must never be accepted: ' + JSON.stringify(bad));
    }
    /* An unsigned "alg: none" token is the classic bypass. */
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      + '.' + Buffer.from(JSON.stringify({ sub: 'attacker', aud: 'esther-s-chat' }))
        .toString('base64url') + '.';
    await assert.rejects(() => auth.verifyIdToken(none),
      'an unsigned token must be refused');

    await deleteApp(getApps().find((a) => a.name === name));
  });

  test('no custom JWT verification was introduced anywhere in our code', () => {
    /* The fix is a dependency pin. If this ever starts failing, somebody has
       written their own verifier, which is the one thing that must not
       happen here. */
    const FORBIDDEN = ['jsonwebtoken', 'jwks-rsa', "require('jose')",
      "import('jose')", 'decodeJwt', 'createVerify', 'createPublicKey'];
    for (const file of ['auth.js', 'handler.js', 'firebase-admin.js',
      'service.js', 'validation.js', 'http.js', 'rate-limit.js']) {
      /* Comments stripped: this codebase discusses jose and jwks-rsa at
         length in prose, and matching that would make the test lie. */
      const code = fs.readFileSync(ROOT + '/api/_chat/' + file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of FORBIDDEN) {
        assert.equal(code.includes(forbidden), false,
          file + ' must not do its own JWT work: ' + forbidden);
      }
    }
    const auth = fs.readFileSync(ROOT + '/api/_chat/auth.js', 'utf8');
    assert.ok(auth.includes('verifyIdToken'),
      'verification stays delegated to the Admin SDK');
  });
});
