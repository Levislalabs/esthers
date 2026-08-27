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
   * Drawing attachment. A mailto: link cannot carry a file, so the picked
   * files are listed in the request and the customer is told to attach them
   * to the message that opens. Nothing here pretends to upload.
   */
  function buildDrawingField() {
    var input = $('#q-drawing');
    if (!input) return;
    input.setAttribute('accept', CM.drawingTypes);
    input.addEventListener('change', renderDrawingList);
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
    if (hint) hint.hidden = files.length === 0;
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

    [['#q-name', function (v) { return v.trim().length > 1; }],
     ['#q-email', function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()); }],
     ['#q-details', function (v) { return v.trim().length > 9; }]
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

    lines.push('', 'Project details:', val('#q-details'));
    lines.push('', 'Sent from the Esther\'s materials configurator');

    if (form) { /* keeps the linter honest about the unused binding */ }
    return lines.join('\n');
  }

  function submitQuote(ev) {
    ev.preventDefault();
    if (!validateQuote()) {
      toast('#d4574f', false, 'Check the highlighted fields');
      return;
    }

    var body = buildQuoteText();
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

  function resetQuote() {
    var form = $('#quote-form');
    form.reset();
    form.classList.remove('is-sent');
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
