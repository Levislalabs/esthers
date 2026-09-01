/**
 * Database clients, and the rate limiter that sits in front of them.
 *
 * Two clients, for two different jobs:
 *
 *   serviceClient()  - full access, bypasses RLS. This is how the customer
 *                      endpoints reach the tables at all, since anon has
 *                      no grants. The key it uses NEVER leaves the
 *                      function: it is read from the environment, is not
 *                      logged, and is not returned in any response.
 *
 *   userClient(jwt)  - acts as the signed-in staff member, so RLS applies
 *                      to them exactly as written. Used to verify who is
 *                      calling before the service client does anything.
 *
 * The environment variables below are injected by Supabase automatically
 * for a deployed function; for `supabase functions serve` they come from
 * supabase/.env, which is gitignored. There is no fallback and no default:
 * a missing key is a startup error, never a silent downgrade to a weaker
 * client.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.length === 0) {
    // Names only. Never the value.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Privileged client. Bypasses RLS - treat every query written with it as
 * security-critical, because the database will not second-guess it.
 *
 * Accepts either the new sb_secret_... key or the legacy service_role key,
 * whichever the project is configured with.
 */
export function serviceClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ??
              requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Client acting as the caller. Used only to resolve the JWT to a user;
 * all subsequent reads go through the service client after membership has
 * been confirmed.
 */
export function userClient(jwt: string): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ??
              requireEnv('SUPABASE_ANON_KEY');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/* ------------------------------------------------------------ rate limit */

/**
 * Fixed-window counter, held in Postgres.
 *
 * Real server-side state, not something the browser could forget. It is a
 * fixed window rather than a sliding one, which means a caller can spend
 * their allowance at the end of one window and again at the start of the
 * next. That is a known and accepted property at this scale; the goal is
 * to blunt scripted abuse, not to be a WAF.
 *
 * Returns true when the caller may proceed.
 */
export async function rateLimit(
  db: SupabaseClient,
  bucket: string,
  windowSeconds: number,
  limit: number,
): Promise<boolean> {
  const { data, error } = await db.rpc('chat_rate_limit_hit', {
    p_bucket: bucket,
    p_window_secs: windowSeconds,
    p_limit: limit,
  });
  if (error) {
    // Fail CLOSED. If the limiter cannot be consulted we would rather
    // refuse the request than leave the endpoint unprotected.
    console.error('rate limit check failed:', error.message);
    return false;
  }
  return data === true;
}

/**
 * A bucket key that identifies a caller without storing what identifies
 * them. The IP is hashed before it is written, so chat_rate_limits holds
 * no personal data even though it is keyed per visitor.
 */
export async function ipBucket(prefix: string, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return `${prefix}:ip:${hex}`;
}
