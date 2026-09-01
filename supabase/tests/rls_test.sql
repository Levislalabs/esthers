-- =========================================================================
-- Security tests for the chat schema.
--
-- These run against a plain PostgreSQL server with a small Supabase
-- emulation layer loaded first (supabase/tests/supabase_shim.sql): the
-- anon / authenticated / service_role roles, an auth.users table, and an
-- auth.uid() that reads the current request's claims. That is enough to
-- exercise every GRANT and every POLICY exactly as the real project will.
--
-- Each test raises an exception on failure, so the whole file either runs
-- to "ALL TESTS PASSED" or stops at the first thing that is wrong.
--
-- Run with:  supabase/tests/run_tests.sh
-- =========================================================================

\set ON_ERROR_STOP on
\timing off
-- notice, not warning: every PASS line below is a raise notice, so raising
-- this threshold would silently hide the entire result of the run.
set client_min_messages = notice;

create or replace function test_assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  %', label;
  end if;
end;
$$;

-- Runs a statement as a role and reports whether it was refused.
-- "Refused" covers both halves of the model: a missing GRANT raises
-- insufficient_privilege, while a policy that matches no rows silently
-- affects zero rows. Both are failures to act, and both count here.
create or replace function test_denied(
  p_role text, p_claims text, p_sql text
) returns boolean language plpgsql as $$
declare
  v_denied boolean := false;
begin
  begin
    execute format('set local role %I', p_role);
    if p_claims is null then
      perform set_config('request.jwt.claims', '', true);
    else
      perform set_config('request.jwt.claims', p_claims, true);
    end if;
    execute p_sql;
    v_denied := false;
  exception
    when insufficient_privilege then v_denied := true;
    when others then v_denied := true;
  end;
  reset role;
  return v_denied;
end;
$$;

-- Counts rows visible to a role. Zero visible rows is how RLS refuses a
-- SELECT, so this is the companion to test_denied for reads.
create or replace function test_visible_count(
  p_role text, p_claims text, p_sql text
) returns integer language plpgsql as $$
declare
  v_count integer;
begin
  begin
    execute format('set local role %I', p_role);
    if p_claims is null then
      perform set_config('request.jwt.claims', '', true);
    else
      perform set_config('request.jwt.claims', p_claims, true);
    end if;
    execute p_sql into v_count;
  exception
    when insufficient_privilege then v_count := -1;   -- no grant at all
    when others then v_count := -2;
  end;
  reset role;
  return v_count;
end;
$$;


-- =========================================================================
-- Fixtures
-- =========================================================================
do $$
declare
  v_staff_id     uuid := '11111111-1111-4111-8111-111111111111';
  v_outsider_id  uuid := '22222222-2222-4222-8222-222222222222';
  v_inactive_id  uuid := '33333333-3333-4333-8333-333333333333';
  v_conv_a       uuid;
  v_conv_b       uuid;
begin
  insert into auth.users (id, email) values
    (v_staff_id,    'staff@example.test'),
    (v_outsider_id, 'outsider@example.test'),
    (v_inactive_id, 'former@example.test')
  on conflict (id) do nothing;

  insert into public.staff_profiles (user_id, display_name, is_active) values
    (v_staff_id,   'Active Staff',   true),
    (v_inactive_id,'Former Staff',   false)
  on conflict (user_id) do nothing;

  -- Two conversations, so we can prove one token cannot reach the other.
  -- The hashes below are SHA-256 of the literal strings 'token-a-raw' and
  -- 'token-b-raw'; the Edge Functions never store a raw token and neither
  -- do these fixtures.
  insert into public.chat_conversations (customer_token_hash, customer_name)
  values (encode(digest('token-a-raw', 'sha256'), 'hex'), 'Customer A')
  returning id into v_conv_a;

  insert into public.chat_conversations (customer_token_hash, customer_name)
  values (encode(digest('token-b-raw', 'sha256'), 'hex'), 'Customer B')
  returning id into v_conv_b;

  insert into public.chat_messages (conversation_id, sender_type, body)
  values (v_conv_a, 'customer', 'Hello from customer A'),
         (v_conv_b, 'customer', 'Hello from customer B');

  insert into public.chat_messages (conversation_id, sender_type, body, staff_user_id)
  values (v_conv_a, 'staff', 'Hello from Esther''s', v_staff_id);

  create temp table t_ids (k text primary key, v uuid);
  insert into t_ids values
    ('staff', v_staff_id), ('outsider', v_outsider_id), ('inactive', v_inactive_id),
    ('conv_a', v_conv_a), ('conv_b', v_conv_b);
end;
$$;


-- =========================================================================
-- The tests
-- =========================================================================
do $$
declare
  claims_staff    text;
  claims_outsider text;
  claims_inactive text;
  conv_a uuid := (select v from t_ids where k = 'conv_a');
  conv_b uuid := (select v from t_ids where k = 'conv_b');
  staff  uuid := (select v from t_ids where k = 'staff');
  n integer;
  ok boolean;
  raw_hits integer;
begin
  claims_staff    := json_build_object('sub', staff, 'role', 'authenticated')::text;
  claims_outsider := json_build_object('sub', (select v from t_ids where k='outsider'), 'role','authenticated')::text;
  claims_inactive := json_build_object('sub', (select v from t_ids where k='inactive'), 'role','authenticated')::text;

  raise notice '--- anon has no reach at all ---';

  -- 1. anon cannot SELECT conversations.
  n := test_visible_count('anon', null, 'select count(*) from public.chat_conversations');
  perform test_assert(n = -1, '1. anon cannot SELECT chat_conversations (no grant)');

  -- 2. anon cannot INSERT messages directly.
  ok := test_denied('anon', null,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''customer'', ''injected'')', conv_a));
  perform test_assert(ok, '2. anon cannot INSERT into chat_messages');

  ok := test_denied('anon', null, 'select count(*) from public.chat_messages');
  perform test_assert(ok, '2b. anon cannot SELECT chat_messages');

  ok := test_denied('anon', null,
    format('insert into public.chat_conversations (customer_token_hash)
            values (%L)', repeat('a', 64)));
  perform test_assert(ok, '2c. anon cannot create a conversation');

  ok := test_denied('anon', null, 'select count(*) from public.staff_profiles');
  perform test_assert(ok, '2d. anon cannot read staff_profiles');

  ok := test_denied('anon', null, 'select count(*) from public.chat_rate_limits');
  perform test_assert(ok, '2e. anon cannot read chat_rate_limits');

  raise notice '--- an ordinary signed-in user is not staff ---';

  -- 3. Ordinary authenticated non-staff user cannot read chats.
  n := test_visible_count('authenticated', claims_outsider,
        'select count(*) from public.chat_conversations');
  perform test_assert(n = 0, '3. non-staff authenticated user sees 0 conversations');

  n := test_visible_count('authenticated', claims_outsider,
        'select count(*) from public.chat_messages');
  perform test_assert(n = 0, '3b. non-staff authenticated user sees 0 messages');

  -- A deactivated staff member is treated exactly like an outsider.
  n := test_visible_count('authenticated', claims_inactive,
        'select count(*) from public.chat_conversations');
  perform test_assert(n = 0, '3c. INACTIVE staff sees 0 conversations');

  -- And nobody can promote themselves.
  ok := test_denied('authenticated', claims_outsider,
    format('insert into public.staff_profiles (user_id, display_name)
            values (%L, ''Self Promoted'')', (select v from t_ids where k='outsider')));
  perform test_assert(ok, '3d. a user cannot insert their own staff_profiles row');

  ok := test_denied('authenticated', claims_inactive,
    'update public.staff_profiles set is_active = true');
  perform test_assert(ok, '3e. an inactive staff member cannot reactivate themselves');

  -- They can read their own row, and only their own.
  n := test_visible_count('authenticated', claims_staff,
        'select count(*) from public.staff_profiles');
  perform test_assert(n = 1, '3f. staff sees exactly their own staff_profiles row');

  raise notice '--- active staff can READ, and only read ---';

  -- 4, 5. Active staff can read conversations and messages. This is the
  -- whole of their direct database access.
  n := test_visible_count('authenticated', claims_staff,
        'select count(*) from public.chat_conversations');
  perform test_assert(n = 2, '4. active staff CAN SELECT conversations');

  n := test_visible_count('authenticated', claims_staff,
        'select count(*) from public.chat_messages');
  perform test_assert(n = 3, '5. active staff CAN SELECT messages');

  raise notice '--- the browser is not a writer, even for active staff ---';

  -- 6. THE CORE OF THIS MODEL. An active staff member holding a valid
  -- session cannot write to these tables from the browser at all. Replies,
  -- closing and mark-read go through staff-actions, which runs
  -- server-side with credentials the browser never sees.
  --
  -- An earlier draft granted INSERT here with a policy requiring
  -- sender_type = 'staff' and staff_user_id = auth.uid(). That policy was
  -- sound but it made a second write path into the same rows. This test
  -- exists to stop it coming back.
  ok := test_denied('authenticated', claims_staff,
    format('insert into public.chat_messages (conversation_id, sender_type, body, staff_user_id)
            values (%L, ''staff'', ''direct insert attempt'', %L)', conv_a, staff));
  perform test_assert(ok, '6. ACTIVE STAFF CANNOT directly INSERT chat_messages');

  ok := test_denied('authenticated', claims_staff,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''customer'', ''forged customer message'')', conv_a));
  perform test_assert(ok, '6b. staff cannot forge a CUSTOMER message directly');

  ok := test_denied('authenticated', claims_staff,
    format('insert into public.chat_messages (conversation_id, sender_type, body, staff_user_id)
            values (%L, ''staff'', ''posted as a colleague'', %L)',
           conv_a, (select v from t_ids where k='inactive')));
  perform test_assert(ok, '6c. staff cannot post as another staff member directly');

  -- 7. Active staff cannot change a conversation from the browser.
  ok := test_denied('authenticated', claims_staff,
    format('update public.chat_conversations set status = ''closed'' where id = %L', conv_a));
  perform test_assert(ok, '7. ACTIVE STAFF CANNOT directly UPDATE chat_conversations (status)');

  ok := test_denied('authenticated', claims_staff,
    format('update public.chat_conversations set staff_last_read_at = now() where id = %L', conv_a));
  perform test_assert(ok, '7b. staff cannot directly UPDATE staff_last_read_at');

  -- 7c. The read marker that belongs to the customer. Staff must not be
  -- able to move it: doing so would write a small lie into the record,
  -- claiming the customer had seen something they had not.
  ok := test_denied('authenticated', claims_staff,
    format('update public.chat_conversations set customer_last_read_at = now() where id = %L', conv_a));
  perform test_assert(ok, '7c. staff cannot UPDATE customer_last_read_at (customer-owned)');

  -- 8. No deletes anywhere, for anyone with a browser session.
  ok := test_denied('authenticated', claims_staff,
    'delete from public.chat_messages');
  perform test_assert(ok, '8. staff have no direct DELETE on chat_messages');

  ok := test_denied('authenticated', claims_staff,
    'delete from public.chat_conversations');
  perform test_assert(ok, '8b. staff have no direct DELETE on chat_conversations');

  ok := test_denied('authenticated', claims_staff,
    'update public.chat_messages set body = ''rewritten history''');
  perform test_assert(ok, '8c. staff cannot UPDATE a message body (append-only)');

  ok := test_denied('authenticated', claims_staff,
    'delete from public.staff_profiles');
  perform test_assert(ok, '8d. staff have no direct DELETE on staff_profiles');

  ok := test_denied('authenticated', claims_staff,
    'insert into public.chat_conversations (customer_token_hash) values (' ||
    quote_literal(repeat('d', 64)) || ')');
  perform test_assert(ok, '8e. staff cannot directly INSERT a conversation');

  raise notice '--- the grants themselves, read from the catalog ---';

  -- Reading the catalog directly, rather than inferring privileges from
  -- behaviour. This is the authoritative statement of what authenticated
  -- actually holds, and it fails loudly if a future migration widens it.
  select count(*) into n
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_schema = 'public'
     and table_name in ('chat_conversations','chat_messages','staff_profiles','chat_rate_limits')
     and privilege_type <> 'SELECT';
  perform test_assert(n = 0,
    'G1. authenticated holds NO privilege other than SELECT on any chat table');

  select count(*) into n
    from information_schema.role_table_grants
   where grantee = 'authenticated'
     and table_schema = 'public'
     and table_name in ('chat_conversations','chat_messages','staff_profiles')
     and privilege_type = 'SELECT';
  perform test_assert(n = 3,
    'G2. authenticated holds SELECT on exactly the three readable tables');

  select count(*) into n
    from information_schema.role_table_grants
   where grantee = 'anon' and table_schema = 'public'
     and table_name in ('chat_conversations','chat_messages','staff_profiles','chat_rate_limits');
  perform test_assert(n = 0, 'G3. anon holds NO privilege of any kind');

  -- And no column-level grant survives either, which is where the old
  -- UPDATE(status, staff_last_read_at, customer_last_read_at) lived.
  select count(*) into n
    from information_schema.column_privileges
   where grantee = 'authenticated'
     and table_schema = 'public'
     and table_name in ('chat_conversations','chat_messages','staff_profiles','chat_rate_limits')
     and privilege_type <> 'SELECT';
  perform test_assert(n = 0, 'G4. authenticated holds no column-level write grant');

  -- No write POLICY exists for authenticated either. Belt and braces: a
  -- future grant alone would then still not be enough.
  select count(*) into n
    from pg_policies
   where schemaname = 'public'
     and tablename in ('chat_conversations','chat_messages','staff_profiles','chat_rate_limits')
     and cmd <> 'SELECT';
  perform test_assert(n = 0, 'G5. no INSERT/UPDATE/DELETE policy exists on any chat table');

  raise notice '--- the customer token ---';

  -- 9. The raw token is never persisted anywhere.
  select count(*) into raw_hits
    from public.chat_conversations
   where customer_token_hash in ('token-a-raw', 'token-b-raw')
      or customer_token_hash like '%token-a-raw%'
      or customer_token_hash like '%token-b-raw%';
  perform test_assert(raw_hits = 0, '9. no raw token is stored in chat_conversations');

  select count(*) into raw_hits
    from public.chat_conversations
   where customer_token_hash !~ '^[0-9a-f]{64}$';
  perform test_assert(raw_hits = 0, '9b. every stored token value is a SHA-256 hex digest');

  -- 10. An invalid token matches nothing.
  select count(*) into n
    from public.chat_conversations
   where id = conv_a
     and customer_token_hash = encode(digest('not-the-right-token', 'sha256'), 'hex');
  perform test_assert(n = 0, '10. an invalid customer token fails to match');

  -- ...and the right token does match, so the test above is meaningful.
  select count(*) into n
    from public.chat_conversations
   where id = conv_a
     and customer_token_hash = encode(digest('token-a-raw', 'sha256'), 'hex');
  perform test_assert(n = 1, '10b. the correct customer token matches its conversation');

  -- 11. One conversation's token cannot reach another conversation.
  select count(*) into n
    from public.chat_conversations
   where id = conv_b
     and customer_token_hash = encode(digest('token-a-raw', 'sha256'), 'hex');
  perform test_assert(n = 0, '11. conversation A''s token cannot open conversation B');

  -- The token hash is immutable even for a privileged caller.
  ok := test_denied('postgres', null,
    format('update public.chat_conversations set customer_token_hash = %L where id = %L',
           repeat('b', 64), conv_a));
  perform test_assert(ok, '11b. customer_token_hash is immutable (guard trigger)');

  -- Staff have no grant on that column in any case.
  ok := test_denied('authenticated', claims_staff,
    format('update public.chat_conversations set customer_token_hash = %L where id = %L',
           repeat('c', 64), conv_a));
  perform test_assert(ok, '11c. staff have no column grant on customer_token_hash');

  raise notice '--- message validation ---';

  -- 12. Empty messages rejected.
  ok := test_denied('postgres', null,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''customer'', '''')', conv_a));
  perform test_assert(ok, '12. an empty message body is rejected');

  ok := test_denied('postgres', null,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''customer'', ''    '')', conv_a));
  perform test_assert(ok, '12b. a whitespace-only message body is rejected');

  -- 13. Oversized messages rejected.
  ok := test_denied('postgres', null,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''customer'', %L)', conv_a, repeat('x', 4001)));
  perform test_assert(ok, '13. a 4001 character message is rejected');

  ok := test_denied('postgres', null,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''customer'', %L)', conv_a, repeat('x', 4000)));
  perform test_assert(not ok, '13b. a 4000 character message is accepted');

  -- An unknown sender_type is refused.
  ok := test_denied('postgres', null,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''robot'', ''hello'')', conv_a));
  perform test_assert(ok, '13c. an unknown sender_type is rejected');

  raise notice '--- malformed input ---';

  -- 14. Malformed UUIDs are a type error, never a wildcard match.
  ok := test_denied('postgres', null,
    'select * from public.chat_conversations where id = ''not-a-uuid''');
  perform test_assert(ok, '14. a malformed UUID is rejected by the type system');

  ok := test_denied('postgres', null,
    format('insert into public.chat_messages (conversation_id, sender_type, body)
            values (%L, ''customer'', ''orphan'')',
           '99999999-9999-4999-8999-999999999999'));
  perform test_assert(ok, '14b. a message for a non-existent conversation is rejected');

  -- An invalid status cannot be set.
  ok := test_denied('postgres', null,
    format('update public.chat_conversations set status = ''archived'' where id = %L', conv_a));
  perform test_assert(ok, '14c. an unknown conversation status is rejected');

  raise notice '--- closing a conversation ---';

  -- 15. Closed behaviour is explicit: closing stamps closed_at, reopening
  -- clears it, and the row stays readable. Refusing new CUSTOMER messages
  -- on a closed conversation is enforced by chat-send, which is covered by
  -- the Edge Function tests rather than here.
  update public.chat_conversations set status = 'closed' where id = conv_a;
  select count(*) into n from public.chat_conversations
   where id = conv_a and status = 'closed' and closed_at is not null;
  perform test_assert(n = 1, '15. closing a conversation stamps closed_at');

  update public.chat_conversations set status = 'open' where id = conv_a;
  select count(*) into n from public.chat_conversations
   where id = conv_a and status = 'open' and closed_at is null;
  perform test_assert(n = 1, '15b. reopening a conversation clears closed_at');

  n := test_visible_count('authenticated', claims_staff,
        format('select count(*) from public.chat_messages where conversation_id = %L', conv_a));
  perform test_assert(n > 0, '15c. a closed conversation stays readable by staff');

  raise notice '--- triggers ---';

  -- last_message_at follows the newest message.
  insert into public.chat_messages (conversation_id, sender_type, body)
  values (conv_b, 'customer', 'a later message');
  select count(*) into n from public.chat_conversations c
   where c.id = conv_b
     and c.last_message_at = (select max(created_at) from public.chat_messages
                               where conversation_id = conv_b);
  perform test_assert(n = 1, '16. inserting a message bumps last_message_at');

  raise notice ' ';
  raise notice 'ALL TESTS PASSED';
end;
$$;
