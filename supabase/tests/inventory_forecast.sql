-- ============================================================================
-- inventory_forecast.sql — ESTIA · proof that the forecast tables are a tenant's
--                          own, and that the two new states are real
--
-- What this is
--   The evidence for 0030_inventory_forecast.sql. That file shipped two things
--   a proof can hold to account, and this file holds it to both.
--
--     1. Two enum labels. `returning` and `lost` were in the frozen contract
--        and not in `public.inventory_state`. 0030 adds them positioned rather
--        than appended, and it has to end §1 with an explicit `commit;` before
--        anything may name them — an `alter type ... add value` is visible to
--        the catalogue immediately and unusable until the transaction commits.
--        So the labels are asserted twice: once by reading `pg_enum`, which is
--        what 0030's own rehearsal does, and once by *storing them in a row*,
--        which is the thing a catalogue read cannot tell you. A label that
--        lists but raises 55P02 on use is a label the product does not have.
--
--     2. Four tables — inventory_settings, inventory_reservations,
--        inventory_discrepancies, inventory_transfers — each with RLS enabled
--        AND forced, each carrying `organization_id`, each with a select /
--        insert / update policy and, deliberately, no DELETE grant at all.
--        Every one of them is put through the same four questions as a real
--        `authenticated` session belonging to organization A and to nothing
--        else: what can it read, what can it write, what can it change, what
--        can it destroy.
--
--   Every isolation assertion is paired with a positive control. This is not
--   ceremony. A missing GRANT, a policy that admits nobody, or a permission
--   code no role holds all produce exactly the same "0 rows" and "42501" that
--   correct isolation produces — and 0030's own header records that 0011 made
--   precisely that mistake with the commission codes. Without the controls
--   below, this file would pass just as green against a schema where the
--   inventory module is entirely unreachable, and would be worthless.
--
--   Nothing is asserted with `has_table_privilege`. A privilege check proves a
--   grant exists; only running the statement proves the policy filters.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/inventory_forecast.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK. It leaves no rows behind. One result
--   row per assertion plus a TOTAL; `passed = false` anywhere is a defect.
--
-- What this file does NOT prove
--   The forecast arithmetic itself — that Friday's twenty-five towels are not
--   Saturday's thirty — which lives in TypeScript and is proven there. Nor the
--   concurrency guarantee inside `reserve_inventory`: everything here runs on
--   one connection in one transaction, so there is no second session to race.
--   What is proven is the boundary around the tables that arithmetic reads.
--
-- Depends on
--   0001 … 0030 applied in order, plus 0035 — the policies in 0030 name
--   `inventory.adjust` and `inventory.transfer`, which 0035 is the file that
--   puts in `public.permissions` and grants to `organization_owner`. Before
--   0035 those policies admit nobody and the positive controls below go red,
--   which is the correct answer and the reason they exist.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table forecast_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := 'e9000030-0000-4000-8000-00000000000a';
  org_b   constant uuid := 'e9000030-0000-4000-8000-00000000000b';
  user_a  constant uuid := 'e9a00030-0000-4000-8000-00000000000a';
  user_b  constant uuid := 'e9a00030-0000-4000-8000-00000000000b';
  mem_a   constant uuid := 'e9d00030-0000-4000-8000-00000000000a';
  mem_b   constant uuid := 'e9d00030-0000-4000-8000-00000000000b';

  owner_role uuid;

  -- Two properties per organization: a transfer is between properties, and
  -- both of its foreign keys are composite with organization_id, so a
  -- cross-tenant transfer cannot even be spelled without a second property
  -- inside the *same* tenant.
  prop_a1  uuid;
  prop_a2  uuid;
  prop_b1  uuid;
  prop_b2  uuid;

  item_a1  uuid;
  item_a2  uuid;
  item_b1  uuid;
  item_b2  uuid;

  v_labels    text[];
  v_returning integer;
  v_damaged   integer;
  v_out       integer;
  v_lost      integer;
  v_state     text;

  n_all   bigint;
  n_other bigint;
  n_rows  bigint;
  err     text;
begin
  ---------------------------------------------------------------------------
  -- Fixture. Written as the owner, which has BYPASSRLS: setting up the world
  -- is not what is under test.
  --
  -- 0007 put `on_auth_user_created` on auth.users, so the profile row already
  -- exists by the time the insert returns. Inserting one here would raise
  -- 23505 and take the whole file with it.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'forecast-proof-a@estia.test'),
    (user_b, 'forecast-proof-b@estia.test');

  update public.user_profiles set full_name = 'Forecast User A' where id = user_a;
  update public.user_profiles set full_name = 'Forecast User B' where id = user_b;

  insert into public.organizations (id, slug, name) values
    (org_a, 'forecast-proof-org-a', 'Forecast Organization A'),
    (org_b, 'forecast-proof-org-b', 'Forecast Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_b, org_b, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'),
    (mem_b, org_b, 'all_organization');

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'forecast-proof-villa-a1', 'Forecast Villa A1', 'active') returning id into prop_a1;
  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'forecast-proof-villa-a2', 'Forecast Villa A2', 'active') returning id into prop_a2;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'forecast-proof-villa-b1', 'Forecast Villa B1', 'active') returning id into prop_b1;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'forecast-proof-villa-b2', 'Forecast Villa B2', 'active') returning id into prop_b2;

  -- inventory_items and inventory_movements are 0011's, not 0030's. They are
  -- here only as the parents 0030's foreign keys demand.
  insert into public.inventory_items (organization_id, property_id, name, quantity) values
    (org_a, prop_a1, 'forecast-proof bath towel A1', 50) returning id into item_a1;
  insert into public.inventory_items (organization_id, property_id, name, quantity) values
    (org_a, prop_a2, 'forecast-proof bath towel A2', 50) returning id into item_a2;
  insert into public.inventory_items (organization_id, property_id, name, quantity) values
    (org_b, prop_b1, 'forecast-proof bath towel B1', 50) returning id into item_b1;
  insert into public.inventory_items (organization_id, property_id, name, quantity) values
    (org_b, prop_b2, 'forecast-proof bath towel B2', 50) returning id into item_b2;

  ---------------------------------------------------------------------------
  -- 1 · The two states 0030 added
  ---------------------------------------------------------------------------
  -- First the catalogue, which is what 0030's own rehearsal reads.
  select array_agg(e.enumlabel::text order by e.enumsortorder) into v_labels
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'inventory_state';

  insert into forecast_results (area, name, expected, actual, passed) values
    ('enum', 'inventory_state carries the label `returning`', 'present',
     case when 'returning' = any(v_labels) then 'present' else
       'MISSING — labels are ' || array_to_string(v_labels, ',') end,
     'returning' = any(v_labels));

  insert into forecast_results (area, name, expected, actual, passed) values
    ('enum', 'inventory_state carries the label `lost`', 'present',
     case when 'lost' = any(v_labels) then 'present' else
       'MISSING — labels are ' || array_to_string(v_labels, ',') end,
     'lost' = any(v_labels));

  -- Position, not merely presence. INVENTORY_STATES declares an order and the
  -- enum sorts by it, so a screen listing states naturally would otherwise
  -- show the cycle out of sequence.
  v_returning := array_position(v_labels, 'returning');
  v_damaged   := array_position(v_labels, 'damaged');
  v_out       := array_position(v_labels, 'out_of_service');
  v_lost      := array_position(v_labels, 'lost');

  insert into forecast_results (area, name, expected, actual, passed) values
    ('enum', 'returning sorts before damaged, lost after out_of_service',
     'returning<damaged and lost>out_of_service',
     'returning=' || coalesce(v_returning::text, 'null') ||
     ' damaged=' || coalesce(v_damaged::text, 'null') ||
     ' out_of_service=' || coalesce(v_out::text, 'null') ||
     ' lost=' || coalesce(v_lost::text, 'null'),
     v_returning is not null and v_damaged is not null
     and v_out is not null and v_lost is not null
     and v_returning < v_damaged and v_lost > v_out);

  -- And now the part pg_enum cannot answer. `alter type ... add value` makes a
  -- label visible to the catalogue immediately and unusable until the adding
  -- transaction commits: a cast, a default or a comparison raises 55P02. So a
  -- label that lists is not yet a label the product has. Store one.
  begin
    insert into public.inventory_items (organization_id, property_id, name, quantity, state)
      values (org_a, prop_a1, 'forecast-proof towels in the van', 6, 'returning');
    select state::text into v_state from public.inventory_items
      where organization_id = org_a and name = 'forecast-proof towels in the van';
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; v_state := null;
  end;
  insert into forecast_results (area, name, expected, actual, passed) values
    ('enum', 'a row can actually be stored with state = returning', 'returning',
     coalesce(v_state, 'null') || coalesce(' err=' || err, ''),
     v_state = 'returning');

  begin
    insert into public.inventory_items (organization_id, property_id, name, quantity, state)
      values (org_a, prop_a1, 'forecast-proof towels nobody can find', 2, 'lost');
    select state::text into v_state from public.inventory_items
      where organization_id = org_a and name = 'forecast-proof towels nobody can find';
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; v_state := null;
  end;
  insert into forecast_results (area, name, expected, actual, passed) values
    ('enum', 'a row can actually be stored with state = lost', 'lost',
     coalesce(v_state, 'null') || coalesce(' err=' || err, ''),
     v_state = 'lost');

  -- A round trip through the type, which is the comparison a forecast query
  -- makes when it asks which stock is still in the van.
  begin
    select count(*) into n_all from public.inventory_items
     where organization_id = org_a and state in ('returning', 'lost');
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  insert into forecast_results (area, name, expected, actual, passed) values
    ('enum', 'the new labels are usable in a WHERE ... IN comparison', '2',
     n_all::text || coalesce(' err=' || err, ''), n_all = 2);

  ---------------------------------------------------------------------------
  -- Rows belonging to organization B, and to organization A, written by the
  -- owner. inventory_settings is deliberately created for B only: its primary
  -- key is organization_id, so A's own row has to be the one A writes for
  -- itself, which makes the positive control a real insert rather than a
  -- duplicate-key error dressed up as one.
  ---------------------------------------------------------------------------
  insert into public.inventory_settings (organization_id, mode, linen_turnaround_days)
    values (org_b, 'advanced', 2);

  insert into public.inventory_reservations
    (organization_id, property_id, item_id, quantity, needed_from, needed_to, note)
  values
    (org_a, prop_a1, item_a1, 25, '2027-03-05', '2027-03-06', 'forecast-proof A'),
    (org_b, prop_b1, item_b1, 30, '2027-03-06', '2027-03-07', 'forecast-proof B');

  insert into public.inventory_discrepancies
    (organization_id, property_id, item_id, expected_quantity, collected_quantity)
  values
    (org_a, prop_a1, item_a1, 12, 9),
    (org_b, prop_b1, item_b1, 12, 8);

  insert into public.inventory_transfers
    (organization_id, item_id, from_property_id, to_property_id, quantity, needed_by, reason)
  values
    (org_a, item_a1, prop_a1, prop_a2, 5, '2027-03-06', 'forecast-proof A'),
    (org_b, item_b1, prop_b1, prop_b2, 5, '2027-03-06', 'forecast-proof B');

  ---------------------------------------------------------------------------
  -- Impersonate user A: an active member of organization A and nothing else.
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
  insert into forecast_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  ---------------------------------------------------------------------------
  -- 2 · inventory_settings
  --     Written by `inventory.edit`, read by `inventory.view`.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    insert into public.inventory_settings (organization_id, mode)
      values (org_b, 'off');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('insert', 'inventory_settings INSERT carrying org B refused', '42501', err, err = '42501');

  -- Positive control for the same verb. Without it the refusal above is
  -- equally consistent with a table nobody may write at all.
  begin
    execute 'set local role authenticated';
    insert into public.inventory_settings
      (organization_id, mode, linen_turnaround_days, shared_stock)
      values (org_a, 'advanced', 2, false);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert inventory_settings for its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.inventory_settings;
    select count(*) into n_other from public.inventory_settings where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('select', 'inventory_settings: A sees its own row and none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_settings set safety_buffer_units = 99
     where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('update', 'inventory_settings UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_settings set safety_buffer_units = 10
     where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own inventory_settings', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- 0030 grants select, insert and update and nothing else. The absence of the
  -- DELETE grant is the mechanism, so the expected answer is a refusal rather
  -- than a filtered zero — and it is asserted in the caller's own organization
  -- too, because a zero there would be indistinguishable from a policy that
  -- filtered rather than a grant that is missing.
  begin
    execute 'set local role authenticated';
    delete from public.inventory_settings where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_settings DELETE of B refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.inventory_settings where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_settings DELETE refused in A''s own org too', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 3 · inventory_reservations
  --     `inventory.adjust`, not `inventory.edit`: a promise of stock to a
  --     booking is a quantity, and adjust is the permission that moves one.
  ---------------------------------------------------------------------------
  -- Every foreign key on this insert points at a real row of B's, so the only
  -- thing that can refuse it is the policy.
  begin
    execute 'set local role authenticated';
    insert into public.inventory_reservations
      (organization_id, property_id, item_id, quantity, needed_from, needed_to)
      values (org_b, prop_b1, item_b1, 3, '2027-04-01', '2027-04-02');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('insert', 'inventory_reservations INSERT carrying org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.inventory_reservations
      (organization_id, property_id, item_id, quantity, needed_from, needed_to, note)
      values (org_a, prop_a2, item_a2, 3, '2027-04-01', '2027-04-02', 'written by A');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a reservation in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.inventory_reservations;
    select count(*) into n_other from public.inventory_reservations where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('select', 'inventory_reservations: A sees both of its own, none of B''s', 'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_reservations set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('update', 'inventory_reservations UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_reservations set note = 'ok' where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own reservations', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  -- "We promised these and then did not" is a fact worth keeping, so 0030
  -- grants no DELETE: releasing is a status and a reason, not a vanishing.
  begin
    execute 'set local role authenticated';
    delete from public.inventory_reservations where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_reservations DELETE of B refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.inventory_reservations where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_reservations DELETE refused in A''s own org too', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 4 · inventory_discrepancies
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    insert into public.inventory_discrepancies
      (organization_id, property_id, item_id, expected_quantity, collected_quantity)
      values (org_b, prop_b1, item_b1, 10, 7);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('insert', 'inventory_discrepancies INSERT carrying org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.inventory_discrepancies
      (organization_id, property_id, item_id, expected_quantity, collected_quantity)
      values (org_a, prop_a2, item_a2, 10, 7);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN raise a discrepancy in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.inventory_discrepancies;
    select count(*) into n_other from public.inventory_discrepancies where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('select', 'inventory_discrepancies: A sees both of its own, none of B''s', 'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_discrepancies set resolution_note = 'HACKED'
     where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('update', 'inventory_discrepancies UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_discrepancies set resolution_note = 'counted again'
     where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own discrepancies', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  begin
    execute 'set local role authenticated';
    delete from public.inventory_discrepancies where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_discrepancies DELETE of B refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.inventory_discrepancies where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_discrepancies DELETE refused in A''s own org too', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 5 · inventory_transfers
  --     `inventory.transfer` for the write. The SELECT is `inventory.view`, so
  --     the property being asked to give stock away can see the request.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    insert into public.inventory_transfers
      (organization_id, item_id, from_property_id, to_property_id, quantity)
      values (org_b, item_b1, prop_b1, prop_b2, 4);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('insert', 'inventory_transfers INSERT carrying org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.inventory_transfers
      (organization_id, item_id, from_property_id, to_property_id, quantity, reason)
      values (org_a, item_a2, prop_a2, prop_a1, 4, 'written by A');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN propose a transfer inside its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.inventory_transfers;
    select count(*) into n_other from public.inventory_transfers where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('select', 'inventory_transfers: A sees both of its own, none of B''s', 'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  begin
    execute 'set local role authenticated';
    update public.inventory_transfers set reason = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('update', 'inventory_transfers UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- Approving is an UPDATE like any other, and it is the one that empties a
  -- cupboard, so the control uses the real transition rather than a note.
  begin
    execute 'set local role authenticated';
    update public.inventory_transfers
       set status = 'approved', decided_by = user_a, decided_at = now()
     where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('control', 'A CAN approve its own transfers', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  begin
    execute 'set local role authenticated';
    delete from public.inventory_transfers where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_transfers DELETE of B refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.inventory_transfers where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('delete', 'inventory_transfers DELETE refused in A''s own org too', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 6 · Nothing of B's survived any of the above
  ---------------------------------------------------------------------------
  -- Read back as the owner, which no policy filters. Every statement A aimed
  -- at organization B reported zero or refused; this is the independent check
  -- that the zeros were the truth and not a filtered view of a mutation that
  -- actually landed.
  select count(*) into n_all from (
    select 1 from public.inventory_settings      where organization_id = org_b and mode = 'advanced' and safety_buffer_units = 0
    union all
    select 1 from public.inventory_reservations  where organization_id = org_b and note = 'forecast-proof B'
    union all
    select 1 from public.inventory_discrepancies where organization_id = org_b and resolution_note is null
    union all
    select 1 from public.inventory_transfers     where organization_id = org_b and reason = 'forecast-proof B' and status = 'suggested'
  ) untouched;
  insert into forecast_results (area, name, expected, actual, passed) values
    ('tamper', 'organization B''s four rows are byte for byte as the fixture left them', '4',
     n_all::text, n_all = 4);

  select count(*) into n_all from (
    select 1 from public.inventory_reservations  where organization_id = org_b
    union all
    select 1 from public.inventory_discrepancies where organization_id = org_b
    union all
    select 1 from public.inventory_transfers     where organization_id = org_b
    union all
    select 1 from public.inventory_settings      where organization_id = org_b
  ) still_there;
  insert into forecast_results (area, name, expected, actual, passed) values
    ('tamper', 'B still holds exactly the four rows it started with — none added, none removed', '4',
     n_all::text, n_all = 4);

  ---------------------------------------------------------------------------
  -- 7 · Anonymous callers
  ---------------------------------------------------------------------------
  -- 0030 revokes from `anon` by name before it grants to `authenticated`. A
  -- table reachable over /rest/v1 with no grant is the only thing standing
  -- between a stock cupboard and the open internet, so it is asserted per
  -- table rather than once.
  perform set_config('request.jwt.claims', '', true);

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.inventory_settings;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read inventory_settings at all', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.inventory_reservations;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read inventory_reservations at all', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.inventory_discrepancies;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read inventory_discrepancies at all', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.inventory_transfers;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into forecast_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read inventory_transfers at all', '42501', err, err = '42501');

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The tally is appended as a final row so the whole run is one result set.
insert into forecast_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from forecast_results;

select seq, area, name, expected, actual, passed from forecast_results order by seq;

rollback;
