/* Customer endpoints: auth, start, send, idempotency, ownership, origin. */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  db, handlerFor, call, wipe, uuid, anonToken, passwordToken,
  countMessages, getConversation, RATE_SECRET
} from './helpers.mjs';

const START = '/home/user/esthers/api/chat/start.js';
const SEND = '/home/user/esthers/api/chat/send.js';

const CUST_A = 'anon-customer-a';
const CUST_B = 'anon-customer-b';
const STAFF = 'staff-uid-1';

const TOKENS = {
  'tokA': anonToken(CUST_A),
  'tokB': anonToken(CUST_B),
  'tokStaff': passwordToken(STAFF, 'manager@example.test')
};

const start = () => handlerFor(START, TOKENS);
const send = () => handlerFor(SEND, TOKENS);

const goodStart = (over = {}) => Object.assign({
  name: 'Jordan Ellis', email: 'jordan@example.test',
  message: 'Do you make louvered chimney caps?', clientMessageId: uuid()
}, over);

before(async () => { await wipe(); });
beforeEach(async () => { await wipe(); });

async function openConversation(token = 'tokA') {
  const res = await call(start(), { token, body: goodStart() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return res.payload.conversationId;
}

/* ------------------------------------------------------------------ AUTH */
describe('customer auth', () => {
  test('no Bearer token -> 401', async () => {
    const res = await call(start(), { body: goodStart() });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'missing_authorization');
  });

  test('malformed Bearer -> 401', async () => {
    for (const h of ['Bearer', 'Basic abc', 'Bearer  ', 'Bearer a b', 'tokA']) {
      const res = await call(start(), { headers: { authorization: h }, body: goodStart() });
      assert.equal(res.statusCode, 401, 'header: ' + h);
    }
  });

  test('repeated Authorization header -> 401', async () => {
    const res = await call(start(), {
      headers: { authorization: ['Bearer tokA', 'Bearer tokB'] }, body: goodStart() });
    assert.equal(res.statusCode, 401);
  });

  test('invalid token -> 401', async () => {
    const res = await call(start(), { token: 'not-a-real-token', body: goodStart() });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.code, 'invalid_token');
  });

  test('Email/Password token on a customer route -> 403', async () => {
    const res = await call(start(), { token: 'tokStaff', body: goodStart() });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'not_a_customer');
  });

  test('anonymous token accepted', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    assert.equal(res.statusCode, 200);
  });

  test('wrong method -> 405 with Allow', async () => {
    const res = await call(start(), { method: 'GET', token: 'tokA' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.getHeader('allow'), 'POST');
  });
});

/* ----------------------------------------------------------------- START */
describe('chat/start', () => {
  test('creates exactly one conversation and one message', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    assert.equal(res.statusCode, 200);
    const convs = await db().collection('chatConversations').get();
    assert.equal(convs.size, 1);
    assert.equal(await countMessages(res.payload.conversationId), 1);
  });

  test('message carries EXACTLY the four allowed fields', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    const snap = await db().collection('chatMessages').doc(res.payload.messageId).get();
    assert.deepEqual(Object.keys(snap.data()).sort(),
      ['body', 'conversationId', 'createdAt', 'senderType']);
  });

  test('customerUid comes from the verified token, not the body', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    const conv = await getConversation(res.payload.conversationId);
    assert.equal(conv.customerUid, CUST_A);
  });

  test('senderType is forced to customer', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    const snap = await db().collection('chatMessages').doc(res.payload.messageId).get();
    assert.equal(snap.data().senderType, 'customer');
  });

  test('timestamps are server-controlled Firestore Timestamps', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    const conv = await getConversation(res.payload.conversationId);
    assert.equal(typeof conv.createdAt.toMillis, 'function');
    assert.equal(conv.status, 'open');
    assert.equal(conv.messageCount, 1);
    assert.equal(conv.closedAt, null);
    assert.equal(conv.staffLastReadAt, null);
    assert.equal(conv.customerLastReadAt, null);
    assert.equal(conv.staffNotifiedAt, null);
  });

  test('the response returns only the allow-listed fields', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    assert.deepEqual(Object.keys(res.payload).sort(),
      ['conversationId', 'messageId', 'ok', 'status']);
  });

  test('invalid name rejected', async () => {
    for (const name of ['', '   ', 'x'.repeat(101), 42, null]) {
      const res = await call(start(), { token: 'tokA', body: goodStart({ name }) });
      assert.equal(res.statusCode, 400, 'name: ' + JSON.stringify(name));
    }
  });

  test('invalid email rejected', async () => {
    for (const email of ['', 'nope', 'a@b', 'x'.repeat(250) + '@b.co', 7]) {
      const res = await call(start(), { token: 'tokA', body: goodStart({ email }) });
      assert.equal(res.statusCode, 400, 'email: ' + JSON.stringify(email));
    }
  });

  test('blank message rejected', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart({ message: '   ' }) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'empty_message');
  });

  test('over-long message rejected', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart({ message: 'x'.repeat(2001) }) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'message_too_long');
  });

  test('privileged fields rejected outright', async () => {
    for (const field of ['customerUid', 'senderType', 'staffUserId', 'status',
                         'createdAt', 'messageCount', 'closedAt', 'role']) {
      const body = goodStart(); body[field] = 'x';
      const res = await call(start(), { token: 'tokA', body });
      assert.equal(res.statusCode, 400, 'field: ' + field);
      assert.equal(res.payload.code, 'forbidden_field', 'field: ' + field);
    }
  });

  test('malformed clientMessageId rejected', async () => {
    for (const id of ['', 'abc', '123', 'x'.repeat(80), 5]) {
      const res = await call(start(), { token: 'tokA', body: goodStart({ clientMessageId: id }) });
      assert.equal(res.statusCode, 400, 'id: ' + JSON.stringify(id));
    }
  });

  test('malformed JSON body rejected', async () => {
    const res = await call(start(), { token: 'tokA', body: 'not json at all' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'malformed_body');
  });

  test('unicode name and emoji message are accepted unchanged', async () => {
    const body = goodStart({ name: 'Zoë 中文 Müller', message: 'thanks 👍' });
    const res = await call(start(), { token: 'tokA', body });
    assert.equal(res.statusCode, 200);
    const conv = await getConversation(res.payload.conversationId);
    assert.equal(conv.customerName, 'Zoë 中文 Müller');
    const snap = await db().collection('chatMessages').doc(res.payload.messageId).get();
    assert.equal(snap.data().body, 'thanks 👍');
  });
});

/* ------------------------------------------------------------------ SEND */
describe('chat/send', () => {
  test('customer can send to their own open conversation', async () => {
    const id = await openConversation('tokA');
    const res = await call(send(), { token: 'tokA',
      body: { conversationId: id, message: 'One more thing', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 200);
    assert.equal(await countMessages(id), 2);
  });

  test('messageCount increments exactly once', async () => {
    const id = await openConversation('tokA');
    await call(send(), { token: 'tokA',
      body: { conversationId: id, message: 'a', clientMessageId: uuid() } });
    const conv = await getConversation(id);
    assert.equal(conv.messageCount, 2);
  });

  test('customer cannot send to another customer\'s conversation', async () => {
    const id = await openConversation('tokA');
    const res = await call(send(), { token: 'tokB',
      body: { conversationId: id, message: 'let me in', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 404);
    assert.equal(await countMessages(id), 1, 'nothing was appended');
  });

  test('wrong-owner and nonexistent are INDISTINGUISHABLE', async () => {
    const id = await openConversation('tokA');
    const wrongOwner = await call(send(), { token: 'tokB',
      body: { conversationId: id, message: 'x', clientMessageId: uuid() } });
    const missing = await call(send(), { token: 'tokB',
      body: { conversationId: 'AAAAAAAAAAAAAAAAAAAA', message: 'x', clientMessageId: uuid() } });
    assert.equal(wrongOwner.statusCode, missing.statusCode);
    assert.deepEqual(wrongOwner.payload, missing.payload,
      'the two responses must be byte-identical or the id becomes an oracle');
  });

  test('customer cannot send to a closed conversation', async () => {
    const id = await openConversation('tokA');
    await db().collection('chatConversations').doc(id).update({ status: 'closed' });
    const res = await call(send(), { token: 'tokA',
      body: { conversationId: id, message: 'still here?', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, 'conversation_closed');
    assert.equal(await countMessages(id), 1);
  });

  test('senderType forgery is rejected', async () => {
    const id = await openConversation('tokA');
    const res = await call(send(), { token: 'tokA', body: {
      conversationId: id, message: 'I am staff', clientMessageId: uuid(), senderType: 'staff' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'forbidden_field');
  });

  test('a browser-supplied customerUid is rejected', async () => {
    const id = await openConversation('tokA');
    const res = await call(send(), { token: 'tokB', body: {
      conversationId: id, message: 'x', clientMessageId: uuid(), customerUid: CUST_A } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'forbidden_field');
  });

  test('invalid conversationId shapes rejected', async () => {
    for (const id of ['../etc/passwd', 'a/b', '.', '..', '__proto__', '', 'x'.repeat(65)]) {
      const res = await call(send(), { token: 'tokA',
        body: { conversationId: id, message: 'x', clientMessageId: uuid() } });
      assert.equal(res.statusCode, 400, 'id: ' + JSON.stringify(id));
    }
  });
});

/* ----------------------------------------------------------- IDEMPOTENCY */
describe('idempotency', () => {
  test('retrying the same clientMessageId does not duplicate', async () => {
    const id = await openConversation('tokA');
    const cmid = uuid();
    const body = { conversationId: id, message: 'sent twice', clientMessageId: cmid };
    const first = await call(send(), { token: 'tokA', body });
    const second = await call(send(), { token: 'tokA', body });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.payload.messageId, second.payload.messageId);
    assert.equal(await countMessages(id), 2, 'one original + one retried message');
  });

  test('a retry does not increment messageCount twice', async () => {
    const id = await openConversation('tokA');
    const body = { conversationId: id, message: 'x', clientMessageId: uuid() };
    await call(send(), { token: 'tokA', body });
    await call(send(), { token: 'tokA', body });
    const conv = await getConversation(id);
    assert.equal(conv.messageCount, 2);
  });

  test('start is idempotent per clientMessageId within its own conversation', async () => {
    /* start() mints a new conversation id each call, so two starts are two
       conversations by design - what must hold is that the derived message id
       is deterministic from (conversationId, clientMessageId). */
    const S = (await import('node:module')).createRequire('/home/user/esthers/')
      ('/home/user/esthers/api/_chat/service.js');
    const a = S.messageId('conv1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const b = S.messageId('conv1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const c = S.messageId('conv2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(a, b, 'same inputs give the same id');
    assert.notEqual(a, c, 'the conversation is mixed in');
  });

  test('the same clientMessageId in two conversations is two messages', async () => {
    const idA = await openConversation('tokA');
    const idB = await openConversation('tokB');
    const cmid = uuid();
    await call(send(), { token: 'tokA', body: { conversationId: idA, message: 'x', clientMessageId: cmid } });
    await call(send(), { token: 'tokB', body: { conversationId: idB, message: 'x', clientMessageId: cmid } });
    assert.equal(await countMessages(idA), 2);
    assert.equal(await countMessages(idB), 2);
  });
});

/* ---------------------------------------------------------------- ORIGIN */
describe('same-origin policy', () => {
  test('matching Origin accepted', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart(),
      headers: { origin: 'https://www.esthers.ca', host: 'www.esthers.ca' } });
    assert.equal(res.statusCode, 200);
  });

  test('production apex origin accepted', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart(),
      headers: { origin: 'https://esthers.ca', host: 'anything.vercel.app' } });
    assert.equal(res.statusCode, 200);
  });

  test('preview deployment: origin matching its own host accepted', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart(),
      headers: { origin: 'https://esthers-git-branch.vercel.app',
                 host: 'esthers-git-branch.vercel.app' } });
    assert.equal(res.statusCode, 200);
  });

  test('mismatched Origin rejected', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart(),
      headers: { origin: 'https://evil.example', host: 'www.esthers.ca' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'cross_origin');
  });

  test('no wildcard CORS header is ever returned', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    assert.equal(res.getHeader('access-control-allow-origin'), undefined);
  });

  test('every response is no-store', async () => {
    const res = await call(start(), { token: 'tokA', body: goodStart() });
    assert.equal(res.getHeader('cache-control'), 'no-store');
    assert.equal(res.getHeader('x-content-type-options'), 'nosniff');
  });
});
