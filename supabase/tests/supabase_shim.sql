-- =========================================================================
-- A minimal stand-in for the parts of Supabase the migrations depend on.
--
-- This file exists ONLY so the security tests can run against a plain
-- PostgreSQL server. It is never applied to the real project - Supabase
-- provides all of this already, and applying it there would be both
-- redundant and dangerous.
--
-- What it recreates:
--   - the anon / authenticated / service_role roles
--   - auth.users, enough of it for our foreign keys
--   - auth.uid() and auth.role(), reading request.jwt.claims exactly as
--     Supabase's do, so a policy written for production behaves the same
--     way here
-- =========================================================================

create extension if not exists pgcrypto;

-- Roles. NOINHERIT matches Supabase; service_role bypasses RLS there, and
-- does here too, which is what lets the Edge Functions reach the tables.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now()
);

-- The current user id, taken from the verified JWT claims that Supabase
-- sets on the connection. Returns null when there is no session.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
$$;

grant execute on function auth.uid()  to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
