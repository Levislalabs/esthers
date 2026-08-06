/*
 * render.js — SVG scene generation for the copper patina timeline and the
 * zinc finish renderings.
 *
 * Each scene is built from flat polygons filled with colour-derived gradients,
 * then overlaid with a sky/ground reflection ramp, a specular sweep and a fine
 * grain filter. Changing the source colour rebuilds the gradient stops, so a
 * scene re-lights in one frame without any asset swapping.
 */
window.CM = window.CM || {};

(function (CM) {
  'use strict';

  var U = CM.util;
  var uid = 0;

  /* --------------------------------------------------------- primitives */

  function pts(list) {
    return list.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
  }

  function poly(points, fill, extra) {
    return '<polygon points="' + pts(points) + '" fill="' + fill + '"' + (extra || '') + '/>';
  }

  /* Masonry palette is deliberately neutral so the metal colour stays the
     subject of the render rather than competing with the brick. */
  var BRICK = {
    front: '#4a4238', side: '#372f28', top: '#5b5147',
    mortar: '#2b241f', shadow: '#151312'
  };

  /*
   * Shared <defs>: face gradients, environment reflection, specular sweep,
   * grain filter and a soft contact shadow.
   */
  function defs(id, p) {
    var m = p.metallic;
    return [
      '<defs>',
      '<linearGradient id="', id, '-top" x1="0.05" y1="0" x2="0.9" y2="1">',
        '<stop offset="0" stop-color="', p.topHi, '"/>',
        '<stop offset="0.46" stop-color="', p.top, '"/>',
        '<stop offset="1" stop-color="', p.base, '"/>',
      '</linearGradient>',

      '<linearGradient id="', id, '-front" x1="0" y1="0" x2="0.25" y2="1">',
        '<stop offset="0" stop-color="', p.top, '"/>',
        '<stop offset="0.34" stop-color="', p.front, '"/>',
        '<stop offset="1" stop-color="', p.side, '"/>',
      '</linearGradient>',

      '<linearGradient id="', id, '-side" x1="0" y1="0" x2="1" y2="0.55">',
        '<stop offset="0" stop-color="', p.side, '"/>',
        '<stop offset="1" stop-color="', p.deep, '"/>',
      '</linearGradient>',

      '<linearGradient id="', id, '-deep" x1="0" y1="0" x2="0" y2="1">',
        '<stop offset="0" stop-color="', p.deep, '"/>',
        '<stop offset="1" stop-color="', p.dark, '"/>',
      '</linearGradient>',

      /* Sky above / ground below — the single strongest metal cue */
      '<linearGradient id="', id, '-env" x1="0" y1="0" x2="0.2" y2="1">',
        '<stop offset="0" stop-color="#d5e6f5" stop-opacity="', (m ? 0.34 : 0.20), '"/>',
        '<stop offset="0.42" stop-color="#d5e6f5" stop-opacity="0"/>',
        '<stop offset="0.58" stop-color="#0a0b0c" stop-opacity="0"/>',
        '<stop offset="1" stop-color="#0a0b0c" stop-opacity="', (m ? 0.30 : 0.22), '"/>',
      '</linearGradient>',

      /* Narrow moving highlight band */
      '<linearGradient id="', id, '-spec" x1="0" y1="0" x2="1" y2="0.65">',
        '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>',
        '<stop offset="0.34" stop-color="#ffffff" stop-opacity="', (m ? 0.30 : 0.15), '"/>',
        '<stop offset="0.47" stop-color="#ffffff" stop-opacity="', (m ? 0.44 : 0.22), '"/>',
        '<stop offset="0.62" stop-color="#ffffff" stop-opacity="0"/>',
        '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
      '</linearGradient>',

      '<radialGradient id="', id, '-glow" cx="0.5" cy="0.5" r="0.5">',
        '<stop offset="0" stop-color="', p.spec, '" stop-opacity="0.5"/>',
        '<stop offset="1" stop-color="', p.spec, '" stop-opacity="0"/>',
      '</radialGradient>',

      '<radialGradient id="', id, '-contact" cx="0.5" cy="0.5" r="0.5">',
        '<stop offset="0" stop-color="#000" stop-opacity="0.62"/>',
        '<stop offset="1" stop-color="#000" stop-opacity="0"/>',
      '</radialGradient>',

      /* Paint tooth — subtle, but it stops large faces reading as vector fill */
      '<filter id="', id, '-grain" x="-5%" y="-5%" width="110%" height="110%">',
        '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="n"/>',
        '<feColorMatrix type="saturate" values="0" in="n" result="ng"/>',
        '<feComponentTransfer in="ng" result="na">',
          '<feFuncA type="linear" slope="', (m ? 0.16 : 0.10), '"/>',
        '</feComponentTransfer>',
        /* Clip the noise to the artwork's alpha, then lay it back over the
           artwork. Without the merge the filter output would be noise alone. */
        '<feComposite operator="in" in="na" in2="SourceGraphic" result="grain"/>',
        '<feMerge>',
          '<feMergeNode in="SourceGraphic"/>',
          '<feMergeNode in="grain"/>',
        '</feMerge>',
      '</filter>',

      '<filter id="', id, '-soft" x="-30%" y="-30%" width="160%" height="160%">',
        '<feGaussianBlur stdDeviation="9"/>',
      '</filter>',
      '</defs>'
    ].join('');
  }

  function G(id, name) { return 'url(#' + id + '-' + name + ')'; }

  /* Contact shadow under the assembly. */
  function contact(id, cx, cy, rx, ry) {
    return '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry +
           '" fill="' + G(id, 'contact') + '"/>';
  }

  /* --------------------------------------------------- masonry chimney */

  /*
   * A 3/4-view brick stack used as context under every chimney cap.
   * Returns markup only; geometry is fixed so the cap functions can rely on it.
   */
  function chimney(opts) {
    opts = opts || {};
    var topY = opts.topY === undefined ? 300 : opts.topY;
    var d = 62, r = 54;                     /* depth offsets for the 3/4 view */
    var L = 258, R = 522, B = 528;
    var s = [];

    /* right side face */
    s.push(poly([[R, topY], [R + d, topY - r], [R + d, B - r], [R, B]], BRICK.side));
    /* front face */
    s.push(poly([[L, topY], [R, topY], [R, B], [L, B]], BRICK.front));
    /* crown wash on top */
    s.push(poly([[L, topY], [L + d, topY - r], [R + d, topY - r], [R, topY]], BRICK.top));

    /* brick coursing — mortar joints, front face then side face */
    var y, i;
    for (i = 1; i < 7; i++) {
      y = topY + i * 33;
      if (y > B - 4) break;
      s.push('<path d="M' + L + ' ' + y + 'H' + R + '" stroke="' + BRICK.mortar + '" stroke-width="2.4" opacity="0.75"/>');
      s.push('<path d="M' + R + ' ' + y + 'l' + d + ' ' + (-r) + '" stroke="' + BRICK.mortar + '" stroke-width="2.4" opacity="0.5"/>');
    }
    /* vertical head joints, staggered by course */
    for (i = 0; i < 7; i++) {
      var yy = topY + i * 33;
      if (yy > B - 20) break;
      var off = (i % 2) ? 44 : 0;
      for (var x = L + 44 + off; x < R - 10; x += 88) {
        s.push('<path d="M' + x + ' ' + yy + 'v33" stroke="' + BRICK.mortar + '" stroke-width="2.2" opacity="0.55"/>');
      }
    }

    /* ambient occlusion where the stack meets the ground plane */
    s.push(poly([[L, B - 40], [R + d, B - 40 - r], [R + d, B - r], [L, B]],
      'rgba(0,0,0,0.28)'));

    return s.join('');
  }

  /* ------------------------------------------------------ patina scene */

  /*
   * A standing seam copper cap rendered at one weathering stage.
   * Later stages layer mottled patches so the transition reads as chemistry
   * rather than a simple hue shift.
   */
  function renderPatina(index) {
    var stage = CM.patinaTimeline[index] || CM.patinaTimeline[0];
    var id = 'pat' + (++uid);
    var p = U.palette(stage.hex, index < 3);
    var gloss = Math.max(0, 0.85 - index * 0.19);
    var s = [];

    /* Cropped to the assembly rather than the full canvas — the cap should
       fill its frame, not float in the middle of it. */
    s.push('<svg viewBox="150 170 560 420" role="img" preserveAspectRatio="xMidYMid meet">');
    s.push(defs(id, p));

    /* mottling: patina never arrives evenly */
    s.push('<defs><radialGradient id="' + id + '-mot" cx="0.5" cy="0.5" r="0.5">' +
           '<stop offset="0" stop-color="' + stage.accent + '" stop-opacity="0.85"/>' +
           '<stop offset="1" stop-color="' + stage.accent + '" stop-opacity="0"/>' +
           '</radialGradient></defs>');

    s.push('<rect width="800" height="600" fill="#0e1013"/>');
    s.push(contact(id, 400, 566, 240, 26));
    s.push(chimney({ topY: 336 }));

    /* skirt */
    s.push(poly([[522, 328], [584, 274], [584, 336], [522, 390]], G(id, 'side')));
    s.push(poly([[258, 328], [522, 328], [522, 390], [258, 390]], G(id, 'front')));

    /* crown */
    var A = [206, 322], B = [574, 322], C = [674, 238], D = [306, 238];
    s.push(poly([B, C, [C[0], C[1] + 16], [B[0], B[1] + 16]], G(id, 'side')));
    s.push(poly([A, B, [B[0], B[1] + 16], [A[0], A[1] + 16]], G(id, 'front')));
    var E = [352, 208], F = [528, 208];
    s.push(poly([D, C, F, E], G(id, 'deep')));
    s.push(poly([A, D, E], G(id, 'side')));
    s.push(poly([B, C, F], G(id, 'top')));
    s.push(poly([A, B, F, E], G(id, 'front')));

    /* standing seams on the front slope */
    for (var i = 1; i < 7; i++) {
      var t = i / 7;
      var x0 = A[0] + (B[0] - A[0]) * t, x1 = E[0] + (F[0] - E[0]) * t;
      s.push('<path d="M' + x0 + ' ' + A[1] + 'L' + x1 + ' ' + E[1] +
             '" stroke="' + p.dark + '" stroke-width="6" stroke-linecap="round" opacity="0.45"/>');
      s.push('<path d="M' + (x0 - 2) + ' ' + A[1] + 'L' + (x1 - 2) + ' ' + E[1] +
             '" stroke="' + p.spec + '" stroke-width="2.4" stroke-linecap="round" opacity="' + (0.35 + gloss * 0.6) + '"/>');
    }

    /* Patina blooms — count and size grow with the stage. Clipped to the
       front slope so the mottling stays on the metal. */
    s.push('<clipPath id="' + id + '-crown"><polygon points="' + pts([A, B, F, E]) + '"/></clipPath>');
    var blooms = index === 0 ? 0 : index * 5;
    s.push('<g clip-path="url(#' + id + '-crown)">');
    for (var b = 0; b < blooms; b++) {
      var bx = 230 + ((b * 137) % 320);
      var by = 230 + ((b * 89) % 90);
      var br = 24 + ((b * 31) % 46) + index * 5;
      s.push('<ellipse cx="' + bx + '" cy="' + by + '" rx="' + br + '" ry="' + (br * 0.62) +
             '" fill="url(#' + id + '-mot)" opacity="' + (0.14 + index * 0.06) + '"/>');
    }
    s.push('</g>');

    s.push(poly([A, B, F, E], G(id, 'env')));
    /* gloss falls away as the oxide thickens */
    s.push('<polygon points="' + pts([A, B, F, E]) + '" fill="' + G(id, 'spec') +
           '" opacity="' + gloss + '"/>');
    s.push('<path d="M' + E[0] + ' ' + E[1] + 'H' + F[0] + '" stroke="' + p.spec +
           '" stroke-width="3.4" stroke-linecap="round" opacity="' + (0.35 + gloss * 0.5) + '"/>');

    s.push('</svg>');
    return s.join('');
  }

  /* --------------------------------------------------------- zinc scene */

  /* Architectural rendering of a zinc standing seam wall/cap assembly. */
  function renderZinc(finish) {
    var id = 'z' + (++uid);
    /*
     * Deliberately not the metallic palette here: the wide highlight spread
     * plus a full-plane specular pass flattens all four finishes to the same
     * bright silver. Sheen is applied per-finish below instead, so Anthra
     * stays anthracite and Natural stays mill-bright.
     */
    var p = U.palette(finish.hex, false);
    var sheen = finish.sheen;
    var s = [];

    s.push('<svg viewBox="0 0 640 440" role="img" preserveAspectRatio="xMidYMid slice">');
    s.push(defs(id, p));
    s.push('<rect width="640" height="440" fill="#0d0f11"/>');

    /* cladding plane, seams running vertically */
    s.push(poly([[40, 60], [400, 20], [400, 400], [40, 420]], G(id, 'front')));
    for (var i = 1; i < 9; i++) {
      var x = 40 + i * 40;
      var yTop = 60 - i * 4.4, yBot = 420 - i * 2.2;
      s.push('<path d="M' + x + ' ' + yTop + 'V' + yBot + '" stroke="' + p.dark +
             '" stroke-width="5" opacity="0.45"/>');
      s.push('<path d="M' + (x - 2) + ' ' + yTop + 'V' + yBot + '" stroke="' + p.spec +
             '" stroke-width="2" opacity="' + (0.25 + finish.sheen * 0.6) + '"/>');
    }
    s.push('<polygon points="' + pts([[40, 60], [400, 20], [400, 400], [40, 420]]) +
           '" fill="' + G(id, 'env') + '" opacity="' + (0.35 + sheen * 0.5) + '"/>');
    s.push('<polygon points="' + pts([[40, 60], [400, 20], [400, 400], [40, 420]]) +
           '" fill="' + G(id, 'spec') + '" opacity="' + (sheen * 0.85) + '"/>');

    /* returning elevation in shade */
    s.push(poly([[400, 20], [600, 74], [600, 386], [400, 400]], G(id, 'side')));
    for (i = 1; i < 5; i++) {
      var xx = 400 + i * 40;
      s.push('<path d="M' + xx + ' ' + (20 + i * 10.8) + 'V' + (400 - i * 2.8) + '" stroke="' + p.dark +
             '" stroke-width="4" opacity="0.4"/>');
    }
    s.push('<polygon points="' + pts([[400, 20], [600, 74], [600, 386], [400, 400]]) +
           '" fill="' + G(id, 'env') + '" opacity="' + (0.3 + sheen * 0.3) + '"/>');

    /* coping cap along the top edge */
    s.push(poly([[32, 56], [404, 14], [608, 70], [608, 84], [404, 30], [32, 72]], G(id, 'top')));
    s.push('<path d="M32 56L404 14L608 70" stroke="' + p.spec + '" stroke-width="2" fill="none" opacity="' +
           (0.4 + finish.sheen * 0.5) + '"/>');

    /* recessed glazing slot for scale */
    s.push(poly([[120, 190], [300, 170], [300, 268], [120, 284]], '#0b0e12'));
    s.push(poly([[120, 190], [300, 170], [300, 200], [120, 218]], 'rgba(180,205,225,0.14)'));

    s.push('</svg>');
    return s.join('');
  }

  /*
   * Close-up macro texture strip — rolled grain plus a specular band.
   * Rendered as a gradient stack rather than an image so it recolours freely.
   */
  function zincMacro(finish) {
    var id = 'zm' + (++uid);
    var p = U.palette(finish.hex, true);
    var tight = finish.grain === 'fine';
    var s = ['<svg viewBox="0 0 400 120" preserveAspectRatio="none" style="width:100%;height:100%">'];
    s.push('<defs><linearGradient id="' + id + '-b" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + p.top + '"/>' +
      '<stop offset="0.42" stop-color="' + p.base + '"/>' +
      '<stop offset="1" stop-color="' + p.deep + '"/></linearGradient>' +
      '<filter id="' + id + '-g"><feTurbulence type="fractalNoise" baseFrequency="' +
      (tight ? '0.02 0.9' : '0.06 0.5') + '" numOctaves="3"/>' +
      '<feColorMatrix type="saturate" values="0"/>' +
      '<feComponentTransfer><feFuncA type="linear" slope="' + (tight ? 0.30 : 0.20) + '"/></feComponentTransfer>' +
      '<feComposite operator="in" in2="SourceGraphic"/></filter></defs>');
    s.push('<rect width="400" height="120" fill="url(#' + id + '-b)"/>');
    s.push('<rect width="400" height="120" fill="url(#' + id + '-b)" filter="url(#' + id + '-g)"/>');
    s.push('<rect width="400" height="120" fill="#fff" opacity="' + (finish.sheen * 0.16) + '"/>');
    s.push('</svg>');
    return s.join('');
  }

  CM.render = {
    patina: renderPatina,
    zinc: renderZinc,
    zincMacro: zincMacro
  };
})(window.CM);
