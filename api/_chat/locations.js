/*
 * THE TWO SHOPS, AND THE ONE PLACE THAT DECIDES WHAT THEY ARE.
 *
 * Esther's runs two shops. A customer chooses which one to message; staff see
 * only the shops they are authorised for; a conversation that went to the
 * wrong shop can be handed to the other one without the customer losing
 * anything. All of that turns on a single canonical identifier per shop, and
 * this file owns it on the SERVER side.
 *
 * THE ID IS THE AUTHORITY. THE LABEL IS NOT.
 *
 * 'main' and 'specialty' are routing and authorisation identifiers: short,
 * stable, and never shown to anybody. "Main Shop - 1st Avenue" is a sentence
 * for a person to read, and it can be reworded on any Tuesday without a
 * migration. Authorisation compares IDs; the label is derived from the ID and
 * never travels the other way. A request that supplies a label supplies
 * nothing.
 *
 * WHY THE SERVER HAS ITS OWN COPY.
 *
 * assets/js/chat-locations.js carries the same three IDs for the browser.
 * That file is downloaded by anybody who asks, and a browser can be made to
 * say whatever its owner likes - so the server does not import it, reference
 * it, or trust it. The allow-list below is checked independently on every
 * request. A test pins the two lists to each other so they cannot drift; the
 * point is not that they differ, it is that the server does not DEPEND on the
 * client's copy.
 *
 * UNASSIGNED IS A REAL DESTINATION, NOT AN ABSENCE.
 *
 * "I'm Not Sure" is an answer a customer is allowed to give, and it stores
 * 'unassigned' explicitly. Separately, conversations created before routing
 * existed carry no locationId at all - resolveLocation() maps that absence to
 * 'unassigned' too, so both kinds behave identically for reading,
 * authorisation and display without a backfill.
 */

'use strict';

const { ValidationError } = require('./validation.js');

/* The canonical set. Order is the order a person should see them in. */
const MAIN = 'main';
const SPECIALTY = 'specialty';
const UNASSIGNED = 'unassigned';

const LOCATION_IDS = [MAIN, SPECIALTY, UNASSIGNED];

/*
 * The exact words a person sees. Wherever a destination has to be recognised
 * at a glance - a customer's confirmation, an inbox row, a thread header, a
 * transfer dialog - it is one of these three strings and not a paraphrase.
 * Vague labels are how somebody sends a curved-scupper job to the wrong shop.
 */
const LABELS = {
  [MAIN]: 'Main Shop - 1st Avenue',
  [SPECIALTY]: 'Specialty Shop - Keith Street',
  [UNASSIGNED]: 'Not Sure / Unassigned'
};

function isLocationId(value) {
  return typeof value === 'string' && LOCATION_IDS.indexOf(value) !== -1;
}

/*
 * The label for an id, for a response the server assembles itself.
 *
 * Anything unrecognised is 'Not Sure / Unassigned' rather than an echo of the
 * input: this is the last stop before a string reaches a screen, and echoing
 * an unknown value here is how a caller gets to choose what staff read.
 */
function labelFor(locationId) {
  return Object.prototype.hasOwnProperty.call(LABELS, locationId)
    ? LABELS[locationId]
    : LABELS[UNASSIGNED];
}

/*
 * Validate a customer-supplied destination.
 *
 * EXACT MATCH, DELIBERATELY. No trimming, no lower-casing, no coercion. The
 * three values are produced by our own selector, not typed by anybody, so a
 * ' Main ' or a 'MAIN' is not a near-miss to be helpfully repaired - it is a
 * request that did not come from the form, and the honest answer is no. The
 * customer-facing text is generic for the same reason it is generic
 * everywhere else: a caller poking at the API learns nothing from it.
 */
function validLocationId(body) {
  const value = body ? body.locationId : undefined;
  if (!isLocationId(value)) {
    throw new ValidationError('invalid_location',
      'Please choose which shop you would like to message.');
  }
  return value;
}

/*
 * What shop is this conversation at?
 *
 * THE ONE FUNCTION EVERY READ PATH GOES THROUGH. A conversation document
 * written before routing existed has no locationId, and there are real ones
 * in production. Absence means 'unassigned' - not 'main', which would quietly
 * hand every legacy conversation to one shop and hide it from the other.
 * A value that is present but not canonical is treated the same way: unknown
 * routing is unassigned routing, never a default that grants access.
 */
function resolveLocation(data) {
  const value = data ? data.locationId : undefined;
  return isLocationId(value) ? value : UNASSIGNED;
}

/* ------------------------------------------------- staff authorisation */

/*
 * WHICH ROLES SEE EVERY SHOP WHILE `locations` IS STILL BEING ROLLED OUT.
 *
 * Today ALLOWED_STAFF_ROLES in auth.js is exactly ['admin'], and both
 * production staff documents carry it. Neither has a `locations` field yet,
 * so without a fallback this change would take the inbox away from both
 * accounts the moment it shipped - a regression dressed as a security
 * improvement.
 *
 * So: an admin with no explicit assignment keeps seeing everything, exactly as
 * today. THAT IS A TRANSITIONAL ALLOWANCE, NOT A PRIVILEGE MODEL. The moment a
 * document gains a `locations` array, the array wins and the fallback stops
 * applying to it - which is how counter@esthers.ca becomes main-only, by
 * editing one document and changing no code.
 *
 * It is a SEPARATE list from ALLOWED_STAFF_ROLES on purpose. Adding a second
 * role to that list later - 'agent', say - must not silently hand the new role
 * every shop in the company. A role that can sign in but is not named here
 * fails closed with no locations at all until somebody assigns some.
 */
const ALL_LOCATION_ROLES = ['admin'];

/*
 * The shops this staff document may act on.
 *
 * 1. An explicit `locations` array wins, always. Unknown entries are dropped
 *    rather than treated as wildcards, and duplicates collapse.
 * 2. An empty or all-invalid array is an assignment of NOTHING. Somebody wrote
 *    `locations: []` on purpose, or wrote nonsense; either way the safe answer
 *    is no shops, not every shop.
 * 3. No `locations` field at all, and a role in ALL_LOCATION_ROLES: every
 *    shop, for the rollout reason above.
 * 4. No `locations` field, any other role: nothing. Fail closed.
 */
function staffLocations(staffData) {
  const data = staffData || {};
  const raw = data.locations;

  if (Array.isArray(raw)) {
    const seen = [];
    for (const entry of raw) {
      if (isLocationId(entry) && seen.indexOf(entry) === -1) seen.push(entry);
    }
    return seen;                       /* possibly empty - see rule 2 */
  }

  if (raw !== undefined && raw !== null) {
    /* Present but not an array: a string, an object, a number. Not an
       assignment, and not an excuse to fall back to everything. */
    return [];
  }

  if (ALL_LOCATION_ROLES.indexOf(data.role) !== -1) return LOCATION_IDS.slice();
  return [];
}

/* Does this actor's authorised set cover this shop? */
function canAccessLocation(actor, locationId) {
  const allowed = (actor && Array.isArray(actor.locations)) ? actor.locations : [];
  return allowed.indexOf(locationId) !== -1;
}

module.exports = {
  MAIN, SPECIALTY, UNASSIGNED,
  LOCATION_IDS, LABELS, ALL_LOCATION_ROLES,
  isLocationId, labelFor, validLocationId, resolveLocation,
  staffLocations, canAccessLocation
};
