/*
 * Which stage of an authenticated request failed.
 *
 * WHY THIS FILE EXISTS
 *
 * The unauthenticated probe reaches 401 cleanly, so the function loads, the
 * SDK loads and the configuration is valid. The first authenticated request
 * then produced:
 *
 *     chat: unhandled [chat/start] unknown_error
 *
 * which says only "something threw that we do not recognise". An
 * authenticated /api/chat/start touches token verification, provider
 * checking, an idempotency read, two rate-limit transactions and a write
 * transaction, and that log line cannot tell them apart.
 *
 * A stage is attached to an error as it passes each boundary, and the
 * handler logs it. Nothing else changes: the same errors, the same status
 * codes, one extra allow-listed word in the log.
 *
 * SAFETY. A stage is a constant chosen from the list below. It is never
 * derived from a token, a message body, an address, an error message or any
 * other request data - so a stage can be printed without inspecting it.
 */

'use strict';

/*
 * THE COMPLETE ALLOW-LIST. Anything not on it is replaced, never printed.
 */
const STAGES = [
  /* authentication */
  'auth_token_verify_failed',            /* the token is bad - client's fault */
  'auth_token_verify_internal_error',    /* the verifier itself broke - ours */
  'auth_customer_provider_check_failed',
  'auth_customer_uid_missing',
  'auth_staff_lookup_failed',
  /* the request body */
  'request_validation_failed',
  /* the work */
  'idempotency_lookup_failed',
  'rate_limit_check_failed',
  'chat_start_transaction_failed',
  'chat_send_transaction_failed',
  'chat_close_transaction_failed',
  'firestore_operation_failed',
  'response_serialization_failed',
  /* nothing above matched */
  'unknown_authenticated_error'
];

function validStage(stage) {
  return STAGES.indexOf(stage) === -1 ? 'unknown_authenticated_error' : stage;
}

/*
 * Attach a stage to an error, without disturbing it otherwise.
 *
 * FIRST ONE WINS. An error that already knows where it came from keeps that
 * answer: an inner stage is more specific than the outer one that caught it,
 * and overwriting would replace "the transaction failed" with "the request
 * failed", which is the thing we are trying to stop happening.
 */
function tagStage(err, stage) {
  if (err && typeof err === 'object' && !err.chatStage) {
    try { err.chatStage = validStage(stage); } catch (ignored) { /* frozen */ }
  }
  return err;
}

/*
 * Run one stage of a request. Anything it throws is labelled and rethrown -
 * never caught and continued, never converted into a different status.
 */
async function runStage(stage, fn) {
  try {
    return await fn();
  } catch (err) {
    throw tagStage(err, stage);
  }
}

/* The stage of an error, or null. Always allow-listed. */
function stageOf(err) {
  if (!err || typeof err !== 'object' || typeof err.chatStage !== 'string') return null;
  return validStage(err.chatStage);
}

module.exports = { STAGES, validStage, tagStage, runStage, stageOf };
