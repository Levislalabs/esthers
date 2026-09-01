/**
 * chat-start - open a new conversation.
 *
 * POST { name?, email?, phone?, message? }
 *   -> 201 { conversationId, token, createdAt }
 *
 * THE TOKEN IS RETURNED HERE AND NOWHERE ELSE, EVER AGAIN. Only its
 * SHA-256 hash is written to the database, so it cannot be looked up,
 * recovered or re-sent. If the customer loses it, the conversation is gone
 * to them and a new one has to be started. That is the intended trade:
 * a conversation cannot be reopened by anyone who merely knows an id.
 *
 * Phase 2A: deployed by nobody and called by nobody. The public chat UI is
 * still the local demo and is not wired to this.
 */

import { preflight } from '../_shared/cors.ts';
import { json, fail, handleError, requirePost, callerIp } from '../_shared/http.ts';
import { readJsonBody, optionalText, optionalEmail, requireMessageBody,
         MAX_NAME_CHARS, MAX_PHONE_CHARS } from '../_shared/validate.ts';
import { generateToken, hashToken } from '../_shared/token.ts';
import { serviceClient, rateLimit, ipBucket } from '../_shared/db.ts';

/** New conversations allowed from one IP in a ten minute window. */
const START_LIMIT = 5;
const START_WINDOW_SECONDS = 600;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return preflight(origin);

  const wrongMethod = requirePost(req, origin);
  if (wrongMethod) return wrongMethod;

  try {
    const db = serviceClient();

    // Limit before doing any work, and before touching the body.
    const bucket = await ipBucket('chat-start', callerIp(req));
    if (!await rateLimit(db, bucket, START_WINDOW_SECONDS, START_LIMIT)) {
      return fail('Too many conversations started. Please wait a few minutes.', 429, origin);
    }

    const body = await readJsonBody(req);

    // All contact details optional: a visitor can ask a question without
    // handing over anything about themselves.
    const name  = optionalText(body.name, 'Name', MAX_NAME_CHARS);
    const email = optionalEmail(body.email);
    const phone = optionalText(body.phone, 'Phone', MAX_PHONE_CHARS);

    // An opening message is optional too, but if one is present it must be
    // a real message.
    const firstMessage = body.message === undefined || body.message === null || body.message === ''
      ? null
      : requireMessageBody(body.message);

    const token = generateToken();
    const tokenHash = await hashToken(token);

    const { data: conversation, error: insertError } = await db
      .from('chat_conversations')
      .insert({
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        customer_token_hash: tokenHash,
      })
      .select('id, created_at')
      .single();

    if (insertError || !conversation) {
      console.error('could not create conversation:', insertError?.message);
      return fail('Could not start the conversation. Please try again.', 500, origin);
    }

    if (firstMessage) {
      const { error: messageError } = await db.from('chat_messages').insert({
        conversation_id: conversation.id,
        sender_type: 'customer',
        body: firstMessage,
      });
      if (messageError) {
        // The conversation exists and the customer holds its token, so
        // this is recoverable by resending. Do not tear the row down.
        console.error('could not store opening message:', messageError.message);
      }
    }

    return json(
      { conversationId: conversation.id, token, createdAt: conversation.created_at },
      201,
      origin,
    );
  } catch (err) {
    return handleError(err, origin);
  }
});
