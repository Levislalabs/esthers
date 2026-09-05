/*
 * Input validation.
 *
 * Two jobs. The obvious one is refusing nonsense. The less obvious one is
 * refusing PRIVILEGE: a request that supplies customerUid, senderType,
 * staffUserId, status or createdAt is rejected outright rather than having
 * those fields quietly ignored. Silently dropping them would work, but a
 * caller probing for a way in deserves a clear no, and a future edit that
 * accidentally started reading one of those fields would be caught here
 * instead of becoming a vulnerability.
 */

'use strict';

const LIMITS = {
  NAME_MIN: 1,
  NAME_MAX: 100,
  EMAIL_MAX: 254,          /* the practical maximum length of an address */
  MESSAGE_MAX: 2000,
  CONVERSATION_ID_MAX: 64,
  CLIENT_MESSAGE_ID_MAX: 64
};

/* Fields only the server may ever decide. Present in a request body => 400. */
const FORBIDDEN_FIELDS = [
  'customerUid', 'senderType', 'staffUserId', 'createdAt', 'updatedAt',
  'status', 'closedAt', 'messageCount', 'lastMessageAt',
  'staffLastReadAt', 'customerLastReadAt', 'staffNotifiedAt', 'uid', 'role'
];

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.code = code;
    /* See the note on AuthError: recognised by tag as well as instanceof. */
    this.chatErrorKind = 'validation';
  }
}

/*
 * Control characters are refused, with tab, newline and carriage return
 * allowed inside a message body. NUL in particular must never reach
 * Firestore or a later renderer.
 *
 * Unicode is otherwise left completely alone: names and messages in any
 * script are ordinary input, not a threat, and mangling them would be a bug.
 */
const CONTROL_ANY = /[\0-\x1f\x7f]/;
const CONTROL_EXCEPT_WS = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function requireNoPrivilegedFields(body) {
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      throw new ValidationError('forbidden_field',
        'That request contained a field the server sets for itself.');
    }
  }
}

function str(body, field) {
  const v = body[field];
  if (typeof v !== 'string') {
    throw new ValidationError('invalid_' + field, 'Please check the ' + field + ' field.');
  }
  return v;
}

function validName(body) {
  const name = str(body, 'name').trim();
  if (name.length < LIMITS.NAME_MIN || name.length > LIMITS.NAME_MAX) {
    throw new ValidationError('invalid_name', 'Please give us a name we can use.');
  }
  if (CONTROL_ANY.test(name)) {
    throw new ValidationError('invalid_name', 'Please give us a name we can use.');
  }
  return name;
}

/*
 * Deliberately a shape check, not an RFC 5322 implementation. The address is
 * for a person to reply to, and over-strict patterns reject real addresses.
 */
function validEmail(body) {
  const email = str(body, 'email').trim();
  if (email.length > LIMITS.EMAIL_MAX) {
    throw new ValidationError('invalid_email', 'Please give us a valid email address.');
  }
  if (CONTROL_ANY.test(email)) {
    throw new ValidationError('invalid_email', 'Please give us a valid email address.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ValidationError('invalid_email', 'Please give us a valid email address.');
  }
  return email;
}

/*
 * The message stays plain text. It is NOT rewritten into markup, escaped or
 * "sanitised" - the transcript is rendered with textContent, and a server
 * that HTML-encoded here would put &amp; in front of the customer.
 */
function validMessage(body) {
  const raw = str(body, 'message');
  if (raw.length > LIMITS.MESSAGE_MAX * 4) {
    /* Reject an absurd payload before trimming a megabyte of whitespace. */
    throw new ValidationError('message_too_long', 'That message is too long to send.');
  }
  const message = raw.trim();
  if (!message) {
    throw new ValidationError('empty_message', 'Please type a message first.');
  }
  if (message.length > LIMITS.MESSAGE_MAX) {
    throw new ValidationError('message_too_long', 'That message is too long to send.');
  }
  if (CONTROL_EXCEPT_WS.test(message)) {
    throw new ValidationError('invalid_message', 'That message contains characters we cannot send.');
  }
  return message;
}

/*
 * The browser will generate this with crypto.randomUUID(). Accepting only
 * that shape keeps the idempotency key predictable to hash and impossible to
 * use as a smuggling channel.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validClientMessageId(body) {
  const id = str(body, 'clientMessageId').trim();
  if (id.length > LIMITS.CLIENT_MESSAGE_ID_MAX || !UUID_RE.test(id)) {
    throw new ValidationError('invalid_client_message_id', 'That request could not be identified.');
  }
  return id.toLowerCase();
}

/*
 * A Firestore document id we generated. Conservative on purpose: our own ids
 * are 20-character auto-ids, so anything with a slash, a dot-only name or a
 * __reserved__ shape is refused long before it reaches a document path.
 */
function validConversationId(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_conversation_id', 'We could not find that conversation.');
  }
  const id = value.trim();
  if (!id || id.length > LIMITS.CONVERSATION_ID_MAX) {
    throw new ValidationError('invalid_conversation_id', 'We could not find that conversation.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ValidationError('invalid_conversation_id', 'We could not find that conversation.');
  }
  if (id === '.' || id === '..' || /^__.*__$/.test(id)) {
    throw new ValidationError('invalid_conversation_id', 'We could not find that conversation.');
  }
  return id;
}

function validateStart(body) {
  requireNoPrivilegedFields(body);
  return {
    name: validName(body),
    email: validEmail(body),
    message: validMessage(body),
    clientMessageId: validClientMessageId(body)
  };
}

function validateSend(body) {
  requireNoPrivilegedFields(body);
  return {
    conversationId: validConversationId(body.conversationId),
    message: validMessage(body),
    clientMessageId: validClientMessageId(body)
  };
}

module.exports = {
  LIMITS, FORBIDDEN_FIELDS, ValidationError,
  requireNoPrivilegedFields, validName, validEmail, validMessage,
  validClientMessageId, validConversationId, validateStart, validateSend
};
