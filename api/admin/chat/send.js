/*
 * POST /api/admin/chat/send
 *
 * A staff reply. senderType is set by the server, never by the request, and
 * the staff member's uid is deliberately NOT written onto the message -
 * message documents are customer-readable and must stay at four fields.
 */

'use strict';

const H = require('../../_chat/http.js');
const RL = require('../../_chat/rate-limit.js');
const V = require('../../_chat/validation.js');
const S = require('../../_chat/service.js');
const { createHandler } = require('../../_chat/handler.js');

const OPTIONS = {
  route: 'admin/chat/send',
  methods: ['POST'],
  actor: 'staff',
  needsRateSecret: true,
  run: async (ctx) => {
    const input = V.validateSend(ctx.body);

    await RL.consume(ctx.db, 'staff_write', ctx.actor.uid, ctx.rateSecret);

    const result = await S.sendStaffMessage(ctx.db, ctx.deps, {
      conversationId: input.conversationId,
      message: input.message,
      clientMessageId: input.clientMessageId
    });

    return H.ok(ctx.res, { messageId: result.messageId, conversationId: input.conversationId });
  }
};

module.exports = createHandler(OPTIONS);

/* Tests build the same handler with injected dependencies - a Firestore
   pointed at the emulator and a stand-in token verifier - so every branch
   can be exercised without a real Firebase project, a real token or a real
   staff password. Production always uses the export above. */
module.exports.forTest = (deps) =>
  createHandler(Object.assign({}, OPTIONS, { deps: deps }));
