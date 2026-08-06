# esthers

Esther's Architectural Sheet Metal — Materials & Colour Configurator.

A single-page, dependency-free configurator for chimney caps, flashing and
architectural sheet metal. Pick a material, browse its official colour
collection, then send the specification through as a quote request.

## Running it

There is no build step and no package manager. Open `index.html` in a browser,
or serve the directory:

```sh
python3 -m http.server 8000    # then visit http://localhost:8000
```

## What's in it

| Section | Behaviour |
| --- | --- |
| Material selector | Eight materials on a snap-scrolling rail. Selecting one re-renders the spec panel, swaps the colour collection, updates what the quote request carries, and cascades an accent colour through the page. |
| Spec panel | Gauges, finish description, applications, warranty, thickness, durability, cost category and maintenance for each material, plus feature pills for PVDF / aluminum / copper / zinc. |
| Colour grid | Opened by **View Available Colours**. Live search, colour-family filters, favourites (persisted to `localStorage`), and hover states that enlarge the swatch and sweep its specular highlight. |
| Copper patina | Five-stage weathering timeline (Day 1 → 10 Years) with scrub control and autoplay. Later stages layer clipped mottling so the change reads as chemistry, not a hue shift. |
| Zinc | Architectural renderings of Natural, Pre-weathered, Quartz and Anthra zinc, each with a close-up texture strip on hover. |
| Comparison tool | Twelve attributes across all eight materials. Sticky header and attribute column, meters that fill on scroll, and column focus tied to the current material. |
| Services | The nine fabrication services, each with a **Request a quote** action that ticks the matching box on the form below and jumps to it. |
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
assets/css/configurator.css    selector, colour grid, patina, compare, services, quote
assets/js/util.js              colour maths, DOM helpers, icon set
assets/js/data/colours.js      the five colour collections + patina/zinc data
assets/js/data/materials.js    material specs, comparison matrix, services
assets/js/render.js            SVG scene generation
assets/js/app.js               state and wiring
```

Scripts are plain `<script>` tags sharing a `window.CM` namespace rather than ES
modules, so the page also works when opened directly from the filesystem.

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
