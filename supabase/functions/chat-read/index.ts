/**
 * chat-read - return one customer's own transcript.
 *
 * POST { conversationId, token, since? }
 *   -> 200 { conversation, messages[] }
 *
 * The `since` parameter lets the browser poll for new messages without
 * re-downloading the whole thread. It never widens what is returned: the
 * conversation filter is applied first and is not negotiable.
 *
 * Phase 2A: not deployed, not called.
 */

import { preflight } from '../_shared/cors.ts';
import { json, fail, handleError, requirePost, callerIp, DENIED } from '../_shared/http.ts';
import { readJsonBody, requireUuid, ValidationError } from '../_shared/validate.ts';
import { serviceClient, rateLimit, ipBucket } from '../_shared/db.ts';
import { authenticateCustomer } from '../_shared/conversation.ts';

/** Generous - polling is a normal, cheap read - but still bounded. */
const READ_LIMIT = 120;
const READ_WINDOW = 300; // 5 minutes

/** Ceiling on one response, so a long thread cannot be used as an amplifier. */
const MAX_MESSAGES = 200;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);

  const wrongMethod = requirePost(req, origin);
  if (wrongMethod) return wrongMethod;

  try {
    const db = serviceClient();

    const ipKey = await ipBucket('chat-read', callerIp(req));
    if (!await rateLimit(db, ipKey, READ_WINDOW, READ_LIMIT)) {
      return fail('Too many requests. Please wait a moment.', 429, origin);
    }

    const body = await readJsonBody(req);
    const conversationId = requireUuid(body.conversationId, 'conversationId');

    const auth = await authenticateCustomer(db, conversationId, body.token);
    if (!auth.ok) return fail(DENIED, 404, origin);

    // Optional incremental cursor.
    let since: string | null = null;
    if (body.since !== undefined && body.since !== null && body.since !== '') {
      if (typeof body.since !== 'string' || Number.isNaN(Date.parse(body.since))) {
        throw new ValidationError('since must be an ISO timestamp.');
      }
      since = new Date(body.since).toISOString();
    }

    // The conversation filter is applied unconditionally. `since` only
    // ever narrows this further; it cannot reach another conversation.
    let query = db
      .from('chat_messages')
      .select('id, sender_type, body, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(MAX_MESSAGES);

    if (since) query = query.gt('created_at', since);

    const { data: messages, error } = await query;
    if (error) {
      console.error('could not read messages:', error.message);
      return fail('Could not load the conversation. Please try again.', 500, origin);
    }

    // Best effort: record that the customer has caught up. A failure here
    // must not fail the read.
    await db
      .from('chat_conversations')
      .update({ customer_last_read_at: new Date().toISOString() })
      .eq('id', conversationId);

    return json(
      {
        conversation: {
          id: auth.conversation.id,
          status: auth.conversation.status,
          createdAt: auth.conversation.created_at,
          lastMessageAt: auth.conversation.last_message_at,
        },
        messages: (messages ?? []).map((m) => ({
          id: m.id,
          senderType: m.sender_type,
          body: m.body,
          createdAt: m.created_at,
        })),
      },
      200,
      origin,
    );
  } catch (err) {
    return handleError(err, origin);
  }
});
