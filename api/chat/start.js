/*
 * POST /api/chat/start
 *
 * Opens a conversation and records its first message, in one transaction.
 * The customer's identity comes from the verified anonymous Firebase token;
 * nothing identifying is taken from the request body.
 */

'use strict';

const H = require('../_chat/http.js');
const RL = require('../_chat/rate-limit.js');
const V = require('../_chat/validation.js');
const S = require('../_chat/service.js');
const { createHandler } = require('../_chat/handler.js');

const OPTIONS = {
  route: 'chat/start',
  methods: ['POST'],
  actor: 'customer',
  needsRateSecret: true,
  run: async (ctx) => {
    const input = V.validateStart(ctx.body);

    /* Per-uid first: it is the cheaper bucket and the one an honest retry
       loop trips. The per-IP bucket is the one a fresh anonymous uid cannot
       escape. */
    await RL.consume(ctx.db, 'start_uid', ctx.actor.uid, ctx.rateSecret);
    if (ctx.ip) await RL.consume(ctx.db, 'start_ip', ctx.ip, ctx.rateSecret);

    const result = await S.startConversation(ctx.db, ctx.deps, {
      customerUid: ctx.actor.uid,
      name: input.name,
      email: input.email,
      message: input.message,
      clientMessageId: input.clientMessageId
    });

    /* An explicit allow-list. No customerUid, no email, no internal
       timestamps, no rate-limit state. */
    return H.ok(ctx.res, {
      conversationId: result.conversationId,
      messageId: result.messageId,
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
