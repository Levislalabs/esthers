/**
 * Tests for the staff authorization decision and for the staff write path.
 *
 * TWO KINDS OF TEST LIVE HERE, AND THE DIFFERENCE MATTERS.
 *
 * PART 1 executes the real decision function from staff_policy.ts against
 * every shape of input it can be handed. That is a genuine behavioural
 * test of the code that ships.
 *
 * PART 2 is STATIC ANALYSIS of the staff-actions source. It reads the file
 * and proves structural properties: that sender_type and staff_user_id are
 * never taken from the request body, that no update or delete of a message
 * exists, and so on. It does NOT execute the function.
 *
 * WHAT IS NOT TESTED HERE, STATED PLAINLY:
 *
 *   Running staff-actions end to end needs the Deno runtime plus a live
 *   Supabase stack for auth.getUser() and the Data API. Neither is
 *   available in this environment - Deno is not installed and Docker
 *   cannot pull images. So there is NO integration proof in this suite
 *   that a real JWT from a real active staff member results in a stored
 *   reply, and none is claimed.
 *
 *   That gap must be closed before deployment by running, against a local
 *   `supabase start` stack:
 *     - an active staff JWT   -> reply stored, author = that staff id
 *     - a non-staff JWT       -> 403, nothing written
 *     - an inactive staff JWT -> 403, nothing written
 *     - no JWT                -> 401
 *     - a body naming another staff_user_id or sender_type -> ignored
 *   The checklist is in docs/CHAT_BACKEND.md.
 *
 * Run:  node --experimental-strip-types supabase/tests/staff_policy_test.ts
 */

import {
  bearerToken,
  decideStaffAccess,
  NOT_AUTHORISED,
  SESSION_EXPIRED,
  NOT_SIGNED_IN,
  type StaffProfileRow,
} from '../functions/_shared/staff_policy.ts';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) { passed++; console.log('PASS  ' + label); }
  else { failed++; console.log('FAIL  ' + label); }
}

const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function profile(over: Partial<StaffProfileRow> = {}): StaffProfileRow {
  return { user_id: STAFF_ID, display_name: 'Active Staff', is_active: true, ...over };
}

/* =====================================================================
   PART 1 - the real decision function
   ===================================================================== */

console.log('--- bearer token parsing ---');
check('A1. a well formed header yields the token', bearerToken('Bearer abc.def.ghi') === 'abc.def.ghi');
check('A2. case insensitive scheme', bearerToken('bearer abc') === 'abc');
check('A3. surrounding whitespace tolerated', bearerToken('  Bearer   abc  ') === 'abc');
check('A4. a missing header yields null', bearerToken(null) === null);
check('A5. an empty header yields null', bearerToken('') === null);
check('A6. a bare token without the scheme is refused', bearerToken('abc.def.ghi') === null);
check('A7. the wrong scheme is refused', bearerToken('Basic abc') === null);
check('A8. a header with no credential is refused', bearerToken('Bearer') === null);
check('A9. a header with only spaces after the scheme is refused', bearerToken('Bearer    ') === null);
check('A10. two tokens are refused rather than the first taken',
  bearerToken('Bearer abc def') === null);

console.log('--- the authorization decision ---');

const good = decideStaffAccess(STAFF_ID, profile());
check('B1. verified id + active row = allowed', good.ok === true);
check('B2. the allowed identity is the VERIFIED id, not the row',
  good.ok === true && good.userId === STAFF_ID);
check('B3. the display name is carried through',
  good.ok === true && good.displayName === 'Active Staff');

const noJwt = decideStaffAccess(null, profile());
check('B4. no verified id = 401, even with a perfectly good staff row',
  noJwt.ok === false && noJwt.status === 401 && noJwt.message === SESSION_EXPIRED);

const noRow = decideStaffAccess(STAFF_ID, null);
check('B5. verified id but NO staff row = 403',
  noRow.ok === false && noRow.status === 403);

const inactive = decideStaffAccess(STAFF_ID, profile({ is_active: false }));
check('B6. an INACTIVE staff row = 403',
  inactive.ok === false && inactive.status === 403);

check('B7. a missing row and an inactive row give the SAME message, so a '
    + 'former staff member cannot learn their row still exists',
  noRow.ok === false && inactive.ok === false && noRow.message === inactive.message
  && noRow.message === NOT_AUTHORISED);

// is_active must be exactly true. These are the values that a truthy
// check would wrongly admit.
const truthyTraps: Array<[string, unknown]> = [
  ['the string "false"', 'false'],
  ['the string "true"', 'true'],
  ['the number 1', 1],
  ['the number 0', 0],
  ['an empty object', {}],
  ['an empty array', []],
  ['the string "0"', '0'],
  ['null', null],
  ['undefined', undefined],
];
for (const [label, value] of truthyTraps) {
  const d = decideStaffAccess(STAFF_ID, profile({ is_active: value }));
  check(`B8. is_active = ${label} is REFUSED (must be boolean true)`, d.ok === false);
}

const mismatched = decideStaffAccess(STAFF_ID, profile({ user_id: OTHER_ID }));
check('B9. a row belonging to a different user is refused',
  mismatched.ok === false && mismatched.status === 403);

const blankName = decideStaffAccess(STAFF_ID, profile({ display_name: '   ' }));
check('B10. a blank display name falls back rather than showing nothing',
  blankName.ok === true && blankName.displayName.length > 0);

check('B11. the not-signed-in message is distinct from the not-authorised one',
  NOT_SIGNED_IN !== NOT_AUTHORISED);

/* =====================================================================
   PART 2 - static analysis of the staff write path
   ===================================================================== */

console.log('--- staff-actions source (STATIC analysis, not execution) ---');

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

/**
 * Strip comments before analysing.
 *
 * Without this the checks read prose as if it were code: staff-actions
 * carries a comment listing what it deliberately never does, including
 * "touching customer_token_hash", and a naive search would score that
 * reassurance as a violation. The tests must look at what the file DOES,
 * not at what it says about itself.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, sparing "://"
}

function sqlCodeOnly(source: string): string {
  return source.replace(/--.*$/gm, '');
}

const actions = codeOnly(read('../functions/staff-actions/index.ts'));
const conversations = codeOnly(read('../functions/staff-conversations/index.ts'));
const migration = sqlCodeOnly(read('../migrations/20260901000002_chat_security.sql'));

// The author and the message type must come from the session, never the
// body. A regression here would let a staff client post as a customer or
// as a colleague.
check('C1. staff_user_id is assigned from the verified session',
  /staff_user_id:\s*staffUserId/.test(actions));
check('C2. staffUserId is read from the verified auth result',
  /const\s+staffUserId\s*=\s*auth\.staff\.userId/.test(actions));
check('C3. sender_type is hard-coded to "staff" on a reply',
  /sender_type:\s*'staff'/.test(actions));
check('C4. sender_type is NEVER read from the request body',
  !/body\.sender_type|body\['sender_type'\]/.test(actions));
check('C5. staff_user_id is NEVER read from the request body',
  !/body\.staff_user_id|body\.staffUserId|body\['staff_user_id'\]/.test(actions));
check('C6. customer_token_hash is never named in the staff write path',
  !/customer_token_hash/.test(actions));
check('C7. customer_last_read_at is never written by the staff path',
  !/customer_last_read_at/.test(actions));
check('C8. staff_last_read_at IS written by the staff path',
  /staff_last_read_at/.test(actions));

// Append-only, enforced by the absence of these operations.
check('C9. no .update( on chat_messages anywhere in the staff path',
  !/from\('chat_messages'\)[\s\S]{0,120}\.update\(/.test(actions));
check('C10. no .delete( anywhere in the staff path',
  !/\.delete\(/.test(actions));
check('C11. no .delete( in the staff read path either',
  !/\.delete\(/.test(conversations));

// Authorization must run before anything else, and must not be optional.
check('C12. staff-actions calls requireActiveStaff',
  /requireActiveStaff\(req,\s*db\)/.test(actions));
check('C13. staff-actions returns early when authorization fails',
  /if\s*\(!auth\.ok\)\s*return\s+fail\(/.test(actions));
check('C14. the read path also requires active staff',
  /requireActiveStaff\(req,\s*db\)/.test(conversations) &&
  /if\s*\(!auth\.ok\)\s*return\s+fail\(/.test(conversations));
check('C15. the read path never writes',
  !/\.insert\(|\.update\(|\.upsert\(/.test(conversations));

// The migration must not hand the browser a write path.
check('C16. the migration grants no INSERT to authenticated',
  !/grant[^;]*insert[^;]*to\s+authenticated/is.test(migration));
check('C17. the migration grants no UPDATE to authenticated',
  !/grant\s+update[^;]*to\s+authenticated/is.test(migration));
check('C18. the migration grants no DELETE to authenticated',
  !/grant[^;]*delete[^;]*to\s+authenticated/is.test(migration));
check('C19. the migration creates no non-SELECT policy',
  !/create\s+policy[\s\S]{0,200}?for\s+(insert|update|delete)/is.test(migration));
check('C20. the migration revokes everything from anon and authenticated first',
  /revoke\s+all\s+on\s+public\.chat_conversations\s+from\s+anon,\s*authenticated/i.test(migration));

console.log('');
console.log(`${passed} passed, ${failed} failed`);
console.log('');
console.log('NOTE: Part 2 is static analysis of source text, not execution.');
console.log('      End-to-end Edge Function tests need Deno + a live Supabase');
console.log('      stack and have NOT been run. See the header of this file');
console.log('      and the checklist in docs/CHAT_BACKEND.md.');

if (failed > 0) {
  if (typeof process !== 'undefined') process.exitCode = 1;
  throw new Error(`${failed} staff policy test(s) failed`);
}
