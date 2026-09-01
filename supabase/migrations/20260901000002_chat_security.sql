-- =========================================================================
-- Esther's customer messaging - access control
--
-- The whole security model is in this one file so it can be read top to
-- bottom in a review.
--
-- ONE RULE DECIDES EVERYTHING HERE:
--
--     NO BROWSER SESSION HAS DIRECT WRITE ACCESS TO ANY CHAT TABLE.
--
--     customer      -> Edge Function -> database
--     staff READ    -> Data API, under RLS, with their own JWT
--     staff WRITE   -> staff-actions Edge Function -> database
--
-- The browser is a rendering surface, never a writer. Every change to a
-- conversation or a message is made server-side by code that has already
-- verified who is asking.
--
-- Why writes are not granted to the browser even though an RLS policy
-- could be written to make them "safe": a direct grant means the rules
-- live in two places. The policy would have to re-state, in SQL, every
-- invariant staff-actions already enforces - that sender_type is 'staff',
-- that the author is the caller, that a closed conversation is read-only,
-- that closed_at follows status. Two copies of one rule drift apart, and
-- the day they do, the weaker copy is the one that decides. So there is
-- one write path, and it is the one with the checks in it.
--
-- The four supporting ideas:
--
--   1. anon gets NOTHING. Not a policy, not a grant, not one column. The
--      public website never touches these tables; it talks to an Edge
--      Function, which talks to the database as service_role. There is no
--      "customer" database role to attack.
--
--   2. authenticated gets SELECT and nothing else. Even that yields
--      nothing without an active row in staff_profiles. Signing up for an
--      account buys no access to anything here.
--
--   3. chat_messages is append-only. No INSERT, UPDATE or DELETE exists
--      for any browser role, so the transcript cannot be rewritten by the
--      people it might embarrass.
--
--   4. Nobody may grant themselves membership. staff_profiles is readable
--      by its owner and writable by no client role at all.
--
-- RLS grants nothing on its own: a policy only ever narrows what a GRANT
-- has already allowed. Both halves appear below for every table.
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1. Take everything away first
--
-- Supabase's default privileges are generous to anon and authenticated on
-- new objects in public. Revoking before granting means the grants further
-- down are the complete list, not an addition to something unseen.
-- -------------------------------------------------------------------------
revoke all on public.chat_conversations from anon, authenticated, public;
revoke all on public.chat_messages      from anon, authenticated, public;
revoke all on public.staff_profiles     from anon, authenticated, public;
revoke all on public.chat_rate_limits   from anon, authenticated, public;

-- The helper functions are service-side plumbing. Only the owner and
-- service_role should be able to call them directly.
revoke all on function public.chat_rate_limit_hit(text, integer, integer)
  from anon, authenticated, public;
revoke all on function public.chat_delete_expired_rate_limits()
  from anon, authenticated, public;


-- -------------------------------------------------------------------------
-- 2. Row level security on
--
-- With RLS enabled and no policy for a role, that role sees zero rows and
-- can write none. That is the default we want for anon everywhere.
-- -------------------------------------------------------------------------
alter table public.chat_conversations enable row level security;
alter table public.chat_messages      enable row level security;
alter table public.staff_profiles     enable row level security;
alter table public.chat_rate_limits   enable row level security;


-- -------------------------------------------------------------------------
-- 3. Who counts as staff
--
-- security definer so a policy on chat_conversations can consult
-- staff_profiles without recursing into staff_profiles' own policy.
-- Empty search_path so the function cannot be redirected at a table an
-- attacker created earlier in the path.
--
-- Both conditions matter: the row must exist AND be active. Deactivating a
-- staff member is a single boolean, and it takes effect on their next
-- request without deleting their account or their message history.
-- -------------------------------------------------------------------------
create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.staff_profiles sp
     where sp.user_id = (select auth.uid())
       and sp.is_active
  );
$$;

revoke all on function public.is_active_staff() from public;
grant execute on function public.is_active_staff() to authenticated;

comment on function public.is_active_staff() is
  'True only for a signed-in user with an active staff_profiles row. Never trust email domains for this.';


-- =========================================================================
-- staff_profiles
-- =========================================================================

-- Read-only, and only your own row. A staff member can confirm they are
-- staff; nobody can enumerate the team, and nobody can write here at all.
grant select on public.staff_profiles to authenticated;

drop policy if exists staff_profiles_select_own on public.staff_profiles;
create policy staff_profiles_select_own
  on public.staff_profiles
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Deliberately absent: INSERT, UPDATE and DELETE policies. No client role
-- can create or alter an authorization record, so a signed-up user cannot
-- promote themselves to staff. Rows are added by an administrator through
-- the Supabase dashboard or a service-role script.


-- =========================================================================
-- chat_conversations
-- =========================================================================

-- SELECT only. The staff inbox renders from this; it never writes here.
grant select on public.chat_conversations to authenticated;

drop policy if exists chat_conversations_staff_select on public.chat_conversations;
create policy chat_conversations_staff_select
  on public.chat_conversations
  for select
  to authenticated
  using (public.is_active_staff());

-- Deliberately absent: INSERT, UPDATE and DELETE, for every browser role.
--
-- Closing a conversation, reopening it and marking it read all happen in
-- staff-actions, which has already verified the JWT and confirmed active
-- membership before it touches anything. An earlier draft granted
-- UPDATE(status, staff_last_read_at, customer_last_read_at) here; that
-- was a second write path into the same rows and it has been removed.
--
-- Note what the removal also fixes: customer_last_read_at was in that
-- column list, which meant staff could move a marker that belongs to the
-- customer. It is now writable only by chat-read, on the customer's own
-- token-authenticated request. See the note at the foot of this file.


-- =========================================================================
-- chat_messages
-- =========================================================================

-- SELECT only. Staff read the transcript in the browser; they add to it
-- through staff-actions.
grant select on public.chat_messages to authenticated;

drop policy if exists chat_messages_staff_select on public.chat_messages;
create policy chat_messages_staff_select
  on public.chat_messages
  for select
  to authenticated
  using (public.is_active_staff());

-- Deliberately absent: INSERT, UPDATE and DELETE, for every browser role.
--
-- An earlier draft granted INSERT with a policy requiring
-- sender_type = 'staff' and staff_user_id = auth.uid(). That policy was
-- correct as far as it went, but it made the browser a writer, and it
-- duplicated a rule staff-actions already enforces. The single write path
-- is now staff-actions, which sets sender_type and the author id from the
-- verified session and never from the request body.
--
-- UPDATE and DELETE do not exist anywhere, for anyone. The transcript is
-- append-only. Retracting a message would be a product decision needing
-- its own column and its own review - never a silent edit.

-- Belt and braces: the two policies below can never be created by accident
-- later without someone noticing this comment, because the transcript's
-- append-only property is the reason customers and staff can both trust
-- what it says.


-- =========================================================================
-- chat_rate_limits
-- =========================================================================

-- No grants and no policies. RLS is enabled so that even a future grant
-- made by mistake still yields nothing. Only service_role, which bypasses
-- RLS, can touch it - and it does so through chat_rate_limit_hit().


-- =========================================================================
-- 4. Default privileges for anything added later
--
-- Without this, the next table someone creates in public inherits
-- Supabase's permissive defaults and is exposed the moment it exists.
-- =========================================================================
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on functions from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;


-- =========================================================================
-- 5. The two read markers, and who owns which
--
--   staff_last_read_at     the STAFF side. Written only by staff-actions,
--                          on 'mark-read' and after a reply.
--
--   customer_last_read_at  the CUSTOMER side. Written only by chat-read,
--                          after a request that presented the correct
--                          conversation token. Staff have no way to move
--                          it - not through a grant, not through a policy,
--                          not through staff-actions, which never names
--                          the column.
--
-- They are two markers for two different people and neither side may
-- touch the other's. A staff member marking a customer's own thread as
-- "read by the customer" would be writing a small lie into the record.
--
-- Both are reached only by service_role from inside an Edge Function, so
-- neither appears in any grant above.
-- =========================================================================
