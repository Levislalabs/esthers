/*
 * WHETHER ANYBODY HAS ACTUALLY LOOKED AT A CONVERSATION.
 *
 * The shop needs to be able to walk away from the screen and still know a
 * customer is waiting. That means "unread" has to survive a page reload, be
 * the same answer on the counter computer and the office computer, and stop
 * being true the moment somebody genuinely opens the thread - not merely when
 * a poll returns it, not when a notification pops, and not because a tab that
 * nobody is looking at happened to fetch the inbox.
 *
 * WHY VERSIONS AND NOT TIMESTAMPS.
 *
 * The obvious design is "staffLastReadAt >= lastMessageAt". It races, and the
 * race loses a customer message:
 *
 *     1. staff opens the thread; the transcript is fetched
 *     2. the customer sends another message
 *     3. the client posts "read at now()"
 *     4. now() is AFTER the new message, so the unseen message is read
 *
 * Nobody sees step 2 again. A counter is immune to that because the client
 * acknowledges A SPECIFIC VERSION - the one it actually rendered - and the
 * server refuses to advance past it. Step 2 bumps the version to 8, step 3
 * acknowledges 7, and 8 is still outstanding.
 *
 * TWO COUNTERS, ONE COMPARISON:
 *
 *     staffAttentionVersion   raised by the server when something happens
 *                             that staff need to see
 *     staffReadVersion        raised only by an explicit acknowledgement of a
 *                             version somebody observed
 *
 *     unread  <=>  staffAttentionVersion > staffReadVersion
 *
 * staffLastReadAt is KEPT and still written, because it is already in the
 * schema and is genuinely useful to a person reading a document by hand. It
 * is no longer the authority for anything.
 *
 * LEGACY DOCUMENTS HAVE NEITHER FIELD, and normalise to 0/0 - equal, so not
 * unread. That is the whole migration: the day this deploys, no historical
 * conversation starts shouting at anybody. The next genuine customer message
 * on one of them raises 0 to 1 and it behaves like any other conversation
 * from then on.
 */

'use strict';

const { ValidationError } = require('./validation.js');

/*
 * Why something needs attention. Three values, closed set, because the client
 * turns them into different sentences: a transfer is not a new message and
 * must not be announced as one.
 */
const NEW_CONVERSATION = 'new_conversation';
const CUSTOMER_MESSAGE = 'customer_message';
const TRANSFER = 'transfer';

const ATTENTION_TYPES = [NEW_CONVERSATION, CUSTOMER_MESSAGE, TRANSFER];

/*
 * The ceiling on a version.
 *
 * Not a business rule - a guard. A version arrives from a request body, and
 * arithmetic past Number.MAX_SAFE_INTEGER silently stops being exact, so a
 * huge value could otherwise compare equal to its own successor. Nothing
 * legitimate will reach ten million: that is one attention event per minute
 * for nineteen years on a single conversation.
 */
const MAX_VERSION = 10 * 1000 * 1000;

/*
 * A stored counter, made safe.
 *
 * ANYTHING that is not a clean non-negative integer reads as 0 - missing,
 * null, a string, a float, a negative, NaN, Infinity, or something past the
 * ceiling. Reading a corrupt value as 0 makes a conversation look READ rather
 * than making it shout, and a document nobody can explain should not be the
 * one that wakes the shop up.
 */
function normalizeVersion(value) {
  if (typeof value !== 'number') return 0;
  if (!isFinite(value)) return 0;
  if (!Number.isInteger(value)) return 0;
  if (value < 0 || value > MAX_VERSION) return 0;
  return value;
}

function attentionVersionOf(data) {
  return normalizeVersion(data ? data.staffAttentionVersion : undefined);
}

function readVersionOf(data) {
  return normalizeVersion(data ? data.staffReadVersion : undefined);
}

/* The one definition of unread, used by every route that answers the
   question. Legacy 0 > 0 is false, which is the point. */
function isUnread(data) {
  return attentionVersionOf(data) > readVersionOf(data);
}

/* An attention type that is not one of the three reads as null rather than
   being echoed - the client picks its wording from this, and an unrecognised
   value must not reach a screen. */
function attentionTypeOf(data) {
  const value = data ? data.lastAttentionType : undefined;
  return ATTENTION_TYPES.indexOf(value) !== -1 ? value : null;
}

/*
 * The fields a brand-new conversation is created with.
 *
 * 1 and 0: unread from the instant it exists, because it is. There is no
 * separate "notify the shop" step to forget.
 */
function initialAttention(now) {
  return {
    staffAttentionVersion: 1,
    staffReadVersion: 0,
    lastAttentionType: NEW_CONVERSATION,
    lastAttentionAt: now
  };
}

/*
 * The update fragment that raises attention by exactly one.
 *
 * Computed from the document READ IN THE SAME TRANSACTION, never from a
 * counter the caller carried in, so two events landing together cannot both
 * write the same number.
 *
 * staffReadVersion is deliberately absent: raising attention must never
 * disturb what somebody has already acknowledged.
 */
function raiseAttention(data, type, now) {
  if (ATTENTION_TYPES.indexOf(type) === -1) {
    throw new Error('unknown attention type: ' + String(type));
  }
  return {
    staffAttentionVersion: attentionVersionOf(data) + 1,
    lastAttentionType: type,
    lastAttentionAt: now
  };
}

/*
 * What staffReadVersion should become, given what somebody says they saw.
 *
 *     max(existingRead, min(observed, currentAttention))
 *
 * Three separate promises in one line:
 *
 *   min(observed, current)   NEVER ACKNOWLEDGE MORE THAN WAS SEEN. A client
 *                            claiming version 99 acknowledges only what
 *                            actually exists. This is also what keeps the
 *                            race honest - see the note at the top.
 *
 *   max(existing, ...)       NEVER GO BACKWARDS. A slow acknowledgement of an
 *                            older version arriving after a newer one is a
 *                            no-op, not a regression that makes a read
 *                            conversation unread again.
 *
 *   pure                     no clock, no request state, so the whole rule is
 *                            testable without a database.
 */
function resolveReadVersion(data, observedVersion) {
  const current = attentionVersionOf(data);
  const existing = readVersionOf(data);
  const observed = normalizeVersion(observedVersion);
  return Math.max(existing, Math.min(observed, current));
}

/*
 * The acknowledged version from a request body.
 *
 * Strict: a real non-negative integer and nothing else. NOT coerced from a
 * string, because "7" arriving where 7 was meant is a client bug worth
 * hearing about rather than papering over - and a coerced value is exactly
 * the kind of thing that later turns into "07" or "7 " and compares wrong.
 */
function validAttentionVersion(body) {
  const value = body ? body.attentionVersion : undefined;
  if (typeof value !== 'number' || !isFinite(value)
      || !Number.isInteger(value) || value < 0 || value > MAX_VERSION) {
    throw new ValidationError('invalid_attention_version',
      'That read acknowledgement could not be accepted. Please reload.');
  }
  return value;
}

module.exports = {
  NEW_CONVERSATION, CUSTOMER_MESSAGE, TRANSFER, ATTENTION_TYPES, MAX_VERSION,
  normalizeVersion, attentionVersionOf, readVersionOf, isUnread,
  attentionTypeOf, initialAttention, raiseAttention, resolveReadVersion,
  validAttentionVersion
};
