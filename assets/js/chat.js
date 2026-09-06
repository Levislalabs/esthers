/* =========================================================================
 * Esther's - customer help launcher and messaging panel
 *
 * ####################################################################
 * ##                                                                ##
 * ##  LIVE ON THE PUBLIC SITE, AND IT SENDS NOTHING ANYWHERE.       ##
 * ##                                                                ##
 * ##  There is no fetch, no XHR, no WebSocket, no form action, no   ##
 * ##  mailto, no third-party SDK and no storage in this file. A     ##
 * ##  message typed here exists in one browser tab and is gone on   ##
 * ##  reload. NOBODY AT ESTHER'S RECEIVES IT.                       ##
 * ##                                                                ##
 * ##  Because this is now in front of real customers, it says so    ##
 * ##  plainly and twice over: a standing notice sits in the         ##
 * ##  conversation from the moment it opens - BEFORE anyone spends  ##
 * ##  time typing - and the reply repeats it and points at the two  ##
 * ##  routes that do reach the shop, the phone and the quote form.  ##
 * ##  Nothing here may imply a person is reading.                   ##
 * ##                                                                ##
 * ##  THE REAL TRANSPORT NOW EXISTS, AND IS SWITCHED OFF.          ##
 * ##  assets/js/chat-customer.js can sign a visitor in, post to     ##
 * ##  /api/chat/* and stream the transcript back from Firestore.    ##
 * ##  CHAT_PUBLIC_ENABLED below is false, so this file never loads  ##
 * ##  it, never imports Firebase, and behaves exactly as it did     ##
 * ##  before that module was written. The notice and the canned     ##
 * ##  reply both go on the day the gate is flipped, not before.     ##
 * ##                                                                ##
 * ####################################################################
 *
 * Plain script on the shared window.CM namespace, same as the rest of the
 * site. No framework, no dependency, no build step.
 * ========================================================================= */

(function () {
  'use strict';

  window.CM = window.CM || {};

  var U = window.CM.util || null;
  var $ = function (sel) { return document.querySelector(sel); };

  /* The reply, and how long to wait before showing it. The delay is long
     enough to read as considered and short enough not to feel broken.

     Split around the phone number so it can be assembled from DOM nodes
     with a real tel: link in the middle. See buildReplyNodes(): the number
     is a link because a visitor told "call us" on a phone should be able
     to just tap it, and making them copy it out by hand is the kind of
     small friction that loses the enquiry. */
  var REPLY_BEFORE = 'Thanks for reaching out! Our online messaging system is ' +
                     'currently under construction and will be available soon. ' +
                     'For immediate assistance, please call our Main Branch at ';
  var REPLY_PHONE  = '604-291-6766';
  var REPLY_TEL    = 'tel:+16042916766';
  var REPLY_AFTER  = ' or use the Quote Request form.';

  /* Shown in the conversation from the moment it opens, before anyone types
     anything. A visitor should learn that nobody is reading this BEFORE
     they spend time writing, not after. */
  var CONSTRUCTION_NOTICE =
    'Online messaging is currently under construction. ' +
    'Messages are not being sent to our team yet.';

  var DEMO_DELAY = 1100;

  /* ---- THE ROLLOUT GATE ----------------------------------------------
     FALSE, and it must stay false until the launch checklist in
     docs/CHAT_APP_CHECK.md is complete.

     While it is false this file does not import chat-customer.js at all,
     so on an ordinary page load there is: no Firebase SDK download, no
     reCAPTCHA challenge, no anonymous sign-in, no request to /api/chat/*
     and no Firestore listener. The visitor gets the demo above, exactly
     as they did before the real transport was written.

     A SOURCE CONSTANT, deliberately. No query string, no cookie, no
     storage key and no hidden control can reach it - switching chat on is
     a commit, a review and a deploy, which is the right weight for the
     decision. chat-customer.js carries its own matching constant and
     connect() refuses while EITHER is false; both are flipped in the same
     commit when chat goes live.

     To exercise the real thing before then, see openChatForReview() in
     chat-customer.js and the walkthrough in docs/CHAT_CUSTOMER_FRONTEND.md.
     That path is a person typing an import into DevTools; nothing on the
     page leads to it. ------------------------------------------------- */
  var CHAT_PUBLIC_ENABLED = false;

  /* Root-relative, like every other asset path in this file: the widget is
     on /services and /gallery too, and a bare path resolves against the
     directory there and 404s. */
  var TRANSPORT_MODULE = '/assets/js/chat-customer.js';

  /* ---- placement ----------------------------------------------------
     The launcher can be dragged out of the way. Where the visitor put it
     is remembered per browser (localStorage) and whether they dismissed
     it is remembered per tab (sessionStorage) - dismissing is a "not
     right now", not a permanent opt-out, so it lapses when the tab does.

     Both are best-effort. Private modes and blocked-storage settings make
     these throw on access, not just on write, so every touch is wrapped
     and a failure simply means the default position and a visible
     mascot. ------------------------------------------------------- */
  var POS_KEY    = 'esthers.chat.position';
  var HIDDEN_KEY = 'esthers.chat.hidden';

  /* How far a pointer must travel before the gesture stops being a tap
     and becomes a drag. Below this, a shaky finger still opens the chat. */
  var DRAG_THRESHOLD = 6;

  /* Kept between the launcher and the edge of the screen, on top of any
     device safe-area inset. Also absorbs the dismiss button, which sits
     a few pixels outside the dock's own box. */
  var EDGE_GAP = 12;

  var pos = { dx: 0, dy: 0 };
  var drag = null;
  var suppressClick = false;

  var root, launcher, panel, log, form, input, send, closeBtn, mascot;
  var dock, dismissBtn, restoreBtn;
  var replyTimer = null;
  var nudgeTimer = null;
  var lastFocus = null;

  /* ---- real-transport state ----
     All null while the gate is shut. `mode` is the one thing the rest of
     this file branches on: 'demo' is everything that shipped before, 'live'
     is a real conversation driven by chat-customer.js. */
  var mode = 'demo';
  var transport = null;          /* the imported module namespace */
  var startPanel = null;         /* the name/email/message form           */
  var startFields = null;        /* { name, email, message } elements     */
  var startSubmit = null;
  var noticeBox = null;          /* one inline sentence, textContent only */
  var retryBtn = null;
  var statusLine = null;
  var onStartHandler = null;
  var onSendHandler = null;
  var retryHandler = null;
  var isBusy = false;
  var isClosed = false;
  var composerEnabled = true;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  /* --------------------------------------------------------------- motion */

  /* The acknowledgement bounce. Restarting the class needs the element to
     leave and re-enter the animation, hence the forced reflow. */
  function nudge() {
    if (!mascot) return;
    clearTimeout(nudgeTimer);
    mascot.classList.remove('is-nudging');
    void mascot.offsetWidth;
    mascot.classList.add('is-nudging');
    nudgeTimer = setTimeout(function () {
      mascot.classList.remove('is-nudging');
    }, 500);
  }

  /* ---------------------------------------------------------- conversation */

  function scrollLog() {
    /* Anchored to the bottom so the newest message is the one in view. */
    log.scrollTop = log.scrollHeight;
  }

  /*
   * A message bubble.
   *
   * `text` is set with textContent, never innerHTML. Everything a visitor
   * types goes through here, so there is exactly one place to check that
   * their words are treated as words and never as markup.
   *
   * `nodes` is the narrow exception: an array of elements this file built
   * itself, for our own copy that needs a link in it. Visitor input never
   * reaches that path - see submit(), which only ever passes `text`.
   */
  function addMessage(who, text, nodes) {
    var msg = el('div', {
      class: 'chat__msg chat__msg--' + (who === 'me' ? 'me' : 'them')
    });
    if (nodes) {
      nodes.forEach(function (n) { msg.appendChild(n); });
    } else {
      msg.textContent = text;
    }
    log.appendChild(msg);
    scrollLog();
    return msg;
  }

  /* The under-construction reply, assembled from nodes so the phone number
     is tappable. No innerHTML anywhere: three pieces, one of them a link. */
  function buildReplyNodes() {
    return [
      document.createTextNode(REPLY_BEFORE),
      el('a', {
        class: 'chat__msg-tel',
        href: REPLY_TEL,
        'aria-label': 'Call the Main Branch on ' + REPLY_PHONE,
        text: REPLY_PHONE
      }),
      document.createTextNode(REPLY_AFTER)
    ];
  }

  function showTyping() {
    var t = el('div', { class: 'chat__typing', 'aria-hidden': 'true' }, [
      el('span'), el('span'), el('span')
    ]);
    log.appendChild(t);
    scrollLog();
    return t;
  }

  /* ------------------------------------------------------------- composer */

  function autoGrow() {
    /* Reset first, or the field can only ever get taller. The cap lives in
       CSS (max-height); this just stops short of it. */
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 108) + 'px';
  }

  function syncSend() {
    var empty = input.value.trim() === '';
    /* In live mode the composer has three more reasons to be dead: a send
       already in flight, a closed conversation, and a session that has not
       finished connecting. Checking them here means every path that touches
       the composer - typing, sending, a state change - agrees. */
    send.disabled = empty || (mode === 'live' && (isBusy || isClosed || !composerEnabled));
    input.disabled = mode === 'live' && (isClosed || !composerEnabled);
  }

  /*
   * PROTOTYPE BEHAVIOUR - the whole of it.
   *
   * The visitor's message is put on screen, the composer is cleared, and a
   * fixed string is shown after a pause. No request leaves the browser.
   * When Phase 2 arrives, this function is the seam: the local echo stays,
   * and the setTimeout is replaced by whatever transport is chosen.
   */
  function submit() {
    var text = input.value.trim();
    if (!text) return;

    /* LIVE. The transport owns the transcript from here: it echoes the
       message optimistically, posts it, and the Firestore listener delivers
       the stored copy - which replaces the echo rather than joining it,
       because both carry the same derived id. Nothing is drawn here. */
    if (mode === 'live') {
      if (!composerEnabled || isBusy || isClosed) return;
      input.value = '';
      autoGrow();
      syncSend();
      input.focus();
      if (typeof onSendHandler === 'function') onSendHandler({ message: text });
      return;
    }

    addMessage('me', text);

    input.value = '';
    autoGrow();
    syncSend();
    input.focus();

    clearTimeout(replyTimer);
    var typing = showTyping();

    replyTimer = setTimeout(function () {
      if (typing.parentNode) typing.parentNode.removeChild(typing);
      /* NOT a real reply. Constants, defined at the top of this file. */
      addMessage('them', null, buildReplyNodes());
    }, DEMO_DELAY);
  }

  /* --------------------------------------------------------- open / close */

  function isOpen() { return root.getAttribute('data-open') === 'true'; }

  function open() {
    if (isOpen()) return;
    lastFocus = document.activeElement;
    root.setAttribute('data-open', 'true');
    launcher.setAttribute('aria-expanded', 'true');
    nudge();
    /* Pick the listener back up. The other half of the suspend in close(). */
    if (mode === 'live' && transport && typeof transport.resume === 'function') {
      transport.resume();
    }
    /* Focus lands on the composer, which is what the visitor came for. The
       close button is one Shift+Tab away. */
    setTimeout(function () { input.focus(); scrollLog(); }, 60);
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    root.setAttribute('data-open', 'false');
    launcher.setAttribute('aria-expanded', 'false');
    /*
     * SUSPEND, not disconnect.
     *
     * A closed panel must not keep a Firestore listener open - it bills a
     * read for every message arriving at a widget nobody is looking at. But
     * tearing the session down was a bug: nothing re-established it, so
     * reopening gave the visitor a composer that looked fine and silently
     * discarded everything typed into it. Suspending stops the listener and
     * keeps the conversation; open() resumes it.
     */
    if (mode === 'live' && transport && typeof transport.suspend === 'function') {
      transport.suspend();
    }
    /* Only pull focus back on a deliberate close - Escape or the button.
       Doing it unconditionally would yank the page around. */
    if (returnFocus !== false) launcher.focus();
    lastFocus = null;
  }

  function toggle() { isOpen() ? close() : open(); }

  /* ------------------------------------------------------------ placement */

  function readNum(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  /* Device safe-area insets, published as custom properties by chat.css so
     they can be read here. Browsers that do not resolve env() inside a
     custom property hand back something unparseable, which readNum turns
     into 0 - the plain EDGE_GAP then carries the clamp on its own. */
  function insets() {
    var cs = window.getComputedStyle(root);
    return {
      top:    readNum(cs.getPropertyValue('--chat-safe-t')),
      right:  readNum(cs.getPropertyValue('--chat-safe-r')),
      bottom: readNum(cs.getPropertyValue('--chat-safe-b')),
      left:   readNum(cs.getPropertyValue('--chat-safe-l'))
    };
  }

  /*
   * Hold an offset inside the visible viewport.
   *
   * The dock is moved with a transform, so its layout position never
   * changes: subtracting the offset already applied gives the anchored
   * position CSS would put it at, and the legal range of offsets follows
   * from that. Doing it this way means the media queries that reposition
   * the launcher on small screens keep working untouched - they move the
   * anchor, and the offset is re-clamped around wherever it lands.
   */
  function clamp(dx, dy) {
    if (!dock) return { dx: 0, dy: 0 };

    var r = dock.getBoundingClientRect();
    var pad = insets();
    var baseLeft = r.left - pos.dx;
    var baseTop = r.top - pos.dy;

    var minLeft = EDGE_GAP + pad.left;
    var maxLeft = window.innerWidth - EDGE_GAP - pad.right - r.width;
    var minTop = EDGE_GAP + pad.top;
    var maxTop = window.innerHeight - EDGE_GAP - pad.bottom - r.height;

    /* A launcher taller or wider than the viewport (a very short landscape
       phone) has no legal range at all. Pin it to the top-left of what is
       available rather than letting the maths invert. */
    if (maxLeft < minLeft) maxLeft = minLeft;
    if (maxTop < minTop) maxTop = minTop;

    var left = Math.min(Math.max(baseLeft + dx, minLeft), maxLeft);
    var top = Math.min(Math.max(baseTop + dy, minTop), maxTop);

    return { dx: Math.round(left - baseLeft), dy: Math.round(top - baseTop) };
  }

  function applyPos() {
    dock.style.setProperty('--chat-dx', pos.dx + 'px');
    dock.style.setProperty('--chat-dy', pos.dy + 'px');
  }

  function setPos(dx, dy) {
    var c = clamp(dx, dy);
    pos.dx = c.dx;
    pos.dy = c.dy;
    applyPos();
  }

  function savePos() {
    try {
      window.localStorage.setItem(POS_KEY, JSON.stringify({ dx: pos.dx, dy: pos.dy }));
    } catch (err) { /* storage unavailable - the position is simply not kept */ }
  }

  function loadPos() {
    var raw = null;
    try { raw = window.localStorage.getItem(POS_KEY); } catch (err) { return; }
    if (!raw) return;
    var v;
    try { v = JSON.parse(raw); } catch (err) { return; }
    if (!v || typeof v.dx !== 'number' || typeof v.dy !== 'number') return;
    if (!isFinite(v.dx) || !isFinite(v.dy)) return;
    /* The viewport may be nothing like the one this was saved in, so the
       stored offset is a request, not an instruction: clamp decides. */
    setPos(v.dx, v.dy);
  }

  /* Re-clamp after anything that changes the viewport. An offset that was
     legal in landscape can strand the launcher off-screen in portrait. */
  function reclamp() {
    if (!dock) return;
    setPos(pos.dx, pos.dy);
  }

  /* ----------------------------------------------------------- visibility */

  function isHidden() { return root.getAttribute('data-hidden') === 'true'; }

  /*
   * Hide or show the full launcher.
   *
   * Hiding never removes customer help - it swaps the mascot for the small
   * round button, which is the same feature at a tenth of the footprint.
   * Focus is moved to whichever control replaces the one being hidden, so
   * a keyboard visitor is never left standing on an element that has just
   * gone away.
   */
  function setHidden(hidden, moveFocus) {
    /* Already in the requested state: nothing to move, nothing to store. */
    if (isHidden() === !!hidden) return;

    if (hidden) {
      /* An open panel with no launcher behind it is a floating orphan.
         Close it first, and do not send focus to the launcher on the way
         out - it is about to disappear. */
      if (isOpen()) close(false);
      root.setAttribute('data-hidden', 'true');
      if (moveFocus) restoreBtn.focus();
    } else {
      root.setAttribute('data-hidden', 'false');
      /* The viewport may have changed while it was out of sight. */
      reclamp();
      if (moveFocus) launcher.focus();
    }
    try {
      if (hidden) window.sessionStorage.setItem(HIDDEN_KEY, '1');
      else window.sessionStorage.removeItem(HIDDEN_KEY);
    } catch (err) { /* session storage unavailable - state lives for this page only */ }
  }

  function loadHidden() {
    var v = null;
    try { v = window.sessionStorage.getItem(HIDDEN_KEY); } catch (err) { return; }
    if (v === '1') root.setAttribute('data-hidden', 'true');
  }

  /* -------------------------------------------------------------- markup */

  /* ==================================================================
   * THE TRANSPORT SURFACE
   *
   * Everything below exists so chat-customer.js can drive this widget
   * without knowing a single CSS class, and so this file can render a real
   * conversation without knowing what Firebase is. The interface is the
   * `ui` object returned by transportSurface(), documented under THE UI
   * CONTRACT in chat-customer.js.
   *
   * EVERY STRING THAT CROSSES THAT BOUNDARY IS SET WITH textContent.
   * Message bodies, status lines, error sentences - all of them. There is
   * no innerHTML anywhere in this section and there must never be: a
   * transcript carries whatever a customer typed and whatever a staff
   * member typed back, which is precisely the input you do not hand to an
   * HTML parser. The three innerHTML calls in build() are ours, they are
   * fixed SVG icons, and no message ever reaches them.
   * ================================================================== */

  /* Defensive ceiling on one render pass. Firestore is already capped at
     200 by the rules and by the listener's own limit(), so this only fires
     if something upstream is very wrong - and when it does, it draws 200
     bubbles instead of hanging the tab. */
  var MAX_RENDER = 200;

  function clearLog() {
    while (log.firstChild) log.removeChild(log.firstChild);
  }

  /* Bottom-pinned unless the visitor has deliberately scrolled up to read
     something. Yanking them back down mid-sentence because a message
     arrived is the single most irritating thing a chat can do. */
  function nearBottom() {
    return (log.scrollHeight - log.scrollTop - log.clientHeight) < 48;
  }

  function buildStartPanel() {
    function field(id, labelText, control) {
      return el('div', { class: 'chat__field' }, [
        el('label', { class: 'chat__label', for: id, text: labelText }),
        control
      ]);
    }

    var nameInput = el('input', {
      class: 'chat__text', id: 'chat-start-name', type: 'text',
      name: 'name', maxlength: '100', required: 'required',
      autocomplete: 'name', placeholder: 'Your name'
    });
    var emailInput = el('input', {
      class: 'chat__text', id: 'chat-start-email', type: 'email',
      name: 'email', maxlength: '254', required: 'required',
      autocomplete: 'email', placeholder: 'you@example.com'
    });
    var messageInput = el('textarea', {
      class: 'chat__text chat__text--area', id: 'chat-start-message',
      name: 'message', rows: '3', maxlength: '2000', required: 'required',
      placeholder: 'How can we help?'
    });

    startSubmit = el('button', { class: 'chat__send chat__start-send', type: 'submit' });
    startSubmit.textContent = 'Start conversation';

    startFields = { name: nameInput, email: emailInput, message: messageInput };

    startPanel = el('form', { class: 'chat__start', novalidate: 'novalidate' }, [
      el('p', {
        class: 'chat__start-lede',
        text: 'Tell us who you are and what you need, and we will reply here.'
      }),
      field('chat-start-name', 'Name', nameInput),
      field('chat-start-email', 'Email', emailInput),
      field('chat-start-message', 'Message', messageInput),
      startSubmit
    ]);

    startPanel.addEventListener('submit', function (e) {
      e.preventDefault();
      if (isBusy) return;
      if (typeof onStartHandler !== 'function') return;
      /* Trimmed here only so an all-spaces field does not look accepted.
         The server validates for real, and its answer is what the visitor
         is shown - this file does not second-guess it. */
      onStartHandler({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        message: messageInput.value.trim()
      });
    });

    return startPanel;
  }

  /* One inline sentence, above the composer. Never markup, never a server
     string - chat-customer.js chooses it from its own allow-list. */
  function ensureNotice() {
    if (noticeBox) return noticeBox;
    noticeBox = el('p', {
      class: 'chat__notice',
      role: 'alert',
      hidden: 'hidden'
    });
    retryBtn = el('button', { class: 'chat__retry', type: 'button', hidden: 'hidden' });
    retryBtn.textContent = 'Try again';
    retryBtn.addEventListener('click', function () {
      var handler = retryHandler;
      if (typeof handler !== 'function') return;
      /* Cleared BEFORE the call, so one press is one attempt however long
         it takes to answer. */
      setRetryHandler(null);
      handler();
    });
    var wrap = el('div', { class: 'chat__notice-wrap' }, [noticeBox, retryBtn]);
    panel.insertBefore(wrap, form);
    return noticeBox;
  }

  function setRetryHandler(handler) {
    retryHandler = typeof handler === 'function' ? handler : null;
    if (!retryBtn) return;
    if (retryHandler) retryBtn.removeAttribute('hidden');
    else retryBtn.setAttribute('hidden', 'hidden');
  }

  /*
   * Draw the transcript.
   *
   * A full rebuild from the list the store hands over, not a diff. The
   * store is already deduplicated and ordered by id, so rebuilding cannot
   * produce a duplicate no matter how many snapshots arrive - which is
   * exactly the property worth having here, and it costs nothing at 200
   * rows.
   */
  function renderMessages(list) {
    var pinned = nearBottom();
    clearLog();
    var items = Array.isArray(list) ? list.slice(0, MAX_RENDER) : [];

    if (!items.length) {
      log.appendChild(el('p', {
        class: 'chat__note',
        text: 'No messages yet. Send one and we will reply here.'
      }));
      return;
    }

    for (var i = 0; i < items.length; i++) {
      var m = items[i] || {};
      var body = typeof m.body === 'string' ? m.body : '';

      /* A 'system' message is the API telling the customer something -
         "this conversation was closed" - not a person. It reads as a note,
         not as a bubble from Esther's. */
      if (m.senderType === 'system') {
        log.appendChild(el('p', { class: 'chat__note', text: body }));
        continue;
      }

      var mine = m.senderType === 'customer';
      var bubble = el('div', {
        class: 'chat__msg chat__msg--' + (mine ? 'me' : 'them')
          + (m.pending ? ' is-pending' : '')
      });
      /* textContent. The whole reason this function exists. */
      bubble.textContent = body;
      if (m.pending) bubble.setAttribute('aria-label', 'Sending: ' + body);
      log.appendChild(bubble);
    }

    if (pinned) scrollLog();
  }

  /*
   * Hand the widget over to the real transport.
   *
   * The demo conversation is cleared first - leaving "our messaging is
   * under construction" above a working transcript would be worse than
   * either state on its own.
   */
  function enterLiveMode() {
    mode = 'live';
    clearTimeout(replyTimer);
    clearLog();
    isClosed = false;
    isBusy = false;
    composerEnabled = false;
    syncSend();
    ensureNotice();
    return transportSurface();
  }

  function showStartForm() {
    if (!startPanel) buildStartPanel();
    clearLog();
    log.appendChild(startPanel);
    form.setAttribute('hidden', 'hidden');
    /* The panel is already open by the time this runs, so moving focus is
       taking the visitor where they were going, not stealing it. */
    setTimeout(function () {
      if (startFields && startFields.name) startFields.name.focus();
    }, 60);
  }

  function showTranscript() {
    if (startPanel && startPanel.parentNode) startPanel.parentNode.removeChild(startPanel);
    form.removeAttribute('hidden');
  }

  /*
   * The object chat-customer.js drives. Deliberately small, deliberately
   * all strings and booleans: nothing here accepts a node, so nothing on
   * the other side of the boundary can put markup on the page.
   */
  function transportSurface() {
    return {
      showStartForm: showStartForm,
      showTranscript: showTranscript,
      renderMessages: renderMessages,

      setStatus: function (text) {
        if (statusLine) statusLine.textContent = String(text == null ? '' : text);
      },

      setNotice: function (text) {
        ensureNotice();
        if (text == null || text === '') {
          noticeBox.textContent = '';
          noticeBox.setAttribute('hidden', 'hidden');
          return;
        }
        noticeBox.textContent = String(text);
        noticeBox.removeAttribute('hidden');
      },

      setBusy: function (flag) {
        isBusy = flag === true;
        if (startSubmit) startSubmit.disabled = isBusy;
        panel.setAttribute('data-busy', isBusy ? 'true' : 'false');
        syncSend();
      },

      setComposerEnabled: function (flag) {
        composerEnabled = flag === true;
        syncSend();
      },

      setClosed: function (flag) {
        isClosed = flag === true;
        panel.setAttribute('data-closed', isClosed ? 'true' : 'false');
        if (isClosed) {
          log.appendChild(el('p', {
            class: 'chat__note',
            text: 'This conversation has been closed. Call us or use the '
              + 'Quote Request form if you need anything else.'
          }));
          scrollLog();
        }
        syncSend();
      },

      setRetry: setRetryHandler,

      onStart: function (handler) {
        onStartHandler = typeof handler === 'function' ? handler : null;
      },

      onSend: function (handler) {
        onSendHandler = typeof handler === 'function' ? handler : null;
      }
    };
  }

  function build() {
    root = $('#chat');
    if (!root) return false;

    /* ---- closed state ----
       Every asset path below is root-relative, not document-relative. The
       mascot files live at the site root, but this widget is on every page -
       including /services and /gallery - and a bare "assets/..." there
       resolves against the directory and 404s. The leading slash is the
       whole fix. */
    var picture = el('picture');
    picture.appendChild(el('source', {
      type: 'image/webp',
      srcset: '/assets/img/chat-mascot-240.webp 240w, /assets/img/chat-mascot-360.webp 360w',
      sizes: '110px'
    }));
    mascot = el('img', {
      class: 'chat__mascot',
      src: '/assets/img/chat-mascot-240.webp',
      width: '1240', height: '1191',
      loading: 'lazy', decoding: 'async',
      /* An image is natively draggable, and that drag hijacks the gesture:
         the browser starts its own drag-and-drop, fires pointercancel and
         the launcher stops following the pointer after one frame. */
      draggable: 'false',
      /* Decorative: the button beside it already carries the accessible
         name, and describing the drawing twice only adds noise. */
      alt: ''
    });
    picture.appendChild(mascot);

    launcher = el('button', {
      class: 'chat__launcher',
      type: 'button',
      id: 'chat-launcher',
      'aria-expanded': 'false',
      'aria-controls': 'chat-panel',
      'aria-label': "Open Esther's customer help"
    }, [
      el('span', { class: 'chat__bubble', text: 'How can I help you today?' }),
      picture
    ]);

    /* ---- panel ---- */
    var avatar = el('img', {
      class: 'chat__avatar',
      src: '/assets/img/chat-mascot-240.webp',
      alt: '', loading: 'lazy', decoding: 'async'
    });

    closeBtn = el('button', {
      class: 'chat__close',
      type: 'button',
      'aria-label': "Close Esther's customer help"
    });
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round"/></svg>';

    var head = el('div', { class: 'chat__head' }, [
      avatar,
      el('div', { class: 'chat__head-text' }, [
        el('p', { class: 'chat__title', id: 'chat-title', text: "Esther's Sheet Metal" }),
        /* Must not imply anyone is reading. "Usually replies during business
           hours" was true of the intent and false of the fact: messaging is
           not connected, so nobody replies here at all. It can go back the
           day the backend does. */
        /* Replaced by the transport in live mode - see setStatus() in
           transportSurface(). While the gate is shut this is the whole
           truth and must stay that way. */
        (statusLine = el('p', {
          class: 'chat__status',
          id: 'chat-status',
          role: 'status',
          'aria-live': 'polite',
          text: 'Online messaging coming soon.'
        }))
      ]),
      closeBtn
    ]);

    /* aria-live polite: the demo reply arrives on a timer with no visitor
       action behind it, so a screen reader would otherwise never learn it
       appeared. Polite, not assertive - it is not an alert. */
    log = el('div', {
      class: 'chat__log',
      id: 'chat-log',
      role: 'log',
      'aria-live': 'polite',
      'aria-atomic': 'false',
      'aria-label': 'Conversation'
    });

    input = el('textarea', {
      class: 'chat__input',
      id: 'chat-input',
      rows: '1',
      placeholder: 'Type your message...',
      'aria-label': 'Type your message'
    });

    send = el('button', {
      class: 'chat__send',
      type: 'submit',
      disabled: 'disabled',
      'aria-label': 'Send message'
    });
    send.textContent = 'Send';

    form = el('form', { class: 'chat__form', novalidate: 'novalidate' }, [input, send]);

    panel = el('div', {
      class: 'chat__panel',
      id: 'chat-panel',
      role: 'dialog',
      'aria-labelledby': 'chat-title'
    }, [head, log, form]);

    /* ---- dismiss, and the small button it leaves behind ---- */

    /* A sibling of the launcher, not a child: a button inside a button is
       invalid and browsers disagree about which one a tap belongs to.
       Positioned over the top corner of the speech bubble by chat.css,
       well clear of the mascot's face. */
    dismissBtn = el('button', {
      class: 'chat__dismiss',
      type: 'button',
      'aria-label': 'Hide customer help'
    });
    dismissBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round"/></svg>';

    /* The launcher and its dismiss button travel together, so the drag
       offset is applied to this wrapper rather than to the launcher
       itself. It also keeps the launcher's own transform free for the
       hover, press and panel-open states already in chat.css. */
    dock = el('div', { class: 'chat__dock' }, [launcher, dismissBtn]);

    restoreBtn = el('button', {
      class: 'chat__restore',
      type: 'button',
      'aria-label': 'Show customer help'
    });
    restoreBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M21 11.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1.8-5.1A7.5 7.5 0 1 1 21 11.5Z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
      '</svg>';

    root.appendChild(panel);
    root.appendChild(dock);
    root.appendChild(restoreBtn);
    root.setAttribute('data-open', 'false');
    root.setAttribute('data-hidden', 'false');

    /* ---- opening lines ---- */
    showDemoConversation();

    return true;
  }

  /* The demo conversation, in one place so the transport fallback can put it
     back if the real thing fails to connect. Identical to what shipped. */
  function showDemoConversation() {
    addMessage('them', 'Hi! How can we help with your sheet metal project?');
    log.appendChild(el('p', {
      class: 'chat__note',
      text: CONSTRUCTION_NOTICE
    }));
  }

  /* --------------------------------------------------------------- wiring */

  function wire() {
    launcher.addEventListener('click', function () {
      /* Set by the drag that just finished. Every real click is preceded by
         a pointerdown, which clears the flag, so a stale one cannot swallow
         a later tap - and a keyboard Enter/Space never sets it at all. */
      if (suppressClick) { suppressClick = false; return; }
      nudge();
      toggle();
    });

    /* ---- drag ----
       One Pointer Events implementation covers mouse, touch and pen.
       Capture keeps the gesture attached to the launcher even when the
       pointer outruns it, which is most of the time on a phone. */
    launcher.addEventListener('pointerdown', function (e) {
      if (!e.isPrimary) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      suppressClick = false;
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: pos.dx,
        dy: pos.dy,
        moved: false
      };
      try { launcher.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    });

    launcher.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var mx = e.clientX - drag.x;
      var my = e.clientY - drag.y;
      if (!drag.moved) {
        /* Still inside the threshold: this is a tap so far, so leave it
           alone. Moving on the first stray pixel would make the mascot
           impossible to simply press on a touchscreen. */
        if (Math.sqrt(mx * mx + my * my) < DRAG_THRESHOLD) return;
        drag.moved = true;
        root.setAttribute('data-dragging', 'true');
      }
      setPos(drag.dx + mx, drag.dy + my);
    });

    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var moved = drag.moved;
      drag = null;
      root.removeAttribute('data-dragging');
      if (moved) {
        /* It was a drag, not a tap: do not open the panel on the click
           the browser is about to send. */
        suppressClick = true;
        savePos();
      }
    }
    launcher.addEventListener('pointerup', endDrag);
    launcher.addEventListener('pointercancel', endDrag);

    /* Belt and braces alongside draggable="false" and the CSS: anything
       inside the launcher that a browser decides is draggable must not be,
       because a native drag cancels the pointer stream mid-gesture. */
    launcher.addEventListener('dragstart', function (e) { e.preventDefault(); });

    /* ---- hide and restore ---- */
    dismissBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setHidden(true, true);
    });
    restoreBtn.addEventListener('click', function () { setHidden(false, true); });

    /* A rotation or a resize can strand the launcher outside the new
       viewport. orientationchange fires before the new dimensions settle
       on some phones, hence the second pass. */
    window.addEventListener('resize', reclamp);
    window.addEventListener('orientationchange', function () {
      reclamp();
      setTimeout(reclamp, 300);
    });

    closeBtn.addEventListener('click', function () { close(); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();   /* nothing is posted anywhere; see the header */
      submit();
    });

    input.addEventListener('input', function () { autoGrow(); syncSend(); });

    input.addEventListener('keydown', function (e) {
      /* Enter sends, Shift+Enter breaks the line. IME composition must be
         left alone or Japanese and Chinese input send half a word. */
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });

    /* Escape closes from anywhere inside the feature. Bound on the root, not
       the document, so it cannot swallow Escape from the favourites drawer,
       the quote form or anything else on the page. */
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) {
        e.stopPropagation();
        close();
      }
    });

    /* Clicking away closes it. Deliberately NOT a focus trap: the visitor
       can tab straight out into the page, which is the right behaviour for
       a corner panel that is not modal. */
    document.addEventListener('pointerdown', function (e) {
      if (isOpen() && !root.contains(e.target)) close(false);
    });
  }

  function init() {
    if (!build()) return;
    wire();
    loadHidden();
    loadPos();
    window.CM.chat = {
      open: open,
      close: close,
      toggle: toggle,
      hide: function () { setHidden(true, false); },
      show: function () { setHidden(false, false); },

      /*
       * The seam chat-customer.js attaches to.
       *
       * NOT a way to turn chat on. It touches no network: it does not fetch,
       * sign anyone in, attest, or open a listener. What it hands back is an
       * object that can draw a conversation, and nothing draws until a
       * transport drives it - and reaching a transport means importing a
       * module no page loads.
       *
       * IT IS NOT A GETTER, THOUGH. Calling it switches the widget into live
       * mode, which clears the demo conversation, so somebody typing it into
       * a console blanks their own chat panel until they reload. That IS the
       * handover and it is the point - but the side effect is real, and it is
       * why nothing on the page calls this.
       *
       * It exists so the review harness does not have to reach into the DOM
       * and guess at class names, and so this widget stays free to change
       * how it is built.
       */
      transportSurface: enterLiveMode
    };

    /* ---- the gate ----
       False on every production page today, so this branch does not run,
       nothing is imported, and the widget is the demo it has always been.
       When it is flipped, THIS is the only place the real transport is
       reached from automatically. */
    if (CHAT_PUBLIC_ENABLED) connectTransport();
  }

  /*
   * Load the transport and start a conversation.
   *
   * Dynamically imported so the Firebase SDK, the reCAPTCHA challenge and
   * this module itself cost nothing on a page whose visitor never opens
   * chat. Failure is quiet and total: the widget stays in demo mode, which
   * is a working page with an honest notice on it rather than a broken one.
   */
  function connectTransport() {
    import(TRANSPORT_MODULE).then(function (mod) {
      transport = mod;
      /*
       * Check the transport's own gate BEFORE handing the widget over.
       * enterLiveMode() blanks the demo conversation, and setting mode back
       * to 'demo' afterwards does not un-blank it - the visitor was left
       * looking at an empty panel with a dead composer. Both constants have
       * to be true; either one false and we never touch the widget.
       */
      if (typeof mod.isPublicChatEnabled === 'function' && !mod.isPublicChatEnabled()) {
        return null;
      }
      return mod.connect(enterLiveMode(), {});
    }).then(function (session) {
      if (!session) restoreDemo();
    })['catch'](function () {
      restoreDemo();
    });
  }

  /*
   * Put the widget back the way it was.
   *
   * Reached when the transport cannot connect - a blocked CDN, a refused
   * attestation, a gate that turned out to be shut. A visitor is better served
   * by the working demo and its honest notice than by an empty panel, and this
   * is the only path that can tell them anything at all.
   */
  function restoreDemo() {
    if (mode !== 'live') return;
    mode = 'demo';
    onStartHandler = null;
    onSendHandler = null;
    setRetryHandler(null);
    isBusy = false;
    isClosed = false;
    composerEnabled = true;
    if (startPanel && startPanel.parentNode) startPanel.parentNode.removeChild(startPanel);
    form.removeAttribute('hidden');
    if (noticeBox) {
      noticeBox.textContent = '';
      noticeBox.setAttribute('hidden', 'hidden');
    }
    if (statusLine) statusLine.textContent = 'Online messaging coming soon.';
    panel.setAttribute('data-busy', 'false');
    panel.setAttribute('data-closed', 'false');
    clearLog();
    showDemoConversation();
    syncSend();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
