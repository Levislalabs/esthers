# Customer messaging — Firebase security model

Internal document. Not deployed: `docs/` is excluded in `.vercelignore`.

**Phase 1 status.** This describes the security foundation only. There is
no chat backend running, no customer chat on the website, and nothing in
this repository deploys to Firebase. The public site still says online
messaging is not connected, and that stays true until a later, explicitly
authorised phase.

---

## 1. The Firebase project

| | |
|---|---|
| Project | `esther-s-chat` |
| Firestore | Native mode, Standard edition, database `(default)` |
| Region | `northamerica-northeast2` (Toronto) |
| Plan | Spark (no cost) |

Toronto keeps customer messages in Canada, which is the right default for
a BC business handling customer names and email addresses.

## 2. Authentication

| Who | Method | Purpose |
|---|---|---|
| Customer | Anonymous | An identity, not a login. No account, no sign-in screen. |
| Staff | Email/Password | Identifies a named person. |

Email-link/passwordless is deliberately **not** enabled.

**Anonymous account auto-cleanup is on: Firebase removes anonymous
accounts older than 30 days.** That is a real product constraint, not
housekeeping. A conversation is owned by an anonymous UID, so once the
account is reaped, the returning visitor is a different UID and can no
longer read that conversation directly. The transcript is not lost —
staff still see it through the API — but the customer's own view of it
ends. Any UI promising indefinite history would be lying. Design the
customer experience for a conversation that lives days or weeks, not
years.

## 3. Who may touch the data, and how

```
CUSTOMER
  send     browser -> Vercel /api/chat/*        -> Admin SDK -> Firestore
  receive  browser -> Firestore listener, DIRECT, READ-ONLY
                      governed by firestore.rules

STAFF
  all      browser -> Vercel /api/admin/chat/*  -> Admin SDK -> Firestore
```

Customers read directly because realtime delivery is the point: a staff
reply should appear without the page asking for it. They never write
directly. Staff neither read nor write directly — a staff Firebase
account grants **no** Firestore access at all.

### Direct customer READ — exactly what is granted

Only these two, and only to an anonymously authenticated caller:

1. `get` on `chatConversations/{id}` where `customerUid == request.auth.uid`
2. `get`/`list` on `chatMessages` where the referenced conversation exists
   and its `customerUid == request.auth.uid`

`list` on `chatConversations` is refused outright. A customer already
holds the one id it needs, so the collection can never be walked,
counted, or sampled — not even for rows the caller owns.

### Direct customer WRITE — none

No `create`, `update` or `delete` on any collection, for anybody, ever.
Not even for the customer who owns the row. Every write is the Vercel
API's, after it has verified a Firebase ID token.

### Direct staff access — none

`staff/{uid}` denies read as well as write, so the team cannot be
enumerated even with a valid staff session. The allow-list is read
server-side.

## 4. Why the rules test the sign-in provider

`request.auth != null` would be wrong here. Staff hold real accounts in
the same project, so "signed in" would hand them the direct access the
architecture withholds. The customer rules therefore require

```
request.auth.token.firebase.sign_in_provider == 'anonymous'
```

which an Email/Password session fails. This is verified by test, not
assumed — see the `email/password user` block in the suite.

## 5. Why the Admin SDK bypasses all of this

The Firebase Admin SDK authenticates as a service account and is **not
subject to Security Rules**. That is intended, and it has a consequence
worth stating plainly:

> Once the Vercel API exists, `firestore.rules` protects the browser
> path only. Everything the server does is constrained by the server's
> own code and by nothing else.

The Supabase design this replaced had Postgres RLS as a genuine second
enforcement layer: an API bug still met a database that refused. There
is no equivalent here. So the following are not optional in later
phases:

- one shared module builds every Firestore query and write; no route
  talks to Firestore directly
- every message query applies its `conversationId` filter first and
  unconditionally
- every response is built from an explicit field allow-list, so adding a
  field to a document can never widen what is returned
- `senderType`, `staffUserId`, `customerUid` and all timestamps are set
  from verified inputs, never from a request body
- the invariants Postgres used to enforce (length caps, the
  staff-author rule, status transitions) are enforced in code **and
  covered by tests**, because tests are now the only thing enforcing them

## 6. Ownership model

`chatConversations.customerUid` is the Firebase Anonymous UID that owns
the conversation. It is written once by the server after verifying the
customer's Firebase ID token, and it is the sole basis of every customer
read permission.

A conversation id is **not** a credential. It is an ordinary identifier;
knowing one grants nothing. Ownership is proved by the Firebase session,
which the page cannot forge.

## 7. Append-only transcript

`chatMessages` has no client write permission of any kind, so a browser
cannot add to, edit or delete the record. Later phases must keep it that
way: there is to be no endpoint that edits a message, deletes a single
message, changes a sender, or alters a timestamp. Retracting a message
would be a product decision needing its own field and its own review —
never a silent edit.

## 8. The staff allow-list

A document at `staff/{firebaseUid}` with `email`, `displayName`,
`isActive` and `role`. Two exist today, for `manager@esthers.ca` and
`counter@esthers.ca`.

Being authenticated is not being staff. The API will require an active
row, and will compare `isActive === true` strictly — a truthy test would
admit a future `"false"` string or `0`.

**No `@esthers.ca` domain rule, ever.** A domain check would admit every
future mailbox and keep admitting someone after they leave. Offboarding
is `isActive: false`, which takes effect on the next request and keeps
their message history intact.

## 9. Secret handling

Safe to publish: the Firebase **web config** (`apiKey`, `authDomain`,
`projectId`) and the staff UIDs. The web config is an identifier, not a
secret — and with these rules it unlocks nothing, because every chat
collection denies client access.

Never in the repository, a browser file, a log, or a response: the
service-account private key, or any `sb_secret`-style credential. It
belongs in the Vercel environment and the Firebase console, nowhere else.

`.gitignore` blocks `.env*`, `*firebase-adminsdk*.json`,
`*service-account*.json`, `*service_account*.json`, the emulator debug
logs and `.firebaserc`.

> **If a private key is ever committed, it is compromised.** Rotate the
> service account in the Firebase console immediately. Deleting the file,
> amending the commit or rewriting history does not undo it.

## 10. Running the rules tests

```
npm install
npm run test:firestore-rules
```

Requires Java (the Firestore emulator is a JAR) and downloads the
emulator on first run. It uses project id `demo-esthers-rules` — the
`demo-` prefix makes the Firebase tooling refuse to reach any live
backend, so the suite **cannot** touch `esther-s-chat`. No production
credentials and no service-account key are involved.

The suite seeds data with rules disabled (as the Admin SDK will) and then
proves what each caller can and cannot do: unauthenticated, two separate
anonymous customers, and an Email/Password user standing in for staff.

## 11. Indexes

Two composite indexes, both required, neither speculative:

| Collection | Fields | Serves |
|---|---|---|
| `chatMessages` | `conversationId` ASC, `createdAt` ASC | the customer's realtime transcript |
| `chatConversations` | `status` ASC, `lastMessageAt` DESC | the staff inbox |

Firestore creates single-field indexes automatically, but an equality
filter on one field combined with an `orderBy` on a *different* field
needs a composite index. Both queries have exactly that shape.

## 12. What the rules cost

`ownsConversation()` performs a `get()` on the conversation. That is an
access call: billed as a document read, and counted against the
per-request access-call limit.

Access calls are **cached per request by path**. Every message in one
properly-scoped query resolves the same conversation, so the query
performs **one** dependent read, not one per message. This is proved
empirically with a 60-document query — comfortably past the documented
limit — in the test suite.

**Budget:** a customer transcript read costs `N` message reads **plus 1**
conversation read.

## 13. Reminders

- **Do not merge `claude/materials-color-configurator-yri05u`.** It holds
  the abandoned Supabase design and is eleven commits behind `main`;
  merging it would revert live site content. Read it for reference only.
- **Nothing here deploys to Firebase automatically.** There is no
  `.firebaserc`, so `firebase deploy` has no project to target until
  someone deliberately provides one. Rules and indexes go live only by an
  explicit, separately authorised step.
- The obsolete custom bearer-token design is gone. Customer identity is
  `request.auth.uid` from Firebase Anonymous Auth.
