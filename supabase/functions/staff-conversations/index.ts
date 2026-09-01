/**
 * staff-conversations - read side of the staff inbox.
 *
 * POST { action: 'list',   status?, limit?, before? }
 *   -> 200 { conversations[] }
 * POST { action: 'detail', conversationId }
 *   -> 200 { conversation, messages[] }
 *
 * Read-only by design. Everything that changes state lives in
 * staff-actions, so a review of this file only has to ask "can the wrong
 * person see this?" and never "can the wrong person change this?".
 *
 * The customer token hash is never selected here, so it cannot leak into
 * a response even by accident.
 *
 * Phase 2A: not deployed.
 */

import { preflight } from '../_shared/cors.ts';
import { json, fail, handleError, requirePost } from '../_shared/http.ts';
import { readJsonBody, requireUuid, requireStatus, ValidationError } from '../_shared/validate.ts';
import { serviceClient } from '../_shared/db.ts';
import { requireActiveStaff } from '../_shared/staff.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_MESSAGES = 500;

/** Explicit column list. Adding a column to the table must not widen this. */
const CONVERSATION_COLUMNS =
  'id, status, created_at, updated_at, last_message_at, closed_at, ' +
  'staff_last_read_at, customer_last_read_at, ' +
  'customer_name, customer_email, customer_phone';

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);

  const wrongMethod = requirePost(req, origin);
  if (wrongMethod) return wrongMethod;

  try {
    const db = serviceClient();

    const auth = await requireActiveStaff(req, db);
    if (!auth.ok) return fail(auth.message, auth.status, origin);

    const body = await readJsonBody(req);
    const action = body.action;

    if (action === 'list') {
      let limit = DEFAULT_LIMIT;
      if (body.limit !== undefined) {
        const n = Number(body.limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
          throw new ValidationError(`limit must be a whole number between 1 and ${MAX_LIMIT}.`);
        }
        limit = n;
      }

      let query = db
        .from('chat_conversations')
        .select(CONVERSATION_COLUMNS)
        .order('last_message_at', { ascending: false })
        .limit(limit);

      if (body.status !== undefined && body.status !== null && body.status !== 'all') {
        query = query.eq('status', requireStatus(body.status));
      }

      // Keyset pagination on the same column the index is built for.
      if (body.before !== undefined && body.before !== null && body.before !== '') {
        if (typeof body.before !== 'string' || Number.isNaN(Date.parse(body.before))) {
          throw new ValidationError('before must be an ISO timestamp.');
        }
        query = query.lt('last_message_at', new Date(body.before).toISOString());
      }

      const { data, error } = await query;
      if (error) {
        console.error('could not list conversations:', error.message);
        return fail('Could not load conversations.', 500, origin);
      }
      return json({ conversations: data ?? [] }, 200, origin);
    }

    if (action === 'detail') {
      const conversationId = requireUuid(body.conversationId, 'conversationId');

      const { data: conversation, error: convError } = await db
        .from('chat_conversations')
        .select(CONVERSATION_COLUMNS)
        .eq('id', conversationId)
        .maybeSingle();

      if (convError) {
        console.error('could not load conversation:', convError.message);
        return fail('Could not load the conversation.', 500, origin);
      }
      if (!conversation) return fail('Conversation not found.', 404, origin);

      const { data: messages, error: msgError } = await db
        .from('chat_messages')
        .select('id, sender_type, body, created_at, staff_user_id')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(MAX_MESSAGES);

      if (msgError) {
        console.error('could not load messages:', msgError.message);
        return fail('Could not load the conversation.', 500, origin);
      }

      return json({ conversation, messages: messages ?? [] }, 200, origin);
    }

    throw new ValidationError("action must be 'list' or 'detail'.");
  } catch (err) {
    return handleError(err, origin);
  }
});
