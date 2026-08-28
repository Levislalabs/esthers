# Updating "Recent fabrication"

This is the photo gallery on the home page, under the heading **Recent
fabrication**.

You only ever touch two things:

| What | Where |
| --- | --- |
| The photo files | `assets/img/work/` |
| Everything else | `assets/js/data/work.js` |

That's it. You never need to open the HTML, the CSS, or any other file. The
layout arranges itself: one photo across on a phone, two on a tablet, three on
a desktop, however many you put in.

---

## Before you start

Open `assets/js/data/work.js` in any plain text editor. Each photo is a block
that looks like this:

```js
{
  id: 'cove-cap',
  image: 'assets/img/work/cove-cap.jpg',
  title: 'Cove-profile cap',
  caption: 'Flared bell over stone',
  alt: 'Cove-profile chimney cap with a flared bell shape on a stone chimney.',
  enabled: true,
  order: 1
},
```

Here is what each line does:

| Line | What it does |
| --- | --- |
| `id` | A nickname so the blocks can be told apart. Nobody sees it. |
| `image` | Which photo file to show. |
| `title` | The bold line under the photo. |
| `caption` | The small grey line beside the title. |
| `alt` | A description of the photo, for blind visitors and for Google. |
| `enabled` | `true` shows it, `false` hides it. |
| `order` | Position on the page. Smallest number first. |

**Four rules that will save you a headache**

1. Text goes inside `'single quotes'`.
2. If your text has an apostrophe in it, put a backslash before it:
   `'Esther\'s shop'`.
3. Every line ends with a comma, **except the last line before the `}`**.
4. `true` and `false` are typed **without** quotes.

If the gallery goes blank after you edit, you have almost certainly missed a
comma, a quote or a bracket. Undo your change, save, and try again.

---

## How to replace a photo

1. Put the new photo into the folder `assets/img/work/`

2. Give it a simple lowercase name with hyphens instead of spaces:

   ```
   copper-chimney-cap.jpg
   ```

3. Open `assets/js/data/work.js`

4. Find the block for the photo you're replacing and change the `image` line:

   ```js
   image: 'assets/img/work/cove-cap.jpg',
   ```

   to

   ```js
   image: 'assets/img/work/copper-chimney-cap.jpg',
   ```

5. Update the `title`, `caption` and `alt` lines to match the new photo.

6. Save the file and refresh the page.

> **If you get the filename wrong**, the page will not break. That card shows a
> dark plate with the filename it was looking for, so you can see the typo. The
> browser console also prints a message telling you what to fix.

---

## How to change the title

```js
title: 'Copper cap with a standing seam crown',
```

## How to change the small caption

```js
caption: 'Copper • Custom fabricated • Burnaby, BC',
```

## How to change the description for screen readers

```js
alt: 'Copper chimney cap with a standing seam crown on a brick chimney.',
```

Describe **what is in the photograph**, in a sentence. Don't just repeat the
title, and don't write "photo of" — screen readers already say that part.

---

## How to add another project

Copy an existing block, paste it after the last one, and change the values.

**Watch the commas.** Every block needs a comma after its closing `}` except
the very last one.

```js
    {
      id: 'louvre-cap-tile',
      image: 'assets/img/work/louvre-cap-tile.jpg',
      title: 'Louvered cap on tile',
      caption: 'Draft with weather exclusion',
      alt: 'Louvered chimney cap with a hipped crown installed on a tile roof.',
      enabled: true,
      order: 3
    },                          <-- comma added, because a block follows it

    {
      id: 'copper-cap',
      image: 'assets/img/work/copper-chimney-cap.jpg',
      title: 'Copper cap, standing seam crown',
      caption: 'Copper • Burnaby, BC',
      alt: 'Copper chimney cap with a standing seam crown on a brick chimney.',
      enabled: true,
      order: 4
    }                           <-- no comma, this is the last one

  ]
};
```

The page will show four cards. Add a fifth, a sixth, a ninth — the grid keeps
arranging them without any other change.

---

## How to hide a project without deleting it

Change one word:

```js
enabled: false,
```

The card disappears from the page but all its information stays in the file,
ready to switch back on with `enabled: true`.

## How to delete a project permanently

Delete the whole block from the opening `{` to the closing `}`, including its
comma. Then check that the block now last in the list has **no** comma after
its `}`.

Hiding is safer than deleting. Prefer `enabled: false` unless you are sure.

---

## How to reorder the projects

Change the `order` numbers. Lowest shows first.

To move the third photo to the front:

```js
order: 1     // was 3, now first
order: 2     // the old first one, bumped down
order: 3     // the old second one, bumped down
```

The numbers do not have to be neat. `10`, `20`, `30` works too, and leaves room
to slot something in between later without renumbering everything.

---

## How to fix a badly cropped photo

Photos are cropped to a square on desktop. By default the middle is kept, which
sometimes cuts the top off a tall chimney.

Add one optional line to that photo's block:

```js
objectPosition: 'center top',
```

| Value | Keeps |
| --- | --- |
| *(leave the line out)* | the middle |
| `'center top'` | the top |
| `'center bottom'` | the bottom |
| `'50% 30%'` | a point 30% of the way down |

Nudge the percentage until it looks right. Nothing is ever squashed or
stretched — the photo is only ever cropped.

---

## How to change the heading and the paragraph

They are at the top of the same file:

```js
eyebrow: 'Our Work',
heading: 'Recent fabrication',
intro:
  'A few pieces off the floor and on the roof. Everything here was drawn, ' +
  'cut and formed for a specific chimney.',
```

The `+` at the end of a line just joins the next line onto it, so a long
paragraph stays readable in the file. Keep the pattern: each piece in quotes, a
`+` at the end of every line except the last, and a space before the closing
quote so words don't run together.

---

## A note on the photos themselves

- Save them as **JPEG**, about **1600 pixels** on the longest side.
- Only put up photographs the business owns. A supplier's product render or a
  picture found online usually belongs to someone else, and a commercial
  website is exactly where that gets noticed.
- Keep your full-size originals somewhere else. The ones in this folder are
  the web-sized copies.
