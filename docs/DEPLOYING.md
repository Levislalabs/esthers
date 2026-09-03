# Putting the website online

Plain-English guide to how Esther's website is hosted, what has been done,
and what is left. Written for someone who has not done this before.

**Where things stand right now:** the site is **live on Vercel** at
`https://esthers.vercel.app`, and **www.esthers.ca still points at the old
cPanel site**. Nothing about the live domain or the company email has been
touched.

Steps 1 and 1b below are done. **Step 1c — creating the private Blob store —
is not, and customer file uploads do not work until it is.**

---

## The plan, in a picture

```
   GitHub repository  (private)
            |
            |  Vercel watches it and rebuilds on every push
            v
        VERCEL  ---->  www.esthers.ca        the WEBSITE
                       esthers.ca  -> redirects to www

        cPanel  ---->  mail.esthers.ca       the EMAIL, unchanged
                       MX records            stays exactly where it is
```

The important thing to understand: **the website and the email are separate
things that happen to share a domain name.** Moving the website to Vercel
must not disturb the email, and it does not have to — they are controlled by
different DNS records.

---

## What is already done

- `vercel.json` — tells Vercel this is a plain static site with no build
  step, sets the old-URL redirects, and adds security headers.
- `.vercelignore` — keeps the unfinished messaging backend and the internal
  docs out of anything published.
- The site itself is finished and tested.

### The exclusions were tested, not assumed

A copy of the deployment was built locally by applying `.vercelignore` to the
repository, then served over HTTP and probed. **47 files are published; 35 are
held back** — the whole of `supabase/`, `staff/` and `docs/`, both `README.md`
files, `tools-bundle.js`, `.gitignore` and `.nojekyll`.

Every excluded path returned **404**, and the same paths were checked against
the raw repository first, where they all returned **200**. That second step
matters: without it a 404 could just as easily mean the test was pointed at an
empty folder. The site itself was then run through 46 browser checks at five
screen widths — all passed, with no broken images, no console errors and no
network request leaving the page.

## What is NOT done

- **No Blob store exists** — so quote uploads are off. See step 1c.
- No DNS has been touched.
- The chat backend is written but not switched on.

**Why the storage was not created for you:** it is a dashboard action tied to
your account and billing, and it produces a credential that should never pass
through a chat message. Step 1c is a couple of minutes of clicking that only
you can do. Everything that *could* be prepared in advance has been.

---

## Step 1 — create the Vercel project

Do this in a browser. It takes about five minutes.

1. Go to **vercel.com** and sign in. **Sign in with GitHub** is easiest —
   it means Vercel can see the repository without any extra setup.
2. Click **Add New…** → **Project**.
3. Find **Levislalabs/esthers** in the list and click **Import**.
   - If it is not listed, click **Adjust GitHub App Permissions** and give
     Vercel access to that repository.
4. On the configuration screen:

   | Setting | What to choose |
   | --- | --- |
   | Project Name | `esthers` |
   | Framework Preset | **Other** |
   | Root Directory | `./` (leave it alone) |
   | Build Command | leave **empty** |
   | Output Directory | leave **empty** |
   | Install Command | leave **empty** |

   If Vercel has pre-filled a build command, clear it. This site has no build
   step — the files in the repository *are* the website.

5. Add the Environment Variables for quote-request email (see the next
   section). Without them the site still works — the quote form falls back to
   opening the visitor's email app — but **attachments will not arrive**.
6. Click **Deploy**.

After a minute you get a URL like `https://esthers.vercel.app`. That is the
preview. **The real domain is still untouched at this point.**

---

## Step 1b — turn on quote-request email

**This is the step that makes customer photos arrive as attachments.** Until it
is done, the quote form behaves the way it always has: it opens the visitor's
email app with the request typed out, and their photos stay on their phone.
Nothing breaks — it simply does not carry the pictures.

### Why it needs setting up at all

A `mailto:` link — which is all the form had before — has room for a subject
and a message and nothing else. There is no attachment field in it. So a
customer who picked three photos sent an email listing three *filenames*. The
pictures never left their browser. Fixing that needs somewhere to send them,
and that is what these three settings are.

### Create the sending account

1. Go to **resend.com** and sign up. The free tier is far more than a quote
   form needs.
2. **API Keys → Create API Key.** Give it **Sending access** only.
3. Copy the key. You will not be shown it again.
   **Do not paste it into the repository, a document, or a chat message.** It
   goes in one place only: the box in step 4.

### Add the three variables in Vercel

**Settings → Environment Variables.** Add each one to all environments
(Production, Preview, Development):

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | the key you just copied |
| `QUOTE_TO` | `counter@esthers.ca,manager@esthers.ca` |
| `QUOTE_FROM` | leave unset for now — see below |

Then **Deployments → … → Redeploy**. Environment variables are read when the
site is built, so an existing deployment will not pick them up on its own.

### Step 1c — create the private Blob store (you must do this)

Customer photos no longer travel inside the quote request — they upload
straight to private storage. That storage has to exist before the form can
accept a file, and creating it is a dashboard job only you can do.

**Until this is done the site still works.** The form falls back to the old
behaviour and says so. Nothing is broken; files just are not carried.

1. Open your project on **vercel.com**.
2. Go to the **Storage** tab.
3. Click **Create Database** (or **Create Store**) and choose **Blob**.
4. Name it something plain, e.g. `esthers-quote-uploads`.
5. **Choose PRIVATE, not public.** This is the important click on this page.
   A public store hands out permanent URLs that anyone who ever sees one can
   open forever. These files are photographs of customers' houses.
6. **Connect it to the Esther's project only.** If your account also has
   Portrait Remix, do not connect it to that as well — separate projects,
   separate storage, nothing shared.
7. Connect it to **all three environments**: Production, Preview, Development.
8. Vercel then creates an environment variable called **`BLOB_READ_WRITE_TOKEN`**
   in the project automatically.
   **You do not need to copy it, type it, or send it to anyone — including me.**
   It should never appear in the repository or in a chat message.
9. **Redeploy** (Deployments → … → Redeploy). Variables are read at build
   time, so an existing deployment will not pick it up on its own.

**How to check it worked:** open `https://esthers.vercel.app/api/quote` in a
browser. You want to see `"ready":true` **and** `"uploads":true`. If `uploads`
is false, the store is not connected to this project or the redeploy has not
happened yet.

### About the "from" address

Leave `QUOTE_FROM` unset to start. The endpoint then sends from the provider's
own test address, which **needs no DNS changes at all** — important, because
nothing about esthers.ca DNS should be touched yet. Quotes still arrive at
`counter@esthers.ca`, and replying goes to the customer, because their address
is set as the reply-to.

Later, when you want the email to come *from* esthers.ca, that requires adding
DNS records the provider gives you. **That is a separate job to plan carefully
alongside the domain move**, since it touches the same DNS zone as the company
email. It is not needed for attachments to work.

### Check it worked

Open the site, submit a quote request to yourself with a photo attached, and
look in the mailbox. Full instructions are in the checklist at the end.

If the key is missing or wrong, the form does not show an error to the
customer — it quietly falls back to the email-app behaviour. That is deliberate:
a customer should never see a broken form. But it does mean **the only way to
know it is working is to look in the mailbox.**

---

### Keep this project separate from Portrait Remix

If your Vercel account also has a **portrait-remix** project, keep them
apart: separate projects, separate environment variables, separate
databases, separate Supabase projects. Nothing is shared. A mistake in one
should never be able to reach the other.

---

## Step 2 — check the preview

Open the `.vercel.app` URL and go through it properly. There is a full
checklist at the bottom of this file.

Two things to confirm specifically, because they are the ones that would be
embarrassing to get wrong:

- **`/staff` and `/supabase` must return "not found."** Try them:
  `https://<your-url>/staff/` should 404. If it shows a sign-in page,
  `.vercelignore` did not apply — stop and say so.
- **The chat must say it is under construction** and must not send anything.

---

## Step 3 — before you touch the domain

Do not skip any of these. They are the difference between a smooth switch
and a day with no email.

### 3a. Back up the old website

1. Log in to cPanel.
2. Open **File Manager**.
3. Find the **public_html** folder.
4. Select it, click **Compress**, make a `.zip`, then **Download** it.
5. Keep that file somewhere safe.

**Do not delete the old site.** Leave it exactly where it is until the new
one has been live and working for a while.

### 3b. Write down every DNS record — all of them

In cPanel, open **Zone Editor** and screenshot or copy every record. You need
these written down before anything changes:

| Type | Why it matters |
| --- | --- |
| A | Where the website points |
| CNAME | Aliases, often `www` |
| **MX** | **Where your email is delivered. Break this and mail stops.** |
| **TXT / SPF** | Stops your mail being marked as spam |
| **DKIM** | Signs your mail so it is trusted |
| **DMARC** | Tells other servers what to do with fake mail |

The last four are the email records. **They must survive the move
completely unchanged.**

### 3c. Confirm the real mail hostname

An old note recorded the mail server IP as `216.251.144.124`. **Do not act on
that number alone.** Confirm the actual hostname and current records in
cPanel first — an IP written down months ago is not evidence of what is true
today, and email is not something to guess at.

---

## Step 4 — connect the domain (NOT YET)

Only when steps 1–3 are done and the preview has been checked.

1. In the Vercel project: **Settings → Domains → Add**.
2. Add `www.esthers.ca`, then add `esthers.ca` and set it to redirect to the
   www version.
3. Vercel shows you the DNS records it needs. At the registrar, **change or
   add only these**:
   - `www` → a CNAME pointing at Vercel
   - `@` (the bare domain) → the A record Vercel gives you
4. **Change nothing else.** Leave MX, TXT, SPF, DKIM and DMARC exactly as
   they are. Leave `mail.esthers.ca` pointing at cPanel.
5. Wait for the padlock. Vercel issues the HTTPS certificate automatically,
   usually within minutes.

### Do not change the nameservers

Some hosts offer to "take over" your DNS. **Say no.** Moving nameservers
moves *every* record, email included, and that is how mail goes down. Change
the two website records at the registrar and nothing else.

---

## Step 5 — the day you connect the domain, remove the noindex

`vercel.json` currently sends this header on every page:

```
X-Robots-Tag: noindex, nofollow
```

That tells Google **not** to list the site. It is there on purpose: while the
site lives at a temporary `.vercel.app` address, that address must not end up
in search results competing with esthers.ca.

**Delete that one header entry from `vercel.json` when you connect the real
domain.** If you forget, the site will work perfectly and never appear in
Google. It is the single easiest thing to overlook in this whole document.

---

## Old addresses from the previous website

If someone has an old link or Google still lists an old page, these send them
to the right place instead of a dead end:

| Old address | Goes to | Status |
| --- | --- | --- |
| `/contact.html` | `/#contact` | **Done** — in `vercel.json` |
| `/showcase.html` | `/#work` | **Done** — in `vercel.json` |
| `/inside.html` | *unknown* | **Not done — needs you** |

**`/inside.html` is deliberately unresolved.** Nothing in this repository
records what that page contained, and sending someone to the wrong section is
worse than a clean "not found". Open the old site (or the cPanel backup from
step 3a), see what was on it, and the redirect can be added in one line:

- if it was about the shop or how work is done → `/#process`
- if it was about what the shop makes → `/#services`
- if it was photographs → `/#work`

---

## Search engines — what is ready and what is not

Done:

- page title and meta description
- every image has alt text
- a favicon
- photographs sized properly for the web
- mobile layout and no sideways scrolling

Still to do, and best done **at domain cutover**, not before:

- **canonical URL** — deliberately absent. Pointing it at the temporary
  Vercel address would tell Google that address is the real site. It should
  be added as `https://www.esthers.ca/` on the day the domain connects.
- **Open Graph / social sharing image** — controls how a link looks when
  pasted into Facebook, LinkedIn or a text message. Right now such a link
  shows no picture.
- **robots.txt and sitemap.xml** — both need the final domain in them.
- **LocalBusiness structured data** — the block that lets Google show the
  shop's address, phone and hours directly in search results. Worth doing for
  a local business; needs the real domain.

None of these are missing by accident. Each one needs the final domain to be
correct, and adding them now with a placeholder domain would be worse than
leaving them out.

---

## Checklist for the preview

Work through this on the `.vercel.app` URL.

**It loads**
1. Homepage opens
2. Padlock shows (HTTPS)
3. All images appear
4. No broken links

**It looks right**
5. Header: "ESTHER'S Architectural Sheet Metal", crisp white
6. Hero: "Built to fit. Made to last."
7. Navigation jumps to each section
8. Services listed
9. Materials rail scrolls, arrows and counter work
10. Colour swatches are flat — no diagonal lines
11. Compare table works
12. Recent Fabrication: all six photos
13. Gallery swipes sideways on a narrow window
14. Quote Request form appears

**The quote form — the part that needs a real mailbox check**
14a. "Project details" shows **optional**, not required
14b. Submitting with Project details **empty** works
14c. The upload control reads "Up to 5 files, 25 MB each"
14d. Attach a photo, submit, and **look in counter@esthers.ca**: the email
     has an ATTACHMENTS / FILES section listing the file, its size and a
     "Download securely" link. Click the link — the picture must open.
14e. Attach two or three photos, including a big one: all of them are
     listed, each with its own link, and each row shows "sent"
14f. Try a file that is not allowed (a .txt): a plain message appears and
     nothing is sent
14g. Try a photo over 25 MB: it is refused with a message naming the limit
14h. If a send fails, the form keeps everything typed — nothing is cleared
14i. Paste a download link into a private window a few days later to
     confirm it still works; after 7 days it must stop working
15. Contact: both shops, **Ed / Luisa** on Main Branch
16. Helper line sits **above** the two cards
17. Maps show, Get Directions works
18. Footer complete

**The chat**
19. Mascot bottom-right, gently moving
20. Bubble reads exactly "How can I help you today?"
21. Clicking opens the panel
22. The under-construction notice is visible **straight away**
23. Typing and sending returns only the local reply
24. Phone number in the reply is tappable
25. Nothing is actually sent (F12 → Network shows no request)

**On a phone**
26. Everything readable
27. No sideways scrolling
28. Buttons big enough to tap

**Nothing leaking**
29. `/staff/` returns not found
30. `/supabase/` returns not found
31. `/docs/CHAT_BACKEND.md` returns not found
32. `/README.md` returns not found
33. `/vercel.json` and `/.vercelignore` — check what these return. Neither
    contains a password or a key, so nothing is at risk either way, but if
    Vercel does serve them it is tidier to know. This one could not be
    settled locally: it depends on how Vercel itself handles its own config
    files, not on anything in this repository.
34. F12 → Console shows no errors
