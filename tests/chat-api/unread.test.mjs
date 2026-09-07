/*
 * UNREAD, AND WHAT IT TAKES TO CLEAR IT.
 *
 * The shop needs to be able to walk away from the screen and still know a
 * customer is waiting - and to stop being told the moment somebody actually
 * looks, on whichever computer they happen to be at. Every one of those is a
 * server question, so every one of them is tested here against the real
 * handlers and the real Firestore emulator.
 *
 * THE THING THESE TESTS EXIST TO STOP: a customer message that arrives in the
 * gap between a transcript being fetched and a read acknowledgement landing,
 * and is marked read without anybody having seen it.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  db, handlerFor, call, wipe, uuid, anonToken, passwordToken, seedStaff,
  getConversation, countMessages, Timestamp
} from './helpers.mjs';

const ROOT = '/home/user/esthers';
const START = ROOT + '/api/chat/start.js';
const SEND = ROOT + '/api/chat/send.js';
const STATUS = ROOT + '/api/chat/status.js';
const CONVERSATIONS = ROOT + '/api/admin/chat/conversations.js';
const MESSAGES = ROOT + '/api/admin/chat/messages.js';
const STAFF_SEND = ROOT + '/api/admin/chat/send.js';
const CLOSE = ROOT + '/api/admin/chat/close.js';
const TRANSFER = ROOT + '/api/admin/chat/transfer.js';
const READ = ROOT + '/api/admin/chat/read.js';

/* The production shapes, as they actually are since the routing rollout. */
const MGR = 'staff-manager';          /* all three shops                     */
const MAIN_ONLY = 'staff-main-only';  /* ['main']  - the counter computer    */
const SPEC_ONLY = 'staff-spec-only';  /* ['specialty']                       */
const CUST = 'anon-customer-a';

const TOKENS = {
  mgr: passwordToken(MGR, 'manager@example.test'),
  main: passwordToken(MAIN_ONLY, 'counter@example.test'),
  spec: passwordToken(SPEC_ONLY, 'keith@example.test'),
  cust: anonToken(CUST)
};

const start = () => handlerFor(START, TOKENS);
const custSend = () => handlerFor(SEND, TOKENS);
const status = () => handlerFor(STATUS, TOKENS);
const inbox = () => handlerFor(CONVERSATIONS, TOKENS);
const transcript = () => handlerFor(MESSAGES, TOKENS);
const reply = () => handlerFor(STAFF_SEND, TOKENS);
const close = () => handlerFor(CLOSE, TOKENS);
const transfer = () => handlerFor(TRANSFER, TOKENS);
const markRead = () => handlerFor(READ, TOKENS);

before(async () => { await wipe(); });
beforeEach(async () => {
  await wipe();
  await seedStaff(MGR, { isActive: true, role: 'admin',
    locations: ['main', 'specialty', 'unassigned'] });
  await seedStaff(MAIN_ONLY, { isActive: true, role: 'admin', locations: ['main'] });
  await seedStaff(SPEC_ONLY, { isActive: true, role: 'admin', locations: ['specialty'] });
});

const goodStart = (over = {}) => Object.assign({
  name: 'John Smith', email: 'john@example.test',
  message: 'Hi, I need a custom chimney cap...', clientMessageId: uuid(),
  locationId: 'main'
}, over);

async function conversationAt(locationId = 'main') {
  const res = await call(start(), { token: 'cust', body: goodStart({ locationId }) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return res.payload.conversationId;
}

/* One genuine new customer message. Returns the clientMessageId so a test can
   replay the SAME request and prove the replay changes nothing. */
async function customerSays(id, message = 'and another thing') {
  const clientMessageId = uuid();
  const res = await call(custSend(), { token: 'cust', body: {
    conversationId: id, message, clientMessageId } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return clientMessageId;
}

/* What the staff inbox says about one conversation. */
async function row(id, token = 'mgr') {
  const res = await call(inbox(), { method: 'GET', token });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return res.payload.conversations.find((c) => c.conversationId === id) || null;
}

const versions = async (id) => {
  const c = await getConversation(id);
  return { attention: c.staffAttentionVersion, read: c.staffReadVersion,
           type: c.lastAttentionType };
};

/*
 * A conversation as it exists in production from BEFORE this feature: no
 * attention fields at all. Written straight to Firestore because the API can
 * no longer create one.
 */
async function legacyConversation(id = 'legacy-unread-1', locationId = 'main') {
  const doc = {
    customerUid: CUST,
    customerName: 'Old Customer',
    customerEmail: 'old@example.test',
    locationId: locationId,
    status: 'open',
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    lastMessageAt: Timestamp.now(),
    messageCount: 1, closedAt: null,
    staffLastReadAt: null, customerLastReadAt: null, staffNotifiedAt: null
    /* NO staffAttentionVersion, NO staffReadVersion - that is the point */
  };
  await db().collection('chatConversations').doc(id).set(doc);
  await db().collection('chatMessages').doc(id + '__m1').set({
    conversationId: id, senderType: 'customer',
    body: 'a message from before unread existed', createdAt: Timestamp.now()
  });
  return id;
}

/* ================================================= 1-8. RAISING ATTENTION */

describe('what raises attention, and what deliberately does not', () => {
  test('A NEW CONVERSATION IS UNREAD FROM THE INSTANT IT EXISTS', async () => {
    const id = await conversationAt('main');
    const v = await versions(id);
    assert.equal(v.attention, 1, 'attentionVersion starts at 1');
    assert.equal(v.read, 0, 'readVersion starts at 0');
    assert.equal(v.type, 'new_conversation');

    const r = await row(id);
    assert.equal(r.unread, true);
    assert.equal(r.attentionVersion, 1);
    assert.equal(r.lastAttentionType, 'new_conversation');
    assert.equal(typeof r.lastAttentionAt, 'number', 'a millisecond stamp');
  });

  test('a genuine customer message increments it', async () => {
    const id = await conversationAt('main');
    await customerSays(id);
    const v = await versions(id);
    assert.equal(v.attention, 2);
    assert.equal(v.read, 0, 'and does not touch what was acknowledged');
    assert.equal(v.type, 'customer_message');

    await customerSays(id, 'a third');
    assert.equal((await versions(id)).attention, 3);
  });

  test('AN IDEMPOTENT REPLAY DOES NOT INCREMENT TWICE', async () => {
    /*
     * The whole point of the idempotency key. A flaky connection retrying the
     * same message must not make the shop think two customers are waiting -
     * and must not re-raise attention on a conversation somebody just read.
     */
    const id = await conversationAt('main');
    const key = await customerSays(id, 'exactly once please');
    assert.equal((await versions(id)).attention, 2);

    for (let i = 0; i < 3; i += 1) {
      const again = await call(custSend(), { token: 'cust', body: {
        conversationId: id, message: 'exactly once please', clientMessageId: key } });
      assert.equal(again.statusCode, 200, 'the replay still succeeds');
    }
    assert.equal((await versions(id)).attention, 2, 'still 2 after three replays');
  });

  test('AN IDEMPOTENT START REPLAY DOES NOT INCREMENT EITHER', async () => {
    const body = goodStart();
    const first = await call(start(), { token: 'cust', body });
    assert.equal(first.statusCode, 200);
    const id = first.payload.conversationId;

    const replay = await call(start(), { token: 'cust', body });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.payload.conversationId, id, 'the same conversation');
    assert.equal((await versions(id)).attention, 1, 'still 1');
  });

  test("A STAFF REPLY RAISES NOTHING - the shop is not alerted by itself",
    async () => {
      const id = await conversationAt('main');
      const before = await versions(id);
      const res = await call(reply(), { token: 'main', body: {
        conversationId: id, message: 'Let me check on that.',
        clientMessageId: uuid() } });
      assert.equal(res.statusCode, 200);

      const after = await versions(id);
      assert.equal(after.attention, before.attention, 'attentionVersion untouched');
      assert.equal(after.read, before.read, 'readVersion untouched');
      assert.equal(after.type, before.type, 'and the reason did not change');
      /* But the message really was written - so this is not a no-op test. */
      assert.equal((await getConversation(id)).messageCount, 2);
    });

  test('A CHANGED TRANSFER CREATES ATTENTION FOR THE DESTINATION', async () => {
    const id = await conversationAt('main');
    /* Read it first, so the transfer is the only thing that could make it
       unread again. */
    await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 1 } });
    assert.equal((await row(id)).unread, false, 'read to begin with');

    const t = await call(transfer(), { token: 'main', body: {
      conversationId: id, locationId: 'specialty' } });
    assert.equal(t.statusCode, 200);
    assert.equal(t.payload.changed, true);

    const v = await versions(id);
    assert.equal(v.attention, 2, 'the handoff is an attention event');
    assert.equal(v.read, 1, 'and the old acknowledgement stands');
    assert.equal(v.type, 'transfer');
    assert.equal((await row(id)).unread, true, 'Keith Street has something to see');
  });

  test('a transfer does NOT bump messageCount or lastMessageAt', async () => {
    const id = await conversationAt('main');
    const before = await getConversation(id);
    await call(transfer(), { token: 'main', body: {
      conversationId: id, locationId: 'specialty' } });
    const after = await getConversation(id);
    assert.equal(after.messageCount, before.messageCount, 'nothing was said');
    assert.equal(after.lastMessageAt.toMillis(), before.lastMessageAt.toMillis());
  });

  test('a SAME-LOCATION transfer raises nothing', async () => {
    const id = await conversationAt('main');
    await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 1 } });

    const t = await call(transfer(), { token: 'main', body: {
      conversationId: id, locationId: 'main' } });
    assert.equal(t.statusCode, 200);
    assert.equal(t.payload.changed, false, 'a safe no-op');

    const v = await versions(id);
    assert.equal(v.attention, 1, 'no attention manufactured by a double-click');
    assert.equal(v.read, 1);
    assert.equal((await row(id)).unread, false);
  });
});

/* ================================================== 9-11. LEGACY DOCUMENTS */

describe('conversations from before this feature stay quiet', () => {
  test('MISSING VERSIONS NORMALISE TO 0/0 AND ARE NOT UNREAD', async () => {
    /*
     * The whole migration. The day this deploys, no historical conversation
     * starts shouting at anybody - and nothing is written to make that true.
     */
    const id = await legacyConversation();
    const raw = await getConversation(id);
    assert.equal(raw.staffAttentionVersion, undefined, 'genuinely absent');
    assert.equal(raw.staffReadVersion, undefined);

    const r = await row(id);
    assert.ok(r, 'it is still in the inbox');
    assert.equal(r.unread, false, 'and it is NOT shouting');
    assert.equal(r.attentionVersion, 0);
    assert.equal(r.lastAttentionType, null, 'no reason, because nothing happened');
    assert.equal(r.lastAttentionAt, null);

    /* And nothing was written to it to make that work. */
    const after = await getConversation(id);
    assert.equal(after.staffAttentionVersion, undefined, 'no backfill happened');
  });

  test('the next genuine customer message initialises it from zero', async () => {
    const id = await legacyConversation();
    await customerSays(id, 'still waiting on that quote');
    const v = await versions(id);
    assert.equal(v.attention, 1, '0 + 1');
    assert.equal(v.read, undefined, 'read is still absent, and reads as 0');
    assert.equal(v.type, 'customer_message');
    assert.equal((await row(id)).unread, true);
  });

  test('a transfer initialises a legacy conversation too', async () => {
    const id = await legacyConversation('legacy-unread-2', 'main');
    await call(transfer(), { token: 'main', body: {
      conversationId: id, locationId: 'specialty' } });
    const v = await versions(id);
    assert.equal(v.attention, 1);
    assert.equal(v.type, 'transfer');
  });

  test('a garbled version reads as 0 rather than as an alert', async () => {
    /* Reading a value nobody can explain as 0 makes a conversation look READ.
       A document that is corrupt should not be the one that wakes the shop. */
    const id = await conversationAt('main');
    for (const bad of ['7', 7.5, -1, NaN, null, {}, Number.MAX_SAFE_INTEGER]) {
      await db().collection('chatConversations').doc(id)
        .update({ staffAttentionVersion: bad, staffReadVersion: 0 });
      const r = await row(id);
      assert.equal(r.attentionVersion, 0, JSON.stringify(bad) + ' -> 0');
      assert.equal(r.unread, false, JSON.stringify(bad) + ' must not alert');
    }
  });
});

/* ======================================== 12-17. MARKING IT READ, SAFELY */

describe('marking a conversation read', () => {
  test('reading the exact observed version clears unread', async () => {
    const id = await conversationAt('main');
    assert.equal((await row(id)).unread, true);

    const res = await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 1 } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.unread, false);
    assert.equal(res.payload.readVersion, 1);
    assert.equal(res.payload.attentionVersion, 1);
    assert.equal((await row(id)).unread, false);
  });

  test('THE RACE: a message arriving between render and acknowledgement is '
    + 'NOT swallowed', async () => {
      /*
       * The exact scenario a timestamp design loses.
       *
       *   staff renders v7  ->  customer sends, server is now v8  ->
       *   staff acknowledges 7  ->  8 must still be outstanding.
       */
      const id = await conversationAt('main');
      for (let i = 0; i < 6; i += 1) await customerSays(id, 'message ' + i);
      assert.equal((await versions(id)).attention, 7, 'set the stage at v7');

      /* The staff member's browser rendered version 7. */
      const rendered = (await call(transcript(), { method: 'GET', token: 'main',
        query: { conversationId: id } })).payload.conversation.attentionVersion;
      assert.equal(rendered, 7);

      /* The customer types again before the acknowledgement lands. */
      await customerSays(id, 'one more thing');
      assert.equal((await versions(id)).attention, 8);

      /* The acknowledgement, for the version actually seen. */
      const res = await call(markRead(), { token: 'main', body: {
        conversationId: id, attentionVersion: rendered } });
      assert.equal(res.statusCode, 200);

      const v = await versions(id);
      assert.equal(v.read, 7, 'exactly what was observed');
      assert.equal(v.attention, 8, 'and the new message still stands above it');
      assert.equal(res.payload.unread, true, 'the server says so in the answer');
      assert.equal((await row(id)).unread, true, 'STILL UNREAD');
    });

  test('CANNOT ADVANCE BEYOND THE CURRENT ATTENTION VERSION', async () => {
    const id = await conversationAt('main');              /* v1 */
    const res = await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 999 } });
    assert.equal(res.statusCode, 200, 'not an error - just not believed');
    assert.equal(res.payload.readVersion, 1, 'clamped to what exists');
    assert.equal((await versions(id)).read, 1);

    /* And the clamp is not a one-off: a later real message is still unread. */
    await customerSays(id);
    assert.equal((await row(id)).unread, true);
  });

  test('AN OLDER ACKNOWLEDGEMENT CANNOT MOVE IT BACKWARDS', async () => {
    const id = await conversationAt('main');
    await customerSays(id);
    await customerSays(id);                                /* v3 */

    await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 3 } });
    assert.equal((await versions(id)).read, 3);

    /* A slow request for an older version lands late. */
    const late = await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 1 } });
    assert.equal(late.statusCode, 200);
    assert.equal(late.payload.readVersion, 3, 'a no-op, not a regression');
    assert.equal((await versions(id)).read, 3);
    assert.equal((await row(id)).unread, false, 'and it did not become unread again');
  });

  test('two staff acknowledging the same version is idempotent', async () => {
    const id = await conversationAt('main');
    const a = await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 1 } });
    const b = await call(markRead(), { token: 'mgr', body: {
      conversationId: id, attentionVersion: 1 } });
    assert.equal(a.payload.readVersion, 1);
    assert.equal(b.payload.readVersion, 1);
    assert.equal((await versions(id)).read, 1);
  });

  test('a nonsense attentionVersion is refused, not coerced', async () => {
    const id = await conversationAt('main');
    for (const bad of ['1', 1.5, -1, null, undefined, {}, [], true, NaN,
                       Number.MAX_SAFE_INTEGER]) {
      const body = { conversationId: id };
      if (bad !== undefined) body.attentionVersion = bad;
      const res = await call(markRead(), { token: 'main', body });
      assert.equal(res.statusCode, 400, JSON.stringify(bad) + ' was accepted');
      assert.equal(res.payload.code, 'invalid_attention_version');
    }
    assert.equal((await versions(id)).read, 0, 'and nothing was written');
  });

  test('a caller cannot write its own read state', async () => {
    const id = await conversationAt('main');
    for (const field of ['staffReadVersion', 'staffAttentionVersion',
                         'lastAttentionAt', 'lastAttentionType', 'unread',
                         'staffLastReadAt']) {
      const body = { conversationId: id, attentionVersion: 1 };
      body[field] = 99;
      const res = await call(markRead(), { token: 'main', body });
      assert.equal(res.statusCode, 400, field + ' was accepted');
      assert.equal(res.payload.code, 'forbidden_field');
    }
    assert.equal((await versions(id)).read, 0);
  });
});

/* ============================== 18-22. LOCATION AUTHORISATION ON /read */

describe('unread obeys the shop model', () => {
  test('MAIN-ONLY STAFF CANNOT MARK A SPECIALTY CONVERSATION READ', async () => {
    const id = await conversationAt('specialty');
    const res = await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 1 } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
    assert.equal((await versions(id)).read, 0, 'and nothing was written');

    /* THE SAME ANSWER as an id that never existed, so guessing tells them
       nothing about the other shop. */
    const ghost = await call(markRead(), { token: 'main', body: {
      conversationId: 'x'.repeat(20), attentionVersion: 1 } });
    assert.equal(ghost.statusCode, res.statusCode);
    assert.equal(ghost.payload.code, res.payload.code);
    assert.equal(ghost.payload.error, res.payload.error);
  });

  test('THE TRANSFER AUTH RACE: a stale acknowledgement from the old shop is '
    + 'refused', async () => {
      /*
       * Main-only staff open a Main conversation, it is transferred to Keith
       * Street, and only then does their read acknowledgement arrive. It must
       * not clear Keith Street's unread flag.
       */
      const id = await conversationAt('main');
      const rendered = (await call(transcript(), { method: 'GET', token: 'main',
        query: { conversationId: id } })).payload.conversation.attentionVersion;

      await call(transfer(), { token: 'main', body: {
        conversationId: id, locationId: 'specialty' } });

      const late = await call(markRead(), { token: 'main', body: {
        conversationId: id, attentionVersion: rendered } });
      assert.equal(late.statusCode, 404, 'the current shop is what counts');
      assert.equal((await versions(id)).read, 0);
      assert.equal((await row(id, 'spec')).unread, true,
        'Keith Street still has their handoff to look at');
    });

  test('manager can mark every authorised shop read', async () => {
    for (const where of ['main', 'specialty', 'unassigned']) {
      const id = await conversationAt(where);
      const res = await call(markRead(), { token: 'mgr', body: {
        conversationId: id, attentionVersion: 1 } });
      assert.equal(res.statusCode, 200, where);
      assert.equal(res.payload.unread, false);
    }
  });

  test('the counter computer never learns Keith Street exists', async () => {
    const spec = await conversationAt('specialty');
    const mine = await conversationAt('main');
    const res = await call(inbox(), { method: 'GET', token: 'main' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.conversations.map((c) => c.conversationId),
      [mine], 'one row, and it is theirs');
    /* Not even its unread state leaks - the row is simply not there. */
    assert.equal(JSON.stringify(res.payload).indexOf(spec), -1);
  });

  test('the read response exposes no internal staff or audit field', async () => {
    const id = await conversationAt('main');
    await call(markRead(), { token: 'mgr', body: {
      conversationId: id, attentionVersion: 1 } });
    const res = await call(markRead(), { token: 'main', body: {
      conversationId: id, attentionVersion: 1 } });
    assert.deepEqual(Object.keys(res.payload).sort(),
      ['attentionVersion', 'conversationId', 'ok', 'readVersion', 'unread']);
    const body = JSON.stringify(res.payload);
    for (const secret of [MGR, MAIN_ONLY, CUST, 'staffLastReadAt',
                          'lastTransferredByStaffUid', 'customerUid',
                          'customerEmail', 'john@example.test']) {
      assert.equal(body.indexOf(secret), -1, secret + ' leaked');
    }
  });
});

/* ============================ 23-27. THE REST OF THE SURFACE IS UNCHANGED */

describe('the rest of the API learns nothing it should not', () => {
  test('THE CUSTOMER IS TOLD NOTHING ABOUT STAFF UNREAD STATE', async () => {
    const id = await conversationAt('main');
    await customerSays(id);
    const res = await call(status(), { method: 'GET', token: 'cust',
      query: { conversationId: id } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.payload).sort(),
      ['conversationId', 'locationId', 'ok', 'status'],
      'still exactly four keys');
    for (const secret of ['unread', 'attentionVersion', 'staffAttentionVersion',
                          'staffReadVersion', 'lastAttentionType',
                          'lastAttentionAt', 'staffLastReadAt']) {
      assert.equal(res.payload[secret], undefined, secret + ' leaked to a customer');
    }
  });

  test('the start response is unchanged too', async () => {
    const res = await call(start(), { token: 'cust', body: goodStart() });
    assert.deepEqual(Object.keys(res.payload).sort(),
      ['conversationId', 'locationId', 'messageId', 'ok', 'status']);
  });

  test('GET /messages does not mark anything read', async () => {
    /*
     * Fetching is not looking. A background tab, a prefetch and a poll all
     * fetch, and none of them means a person read anything.
     */
    const id = await conversationAt('main');
    for (let i = 0; i < 3; i += 1) {
      const t = await call(transcript(), { method: 'GET', token: 'main',
        query: { conversationId: id } });
      assert.equal(t.statusCode, 200);
      assert.equal(t.payload.conversation.unread, true, 'still unread');
      assert.equal(t.payload.conversation.attentionVersion, 1,
        'and it says which version this transcript is');
    }
    assert.equal((await versions(id)).read, 0, 'nothing was acknowledged');
  });

  test('closing does not change attention, and a closed row is still honest',
    async () => {
      const id = await conversationAt('main');
      const before = await versions(id);
      const res = await call(close(), { token: 'main', body: { conversationId: id } });
      assert.equal(res.statusCode, 200);
      const after = await versions(id);
      assert.equal(after.attention, before.attention);
      assert.equal(after.read, before.read);

      /* It leaves the Open inbox, which is what stops it being monitored -
         the client's alert monitor only ever looks at open conversations. */
      const open = await call(inbox(), { method: 'GET', token: 'main' });
      assert.equal(open.payload.conversations.length, 0);
      const closed = await call(inbox(), { method: 'GET', token: 'main',
        query: { status: 'closed' } });
      assert.equal(closed.payload.conversations[0].unread, true,
        'and it still tells the truth about itself when asked directly');
    });

  test('the three attention types are exactly the three, and are never echoed',
    async () => {
      const id = await conversationAt('main');
      assert.equal((await row(id)).lastAttentionType, 'new_conversation');
      await customerSays(id);
      assert.equal((await row(id)).lastAttentionType, 'customer_message');
      await call(transfer(), { token: 'main', body: {
        conversationId: id, locationId: 'specialty' } });
      assert.equal((await row(id, 'mgr')).lastAttentionType, 'transfer');

      /* Anything else on the document reads as null rather than reaching a
         screen - this is the last stop before a string is displayed. */
      await db().collection('chatConversations').doc(id)
        .update({ lastAttentionType: '<img src=x onerror=alert(1)>' });
      assert.equal((await row(id, 'mgr')).lastAttentionType, null);
    });
});

/* ================================ THE SHOP-WIDE PROMISE, END TO END */

describe('one person looking is enough for the whole shop', () => {
  test('THE CORE REQUIREMENT: the other computer stops asking after its next '
    + 'poll', async () => {
      /*
       * Two computers signed in for Main Shop. A customer writes. Both see
       * unread. One person opens it. The other computer's next ordinary inbox
       * refresh must report unread=false - that is what makes the reminders
       * stop everywhere, and it is the reason read state is server-persisted
       * rather than kept in a tab.
       */
      const id = await conversationAt('main');
      await customerSays(id, 'anyone there?');

      /* Computer A (the counter) and Computer B (the manager) both see it. */
      assert.equal((await row(id, 'main')).unread, true, 'counter sees unread');
      assert.equal((await row(id, 'mgr')).unread, true, 'office sees unread');

      /* Computer B opens it and acknowledges the version it rendered. */
      const rendered = (await call(transcript(), { method: 'GET', token: 'mgr',
        query: { conversationId: id } })).payload.conversation.attentionVersion;
      const ack = await call(markRead(), { token: 'mgr', body: {
        conversationId: id, attentionVersion: rendered } });
      assert.equal(ack.statusCode, 200);

      /* Computer A's very next poll - no action taken on that machine. */
      assert.equal((await row(id, 'main')).unread, false,
        'the counter computer stops asking');
      assert.equal((await row(id, 'mgr')).unread, false);
    });
});

/* ======================= NO CUSTOMER MESSAGE TEXT LEAVES chatMessages */

/*
 * WHAT A CUSTOMER WROTE STAYS IN chatMessages.
 *
 * An earlier draft copied the first hundred characters of each customer
 * message onto the conversation, so a desktop pop-up could quote it. It was
 * removed: a native notification lands on whatever screen the browser is on,
 * and a shop monitor faces the counter. The requirement is to make a new
 * message impossible to MISS, not to put its contents in front of whoever is
 * standing there before a staff member has opened the thread.
 *
 * These tests exist so it cannot come back by accident.
 */
describe('no message body is copied onto the conversation', () => {
  const BODIES = ['lastMessagePreview', 'messagePreview', 'preview',
                  'lastMessageBody', 'lastMessageText', 'snippet', 'excerpt',
                  'lastCustomerMessage'];

  test('NOTHING IS WRITTEN ON CREATION', async () => {
    const id = await conversationAt('main');
    const raw = await getConversation(id);
    for (const f of BODIES) {
      assert.equal(raw[f], undefined, f + ' was written to the conversation');
    }
    /* And the message itself really is stored, in the collection it belongs
       to - so this is not passing because nothing happened. */
    assert.equal(await countMessages(id), 1);
  });

  test('NOTHING IS WRITTEN AFTER A CUSTOMER SEND', async () => {
    const id = await conversationAt('main');
    await customerSays(id, 'Hi, I need a custom chimney cap for a 8x8 flue');
    const raw = await getConversation(id);
    for (const f of BODIES) {
      assert.equal(raw[f], undefined, f + ' was written to the conversation');
    }
    /* The words exist - in chatMessages, where a staff member reads them by
       opening the conversation. */
    const t = await call(transcript(), { method: 'GET', token: 'main',
      query: { conversationId: id } });
    assert.equal(t.payload.messages.length, 2);
    assert.match(t.payload.messages[1].body, /custom chimney cap/);
  });

  test('THE STAFF INBOX RESPONSE CARRIES NO MESSAGE TEXT', async () => {
    const id = await conversationAt('main');
    const secret = 'THE-QUOTE-IS-FOUR-THOUSAND-DOLLARS';
    await customerSays(id, secret);

    const res = await call(inbox(), { method: 'GET', token: 'main' });
    assert.equal(res.statusCode, 200);
    const body = JSON.stringify(res.payload);
    assert.equal(body.indexOf(secret), -1,
      'the customer message reached the inbox response');
    for (const f of BODIES) {
      assert.equal(body.indexOf(f), -1, f + ' is in the inbox response');
    }
    /* The row still says everything the shop needs to act: who, which shop,
       and that somebody is waiting. */
    const r = res.payload.conversations[0];
    assert.equal(r.customerName, 'John Smith');
    assert.equal(r.locationLabel, 'Main Shop - 1st Avenue');
    assert.equal(r.unread, true);
  });

  test('and neither does the transcript response summary', async () => {
    const id = await conversationAt('main');
    await customerSays(id, 'a second message');
    const t = await call(transcript(), { method: 'GET', token: 'main',
      query: { conversationId: id } });
    for (const f of BODIES) {
      assert.equal(t.payload.conversation[f], undefined,
        f + ' is on the conversation summary');
    }
    /* The transcript itself of course carries the messages - that is what a
       transcript IS, and reading it is the deliberate act. */
    assert.equal(t.payload.messages.length, 2);
  });

  test('REMOVING IT COST NO EXTRA REQUEST: one inbox call still answers '
    + 'everything an alert needs', async () => {
      const id = await conversationAt('main');
      await customerSays(id);
      const res = await call(inbox(), { method: 'GET', token: 'main' });
      const r = res.payload.conversations.find((c) => c.conversationId === id);
      /* Name, shop, unread, version and reason - all from ONE list request.
         Nothing here would need a transcript fetched to build a notification. */
      assert.equal(typeof r.customerName, 'string');
      assert.equal(typeof r.locationLabel, 'string');
      assert.equal(r.unread, true);
      assert.equal(typeof r.attentionVersion, 'number');
      assert.equal(r.lastAttentionType, 'customer_message');
    });
});


/* ============================ EACH GATE ON ITS OWN, NOT JUST THE STACK */

/*
 * THE SAME CHECK IS MADE TWICE ON PURPOSE, AND BOTH COPIES ARE TESTED HERE.
 *
 * Two of these rules exist in two places: once at the door of the route, and
 * once inside the transaction that writes. Through the HTTP handlers the door
 * answers first, so deleting the inner copy is a change no end-to-end test can
 * see - mutation testing said so, and these are the tests that close it.
 *
 * The inner copies are the ones that matter under load. The door check is a
 * separate read; the transaction is what actually decides.
 */
describe('every gate holds on its own, not only as a pair', () => {
  let S;
  const now = () => Timestamp.now();
  const mainOnly = () => ({ uid: MAIN_ONLY, role: 'admin', locations: ['main'] });

  test('the service module loads', async () => {
    /* Imported in a test rather than in the describe body: on Node v22 a
       throw up there marks the suite not-ok, runs none of it, and still exits
       0 - so the assertion would be attached to nothing. */
    S = (await import(ROOT + '/api/_chat/service.js')).default;
    assert.equal(typeof S.markConversationRead, 'function');
    assert.equal(typeof S.sendCustomerMessage, 'function');
  });

  test('THE IN-TRANSACTION DUPLICATE BRANCH RAISES NOTHING', async () => {
    /*
     * api/chat/send.js checks for an already-stored message BEFORE the
     * transaction, to save the customer's rate-limit allowance - so an
     * ordinary retry never reaches the branch inside sendCustomerMessage()
     * at all. That branch is the authoritative one: it is what makes two
     * SIMULTANEOUS identical sends safe, and it is only observable from here.
     */
    S = S || (await import(ROOT + '/api/_chat/service.js')).default;
    const id = await conversationAt('main');
    const clientMessageId = uuid();

    const first = await S.sendCustomerMessage(db(), { now }, {
      conversationId: id, message: 'the only copy', customerUid: CUST,
      clientMessageId: clientMessageId
    });
    assert.equal(first.duplicate, false);
    assert.equal((await versions(id)).attention, 2);

    /* The same call again, straight at the service - the race, deterministically. */
    const again = await S.sendCustomerMessage(db(), { now }, {
      conversationId: id, message: 'the only copy', customerUid: CUST,
      clientMessageId: clientMessageId
    });
    assert.equal(again.duplicate, true);
    assert.equal((await versions(id)).attention, 2, 'still 2, not 3');
    assert.equal((await getConversation(id)).messageCount, 2,
      'and the message was not counted twice either');
  });

  test('THE IN-TRANSACTION SHOP CHECK ON /read HOLDS BY ITSELF', async () => {
    /*
     * The route authorises at the door, then this re-checks. A transfer can
     * land in the gap. Calling the service directly IS that gap.
     */
    S = S || (await import(ROOT + '/api/_chat/service.js')).default;
    const id = await conversationAt('main');
    await db().collection('chatConversations').doc(id)
      .update({ locationId: 'specialty' });        /* the transfer lands */

    await assert.rejects(
      () => S.markConversationRead(db(), { now }, {
        conversationId: id, attentionVersion: 1, actor: mainOnly()
      }),
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.code, 'conversation_not_found');
        assert.equal(err.message, 'That conversation no longer exists.');
        return true;
      });
    assert.equal((await versions(id)).read, 0, 'nothing was acknowledged');

    /* And it allows its own, so the refusal above is the check and not a
       function that refuses everything. */
    const mine = await conversationAt('main');
    const ok = await S.markConversationRead(db(), { now }, {
      conversationId: mine, attentionVersion: 1, actor: mainOnly()
    });
    assert.equal(ok.unread, false);
  });

  test('the version arithmetic is a pure max/min, testable without a database',
    async () => {
      const A = (await import(ROOT + '/api/_chat/attention.js')).default;
      const at = (a, r) => ({ staffAttentionVersion: a, staffReadVersion: r });

      /* Never more than was seen. */
      assert.equal(A.resolveReadVersion(at(8, 0), 7), 7);
      assert.equal(A.resolveReadVersion(at(8, 0), 999), 8);
      /* Never backwards. */
      assert.equal(A.resolveReadVersion(at(8, 5), 3), 5);
      assert.equal(A.resolveReadVersion(at(8, 8), 1), 8);
      /* Legacy zero. */
      assert.equal(A.resolveReadVersion({}, 5), 0);
      /* Garbage in is zero, not an exception and not an alert. */
      for (const bad of ['7', 7.5, -1, NaN, null, undefined, {}]) {
        assert.equal(A.normalizeVersion(bad), 0, JSON.stringify(bad));
      }
      assert.equal(A.isUnread({}), false, 'a legacy document is not unread');
      assert.equal(A.isUnread(at(1, 0)), true);
      assert.equal(A.isUnread(at(1, 1)), false);
    });
});
