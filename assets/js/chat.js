/* =========================================================================
 * Esther's - customer help launcher and messaging panel
 *
 * ####################################################################
 * ##                                                                ##
 * ##  PROTOTYPE ONLY. THIS SENDS NOTHING ANYWHERE.                  ##
 * ##                                                                ##
 * ##  There is no fetch, no XHR, no WebSocket, no form action, no   ##
 * ##  mailto, no third-party SDK and no storage in this file. A     ##
 * ##  message typed here exists in one browser tab and is gone on   ##
 * ##  reload. NOBODY AT ESTHER'S RECEIVES IT.                       ##
 * ##                                                                ##
 * ##  The reply is a hard-coded string on a setTimeout - see        ##
 * ##  DEMO_REPLY below. It is worded to say so out loud, and a      ##
 * ##  standing notice sits in the conversation saying the same      ##
 * ##  thing, so a visitor cannot mistake it for a person.           ##
 * ##                                                                ##
 * ##  Phase 2 decides how messages actually reach the shop and how  ##
 * ##  staff replies come back. Nothing here presumes that answer:   ##
 * ##  send() is the single place a real transport would go.         ##
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

  /* The demo reply, and how long to wait before showing it. The delay is
     long enough to read as considered and short enough not to feel broken. */
  var DEMO_REPLY = "Thanks! This is a preview of the Esther's messaging system.";
  var DEMO_DELAY = 1100;

  var root, launcher, panel, log, form, input, send, closeBtn, mascot;
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

  function addMessage(who, text) {
    var msg = el('div', {
      class: 'chat__msg chat__msg--' + (who === 'me' ? 'me' : 'them'),
      text: text
    });
    log.appendChild(msg);
    scrollLog();
    return msg;
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
      /* NOT a real reply. A constant, defined at the top of this file. */
      addMessage('them', DEMO_REPLY);
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

  /* -------------------------------------------------------------- markup */

  function build() {
    root = $('#chat');
    if (!root) return false;

    /* ---- closed state ---- */
    var picture = el('picture');
    picture.appendChild(el('source', {
      type: 'image/webp',
      srcset: 'assets/img/chat-mascot-240.webp 240w, assets/img/chat-mascot-360.webp 360w',
      sizes: '110px'
    }));
    mascot = el('img', {
      class: 'chat__mascot',
      src: 'assets/img/chat-mascot-240.webp',
      width: '1240', height: '1191',
      loading: 'lazy', decoding: 'async',
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
      src: 'assets/img/chat-mascot-240.webp',
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
        /* Deliberately not "online now" or "replies instantly" - neither is
           true, and neither will be true until Phase 2 says so. */
        el('p', { class: 'chat__status', text: 'Usually replies during business hours.' })
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

    root.appendChild(panel);
    root.appendChild(launcher);
    root.setAttribute('data-open', 'false');

    /* ---- opening lines ---- */
    addMessage('them', 'Hi! How can we help with your sheet metal project?');
    log.appendChild(el('p', {
      class: 'chat__note',
      text: "Preview only - messages are not sent to Esther's yet."
    }));

    return true;
  }

  /* --------------------------------------------------------------- wiring */

  function wire() {
    launcher.addEventListener('click', function () { nudge(); toggle(); });

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
    window.CM.chat = { open: open, close: close, toggle: toggle };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
