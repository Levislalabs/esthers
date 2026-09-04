/**
 * Esther's - Firestore Security Rules test suite
 *
 * Runs against the Firestore EMULATOR only. It needs no production
 * credentials, no service-account key, and never contacts the real
 * esther-s-chat project - the project id below is a "demo-" id, which the
 * Firebase tooling refuses to connect to any live backend.
 *
 *   npm run test:firestore-rules
 *
 * The suite exists because, in this architecture, these rules are the ONLY
 * thing standing between a browser and the chat data. Everything else the
 * browser wants goes through the Vercel API. So the questions asked here
 * are deliberately blunt: can the wrong person read this, and can anybody
 * at all write it.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, limit, getDocs, onSnapshot,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-esthers-rules';

/* The two customers and the one staff member the matrix is built around. */
const UID_A     = 'anon-A';
const UID_B     = 'anon-B';
const UID_STAFF = 'staff-test';

const CONV_A = 'convA';
const CONV_B = 'convB';

/* How many messages conversation A gets. Deliberately larger than the
   Firestore rules access-call limit, to prove the dependent get() in
   ownsConversation() is cached per request rather than performed once per
   returned document. If it were not, this number would break the query. */
const BULK_MESSAGES = 60;

let env;
let unauth, customerA, customerB, staff;

/* A staff member signs in with Email/Password, so their token carries a
   different sign_in_provider. That single field is what the rules key on,
   and it is why holding a staff account grants no direct data access. */
const ANON_TOKEN  = { firebase: { sign_in_provider: 'anonymous' } };
const STAFF_TOKEN = { firebase: { sign_in_provider: 'password' }, email: 'manager@esthers.ca' };

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
  unauth    = env.unauthenticatedContext();
  customerA = env.authenticatedContext(UID_A, ANON_TOKEN);
  customerB = env.authenticatedContext(UID_B, ANON_TOKEN);
  staff     = env.authenticatedContext(UID_STAFF, STAFF_TOKEN);
});

after(async () => { if (env) await env.cleanup(); });

/* Seeded with the rules switched off, the way the future Vercel API will
   write it - through the Admin SDK, which bypasses rules. Nothing in this
   suite is allowed to create data through the rules, because nothing in
   production may either. */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const base = Date.now();

    await setDoc(doc(db, 'chatConversations', CONV_A), {
      customerUid: UID_A, customerName: 'Alice', customerEmail: 'alice@example.com',
      status: 'open', createdAt: new Date(base), updatedAt: new Date(base),
      lastMessageAt: new Date(base), messageCount: BULK_MESSAGES,
      staffLastReadAt: null, customerLastReadAt: null,
      staffNotifiedAt: null, closedAt: null,
    });
    await setDoc(doc(db, 'chatConversations', CONV_B), {
      customerUid: UID_B, customerName: 'Bob', customerEmail: 'bob@example.com',
      status: 'open', createdAt: new Date(base), updatedAt: new Date(base),
      lastMessageAt: new Date(base), messageCount: 2,
      staffLastReadAt: null, customerLastReadAt: null,
      staffNotifiedAt: null, closedAt: null,
    });

    for (let i = 0; i < BULK_MESSAGES; i++) {
      await setDoc(doc(db, 'chatMessages', `a-${String(i).padStart(3, '0')}`), {
        conversationId: CONV_A, createdAt: new Date(base + i),
        senderType: i % 2 ? 'staff' : 'customer',
        body: `A message ${i}`,
        staffUserId: i % 2 ? UID_STAFF : null,
      });
    }
    await setDoc(doc(db, 'chatMessages', 'b-000'), {
      conversationId: CONV_B, createdAt: new Date(base),
      senderType: 'customer', body: 'B message', staffUserId: null,
    });

    /* Mirrors the two real allow-list documents. Values are illustrative;
       the real UIDs are not needed to prove the collection is sealed. */
    await setDoc(doc(db, 'staff', UID_STAFF), {
      email: 'manager@esthers.ca', displayName: 'EJay',
      isActive: true, role: 'admin',
    });
    await setDoc(doc(db, 'chatRateLimits', 'chat-send__deadbeef__1700000000'), {
      hits: 3, windowStart: 1700000000,
    });
  });
});

/* ------------------------------------------------------------- helpers */

const convRef = (ctx, id) => doc(ctx.firestore(), 'chatConversations', id);
const msgRef  = (ctx, id) => doc(ctx.firestore(), 'chatMessages', id);

/* The exact query shape the future realtime listener will use. */
const transcriptQuery = (ctx, conversationId) =>
  query(
    collection(ctx.firestore(), 'chatMessages'),
    where('conversationId', '==', conversationId),
    orderBy('createdAt', 'asc'),
  );

/* onSnapshot resolves on the first delivered snapshot, or rejects on the
   first error. Realtime is the entire point of the design, so it is tested
   as realtime rather than inferred from a one-shot read. */
function firstSnapshot(q, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('listener timed out')); }, timeoutMs);
    const stop = onSnapshot(q,
      (snap) => { clearTimeout(timer); stop(); resolve(snap); },
      (err)  => { clearTimeout(timer); stop(); reject(err); },
    );
  });
}

/* =====================================================================
   1. UNAUTHENTICATED - a visitor with no Firebase session at all
   ===================================================================== */
describe('unauthenticated', () => {
  test('cannot get a conversation', async () => {
    await assertFails(getDoc(convRef(unauth, CONV_A)));
  });
  test('cannot query messages, even correctly scoped', async () => {
    await assertFails(getDocs(transcriptQuery(unauth, CONV_A)));
  });
  test('cannot get a single message', async () => {
    await assertFails(getDoc(msgRef(unauth, 'a-000')));
  });
  test('cannot read a staff document', async () => {
    await assertFails(getDoc(doc(unauth.firestore(), 'staff', UID_STAFF)));
  });
  test('cannot read rate-limit data', async () => {
    await assertFails(getDoc(doc(unauth.firestore(), 'chatRateLimits', 'chat-send__deadbeef__1700000000')));
  });
  test('cannot create a conversation', async () => {
    await assertFails(addDoc(collection(unauth.firestore(), 'chatConversations'), { customerUid: 'x' }));
  });
  test('cannot create a message', async () => {
    await assertFails(addDoc(collection(unauth.firestore(), 'chatMessages'), { conversationId: CONV_A, body: 'x' }));
  });
  test('cannot update a conversation', async () => {
    await assertFails(updateDoc(convRef(unauth, CONV_A), { status: 'closed' }));
  });
  test('cannot update a message', async () => {
    await assertFails(updateDoc(msgRef(unauth, 'a-000'), { body: 'tampered' }));
  });
  test('cannot delete a conversation', async () => {
    await assertFails(deleteDoc(convRef(unauth, CONV_A)));
  });
  test('cannot delete a message', async () => {
    await assertFails(deleteDoc(msgRef(unauth, 'a-000')));
  });
});

/* =====================================================================
   2. ANONYMOUS CUSTOMER A - what a real visitor is allowed to do
   ===================================================================== */
describe('anonymous customer A - allowed', () => {
  test('gets its own conversation', async () => {
    const snap = await assertSucceeds(getDoc(convRef(customerA, CONV_A)));
    assert.equal(snap.data().customerUid, UID_A);
  });

  test('queries its own transcript', async () => {
    const snap = await assertSucceeds(getDocs(transcriptQuery(customerA, CONV_A)));
    assert.equal(snap.size, BULK_MESSAGES);
  });

  test('gets a single message from its own conversation', async () => {
    await assertSucceeds(getDoc(msgRef(customerA, 'a-000')));
  });

  test('realtime listener on its own conversation document works', async () => {
    const snap = await firstSnapshot(convRef(customerA, CONV_A));
    assert.equal(snap.data().customerUid, UID_A);
  });

  test('realtime listener on its own transcript works', async () => {
    const snap = await firstSnapshot(transcriptQuery(customerA, CONV_A));
    assert.equal(snap.size, BULK_MESSAGES);
  });

  /* The dependent get() in ownsConversation() runs for every document a
     query returns. Firestore caches access calls by path within one
     request, so this 60-document query costs ONE conversation read, not
     60 - and stays inside the access-call limit. If that ever stops being
     true, this test is where it surfaces. */
  test(`transcript query of ${BULK_MESSAGES} docs stays inside the access-call limit`, async () => {
    const snap = await assertSucceeds(getDocs(transcriptQuery(customerA, CONV_A)));
    assert.equal(snap.size, BULK_MESSAGES);
    assert.ok(BULK_MESSAGES > 10, 'must exceed the documented access-call limit to be meaningful');
  });
});

describe('anonymous customer A - denied', () => {
  test('cannot get another customer\'s conversation', async () => {
    await assertFails(getDoc(convRef(customerA, CONV_B)));
  });
  test('cannot query another customer\'s transcript', async () => {
    await assertFails(getDocs(transcriptQuery(customerA, CONV_B)));
  });
  test('cannot get another customer\'s message directly', async () => {
    await assertFails(getDoc(msgRef(customerA, 'b-000')));
  });
  test('cannot list the conversations collection', async () => {
    await assertFails(getDocs(collection(customerA.firestore(), 'chatConversations')));
  });
  test('cannot list conversations even filtered to its own uid', async () => {
    await assertFails(getDocs(query(
      collection(customerA.firestore(), 'chatConversations'),
      where('customerUid', '==', UID_A),
    )));
  });
  test('cannot read a staff document', async () => {
    await assertFails(getDoc(doc(customerA.firestore(), 'staff', UID_STAFF)));
  });
  test('cannot read rate-limit data', async () => {
    await assertFails(getDoc(doc(customerA.firestore(), 'chatRateLimits', 'chat-send__deadbeef__1700000000')));
  });
  test('cannot create a conversation', async () => {
    await assertFails(addDoc(collection(customerA.firestore(), 'chatConversations'), { customerUid: UID_A }));
  });
  test('cannot create a message, even in its own conversation', async () => {
    await assertFails(addDoc(collection(customerA.firestore(), 'chatMessages'), {
      conversationId: CONV_A, senderType: 'customer', body: 'direct write', createdAt: new Date(),
    }));
  });
  test('cannot forge a staff message', async () => {
    await assertFails(addDoc(collection(customerA.firestore(), 'chatMessages'), {
      conversationId: CONV_A, senderType: 'staff', body: 'we will do it free', staffUserId: UID_STAFF,
    }));
  });
  test('cannot update its own conversation', async () => {
    await assertFails(updateDoc(convRef(customerA, CONV_A), { status: 'closed' }));
  });
  test('cannot update its own message', async () => {
    await assertFails(updateDoc(msgRef(customerA, 'a-000'), { body: 'rewritten' }));
  });
  test('cannot delete its own conversation', async () => {
    await assertFails(deleteDoc(convRef(customerA, CONV_A)));
  });
  test('cannot delete its own message', async () => {
    await assertFails(deleteDoc(msgRef(customerA, 'a-000')));
  });
  test('cannot write a staff document', async () => {
    await assertFails(setDoc(doc(customerA.firestore(), 'staff', UID_A), { isActive: true, role: 'admin' }));
  });
});

/* =====================================================================
   3. ANONYMOUS CUSTOMER B - the mirror, so isolation is proven both ways
   ===================================================================== */
describe('anonymous customer B - isolation mirrors A', () => {
  test('gets its own conversation', async () => {
    const snap = await assertSucceeds(getDoc(convRef(customerB, CONV_B)));
    assert.equal(snap.data().customerUid, UID_B);
  });
  test('queries its own transcript', async () => {
    const snap = await assertSucceeds(getDocs(transcriptQuery(customerB, CONV_B)));
    assert.equal(snap.size, 1);
  });
  test('cannot get customer A\'s conversation', async () => {
    await assertFails(getDoc(convRef(customerB, CONV_A)));
  });
  test('cannot query customer A\'s transcript', async () => {
    await assertFails(getDocs(transcriptQuery(customerB, CONV_A)));
  });
  test('cannot get customer A\'s message directly', async () => {
    await assertFails(getDoc(msgRef(customerB, 'a-000')));
  });
});

/* =====================================================================
   4. EMAIL/PASSWORD USER - a real staff account gets nothing directly
   ===================================================================== */
describe('email/password user (staff) has no direct Firestore access', () => {
  test('cannot get a conversation', async () => {
    await assertFails(getDoc(convRef(staff, CONV_A)));
  });
  test('cannot get the other conversation either', async () => {
    await assertFails(getDoc(convRef(staff, CONV_B)));
  });
  test('cannot query any transcript', async () => {
    await assertFails(getDocs(transcriptQuery(staff, CONV_A)));
  });
  test('cannot list chatMessages', async () => {
    await assertFails(getDocs(collection(staff.firestore(), 'chatMessages')));
  });
  test('cannot list chatConversations', async () => {
    await assertFails(getDocs(collection(staff.firestore(), 'chatConversations')));
  });
  test('cannot read its OWN staff document', async () => {
    await assertFails(getDoc(doc(staff.firestore(), 'staff', UID_STAFF)));
  });
  test('cannot read rate-limit data', async () => {
    await assertFails(getDoc(doc(staff.firestore(), 'chatRateLimits', 'chat-send__deadbeef__1700000000')));
  });
  test('cannot reply directly to a conversation', async () => {
    await assertFails(addDoc(collection(staff.firestore(), 'chatMessages'), {
      conversationId: CONV_A, senderType: 'staff', body: 'direct reply', staffUserId: UID_STAFF,
    }));
  });
  test('cannot close a conversation directly', async () => {
    await assertFails(updateDoc(convRef(staff, CONV_A), { status: 'closed' }));
  });
  test('cannot promote itself in the staff collection', async () => {
    await assertFails(updateDoc(doc(staff.firestore(), 'staff', UID_STAFF), { role: 'superadmin' }));
  });
});

/* =====================================================================
   5. MALFORMED AND HOSTILE QUERIES - rules are not filters
   ===================================================================== */
describe('hostile query shapes fail closed', () => {
  test('unconstrained chatMessages query is refused', async () => {
    await assertFails(getDocs(collection(customerA.firestore(), 'chatMessages')));
  });

  test('query with ordering but no ownership constraint is refused', async () => {
    await assertFails(getDocs(query(
      collection(customerA.firestore(), 'chatMessages'),
      orderBy('createdAt', 'asc'),
    )));
  });

  test('swapping only the conversationId to another customer\'s is refused', async () => {
    await assertFails(getDocs(transcriptQuery(customerA, CONV_B)));
  });

  test('query spanning both conversations is refused', async () => {
    await assertFails(getDocs(query(
      collection(customerA.firestore(), 'chatMessages'),
      where('conversationId', 'in', [CONV_A, CONV_B]),
    )));
  });

  test('limit does not smuggle another customer\'s messages out', async () => {
    await assertFails(getDocs(query(
      collection(customerA.firestore(), 'chatMessages'),
      where('conversationId', '==', CONV_B),
      limit(1),
    )));
  });

  test('a filter on senderType alone is refused', async () => {
    await assertFails(getDocs(query(
      collection(customerA.firestore(), 'chatMessages'),
      where('senderType', '==', 'staff'),
    )));
  });

  test('querying a conversation that does not exist is refused', async () => {
    await assertFails(getDocs(transcriptQuery(customerA, 'no-such-conversation')));
  });

  test('a realtime listener on another customer\'s transcript errors out', async () => {
    await assert.rejects(() => firstSnapshot(transcriptQuery(customerA, CONV_B)));
  });

  test('an unknown collection is denied by the catch-all', async () => {
    await assertFails(getDoc(doc(customerA.firestore(), 'someFutureCollection', 'x')));
    await assertFails(setDoc(doc(customerA.firestore(), 'someFutureCollection', 'x'), { a: 1 }));
  });
});
