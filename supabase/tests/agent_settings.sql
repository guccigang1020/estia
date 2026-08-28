-- ============================================================================
-- agent_settings.sql — ESTIA · proof for 0018, 0019 and 0020
--
-- What this is
--   The evidence for three things that were each a silent wrong answer rather
--   than a loud failure:
--
--     · `public.commission_base` no longer describing `COMMISSION_BASES`, so a
--       base the agent domain supports could not be stored and a stored one
--       could not be read;
--     · `agent_organization_settings` and `agent_invitations` not existing, so
--       the whole `AgentSettingsStore` port was unimplementable;
--     · `findUserByPhone` having no normalised column and no way to ask a
--       global question, so every answer was "no such user" — which makes
--       identity.ts create a second identity for a person who already has one.
--
--   The last section is the one to read carefully. A lookup that spans every
--   tenant is the most dangerous thing in this file, so it is proved in five
--   directions: that it answers, that it refuses, that what it returns is one
--   opaque id, that the id unlocks nothing, and that it cannot be swept.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/agent_settings.sql
--
--   One transaction, ending in ROLLBACK. One row per assertion plus a TOTAL.
--
-- Depends on
--   0001 … 0020, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table settings_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a    constant uuid := '1a1a1a1a-8888-4111-8111-111111111111';
  org_b    constant uuid := '2b2b2b2b-8888-4222-8222-222222222222';
  owner_a  constant uuid := 'a0a0a0a0-8888-4000-8000-00000000000a';
  owner_b  constant uuid := 'b0b0b0b0-8888-4000-8000-00000000000b';
  -- A member of organization A holding no role at all. The control that shows
  -- the phone lookup is behind a grant and not merely behind a login.
  plain_a  constant uuid := 'c0c0c0c0-8888-4000-8000-00000000000c';
  -- The agent. Belongs to organization B only, so to organization A they are
  -- exactly what findUserByPhone exists to find: a stranger who is already an
  -- ESTIA user.
  agent_b  constant uuid := 'd0d0d0d0-8888-4000-8000-00000000000d';

  mem_owner_a constant uuid := 'e0e0e0e0-8888-4000-8000-00000000000a';
  mem_owner_b constant uuid := 'e0e0e0e0-8888-4000-8000-00000000000b';
  mem_plain_a constant uuid := 'e0e0e0e0-8888-4000-8000-00000000000c';
  mem_agent_b constant uuid := 'e0e0e0e0-8888-4000-8000-00000000000d';

  agent_phone constant text := '050-990-4242';
  agent_e164  constant text := '+972509904242';

  owner_role uuid;
  prop_a     uuid;
  prop_b     uuid;
  set_a      uuid;
  set_b      uuid;
  inv_a      uuid;

  found      uuid;
  n_rows     bigint;
  n_all      bigint;
  n_hits     bigint;
  err        text;
  got        text[];
  want       text[];
  txt        text;
begin
  ---------------------------------------------------------------------------
  -- Fixture
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (owner_a, 'set-owner-a@estia.test'),
    (owner_b, 'set-owner-b@estia.test'),
    (plain_a, 'set-plain-a@estia.test'),
    (agent_b, 'set-agent-b@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'settings-org-a', 'Settings Organization A'),
    (org_b, 'settings-org-b', 'Settings Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_owner_a, owner_a, org_a, 'active', now()),
    (mem_owner_b, owner_b, org_b, 'active', now()),
    (mem_plain_a, plain_a, org_a, 'active', now()),
    (mem_agent_b, agent_b, org_b, 'active', now());

  -- plain_a deliberately gets no role: an active member holding nothing.
  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_owner_a, org_a, owner_role),
    (mem_owner_b, org_b, owner_role),
    (mem_agent_b, org_b, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_owner_a, org_a, 'all_organization'),
    (mem_owner_b, org_b, 'all_organization'),
    (mem_plain_a, org_a, 'all_organization'),
    (mem_agent_b, org_b, 'all_organization');

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'set-villa-a', 'Settings Villa A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'set-villa-b', 'Settings Villa B', 'active') returning id into prop_b;

  -- The number that is the identity key. Written as a person would type it,
  -- normalised by the generated column.
  update public.user_profiles set phone = agent_phone where id = agent_b;

  ---------------------------------------------------------------------------
  -- 1 · 0018 — the enum now describes the code
  ---------------------------------------------------------------------------
  got  := public.commission_base_members();
  want := array['accommodation_only','stay_total','gross_revenue','net_revenue',
                'net_of_direct_costs','net_contribution'];
  insert into settings_results (area, name, expected, actual, passed) values
    ('enum', 'commission_base is exactly COMMISSION_BASES from src/lib/contracts/states.ts',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  insert into settings_results (area, name, expected, actual, passed) values
    ('enum', 'whole_booking is no longer a member', '0',
     (select count(*)::text from unnest(public.commission_base_members()) m where m = 'whole_booking'),
     (select count(*) from unnest(public.commission_base_members()) m where m = 'whole_booking') = 0);

  -- The read-side half of the drift: a stored whole_booking was a value no
  -- TypeScript union accepts. It can no longer be written at all.
  begin
    perform 'whole_booking'::public.commission_base;
    err := 'NO ERROR — whole_booking IS STILL WRITABLE';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('enum', 'whole_booking is refused as a value', '22P02', err, err = '22P02');

  -- The write-side half: stay_total is what agents/commission.ts explicitly
  -- supports and could not store. Positive control, on the real column.
  begin
    insert into public.agent_commission_rules
      (organization_id, agent_user_id, name, rule, base, priority, created_by)
    values (org_a, agent_b, 'Stay total 10%', '{"kind":"percentage","percent":10}'::jsonb,
            'stay_total', 10, owner_a);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('enum', 'a commission rule CAN now be stored on stay_total', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    insert into public.agent_commission_rules
      (organization_id, agent_user_id, name, rule, base, priority, created_by)
    values (org_a, agent_b, 'Net contribution 5%', '{"kind":"percentage","percent":5}'::jsonb,
            'net_contribution', 20, owner_a);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('enum', 'a commission rule CAN be stored on net_contribution', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- The defaults moved with the members. A default still spelled
  -- whole_booking would have been the same drift wearing a new type.
  select string_agg(c.relname || '=' || pg_get_expr(d.adbin, d.adrelid), ', ' order by c.relname)
    into txt
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.atttypid = 'public.commission_base'::regtype and a.attnum > 0 and not a.attisdropped;
  insert into settings_results (area, name, expected, actual, passed) values
    ('enum', 'every commission_base default is stay_total', '3 defaults, all stay_total',
     txt, txt = 'agency_agreements=''stay_total''::commission_base, ' ||
                'agent_commission_rules=''stay_total''::commission_base, ' ||
                'commissions=''stay_total''::commission_base');

  insert into settings_results (area, name, expected, actual, passed) values
    ('enum', 'the old type was dropped rather than left behind', '0',
     (select count(*)::text from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typname = 'commission_base_v1'),
     (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typname = 'commission_base_v1') = 0);

  ---------------------------------------------------------------------------
  -- 2 · agent_organization_settings — the shape the union promises
  ---------------------------------------------------------------------------
  -- The architecture forbids a type column, and src/lib/agents/types.ts has a
  -- compile-time gate saying so. This is the same gate at the floor.
  insert into settings_results (area, name, expected, actual, passed) values
    ('contract', 'no type, preset or model column exists', '0',
     (select count(*)::text from information_schema.columns
       where table_schema = 'public' and table_name = 'agent_organization_settings'
         and column_name in ('type', 'preset', 'model', 'agent_type')),
     (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'agent_organization_settings'
         and column_name in ('type', 'preset', 'model', 'agent_type')) = 0);

  -- The cross-ladder rule, refused. A price the calendar rung does not reach
  -- is an agent shown the rate the owner actually receives.
  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, access_calendar, access_price, created_by)
    values (org_b, agent_b, mem_agent_b, 'availability', 'net', owner_b);
    err := 'NO ERROR — A NET RATE BELOW THE PRICE RUNG';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'a price level below the price rung is refused', '23514', err, err = '23514');

  -- …and required from that rung upward, which is the other half of the same
  -- rule and the half a one-sided constraint would have missed.
  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, access_calendar, access_price, created_by)
    values (org_b, agent_b, mem_agent_b, 'availability_price', 'none', owner_b);
    err := 'NO ERROR — NO PRICE AT THE PRICE RUNG';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'price = none at or above the price rung is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id,
       access_calendar, access_price, access_guest_data, created_by)
    values (org_b, agent_b, mem_agent_b, 'availability_hold', 'agent', 'email', owner_b);
    err := 'NO ERROR — GUEST DATA BELOW THE BOOKING RUNG';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'guest data below the booking rung is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id,
       access_calendar, access_price, access_amendments, created_by)
    values (org_b, agent_b, mem_agent_b, 'availability_hold', 'agent',
            array['dates']::public.agent_amendment[], owner_b);
    err := 'NO ERROR — AMENDMENTS BELOW THE BOOKING RUNG';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'amendments below the booking rung are refused', '23514', err, err = '23514');

  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id,
       access_calendar, access_price, access_cancellation_kind, created_by)
    values (org_b, agent_b, mem_agent_b, 'availability_booking', 'agent',
            'hours_before_arrival', owner_b);
    err := 'NO ERROR — AN HOURS POLICY WITH NO HOURS';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'an hours-before-arrival policy with no hours is refused',
     '23514', err, err = '23514');

  -- The inventory union: each variant carries exactly the ids it needs.
  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, inventory_kind, created_by)
    values (org_b, agent_b, mem_agent_b, 'properties', owner_b);
    err := 'NO ERROR — A PROPERTIES SCOPE NAMING NO PROPERTIES';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'a properties scope with an empty list is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, inventory_kind,
       inventory_property_ids, inventory_unit_ids, created_by)
    values (org_b, agent_b, mem_agent_b, 'all_properties',
            array[prop_b], '{}'::uuid[], owner_b);
    err := 'NO ERROR — all_properties CARRYING A PROPERTY LIST';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'all_properties carrying a property list is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, discount_max_percent, created_by)
    values (org_b, agent_b, mem_agent_b, 100.001, owner_b);
    err := 'NO ERROR — A DISCOUNT CAP ABOVE 100%';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'a discount cap above 100 per cent is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id,
       hold_default_minutes, hold_max_minutes, created_by)
    values (org_b, agent_b, mem_agent_b, 180, 120, owner_b);
    err := 'NO ERROR — A DEFAULT WINDOW LONGER THAN THE CEILING';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'a default hold window above the ceiling is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, reputation_score, created_by)
    values (org_b, agent_b, mem_agent_b, 101, owner_b);
    err := 'NO ERROR — A REPUTATION SCORE ABOVE 100';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'a reputation score above 100 is refused', '23514', err, err = '23514');

  -- The terms cannot be hung on somebody else's membership, or on one in
  -- another tenant. The composite key is what makes that a database fact.
  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, created_by)
    values (org_b, agent_b, mem_owner_a, owner_b);
    err := 'NO ERROR — TERMS ATTACHED TO ANOTHER TENANT MEMBERSHIP';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('contract', 'terms cannot name a membership from another organization',
     '23503', err, err = '23503');

  -- The coherent row. Everything above refused; this is what passes.
  insert into public.agent_organization_settings
    (organization_id, agent_user_id, membership_id,
     access_calendar, access_price, access_guest_data, access_amendments,
     access_cancellation_kind, access_cancellation_hours, access_payment_link,
     inventory_kind, inventory_property_ids,
     discount_max_percent, discount_max_agorot,
     hold_max_concurrent, hold_max_per_day, hold_max_extensions,
     hold_default_minutes, hold_max_minutes, reputation_score, created_by)
  values
    (org_b, agent_b, mem_agent_b,
     'availability_booking', 'net', 'email',
     array['dates','extras']::public.agent_amendment[],
     'hours_before_arrival', 48, true,
     'properties', array[prop_b],
     7.500, 50000,
     5, 20, 2, 30, 120, 60, owner_b)
  returning id into set_b;

  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'a fully coherent booking-rung agent stores', '1',
     (select count(*)::text from public.agent_organization_settings where id = set_b),
     (select count(*) from public.agent_organization_settings where id = set_b) = 1);

  -- numeric, not float. 7.5 has to survive the round trip exactly, because
  -- discounts.ts compares against it.
  insert into settings_results (area, name, expected, actual, passed) values
    ('ladder', 'a fractional discount cap round-trips exactly', 'true',
     (select (discount_max_percent = 7.5)::text from public.agent_organization_settings where id = set_b),
     (select discount_max_percent = 7.5 from public.agent_organization_settings where id = set_b));

  -- One set of terms per agent per organization.
  begin
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, created_by)
    values (org_b, agent_b, mem_agent_b, owner_b);
    err := 'NO ERROR — TWO SETS OF TERMS FOR ONE AGENT';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('contract', 'an agent has one set of terms per organization', '23505', err, err = '23505');

  -- The status is read from the membership and is not a column here. Two
  -- copies of "is this agent active" disagree the first day somebody is
  -- suspended.
  insert into settings_results (area, name, expected, actual, passed) values
    ('contract', 'settings carry no status column of their own', '0',
     (select count(*)::text from information_schema.columns
       where table_schema = 'public' and table_name = 'agent_organization_settings'
         and column_name = 'status'),
     (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'agent_organization_settings'
         and column_name = 'status') = 0);

  insert into settings_results (area, name, expected, actual, passed) values
    ('contract', 'the membership status is reachable through the terms', 'active',
     (select m.status::text from public.agent_organization_settings s
        join public.memberships m on m.id = s.membership_id where s.id = set_b),
     (select m.status from public.agent_organization_settings s
        join public.memberships m on m.id = s.membership_id where s.id = set_b) = 'active');

  -- The terms for organization A's own agent, so the isolation section below
  -- has something on each side.
  insert into public.agent_organization_settings
    (organization_id, agent_user_id, membership_id, created_by)
  values (org_a, plain_a, mem_plain_a, owner_a)
  returning id into set_a;

  ---------------------------------------------------------------------------
  -- 3 · agent_invitations
  ---------------------------------------------------------------------------
  insert into public.agent_invitations
    (organization_id, phone, display_name, invited_by_user_id, expires_at,
     access_calendar, access_price, created_by)
  values (org_a, '050-990-5151', 'Invited Agent', owner_a, now() + interval '7 days',
          'availability_price', 'agent', owner_a)
  returning id into inv_a;

  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'a typed number is stored normalised as the identity key',
     '+972509905151',
     (select phone_e164 from public.agent_invitations where id = inv_a),
     (select phone_e164 from public.agent_invitations where id = inv_a) = '+972509905151');

  begin
    insert into public.agent_invitations
      (organization_id, phone, invited_by_user_id, expires_at, created_by)
    values (org_a, 'not a number', owner_a, now() + interval '7 days', owner_a);
    err := 'NO ERROR — AN INVITATION TO A NUMBER THAT IS NOT ONE';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'a number that cannot normalise is refused', '23514', err, err = '23514');

  begin
    insert into public.agent_invitations
      (organization_id, phone, invited_by_user_id, expires_at, created_by)
    values (org_a, '+972-50-990-5151', owner_a, now() + interval '7 days', owner_a);
    err := 'NO ERROR — TWO LIVE INVITATIONS TO ONE NUMBER';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'a second live invitation to the same number, differently spelled, is refused',
     '23505', err, err = '23505');

  -- The same number in a different organization is a different relationship
  -- and must be allowed: the whole premise is one person selling for several
  -- competing businesses. Positive control for the constraint above.
  begin
    insert into public.agent_invitations
      (organization_id, phone, invited_by_user_id, expires_at, created_by)
    values (org_b, '050-990-5151', owner_b, now() + interval '7 days', owner_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'the same number CAN be invited by a second organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    update public.agent_invitations set status = 'accepted' where id = inv_a;
    err := 'NO ERROR — ACCEPTED WITH NO MOMENT OF ACCEPTANCE';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'accepted without an accepted_at is refused', '23514', err, err = '23514');

  begin
    update public.agent_invitations set invited_by_user_id = owner_b where id = inv_a;
    err := 'NO ERROR — THE INVITER WAS REWRITTEN';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'who invited an outsider cannot be rewritten', '42501', err, err = '42501');

  begin
    update public.agent_invitations set phone = '050-990-9999' where id = inv_a;
    err := 'NO ERROR — AN OUTSTANDING OFFER WAS MOVED TO ANOTHER NUMBER';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'an invitation cannot be moved to a different number',
     '42501', err, err = '42501');

  -- Positive control for the two refusals above: an ordinary revocation, which
  -- is what the UPDATE policy exists to allow.
  begin
    update public.agent_invitations
       set status = 'revoked', revoked_at = now(), revoked_by = owner_a
     where id = inv_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('invitation', 'an invitation CAN still be revoked', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  ---------------------------------------------------------------------------
  -- 4 · Tenant isolation, with positive controls on every claim
  ---------------------------------------------------------------------------
  -- Organization B's owner, looking at organization A.
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_b::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.agent_organization_settings
      where organization_id = org_a;
    select count(*) into n_all from public.agent_organization_settings
      where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1; n_all := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot read A''s agent terms', 'other=0',
     'other=' || n_rows || coalesce(' err=' || err, ''), n_rows = 0);
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'B CAN read its own agent terms', 'own=1',
     'own=' || n_all, n_all = 1);

  begin
    execute 'set local role authenticated';
    update public.agent_organization_settings
       set internal_note = 'tampered' where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot edit A''s agent terms', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.agent_organization_settings
       set internal_note = 'ok' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'B CAN edit its own agent terms', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- The INSERT claim is written with VALUES, never INSERT … SELECT from a
  -- table row level security filters: a filtered source touches zero rows and
  -- proves the reader was filtered, not that the writer was refused.
  begin
    execute 'set local role authenticated';
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, created_by)
    values (org_a, owner_a, mem_owner_a, owner_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot create agent terms inside A', '42501',
     n_rows::text || coalesce(' err=' || err, ''), err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.agent_organization_settings
      (organization_id, agent_user_id, membership_id, created_by)
    values (org_b, owner_b, mem_owner_b, owner_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'B CAN create agent terms inside its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.agent_invitations where organization_id = org_a;
    select count(*) into n_all  from public.agent_invitations where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1; n_all := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot read the numbers A is recruiting', 'other=0',
     'other=' || n_rows || coalesce(' err=' || err, ''), n_rows = 0);
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'B CAN read its own outstanding invitations', 'own=1',
     'own=' || n_all, n_all = 1);

  begin
    execute 'set local role authenticated';
    insert into public.agent_invitations
      (organization_id, phone, invited_by_user_id, expires_at, created_by)
    values (org_a, '050-990-7777', owner_b, now() + interval '7 days', owner_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot invite an agent into A', '42501',
     n_rows::text || coalesce(' err=' || err, ''), err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.agent_invitations
      (organization_id, phone, invited_by_user_id, expires_at, created_by)
    values (org_b, '050-990-7777', owner_b, now() + interval '7 days', owner_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'B CAN invite an agent into its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- An agent may read their own terms — it is their own discount cap and hold
  -- allowance — and may not write them, or they would set their own ceiling.
  perform set_config('request.jwt.claims',
    json_build_object('sub', agent_b::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.agent_organization_settings where id = set_b;
    err := null;
  exception when others then err := sqlstate; n_all := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'an agent CAN read their own terms', 'own=1',
     'own=' || n_all || coalesce(' err=' || err, ''), n_all = 1);

  -- A member of A holding no role at all. The read policy is a grant, not a
  -- consequence of membership.
  perform set_config('request.jwt.claims',
    json_build_object('sub', plain_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.agent_invitations where organization_id = org_a;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('isolation', 'a member of A with no grant cannot read A''s invitations', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  ---------------------------------------------------------------------------
  -- 5 · find_user_id_by_phone — the lookup that spans every tenant
  ---------------------------------------------------------------------------
  -- (a) The signature. It returns a scalar uuid, and there is exactly one of
  --     it: a second overload returning a row would be the leak this design
  --     exists to prevent, arriving later and unnoticed.
  select count(*) into n_all
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'find_user_id_by_phone';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'exactly one find_user_id_by_phone exists', '1', n_all::text, n_all = 1);

  select pg_get_function_result(p.oid) into txt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'find_user_id_by_phone';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'it returns a bare uuid and nothing else', 'uuid', txt, txt = 'uuid');

  -- Not a name, not an email, not a set. Stated as three separate assertions
  -- because each is a different way the same mistake could be made.
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'it is not a set-returning function', 'false',
     (select p.proretset::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'find_user_id_by_phone'),
     (select p.proretset from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'find_user_id_by_phone') = false);

  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'it has no OUT parameters carrying a second value', '0',
     ((select coalesce(array_length(p.proallargtypes, 1), 1)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'find_user_id_by_phone') - 1)::text,
     (select coalesce(array_length(p.proallargtypes, 1), 1) - 1
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'find_user_id_by_phone') = 0);

  -- (b) anon must not reach it. REVOKE FROM PUBLIC is not enough on Supabase,
  --     and an unauthenticated phone oracle is the worst version of this bug.
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'anon cannot execute the lookup', 'false',
     has_function_privilege('anon', 'public.find_user_id_by_phone(text)', 'EXECUTE')::text,
     has_function_privilege('anon', 'public.find_user_id_by_phone(text)', 'EXECUTE') = false);

  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'authenticated CAN execute the lookup', 'true',
     has_function_privilege('authenticated', 'public.find_user_id_by_phone(text)', 'EXECUTE')::text,
     has_function_privilege('authenticated', 'public.find_user_id_by_phone(text)', 'EXECUTE') = true);

  -- (c) It answers. Organization A's owner asks about a number belonging to a
  --     person who is a member of organization B only — the exact case that
  --     used to return nothing and send identity.ts down invite_new_user.
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select public.find_user_id_by_phone(agent_e164) into found;
    err := null;
  exception when others then err := sqlstate; found := null;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'an inviter CAN find the user behind a number in another tenant',
     agent_b::text, coalesce(found::text, 'null') || coalesce(' err=' || err, ''),
     found = agent_b);

  -- …and does so whatever spelling the owner typed, which is the entire point
  -- of normalising on both sides.
  begin
    execute 'set local role authenticated';
    select public.find_user_id_by_phone('0509904242') into found;
    err := null;
  exception when others then err := sqlstate; found := null;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'the same person is found from a differently spelled number',
     agent_b::text, coalesce(found::text, 'null'), found = agent_b);

  -- (d) The id unlocks nothing. This is the assertion the whole design rests
  --     on: the caller now holds a stranger's user id and every table it could
  --     name is still behind row level security evaluated as them.
  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.user_profiles where id = agent_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'the returned id reveals no profile — no name, no phone, no email', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.memberships where user_id = agent_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'the returned id reveals no membership — not which businesses they sell for',
     '0', n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.agent_organization_settings
      where agent_user_id = agent_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'the returned id reveals no terms — not a rival''s commission or cap',
     '0', n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- Positive control for the three above: the same three reads about a person
  -- the caller actually shares an organization with return rows. Without it,
  -- three zeroes would be equally consistent with a broken fixture.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.user_profiles where id = plain_a;
    err := null;
  exception when others then err := sqlstate; n_all := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'the same caller CAN read the profile of a colleague', 'own=1',
     'own=' || n_all || coalesce(' err=' || err, ''), n_all = 1);

  -- (e) It cannot be swept. A partial number, a wildcard and an empty string
  --     all normalise to something that matches nothing; there is no prefix,
  --     pattern or range form of this function to reach for.
  begin
    execute 'set local role authenticated';
    select count(*) into n_hits from (
      select public.find_user_id_by_phone(v) as hit
      from (values ('+9725'), ('05099'), ('%'), ('+972509904%'), (''), ('   '),
                   ('+972509904243'), ('+972509904241')) as probes(v)
    ) x where x.hit is not null;
    err := null;
  exception when others then err := sqlstate; n_hits := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'prefixes, wildcards, blanks and near misses all find nobody', '0',
     n_hits::text || coalesce(' err=' || err, ''), n_hits = 0);

  -- (f) It is behind a grant. An ordinary member of an organization — active,
  --     signed in, holding no role — gets NULL for a number that exists.
  perform set_config('request.jwt.claims',
    json_build_object('sub', plain_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select public.find_user_id_by_phone(agent_e164) into found;
    err := null;
  exception when others then err := sqlstate; found := null;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'a member with no agent.invite grant gets nothing for a number that exists',
     'null', coalesce(found::text, 'null') || coalesce(' err=' || err, ''), found is null);

  -- Sweeping as that caller finds nothing either, which is what "cannot be
  -- used to enumerate accounts" means for everybody who is not an inviter.
  begin
    execute 'set local role authenticated';
    select count(*) into n_hits from (
      select public.find_user_id_by_phone('+97250990424' || d::text) as hit
      from generate_series(0, 9) d
    ) x where x.hit is not null;
    err := null;
  exception when others then err := sqlstate; n_hits := -1;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'an ungranted caller sweeping ten consecutive numbers finds none', '0',
     n_hits::text || coalesce(' err=' || err, ''), n_hits = 0);

  -- …and a caller who is not signed in at all finds nothing, which is the
  -- state a leaked publishable key would put an attacker in.
  perform set_config('request.jwt.claims', '', true);
  begin
    execute 'set local role authenticated';
    select public.find_user_id_by_phone(agent_e164) into found;
    err := null;
  exception when others then err := sqlstate; found := null;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'a caller with no identity finds nobody', 'null',
     coalesce(found::text, 'null') || coalesce(' err=' || err, ''), found is null);

  -- (g) Your own number always answers, grant or no grant. Harmless, and it is
  --     what lets a person confirm which account a number is attached to.
  perform set_config('request.jwt.claims',
    json_build_object('sub', agent_b::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    select public.find_user_id_by_phone(agent_e164) into found;
    err := null;
  exception when others then err := sqlstate; found := null;
  end;
  execute 'reset role';
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'a person CAN look up their own number', agent_b::text,
     coalesce(found::text, 'null') || coalesce(' err=' || err, ''), found = agent_b);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  ---------------------------------------------------------------------------
  -- 6 · The identity key is unique across the product
  ---------------------------------------------------------------------------
  -- Not per organization. A person is not owned by a tenant, and two rows with
  -- one number are one person entered twice — the failure the whole module
  -- exists to prevent.
  begin
    update public.user_profiles set phone = '+972-50-990-4242' where id = plain_a;
    err := 'NO ERROR — TWO PROFILES SHARE ONE NUMBER';
  exception when others then err := sqlstate;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'two profiles cannot share one number, however it is spelled',
     '23505', err, err = '23505');

  begin
    update public.user_profiles set phone = '050-990-8888' where id = plain_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  insert into settings_results (area, name, expected, actual, passed) values
    ('control', 'a different number CAN be stored on the second profile', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  insert into settings_results (area, name, expected, actual, passed) values
    ('phone', 'the normalised column is generated, not written', 'ALWAYS',
     (select is_generated from information_schema.columns
       where table_schema = 'public' and table_name = 'user_profiles'
         and column_name = 'phone_e164'),
     (select is_generated from information_schema.columns
       where table_schema = 'public' and table_name = 'user_profiles'
         and column_name = 'phone_e164') = 'ALWAYS');
end $$;

insert into settings_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from settings_results;

select seq, area, name, expected, actual, passed from settings_results order by seq;

rollback;
