-- =========================================================================
-- Esther's customer messaging - schema
--
-- Phase 2A. Tables, constraints, indexes and triggers only. All of the
-- access control lives in the next migration
-- (20260901000002_chat_security.sql) so that the two concerns can be read
-- and audited separately.
--
-- Three tables, deliberately:
--   chat_conversations  one per customer conversation
--   chat_messages       append-only transcript
--   staff_profiles      who at Esther's is allowed to see any of it
-- plus one small internal counter table for rate limiting.
--
-- Nothing here grants anybody anything. Until the security migration runs,
-- these tables are reachable only by the database owner.
-- =========================================================================

-- gen_random_uuid() lives here. Supabase ships this extension in the
-- "extensions" schema and enables it by default; creating it if missing
-- keeps this migration runnable against a bare Postgres too.
create extension if not exists pgcrypto;


-- -------------------------------------------------------------------------
-- chat_conversations
-- -------------------------------------------------------------------------
create table if not exists public.chat_conversations (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Only two states in Phase 2A. Resist adding more until a real workflow
  -- asks for them: every extra state is another branch in the UI.
  status              text        not null default 'open'
                                  constraint chat_conversations_status_check
                                  check (status in ('open', 'closed')),

  -- All optional. A visitor can start a conversation without handing over
  -- anything about themselves; asking first is a UX decision for Phase 2B.
  customer_name       text,
  customer_email      text,
  customer_phone      text,

  -- SHA-256 of the customer's bearer token, hex encoded. The raw token is
  -- returned to the browser once by chat-start and never written down. If
  -- this table leaked, the hashes in it would not let anyone read a
  -- conversation, because the token cannot be recovered from its hash.
  customer_token_hash text        not null unique
                                  constraint chat_conversations_token_hash_check
                                  check (customer_token_hash ~ '^[0-9a-f]{64}$'),

  last_message_at     timestamptz not null default now(),
  staff_last_read_at  timestamptz,
  customer_last_read_at timestamptz,
  closed_at           timestamptz
);

comment on table  public.chat_conversations is
  'One customer conversation. Reached by customers only through Edge Functions, never directly.';
comment on column public.chat_conversations.customer_token_hash is
  'SHA-256 (hex) of the customer bearer token. The raw token is NEVER stored.';


-- -------------------------------------------------------------------------
-- chat_messages   (append-only)
-- -------------------------------------------------------------------------
create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid        not null
                              references public.chat_conversations(id)
                              on delete cascade,
  created_at      timestamptz not null default now(),

  sender_type     text        not null
                              constraint chat_messages_sender_type_check
                              check (sender_type in ('customer', 'staff', 'system')),

  -- Trimmed and length-checked in the database as well as in the Edge
  -- Function. The function is the friendly error message; this is the
  -- guarantee.
  body            text        not null
                              constraint chat_messages_body_check
                              check (char_length(btrim(body)) between 1 and 4000),

  -- Set for staff messages, null for customer and system messages. If a
  -- staff account is ever deleted the transcript survives with a null
  -- author rather than disappearing.
  staff_user_id   uuid        references auth.users(id) on delete set null,

  -- A message either comes from a staff member and says which one, or it
  -- does not come from staff at all. Stops a staff row being written with
  -- no author, and stops a customer row being attributed to a staff member.
  constraint chat_messages_staff_author_check check (
    (sender_type = 'staff'  and staff_user_id is not null) or
    (sender_type <> 'staff' and staff_user_id is null)
  )
);

comment on table public.chat_messages is
  'Append-only transcript. No UPDATE or DELETE policy exists for any client role.';


-- -------------------------------------------------------------------------
-- staff_profiles
--
-- Authorization is a row in this table, not an email domain and not a
-- claim in a JWT the user could influence. Rows are created out of band by
-- an administrator; no client role may write here at all.
-- -------------------------------------------------------------------------
create table if not exists public.staff_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text        not null
                           constraint staff_profiles_display_name_check
                           check (char_length(btrim(display_name)) between 1 and 120),
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

comment on table public.staff_profiles is
  'Membership table. Being authenticated is not being staff; having an active row here is.';


-- -------------------------------------------------------------------------
-- chat_rate_limits
--
-- A fixed-window counter. Internal plumbing for the Edge Functions: no
-- client role is granted anything on it, and it carries no personal data -
-- the bucket key holds a hash, never a raw IP or a raw token.
-- -------------------------------------------------------------------------
create table if not exists public.chat_rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket, window_start)
);

comment on table public.chat_rate_limits is
  'Fixed-window counters for the Edge Functions. Service role only. Prune with delete_expired_rate_limits().';


-- -------------------------------------------------------------------------
-- Indexes
--
-- Four, each answering a query the application actually makes. Nothing
-- speculative: an unused index still costs every write.
-- -------------------------------------------------------------------------

-- Staff inbox, newest conversation first.
create index if not exists chat_conversations_last_message_at_idx
  on public.chat_conversations (last_message_at desc);

-- The same inbox filtered to open (or closed) conversations.
create index if not exists chat_conversations_status_last_message_at_idx
  on public.chat_conversations (status, last_message_at desc);

-- Reading one transcript in order, and the customer's own poll.
create index if not exists chat_messages_conversation_id_created_at_idx
  on public.chat_messages (conversation_id, created_at);

-- The customer token lookup. UNIQUE on customer_token_hash already creates
-- an index, so there is deliberately no second one here.


-- -------------------------------------------------------------------------
-- updated_at
--
-- security definer + an empty search_path is the standard shape for a
-- Supabase trigger function: it runs as the owner so it is not blocked by
-- the caller's own RLS, and it cannot be hijacked by a temporary object
-- planted earlier in the search path.
-- -------------------------------------------------------------------------
create or replace function public.chat_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists chat_conversations_set_updated_at on public.chat_conversations;
create trigger chat_conversations_set_updated_at
  before update on public.chat_conversations
  for each row execute function public.chat_set_updated_at();


-- -------------------------------------------------------------------------
-- Protected columns
--
-- Column-level GRANTs already stop staff writing to the token hash. This
-- is the second lock on the same door: even a mistake in a future grant,
-- or a bug in an Edge Function running as service_role, cannot rewrite a
-- conversation's identity or its bearer credential.
-- -------------------------------------------------------------------------
create or replace function public.chat_conversations_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'chat_conversations.id is immutable';
  end if;
  if new.customer_token_hash is distinct from old.customer_token_hash then
    raise exception 'chat_conversations.customer_token_hash is immutable';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'chat_conversations.created_at is immutable';
  end if;

  -- Keep closed_at honest rather than trusting the caller to set it.
  if new.status = 'closed' and old.status <> 'closed' then
    new.closed_at := now();
  elsif new.status = 'open' and old.status <> 'open' then
    new.closed_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists chat_conversations_guard_trg on public.chat_conversations;
create trigger chat_conversations_guard_trg
  before update on public.chat_conversations
  for each row execute function public.chat_conversations_guard();


-- -------------------------------------------------------------------------
-- last_message_at
--
-- Runs after a message lands so the inbox can sort without touching
-- chat_messages. security definer again: a staff INSERT into chat_messages
-- must not need UPDATE rights on chat_conversations to succeed.
-- -------------------------------------------------------------------------
create or replace function public.chat_bump_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chat_conversations
     set last_message_at = new.created_at,
         updated_at      = now()
   where id = new.conversation_id;
  return null;   -- after-trigger; the return value is ignored
end;
$$;

drop trigger if exists chat_messages_bump_conversation on public.chat_messages;
create trigger chat_messages_bump_conversation
  after insert on public.chat_messages
  for each row execute function public.chat_bump_conversation();


-- -------------------------------------------------------------------------
-- Rate-limit helpers
--
-- Called only by Edge Functions running as service_role. Returns true when
-- the caller is still under the limit for this window.
-- -------------------------------------------------------------------------
create or replace function public.chat_rate_limit_hit(
  p_bucket      text,
  p_window_secs integer,
  p_limit       integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits   integer;
begin
  if p_window_secs <= 0 or p_limit <= 0 then
    raise exception 'invalid rate limit parameters';
  end if;

  -- Floor "now" onto a fixed window boundary so concurrent callers share
  -- one row and the upsert below serialises them.
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);

  insert into public.chat_rate_limits (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set hits = public.chat_rate_limits.hits + 1
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

-- Housekeeping. Call from a scheduled job, or ignore: the table is tiny.
create or replace function public.chat_delete_expired_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.chat_rate_limits
   where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
