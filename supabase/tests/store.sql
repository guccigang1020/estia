-- ============================================================================
-- store.sql — ESTIA · proof that the store keeps one business out of another's
--
-- What this is
--   The evidence for the row-level security section of 0032_store.sql. That
--   migration creates nineteen tables, enables AND forces RLS on every one of
--   them, revokes the lot from `anon` and `authenticated`, and then hands back
--   a deliberately uneven set of privileges: the catalogue may be deleted, an
--   order may not; the price history may only be read; a provider request is
--   written by whoever fulfils rather than by whoever manages.
--
--   This file asserts that shape, table by table, as a real `authenticated`
--   session belonging to organization A. For each of the nineteen it runs the
--   actual statement — never has_table_privilege, which proves a grant exists
--   and says nothing at all about whether a policy filters — and records:
--
--     · SELECT sees A's rows and none of B's
--     · INSERT carrying B's organization_id is refused with 42501
--     · UPDATE of B's rows affects zero rows
--     · DELETE of B's rows affects zero rows where 0032 grants DELETE, and is
--       refused outright with 42501 on the five tables where it does not:
--       store_price_history, store_orders, store_order_payments,
--       store_order_amendments and store_provider_requests. An order is
--       cancelled, never deleted, and the absence of the grant is the point.
--     · a POSITIVE CONTROL for every verb the table actually grants
--
--   The positive controls are not decoration. A missing GRANT produces exactly
--   the same "0 rows affected" as a working policy, so without them every
--   isolation assertion in this file would pass on a table nobody can reach at
--   all, and the run would be green while proving nothing. They mutate the
--   fixture, so they are all at the end.
--
--   store_price_history is the odd one and is asserted as what it is rather
--   than as what its neighbours are: 0032 grants it SELECT and nothing else,
--   revokes INSERT and UPDATE from `authenticated` and `service_role` alike,
--   and gives it a single policy — a SELECT policy gated on
--   `product.price_manage`. The trigger tg_store_items_price_history is its
--   only writer. So the assertions below expect 42501 on insert, update and
--   delete, in the caller's OWN organization too, and the control is that the
--   one verb it does grant works.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/store.sql
--   or paste it into the SQL editor of the Supabase dashboard, or run the
--   whole directory with `node scripts/run-db-proofs.mjs`.
--
--   One transaction, ending in ROLLBACK. It leaves no rows behind. One result
--   row per assertion plus a TOTAL; `passed = false` anywhere is a security
--   defect, not a flaky test.
--
-- What this file does NOT prove
--   The permission asymmetry inside a single organization. User A here holds
--   `organization_owner`, which carries all nine of 0012's commerce grants, so
--   what is under test is the tenant boundary and the grant surface — not that
--   a receptionist without `provider.manage` is refused store_providers, nor
--   that `product.price_manage` is what store_price_history reads on. Those
--   are a different fixture and belong in their own file.
--
-- Depends on
--   0001 … 0032, applied in order. In particular 0007's on_auth_user_created
--   trigger, which already writes public.user_profiles for a new auth user —
--   which is why the fixture below UPDATEs those rows rather than inserting
--   them.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table store_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := 'c9000000-0000-4000-8000-00000000000a';
  org_b   constant uuid := 'c9000000-0000-4000-8000-00000000000b';
  user_a  constant uuid := 'c9a00000-0000-4000-8000-00000000000a';
  user_b  constant uuid := 'c9a00000-0000-4000-8000-00000000000b';
  mem_a   constant uuid := 'c9d00000-0000-4000-8000-00000000000a';
  mem_b   constant uuid := 'c9d00000-0000-4000-8000-00000000000b';

  owner_role uuid;

  prop_a uuid; prop_b uuid;

  settings_a uuid; settings_b uuid;
  cat_a      uuid; cat_b      uuid;
  prov_a     uuid; prov_b     uuid;
  item_a     uuid; item_b     uuid;
  item_a2    uuid; item_b2    uuid;
  opt_a      uuid; opt_b      uuid;
  val_a      uuid; val_b      uuid;
  addon_a    uuid; addon_b    uuid;
  pkg_a      uuid; pkg_b      uuid;
  pkgitem_a  uuid; pkgitem_b  uuid;
  ovr_a      uuid; ovr_b      uuid;
  rule_a     uuid; rule_b     uuid;
  promo_a    uuid; promo_b    uuid;
  order_a    uuid; order_b    uuid;
  line_a     uuid; line_b     uuid;
  lineopt_a  uuid; lineopt_b  uuid;
  payment_a  uuid; payment_b  uuid;
  amd_a      uuid; amd_b      uuid;
  req_a      uuid; req_b      uuid;

  -- The row a positive control creates, updates and then deletes.
  ctl uuid;

  n_all   bigint;
  n_other bigint;
  n_rows  bigint;
  err     text;
begin
  ---------------------------------------------------------------------------
  -- Fixture. Written as the owner, which has BYPASSRLS: setting up the world
  -- is not what is under test. Built in dependency order — settings,
  -- categories, providers, items, options, packages, then the orders and
  -- their children — and mirrored in full into organization B, because a
  -- child table cannot prove isolation against a parent that does not exist.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'store-proof-a@estia.test'),
    (user_b, 'store-proof-b@estia.test');

  -- 0007's on_auth_user_created has already written these rows. A second
  -- INSERT would raise 23505 and take the whole file with it.
  update public.user_profiles set full_name = 'Store Proof A' where id = user_a;
  update public.user_profiles set full_name = 'Store Proof B' where id = user_b;

  insert into public.organizations (id, slug, name) values
    (org_a, 'store-proof-org-a', 'Store Proof Organization A'),
    (org_b, 'store-proof-org-b', 'Store Proof Organization B');

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
    (org_a, 'store-proof-house-a', 'Store Proof House A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'store-proof-house-b', 'Store Proof House B', 'active') returning id into prop_b;

  -- store_settings · the organization default, one row per scope.
  insert into public.store_settings (organization_id, mode) values
    (org_a, 'simple') returning id into settings_a;
  insert into public.store_settings (organization_id, mode) values
    (org_b, 'simple') returning id into settings_b;

  -- store_categories
  insert into public.store_categories (organization_id, name, slug) values
    (org_a, 'Store Proof Category A', 'store-proof-cat-a') returning id into cat_a;
  insert into public.store_categories (organization_id, name, slug) values
    (org_b, 'Store Proof Category B', 'store-proof-cat-b') returning id into cat_b;

  -- store_providers · `whatsapp` is the default channel and demands a phone.
  insert into public.store_providers (organization_id, name, phone) values
    (org_a, 'Store Proof Provider A', '050-900-0001') returning id into prov_a;
  insert into public.store_providers (organization_id, name, phone) values
    (org_b, 'Store Proof Provider B', '050-900-0002') returning id into prov_b;

  -- store_items · two per organization. The spare exists so the
  -- store_package_items control has an item to add that is not already in the
  -- package, and so nothing has to be deleted out from under another table.
  insert into public.store_items
    (organization_id, category_id, name, slug, base_price_agorot, status)
  values (org_a, cat_a, 'Store Proof Item A', 'store-proof-item-a', 150000, 'active')
  returning id into item_a;
  insert into public.store_items
    (organization_id, category_id, name, slug, base_price_agorot, status)
  values (org_a, cat_a, 'Store Proof Spare A', 'store-proof-spare-a', 20000, 'active')
  returning id into item_a2;
  insert into public.store_items
    (organization_id, category_id, name, slug, base_price_agorot, status)
  values (org_b, cat_b, 'Store Proof Item B', 'store-proof-item-b', 150000, 'active')
  returning id into item_b;
  insert into public.store_items
    (organization_id, category_id, name, slug, base_price_agorot, status)
  values (org_b, cat_b, 'Store Proof Spare B', 'store-proof-spare-b', 20000, 'active')
  returning id into item_b2;

  -- store_item_options and their values
  insert into public.store_item_options (organization_id, item_id, name) values
    (org_a, item_a, 'Store Proof Option A') returning id into opt_a;
  insert into public.store_item_options (organization_id, item_id, name) values
    (org_b, item_b, 'Store Proof Option B') returning id into opt_b;

  insert into public.store_item_option_values (organization_id, option_id, label) values
    (org_a, opt_a, 'Store Proof Value A') returning id into val_a;
  insert into public.store_item_option_values (organization_id, option_id, label) values
    (org_b, opt_b, 'Store Proof Value B') returning id into val_b;

  -- store_item_addons
  insert into public.store_item_addons (organization_id, item_id, name, price_agorot) values
    (org_a, item_a, 'Store Proof Addon A', 5000) returning id into addon_a;
  insert into public.store_item_addons (organization_id, item_id, name, price_agorot) values
    (org_b, item_b, 'Store Proof Addon B', 5000) returning id into addon_b;

  -- store_packages and their members
  insert into public.store_packages (organization_id, category_id, name, slug, price_agorot) values
    (org_a, cat_a, 'Store Proof Package A', 'store-proof-pkg-a', 69000) returning id into pkg_a;
  insert into public.store_packages (organization_id, category_id, name, slug, price_agorot) values
    (org_b, cat_b, 'Store Proof Package B', 'store-proof-pkg-b', 69000) returning id into pkg_b;

  insert into public.store_package_items (organization_id, package_id, item_id) values
    (org_a, pkg_a, item_a) returning id into pkgitem_a;
  insert into public.store_package_items (organization_id, package_id, item_id) values
    (org_b, pkg_b, item_b) returning id into pkgitem_b;

  -- store_item_property_overrides
  insert into public.store_item_property_overrides
    (organization_id, item_id, property_id, price_override_agorot)
  values (org_a, item_a, prop_a, 160000) returning id into ovr_a;
  insert into public.store_item_property_overrides
    (organization_id, item_id, property_id, price_override_agorot)
  values (org_b, item_b, prop_b, 160000) returning id into ovr_b;

  -- store_availability_rules · a weekday rule must name its weekdays.
  insert into public.store_availability_rules (organization_id, item_id, kind, weekdays) values
    (org_a, item_a, 'weekday', array[5]::smallint[]) returning id into rule_a;
  insert into public.store_availability_rules (organization_id, item_id, kind, weekdays) values
    (org_b, item_b, 'weekday', array[5]::smallint[]) returning id into rule_b;

  -- store_promo_codes · the code format is upper case by constraint.
  insert into public.store_promo_codes
    (organization_id, code, discount_kind, percent)
  values (org_a, 'STORE-PROOF-A', 'percent', 10) returning id into promo_a;
  insert into public.store_promo_codes
    (organization_id, code, discount_kind, percent)
  values (org_b, 'STORE-PROOF-B', 'percent', 10) returning id into promo_b;

  -- store_price_history · WRITTEN BY THE TRIGGER, never by hand. Moving the
  -- catalogue price is the only way to make a row here, which is the point of
  -- the table: the record cannot depend on a screen remembering.
  update public.store_items set base_price_agorot = 180000 where id = item_a;
  update public.store_items set base_price_agorot = 180000 where id = item_b;

  -- store_orders · `staff` rather than `guest_portal`, so the order needs no
  -- booking and this file needs no booking fixture.
  insert into public.store_orders
    (organization_id, property_id, reference, source, status)
  values (org_a, prop_a, 'store-proof-A-1', 'staff', 'pending') returning id into order_a;
  insert into public.store_orders
    (organization_id, property_id, reference, source, status)
  values (org_b, prop_b, 'store-proof-B-1', 'staff', 'pending') returning id into order_b;

  -- store_order_lines · the price snapshot.
  insert into public.store_order_lines
    (organization_id, order_id, item_id, item_name_snapshot, item_type_snapshot,
     pricing_model_snapshot, unit_price_agorot, quantity)
  values (org_a, order_a, item_a, 'Store Proof Item A', 'service', 'fixed', 150000, 1)
  returning id into line_a;
  insert into public.store_order_lines
    (organization_id, order_id, item_id, item_name_snapshot, item_type_snapshot,
     pricing_model_snapshot, unit_price_agorot, quantity)
  values (org_b, order_b, item_b, 'Store Proof Item B', 'service', 'fixed', 150000, 1)
  returning id into line_b;

  insert into public.store_order_line_options
    (organization_id, order_line_id, option_id, option_value_id,
     option_name_snapshot, value_label_snapshot)
  values (org_a, line_a, opt_a, val_a, 'Store Proof Option A', 'Store Proof Value A')
  returning id into lineopt_a;
  insert into public.store_order_line_options
    (organization_id, order_line_id, option_id, option_value_id,
     option_name_snapshot, value_label_snapshot)
  values (org_b, line_b, opt_b, val_b, 'Store Proof Option B', 'Store Proof Value B')
  returning id into lineopt_b;

  insert into public.store_order_payments
    (organization_id, order_id, mode, method, amount_agorot)
  values (org_a, order_a, 'with_booking', 'bank_transfer', 150000) returning id into payment_a;
  insert into public.store_order_payments
    (organization_id, order_id, mode, method, amount_agorot)
  values (org_b, order_b, 'with_booking', 'bank_transfer', 150000) returning id into payment_b;

  insert into public.store_order_amendments
    (organization_id, order_id, kind, reason, delta_agorot)
  values (org_a, order_a, 'quantity', 'store-proof fixture A', 0) returning id into amd_a;
  insert into public.store_order_amendments
    (organization_id, order_id, kind, reason, delta_agorot)
  values (org_b, order_b, 'quantity', 'store-proof fixture B', 0) returning id into amd_b;

  insert into public.store_provider_requests
    (organization_id, order_id, order_line_id, provider_id, property_id,
     service_name, service_date, reference)
  values (org_a, order_a, line_a, prov_a, prop_a,
          'Store Proof Service A', current_date + 7, 'store-proof-req-a-1')
  returning id into req_a;
  insert into public.store_provider_requests
    (organization_id, order_id, order_line_id, provider_id, property_id,
     service_name, service_date, reference)
  values (org_b, order_b, line_b, prov_b, prop_b,
          'Store Proof Service B', current_date + 7, 'store-proof-req-b-1')
  returning id into req_b;

  ---------------------------------------------------------------------------
  -- Impersonate user A: an active member of organization A and nothing else,
  -- holding organization_owner, which carries all nine of 0012's grants.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- auth.uid() must actually be user A, or every assertion below is vacuous.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  -- ══ SELECT · A's own rows, and none of B's ═══════════════════════════════

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_settings;
    select count(*) into n_other from public.store_settings where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_settings: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_categories;
    select count(*) into n_other from public.store_categories where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_categories: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_providers;
    select count(*) into n_other from public.store_providers where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_providers: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_items;
    select count(*) into n_other from public.store_items where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_items: A sees its 2 rows, none of B''s', 'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_item_options;
    select count(*) into n_other from public.store_item_options where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_item_options: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_item_option_values;
    select count(*) into n_other from public.store_item_option_values where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_item_option_values: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_item_addons;
    select count(*) into n_other from public.store_item_addons where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_item_addons: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_packages;
    select count(*) into n_other from public.store_packages where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_packages: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_package_items;
    select count(*) into n_other from public.store_package_items where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_package_items: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_item_property_overrides;
    select count(*) into n_other from public.store_item_property_overrides where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_item_property_overrides: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_availability_rules;
    select count(*) into n_other from public.store_availability_rules where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_availability_rules: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_promo_codes;
    select count(*) into n_other from public.store_promo_codes where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_promo_codes: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_price_history;
    select count(*) into n_other from public.store_price_history where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_price_history: A sees the trigger''s 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_orders;
    select count(*) into n_other from public.store_orders where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_orders: A sees its 1 order, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_order_lines;
    select count(*) into n_other from public.store_order_lines where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_order_lines: A sees its 1 line, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_order_line_options;
    select count(*) into n_other from public.store_order_line_options where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_order_line_options: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_order_payments;
    select count(*) into n_other from public.store_order_payments where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_order_payments: A sees its 1 payment, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_order_amendments;
    select count(*) into n_other from public.store_order_amendments where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_order_amendments: A sees its 1 row, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.store_provider_requests;
    select count(*) into n_other from public.store_provider_requests where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('select', 'store_provider_requests: A sees its 1 request, none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  -- ══ INSERT carrying organization B's id · refused by WITH CHECK ══════════
  -- Every one of these names a real parent row in B, so the foreign keys all
  -- resolve and what refuses the statement is the policy and nothing else.

  begin
    execute 'set local role authenticated';
    insert into public.store_settings (organization_id, property_id, mode)
      values (org_b, prop_b, 'simple');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_settings INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_categories (organization_id, name, slug)
      values (org_b, 'Smuggled', 'store-proof-smuggled-cat');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_categories INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_providers (organization_id, name, phone)
      values (org_b, 'Smuggled Provider', '050-900-0009');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_providers INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_items
      (organization_id, category_id, name, slug, base_price_agorot)
      values (org_b, cat_b, 'Smuggled Item', 'store-proof-smuggled-item', 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_items INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_item_options (organization_id, item_id, name)
      values (org_b, item_b, 'Smuggled Option');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_item_options INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_item_option_values (organization_id, option_id, label)
      values (org_b, opt_b, 'Smuggled Value');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_item_option_values INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_item_addons (organization_id, item_id, name, price_agorot)
      values (org_b, item_b, 'Smuggled Addon', 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_item_addons INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_packages (organization_id, name, slug, price_agorot)
      values (org_b, 'Smuggled Package', 'store-proof-smuggled-pkg', 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_packages INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_package_items (organization_id, package_id, item_id)
      values (org_b, pkg_b, item_b2);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_package_items INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_item_property_overrides
      (organization_id, item_id, property_id, price_override_agorot)
      values (org_b, item_b2, prop_b, 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_item_property_overrides INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_availability_rules (organization_id, item_id, kind, weekdays)
      values (org_b, item_b, 'weekday', array[3]::smallint[]);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_availability_rules INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_promo_codes (organization_id, code, discount_kind, percent)
      values (org_b, 'STORE-PROOF-SMUGGLED', 'percent', 50);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_promo_codes INSERT into org B refused', '42501', err, err = '42501');

  -- store_price_history holds no INSERT grant for anybody, so this is refused
  -- before a policy is ever consulted. That is the stronger guarantee.
  begin
    execute 'set local role authenticated';
    insert into public.store_price_history
      (organization_id, item_id, previous_price_agorot, new_price_agorot)
      values (org_b, item_b, 1, 2);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_price_history INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_orders (organization_id, property_id, reference, source, status)
      values (org_b, prop_b, 'store-proof-smuggled-1', 'staff', 'pending');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_orders INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_order_lines
      (organization_id, order_id, item_id, item_name_snapshot, item_type_snapshot,
       pricing_model_snapshot, unit_price_agorot, quantity)
      values (org_b, order_b, item_b, 'Smuggled', 'service', 'fixed', 100, 1);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_order_lines INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_order_line_options
      (organization_id, order_line_id, option_name_snapshot, value_label_snapshot)
      values (org_b, line_b, 'Smuggled Option', 'Smuggled Value');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_order_line_options INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_order_payments
      (organization_id, order_id, mode, method, amount_agorot)
      values (org_b, order_b, 'with_booking', 'cash', 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_order_payments INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_order_amendments
      (organization_id, order_id, kind, reason, delta_agorot)
      values (org_b, order_b, 'price', 'smuggled', 0);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_order_amendments INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.store_provider_requests
      (organization_id, order_id, provider_id, property_id,
       service_name, service_date, reference)
      values (org_b, order_b, prov_b, prop_b,
              'Smuggled Service', current_date + 7, 'store-proof-req-smuggled');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('insert', 'store_provider_requests INSERT into org B refused', '42501', err, err = '42501');

  -- ══ UPDATE of organization B's rows · zero rows affected ═════════════════

  begin
    execute 'set local role authenticated';
    update public.store_settings set guest_store_heading = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_settings UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_categories set name = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_categories UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_providers set notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_providers UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_items set short_description = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_items UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_item_options set name = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_item_options UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_item_option_values set label = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_item_option_values UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_item_addons set name = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_item_addons UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_packages set name = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_packages UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_package_items set quantity = 99 where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_package_items UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_item_property_overrides set notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_item_property_overrides UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_availability_rules set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_availability_rules UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_promo_codes set description = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_promo_codes UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- No UPDATE grant at all on the price history: refused rather than filtered.
  begin
    execute 'set local role authenticated';
    update public.store_price_history set reason = 'HACKED' where organization_id = org_b;
    err := 'NO ERROR — UPDATE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_price_history UPDATE of B refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    update public.store_orders set internal_notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_orders UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_order_lines set notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_order_lines UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_order_line_options set value_label_snapshot = 'HACKED'
      where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_order_line_options UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_order_payments set notes = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_order_payments UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_order_amendments set reason = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_order_amendments UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.store_provider_requests set operational_notes = 'HACKED'
      where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('update', 'store_provider_requests UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- ══ DELETE of organization B's rows ══════════════════════════════════════
  -- Fourteen of the nineteen grant DELETE to `authenticated` and must return
  -- zero rows. The other five grant it to nobody at all — an order, its money,
  -- its amendments, the requests sent in the organization's name and the price
  -- history are the evidence, and 0032 takes DELETE away from `service_role`
  -- as well — so those are refused outright, which is asserted rather than
  -- assumed.

  begin
    execute 'set local role authenticated';
    delete from public.store_settings where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_settings DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_categories where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_categories DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_providers where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_providers DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_items where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_items DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_options where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_item_options DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_option_values where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_item_option_values DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_addons where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_item_addons DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_packages where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_packages DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_package_items where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_package_items DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_property_overrides where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_item_property_overrides DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_availability_rules where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_availability_rules DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_promo_codes where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_promo_codes DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_price_history where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_price_history DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.store_orders where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_orders DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.store_order_lines where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_order_lines DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_order_line_options where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_order_line_options DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.store_order_payments where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_order_payments DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.store_order_amendments where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_order_amendments DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.store_provider_requests where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('delete', 'store_provider_requests DELETE refused outright', '42501', err, err = '42501');

  -- ══ anon holds nothing, anywhere in this schema ══════════════════════════
  -- 0032 revokes every privilege from `anon` and writes no policy for it. An
  -- unauthenticated read of store_orders is an occupancy calendar with a
  -- shopping list attached, so the refusal is asserted at the grant level
  -- where it cannot be argued with.

  perform set_config('request.jwt.claims', '', true);

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_settings;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_settings', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_items;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_items', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_promo_codes;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_promo_codes', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_price_history;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_price_history', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_orders;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_orders', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_order_lines;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_order_lines', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_order_payments;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_order_payments', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.store_provider_requests;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot read store_provider_requests', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- POSITIVE CONTROLS
  --
  -- Without these, everything above proves nothing. A table with no GRANT at
  -- all produces exactly the same "0 rows affected" as a policy doing its job,
  -- and every isolation assertion would pass on a store nobody can use.
  --
  -- Each control creates a row in organization A, updates it and then deletes
  -- it, so the three verbs are proven on the same row and nothing is left
  -- behind for the assertion after it. On the five tables that grant no
  -- DELETE, the control asserts the refusal in the caller's OWN organization —
  -- which is the stronger statement, because it shows the zeros above come
  -- from the missing grant and not from the tenant filter.
  --
  -- These mutate the fixture, so they run last.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- ── store_settings ───────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_settings (organization_id, property_id, mode)
      values (org_a, prop_a, 'simple') returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert store_settings for its own property', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_settings set guest_store_heading = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_settings row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_settings where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_settings row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_categories ─────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_categories (organization_id, name, slug)
      values (org_a, 'Store Proof Control', 'store-proof-cat-ctl') returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_categories row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_categories set name = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_categories row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_categories where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_categories row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_providers ──────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_providers (organization_id, name, phone)
      values (org_a, 'Store Proof Control Provider', '050-900-0011') returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_providers row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_providers set notes = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_providers row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_providers where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_providers row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_items ──────────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_items
      (organization_id, category_id, name, slug, base_price_agorot)
      values (org_a, cat_a, 'Store Proof Control Item', 'store-proof-item-ctl', 1000)
      returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_items row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_items set short_description = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_items row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_items where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_items row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_item_options ───────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_item_options (organization_id, item_id, name)
      values (org_a, item_a, 'Store Proof Control Option') returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_item_options row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_item_options set name = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_item_options row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_options where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_item_options row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_item_option_values ─────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_item_option_values (organization_id, option_id, label)
      values (org_a, opt_a, 'Store Proof Control Value') returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_item_option_values row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_item_option_values set label = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_item_option_values row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_option_values where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_item_option_values row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_item_addons ────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_item_addons (organization_id, item_id, name, price_agorot)
      values (org_a, item_a, 'Store Proof Control Addon', 100) returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_item_addons row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_item_addons set name = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_item_addons row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_addons where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_item_addons row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_packages ───────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_packages (organization_id, name, slug, price_agorot)
      values (org_a, 'Store Proof Control Package', 'store-proof-pkg-ctl', 1000)
      returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_packages row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_packages set description = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_packages row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_packages where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_packages row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_package_items ──────────────────────────────────────────────────
  -- The spare item exists for exactly this: (pkg_a, item_a) is already taken.
  begin
    execute 'set local role authenticated';
    insert into public.store_package_items (organization_id, package_id, item_id)
      values (org_a, pkg_a, item_a2) returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_package_items row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_package_items set quantity = 2 where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_package_items row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_package_items where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_package_items row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_item_property_overrides ────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_item_property_overrides
      (organization_id, item_id, property_id, price_override_agorot)
      values (org_a, item_a2, prop_a, 25000) returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_item_property_overrides row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_item_property_overrides set notes = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_item_property_overrides row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_item_property_overrides where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_item_property_overrides row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_availability_rules ─────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_availability_rules
      (organization_id, item_id, property_id, kind, weekdays)
      values (org_a, item_a, prop_a, 'weekday', array[3]::smallint[]) returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_availability_rules row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_availability_rules set note = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_availability_rules row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_availability_rules where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_availability_rules row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_promo_codes ────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_promo_codes (organization_id, code, discount_kind, amount_agorot)
      values (org_a, 'STORE-PROOF-CTL', 'amount', 5000) returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_promo_codes row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_promo_codes set description = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_promo_codes row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_promo_codes where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_promo_codes row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_price_history · SELECT is the only verb it grants ──────────────
  -- The three refusals below are asserted in the caller's OWN organization,
  -- which is what shows the zeros in the sections above come from the absent
  -- grant rather than from the tenant filter.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.store_price_history
     where organization_id = org_a;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN select its own store_price_history rows (the only verb it holds)', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  begin
    execute 'set local role authenticated';
    insert into public.store_price_history
      (organization_id, item_id, previous_price_agorot, new_price_agorot)
      values (org_a, item_a, 1, 2);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A cannot insert store_price_history even in its own org', '42501',
     err, err = '42501');

  begin
    execute 'set local role authenticated';
    update public.store_price_history set reason = 'store-proof' where organization_id = org_a;
    err := 'NO ERROR — UPDATE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A cannot update store_price_history even in its own org', '42501',
     err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.store_price_history where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A cannot delete store_price_history even in its own org', '42501',
     err, err = '42501');

  -- ── store_orders · INSERT and UPDATE granted, DELETE granted to nobody ───
  begin
    execute 'set local role authenticated';
    insert into public.store_orders (organization_id, property_id, reference, source, status)
      values (org_a, prop_a, 'store-proof-A-ctl', 'staff', 'pending') returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_orders row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_orders set internal_notes = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_orders row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_orders where id = ctl;
    err := 'NO ERROR — AN ORDER WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A cannot delete its OWN order — an order is cancelled, never deleted',
     '42501', err, err = '42501');

  -- ── store_order_lines ────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_order_lines
      (organization_id, order_id, item_id, item_name_snapshot, item_type_snapshot,
       pricing_model_snapshot, unit_price_agorot, quantity)
      values (org_a, order_a, item_a, 'Store Proof Control Line', 'service', 'fixed', 4200, 2)
      returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_order_lines row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_order_lines set notes = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_order_lines row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_order_lines where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_order_lines row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_order_line_options ─────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_order_line_options
      (organization_id, order_line_id, option_name_snapshot, value_label_snapshot)
      values (org_a, line_a, 'Store Proof Control Option', 'Store Proof Control Value')
      returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_order_line_options row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_order_line_options set value_label_snapshot = 'store-proof ok'
      where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_order_line_options row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_order_line_options where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own store_order_line_options row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── store_order_payments · money is recorded and never deleted ───────────
  begin
    execute 'set local role authenticated';
    insert into public.store_order_payments
      (organization_id, order_id, mode, method, amount_agorot)
      values (org_a, order_a, 'with_booking', 'cash', 2500) returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN record a store_order_payments row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_order_payments set notes = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_order_payments row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_order_payments where id = ctl;
    err := 'NO ERROR — A PAYMENT RECORD WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A cannot delete its OWN store_order_payments row', '42501',
     err, err = '42501');

  -- ── store_order_amendments ───────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_order_amendments
      (organization_id, order_id, kind, reason, delta_agorot)
      values (org_a, order_a, 'date', 'store-proof control', 0) returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_order_amendments row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_order_amendments set reason = 'store-proof ok' where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_order_amendments row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_order_amendments where id = ctl;
    err := 'NO ERROR — AN AMENDMENT WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A cannot delete its OWN store_order_amendments row', '42501',
     err, err = '42501');

  -- ── store_provider_requests ──────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    insert into public.store_provider_requests
      (organization_id, order_id, order_line_id, provider_id, property_id,
       service_name, service_date, reference)
      values (org_a, order_a, line_a, prov_a, prop_a,
              'Store Proof Control Service', current_date + 8, 'store-proof-req-a-ctl')
      returning id into ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a store_provider_requests row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.store_provider_requests set operational_notes = 'store-proof ok'
      where id = ctl;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own store_provider_requests row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.store_provider_requests where id = ctl;
    err := 'NO ERROR — A PROVIDER REQUEST WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into store_results (area, name, expected, actual, passed) values
    ('control', 'A cannot delete its OWN store_provider_requests row', '42501',
     err, err = '42501');

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The tally is appended as a final row so the whole run is one result set.
insert into store_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from store_results;

select seq, area, name, expected, actual, passed from store_results order by seq;

rollback;
