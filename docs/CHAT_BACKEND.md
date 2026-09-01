# Esther's messaging system — how the backend works

This is the plain-English guide to the customer messaging system: what the
pieces are, what protects them, and what still has to be done by hand.

**Nothing in this document is live yet.** Phase 2A is code and design only.
No migration has been applied to the real Supabase project, no function has
been deployed, and the mascot chat on the website is still the local demo
that sends nothing to anybody.

---

## The shape of it

```
    CUSTOMER on esthers.ca
            |
            |  (Phase 2B will connect this. It is NOT connected today.)
            v
    EDGE FUNCTIONS          chat-start / chat-send / chat-read
    small programs that     staff-conversations / staff-actions
    run on Supabase
            |
            v
    POSTGRES DATABASE       chat_conversations
                            chat_messages
                            staff_profiles
                            ^
                            |
    ESTHER'S STAFF  ------->|   signed in through Supabase Auth
    staff/index.html            + an active staff_profiles row
```

### The one rule

**No browser session has direct write access to any chat table. None. Not
even an active staff member's.**

| Who | Reads | Writes |
| --- | --- | --- |
| Customer | Edge Function only | Edge Function only |
| Staff | Data API, with their own JWT, under RLS | **`staff-actions` Edge Function only** |

The customer's browser never touches the database at all. It asks an Edge
Function, and the Edge Function talks to the database. That removes a whole
category of problem — there is no public database role for an attacker to
abuse, because the public has no database role at all.

Staff are allowed to **read** directly, because they have real accounts and
Row Level Security can be written for them. They cannot **write** directly.
Replying, closing, reopening and marking-as-read all go through
`staff-actions`, which verifies the JWT and confirms active membership
before it touches anything.

Why not just grant staff a careful, policy-guarded write? Because then the
rules live in two places. The policy would have to restate, in SQL, every
invariant `staff-actions` already enforces — that `sender_type` is `staff`,
that the author is the caller, that a closed conversation is read-only, that
`closed_at` follows `status`. Two copies of one rule drift apart, and the day
they do, the weaker copy is the one that decides. So there is one write path,
and it is the one with the checks in it.

An earlier draft of the migration did grant `INSERT` on `chat_messages` and
`UPDATE` on `chat_conversations` to signed-in staff. That was a second write
path into the same rows and it has been removed. There is a test that fails
if it ever comes back.

---

## The tables

### `chat_conversations` — one row per conversation

| Column | What it is |
| --- | --- |
| `id` | The conversation's identifier. **Not a password** — see the token section. |
| `status` | `open` or `closed`. Just those two, on purpose. |
| `customer_name` / `customer_email` / `customer_phone` | All optional. A visitor can ask a question without giving any of them. |
| `customer_token_hash` | A scrambled fingerprint of the customer's private key. **The real key is never stored.** |
| `last_message_at` | Used to sort the inbox. Updated automatically. |
| `staff_last_read_at` | When someone at Esther's last looked. Drives the unread dot. |
| `customer_last_read_at` | The same, for the customer. |
| `created_at` / `updated_at` / `closed_at` | Timestamps, all maintained by the database. |

### `chat_messages` — the transcript

| Column | What it is |
| --- | --- |
| `conversation_id` | Which conversation it belongs to. |
| `sender_type` | `customer`, `staff` or `system`. |
| `body` | The text. Must not be empty, must be 4000 characters or fewer. |
| `staff_user_id` | Which staff member wrote it. Empty for customer and system messages. |

**This table is append-only.** There is no policy anywhere that lets any
staff member edit or delete a message. That is deliberate: the transcript is
a record of what was actually said, and the people it might embarrass are
exactly the people who must not be able to quietly change it.

### `staff_profiles` — who is allowed in

| Column | What it is |
| --- | --- |
| `user_id` | Points at a Supabase Auth account. |
| `display_name` | The name shown on replies. |
| `is_active` | Turn access off without deleting anyone's history. |

**Having a Supabase account is not the same as being staff.** Access needs an
active row here, and no client can create or change one.

### `chat_rate_limits` — internal counters

Plumbing for the abuse limits. No customer or staff role can read or write
it. It stores a *hash* of the visitor's IP, never the IP itself.

---

## The customer's private key ("token")

This is the heart of the customer-side security, so it is worth being clear
about.

A customer has no account and no password. When they start a conversation,
the server mints a long random key — 32 random bytes, from the operating
system's cryptographic generator — and hands it to their browser **once**.
Whoever holds that key can read and write that one conversation.

The database **never stores the key**. It stores a SHA-256 hash: a one-way
fingerprint. You can check a key against a fingerprint, but you cannot work
backwards from the fingerprint to the key.

Why that matters: if the database were ever copied — a leak, a bad backup, a
misconfigured tool — the thief would hold a list of fingerprints and could
not read a single conversation with them.

**The conversation `id` on its own is worthless.** Guessing an id gets you
nothing; every request must present the matching key. Getting the key wrong
and naming a conversation that does not exist produce byte-for-byte the same
answer, so the endpoint cannot be used to discover which ids are real.

The trade: **if the customer loses the key, the conversation is gone to
them.** There is no recovery, because a recovery path would be a way in for
somebody else. They start a new conversation instead.

---

## What each Edge Function does

| Function | Who calls it | What it does |
| --- | --- | --- |
| `chat-start` | Website visitor | Creates a conversation and returns the private key **once**. |
| `chat-send` | Website visitor | Checks the key, then adds their message. |
| `chat-read` | Website visitor | Checks the key, then returns that conversation's messages and nothing else. |
| `staff-conversations` | Signed-in staff | Lists conversations, opens one. **Read only.** |
| `staff-actions` | Signed-in staff | Reply, mark as read, close or reopen. |

The staff side is split in two on purpose: everything that can *change*
something lives in one small file, so a security review only has to read
that file closely.

Things no function will do, at any price:

- edit or delete a message
- let staff post as a customer, or as a different colleague
- change a conversation's private key
- tell an unauthorised caller whether a conversation exists

---

## Row Level Security, in one page

Row Level Security is a rule the database itself enforces on every query. It
does not matter how the query arrives; the rule still applies.

Two things have to line up before anyone can do anything:

1. a **GRANT** — permission to touch the table at all
2. a **POLICY** — permission to touch *those particular rows*

Missing either one means no access.

**`anon` (the general public): nothing.** Every privilege is revoked. There
is no policy for anon on any chat table. A stranger with the publishable key
and a copy of the website can do exactly nothing to these tables. This is
tested.

**`authenticated` (someone signed in): `SELECT` and nothing else.** Even
that yields nothing without `is_active_staff()` being true.

| Table | Signed-in active staff may | Nobody with a browser session may |
| --- | --- | --- |
| `chat_conversations` | **read** | insert, update or delete — anything |
| `chat_messages` | **read** | insert, update or delete — anything |
| `staff_profiles` | **read their own row** | insert, update or delete — anything |
| `chat_rate_limits` | nothing | anything |

That is the complete list. There is no `INSERT`, no `UPDATE`, no `DELETE`
grant and no non-`SELECT` policy for any browser role on any chat table.
The test suite reads this straight out of the database catalog and fails if
a future migration widens it.

`customer_token_hash` is protected three times over: staff have no write
grant at all, there is no update policy, and a database trigger refuses any
change to it even from `service_role`.

**`service_role` (the Edge Functions):** full access, bypasses all of the
above. That is why the secret key must never leave the server.

---

## The two read markers

Two columns, two owners, and neither side may touch the other's.

| Column | Owned by | Written by | Never written by |
| --- | --- | --- | --- |
| `staff_last_read_at` | the staff side | `staff-actions`, on `mark-read` and after a reply | the customer path |
| `customer_last_read_at` | the customer side | `chat-read`, after a request that presented the correct conversation token | staff, by any route |

`customer_last_read_at` is **implemented**, not reserved: `chat-read`
updates it server-side on every successful token-authenticated read, as a
best-effort write that never fails the read itself.

An earlier draft let staff update it, as part of a column grant. That was
wrong — a staff member marking a customer's own thread as "read by the
customer" writes a small lie into the record. Staff now have no way to move
it: no grant, no policy, and `staff-actions` never names the column. There
is a test for each of those.

---

## Which keys are public and which are secret

| Key | Where it goes | If it leaks |
| --- | --- | --- |
| `sb_publishable_...` (publishable / "anon") | Browser. `staff/config.js`. Fine to be visible. | Not a problem. It grants nothing on its own. |
| `sb_secret_...` (secret / "service_role") | **Server only.** Edge Function environment. | **Emergency.** Full read/write to every conversation. Rotate immediately. |
| Database password | Never in this repo. | Emergency. Rotate immediately. |
| Supabase access / refresh tokens | Never in this repo. | Emergency. Rotate immediately. |

Rules that are not negotiable:

- The secret key is never in `index.html`, `assets/`, `staff/config.js`, a
  commit, a log line, an error message, or a bundled artifact.
- `supabase/.env` and `staff/config.js` are gitignored. The `.example`
  versions, with placeholders, are the tracked ones.
- If a secret is ever committed, **rotate it**. Deleting the file or
  rewriting the commit does not un-leak it.

---

## Abuse limits

Counters live in Postgres, keyed by a hash of the caller's IP or by the
conversation, in fixed time windows.

| Endpoint | Limit |
| --- | --- |
| `chat-start` | 5 new conversations per IP per 10 minutes |
| `chat-send` | 40 messages per IP per 5 minutes, and 20 per conversation per 5 minutes |
| `chat-read` | 120 requests per IP per 5 minutes |
| every endpoint | request body capped at 16 KB, message capped at 4000 characters |

Honest limitations, stated plainly:

- **The IP comes from a header** (`x-forwarded-for`) set by Supabase's edge.
  It is good enough to stop casual scripted abuse. It is not a defence
  against someone determined and well-resourced, and it is not claimed to be.
- **Fixed windows, not sliding.** Someone can spend their allowance at the
  end of one window and again at the start of the next.
- **Nothing is enforced in the browser**, because anything enforced in the
  browser can be turned off by the person being limited.
- If Esther's ever needs real protection here, that is a WAF or Cloudflare
  Turnstile in front of the functions — a Phase 3 decision, not something to
  fake now.

---

## How staff get access

There is no shared password anywhere, and no password handling in this
repo's code. Supabase Auth does all of it.

Adding a staff member — **all of this is manual and none of it has been
done**:

1. In the Supabase dashboard, **Authentication → Users → Add user**, create
   their account. Self-signup is disabled in `config.toml`, so this is the
   only way an account comes into existence.
2. Copy the new user's **UUID**.
3. In the **SQL Editor**, add their membership row:

   ```sql
   insert into public.staff_profiles (user_id, display_name, is_active)
   values ('PASTE-THE-USER-UUID-HERE', 'Their Name', true);
   ```

4. They can now sign in at `staff/index.html`.

Removing access:

```sql
update public.staff_profiles set is_active = false
 where user_id = 'PASTE-THE-USER-UUID-HERE';
```

That takes effect on their next request. Their past replies stay in the
transcript, which is what you want — the history should not develop holes
when somebody leaves.

Note what is *not* used: email domains. A rule like "anyone @esthers.ca is
staff" looks convenient and is a bad idea — it says nothing about whether
someone should still have access after they leave, and in some setups the
address can be influenced by the user.

---

## Working on it locally

You need Docker running and the Supabase CLI installed.

```bash
supabase start          # local Postgres + Auth + Studio
supabase db reset       # apply the migrations to the LOCAL database
supabase functions serve
```

Then copy the two example files and fill them in:

```bash
cp supabase/.env.example supabase/.env
cp staff/config.example.js staff/config.js
```

Running the security tests needs no Docker and no Supabase at all — just the
PostgreSQL server binaries:

```bash
./supabase/tests/run_tests.sh                                        # policies and grants
node --experimental-strip-types supabase/tests/unit_test.ts          # token and validation
node --experimental-strip-types supabase/tests/staff_policy_test.ts  # staff authorization
```

The first script builds a throwaway database, applies a small stand-in for
the parts of Supabase the migrations depend on, applies both real
migrations, and runs every access-control assertion. It never touches the
real project.

**What these suites do NOT cover.** `staff_policy_test.ts` executes the real
authorization decision, but its checks on `staff-actions` itself are *static
analysis of the source text* — they prove the file never reads `sender_type`
or `staff_user_id` from the request body, never updates or deletes a
message, and always calls `requireActiveStaff` first. They do not run the
function.

Running an Edge Function end to end needs Deno plus a live Supabase stack
for `auth.getUser()` and the Data API. That has **not** been done. Before
deploying, run this against a local `supabase start`:

| Case | Expected |
| --- | --- |
| active staff JWT, reply | 201, message stored, author = that staff id |
| non-staff JWT | 403, nothing written |
| inactive staff JWT | 403, nothing written |
| no JWT | 401 |
| body naming another `staff_user_id` | ignored; author is the caller |
| body naming `sender_type: 'customer'` | ignored; stored as `staff` |
| reply to a closed conversation | 409, nothing written |

---

## Phase 2B — connecting the website

Not done, and deliberately not started. When it happens:

1. Add Esther's real origin to `ALLOWED_ORIGINS` in
   `supabase/functions/_shared/cors.ts`.
2. In `assets/js/chat.js`, replace the demo reply with real calls to
   `chat-start`, `chat-send` and `chat-read`.
3. Keep the private key in `sessionStorage` so a page reload does not lose
   the conversation. **Never in a cookie**, and never in the URL — URLs end
   up in server logs, `Referer` headers and browser history.
4. Remove the "Preview only" notice, and only then.
5. Decide how staff learn a message arrived. Polling every few seconds is
   the simple answer; Supabase Realtime is the better one, and needs its own
   security review because it is a different access path.

Until every one of those is done, the mascot chat stays exactly as it is: a
local demo that sends nothing and says so.

---

## Going live — the manual checklist

None of this has been done. Each step is deliberate and needs authorising.

1. `supabase link` to the **Esther's Chat** project.
2. `supabase db push` to apply the two migrations.
3. `supabase functions deploy` for all five functions.
4. Set `SUPABASE_SECRET_KEY` in the dashboard's function settings — never in
   a file in this repository.
5. Confirm **self-signup is disabled** in Auth settings.
6. Create the real staff accounts and their `staff_profiles` rows.
7. Add the production origin to the CORS allowlist.
8. Re-run the security tests against the deployed project before any real
   customer can reach it.
9. Decide how long conversations are kept. There is no retention policy yet,
   and personal contact details should not be kept forever by default.

---

## Known gaps, stated rather than hidden

These are real and are not solved by anything in Phase 2A:

- **No file attachments.** Customers will want to send a photo or a drawing.
  That needs Supabase Storage and its own access rules.
- **No notification to staff.** Nothing emails or texts anyone when a
  message arrives. Somebody has to open the inbox.
- **No retention or deletion policy.** Conversations accumulate forever, with
  whatever contact details customers typed. This needs a decision.
- **No spam filtering.** The rate limits blunt volume; they do not judge
  content.
- **The customer's key lives in one browser.** Clear the site data and the
  conversation is unreachable. That is the cost of having no accounts.
- **IP rate limiting rests on a header.** See the limitations above.
