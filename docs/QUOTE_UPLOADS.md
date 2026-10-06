# Quote request uploads

How a customer's photos and drawings reach Esther's, what is stored, for how
long, and what an owner has to do to switch it on.

---

## Why this was rebuilt

The first working version put the customer's files **inside** the quote
request, base64-encoded into the JSON body. That worked, and it had a hard
ceiling nobody chose: a Vercel Function's request body is capped at **4.5 MB**,
and base64 makes binary a third bigger. The practical limit was about **3 MB** —
less than two photos from a modern phone. Customers were being asked to shrink
their own files before they could ask for a price.

Files now go **straight from the browser to private storage**, and the quote
request carries only pathnames. Measured in the tests: a 10 MB photo produced a
quote request of **1,043 bytes**. The old ceiling no longer applies to anything
a customer sends.

---

## The shape of it

```
   Customer's browser
        |
        |  1. "here is what I want to send"  (names and sizes only)
        v
   /api/upload-token          checks the list, then asks storage for
        |                     one narrowly-scoped upload URL per file
        |  2. presigned PUT URLs
        v
   Customer's browser
        |
        |  3. uploads each file DIRECTLY   <-- the bytes never touch our server
        v
   PRIVATE Vercel Blob storage
        |
        |  4. pathnames only
        v
   /api/quote                 verifies every file really exists, checks its
        |                     size and its actual bytes, then signs a
        |                     time-limited download link for each
        v
   Resend  ->  counter@esthers.ca
```

**Nothing is sent until every file has uploaded.** If one of five fails, the
quote does not go at all — the customer is told which file failed and can
retry. A partly-uploaded set must never become an email claiming everything
arrived.

---

## Limits

| | |
| --- | --- |
| Files per request | **5** |
| Each file | **25 MB** |
| All files together | **75 MB** |

Shown to the customer as "Up to 5 files, 25 MB each" under the upload control.

Accepted types: PDF, JPG, PNG, HEIC, WebP, DWG, DXF, DOC, DOCX.

These are enforced in `api/_lib.js`, which both endpoints share, and mirrored
in the browser only so an oversized file is refused instantly instead of after
a long upload. **The browser's copy is a courtesy, not a control.**

---

## What stops this being abused

A public upload endpoint is an invitation, so:

- **The upload URL is scoped, not general.** Each one is tied to a single
  pathname *we* choose, a single operation (`put`), a content type allowlist,
  a **30-minute expiry**, and a maximum size equal to **that file's own
  declared size** — not the 25 MB per-file cap. A URL handed out for a 3 MB
  photo cannot be spent on a 25 MB file, let alone a 2 GB one, cannot
  overwrite anything, and stops working within the half hour.
- **Declared sizes are validated before they become ceilings.**
  `checkManifest()` in `api/_lib.js` is the gate: each size must be a whole,
  positive number of bytes (a real JSON number — strings, fractions, NaN and
  Infinity are refused, never coerced), no more than 25 MB, and all of them
  together no more than 75 MB. Only then is each size used as that file's
  upload ceiling, in both the signed token and the presigned URL, so the
  permissions from one manifest can never add up to more than 75 MB. (Before
  this, five understated files each got a 25 MB permission — 125 MB in all.)
  The browser reports `File.size` exactly and uploads the raw file, so an
  honest upload always fits.
- **The browser never receives `BLOB_READ_WRITE_TOKEN`**, or anything that
  could be reused as one.
- **The customer cannot choose where a file goes.** They send a filename; we
  decide the path. `../../../etc/passwd.jpg` becomes `passwd.jpg` inside our
  own namespace.
- **Pathnames coming back are checked against a pattern** before anything is
  emailed, so a caller cannot name some other object in the store and have a
  signed link to it sent out.
- **The bytes are checked, not the name.** After upload, `/api/quote` reads the
  first 512 bytes of each file back through a signed URL and confirms the file
  really is what its extension claims. A Windows executable renamed `.jpg`
  uploads fine and is then refused — the quote does not send.

- **Both endpoints are rate limited per address** (`api/_quote-limit.js`).
  Without this, anybody could POST `/api/quote` in a loop and send email
  through the Resend account until the inbox flooded and the sending quota ran
  out. Limits, per address, burst and hourly windows consumed together
  (all or nothing):

  | | burst | hourly |
  | --- | --- | --- |
  | quote emails | **2 per 5 minutes** | **4 per hour** |
  | upload permissions | **4 per 5 minutes** | **10 per hour** |

  (Until October 2026 this was 10 quotes / 20 uploads per hour with no burst
  window; see *Automated spam* below for why that was not enough.)

  **Only well-formed, verified requests count.** The limit is checked *after*
  the cheap validation — for a quote: the body, name, email, text, file
  count, and each file's path shape and type; for uploads: the whole manifest
  via `checkManifest()` — and *after* the bot checks and Turnstile
  verification, so neither garbage nor unverified requests from the same
  address can use up a real customer's allowance. It is checked *before* anything expensive:
  the Blob lookups and signature reads, issuing upload permissions, and the
  email itself. Over the limit the customer gets
  a 429 and a plain sentence asking them to wait or email/phone instead; the
  form already shows it. `GET /api/quote` (the readiness probe) is never
  limited.

  There are two layers. An **in-memory** counter is always on and needs no
  setup, but each server instance keeps its own, so on its own it only stops
  the simple case. The **shared** counter reuses the chat system's Firestore
  limiter (`api/_chat/rate-limit.js`, scopes `quote_burst_ip` + `quote_ip`,
  `upload_burst_ip` + `upload_ip`, via `consumeMany()` in one transaction) and
  holds across instances — it switches on by itself once the chat environment
  variables below are set. Unlike chat, the quote limiter **fails open**: if
  Firestore is unconfigured or erroring, the request goes through (the
  in-memory layer still applies) and a reason token is logged. Losing a real
  customer's quote is the worse failure. No raw address is stored or logged
  in either layer.

  **The in-memory layer is only partial protection.** Vercel runs several
  instances and routes requests between them, so a caller spread across
  instances gets several allowances. **G1 is not closed in production** until
  all three of these are done:

  1. the production Firestore security rules are deployed to `esther-s-chat`;
  2. `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` and
     `CHAT_RATE_LIMIT_SECRET` are set in Vercel;
  3. the shared Firestore quote limiter is verified working in production —
     e.g. a `chatRateLimits/quote_ip_*` document appears after a real quote,
     and no `quote-limit: shared limiter unavailable` lines are in the logs.

  Until then, deploying this code gives the in-memory layer only.

The one thing this deliberately does *not* do is make customers create
accounts, or track them.

---

## Automated spam — Turnstile, bot signals and duplicate suppression

### What happened, and why rate limiting alone was not enough

In October 2026 the live form sent several quote emails within minutes, from
generated-looking names, some repeated. Every one was a *valid* request, so
validation could not refuse it, and the per-address limit (10 an hour) still
let a bot send several in a burst. An address limit also does nothing against
a bot that rotates addresses. Nothing asked whether a **human, in a browser,
on our page** made the request.

### Threat model

| Attacker | Stopped by |
| --- | --- |
| Script POSTing straight to `/api/quote` or `/api/upload-token` | **Turnstile** (no valid token, no email / no upload permission) |
| Headless browser driving our page | Turnstile's Managed challenge; then rate limits |
| Bot rotating IP addresses | Turnstile (each token is a fresh, single-use challenge) |
| Replaying a captured token | Turnstile single-use (`timeout-or-duplicate`) + 5-minute life |
| Using an upload token to send a quote | Action binding (`quote_upload` ≠ `quote_submit`) |
| Token minted on another site | Hostname check against `TURNSTILE_ALLOWED_HOSTNAMES` |
| Re-submitting the same quote repeatedly | Duplicate suppression (30 minutes) |
| Naive form-filling bot | Honeypot + minimum form age (supplemental) |
| Cross-site browser POST | Origin check (a filter only; scripts forge headers) |
| A paid human solving challenges | Not stoppable by any of this; bounded by rate limits |

### The order the server applies them

`/api/quote` (POST):

1. method → **Origin** (cross-site browser POST → 403)
2. mailbox configured, **Turnstile configured** (else 503 `notConfigured` →
   the form falls back to the visitor's email app)
3. parse and validate name, email, text, file count, each file's path and type
4. **form signals** — honeypot empty, form stamp valid and ≥ 3 s old
5. **Turnstile** — `quote_submit` token verified with Cloudflare Siteverify
6. **rate limit** — burst + hourly together
7. Blob existence / size / signature checks, signed download links
8. **duplicate reservation** (immediately before sending)
9. Resend — on failure the reservation is *released*; on success *confirmed*

`/api/upload-token` (POST): method → Origin → Blob configured → Turnstile
configured → parse → manifest (`checkManifest`) → form signals → Turnstile
(`quote_upload` token) → rate limit → exact per-file upload permissions
(unchanged: each ceiling is that file's validated declared size).

Steps 4–5 run before the limiter, so nothing unverified spends anyone's
allowance. Every refusal at steps 1, 4 and 5 gives the *same* customer
message — "We couldn't verify this request. Please try again, or contact
the shop directly." — so the response never says which rule fired. (A rate
limit and a duplicate each get their own honest message, because the
customer needs to know to wait, or that the request already arrived.)

### Cloudflare Turnstile

- **Widget:** Managed mode (Cloudflare decides; most visitors see nothing, a
  doubtful one gets a single checkbox — no puzzles), rendered with
  `appearance: interaction-only` and `execution: execute`, so the challenge
  runs when Send is pressed and a box appears only if needed. Cloudflare
  states that "Turnstile is WCAG 2.2 AA compliant" (Turnstile docs overview,
  checked October 2026).
- **Script:** `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
  — the site's only third-party script. It is loaded **only on the quote
  page**, **only when** the readiness probe says server sending is available,
  and **only once the visitor focuses the form**. No other page loads it. The
  site has no Content-Security-Policy today; if one is added it needs
  `script-src` and `frame-src https://challenges.cloudflare.com`.
- **Token lifecycle:** every token is single-use and expires after 300 s. The
  browser renders a fresh widget per request and removes it afterwards:
  - with attachments: token A (`quote_upload`) → `/api/upload-token` (verified,
    spent) → files uploaded → token B (`quote_submit`) → `/api/quote`;
  - without attachments: token B only.
  No token is ever sent twice. A retry after any failure gets new tokens.
- **Server verification** (`api/_quote-guard.js` `verifyTurnstile`): POST to
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`,
  `response`, `remoteip` (the visitor's IP is sent to Cloudflare, as Cloudflare
  recommends; it is not stored by us) and an `idempotency_key`. Token must be
  1–2048 printable characters or Cloudflare is not asked. 5-second timeout,
  one retry with the same idempotency key on a network error or 5xx. Success
  requires `success === true`, the expected `action`, an allowed `hostname`,
  and a `challenge_ts` no older than 330 s.
- **Fails closed.** Siteverify unreachable, timing out, 5xx, malformed JSON,
  `internal-error` or `bad-request` → 503 and **no email, no upload
  permission**. An outage stops server-sent quotes; the page still offers both
  shop phone numbers and "Copy as text". A rejected secret is treated as
  *not configured* (mail-app fallback), never as success.
- **Dummy keys** (`1x000…AA` and friends) pass unconditionally, so the server
  **refuses them when `VERCEL_ENV=production`** — readiness reports not ready
  and nothing is sent. Outside production they work, and action/hostname are
  not checked with a dummy secret (Cloudflare's test service does not echo
  them reliably).

### Supplemental bot signals (never the boundary)

- **Honeypot** `q_hp_ref`: off-screen (not `display:none`), `tabindex="-1"`,
  `aria-hidden`, `autocomplete="off"`, a name no autofill profile matches.
  Anything other than empty → refused. Absent → fine (a direct caller simply
  has no such field — Turnstile is what stops it).
- **Form stamp:** `GET /api/quote` returns `formStamp` =
  `<issue time, base36 ms>.<HMAC>`, keyed from `CHAT_RATE_LIMIT_SECRET` with a
  fixed label. A POST must carry a valid stamp at least **3 seconds** old
  (and not more than 60 s in the future). There is no upper age limit. If the
  secret is not configured the stamp is skipped (logged as a reason) —
  Turnstile is still required.

A script can read this file and forge both. They exist to make naive bots
cost something, at no cost to people.

### Duplicate suppression

- **Fingerprint:** HMAC-SHA-256 (key derived from `CHAT_RATE_LIMIT_SECRET`,
  label `esthers-quote-guard-v1`) over: name, email, request text and the
  sorted attachment **file names**. Normalisation: text fields are Unicode
  NFKC, lower-cased, whitespace runs collapsed to one space, trimmed; email is
  trimmed and lower-cased; storage paths (new on every upload) are ignored.
  First 40 hex characters are the id.
- **Window:** a request already emailed is not emailed again for **30
  minutes** — 409 with "We already received this exact request…", and the
  form is not marked sent. One still in flight blocks a copy for at most **2
  minutes** (so a crashed attempt never blocks for long). A *changed* request
  (different text, an added file, a different email) is a new request and
  goes immediately. A failed send releases its reservation at once.
- **Storage:** Firestore collection `quoteDuplicates`, document id = the
  fingerprint, fields `status` (`pending`/`sent`), `at` (ms) and `expireAt`
  (Date, for an optional TTL policy). Nothing else: no text, name or email.
  Reserved in a **transaction**, so two copies arriving together cannot both
  send. If Firestore is unconfigured or failing, a per-instance in-memory copy
  of the same logic still applies and `duplicate_store_unavailable` is logged.

### Logging

Refusals log exactly `quote-guard: <quote|upload> refused: <reason>`, with the
reason from an allow-list in `_quote-guard.js` (`honeypot`, `too_fast`,
`turnstile_rejected`, `duplicate`, …). Never logged: the IP, the Turnstile
token, any secret, the quote text, the customer's name or email. A Resend
failure logs its HTTP status and the provider's error **name** only (its
message can echo an address).

### Environment variables (names only — values live in Vercel)

| Name | Required | Notes |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | yes | public; served to the browser by `GET /api/quote` |
| `TURNSTILE_SECRET_KEY` | yes | **secret**; Vercel only |
| `TURNSTILE_ALLOWED_HOSTNAMES` | no | default `esthers.ca,www.esthers.ca` |
| `CHAT_RATE_LIMIT_SECRET` | already set | form stamp + duplicate key + limiter |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | already set | shared limiter + shared duplicate store |

**No-secret rules:** the secret key never goes in the repository, `.env.example`
(placeholders only), a commit message, a ticket, a chat, a screenshot or a
log. If it is ever exposed, rotate it in the Cloudflare dashboard and update
Vercel — deleting the commit does not un-expose it.

### Rollout (owner actions — in this order)

1. **Cloudflare dashboard → Turnstile → Add widget.** Name "Esther's quote
   form"; hostnames `esthers.ca`, `www.esthers.ca`; Widget Mode **Managed**;
   pre-clearance **off**. Copy the site key and the secret key.
2. **Vercel → Settings → Environment Variables, Production:** add
   `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. (Preview, optional: the
   dummy pair `1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`
   to exercise the flow on a `*.vercel.app` preview; a dummy key is refused in
   Production by design.)
3. Merge this branch after review and let Vercel deploy. **Order matters:** if
   the code deploys before the keys exist, the form safely falls back to the
   visitor's email app and the server sends nothing — which also stops the
   spam immediately, but customers lose server-sent uploads until step 2.
4. **Verify in production:**
   - `GET https://www.esthers.ca/api/quote` → `ready: true`,
     `turnstileSiteKey` = the public key, a `formStamp`;
   - send one real quote from a phone and one from a desktop — expect one
     email each, and no visible challenge for most visitors;
   - send the identical request again within 30 minutes → the "already
     received" message, no second email;
   - `curl -X POST https://www.esthers.ca/api/quote -H 'content-type: application/json' -d '{"name":"Bot","email":"b@x.yz","text":"x"}'`
     → 403, generic message, no email;
   - Vercel logs: `quote-guard: … refused: …` lines with reasons only;
   - Cloudflare Turnstile analytics show solves for the widget.
5. Optional: a Firestore TTL policy on `quoteDuplicates.expireAt` (Firebase
   console) to clean old fingerprints. Not required for correctness.

### Rollback

- **Fast, no code change:** none that is safe. Removing the Turnstile keys
  does *not* reopen the old path; it makes the form fall back to the
  visitor's email app (server sends nothing). That is the safe degraded mode
  if Turnstile itself misbehaves for customers.
- **Full:** revert the merge commit on `main` and redeploy. That restores the
  previous behaviour (no Turnstile, 10/20 hourly limits) — and the spam.
- Never roll back by deleting Firestore data.

### Testing

`npm run test:quote-api` (no emulator, no network) covers: valid / missing /
malformed / rejected / replayed / wrong-action / wrong-hostname / stale
tokens; Siteverify network failure, retry, 5xx, malformed JSON,
`internal-error`, `bad-request`, rejected secret; dummy keys refused in
production; token and secret never logged or returned; burst, hourly,
rollover, all-or-nothing, shared-across-instances limits; honeypot, form age,
forged stamps, omission; origin; exact / normalised / distinct duplicates,
window expiry, release on failure, stale pending, concurrent reservations;
upload permissions only after verification; existing size/type/path checks.

---

## Storage layout

```
quotes/YYYY/MM/<32 random hex characters>/<n>-<safe filename>
```

The date makes cleanup by age a matter of listing a prefix. The random id
means paths cannot be guessed or enumerated.

**No customer name or email ever appears in a path.** A storage key can end up
in logs, in a URL, in a support ticket; the customer's identity belongs in the
email, not there.

---

## Privacy

Files are stored **private**. A quote can carry photographs of somebody's
house, their measurements, their drawings.

- No permanent public URL is ever emailed.
- Links in the quote email are **signed and expire after 7 days**.
- Without a valid signature the object is refused — tested, along with a
  tampered signature and an expired link.

---

## Retention — and the cleanup you have to do

**Policy: uploads become eligible for deletion 30 days after upload.**

There is **no automatic deletion job**, on purpose. A cron that deletes
customer files is exactly the kind of thing that is quietly wrong for months
and then removes something that mattered. The paths are laid out so it can be
added safely later, and until then this is a manual job.

To clean up, from a machine with the store's token in its environment:

```js
// npm install @vercel/blob, then run with node
import { list, del } from '@vercel/blob';

const CUTOFF = Date.now() - 30 * 24 * 60 * 60 * 1000;
let cursor, doomed = [];

do {
  // The prefix is the safety rail: nothing outside quotes/ is even listed.
  const page = await list({ prefix: 'quotes/', cursor, limit: 1000 });
  for (const b of page.blobs) {
    if (new Date(b.uploadedAt).getTime() < CUTOFF) doomed.push(b.pathname);
  }
  cursor = page.cursor;
} while (cursor);

console.log(doomed.length + ' files older than 30 days:');
doomed.forEach(p => console.log('  ' + p));

// Read that list. Only then uncomment:
// await del(doomed);
```

Two rules if you ever automate it: keep the `prefix: 'quotes/'`, and keep the
age check. Either one alone is not enough.

---

## Orphaned uploads

If the files upload but the email then fails, the files are already in
storage and no quote arrived. They are **left in place** rather than deleted,
because the customer will usually press Send again and it is better to waste a
few megabytes than to delete something during a failure you do not yet
understand.

They are ordinary `quotes/…` objects, so the 30-day cleanup above collects
them with everything else. Nothing extra to do.

---

## Environment variables

| Name | What it does |
| --- | --- |
| `RESEND_API_KEY` | Sends the email. Missing → the form falls back to the old email-app behaviour. |
| `QUOTE_TO` | Comma-separated recipients. **This is the recipient setting** — there is no other. |
| `QUOTE_FROM` | Optional sender. Unset uses the provider's test address, which needs no DNS changes. |
| `BLOB_READ_WRITE_TOKEN` | Created automatically by Vercel when a Blob store is connected. Never set by hand, never in the repository. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | **Required for server sending.** Missing (or a dummy key in Production) → the form falls back to the email-app behaviour and the server sends nothing. See *Automated spam* above. |
| `TURNSTILE_ALLOWED_HOSTNAMES` | Optional. Default `esthers.ca,www.esthers.ca`. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `CHAT_RATE_LIMIT_SECRET` | They belong to the chat system (see `CHAT_API.md`). When all four are set, the quote rate limit and duplicate store are shared across server instances; unset, they run per instance only. `CHAT_RATE_LIMIT_SECRET` also signs the form stamp. |

`GET /api/quote` reports readiness — `ready` (mailbox **and** Turnstile),
`uploads` (storage) — plus two public values the form needs: the Turnstile
**site** key and a signed `formStamp`. Never a secret, never a secret's length.

## What happens when it is not configured

The form degrades honestly rather than breaking:

- Both live → "Your quote request and files are sent directly to Esther's."
- Not configured (no mailbox, **or no Turnstile keys**) → the old `mailto:`
  behaviour, and the file hint says plainly that the files will **not** be
  sent and must be attached by hand.
- Turnstile reachable but failing for this visitor → "We couldn't verify this
  request. Please try again, or contact the shop directly." Everything they
  typed stays in the form; "Copy as text" and both phone numbers remain.

It never promises an upload it cannot perform.
