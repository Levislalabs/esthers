/**
 * The staff authorization DECISION, with no I/O in it.
 *
 * Split out from staff.ts on purpose. staff.ts does the talking - verify a
 * JWT with Supabase, fetch a row - and this file does the deciding. The
 * decision is the part that must never be wrong, so it lives somewhere it
 * can be tested exhaustively without a network, a database or a Deno
 * runtime.
 *
 * The rule, in one sentence: a caller is staff only if Supabase Auth
 * verified their identity AND a row exists for them AND that row says
 * is_active is exactly true.
 */

export interface StaffProfileRow {
  user_id: string;
  display_name: string;
  is_active: unknown; // deliberately unknown: see the strict check below
}

export type StaffDecision =
  | { ok: true; userId: string; displayName: string }
  | { ok: false; status: 401 | 403; message: string };

/** Shown for every authorization failure. Never says which check failed. */
export const NOT_AUTHORISED = 'Not authorised.';
export const NOT_SIGNED_IN = 'Sign in to continue.';
export const SESSION_EXPIRED = 'Your session has expired. Sign in again.';

/**
 * Pull the JWT out of an Authorization header.
 *
 * Returns null rather than throwing, so a missing or malformed header is
 * an ordinary 401 and not a 500.
 */
export function bearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

/**
 * The decision itself.
 *
 * @param userId  the id Supabase Auth returned, or null if the JWT did
 *                not verify. NEVER a value taken from the request body.
 * @param profile the staff_profiles row for that id, or null if none.
 *
 * is_active is compared with === true rather than being treated as
 * truthy. If a future change ever lets that column arrive as the string
 * "false", or as 0, or as an object, a truthy test would quietly admit
 * the caller. Only the boolean true opens the door.
 *
 * A missing row and a deactivated row return the same refusal, so a
 * former staff member cannot learn that their row still exists.
 */
export function decideStaffAccess(
  userId: string | null,
  profile: StaffProfileRow | null,
): StaffDecision {
  if (!userId) {
    return { ok: false, status: 401, message: SESSION_EXPIRED };
  }
  if (!profile) {
    return { ok: false, status: 403, message: NOT_AUTHORISED };
  }
  if (profile.is_active !== true) {
    return { ok: false, status: 403, message: NOT_AUTHORISED };
  }
  // The identity comes from the verified token, never from the row we
  // just read, so a corrupted row cannot redirect who the caller is.
  if (profile.user_id !== userId) {
    return { ok: false, status: 403, message: NOT_AUTHORISED };
  }
  return {
    ok: true,
    userId,
    displayName: typeof profile.display_name === 'string' && profile.display_name.trim()
      ? profile.display_name
      : 'Esther’s',
  };
}
