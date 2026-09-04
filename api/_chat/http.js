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

  let originHost;
  try { originHost = new URL(origin).host; } catch (err) { return false; }
  return originHost === host;
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
 * The effective client address, from the proxy headers Vercel sets.
 *
 * This value is HMAC'd before it is stored and is never logged. It is used
 * only as a rate-limit dimension, never as identity: a shared office NAT puts
 * many people behind one address, and a determined caller can change theirs.
 */
function clientIp(req) {
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) {
    /* Left-most entry is the original client; the rest were added by proxies. */
    const first = forwarded.split(',')[0].trim();
    if (first) return normaliseIp(first);
  }
  const real = header(req, 'x-real-ip');
  if (real) return normaliseIp(real);
  const socket = req.socket && req.socket.remoteAddress;
  return socket ? normaliseIp(socket) : null;
}

function normaliseIp(raw) {
  let ip = String(raw).trim().toLowerCase();
  /* IPv4-mapped IPv6, so 1.2.3.4 and ::ffff:1.2.3.4 share a bucket. */
  if (ip.indexOf('::ffff:') === 0) ip = ip.slice(7);
  /* Strip a port if one came along, and the brackets around a literal v6. */
  if (ip.indexOf('[') === 0) {
    const close = ip.indexOf(']');
    if (close !== -1) ip = ip.slice(1, close);
  } else if ((ip.match(/:/g) || []).length === 1) {
    ip = ip.split(':')[0];
  }
  return ip.slice(0, 64) || null;
}

module.exports = {
  PRODUCTION_ORIGINS, MAX_BODY_CHARS,
  baseHeaders, sameOrigin, header, fail, ok, methodAllowed, parseBody,
  clientIp, normaliseIp
};
