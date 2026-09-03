/*
 * app.js - configurator wiring.
 *
 * One state object drives every panel. Anything that changes state calls the
 * relevant render function; nothing reads the DOM back as a source of truth.
 */
(function (CM) {
  'use strict';

  var U = CM.util;
  var $ = U.$, $$ = U.$$, el = U.el;
  var FAV_KEY = 'esthers.favourites.v1';

  var state = {
    materialId: 'smp-24',
    coloursOpen: false,
    query: '',
    family: 'all',
    favOnly: false,
    favourites: U.store.get(FAV_KEY, []),
    selected: null,      /* { collection, name, hex, metallic } */
    colourChosen: false, /* true only after the visitor clicks a swatch */
    quoteText: '',
    quoteUpload: false,   /* true once /api/quote reports it can send mail */
    quoteSentCount: 0,    /* attachments on the request that just went */
    patina: 0,
    patinaAuto: false
  };

  var patinaTimer = null;

  /* ------------------------------------------------------------ lookups */

  function material(id) {
    return CM.materials.filter(function (m) { return m.id === (id || state.materialId); })[0];
  }
  function collection(id) {
    return CM.collections[id || material().collection];
  }
  function favKey(collectionId, name) { return collectionId + '::' + name; }
  function isFav(collectionId, name) {
    return state.favourites.indexOf(favKey(collectionId, name)) !== -1;
  }

  /* Family swatch colour used on the filter chips. */
  var FAMILY_DOT = {
    all: 'linear-gradient(135deg,#e9e9e4,#8b6b4a 34%,#3d5f45 62%,#2d4a7a 84%,#8d2a2a)',
    white: '#eceae2', grey: '#8d9295', black: '#232426', brown: '#7a5f47',
    green: '#3d5f45', blue: '#2d4a7a', red: '#8d2a2a',
    metallic: 'linear-gradient(135deg,#d8dde1,#8f979d 48%,#c9b69a)'
  };

  /* ===================================================================
     MATERIAL RAIL
     =================================================================== */

  function buildRail() {
    var rail = $('#material-rail');
    if (!rail) return;
    rail.innerHTML = '';

    CM.materials.forEach(function (m) {
      var chip = el('span', { class: 'mat-card__chip paint', style: { '--c': m.swatch } });
      var card = el('button', {
        class: 'mat-card',
        type: 'button',
        'data-material': m.id,
        'aria-pressed': m.id === state.materialId,
        style: { '--card-accent': m.accent },
        onclick: function () { selectMaterial(m.id); }
      }, [
        chip,
        el('span', { class: 'mat-card__dot' }),
        el('span', { class: 'mat-card__name', text: m.name }),
        el('span', { class: 'mat-card__kicker', text: m.kicker })
      ]);
      rail.appendChild(card);
    });

    /* The materials rail overflows at every width - eight cards at 216px is
       wider than any screen - so unlike the gallery it always needs the
       controls. The edge fades on .selector__rail-wrap have always been
       there, but a permanent fade on both sides says nothing about which
       way there is more, or how much. Anchored to the wrapper so the nav
       sits under the fades rather than inside the scrolling area. */
    railAffordance(rail, {
      itemSelector: '.mat-card',
      label: 'material',
      insertAfter: rail.closest('.selector__rail-wrap') || rail
    });
  }

  function selectMaterial(id, opts) {
    if (state.materialId === id && !(opts && opts.force)) return;
    state.materialId = id;
    var m = material();

    $$('#material-rail .mat-card').forEach(function (c) {
      c.setAttribute('aria-pressed', String(c.dataset.material === id));
    });

    /* Accent colour cascades to every accented element on the page. */
    document.documentElement.style.setProperty('--accent', m.accent);
    document.documentElement.style.setProperty('--accent-soft', U.rgba(m.accent, 0.14));
    document.documentElement.style.setProperty('--accent-line', U.rgba(m.accent, 0.38));

    renderDetail();
    renderColours({ resetSelection: true });
    focusCompareColumn(id);

    /* Bring the rail card into view when selection is driven from elsewhere. */
    var card = $('#material-rail .mat-card[data-material="' + id + '"]');
    if (card && opts && opts.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  /* ===================================================================
     DETAIL PANEL
     =================================================================== */

  function renderDetail() {
    var body = $('#detail-body');
    if (!body) return;
    var m = material();

    body.classList.add('is-swapping');

    window.setTimeout(function () {
      body.innerHTML = '';

      var coll = collection();
      var isPainted = ['smp', 'pvdf', 'aluminum'].indexOf(coll.id) !== -1;
      var btnLabel = isPainted ? 'View Available Colours' : 'View ' + m.name + ' Finishes';

      var actions = [
        el('button', {
          class: 'btn btn--accent',
          type: 'button',
          id: 'view-colours',
          'aria-expanded': String(state.coloursOpen),
          'aria-controls': 'colour-panel',
          onclick: toggleColours
        }, [
          el('span', { text: btnLabel }),
          el('span', { class: 'btn__arrow', html: U.icon('arrow') })
        ])
      ];

      if (coll.id === 'copper') {
        actions.push(el('button', {
          class: 'btn btn--ghost', type: 'button',
          onclick: function () { scrollToId('patina'); }
        }, [el('span', { text: 'See the patina timeline' })]));
      }
      if (coll.id === 'zinc') {
        actions.push(el('button', {
          class: 'btn btn--ghost', type: 'button',
          onclick: function () { scrollToId('zinc'); }
        }, [el('span', { text: 'See zinc finishes in detail' })]));
      }

      var top = el('div', { class: 'detail__top' }, [
        el('div', { class: 'detail__title' }, [
          el('p', { class: 'eyebrow', text: m.kicker }),
          el('h3', { class: 'headline', text: m.name }),
          el('p', { class: 'detail__summary', text: m.summary })
        ]),
        el('div', { class: 'detail__actions' }, actions)
      ]);
      body.appendChild(top);

      if (m.highlights && m.highlights.length) {
        var row = el('div', { class: 'pill-row' });
        m.highlights.forEach(function (h, i) {
          row.appendChild(el('span', {
            class: 'pill', text: h,
            style: { animationDelay: (i * 42) + 'ms' }
          }));
        });
        body.appendChild(row);
      }

      var grid = el('div', { class: 'spec-grid' });
      m.specs.forEach(function (sp, i) {
        grid.appendChild(el('div', {
          class: 'spec',
          style: { animationDelay: (i * 46) + 'ms' }
        }, [
          el('div', { class: 'spec__label', text: sp.label }),
          el('div', { class: 'spec__value', text: sp.value }),
          el('div', { class: 'spec__detail', text: sp.detail })
        ]));
      });
      body.appendChild(grid);

      body.classList.remove('is-swapping');
    }, 200);
  }

  /* ===================================================================
     COLOUR GRID
     =================================================================== */

  function toggleColours() {
    state.coloursOpen = !state.coloursOpen;
    var panel = $('#colour-panel');
    panel.setAttribute('data-open', String(state.coloursOpen));
    var btn = $('#view-colours');
    if (btn) btn.setAttribute('aria-expanded', String(state.coloursOpen));
    if (state.coloursOpen) {
      window.setTimeout(function () {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        var input = $('#colour-search');
        if (input && window.innerWidth > 760) input.focus({ preventScroll: true });
      }, 260);
    }
  }

  function visibleColours() {
    var coll = collection();
    var q = U.norm(state.query.trim());
    return coll.colours.filter(function (c) {
      if (state.family !== 'all' && c.family !== state.family) return false;
      if (state.favOnly && !isFav(coll.id, c.name)) return false;
      if (q && U.norm(c.name).indexOf(q) === -1 && U.norm(c.hex).indexOf(q) === -1) return false;
      return true;
    });
  }

  function buildFilters() {
    var wrap = $('#colour-filters');
    if (!wrap) return;
    wrap.innerHTML = '';
    var coll = collection();
    var present = {};
    coll.colours.forEach(function (c) { present[c.family] = true; });

    CM.families.forEach(function (f) {
      if (f.id !== 'all' && !present[f.id]) return;
      var dot = el('span', { class: 'filter__dot' });
      dot.style.background = FAMILY_DOT[f.id] || '#888';
      wrap.appendChild(el('button', {
        class: 'filter', type: 'button',
        'data-family': f.id,
        'aria-pressed': String(state.family === f.id),
        onclick: function () {
          state.family = f.id;
          $$('#colour-filters .filter').forEach(function (b) {
            b.setAttribute('aria-pressed', String(b.dataset.family === f.id));
          });
          renderSwatches();
        }
      }, [dot, el('span', { text: f.label })]));
    });
  }

  function renderColours(opts) {
    var coll = collection();
    $('#colour-collection-name').textContent = coll.name;
    $('#colour-collection-tagline').textContent = coll.tagline;
    $('#colour-disclaimer').textContent = coll.disclaimer;

    /* A family that does not exist in the new collection would show nothing. */
    var hasFamily = coll.colours.some(function (c) { return c.family === state.family; });
    if (state.family !== 'all' && !hasFamily) state.family = 'all';

    buildFilters();

    if (opts && opts.resetSelection) {
      /* Seed a valid colour for the new collection, but this is a default and
         not a choice, so it must not travel into the quote on its own. */
      var first = coll.colours[0];
      state.selected = { collection: coll.id, name: first.name, hex: first.hex, metallic: !!first.metallic };
      state.colourChosen = false;
    }
    renderSwatches();
  }

  function renderSwatches() {
    var grid = $('#swatch-grid');
    if (!grid) return;
    var coll = collection();
    var list = visibleColours();

    grid.innerHTML = '';

    if (!list.length) {
      grid.appendChild(el('div', { class: 'empty-state' }, [
        el('strong', { text: 'No colours match those filters' }),
        el('span', { text: state.favOnly
          ? 'You have not saved any favourites in this collection yet.'
          : 'Try a different search term or clear the colour family filter.' })
      ]));
      updateCount(0, coll.colours.length);
      return;
    }

    list.forEach(function (c, i) {
      var selected = state.selected &&
                     state.selected.collection === coll.id &&
                     state.selected.name === c.name;

      var paint = el('span', {
        class: 'swatch__paint paint' + (c.metallic ? ' paint--metallic' : ''),
        style: { '--c': c.hex }
      });

      var meta = el('span', { class: 'swatch__meta' }, [
        el('span', { class: 'swatch__text' }, [
          el('span', { class: 'swatch__name', text: c.name }),
          el('span', { class: 'swatch__hex', text: c.hex }),
          c.note ? el('span', { class: 'swatch__note', text: c.note }) : null,
          c.stocked ? el('span', { class: 'swatch__note', text: 'Stocked' }) : null
        ])
      ]);

      var btn = el('button', {
        class: 'swatch__btn', type: 'button',
        'aria-pressed': String(!!selected),
        title: 'Add ' + c.name + ' to your quote request',
        onclick: function () { applyColour(coll.id, c); }
      }, [paint, meta]);

      var fav = el('button', {
        class: 'fav', type: 'button',
        'aria-pressed': String(isFav(coll.id, c.name)),
        'aria-label': (isFav(coll.id, c.name) ? 'Remove ' : 'Save ') + c.name + ' as a favourite',
        html: U.icon('heart'),
        onclick: function (ev) {
          ev.stopPropagation();
          toggleFavourite(coll.id, c, this);
        }
      });

      var card = el('div', {
        class: 'swatch' + (selected ? ' is-selected' : ''),
        'data-colour': c.name,
        style: { animationDelay: Math.min(i * 22, 460) + 'ms' }
      }, [btn, fav]);

      grid.appendChild(card);
    });

    updateCount(list.length, coll.colours.length);
  }

  function updateCount(shown, total) {
    var node = $('#colour-count');
    if (node) {
      node.textContent = shown === total
        ? total + ' colours in this collection'
        : shown + ' of ' + total + ' colours';
    }
  }

  function applyColour(collectionId, c) {
    state.selected = { collection: collectionId, name: c.name, hex: c.hex, metallic: !!c.metallic };
    state.colourChosen = true;
    $$('#swatch-grid .swatch').forEach(function (card) {
      var on = card.dataset.colour === c.name;
      card.classList.toggle('is-selected', on);
      var b = $('.swatch__btn', card);
      if (b) b.setAttribute('aria-pressed', String(on));
    });
    toast(c.hex, c.metallic, c.name + ' added to your quote request');
  }

  /* ------------------------------------------------------- favourites */

  function toggleFavourite(collectionId, c, btn) {
    var key = favKey(collectionId, c.name);
    var idx = state.favourites.indexOf(key);
    var added = idx === -1;

    if (added) state.favourites.push(key);
    else state.favourites.splice(idx, 1);

    U.store.set(FAV_KEY, state.favourites);

    if (btn) {
      btn.setAttribute('aria-pressed', String(added));
      btn.setAttribute('aria-label', (added ? 'Remove ' : 'Save ') + c.name + ' as a favourite');
      btn.classList.remove('is-pulsing');
      void btn.offsetWidth;               /* restart the animation */
      btn.classList.add('is-pulsing');
    }

    updateFavCount();
    renderDrawer();
    if (state.favOnly) renderSwatches();
    toast(c.hex, c.metallic, added ? c.name + ' saved to favourites' : c.name + ' removed from favourites');
  }

  function updateFavCount() {
    var node = $('#fav-count-value');
    var btn = $('#fav-count');
    if (node) node.textContent = state.favourites.length;
    if (btn) btn.setAttribute('data-empty', String(state.favourites.length === 0));
  }

  /* Resolve a stored key back to its colour record. */
  function favRecord(key) {
    var parts = key.split('::');
    var coll = CM.collections[parts[0]];
    if (!coll) return null;
    var c = coll.colours.filter(function (x) { return x.name === parts[1]; })[0];
    return c ? { collection: coll, colour: c, key: key } : null;
  }

  function renderDrawer() {
    var list = $('#drawer-list');
    if (!list) return;
    list.innerHTML = '';

    var records = state.favourites.map(favRecord).filter(Boolean);

    if (!records.length) {
      list.appendChild(el('div', { class: 'empty-state' }, [
        el('strong', { text: 'No favourites yet' }),
        el('span', { text: 'Tap the heart on any swatch to build a shortlist for your quote.' })
      ]));
      return;
    }

    records.forEach(function (r) {
      list.appendChild(el('div', { class: 'fav-row' }, [
        el('span', {
          class: 'fav-row__chip paint' + (r.colour.metallic ? ' paint--metallic' : ''),
          style: { '--c': r.colour.hex }
        }),
        el('span', {}, [
          el('span', { class: 'fav-row__name', text: r.colour.name }),
          el('span', { class: 'fav-row__sub', text: r.collection.id + ' · ' + r.colour.hex })
        ]),
        el('span', { class: 'fav-row__actions' }, [
          el('button', {
            class: 'fav-row__btn', type: 'button',
            title: 'Use this colour on the quote request',
            'aria-label': 'Use ' + r.colour.name + ' on the quote request',
            html: U.icon('eye'),
            onclick: function () {
              /* Jump the configurator to a material that carries this colour. */
              var target = CM.materials.filter(function (m) {
                return m.collection === r.collection.id;
              })[0];
              if (target) selectMaterial(target.id, { scrollIntoView: true });
              applyColour(r.collection.id, r.colour);
              closeDrawer();
              scrollToId('quote');
            }
          }),
          el('button', {
            class: 'fav-row__btn', type: 'button',
            title: 'Remove from favourites',
            'aria-label': 'Remove ' + r.colour.name + ' from favourites',
            html: U.icon('trash'),
            onclick: function () { toggleFavourite(r.collection.id, r.colour, null); renderSwatches(); }
          })
        ])
      ]));
    });
  }

  function openDrawer() {
    $('#drawer').setAttribute('data-open', 'true');
    $('#drawer-scrim').setAttribute('data-open', 'true');
    $('#drawer-close').focus();
  }
  function closeDrawer() {
    $('#drawer').setAttribute('data-open', 'false');
    $('#drawer-scrim').setAttribute('data-open', 'false');
  }

  /* ===================================================================
     TOAST
     =================================================================== */

  var toastTimer = null;
  function toast(hex, metallic, message) {
    var node = $('#toast');
    if (!node) return;
    $('#toast-chip').className = 'toast__chip paint' + (metallic ? ' paint--metallic' : '');
    $('#toast-chip').style.setProperty('--c', hex);
    $('#toast-text').textContent = message;
    node.setAttribute('data-open', 'true');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      node.setAttribute('data-open', 'false');
    }, 2400);
  }

  /* ===================================================================
     COPPER PATINA TIMELINE
     =================================================================== */

  function buildPatina() {
    var steps = $('#patina-steps');
    if (!steps) return;
    steps.innerHTML = '';

    CM.patinaTimeline.forEach(function (s, i) {
      steps.appendChild(el('button', {
        class: 'patina__step', type: 'button',
        'data-index': i,
        'aria-pressed': String(i === state.patina),
        style: { '--bead': s.hex },
        onclick: function () { setPatina(i, { stopAuto: true }); }
      }, [
        el('span', { class: 'patina__bead' }),
        el('span', { class: 'patina__step-label', text: s.stage })
      ]));
    });

    var auto = $('#patina-auto');
    if (auto) auto.addEventListener('click', function () { togglePatinaAuto(); });

    setPatina(0);
  }

  function setPatina(index, opts) {
    state.patina = index;
    var s = CM.patinaTimeline[index];

    $$('#patina-steps .patina__step').forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.index) === index));
    });

    var pct = CM.patinaTimeline.length > 1
      ? (index / (CM.patinaTimeline.length - 1)) * 100 : 0;
    $('#patina-progress').style.width = pct + '%';

    $('#patina-stage').innerHTML = CM.render.patina(index);

    var copy = $('#patina-copy');
    copy.classList.add('is-swapping');
    window.setTimeout(function () {
      $('#patina-stage-name').textContent = s.stage + ' · ' + s.title;
      $('#patina-body').textContent = s.body;
      copy.style.setProperty('--patina-accent', s.accent);
      copy.classList.remove('is-swapping');
    }, 180);

    if (opts && opts.stopAuto) togglePatinaAuto(false);
  }

  function togglePatinaAuto(force) {
    var next = force === undefined ? !state.patinaAuto : force;
    state.patinaAuto = next;
    var btn = $('#patina-auto');
    if (btn) {
      btn.setAttribute('aria-pressed', String(next));
      $('#patina-auto-label').textContent = next ? 'Pause weathering' : 'Play weathering';
    }
    clearInterval(patinaTimer);
    if (next) {
      patinaTimer = window.setInterval(function () {
        setPatina((state.patina + 1) % CM.patinaTimeline.length);
      }, 2600);
    }
  }

  /* ===================================================================
     ZINC PANEL
     =================================================================== */

  function buildZinc() {
    var grid = $('#zinc-grid');
    if (!grid) return;
    grid.innerHTML = '';

    CM.zincFinishes.forEach(function (f) {
      grid.appendChild(el('article', { class: 'zinc-card' }, [
        el('div', { class: 'zinc-card__render' }, [
          el('div', { html: CM.render.zinc(f), style: { height: '100%' } }),
          el('div', {
            class: 'zinc-card__macro',
            html: CM.render.zincMacro(f) +
                  '<span class="zinc-card__macro-label">Close-up texture</span>'
          })
        ]),
        el('div', { class: 'zinc-card__body' }, [
          el('h4', { class: 'zinc-card__name', text: f.name }),
          el('p', { class: 'zinc-card__text', text: f.body })
        ])
      ]));
    });

    var traits = $('#zinc-traits');
    if (!traits) return;
    var items = [
      ['heal', 'Self-healing surface',
       'The patina re-forms over scratches and cut edges. Handling marks that would be permanent on a painted panel disappear over a few months of weathering.'],
      ['hourglass', 'Extremely long lifespan',
       'Correctly detailed and free-draining, architectural zinc has a documented service life of 80 to 100 years and more. It outlives the fasteners and sealants around it.'],
      ['leaf', 'Low maintenance',
       'No cleaning schedule, no recoating, no touch-up. The only real requirement is a ventilated back face so moisture cannot sit against the underside.'],
      ['gem', 'Luxury architectural appearance',
       'A soft, matte, slightly variegated grey that reads as material rather than finish. It is the reason zinc keeps appearing on award-winning residential work.']
    ];
    traits.innerHTML = '';
    items.forEach(function (it) {
      traits.appendChild(el('div', { class: 'zinc-trait' }, [
        el('span', { class: 'zinc-trait__icon', html: U.icon(it[0]) }),
        el('h4', { class: 'zinc-trait__name', text: it[1] }),
        el('p', { class: 'zinc-trait__text', text: it[2] })
      ]));
    });
  }

  /* ===================================================================
     COMPARISON MATRIX
     =================================================================== */

  function buildCompare() {
    var head = $('#compare-head');
    var body = $('#compare-body');
    if (!head || !body) return;

    var cols = CM.comparison.materials.map(material);

    /* header */
    var hr = el('tr', {}, [el('th', { class: 'attr-col', scope: 'col' }, [
      el('span', { class: 'mono-label', text: 'Attribute' })
    ])]);
    cols.forEach(function (m) {
      var chip = el('span', { class: 'compare-head__chip paint', style: { '--c': m.swatch } });
      hr.appendChild(el('th', { scope: 'col', 'data-col': m.id }, [
        el('button', {
          class: 'compare-head', type: 'button',
          title: 'Show ' + m.name + ' in the configurator',
          onclick: function () { selectMaterial(m.id, { scrollIntoView: true }); scrollToId('materials'); }
        }, [chip, el('span', { class: 'compare-head__name', text: m.short })])
      ]));
    });
    head.innerHTML = '';
    head.appendChild(hr);

    /* rows */
    body.innerHTML = '';
    CM.comparison.rows.forEach(function (row) {
      var tr = el('tr', { 'data-row': row.id });

      tr.appendChild(el('th', { class: 'attr-col', scope: 'row' }, [
        el('span', { class: 'attr' }, [
          el('span', { class: 'attr__icon', html: U.icon(row.icon) }),
          el('span', {}, [
            el('span', { class: 'attr__label', text: row.label }),
            el('span', { class: 'attr__hint', text: row.hint })
          ])
        ])
      ]));

      cols.forEach(function (m) {
        var v = row.values[m.id];
        var note = row.footnotes && row.footnotes[m.id];
        var cell;

        if (row.type === 'rating') {
          var fill = el('span', { class: 'meter__fill', 'data-target': (v / 5) * 100 });
          cell = el('td', { 'data-col': m.id }, [
            el('span', { class: 'meter' }, [
              el('span', { class: 'meter__track' }, [fill]),
              el('span', { class: 'meter__value', text: v + '/5' })
            ]),
            note ? el('span', { class: 'meter__note', text: note }) : null
          ]);
        } else {
          cell = el('td', { 'data-col': m.id }, [
            el('span', { class: 'cell-text', 'data-tier': String(v).length, text: v })
          ]);
        }
        tr.appendChild(cell);
      });

      body.appendChild(tr);
    });

    focusCompareColumn(state.materialId);
    observeMeters();
  }

  function focusCompareColumn(id) {
    $$('#compare-table [data-col]').forEach(function (c) {
      c.classList.toggle('is-focus', c.dataset.col === id);
    });
  }

  /* Meters fill on first scroll into view - the animation is the payoff. */
  function observeMeters() {
    var table = $('#compare-table');
    if (!table) return;
    var fills = $$('.meter__fill', table);

    var run = function () {
      fills.forEach(function (f, i) {
        window.setTimeout(function () { f.style.width = f.dataset.target + '%'; }, i * 9);
      });
    };

    if (!('IntersectionObserver' in window) || U.prefersReducedMotion()) { run(); return; }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { run(); io.disconnect(); }
      });
    }, { threshold: 0.15 });
    io.observe(table);
  }

  /* ===================================================================
     SERVICES
     =================================================================== */

  /*
   * Contact / Visit our shops.
   *
   * Everything visible comes from CM.contactSection in
   * assets/js/data/locations.js. The owner writes only human-readable values
   * there; the tel: link, the mailto: links, the map frame and the directions
   * URL are all derived here from the address and phone as typed, so one
   * address change moves all four.
   *
   * Both map URLs are keyless and free. The embed is the plain
   * google.com/maps ?output=embed form, and directions use the documented
   * Maps URLs endpoint. No API key is created, stored or sent.
   */
  var MAPS_EMBED = 'https://www.google.com/maps?output=embed&q=';
  var MAPS_DIR = 'https://www.google.com/maps/dir/?api=1&destination=';

  function telHref(phone) {
    /* A tel: link has to be digits. Canadian numbers get the +1 country code
       so the link also works for someone dialling from outside Canada. */
    var digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (digits.length === 10) digits = '1' + digits;
    return 'tel:+' + digits;
  }

  function buildContact() {
    var section = CM.contactSection;
    var wrap = $('#contact-grid');
    if (!section || !wrap) return;

    var head = $('#contact-head');
    if (head) {
      head.innerHTML = '';
      head.appendChild(el('p', { class: 'eyebrow', text: section.eyebrow }));
      head.appendChild(el('h2', { class: 'headline', text: section.heading }));
      head.appendChild(el('p', { class: 'lede', text: section.intro }));
    }

    wrap.innerHTML = '';

    (section.locations || []).forEach(function (loc) {
      var a = loc.address || {};
      var cityLine = [a.city, a.region].filter(Boolean).join(', ');
      if (a.postalCode) cityLine += (cityLine ? ' ' : '') + a.postalCode;
      var oneLine = loc.mapAddress || [a.street, cityLine].filter(Boolean).join(', ');

      /* --- heading + address ---
         The name carries the label; a separate mono badge repeating it was
         the same words twice. "Primary" sits beside the heading rather than
         inside it, so it stays out of the accessible name. */
      var head = el('div', { class: 'loc__head' }, [
        el('h3', { class: 'loc__name', text: loc.label || '' }),
        loc.primary ? el('span', { class: 'loc__primary', text: 'Primary' }) : null
      ]);

      var address = el('address', { class: 'loc__address' }, [
        el('span', { text: a.street || '' }),
        el('span', { text: cityLine })
      ]);

      /* --- phone --- */
      var rows = [];
      var tel = telHref(loc.phone);
      if (tel) {
        rows.push(el('div', { class: 'loc__row' }, [
          el('span', { class: 'loc__row-label', text: 'Phone' }),
          el('a', {
            class: 'loc__link loc__link--phone', href: tel,
            'aria-label': 'Call the ' + loc.label + ' on ' + loc.phone,
            text: loc.phone
          })
        ]));
      }

      /* --- contacts --- */
      if (loc.contacts && loc.contacts.length) {
        var people = el('ul', { class: 'loc__people' });
        loc.contacts.forEach(function (c) {
          people.appendChild(el('li', { class: 'loc__person' }, [
            el('span', { class: 'loc__person-name', text: c.name || '' }),
            c.email ? el('a', {
              class: 'loc__link', href: 'mailto:' + c.email,
              'aria-label': 'Email ' + (c.name || '') + ' at the ' + loc.label + ', ' + c.email,
              text: c.email
            }) : null
          ]));
        });
        rows.push(el('div', { class: 'loc__row' }, [
          el('span', { class: 'loc__row-label', text: loc.contacts.length > 1 ? 'Contacts' : 'Contact' }),
          people
        ]));
      }

      /* --- what they make --- */
      if (loc.specialties) {
        rows.push(el('div', { class: 'loc__row' }, [
          el('span', { class: 'loc__row-label', text: 'Specializes in' }),
          el('p', { class: 'loc__spec', text: loc.specialties })
        ]));
      }

      /* --- directions + map --- */
      var directions = el('a', {
        class: 'btn btn--accent loc__cta',
        href: MAPS_DIR + encodeURIComponent(oneLine),
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': 'Get directions to the ' + loc.label + ' at ' + oneLine + ', opens Google Maps in a new tab'
      }, [
        el('span', { html: U.icon('pin') }),
        el('span', { text: 'Get directions' }),
        el('span', { class: 'visually-hidden', text: '(opens in a new tab)' })
      ]);

      /* The map frame always goes in. Nothing gates it.
      
         An earlier version tested google.com with a small image request first
         and only inserted the frame if that succeeded. That was wrong: a
         tracker blocker, a privacy extension, a corporate proxy or Google
         simply answering that one request differently would all fail the test
         while the map itself would have loaded perfectly well - and the
         visitor would have been shown a fallback plate instead of a working
         map they could have had. A false negative there costs more than the
         case it was guarding against.
      
         So the frame is inserted unconditionally and the address plate sits
         behind it, not instead of it. The frame is transparent until its load
         event fires, which means:
           - Google reachable  -> the real interactive map paints over the plate
           - frame blocked      -> nothing paints, the plate shows through
         No probe, no timing guess, no sniffing for any particular host. */
      var frameEl = el('iframe', {
        src: MAPS_EMBED + encodeURIComponent(oneLine),
        title: 'Map showing the ' + loc.label + ' at ' + oneLine,
        loading: 'lazy',
        referrerpolicy: 'no-referrer-when-downgrade'
      });
      frameEl.addEventListener('load', function () { frameEl.classList.add('is-ready'); });

      var map = el('div', { class: 'loc__map' }, [
        el('span', { class: 'loc__map-fallback' }, [
          el('span', { html: U.icon('pin') }),
          el('span', { text: oneLine })
        ]),
        frameEl
      ]);

      wrap.appendChild(el('article', {
        class: 'loc' + (loc.primary ? ' loc--primary' : ''),
        id: loc.id ? 'loc-' + loc.id : null
      }, [head, address, el('div', { class: 'loc__rows' }, rows), directions, map]));
    });

    buildContactHelp(section);
  }

  /*
   * The note above the cards for anyone unsure which shop to ring. The owner
   * writes one sentence with {phone} in it; the number is taken from whichever
   * location is marked primary, so it can never drift out of step with the
   * card below it.
   */
  function buildContactHelp(section) {
    var note = $('#contact-help');
    if (!note) return;
    note.innerHTML = '';

    var text = section.helpText;
    if (!text) { note.hidden = true; return; }
    note.hidden = false;

    var source = (section.locations || []).filter(function (l) { return l.primary; })[0] ||
                 (section.locations || [])[0];
    var tel = source ? telHref(source.phone) : null;
    var parts = String(text).split('{phone}');

    note.appendChild(document.createTextNode(parts[0]));
    if (parts.length > 1) {
      if (tel) {
        note.appendChild(el('a', {
          class: 'loc__link loc-help__phone', href: tel,
          'aria-label': 'Call the ' + source.label + ' on ' + source.phone,
          text: source.phone
        }));
      }
      note.appendChild(document.createTextNode(parts.slice(1).join('{phone}')));
    }
  }

  /*
   * Recent fabrication gallery.
   *
   * Everything visible in this section - the heading, the paragraph and every
   * card - comes from CM.workSection in assets/js/data/work.js, so the owner
   * changes the gallery by editing one data file and never this function.
   *
   * Cards are filtered on `enabled` and sorted on `order`. The grid is a
   * plain auto-flow grid, so any number of cards lays out on its own.
   */
  function buildWork() {
    var section = CM.workSection;
    var grid = $('#work-grid');
    if (!section || !grid) return;

    var head = $('#work-head');
    if (head) {
      head.innerHTML = '';
      head.appendChild(el('p', { class: 'eyebrow', text: section.eyebrow }));
      head.appendChild(el('h2', { class: 'headline', text: section.heading }));
      head.appendChild(el('p', { class: 'lede', text: section.intro }));
    }

    var projects = (section.projects || [])
      .filter(function (p) { return p && p.enabled !== false; })
      .slice()
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

    grid.innerHTML = '';

    if (!projects.length) {
      /* Nothing enabled is a legitimate state - an empty grid beats a broken
         one - but it is almost always a mistake, so say so in the console. */
      warnWork('every project is either missing or has enabled: false, so the gallery is empty');
      return;
    }

    projects.forEach(function (p) {
      if (!p.image) { warnWork('project "' + (p.id || '?') + '" has no image, skipping'); return; }
      if (!p.alt)   { warnWork('project "' + (p.id || '?') + '" has no alt text, so screen readers will skip the photo'); }

      var img = el('img', {
        src: p.image,
        alt: p.alt || '',
        loading: 'lazy',
        decoding: 'async',
        /* The frame already reserves a square box, so a missing width and
           height here costs no layout shift. */
        style: { objectPosition: p.objectPosition || 'center' }
      });

      /* Two sizes when the owner has supplied one, so a phone is not made to
         download a picture sized for a desktop. `sizes` tells the browser how
         wide the card will actually be BEFORE layout happens, which is the
         only way it can pick correctly; the values mirror the card widths in
         home.css. A photo with no imageLarge simply serves its one file. */
      if (p.imageLarge) {
        img.setAttribute('srcset', p.image + ' 720w, ' + p.imageLarge + ' 1200w');
        img.setAttribute('sizes',
          '(min-width: 1000px) min(33vw, 440px), (min-width: 640px) min(44vw, 340px), min(78vw, 320px)');
      }

      /* A missing file falls back to the labelled plate every other photo on
         the page uses, rather than a broken-image icon. */
      var frame = el('div', { class: 'work__frame slot', 'data-slot': true }, [
        img,
        el('div', { class: 'slot__ph' }, [
          el('span', { class: 'slot__ph-icon', html: U.icon('photo') }),
          el('span', { class: 'slot__ph-label', text: p.title || 'Photograph' }),
          el('span', { class: 'slot__ph-file', text: p.image })
        ])
      ]);

      img.addEventListener('error', function () {
        warnWork('the file "' + p.image + '" could not be loaded - check the name and that it is in assets/img/work/');
      });

      /* The small grey line is optional. An empty span still occupies its
         line box and its gap, so a card with no caption would sit taller
         than its neighbours for no reason - leave the element out instead. */
      var captionText = (p.caption || '').trim();
      var figcaption = el('figcaption', {}, [
        el('span', { class: 'work__title', text: p.title || '' }),
        captionText ? el('span', { class: 'work__meta', text: captionText }) : null
      ]);

      grid.appendChild(el('figure', { class: 'work' }, [frame, figcaption]));
    });

    makeWorkScrollable(grid);
  }

  /*
   * Below 1000px the gallery becomes one sideways-scrolling row (see
   * .work-grid in home.css). The scrolling itself is the browser's, not
   * ours - but a scroll box whose contents are not focusable is
   * unreachable by keyboard, so it needs a tab stop and a name of its own.
   *
   * Given only when it actually overflows. Adding tabindex unconditionally
   * would leave a tab stop on desktop that focuses a box which does not
   * scroll, which is worse than not having one.
   */
  function makeWorkScrollable(grid) {
    var sync = function () {
      var scrollable = grid.scrollWidth > grid.clientWidth + 1;
      if (scrollable) {
        grid.setAttribute('tabindex', '0');
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', 'Recent fabrication, scroll sideways for more');
      } else {
        grid.removeAttribute('tabindex');
        grid.removeAttribute('role');
        grid.removeAttribute('aria-label');
      }
    };

    sync();
    /* Images arrive after layout, and a rotated phone changes the answer. */
    window.addEventListener('resize', sync);
    window.addEventListener('load', sync);

    railAffordance(grid, {
      itemSelector: '.work',
      label: 'photo',
      insertAfter: grid
    });
  }

  /* ===================================================================
     SCROLLING RAILS - saying out loud that there is more

     A row that scrolls sideways looks identical to a row that does not.
     The partly visible card at the edge is a hint, and it is easy to
     miss; with a mouse there is often no obvious way to move the row at
     all, because a trackpad's sideways gesture is not something everyone
     knows they have.

     So the state gets stated: how many there are, which one you are on,
     and a pair of arrows that move it. Built only for rails that
     actually overflow - a row that fits shows nothing - and rebuilt on
     resize, because a phone turned sideways changes the answer.
     =================================================================== */

  function railAffordance(rail, opts) {
    if (!rail) return;

    var items = function () {
      return Array.prototype.slice.call(rail.querySelectorAll(opts.itemSelector));
    };
    var nav = null;
    var dots = [];

    function overflows() { return rail.scrollWidth > rail.clientWidth + 2; }

    /* Which item is nearest the left edge. Comparing against the rail's own
       box rather than the page means this stays right whatever the rail's
       padding or the page's scroll position. */
    function activeIndex() {
      var list = items();
      var railLeft = rail.getBoundingClientRect().left;
      var best = 0;
      var bestDist = Infinity;
      for (var i = 0; i < list.length; i++) {
        var d = Math.abs(list[i].getBoundingClientRect().left - railLeft);
        if (d < bestDist - 1) { bestDist = d; best = i; }
      }
      /* Scrolled hard to the end: the last item is the honest answer even
         when an earlier one happens to sit closer to the left edge. */
      if (rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2) {
        best = list.length - 1;
      }
      return best;
    }

    function scrollToIndex(i) {
      var list = items();
      if (!list[i]) return;
      rail.scrollTo({
        left: list[i].offsetLeft - rail.offsetLeft,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
      });
    }

    function step(dir) {
      var i = activeIndex() + dir;
      scrollToIndex(Math.max(0, Math.min(items().length - 1, i)));
    }

    function build() {
      var list = items();
      nav = el('div', { class: 'rail-nav' });

      var prev = el('button', {
        class: 'rail-nav__arrow', type: 'button',
        'aria-label': 'Previous ' + opts.label
      });
      prev.innerHTML = arrowSvg('left');
      prev.addEventListener('click', function () { step(-1); });

      var next = el('button', {
        class: 'rail-nav__arrow', type: 'button',
        'aria-label': 'Next ' + opts.label
      });
      next.innerHTML = arrowSvg('right');
      next.addEventListener('click', function () { step(1); });

      var dotWrap = el('div', {
        class: 'rail-nav__dots', role: 'group',
        'aria-label': 'Jump to a ' + opts.label
      });
      dots = list.map(function (_, i) {
        var d = el('button', {
          class: 'rail-nav__dot', type: 'button',
          'aria-label': 'Show ' + opts.label + ' ' + (i + 1) + ' of ' + list.length
        });
        d.addEventListener('click', function () { scrollToIndex(i); });
        dotWrap.appendChild(d);
        return d;
      });

      /* The count in words as well as dots. A row of dots tells you how
         many there are only once you have counted them; "1 / 6" does not
         need counting, and it is what a screen reader announces. */
      var count = el('span', {
        class: 'rail-nav__count',
        'aria-live': 'polite',
        'aria-atomic': 'true'
      });

      nav.appendChild(prev);
      nav.appendChild(dotWrap);
      nav.appendChild(count);
      nav.appendChild(next);

      nav._prev = prev; nav._next = next; nav._count = count;

      var anchor = opts.insertAfter || rail;
      anchor.parentNode.insertBefore(nav, anchor.nextSibling);
    }

    function paint() {
      if (!nav) return;
      var i = activeIndex();
      var total = items().length;

      dots.forEach(function (d, n) {
        if (n === i) d.setAttribute('aria-current', 'true');
        else d.removeAttribute('aria-current');
      });

      nav._count.textContent = (i + 1) + ' / ' + total;

      var atStart = rail.scrollLeft <= 2;
      var atEnd = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
      nav._prev.disabled = atStart;
      nav._next.disabled = atEnd;
    }

    function sync() {
      if (overflows()) {
        if (!nav) build();
        nav.hidden = false;
        paint();
      } else if (nav) {
        nav.hidden = true;
      }
    }

    /* rAF-throttled: a scroll fires far more often than a repaint is
       useful, and the work here reads layout. */
    var ticking = false;
    rail.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { paint(); ticking = false; });
    }, { passive: true });

    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('load', sync);
  }

  function arrowSvg(dir) {
    var d = dir === 'left' ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5';
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
           '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.7" ' +
           'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function prefersReducedMotion() {
    return window.matchMedia &&
           window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function warnWork(message) {
    if (window.console && console.warn) {
      console.warn('Recent fabrication: ' + message + ' (edit assets/js/data/work.js)');
    }
  }

  function buildServices() {
    var wrap = $('#services-grid');
    if (!wrap) return;
    wrap.innerHTML = '';

    CM.services.forEach(function (svc, i) {
      wrap.appendChild(el('article', { class: 'service' }, [
        el('p', { class: 'service__index', text: String(i + 1).padStart(2, '0') }),
        el('h3', { class: 'service__name', text: svc.name }),
        el('p', { class: 'service__body', text: svc.body }),
        el('button', {
          class: 'service__cta', type: 'button',
          onclick: function () { requestQuoteFor(svc.id); }
        }, [
          el('span', { text: 'Request a quote' }),
          el('span', { html: U.icon('arrow') })
        ])
      ]));
    });
  }

  /*
   * Carry the service into the request. The checkbox list was removed, so the
   * service name seeds the details field instead, and only when it is empty so
   * a half-typed message is never overwritten.
   */
  function requestQuoteFor(serviceId) {
    var svc = CM.services.filter(function (x) { return x.id === serviceId; })[0];
    var details = $('#q-details');
    if (svc && details && !details.value.trim()) {
      details.value = svc.name + ': ';
    }
    scrollToId('quote');
    window.setTimeout(function () {
      var target = (details && details.value.trim()) ? details : $('#q-name');
      if (target && window.innerWidth > 760) {
        target.focus({ preventScroll: true });
        if (target === details) target.setSelectionRange(target.value.length, target.value.length);
      }
    }, 620);
  }

  /* ===================================================================
     QUOTE REQUEST
     =================================================================== */

  function buildQuote() {
    var form = $('#quote-form');
    if (!form) return;

    buildMaterialPicker();
    buildDrawingField();
    probeQuoteUpload();

    fillSelect($('#q-timeline'), CM.timelines, 'Select a timeline');

    $('#quote-form').addEventListener('submit', submitQuote);
    $('#quote-reset').addEventListener('click', resetQuote);
    $('#quote-copy').addEventListener('click', copyQuote);
    $('#quote-copy-done').addEventListener('click', copyQuote);

    /* Clear the invalid state as soon as the visitor starts fixing it. */
    $$('#quote-form input, #quote-form select, #quote-form textarea').forEach(function (input) {
      input.addEventListener('input', function () {
        var field = input.closest('.field');
        if (field) field.classList.remove('is-invalid');
      });
    });

  }

  /*
   * Material picker. The same material can appear more than once, because a
   * job often takes one gauge in two colours, so this adds line items rather
   * than toggling a fixed set of checkboxes. Each line owns its own colour.
   */
  var lineSeq = 0;

  function buildMaterialPicker() {
    var panel = $('#q-materials-panel');
    var toggle = $('#q-materials-toggle');
    if (!panel || !toggle) return;

    panel.innerHTML = '';
    CM.materials.forEach(function (m) {
      panel.appendChild(el('button', {
        class: 'multi__opt', type: 'button',
        onclick: function () { addMaterialLine(m.id); }
      }, [
        el('span', { class: 'multi__opt-add', html: U.icon('plus') }),
        el('span', { class: 'multi__chip paint', style: { '--c': m.swatch } }),
        el('span', { text: m.name })
      ]));
    });

    toggle.addEventListener('click', function () {
      setMaterialPanel(toggle.getAttribute('aria-expanded') !== 'true');
    });

    /* Close on outside click and on Escape, like any other menu. */
    document.addEventListener('click', function (ev) {
      if (!$('#q-materials').contains(ev.target)) setMaterialPanel(false);
    });
    panel.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { setMaterialPanel(false); toggle.focus(); }
    });

    syncMaterialLines();
  }

  function setMaterialPanel(open) {
    var panel = $('#q-materials-panel');
    var toggle = $('#q-materials-toggle');
    if (!panel) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  /*
   * Adds one line. The panel deliberately stays open so a visitor wanting the
   * same gauge in three colours can click it three times.
   */
  function addMaterialLine(materialId, presetColour) {
    var wrap = $('#q-material-colours');
    var m = CM.materials.filter(function (x) { return x.id === materialId; })[0];
    if (!wrap || !m) return;

    var coll = CM.collections[m.collection];
    var id = 'line-' + (++lineSeq);
    var chip = el('span', { class: 'matcolour__chip paint' });

    var sel = el('select', {
      'data-material': m.id,
      id: id + '-colour',
      'aria-label': 'Colour for ' + m.name,
      onchange: function () { paintChip(chip, coll, this.value); }
    });
    sel.appendChild(el('option', { value: '', text: 'Colour not decided yet' }));
    coll.colours.forEach(function (c) {
      sel.appendChild(el('option', { value: c.name, text: c.name }));
    });

    /* Seed from the argument, else from a colour picked while browsing. */
    var seed = presetColour;
    if (seed === undefined && state.colourChosen && state.selected &&
        state.selected.collection === coll.id) {
      seed = state.selected.name;
    }
    if (seed) sel.value = seed;
    paintChip(chip, coll, sel.value);

    var row = el('div', { class: 'matcolour', 'data-line': id }, [
      el('span', { class: 'matcolour__name', text: m.name }),
      el('span', { class: 'matcolour__pick' }, [chip, sel]),
      el('button', {
        class: 'matcolour__remove', type: 'button',
        'aria-label': 'Remove this ' + m.name + ' line',
        html: U.icon('close'),
        onclick: function () { row.remove(); syncMaterialLines(); }
      }),
      el('span', { class: 'matcolour__note', text: coll.name })
    ]);

    wrap.appendChild(row);
    syncMaterialLines();
    if (window.innerWidth > 760) sel.focus();
  }

  /* Keeps the empty-state hint and the toggle label honest. */
  function syncMaterialLines() {
    var rows = $$('#q-material-colours .matcolour');
    var hint = $('#q-materials-empty');
    var value = $('#q-materials-value');
    var wrap = $('#q-materials');

    if (hint) hint.hidden = rows.length > 0;
    if (wrap) wrap.classList.toggle('has-selection', rows.length > 0);
    if (value) {
      value.textContent = rows.length
        ? 'Add another material  (' + rows.length + ' added)'
        : 'Add a material';
    }
  }

  function paintChip(chip, coll, colourName) {
    var c = coll.colours.filter(function (x) { return x.name === colourName; })[0];
    chip.className = 'matcolour__chip paint' + (c && c.metallic ? ' paint--metallic' : '');
    if (c) chip.style.setProperty('--c', c.hex);
    else chip.style.removeProperty('--c');
  }

  /* [{ material, colour, hex }] for the request body, in the order added. */
  function materialChoices() {
    return $$('#q-material-colours .matcolour').map(function (row) {
      var sel = $('select', row);
      var m = CM.materials.filter(function (x) { return x.id === sel.dataset.material; })[0];
      var coll = m ? CM.collections[m.collection] : null;
      var c = (coll && sel.value)
        ? coll.colours.filter(function (x) { return x.name === sel.value; })[0] : null;
      return {
        material: m ? m.name : sel.dataset.material,
        colour: sel.value,
        hex: c ? c.hex : ''
      };
    });
  }

  /*
   * Drawing attachment.
   *
   * These four numbers mirror the ones in api/quote.js. The server enforces
   * them; these exist only so a customer who picks a 40 MB photo hears about
   * it immediately instead of after an upload. If you change one, change both.
   */
  var UPLOAD = {
    maxFiles: 5,
    maxFileBytes: 2.5 * 1024 * 1024,
    maxTotalBytes: 3 * 1024 * 1024,
    /* Mirrors CM.drawingTypes. The server decides for real, by reading the
       bytes; this is the fast, friendly check. */
    extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'dwg', 'dxf', 'doc', 'docx']
  };

  function buildDrawingField() {
    var input = $('#q-drawing');
    if (!input) return;
    input.setAttribute('accept', CM.drawingTypes);
    input.addEventListener('change', renderDrawingList);
  }

  function extensionOf(filename) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(filename || '');
    return m ? m[1].toLowerCase() : '';
  }

  /*
   * Returns a customer-facing sentence when the picked files cannot be sent,
   * or null when they are fine. Never surfaces an API error verbatim.
   */
  function checkDrawings(files) {
    if (files.length > UPLOAD.maxFiles) {
      return 'Please attach no more than ' + UPLOAD.maxFiles +
             ' files. You can email any extras to us directly.';
    }
    var total = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (UPLOAD.extensions.indexOf(extensionOf(f.name)) === -1) {
        return '"' + f.name + '" is not a file type we can open. ' +
               'Please send a PDF, image, DWG, DXF or Word file.';
      }
      if (f.size > UPLOAD.maxFileBytes) {
        return '"' + f.name + '" is larger than ' +
               (Math.round(UPLOAD.maxFileBytes / 1024 / 1024 * 10) / 10) +
               ' MB. Please send that one by email instead.';
      }
      total += f.size;
    }
    if (total > UPLOAD.maxTotalBytes) {
      return 'Those files come to more than ' +
             Math.round(UPLOAD.maxTotalBytes / 1024 / 1024) +
             ' MB together. Please attach the important ones and email the rest.';
    }
    return null;
  }

  /* FileReader rather than arrayBuffer(), so this still works on the older
     iOS Safari versions a contractor on a job site is likely to be holding. */
  function readAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        if (comma === -1) { reject(new Error('unreadable')); return; }
        resolve(result.slice(comma + 1));
      };
      reader.onerror = function () { reject(new Error('unreadable')); };
      reader.readAsDataURL(file);
    });
  }

  function fileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function renderDrawingList() {
    var input = $('#q-drawing');
    var list = $('#q-drawing-list');
    var hint = $('#q-drawing-hint');
    if (!list) return;

    var files = input.files ? Array.prototype.slice.call(input.files) : [];
    list.innerHTML = '';
    files.forEach(function (f) {
      list.appendChild(el('li', {}, [
        el('span', { class: 'filelist__name', text: f.name }),
        el('span', { class: 'filelist__size', text: fileSize(f.size) })
      ]));
    });

    if (!hint) return;
    hint.hidden = files.length === 0;
    if (!files.length) { hint.classList.remove('field__hint--bad'); return; }

    /* Say what will actually happen to these files. The answer differs
       depending on whether this deployment can send them, so it is read
       from the endpoint rather than hard-coded into the markup. */
    var problem = checkDrawings(files);
    hint.classList.toggle('field__hint--bad', Boolean(problem));
    hint.textContent = problem ? problem
      : state.quoteUpload
        ? 'These will be attached to your request.'
        : 'Your email app cannot pick files up from a web page, so attach these to the ' +
          'message that opens before you send it. We have listed them in the request ' +
          'so nothing gets missed.';
  }

  function drawingNames() {
    var input = $('#q-drawing');
    if (!input || !input.files) return [];
    return Array.prototype.slice.call(input.files).map(function (f) {
      return f.name + ' (' + fileSize(f.size) + ')';
    });
  }

  function fillSelect(node, options, placeholder) {
    if (!node) return;
    node.innerHTML = '';
    node.appendChild(el('option', { value: '', text: placeholder }));
    options.forEach(function (o) {
      node.appendChild(el('option', { value: o, text: o }));
    });
  }

  function markInvalid(input, invalid) {
    var field = input.closest('.field');
    if (field) field.classList.toggle('is-invalid', invalid);
    return !invalid;
  }

  function validateQuote() {
    var ok = true;
    var firstBad = null;

    /* Name and email are all that is genuinely required: without them a quote
       cannot be addressed or returned. Project details used to be required
       too, but a customer who just wants a number for a chase cover should
       not be blocked by a minimum word count - and the drawings they attach
       often say more than the box would. */
    [['#q-name', function (v) { return v.trim().length > 1; }],
     ['#q-email', function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()); }]
    ].forEach(function (pair) {
      var input = $(pair[0]);
      var good = pair[1](input.value);
      markInvalid(input, !good);
      if (!good) { ok = false; if (!firstBad) firstBad = input; }
    });

    if (firstBad) firstBad.focus();
    return ok;
  }

  /*
   * There is no server behind this page, so "send" composes the request into
   * an email the visitor's client opens, and offers the same text on the
   * clipboard as a fallback. Nothing is silently swallowed.
   */
  function buildQuoteText() {
    var form = $('#quote-form');
    var val = function (id) { return ($(id).value || '').trim(); };
    var choices = materialChoices();
    var drawings = drawingNames();

    var favs = state.favourites.map(favRecord).filter(Boolean).map(function (r) {
      return r.colour.name + ' (' + r.collection.name + ', ' + r.colour.hex + ')';
    });

    var lines = [
      'QUOTE REQUEST',
      '',
      'Name:      ' + val('#q-name'),
      'Company:   ' + (val('#q-company') || 'not given'),
      'Email:     ' + val('#q-email'),
      'PO / Job:  ' + (val('#q-po') || 'not given'),
      'Phone:     ' + (val('#q-phone') || 'not given'),
      '',
      'Timeline:  ' + (val('#q-timeline') || 'not given'),
      ''
    ];

    if (choices.length) {
      lines.push('Materials:');
      choices.forEach(function (ch) {
        lines.push('  · ' + ch.material +
          (ch.colour ? '  |  ' + ch.colour + (ch.hex ? ' (' + ch.hex + ')' : '')
                     : '  |  colour not decided yet'));
      });
    } else {
      lines.push('Materials:    not specified');
    }

    if (favs.length) {
      lines.push('', 'Saved colours:');
      favs.forEach(function (f) { lines.push('  · ' + f); });
    }

    if (drawings.length) {
      lines.push('', 'Drawings attached to this email:');
      drawings.forEach(function (d) { lines.push('  · ' + d); });
    }

    /* Optional since the field was relaxed. An empty box gets the same
       "not given" the other optional fields use, so the email never carries
       an empty heading - and never the words undefined, null or "". */
    var details = val('#q-details');
    if (details) lines.push('', 'Project details:', details);
    else lines.push('', 'Project details: not given');

    lines.push('', 'Sent from the Esther\'s materials configurator');

    if (form) { /* keeps the linter honest about the unused binding */ }
    return lines.join('\n');
  }

  /*
   * Ask the endpoint whether it can actually send mail. A deployment with no
   * mailbox configured answers ready:false, and one with no function at all
   * answers 404 - both mean the same thing here, so both fall back to the
   * mailto: flow. Nothing about the key is requested or returned; the answer
   * is a boolean.
   */
  function probeQuoteUpload() {
    if (!window.fetch) return;
    fetch('/api/quote', { method: 'GET', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        state.quoteUpload = Boolean(info && info.ready);
        renderDrawingList();
      })
      .catch(function () { state.quoteUpload = false; });
  }

  function setQuoteSending(sending) {
    var btn = $('#quote-form button[type="submit"]');
    if (!btn) return;
    btn.disabled = sending;
    btn.classList.toggle('is-busy', sending);
    var label = btn.querySelector('span');
    if (label) {
      if (sending) {
        if (!btn.dataset.label) btn.dataset.label = label.textContent;
        label.textContent = 'Sending…';
      } else if (btn.dataset.label) {
        label.textContent = btn.dataset.label;
      }
    }
  }

  /*
   * The mailto: composer. This was the whole of "send" until the upload
   * endpoint existed, and it stays as the fallback for a deployment with no
   * mailbox wired up. It cannot carry files - a mailto: URI has no
   * attachment field - which is exactly why it is no longer the main path.
   */
  function sendQuoteByMail(body) {
    var subject = 'Quote request from ' + $('#q-name').value.trim();
    /* Several addresses are allowed; a comma-separated list is what a mailto:
       To field takes, so every one of them is on the message. */
    var to = [].concat(CM.quoteEmail).join(',');
    var href = 'mailto:' + to +
               '?subject=' + encodeURIComponent(subject) +
               '&body=' + encodeURIComponent(body);

    state.quoteText = body;
    $('#quote-form').classList.add('is-sent');
    window.location.href = href;
  }

  function submitQuote(ev) {
    ev.preventDefault();
    if (!validateQuote()) {
      toast('#d4574f', false, 'Check the highlighted fields');
      return;
    }

    var input = $('#q-drawing');
    var files = (input && input.files) ? Array.prototype.slice.call(input.files) : [];

    var problem = checkDrawings(files);
    if (problem) {
      renderDrawingList();
      toast('#d4574f', false, problem);
      if (input) input.focus();
      return;
    }

    var body = buildQuoteText();
    state.quoteText = body;

    /* No endpoint on this deployment: compose the email as before. The done
       panel tells the customer to attach the files themselves, which is the
       truth on this path. */
    if (!state.quoteUpload || !window.fetch) {
      sendQuoteByMail(body);
      return;
    }

    setQuoteSending(true);

    Promise.all(files.map(function (f) {
      return readAsBase64(f).then(function (data) {
        return { name: f.name, type: f.type || '', size: f.size, data: data };
      });
    })).then(function (payloadFiles) {
      /* A file that would not read must not become a quietly attachment-less
         "success". Better to stop and say so. */
      if (payloadFiles.length !== files.length) throw new Error('unreadable');

      return fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#q-name').value.trim(),
          email: $('#q-email').value.trim(),
          subject: 'Quote request from ' + $('#q-name').value.trim(),
          text: body,
          files: payloadFiles
        })
      });
    }).then(function (response) {
      return response.json().catch(function () { return {}; })
        .then(function (data) { return { response: response, data: data }; });
    }).then(function (result) {
      var data = result.data || {};

      /* The mailbox went away between the probe and the send. Fall back
         rather than telling the customer their request failed. */
      if (result.response.status === 503 && data.notConfigured) {
        setQuoteSending(false);
        sendQuoteByMail(body);
        return;
      }

      if (!result.response.ok || !data.ok) {
        throw new Error(data.error || '');
      }

      /* Success state ONLY here - after the provider accepted the message.
         The form is left exactly as the customer filled it; resetQuote is
         what clears it, and only when they ask for another request. */
      setQuoteSending(false);
      state.quoteSentCount = files.length;
      var title = $('.quote__done-title');
      if (title && title.dataset.sent) title.textContent = title.dataset.sent;
      $('#quote-form').classList.add('is-sent', 'is-sent--server');
      toast(material().accent, false,
        files.length ? 'Request sent with ' + files.length +
                       (files.length === 1 ? ' attachment' : ' attachments')
                     : 'Request sent');
    }).catch(function (err) {
      setQuoteSending(false);
      /* The customer's answers stay on screen, untouched, so they can retry
         or copy the request instead. */
      var message = (err && err.message) ? err.message : '';
      toast('#d4574f', false, message ||
        'We could not send your request just now. Please try again, or copy it and email us.');
    });
  }

  function resetQuote() {
    var form = $('#quote-form');
    form.reset();
    form.classList.remove('is-sent', 'is-sent--server');
    /* The heading is swapped on a real send, so put it back for the next one. */
    var title = $('.quote__done-title');
    if (title) title.textContent = 'Your request is ready to send';
    setQuoteSending(false);
    state.quoteSentCount = 0;
    $('#q-material-colours').innerHTML = '';
    syncMaterialLines();
    renderDrawingList();
    setMaterialPanel(false);
    $$('#quote-form .field').forEach(function (f) { f.classList.remove('is-invalid'); });
    scrollToId('quote');
  }

  function copyQuote() {
    /* Copying is what a visitor with no mail handler falls back to, so the
       text has to carry the address the mailto: link would have supplied. */
    var text = 'Send to: ' + [].concat(CM.quoteEmail).join(', ') + '\n\n' +
               (state.quoteText || buildQuoteText());
    var done = function () { toast(material().accent, false, 'Request copied to your clipboard'); };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }

    function fallbackCopy() {
      var ta = el('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast('#d4574f', false, 'Could not copy, select the text manually'); }
      document.body.removeChild(ta);
    }
  }

  /* ===================================================================
     PAGE CHROME
     =================================================================== */

  function scrollToId(id) {
    var node = document.getElementById(id);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /*
   * Photographs are dropped into assets/img/ by hand. Until a file exists the
   * slot shows a labelled plate naming the missing file, so the layout holds
   * and nobody sees a broken-image icon.
   */
  function buildImageSlots() {
    $$('[data-slot]').forEach(function (slot) {
      var img = $('img', slot);
      if (!img) return;

      var fail = function () { slot.setAttribute('data-missing', 'true'); };
      var pass = function () { slot.removeAttribute('data-missing'); };

      if (img.complete) {
        /* naturalWidth is 0 for an image that finished loading and failed */
        if (img.naturalWidth === 0) fail(); else pass();
      }
      img.addEventListener('error', fail);
      img.addEventListener('load', function () {
        if (img.naturalWidth > 0) pass();
      });
    });
  }

  function buildReveal() {
    var nodes = $$('.reveal');
    if (!('IntersectionObserver' in window) || U.prefersReducedMotion()) {
      nodes.forEach(function (n) { n.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px' });
    nodes.forEach(function (n) { io.observe(n); });
  }

  function wireSearch() {
    var input = $('#colour-search');
    var wrap = $('#colour-search-wrap');
    if (!input) return;

    var apply = U.debounce(function () {
      state.query = input.value;
      wrap.classList.toggle('is-filled', input.value.length > 0);
      renderSwatches();
    }, 110);

    input.addEventListener('input', apply);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; apply(); }
    });
    $('#colour-search-clear').addEventListener('click', function () {
      input.value = '';
      state.query = '';
      wrap.classList.remove('is-filled');
      renderSwatches();
      input.focus();
    });
  }

  function wireFavourites() {
    $('#fav-count').addEventListener('click', openDrawer);
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#drawer-scrim').addEventListener('click', closeDrawer);

    $('#fav-only').addEventListener('click', function () {
      state.favOnly = !state.favOnly;
      this.setAttribute('aria-pressed', String(state.favOnly));
      $('#fav-only-label').textContent = state.favOnly ? 'Showing favourites' : 'Favourites only';
      renderSwatches();
    });

    $('#drawer-clear').addEventListener('click', function () {
      state.favourites = [];
      U.store.set(FAV_KEY, state.favourites);
      updateFavCount();
      renderDrawer();
      renderSwatches();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  /* ------------------------------------------------------------- init */

  function init() {
    buildRail();
    buildWork();
    buildContact();
    buildServices();
    buildQuote();
    buildPatina();
    buildZinc();
    buildCompare();
    wireSearch();
    wireFavourites();
    updateFavCount();
    renderDrawer();
    buildImageSlots();
    buildReveal();

    /* force:true so the first paint runs the full render path */
    selectMaterial(state.materialId, { force: true });

    $('#hero-cta').addEventListener('click', function () { scrollToId('materials'); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.CM);
