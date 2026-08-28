-- ============================================================================
-- preparation.sql — ESTIA · proof for 0021
--
-- What this is
--   The evidence for the three tables src/lib/persistence/preparation.ts
--   refused to project onto `tasks`, and for the one guarantee that projection
--   would have deleted.
--
--   Section 2 is the marquee assertion and the reason the group exists: a
--   catalogue is edited *after* a plan was built from it, and the plan still
--   costs what it cost before the edit. Everything else in this file supports
--   that one sentence — the snapshot cannot be updated, cannot be deleted,
--   cannot be duplicated, and a plan cannot name a snapshot that is not there.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/preparation.sql
--
--   One transaction, ending in ROLLBACK. One row per assertion plus a TOTAL.
--   Every isolation claim has a positive control beside it: a zero-row result
--   proves isolation only when the same statement aimed at the caller's own
--   organization affects exactly one row.
--
-- Depends on
--   0001 … 0021, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table prep_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := '3c3c3c3c-7777-4111-8111-111111111111';
  org_b   constant uuid := '4d4d4d4d-7777-4222-8222-222222222222';
  user_a  constant uuid := 'aaaa7777-7777-4000-8000-00000000000a';
  user_b  constant uuid := 'bbbb7777-7777-4000-8000-00000000000b';
  mem_a   constant uuid := 'cccc7777-7777-4000-8000-00000000000a';
  mem_b   constant uuid := 'cccc7777-7777-4000-8000-00000000000b';
  plan_a  constant uuid := 'eeee7777-7777-4000-8000-00000000000a';
  plan_b  constant uuid := 'eeee7777-7777-4000-8000-00000000000b';

  owner_role uuid;
  prop_a     uuid;
  prop_b     uuid;
  unit_a     uuid;
  unit_b     uuid;
  guest_a    uuid;
  guest_b    uuid;
  bk_a       uuid;
  bk_b       uuid;
  cat_a      uuid;
  snap_a     uuid;

  n_rows  bigint;
  n_all   bigint;
  err     text;
  txt     text;
begin
  ---------------------------------------------------------------------------
  -- Fixture
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'prep-a@estia.test'), (user_b, 'prep-b@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'prep-org-a', 'Preparation Organization A'),
    (org_b, 'prep-org-b', 'Preparation Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role), (mem_b, org_b, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'), (mem_b, org_b, 'all_organization');

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'prep-villa-a', 'Preparation Villa A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'prep-villa-b', 'Preparation Villa B', 'active') returning id into prop_b;

  insert into public.units (organization_id, property_id, code, name, status) values
    (org_a, prop_a, 'PA', 'Preparation Unit A', 'active') returning id into unit_a;
  insert into public.units (organization_id, property_id, code, name, status) values
    (org_b, prop_b, 'PB', 'Preparation Unit B', 'active') returning id into unit_b;

  insert into public.guests (organization_id, full_name, phone) values
    (org_a, 'Preparation Guest A', '050-880-0001') returning id into guest_a;
  insert into public.guests (organization_id, full_name, phone) values
    (org_b, 'Preparation Guest B', '050-880-0002') returning id into guest_b;

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_a, prop_a, unit_a, guest_a, 'inquiry', '2027-03-01', '2027-03-03', user_a)
  returning id into bk_a;
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_b, prop_b, unit_b, guest_b, 'inquiry', '2027-03-01', '2027-03-03', user_b)
  returning id into bk_b;

  ---------------------------------------------------------------------------
  -- 1 · The catalogue
  ---------------------------------------------------------------------------
  insert into public.preparation_catalogues
    (organization_id, property_id, bed_types, variable_costs, complexity, created_by)
  values (org_a, prop_a,
          '[{"id":"double","label":"מיטה זוגית"}]'::jsonb,
          '[{"id":"linen","label":"כביסה","amount":10000}]'::jsonb,
          '{"perGuest":5}'::jsonb, user_a)
  returning id into cat_a;

  insert into public.preparation_catalogues
    (organization_id, property_id, created_by)
  values (org_b, prop_b, user_b);

  insert into prep_results (area, name, expected, actual, passed) values
    ('catalogue', 'a property has one catalogue', '1',
     (select count(*)::text from public.preparation_catalogues where property_id = prop_a),
     (select count(*) from public.preparation_catalogues where property_id = prop_a) = 1);

  begin
    insert into public.preparation_catalogues (organization_id, property_id, created_by)
      values (org_a, prop_a, user_a);
    err := 'NO ERROR — TWO CATALOGUES FOR ONE PROPERTY';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('catalogue', 'a second catalogue for one property is refused', '23505', err, err = '23505');

  -- Shape. An object where the type says a list is the write that produces a
  -- snapshot nothing downstream can read.
  begin
    insert into public.preparation_catalogues
      (organization_id, property_id, rules, created_by)
    values (org_b, prop_b, '{"not":"a list"}'::jsonb, user_b);
    err := 'NO ERROR — AN OBJECT STORED WHERE A LIST OF RULES BELONGS';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('catalogue', 'a non-array in a list column is refused', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 2 · The whole point — a March plan still costs what it cost in March
  ---------------------------------------------------------------------------
  insert into public.preparation_snapshots
    (organization_id, property_id, booking_id, hash, effective_on,
     bed_types, variable_costs, complexity, price_lines, created_by)
  select org_a, prop_a, bk_a, 'hash-march-2027', date '2027-03-01',
         c.bed_types, c.variable_costs, c.complexity,
         '[{"kind":"accommodation","amountAgorot":500000}]'::jsonb, user_a
    from public.preparation_catalogues c where c.id = cat_a
  returning id into snap_a;

  insert into public.work_plans
    (id, organization_id, property_id, unit_id, booking_id, version, snapshot_hash,
     sections, critical_path_minutes, recommended_staff, created_by)
  values (plan_a, org_a, prop_a, unit_a, bk_a, 1, 'hash-march-2027',
          '[{"key":"bedrooms","items":[{"itemId":"linen","requiredCount":15}]}]'::jsonb,
          180, 2, user_a);

  -- April. Somebody puts the price of laundry up fivefold.
  update public.preparation_catalogues
     set variable_costs = '[{"id":"linen","label":"כביסה","amount":50000}]'::jsonb,
         updated_by = user_a
   where id = cat_a;

  insert into prep_results (area, name, expected, actual, passed) values
    ('drift', 'the live catalogue now says 50000', '50000',
     (select variable_costs -> 0 ->> 'amount' from public.preparation_catalogues where id = cat_a),
     (select variable_costs -> 0 ->> 'amount' from public.preparation_catalogues where id = cat_a) = '50000');

  insert into prep_results (area, name, expected, actual, passed) values
    ('drift', 'the frozen snapshot still says 10000 — a March plan costs what it cost in March',
     '10000',
     (select variable_costs -> 0 ->> 'amount' from public.preparation_snapshots where id = snap_a),
     (select variable_costs -> 0 ->> 'amount' from public.preparation_snapshots where id = snap_a) = '10000');

  -- And the plan reaches it through its own hash, not through the catalogue.
  insert into prep_results (area, name, expected, actual, passed) values
    ('drift', 'the plan resolves its own snapshot by hash and reads the March figure',
     '10000',
     (select s.variable_costs -> 0 ->> 'amount'
        from public.work_plans w
        join public.preparation_snapshots s
          on s.booking_id = w.booking_id and s.hash = w.snapshot_hash
       where w.id = plan_a),
     (select s.variable_costs -> 0 ->> 'amount'
        from public.work_plans w
        join public.preparation_snapshots s
          on s.booking_id = w.booking_id and s.hash = w.snapshot_hash
       where w.id = plan_a) = '10000');

  ---------------------------------------------------------------------------
  -- 3 · The snapshot is append-only, by privileges and by trigger
  ---------------------------------------------------------------------------
  -- Run as the table owner, which is the case row level security alone does
  -- not cover: postgres and service_role carry BYPASSRLS.
  begin
    update public.preparation_snapshots
       set variable_costs = '[{"id":"linen","amount":50000}]'::jsonb where id = snap_a;
    err := 'NO ERROR — A FROZEN SNAPSHOT WAS EDITED';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('append_only', 'a snapshot cannot be updated, even by the owner', '42501', err, err = '42501');

  begin
    delete from public.preparation_snapshots where id = snap_a;
    err := 'NO ERROR — A FROZEN SNAPSHOT WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('append_only', 'a snapshot cannot be deleted, even by the owner', '42501', err, err = '42501');

  insert into prep_results (area, name, expected, actual, passed) values
    ('append_only', 'no role holds UPDATE or DELETE on preparation_snapshots', 'none',
     coalesce((select string_agg(distinct grantee || ':' || privilege_type, ', ')
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'preparation_snapshots'
         and privilege_type in ('UPDATE', 'DELETE')
         and grantee in ('anon', 'authenticated', 'service_role')), 'none'),
     not exists (select 1 from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'preparation_snapshots'
         and privilege_type in ('UPDATE', 'DELETE')
         and grantee in ('anon', 'authenticated', 'service_role')));

  begin
    insert into public.preparation_snapshots
      (organization_id, property_id, booking_id, hash, effective_on, created_by)
    values (org_a, prop_a, bk_a, 'hash-april-2027', date '2027-04-01', user_a);
    err := 'NO ERROR — A SECOND SNAPSHOT FOR ONE BOOKING';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('append_only', 'a booking cannot acquire a second frozen ruleset', '23505', err, err = '23505');

  -- The booking cannot be erased out from under the record that explains what
  -- it cost.
  --
  -- The code is asserted as "either refusal" rather than as 23503, and that is
  -- a finding rather than a loosening: the DELETE is refused before this
  -- foreign key is reached, because the cascade touches `finance_snapshots`
  -- and 0016's append-only trigger raises 42501 first. src/lib/persistence/
  -- finance.ts already records that behaviour — "a DELETE on bookings fails
  -- even for a booking that has no snapshot". Writing 23503 here would have
  -- been a test that passed for a reason nobody had checked, so both refusals
  -- are accepted and the RESTRICT itself is asserted separately below.
  begin
    delete from public.bookings where id = bk_a;
    err := 'NO ERROR — A COSTED BOOKING WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('append_only', 'a booking that has been costed cannot be deleted',
     '23503 or 42501', err, err in ('23503', '42501'));

  -- …and the foreign key really is RESTRICT, which is the refusal that would
  -- stand on its own if the finance trigger were ever relaxed. `r` is
  -- ON DELETE RESTRICT; `a` would be NO ACTION and `c` would be CASCADE.
  insert into prep_results (area, name, expected, actual, passed) values
    ('append_only', 'the snapshot holds its booking with RESTRICT, not CASCADE', 'r',
     (select confdeltype::text from pg_constraint
       where conname = 'preparation_snapshots_booking_fkey'),
     (select confdeltype from pg_constraint
       where conname = 'preparation_snapshots_booking_fkey') = 'r');

  -- The plan, by contrast, is CASCADE. A computed artefact can be rebuilt from
  -- the snapshot; the snapshot cannot be rebuilt from anything, and the two
  -- foreign keys point at the same booking saying different things on purpose.
  insert into prep_results (area, name, expected, actual, passed) values
    ('append_only', 'the plan holds its booking with CASCADE, not RESTRICT', 'c',
     (select confdeltype::text from pg_constraint
       where conname = 'work_plans_booking_fkey'),
     (select confdeltype from pg_constraint
       where conname = 'work_plans_booking_fkey') = 'c');

  ---------------------------------------------------------------------------
  -- 4 · The revision chain
  ---------------------------------------------------------------------------
  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'creating a plan records revision 1 in the history', '1',
     (select count(*)::text from public.work_plan_versions where plan_id = plan_a and version = 1),
     (select count(*) from public.work_plan_versions where plan_id = plan_a and version = 1) = 1);

  -- The party grows from twenty-five to thirty. A recomputation.
  update public.work_plans
     set version = 2,
         supersedes_version = 1,
         sections = '[{"key":"bedrooms","items":[{"itemId":"linen","requiredCount":20}]}]'::jsonb,
         delta = '{"fromVersion":1,"toVersion":2,"unchanged":0}'::jsonb,
         change_reason = 'guest count 25 -> 30',
         changed_by = user_a
   where id = plan_a;

  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'recomputing records a second revision', '2',
     (select count(*)::text from public.work_plan_versions where plan_id = plan_a),
     (select count(*) from public.work_plan_versions where plan_id = plan_a) = 2);

  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'revision 1 still required 15 after revision 2 asked for 20', '15',
     (select sections -> 0 -> 'items' -> 0 ->> 'requiredCount'
        from public.work_plan_versions where plan_id = plan_a and version = 1),
     (select sections -> 0 -> 'items' -> 0 ->> 'requiredCount'
        from public.work_plan_versions where plan_id = plan_a and version = 1) = '15');

  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'the delta that produced revision 2 is stored, not only narrated', '1',
     (select delta ->> 'fromVersion' from public.work_plan_versions
       where plan_id = plan_a and version = 2),
     (select delta ->> 'fromVersion' from public.work_plan_versions
       where plan_id = plan_a and version = 2) = '1');

  -- A cleaner ticking items is not a new revision of what the work *is*. The
  -- live row moves; the history of revision 2 stays as it was created.
  update public.work_plans
     set sections = '[{"key":"bedrooms","status":"completed","items":[{"itemId":"linen","requiredCount":20,"completedCount":20}]}]'::jsonb,
         updated_by = user_a
   where id = plan_a;

  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'ticking items does not create a third revision', '2',
     (select count(*)::text from public.work_plan_versions where plan_id = plan_a),
     (select count(*) from public.work_plan_versions where plan_id = plan_a) = 2);

  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'the live plan carries the completion the history does not', '20',
     (select sections -> 0 -> 'items' -> 0 ->> 'completedCount' from public.work_plans where id = plan_a),
     (select sections -> 0 -> 'items' -> 0 ->> 'completedCount' from public.work_plans where id = plan_a) = '20');

  begin
    update public.work_plans set version = 1 where id = plan_a;
    err := 'NO ERROR — TWO REVISIONS OF WORK WERE SILENTLY DISCARDED';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'a plan revision cannot move backwards', '23514', err, err = '23514');

  insert into prep_results (area, name, expected, actual, passed) values
    ('revision', 'no caller holds INSERT on work_plan_versions', 'none',
     coalesce((select string_agg(distinct grantee, ', ')
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'work_plan_versions'
         and privilege_type = 'INSERT'
         and grantee in ('anon', 'authenticated', 'service_role')), 'none'),
     not exists (select 1 from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'work_plan_versions'
         and privilege_type = 'INSERT'
         and grantee in ('anon', 'authenticated', 'service_role')));

  ---------------------------------------------------------------------------
  -- 5 · A plan cannot invent its own provenance
  ---------------------------------------------------------------------------
  -- Organization B's own snapshot, which the three refusals below are aimed
  -- at so that each fails for the reason under test rather than colliding with
  -- the plan organization A already has.
  insert into public.preparation_snapshots
    (organization_id, property_id, booking_id, hash, effective_on, created_by)
  values (org_b, prop_b, bk_b, 'hash-b', date '2027-03-01', user_b);

  begin
    insert into public.work_plans
      (id, organization_id, property_id, unit_id, booking_id, snapshot_hash, created_by)
    values (gen_random_uuid(), org_b, prop_b, unit_b, bk_b, 'a-hash-nobody-stored', user_b);
    err := 'NO ERROR — A PLAN NAMING A SNAPSHOT THAT DOES NOT EXIST';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('provenance', 'a plan cannot name a snapshot that was never stored', '23503', err, err = '23503');

  begin
    insert into public.work_plans
      (id, organization_id, property_id, unit_id, booking_id, snapshot_hash,
       sections, created_by)
    values (gen_random_uuid(), org_b, prop_b, unit_b, bk_b, 'hash-b',
            '{"not":"a list"}'::jsonb, user_b);
    err := 'NO ERROR — SECTIONS STORED AS AN OBJECT';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('provenance', 'a plan whose sections are not a list is refused', '23514', err, err = '23514');

  insert into public.work_plans
    (id, organization_id, property_id, unit_id, booking_id, snapshot_hash, created_by)
  values (plan_b, org_b, prop_b, unit_b, bk_b, 'hash-b', user_b);

  begin
    insert into public.work_plans
      (id, organization_id, property_id, unit_id, booking_id, snapshot_hash, created_by)
    values (gen_random_uuid(), org_b, prop_b, unit_b, bk_b, 'hash-b', user_b);
    err := 'NO ERROR — A SECOND PLAN FOR ONE BOOKING';
  exception when others then err := sqlstate;
  end;
  insert into prep_results (area, name, expected, actual, passed) values
    ('provenance', 'a booking cannot acquire a second plan', '23505', err, err = '23505');

  ---------------------------------------------------------------------------
  -- 6 · Tenant isolation, with a positive control on every claim
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_b::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.preparation_catalogues where organization_id = org_a;
    select count(*) into n_all  from public.preparation_catalogues where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1; n_all := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot read A''s catalogue', 'other=0',
     'other=' || n_rows || coalesce(' err=' || err, ''), n_rows = 0);
  insert into prep_results (area, name, expected, actual, passed) values
    ('control', 'B CAN read its own catalogue', 'own=1', 'own=' || n_all, n_all = 1);

  begin
    execute 'set local role authenticated';
    update public.preparation_catalogues set complexity = '{"perGuest":999}'::jsonb
     where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot rewrite A''s preparation rules', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.preparation_catalogues set complexity = '{"perGuest":9}'::jsonb
     where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('control', 'B CAN rewrite its own preparation rules', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- Written with VALUES, never INSERT … SELECT from a filtered table: a
  -- filtered source touches zero rows and proves the reader was filtered, not
  -- that the writer was refused.
  begin
    execute 'set local role authenticated';
    insert into public.preparation_catalogues (organization_id, property_id, created_by)
      values (org_a, prop_a, user_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot create a catalogue inside A', '42501',
     n_rows::text || coalesce(' err=' || err, ''), err = '42501');

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.preparation_snapshots where organization_id = org_a;
    select count(*) into n_all  from public.preparation_snapshots where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1; n_all := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot read A''s frozen snapshots', 'other=0',
     'other=' || n_rows || coalesce(' err=' || err, ''), n_rows = 0);
  insert into prep_results (area, name, expected, actual, passed) values
    ('control', 'B CAN read its own frozen snapshot', 'own=1', 'own=' || n_all, n_all = 1);

  begin
    execute 'set local role authenticated';
    insert into public.preparation_snapshots
      (organization_id, property_id, booking_id, hash, effective_on, created_by)
    values (org_a, prop_a, bk_a, 'hash-injected', date '2027-03-01', user_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot freeze a snapshot inside A', '42501',
     n_rows::text || coalesce(' err=' || err, ''), err = '42501');

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.work_plans where organization_id = org_a;
    select count(*) into n_all  from public.work_plans where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1; n_all := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot read A''s work plans', 'other=0',
     'other=' || n_rows || coalesce(' err=' || err, ''), n_rows = 0);
  insert into prep_results (area, name, expected, actual, passed) values
    ('control', 'B CAN read its own work plan', 'own=1', 'own=' || n_all, n_all = 1);

  begin
    execute 'set local role authenticated';
    update public.work_plans set recommended_staff = 99 where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot change the crew on A''s plan', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.work_plans set recommended_staff = 3 where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('control', 'B CAN change the crew on its own plan', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.work_plans
      (id, organization_id, property_id, unit_id, booking_id, snapshot_hash, created_by)
    values (gen_random_uuid(), org_a, prop_a, unit_a, bk_a, 'hash-march-2027', user_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot create a plan inside A', '42501',
     n_rows::text || coalesce(' err=' || err, ''), err = '42501');

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.work_plan_versions where organization_id = org_a;
    select count(*) into n_all  from public.work_plan_versions where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1; n_all := -1;
  end;
  execute 'reset role';
  insert into prep_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot read the history of A''s plans', 'other=0',
     'other=' || n_rows || coalesce(' err=' || err, ''), n_rows = 0);
  insert into prep_results (area, name, expected, actual, passed) values
    ('control', 'B CAN read the history of its own plan', 'own=1', 'own=' || n_all, n_all = 1);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into prep_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from prep_results;

select seq, area, name, expected, actual, passed from prep_results order by seq;

rollback;
