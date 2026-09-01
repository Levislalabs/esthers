/**
 * chat-send - append a customer message to their own conversation.
 *
 * POST { conversationId, token, message }
 *   -> 201 { id, createdAt }
 *
 * Two things this endpoint must never do: accept a message for a
 * conversation the caller cannot prove they own, and tell an unauthorised
 * caller anything about whether that conversation exists.
 *
 * Phase 2A: not deployed, not called. The public chat UI remains a local
 * demo.
 */

import { preflight } from '../_shared/cors.ts';
import { json, fail, handleError, requirePost, callerIp, DENIED } from '../_shared/http.ts';
import { readJsonBody, requireUuid, requireMessageBody } from '../_shared/validate.ts';
import { serviceClient, rateLimit, ipBucket } from '../_shared/db.ts';
import { authenticateCustomer } from '../_shared/conversation.ts';

/** Per conversation, and a wider net per IP across all conversations. */
const PER_CONVERSATION_LIMIT = 20;
const PER_CONVERSATION_WINDOW = 300; // 5 minutes
const PER_IP_LIMIT = 40;
const PER_IP_WINDOW = 300;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);

  const wrongMethod = requirePost(req, origin);
  if (wrongMethod) return wrongMethod;

  try {
    const db = serviceClient();

    const ipKey = await ipBucket('chat-send', callerIp(req));
    if (!await rateLimit(db, ipKey, PER_IP_WINDOW, PER_IP_LIMIT)) {
      return fail('Too many messages. Please wait a moment.', 429, origin);
    }

    const body = await readJsonBody(req);
    const conversationId = requireUuid(body.conversationId, 'conversationId');
    const message = requireMessageBody(body.message);

    // Ownership is proved by the token, never by the id.
    const auth = await authenticateCustomer(db, conversationId, body.token);
    if (!auth.ok) {
      // Same message and same status whether the row is missing or the
      // token is wrong, so this cannot be used to probe for real ids.
      return fail(DENIED, 404, origin);
    }

    // A closed conversation is read-only. Staff close it deliberately;
    // reopening is their decision, not the customer's.
    if (auth.conversation.status === 'closed') {
      return fail('This conversation has been closed. Please start a new one.', 409, origin);
    }

    // Second limiter, keyed to the conversation itself, so one abusive
    // session cannot be spread across many IPs.
    const convKey = `chat-send:conv:${conversationId}`;
    if (!await rateLimit(db, convKey, PER_CONVERSATION_WINDOW, PER_CONVERSATION_LIMIT)) {
      return fail('Too many messages in this conversation. Please wait a moment.', 429, origin);
    }

    const { data, error } = await db
      .from('chat_messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'customer',
        body: message,
      })
      .select('id, created_at')
      .single();

    if (error || !data) {
      console.error('could not store message:', error?.message);
      return fail('Could not send the message. Please try again.', 500, origin);
    }

    return json({ id: data.id, createdAt: data.created_at }, 201, origin);
  } catch (err) {
    return handleError(err, origin);
  }
});
