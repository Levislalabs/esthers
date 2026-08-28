# Photography

The homepage expects the files below. Drop them in this folder with these exact
names and they appear automatically - no code changes needed. Until a file is
present, the page renders a labelled placeholder in its slot rather than a
broken image, so the layout never collapses.

| Filename | Shot |
| --- | --- |
| `work-enclosure.jpg` | Large louvered chimney enclosure installed on a stone chimney, dark anthracite finish. Used as the hero image. |
| `work-louvre-shop.jpg` | Louvered cap with hipped crown photographed in the yard before pickup - mill-finish louvre blades against a dark crown. |
| `work-louvre-cap.jpg` | Louvered chimney cap with a hipped crown installed on a tile roof. |
| `work-cove-cap.jpg` | Cove-profile (flared bell) chimney cap on a stone chimney, with vent grommets. |

## Logo

Two pieces of supplied artwork, and everything here is derived from one of
them. Regenerate the whole set together if either is ever reissued.

### The stacked lockup - hero and footer

| Filename | What it is |
| --- | --- |
| `logo-master.webp` | The delivered artwork, trimmed to its own ink and otherwise untouched. The page never loads this file. |
| `logo-lockup.webp` + `-900/-600/-420` | What the page actually loads. |
| `logo-mark.webp` | The mark cut out of the lockup. Not loaded either - it is the source the favicon data URI in `index.html` was made from. |

**This artwork was drawn on white.** On the site's near-black the metal sinks
into the background and the wordmark is barely readable, so every loaded file
carries a 0.60 gamma on its colour channels. That lifts the shadows back out
without touching the highlights, the orange edges or the transparency.

### The horizontal wordmark - top bar

| Filename | What it is |
| --- | --- |
| `logo-wordmark.webp` + `-720/-400` | "Esther's Architectural Sheet Metal", the full line. |
| `logo-wordmark-short.webp` + `-260` | The name on its own, cut at the wide gap before "Architectural". |

**This one arrived on solid black with no alpha.** It is light-on-dark
artwork, so the black is the transparency: the brightest channel becomes the
matte and is divided back out to give straight alpha. Stamping the original
onto the bar would have put a black rectangle over a translucent, blurred
surface. It then takes a 0.76 curve, because "Architectural Sheet Metal" is
drawn dim enough to sit noticeably lighter than the navigation links beside
it.

**Why there are two crops.** "Architectural Sheet Metal" needs roughly 280px
of width before its x-height drops under seven pixels. The bar has that at
every size except a phone, where the `<picture>` serves the name alone.

## Guidance

- The gallery crops to **1:1** and the hero to **4:5**, both with
  `object-fit: cover`, so any aspect ratio works - but the subject should sit
  near the centre or it will be cropped out.
- **Export as real JPEG at roughly 1600px on the long edge**, quality 80.
  Larger is wasted on screen; smaller gets upscaled and looks soft.
- **Check the file is actually a JPEG**, not a PNG renamed to `.jpg`. Browsers
  cope, but a PNG photograph is five to ten times the file size for no visible
  gain - the first upload here was 4.1MB of PNG that compressed to 535KB.
- **Keep the originals somewhere else.** These are the web-sized copies.
- Filenames are lowercase with hyphens. `.jpg` is expected; if you use `.webp`
  or `.png`, update the `src` in `index.html` to match.

## Before you publish someone else's photo

Only put photos here that Esther's took or owns. A supplier's product render or
an image found online is usually someone else's copyright, and a commercial
website is exactly the context where that gets noticed.
