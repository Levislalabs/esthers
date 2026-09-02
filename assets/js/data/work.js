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
      id: 'louvered-cap-stack',
      image: 'assets/img/work/louvered-cap-stack-720.webp',
      imageLarge: 'assets/img/work/louvered-cap-stack-1200.webp',
      title: 'Large Architectural Louvered Chimney Cap',
      caption: '',
      alt:
        'A tall stack of dark bronze louvered chimney caps on a pallet outside the shop, ' +
        'wrapped and ready to go out.',
      enabled: true,
      order: 1
    },

    {
      id: 'chase-cover',
      image: 'assets/img/work/chase-cover-720.webp',
      imageLarge: 'assets/img/work/chase-cover-1200.webp',
      title: 'Chimney Chase Cover',
      caption: '',
      alt:
        'White chimney chase covers standing on the shop floor, each with a sloped hip formed ' +
        'to shed water and a welded round collar for the flue.',
      enabled: true,
      order: 2
    },

    {
      id: 'louvered-cap-sloped',
      image: 'assets/img/work/louvered-cap-sloped-720.webp',
      imageLarge: 'assets/img/work/louvered-cap-sloped-1200.webp',
      title: 'Louvered Chimney Cap with Sloped Rain Cover',
      caption: '',
      alt:
        'A large black louvered chimney cap outside the shop, with full louvre bands on all four ' +
        'faces and a hipped rain cover sloping to a raised standing edge.',
      enabled: true,
      order: 3
    },

    {
      id: 'shroud-flared',
      image: 'assets/img/work/shroud-flared-720.webp',
      imageLarge: 'assets/img/work/shroud-flared-1200.webp',
      title: 'Custom Fabricated Chimney Shroud',
      caption: '',
      alt:
        'Two dark bronze chimney shrouds in the shop, with concave flared sides, raised standing ' +
        'seams and a flat top, still carrying their protective film.',
      enabled: true,
      order: 4
    },

    {
      id: 'flue-collar-flashing',
      image: 'assets/img/work/flue-collar-flashing-720.webp',
      imageLarge: 'assets/img/work/flue-collar-flashing-1200.webp',
      title: 'Custom Metal Chimney Flashing & Flue Collar',
      caption: '',
      alt:
        'A black flue collar welded to a flat flashing base on the bench, the round pipe cut on ' +
        'an angle to meet the roof pitch, with the weld bead running right around the joint.',
      enabled: true,
      order: 5
    },

    {
      id: 'shroud-architectural',
      image: 'assets/img/work/shroud-architectural-720.webp',
      title: 'Custom Architectural Chimney Shroud',
      caption: '',
      alt:
        'A black architectural chimney shroud on a pallet in the shop, with a concave flared ' +
        'crown, raised seams and a banded base of X-pattern frames over mesh screening.',
      enabled: true,
      order: 6
    }

  ]
};
