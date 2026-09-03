# esthers

Esther's Sheet Metal - company site and materials configurator.

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
| Our work | Gallery of recent fabrication, rendered from `assets/js/data/work.js`. The owner adds, hides, reorders and re-captions projects by editing that one file - see [`docs/UPDATING_RECENT_FABRICATION.md`](docs/UPDATING_RECENT_FABRICATION.md). Every image is an **image slot** - see below. |
| Process | The four steps from measurement to pickup, and what the customer needs to supply at each. |
| Material selector | Eight materials on a snap-scrolling rail. Selecting one re-renders the spec panel, swaps the colour collection, updates what the quote request carries, and cascades an accent colour through the page. |
| Spec panel | Gauges, finish description, applications, warranty, thickness, durability, cost category and maintenance for each material, plus feature pills for PVDF / aluminum / copper / zinc. |
| Colour grid | Opened by **View Available Colours**. Live search, colour-family filters, favourites (persisted to `localStorage`), and hover states that enlarge the swatch and sweep its specular highlight. |
| Copper patina | Five-stage weathering timeline (Day 1 → 10 Years) with scrub control and autoplay. Later stages layer clipped mottling so the change reads as chemistry, not a hue shift. |
| Zinc | Architectural renderings of Natural, Pre-weathered, Quartz and Anthra zinc, each with a close-up texture strip on hover. |
| Comparison tool | Twelve attributes across all eight materials. Sticky header and attribute column, meters that fill on scroll, and column focus tied to the current material. |
| Services | The six fabrication services, each with a **Request a quote** action that ticks the matching box on the form below and jumps to it. |
| Contact | The two Burnaby shops, each with address, phone, the people to ask for, what that shop makes, a Get Directions button and an embedded map. Rendered from `assets/js/data/locations.js` - see [`docs/UPDATING_CONTACT_LOCATIONS.md`](docs/UPDATING_CONTACT_LOCATIONS.md). |
| Quote request | Contact details, optional company name and PO number / job location, timeline, a material picker that adds one line per colour (the same material can be added twice for a two-colour job), each line with its own colour list, an attachment field for drawings, and project details. Saved favourites ride along too. |

## Colour data

Colour names and collection membership follow the Cascadia Metals **Classic
(SMP)** and **Signature (PVDF)** colour cards.

**Hex values are on-screen approximations, not colour-matched values.** They
exist to drive the preview. Screen rendering, gloss level and ambient lighting
all shift perceived colour, and some colours are regional or mill-order only.
Confirm against a physical metal chip before ordering. This caveat is surfaced
in the UI on every collection and in the footer.

To correct a value or add a colour, edit `assets/js/data/colours.js` - nothing
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
assets/js/data/work.js         the Recent Fabrication gallery - owner-editable
assets/js/data/locations.js    the two shops in the Contact section - owner-editable
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

Submitting validates the form, composes the whole request as plain text
(contact details, company, PO number / job location, timeline, chosen
materials, a deliberately picked colour and saved favourites), uploads any
picked files **directly from the browser to private storage**, and then posts
the request to `api/quote.js` carrying only the pathnames. The email arrives
with an ATTACHMENTS / FILES section: each file's name, its size, and a signed
download link that expires after 7 days. **Copy as text** puts the request on
the clipboard.

Files no longer travel inside the request, which is what used to cap them at
about 3 MB. **Limits are now 5 files, 25 MB each, 75 MB combined.** The full
design — security, storage layout, retention — is in
[`docs/QUOTE_UPLOADS.md`](docs/QUOTE_UPLOADS.md).

Only name and email are required. Project details is optional; when it is left
blank the email says `Project details: not given` rather than carrying an empty
heading.

### It falls back rather than failing

On startup the page asks `GET /api/quote` whether the mailbox is configured. If
the answer is no - no API key set, or no function deployed at all - the form
reverts to the old `mailto:` behaviour, and the drawing hint goes back to
telling the visitor to attach the files themselves.

**A `mailto:` link cannot carry a file**, which is exactly why that path is now
the fallback and not the main one: for years it meant a customer who picked
three photos sent an email listing three filenames and no pictures.

The success panel only appears once the provider has actually accepted the
message. A failed send leaves the form exactly as the customer filled it.

### Configuring delivery

Set these on the deployment. None of them belong in the repository:

| Variable | Meaning |
| --- | --- |
| `RESEND_API_KEY` | API key. Without it the endpoint reports "not configured" and the site falls back to `mailto:`. |
| `QUOTE_TO` | Comma-separated recipients, e.g. `counter@esthers.ca,manager@esthers.ca`. |
| `QUOTE_FROM` | Optional sender. Defaults to the provider's test sender, which needs no DNS changes. |
| `BLOB_READ_WRITE_TOKEN` | Created automatically by Vercel when a **private** Blob store is connected to the project. Never set by hand. Without it, uploads report unavailable and the form falls back. |

Limits, enforced server-side in `api/_lib.js` and mirrored in the browser for
a faster message: **5 files, 25 MB each, 75 MB combined**. Accepted types are
PDF, JPG, PNG, HEIC, WebP, DWG, DXF, DOC and DOCX - decided by reading the
file's actual bytes back after upload, never by its extension or the MIME type
the browser claims. The email is sent as plain text only, so nothing a visitor
types is ever interpreted as markup.

`CM.quoteEmail` in `assets/js/data/materials.js` still holds the addresses used
by the `mailto:` fallback and by **Copy as text**; `QUOTE_TO` is what the server
actually sends to. Keep them in step.

## Maps

The Contact section embeds a Google Maps frame per location and links out for
directions. Both URLs are the free public forms - `google.com/maps?output=embed`
and the documented `maps/dir/?api=1` endpoint - so **no API key, Google account
or billing setup exists anywhere in this project**, and nothing needs renewing.

An iframe cannot be asked whether it loaded: it is cross-origin, and a blocked
one still fires its load event over the browser's own error page. So each card
renders its address plate first and only inserts the frame once a small image
request has shown Google to be reachable. Two things fall out of that - nothing
third-party is requested on a page where the map could not work anyway, and a
blocked or ad-blocked map leaves the address on screen instead of a light grey
rectangle in the middle of a dark page.

## Rendering approach

The copper patina and zinc scenes are **layered SVG**, not a 3D engine: flat
polygons filled with gradients derived from the source hex, then overlaid with
a sky/ground reflection ramp, a specular sweep and a fractal-noise grain filter.
Changing colour rebuilds the gradient stops, so a scene re-lights in a single
frame with no asset loading.

Swatch textures use the same idea in CSS: one `--c` custom property drives a
layered background of roll-direction grain, specular sweep and paint tooth.

## Contrast

Every ink token clears WCAG AA (4.5:1) against the darkest surface it is used
on, `--bg-elevated`. `--ink-dim` and `--ink-faint` previously measured 3.54 and
2.06, which made form labels and placeholders effectively unreadable. There is
a rendered-DOM contrast audit in the test scripts rather than a token-level one,
because what matters is the pair that actually lands on screen.

## Accessibility

Semantic buttons with `aria-pressed` throughout, a real `<table>` for the
comparison matrix, visible focus rings, Escape to close the favourites drawer,
and `prefers-reduced-motion` support that drops transforms and long transitions
while keeping colour feedback intact. Form fields are labelled, validation
messages say what to fix, and the invalid state clears as soon as the visitor
starts correcting it.
