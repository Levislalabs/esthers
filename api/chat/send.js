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

const OPTIONS = {
  route: 'chat/send',
  methods: ['POST'],
  actor: 'customer',
  needsRateSecret: true,
  run: async (ctx) => {
    const input = V.validateSend(ctx.body);

    await RL.consume(ctx.db, 'send_uid', ctx.actor.uid, ctx.rateSecret);
    if (ctx.ip) await RL.consume(ctx.db, 'send_ip', ctx.ip, ctx.rateSecret);

    const result = await S.sendCustomerMessage(ctx.db, ctx.deps, {
      customerUid: ctx.actor.uid,
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
