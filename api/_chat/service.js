/*
 * Every Firestore operation the chat performs.
 *
 * Kept apart from the HTTP handlers so the security-critical logic can be
 * tested against the emulator without inventing fake requests, and so the
 * rules that matter live in one readable place.
 *
 * THE ONE CONTRACT THAT MUST NOT SLIP
 *
 * A chatMessages document contains EXACTLY four fields:
 *
 *     conversationId  createdAt  senderType  body
 *
 * The deployed Firestore rules let a customer read their own messages
 * directly, and a rule cannot hide a field inside a document it has allowed.
 * So every field on a message is customer-visible, and anything internal -
 * a staff uid, an email, an address, moderation state - would be handed
 * straight to the customer. buildMessage() is the only place a message is
 * constructed, and a Phase 1 test asserts this exact key set.
 */

'use strict';

const crypto = require('crypto');

const CONVERSATIONS = 'chatConversations';
const MESSAGES = 'chatMessages';

/* The transcript ceiling, matching maxMessageQuery() in firestore.rules. The
   two are independent enforcement points and both must hold. */
const MAX_TRANSCRIPT = 200;
const MAX_INBOX = 50;

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

/*
 * A customer asking about a conversation that does not exist and a customer
 * asking about someone else's conversation get THE SAME error. Anything else
 * turns the endpoint into an oracle: try ids until the message changes, and
 * you have learned which ones are real.
 */
function notFoundForCustomer() {
  return new ServiceError(404, 'conversation_not_found',
    'We could not find that conversation. Please start a new one.');
}

/*
 * Deterministic message id: the idempotency key.
 *
 * A retried request must not append a second copy of the same message. The
 * obvious fix - store clientMessageId on the document and query for it -
 * would add a fifth field to a customer-readable document and break the
 * schema contract above. Hashing it into the document ID instead keeps the
 * document at four fields and makes the duplicate impossible rather than
 * merely detectable: the second create lands on the same path.
 *
 * The conversation id is mixed in so the same clientMessageId in two
 * different conversations is two different messages.
 */
function messageId(conversationId, clientMessageId) {
  return crypto.createHash('sha256')
    .update(conversationId + '\0' + clientMessageId)
    .digest('hex')
    .slice(0, 40);
}

/* The only constructor for a message document. Four fields, no exceptions. */
function buildMessage(conversationId, senderType, body, now) {
  return {
    conversationId: conversationId,
    createdAt: now,
    senderType: senderType,
    body: body
  };
}

/*
 * Start a conversation and its first message, atomically.
 *
 * A transaction because the two halves are meaningless apart: a conversation
 * with no message is an empty thread in the inbox, and a message with no
 * conversation is unreadable by its own owner - the deployed rules resolve
 * ownership through the conversation document.
 *
 * No email is sent from in here. A notification failing must never decide
 * whether the customer's message was saved.
 */
async function startConversation(db, deps, input) {
  const now = deps.now();
  const convRef = db.collection(CONVERSATIONS).doc();
  const msgRef = db.collection(MESSAGES).doc(messageId(convRef.id, input.clientMessageId));

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(msgRef);
    if (existing.exists) return;         /* a retry; nothing more to do */

    tx.set(convRef, {
      customerUid: input.customerUid,    /* from the verified token, never the body */
      customerName: input.name,
      customerEmail: input.email,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      messageCount: 1,
      closedAt: null,
      staffLastReadAt: null,
      customerLastReadAt: null,
      staffNotifiedAt: null
    });
    tx.set(msgRef, buildMessage(convRef.id, 'customer', input.message, now));
  });

  return { conversationId: convRef.id, messageId: msgRef.id, status: 'open' };
}

/*
 * Append a customer message to a conversation they own and that is open.
 */
async function sendCustomerMessage(db, deps, input) {
  const now = deps.now();
  const convRef = db.collection(CONVERSATIONS).doc(input.conversationId);
  const msgRef = db.collection(MESSAGES).doc(messageId(input.conversationId, input.clientMessageId));

  const result = await db.runTransaction(async (tx) => {
    const conv = await tx.get(convRef);

    /* Missing and not-yours are the same answer, deliberately. */
    if (!conv.exists) throw notFoundForCustomer();
    const data = conv.data() || {};
    if (data.customerUid !== input.customerUid) throw notFoundForCustomer();

    if (data.status !== 'open') {
      throw new ServiceError(409, 'conversation_closed',
        'This conversation has been closed. Please start a new one.');
    }

    const existing = await tx.get(msgRef);
    if (existing.exists) {
      /* Retry of a message already stored. Return success WITHOUT touching
         messageCount - counting it twice is the bug idempotency exists to
         prevent. */
      return { messageId: msgRef.id, duplicate: true };
    }

    tx.set(msgRef, buildMessage(input.conversationId, 'customer', input.message, now));
    tx.update(convRef, {
      updatedAt: now,
      lastMessageAt: now,
      messageCount: (typeof data.messageCount === 'number' ? data.messageCount : 0) + 1
    });
    return { messageId: msgRef.id, duplicate: false };
  });

  return result;
}

/*
 * Staff reply. Same shape, same four-field message, and the senderType is
 * set here rather than taken from the request - a staff route that trusted a
 * body field could be made to write 'customer', and vice versa.
 *
 * The staff member's uid is deliberately NOT recorded on the message: it
 * would be customer-readable. If an authorship audit trail is wanted later
 * it belongs in a separate server-only collection.
 */
async function sendStaffMessage(db, deps, input) {
  const now = deps.now();
  const convRef = db.collection(CONVERSATIONS).doc(input.conversationId);
  const msgRef = db.collection(MESSAGES).doc(messageId(input.conversationId, input.clientMessageId));

  return db.runTransaction(async (tx) => {
    const conv = await tx.get(convRef);
    if (!conv.exists) {
      throw new ServiceError(404, 'conversation_not_found', 'That conversation no longer exists.');
    }
    const data = conv.data() || {};
    if (data.status !== 'open') {
      throw new ServiceError(409, 'conversation_closed', 'That conversation is closed.');
    }

    const existing = await tx.get(msgRef);
    if (existing.exists) return { messageId: msgRef.id, duplicate: true };

    tx.set(msgRef, buildMessage(input.conversationId, 'staff', input.message, now));
    tx.update(convRef, {
      updatedAt: now,
      lastMessageAt: now,
      messageCount: (typeof data.messageCount === 'number' ? data.messageCount : 0) + 1
    });
    return { messageId: msgRef.id, duplicate: false };
  });
}

/*
 * Close a conversation. Idempotent: closing an already-closed thread is a
 * success, not an error, because a staff member double-clicking a button
 * should not see a failure.
 *
 * Nothing is deleted. Retention is a later phase and a separate decision.
 */
async function closeConversation(db, deps, input) {
  const now = deps.now();
  const convRef = db.collection(CONVERSATIONS).doc(input.conversationId);

  return db.runTransaction(async (tx) => {
    const conv = await tx.get(convRef);
    if (!conv.exists) {
      throw new ServiceError(404, 'conversation_not_found', 'That conversation no longer exists.');
    }
    const data = conv.data() || {};
    if (data.status === 'closed') {
      return { conversationId: convRef.id, status: 'closed', alreadyClosed: true };
    }
    tx.update(convRef, { status: 'closed', closedAt: now, updatedAt: now });
    return { conversationId: convRef.id, status: 'closed', alreadyClosed: false };
  });
}

/* ------------------------------------------------------------------ reads */

/*
 * Explicit field allow-lists on the way out. Serialising a Firestore document
 * wholesale is how internal fields end up in a browser months later, when
 * somebody adds one to the schema and forgets this file exists.
 */
function publicConversation(doc) {
  const d = doc.data() || {};
  return {
    conversationId: doc.id,
    customerName: d.customerName || null,
    customerEmail: d.customerEmail || null,
    status: d.status || null,
    createdAt: toMillis(d.createdAt),
    lastMessageAt: toMillis(d.lastMessageAt),
    messageCount: typeof d.messageCount === 'number' ? d.messageCount : 0,
    staffLastReadAt: toMillis(d.staffLastReadAt)
  };
}

function publicMessage(doc) {
  const d = doc.data() || {};
  return {
    messageId: doc.id,
    conversationId: d.conversationId,
    senderType: d.senderType,
    body: d.body,
    createdAt: toMillis(d.createdAt)
  };
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return null;
}

/*
 * The staff inbox. Uses the deployed composite index
 * (status ASC, lastMessageAt DESC).
 */
async function listConversations(db, opts) {
  const status = (opts && opts.status) || 'open';
  const limit = Math.min(Math.max(1, (opts && opts.limit) || MAX_INBOX), MAX_INBOX);

  const snap = await db.collection(CONVERSATIONS)
    .where('status', '==', status)
    .orderBy('lastMessageAt', 'desc')
    .limit(limit)
    .get();

  return { conversations: snap.docs.map(publicConversation), limit: limit, status: status };
}

/*
 * One transcript, oldest first, using the deployed
 * (conversationId ASC, createdAt ASC) index.
 *
 * The conversation is confirmed to exist first so a staff member gets an
 * honest not-found rather than a convincing empty thread.
 */
async function readTranscript(db, opts) {
  const limit = Math.min(Math.max(1, (opts && opts.limit) || MAX_TRANSCRIPT), MAX_TRANSCRIPT);
  const conv = await db.collection(CONVERSATIONS).doc(opts.conversationId).get();
  if (!conv.exists) {
    throw new ServiceError(404, 'conversation_not_found', 'That conversation no longer exists.');
  }

  const snap = await db.collection(MESSAGES)
    .where('conversationId', '==', opts.conversationId)
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get();

  return {
    conversation: publicConversation(conv),
    messages: snap.docs.map(publicMessage),
    limit: limit
  };
}

module.exports = {
  CONVERSATIONS, MESSAGES, MAX_TRANSCRIPT, MAX_INBOX,
  ServiceError, messageId, buildMessage,
  startConversation, sendCustomerMessage, sendStaffMessage, closeConversation,
  listConversations, readTranscript,
  publicConversation, publicMessage, toMillis
};
