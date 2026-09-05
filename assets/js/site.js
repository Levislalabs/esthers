/*
 * site.js - the shell behaviour shared by every page.
 *
 * Deliberately tiny, and deliberately not required for the site to work.
 * The navigation is real markup and real links: with JavaScript off, the
 * only thing lost on a phone is the collapse, and the menu simply shows.
 * Nothing here renders content.
 *
 * ---------------------------------------------------------------------
 * WHY EVERY INTERNAL LINK ON THIS SITE HAS NO TRAILING SLASH
 *
 * work.js and chat.js hold their image paths RELATIVELY - 'assets/img/...'
 * rather than '/assets/img/...'. A document served at /gallery resolves
 * those against the root and they load. The same document served at
 * /gallery/ resolves them against /gallery/ and eight images 404.
 *
 * vercel.json sets "trailingSlash": false, so Vercel redirects /gallery/
 * to /gallery and production never renders the broken form. That is what
 * makes the relative paths safe - not luck, but it IS a coupling, so:
 * every href here and in the page markup is slash-free, and the canonical
 * URLs match. If that Vercel setting ever changes, make the paths in
 * work.js and chat.js root-absolute first.
 * ---------------------------------------------------------------------
 */
(function () {
  'use strict';

  /*
   * Legacy anchors from the single-page site.
   *
   * The homepage used to hold every section, so /#compare and /#contact
   * were real destinations and may be bookmarked or linked. Those sections
   * live on their own pages now. Rather than leave someone on a homepage
   * that quietly ignores their anchor, send them where the thing actually
   * is - and keep the sub-anchor where the target page still has one.
   *
   * Only runs on the homepage, and only for hashes the old page really had.
   */
  var LEGACY = {
    '#materials': '/materials',
    '#patina':    '/materials#patina',
    '#zinc':      '/materials#zinc',
    '#compare':   '/materials#compare',
    '#work':      '/gallery',
    '#services':  '/services',
    '#quote':     '/quote',
    '#contact':   '/contact',
    '#process':   '/quote'
  };

  if (location.pathname === '/' || location.pathname === '/index.html') {
    var target = LEGACY[location.hash];
    /* replace(), not assign(): the old anchor should not sit in the history
       and send the reader straight back here when they press Back. */
    if (target) location.replace(target);
  }

  /* The footer year. Every page carries the same span. */
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* Mobile menu. The button is hidden by CSS above 940px, so this wires up
     nothing visible on a desktop. */
  var toggle = document.getElementById('navtoggle');
  var nav = document.getElementById('sitenav');

  if (toggle && nav) {
    var setOpen = function (open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };

    toggle.addEventListener('click', function () {
      setOpen(!nav.classList.contains('is-open'));
    });

    /* Following a link should not leave the drawer open behind the new page
       on a browser that restores scroll position. */
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        setOpen(false);
        toggle.focus();
      }
    });

    /* Coming back to a desktop width should not leave the drawer state
       stuck on. */
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width: 941px)');
      var onChange = function (m) { if (m.matches) setOpen(false); };
      if (wide.addEventListener) wide.addEventListener('change', onChange);
      else if (wide.addListener) wide.addListener(onChange);
    }
  }
}());
