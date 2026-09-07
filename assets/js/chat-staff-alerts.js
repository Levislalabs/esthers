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
export const CHAT_CLIENT_VERSION = '2026-09-06.2';

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
   */
  let alerted = new Map();

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

  function sound() {
    if (!ctx || muted) return false;
    try {
      /* A context can be suspended again by the browser when a tab is
         backgrounded on some platforms. Asking it to resume costs nothing
         when it is already running. */
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
      playChime(ctx, 0.9);
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---- desktop notification ---- */

  function popup(conversation) {
    const N = deps.notificationApi();
    if (!N || N.permission !== 'granted') return false;
    const said = describeAlert(conversation);
    try {
      /*
       * tag = the conversation id, so a second alert about the SAME
       * conversation replaces the first rather than stacking six of them
       * down the corner of the screen. Somebody coming back to their desk
       * should see what is waiting, not a history of it.
       */
      new N(said.title, {
        body: said.body,
        tag: 'esthers-chat-' + String(conversation.conversationId || ''),
        renotify: false
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
         can judge the volume now rather than at 8am on a Tuesday. */
      if (audio) sound();
      return status();
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
      const played = sound();
      const shown = popup({
        conversationId: 'test',
        customerName: 'Test alert',
        locationLabel: "Esther's Sheet Metal",
        lastAttentionType: 'customer_message'
      });
      return { played: played, shown: shown, status: status() };
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

        const last = alerted.get(key);
        if (last === undefined) {
          /* First time this exact version has been seen by this browser. */
          alerted.set(key, now);
          fired.push({ kind: 'initial', conversationId: c.conversationId, key: key });
        } else if (now - last >= REMINDER_MS) {
          alerted.set(key, now);
          fired.push({ kind: 'reminder', conversationId: c.conversationId, key: key });
        } else {
          /* Still unread, still inside the cooldown. Say nothing - this is
             the branch that runs on almost every poll. */
          continue;
        }

        if (enabled) {
          sound();
          popup(c);
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
      return { unreadCount: unreadCount, fired: fired, alerts: enabled === true };
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
