/*
 * POST /api/admin/chat/read
 *
 * "I have actually looked at this conversation, at this version."
 *
 * WHY A VERSION AND NOT A TIMESTAMP. The body carries the attentionVersion
 * the browser genuinely RENDERED, and the server never advances past it. In
 * the gap between fetching a transcript and this call landing, the customer
 * may well have sent another message; acknowledging "now" would swallow it
 * without anybody seeing it. See the worked race at the top of
 * api/_chat/attention.js, which has a test of its own.
 *
 * WHY IT IS A WRITE AND NOT A SIDE EFFECT OF GET /messages. A GET that
 * mutates state surprises everybody, browsers prefetch, and - decisively -
 * fetching a transcript is not the same as a person looking at one. The
 * client only calls this after the transcript has actually been rendered,
 * with the tab visible, with the thread still selected. Those are conditions
 * the server cannot check, which is exactly why they are the client's job and
 * this endpoint's job is to be impossible to abuse when it is called.
 *
 * THE GATE, INHERITED RATHER THAN REBUILT. createHandler() runs, in order:
 * method, same-origin, body, Admin initialisation, APP CHECK, then Firebase
 * ID-token verification with actor: 'staff' - which requires
 * staff/{uid}.isActive and an allowed role. Location authorisation happens
 * twice after that: at the door here, and again inside the transaction, for
 * the same reason every other staff route does it.
 */

'use strict';

const H = require('../../_chat/http.js');
const RL = require('../../_chat/rate-limit.js');
const V = require('../../_chat/validation.js');
const A = require('../../_chat/attention.js');
const S = require('../../_chat/service.js');
const { createHandler } = require('../../_chat/handler.js');
const { runStage } = require('../../_chat/stages.js');

const OPTIONS = {
  route: 'admin/chat/read',
  methods: ['POST'],
  actor: 'staff',
  needsRateSecret: true,
  run: async (ctx) => {
    /* staffLastReadAt is on the forbidden list, and so is every field the
       server owns. A body trying to write its own read state is refused
       outright rather than having the field quietly dropped. */
    V.requireNoPrivilegedFields(ctx.body);

    const conversationId = V.validConversationId(ctx.body.conversationId);
    const attentionVersion = A.validAttentionVersion(ctx.body);

    /*
     * Load, resolve the shop, authorise - BEFORE spending an allowance. A
     * staff member whose conversation was transferred away is refused here
     * with the same 404 an id that never existed would get, so the endpoint
     * is not a cross-shop existence oracle either.
     */
    await runStage('firestore_operation_failed',
      () => S.loadConversationForStaff(ctx.db, ctx.actor, conversationId));

    /* Its own bucket, not staff_write - see the note in rate-limit.js. */
    await runStage('rate_limit_check_failed',
      () => RL.consume(ctx.db, 'staff_read', ctx.actor.uid, ctx.rateSecret));

    const result = await runStage('chat_read_transaction_failed',
      () => S.markConversationRead(ctx.db, ctx.deps, {
        conversationId: conversationId,
        attentionVersion: attentionVersion,
        actor: ctx.actor              /* verified staff, never the body */
      }));

    /*
     * The minimum a dashboard needs to settle its own state, and no more.
     *
     * `unread` is the server's verdict, so two computers cannot disagree
     * about it. `readVersion` is echoed because the caller just set it and
     * seeing it come back is how the client knows the acknowledgement landed
     * on the version it meant.
     *
     * NOT RETURNED: which staff member read it, when anybody else read it,
     * the customer's uid, or any transfer audit field. Nothing here says
     * anything about a colleague.
     */
    return H.ok(ctx.res, {
      conversationId: result.conversationId,
      attentionVersion: result.attentionVersion,
      readVersion: result.readVersion,
      unread: result.unread
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
