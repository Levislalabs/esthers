/**
 * The customer's conversation token.
 *
 * A customer has no account and no password. The token IS their identity:
 * whoever holds it can read and write that one conversation, and nothing
 * else. That makes it a bearer credential, and it gets the handling one
 * deserves.
 *
 * The rules, all enforced below or by the callers:
 *
 *   - 32 bytes from the platform CSPRNG. Never Math.random(), which is
 *     seeded predictably and is not a security primitive.
 *   - Returned to the browser exactly once, by chat-start.
 *   - Only its SHA-256 hash is written to the database. A dump of
 *     chat_conversations therefore contains nothing that can be replayed.
 *   - Never logged, never echoed in an error, never put in a URL (URLs
 *     end up in server logs, Referer headers and browser history).
 *   - Compared in constant time, so a caller cannot learn the hash one
 *     byte at a time from response timing.
 */

const TOKEN_BYTES = 32; // 256 bits of entropy

/**
 * A fresh token, base64url encoded so it is safe in a header or a JSON
 * body without escaping. 32 bytes becomes 43 characters.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** SHA-256 of the token, lower-case hex. This is what the database stores. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hex(new Uint8Array(digest));
}

/**
 * Constant-time string comparison.
 *
 * Both inputs here are fixed-length hex digests, so length is not secret;
 * we still fold length into the result rather than returning early, and we
 * compare every byte regardless of where the first difference is.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // Compare over the longer of the two so the loop count does not reveal
  // which input was shorter.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Shape check before a token is used for anything.
 *
 * Cheap, and it means a malformed value is rejected before it reaches the
 * database or the hash function.
 */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 40 && value.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

/* ----------------------------------------------------------------- utils */

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
