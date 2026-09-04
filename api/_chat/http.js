/*
 * HTTP plumbing shared by every chat endpoint.
 *
 * Files and directories under api/ whose name begins with an underscore are
 * not turned into routes, which is how api/_lib.js already works in
 * production. Nothing in this directory is reachable as an endpoint.
 *
 * Nothing here holds a secret. That is deliberate and worth keeping: it
 * means source exposure, were it ever to happen, would leak design rather
 * than credentials.
 */

'use strict';

const net = require('net');

/* The addresses the finished site answers on. A request whose Origin is not
   one of these, and does not match the host actually serving the request, is
   refused - see sameOrigin(). */
const PRODUCTION_ORIGINS = [
  'https://www.esthers.ca',
  'https://esthers.ca'
];

/* Nothing a chat endpoint returns should ever sit in a cache: transcripts
   are private and the readiness of the service changes. */
function baseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  /* No Access-Control-Allow-Origin of any kind. These are same-origin APIs;
     emitting a CORS header - even a specific one - would only widen what a
     browser is willing to do with them. */
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/*
 * Same-origin policy.
 *
 * A browser attaches Origin to every cross-origin request and to same-origin
 * non-GET requests, so it is a usable signal - but only a negative one. A
 * request WITHOUT Origin is not thereby trusted: it is simply not a browser
 * making a cross-site call, and Firebase authentication still has to pass.
 * Origin is never an authentication mechanism here.
 *
 * Matching against the request's own host, rather than a fixed list, is what
 * lets a Vercel Preview deployment work without anybody enumerating preview
 * hostnames - the preview page and the preview API share a host, so they
 * match each other.
 */
function sameOrigin(req) {
  const origin = header(req, 'origin');
  if (!origin) return true;                       /* not a cross-site browser call */

  if (PRODUCTION_ORIGINS.indexOf(origin) !== -1) return true;

  const host = header(req, 'x-forwarded-host') || header(req, 'host');
  if (!host) return false;

  let url;
  try { url = new URL(origin); } catch (err) { return false; }

  /* Host comparison, not prefix or suffix matching. www.esthers.ca and
     www.esthers.ca.attacker.example are different hosts, and any check that
     used indexOf or endsWith here would accept the second one. URL also
     normalises a default port away, so https://www.esthers.ca:443 and
     www.esthers.ca are the same host. */
  if (url.host !== host) return false;

  /* An origin is scheme + host + port, so the same host over a different
     scheme is a DIFFERENT origin. Vercel serves https, so https is the only
     scheme a real deployment can present; http is accepted solely for a
     local development host, where there is no TLS to speak of. */
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && isLocalHostname(url.hostname)) return true;
  return false;
}

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
    || hostname === '::1';
}

function header(req, name) {
  const v = req.headers ? req.headers[name] : undefined;
  /* A repeated header arrives as an array. Anything ambiguous is refused
     rather than guessed at. */
  if (Array.isArray(v)) return v.length === 1 ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

/*
 * The client-facing error shape. `code` is a short stable token the future UI
 * can branch on; `error` is the sentence a person reads. Neither ever carries
 * a stack trace, a Firebase message, or anything about what exists on the
 * server.
 */
function fail(res, status, code, message, extra) {
  baseHeaders(res);
  return res.status(status).json(
    Object.assign({ ok: false, code: code, error: message }, extra || {}));
}

function ok(res, payload) {
  baseHeaders(res);
  return res.status(200).json(Object.assign({ ok: true }, payload));
}

/*
 * Method gate. Returns true when the request may proceed.
 */
function methodAllowed(req, res, allowed) {
  if (allowed.indexOf(req.method) !== -1) return true;
  res.setHeader('Allow', allowed.join(', '));
  fail(res, 405, 'method_not_allowed', 'Method not allowed.');
  return false;
}

/*
 * Body parsing. Vercel parses application/json for us, but a handler must
 * still cope with a string body (some runtimes) and with nonsense.
 */
const MAX_BODY_CHARS = 64 * 1024;

function parseBody(req) {
  let body = req.body;
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_CHARS) return null;
    try { body = JSON.parse(body); } catch (err) { return null; }
  }
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  return body;
}

/*
 * The effective client address.
 *
 * WHICH HEADER, AND WHY THE ORDER MATTERS
 *
 * x-vercel-forwarded-for is set by Vercel's edge and cannot be supplied by
 * the caller, so it is preferred. x-forwarded-for is also overwritten by
 * Vercel rather than appended to, which is what stops a browser sending its
 * own chain - but it is a header every proxy in the world also writes, so it
 * is the fallback rather than the first choice. x-real-ip is last, and is
 * only reached if neither of the above parses.
 *
 * The final fallback is the socket address, which no client can forge.
 *
 * A CANDIDATE THAT DOES NOT PARSE IS SKIPPED, NOT USED. Taking the left-most
 * element of an attacker-supplied comma list and storing whatever it happens
 * to contain is the classic version of this bug; here every candidate must
 * survive net.isIP() before it is accepted, and a header full of nonsense
 * simply falls through to the next source.
 *
 * OPERATIONAL CAVEAT: this ordering describes traffic reaching Vercel
 * directly (DNS-only, or Cloudflare in DNS-only mode). If Esther's traffic is
 * ever put behind another reverse proxy IN FRONT OF Vercel, the effective
 * client-IP semantics must be re-verified before trusting any of these
 * headers - a proxy that appends rather than overwrites changes which element
 * of the chain is the real client. Nothing here trusts cf-connecting-ip,
 * because this project's topology does not currently include a proxy that
 * sets it, and trusting a header no trusted hop writes is how spoofing works.
 *
 * The result is HMAC'd before it is stored and is never logged. It is used
 * only as a rate-limit dimension, never as identity: a shared office NAT puts
 * many people behind one address, and a determined caller can change theirs.
 */
const ADDRESS_HEADERS = ['x-vercel-forwarded-for', 'x-forwarded-for', 'x-real-ip'];

function clientIp(req) {
  for (const name of ADDRESS_HEADERS) {
    const raw = header(req, name);
    if (!raw) continue;
    /* Left-most entry is the original client; anything after it was added by
       a proxy. On Vercel this list is written by the platform. */
    const ip = normaliseIp(raw.split(',')[0]);
    if (ip) return ip;
  }
  const socket = req.socket && req.socket.remoteAddress;
  return socket ? normaliseIp(socket) : null;
}

/*
 * Returns a canonical IP string, or null if the value is not an IP address.
 *
 * net.isIP() is the arbiter rather than a hand-written regular expression:
 * it is the same parser Node uses everywhere else, and an address format
 * nobody thought of is exactly what a regular expression gets wrong.
 */
function normaliseIp(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let ip = String(raw).trim().toLowerCase();
  if (!ip || ip.length > 64) return null;

  /* [2001:db8::1]:443 - brackets around a literal v6, with an optional port. */
  if (ip[0] === '[') {
    const close = ip.indexOf(']');
    if (close === -1) return null;
    ip = ip.slice(1, close);
  } else if ((ip.match(/:/g) || []).length === 1) {
    /* Exactly one colon means host:port, never a v6 literal. */
    ip = ip.slice(0, ip.indexOf(':'));
  }

  /* IPv4-mapped IPv6, so 1.2.3.4 and ::ffff:1.2.3.4 share one bucket rather
     than giving the same caller two allowances. */
  if (ip.indexOf('::ffff:') === 0 && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);

  return net.isIP(ip) ? ip : null;
}

module.exports = {
  PRODUCTION_ORIGINS, MAX_BODY_CHARS, ADDRESS_HEADERS,
  baseHeaders, sameOrigin, isLocalHostname, header, fail, ok, methodAllowed,
  parseBody, clientIp, normaliseIp
};
