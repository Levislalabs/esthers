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
shop counter especially. Refreshing the page does not sign you out: the tab
keeps your session so F5 does not make you type your password again.

**Closing the tab DOES end the session.** The sign-in is remembered per tab,
not per browser, so a new tab starts signed out. That is deliberate: it means
you can have this dashboard open in one tab and the customer-facing website in
another without the two interfering — signing in here does not disturb a
customer chat in the other tab, and vice versa. It also means the next person
to open a fresh tab on this machine does not inherit your session.

If a sign-in fails you get one sentence: *"That email address and password did
not match."* That is deliberate and it is the same sentence for a wrong
password, a typo in the address and an account that does not exist — so that
someone guessing cannot learn which email addresses are real.

---

## Reading and replying

**The left column** is the list of conversations, newest activity first. Each
row shows the customer's name, their email address, **which shop the message
was sent to**, when they last wrote, whether the conversation is Open or
Closed, and how many messages it has.

**Open / Closed** at the top of the list switches between the two. Open is
what you want almost always.

**The shop buttons** — *All shops*, *Main Shop - 1st Avenue*, *Specialty Shop -
Keith Street*, *Not Sure / Unassigned* — appear only if your account covers
more than one shop. They narrow what is on your screen; they do not change what
you are allowed to see. If your account covers one shop, the buttons are not
there because there is nothing to choose between: the list is already only
your shop's, decided on the server before it ever reached your browser.

*Not Sure / Unassigned* is where two kinds of conversation end up: the customer
picked "I'm Not Sure", and anything from before we started asking.

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

## Moving a conversation to the other shop

Somebody asks the 1st Avenue shop about a curved copper scupper. That is Keith
Street's work. Press **Move to other shop**.

You get a box asking which shop, with nothing pre-selected. Pick one and press
**Move conversation**; **Leave it here** or Escape cancels, and nothing happens
until you answer.

What happens when you do:

- **The customer keeps the same conversation.** Same thread, same transcript,
  nothing copied and nothing lost. They do not have to explain it twice.
- **They are told where it went.** The line at the top of their panel changes
  from "Sending to: Main Shop - 1st Avenue" to the new shop, without them
  having to do anything. They are **not** told who moved it.
- **The other shop sees it** in their list within about fifteen seconds.
- **If the shop you chose is not one of yours, it leaves your inbox** — you get
  a note saying where it went, and the conversation closes on your screen. That
  is normal and it is not an error: you handed it over, which is not the same
  as being let into the other shop.

You can move a conversation to a shop you cannot read. That is deliberate:
otherwise only a manager could ever fix a misroute.

**A closed conversation cannot be moved.** There is nobody to hand it to and
nothing left to do with it, so the button is not offered.

Moving a conversation does **not** count as a message. It does not change
"last wrote" or the message count, and the customer gets no notification other
than the line at the top of their panel.

---

## How fresh is what I am looking at

Every 15 seconds, while the tab is visible, the page asks the server for the
conversation list. That list says, for each conversation, when it last had a
message and how many it has.

If the conversation you have open has not changed since you last read it, the
page does nothing more. If it has — a new customer message, or somebody closed
it — the page fetches that one conversation, once, and the new message appears.

**It stops entirely when the tab is not visible.** Switch to another tab and
nothing is fetched at all; come back and it checks straight away, so you are
never looking at a stale screen after a break.

**Refresh** at the top of the list checks both the list and the open
conversation immediately, whether or not anything looks changed. When you want
to be certain, press it.

Sending a reply or closing a conversation updates the screen at once — neither
waits for the next 15-second check.

If the server stops answering, the page waits longer between attempts instead
of hammering it, and picks up again on its own when things recover. Pressing
Refresh always tries immediately.

### What changed here, and why it matters

The first version of this page re-read **every message in the open
conversation every 8 seconds**, whether or not anything had happened. A
conversation with thirty messages in it therefore had all thirty read from the
database roughly seven times a minute, just to discover — almost always — that
nothing was new.

It now reads the conversation *list* every 15 seconds and the messages
themselves only when that list says something actually happened. On a quiet
afternoon with a thread left open, the number of message reads goes from
"constantly" to none at all until somebody writes something.

The exact saving depends on how many messages a conversation has and how busy
the day is, so this is not a promise about a bill — but the shape of it is
that the expensive read now happens on real events rather than on a clock.

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

**And it keeps it per tab, not per browser.** Firebase's default is to share
one signed-in user across every tab, which would be wrong here: the same
Firebase project holds anonymous customer sessions as well as staff accounts,
and only one user can be signed in at a time. Under the default, signing in
here would have kicked a customer's chat session out in another tab, and a
customer starting a chat would have signed a staff member out mid-reply. The
session is deliberately confined to the tab it was created in, so the two
cannot collide. The practical consequence is the one described above: closing
the tab ends the session.

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

**Which shops an account sees.** Today both staff documents are
`{ isActive: true, role: 'admin' }` with no `locations` field, and that is read
as *every shop* — so nothing changes for either account, and both get the shop
buttons. To restrict an account to one shop, add a `locations` array to its
`staff/{uid}` document:

```
locations: ["main"]           only 1st Avenue
locations: ["specialty"]      only Keith Street
locations: ["main", "unassigned"]   1st Avenue, plus anything unrouted
locations: []                 nothing at all (a deliberate switch-off)
```

Those three ids — `main`, `specialty`, `unassigned` — are the only ones the
server accepts; anything else in the array is ignored. **Deploy the composite
index first** (`firebase deploy --only firestore:indexes`): a single-shop
account uses a query that needs it.

If the page ever looks wrong after a deployment, it is worth confirming you
have the current build: the version the page is running is
`CM.chat.clientVersion` on the customer pages and the `?v=` on this page's own
script tag. A hard reload (Ctrl+Shift+R) settles it.
