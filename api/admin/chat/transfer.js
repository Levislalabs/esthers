/*
 * POST /api/admin/chat/transfer
 *
 * Hand a wrongly-routed conversation to the other shop, keeping the same
 * conversationId and the same transcript.
 *
 * THE ASYMMETRY THAT MAKES THIS USEFUL
 *
 * Source authorisation and destination authorisation are deliberately
 * different questions. Main-only staff who find a curved-scupper job in their
 * inbox must be able to send it to Keith Street - if that needed destination
 * access, only a manager could ever fix a misroute, and in practice the
 * conversation would just sit in the wrong inbox. So: you may transfer any
 * conversation you are currently authorised to handle, to any canonical shop.
 *
 * What that does NOT give you is a way in. The instant the id changes, your
 * ordinary read rules apply again: the conversation leaves your inbox, its
 * transcript stops loading, and send and close refuse. Handing something over
 * is not the same as being let into the room, and every one of those is
 * enforced on the server, not by hiding a button.
 *
 * NOTHING ABOUT THE SOURCE IS TAKEN FROM THE REQUEST. The body carries a
 * conversationId and a destination. The server loads the real document and
 * reads the current location off it, inside the same transaction as the
 * write - so a caller cannot claim to be transferring out of a shop they are
 * not in, and two people fixing the same misroute at once cannot both win.
 */

'use strict';

const H = require('../../_chat/http.js');
const RL = require('../../_chat/rate-limit.js');
const V = require('../../_chat/validation.js');
const S = require('../../_chat/service.js');
const LOC = require('../../_chat/locations.js');
const { createHandler } = require('../../_chat/handler.js');
const { runStage } = require('../../_chat/stages.js');

const OPTIONS = {
  route: 'admin/chat/transfer',
  methods: ['POST'],
  actor: 'staff',
  needsRateSecret: true,
  run: async (ctx) => {
    /* previousLocationId, lastTransferredByStaffUid and the rest are on the
       forbidden list: a body that tries to write its own audit trail is
       refused outright rather than having the fields quietly dropped. */
    V.requireNoPrivilegedFields(ctx.body);

    const conversationId = V.validConversationId(ctx.body.conversationId);
    const locationId = LOC.validLocationId(ctx.body);

    /* Spends the same staff-write allowance as a reply or a close. A transfer
       is a write, and a script hammering this endpoint should run out of rope
       exactly as fast. */
    await runStage('rate_limit_check_failed',
      () => RL.consume(ctx.db, 'staff_write', ctx.actor.uid, ctx.rateSecret));

    const result = await runStage('chat_transfer_transaction_failed',
      () => S.transferConversation(ctx.db, ctx.deps, {
        conversationId: conversationId,
        locationId: locationId,
        actor: ctx.actor              /* verified staff, never the body */
      }));

    /*
     * The minimum a dashboard needs to reconcile itself, and no more. Both
     * labels are derived from the ids by the server, so no caller ever gets
     * to choose the words another staff member reads.
     *
     * `changed: false` means it was already there - a safe no-op that wrote
     * nothing and recorded no audit event.
     *
     * NOT RETURNED: who performed any earlier transfer, when, or how often.
     * That is written to the document for an operator to look up; it is not
     * something a browser needs, and this response is read by a client.
     */
    return H.ok(ctx.res, {
      conversationId: result.conversationId,
      locationId: result.locationId,
      locationLabel: LOC.labelFor(result.locationId),
      previousLocationId: result.previousLocationId,
      previousLocationLabel: LOC.labelFor(result.previousLocationId),
      changed: result.changed
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
