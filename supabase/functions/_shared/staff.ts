/**
 * Verifying that a caller is Esther's staff.
 *
 * Two separate questions, answered in this order and never merged:
 *
 *   1. Who are you?   Answered by Supabase Auth, from the JWT. We do not
 *                     parse or trust the token ourselves; getUser() checks
 *                     the signature and expiry against the project.
 *
 *   2. Are you staff? Answered by an active row in staff_profiles. Being
 *                     signed in is not being staff. Anyone with an account
 *                     is authenticated; only an administrator can create
 *                     the membership row.
 *
 * The email address on the account is never used to decide this. Email
 * domains can be spoofed in some setups, change over time, and say nothing
 * about whether someone should still have access after they leave.
 *
 * This file does the I/O. The decision itself lives in staff_policy.ts,
 * where it is unit tested against every shape of bad input.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { userClient } from './db.ts';
import {
  bearerToken,
  decideStaffAccess,
  NOT_SIGNED_IN,
  type StaffProfileRow,
  type StaffDecision,
} from './staff_policy.ts';

export interface StaffIdentity {
  userId: string;
  displayName: string;
}

export type StaffResult =
  | { ok: true; staff: StaffIdentity }
  | { ok: false; status: 401 | 403; message: string };

export async function requireActiveStaff(
  req: Request,
  db: SupabaseClient,
): Promise<StaffResult> {
  const jwt = bearerToken(req.headers.get('authorization'));
  if (!jwt) {
    return { ok: false, status: 401, message: NOT_SIGNED_IN };
  }

  // Question 1: identity. Verified by Supabase against the project's
  // signing key - we never decode the token ourselves.
  const { data, error } = await userClient(jwt).auth.getUser(jwt);
  const userId = error || !data?.user ? null : data.user.id;

  // Question 2: membership. Read with the service client, so the answer
  // does not depend on the very policy it is about to gate.
  let profile: StaffProfileRow | null = null;
  if (userId) {
    const { data: row, error: profileError } = await db
      .from('staff_profiles')
      .select('user_id, display_name, is_active')
      .eq('user_id', userId)
      .maybeSingle();

    if (profileError) {
      console.error('staff lookup failed:', profileError.message);
      // Fail CLOSED. A lookup that did not complete is not a yes.
      profile = null;
    } else {
      profile = (row as StaffProfileRow | null) ?? null;
    }
  }

  const decision: StaffDecision = decideStaffAccess(userId, profile);
  if (!decision.ok) {
    return { ok: false, status: decision.status, message: decision.message };
  }
  return {
    ok: true,
    staff: { userId: decision.userId, displayName: decision.displayName },
  };
}
