/* =========================================================================
 * RECENT FABRICATION - the photo gallery on the home page.
 *
 * THIS IS THE ONLY FILE YOU EDIT to change that section. The heading, the
 * paragraph under it, and every photo card all come from here.
 *
 * Photos live in:  assets/img/work/
 *
 * There is a plain-English guide next to this file:
 *   docs/UPDATING_RECENT_FABRICATION.md
 *
 * A few rules that will save you time:
 *   - Every line inside a { } block ends with a comma, except the last one.
 *   - Text goes inside 'single quotes'. If your text contains an apostrophe,
 *     write it as \' - for example 'Esther\'s shop'.
 *   - true and false are typed WITHOUT quotes.
 *   - If the page goes blank after an edit, you have almost certainly missed
 *     a comma, a quote or a bracket. Undo your change and try again.
 * ========================================================================= */

window.CM = window.CM || {};

CM.workSection = {

  /* The small label above the heading. */
  eyebrow: 'Our Work',

  /* The big heading. */
  heading: 'Recent fabrication',

  /* The paragraph under the heading. */
  intro:
    'A few pieces off the floor and on the roof. Everything here was drawn, cut and formed for a ' +
    'specific chimney. The dimensions, the louvre spacing and the crown profile all change from ' +
    'one job to the next.',

  /* ---------------------------------------------------------------------
   * THE PHOTO CARDS
   *
   * Add as many as you like. The grid arranges them on its own - one across
   * on a phone, two on a tablet, three on a desktop - so you never have to
   * touch the layout.
   *
   * Each card takes:
   *
   *   id       A short nickname, only used to tell cards apart. Never shown.
   *   image    Where the photo file is. Put photos in assets/img/work/
   *   title    The bold line under the photo.
   *   caption  The small grey line beside the title.
   *   alt      A sentence describing the photo for someone who cannot see
   *            it. Screen readers read this out loud, and search engines
   *            read it too, so describe the thing rather than repeating the
   *            title.
   *   enabled  true shows the card. false hides it without deleting it.
   *   order    Cards are shown lowest number first. 1, 2, 3...
   *
   * And one optional setting:
   *
   *   objectPosition
   *            Which part of the photo to keep when it is cropped square.
   *            Leave it out and the middle is kept. Use it when the good
   *            part of a photo is being cut off:
   *              'center top'     keep the top
   *              'center bottom'  keep the bottom
   *              '50% 30%'        keep a point 30% down from the top
   * ------------------------------------------------------------------- */

  projects: [

    {
      id: 'cove-cap',
      image: 'assets/img/work/cove-cap.jpg',
      title: 'Cove-profile cap',
      caption: 'Flared bell over stone',
      alt: 'Cove-profile chimney cap with a flared bell shape on a stone chimney.',
      enabled: true,
      order: 1
    },

    {
      id: 'louvre-cap-shop',
      image: 'assets/img/work/louvre-cap-shop.jpg',
      title: 'Louvered cap, hipped crown',
      caption: 'In the yard before pickup',
      alt: 'Louvered chimney cap with a hipped crown, photographed in the yard before pickup.',
      enabled: true,
      order: 2
    },

    {
      id: 'louvre-cap-tile',
      image: 'assets/img/work/louvre-cap-tile.jpg',
      title: 'Louvered cap on tile',
      caption: 'Draft with weather exclusion',
      alt: 'Louvered chimney cap with a hipped crown installed on a tile roof.',
      enabled: true,
      order: 3
    }

  ]
};
