# The staff chat inbox

Where customer chat messages arrive, and where you answer them.

**URL:** `https://www.esthers.ca/staff/chat`

It is not linked from anywhere on the website and it does not appear in search
results. Bookmark it.

---

## Who can sign in

Staff accounts that already exist in the Firebase project — today
`manager@esthers.ca` and `counter@esthers.ca`.

Having a Firebase account is **not** enough on its own. Every request the page
makes is checked against the staff list on the server, and an account that is
not on it, or has been switched off, gets no further than the sign-in screen —
whatever the email address says.

Passwords are managed in the Firebase console. Nobody needs to give a password
to anybody to set this up, and this document does not contain one.

---

## Signing in and out

1. Open the URL. You get an email and password form.
2. Enter your staff email and password, press **Sign in**.
3. The inbox appears.

**Sign out** is the button at the top right. Use it on a shared machine — the
shop counter especially. Closing the tab is not signing out: the browser keeps
the session so a page refresh does not make you sign in again, which is
convenient for you and equally convenient for the next person to sit down.

If a sign-in fails you get one sentence: *"That email address and password did
not match."* That is deliberate and it is the same sentence for a wrong
password, a typo in the address and an account that does not exist — so that
someone guessing cannot learn which email addresses are real.

---

## Reading and replying

**The left column** is the list of conversations, newest activity first. Each
row shows the customer's name, their email address, when they last wrote,
whether the conversation is Open or Closed, and how many messages it has.

**Open / Closed** at the top of the list switches between the two. Open is
what you want almost always.

Click a conversation to read it. Customer messages sit on the left; your
replies sit on the right, tinted orange and labelled *Esther's*.

**To reply:** type in the box at the bottom and press **Send**, or just press
Enter. Shift+Enter gives you a new line without sending.

The Send button greys out while a reply is on its way, so a double-click
cannot send the same thing twice.

**If a reply fails to send** you get a message and a **Try again** button. Use
the button rather than retyping: it re-sends *the same message*, and the server
recognises it, so you cannot accidentally send the customer the same sentence
twice. Retyping it would be a second message.

---

## Closing a conversation

Closing means the customer can no longer send new messages. They can still
read everything that was said, and so can you — nothing is deleted.

Press **Close conversation** and you get a confirmation box. Nothing happens
until you answer it; Escape or **Keep it open** cancels.

Once closed:

- the thread is marked **Closed**
- the reply box and Send are switched off
- the Close button disappears
- a line at the bottom of the transcript explains the state
- the conversation moves out of the Open list

There is no reopen. If a customer needs to talk again they start a new
conversation, which is what the customer-side panel offers them.

---

## How fresh is what I am looking at

The page checks for new messages on its own:

| what | how often |
|---|---|
| the conversation list | every 15 seconds |
| the conversation you have open | every 8 seconds |

**It stops entirely when the tab is not visible.** Switch to another tab and
nothing is fetched; come back and it refreshes immediately, so you are never
looking at a stale screen after a break.

**Refresh** at the top of the list forces a check right now.

If the server stops answering, the page waits longer between attempts instead
of hammering it, and picks up again on its own when things recover. Pressing
Refresh always tries immediately.

---

## What the messages mean

| what you see | what it means | what to do |
|---|---|---|
| *That email address and password did not match* | The sign-in was refused. | Check both and try again. Same message for every kind of failure, by design. |
| *This account is not authorised for the staff inbox* | The account signed in, but it is not on the staff list, has been switched off, or has the wrong role. | Ask whoever manages the Firebase project. |
| *Your session has ended. Please sign in again.* | The sign-in expired or was revoked while you were working. | Sign in again. Anything you had on screen is cleared first, on purpose. |
| *This page could not be verified. Please reload* | The page could not prove to the server that it is the real site. Usually a reload fixes it; an ad-blocker or a very strict privacy extension can cause it. | Reload. If it persists, try another browser. |
| *We could not reach the server* | The network dropped. | Check the connection, then press Refresh. |
| *Something went wrong at our end* | The server had a problem. | Wait a moment and press Refresh. If it keeps happening, say so. |
| *That conversation has been closed* | Somebody closed it while you were typing. | The thread updates itself; nothing was sent. |
| *That is a lot of messages at once* | You have hit the sending limit (60 a minute). | Wait a moment. |

---

## Security notes

Worth knowing, and worth not undoing.

**The application stores no password and no tokens.** The password exists only
for as long as it takes to hand it to Firebase, and the field is cleared
immediately. Sign-in tokens are never written to browser storage, cookies, the
address bar or any log by this page. Firebase Auth keeps its own session in its
own storage — that is what makes a refresh work — and that is the only thing
kept.

**Staff browsers have no direct database access, deliberately.** The customer's
own chat panel reads its transcript straight from Firestore, because the
database rules can express "this person owns this one conversation" exactly.
They cannot express "this person is staff" without handing every field of every
conversation to any browser holding a staff session — including fields added
later that nobody thought about. So the rules deny staff browsers all chat
access, and this page reads everything through the server, which decides what
to send. That is why the page polls instead of updating live, and it is a trade
made on purpose.

**Every request carries two separate proofs**: that it came from the real site
(App Check), and who is making it (your sign-in). The server checks both, then
checks the staff list, before it returns anything.

**If the server stops trusting the session mid-shift**, the page clears the
customer names, email addresses and messages off the screen *first*, then signs
out. A revoked session does not leave customer details sitting on a shop
monitor behind a warning.

**Everything a customer typed is displayed as plain text.** If somebody types
HTML or a script into the chat, you see the characters they typed. It cannot
run.

**The page being hard to find is not the protection.** It carries a `noindex`
tag and no link points at it, but that is tidiness. The protection is the three
checks on every request.

---

## Rollout status

- **The staff inbox: ready for review, not yet deployed.**
- **Public customer chat: still OFF.** Visitors get the existing
  under-construction chat panel. Both rollout gates in the customer code
  remain `false`, and no public page loads the real customer transport.
- **App Check enforcement on the Vercel chat API: ON.**
- **App Check enforcement in Firebase for Firestore and Authentication: OFF.**
  Turning those on is a separate, deliberate step.

---

## Checking it on production, the first time

Nobody has yet signed a real staff account in through this page, because App
Check attestation only works on a page served from `esthers.ca` — not from a
preview URL and not from a laptop. So the first sign-in is the test.

1. Open `https://www.esthers.ca/staff/chat` in a normal window.
2. Open DevTools → Network before signing in.
3. Sign in with a staff account.
4. You should see, in order: a `recaptcha/enterprise` request, a
   `firebaseappcheck.googleapis.com` request returning 200, then
   `/api/admin/chat/conversations` returning 200.
5. The inbox appears.

If step 4 shows a 403 on `/api/admin/chat/conversations`, the account signed in
but is not authorised — check `isActive` and `role` on its `staff` document.

If the page ever looks wrong after a deployment, it is worth confirming you
have the current build: the version the page is running is
`CM.chat.clientVersion` on the customer pages and the `?v=` on this page's own
script tag. A hard reload (Ctrl+Shift+R) settles it.
