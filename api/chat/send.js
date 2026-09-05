/*
 * POST /api/chat/send
 *
 * Appends a customer message to a conversation they own and that is open.
 * A conversation that does not exist and one belonging to somebody else
 * produce the same response, so an id cannot be probed for existence.
 */

'use strict';

const H = require('../_chat/http.js');
const RL = require('../_chat/rate-limit.js');
const V = require('../_chat/validation.js');
const S = require('../_chat/service.js');
const { createHandler } = require('../_chat/handler.js');
const { runStage } = require('../_chat/stages.js');

const OPTIONS = {
  route: 'chat/send',
  methods: ['POST'],
  actor: 'customer',
  needsRateSecret: true,
  run: async (ctx) => {
    const input = await runStage('request_validation_failed',
      () => V.validateSend(ctx.body));
    const request = {
      customerUid: ctx.actor.uid,      /* verified token, never the body */
      conversationId: input.conversationId,
      message: input.message,
      clientMessageId: input.clientMessageId
    };

    /* A retry of a message already stored spends the replay allowance rather
       than the send allowance. A NEW message never takes this path, so an
       invented idempotency key cannot be used to skip the send limit. */
    const replay = await runStage('idempotency_lookup_failed',
      () => S.peekMessage(ctx.db, request));
    if (replay) {
      await runStage('rate_limit_check_failed',
        () => RL.consume(ctx.db, 'replay_uid', ctx.actor.uid, ctx.rateSecret));
      return H.ok(ctx.res,
        { messageId: replay.messageId, conversationId: input.conversationId });
    }

    await runStage('rate_limit_check_failed',
      () => RL.consume(ctx.db, 'send_uid', ctx.actor.uid, ctx.rateSecret));
    if (ctx.ip) {
      await runStage('rate_limit_check_failed',
        () => RL.consume(ctx.db, 'send_ip', ctx.ip, ctx.rateSecret));
    }

    const result = await runStage('chat_send_transaction_failed',
      () => S.sendCustomerMessage(ctx.db, ctx.deps, request));

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
