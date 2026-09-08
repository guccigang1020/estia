-- ============================================================================
-- laundry.sql — ESTIA · proof that the laundry module is sealed per tenant
--
-- What this is
--   The evidence for the row level security half of 0029_laundry.sql. Five
--   tables were added — laundry_settings, laundry_providers,
--   laundry_item_profiles, laundry_orders, laundry_order_lines — every one of
--   them carrying an `organization_id`, every one of them with RLS enabled AND
--   forced. This file proves that the policies over them actually hold: that a
--   member of organization A cannot read, write, alter or remove a single row
--   belonging to organization B.
--
--   Every assertion is executed as a REAL `authenticated` session, with
--   request.jwt.claims set the way GoTrue sets it, so auth.uid() returns the
--   test user and `my_organizations()`, `property_in_scope()` and
--   `has_permission()` all resolve against a real membership. Nothing is
--   asserted against the owner connection, because the owner is exactly the
--   actor RLS does not constrain — the owner is used only to build the world.
--
--   A privilege check is deliberately not used anywhere here.
--   `has_table_privilege` proves a GRANT exists; only running the statement
--   proves the POLICY filters. So every assertion below runs the real
--   statement and reads the real row count or the real sqlstate.
--
-- Positive controls
--   Sections 3 to 7 would pass vacuously on a table nobody can touch at all: a
--   missing GRANT produces the same "0 rows affected" as a policy doing its
--   job. So for every verb that has a policy, the same statement is aimed at
--   organization A and must affect at least one row. Those controls mutate the
--   fixture, so they run last, in section 8.
--
-- What 0029 actually grants, which is not uniform and is asserted as it is
--   laundry_settings, laundry_providers, laundry_item_profiles and
--   laundry_order_lines hold select/insert/update/delete for `authenticated`,
--   with a policy for each verb.
--
--   `laundry_orders` holds select/insert/update ONLY. 0029 grants no DELETE
--   and writes no delete policy, on purpose: "An order is never deleted, by
--   anybody. It is cancelled." So the delete assertions on that table expect
--   42501 rather than zero rows — against organization B AND against the
--   caller's own organization, because the absence of the grant is the point.
--
-- One asymmetry worth naming
--   Reading a laundry_providers row is `laundry.provider_manage`, not
--   `laundry.view`. The test user holds the `organization_owner` system role,
--   which holds all five laundry grants, so this file exercises the tenant
--   boundary and not the permission split — the permission split is 0035's to
--   prove.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/laundry.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK. It leaves no rows behind. One result
--   row per assertion plus a TOTAL; `passed = false` anywhere is a security
--   defect, not a flaky test.
--
-- Depends on
--   0001 … 0007 for identity (organizations, memberships, membership_roles,
--   membership_scopes, and the `on_auth_user_created` trigger that materialises
--   `user_profiles` — which is why the fixture below UPDATEs a profile rather
--   than inserting one), 0008 for properties and `property_in_scope`, 0012 for
--   the five laundry permissions, and 0029 for everything under test.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table laundry_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a    constant uuid := 'a9111111-1111-4111-8111-111111111111';
  org_b    constant uuid := 'a9222222-2222-4222-8222-222222222222';
  user_a   constant uuid := 'a9a11111-0000-4000-8000-00000000000a';
  user_b   constant uuid := 'a9a22222-0000-4000-8000-00000000000b';
  mem_a    constant uuid := 'a9d11111-0000-4000-8000-00000000000a';
  mem_b    constant uuid := 'a9d22222-0000-4000-8000-00000000000b';

  prop_a   constant uuid := 'a9e11111-0000-4000-8000-00000000000a';
  prop_a2  constant uuid := 'a9e11111-0000-4000-8000-00000000000b';
  prop_b   constant uuid := 'a9e22222-0000-4000-8000-00000000000c';

  set_a    constant uuid := 'a9411111-0000-4000-8000-00000000000a';
  set_b    constant uuid := 'a9422222-0000-4000-8000-00000000000b';
  set_ctl  constant uuid := 'a9411111-0000-4000-8000-00000000000c';

  prov_a   constant uuid := 'a9f11111-0000-4000-8000-00000000000a';
  prov_b   constant uuid := 'a9f22222-0000-4000-8000-00000000000b';
  prov_ctl constant uuid := 'a9f11111-0000-4000-8000-00000000000c';

  prof_a   constant uuid := 'a9b11111-0000-4000-8000-00000000000a';
  prof_b   constant uuid := 'a9b22222-0000-4000-8000-00000000000b';
  prof_ctl constant uuid := 'a9b11111-0000-4000-8000-00000000000c';

  ord_a    constant uuid := 'a9c11111-0000-4000-8000-00000000000a';
  ord_b    constant uuid := 'a9c22222-0000-4000-8000-00000000000b';
  ord_ctl  constant uuid := 'a9c11111-0000-4000-8000-00000000000c';

  line_a   constant uuid := 'a9011111-0000-4000-8000-00000000000a';
  line_b   constant uuid := 'a9022222-0000-4000-8000-00000000000b';
  line_ctl constant uuid := 'a9011111-0000-4000-8000-00000000000c';

  due      constant timestamptz := '2027-03-05 10:00:00+02';

  owner_role uuid;

  n_all   bigint;
  n_other bigint;
  n_rows  bigint;
  err     text;
begin
  ---------------------------------------------------------------------------
  -- 1 · Fixture. Written as the owner, which has BYPASSRLS: setting up the
  --     world is not what is under test.
  --
  --     `user_profiles` is UPDATEd rather than inserted. 0007 put
  --     `on_auth_user_created` on auth.users, so the profile row already
  --     exists by the time the insert into auth.users returns, and a second
  --     insert would raise 23505 and take the whole file with it.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'laundry-proof-a@estia.test'),
    (user_b, 'laundry-proof-b@estia.test');

  update public.user_profiles set full_name = 'Laundry Proof User A' where id = user_a;
  update public.user_profiles set full_name = 'Laundry Proof User B' where id = user_b;

  insert into public.organizations (id, slug, name) values
    (org_a, 'laundry-proof-org-a', 'Laundry Proof Organization A'),
    (org_b, 'laundry-proof-org-b', 'Laundry Proof Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_b, org_b, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'),
    (mem_b, org_b, 'all_organization');

  insert into public.properties (id, organization_id, slug, name, status) values
    (prop_a,  org_a, 'laundry-proof-villa-a',  'Laundry Proof Villa A',  'active'),
    (prop_a2, org_a, 'laundry-proof-villa-a2', 'Laundry Proof Villa A2', 'active'),
    (prop_b,  org_b, 'laundry-proof-villa-b',  'Laundry Proof Villa B',  'active');

  -- The outside companies come first: settings and profiles point at them.
  insert into public.laundry_providers
    (id, organization_id, name, phone, default_channel, turnaround_hours)
  values
    (prov_a, org_a, 'Laundry Proof Provider A', '050-900-0001', 'whatsapp', 24),
    (prov_b, org_b, 'Laundry Proof Provider B', '050-900-0002', 'whatsapp', 24);

  -- One organization-wide row each. A property override is inserted later, by
  -- the caller under test, as the INSERT positive control.
  insert into public.laundry_settings
    (id, organization_id, property_id, mode, default_provider_id, standing_notes)
  values
    (set_a, org_a, null, 'external', prov_a, 'laundry-proof-notes-a'),
    (set_b, org_b, null, 'external', prov_b, 'laundry-proof-notes-b');

  insert into public.laundry_item_profiles
    (id, organization_id, item_id, label, laundry_managed, notes)
  values
    (prof_a, org_a, 'laundry-proof-sheet', 'Laundry Proof Sheet', true, 'laundry-proof-a'),
    (prof_b, org_b, 'laundry-proof-sheet', 'Laundry Proof Sheet', true, 'laundry-proof-b');

  insert into public.laundry_orders
    (id, organization_id, property_id, provider_id, status, mode, reference,
     requirement_key, required_by, internal_notes)
  values
    (ord_a, org_a, prop_a, prov_a, 'draft', 'external', 'laundry-proof-ref-a',
     'laundry-proof-key-a', due, 'laundry-proof-internal-a'),
    (ord_b, org_b, prop_b, prov_b, 'draft', 'external', 'laundry-proof-ref-b',
     'laundry-proof-key-b', due, 'laundry-proof-internal-b');

  insert into public.laundry_order_lines
    (id, organization_id, order_id, property_id, item_id, label,
     calculated_quantity, required_by, notes)
  values
    (line_a, org_a, ord_a, prop_a, 'laundry-proof-sheet', 'Laundry Proof Sheet',
     30, due, 'laundry-proof-line-a'),
    (line_b, org_b, ord_b, prop_b, 'laundry-proof-sheet', 'Laundry Proof Sheet',
     44, due, 'laundry-proof-line-b');

  ---------------------------------------------------------------------------
  -- 2 · Become user A: an active member of organization A and nothing else.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- If auth.uid() is not user A, every assertion below is vacuous.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  ---------------------------------------------------------------------------
  -- 3 · SELECT — A's own rows, and none of B's.
  --
  --     The "a>=1" half is the positive control for the select policy: a
  --     policy refusing everybody would produce b=0 as well.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.laundry_settings;
    select count(*) into n_other from public.laundry_settings where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('select', 'laundry_settings: A sees its own row and none of B''s', 'a=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.laundry_providers;
    select count(*) into n_other from public.laundry_providers where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('select', 'laundry_providers: A sees its own row and none of B''s', 'a=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.laundry_item_profiles;
    select count(*) into n_other from public.laundry_item_profiles where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('select', 'laundry_item_profiles: A sees its own row and none of B''s', 'a=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.laundry_orders;
    select count(*) into n_other from public.laundry_orders where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('select', 'laundry_orders: A sees its own order and none of B''s', 'a=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.laundry_order_lines;
    select count(*) into n_other from public.laundry_order_lines where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('select', 'laundry_order_lines: A sees its own line and none of B''s', 'a=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  -- The breakdown is what a provider message is built from, so it is worth
  -- proving that reaching for it through B's order id also returns nothing.
  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.laundry_order_lines where order_id = ord_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('select', 'laundry_order_lines: B''s order id yields no lines', '0',
     n_other::text || coalesce(' err=' || err, ''), n_other = 0);

  ---------------------------------------------------------------------------
  -- 4 · INSERT carrying organization B's id — refused by WITH CHECK.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    insert into public.laundry_settings (organization_id, property_id, mode)
      values (org_b, prop_b, 'external');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('insert', 'laundry_settings INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.laundry_providers (organization_id, name, phone)
      values (org_b, 'Smuggled Provider', '050-900-9999');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('insert', 'laundry_providers INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.laundry_item_profiles (organization_id, item_id, label)
      values (org_b, 'laundry-proof-smuggled', 'Smuggled Item');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('insert', 'laundry_item_profiles INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.laundry_orders
      (organization_id, property_id, provider_id, mode, reference, requirement_key, required_by)
      values (org_b, prop_b, prov_b, 'external', 'laundry-proof-ref-smuggled',
              'laundry-proof-key-smuggled', due);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('insert', 'laundry_orders INSERT into org B refused', '42501', err, err = '42501');

  -- laundry_order_lines is the one table where the refusal does not come from
  -- the policy's WITH CHECK, and the reason is worth stating rather than
  -- papering over. `tg_laundry_order_lines_agree` is a BEFORE trigger and runs
  -- first; it is an ordinary invoker-rights function, so its lookup of the
  -- parent order is itself subject to RLS. Under user A, B's order is not
  -- there to be found, so the insert dies at 23503 — "that order does not
  -- exist" — before the policy ever gets a say. The row is not written either
  -- way, and the assertion below checks BOTH: the refusal, and that B's line
  -- count is untouched afterwards.
  begin
    execute 'set local role authenticated';
    insert into public.laundry_order_lines
      (organization_id, order_id, property_id, item_id, label,
       calculated_quantity, required_by)
      values (org_b, ord_b, prop_b, 'laundry-proof-smuggled', 'Smuggled Line', 99, due);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('insert', 'laundry_order_lines INSERT into org B refused (parent order invisible)',
     '23503', err, err = '23503');

  -- The same attempt smuggled in under organization A's own id, pointed at B's
  -- order. Here the trigger's own cross-tenant check is what refuses it.
  begin
    execute 'set local role authenticated';
    insert into public.laundry_order_lines
      (organization_id, order_id, property_id, item_id, label,
       calculated_quantity, required_by)
      values (org_a, ord_b, prop_a, 'laundry-proof-smuggled', 'Smuggled Line', 99, due);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('insert', 'laundry_order_lines: A cannot hang a line off B''s order',
     '23503', err, err = '23503');

  -- Whatever the sqlstate was, nothing of B's may have appeared.
  select count(*) into n_other from public.laundry_order_lines where organization_id = org_b;
  insert into laundry_results (area, name, expected, actual, passed) values
    ('insert', 'B still holds exactly the one line the fixture gave it', '1',
     n_other::text, n_other = 1);

  ---------------------------------------------------------------------------
  -- 5 · UPDATE of organization B's rows — zero rows affected.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    update public.laundry_settings set standing_notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('update', 'laundry_settings UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.laundry_providers set notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('update', 'laundry_providers UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.laundry_item_profiles set notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('update', 'laundry_item_profiles UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.laundry_orders set internal_notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('update', 'laundry_orders UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.laundry_order_lines set notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('update', 'laundry_order_lines UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- Row counts are what the caller is told; this is what actually happened.
  select count(*) into n_other from public.laundry_order_lines
   where organization_id = org_b and notes = 'laundry-proof-line-b';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('update', 'B''s line still carries the text the fixture gave it', '1',
     n_other::text, n_other = 1);

  ---------------------------------------------------------------------------
  -- 6 · DELETE of organization B's rows.
  --
  --     Four of the five tables have a DELETE grant and a delete policy, so
  --     the correct answer there is zero rows. `laundry_orders` has neither —
  --     0029 revokes delete from service_role as well and says why: an order
  --     is cancelled, never deleted — so the correct answer there is an
  --     outright 42501, which section 8 re-checks against A's own order.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    delete from public.laundry_settings where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('delete', 'laundry_settings DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.laundry_providers where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('delete', 'laundry_providers DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.laundry_item_profiles where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('delete', 'laundry_item_profiles DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.laundry_order_lines where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('delete', 'laundry_order_lines DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- No DELETE grant on laundry_orders at all: the statement is refused before
  -- any policy is consulted, so it never reaches "zero rows".
  begin
    execute 'set local role authenticated';
    delete from public.laundry_orders where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('delete', 'laundry_orders DELETE of B refused outright (no grant)',
     '42501', err, err = '42501');

  -- And B's rows are all still there.
  select count(*) into n_other from (
    select 1 from public.laundry_settings      where organization_id = org_b
    union all select 1 from public.laundry_providers     where organization_id = org_b
    union all select 1 from public.laundry_item_profiles where organization_id = org_b
    union all select 1 from public.laundry_orders        where organization_id = org_b
    union all select 1 from public.laundry_order_lines   where organization_id = org_b
  ) survivors;
  insert into laundry_results (area, name, expected, actual, passed) values
    ('delete', 'all five of B''s rows survived every statement above', '5',
     n_other::text, n_other = 5);

  ---------------------------------------------------------------------------
  -- 7 · anon holds nothing. 0029 revokes every privilege from it by name, and
  --     a laundry order names a property and a date, which unauthenticated is
  --     an occupancy calendar.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.laundry_settings;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read laundry_settings at all', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.laundry_providers;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read laundry_providers at all', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.laundry_item_profiles;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read laundry_item_profiles at all', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.laundry_orders;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read laundry_orders at all', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.laundry_order_lines;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read laundry_order_lines at all', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 8 · Positive controls.
  --
  --     Without these, sections 3 to 6 prove nothing: a missing GRANT, or a
  --     policy that refuses everybody, produces exactly the same zeros. Each
  --     statement below is the twin of one above, aimed at organization A, and
  --     must affect at least the expected number of rows.
  --
  --     They mutate the fixture, so they run last.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- ── INSERT ───────────────────────────────────────────────────────────────
  -- A property override, because the organization-wide row already exists and
  -- `laundry_settings_organization_default_key` allows exactly one.
  begin
    execute 'set local role authenticated';
    insert into public.laundry_settings (id, organization_id, property_id, mode)
      values (set_ctl, org_a, prop_a2, 'hybrid');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a laundry_settings override in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.laundry_providers (id, organization_id, name, phone)
      values (prov_ctl, org_a, 'Laundry Proof Provider A2', '050-900-0003');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a laundry_providers row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.laundry_item_profiles (id, organization_id, item_id, label, laundry_managed)
      values (prof_ctl, org_a, 'laundry-proof-towel', 'Laundry Proof Towel', true);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a laundry_item_profiles row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.laundry_orders
      (id, organization_id, property_id, provider_id, mode, reference,
       requirement_key, required_by)
      values (ord_ctl, org_a, prop_a, prov_a, 'external', 'laundry-proof-ref-ctl',
              'laundry-proof-key-ctl', due);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a laundry_orders row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.laundry_order_lines
      (id, organization_id, order_id, property_id, item_id, label,
       calculated_quantity, required_by, notes)
      values (line_ctl, org_a, ord_a, prop_a, 'laundry-proof-towel',
              'Laundry Proof Towel', 12, due, 'laundry-proof-line-ctl');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a laundry_order_lines row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── SELECT ───────────────────────────────────────────────────────────────
  -- The rows just written are readable back, which is the select policy's own
  -- positive control on the two tables the fixture only gave one row each.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (
      select 1 from public.laundry_settings      where id = set_ctl
      union all select 1 from public.laundry_providers     where id = prov_ctl
      union all select 1 from public.laundry_item_profiles where id = prof_ctl
      union all select 1 from public.laundry_orders        where id = ord_ctl
      union all select 1 from public.laundry_order_lines   where id = line_ctl
    ) mine;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN read back all five rows it just wrote', '5',
     n_all::text || coalesce(' err=' || err, ''), n_all = 5);

  -- ── UPDATE ───────────────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    update public.laundry_settings set standing_notes = 'laundry-proof-ok' where id = set_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own laundry_settings row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.laundry_providers set notes = 'laundry-proof-ok' where id = prov_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own laundry_providers row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.laundry_item_profiles set notes = 'laundry-proof-ok' where id = prof_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own laundry_item_profiles row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.laundry_orders set internal_notes = 'laundry-proof-ok' where id = ord_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own laundry_orders row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.laundry_order_lines set notes = 'laundry-proof-ok' where id = line_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own laundry_order_lines row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── DELETE ───────────────────────────────────────────────────────────────
  -- Four tables have a delete policy, so the zeros in section 6 are policy and
  -- not absence. The rows removed here are the ones this section wrote.
  begin
    execute 'set local role authenticated';
    delete from public.laundry_order_lines where id = line_ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete a laundry_order_lines row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.laundry_item_profiles where id = prof_ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete a laundry_item_profiles row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.laundry_settings where id = set_ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete a laundry_settings row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.laundry_providers where id = prov_ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete a laundry_providers row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- laundry_orders is the exception, and there is no positive control to
  -- offer: the correct behaviour is that nobody deletes an order, including in
  -- the caller's own organization. That is asserted rather than assumed.
  begin
    execute 'set local role authenticated';
    delete from public.laundry_orders where id = ord_ctl;
    err := 'NO ERROR — AN ORDER WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into laundry_results (area, name, expected, actual, passed) values
    ('control', 'nobody deletes a laundry order, not even in their own org',
     '42501', err, err = '42501');

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The tally is appended as a final row so the whole run is one result set.
insert into laundry_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from laundry_results;

select seq, area, name, expected, actual, passed from laundry_results order by seq;

rollback;
