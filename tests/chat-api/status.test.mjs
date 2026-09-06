/*
 * GET /api/chat/status — the customer's own view of one conversation.
 *
 * THE BUG THIS ENDPOINT EXISTS FOR, reproduced in a real production review:
 *
 *   customer starts a conversation, staff reply, staff close it. The
 *   customer's UI stays "Connected", because their realtime listener watches
 *   chatMessages and closeConversation() writes only to the conversation
 *   document. They discover the close by sending a message and being refused
 *   409. Then they reload — and the panel comes back saying "Connected" with a
 *   live composer, because nothing on the client knew any better.
 *
 * The backend refused those sends correctly throughout, so this was never an
 * authorisation hole. It was the client being told nothing and guessing wrong.
 *
 * These tests are the server half: the endpoint answers for the owner, refuses
 * everybody else indistinguishably from "does not exist", and returns two
 * fields and nothing more. The client half is in chat-customer.test.mjs.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  db, handlerFor, call, wipe, uuid, anonToken, passwordToken, seedStaff,
  getConversation, APP_CHECK_OK, APP_CHECK_BAD
} from './helpers.mjs';

const START = '/home/user/esthers/api/chat/start.js';
const SEND = '/home/user/esthers/api/chat/send.js';
const STATUS = '/home/user/esthers/api/chat/status.js';
const CLOSE = '/home/user/esthers/api/admin/chat/close.js';

const CUST_A = 'anon-customer-a';
const CUST_B = 'anon-customer-b';
const STAFF = 'staff-uid-1';

const TOKENS = {
  tokA: anonToken(CUST_A),
  tokB: anonToken(CUST_B),
  tokStaff: passwordToken(STAFF, 'manager@example.test')
};

const start = (o) => handlerFor(START, TOKENS, o);
const send = (o) => handlerFor(SEND, TOKENS, o);
const status = (o) => handlerFor(STATUS, TOKENS, o);
const close = (o) => handlerFor(CLOSE, TOKENS, o);

const goodStart = (over = {}) => Object.assign({
  name: 'Jordan Ellis', email: 'jordan@example.test',
  message: 'Do you make louvered chimney caps?', clientMessageId: uuid(),
  /* Routing is required on start now - see api/_chat/locations.js. */
  locationId: 'main'
}, over);

before(async () => { await wipe(); });
beforeEach(async () => {
  await wipe();
  /* wipe() clears the allow-list too, so the staff member closing a
     conversation has to be seeded for every test that needs one. */
  await seedStaff(STAFF, { isActive: true, role: 'admin' });
});

async function openConversation(token = 'tokA') {
  const res = await call(start(), { token, body: goodStart() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return res.payload.conversationId;
}

/* A GET carries its argument in the query string, not a body. */
const ask = (conversationId, opts = {}) => call(status(opts.handler), Object.assign({
  method: 'GET',
  token: 'tokA',
  query: { conversationId }
}, opts.req || {}));

/* ================================================================ HAPPY */

describe('the owner reads their own status', () => {
  test('an open conversation reports open', async () => {
    const id = await openConversation();
    const res = await ask(id);
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.conversationId, id);
    assert.equal(res.payload.status, 'open');
  });

  test('a closed conversation reports closed - WITHOUT the customer sending anything',
    async () => {
      /* The whole point. Before this endpoint the only way to discover a
         close was to attempt a write and be refused. */
      const id = await openConversation();
      const closed = await call(close(), { token: 'tokStaff', body: { conversationId: id } });
      assert.equal(closed.statusCode, 200, JSON.stringify(closed.payload));

      const res = await ask(id);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.status, 'closed');
    });

  test('reading status does not mutate the conversation', async () => {
    const id = await openConversation();
    const before = await getConversation(id);
    await ask(id);
    await ask(id);
    const after = await getConversation(id);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    assert.equal(after.status, before.status);
    assert.equal(after.messageCount, before.messageCount);
    assert.equal(String(after.updatedAt), String(before.updatedAt));
  });

  test('a post-close send is still refused - the endpoint changed nothing there',
    async () => {
      const id = await openConversation();
      await call(close(), { token: 'tokStaff', body: { conversationId: id } });

      const res = await call(send(), {
        token: 'tokA',
        body: { conversationId: id, message: 'anyone there?', clientMessageId: uuid() }
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.payload.code, 'conversation_closed');
    });
});

/* ============================================================ OWNERSHIP */

describe('ownership', () => {
  test('another anonymous customer cannot read the status', async () => {
    const id = await openConversation('tokA');
    const res = await call(status(), {
      method: 'GET', token: 'tokB', query: { conversationId: id }
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
  });

  test('somebody else\'s conversation is INDISTINGUISHABLE from one that does not exist',
    async () => {
      /* Otherwise the endpoint is an oracle: try ids until the answer changes
         and you have learned which ones are real. */
      const id = await openConversation('tokA');

      const theirs = await call(status(), {
        method: 'GET', token: 'tokB', query: { conversationId: id }
      });
      const nothing = await call(status(), {
        method: 'GET', token: 'tokB', query: { conversationId: 'doesnotexist0000' }
      });

      assert.equal(theirs.statusCode, nothing.statusCode);
      assert.equal(theirs.payload.code, nothing.payload.code);
      assert.equal(theirs.payload.error, nothing.payload.error);
      assert.deepEqual(Object.keys(theirs.payload).sort(),
        Object.keys(nothing.payload).sort());
    });

  test('a conversation that does not exist is a clean 404', async () => {
    const res = await ask('nosuchconversation');
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
    assert.equal(res.payload.ok, false);
  });

  test('the uid comes from the token, not from anything the caller sends',
    async () => {
      const id = await openConversation('tokA');
      /* Every shape a caller might try to smuggle an identity through. */
      for (const extra of [
        { customerUid: CUST_A }, { uid: CUST_A }, { customerUid: CUST_B }
      ]) {
        const res = await call(status(), {
          method: 'GET', token: 'tokB',
          query: Object.assign({ conversationId: id }, extra)
        });
        assert.equal(res.statusCode, 404, JSON.stringify(extra));
        assert.equal(res.payload.code, 'conversation_not_found');
      }
    });
});

/* ============================================================ BAD INPUT */

describe('input', () => {
  test('a missing conversationId is refused', async () => {
    const res = await call(status(), { method: 'GET', token: 'tokA', query: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'invalid_conversation_id');
  });

  test('a malformed conversationId is refused before it reaches a document path',
    async () => {
      for (const bad of ['', '   ', '.', '..', '__proto__', 'has/slash',
        'has space', 'x'.repeat(65), '../../etc/passwd']) {
        const res = await call(status(), {
          method: 'GET', token: 'tokA', query: { conversationId: bad }
        });
        assert.equal(res.statusCode, 400, 'accepted: ' + JSON.stringify(bad));
        assert.equal(res.payload.code, 'invalid_conversation_id');
      }
    });

  test('POST is not allowed - this is a read', async () => {
    const id = await openConversation();
    const res = await call(status(), {
      method: 'POST', token: 'tokA', query: { conversationId: id }
    });
    assert.equal(res.statusCode, 405);
    assert.equal(res.payload.code, 'method_not_allowed');
  });

  test('a cross-origin request is refused', async () => {
    const id = await openConversation();
    const res = await call(status(), {
      method: 'GET', token: 'tokA', query: { conversationId: id },
      headers: { origin: 'https://evil.example' }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'cross_origin');
  });
});

/* ================================================================= AUTH */

describe('authentication', () => {
  test('no Bearer token -> 401', async () => {
    const res = await call(status(), { method: 'GET', query: { conversationId: 'abc' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'missing_authorization');
  });

  test('a malformed Bearer -> 401', async () => {
    for (const h of ['Bearer', 'Basic abc', 'Bearer  ', 'Bearer a b']) {
      const res = await call(status(), {
        method: 'GET', headers: { authorization: h }, query: { conversationId: 'abc' }
      });
      assert.equal(res.statusCode, 401, h);
    }
  });

  test('an unknown token -> 401', async () => {
    const res = await call(status(), {
      method: 'GET', token: 'not-a-real-token', query: { conversationId: 'abc' }
    });
    assert.equal(res.statusCode, 401);
  });

  test('a STAFF token is refused 403 - this is a customer endpoint', async () => {
    const id = await openConversation('tokA');
    const res = await call(status(), {
      method: 'GET', token: 'tokStaff', query: { conversationId: id }
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'not_a_customer');
  });
});

/* ============================================================ APP CHECK */

describe('App Check', () => {
  test('with enforcement ON, a valid App Check token is required', async () => {
    const id = await openConversation();
    const res = await call(status({ appCheckEnforced: true }), {
      method: 'GET', token: 'tokA', query: { conversationId: id }
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_required');
  });

  test('with enforcement ON, an invalid App Check token is refused', async () => {
    const id = await openConversation();
    const res = await call(status({ appCheckEnforced: true }), {
      method: 'GET', token: 'tokA', appCheck: APP_CHECK_BAD, query: { conversationId: id }
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'app_check_invalid');
  });

  test('with enforcement ON, a valid App Check token plus the owner succeeds',
    async () => {
      const id = await openConversation();
      const res = await call(status({ appCheckEnforced: true }), {
        method: 'GET', token: 'tokA', appCheck: APP_CHECK_OK, query: { conversationId: id }
      });
      assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
      assert.equal(res.payload.status, 'open');
    });

  test('App Check does NOT substitute for authentication', async () => {
    /* A perfect App Check token and no ID token is still refused. */
    const id = await openConversation();
    const res = await call(status({ appCheckEnforced: true }), {
      method: 'GET', appCheck: APP_CHECK_OK, query: { conversationId: id }
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'missing_authorization');
  });

  test('App Check does NOT substitute for ownership', async () => {
    const id = await openConversation('tokA');
    const res = await call(status({ appCheckEnforced: true }), {
      method: 'GET', token: 'tokB', appCheck: APP_CHECK_OK, query: { conversationId: id }
    });
    assert.equal(res.statusCode, 404);
  });
});

/* ============================================================== PAYLOAD */

describe('the response body', () => {
  test('exactly four keys, and nothing else', async () => {
    const id = await openConversation();
    const res = await ask(id);
    /* locationId joined this list when routing shipped: the panel has to keep
       telling the customer which shop they are writing to across a reload and
       across a transfer. It is a deliberate, reviewed addition to the
       allow-list, not a widening of it - the list is still exact, and the
       next accidental field still fails here. */
    assert.deepEqual(Object.keys(res.payload).sort(),
      ['conversationId', 'locationId', 'ok', 'status']);
  });

  test('no staff or internal field ever appears', async () => {
    const id = await openConversation();
    await call(close(), { token: 'tokStaff', body: { conversationId: id } });
    const res = await ask(id);

    const body = JSON.stringify(res.payload);
    for (const forbidden of [
      'customerUid', 'customerName', 'customerEmail', 'staffUserId',
      'staffLastReadAt', 'staffNotifiedAt', 'customerLastReadAt',
      'startRequestHash', 'messageCount', 'lastMessageAt', 'closedAt',
      'createdAt', 'updatedAt',
      /* routing audit: which shop it is at is the customer's business, who
         moved it and when is not */
      'previousLocationId', 'lastTransferredAt', 'lastTransferredByStaffUid',
      'transferCount', 'locationLabel',
      /* and the actual values, in case a field were renamed */
      CUST_A, 'Jordan Ellis', 'jordan@example.test'
    ]) {
      assert.equal(body.includes(forbidden), false,
        'leaked ' + forbidden + ' in ' + body);
    }
  });

  test('the whole conversation document is NOT returned', async () => {
    const id = await openConversation();
    const stored = await getConversation(id);
    const res = await ask(id);
    /* The stored document has many more fields than the four we return. */
    assert.ok(Object.keys(stored).length > 8, 'the document really is fat');
    assert.equal(Object.keys(res.payload).length, 4);
  });

  test('status is normalised to exactly open or closed, never echoed', async () => {
    const id = await openConversation();
    /* Put something unexpected in the field, the way a future migration or a
       bad write might. The customer must still see one of two words. */
    await db().collection('chatConversations').doc(id)
      .update({ status: 'archived-pending-review' });
    const res = await ask(id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, 'open',
      'anything that is not exactly "closed" reads as open');
  });

  test('no Firestore write happens on the read path', async () => {
    /* The rate limiter writes a counter; this route deliberately has no
       bucket, so a status read must leave chatRateLimits empty. */
    const id = await openConversation();
    const before = (await db().collection('chatRateLimits').get()).size;
    for (let i = 0; i < 5; i++) await ask(id);
    const after = (await db().collection('chatRateLimits').get()).size;
    assert.equal(after, before, 'a read must not spend a write');
  });
});

/* ================================================== THE REPORTED SEQUENCE */

describe('the exact sequence from the production review', () => {
  test('start -> send -> staff close -> status says closed, with no failed send',
    async () => {
      const id = await openConversation('tokA');

      const sent = await call(send(), {
        token: 'tokA',
        body: { conversationId: id, message: 'one more thing', clientMessageId: uuid() }
      });
      assert.equal(sent.statusCode, 200);

      /* Staff close it. */
      await call(close(), { token: 'tokStaff', body: { conversationId: id } });

      /* The customer asks — this is the call a reload now makes BEFORE the
         composer is enabled. No message was attempted. */
      const res = await ask(id);
      assert.equal(res.payload.status, 'closed');

      /* And the write path still refuses, unchanged. */
      const after = await call(send(), {
        token: 'tokA',
        body: { conversationId: id, message: 'still?', clientMessageId: uuid() }
      });
      assert.equal(after.statusCode, 409);
      assert.equal(after.payload.code, 'conversation_closed');
    });

  test('closing twice is still idempotent, and status stays closed', async () => {
    const id = await openConversation();
    await call(close(), { token: 'tokStaff', body: { conversationId: id } });
    const again = await call(close(), { token: 'tokStaff', body: { conversationId: id } });
    assert.equal(again.statusCode, 200);
    assert.equal((await ask(id)).payload.status, 'closed');
  });
});
