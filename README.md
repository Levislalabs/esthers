# esthers

Esther's Sheet Metal — company site and materials configurator.

A single-page, dependency-free site for a custom architectural sheet metal
shop in Burnaby, BC. Leads with the work and the services, then hands the
visitor a full materials and colour configurator that feeds a quote request.

## Running it

There is no build step and no package manager. Open `index.html` in a browser,
or serve the directory:

```sh
python3 -m http.server 8000    # then visit http://localhost:8000
```

## What's in it

| Section | Behaviour |
| --- | --- |
| Hero + credibility | The pitch alongside a photograph of real work, followed by four verifiable facts about the shop. |
| Our work | Gallery of recent fabrication. Every image is an **image slot** — see below. |
| Process | The four steps from measurement to delivery, and what the customer needs to supply at each. |
| Material selector | Eight materials on a snap-scrolling rail. Selecting one re-renders the spec panel, swaps the colour collection, updates what the quote request carries, and cascades an accent colour through the page. |
| Spec panel | Gauges, finish description, applications, warranty, thickness, durability, cost category and maintenance for each material, plus feature pills for PVDF / aluminum / copper / zinc. |
| Colour grid | Opened by **View Available Colours**. Live search, colour-family filters, favourites (persisted to `localStorage`), and hover states that enlarge the swatch and sweep its specular highlight. |
| Copper patina | Five-stage weathering timeline (Day 1 → 10 Years) with scrub control and autoplay. Later stages layer clipped mottling so the change reads as chemistry, not a hue shift. |
| Zinc | Architectural renderings of Natural, Pre-weathered, Quartz and Anthra zinc, each with a close-up texture strip on hover. |
| Comparison tool | Twelve attributes across all eight materials. Sticky header and attribute column, meters that fill on scroll, and column focus tied to the current material. |
| Services | The seven fabrication services, each with a **Request a quote** action that ticks the matching box on the form below and jumps to it. |
| Quote request | Carries the current material, the selected colour and every saved favourite into the request, so the quote matches what was on screen. |

## Colour data

Colour names and collection membership follow the Cascadia Metals **Classic
(SMP)** and **Signature (PVDF)** colour cards.

**Hex values are on-screen approximations, not colour-matched values.** They
exist to drive the preview. Screen rendering, gloss level and ambient lighting
all shift perceived colour, and some colours are regional or mill-order only.
Confirm against a physical metal chip before ordering. This caveat is surfaced
in the UI on every collection and in the footer.

To correct a value or add a colour, edit `assets/js/data/colours.js` — nothing
else needs to change.

## Structure

```
index.html
assets/css/base.css            design tokens, typography, shell chrome
assets/css/home.css            hero, credibility strip, work gallery, process
assets/css/configurator.css    selector, colour grid, patina, compare, services, quote
assets/js/util.js              colour maths, DOM helpers, icon set
assets/js/data/colours.js      the five colour collections + patina/zinc data
assets/js/data/materials.js    material specs, comparison matrix, services
assets/js/render.js            SVG scene generation
assets/js/app.js               state and wiring
```

Scripts are plain `<script>` tags sharing a `window.CM` namespace rather than ES
modules, so the page also works when opened directly from the filesystem.

## Photographs

Drop files into `assets/img/` using the names listed in
[`assets/img/README.md`](assets/img/README.md) and they appear automatically.

Until a file is present its slot renders a labelled plate naming the missing
file, so the layout never collapses and no broken-image icon is ever shown.
That fallback is driven by `buildImageSlots()` in `assets/js/app.js`, which
checks `naturalWidth` rather than trusting the load event alone.

Only publish photographs the business owns. A supplier's product render or an
image found online is usually someone else's copyright.

## Quote requests

There is no server behind this page. Submitting validates the form, composes the
whole request as plain text — contact details, project type, timeline, chosen
services, material, selected colour and saved favourites — and hands it to the
visitor's email client via `mailto:`. **Copy as text** puts the same content on
the clipboard for anyone whose browser has no mail handler. Nothing is stored
and nothing is posted anywhere.

Change the destination address in one place: `CM.quoteEmail` in
`assets/js/data/materials.js`. Wiring this to a real backend means replacing
`submitQuote()` in `assets/js/app.js` with a `fetch` to your endpoint — the
composer that builds the request body is already separate.

## Rendering approach

The copper patina and zinc scenes are **layered SVG**, not a 3D engine: flat
polygons filled with gradients derived from the source hex, then overlaid with
a sky/ground reflection ramp, a specular sweep and a fractal-noise grain filter.
Changing colour rebuilds the gradient stops, so a scene re-lights in a single
frame with no asset loading.

Swatch textures use the same idea in CSS: one `--c` custom property drives a
layered background of roll-direction grain, specular sweep and paint tooth.

## Accessibility

Semantic buttons with `aria-pressed` throughout, a real `<table>` for the
comparison matrix, visible focus rings, Escape to close the favourites drawer,
and `prefers-reduced-motion` support that drops transforms and long transitions
while keeping colour feedback intact. Form fields are labelled, validation
messages say what to fix, and the invalid state clears as soon as the visitor
starts correcting it.
