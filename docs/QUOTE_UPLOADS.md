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
  pathname *we* choose, a single operation (`put`), a maximum size, a content
  type allowlist, and a **30-minute expiry**. A URL handed out for a 3 MB photo
  cannot be spent on a 2 GB file, cannot overwrite anything, and stops working
  within the half hour.
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

The one thing this deliberately does *not* do is make customers create
accounts, or track them.

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

`GET /api/quote` reports readiness as two booleans — `ready` (mailbox) and
`uploads` (storage) — and never anything about the values themselves.

## What happens when it is not configured

The form degrades honestly rather than breaking:

- Both live → "Your quote request and files are sent directly to Esther's."
- Not configured → the old `mailto:` behaviour, and the file hint says plainly
  that the files will **not** be sent and must be attached by hand.

It never promises an upload it cannot perform.
