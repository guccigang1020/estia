-- ============================================================================
-- idempotency.sql — ESTIA · proof that a retry cannot charge twice
--
-- What this is
--   isolation.sql proves that Postgres refuses to hand organization A a row
--   belonging to organization B. This file proves the other guarantee the
--   database is asked to carry on its own: that of two attempts holding the
--   same idempotency key, exactly one wins — and that the winner is decided by
--   a unique constraint rather than by application code, which cannot decide
--   it correctly.
--
--   It also re-proves, after 0006 added a column to audit_events, that the
--   append-only guarantee still holds. Adding a column ought to be harmless.
--   "Ought to be" is not a test.
--
--   Every tenant assertion runs as a real `authenticated` session, with
--   request.jwt.claims set the way GoTrue sets it, and every one of them has a
--   positive control: the same statement aimed at the caller's own
--   organization, which must affect exactly one row. A zero-row result on its
--   own proves nothing — a missing GRANT produces the same zero.
--
-- What this file cannot prove
--   True simultaneity. The script runs in one transaction on one connection,
--   so the two "concurrent" begins are sequential statements. What that does
--   prove is the losing path: the second `insert … on conflict do nothing`
--   inserts nothing and the caller falls through to reading the existing row,
--   which is exactly the code path a real race produces for the loser. The
--   raw-duplicate assertion below closes the other half by showing the
--   constraint itself raising 23505 — the mechanism a concurrent transaction
--   would collide with — rather than trusting ON CONFLICT to be the only
--   thing standing between two attempts.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/idempotency.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK; it leaves no rows behind. One result
--   row per assertion plus a TOTAL. `passed = false` anywhere is a defect.
--
-- Depends on
--   0001_identity.sql … 0006_idempotency.sql, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table idempotency_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $outer$
declare
  org_a   constant uuid := '31111111-1111-4111-8111-111111111111';
  org_b   constant uuid := '32222222-2222-4222-8222-222222222222';
  user_a  constant uuid := 'a1aaaaaa-0000-4000-8000-00000000000a';
  user_b  constant uuid := 'b1bbbbbb-0000-4000-8000-00000000000b';
  mem_a   constant uuid := 'd1dddddd-0000-4000-8000-00000000000a';
  mem_b   constant uuid := 'd1dddddd-0000-4000-8000-00000000000b';

  -- One operation, one client-chosen key. The key is deliberately the string a
  -- retry loop with a counter actually produces.
  op      constant text := 'payment.charge';
  key_1   constant text := 'retry-1';
  key_2   constant text := 'retry-2';
  key_3   constant text := 'retry-3';

  fp_a    constant text := 'a1b2c3d4e5f60718';
  fp_b    constant text := 'ffffffffffffffff';

  owner_role uuid;

  first_id   uuid;
  second_id  uuid;
  probe_id   uuid;
  audit_a    uuid;

  n_rows     bigint;
  n_all      bigint;
  n_other    bigint;
  status_txt text;
  ok_bool    boolean;
  got_json   jsonb;
  err        text;
begin
  ---------------------------------------------------------------------------
  -- Fixture, written as the owner. Setting up the world is not what is under
  -- test.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'idempotency-a@estia.test'),
    (user_b, 'idempotency-b@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'idempotency-org-a', 'Organization A'),
    (org_b, 'idempotency-org-b', 'Organization B');

  insert into public.user_profiles (id, full_name) values
    (user_a, 'User A'), (user_b, 'User B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_b, org_b, owner_role);

  insert into public.audit_events
    (organization_id, actor_user_id, actor_label, action, resource_type, summary)
  values
    (org_a, user_a, 'User A', 'booking.create', 'booking', 'A created a booking')
  returning id into audit_a;

  ---------------------------------------------------------------------------
  -- From here on, user A: an active member of organization A and nothing else.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  -- ── begin(): the first attempt takes the key ─────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_1, fp_a, user_a)
      on conflict (organization_id, operation, key) do nothing
      returning id into first_id;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('begin', 'first begin() reserves the key (1 row inserted)', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── begin(): the second, identical attempt does not ──────────────────────
  -- This is the loser's path in a real race: nothing is inserted, and the
  -- caller falls through to reading the row that is already there.
  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_1, fp_a, user_a)
      on conflict (organization_id, operation, key) do nothing
      returning id into second_id;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('begin', 'second concurrent begin() inserts nothing', '0 rows, no id',
     n_rows::text || ' rows, id=' || coalesce(second_id::text, 'null')
       || coalesce(' err=' || err, ''),
     n_rows = 0 and second_id is null);

  -- The loser reads the existing row and classifies it: same fingerprint,
  -- not completed, therefore in_flight.
  begin
    execute 'set local role authenticated';
    select case
             when k.fingerprint <> fp_a then 'mismatch'
             when k.completed_at is null then 'in_flight'
             else 'replayed'
           end
      into status_txt
      from public.idempotency_keys k
     where k.organization_id = org_a and k.operation = op and k.key = key_1;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; status_txt := null;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('begin', 'the loser sees the existing row as in_flight', 'in_flight',
     coalesce(status_txt, 'null') || coalesce(' err=' || err, ''),
     status_txt = 'in_flight');

  -- Exactly one row exists for the scope. Two attempts, one reservation.
  select count(*) into n_all from public.idempotency_keys
   where organization_id = org_a and operation = op and key = key_1;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('begin', 'exactly one row exists for (org, operation, key)', '1',
     n_all::text, n_all = 1);

  -- ── The constraint itself, not ON CONFLICT, is what refuses ──────────────
  -- A concurrent transaction that did not use ON CONFLICT would hit this.
  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint)
      values (org_a, op, key_1, fp_a);
    err := 'NO ERROR - DUPLICATE KEY WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('begin', 'a raw duplicate insert is refused by the unique constraint', '23505',
     err, err = '23505');

  -- ── The same key in another organization does not collide ────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_b::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_b, op, key_1, fp_b, user_b)
      on conflict (organization_id, operation, key) do nothing
      returning id into probe_id;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('scope', 'B reserves the same key retry-1 in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  select count(*) into n_all from public.idempotency_keys
   where operation = op and key = key_1;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('scope', 'the same key now exists once per organization', '2',
     n_all::text, n_all = 2);

  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- ── A different request under the same key is a mismatch ─────────────────
  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_1, fp_b, user_a)
      on conflict (organization_id, operation, key) do nothing
      returning id into probe_id;
    get diagnostics n_rows = row_count;
    select case
             when k.fingerprint <> fp_b then 'mismatch'
             when k.completed_at is null then 'in_flight'
             else 'replayed'
           end
      into status_txt
      from public.idempotency_keys k
     where k.organization_id = org_a and k.operation = op and k.key = key_1;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1; status_txt := null;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('mismatch', 'same key, different fingerprint is detectable as mismatch',
     '0 rows, mismatch',
     n_rows::text || ' rows, ' || coalesce(status_txt, 'null') || coalesce(' err=' || err, ''),
     n_rows = 0 and status_txt = 'mismatch');

  -- ── complete(): the reservation stores its result ────────────────────────
  begin
    execute 'set local role authenticated';
    update public.idempotency_keys
       set result = '{"charge_id":"ch_123","amount_agorot":520000}'::jsonb,
           completed_at = now(),
           updated_by = user_a
     where organization_id = org_a and operation = op and key = key_1;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('complete', 'complete() writes the result (1 row)', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- The database, not the caller, widened the retention window.
  select expires_at > now() + interval '23 hours', version
    into ok_bool, n_all
    from public.idempotency_keys
   where organization_id = org_a and operation = op and key = key_1;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('complete', 'completion extends expires_at to the replay window', 'true, version=2',
     coalesce(ok_bool::text, 'null') || ', version=' || coalesce(n_all::text, 'null'),
     ok_bool and n_all = 2);

  -- ── A completed reservation replays its stored result ────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_1, fp_a, user_a)
      on conflict (organization_id, operation, key) do nothing
      returning id into probe_id;
    get diagnostics n_rows = row_count;
    select case
             when k.fingerprint <> fp_a then 'mismatch'
             when k.completed_at is null then 'in_flight'
             else 'replayed'
           end,
           k.result
      into status_txt, got_json
      from public.idempotency_keys k
     where k.organization_id = org_a and k.operation = op and k.key = key_1;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1; status_txt := null;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('replay', 'a completed reservation replays, and returns its stored result',
     '0 rows, replayed, charge ch_123',
     n_rows::text || ' rows, ' || coalesce(status_txt, 'null')
       || ', charge ' || coalesce(got_json ->> 'charge_id', 'null')
       || coalesce(' err=' || err, ''),
     n_rows = 0 and status_txt = 'replayed' and got_json ->> 'charge_id' = 'ch_123');

  ---------------------------------------------------------------------------
  -- Tenant isolation. Organization B's reservation is the target throughout.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.idempotency_keys;
    select count(*) into n_other from public.idempotency_keys where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('select', 'A sees only its own reservation, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint)
      values (org_b, op, 'smuggled', fp_a);
    err := 'NO ERROR - ROW WAS WRITTEN INTO ORG B';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('insert', 'INSERT into organization B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    update public.idempotency_keys set result = '{"stolen":true}'::jsonb, completed_at = now()
     where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('update', 'UPDATE of B''s reservations affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.idempotency_keys where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('delete', 'DELETE of B''s reservations affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- B's row is still there, unchanged, seen from the owner connection.
  select count(*) into n_all from public.idempotency_keys
   where organization_id = org_b and result is null and completed_at is null;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('delete', 'B''s reservation survived A''s attempts untouched', '1',
     n_all::text, n_all = 1);

  -- ── Positive controls for every isolation assertion above ────────────────
  -- Without these, "0 rows affected" could mean a missing GRANT rather than
  -- isolation, and each assertion above would pass vacuously.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.idempotency_keys where organization_id = org_a;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('control', 'A CAN read its own reservation', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_2, fp_a, user_a);
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a reservation in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.idempotency_keys set result = '{"ok":true}'::jsonb, completed_at = now()
     where organization_id = org_a and key = key_2;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own reservation', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- abandon(): the row is genuinely removed, and the key is free again. This
  -- is also the positive control for the DELETE assertion.
  begin
    execute 'set local role authenticated';
    delete from public.idempotency_keys where organization_id = org_a and key = key_2;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete (abandon) its own reservation', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_2, fp_a, user_a)
      on conflict (organization_id, operation, key) do nothing
      returning id into probe_id;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('abandon', 'after abandon() the key can be reserved again', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  ---------------------------------------------------------------------------
  -- Expiry. A reservation held by a process that then crashed must not block
  -- its key for ever, and reclaiming it must not wait for a scheduled sweep.
  ---------------------------------------------------------------------------
  -- Simulate the crash: the row is in flight and its lease has run out.
  update public.idempotency_keys
     set expires_at = now() - interval '1 minute'
   where organization_id = org_a and key = key_2;

  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_2, fp_b, user_a)
      on conflict (organization_id, operation, key) do update
         set fingerprint  = excluded.fingerprint,
             result       = null,
             completed_at = null,
             created_at   = now(),
             expires_at   = now() + interval '1 hour'
       where public.idempotency_keys.expires_at <= now()
      returning id into probe_id;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('expiry', 'an expired reservation is reclaimed in the same statement', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  select fingerprint = fp_b and completed_at is null and expires_at > now()
    into ok_bool
    from public.idempotency_keys
   where organization_id = org_a and key = key_2;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('expiry', 'the reclaimed row is a fresh reservation for the new request', 'true',
     coalesce(ok_bool::text, 'null'), ok_bool);

  -- The negative half: the same statement must NOT take over a live row.
  begin
    execute 'set local role authenticated';
    insert into public.idempotency_keys (organization_id, operation, key, fingerprint, created_by)
      values (org_a, op, key_2, 'aaaaaaaaaaaaaaaa', user_a)
      on conflict (organization_id, operation, key) do update
         set fingerprint  = excluded.fingerprint,
             result       = null,
             completed_at = null,
             created_at   = now(),
             expires_at   = now() + interval '1 hour'
       where public.idempotency_keys.expires_at <= now()
      returning id into probe_id;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('expiry', 'a live reservation is NOT taken over by the reclaiming form', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  select fingerprint into status_txt from public.idempotency_keys
   where organization_id = org_a and key = key_2;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('expiry', 'the live reservation still holds its own fingerprint', fp_b,
     coalesce(status_txt, 'null'), status_txt = fp_b);

  -- The sweeper. Correctness does not depend on it, but it must actually work
  -- and it must not be callable by a signed-in customer.
  insert into public.idempotency_keys (organization_id, operation, key, fingerprint, expires_at)
    values (org_a, op, key_3, fp_a, now() - interval '2 days');

  begin
    execute 'set local role authenticated';
    perform public.purge_expired_idempotency_keys();
    err := 'NO ERROR - authenticated executed the sweeper';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('expiry', 'authenticated cannot execute purge_expired_idempotency_keys()',
     '42501', err, err = '42501');

  begin
    execute 'set local role service_role';
    select public.purge_expired_idempotency_keys() into n_all;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  select count(*) into n_other from public.idempotency_keys
   where organization_id = org_a and key = key_3;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('expiry', 'the sweeper deletes the expired row and reports it',
     'removed>=1, remaining=0',
     'removed=' || coalesce(n_all::text, 'null') || ' remaining=' || n_other
       || coalesce(' err=' || err, ''),
     n_all >= 1 and n_other = 0);

  -- And it did not take the live reservations with it.
  select count(*) into n_all from public.idempotency_keys
   where expires_at > now();
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('expiry', 'the sweeper left every unexpired reservation alone', '3',
     n_all::text, n_all = 3);

  ---------------------------------------------------------------------------
  -- Anonymous callers get nothing, as everywhere else.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);
  begin
    execute 'set local role anon';
    select count(*) into n_all from public.idempotency_keys;
    err := 'NO ERROR - anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read idempotency_keys at all', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- audit_events after the column addition. ALTER TABLE ADD COLUMN should not
  -- disturb a statement-level trigger or a revoked privilege — but "should
  -- not" is the reason to check rather than the reason not to.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    update public.audit_events set summary = 'REWRITTEN' where id = audit_a;
    err := 'NO ERROR - AUDIT ROW WAS UPDATED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'authenticated UPDATE on audit_events still refused', '42501',
     err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.audit_events where id = audit_a;
    err := 'NO ERROR - AUDIT ROW WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'authenticated DELETE on audit_events still refused', '42501',
     err, err = '42501');

  begin
    execute 'set local role service_role';
    update public.audit_events set on_behalf_of_user_id = user_b where id = audit_a;
    err := 'NO ERROR - AUDIT ROW WAS UPDATED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'service_role UPDATE of the NEW column refused (BYPASSRLS)',
     '42501', err, err = '42501');

  begin
    execute 'set local role service_role';
    delete from public.audit_events where id = audit_a;
    err := 'NO ERROR - AUDIT ROW WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'service_role DELETE on audit_events still refused', '42501',
     err, err = '42501');

  begin
    execute 'set local role service_role';
    update public.audit_events set summary = 'x'
     where id = '00000000-0000-4000-8000-000000000000';
    err := 'NO ERROR - ZERO-ROW UPDATE WAS ACCEPTED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'zero-row UPDATE on audit_events still refused', '42501',
     err, err = '42501');

  begin
    update public.audit_events set on_behalf_of_user_id = user_b where id = audit_a;
    err := 'NO ERROR - AUDIT ROW WAS UPDATED';
  exception when others then err := sqlstate;
  end;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'table owner UPDATE on audit_events still refused', '42501',
     err, err = '42501');

  begin
    delete from public.audit_events where id = audit_a;
    err := 'NO ERROR - AUDIT ROW WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'table owner DELETE on audit_events still refused', '42501',
     err, err = '42501');

  -- The positive control for the whole append-only section: inserts must still
  -- work, or the four refusals above prove only that the table is broken.
  begin
    execute 'set local role authenticated';
    insert into public.audit_events
      (organization_id, actor_user_id, actor_type, actor_label,
       on_behalf_of_user_id, action, resource_type, summary)
    values
      (org_a, null, 'ai_agent', 'Website Studio',
       user_a, 'content.publish', 'page',
       'ESTIA wrote a new homepage headline, and User A approved it');
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('control', 'an ai_agent event carrying on_behalf_of_user_id inserts', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- And it reads back as what it is: generated by ESTIA, approved by a person.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.audit_events
     where organization_id = org_a
       and actor_type = 'ai_agent'
       and on_behalf_of_user_id = user_a;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('control', 'the delegated event is readable with its approver attached', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  -- A member may not sign an event with somebody else's name, and 0006 extends
  -- that to somebody else's approval: a forged "the owner approved this" is
  -- exactly as damaging as a forged actor.
  begin
    execute 'set local role authenticated';
    insert into public.audit_events
      (organization_id, actor_user_id, actor_type, actor_label,
       on_behalf_of_user_id, action, resource_type, summary)
    values
      (org_a, null, 'ai_agent', 'Website Studio',
       user_b, 'content.publish', 'page', 'forged approval by another member');
    err := 'NO ERROR - FORGED APPROVAL WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into idempotency_results (area, name, expected, actual, passed) values
    ('append_only', 'A cannot claim that B approved an AI action', '42501',
     err, err = '42501');

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $outer$;

insert into idempotency_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from idempotency_results;

select seq, area, name, expected, actual, passed from idempotency_results order by seq;

rollback;
