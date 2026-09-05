/*
 * GET /api/admin/chat/conversations?status=open&limit=50
 *
 * The staff inbox. Field allow-listed, hard-limited, and served through the
 * deployed (status ASC, lastMessageAt DESC) composite index.
 */

'use strict';

const H = require('../../_chat/http.js');
const S = require('../../_chat/service.js');
const { ValidationError } = require('../../_chat/validation.js');
const { createHandler } = require('../../_chat/handler.js');
const { runStage } = require('../../_chat/stages.js');

const ALLOWED_STATUS = ['open', 'closed'];

const OPTIONS = {
  route: 'admin/chat/conversations',
  methods: ['GET'],
  actor: 'staff',
  needsRateSecret: false,
  run: async (ctx) => {
    const status = ctx.query.status === undefined ? 'open' : String(ctx.query.status);
    if (ALLOWED_STATUS.indexOf(status) === -1) {
      throw new ValidationError('invalid_status', 'Unsupported status filter.');
    }

    let limit = S.MAX_INBOX;
    if (ctx.query.limit !== undefined) {
      limit = Number(ctx.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > S.MAX_INBOX) {
        throw new ValidationError('invalid_limit', 'Unsupported limit.');
      }
    }

    const result = await runStage('firestore_operation_failed',
      () => S.listConversations(ctx.db, { status, limit }));
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
