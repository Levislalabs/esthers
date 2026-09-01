/**
 * Resolving a customer's token to their conversation.
 *
 * Every customer endpoint funnels through authenticateCustomer(). Keeping
 * it in one place means the lookup rule, the constant-time comparison and
 * the deliberately uninformative failure all live together and cannot
 * drift apart between endpoints.
 *
 * The rule the whole customer side rests on:
 *
 *   the conversation id alone is NOT a credential.
 *
 * A row is fetched by id, then the presented token is hashed and compared
 * with the stored hash. Holding an id without the matching token gets you
 * exactly the same answer as holding an id that does not exist.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { hashToken, looksLikeToken, timingSafeEqual } from './token.ts';

export interface Conversation {
  id: string;
  status: 'open' | 'closed';
  created_at: string;
  last_message_at: string;
  customer_last_read_at: string | null;
}

export type AuthResult =
  | { ok: true; conversation: Conversation }
  | { ok: false };

export async function authenticateCustomer(
  db: SupabaseClient,
  conversationId: string,
  token: unknown,
): Promise<AuthResult> {
  // Shape first, so a malformed value never reaches the hash or the query.
  if (!looksLikeToken(token)) return { ok: false };

  const presented = await hashToken(token);

  const { data, error } = await db
    .from('chat_conversations')
    .select('id, status, created_at, last_message_at, customer_last_read_at, customer_token_hash')
    .eq('id', conversationId)
    .maybeSingle();

  if (error) {
    console.error('conversation lookup failed:', error.message);
    return { ok: false };
  }

  // No such conversation. Still hash and compare against a dummy value so
  // a missing row and a wrong token take a similar amount of work, and the
  // two cases cannot be told apart by timing.
  if (!data) {
    timingSafeEqual(presented, '0'.repeat(64));
    return { ok: false };
  }

  if (!timingSafeEqual(presented, data.customer_token_hash as string)) {
    return { ok: false };
  }

  // Never let the hash escape this module.
  const { customer_token_hash: _omit, ...conversation } = data as Record<string, unknown>;
  return { ok: true, conversation: conversation as unknown as Conversation };
}
