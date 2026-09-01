/**
 * staff-actions - the write side of the staff inbox.
 *
 * POST { action: 'reply',      conversationId, message }
 * POST { action: 'mark-read',  conversationId }
 * POST { action: 'set-status', conversationId, status }
 *
 * Three operations, all "an authorised staff member changes one
 * conversation". Kept apart from staff-conversations so that everything
 * capable of writing sits in one small file.
 *
 * What is deliberately NOT here, and has no endpoint anywhere:
 *   - editing a message body        (the transcript is append-only)
 *   - deleting a message            (likewise)
 *   - posting as a customer         (sender_type is fixed to 'staff')
 *   - posting as another colleague  (staff_user_id is taken from the JWT)
 *   - touching customer_token_hash  (never written outside chat-start)
 *
 * Phase 2A: not deployed.
 */

import { preflight } from '../_shared/cors.ts';
import { json, fail, handleError, requirePost } from '../_shared/http.ts';
import { readJsonBody, requireUuid, requireMessageBody, requireStatus,
         ValidationError } from '../_shared/validate.ts';
import { serviceClient } from '../_shared/db.ts';
import { requireActiveStaff } from '../_shared/staff.ts';

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);

  const wrongMethod = requirePost(req, origin);
  if (wrongMethod) return wrongMethod;

  try {
    const db = serviceClient();

    const auth = await requireActiveStaff(req, db);
    if (!auth.ok) return fail(auth.message, auth.status, origin);
    const staffUserId = auth.staff.userId;

    const body = await readJsonBody(req);
    const conversationId = requireUuid(body.conversationId, 'conversationId');

    // The conversation must exist before any action touches it.
    const { data: conversation, error: convError } = await db
      .from('chat_conversations')
      .select('id, status')
      .eq('id', conversationId)
      .maybeSingle();

    if (convError) {
      console.error('conversation lookup failed:', convError.message);
      return fail('Could not load the conversation.', 500, origin);
    }
    if (!conversation) return fail('Conversation not found.', 404, origin);

    /* ------------------------------------------------------------ reply */
    if (body.action === 'reply') {
      const message = requireMessageBody(body.message);

      if (conversation.status === 'closed') {
        return fail('Reopen this conversation before replying.', 409, origin);
      }

      // sender_type and staff_user_id are set from the verified session,
      // never from the request body. Even a malicious staff client cannot
      // author a message as a customer or as a colleague.
      const { data, error } = await db
        .from('chat_messages')
        .insert({
          conversation_id: conversationId,
          sender_type: 'staff',
          staff_user_id: staffUserId,
          body: message,
        })
        .select('id, created_at')
        .single();

      if (error || !data) {
        console.error('could not store reply:', error?.message);
        return fail('Could not send the reply.', 500, origin);
      }

      // Replying implies having read it.
      await db
        .from('chat_conversations')
        .update({ staff_last_read_at: new Date().toISOString() })
        .eq('id', conversationId);

      return json({ id: data.id, createdAt: data.created_at }, 201, origin);
    }

    /* -------------------------------------------------------- mark-read */
    if (body.action === 'mark-read') {
      const { error } = await db
        .from('chat_conversations')
        .update({ staff_last_read_at: new Date().toISOString() })
        .eq('id', conversationId);

      if (error) {
        console.error('could not mark read:', error.message);
        return fail('Could not update the conversation.', 500, origin);
      }
      return json({ ok: true }, 200, origin);
    }

    /* ------------------------------------------------------- set-status */
    if (body.action === 'set-status') {
      const status = requireStatus(body.status);

      // closed_at is maintained by the database trigger, not set here, so
      // it always matches the status it describes.
      const { error } = await db
        .from('chat_conversations')
        .update({ status })
        .eq('id', conversationId);

      if (error) {
        console.error('could not change status:', error.message);
        return fail('Could not update the conversation.', 500, origin);
      }

      // A line in the transcript, so the customer and any colleague can
      // see what happened and when.
      await db.from('chat_messages').insert({
        conversation_id: conversationId,
        sender_type: 'system',
        body: status === 'closed'
          ? 'This conversation was closed by Esther’s.'
          : 'This conversation was reopened by Esther’s.',
      });

      return json({ ok: true, status }, 200, origin);
    }

    throw new ValidationError("action must be 'reply', 'mark-read' or 'set-status'.");
  } catch (err) {
    return handleError(err, origin);
  }
});
