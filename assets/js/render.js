/*
 * render.js — SVG scene generation.
 *
 * Every product preview is built from flat polygons filled with colour-derived
 * gradients, then overlaid with a sky/ground reflection ramp, a specular sweep
 * and a fine grain filter. Changing the selected colour rebuilds the gradient
 * stops, so the whole scene re-lights in one frame without any asset swapping.
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

  /* Support posts for open-sided caps. */
  function posts(id, topY, botY) {
    var s = [];
    [[276, 0], [504, 0], [560, -50], [332, -50]].forEach(function (q) {
      var x = q[0], dy = q[1];
      s.push('<rect x="' + x + '" y="' + (topY + dy) + '" width="15" height="' + (botY - topY) +
             '" fill="' + G(id, 'front') + '"/>');
      s.push('<rect x="' + x + '" y="' + (topY + dy) + '" width="4.5" height="' + (botY - topY) +
             '" fill="' + G(id, 'env') + '"/>');
    });
    return s.join('');
  }

  /* Overhanging base plate that a crown sits on. Returns markup + corner pts. */
  function basePlate(id, y, th) {
    var A = [206, y], B = [574, y], C = [674, y - 84], D = [306, y - 84];
    var s = [
      poly([[B[0], B[1]], [C[0], C[1]], [C[0], C[1] + th], [B[0], B[1] + th]], G(id, 'side')),
      poly([[A[0], A[1]], [B[0], B[1]], [B[0], B[1] + th], [A[0], A[1] + th]], G(id, 'front')),
      poly([A, D, C, B], G(id, 'top')),
      poly([A, D, C, B], G(id, 'env')),
      /* hemmed drip edge catches a bright line */
      '<path d="M' + A[0] + ' ' + (A[1] + th) + 'H' + B[0] + 'l' + (C[0] - B[0]) + ' ' + (C[1] - B[1]) +
        '" stroke="' + U.rgba('#ffffff', 0.20) + '" stroke-width="1.6" fill="none"/>'
    ].join('');
    return { markup: s, A: A, B: B, C: C, D: D };
  }

  /* ------------------------------------------------------------ products */

  var PRODUCTS = {};

  /* 1 — Custom chimney cap: hipped crown, full skirt, overhang plate */
  PRODUCTS['custom-cap'] = function (id, p) {
    var s = [contact(id, 440, 540, 250, 26), chimney()];

    /* skirt wrapping the top of the stack */
    s.push(poly([[522, 292], [584, 238], [584, 300], [522, 354]], G(id, 'side')));
    s.push(poly([[258, 292], [522, 292], [522, 354], [258, 354]], G(id, 'front')));
    s.push(poly([[258, 292], [522, 292], [522, 312], [258, 312]], G(id, 'env')));

    var bp = basePlate(id, 286, 17);
    s.push(bp.markup);

    /* hip crown: ridge parallel to the front edge, centred on the plan */
    var A = bp.A, B = bp.B, C = bp.C, D = bp.D;
    var E = [352, 172], F = [528, 172];
    s.push(poly([D, C, F, E], G(id, 'deep')));      /* back slope */
    s.push(poly([A, D, E], G(id, 'side')));          /* left hip   */
    s.push(poly([B, C, F], G(id, 'top')));           /* right hip  */
    s.push(poly([A, B, F, E], G(id, 'front')));      /* front slope*/
    s.push(poly([A, B, F, E], G(id, 'env')));
    s.push(poly([A, B, F, E], G(id, 'spec')));

    /* hip ribs and ridge cap */
    ['M' + A[0] + ' ' + A[1] + 'L' + E[0] + ' ' + E[1],
     'M' + B[0] + ' ' + B[1] + 'L' + F[0] + ' ' + F[1],
     'M' + C[0] + ' ' + C[1] + 'L' + F[0] + ' ' + F[1]].forEach(function (d) {
      s.push('<path d="' + d + '" stroke="' + U.rgba(p.edge, 0.55) + '" stroke-width="2.2" fill="none"/>');
    });
    s.push('<path d="M' + E[0] + ' ' + E[1] + 'H' + F[0] + '" stroke="' + p.spec +
           '" stroke-width="3.4" stroke-linecap="round" opacity="0.85"/>');

    return s.join('');
  };

  /* 2 — Standing seam chimney cap: raised ribs across a low-slope crown */
  PRODUCTS['standing-cap'] = function (id, p) {
    var s = [contact(id, 440, 540, 250, 26), chimney()];

    var bp = basePlate(id, 322, 15);
    s.push(bp.markup);

    /*
     * Solid frieze between the plate and the crown. Posts were tried here and
     * disappear behind the plate's top face, which leaves the crown reading as
     * a floating slab — the band closes the assembly properly.
     */
    s.push(poly([[574, 276], [674, 192], [674, 238], [574, 322]], G(id, 'deep')));
    s.push(poly([[206, 276], [574, 276], [574, 322], [206, 322]], G(id, 'side')));
    s.push(poly([[206, 276], [574, 276], [574, 292], [206, 292]], G(id, 'env')));

    /* low-slope crown plane, ridge slightly above the plate */
    var A = [206, 262], B = [574, 262], C = [674, 178], D = [306, 178];
    s.push(poly([[B[0], B[1]], [C[0], C[1]], [C[0], C[1] + 14], [B[0], B[1] + 14]], G(id, 'side')));
    s.push(poly([A, B, [B[0], B[1] + 14], [A[0], A[1] + 14]], G(id, 'front')));
    s.push(poly([A, D, C, B], G(id, 'top')));
    s.push(poly([A, D, C, B], G(id, 'env')));

    /* mechanically seamed ribs running front-to-back along the slope */
    for (var i = 0; i <= 7; i++) {
      var t = i / 7;
      var x0 = A[0] + (B[0] - A[0]) * t, y0 = A[1];
      var x1 = D[0] + (C[0] - D[0]) * t, y1 = D[1];
      s.push('<path d="M' + x0 + ' ' + y0 + 'L' + x1 + ' ' + y1 +
             '" stroke="' + p.dark + '" stroke-width="7" stroke-linecap="round" opacity="0.55"/>');
      s.push('<path d="M' + (x0 - 2) + ' ' + y0 + 'L' + (x1 - 2) + ' ' + y1 +
             '" stroke="' + p.spec + '" stroke-width="2.6" stroke-linecap="round" opacity="0.9"/>');
      s.push('<path d="M' + (x0 + 3) + ' ' + y0 + 'L' + (x1 + 3) + ' ' + y1 +
             '" stroke="' + p.deep + '" stroke-width="2.2" stroke-linecap="round" opacity="0.7"/>');
    }
    s.push(poly([A, D, C, B], G(id, 'spec')));

    return s.join('');
  };

  /* 3 — Louvered chimney cap: screened louvre bands on the open sides */
  PRODUCTS['louvered-cap'] = function (id, p) {
    var s = [contact(id, 440, 540, 250, 26), chimney()];

    /* louvre box between the stack and the crown */
    var boxT = 214, boxB = 330;
    s.push(poly([[522, boxT + 8], [584, boxT - 46], [584, boxB - 46], [522, boxB]], G(id, 'deep')));
    s.push(poly([[258, boxT + 8], [522, boxT + 8], [522, boxB], [258, boxB]], G(id, 'side')));

    /* horizontal blades — front bank, then the receding side bank */
    for (var i = 0; i < 7; i++) {
      var y = boxT + 22 + i * 15;
      s.push('<path d="M262 ' + y + 'H518" stroke="' + p.top + '" stroke-width="5.5" stroke-linecap="round" opacity="0.92"/>');
      s.push('<path d="M262 ' + (y + 4) + 'H518" stroke="' + p.dark + '" stroke-width="3.4" stroke-linecap="round" opacity="0.75"/>');
      s.push('<path d="M524 ' + (y - 2) + 'l58 -50" stroke="' + p.front + '" stroke-width="5" stroke-linecap="round" opacity="0.7"/>');
    }
    /* insect screen behind the blades */
    s.push('<rect x="262" y="' + (boxT + 14) + '" width="256" height="110" fill="' +
           U.rgba('#000000', 0.30) + '"/>');

    /* corner mullions */
    [[256, 8], [516, 8]].forEach(function (q) {
      s.push('<rect x="' + q[0] + '" y="' + (boxT + q[1] - 4) + '" width="12" height="' +
             (boxB - boxT - 4) + '" fill="' + G(id, 'front') + '"/>');
    });

    var bp = basePlate(id, 216, 16);
    s.push(bp.markup);

    /* shallow hip crown above the louvres */
    var A = bp.A, B = bp.B, C = bp.C, D = bp.D;
    var E = [366, 138], F = [514, 138];
    s.push(poly([D, C, F, E], G(id, 'deep')));
    s.push(poly([A, D, E], G(id, 'side')));
    s.push(poly([B, C, F], G(id, 'top')));
    s.push(poly([A, B, F, E], G(id, 'front')));
    s.push(poly([A, B, F, E], G(id, 'env')));
    s.push(poly([A, B, F, E], G(id, 'spec')));
    s.push('<path d="M' + E[0] + ' ' + E[1] + 'H' + F[0] + '" stroke="' + p.spec +
           '" stroke-width="3.2" stroke-linecap="round" opacity="0.85"/>');

    return s.join('');
  };

  /* 4 — Flat-top chimney cap: single flat plate on slim posts */
  PRODUCTS['flat-cap'] = function (id, p) {
    var s = [contact(id, 440, 540, 250, 26), chimney()];
    s.push(posts(id, 232, 306));

    var A = [196, 226], B = [584, 226], C = [684, 142], D = [296, 142];
    var th = 13;
    s.push(poly([B, C, [C[0], C[1] + th], [B[0], B[1] + th]], G(id, 'side')));
    s.push(poly([A, B, [B[0], B[1] + th], [A[0], A[1] + th]], G(id, 'front')));
    s.push(poly([A, D, C, B], G(id, 'top')));
    s.push(poly([A, D, C, B], G(id, 'env')));
    s.push(poly([A, D, C, B], G(id, 'spec')));

    /* two flush joint seams keep the plate from reading as a slab */
    [0.36, 0.68].forEach(function (t) {
      var x0 = A[0] + (B[0] - A[0]) * t, x1 = D[0] + (C[0] - D[0]) * t;
      s.push('<path d="M' + x0 + ' ' + A[1] + 'L' + x1 + ' ' + D[1] +
             '" stroke="' + U.rgba(p.dark, 0.5) + '" stroke-width="2" fill="none"/>');
    });
    /* crisp hemmed edge highlight */
    s.push('<path d="M' + A[0] + ' ' + A[1] + 'H' + B[0] + 'L' + C[0] + ' ' + C[1] +
           '" stroke="' + p.spec + '" stroke-width="2" fill="none" opacity="0.7"/>');

    return s.join('');
  };

  /* 5 — Architectural flashing: exposed profile with hemmed drip and kick */
  PRODUCTS['arch-flash'] = function (id, p) {
    var s = [contact(id, 400, 520, 260, 24)];

    /* wall plane behind */
    s.push(poly([[120, 90], [600, 90], [600, 470], [120, 470]], '#3a352f'));
    s.push(poly([[600, 90], [700, 44], [700, 424], [600, 470]], '#2a2621'));
    for (var i = 1; i < 8; i++) {
      s.push('<path d="M120 ' + (90 + i * 48) + 'H600" stroke="#282420" stroke-width="2.4" opacity="0.7"/>');
    }

    /* flashing band: face, hem return, kick-out */
    var top = 250, h = 74;
    s.push(poly([[600, top], [700, top - 46], [700, top - 46 + h], [600, top + h]], G(id, 'side')));
    s.push(poly([[110, top], [600, top], [600, top + h], [110, top + h]], G(id, 'front')));
    s.push(poly([[110, top], [600, top], [600, top + 26], [110, top + 26]], G(id, 'env')));
    s.push(poly([[110, top], [600, top], [600, top + h], [110, top + h]], G(id, 'spec')));

    /* top return catching the sky */
    s.push(poly([[110, top - 16], [600, top - 16], [700, top - 62], [210, top - 62]], G(id, 'top')));
    s.push(poly([[110, top - 16], [600, top - 16], [700, top - 62], [210, top - 62]], G(id, 'env')));
    s.push(poly([[110, top - 16], [600, top - 16], [600, top], [110, top]], G(id, 'deep')));

    /* hemmed drip at the bottom edge, with the shadow it throws on the wall */
    s.push(poly([[110, top + h], [600, top + h], [700, top + h - 46], [700, top + h - 34],
                 [600, top + h + 12], [110, top + h + 12]], G(id, 'deep')));
    s.push('<path d="M110 ' + (top + h) + 'H600" stroke="' + p.spec + '" stroke-width="2.2" opacity="0.8"/>');
    s.push(poly([[120, top + h + 12], [600, top + h + 12], [600, top + h + 34], [120, top + h + 34]],
      'rgba(0,0,0,0.32)'));

    return s.join('');
  };

  /* 6 — Counter flashing: stepped into masonry coursing above a roof slope */
  PRODUCTS['counter-flash'] = function (id, p) {
    var s = [contact(id, 420, 528, 250, 22)];

    /* masonry wall — course spacing matches the flashing step rise so the
       pieces land in real mortar joints rather than floating on the brick */
    var course = 28;
    s.push(poly([[150, 60], [560, 60], [560, 500], [150, 500]], '#463e35'));
    s.push(poly([[560, 60], [660, 20], [660, 460], [560, 500]], '#332c26'));
    for (var i = 1; i < 16; i++) {
      s.push('<path d="M150 ' + (60 + i * course) + 'H560" stroke="#2b2521" stroke-width="2.4" opacity="0.8"/>');
    }

    /* roof deck rising to the right */
    s.push(poly([[100, 470], [560, 300], [660, 348], [180, 528]], '#20232a'));
    s.push(poly([[100, 470], [560, 300], [560, 316], [100, 486]], '#2c3038'));

    /*
     * Stepped counter flashing is fabricated as individual pieces, each one
     * lapping the piece below it. Drawing left to right puts the upper piece
     * over the lower — the same order water sheds.
     */
    var run = 76, rise = 28, w = 98, h = 56;
    for (var k = 0; k < 5; k++) {
      var x0 = 160 + k * run, y0 = 400 - k * rise;
      var quad = [[x0, y0], [x0 + w, y0], [x0 + w, y0 - h], [x0, y0 - h]];

      /* shadow the piece throws down the wall */
      s.push(poly([[x0, y0 + 9], [x0 + w, y0 + 9], [x0 + w, y0 + 24], [x0, y0 + 24]],
        'rgba(0,0,0,0.30)'));

      s.push(poly(quad, G(id, 'front')));
      s.push(poly(quad, G(id, 'env')));
      s.push(poly(quad, G(id, 'spec')));

      /* hemmed bottom edge */
      s.push(poly([[x0, y0], [x0 + w, y0], [x0 + w, y0 + 9], [x0, y0 + 9]], G(id, 'deep')));
      s.push('<path d="M' + x0 + ' ' + y0 + 'h' + w + '" stroke="' + p.spec +
             '" stroke-width="2" opacity="0.85"/>');

      /* top edge turned into the reglet, with the sealant bead above it */
      s.push('<path d="M' + x0 + ' ' + (y0 - h) + 'h' + w + '" stroke="' + U.rgba(p.dark, 0.7) +
             '" stroke-width="3.5"/>');
      s.push('<path d="M' + x0 + ' ' + (y0 - h - 4) + 'h' + w + '" stroke="rgba(0,0,0,0.35)" stroke-width="4"/>');
    }

    return s.join('');
  };

  /* 7 — Wall cap: two-slope cap with hemmed edges on a low wall */
  PRODUCTS['wall-cap'] = function (id, p) {
    var s = [contact(id, 420, 534, 260, 24)];

    /* wall */
    s.push(poly([[230, 250], [540, 250], [540, 520], [230, 520]], BRICK.front));
    s.push(poly([[540, 250], [640, 200], [640, 470], [540, 520]], BRICK.side));
    for (var i = 1; i < 6; i++) {
      s.push('<path d="M230 ' + (250 + i * 46) + 'H540" stroke="' + BRICK.mortar + '" stroke-width="2.6" opacity="0.75"/>');
      s.push('<path d="M540 ' + (250 + i * 46) + 'l100 -50" stroke="' + BRICK.mortar + '" stroke-width="2.4" opacity="0.5"/>');
    }

    /* cap: two slopes from a central ridge, overhanging both faces */
    var Lf = [196, 244], Rf = [574, 244];                 /* front eave line */
    var Lb = [296, 194], Rb = [674, 194];                 /* back eave line  */
    var ridgeF = [385, 206], ridgeB = [485, 156];

    s.push(poly([Rf, Rb, ridgeB, ridgeF], G(id, 'top')));      /* far slope  */
    s.push(poly([Lf, ridgeF, ridgeB, Lb], G(id, 'front')));    /* near slope */
    s.push(poly([Lf, ridgeF, ridgeB, Lb], G(id, 'env')));
    s.push(poly([Rf, Rb, ridgeB, ridgeF], G(id, 'env')));
    s.push(poly([Lf, ridgeF, ridgeB, Lb], G(id, 'spec')));

    /* hemmed drip edges */
    s.push(poly([[Lf[0], Lf[1]], [ridgeF[0], ridgeF[1]], [ridgeF[0], ridgeF[1] + 13],
                 [Lf[0], Lf[1] + 13]], G(id, 'deep')));
    s.push(poly([[ridgeF[0], ridgeF[1]], [Rf[0], Rf[1]], [Rf[0], Rf[1] + 13],
                 [ridgeF[0], ridgeF[1] + 13]], G(id, 'deep')));
    s.push('<path d="M' + Lf[0] + ' ' + Lf[1] + 'L' + ridgeF[0] + ' ' + ridgeF[1] + 'L' + Rf[0] + ' ' + Rf[1] +
           '" stroke="' + p.spec + '" stroke-width="2.4" fill="none" opacity="0.8"/>');
    /* ridge line */
    s.push('<path d="M' + ridgeF[0] + ' ' + ridgeF[1] + 'L' + ridgeB[0] + ' ' + ridgeB[1] +
           '" stroke="' + p.spec + '" stroke-width="2.8" opacity="0.7"/>');

    return s.join('');
  };

  /* 8 — Coping: parapet run with standing joint covers */
  PRODUCTS['coping'] = function (id, p) {
    var s = [contact(id, 420, 528, 280, 22)];

    /* parapet running away to the right */
    s.push(poly([[120, 300], [600, 232], [700, 268], [220, 344]], '#3f382f'));
    s.push(poly([[120, 300], [600, 232], [600, 500], [120, 520]], BRICK.front));
    for (var i = 1; i < 5; i++) {
      s.push('<path d="M120 ' + (300 + i * 48) + 'L600 ' + (232 + i * 48) + '" stroke="' + BRICK.mortar +
             '" stroke-width="2.6" opacity="0.7"/>');
    }

    /* coping top surface, sloped to the interior */
    var A = [110, 292], B = [600, 224], C = [706, 262], D = [214, 336];
    s.push(poly([A, B, C, D], G(id, 'top')));
    s.push(poly([A, B, C, D], G(id, 'env')));
    s.push(poly([A, B, C, D], G(id, 'spec')));

    /* outboard fascia with hemmed drip */
    s.push(poly([A, B, [B[0], B[1] + 30], [A[0], A[1] + 30]], G(id, 'front')));
    s.push(poly([A, B, [B[0], B[1] + 12], [A[0], A[1] + 12]], G(id, 'env')));
    s.push(poly([[A[0], A[1] + 30], [B[0], B[1] + 30], [B[0], B[1] + 42], [A[0], A[1] + 42]], G(id, 'deep')));
    s.push('<path d="M' + A[0] + ' ' + A[1] + 'L' + B[0] + ' ' + B[1] +
           '" stroke="' + p.spec + '" stroke-width="2.4" opacity="0.85"/>');

    /* standing joint covers at each panel break */
    [0.24, 0.5, 0.76].forEach(function (t) {
      var x0 = A[0] + (B[0] - A[0]) * t, y0 = A[1] + (B[1] - A[1]) * t;
      var x1 = D[0] + (C[0] - D[0]) * t, y1 = D[1] + (C[1] - D[1]) * t;
      s.push('<path d="M' + x0 + ' ' + y0 + 'L' + x1 + ' ' + y1 +
             '" stroke="' + p.dark + '" stroke-width="9" stroke-linecap="round" opacity="0.5"/>');
      s.push('<path d="M' + (x0 - 2) + ' ' + (y0 - 1) + 'L' + (x1 - 2) + ' ' + (y1 - 1) +
             '" stroke="' + p.spec + '" stroke-width="3" stroke-linecap="round" opacity="0.9"/>');
    });

    return s.join('');
  };

  /* 9 — Roof accessories: ridge vent, pipe boot collar, valley trim */
  PRODUCTS['roof-acc'] = function (id, p) {
    var s = [contact(id, 420, 534, 280, 22)];

    /* two roof planes meeting at a ridge */
    s.push(poly([[60, 300], [420, 178], [420, 470], [60, 520]], '#232830'));
    s.push(poly([[420, 178], [760, 300], [760, 520], [420, 470]], '#1b1f26'));
    /* shingle coursing */
    for (var i = 1; i < 7; i++) {
      s.push('<path d="M' + (60 + i * 8) + ' ' + (300 + i * 34) + 'L420 ' + (178 + i * 34) +
             '" stroke="#1a1e25" stroke-width="3" opacity="0.8"/>');
      s.push('<path d="M420 ' + (178 + i * 34) + 'L' + (760 - i * 8) + ' ' + (300 + i * 34) +
             '" stroke="#141922" stroke-width="3" opacity="0.8"/>');
    }

    /* ridge vent running the full ridge */
    s.push(poly([[70, 296], [420, 174], [770, 296], [420, 210]], G(id, 'top')));
    s.push(poly([[70, 296], [420, 210], [770, 296], [770, 312], [420, 226], [70, 312]], G(id, 'front')));
    s.push(poly([[70, 296], [420, 174], [770, 296], [420, 210]], G(id, 'env')));
    s.push(poly([[70, 296], [420, 174], [770, 296], [420, 210]], G(id, 'spec')));
    s.push('<path d="M70 296L420 174L770 296" stroke="' + p.spec + '" stroke-width="2.4" fill="none" opacity="0.75"/>');

    /* pipe boot with a formed metal collar on the left plane */
    s.push('<ellipse cx="210" cy="416" rx="66" ry="24" fill="' + G(id, 'side') + '"/>');
    s.push('<ellipse cx="210" cy="408" rx="66" ry="24" fill="' + G(id, 'top') + '"/>');
    s.push('<ellipse cx="210" cy="408" rx="66" ry="24" fill="' + G(id, 'env') + '"/>');
    s.push('<rect x="186" y="330" width="48" height="80" rx="4" fill="' + G(id, 'front') + '"/>');
    s.push('<ellipse cx="210" cy="330" rx="24" ry="9" fill="' + G(id, 'top') + '"/>');
    s.push('<ellipse cx="210" cy="330" rx="24" ry="9" fill="' + G(id, 'spec') + '"/>');
    s.push('<rect x="186" y="330" width="13" height="80" fill="' + G(id, 'env') + '"/>');

    /* low-profile box vent on the right plane: roof flange, curb, top plate */
    var fl = [[546, 302], [634, 334], [634, 418], [546, 386]];
    s.push(poly(fl, G(id, 'side')));
    s.push('<path d="M546 386L634 418" stroke="rgba(0,0,0,0.4)" stroke-width="6"/>');

    /* curb face, with a louvre slot so it reads as a vent and not a block */
    s.push(poly([[546, 386], [634, 418], [634, 384], [546, 352]], G(id, 'front')));
    s.push('<path d="M556 372L626 397" stroke="' + U.rgba(p.dark, 0.75) + '" stroke-width="5"/>');

    var top = [[546, 268], [634, 300], [634, 384], [546, 352]];
    s.push(poly(top, G(id, 'top')));
    s.push(poly(top, G(id, 'env')));
    s.push(poly(top, G(id, 'spec')));
    s.push('<path d="M546 352L634 384" stroke="' + p.spec + '" stroke-width="2.2" opacity="0.8"/>');

    return s.join('');
  };

  /* ---------------------------------------------------------- public API */

  /*
   * renderProduct(productId, hex, metallic) -> full <svg> string.
   * Gradient ids are namespaced per call so multiple scenes can coexist.
   */
  function renderProduct(productId, hex, metallic) {
    var id = 'r' + (++uid);
    var p = U.palette(hex, metallic);
    var draw = PRODUCTS[productId] || PRODUCTS['custom-cap'];
    return '<svg viewBox="0 0 800 560" role="img" preserveAspectRatio="xMidYMid meet">' +
      defs(id, p) +
      '<g filter="url(#' + id + '-grain)">' + draw(id, p) + '</g>' +
      '</svg>';
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
    product: renderProduct,
    patina: renderPatina,
    zinc: renderZinc,
    zincMacro: zincMacro,
    productIds: Object.keys(PRODUCTS)
  };
})(window.CM);
