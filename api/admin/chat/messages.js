/*
 * GET /api/admin/chat/messages?conversationId=...
 *
 * One transcript, oldest first. Reading does NOT mark the thread read:
 * a GET that mutates state surprises everybody, and browsers prefetch. A
 * deliberate read-state endpoint can come later.
 */

'use strict';

const H = require('../../_chat/http.js');
const V = require('../../_chat/validation.js');
const S = require('../../_chat/service.js');
const { createHandler } = require('../../_chat/handler.js');

const OPTIONS = {
  route: 'admin/chat/messages',
  methods: ['GET'],
  actor: 'staff',
  needsRateSecret: false,
  run: async (ctx) => {
    const conversationId = V.validConversationId(ctx.query.conversationId);

    let limit = S.MAX_TRANSCRIPT;
    if (ctx.query.limit !== undefined) {
      limit = Number(ctx.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > S.MAX_TRANSCRIPT) {
        throw new V.ValidationError('invalid_limit', 'Unsupported limit.');
      }
    }

    const result = await S.readTranscript(ctx.db, { conversationId, limit });
    return H.ok(ctx.res, result);
  }
};

module.exports = createHandler(OPTIONS);

/* Tests build the same handler with injected dependencies - a Firestore
   pointed at the emulator and a stand-in token verifier - so every branch
   can be exercised without a real Firebase project, a real token or a real
   staff password. Production always uses the export above. */
module.exports.forTest = (deps) =>
  createHandler(Object.assign({}, OPTIONS, { deps: deps }));
