/* Staff endpoints: authorization against staff/{uid}, inbox, transcript,
   reply, close. */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  db, handlerFor, call, wipe, uuid, anonToken, passwordToken, seedStaff,
  countMessages, getConversation
} from './helpers.mjs';

const START = '/home/user/esthers/api/chat/start.js';
const CONVERSATIONS = '/home/user/esthers/api/admin/chat/conversations.js';
const MESSAGES = '/home/user/esthers/api/admin/chat/messages.js';
const STAFF_SEND = '/home/user/esthers/api/admin/chat/send.js';
const CLOSE = '/home/user/esthers/api/admin/chat/close.js';

const ADMIN_UID = 'staff-admin-1';
const INACTIVE_UID = 'staff-inactive-1';
const NODOC_UID = 'staff-without-a-document';
const ROLE_UID = 'staff-odd-role';
const CUST = 'anon-customer-a';

const TOKENS = {
  admin: passwordToken(ADMIN_UID, 'manager@example.test'),
  inactive: passwordToken(INACTIVE_UID, 'old@example.test'),
  nodoc: passwordToken(NODOC_UID, 'stranger@example.test'),
  oddrole: passwordToken(ROLE_UID, 'intern@example.test'),
  cust: anonToken(CUST)
};

const conversations = () => handlerFor(CONVERSATIONS, TOKENS);
const messages = () => handlerFor(MESSAGES, TOKENS);
const staffSend = () => handlerFor(STAFF_SEND, TOKENS);
const close = () => handlerFor(CLOSE, TOKENS);
const customerStart = () => handlerFor(START, TOKENS);

before(async () => { await wipe(); });
beforeEach(async () => {
  await wipe();
  await seedStaff(ADMIN_UID, { isActive: true, role: 'admin' });
  await seedStaff(INACTIVE_UID, { isActive: false, role: 'admin' });
  await seedStaff(ROLE_UID, { isActive: true, role: 'intern' });
});

async function aConversation() {
  const res = await call(customerStart(), { token: 'cust', body: {
    name: 'Jordan Ellis', email: 'jordan@example.test',
    message: 'First question', clientMessageId: uuid() } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return res.payload.conversationId;
}

/* --------------------------------------------------------- AUTHORIZATION */
describe('staff authorization', () => {
  test('no auth -> 401', async () => {
    const res = await call(conversations(), { method: 'GET' });
    assert.equal(res.statusCode, 401);
  });

  test('an anonymous customer cannot use a staff route -> 403', async () => {
    const res = await call(conversations(), { method: 'GET', token: 'cust' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'not_staff');
  });

  test('password user with no staff document -> 403', async () => {
    const res = await call(conversations(), { method: 'GET', token: 'nodoc' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'not_staff');
  });

  test('inactive staff -> 403', async () => {
    const res = await call(conversations(), { method: 'GET', token: 'inactive' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'staff_inactive');
  });

  test('unsupported role -> 403', async () => {
    const res = await call(conversations(), { method: 'GET', token: 'oddrole' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'staff_role');
  });

  test('active admin allowed', async () => {
    const res = await call(conversations(), { method: 'GET', token: 'admin' });
    assert.equal(res.statusCode, 200);
  });

  test('isActive must be strictly true, not merely truthy', async () => {
    await seedStaff(ADMIN_UID, { isActive: 'yes', role: 'admin' });
    const res = await call(conversations(), { method: 'GET', token: 'admin' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'staff_inactive');
  });

  test('authorization is the allow-list, not the email domain', async () => {
    /* A convincing @esthers.ca address with no staff document gets nothing. */
    const tokens = Object.assign({}, TOKENS,
      { imposter: passwordToken('imposter-uid', 'manager@esthers.ca') });
    const handler = handlerFor(CONVERSATIONS, tokens);
    const res = await call(handler, { method: 'GET', token: 'imposter' });
    assert.equal(res.statusCode, 403);
  });
});

/* ------------------------------------------------------------- INBOX */
describe('staff inbox', () => {
  test('lists open conversations', async () => {
    await aConversation();
    const res = await call(conversations(), { method: 'GET', token: 'admin' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.conversations.length, 1);
    assert.equal(res.payload.status, 'open');
  });

  test('returns only allow-listed fields', async () => {
    await aConversation();
    const res = await call(conversations(), { method: 'GET', token: 'admin' });
    assert.deepEqual(Object.keys(res.payload.conversations[0]).sort(), [
      'conversationId', 'createdAt', 'customerEmail', 'customerName',
      'lastMessageAt', 'messageCount', 'staffLastReadAt', 'status'
    ]);
    assert.equal(res.payload.conversations[0].customerUid, undefined,
      'the customer uid must not be serialised');
  });

  test('hard limit is enforced', async () => {
    const res = await call(conversations(), { method: 'GET', token: 'admin',
      query: { limit: '500' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'invalid_limit');
  });

  test('unsupported status rejected', async () => {
    const res = await call(conversations(), { method: 'GET', token: 'admin',
      query: { status: 'everything' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'invalid_status');
  });

  test('closed filter works and open list excludes closed', async () => {
    const id = await aConversation();
    await call(close(), { token: 'admin', body: { conversationId: id } });
    const open = await call(conversations(), { method: 'GET', token: 'admin' });
    assert.equal(open.payload.conversations.length, 0);
    const closed = await call(conversations(), { method: 'GET', token: 'admin',
      query: { status: 'closed' } });
    assert.equal(closed.payload.conversations.length, 1);
  });

  test('POST is rejected -> 405', async () => {
    const res = await call(conversations(), { method: 'POST', token: 'admin' });
    assert.equal(res.statusCode, 405);
  });
});

/* -------------------------------------------------------- TRANSCRIPT */
describe('staff transcript', () => {
  test('authorized staff can read a transcript', async () => {
    const id = await aConversation();
    const res = await call(messages(), { method: 'GET', token: 'admin',
      query: { conversationId: id } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.messages.length, 1);
    assert.equal(res.payload.messages[0].senderType, 'customer');
  });

  test('unknown conversation handled cleanly', async () => {
    const res = await call(messages(), { method: 'GET', token: 'admin',
      query: { conversationId: 'AAAAAAAAAAAAAAAAAAAA' } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
  });

  test('malformed conversationId rejected', async () => {
    const res = await call(messages(), { method: 'GET', token: 'admin',
      query: { conversationId: '../secrets' } });
    assert.equal(res.statusCode, 400);
  });

  test('reading does NOT mark the thread read', async () => {
    const id = await aConversation();
    await call(messages(), { method: 'GET', token: 'admin', query: { conversationId: id } });
    const conv = await getConversation(id);
    assert.equal(conv.staffLastReadAt, null, 'a GET must not mutate state');
  });
});

/* -------------------------------------------------------- STAFF REPLY */
describe('staff reply', () => {
  test('active staff can send', async () => {
    const id = await aConversation();
    const res = await call(staffSend(), { token: 'admin',
      body: { conversationId: id, message: 'Yes, we make those.', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 200);
    assert.equal(await countMessages(id), 2);
  });

  test('senderType is forced to staff', async () => {
    const id = await aConversation();
    const res = await call(staffSend(), { token: 'admin',
      body: { conversationId: id, message: 'Reply', clientMessageId: uuid() } });
    const snap = await db().collection('chatMessages').doc(res.payload.messageId).get();
    assert.equal(snap.data().senderType, 'staff');
  });

  test('a staff message STILL carries exactly the four allowed fields', async () => {
    const id = await aConversation();
    const res = await call(staffSend(), { token: 'admin',
      body: { conversationId: id, message: 'Reply', clientMessageId: uuid() } });
    const snap = await db().collection('chatMessages').doc(res.payload.messageId).get();
    assert.deepEqual(Object.keys(snap.data()).sort(),
      ['body', 'conversationId', 'createdAt', 'senderType']);
    assert.equal(snap.data().staffUserId, undefined,
      'the staff uid must never reach a customer-readable document');
  });

  test('cannot reply to a closed conversation', async () => {
    const id = await aConversation();
    await call(close(), { token: 'admin', body: { conversationId: id } });
    const res = await call(staffSend(), { token: 'admin',
      body: { conversationId: id, message: 'too late', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 409);
    assert.equal(await countMessages(id), 1);
  });

  test('idempotent retry does not duplicate', async () => {
    const id = await aConversation();
    const body = { conversationId: id, message: 'Reply', clientMessageId: uuid() };
    const a = await call(staffSend(), { token: 'admin', body });
    const b = await call(staffSend(), { token: 'admin', body });
    assert.equal(a.payload.messageId, b.payload.messageId);
    assert.equal(await countMessages(id), 2);
    const conv = await getConversation(id);
    assert.equal(conv.messageCount, 2);
  });

  test('a customer cannot use the staff send route', async () => {
    const id = await aConversation();
    const res = await call(staffSend(), { token: 'cust',
      body: { conversationId: id, message: 'I am staff', clientMessageId: uuid() } });
    assert.equal(res.statusCode, 403);
  });
});

/* -------------------------------------------------------------- CLOSE */
describe('staff close', () => {
  test('active staff can close, server-side', async () => {
    const id = await aConversation();
    const res = await call(close(), { token: 'admin', body: { conversationId: id } });
    assert.equal(res.statusCode, 200);
    const conv = await getConversation(id);
    assert.equal(conv.status, 'closed');
    assert.equal(typeof conv.closedAt.toMillis, 'function');
  });

  test('a second close is safe and idempotent', async () => {
    const id = await aConversation();
    await call(close(), { token: 'admin', body: { conversationId: id } });
    const before = (await getConversation(id)).closedAt.toMillis();
    const second = await call(close(), { token: 'admin', body: { conversationId: id } });
    assert.equal(second.statusCode, 200);
    assert.equal(second.payload.status, 'closed');
    assert.equal((await getConversation(id)).closedAt.toMillis(), before,
      'closedAt must not be rewritten by a repeat close');
  });

  test('the transcript survives closing', async () => {
    const id = await aConversation();
    await call(close(), { token: 'admin', body: { conversationId: id } });
    assert.equal(await countMessages(id), 1, 'closing must not delete anything');
  });

  test('closing an unknown conversation -> 404', async () => {
    const res = await call(close(), { token: 'admin',
      body: { conversationId: 'AAAAAAAAAAAAAAAAAAAA' } });
    assert.equal(res.statusCode, 404);
  });

  test('a customer cannot close a conversation', async () => {
    const id = await aConversation();
    const res = await call(close(), { token: 'cust', body: { conversationId: id } });
    assert.equal(res.statusCode, 403);
    assert.equal((await getConversation(id)).status, 'open');
  });
});
