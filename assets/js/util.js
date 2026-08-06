/*
 * util.js — colour maths, DOM helpers and the icon set.
 * Loaded before every other script; no dependencies.
 */
window.CM = window.CM || {};

(function (CM) {
  'use strict';

  /* ------------------------------------------------------------ colour */

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    var v = (1 << 24) + (Math.round(clamp(r, 0, 255)) << 16) +
            (Math.round(clamp(g, 0, 255)) << 8) + Math.round(clamp(b, 0, 255));
    return '#' + v.toString(16).slice(1);
  }

  /*
   * shade(hex, amount)
   * amount > 0 lightens toward white, < 0 darkens toward black.
   * Lightening biases slightly warm and desaturates a touch, which is how a
   * real painted surface behaves under a highlight rather than a flat tint.
   */
  function shade(hex, amount) {
    var c = hexToRgb(hex);
    if (amount >= 0) {
      var t = amount;
      return rgbToHex(
        c.r + (255 - c.r) * t * 1.00,
        c.g + (255 - c.g) * t * 0.97,
        c.b + (255 - c.b) * t * 0.92
      );
    }
    var d = 1 + amount; /* amount is negative */
    return rgbToHex(c.r * d, c.g * d * 0.99, c.b * d * 1.02);
  }

  /* Perceived luminance, 0-1. Used to decide light-on-dark vs dark-on-light. */
  function luminance(hex) {
    var c = hexToRgb(hex);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  function isLight(hex) { return luminance(hex) > 0.62; }

  function rgba(hex, alpha) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
  }

  /*
   * Build the face palette used by every rendered product.
   * Metallic finishes get a wider spread between highlight and shadow, which
   * is what makes a flake finish read as metal rather than flat paint.
   */
  function palette(hex, metallic) {
    var k = metallic ? 1.35 : 1;
    return {
      base:   hex,
      spec:   shade(hex, clamp(0.66 * k, 0, 0.88)),
      topHi:  shade(hex, clamp(0.40 * k, 0, 0.80)),
      top:    shade(hex, clamp(0.22 * k, 0, 0.66)),
      front:  shade(hex, -0.05),
      side:   shade(hex, -0.24 * k),
      deep:   shade(hex, -0.42 * k),
      dark:   shade(hex, -0.58),
      edge:   shade(hex, clamp(0.55 * k, 0, 0.86)),
      shadow: shade(hex, -0.72),
      metallic: !!metallic
    };
  }

  /* ---------------------------------------------------------------- dom */

  /*
   * Custom properties have to go through setProperty — assigning them onto a
   * CSSStyleDeclaration silently does nothing, which shows up as every swatch
   * falling back to its default colour.
   */
  function setStyle(node, styles) {
    Object.keys(styles).forEach(function (prop) {
      var val = styles[prop];
      if (val === null || val === undefined) return;
      if (prop.slice(0, 2) === '--') node.style.setProperty(prop, val);
      else node.style[prop] = val;
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') setStyle(node, v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* Normalizes for search: case- and accent-insensitive. */
  function norm(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ------------------------------------------------------------ storage */

  /* localStorage is unavailable in some privacy modes — degrade to memory. */
  var memoryStore = {};
  var store = {
    get: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return key in memoryStore ? memoryStore[key] : fallback;
      }
    },
    set: function (key, value) {
      memoryStore[key] = value;
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* memory only */ }
    }
  };

  /* -------------------------------------------------------------- icons */

  var ICONS = {
    heart:   '<path d="M12 20.5 4.3 13a4.6 4.6 0 0 1 6.5-6.5l1.2 1.2 1.2-1.2A4.6 4.6 0 0 1 19.7 13Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    search:  '<circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="m15.2 15.2 4.3 4.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    close:   '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    check:   '<path d="m5 12.5 4.6 4.6L19 7.4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
    copy:    '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    arrow:   '<path d="M4 12h15m-5.5-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    eye:     '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    trash:   '<path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 12.5h9L17.5 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    price:   '<path d="M12 3v18M8 7.5A3 3 0 0 1 11 5h2.5a2.75 2.75 0 0 1 0 5.5h-3a2.75 2.75 0 0 0 0 5.5H13a3 3 0 0 0 3-2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    weight:  '<path d="M5 20 7.5 8.5h9L19 20Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="6" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    shield:  '<path d="M12 3.2 19 6v6c0 4.4-3 7.5-7 8.8-4-1.3-7-4.4-7-8.8V6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m9 12 2 2.2L15.2 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    certificate: '<rect x="4" y="3.6" width="16" height="12.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 8h8M8 11.5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="m9.5 16.2-.8 4.3 3.3-1.8 3.3 1.8-.8-4.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    sun:     '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    diamond: '<path d="M12 3 21 10l-9 11L3 10Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 10h18M12 3 8 10l4 11 4-11Z" fill="none" stroke="currentColor" stroke-width="1.3"/>',
    droplet: '<path d="M12 3.2c3.6 4 6 6.9 6 9.8a6 6 0 0 1-12 0c0-2.9 2.4-5.8 6-9.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    wave:    '<path d="M2.5 9.5c2.4-2.6 4.8-2.6 7.2 0s4.8 2.6 7.2 0 2.9-1.9 4.6-.6M2.5 15c2.4-2.6 4.8-2.6 7.2 0s4.8 2.6 7.2 0 2.9-1.9 4.6-.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    clock:   '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v5.3l3.4 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    wrench:  '<path d="M15.6 3.6a5.2 5.2 0 0 0-5.9 6.7L3.6 16.4a2 2 0 0 0 2.8 2.8l6.1-6.1a5.2 5.2 0 0 0 6.7-5.9l-3 3-2.6-2.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    compass: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m15.4 8.6-2 4.8-4.8 2 2-4.8Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    star:    '<path d="m12 3.4 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.9l6.1-.9Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    heal:    '<path d="M12 3.5v17M3.5 12h17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 3"/>',
    hourglass: '<path d="M7 3.5h10M7 20.5h10M7.5 3.5c0 4.5 4.5 5.2 4.5 8.5s-4.5 4-4.5 8.5M16.5 3.5c0 4.5-4.5 5.2-4.5 8.5s4.5 4 4.5 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    leaf:    '<path d="M20 4.2C10.5 3.4 4.6 7.6 4.6 14a5.4 5.4 0 0 0 5.4 5.4C16.4 19.4 20.6 13.6 20 4.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M16.2 8 6.4 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    gem:     '<path d="M6.5 4h11l3.5 5.2L12 20.5 1 9.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" transform="translate(1)"/>'
  };

  function icon(name, cls) {
    var body = ICONS[name] || '';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : '') + '>' + body + '</svg>';
  }

  /* ------------------------------------------------------------- export */

  CM.util = {
    clamp: clamp,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    shade: shade,
    luminance: luminance,
    isLight: isLight,
    rgba: rgba,
    palette: palette,
    el: el,
    $: $,
    $$: $$,
    slug: slug,
    norm: norm,
    debounce: debounce,
    prefersReducedMotion: prefersReducedMotion,
    store: store,
    icon: icon
  };
})(window.CM);
