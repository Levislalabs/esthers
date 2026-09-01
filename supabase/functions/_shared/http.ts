/**
 * Response helpers, and the one place errors are turned into HTTP.
 *
 * The rule that matters here: a caller learns whether their request was
 * well-formed and whether they are allowed, and nothing else. No database
 * error text, no stack trace, no hint about whether a conversation id
 * exists. "Not found" and "wrong token" deliberately return the same
 * thing, so the endpoint cannot be used to test which ids are real.
 */

import { corsHeaders } from './cors.ts';
import { ValidationError } from './validate.ts';

export function json(
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8',
      // These endpoints return per-caller private data. Nothing about them
      // should ever sit in a shared cache.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export function fail(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

/** The single generic message used for every access failure. */
export const DENIED = 'That conversation could not be found, or the link has expired.';

/**
 * Turn a thrown value into a response.
 *
 * ValidationError carries a message written for a person and is safe to
 * show. Anything else is unexpected: it is logged for us (without any
 * request body, which could contain a token) and reported to the caller as
 * a bare 500.
 */
export function handleError(err: unknown, origin: string | null): Response {
  if (err instanceof ValidationError) {
    return fail(err.message, err.status, origin);
  }
  // Log the type and message only. Never the request, never headers,
  // never a token.
  console.error('unhandled error:', err instanceof Error ? err.message : String(err));
  return fail('Something went wrong. Please try again.', 500, origin);
}

/** Reject anything that is not the method this endpoint accepts. */
export function requirePost(req: Request, origin: string | null): Response | null {
  if (req.method !== 'POST') {
    return fail('Method not allowed.', 405, origin);
  }
  return null;
}

/**
 * The caller's IP, for rate limiting.
 *
 * x-forwarded-for is set by Supabase's edge in front of the function. A
 * client can add its own header, so the LAST entry is not trustworthy;
 * the first entry is the one the edge saw. This is good enough to slow
 * down casual abuse and is not claimed to be more than that - see
 * docs/CHAT_BACKEND.md.
 */
export function callerIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}
