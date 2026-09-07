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

/* Routing. The canonical shop ids, the missing-field fallback and the staff
   authorisation rules all live in one place - see locations.js. */
const L = require('./locations.js');
const A = require('./attention.js');

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
    /* See the note on AuthError: recognised by tag as well as instanceof. */
    this.chatErrorKind = 'service';
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
 * The staff-side equivalent, and the reason it is a constant rather than a
 * literal at each throw site: LocationError below must answer "not your shop"
 * with THIS EXACT SENTENCE. Two spellings of the same refusal would let a
 * staff member tell a real conversation at the other shop from one that never
 * existed - see the note on LocationError.
 */
const STAFF_NOT_FOUND = 'That conversation no longer exists.';

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

/*
 * THE CONVERSATION ID IS DERIVED, NOT RANDOM.
 *
 * This is what makes /api/chat/start idempotent, and it is the one thing a
 * random Firestore auto-id cannot do. With an auto-id, a retried start minted
 * a fresh conversation id, which fed a fresh message id, which meant the
 * duplicate check inside the transaction could never fire - so a customer
 * whose response was dropped by a flaky connection opened a SECOND
 * conversation, and Esther's inbox showed the same person twice.
 *
 * Deriving the id from the verified uid and the client's idempotency key
 * makes the retry land on the same document, where it can be recognised.
 *
 * The uid comes from the VERIFIED token, never from the request body, so one
 * visitor cannot derive another visitor's conversation id. The domain string
 * keeps this hash from ever colliding with the message-id hash below, and NUL
 * separates the parts because neither a uid nor a UUID can contain one.
 *
 * The id is NOT a credential and is not treated as one: ownership is checked
 * against customerUid on every read and write, and the deployed rules do the
 * same. Nothing identifying goes into it - no name, no email, no message.
 */
const START_ID_DOMAIN = 'esthers:chat:conversation:v1';

function startConversationId(customerUid, clientMessageId) {
  return crypto.createHash('sha256')
    .update(START_ID_DOMAIN + '\0' + customerUid + '\0' + clientMessageId)
    .digest('hex')
    .slice(0, 32);
}

/*
 * A fingerprint of what the customer actually asked for, so the same
 * idempotency key used with a DIFFERENT payload can be told apart from an
 * honest retry. Stored on the conversation, which is server-private - never
 * on a message, which is customer-readable and fixed at four fields.
 *
 * Canonicalised first: a name that differs only in spacing, or an address
 * that differs only in case, is the same request typed twice, not a
 * conflicting one.
 */
const START_HASH_DOMAIN = 'esthers:chat:start-request:v1';

function startRequestHash(input) {
  const canonical = [
    START_HASH_DOMAIN,
    String(input.name || '').trim().replace(/\s+/g, ' '),
    String(input.email || '').trim().toLowerCase(),
    String(input.message || '')
  ].join('\0');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/*
 * WHAT A CUSTOMER WROTE STAYS IN chatMessages.
 *
 * An earlier draft of the notification work copied the first hundred
 * characters of each customer message onto the conversation document, so a
 * desktop pop-up could quote it. That was removed deliberately and must not
 * come back: a native notification lands on whatever screen the browser is
 * on, and the shop's monitors are shared and face the counter. The
 * requirement is to make a new message impossible to MISS, not to put its
 * contents in front of whoever happens to be standing there before a staff
 * member has decided to open the thread.
 *
 * The customer's name and the shop name are enough to act on, and both are
 * already on the conversation. Message bodies live in chatMessages, behind
 * the transcript endpoint, and are read when somebody opens the conversation.
 */

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
  const conversationId = startConversationId(input.customerUid, input.clientMessageId);
  const convRef = db.collection(CONVERSATIONS).doc(conversationId);
  const msgRef = db.collection(MESSAGES).doc(messageId(conversationId, input.clientMessageId));
  const requestHash = startRequestHash(input);

  return db.runTransaction(async (tx) => {
    const conv = await tx.get(convRef);

    /* The authoritative duplicate check. peekStart() below does the same
       check first without a transaction, to save the rate-limit allowance,
       but this one is what makes two SIMULTANEOUS identical starts safe: the
       loser of the race retries, sees the document, and returns it. */
    if (conv.exists) return resolveExistingStart(conv, input, msgRef.id, requestHash);

    tx.set(convRef, {
      customerUid: input.customerUid,    /* from the verified token, never the body */
      customerName: input.name,
      customerEmail: input.email,
      /*
       * The shop the customer chose. Validated against the canonical
       * allow-list before it got here, so this is one of exactly three
       * strings. The LABEL is never stored - it is derived from this id
       * wherever a person has to read it, so rewording a shop name is a
       * copy edit rather than a migration.
       */
      locationId: input.locationId,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      messageCount: 1,
      closedAt: null,
      /*
       * UNREAD FROM THE INSTANT IT EXISTS: version 1, read 0.
       *
       * Written inside the same transaction as the conversation and its first
       * message, so there is no separate "and now tell the shop" step that a
       * later edit could forget or that a crash could skip. A conversation
       * that exists and has never been looked at is exactly what unread
       * means. See attention.js.
       *
       * The replay path returns from resolveExistingStart() before reaching
       * here, so a retried start never raises attention a second time.
       */
      staffAttentionVersion: 1,
      staffReadVersion: 0,
      lastAttentionType: A.NEW_CONVERSATION,
      lastAttentionAt: now,
      staffLastReadAt: null,
      customerLastReadAt: null,
      staffNotifiedAt: null,
      /* Server-private. A conversation document is never readable by a
         browser and publicConversation() does not serialise this. */
      startRequestHash: requestHash
    });
    tx.set(msgRef, buildMessage(conversationId, 'customer', input.message, now));

    return { conversationId: conversationId, messageId: msgRef.id, status: 'open',
      locationId: input.locationId, duplicate: false };
  });
}

/*
 * What an already-existing conversation means for this start request.
 *
 * Shared by the pre-check and the transaction so the two can never disagree
 * about whether something is a retry, a conflict or somebody else's thread.
 */
function resolveExistingStart(conv, input, existingMessageId, requestHash) {
  const data = conv.data() || {};

  /* The id is derived from the uid, so a mismatch here is not a normal
     situation. Answer exactly as if the conversation did not exist. */
  if (data.customerUid !== input.customerUid) throw notFoundForCustomer();

  /*
   * Same key, different request. Creating a second conversation would defeat
   * the idempotency key, and overwriting the first would silently discard a
   * message somebody actually sent - so neither happens and the caller is
   * told plainly.
   */
  if (data.startRequestHash !== requestHash) {
    throw new ServiceError(409, 'idempotency_conflict',
      'That request was already used to start a different conversation.');
  }

  return {
    conversationId: conv.id,
    messageId: existingMessageId,
    status: data.status || 'open',
    /*
     * FROM THE STORED DOCUMENT, not from the retried request.
     *
     * A retry can arrive after staff have already moved the conversation to
     * the other shop, and the panel's "Sending to:" line has to say where it
     * IS - not where this request once asked for. The stored value wins; a
     * conversation written before routing existed resolves to unassigned.
     *
     * locationId is deliberately NOT part of startRequestHash(). Adding it
     * would make a conversation started before this deploy fail an honest
     * retry with idempotency_conflict, because its stored hash was computed
     * without the field. The destination is settled by the document either
     * way, so nothing is lost by leaving the fingerprint alone.
     */
    locationId: L.resolveLocation(data),
    duplicate: true
  };
}

/*
 * A read-only look for an already-stored start, so a retry does not spend the
 * customer's allowance for NEW conversations. Returns null when this is a
 * genuinely new request, in which case the caller must rate limit normally.
 *
 * Correctness does not rest on this: startConversation() repeats the check
 * inside its transaction. This only decides which rate-limit bucket is used.
 */
async function peekStart(db, input) {
  const conversationId = startConversationId(input.customerUid, input.clientMessageId);
  const conv = await db.collection(CONVERSATIONS).doc(conversationId).get();
  if (!conv.exists) return null;
  return resolveExistingStart(conv, input,
    messageId(conversationId, input.clientMessageId), startRequestHash(input));
}

/*
 * The same idea for a message send: is this exact message already stored?
 *
 * The conversation is checked too, so a caller who guessed an id cannot use
 * this to learn whether somebody else's message exists. Returns null when the
 * message is new, and the caller then rate limits normally.
 */
async function peekMessage(db, input) {
  const msgRef = db.collection(MESSAGES)
    .doc(messageId(input.conversationId, input.clientMessageId));
  const msg = await msgRef.get();
  if (!msg.exists) return null;

  const conv = await db.collection(CONVERSATIONS).doc(input.conversationId).get();
  if (!conv.exists) return null;
  const data = conv.data() || {};

  /* customerUid is only supplied for the customer route. Staff are authorised
     for every conversation, so there is nothing to compare for them. */
  if (input.customerUid !== undefined && data.customerUid !== input.customerUid) {
    throw notFoundForCustomer();
  }
  return { messageId: msgRef.id, duplicate: true };
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
    /*
     * THE SHOP NEEDS TO SEE THIS ONE.
     *
     * Raised from the document read in THIS transaction, and only on the
     * branch that actually stores a message - the duplicate branch above
     * returns before it, so a retried send does not make the same message
     * demand attention twice.
     *
     * staffReadVersion is untouched: whatever somebody has already
     * acknowledged stays acknowledged, and this new version sits above it.
     */
    tx.update(convRef, Object.assign({
      updatedAt: now,
      lastMessageAt: now,
      messageCount: (typeof data.messageCount === 'number' ? data.messageCount : 0) + 1
    }, A.raiseAttention(data, A.CUSTOMER_MESSAGE, now)));
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
      throw new ServiceError(404, 'conversation_not_found', STAFF_NOT_FOUND);
    }
    const data = conv.data() || {};

    /*
     * RE-CHECKED INSIDE THE TRANSACTION, not only at the door.
     *
     * The route already refused an unauthorised shop before getting here, but
     * a transfer can land in the gap between that check and this write. If it
     * did, the conversation is no longer this staff member's to answer, and
     * the reply must not be written - "I had it open a second ago" is not
     * authorisation. Reading it in the same transaction as the write is what
     * makes that race unwinnable.
     */
    if (input.actor && !L.canAccessLocation(input.actor, L.resolveLocation(data))) {
      throw new LocationError();
    }

    if (data.status !== 'open') {
      throw new ServiceError(409, 'conversation_closed', 'That conversation is closed.');
    }

    const existing = await tx.get(msgRef);
    if (existing.exists) return { messageId: msgRef.id, duplicate: true };

    tx.set(msgRef, buildMessage(input.conversationId, 'staff', input.message, now));
    /*
     * NO ATTENTION EVENT. Staff answering the shop's own phone is not
     * something the shop needs to be told about, and raising a version here
     * would make every reply light up every other computer in the building -
     * including a reminder chime three minutes later. Deliberately absent,
     * and there is a test that fails if somebody adds it.
     */
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
      throw new ServiceError(404, 'conversation_not_found', STAFF_NOT_FOUND);
    }
    const data = conv.data() || {};

    /* Re-checked in the transaction, for the same reason as the send path: a
       transfer landing mid-request must not leave the old shop able to close
       a conversation it no longer holds. */
    if (input.actor && !L.canAccessLocation(input.actor, L.resolveLocation(data))) {
      throw new LocationError();
    }

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
  /* Missing or unrecognised routing is 'unassigned' - never 'main'. There are
     real conversations in production from before routing existed. */
  const locationId = L.resolveLocation(d);
  return {
    conversationId: doc.id,
    customerName: d.customerName || null,
    customerEmail: d.customerEmail || null,
    status: d.status || null,
    /* Both, deliberately. The id is what authorisation and reconciliation
       compare; the label is what a person reads, derived here so no client
       has to know the words and no caller can supply them. */
    locationId: locationId,
    locationLabel: L.labelFor(locationId),
    createdAt: toMillis(d.createdAt),
    lastMessageAt: toMillis(d.lastMessageAt),
    messageCount: typeof d.messageCount === 'number' ? d.messageCount : 0,
    staffLastReadAt: toMillis(d.staffLastReadAt),
    /*
     * UNREAD, ANSWERED BY THE SERVER.
     *
     * The client is given the verdict, not the ingredients to compute it
     * from: two dashboards must never disagree about whether somebody has
     * looked at a conversation, and a client comparing formatted timestamps
     * is how they would. attentionVersion travels because the client has to
     * acknowledge A SPECIFIC VERSION - the one it rendered - and because it
     * is the dedupe identity for alerts.
     *
     * staffReadVersion is deliberately NOT serialised. Nothing on a screen
     * needs it, `unread` already answers the only question anybody asks, and
     * a field nobody needs is a field that cannot leak.
     */
    unread: A.isUnread(d),
    attentionVersion: A.attentionVersionOf(d),
    lastAttentionType: A.attentionTypeOf(d),
    lastAttentionAt: toMillis(d.lastAttentionAt)
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
 * The customer's own view of one conversation: is it still open?
 *
 * WHY THIS EXISTS. A customer's realtime listener watches chatMessages, and
 * closing a conversation touches only the conversation document - see
 * closeConversation() above, which writes status/closedAt/updatedAt and no
 * message at all. So a closed thread is completely invisible to the customer's
 * listener. Before this, they found out by sending a message and being refused,
 * and a page reload put the UI back to "Connected" because nothing on the
 * client knew any better.
 *
 * The conversation document itself stays client-private: firestore.rules denies
 * every browser read of chatConversations, because a rule cannot hide a field
 * inside a document it has allowed and that record carries customerEmail,
 * staffLastReadAt, staffNotifiedAt, startRequestHash and whatever a later phase
 * adds. This function is how a customer learns the one bit of it that is
 * theirs, without being handed the rest.
 *
 * TWO FIELDS OUT, AND NOTHING ELSE. Not publicConversation() - that is the
 * staff serialisation and carries name, email, counts and timestamps.
 *
 * NOT AN EXISTENCE ORACLE. A conversation that does not exist and one owned by
 * somebody else produce the SAME error, from the same helper the rest of this
 * file uses. Otherwise a caller could try ids until the message changed and
 * learn which ones are real.
 *
 * The status value is normalised to exactly 'open' or 'closed' rather than
 * echoed: whatever ends up in that field, the customer sees one of two words.
 */
async function readConversationStatus(db, input) {
  const conv = await db.collection(CONVERSATIONS).doc(input.conversationId).get();
  if (!conv.exists) throw notFoundForCustomer();

  const data = conv.data() || {};
  /* Ownership, against the VERIFIED uid from the token - never the body. */
  if (data.customerUid !== input.customerUid) throw notFoundForCustomer();

  return {
    conversationId: conv.id,
    status: data.status === 'closed' ? 'closed' : 'open',
    /*
     * The customer's OWN conversation's destination. Safe to tell them - it
     * is where their message went, and they chose it. The client derives the
     * friendly label from this id; no staff uid, no transfer actor, no audit
     * field and no staff record travels with it.
     */
    locationId: L.resolveLocation(data)
  };
}

/*
 * The staff inbox, filtered to the shops this staff member may actually see.
 *
 * WHY THIS IS NOT ONE CLEAN `where('locationId','in',[...])`.
 *
 * Firestore indexes fields that EXIST. A document written before routing
 * existed has no locationId at all, so no positive filter on that field can
 * ever match it - `== 'unassigned'` misses it, and so does `in [...]`. There
 * are real conversations like that in production, and the instruction is that
 * they stay visible without a backfill. So the query shape depends on whether
 * the caller's authorised set includes 'unassigned':
 *
 *   INCLUDES 'unassigned'  - no location filter. Query by status exactly as
 *     before, then drop unauthorised rows here in the server. Legacy
 *     documents come back, which is the point. Bounded by MAX_INBOX, and for
 *     the all-shop case (every admin today) nothing is dropped at all.
 *
 *   EXCLUDES 'unassigned'  - `where('locationId','in', locations)`. Precise,
 *     indexed, no over-fetch, and legacy documents are correctly absent
 *     because an unassigned conversation is not this caller's to see.
 *
 * Either way the filtering is SERVER-SIDE. A browser cannot widen it, and the
 * caller's locations came from their own staff document, not their request.
 *
 * THE TRADE, STATED: in the first shape a page of up to MAX_INBOX rows can
 * come back partly filtered, so a caller may see fewer than `limit` rows even
 * when more exist. With a handful of open conversations that is invisible;
 * with hundreds it would need a cursor. Not worth building today, and noted.
 */
async function listConversations(db, opts) {
  const status = (opts && opts.status) || 'open';
  const limit = Math.min(Math.max(1, (opts && opts.limit) || MAX_INBOX), MAX_INBOX);
  const allowed = (opts && Array.isArray(opts.locations)) ? opts.locations : [];

  /* No shops, no inbox. Not an error - an unassigned staff member simply has
     nothing to look at yet, and saying so is better than a 403 that reads
     like "you are not staff". */
  if (!allowed.length) {
    return { conversations: [], limit: limit, status: status, locations: [] };
  }

  const wantsUnassigned = allowed.indexOf(L.UNASSIGNED) !== -1;
  let query = db.collection(CONVERSATIONS).where('status', '==', status);
  if (!wantsUnassigned) {
    /* Every id is canonical - they came from locations.js, not a request. */
    query = query.where('locationId', 'in', allowed);
  }

  const snap = await query.orderBy('lastMessageAt', 'desc').limit(limit).get();

  const conversations = snap.docs
    .map(publicConversation)
    .filter((c) => allowed.indexOf(c.locationId) !== -1);

  return {
    conversations: conversations,
    limit: limit,
    status: status,
    /* Echoed so the dashboard can build exactly the filters this account is
       entitled to, rather than guessing from a role. */
    locations: allowed.slice()
  };
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
    throw new ServiceError(404, 'conversation_not_found', STAFF_NOT_FOUND);
  }

  /*
   * Load, resolve, authorise, THEN return messages - in that order, before a
   * single message document is read. An unauthorised id gets the same answer
   * as a nonexistent one, so guessing ids tells a caller nothing about the
   * other shop.
   */
  if (opts.actor && !L.canAccessLocation(opts.actor, L.resolveLocation(conv.data() || {}))) {
    throw new LocationError();
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

/* ------------------------------------------------- staff location gates */

/*
 * ONE ANSWER FOR "does not exist" AND "not your shop".
 *
 * A staff member who guesses a conversationId belonging to the other shop
 * must not be able to tell the difference between a real conversation they
 * may not see and one that was never there. Same status, same code, same
 * sentence - so the endpoint is not a cross-shop existence oracle.
 *
 * THE SENTENCE IS COPIED, NOT INVENTED. It is the exact wording the staff
 * routes already use when a conversation genuinely does not exist, above and
 * in sendStaffMessage() and closeConversation(). A near-miss - "not
 * available" against "no longer exists" - reads as identical to a person and
 * is a perfect oracle to a script, which is the only reader that matters
 * here. STAFF_NOT_FOUND is the single definition all four sites share so the
 * two cannot drift apart in a later edit.
 *
 * Extends ServiceError so it carries chatErrorKind: 'service' and is
 * recognised by respondToError() by tag as well as by instanceof - the same
 * reason every other error class in this system is tagged.
 */
class LocationError extends ServiceError {
  constructor() {
    super(404, 'conversation_not_found', STAFF_NOT_FOUND);
    this.name = 'LocationError';
  }
}

/*
 * Load a conversation and prove this staff member may act on it.
 *
 * EVERY staff route that touches one conversation goes through here, in this
 * order: load the real document, resolve ITS location (missing => unassigned),
 * then check the actor's own authorised set. The browser supplies only the id;
 * it never says which shop the conversation is at, so it cannot lie about it.
 */
async function loadConversationForStaff(db, actor, conversationId) {
  const ref = db.collection(CONVERSATIONS).doc(conversationId);
  const snap = await ref.get();
  if (!snap.exists) throw new LocationError();

  const data = snap.data() || {};
  const locationId = L.resolveLocation(data);
  if (!L.canAccessLocation(actor, locationId)) throw new LocationError();

  return { ref, snap, data, locationId };
}

/*
 * Hand a conversation to the other shop.
 *
 * SOURCE AUTHORISATION, NOT DESTINATION AUTHORISATION. Main-only staff who
 * find a curved-scupper job in their inbox must be able to send it to Keith
 * Street - that is the entire point, and requiring destination access would
 * mean only a manager could ever fix a misroute. What they do NOT get is a
 * way in: the moment the id changes, their ordinary read rules apply again
 * and the conversation is gone from their inbox. Handing something over is
 * not the same as being let into the room.
 *
 * ONE TRANSACTION. The authorisation re-check and the write happen together,
 * so a transfer racing another transfer cannot act on a location that has
 * already moved: the loser re-reads, finds a source it is no longer
 * authorised for, and is refused.
 *
 * OPEN ONLY. A closed conversation does not silently change shop - there is
 * nobody to hand it to and nothing left to do with it.
 */
async function transferConversation(db, deps, input) {
  const now = deps.now();
  const ref = db.collection(CONVERSATIONS).doc(input.conversationId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new LocationError();

    const data = snap.data() || {};
    const from = L.resolveLocation(data);

    /* Re-checked INSIDE the transaction, against the document as it is now -
       never against anything the request said about where it came from. */
    if (!L.canAccessLocation(input.actor, from)) throw new LocationError();

    if (data.status !== 'open') {
      throw new ServiceError(409, 'conversation_closed',
        'That conversation is closed and cannot be transferred.');
    }

    /*
     * Already there. A safe no-op: no write, no audit entry, no bump of
     * transferCount. Somebody double-clicked, or two people fixed the same
     * misroute at once, and neither is an event worth recording twice.
     */
    if (from === input.locationId) {
      return {
        conversationId: ref.id,
        locationId: from,
        previousLocationId: from,
        changed: false
      };
    }

    /*
     * The audit, and only what answers the four questions: where from, where
     * to, when, and which authenticated staff uid did it. Server-owned every
     * one - none is accepted from a request, and requireNoPrivilegedFields()
     * refuses a body that tries.
     *
     * DELIBERATELY NOT AN ARRAY. A per-transfer history would grow without
     * bound inside a document that is read on every inbox poll. The most
     * recent transfer is what anybody actually asks about; a full history, if
     * it is ever wanted, belongs in its own collection and is reported as a
     * separate design rather than smuggled in here.
     *
     * lastMessageAt and messageCount are NOT touched: nothing was said. The
     * dashboard notices the move through locationId, which is part of its
     * reconciliation marker for exactly this reason.
     */
    /*
     * A HANDOFF IS SOMETHING THE DESTINATION SHOP HAS TO BE TOLD ABOUT.
     *
     * Keith Street has no other way to learn that 1st Avenue just sent them a
     * curved-scupper job: no message was written, so lastMessageAt and
     * messageCount do not move and nothing else on the document changes in a
     * way their dashboard would notice as "somebody said something".
     *
     * Raised here rather than left to the client, and NOT auto-acknowledged
     * for the person doing the transferring even when they can also read the
     * destination - see the note on requestTransfer() in chat-staff.js. The
     * destination team gets their alert.
     *
     * The same-shop no-op returns above without reaching this line, so
     * double-clicking Move does not manufacture attention.
     */
    tx.update(ref, Object.assign({
      locationId: input.locationId,
      previousLocationId: from,
      lastTransferredAt: now,
      lastTransferredByStaffUid: input.actor.uid,
      transferCount: (typeof data.transferCount === 'number' ? data.transferCount : 0) + 1,
      updatedAt: now
    }, A.raiseAttention(data, A.TRANSFER, now)));

    return {
      conversationId: ref.id,
      locationId: input.locationId,
      previousLocationId: from,
      changed: true
    };
  });
}

/*
 * Somebody actually looked at this conversation.
 *
 * The client sends THE VERSION IT RENDERED, not "now" and not "the latest".
 * That single choice is what makes the whole thing race-safe: between the
 * transcript being fetched and this call landing, the customer may well have
 * sent another message, and acknowledging anything the client did not see
 * would lose it silently. See the worked example at the top of attention.js.
 *
 * AUTHORISED AGAINST THE CURRENT STORED LOCATION, INSIDE THE TRANSACTION.
 * A conversation can be transferred in the gap between opening it and
 * acknowledging it. Main-only staff who had it open must not be able to clear
 * Keith Street's unread flag with a stale id and a stale version - so the
 * shop is re-read here, not taken from whatever the route decided a moment
 * ago.
 *
 * IDEMPOTENT. Two computers acknowledging the same version, or the same
 * computer acknowledging twice, both settle on the same number:
 * resolveReadVersion() is a pure max/min with no accumulation in it.
 */
async function markConversationRead(db, deps, input) {
  const now = deps.now();
  const ref = db.collection(CONVERSATIONS).doc(input.conversationId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    /* Same answer as a conversation that never existed - see LocationError. */
    if (!snap.exists) throw new LocationError();

    const data = snap.data() || {};
    if (!L.canAccessLocation(input.actor, L.resolveLocation(data))) {
      throw new LocationError();
    }

    const before = A.readVersionOf(data);
    const attention = A.attentionVersionOf(data);
    const after = A.resolveReadVersion(data, input.attentionVersion);

    /*
     * NOTHING TO WRITE is the common case by a wide margin: a poll that
     * re-renders a thread already acknowledged lands here every time. Writing
     * anyway would cost a document write per poll per open dashboard, for no
     * change at all.
     */
    if (after !== before) {
      tx.update(ref, {
        staffReadVersion: after,
        /* The old timestamp field, kept and still maintained because it is
           genuinely useful to a person reading a document by hand. It is no
           longer the authority for anything, and it moves ONLY when the read
           version genuinely advances. */
        staffLastReadAt: now,
        updatedAt: now
      });
    }

    return {
      conversationId: ref.id,
      attentionVersion: attention,
      readVersion: after,
      unread: attention > after,
      changed: after !== before
    };
  });
}

module.exports = {
  CONVERSATIONS, MESSAGES, MAX_TRANSCRIPT, MAX_INBOX,
  markConversationRead,
  LocationError, loadConversationForStaff, transferConversation,
  START_ID_DOMAIN, START_HASH_DOMAIN,
  ServiceError, messageId, buildMessage, startConversationId, startRequestHash,
  startConversation, sendCustomerMessage, sendStaffMessage, closeConversation,
  peekStart, peekMessage, resolveExistingStart,
  listConversations, readTranscript,
  readConversationStatus,
  publicConversation, publicMessage, toMillis
};
