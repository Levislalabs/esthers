/* =========================================================================
 * MAKING IT HARD TO MISS A CUSTOMER.
 *
 * The shop is not sitting watching a browser tab. Somebody is at a brake, or
 * on the phone, or in another program entirely, and a customer message that
 * waits forty minutes is a customer who phones somebody else. This module is
 * the noise: a loud chime, a desktop notification, an unread count in the tab
 * title, and a reminder every few minutes until somebody actually looks.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO KNOW.
 *
 * It makes no API calls, holds no token, and decides nothing about
 * authorisation. chat-staff.js hands it a list of conversations the SERVER
 * has already decided this account may see, and this file turns that into
 * sound and text. If it were ever handed a Keith Street conversation for a
 * Main-only account, that would be a bug in the caller, and no amount of
 * filtering here would be the fix.
 *
 * WHAT IT REMEMBERS, AND WHERE.
 *
 * Two booleans in localStorage - whether alerts are on, and whether they are
 * muted. Both are preferences, neither is a credential, and there is nothing
 * else. No token, no uid, no conversation, no customer text. See PREF_KEY.
 *
 * THE HONEST LIMIT.
 *
 * This works while the staff chat tab is OPEN, in a browser that is RUNNING.
 * Background it, minimise it, switch programs - all fine. Close the tab or
 * quit the browser and nothing here runs, because nothing here is a service
 * worker. Web Push would change that and is a separate phase; this file does
 * not pretend otherwise and neither does the documentation.
 * ========================================================================= */

/* The chat client version. THE SAME STRING as CHAT_CLIENT_VERSION in chat.js,
   chat-customer.js, chat-staff.js, chat-app-check.js and chat-locations.js. */
export const CHAT_CLIENT_VERSION = '2026-09-08.1';

/*
 * How long an unread conversation waits before it says something again.
 *
 * Three minutes is a compromise with a real cost on both sides: shorter and
 * it becomes the thing people mute, longer and a customer waits. It is
 * evaluated on the existing poll rather than by its own timer, so the actual
 * gap is three minutes rounded up to the next poll - at most thirty seconds
 * late, and never early.
 */
export const REMINDER_MS = 3 * 60 * 1000;

/* localStorage. Namespaced like every other key this site sets, and
   deliberately boring: two booleans, nothing that could be a credential. */
const PREF_KEY = 'esthers.staff.alerts';

const DEFAULT_TITLE = "Esther's Staff Chat";

/* ------------------------------------------------------------- the sound */

/*
 * A triple chime, built with Web Audio.
 *
 * NO AUDIO FILE, on purpose: no copyrighted asset to license, no extra
 * request, nothing to 404 after a deploy, and it works the same on every
 * browser that has Web Audio at all.
 *
 * Three rising notes rather than one, because one short beep in a shop is
 * indistinguishable from every other short beep a computer makes. Loud, but
 * bounded - about a second in total, so it carries across a room without
 * becoming the thing somebody turns off.
 *
 * WHAT IT DOES NOT DO: touch the OS volume, override Do Not Disturb, or
 * bypass the browser's own autoplay rules. Nothing in a web page can, and
 * anything that claimed to would be lying.
 */
const CHIME = [
  { freq: 880, at: 0.00, len: 0.16 },
  { freq: 1174.7, at: 0.20, len: 0.16 },
  { freq: 1567.98, at: 0.40, len: 0.34 }
];

function playChime(ctx, gainValue) {
  const now = ctx.currentTime;
  for (const note of CHIME) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    /* A triangle rather than a sine: more harmonics, so it cuts through
       machine noise at the same peak level. */
    osc.type = 'triangle';
    osc.frequency.value = note.freq;

    /* A short attack and an exponential tail. A square-edged gate on a loud
       tone produces an audible click on most hardware. */
    const start = now + note.at;
    const end = start + note.len;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

/* ------------------------------------------------------- text for humans */

/*
 * Everything a notification says, in one place.
 *
 * NO MESSAGE CONTENT, EVER. A native notification lands on whatever screen the
 * browser is on, and a shop monitor faces the counter - so the words a
 * customer typed are not put in front of whoever is standing there before a
 * staff member has decided to open the thread. The job is to make a new
 * message impossible to MISS, which the customer's name and the shop name do
 * on their own. The message itself is behind the transcript, where somebody
 * has to go and look at it.
 *
 * A TRANSFER IS NOT A NEW MESSAGE. Announcing a handoff as "new customer
 * message" would send somebody looking for words the customer never wrote.
 * The two get different titles and different bodies.
 *
 * THE SHOP NAME IS THE CALLER'S DERIVED LABEL, never a string from the wire:
 * chat-staff.js maps the location id through labelFor() before anything gets
 * here, so the only three shop names this can ever print are the three in
 * chat-locations.js.
 */
export function describeAlert(conversation) {
  const c = conversation || {};
  const shop = text(c.locationLabel);
  /* A conversation with no name on it is still a customer waiting. */
  const who = text(c.customerName) || 'A customer';

  if (c.lastAttentionType === 'transfer') {
    return {
      title: 'Conversation transferred — ' + shop,
      body: who + ' — this conversation was moved to your shop.'
    };
  }
  return {
    title: 'New customer message — ' + shop,
    body: who + ' is waiting for a reply.'
  };
}

/*
 * Plain text, bounded.
 *
 * Not escaping - BOUNDING. Both destinations take text and neither parses
 * markup: the Notification API renders its title and body as text, and every
 * string this module hands back reaches the DOM through textContent in
 * chat-staff.js. A customer typing a <script> tag gets a notification with a
 * <script> tag spelled out in it, doing nothing.
 *
 * What this DOES stop is a customer with a very long name, or a newline, or a
 * terminal escape sequence, making a notification unreadable.
 */
function text(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\0-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/* ----------------------------------------------------------- the module */

/*
 * Everything the browser gives us is injectable, because none of it can be
 * driven honestly in a test otherwise: permission prompts need a click, audio
 * needs a device, and Notification does not exist in Node at all.
 */
function defaultDeps(overrides) {
  const d = {
    now: () => Date.now(),
    storage: () => {
      try { return globalThis.localStorage || null; } catch (err) { return null; }
    },
    document: () => globalThis.document || null,
    notificationApi: () => (typeof globalThis.Notification === 'function'
      ? globalThis.Notification : null),
    audioContext: () => {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      return Ctor ? new Ctor() : null;
    }
  };
  return Object.assign(d, overrides || {});
}

export function createAlerts(options) {
  const deps = defaultDeps(options && options.deps);
  const opts = options || {};

  /*
   * The dedupe ledger: conversationId + ':' + attentionVersion -> when we
   * last made a noise about it.
   *
   * THE VERSION IS PART OF THE IDENTITY, and that is the whole design. The
   * same conversation polled two hundred times at version 7 is ONE event;
   * the moment the customer writes again it becomes version 8, a different
   * key, and a new alert. Deduping by conversation alone would silence the
   * second message; deduping by timestamp would fire on clock jitter.
   *
   * The value is { at, reminders }: when we last made a noise, and how many
   * reminders this key has had. The count is what gives each reminder its own
   * platform identity - see the tag section below. It is NOT a new structure:
   * this map is pruned on every observe() down to the conversations that are
   * unread right now, so it is bounded by the shop's open work, exactly as it
   * was when the value was a bare number.
   */
  let alerted = new Map();

  /*
   * A single integer, for the identities that must never repeat. Bounded on
   * purpose: it wraps, and the clock in uniqueTag() is what keeps a wrapped
   * value from colliding with anything still on screen.
   */
  let identitySequence = 0;

  let enabled = false;
  let muted = false;
  let ctx = null;                 /* the AudioContext, once unlocked */
  let titleApplied = false;
  let originalTitle = null;

  /* ---- preferences ---- */

  function readPrefs() {
    try {
      const store = deps.storage();
      if (!store) return;
      const raw = store.getItem(PREF_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      enabled = parsed.alertsEnabled === true;
      muted = parsed.muted === true;
    } catch (err) {
      /* Private mode, blocked storage, or something that is not JSON. The
         defaults are both false, which is the quiet, safe state. */
    }
  }

  function writePrefs() {
    try {
      const store = deps.storage();
      if (!store) return;
      /* EXACTLY TWO BOOLEANS. Not the account, not a token, not a
         conversation, not a customer's words. */
      store.setItem(PREF_KEY, JSON.stringify({
        alertsEnabled: enabled === true,
        muted: muted === true
      }));
    } catch (err) { /* best effort; a preference is not worth an exception */ }
  }

  readPrefs();

  /* ---- capability ---- */

  function permission() {
    const N = deps.notificationApi();
    if (!N) return 'unsupported';
    const p = N.permission;
    return (p === 'granted' || p === 'denied' || p === 'default') ? p : 'default';
  }

  function status() {
    return {
      enabled: enabled === true,
      muted: muted === true,
      audio: ctx !== null,
      permission: permission(),
      supported: deps.notificationApi() !== null
    };
  }

  /* ---- sound ---- */

  /*
   * Unlocked by a click, and only by a click.
   *
   * Every browser refuses to start audio without a user gesture, and it is
   * right to: a page that can make noise unprompted is a page nobody keeps
   * open. enable() below is wired to a real button for exactly this reason.
   */
  function unlockAudio() {
    if (ctx) return true;
    try {
      const created = deps.audioContext();
      if (!created) return false;
      if (created.state === 'suspended' && typeof created.resume === 'function') {
        created.resume();
      }
      ctx = created;
      return true;
    } catch (err) {
      return false;
    }
  }

  /*
   * RESUME FIRST, SCHEDULE SECOND. THIS ORDER IS THE WHOLE FIX.
   *
   * The browser parks an AudioContext when the tab goes to the background -
   * which is exactly what a staff member does when they switch to another
   * program to answer the customer. While it is parked, ctx.currentTime IS
   * FROZEN.
   *
   * The old code did this:
   *
   *     ctx.resume();            // a Promise, dropped on the floor
   *     playChime(ctx, 0.9);     // runs NOW, reads the FROZEN clock
   *
   * playChime schedules its three notes at currentTime + 0.00 / 0.20 / 0.40.
   * Against a frozen clock those are absolute times that the context has
   * already passed by the moment it actually resumes, so the notes are
   * clipped or dropped outright and the shop hears nothing. Measured in a
   * real Chromium build: at the instant playChime read the clock, it was
   * still frozen.
   *
   * Awaiting the resume costs a few milliseconds and buys a chime that is
   * actually audible. The banner does NOT wait for any of this - see
   * observe().
   */
  let resuming = null;

  async function sound() {
    /* Not armed on this page load. An honest false: the caller may still
       show its banner, and status().audio already says so. */
    if (!ctx) return false;
    if (muted) return false;
    try {
      if (ctx.state === 'suspended') {
        if (typeof ctx.resume !== 'function') return false;
        /*
         * ONE RESUME IN FLIGHT, SHARED. Two conversations going unread in the
         * same poll must not launch two resumes and must not race each
         * other's view of the clock. They both wait on this one and then each
         * schedules its own notes against the same live clock.
         */
        if (!resuming) {
          resuming = Promise.resolve(ctx.resume())
            .then(() => { resuming = null; },
                  (err) => { resuming = null; throw err; });
        }
        await resuming;
      }
      /* Resumed, closed, or interrupted - only one of those can make a
         sound, and createOscillator on a closed context throws. */
      if (ctx.state !== 'running') return false;
      playChime(ctx, 0.9);
      return true;
    } catch (err) {
      /* A rejected resume, a closed device, a context the browser took away.
         Never a crash, never an unhandled rejection, never a lost banner. */
      return false;
    }
  }

  /* ---- desktop notification ---- */

  /*
   * THE PLATFORM IDENTITY, WHICH IS NOT THE APPLICATION DEDUPE KEY.
   *
   * These used to be the same string, and that WAS the production bug.
   *
   * A notification carries a `tag`, and the platform treats two notifications
   * with the same tag as the same notification: the second REPLACES the first
   * in place. With renotify false - the default, and what this file used to
   * send explicitly - that replacement is SILENT. No new banner, no re-alert,
   * nothing. On Windows the first Chrome notification of a given tag raised a
   * banner and every later one quietly rewrote an Action Center entry that
   * nobody was looking at. The chime still played, because the chime is Web
   * Audio in this file and owes the notification nothing - which is exactly
   * why the symptom was "sound but no banner".
   *
   * The old tag was the conversation id alone, so it collapsed precisely the
   * three cases that matter most:
   *
   *     Test alert pressed twice        same id 'test'
   *     attentionVersion 4 -> 5         same conversation
   *     a three-minute reminder         same conversation, same version
   *
   * So the two concepts are now separate and must stay separate:
   *
   *     WHETHER to alert    the dedupe ledger, on conversationId +
   *                         attentionVersion. Unchanged. Ten polls of one
   *                         version are still one event.
   *
   *     WHAT IDENTITY to    here. Every distinct alert event gets a distinct
   *     hand the platform   tag, so the platform has nothing to collapse.
   *
   * Version in the tag is what lets version 5 be a new banner rather than a
   * silent rewrite of version 4; the reminder sequence is what lets the
   * 3-minute nudge be a new banner rather than a silent rewrite of itself.
   */
  const TAG_PREFIX = 'esthers-chat:';

  function initialTag(conversation) {
    return TAG_PREFIX + String(conversation.conversationId)
      + ':v' + String(conversation.attentionVersion);
  }

  function reminderTag(conversation, sequence) {
    return initialTag(conversation) + ':r' + String(sequence);
  }

  /*
   * An identity that never repeats, for the two cases that must ALWAYS be a
   * fresh banner: the Test alert button, and the defensive fallback below.
   *
   * The counter separates two of these inside the same millisecond; the clock
   * separates two counters across the wrap. One integer of state, not a
   * structure - nothing here grows with use.
   */
  function uniqueTag(kind) {
    identitySequence = (identitySequence + 1) % 1000000;
    return TAG_PREFIX + kind + ':' + String(deps.now())
      + '-' + String(identitySequence);
  }

  function popup(conversation, tag) {
    const N = deps.notificationApi();
    if (!N || N.permission !== 'granted') return false;
    const said = describeAlert(conversation);
    try {
      /*
       * renotify true is the belt to the distinct tag's braces: if two events
       * ever did share a tag, the platform re-alerts instead of swallowing
       * the second one.
       *
       * It is not free. Chromium throws TypeError for renotify WITHOUT a tag
       * - measured in a real Chromium build, not assumed - so the tag here is
       * never allowed to be empty. Every call site passes one; the fallback
       * covers a caller that somehow did not, because a missing argument must
       * not turn a waiting customer into an exception.
       */
      new N(said.title, {
        body: said.body,
        tag: (typeof tag === 'string' && tag !== '') ? tag : uniqueTag('unknown'),
        renotify: true
      });
      return true;
    } catch (err) {
      /* Some browsers throw on construction rather than returning null when
         the platform cannot show one. Sound and the unread badge remain. */
      return false;
    }
  }

  /* ---- the tab title ---- */

  /*
   * "🔴 (2) Esther's Staff Chat".
   *
   * The one indicator that survives the tab being a 60-pixel sliver behind
   * three other windows. The original title is captured the first time it is
   * touched and restored on reset(), so signing out does not leave a phantom
   * count on the page forever.
   */
  function applyTitle(count) {
    const doc = deps.document();
    if (!doc) return;
    if (originalTitle === null) originalTitle = doc.title || DEFAULT_TITLE;
    if (count > 0) {
      doc.title = '🔴 (' + count + ') ' + originalTitle;
      titleApplied = true;
    } else if (titleApplied) {
      doc.title = originalTitle;
      titleApplied = false;
    }
  }

  /* ---- the public surface ---- */

  return {
    status: status,

    /*
     * The one setup interaction, wired to a real button.
     *
     * Ordering matters and is not negotiable: the audio unlock has to happen
     * inside the gesture, so it goes first and synchronously. The permission
     * request is awaited afterwards - some browsers resolve it only after the
     * user answers a prompt, and by then the gesture is long over.
     */
    enable: async function () {
      const audio = unlockAudio();
      enabled = true;
      muted = false;
      writePrefs();

      const N = deps.notificationApi();
      if (N && N.permission === 'default' && typeof N.requestPermission === 'function') {
        try { await N.requestPermission(); } catch (err) { /* denied or unavailable */ }
      }
      /* A test chime, so the person hears exactly what will happen later and
         can judge the volume now rather than at 8am on a Tuesday. Awaited so
         the status returned below reflects a speaker that has actually
         spoken. */
      if (audio) await sound();
      return status();
    },

    /*
     * ARM THE SPEAKER, ON SOMEBODY ELSE'S GESTURE.
     *
     * A browser requires a fresh user gesture per PAGE LOAD before it will
     * let a page make noise, and it is right to. The alerts preference and
     * the notification permission both survive a reload; the audio unlock
     * cannot. That left the engine half on after every reload - banners, no
     * chime - because nothing but the two alert buttons ever created the
     * context.
     *
     * So the dashboard calls this from the first real click or keypress
     * anywhere on the page. It is deliberately minimal:
     *
     *   - it makes NO sound. Somebody clicking a conversation has not asked
     *     to be chimed at.
     *   - it shows no notification, touches no conversation, reads nothing,
     *     calls nothing, and does not write the preference.
     *   - it refuses unless alerts are already ON, so a shop that turned
     *     them off never gets an AudioContext it did not ask for.
     *   - muted is irrelevant: arming a muted speaker is still correct, and
     *     unmuting later must not need a second gesture.
     *
     * This does not bypass the autoplay policy. It IS the gesture the policy
     * asks for; the only change is that any honest click will do, instead of
     * one particular button nobody knew to press.
     */
    unlock: function () {
      if (enabled !== true) return false;
      if (ctx) return true;
      return unlockAudio();
    },

    setMuted: function (flag) {
      muted = flag === true;
      writePrefs();
      return status();
    },

    /*
     * Test alert.
     *
     * DELIBERATELY INERT. It makes a noise and shows a popup, and it touches
     * no conversation, calls no API, and creates no unread state. Somebody
     * checking the volume must not thereby mark a customer read or invent an
     * alert for a conversation that does not exist.
     */
    test: function () {
      unlockAudio();
      const played = sound();     /* a Promise; deliberately not awaited */
      /*
       * A FRESH IDENTITY EVERY PRESS. The whole point of the button is that
       * somebody presses it and sees what will happen later, so five presses
       * must be five banners - never one banner and four silent rewrites of
       * it, which is what a fixed tag gave before.
       */
      const tag = uniqueTag('test');
      const shown = popup({
        conversationId: 'test',
        customerName: 'Test alert',
        locationLabel: "Esther's Sheet Metal",
        lastAttentionType: 'customer_message'
      }, tag);
      /* `chime` is a PROMISE, because a parked context has to be resumed
         before it can make a noise. The banner above did not wait for it. */
      return { chime: played, shown: shown, tag: tag, status: status() };
    },

    /*
     * THE HEART OF IT: given every OPEN conversation this account is
     * authorised for, make whatever noise is owed.
     *
     * Called from the poll rather than from a timer of its own. Reminders are
     * therefore evaluated at most once per poll, which is also why there is
     * no timer to leak, no second interval to overlap with the first, and no
     * way for a reminder to fire while the tab is doing nothing else.
     *
     * Returns what it did, so the caller can test it without a speaker.
     */
    observe: function (conversations) {
      const list = Array.isArray(conversations) ? conversations : [];
      const now = deps.now();
      const seen = new Set();
      const fired = [];
      const chimes = [];
      let unreadCount = 0;

      for (const c of list) {
        if (!c || typeof c.conversationId !== 'string' || !c.conversationId) continue;
        /* A closed conversation is somebody's finished business. The caller
           only ever passes open ones; this is the second lock. */
        if (c.status === 'closed') continue;
        if (c.unread !== true) continue;

        unreadCount += 1;
        const key = c.conversationId + ':' + String(c.attentionVersion);
        seen.add(key);

        const entry = alerted.get(key);
        let tag;
        if (entry === undefined) {
          /* First time this exact version has been seen by this browser. */
          alerted.set(key, { at: now, reminders: 0 });
          tag = initialTag(c);
          fired.push({ kind: 'initial', conversationId: c.conversationId,
                       key: key, tag: tag });
        } else if (now - entry.at >= REMINDER_MS) {
          /* The cooldown is unchanged; only the identity is new. Counting the
             reminders is what makes the second nudge a second banner rather
             than a silent rewrite of the first. */
          entry.at = now;
          entry.reminders += 1;
          tag = reminderTag(c, entry.reminders);
          fired.push({ kind: 'reminder', conversationId: c.conversationId,
                       key: key, tag: tag });
        } else {
          /* Still unread, still inside the cooldown. Say nothing - this is
             the branch that runs on almost every poll. */
          continue;
        }

        if (enabled) {
          /*
           * THE BANNER NEVER WAITS FOR THE SPEAKER.
           *
           * sound() is async now - a parked context must be resumed before a
           * note can be scheduled - so it is started and NOT awaited, and
           * popup() runs synchronously on the next line. A slow or rejected
           * resume costs the chime and nothing else: the banner still
           * appears, the badge still updates, and the poll loop is never
           * blocked or thrown out of.
           */
          chimes.push(sound());
          popup(c, tag);
        }
      }

      /*
       * FORGET ANYTHING NO LONGER UNREAD.
       *
       * This is what makes "somebody else read it on the other computer"
       * work: their acknowledgement lands on the server, this account's next
       * poll returns unread=false, the key drops out of the ledger, and the
       * reminder stops. It also means that if the SAME version somehow became
       * unread again it would alert again, which is correct - it would be a
       * different situation.
       */
      for (const key of Array.from(alerted.keys())) {
        if (!seen.has(key)) alerted.delete(key);
      }

      applyTitle(unreadCount);
      /*
       * `sound` settles when every chime this pass attempted has finished
       * trying. Nothing in the app awaits it - the poll moves on immediately.
       * It exists so that a test can prove a chime actually happened, and so
       * that every promise has a handler attached: sound() already swallows
       * its own failures, and this guarantees no unhandled rejection can
       * escape even if that ever changed.
       */
      return {
        unreadCount: unreadCount,
        fired: fired,
        alerts: enabled === true,
        sound: Promise.all(chimes.map((p) => p.then((v) => v, () => false)))
      };
    },

    /* Sign-out, or teardown. The title goes back to what it was - a phantom
       "(3)" on a signed-out page is a lie about somebody else's customers. */
    reset: function () {
      alerted = new Map();
      applyTitle(0);
    },

    /* Tests only. */
    _pending: () => Array.from(alerted.keys())
  };
}
