/* =========================================================================
 * THE TWO SHOPS, FOR THE BROWSER.
 *
 * The customer's selector, the staff badges, the thread header and the
 * transfer dialog all need the same three names and the same three ids. This
 * is where they come from, so nobody retypes "Specialty Shop - Keith Street"
 * into a fourth file and gets it subtly wrong.
 *
 * THIS FILE DECIDES NOTHING.
 *
 * api/_chat/locations.js has its own copy of the canonical ids and validates
 * every request against it. This file is downloaded by anybody who asks and a
 * browser can be made to say whatever its owner likes, so the server does not
 * import it, reference it, or trust a single byte of it. A test pins the two
 * lists to each other - not because they might differ, but to prove the
 * server does not DEPEND on this one.
 *
 * What lives here that the server does not have: the addresses and the
 * customer-facing descriptions. Those are display copy. The server has no use
 * for them and should not be the place they are edited.
 * ========================================================================= */

/* The chat client version. THE SAME STRING as CHAT_CLIENT_VERSION in chat.js,
   chat-customer.js, chat-staff.js and chat-app-check.js. */
export const CHAT_CLIENT_VERSION = '2026-09-08.1';

export const MAIN = 'main';
export const SPECIALTY = 'specialty';
export const UNASSIGNED = 'unassigned';

/* Canonical order: the order a customer sees the choices in. */
export const LOCATION_IDS = [MAIN, SPECIALTY, UNASSIGNED];

/*
 * One entry per shop, and every string a person reads comes from here.
 *
 *   label        the exact name, everywhere a destination must be recognised
 *   choice       what the customer's own selector button says
 *   address      shown under the choice, because a name is easier to confirm
 *                with a street attached
 *   description  what that shop actually does, so a customer can self-route
 *
 * The labels are deliberately specific. "Main Branch" and "Specialty Shop"
 * were rejected: a customer skim-reading two vague labels sends the curved
 * scupper job to the wrong shop, and so does a staff member glancing at an
 * inbox row.
 */
export const LOCATIONS = {
  [MAIN]: {
    id: MAIN,
    label: 'Main Shop - 1st Avenue',
    choice: 'Main Shop - 1st Avenue',
    address: '3890 E. First Ave., Burnaby',
    phone: '604-291-6766',
    description: 'General sheet metal, flashing, chimney caps, '
      + 'architectural/louvered caps, general sales and supplies.'
  },
  [SPECIALTY]: {
    id: SPECIALTY,
    label: 'Specialty Shop - Keith Street',
    choice: 'Specialty Shop - Keith Street',
    address: '3701 Keith Street',
    phone: '604-677-2379',
    description: 'Curved and arched fabrication, copper scuppers, vents '
      + 'and specialty custom fabrication.'
  },
  [UNASSIGNED]: {
    id: UNASSIGNED,
    label: 'Not Sure / Unassigned',
    /* The customer says "I'm Not Sure"; staff read "Not Sure / Unassigned".
       Same id, two audiences, and neither has to use the other's wording. */
    choice: "I'm Not Sure",
    address: '',
    phone: '',
    description: "We'll help route your message to the right shop."
  }
};

export function isLocationId(value) {
  return typeof value === 'string' && LOCATION_IDS.indexOf(value) !== -1;
}

/*
 * The label for an id.
 *
 * An unrecognised id - including a missing one, and including whatever a
 * hostile response might contain - reads as 'Not Sure / Unassigned' rather
 * than being echoed. This is the last stop before a string reaches a screen,
 * and echoing an unknown value here is exactly how somebody else's text ends
 * up on a staff member's monitor.
 */
export function labelFor(locationId) {
  return isLocationId(locationId)
    ? LOCATIONS[locationId].label
    : LOCATIONS[UNASSIGNED].label;
}

/* Missing or unrecognised routing is unassigned - never main. Mirrors
   resolveLocation() on the server, for conversations written before routing
   existed. */
export function resolveLocation(value) {
  return isLocationId(value) ? value : UNASSIGNED;
}

/* The customer's three choices, in order, ready to render. */
export function customerChoices() {
  return LOCATION_IDS.map((id) => LOCATIONS[id]);
}
