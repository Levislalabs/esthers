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

| Filename | What it is |
| --- | --- |
| `logo-master.webp` | The supplied artwork exactly as delivered, trimmed to its own ink. The page never loads this file; everything below is derived from it. |
| `logo-lockup.webp` + `-900/-600/-420` | The full lockup, used in the hero and the footer. |
| `logo-mark.webp` + `-160/-96` | The mark on its own, used in the top bar. |

Two things to know before reissuing any of these.

**The artwork was drawn on white.** On this site's near-black the metal sinks
into the background and the wordmark is barely readable. Every file the page
loads therefore carries a 0.60 gamma on its colour channels, which lifts the
shadows back out without touching the highlights, the orange edges or the
transparency. Regenerate from `logo-master.webp` and apply the same curve, or
ask for a dark-background version of the artwork.

**The top bar does not use the lockup.** Squeezed to the height of a 66px bar,
"Sheet Metal" turns into an unreadable smear, so the bar pairs the mark with
the name set as live text. That is why `.logo__name` and `.logo__sub` exist in
`base.css`.

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
