-- ============================================================================
-- agents.sql — ESTIA · proof for the agent network, and for the one policy
--              that could not use the tenant rule
--
-- What this is
--   The evidence for 0015_agent_network.sql. The section that matters most is
--   the third: `agencies` has no `organization_id`, so its row level security
--   is written by hand, and a hand-written policy is exactly the one where
--   "isolation works" and "nobody can see anything" look identical from the
--   outside. Both directions are therefore proven explicitly:
--
--     · a member of agency A cannot read agency B;
--     · an organization with no agreement cannot read an agency that sells
--       for somebody else;
--     · and — the controls without which neither of those means anything —
--       a member of agency A CAN read agency A, and an organization holding a
--       live agreement CAN read the agency it signed with.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/agents.sql
--
--   One transaction, ending in ROLLBACK. One row per assertion plus a TOTAL.
--
-- Depends on
--   0001 … 0015, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table agent_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a    constant uuid := '11111111-9999-4111-8111-111111111111';
  org_b    constant uuid := '22222222-9999-4222-8222-222222222222';
  -- org_c signs with nobody: the organization that must see no agency at all.
  org_c    constant uuid := '33333333-9999-4333-8333-333333333333';
  user_a   constant uuid := 'aaaaaaaa-9999-4000-8000-00000000000a';
  user_b   constant uuid := 'bbbbbbbb-9999-4000-8000-00000000000b';
  user_c   constant uuid := 'cccccccc-9999-4000-8000-00000000000c';
  -- The two agency people. `agent_1` belongs to agency A, `agent_2` to B.
  agent_1  constant uuid := 'e1111111-9999-4000-8000-00000000000a';
  agent_2  constant uuid := 'e2222222-9999-4000-8000-00000000000b';
  mem_a    constant uuid := 'dddddddd-9999-4000-8000-00000000000a';
  mem_b    constant uuid := 'dddddddd-9999-4000-8000-00000000000b';
  mem_c    constant uuid := 'dddddddd-9999-4000-8000-00000000000c';
  agency_a constant uuid := 'f1111111-9999-4000-8000-00000000000a';
  agency_b constant uuid := 'f2222222-9999-4000-8000-00000000000b';
  agency_d constant uuid := 'f3333333-9999-4000-8000-00000000000d';

  owner_role uuid;
  prop_a     uuid;
  prop_b     uuid;
  unit_a     uuid;
  unit_b     uuid;
  guest_a    uuid;
  guest_b    uuid;
  bk_a       uuid;
  bk_b       uuid;
  rule_a     uuid;
  comm_a     uuid;
  comm_a2    uuid;
  batch_a    uuid;

  n_rows  bigint;
  n_all   bigint;
  n_other bigint;
  err     text;
  got     text[];
  want    text[];
begin
  ---------------------------------------------------------------------------
  -- Fixture
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'ag-a@estia.test'), (user_b, 'ag-b@estia.test'), (user_c, 'ag-c@estia.test'),
    (agent_1, 'agent-one@estia.test'), (agent_2, 'agent-two@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'agent-org-a', 'Agent Organization A'),
    (org_b, 'agent-org-b', 'Agent Organization B'),
    (org_c, 'agent-org-c', 'Agent Organization C');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now()),
    (mem_c, user_c, org_c, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role), (mem_b, org_b, owner_role), (mem_c, org_c, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'),
    (mem_b, org_b, 'all_organization'),
    (mem_c, org_c, 'all_organization');

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'ag-villa-a', 'Agent Villa A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'ag-villa-b', 'Agent Villa B', 'active') returning id into prop_b;

  insert into public.units (organization_id, property_id, code, name, status) values
    (org_a, prop_a, 'GA', 'Agent Unit A', 'active') returning id into unit_a;
  insert into public.units (organization_id, property_id, code, name, status) values
    (org_b, prop_b, 'GB', 'Agent Unit B', 'active') returning id into unit_b;

  insert into public.guests (organization_id, full_name, phone) values
    (org_a, 'Agent Guest A', '050-990-0001') returning id into guest_a;
  insert into public.guests (organization_id, full_name, phone) values
    (org_b, 'Agent Guest B', '050-990-0002') returning id into guest_b;

  -- Three agencies. A sells for organization A. B sells for organization B.
  -- D sells for nobody in this test and is the row org_c must not see.
  insert into public.agencies (id, name, tax_id, contact_phone, status) values
    (agency_a, 'Agency Alpha', '511111111', '050-111-1111', 'active'),
    (agency_b, 'Agency Beta',  '522222222', '050-222-2222', 'active'),
    (agency_d, 'Agency Delta', '533333333', '050-333-3333', 'active');

  insert into public.agency_memberships (agency_id, user_id, role, status) values
    (agency_a, agent_1, 'manager', 'active'),
    (agency_b, agent_2, 'manager', 'active');

  -- A live agreement between agency A and organization A, and one between
  -- agency B and organization B. Organization C signs nothing.
  insert into public.agency_agreements
    (agency_id, organization_id, status, base, active_from, signed_at,
     rule, payment_terms_days)
  values
    (agency_a, org_a, 'active', 'whole_booking', current_date, now(),
     '{"kind":"percentage","percent":10}'::jsonb, 30),
    (agency_b, org_b, 'active', 'whole_booking', current_date, now(),
     '{"kind":"percentage","percent":12}'::jsonb, 45);

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out,
     source, agent_user_id, agency_id, created_by)
  values
    (org_a, prop_a, unit_a, guest_a, 'confirmed', '2027-08-10', '2027-08-15',
     'agent', agent_1, agency_a, user_a)
  returning id into bk_a;

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values
    (org_b, prop_b, unit_b, guest_b, 'confirmed', '2027-08-10', '2027-08-15', user_b)
  returning id into bk_b;

  ---------------------------------------------------------------------------
  -- 1 · The contract, and the shapes the domain relies on
  ---------------------------------------------------------------------------
  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'commission_base';
  want := array['whole_booking','accommodation_only'];
  insert into agent_results (area, name, expected, actual, passed) values
    ('contract', 'commission_base matches src/lib/agents COMMISSION_BASES',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'commission_condition';
  want := array['deposit_received','payment_received','guest_arrived',
                'stay_completed','cancellation_window_passed'];
  insert into agent_results (area, name, expected, actual, passed) values
    ('contract', 'commission_condition matches COMMISSION_CONDITIONS',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  -- `agencies` must not grow an organization_id. That absence is the design.
  insert into agent_results (area, name, expected, actual, passed) values
    ('contract', 'agencies carries no organization_id column', '0',
     (select count(*)::text from information_schema.columns
       where table_schema = 'public' and table_name = 'agencies'
         and column_name = 'organization_id'),
     (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'agencies'
         and column_name = 'organization_id') = 0);

  -- The bare uuid columns 0009 and 0011 left open are now real references.
  insert into agent_results (area, name, expected, actual, passed) values
    ('contract', 'bookings.agency_id and commissions.agency_id have foreign keys', '2',
     (select count(*)::text from pg_constraint
       where conname in ('bookings_agency_fkey', 'commissions_agency_fkey')),
     (select count(*) from pg_constraint
       where conname in ('bookings_agency_fkey', 'commissions_agency_fkey')) = 2);

  begin
    insert into public.bookings
      (organization_id, property_id, unit_id, guest_id, status, check_in, check_out,
       agency_id, created_by)
    values (org_a, prop_a, unit_a, guest_a, 'inquiry', '2027-09-01', '2027-09-03',
            '00000000-0000-4000-8000-000000000000', user_a);
    err := 'NO ERROR — BOOKED AGAINST A NON-EXISTENT AGENCY';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('contract', 'a booking cannot name an agency that does not exist',
     '23503', err, err = '23503');

  ---------------------------------------------------------------------------
  -- 2 · The commission rule, and its history
  ---------------------------------------------------------------------------
  insert into public.agent_commission_rules
    (organization_id, agent_user_id, name, rule, base, priority, created_by)
  values
    (org_a, agent_1, 'Standard 10%', '{"kind":"percentage","percent":10}'::jsonb,
     'whole_booking', 10, user_a)
  returning id into rule_a;

  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'creating a rule records version 1 in the history', '1',
     (select count(*)::text from public.agent_commission_rule_versions
       where rule_id = rule_a and version = 1),
     (select count(*) from public.agent_commission_rule_versions
       where rule_id = rule_a and version = 1) = 1);

  update public.agent_commission_rules
     set rule = '{"kind":"percentage","percent":8}'::jsonb, updated_by = user_a
   where id = rule_a;

  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'editing a rule records a second version', '2',
     (select count(*)::text from public.agent_commission_rule_versions where rule_id = rule_a),
     (select count(*) from public.agent_commission_rule_versions where rule_id = rule_a) = 2);

  -- The whole point: last year's terms are still readable.
  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'version 1 still says 10% after the rule was changed to 8%', '10',
     (select (rule ->> 'percent') from public.agent_commission_rule_versions
       where rule_id = rule_a and version = 1),
     (select (rule ->> 'percent') from public.agent_commission_rule_versions
       where rule_id = rule_a and version = 1) = '10');

  -- Scope semantics: NULL is "any", '{}' is "nothing", and they are different.
  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'an unscoped rule stores NULL, not an empty array', 'true',
     (select (property_ids is null)::text from public.agent_commission_rules where id = rule_a),
     (select property_ids is null from public.agent_commission_rules where id = rule_a));

  update public.agent_commission_rules set property_ids = '{}'::uuid[] where id = rule_a;
  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'an empty scope array is stored as distinct from NULL', 'false',
     (select (property_ids is null)::text from public.agent_commission_rules where id = rule_a),
     (select property_ids is null from public.agent_commission_rules where id = rule_a) = false);
  update public.agent_commission_rules set property_ids = null where id = rule_a;

  -- A rule that cannot be evaluated pays nothing silently, so it is refused.
  begin
    insert into public.agent_commission_rules (organization_id, rule, created_by)
      values (org_a, '{"kind":"percentage"}'::jsonb, user_a);
    err := 'NO ERROR — A PERCENTAGE RULE WITH NO PERCENT';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'a percentage rule with no percent is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_commission_rules (organization_id, rule, created_by)
      values (org_a, '{"kind":"tiered","mode":"marginal","tiers":[]}'::jsonb, user_a);
    err := 'NO ERROR — A TIERED RULE WITH NO TIERS';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'a tiered rule with no brackets is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_commission_rules (organization_id, rule, created_by)
      values (org_a, '{"kind":"invented"}'::jsonb, user_a);
    err := 'NO ERROR — AN UNKNOWN RULE KIND';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('rule', 'an unknown rule kind is refused', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 3 · A commission can explain itself
  ---------------------------------------------------------------------------
  insert into public.commissions
    (organization_id, property_id, booking_id, agent_user_id, agency_id,
     rule_id, rule_version, base, basis_agorot, rate_bps, amount_agorot,
     explanation, eligibility, created_by)
  values
    (org_a, prop_a, bk_a, agent_1, agency_a, rule_a, 1, 'whole_booking',
     500000, 1000, 50000, '10% of 5,000.00',
     '["payment_received","stay_completed"]'::jsonb, user_a)
  returning id into comm_a;

  insert into agent_results (area, name, expected, actual, passed) values
    ('commission', 'a commission resolves its rule version back to the terms', '10',
     (select v.rule ->> 'percent'
        from public.commissions c
        join public.agent_commission_rule_versions v
          on v.rule_id = c.rule_id and v.version = c.rule_version
       where c.id = comm_a),
     (select v.rule ->> 'percent'
        from public.commissions c
        join public.agent_commission_rule_versions v
          on v.rule_id = c.rule_id and v.version = c.rule_version
       where c.id = comm_a) = '10');

  begin
    update public.commissions set rule_id = null where id = comm_a;
    err := 'NO ERROR — RULE ID CLEARED WITH A VERSION STILL SET';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('commission', 'rule_id and rule_version must be set or absent together',
     '23514', err, err = '23514');

  begin
    delete from public.agent_commission_rules where id = rule_a;
    err := 'NO ERROR — A RULE THAT PAID SOMEBODY WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('commission', 'a rule a commission was calculated under cannot be deleted',
     '23503', err, err = '23503');

  ---------------------------------------------------------------------------
  -- 4 · Payout batches: a commission is paid once
  ---------------------------------------------------------------------------
  insert into public.agent_payout_batches
    (organization_id, agent_user_id, reference, created_by)
  values (org_a, agent_1, 'PAYOUT-2027-08', user_a)
  returning id into batch_a;

  begin
    insert into public.agent_payout_batches
      (organization_id, agent_user_id, reference, created_by)
    values (org_a, agent_1, 'PAYOUT-2027-08', user_a);
    err := 'NO ERROR — TWO BATCHES SHARED A REFERENCE';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('payout', 'a batch reference is unique per organization', '23505', err, err = '23505');

  insert into public.agent_payout_batch_lines
    (batch_id, commission_id, organization_id, amount_agorot)
  values (batch_a, comm_a, org_a, 50000);

  insert into agent_results (area, name, expected, actual, passed) values
    ('payout', 'the batch total is the sum of its lines', '50000',
     (select total_agorot::text from public.agent_payout_batches where id = batch_a),
     (select total_agorot from public.agent_payout_batches where id = batch_a) = 50000);

  -- The guarantee. A commission belongs to one batch and never to two.
  insert into public.agent_payout_batches
    (organization_id, agent_user_id, reference, created_by)
  values (org_a, agent_1, 'PAYOUT-2027-09', user_a);

  begin
    insert into public.agent_payout_batch_lines
      (batch_id, commission_id, organization_id, amount_agorot)
    select b.id, comm_a, org_a, 50000
      from public.agent_payout_batches b
     where b.organization_id = org_a and b.reference = 'PAYOUT-2027-09';
    err := 'NO ERROR — A COMMISSION WAS PUT IN TWO BATCHES';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('payout', 'a commission cannot be paid in two batches', '23505', err, err = '23505');

  ---------------------------------------------------------------------------
  -- 5 · holds.extension_count
  ---------------------------------------------------------------------------
  insert into agent_results (area, name, expected, actual, passed) values
    ('hold', 'holds carries extension_count and created_at', '2',
     (select count(*)::text from information_schema.columns
       where table_schema='public' and table_name='holds'
         and column_name in ('extension_count','created_at')),
     (select count(*) from information_schema.columns
       where table_schema='public' and table_name='holds'
         and column_name in ('extension_count','created_at')) = 2);

  insert into public.holds
    (organization_id, property_id, unit_id, check_in, check_out, reason,
     held_by_user_id, expires_at, created_by)
  values (org_a, prop_a, unit_a, '2027-10-01', '2027-10-03', 'agent_quote',
          agent_1, now() + interval '30 minutes', user_a);

  insert into agent_results (area, name, expected, actual, passed) values
    ('hold', 'a new hold starts with no extensions', '0',
     (select extension_count::text from public.holds
       where unit_id = unit_a and check_in = '2027-10-01'),
     (select extension_count from public.holds
       where unit_id = unit_a and check_in = '2027-10-01') = 0);

  begin
    update public.holds set extension_count = -1
     where unit_id = unit_a and check_in = '2027-10-01';
    err := 'NO ERROR — A NEGATIVE EXTENSION COUNT';
  exception when others then err := sqlstate;
  end;
  insert into agent_results (area, name, expected, actual, passed) values
    ('hold', 'a negative extension count is refused', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 6 · The agencies policy — BOTH directions, and both controls
  ---------------------------------------------------------------------------
  -- (a) An agent of agency A. They must see their own agency and no other.
  perform set_config('request.jwt.claims',
    json_build_object('sub', agent_1::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agencies where id = agency_a;
    select count(*) into n_other from public.agencies where id in (agency_b, agency_d);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('agency', 'a member of agency A cannot read agency B or D', 'other=0',
     'own=' || n_all || ' other=' || n_other || coalesce(' err=' || err, ''), n_other = 0);
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'a member of agency A CAN read agency A', 'own=1',
     'own=' || n_all, n_all = 1);

  -- (b) An organization that signed with agency A. It must see agency A and
  -- must not see the agency that sells for its rival, nor the unrelated one.
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agencies where id = agency_a;
    select count(*) into n_other from public.agencies where id in (agency_b, agency_d);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('agency', 'an organization cannot read the agency that sells for its rival',
     'other=0', 'own=' || n_all || ' other=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0);
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'an organization with a live agreement CAN read that agency', 'own=1',
     'own=' || n_all, n_all = 1);

  -- (c) An organization that signed with nobody. It must see no agency at all.
  -- This is the assertion the whole hand-written policy stands on.
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_c::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.agencies;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('agency', 'an organization with no agreement sees no agency at all', '0',
     n_all::text || coalesce(' err=' || err, ''), n_all = 0);

  -- (d) A draft agreement is not a relationship: it must not reveal the agency.
  insert into public.agency_agreements
    (agency_id, organization_id, status, base, active_from, rule)
  values (agency_d, org_c, 'draft', 'whole_booking', current_date,
          '{"kind":"percentage","percent":5}'::jsonb);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.agencies where id = agency_d;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('agency', 'a draft agreement does not reveal the agency', '0',
     n_all::text || coalesce(' err=' || err, ''), n_all = 0);

  -- And the control for it: signing the same agreement does reveal it. Without
  -- this, the zero above could mean the policy refuses everybody.
  update public.agency_agreements
     set status = 'active', signed_at = now()
   where agency_id = agency_d and organization_id = org_c;

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.agencies where id = agency_d;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'activating the agreement reveals the agency', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  -- A terminated agreement keeps the agency nameable: money outlives access.
  update public.agency_agreements
     set status = 'terminated', terminated_at = now()
   where agency_id = agency_d and organization_id = org_c;

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.agencies where id = agency_d;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('agency', 'a terminated agreement still lets the payer be named', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  -- Editing an agency belongs to the agency, not to a business that uses it.
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    update public.agencies set name = 'HACKED' where id = agency_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('agency', 'a customer of an agency cannot rename it', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  perform set_config('request.jwt.claims',
    json_build_object('sub', agent_1::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    update public.agencies set note = 'ok' where id = agency_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'a manager of the agency CAN edit it', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- Agency membership lists follow the same two-sided rule.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agency_memberships where agency_id = agency_a;
    select count(*) into n_other from public.agency_memberships where agency_id = agency_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('agency', 'agency A sees its own membership list and not B''s', 'other=0 own=1',
     'own=' || n_all || ' other=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all = 1);

  ---------------------------------------------------------------------------
  -- 7 · Tenant isolation on the organization-shaped tables
  ---------------------------------------------------------------------------
  -- Give organization B something of its own to be hidden.
  insert into public.agent_commission_rules
    (organization_id, agent_user_id, name, rule, created_by)
  values (org_b, agent_2, 'B rule', '{"kind":"percentage","percent":15}'::jsonb, user_b);

  insert into public.agent_payout_batches
    (organization_id, agent_user_id, reference, created_by)
  values (org_b, agent_2, 'B-PAYOUT-1', user_b);

  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agent_commission_rules;
    select count(*) into n_other from public.agent_commission_rules where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('select', 'agent_commission_rules: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agent_commission_rule_versions;
    select count(*) into n_other from public.agent_commission_rule_versions where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('select', 'agent_commission_rule_versions: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agent_payout_batches;
    select count(*) into n_other from public.agent_payout_batches where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('select', 'agent_payout_batches: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agent_payout_batch_lines;
    select count(*) into n_other from public.agent_payout_batch_lines where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('select', 'agent_payout_batch_lines: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.agency_agreements;
    select count(*) into n_other from public.agency_agreements where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('select', 'agency_agreements: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  -- INSERT into organization B
  begin
    execute 'set local role authenticated';
    insert into public.agent_commission_rules (organization_id, rule)
      values (org_b, '{"kind":"percentage","percent":99}'::jsonb);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('insert', 'agent_commission_rules INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.agent_payout_batches (organization_id, agent_user_id, reference)
      values (org_b, agent_2, 'SMUGGLED');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('insert', 'agent_payout_batches INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.agency_agreements (agency_id, organization_id, rule)
      values (agency_a, org_b, '{"kind":"none"}'::jsonb);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('insert', 'agency_agreements INSERT into org B refused', '42501', err, err = '42501');

  -- The rule history is written by trigger; nobody may forge it.
  begin
    execute 'set local role authenticated';
    insert into public.agent_commission_rule_versions
      (rule_id, version, organization_id, rule, base, eligibility_conditions, priority)
      values (rule_a, 99, org_a, '{"kind":"percentage","percent":50}'::jsonb,
              'whole_booking', '{}', 0);
    err := 'NO ERROR — HISTORY WAS FORGED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('insert', 'agent_commission_rule_versions INSERT refused outright',
     '42501', err, err = '42501');

  -- UPDATE and DELETE of B's rows
  begin
    execute 'set local role authenticated';
    update public.agent_commission_rules set name = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('update', 'agent_commission_rules UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.agent_payout_batches set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('update', 'agent_payout_batches UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.agency_agreements set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('update', 'agency_agreements UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.agent_commission_rules where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('delete', 'agent_commission_rules DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.agent_payout_batch_lines where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('delete', 'agent_payout_batch_lines DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  ---------------------------------------------------------------------------
  -- 8 · Positive controls
  ---------------------------------------------------------------------------
  -- Without these the whole of section 7 proves nothing.
  begin
    execute 'set local role authenticated';
    insert into public.agent_commission_rules
      (organization_id, name, rule, created_by)
      values (org_a, 'Own organization rule', '{"kind":"fixed","amountAgorot":25000}'::jsonb, user_a);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a commission rule in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.agent_payout_batches
      (organization_id, agent_user_id, reference, created_by)
      values (org_a, agent_1, 'PAYOUT-CONTROL', user_a);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a payout batch in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.agency_agreements
      (agency_id, organization_id, status, base, active_from, rule, created_by)
      values (agency_d, org_a, 'draft', 'whole_booking', current_date,
              '{"kind":"percentage","percent":7}'::jsonb, user_a);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'A CAN sign an agreement in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.agent_commission_rules set note = 'ok' where id = rule_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own commission rule', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.agent_payout_batch_lines
     where organization_id = org_a and commission_id = comm_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into agent_results (area, name, expected, actual, passed) values
    ('control', 'A CAN take a line off an unpaid batch of its own', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into agent_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from agent_results;

select seq, area, name, expected, actual, passed from agent_results order by seq;

rollback;
