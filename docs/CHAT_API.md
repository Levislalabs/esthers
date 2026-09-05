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
underscore. `api/_chat/` is shared code, not endpoints — see §2a for the
proof, which does not rest on analogy with the existing `api/_lib.js`.

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

## 2a. Proof that the helpers are not routable

`api/_lib.js` has an underscore-prefixed **file** basename. The chat helpers
have ordinary basenames inside an underscore-prefixed **directory**, which is
a different rule, so the existing file proves nothing about them by analogy.

The question was settled against Vercel's own detection library —
`@vercel/fs-detectors`, the package the Vercel CLI uses to decide which files
under `api/` become Serverless Functions. It was fed this repository's real
`git ls-files` output, its real `package.json` and its real `vercel.json`,
plus one fabricated `api/negative-control.js` as a control.

Result:

```
builders produced for api/:
  api/admin/chat/close.js          api/chat/send.js
  api/admin/chat/conversations.js  api/chat/start.js
  api/admin/chat/messages.js       api/quote.js
  api/admin/chat/send.js           api/upload-token.js
  api/negative-control.js     <- control WAS detected
builders for api/_chat/**:  NONE
routes mentioning _chat:    []
errors: null   warnings: []
```

The control was detected, so the detector was discriminating rather than
returning nothing. Neither `api/_chat/*` nor `api/_lib.js` produces a builder,
and no generated route mentions `_chat`. The static builder's pattern excludes
all of `api/**`, so these files are not served as static assets either — they
are pulled into the function bundles by dependency tracing, exactly as
`api/_lib.js` already is.

Reproduce with `@vercel/fs-detectors` 7.2.1 and `detectBuilders()`. This should
be re-checked if the project ever moves to a Vercel build pipeline that
resolves `api/` differently.

---

## 2b. Node runtime — a hard pre-deployment requirement

`firebase-admin@14.3.0` declares `engines: { "node": ">=22" }`.

**This repository does not currently guarantee that.** `package.json` has no
`engines` field and `vercel.json` declares no `functions.runtime`, so the
runtime is whatever the Vercel project setting says.

> **Before the chat API is enabled, Esther's Vercel project must be set to
> Node 22.x or 24.x.** Verify it in Project → Settings → Node.js Version.

No runtime declaration was added here, because adding `engines.node` to
`package.json` changes how Vercel selects the runtime for the **whole**
project, including the working quote and upload endpoints — that is a
production change and belongs in a deliberate step, not smuggled into a
hardening pass.

For the record, pinning `>=22` later would not break anything currently
deployed: `@vercel/blob` requires `>=20` and `@google-cloud/firestore`
requires `>=18`, so Node 22 satisfies every dependency the quote flow uses.

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
`staffNotifiedAt`, `startRequestHash`.

A conversation document is server-private — the deployed rules let a customer
read their own, but nothing here is secret from its own owner, and
`publicConversation()` serialises an explicit allow-list that excludes both
`customerUid` and `startRequestHash`.

---

## 7. Same-origin policy

`sameOrigin()` allows a request whose `Origin` is one of the production
origins, **or** matches the host actually serving the request. Matching
against the request's own host is what lets a Vercel Preview deployment work
without anybody enumerating preview hostnames.

Matching is on the whole host, never a prefix or suffix, so
`www.esthers.ca.attacker.example` is refused. The scheme is compared too — the
same host over a different scheme is a different origin — with `http` accepted
only for a local development hostname, where there is no TLS to speak of. The
URL parser normalises a default port away, so `https://www.esthers.ca:443` and
`www.esthers.ca` match while `:8443` does not.

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

A retried request must not append a second copy of the same message, or open
a second conversation — a flaky connection should not double-post to the
shop's inbox.

### Messages

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

### Conversations — and the defect this replaced

The message id above is only idempotent if the conversation id is stable.
It was not. `startConversation()` originally used a random Firestore auto-id:

```js
const convRef = db.collection(CONVERSATIONS).doc();   // fresh id every call
```

which fed a fresh message id on every attempt, which meant the duplicate check
inside the transaction was unreachable dead code. A customer whose response
was dropped opened a **second conversation** and appeared twice in the inbox.

The conversation id is now derived:

```
conversationId = sha256("esthers:chat:conversation:v1" \0 uid \0 clientMessageId)
                 -> first 32 hex
```

The uid comes from the **verified token**, never the body, so one visitor
cannot derive another's conversation id. Nothing identifying goes into the
hash — no name, no email, no message body. The id is **not** a credential and
is not treated as one: ownership is checked against `customerUid` on every
read and write, and the deployed rules do the same.

### The same key with a different payload

Reusing one `clientMessageId` for a genuinely different request is neither a
retry nor a new conversation. Creating a second conversation would defeat the
key; overwriting the first would silently discard a message somebody sent. So
neither happens and the caller gets **409 `idempotency_conflict`**.

To tell the two apart, the conversation carries `startRequestHash` — a SHA-256
of the canonicalised name, email and first message. It lives on the
**conversation**, which is server-private and never serialised by
`publicConversation()`; putting it on a message would break §6.

Canonicalisation means casing in an address and doubled spaces in a name are
treated as the same request typed twice, not a conflict.

### Atomicity and races

The create is one transaction, so there is never a conversation without its
first message or a message without its conversation. The duplicate check is
repeated **inside** the transaction, which is what makes simultaneous
identical starts safe: the loser of the race retries, sees the document and
returns it. A test fires six concurrent identical starts and asserts exactly
one conversation and one message result.

### Rate-limit accounting for retries

A proven replay spends a separate `replay_uid` allowance instead of the
`start_*` or `send_*` allowance, so a dropped response does not cost the
customer their ability to send real messages. This is decided by a cheap
read-only pre-check; correctness never depends on it, because the transaction
repeats the check.

A **new** message or conversation never takes that path, so an invented
idempotency key cannot be used to skip the ordinary limits.

**Known limit:** the replay discount can only apply once something is stored.
Callers racing *simultaneously*, before the first write lands, are
indistinguishable from callers opening new conversations, and each spends a
start allowance — some are refused with 429. Sequential retries, which is what
a dropped response actually produces, take the replay path. No duplicate data
is created in either case, and there is a test for it.

---

## 8a. Client address, and which header is trusted

Extraction order, first value that parses as an IP address wins:

1. `x-vercel-forwarded-for` — set by Vercel's edge, not supplyable by a caller
2. `x-forwarded-for` — also overwritten (not appended to) by Vercel, but a
   header every proxy in the world writes, so it is the fallback
3. `x-real-ip`
4. the socket address, which no client can forge

A candidate that does not parse is **skipped, not used**. Taking the left-most
element of an attacker-supplied comma list and storing whatever it contains is
the classic version of this bug; every candidate must survive Node's
`net.isIP()` first, and a header full of nonsense falls through to the next
source. `::ffff:1.2.3.4` is folded to `1.2.3.4` so one caller does not get two
allowances, and a `host:port` or `[v6]:port` form is unwrapped.

`cf-connecting-ip` is **not** consulted. This project's topology does not
currently include a proxy that sets it, and trusting a header no trusted hop
writes is exactly how spoofing works.

**Operational caveat.** This ordering describes traffic reaching Vercel
directly — DNS-only, including Cloudflare in DNS-only mode. If Esther's
production traffic is ever put behind another reverse proxy *in front of*
Vercel, the effective client-IP semantics must be re-verified before these
headers are trusted: a proxy that appends rather than overwrites changes which
element of the chain is the real client. No DNS or Cloudflare change was made
as part of this work.

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
| `replay_uid` | 120 | 60 s | a **proven replay** of something already stored |

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
  anything is initialised, and the route answers **503 `not_configured`** with
  the body `Online messaging is temporarily unavailable.` The private key is
  checked structurally (PEM header, footer, real newlines, base64 body) before
  the SDK is touched, so "the variable never held a PEM" is told apart from
  "the PEM looked right and crypto still refused it".
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

### Diagnostics, and what is never logged

No message body, no customer email, no Firebase ID token, no private key, no
raw IP address, and **no error message, stack or cause** — a test scans every
`console.*` call in `api/_chat/` and fails if one interpolates raw error data.

A log line carries only an **allow-listed token** from `DIAGNOSTIC_TOKENS` in
`firebase-admin.js`, plus a value-free shape summary:

```
chat: not configured [chat/start] invalid_private_key_pem shape=pid:1,pid_ok:1,\
email:1,email_ok:1,svcacct:1,key:1,key_begin:1,key_end:1,key_multiline:1,\
key_body:0,secret:1
```

The shape is built from a fixed list of field names with `0`/`1` values, so by
construction the only characters that can appear are those names and those two
digits — no length, no count, no fragment of any value. Which structural checks
a *valid* key passes is already public knowledge, so this discloses nothing
while saying exactly which check failed.

Every diagnostic log also carries a runtime segment:

```
runtime=node:22,sdk_app:1,sdk_firestore:1,sdk_auth:1,sdk_code:none
```

Node's major version and which SDK modules loaded — all public facts, none
derived from a credential. `sdk_code` is an allow-listed classification of the
module-load error (`MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`,
`ERR_REQUIRE_ESM`, `syntax_error`, `other`, `none`), never a message.

This exists because the first token the deployed diagnostics produced —
`firebase_admin_module_missing` — was the *fallback* of a single wrapper
around all three `require()` calls, so it meant either "the package is absent"
**or** "the package is present and threw while loading". Those have completely
different fixes. The three modules are now loaded separately at module scope
and each reports its own token: `firebase_admin_app_not_found` versus
`firebase_admin_app_load_failed`, and the same for `firestore` and `auth`.

The SDK modules are loaded by **literal dynamic `import()`**, all three
through one loader. `require('firebase-admin/auth')` was the second
production fault: that module pulls in `jose`, an ESM-only package, and
`require()` of ESM throws `ERR_REQUIRE_ESM` on any Node without `require(esm)`
support — which landed in 22.12, while Vercel's Node 22.x was below it. A
developer machine on a newer 22.x succeeds, which is why it only ever failed
in production. `import()` resolves the package's `import` condition
(`lib/esm/…`) and works on every Node 22. The specifiers stay literal so
Vercel's tracer still follows them.

### The transitive ERR_REQUIRE_ESM, and the one dependency pin

Converting our own loads to `import()` was necessary but **not sufficient**.
Production still reported `firebase_admin_auth_load_failed` /
`ERR_REQUIRE_ESM`, because the failing `require()` was never ours:

```
firebase-admin/auth
  -> firebase-admin/lib/auth/token-verifier.js
    -> firebase-admin/lib/utils/jwt.js
      -> jwks-rsa/src/index.js
        -> jwks-rsa/src/JwksClient.js
          -> jwks-rsa/src/utils.js   line 1:  const jose = require('jose');
```

`jwks-rsa@4.1.0` is `type: "commonjs"` and requires `jose`; its `jose@6` is
`type: "module"` with no CommonJS build at all. `jwks-rsa`'s own engines field
says the quiet part out loud — `^20.19.0 || ^22.12.0 || >= 23.0.0` — those are
exactly the Node versions with `require(esm)`. `import()` in *our* code cannot
change a `require()` written four levels down.

The fix is one narrow, scoped npm override:

```json
"overrides": { "jwks-rsa": { "jose": "^5.10.0" } }
```

`jose@5` ships a CommonJS build, so `jwks-rsa`'s `require()` succeeds on every
Node 22 with no reliance on `require(esm)`. Scoped to `jwks-rsa` deliberately:
a bare `"jose"` key would repin it for every package, including ones that are
fine on 6. `firebase-admin` stays at 14.3.0 — no downgrade. The lockfile diff
is nine lines: the nested `jose@6` entry disappears and `jwks-rsa` uses the
already-present hoisted `jose@5.10.0`.

The regression gate is `node --no-experimental-require-module`, which disables
`require(esm)` and reproduces Vercel's runtime exactly. Tests assert all three
modules import, and that the endpoint reaches 401 rather than a module error,
under that flag.

Because `import()` is asynchronous, `initAdmin()` is async and every caller
awaits it. Two memos guard the cost and the races: the SDK load promise is
cached for the life of the instance (a failed load is *not* retried — whether
a module loads is a property of the deployment, and this path runs before rate
limiting), and the in-flight initialisation promise is cached so concurrent
cold starts build exactly one Firebase app rather than one each. The load
promise never rejects; it resolves to a result object, so a memoised rejection
can never become an unhandled rejection. Loading the library needs no
credentials — `initializeApp()` and `cert()` still happen lazily on the first
request, so a Preview deployment without secrets still builds and still
answers `not_configured`. The loads are wrapped in try/catch so a failure
becomes a precise diagnostic rather than a cold-start crash with no log line.

Five log prefixes, five meanings:

| prefix | status | meaning |
|---|---|---|
| `chat: not configured` | 503 | the environment is wrong; fix it in Vercel |
| `chat: init failed` | 500 | the SDK failed for a reason that is not the environment |
| `chat: auth failed` | 500 | the token **verifier** broke — not a bad token |
| `chat: service failed` | 500 | a named stage of the request failed |
| `chat: unhandled` | 500 | an unexpected fault that named no stage |

### Stage diagnostics for authenticated requests

An authenticated `/api/chat/start` passes through token verification, a
provider check, an idempotency read, two rate-limit transactions and a write
transaction. `unknown_error` cannot tell those apart, so each stage labels
anything it throws with an allow-listed constant from
`api/_chat/stages.js` — never anything derived from the request:

```
auth_token_verify_failed         auth_token_verify_internal_error
auth_customer_provider_check_failed   auth_customer_uid_missing
auth_staff_lookup_failed         request_validation_failed
idempotency_lookup_failed        rate_limit_check_failed
chat_start_transaction_failed    chat_send_transaction_failed
chat_close_transaction_failed    firestore_operation_failed
response_serialization_failed    unknown_authenticated_error
```

The first stage wins: an inner label is more specific than the outer one that
caught it. `runStage()` only labels and rethrows — it never swallows an error
or changes a status code.

**A bad token and a broken verifier are now different things.** The verifier
used to catch *everything* and answer `401 invalid_token`, so an SDK fault, a
network failure reaching Google's keys, or `auth.verifyIdToken` not being a
function all told the visitor "your session has expired" and logged nothing.
Only an allow-listed Firebase `auth/*` code is treated as the caller's fault
and kept at 401; anything else is a 500 the log can name. Both still refuse
the request — nothing is let through either way.

**Errors are recognised by tag as well as `instanceof`.** Each chat error
class sets a stable `chatErrorKind` string. `instanceof` compares against one
module instance, so if a bundler ever loads `auth.js` twice a well-formed 401
silently becomes a 500 `unknown_error` — indistinguishable from the fault
being diagnosed. The tag survives that.

**Why this exists.** The first production deploy answered 500 and logged only
`chat: unhandled [chat/start] Error`, which identified nothing. Two causes:
firebase-admin's `FirebaseAppError` does **not** override `.name` — it is
literally `"Error"` — and `respondToError()` recognised only this project's own
`ChatConfigError`, so every SDK initialisation failure fell through to the
generic branch. Each SDK call is now wrapped separately, so a failure names the
stage it happened in, and known Firebase error codes map to tokens.

A test asserts that a rejected credential never travels inside the error that
rejected it: `ChatInitError` deliberately carries no `cause`, because a cause
chain is exactly what a future edit stringifies into a log.

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
npm run test:chat-api        # 144 tests, Firestore emulator
npm run test:firestore-rules # 67 tests, the Phase 1 rules
npm test                     # both
```

Token verification is **injected**, not module-mocked, so the tests exercise
the real auth code path with a stand-in verifier. Each test file gets its own
`demo-` namespace, because `node --test` runs files in parallel and the
teardown deletes whole collections.

The suite is checked by deliberately regressing the code and confirming it
goes red. Each of these produced failures: removing the ownership check;
adding a `staffUserId` to a message; dropping the anonymous-provider check;
making the rate-limit secret fall back to a default; relaxing `isActive` to
truthy; removing the project guard; reverting the conversation id to a random
auto-id; removing the payload-conflict check; consulting `x-forwarded-for`
ahead of the Vercel header; removing IP validation; removing the same-origin
scheme check; putting a window number back in the rate-limit document id; and
removing the ownership check from the replay pre-check.

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
  which carry `updatedAt` in plain milliseconds for a future sweep. Note that
  no cleanup job is *needed* to bound `chatRateLimits`: the window start lives
  inside the document, so one identity keeps exactly one document per scope
  forever rather than accumulating one per window. A test drives fifty
  consecutive windows and asserts a single document remains.
- **Read receipts.** `staffLastReadAt` and `customerLastReadAt` exist on the
  conversation and are never written by this API.
