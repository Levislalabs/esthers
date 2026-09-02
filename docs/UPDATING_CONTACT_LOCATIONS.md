# Updating the Contact section

This is the **Visit our shops** section near the bottom of the home page, with
the two Burnaby locations.

You only ever open one file:

    assets/js/data/locations.js

You never need to touch the HTML, the CSS, or anything else. Change an address
in that file and the map, the Get Directions button, the phone link and the
email links all follow automatically.

---

## What each line means

Each location is a block that looks like this:

```js
{
  id: 'main-branch',
  label: 'Main Branch',
  primary: true,
  address: {
    street: '3890 E. First Ave.',
    city: 'Burnaby',
    region: 'BC',
    postalCode: 'V5R 3W1'
  },
  phone: '604-291-6766',
  contacts: [
    { name: 'Luisa', email: 'info@esthers.ca' },
    { name: 'EJay', email: 'manager@esthers.ca' }
  ],
  specialties: 'Standard and custom flashing, ...',
  mapAddress: '3890 E. First Ave., Burnaby, BC V5R 3W1'
},
```

| Line | What it does |
| --- | --- |
| `id` | A nickname. Nobody sees it. |
| `label` | The name shown at the top of the card. |
| `primary` | `true` puts the small "Primary" tag on the card. Only one location should have it. |
| `address` | What is printed on the card, in four parts. |
| `phone` | Written the way it should be read on screen. |
| `contacts` | One `{ name, email }` per person. |
| `specialties` | The sentence describing what that shop does. |
| `mapAddress` | What the map and the directions button look up. |

**Four rules that will save you a headache**

1. Text goes inside `'single quotes'`.
2. If your text has an apostrophe in it, put a backslash before it:
   `'Esther\'s shop'`.
3. Every line ends with a comma, **except the last one before a `}`**.
4. `true` and `false` are typed **without** quotes.

If the section goes blank after you edit, you have almost certainly missed a
comma, a quote or a bracket. Undo, save, try again.

---

## How to change a phone number

Change one line:

```js
phone: '604-291-6766',
```

to

```js
phone: '604-555-0199',
```

**You do not write the "click to call" link.** The page builds it from the
digits you typed and adds the Canadian country code, so `604-555-0199` becomes
`tel:+16045550199` behind the scenes. Write the number however it should look
on screen — with dashes, spaces or brackets — and it will still work.

---

## How to change an email address

Find the person in the `contacts` list and change their `email`:

```js
contacts: [
  { name: 'Luisa', email: 'info@esthers.ca' },
  { name: 'EJay', email: 'manager@esthers.ca' }
],
```

The "click to email" link is built from what you type. You do not write
`mailto:` anywhere.

**To add a person**, add another block to the list. Watch the commas:

```js
contacts: [
  { name: 'Luisa', email: 'info@esthers.ca' },
  { name: 'EJay', email: 'manager@esthers.ca' },
  { name: 'Sam', email: 'newcontact@example.com' }
],
```

**To remove a person**, delete their whole `{ ... }` block and its comma, then
check the last one in the list has no comma after it.

---

## How to change a contact name

```js
{ name: 'Nicki / Jordan', email: 'custom@esthers.ca' }
```

Whatever you put in `name` is what appears on the card. Two people sharing an
inbox can share one line, as above.

---

## How to change an address

Change the four address lines **and** the `mapAddress` line. They are separate
on purpose: the first four control how it is printed on the card, and
`mapAddress` controls what the map searches for.

```js
address: {
  street: '3890 E. First Ave.',
  city: 'Burnaby',
  region: 'BC',
  postalCode: 'V5R 3W1'
},
...
mapAddress: '3890 E. First Ave., Burnaby, BC V5R 3W1'
```

**Always change both.** If you change only the printed address, the map will
still point at the old place.

For `mapAddress`, write the address the way you would type it into Google Maps
yourself. After you save, click Get Directions and check it lands in the right
spot.

---

## How to change the specialty description

```js
specialties:
  'Standard and custom flashing, specialty chimney caps including louvered ' +
  'and French-curved designs.',
```

The `+` at the end of a line just joins the next line onto it, so a long
sentence stays readable in the file. Keep the pattern: each piece in quotes, a
`+` at the end of every line except the last, and a space before the closing
quote so words do not run together.

A short sentence needs none of that:

```js
specialties: 'Custom fabrication to your drawings.',
```

---

## How to change the heading and the paragraph

They are at the top of the same file:

```js
eyebrow: 'Contact Us',
heading: 'Visit our shops',
intro: 'Two Burnaby locations. One team ready to help with your sheet metal project.',
```

---

## How to change the note above the two cards

That line lives at the top of the same file, just under `intro`:

```js
helpText:
  'Not sure which shop you need? Call our Main Branch at {phone} ' +
  'and we\'ll point you in the right direction.',
```

Write `{phone}` wherever the number should appear. It becomes a clickable
number on its own — you do not write the link. The number used is the phone of
whichever location has `primary: true`, so it can never drift out of step with
the card below it.

To remove the note entirely, set it to two quotes with nothing between:

```js
helpText: '',
```

---

## How the map and the directions button work

Both are built from `mapAddress`. You never paste a map link or a set of
coordinates.

- **The map** on the card is a Google Maps frame looking up that address.
- **Get Directions** opens Google Maps in a new tab with the address already
  set as the destination. The customer's phone or browser fills in the starting
  point.

**No Google account, API key, billing setup or subscription is needed.** Both
are free, public Google Maps links. There is nothing for you to sign up for and
nothing to renew.

**If the map does not appear**, the card shows a dark plate with the address on
it instead. That happens when the visitor's network or ad-blocker blocks
Google — the rest of the card, including Get Directions, still works normally.
It is not something broken on your end.

---

## Adding a third location

Copy a whole location block, paste it after the last one, and change the
values. Remember the comma after the block you are no longer last, and no comma
after the new last one.

Set `primary: false` on it — only one location should carry the Primary tag.

Two cards sit side by side on a desktop. A third will wrap onto the next row on
its own; nothing needs adjusting.

---

## What NOT to put in this file

Only put information here that is true and that you want published. In
particular this section deliberately does **not** list opening hours, days,
fax numbers, social media or parking, because those were never confirmed. If
you want any of them added, they need to be written into the card layout first
— ask, rather than trying to squeeze them into the specialty sentence.
