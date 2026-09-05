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
 * ##  Phase 2 decides how messages actually reach the shop and how  ##
 * ##  staff replies come back. Nothing here presumes that answer:   ##
 * ##  submit() is the single place a real transport would go, and   ##
 * ##  the notice and the reply both come out on the same day.       ##
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
    send.disabled = input.value.trim() === '';
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
    /* Focus lands on the composer, which is what the visitor came for. The
       close button is one Shift+Tab away. */
    setTimeout(function () { input.focus(); scrollLog(); }, 60);
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    root.setAttribute('data-open', 'false');
    launcher.setAttribute('aria-expanded', 'false');
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
        el('p', { class: 'chat__status', text: 'Online messaging coming soon.' })
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
    addMessage('them', 'Hi! How can we help with your sheet metal project?');
    log.appendChild(el('p', {
      class: 'chat__note',
      text: CONSTRUCTION_NOTICE
    }));

    return true;
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
      show: function () { setHidden(false, false); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
