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
const LOC = require('../_chat/locations.js');
const S = require('../_chat/service.js');
const { createHandler } = require('../_chat/handler.js');
const { runStage } = require('../_chat/stages.js');

const OPTIONS = {
  route: 'chat/start',
  methods: ['POST'],
  actor: 'customer',
  needsRateSecret: true,
  run: async (ctx) => {
    /* Each stage is labelled so an unexpected failure names where it
       happened. The labels are constants; nothing from the request reaches
       them. Nothing is caught and continued - runStage rethrows. */
    const input = await runStage('request_validation_failed',
      () => V.validateStart(ctx.body));
    /* The shop the customer chose, checked against the canonical allow-list.
       Exactly one of three strings reaches the document; anything else is a
       400 rather than a helpfully-repaired near-miss. */
    const locationId = await runStage('request_validation_failed',
      () => LOC.validLocationId(ctx.body));

    const request = {
      customerUid: ctx.actor.uid,      /* verified token, never the body */
      name: input.name,
      email: input.email,
      message: input.message,
      clientMessageId: input.clientMessageId,
      locationId: locationId
    };

    /*
     * Is this a retry of a start we already stored? If so it must not spend
     * the allowance for NEW conversations - a dropped response is the
     * customer's connection failing, not the customer misbehaving. It still
     * costs a replay allowance, so the path stays bounded.
     *
     * This also raises 409 on the same key with a different payload.
     */
    const replay = await runStage('idempotency_lookup_failed',
      () => S.peekStart(ctx.db, request));
    if (replay) {
      await runStage('rate_limit_check_failed',
        () => RL.consume(ctx.db, 'replay_uid', ctx.actor.uid, ctx.rateSecret));
      return runStage('response_serialization_failed', () => H.ok(ctx.res, {
        conversationId: replay.conversationId,
        messageId: replay.messageId,
        status: replay.status,
        /* Where the conversation actually is, read from the stored document -
           see resolveExistingStart(). A retry that arrives after a transfer
           must not tell the customer the old shop. */
        locationId: replay.locationId
      }));
    }

    /* Per-uid first: it is the cheaper bucket and the one an honest retry
       loop trips. The per-IP bucket is the one a fresh anonymous uid cannot
       escape. */
    await runStage('rate_limit_check_failed',
      () => RL.consume(ctx.db, 'start_uid', ctx.actor.uid, ctx.rateSecret));
    if (ctx.ip) {
      await runStage('rate_limit_check_failed',
        () => RL.consume(ctx.db, 'start_ip', ctx.ip, ctx.rateSecret));
    }

    const result = await runStage('chat_start_transaction_failed',
      () => S.startConversation(ctx.db, ctx.deps, request));

    /* An explicit allow-list. No customerUid, no email, no internal
       timestamps, no rate-limit state.

       locationId is echoed so the panel's "Sending to:" line is drawn from
       the server's answer rather than from what the browser believes it
       asked for. The LABEL is not sent - the client derives it, which keeps
       renaming a shop a copy edit. No routing audit field travels here:
       previousLocationId, lastTransferredAt and lastTransferredByStaffUid
       are staff business. */
    return runStage('response_serialization_failed', () => H.ok(ctx.res, {
      conversationId: result.conversationId,
      messageId: result.messageId,
      status: result.status,
      locationId: result.locationId
    }));
  }
};

module.exports = createHandler(OPTIONS);

/* Tests build the same handler with injected dependencies - a Firestore
   pointed at the emulator and a stand-in token verifier - so every branch
   can be exercised without a real Firebase project, a real token or a real
   staff password. Production always uses the export above. */
module.exports.forTest = (deps) =>
  createHandler(Object.assign({}, OPTIONS, { deps: deps }));
