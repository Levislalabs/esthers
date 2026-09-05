/*
 * POST /api/admin/chat/close
 *
 * Marks a conversation closed. Idempotent - closing an already-closed thread
 * succeeds, because a double-clicked button should not look like a failure.
 * Nothing is deleted; retention is a separate, later decision.
 */

'use strict';

const H = require('../../_chat/http.js');
const RL = require('../../_chat/rate-limit.js');
const V = require('../../_chat/validation.js');
const S = require('../../_chat/service.js');
const { createHandler } = require('../../_chat/handler.js');
const { runStage } = require('../../_chat/stages.js');

const OPTIONS = {
  route: 'admin/chat/close',
  methods: ['POST'],
  actor: 'staff',
  needsRateSecret: true,
  run: async (ctx) => {
    V.requireNoPrivilegedFields(ctx.body);
    const conversationId = V.validConversationId(ctx.body.conversationId);

    await runStage('rate_limit_check_failed',
      () => RL.consume(ctx.db, 'staff_write', ctx.actor.uid, ctx.rateSecret));

    const result = await runStage('chat_close_transaction_failed',
      () => S.closeConversation(ctx.db, ctx.deps, { conversationId }));
    return H.ok(ctx.res, {
      conversationId: result.conversationId,
      status: result.status
    });
  }
};

module.exports = createHandler(OPTIONS);

/* Tests build the same handler with injected dependencies - a Firestore
   pointed at the emulator and a stand-in token verifier - so every branch
   can be exercised without a real Firebase project, a real token or a real
   staff password. Production always uses the export above. */
module.exports.forTest = (deps) =>
  createHandler(Object.assign({}, OPTIONS, { deps: deps }));
