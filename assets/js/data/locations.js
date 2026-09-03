/* =========================================================================
 * CONTACT / VISIT OUR SHOPS - the two Burnaby locations at the bottom of
 * the home page.
 *
 * THIS IS THE ONLY FILE YOU EDIT to change any of that. Addresses, phone
 * numbers, contact people, email addresses and the specialty wording all
 * come from here.
 *
 * There is a plain-English guide:
 *   docs/UPDATING_CONTACT_LOCATIONS.md
 *
 * THINGS YOU DO NOT HAVE TO WRITE, because the page works them out from
 * what is below:
 *   - the "tel:" link behind a phone number (built from the digits)
 *   - the "mailto:" link behind an email address
 *   - the embedded map (built from mapAddress)
 *   - the Get Directions link (built from mapAddress)
 * Change the address in one place and all four follow.
 *
 * A few rules that will save you time:
 *   - Text goes inside 'single quotes'.
 *   - If your text contains an apostrophe, write it as \' - for example
 *     'Esther\'s shop'.
 *   - Every line inside a { } block ends with a comma, except the last one.
 *   - true and false are typed WITHOUT quotes.
 * ========================================================================= */

window.CM = window.CM || {};

CM.contactSection = {

  /* The small label above the heading. */
  eyebrow: 'Contact Us',

  /* The big heading. */
  heading: 'Visit our shops',

  /* The paragraph under the heading. */
  intro: 'Two Burnaby locations. One team ready to help with your sheet metal project.',

  /* The small note above the two cards, for anyone unsure which shop to
     ring. Write {phone} where the number should go and it becomes a
     clickable number on its own - you do not write the link.
     The number used is the phone of whichever location has primary: true.
     Set this to '' (two quotes, nothing between) to remove the note. */
  helpText:
    'Not sure which shop you need? Call our Main Branch at {phone} ' +
    'and we\'ll point you in the right direction.',

  /* ---------------------------------------------------------------------
   * THE LOCATION CARDS
   *
   * Each card takes:
   *
   *   id           A short nickname, only used to tell cards apart.
   *   label        The badge at the top of the card.
   *   primary      true puts the quiet "primary" marker on the card. Only
   *                one location should have it.
   *   address      The address, written the way it should appear on screen.
   *                street / city / region / postalCode.
   *   phone        Written the way it should be read: 604-291-6766
   *   contacts     One block per person. name and email.
   *   specialties  The sentence describing what this shop does.
   *   mapAddress   What the map and the Get Directions button search for.
   *                Write it the way you would type it into Google Maps.
   * ------------------------------------------------------------------- */

  locations: [

    {
      id: 'main-branch',
      label: 'Main Branch',
      primary: true,
      address: {
        street: '3890 E. First Ave.',
        city: 'Burnaby',
        region: 'BC',
        postalCode: 'V5C 3W1'
      },
      phone: '604-291-6766',
      contacts: [
        { name: 'Ed / Luisa', email: 'info@esthers.ca' },
        { name: 'EJay', email: 'manager@esthers.ca' },
        { name: 'Mavy', email: 'accounting@esthers.ca' }
      ],
      specialties:
        'Standard and custom flashing, specialty chimney caps including louvered and ' +
        'French-curved designs. We also supply the sheet metal essentials that go with ' +
        'the job, including matching paint, screws and caulking.',
      mapAddress: '3890 E. First Ave., Burnaby, BC V5C 3W1'
    },

    {
      id: 'specialty-shop',
      label: 'Specialty Shop',
      primary: false,
      address: {
        street: '3701 Keith Street',
        city: 'Burnaby',
        region: 'BC',
        postalCode: 'V5J 3B9'
      },
      phone: '604-677-2379',
      contacts: [
        { name: 'Nicki / Jordan', email: 'custom@esthers.ca' }
      ],
      specialties:
        'Specialty fabrication: chimney caps, vents, curved flashing, arched-window work and ' +
        'copper scuppers, among other custom sheet metal projects. If you have drawn it, ask ' +
        'us about it.',
      mapAddress: '3701 Keith Street, Burnaby, BC V5J 3B9'
    }

  ]
};
