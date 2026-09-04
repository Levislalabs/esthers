/*
 * Idempotency, and the platform boundaries that surround it.
 *
 * The defect this file exists for: /api/chat/start used a random Firestore
 * auto-id for the conversation, which fed the message id, so a retried start
 * could never be recognised as a retry. A customer whose response was dropped
 * opened a SECOND conversation and appeared twice in Esther's inbox.
 *
 * Emulator only, demo- project, no credential, no production contact.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import {
  db, handlerFor, call, wipe, uuid, anonToken, passwordToken, seedStaff,
  countMessages, getConversation, RATE_SECRET
} from './helpers.mjs';

const require = createRequire('/home/user/esthers/');
const H = require('/home/user/esthers/api/_chat/http.js');
const S = require('/home/user/esthers/api/_chat/service.js');
const RL = require('/home/user/esthers/api/_chat/rate-limit.js');

const START = '/home/user/esthers/api/chat/start.js';
const SEND = '/home/user/esthers/api/chat/send.js';
const STAFF_SEND = '/home/user/esthers/api/admin/chat/send.js';

const CUST = 'anon-idem-a';
const OTHER = 'anon-idem-b';
const STAFF_UID = 'staff-idem-1';

const TOKENS = {
  a: anonToken(CUST),
  b: anonToken(OTHER),
  staff: passwordToken(STAFF_UID, 'manager@example.test')
};

const start = () => handlerFor(START, TOKENS);
const send = () => handlerFor(SEND, TOKENS);
const staffSend = () => handlerFor(STAFF_SEND, TOKENS);

const startBody = (over = {}) => Object.assign({
  name: 'Jordan Ellis', email: 'jordan@example.test',
  message: 'Do you make louvered chimney caps?', clientMessageId: uuid()
}, over);

const countConversations = async () =>
  (await db().collection('chatConversations').get()).size;
const countAllMessages = async () =>
  (await db().collection('chatMessages').get()).size;

before(async () => { await wipe(); });
beforeEach(async () => {
  await wipe();
  await seedStaff(STAFF_UID, { isActive: true, role: 'admin' });
});

/* ==================================================== START IDEMPOTENCY */
describe('start idempotency', () => {
  test('an identical retry returns the same conversation and creates nothing new', async () => {
    const body = startBody();

    const one = await call(start(), { token: 'a', body });
    const two = await call(start(), { token: 'a', body });
    const three = await call(start(), { token: 'a', body });

    assert.equal(one.statusCode, 200, JSON.stringify(one.payload));
    assert.equal(two.statusCode, 200);
    assert.equal(three.statusCode, 200);

    assert.equal(two.payload.conversationId, one.payload.conversationId);
    assert.equal(three.payload.conversationId, one.payload.conversationId);
    assert.equal(two.payload.messageId, one.payload.messageId);
    assert.equal(three.payload.messageId, one.payload.messageId);

    assert.equal(await countConversations(), 1, 'exactly one conversation');
    assert.equal(await countAllMessages(), 1, 'exactly one first message');
    assert.equal((await getConversation(one.payload.conversationId)).messageCount, 1,
      'messageCount must stay at one');
  });

  test('the conversation id is derived from the verified uid, not minted at random', async () => {
    const body = startBody();
    const res = await call(start(), { token: 'a', body });
    assert.equal(res.payload.conversationId,
      S.startConversationId(CUST, body.clientMessageId),
      'a random auto-id here is exactly the defect this replaces');
  });

  test('the same idempotency key under a DIFFERENT uid is a different conversation', async () => {
    const key = uuid();
    const a = await call(start(), { token: 'a', body: startBody({ clientMessageId: key }) });
    const b = await call(start(), { token: 'b', body: startBody({ clientMessageId: key }) });

    assert.notEqual(a.payload.conversationId, b.payload.conversationId,
      'one visitor must not be able to derive or collide with another');
    assert.equal(await countConversations(), 2);
  });

  test('the derived id carries no name, email or message', async () => {
    const body = startBody();
    const res = await call(start(), { token: 'a', body });
    const id = res.payload.conversationId;
    for (const secret of ['Jordan', 'Ellis', 'jordan@example.test', 'chimney', 'louvered']) {
      assert.equal(id.toLowerCase().includes(secret.toLowerCase()), false);
    }
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  test('the retry is still refused when it is somebody else pretending', async () => {
    /* The id is derived from the uid, so this cannot normally happen. If it
       ever did, the answer must be the ordinary not-found. */
    const body = startBody();
    const res = await call(start(), { token: 'a', body });
    const forged = { customerUid: OTHER, name: body.name, email: body.email,
      message: body.message, clientMessageId: body.clientMessageId };
    /* Point peekStart at the first customer's document while claiming to be
       the second customer. */
    const conv = await db().collection('chatConversations').doc(res.payload.conversationId).get();
    assert.throws(
      () => S.resolveExistingStart(conv, forged, 'x', S.startRequestHash(forged)),
      (err) => err.status === 404 && err.code === 'conversation_not_found');
  });
});

/* ============================================ KEY REUSE, DIFFERENT PAYLOAD */
describe('idempotency key reuse with a different payload', () => {
  test('same key, different message -> 409 and nothing is created or mutated', async () => {
    const key = uuid();
    const first = await call(start(), { token: 'a',
      body: startBody({ clientMessageId: key, message: 'Hello' }) });
    assert.equal(first.statusCode, 200);

    const clash = await call(start(), { token: 'a',
      body: startBody({ clientMessageId: key, message: 'Completely different message' }) });

    assert.equal(clash.statusCode, 409);
    assert.equal(clash.payload.code, 'idempotency_conflict');
    assert.equal(await countConversations(), 1, 'no second conversation');
    assert.equal(await countAllMessages(), 1, 'no second message');

    const conv = await getConversation(first.payload.conversationId);
    assert.equal(conv.messageCount, 1);
    const msg = await db().collection('chatMessages').doc(first.payload.messageId).get();
    assert.equal(msg.data().body, 'Hello', 'the stored message must not be overwritten');
  });

  test('same key, different email -> 409', async () => {
    const key = uuid();
    await call(start(), { token: 'a', body: startBody({ clientMessageId: key }) });
    const clash = await call(start(), { token: 'a',
      body: startBody({ clientMessageId: key, email: 'someone.else@example.test' }) });
    assert.equal(clash.statusCode, 409);
    assert.equal(await countConversations(), 1);
  });

  test('same key, different name -> 409', async () => {
    const key = uuid();
    await call(start(), { token: 'a', body: startBody({ clientMessageId: key }) });
    const clash = await call(start(), { token: 'a',
      body: startBody({ clientMessageId: key, name: 'Someone Else' }) });
    assert.equal(clash.statusCode, 409);
  });

  test('cosmetic differences are a retry, not a conflict', async () => {
    /* Casing in an address and doubled spaces in a name are the same request
       typed twice. Treating them as a conflict would be a bug a real person
       would hit. */
    const key = uuid();
    const one = await call(start(), { token: 'a', body: startBody({
      clientMessageId: key, name: 'Jordan Ellis', email: 'jordan@example.test' }) });
    const two = await call(start(), { token: 'a', body: startBody({
      clientMessageId: key, name: 'Jordan   Ellis', email: 'Jordan@Example.Test' }) });

    assert.equal(two.statusCode, 200);
    assert.equal(two.payload.conversationId, one.payload.conversationId);
    assert.equal(await countConversations(), 1);
  });

  test('the request fingerprint never reaches a message document', async () => {
    const res = await call(start(), { token: 'a', body: startBody() });
    const msg = await db().collection('chatMessages').doc(res.payload.messageId).get();
    assert.deepEqual(Object.keys(msg.data()).sort(),
      ['body', 'conversationId', 'createdAt', 'senderType']);
    assert.equal(msg.data().startRequestHash, undefined);
  });

  test('the fingerprint is on the conversation, and is never serialised out', async () => {
    const res = await call(start(), { token: 'a', body: startBody() });
    const conv = await getConversation(res.payload.conversationId);
    assert.equal(typeof conv.startRequestHash, 'string', 'stored server-side');

    const doc = await db().collection('chatConversations').doc(res.payload.conversationId).get();
    const serialised = S.publicConversation(doc);
    assert.equal(serialised.startRequestHash, undefined,
      'the allow-list must not grow a hash of the customer details');
    assert.equal(serialised.customerUid, undefined);
  });
});

/* ============================================================ ATOMICITY */
describe('the start transaction', () => {
  test('concurrent identical starts produce exactly one conversation', async () => {
    /* Three at once, inside the per-uid start allowance. Only one can win the
       transaction; the losers must retry, see the document and return it. */
    const body = startBody();
    const results = await Promise.all([
      call(start(), { token: 'a', body }),
      call(start(), { token: 'a', body }),
      call(start(), { token: 'a', body })
    ]);

    for (const r of results) assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    const ids = new Set(results.map((r) => r.payload.conversationId));
    assert.equal(ids.size, 1, 'every racing caller must get the same conversation');
    const messageIds = new Set(results.map((r) => r.payload.messageId));
    assert.equal(messageIds.size, 1);

    assert.equal(await countConversations(), 1);
    assert.equal(await countAllMessages(), 1);
    assert.equal((await getConversation(results[0].payload.conversationId)).messageCount, 1);
  });

  test('SIMULTANEOUS retries do each spend a start allowance - a known limit', async () => {
    /* The replay discount can only apply once something is stored, so callers
       racing before the first write lands are indistinguishable from callers
       opening new conversations, and the limiter treats them that way. Some
       are refused. What must NEVER happen is duplicate data, and that is what
       this asserts. Sequential retries - the ordinary case, where a response
       was dropped and the browser tries again - take the replay path and are
       covered above. */
    const body = startBody();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(start(), { token: 'a', body })));

    const okResults = results.filter((r) => r.statusCode === 200);
    const refused = results.filter((r) => r.statusCode === 429);
    assert.ok(okResults.length >= 1, 'at least one must get through');
    assert.equal(okResults.length + refused.length, results.length,
      'every response is either success or a rate limit, never a 500');

    assert.equal(new Set(okResults.map((r) => r.payload.conversationId)).size, 1);
    assert.equal(await countConversations(), 1, 'no duplicate conversation, ever');
    assert.equal(await countAllMessages(), 1, 'no duplicate message, ever');
    assert.equal((await getConversation(okResults[0].payload.conversationId)).messageCount, 1);
  });

  test('a conversation never exists without its first message', async () => {
    const res = await call(start(), { token: 'a', body: startBody() });
    assert.equal(await countMessages(res.payload.conversationId), 1);
    const conv = await getConversation(res.payload.conversationId);
    assert.equal(conv.status, 'open');
    assert.equal(conv.messageCount, 1);
  });
});

/* ================================================= RATE-LIMIT ACCOUNTING */
describe('a retry does not spend the allowance for new work', () => {
  const bucket = async (scope, id) => {
    const snap = await db().collection('chatRateLimits')
      .doc(RL.bucketId(scope, id, RATE_SECRET)).get();
    return snap.exists ? snap.data().count : 0;
  };

  test('repeated identical starts consume one start allowance, not five', async () => {
    const body = startBody();
    for (let i = 0; i < 5; i += 1) {
      const res = await call(start(), { token: 'a', body });
      assert.equal(res.statusCode, 200, 'retry ' + (i + 1) + ' should still succeed');
    }
    assert.equal(await bucket('start_uid', CUST), 1,
      'a dropped response is the connection failing, not the customer misbehaving');
    assert.equal(await bucket('replay_uid', CUST), 4);
    assert.equal(await countConversations(), 1);
  });

  test('a NEW conversation still consumes the start allowance every time', async () => {
    for (let i = 0; i < 3; i += 1) {
      await call(start(), { token: 'a', body: startBody() });
    }
    assert.equal(await bucket('start_uid', CUST), 3,
      'an invented idempotency key must not buy a free conversation');
    const over = await call(start(), { token: 'a', body: startBody() });
    assert.equal(over.statusCode, 429);
  });

  test('repeated identical sends consume one send allowance', async () => {
    const opened = await call(start(), { token: 'a', body: startBody() });
    const body = { conversationId: opened.payload.conversationId,
      message: 'Any update?', clientMessageId: uuid() };

    for (let i = 0; i < 4; i += 1) {
      const res = await call(send(), { token: 'a', body });
      assert.equal(res.statusCode, 200);
    }
    assert.equal(await bucket('send_uid', CUST), 1);
    assert.equal(await bucket('replay_uid', CUST), 3);
  });

  test('the replay path is bounded, not free', async () => {
    assert.equal(RL.RULES.replay_uid.limit, 120);
    assert.ok(RL.RULES.replay_uid.limit > RL.RULES.send_uid.limit,
      'generous enough that an honest retry loop never trips it');
  });
});

/* ================================================== SEND IDEMPOTENCY */
describe('customer send idempotency', () => {
  test('a duplicate send stores one message and increments the count once', async () => {
    const opened = await call(start(), { token: 'a', body: startBody() });
    const id = opened.payload.conversationId;
    const body = { conversationId: id, message: 'Second question',
      clientMessageId: uuid() };

    const one = await call(send(), { token: 'a', body });
    const two = await call(send(), { token: 'a', body });
    const three = await call(send(), { token: 'a', body });

    assert.equal(one.payload.messageId, two.payload.messageId);
    assert.equal(one.payload.messageId, three.payload.messageId);
    assert.equal(await countMessages(id), 2, 'the first message plus one more');
    assert.equal((await getConversation(id)).messageCount, 2);
  });

  test('a replayed message id belonging to someone else is not confirmed', async () => {
    const opened = await call(start(), { token: 'a', body: startBody() });
    const id = opened.payload.conversationId;
    const key = uuid();
    await call(send(), { token: 'a', body: { conversationId: id, message: 'Mine', clientMessageId: key } });

    /* The second customer replays the exact same conversation and key. */
    const res = await call(send(), { token: 'b',
      body: { conversationId: id, message: 'Mine', clientMessageId: key } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
    assert.equal(await countMessages(id), 2, 'nothing was added');
  });

  test('the same key in two different conversations is two different messages', async () => {
    const a = await call(start(), { token: 'a', body: startBody() });
    const b = await call(start(), { token: 'a', body: startBody() });
    const key = uuid();
    const one = await call(send(), { token: 'a', body:
      { conversationId: a.payload.conversationId, message: 'Hi', clientMessageId: key } });
    const two = await call(send(), { token: 'a', body:
      { conversationId: b.payload.conversationId, message: 'Hi', clientMessageId: key } });
    assert.notEqual(one.payload.messageId, two.payload.messageId);
    assert.equal(await countAllMessages(), 4);
  });
});

describe('staff send idempotency', () => {
  test('a duplicate staff reply stores one message and increments the count once', async () => {
    const opened = await call(start(), { token: 'a', body: startBody() });
    const id = opened.payload.conversationId;
    const body = { conversationId: id, message: 'Yes, we make those.',
      clientMessageId: uuid() };

    const one = await call(staffSend(), { token: 'staff', body });
    const two = await call(staffSend(), { token: 'staff', body });
    const three = await call(staffSend(), { token: 'staff', body });

    assert.equal(one.payload.messageId, two.payload.messageId);
    assert.equal(one.payload.messageId, three.payload.messageId);
    assert.equal(await countMessages(id), 2);
    assert.equal((await getConversation(id)).messageCount, 2);
  });

  test('a replayed staff reply still carries exactly four fields', async () => {
    const opened = await call(start(), { token: 'a', body: startBody() });
    const body = { conversationId: opened.payload.conversationId,
      message: 'Reply', clientMessageId: uuid() };
    await call(staffSend(), { token: 'staff', body });
    const again = await call(staffSend(), { token: 'staff', body });

    const msg = await db().collection('chatMessages').doc(again.payload.messageId).get();
    assert.deepEqual(Object.keys(msg.data()).sort(),
      ['body', 'conversationId', 'createdAt', 'senderType']);
    assert.equal(msg.data().staffUserId, undefined);
  });

  test('a repeated staff reply spends the replay allowance, not the write allowance', async () => {
    const opened = await call(start(), { token: 'a', body: startBody() });
    const body = { conversationId: opened.payload.conversationId,
      message: 'Reply', clientMessageId: uuid() };
    await call(staffSend(), { token: 'staff', body });
    await call(staffSend(), { token: 'staff', body });
    await call(staffSend(), { token: 'staff', body });

    const staffBucket = await db().collection('chatRateLimits')
      .doc(RL.bucketId('staff_write', STAFF_UID, RATE_SECRET)).get();
    assert.equal(staffBucket.data().count, 1);
  });
});

/* ======================================= RATE-LIMIT STORAGE IS BOUNDED */
describe('rate-limit storage stays bounded', () => {
  test('fifty consecutive windows reuse ONE document', async () => {
    /* The window start lives inside the document rather than in its id. If it
       were in the id, this loop would leave fifty documents behind that
       nothing ever deletes. */
    const rule = RL.RULES.send_uid;
    const t0 = 1700000000000;
    for (let w = 0; w < 50; w += 1) {
      await RL.consume(db(), 'send_uid', 'bounded-subject', RATE_SECRET,
        { now: t0 + w * rule.windowMs });
    }
    const snap = await db().collection('chatRateLimits').get();
    assert.equal(snap.size, 1, 'fifty windows must not leave fifty documents');

    const doc = snap.docs[0];
    assert.equal(doc.data().count, 1, 'each new window restarts the count');
    assert.equal(doc.data().windowStart, t0 + 49 * rule.windowMs);
    assert.deepEqual(Object.keys(doc.data()).sort(),
      ['count', 'scope', 'updatedAt', 'windowStart']);
  });

  test('the document id is scope plus an HMAC, with no time component', async () => {
    const id = RL.bucketId('send_uid', 'bounded-subject', RATE_SECRET);
    assert.match(id, /^send_uid_[0-9a-f]{32}$/);
    /* Same identity, same id, whatever the clock says. */
    assert.equal(RL.bucketId('send_uid', 'bounded-subject', RATE_SECRET), id);
  });

  test('many identities each keep one document, and none holds an identifier', async () => {
    for (let i = 0; i < 12; i += 1) {
      for (let w = 0; w < 4; w += 1) {
        await RL.consume(db(), 'send_uid', 'subject-' + i, RATE_SECRET,
          { now: 1700000000000 + w * RL.RULES.send_uid.windowMs });
      }
    }
    const snap = await db().collection('chatRateLimits').get();
    assert.equal(snap.size, 12, 'one document per identity, not per window');
    for (const d of snap.docs) {
      assert.equal((d.id + JSON.stringify(d.data())).includes('subject-'), false);
    }
  });
});

/* ================================================== CLIENT ADDRESS */
describe('client address extraction', () => {
  const ipFor = (headers, socket) =>
    H.clientIp({ headers, socket: { remoteAddress: socket } });

  test('the Vercel header wins over a generic forwarded header', async () => {
    assert.equal(ipFor({
      'x-vercel-forwarded-for': '203.0.113.5',
      'x-forwarded-for': '198.51.100.9',
      'x-real-ip': '192.0.2.1'
    }, '10.0.0.1'), '203.0.113.5');
  });

  test('a spoof-looking chain cannot displace the platform header', async () => {
    /* A caller who prepends their own entries to x-forwarded-for still does
       not choose the identity, because the platform header is consulted
       first. */
    assert.equal(ipFor({
      'x-vercel-forwarded-for': '203.0.113.5',
      'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.5'
    }, '10.0.0.1'), '203.0.113.5');
  });

  test('the fallback order is vercel, then forwarded, then real-ip, then socket', async () => {
    assert.equal(ipFor({ 'x-forwarded-for': '198.51.100.9' }, '10.0.0.1'), '198.51.100.9');
    assert.equal(ipFor({ 'x-real-ip': '192.0.2.1' }, '10.0.0.1'), '192.0.2.1');
    assert.equal(ipFor({}, '10.0.0.1'), '10.0.0.1');
    assert.equal(ipFor({}, undefined), null);
  });

  test('IPv4 is normalised', async () => {
    assert.equal(H.normaliseIp('203.0.113.5'), '203.0.113.5');
    assert.equal(H.normaliseIp('  203.0.113.5  '), '203.0.113.5');
    assert.equal(H.normaliseIp('203.0.113.5:51234'), '203.0.113.5');
    assert.equal(H.normaliseIp('::ffff:203.0.113.5'), '203.0.113.5',
      'a v4-mapped address must share one bucket with the plain form');
  });

  test('IPv6 is normalised', async () => {
    assert.equal(H.normaliseIp('2001:db8::1'), '2001:db8::1');
    assert.equal(H.normaliseIp('2001:DB8::1'), '2001:db8::1');
    assert.equal(H.normaliseIp('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(H.normaliseIp('::1'), '::1');
  });

  test('anything that is not an address is refused, not stored', async () => {
    for (const junk of ['', '   ', 'not-an-ip', '999.999.999.999', '203.0.113',
      '<script>', '203.0.113.5; DROP', 'unknown', '[2001:db8::1', 'x'.repeat(200),
      null, undefined, {}, []]) {
      assert.equal(H.normaliseIp(junk), null, JSON.stringify(junk) + ' must be refused');
    }
  });

  test('a malformed header falls through to the next source', async () => {
    assert.equal(ipFor({
      'x-vercel-forwarded-for': 'garbage',
      'x-forwarded-for': '198.51.100.9'
    }, '10.0.0.1'), '198.51.100.9');

    assert.equal(ipFor({
      'x-vercel-forwarded-for': 'garbage',
      'x-forwarded-for': 'also garbage'
    }, '10.0.0.1'), '10.0.0.1', 'the socket address cannot be forged');
  });

  test('a repeated header is refused rather than guessed at', async () => {
    assert.equal(ipFor({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }, '10.0.0.1'),
      '10.0.0.1');
  });

  test('cf-connecting-ip is not consulted', async () => {
    assert.equal(H.ADDRESS_HEADERS.includes('cf-connecting-ip'), false);
    assert.equal(ipFor({ 'cf-connecting-ip': '203.0.113.99' }, '10.0.0.1'), '10.0.0.1');
  });
});

/* ============================================== SAME ORIGIN, RE-AUDITED */
describe('same-origin re-audit', () => {
  const check = (origin, host, extra = {}) =>
    H.sameOrigin({ headers: Object.assign({ origin, host }, extra) });

  test('the production origins are accepted', async () => {
    assert.equal(check('https://www.esthers.ca', 'www.esthers.ca'), true);
    assert.equal(check('https://esthers.ca', 'anything.vercel.app'), true);
  });

  test('a preview deployment matching its own host is accepted', async () => {
    assert.equal(check('https://esthers-git-x-team.vercel.app',
      'esthers-git-x-team.vercel.app'), true);
  });

  test('a suffix attack is refused', async () => {
    assert.equal(check('https://www.esthers.ca.attacker.example', 'www.esthers.ca'), false);
    assert.equal(check('https://attacker.example', 'www.esthers.ca'), false);
    assert.equal(check('https://wwwXesthers.ca', 'www.esthers.ca'), false);
    assert.equal(check('https://esthers.ca.attacker.example',
      'esthers.ca.attacker.example.evil'), false);
  });

  test('a prefix attack is refused', async () => {
    assert.equal(check('https://evil-www.esthers.ca.example', 'www.esthers.ca'), false);
  });

  test('the same host over a different scheme is a different origin', async () => {
    assert.equal(check('http://esthers-git-x.vercel.app', 'esthers-git-x.vercel.app'),
      false, 'http and https are different origins');
    assert.equal(check('https://esthers-git-x.vercel.app', 'esthers-git-x.vercel.app'), true);
  });

  test('local development over http is allowed deliberately', async () => {
    assert.equal(check('http://localhost:3000', 'localhost:3000'), true);
    assert.equal(check('http://127.0.0.1:3000', '127.0.0.1:3000'), true);
    /* But only for a local hostname - not for anything that merely runs on a port. */
    assert.equal(check('http://evil.example:3000', 'evil.example:3000'), false);
  });

  test('the default port is normalised away', async () => {
    assert.equal(check('https://www.esthers.ca:443', 'www.esthers.ca'), true);
    assert.equal(check('https://www.esthers.ca:8443', 'www.esthers.ca'), false);
  });

  test('a garbage Origin is refused, and a missing one is not an authorisation', async () => {
    assert.equal(check('not a url', 'www.esthers.ca'), false);
    assert.equal(check('null', 'www.esthers.ca'), false);
    /* Absent Origin passes THIS gate only; Firebase auth still has to pass. */
    assert.equal(H.sameOrigin({ headers: { host: 'www.esthers.ca' } }), true);
  });

  test('x-forwarded-host is honoured ahead of host', async () => {
    assert.equal(check('https://preview.vercel.app', 'internal-host',
      { 'x-forwarded-host': 'preview.vercel.app' }), true);
  });

  test('the endpoint refuses a cross-origin request before doing any work', async () => {
    const res = await call(start(), { token: 'a', body: startBody(),
      headers: { origin: 'https://www.esthers.ca.attacker.example', host: 'www.esthers.ca' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'cross_origin');
    assert.equal(await countConversations(), 0);
  });
});
