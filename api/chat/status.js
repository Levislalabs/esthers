/*
 * GET /api/chat/status?conversationId=...
 *
 * Is this conversation still open? Answers for the CUSTOMER who owns it, and
 * for nobody else.
 *
 * WHY IT EXISTS
 *
 * The customer's transcript is a direct Firestore listener on chatMessages.
 * Closing a conversation writes only to the conversation document - status,
 * closedAt, updatedAt - and no message, so a close is completely invisible to
 * that listener. Before this endpoint a customer discovered a closed thread by
 * sending a message and being refused, and a page reload put the panel back to
 * "Connected" with a live composer, because nothing on the client knew better.
 * The backend refused those sends correctly throughout; the lie was in the UI.
 *
 * WHY NOT JUST LET THE BROWSER READ THE CONVERSATION
 *
 * Because a Firestore rule cannot hide a field inside a document it has
 * allowed, and chatConversations carries customerEmail, staffLastReadAt,
 * staffNotifiedAt, messageCount, startRequestHash and whatever a later phase
 * adds. Granting the read would hand all of it over, and would keep handing
 * over each new field for free. firestore.rules therefore denies every browser
 * read of that collection, and this change does not touch that - the rules are
 * byte-identical. The server reads the document with the Admin SDK and returns
 * the one bit that is the customer's business.
 *
 * THE FULL GATE, INHERITED RATHER THAN REBUILT
 *
 * createHandler() runs, in this order: method, same-origin, body, Admin
 * initialisation, APP CHECK, then Firebase ID-token verification with
 * actor: 'customer' - which requires the anonymous provider specifically, so a
 * staff Email/Password token is refused 403 here exactly as it is on send.
 * Ownership is then checked inside readConversationStatus() against the
 * VERIFIED uid. No parallel security stack; this route gets the same one every
 * other chat route has.
 *
 * NO RATE-LIMIT BUCKET, deliberately.
 *
 * Every other customer route spends an allowance because it WRITES. This one
 * reads a single document, and the rate limiter itself works by writing a
 * counter to Firestore - so metering this would cost a write per read and make
 * the endpoint more expensive than the thing it was protecting. The same
 * reasoning already applies to /api/admin/chat/messages, which is also a read
 * and also carries needsRateSecret: false. What bounds this endpoint is App
 * Check, an anonymous session, ownership of one conversation, and a client
 * that asks rarely - see the polling interval in assets/js/chat-customer.js.
 */

'use strict';

const H = require('../_chat/http.js');
const V = require('../_chat/validation.js');
const S = require('../_chat/service.js');
const { createHandler } = require('../_chat/handler.js');
const { runStage } = require('../_chat/stages.js');

const OPTIONS = {
  route: 'chat/status',
  methods: ['GET'],
  actor: 'customer',
  needsRateSecret: false,
  run: async (ctx) => {
    const conversationId = V.validConversationId(ctx.query.conversationId);

    const result = await runStage('firestore_operation_failed',
      () => S.readConversationStatus(ctx.db, {
        conversationId: conversationId,
        customerUid: ctx.actor.uid      /* verified token, never the query */
      }));

    /*
     * An explicit allow-list, and it is the whole response. No customerUid, no
     * email, no name, no timestamps, no counts, no staff fields.
     *
     * locationId is on it deliberately. The panel tells the customer which
     * shop they are writing to, and that confirmation has to survive a reload
     * and follow a transfer - otherwise a conversation moved to Keith Street
     * still says "Main Shop" until the tab is closed. It is the customer's own
     * conversation and they chose the destination themselves, so it tells them
     * nothing they did not already know. The friendly LABEL is not sent: the
     * client derives it, which keeps a shop rename a one-file change instead
     * of a data migration. No previousLocationId, no lastTransferredAt, no
     * lastTransferredByStaffUid - who moved it, and when, is staff business.
     */
    return H.ok(ctx.res, {
      conversationId: result.conversationId,
      status: result.status,
      locationId: result.locationId
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
