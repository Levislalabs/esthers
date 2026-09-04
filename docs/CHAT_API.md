# Chat API (Phase 2A)

The server-side half of the Firebase chat. Six Vercel Serverless Functions
that are the **only** thing permitted to write a conversation or a message.

This document is internal. `.vercelignore` excludes `docs/`, so it is not
served at any URL.

**Status: written, tested, NOT enabled.** No Vercel environment variable has
been set, nothing has been deployed, and the public site still says
"Online messaging coming soon."

---

## 1. Why the API exists at all

The deployed Firestore rules (see `CHAT_FIREBASE_SECURITY.md`) let a customer
**read** their own conversation and its messages directly from the browser.
They let a browser **write** nothing. Every create and every update goes
through these functions.

That is deliberate, and it rests on one fact:

> **The Firebase Admin SDK bypasses Firestore Security Rules completely.**

Nothing an Admin SDK call does is checked by a rule. The rules are the
browser's boundary; this code is its own boundary, and it has to be, because
no rule is standing behind it. Every ownership check, every status check and
every field allow-list in `api/_chat/service.js` is load-bearing on its own.

Two consequences worth keeping in mind:

- A bug in this API is not caught by the rules. There is no second net.
- The rules were **not** loosened to make this API work, and must not be.
  If a future change here seems to require a broader rule, the change is
  wrong.

---

## 2. File layout

Vercel does not route anything under `api/` whose name begins with an
underscore, which is how `api/_lib.js` already works in production. So
`api/_chat/` is shared code, not endpoints.

```
api/
  _chat/
    http.js            headers, same-origin, body parsing, client address
    firebase-admin.js  lazy Admin init + the project-id guard
    auth.js            who is calling, proved from a Firebase ID token
    validation.js      input shape, and refusal of privileged fields
    rate-limit.js      Firestore-backed fixed-window limits
    service.js         every Firestore read and write
    handler.js         the wrapper each endpoint runs inside
  chat/
    start.js           POST  /api/chat/start
    send.js            POST  /api/chat/send
  admin/chat/
    conversations.js   GET   /api/admin/chat/conversations
    messages.js        GET   /api/admin/chat/messages
    send.js            POST  /api/admin/chat/send
    close.js           POST  /api/admin/chat/close
```

`api/_chat/` **must not** be added to `.vercelignore` — the endpoints require
it at runtime. `tests/` and `docs/` are excluded and should stay that way.

---

## 3. The gate order

Every endpoint runs inside `createHandler()` in `api/_chat/handler.js`, so no
route can be written without its checks. The order is cheapest-first:

1. **Method** — anything else gets 405 with an `Allow` header.
2. **Same origin** — see §7.
3. **Body parse** — malformed or oversized JSON gets 400.
4. **Admin init** — lazy; a deployment with no credentials gets 503.
5. **Rate-limit secret** — mutating routes only; missing gets 503.
6. **Authentication / authorisation** — 401 or 403.
7. **The endpoint body**, which consumes the rate limit and then works.

Rate limiting is consumed **after** authentication on purpose. It writes a
Firestore document, so letting an unauthenticated caller trigger it would
hand them a free write amplifier.

---

## 4. Authentication and authorisation

Identity comes from exactly one place: a Firebase ID token in
`Authorization: Bearer <token>`, verified by the Admin SDK. No endpoint reads
a uid, an email, a role or a `senderType` from a request body.

### Customer

`/api/chat/*` require a token whose `firebase.sign_in_provider` is
`anonymous`.

Esther's staff hold real Email/Password accounts in the same Firebase
project. A check for merely "is authenticated" would hand a staff token the
customer endpoints, so the provider is checked explicitly and a non-anonymous
token is refused with **403 `not_a_customer`**.

### Staff

`/api/admin/chat/*` require, in this order:

1. A verified token that is **not** anonymous (checked before any lookup, so
   a customer uid never becomes a staff document read).
2. A `staff/{uid}` document that exists.
3. `isActive === true` — strictly `true`. A truthy `"yes"` or `1` is not an
   authorisation, and there is a test for that.
4. `role` in `ALLOWED_STAFF_ROLES` (currently `['admin']`).

Authorisation is **the `staff/{uid}` document and nothing else** — not the
email domain, not a token claim, not anything the browser sent. A convincing
`@esthers.ca` address with no staff document gets 403.

No staff uid is hardcoded anywhere in this code.

The staff documents already exist in the production project and were **not**
created, read or modified by this work. The tests use seeded documents in a
`demo-` emulator namespace.

---

## 5. Routes

All responses are JSON with `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
**no** `Access-Control-Allow-Origin` header of any kind.

Success: `{ "ok": true, ... }`. Failure: `{ "ok": false, "code": "...",
"error": "a sentence a person can read" }`.

### POST /api/chat/start — customer

Opens a conversation and writes its first message, in one transaction.

```json
{ "name": "Jordan Ellis",
  "email": "jordan@example.com",
  "message": "Do you make custom flashing?",
  "clientMessageId": "3f1c...-uuid-v4" }
```

→ `{ "ok": true, "conversationId": "...", "messageId": "...", "status": "open" }`

Nothing else is returned. No `customerUid`, no email echo, no timestamps.

### POST /api/chat/send — customer

```json
{ "conversationId": "...", "message": "...", "clientMessageId": "...uuid..." }
```

→ `{ "ok": true, "messageId": "...", "conversationId": "..." }`

Requires that the caller owns the conversation and that it is `open`.

### GET /api/admin/chat/conversations — staff

`?status=open|closed` (default `open`), `?limit=1..50` (default 50).
Served by the deployed `(status ASC, lastMessageAt DESC)` composite index.

→ `{ "ok": true, "conversations": [...], "status": "open", "limit": 50 }`

Each entry is an explicit allow-list: `conversationId`, `customerName`,
`customerEmail`, `status`, `createdAt`, `lastMessageAt`, `messageCount`,
`staffLastReadAt`. **`customerUid` is never serialised.**

### GET /api/admin/chat/messages — staff

`?conversationId=...`, `?limit=1..200` (default 200).
Served by the deployed `(conversationId ASC, createdAt ASC)` index.

→ `{ "ok": true, "conversation": {...}, "messages": [...], "limit": 200 }`

**Reading does not mark the thread read.** A GET that mutates state surprises
everybody, and browsers prefetch. A deliberate read-state endpoint can come
later.

### POST /api/admin/chat/send — staff

Same body as the customer send. `senderType` is set to `"staff"` by the
server; a request that supplies it is rejected outright.

### POST /api/admin/chat/close — staff

`{ "conversationId": "..." }` → `{ "ok": true, "conversationId": "...",
"status": "closed" }`

Idempotent: closing an already-closed thread succeeds and does **not** rewrite
`closedAt`. Nothing is deleted.

---

## 6. The message schema contract

A `chatMessages` document contains **exactly four fields**:

```
conversationId   createdAt   senderType   body
```

This is not a style preference. The deployed rules let a customer read their
own messages directly, and **a rule cannot hide a field inside a document it
has allowed**. So every field on a message is customer-visible, and anything
internal — a staff uid, an email address, an IP, moderation state — would be
handed straight to the customer.

`buildMessage()` in `service.js` is the only place a message is constructed.
Tests assert the exact key set for both a customer message and a staff reply,
and a Phase 1 rules test asserts it independently.

If an authorship audit trail is wanted later, it belongs in a separate
server-only collection, not on the message.

### Conversation fields

`customerUid` (from the verified token, never the body), `customerName`,
`customerEmail`, `status`, `createdAt`, `updatedAt`, `lastMessageAt`,
`messageCount`, `closedAt`, `staffLastReadAt`, `customerLastReadAt`,
`staffNotifiedAt`.

---

## 7. Same-origin policy

`sameOrigin()` allows a request whose `Origin` is one of the production
origins, **or** matches the host actually serving the request. Matching
against the request's own host is what lets a Vercel Preview deployment work
without anybody enumerating preview hostnames.

A request with **no** `Origin` header is allowed through this gate. That is
not a trust decision: a browser attaches `Origin` to every cross-origin
request, so its absence means this is not a cross-site browser call — and
Firebase authentication still has to pass afterwards. **Origin is never an
authentication mechanism here.**

No CORS header is emitted at all. These are same-origin APIs, and even a
specific `Access-Control-Allow-Origin` would only widen what a browser is
willing to do with them.

---

## 8. Idempotency

A retried request must not append a second copy of the same message — a
flaky connection should not double-post to the shop's inbox.

The client generates a UUIDv4 `clientMessageId`. The server derives the
Firestore document id from it:

```
messageId = sha256(conversationId + "\0" + clientMessageId)  ->  first 40 hex
```

The separator is NUL, which neither a conversation id nor a UUID can contain,
so no two different pairs can produce the same input string.

The obvious alternative — store `clientMessageId` on the document and query
for it — would add a fifth field to a customer-readable document and break the
contract in §6. Hashing it into the id instead keeps the document at four
fields and makes the duplicate **impossible** rather than merely detectable:
the second write lands on the same path.

The conversation id is mixed in, so the same `clientMessageId` in two
different conversations is two different messages.

A duplicate returns success with the same `messageId` and does **not**
increment `messageCount` — counting it twice is the exact bug idempotency
exists to prevent.

---

## 9. Rate limiting, and why no raw IP is stored

Counters live in Firestore, in `chatRateLimits`, which the deployed rules deny
to every browser. They cannot live in process memory: a serverless function
gives every instance its own memory, so an attacker gets a fresh counter just
by being routed elsewhere. A test proves two independently built handlers
observe the same counter.

| Scope | Limit | Window | Applies to |
|---|---|---|---|
| `start_uid` | 3 | 10 min | new conversation, per anonymous uid |
| `start_ip` | 8 | 60 min | new conversation, per hashed address |
| `send_uid` | 20 | 60 s | customer message, per anonymous uid |
| `send_ip` | 60 | 60 s | customer message, per hashed address |
| `staff_write` | 60 | 60 s | staff reply or close, per staff uid |

Both a uid limit and an address limit exist because a browser can mint a fresh
Anonymous Auth uid whenever it likes. A per-uid limit alone stops an honest
retry loop and nothing else; the address limit is the layer that costs an
abuser something. A test drives three fresh uids from one address and confirms
exactly eight starts get through.

**No raw IP address is ever stored.** The address is HMAC-SHA256'd with
`CHAT_RATE_LIMIT_SECRET` before it becomes part of a document id. HMAC rather
than a plain hash, because a bare SHA-256 of an IPv4 address is reversible by
enumerating the whole space — only four billion guesses. The uid is hashed the
same way; it is not secret, but there is no reason to leave a browsable list
of visitor identifiers lying in a collection.

A rate-limit document holds four bookkeeping fields and nothing else:
`scope`, `windowStart`, `count`, `updatedAt`. A test reads the whole
collection back and asserts the address, its network part and the uid appear
nowhere in any id or any field.

The hashed address is a **rate-limit dimension only**, never identity: an
office behind one NAT shares a bucket, and a determined caller can change
address.

The window start is held **inside** the document rather than in its id, so one
identity keeps exactly one document per scope forever instead of accumulating
one per window.

A refused request answers **429** with a `Retry-After` header and a matching
`retryAfter` field, and writes no conversation and no message.

---

## 10. Failing closed

Two configuration failures are treated as reasons to refuse service, not to
carry on:

- **Missing or malformed Firebase credentials** → `initAdmin()` throws before
  anything is initialised, and the route answers **503 `not_configured`**.
- **Missing or too-short `CHAT_RATE_LIMIT_SECRET`** → mutating routes answer
  **503**. An unlimited chat endpoint is worse than an unavailable one.
  Read-only staff routes still work; refusing the inbox as well would take the
  shop offline for no security gain.

### The accidental-project guard

`api/_chat/firebase-admin.js` holds `EXPECTED_PROJECT_ID` as a **hardcoded
constant**, not an environment value — a guard that compares one configured
value against another guards nothing. If `FIREBASE_PROJECT_ID` is anything
else, initialisation is refused and `initializeApp` is never called.

This matters more here than it would elsewhere: the Admin SDK bypasses
Security Rules, so a mistyped project id is caught by no rule at all. It would
simply write to the wrong project, quietly.

Initialisation is **lazy and cached**. Nothing touches Firebase at import
time, so a Preview deployment without credentials still builds and still
answers; the first request is what initialises, and a warm instance reuses it.

### What is never logged

No message body, no customer email, no Firebase ID token, no private key, no
raw IP address. An unrecognised error logs its route and its error *name* and
nothing more; a configuration error logs a short token such as
`unexpected_project`. A test asserts that a rejected credential never travels
inside the error that rejected it.

---

## 11. Refusing privilege, not just nonsense

`validation.js` rejects a request that contains any of:

```
customerUid  senderType  staffUserId  createdAt  updatedAt  status
closedAt  messageCount  lastMessageAt  staffLastReadAt
customerLastReadAt  staffNotifiedAt  uid  role
```

with **400 `forbidden_field`** — rejected, not silently ignored. Dropping them
quietly would work, but a caller probing for a way in deserves a clear no, and
a future edit that accidentally started reading one of those fields would be
caught here instead of becoming a vulnerability.

Limits: name 1–100, email ≤254, message ≤2000, `clientMessageId` must be a
UUID, `conversationId` must be `[A-Za-z0-9_-]{1,64}` and is refused if it is
`.`, `..` or `__reserved__`-shaped — long before it reaches a document path.

Control characters are refused (tab, newline and carriage return are allowed
inside a message). Unicode is otherwise left completely alone: names and
messages in any script are ordinary input, and mangling them would be a bug.

The message is **not** HTML-escaped. It stays plain text and is rendered with
`textContent`; a server that encoded here would put `&amp;` in front of the
customer.

### One error for two situations

A customer asking about a conversation that does not exist and a customer
asking about **somebody else's** conversation get a byte-identical 404.
Anything else turns the endpoint into an oracle: try ids until the message
changes, and you have learned which ones are real. The test asserts the two
payloads are `deepEqual`, not merely both-404.

---

## 12. Running the tests

Everything runs against the local Firestore emulator under a `demo-` project
id, which Firebase refuses to let reach a real service. No credential, no
service-account key, no real staff password, and the production project is
never named as a target.

```
npm run test:chat-api        # 98 tests, Firestore emulator
npm run test:firestore-rules # 67 tests, the Phase 1 rules
npm test                     # both
```

Token verification is **injected**, not module-mocked, so the tests exercise
the real auth code path with a stand-in verifier. Each test file gets its own
`demo-` namespace, because `node --test` runs files in parallel and the
teardown deletes whole collections.

The suite was checked by deliberately regressing the code and confirming it
goes red — removing the ownership check, adding a `staffUserId` to a message,
dropping the anonymous-provider check, making the rate-limit secret fall back
to a default, relaxing `isActive` to truthy, and removing the project guard
each produced failures.

---

## 13. Configuration still required before this can run

None of this has been set. See `.env.example` for the names and placeholders.

| Variable | Where it comes from |
|---|---|
| `FIREBASE_PROJECT_ID` | must equal `EXPECTED_PROJECT_ID` in `firebase-admin.js` |
| `FIREBASE_CLIENT_EMAIL` | service account `client_email` |
| `FIREBASE_PRIVATE_KEY` | service account `private_key`, `\n` escapes fine |
| `CHAT_RATE_LIMIT_SECRET` | generated locally, ≥16 chars, not a Firebase value |

No service account was created and no key was downloaded as part of this work.
When one is created, the downloaded JSON must not be added to this repository:
copy the three fields into the Vercel dashboard and delete the file.

---

## 14. Explicitly not done yet

- **Firebase App Check.** Required before the public realtime customer
  listener is enabled. Not required to run this API, but the listener is not
  part of this phase and must not be enabled without it.
- **The customer realtime listener** and any change to the public chat UI.
  The site still says "Online messaging coming soon."
- **The `/admin/chat` staff inbox UI.** These endpoints have no page yet.
- **Resend notifications** to the shop when a conversation opens. Note that
  `startConversation()` deliberately sends no email from inside its
  transaction: a notification failing must never decide whether the
  customer's message was saved.
- **Retention / cleanup.** Nothing is deleted, including rate-limit documents,
  which carry `updatedAt` in plain milliseconds for a future sweep.
- **Read receipts.** `staffLastReadAt` and `customerLastReadAt` exist on the
  conversation and are never written by this API.
