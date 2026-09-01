/**
 * Allowed origins, in one place so the list can be audited at a glance.
 *
 * These endpoints carry bearer credentials - the customer's conversation
 * token, or a staff JWT - so `Access-Control-Allow-Origin: *` is not an
 * option. A wildcard would let any page on the internet call them with the
 * visitor's credentials attached.
 *
 * The origin is echoed back only when it is on this list, and the response
 * always carries `Vary: Origin` so a cache can never hand one site's
 * CORS decision to another.
 */

/** Origins allowed to call these functions. Add the live site here. */
export const ALLOWED_ORIGINS: readonly string[] = [
  // Local development of the static site.
  'http://localhost:8000',
  'http://127.0.0.1:8000',

  // The staff inbox during local development, if served on its own port.
  'http://localhost:8001',
  'http://127.0.0.1:8001',

  // TODO Phase 2B: add Esther's real origin(s) here before going live,
  // for example 'https://esthers.ca' and 'https://www.esthers.ca'.
  // Add the exact scheme + host + port. No trailing slash. No wildcards.
];

/**
 * Extra origins from the environment, so a deployment can add one without
 * a code change. Comma separated, exact origins only.
 */
function envOrigins(): string[] {
  const raw = Deno.env.get('CHAT_ALLOWED_ORIGINS') ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin) || envOrigins().includes(origin);
}

/**
 * CORS headers for a response.
 *
 * An origin that is not on the list gets no Access-Control-Allow-Origin
 * header at all, which is what makes the browser refuse the response. We
 * do not echo an unknown origin back, and we do not fall back to '*'.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-chat-token',
    'Access-Control-Max-Age': '600',
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin as string;
  }
  return headers;
}

/** Reply to a CORS preflight. */
export function preflight(origin: string | null): Response {
  // 204 with no body. An origin that is not allowed still gets a 204, but
  // without the Allow-Origin header, so the browser blocks the real call.
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
