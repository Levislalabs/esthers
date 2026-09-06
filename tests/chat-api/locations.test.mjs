/*
 * TWO-SHOP ROUTING AND CONVERSATION TRANSFER, SERVER SIDE.
 *
 * Esther's runs two shops. A customer picks one; staff see only the shops
 * they are authorised for; a misrouted conversation can be handed over
 * without the customer losing anything. Every one of those is an
 * authorisation question, so every one of them is tested against the real
 * handlers and the real Firestore emulator - not against a mock of the rules.
 *
 * THE THING THESE TESTS EXIST TO STOP: a staff member with a conversationId
 * from the other shop, a browser console, and five minutes.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codeAndStrings } from './fixtures/source-view.mjs';
import {
  db, handlerFor, call, wipe, uuid, anonToken, passwordToken, seedStaff,
  countMessages, getConversation, Timestamp
} from './helpers.mjs';

const ROOT = '/home/user/esthers';
const START = ROOT + '/api/chat/start.js';
const STATUS = ROOT + '/api/chat/status.js';
const SEND = ROOT + '/api/chat/send.js';
const CONVERSATIONS = ROOT + '/api/admin/chat/conversations.js';
const MESSAGES = ROOT + '/api/admin/chat/messages.js';
const STAFF_SEND = ROOT + '/api/admin/chat/send.js';
const CLOSE = ROOT + '/api/admin/chat/close.js';
const TRANSFER = ROOT + '/api/admin/chat/transfer.js';

/* Four staff shapes, covering the whole authorisation surface. */
const MGR = 'staff-manager';          /* admin, no locations  -> all (rollout) */
const MAIN_ONLY = 'staff-main-only';  /* admin, ['main']                       */
const SPEC_ONLY = 'staff-spec-only';  /* admin, ['specialty']                  */
const NO_LOC = 'staff-empty-array';   /* admin, []            -> nothing       */
/*
 * 1st Avenue plus the unrouted pile. A REAL configuration - somebody has to
 * pick up the "I'm Not Sure" conversations - and the only shape in which the
 * inbox's post-filter is load-bearing: wanting 'unassigned' means the query
 * cannot filter positively (legacy documents have no locationId to match), so
 * specialty rows come back and the SERVER has to drop them.
 */
const MAIN_PLUS = 'staff-main-plus-unassigned';
const CUST = 'anon-customer-a';
const CUST_B = 'anon-customer-b';

const TOKENS = {
  mgr: passwordToken(MGR, 'manager@example.test'),
  main: passwordToken(MAIN_ONLY, 'first@example.test'),
  spec: passwordToken(SPEC_ONLY, 'keith@example.test'),
  noloc: passwordToken(NO_LOC, 'newhire@example.test'),
  mainPlus: passwordToken(MAIN_PLUS, 'firstplus@example.test'),
  cust: anonToken(CUST),
  custB: anonToken(CUST_B)
};

/*
 * Every timestamp in this schema is a Firestore Timestamp, so two reads of an
 * untouched field are equal in instant and never the same object. assert.equal
 * on them compares references and fails on a field that did not move, which is
 * the exact thing several of these tests are trying to prove did not happen.
 */
const at = (value) => (value && typeof value.toMillis === 'function'
  ? value.toMillis() : value);

const start = () => handlerFor(START, TOKENS);
const status = () => handlerFor(STATUS, TOKENS);
const custSend = () => handlerFor(SEND, TOKENS);
const inbox = () => handlerFor(CONVERSATIONS, TOKENS);
const transcript = () => handlerFor(MESSAGES, TOKENS);
const reply = () => handlerFor(STAFF_SEND, TOKENS);
const close = () => handlerFor(CLOSE, TOKENS);
const transfer = () => handlerFor(TRANSFER, TOKENS);

before(async () => { await wipe(); });
beforeEach(async () => {
  await wipe();
  /* Manager: admin with NO locations field - the rollout shape both
     production documents have today. */
  await seedStaff(MGR, { isActive: true, role: 'admin' });
  await seedStaff(MAIN_ONLY, { isActive: true, role: 'admin', locations: ['main'] });
  await seedStaff(SPEC_ONLY, { isActive: true, role: 'admin', locations: ['specialty'] });
  await seedStaff(NO_LOC, { isActive: true, role: 'admin', locations: [] });
  await seedStaff(MAIN_PLUS, { isActive: true, role: 'admin',
    locations: ['main', 'unassigned'] });
});

const goodStart = (over = {}) => Object.assign({
  name: 'Jordan Ellis', email: 'jordan@example.test',
  message: 'Do you make louvered chimney caps?', clientMessageId: uuid(),
  locationId: 'main'
}, over);

async function conversationAt(locationId, token = 'cust') {
  const res = await call(start(), { token, body: goodStart({ locationId }) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  return res.payload.conversationId;
}

/* A conversation as it exists in production from BEFORE routing: no
   locationId field at all. Written straight to Firestore because the API can
   no longer create one. */
async function legacyConversation(id = 'legacy-conv-1') {
  await db().collection('chatConversations').doc(id).set({
    customerUid: CUST,
    customerName: 'Old Customer',
    customerEmail: 'old@example.test',
    status: 'open',
    createdAt: 1000, updatedAt: 1000, lastMessageAt: 1000,
    messageCount: 1, closedAt: null,
    staffLastReadAt: null, customerLastReadAt: null, staffNotifiedAt: null
    /* NO locationId - that is the point */
  });
  await db().collection('chatMessages').doc(id + '__m1').set({
    conversationId: id, senderType: 'customer',
    body: 'a message from before routing existed', createdAt: 1000
  });
  return id;
}

const idsIn = (payload) => payload.conversations.map((c) => c.conversationId).sort();

/* ============================================ 1-10. THE CUSTOMER CONTRACT */

describe('a customer chooses a shop, and the server checks it', () => {
  for (const id of ['main', 'specialty', 'unassigned']) {
    test('accepts the canonical id ' + id, async () => {
      const res = await call(start(), { token: 'cust', body: goodStart({ locationId: id }) });
      assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
      const conv = await getConversation(res.payload.conversationId);
      assert.equal(conv.locationId, id, 'stored verbatim');
      assert.equal(conv.locationLabel, undefined,
        'and the LABEL is not stored - it is derived from the id');
    });
  }

  test('a missing locationId is refused', async () => {
    const body = goodStart();
    delete body.locationId;
    const res = await call(start(), { token: 'cust', body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, 'invalid_location');
  });

  test('every near-miss and nonsense value is refused', async () => {
    /* EXACT MATCH ONLY. These come from our own selector, not from a human
       typing, so ' Main ' is not a near-miss to repair - it is a request that
       did not come from the form. */
    const bad = [
      null, '', '   ', 'Main', 'MAIN', 'main ', ' main', '\tmain',
      'burnaby', 'keith', 'other', 'admin', 'MAIN_SHOP',
      'Main Shop - 1st Avenue',              /* the label is not an id */
      ['main'], { id: 'main' }, 0, 1, true, false
    ];
    for (const value of bad) {
      const res = await call(start(), { token: 'cust',
        body: goodStart({ locationId: value }) });
      assert.equal(res.statusCode, 400, 'accepted ' + JSON.stringify(value));
      assert.equal(res.payload.code, 'invalid_location');
    }
  });

  test('privileged routing fields are refused outright, not dropped',
    async () => {
      /*
       * Refused rather than ignored, deliberately. A caller who tries to set
       * transferredBy has told us something about their intentions, and the
       * honest reply is no - not a 200 that silently did something else.
       */
      for (const field of ['locationLabel', 'branch', 'branchName',
                           'assignedLocation', 'assignedStaff', 'staffLocations',
                           'locations', 'previousLocationId', 'lastTransferredAt',
                           'lastTransferredByStaffUid', 'transferCount',
                           'transferredBy', 'transferHistory', 'permissions']) {
        const body = goodStart();
        body[field] = 'anything at all';
        const res = await call(start(), { token: 'cust', body });
        assert.equal(res.statusCode, 400, field + ' was accepted');
        assert.equal(res.payload.code, 'forbidden_field', field);
      }
    });
});

/* ============================================ 15-20. IMMUTABLE FOR CUSTOMERS */

describe('a customer cannot move their own conversation', () => {
  test('locationId on a customer send changes nothing', async () => {
    const id = await conversationAt('main');
    const res = await call(custSend(), { token: 'cust', body: {
      conversationId: id, message: 'and another thing',
      clientMessageId: uuid(), locationId: 'specialty' } });
    /* Refused as a forbidden field would be too kind to describe: locationId
       is not on the send contract at all, so validateSend ignores it - what
       matters is that the stored routing did not move. */
    const conv = await getConversation(id);
    assert.equal(conv.locationId, 'main', 'still at the shop they chose');
    if (res.statusCode === 200) {
      assert.equal((await getConversation(id)).locationId, 'main');
    }
  });

  test('a query parameter on status changes nothing', async () => {
    const id = await conversationAt('specialty');
    const res = await call(status(), { method: 'GET', token: 'cust',
      query: { conversationId: id, locationId: 'main', location: 'main' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.locationId, 'specialty');
    assert.equal((await getConversation(id)).locationId, 'specialty');
  });

  test('the customer CAN see their own destination, and nothing else',
    async () => {
      const id = await conversationAt('specialty');
      const res = await call(status(), { method: 'GET', token: 'cust',
        query: { conversationId: id } });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(Object.keys(res.payload).sort(),
        ['conversationId', 'locationId', 'ok', 'status']);
      assert.equal(res.payload.locationId, 'specialty');
      /* No label - the client derives it. No staff anything. */
      for (const secret of ['locationLabel', 'staffUserId', 'customerUid',
                            'lastTransferredByStaffUid', 'previousLocationId',
                            'transferCount', 'customerEmail']) {
        assert.equal(res.payload[secret], undefined, secret + ' leaked');
      }
    });

  test('another customer still cannot read it at all', async () => {
    const id = await conversationAt('main');
    const res = await call(status(), { method: 'GET', token: 'custB',
      query: { conversationId: id } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
  });

  test('A CONVERSATION FROM BEFORE ROUTING RESOLVES TO UNASSIGNED',
    async () => {
      const id = await legacyConversation();
      /* The manager sees it... */
      const res = await call(inbox(), { method: 'GET', token: 'mgr' });
      assert.equal(res.statusCode, 200);
      const row = res.payload.conversations.find((c) => c.conversationId === id);
      assert.ok(row, 'a legacy conversation is still in the inbox');
      assert.equal(row.locationId, 'unassigned');
      assert.equal(row.locationLabel, 'Not Sure / Unassigned');
      /* ...and its transcript still loads, with its status intact. */
      const t = await call(transcript(), { method: 'GET', token: 'mgr',
        query: { conversationId: id } });
      assert.equal(t.statusCode, 200);
      assert.equal(t.payload.messages.length, 1);
      assert.equal(t.payload.conversation.status, 'open');
      /* Nothing was written to it to make that work. */
      const raw = await getConversation(id);
      assert.equal(raw.locationId, undefined, 'no backfill happened');
    });
});

/* ======================================== 21-32. STAFF LOCATION AUTHORIZATION */

describe('staff see only the shops they are authorised for', () => {
  async function three() {
    return {
      main: await conversationAt('main'),
      spec: await conversationAt('specialty'),
      un: await conversationAt('unassigned')
    };
  }

  test('a manager (admin, no locations) sees all three', async () => {
    const c = await three();
    const res = await call(inbox(), { method: 'GET', token: 'mgr' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(idsIn(res.payload), [c.main, c.spec, c.un].sort());
    assert.deepEqual(res.payload.locations.sort(),
      ['main', 'specialty', 'unassigned']);
  });

  test('main-only staff list main only', async () => {
    const c = await three();
    const res = await call(inbox(), { method: 'GET', token: 'main' });
    assert.deepEqual(idsIn(res.payload), [c.main]);
    assert.deepEqual(res.payload.locations, ['main']);
  });

  test('specialty-only staff list specialty only', async () => {
    const c = await three();
    const res = await call(inbox(), { method: 'GET', token: 'spec' });
    assert.deepEqual(idsIn(res.payload), [c.spec]);
    assert.deepEqual(res.payload.locations, ['specialty']);
  });

  test('an EMPTY locations array is an assignment of nothing', async () => {
    /* Somebody wrote locations: [] on purpose. That is not a reason to fall
       back to every shop. */
    await three();
    const res = await call(inbox(), { method: 'GET', token: 'noloc' });
    assert.equal(res.statusCode, 200, 'still authenticated staff');
    assert.deepEqual(res.payload.conversations, []);
    assert.deepEqual(res.payload.locations, []);
  });

  test('THE POST-FILTER IS LOAD-BEARING: a mixed set still drops the other shop',
    async () => {
      /*
       * MAIN + UNASSIGNED. Because 'unassigned' is in the set, listConversations
       * runs the query with NO location filter at all - it has to, or the
       * legacy documents that have no locationId field could never match. That
       * makes the server-side drop the ONLY thing standing between this
       * account and the specialty shop's inbox.
       *
       * Every other staff shape in this suite hides that: a manager wants all
       * three so nothing is dropped, and a single-shop account gets a positive
       * query filter instead. Without this test, deleting the post-filter is a
       * change no test notices.
       */
      const c = await three();
      const legacy = await legacyConversation();
      const res = await call(inbox(), { method: 'GET', token: 'mainPlus' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(idsIn(res.payload), [c.main, c.un, legacy].sort(),
        'main, unassigned and the pre-routing one - and NOT specialty');
      assert.equal(res.payload.conversations
        .some((x) => x.conversationId === c.spec), false,
        'the other shop leaked into the list');
      assert.deepEqual(res.payload.locations, ['main', 'unassigned']);
    });

  test('and cannot read the specialty transcript either', async () => {
    const c = await three();
    const res = await call(transcript(), { method: 'GET', token: 'mainPlus',
      query: { conversationId: c.spec } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
  });

  test('main-only staff CANNOT read a specialty transcript', async () => {
    const c = await three();
    const res = await call(transcript(), { method: 'GET', token: 'main',
      query: { conversationId: c.spec } });
    assert.equal(res.statusCode, 404);
    assert.equal(res.payload.code, 'conversation_not_found');
    /* THE SAME ANSWER as an id that never existed, so guessing tells them
       nothing about the other shop. */
    const ghost = await call(transcript(), { method: 'GET', token: 'main',
      query: { conversationId: 'x'.repeat(20) } });
    assert.equal(ghost.statusCode, res.statusCode);
    assert.equal(ghost.payload.code, res.payload.code);
    assert.equal(ghost.payload.error, res.payload.error);
  });

  test('specialty-only staff CANNOT read a main transcript', async () => {
    const c = await three();
    const res = await call(transcript(), { method: 'GET', token: 'spec',
      query: { conversationId: c.main } });
    assert.equal(res.statusCode, 404);
  });

  test('an unauthorised staff SEND is refused, and writes nothing',
    async () => {
      const c = await three();
      const before = await countMessages(c.spec);
      const res = await call(reply(), { token: 'main', body: {
        conversationId: c.spec, message: 'not my shop', clientMessageId: uuid() } });
      assert.equal(res.statusCode, 404);
      assert.equal(await countMessages(c.spec), before, 'no message was written');
    });

  test('an unauthorised staff CLOSE is refused, and closes nothing',
    async () => {
      const c = await three();
      const res = await call(close(), { token: 'main',
        body: { conversationId: c.spec } });
      assert.equal(res.statusCode, 404);
      assert.equal((await getConversation(c.spec)).status, 'open');
    });

  test('NO QUERY PARAMETER CAN WIDEN AUTHORIZATION', async () => {
    const c = await three();
    /* Every shape somebody would try from a console. */
    for (const query of [
      { locationId: 'specialty' }, { location: 'specialty' },
      { locations: 'specialty' }, { locationId: 'main,specialty' },
      { status: 'open', locationId: 'specialty' }
    ]) {
      const res = await call(inbox(), { method: 'GET', token: 'main', query });
      assert.equal(res.statusCode, 200, JSON.stringify(query));
      assert.deepEqual(idsIn(res.payload), [c.main],
        'widened by ' + JSON.stringify(query));
    }
  });

  test('the route reads locations from the staff document, never the request',
    () => {
      const src = readFileSync(ROOT + '/api/admin/chat/conversations.js', 'utf8');
      assert.match(src, /locations: ctx\.actor\.locations/);
      assert.equal(/query\.location/.test(src), false,
        'there is deliberately no location query parameter to widen');
    });

  test('changing a locations array takes effect on the next request',
    async () => {
      const c = await three();
      let res = await call(inbox(), { method: 'GET', token: 'main' });
      assert.deepEqual(idsIn(res.payload), [c.main]);

      await seedStaff(MAIN_ONLY, { isActive: true, role: 'admin',
        locations: ['main', 'specialty'] });
      res = await call(inbox(), { method: 'GET', token: 'main' });
      assert.deepEqual(idsIn(res.payload), [c.main, c.spec].sort(),
        'no code change, no deploy - one document');
    });
});

/* ==================================================== 33-60. THE TRANSFER */

describe('a misrouted conversation can be handed to the other shop', () => {
  const body = (conversationId, locationId) => ({ conversationId, locationId });

  test('main -> specialty succeeds for the SOURCE-authorised staff',
    async () => {
      const id = await conversationAt('main');
      const res = await call(transfer(), { token: 'main', body: body(id, 'specialty') });
      assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
      assert.equal(res.payload.conversationId, id, 'the SAME conversation');
      assert.equal(res.payload.locationId, 'specialty');
      assert.equal(res.payload.locationLabel, 'Specialty Shop - Keith Street');
      assert.equal(res.payload.previousLocationId, 'main');
      assert.equal(res.payload.previousLocationLabel, 'Main Shop - 1st Avenue');
      assert.equal(res.payload.changed, true);
      assert.equal((await getConversation(id)).locationId, 'specialty');
    });

  test('specialty -> main succeeds', async () => {
    const id = await conversationAt('specialty');
    const res = await call(transfer(), { token: 'spec', body: body(id, 'main') });
    assert.equal(res.statusCode, 200);
    assert.equal((await getConversation(id)).locationId, 'main');
  });

  test('unassigned -> main and unassigned -> specialty both succeed',
    async () => {
      /* The practical resolution workflow for "I'm Not Sure". */
      for (const dest of ['main', 'specialty']) {
        const id = await conversationAt('unassigned');
        const res = await call(transfer(), { token: 'mgr', body: body(id, dest) });
        assert.equal(res.statusCode, 200, dest);
        assert.equal((await getConversation(id)).locationId, dest);
      }
    });

  test('main -> unassigned succeeds', async () => {
    const id = await conversationAt('main');
    const res = await call(transfer(), { token: 'main', body: body(id, 'unassigned') });
    assert.equal(res.statusCode, 200);
    assert.equal((await getConversation(id)).locationId, 'unassigned');
  });

  test('a legacy no-location conversation can be routed for the first time',
    async () => {
      const id = await legacyConversation();
      const res = await call(transfer(), { token: 'mgr', body: body(id, 'specialty') });
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.previousLocationId, 'unassigned',
        'absence resolved to unassigned, not main');
      assert.equal((await getConversation(id)).locationId, 'specialty');
    });

  test('an unknown destination is refused', async () => {
    const id = await conversationAt('main');
    for (const dest of ['warehouse', 'Main', 'MAIN', '', null, ['main'],
                        { id: 'main' }, 'Main Shop - 1st Avenue']) {
      const res = await call(transfer(), { token: 'main', body: body(id, dest) });
      assert.equal(res.statusCode, 400, 'accepted ' + JSON.stringify(dest));
      assert.equal(res.payload.code, 'invalid_location');
    }
    assert.equal((await getConversation(id)).locationId, 'main');
  });

  test('SAME-LOCATION transfer is a safe no-op with no audit event',
    async () => {
      const id = await conversationAt('main');
      const res = await call(transfer(), { token: 'main', body: body(id, 'main') });
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.changed, false);
      const conv = await getConversation(id);
      assert.equal(conv.locationId, 'main');
      assert.equal(conv.transferCount, undefined, 'nothing was counted');
      assert.equal(conv.lastTransferredAt, undefined, 'nothing was recorded');
      assert.equal(conv.previousLocationId, undefined);
    });

  test('a CLOSED conversation cannot be transferred', async () => {
    const id = await conversationAt('main');
    await call(close(), { token: 'main', body: { conversationId: id } });
    const res = await call(transfer(), { token: 'main', body: body(id, 'specialty') });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, 'conversation_closed');
    assert.equal((await getConversation(id)).locationId, 'main',
      'a closed conversation does not silently change shop');
  });

  test('staff NOT authorised for the source cannot transfer it', async () => {
    const id = await conversationAt('specialty');
    const res = await call(transfer(), { token: 'main', body: body(id, 'main') });
    assert.equal(res.statusCode, 404, 'and told nothing about why');
    assert.equal((await getConversation(id)).locationId, 'specialty');
  });

  test('a BROWSER-SUPPLIED SOURCE IS IGNORED - the server reads the document',
    async () => {
      const id = await conversationAt('specialty');
      /* Main-only staff claiming the conversation is theirs. The server never
         looks at these; it loads the real document. */
      const res = await call(transfer(), { token: 'main', body: {
        conversationId: id, locationId: 'main',
        sourceLocation: 'main', sourceLocationId: 'main', from: 'main'
      } });
      assert.equal(res.statusCode, 404, 'the claim bought nothing');
      assert.equal((await getConversation(id)).locationId, 'specialty');
    });

  test('a caller cannot write its own audit trail', async () => {
    const id = await conversationAt('main');
    for (const field of ['previousLocationId', 'lastTransferredAt',
                         'lastTransferredByStaffUid', 'transferCount',
                         'transferredBy', 'transferHistory']) {
      const b = body(id, 'specialty');
      b[field] = 'forged';
      const res = await call(transfer(), { token: 'main', body: b });
      assert.equal(res.statusCode, 400, field + ' was accepted');
      assert.equal(res.payload.code, 'forbidden_field');
    }
    assert.equal((await getConversation(id)).locationId, 'main');
  });

  test('THE TRANSCRIPT SURVIVES: same id, same messages, no second conversation',
    async () => {
      const id = await conversationAt('main');
      await call(reply(), { token: 'main', body: {
        conversationId: id, message: 'Let me check.', clientMessageId: uuid() } });
      const before = await countMessages(id);
      const beforeConv = await getConversation(id);
      assert.equal(before, 2);

      const res = await call(transfer(), { token: 'main', body: body(id, 'specialty') });
      assert.equal(res.payload.conversationId, id, 'same conversationId');

      assert.equal(await countMessages(id), before, 'not one message copied');
      const after = await getConversation(id);
      assert.equal(after.messageCount, beforeConv.messageCount,
        'messageCount untouched - nothing was said');
      assert.equal(at(after.lastMessageAt), at(beforeConv.lastMessageAt),
        'lastMessageAt untouched');
      assert.equal(after.customerUid, beforeConv.customerUid);
      assert.equal(at(after.createdAt), at(beforeConv.createdAt));

      /* And exactly one conversation exists. */
      const all = await db().collection('chatConversations').get();
      assert.equal(all.size, 1, 'no second conversation was created');
    });

  test('the audit metadata is written, and is server-owned', async () => {
    const id = await conversationAt('main');
    await call(transfer(), { token: 'main', body: body(id, 'specialty') });
    const conv = await getConversation(id);
    assert.equal(conv.previousLocationId, 'main');
    assert.equal(conv.lastTransferredByStaffUid, MAIN_ONLY,
      'the authenticated uid, not anything from the body');
    /* A Firestore Timestamp, the same as createdAt and lastMessageAt - not a
       number, and not a string the request supplied. */
    assert.equal(typeof conv.lastTransferredAt.toMillis, 'function');
    assert.ok(at(conv.lastTransferredAt) >= at(conv.createdAt),
      'stamped when the transfer happened, not before the conversation');
    assert.equal(conv.transferCount, 1);

    /* A second, real transfer advances it. */
    await call(transfer(), { token: 'spec', body: body(id, 'main') });
    const again = await getConversation(id);
    assert.equal(again.transferCount, 2);
    assert.equal(again.previousLocationId, 'specialty');
    assert.equal(again.lastTransferredByStaffUid, SPEC_ONLY);
  });

  test('THE HANDOFF IS COMPLETE: the old shop loses read, send AND close',
    async () => {
      const id = await conversationAt('main');
      /* Main-only staff can do all three... */
      assert.equal((await call(transcript(), { method: 'GET', token: 'main',
        query: { conversationId: id } })).statusCode, 200);

      /* ...then hands it over. */
      const t = await call(transfer(), { token: 'main', body: body(id, 'specialty') });
      assert.equal(t.statusCode, 200);

      /* And immediately cannot. Handing something over is not being let into
         the room. */
      assert.equal((await call(transcript(), { method: 'GET', token: 'main',
        query: { conversationId: id } })).statusCode, 404, 'read');
      assert.equal((await call(reply(), { token: 'main', body: {
        conversationId: id, message: 'still me', clientMessageId: uuid() } })).statusCode,
        404, 'send');
      assert.equal((await call(close(), { token: 'main',
        body: { conversationId: id } })).statusCode, 404, 'close');
      assert.equal((await call(transfer(), { token: 'main',
        body: body(id, 'main') })).statusCode, 404, 'transfer back');

      assert.equal(await countMessages(id), 1, 'and wrote nothing on the way out');
      assert.equal((await getConversation(id)).status, 'open');
    });

  test('the destination shop gains normal access immediately', async () => {
    const id = await conversationAt('main');
    assert.equal((await call(transcript(), { method: 'GET', token: 'spec',
      query: { conversationId: id } })).statusCode, 404, 'not before');

    await call(transfer(), { token: 'main', body: body(id, 'specialty') });

    assert.equal((await call(transcript(), { method: 'GET', token: 'spec',
      query: { conversationId: id } })).statusCode, 200, 'read');
    assert.equal((await call(reply(), { token: 'spec', body: {
      conversationId: id, message: 'We can do that.', clientMessageId: uuid() } })).statusCode,
      200, 'send');
  });

  test('the inbox moves with it, both ways', async () => {
    const id = await conversationAt('main');
    assert.deepEqual(idsIn((await call(inbox(), { method: 'GET', token: 'main' })).payload),
      [id], 'starts at main');
    assert.deepEqual(idsIn((await call(inbox(), { method: 'GET', token: 'spec' })).payload),
      [], 'and not at specialty');

    await call(transfer(), { token: 'main', body: body(id, 'specialty') });

    assert.deepEqual(idsIn((await call(inbox(), { method: 'GET', token: 'main' })).payload),
      [], 'leaves the old inbox');
    assert.deepEqual(idsIn((await call(inbox(), { method: 'GET', token: 'spec' })).payload),
      [id], 'and appears in the new one');
  });

  test('a manager keeps access across every transfer', async () => {
    const id = await conversationAt('main');
    for (const dest of ['specialty', 'unassigned', 'main']) {
      await call(transfer(), { token: 'mgr', body: body(id, dest) });
      const res = await call(transcript(), { method: 'GET', token: 'mgr',
        query: { conversationId: id } });
      assert.equal(res.statusCode, 200, dest);
      assert.equal(res.payload.conversation.locationId, dest);
    }
  });

  test('THE CUSTOMER FOLLOWS THE CONVERSATION, and learns only where it went',
    async () => {
      const id = await conversationAt('main');
      let s = await call(status(), { method: 'GET', token: 'cust',
        query: { conversationId: id } });
      assert.equal(s.payload.locationId, 'main');

      await call(transfer(), { token: 'main', body: body(id, 'specialty') });

      s = await call(status(), { method: 'GET', token: 'cust',
        query: { conversationId: id } });
      assert.equal(s.statusCode, 200, 'the same conversation still works');
      assert.equal(s.payload.conversationId, id);
      assert.equal(s.payload.locationId, 'specialty', 'and says where it is now');
      assert.equal(s.payload.status, 'open');
      /* No staff identity, ever. */
      assert.deepEqual(Object.keys(s.payload).sort(),
        ['conversationId', 'locationId', 'ok', 'status']);

      /* The customer can still write to it, at its new shop. */
      const sent = await call(custSend(), { token: 'cust', body: {
        conversationId: id, message: 'still here', clientMessageId: uuid() } });
      assert.equal(sent.statusCode, 200);
    });

  test('a transfer is invisible to the message-count marker, and visible to '
    + 'the location one', async () => {
      /*
       * Why locationId had to join the dashboard's reconciliation marker: a
       * transfer changes routing WITHOUT writing a message, so lastMessageAt
       * and messageCount are deliberately untouched. A marker of those two
       * alone would leave a transferred conversation sitting in the old
       * shop's open thread.
       */
      const id = await conversationAt('main');
      const before = await getConversation(id);
      await call(transfer(), { token: 'main', body: body(id, 'specialty') });
      const after = await getConversation(id);
      assert.equal(at(after.lastMessageAt), at(before.lastMessageAt));
      assert.equal(after.messageCount, before.messageCount);
      assert.notEqual(after.locationId, before.locationId);
    });
});

/* ============================================ THE TWO ALLOW-LISTS AGREE */

describe('client and server describe the same three shops', () => {
  test('the canonical ids match exactly', async () => {
    const server = await import(ROOT + '/api/_chat/locations.js');
    const clientSrc = readFileSync(ROOT + '/assets/js/chat-locations.js', 'utf8');
    for (const id of server.default.LOCATION_IDS) {
      assert.ok(clientSrc.indexOf("'" + id + "'") !== -1, id + ' missing client-side');
    }
    assert.match(clientSrc, /export const LOCATION_IDS = \[MAIN, SPECIALTY, UNASSIGNED\];/);
  });

  test('THE EXACT LABELS, pinned so they cannot drift into vagueness',
    async () => {
    /* "Main Branch" and "Specialty Shop" were rejected: a customer
       skim-reading two vague labels sends the curved scupper to the wrong
       shop, and so does a staff member glancing at an inbox row. */
    const server = (await import(ROOT + '/api/_chat/locations.js')).default;
    assert.equal(server.LABELS.main, 'Main Shop - 1st Avenue');
    assert.equal(server.LABELS.specialty, 'Specialty Shop - Keith Street');
    assert.equal(server.LABELS.unassigned, 'Not Sure / Unassigned');

    const clientSrc = readFileSync(ROOT + '/assets/js/chat-locations.js', 'utf8');
    assert.ok(clientSrc.indexOf("label: 'Main Shop - 1st Avenue'") !== -1);
    assert.ok(clientSrc.indexOf("label: 'Specialty Shop - Keith Street'") !== -1);
    assert.ok(clientSrc.indexOf("label: 'Not Sure / Unassigned'") !== -1);
    assert.ok(clientSrc.indexOf("choice: \"I'm Not Sure\"") !== -1);
    assert.ok(clientSrc.indexOf("address: '3890 E. First Ave., Burnaby'") !== -1);
    assert.ok(clientSrc.indexOf("address: '3701 Keith Street'") !== -1);
  });

  test('THE SERVER DOES NOT IMPORT THE CLIENT COPY', () => {
    /*
     * The whole point. A browser file is not an authority.
     *
     * Read through codeAndStrings(): comments blanked, string literals kept.
     * A require() path lives in a string, so nothing that could actually
     * reach the client file escapes this check - while locations.js is still
     * free to SAY, in a comment, that assets/js/chat-locations.js is its
     * browser twin. Deleting that comment to satisfy a substring search would
     * be answering the test instead of the question.
     */
    for (const f of ['api/_chat/locations.js', 'api/chat/start.js',
                     'api/admin/chat/transfer.js',
                     'api/admin/chat/conversations.js', 'api/_chat/service.js']) {
      const src = codeAndStrings(readFileSync(ROOT + '/' + f, 'utf8'));
      assert.equal(/chat-locations/.test(src), false,
        f + ' must not reach for a client file');
      assert.equal(/assets\//.test(src), false,
        f + ' must not reach into assets/');
    }
  });

  test('the label is never stored, only derived', async () => {
    const id = await conversationAt('main');
    const raw = await getConversation(id);
    assert.equal(raw.locationId, 'main');
    assert.equal(raw.locationLabel, undefined,
      'storing the label would make renaming a shop a migration');
  });
});

/* ============================== EACH GATE ON ITS OWN, NOT JUST THE STACK */

/*
 * THE SAME CHECK IS MADE TWICE ON PURPOSE, AND BOTH COPIES ARE TESTED HERE.
 *
 * Every staff route that touches one conversation authorises it at the door,
 * in loadConversationForStaff(), and AGAIN inside the transaction that
 * writes. That is not belt-and-braces for its own sake: a transfer can land
 * in the gap between the two, and "I had it open a second ago" is not
 * authorisation.
 *
 * Through the HTTP handlers, either copy alone is enough to produce a 404 -
 * so deleting one is a change no end-to-end test can see. These call the
 * service functions directly, which is the only way the second copy is
 * observable at all.
 */
describe('every gate holds on its own, not only as a pair', () => {
  let S;
  const now = () => Timestamp.now();

  test('the service module loads', async () => {
    /* Imported in a test rather than in the describe body: on Node v22 a
       throw up there marks the suite not-ok, runs none of it, and still exits
       0 - so the assertion would be attached to nothing. */
    S = (await import(ROOT + '/api/_chat/service.js')).default;
    assert.equal(typeof S.loadConversationForStaff, 'function');
    assert.equal(typeof S.sendStaffMessage, 'function');
    assert.equal(typeof S.closeConversation, 'function');
  });

  const mainOnly = () => ({ uid: MAIN_ONLY, role: 'admin', locations: ['main'] });

  test('THE DOOR: loadConversationForStaff refuses the other shop by itself',
    async () => {
      S = S || (await import(ROOT + '/api/_chat/service.js')).default;
      const id = await conversationAt('specialty');
      await assert.rejects(
        () => S.loadConversationForStaff(db(), mainOnly(), id),
        (err) => {
          assert.equal(err.status, 404);
          assert.equal(err.code, 'conversation_not_found');
          assert.equal(err.message, 'That conversation no longer exists.');
          return true;
        });

      /* And allows its own, so the refusal above is the check and not a
         function that refuses everything. */
      const mine = await conversationAt('main');
      const ok = await S.loadConversationForStaff(db(), mainOnly(), mine);
      assert.equal(ok.locationId, 'main');
    });

  test('THE RACE: a reply is refused INSIDE the transaction, after the door '
    + 'has already been passed', async () => {
      /*
       * Exactly the gap: the route authorised main, and by the time the write
       * runs the conversation is at Keith Street. Calling the service
       * directly is that race, deterministically.
       */
      S = S || (await import(ROOT + '/api/_chat/service.js')).default;
      const id = await conversationAt('main');
      await db().collection('chatConversations').doc(id)
        .update({ locationId: 'specialty' });      /* the transfer lands */

      await assert.rejects(
        () => S.sendStaffMessage(db(), { now }, {
          conversationId: id, message: 'a reply from the wrong shop',
          clientMessageId: uuid(), actor: mainOnly()
        }),
        (err) => {
          assert.equal(err.code, 'conversation_not_found');
          return true;
        });
      assert.equal(await countMessages(id), 1, 'nothing was written');
    });

  test('and so is a close', async () => {
    S = S || (await import(ROOT + '/api/_chat/service.js')).default;
    const id = await conversationAt('main');
    await db().collection('chatConversations').doc(id)
      .update({ locationId: 'specialty' });

    await assert.rejects(
      () => S.closeConversation(db(), { now }, {
        conversationId: id, actor: mainOnly()
      }),
      (err) => {
        assert.equal(err.code, 'conversation_not_found');
        return true;
      });
    assert.equal((await getConversation(id)).status, 'open',
      'the old shop could not close what it no longer holds');
  });

  test('AN EMPTY locations ARRAY IS NOT AN EXCUSE TO FALL BACK', async () => {
    /* Read straight off the function, so a fallback added in ANY branch of
       staffLocations() shows up here rather than only in whichever branch an
       end-to-end test happens to walk. */
    const L = (await import(ROOT + '/api/_chat/locations.js')).default;
    assert.deepEqual(L.staffLocations({ role: 'admin', locations: [] }), []);
    assert.deepEqual(L.staffLocations({ role: 'admin', locations: ['nonsense'] }), []);
    assert.deepEqual(L.staffLocations({ role: 'admin', locations: 'main' }), []);
    assert.deepEqual(L.staffLocations({ role: 'admin', locations: {} }), []);
    assert.deepEqual(L.staffLocations({ role: 'admin', locations: 0 }), []);
    /* Only a genuinely ABSENT field falls back, and only for a role that is
       on the all-shops list. */
    assert.deepEqual(L.staffLocations({ role: 'admin' }),
      ['main', 'specialty', 'unassigned']);
    assert.deepEqual(L.staffLocations({ role: 'admin', locations: null }),
      ['main', 'specialty', 'unassigned']);
    /* A role nobody has invented yet fails CLOSED. */
    assert.deepEqual(L.staffLocations({ role: 'dispatcher' }), []);
    assert.deepEqual(L.staffLocations({}), []);
    assert.deepEqual(L.staffLocations(null), []);
  });
});
