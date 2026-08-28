-- ============================================================================
-- booking.sql — ESTIA · proof that the accommodation and booking core holds
--
-- What this is
--   The evidence for 0008_accommodation.sql and 0009_booking_core.sql. Four
--   things are under test, and only the third is the kind of thing a schema
--   review would have caught by reading:
--
--     1. The contract. Every enum and every status set is compared against
--        the literal arrays in src/lib/booking/types.ts. These assertions
--        exist to fail: the moment somebody adds a status to the TypeScript
--        file without adding it here, the run goes red and says which one.
--     2. No double booking. Overlaps refused, same-day turnarounds allowed,
--        cancellations and soft deletes giving the dates back, holds blocking,
--        lapsed holds not blocking, and a hold converting into the booking it
--        was keeping the dates for.
--     3. Tenant isolation across every new table, select / insert / update /
--        delete, each with a positive control. A zero-row result proves
--        isolation only when the same statement aimed at the caller own
--        organization affects exactly one row — otherwise a missing GRANT
--        would make the whole file pass while proving nothing.
--     4. Scope. A member scoped to one property cannot see, count or write
--        the other one, which is the rule docs/ARCHITECTURE.md §12 states as
--        law for the agent network.
--
--   Plus the foreign keys 0008 closed, and the phone normalisation that guest
--   deduplication rests on.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/booking.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK. It leaves no rows behind. One result
--   row per assertion plus a TOTAL; `passed = false` anywhere is a defect.
--
-- Depends on
--   0001 … 0009, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table booking_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
) on commit drop;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Three of them, because writing `begin … exception … end` around ninety
-- statements by hand is how a test file acquires a copy-paste bug and starts
-- asserting nothing.

create function pg_temp.note(
  p_area text, p_name text, p_expected text, p_actual text
) returns void language sql as $$
  insert into booking_results (area, name, expected, actual, passed)
  values (p_area, p_name, p_expected, coalesce(p_actual, '<null>'),
          p_expected is not distinct from p_actual);
$$;

create function pg_temp.note_like(
  p_area text, p_name text, p_expected text, p_actual text
) returns void language sql as $$
  insert into booking_results (area, name, expected, actual, passed)
  values (p_area, p_name, p_expected, coalesce(p_actual, '<null>'),
          coalesce(p_actual like p_expected, false));
$$;

-- Runs a statement as the owner and reports either the rows it affected or
-- the SQLSTATE it raised. The exception block is a subtransaction, so a
-- failure rolls back that statement and nothing else.
create function pg_temp.try(stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return 'err:' || sqlstate;
end;
$$;

-- Same, with the message, for the cases where two different constraints share
-- a SQLSTATE and the test has to prove which one fired.
create function pg_temp.try_verbose(stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return 'err:' || sqlstate || ' ' || sqlerrm;
end;
$$;

-- Runs a statement as a real `authenticated` session, with request.jwt.claims
-- set the way GoTrue sets it so auth.uid() returns the given user. Nothing
-- about isolation is asserted against the owner connection, because the owner
-- is exactly the actor row level security does not constrain.
create function pg_temp.try_as(uid uuid, stmt text) returns text language plpgsql as $$
declare n bigint; r text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    execute stmt;
    get diagnostics n = row_count;
    r := 'ok:' || n;
  exception when others then
    r := 'err:' || sqlstate;
  end;
  execute 'reset role';
  return r;
end;
$$;

-- Turns a count into 'true' when it is greater than zero, and passes an error
-- string through untouched — so a policy that raised 42501 shows up as a
-- failure that names the SQLSTATE rather than aborting the whole run on a cast.
create function pg_temp.gt0(t text) returns text language sql as $$
  select case when t ~ '^[0-9]+$' and t::bigint > 0 then 'true' else t end;
$$;

create function pg_temp.count_as(uid uuid, q text) returns text language plpgsql as $$
declare n bigint; r text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    execute q into n;
    r := n::text;
  exception when others then
    r := 'err:' || sqlstate;
  end;
  execute 'reset role';
  return r;
end;
$$;


do $$
declare
  org_a    constant uuid := 'a0000000-0000-4000-8000-000000000001';
  org_b    constant uuid := 'b0000000-0000-4000-8000-000000000001';
  user_a   constant uuid := 'a0000000-0000-4000-8000-00000000000a';
  user_b   constant uuid := 'b0000000-0000-4000-8000-00000000000b';
  user_g   constant uuid := 'a0000000-0000-4000-8000-00000000000c';
  user_h   constant uuid := 'a0000000-0000-4000-8000-00000000000d';
  mem_a    constant uuid := 'a0000000-0000-4000-8000-0000000000aa';
  mem_b    constant uuid := 'b0000000-0000-4000-8000-0000000000bb';
  mem_g    constant uuid := 'a0000000-0000-4000-8000-0000000000cc';
  mem_h    constant uuid := 'a0000000-0000-4000-8000-0000000000dd';

  prop_a1  constant uuid := 'a1000000-0000-4000-8000-000000000001';
  prop_a2  constant uuid := 'a1000000-0000-4000-8000-000000000002';
  prop_a3  constant uuid := 'a1000000-0000-4000-8000-000000000003';
  prop_b1  constant uuid := 'b1000000-0000-4000-8000-000000000001';
  unit_a1  constant uuid := 'a2000000-0000-4000-8000-000000000001';
  unit_a2  constant uuid := 'a2000000-0000-4000-8000-000000000002';
  unit_b1  constant uuid := 'b2000000-0000-4000-8000-000000000001';
  grp_a1   constant uuid := 'a3000000-0000-4000-8000-000000000001';
  grp_b1   constant uuid := 'b3000000-0000-4000-8000-000000000001';
  team_a   constant uuid := 'a4000000-0000-4000-8000-000000000001';
  team_b   constant uuid := 'b4000000-0000-4000-8000-000000000001';
  guest_a  constant uuid := 'a5000000-0000-4000-8000-000000000001';
  guest_b  constant uuid := 'b5000000-0000-4000-8000-000000000001';
  amen_a   constant uuid := 'a6000000-0000-4000-8000-000000000001';
  amen_b   constant uuid := 'b6000000-0000-4000-8000-000000000001';
  bk1      constant uuid := 'a7000000-0000-4000-8000-000000000001';
  bk_a2    constant uuid := 'a7000000-0000-4000-8000-000000000002';
  bk_b1    constant uuid := 'b7000000-0000-4000-8000-000000000001';
  bk_conv  constant uuid := 'a7000000-0000-4000-8000-000000000003';
  bk_turn  constant uuid := 'a7000000-0000-4000-8000-000000000010';
  hold_x   constant uuid := 'a8000000-0000-4000-8000-000000000001';
  hold_b   constant uuid := 'b8000000-0000-4000-8000-000000000001';

  owner_role uuid;
  wifi       uuid;
  v          text;
  arr        text[];
  n          bigint;

  -- Transcribed from src/lib/booking/types.ts. These literals are the point
  -- of the first section: if the contract moves and the database does not,
  -- one of these comparisons fails and names the difference.
  contract_statuses constant text[] := array[
    'inquiry','quote','option','awaiting_payment','deposit_paid','contract_pending',
    'confirmed','pre_arrival','ready_for_check_in','checked_in','in_house',
    'checkout_pending','checked_out','inspection','deposit_release','completed',
    'review_requested','cancelled','no_show'];
  contract_occupying constant text[] := array[
    'option','awaiting_payment','deposit_paid','contract_pending','confirmed',
    'pre_arrival','ready_for_check_in','checked_in','in_house','checkout_pending'];
  contract_terminal constant text[] := array['completed','cancelled','no_show'];
  contract_sources constant text[] := array[
    'direct_website','direct_manual','agent','agency','airbnb','booking_com',
    'vrbo','other_channel'];
  contract_hold_reasons constant text[] := array[
    'agent_quote','guest_checkout','staff_manual','maintenance_block'];
  contract_price_kinds constant text[] := array[
    'accommodation','extra_guest','addon','cleaning_fee','discount','promotion',
    'tax','deposit','agent_commission'];
begin
  ---------------------------------------------------------------------------
  -- Fixture, written as the owner. Setting up the world is not what is under
  -- test; every isolation assertion below runs as `authenticated`.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
   where code = 'organization_owner' and organization_id is null;
  select id into wifi from public.amenities
   where code = 'wifi' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'booking-a@estia.test'),
    (user_b, 'booking-b@estia.test'),
    (user_g, 'booking-agent@estia.test'),
    (user_h, 'booking-scoped@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'booking-org-a', 'Organization A'),
    (org_b, 'booking-org-b', 'Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now()),
    (mem_g, user_g, org_a, 'active', now()),
    (mem_h, user_h, org_a, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_b, org_b, owner_role),
    (mem_g, org_a, owner_role),
    (mem_h, org_a, owner_role);

  insert into public.properties (id, organization_id, slug, name, status) values
    (prop_a1, org_a, 'villa-one',   'Villa One',   'active'),
    (prop_a2, org_a, 'villa-two',   'Villa Two',   'active'),
    (prop_a3, org_a, 'villa-three', 'Villa Three', 'active'),
    (prop_b1, org_b, 'villa-b',     'Villa B',     'active');

  -- Scopes are inserted after the properties exist, because 0008 now refuses
  -- a scope that names a property that does not.
  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'),
    (mem_b, org_b, 'all_organization');
  insert into public.membership_scopes (membership_id, organization_id, kind, property_ids) values
    (mem_g, org_a, 'properties', array[prop_a1]),
    (mem_h, org_a, 'properties', array[prop_a3]);

  insert into public.unit_groups (id, organization_id, property_id, name) values
    (grp_a1, org_a, prop_a1, 'Doubles'),
    (grp_b1, org_b, prop_b1, 'Doubles');

  insert into public.units
    (id, organization_id, property_id, unit_group_id, code, name, status, base_price_agorot) values
    (unit_a1, org_a, prop_a1, grp_a1, 'A1', 'Cabin A1', 'active', 65000),
    (unit_a2, org_a, prop_a2, null,   'A2', 'Cabin A2', 'active', 72000),
    (unit_b1, org_b, prop_b1, grp_b1, 'B1', 'Cabin B1', 'active', 51000);

  insert into public.teams (id, organization_id, name, kind) values
    (team_a, org_a, 'Housekeeping A', 'housekeeping'),
    (team_b, org_b, 'Housekeeping B', 'housekeeping');

  insert into public.amenities (id, organization_id, code, name) values
    (amen_a, org_a, 'private_dock', 'Private dock'),
    (amen_b, org_b, 'private_dock', 'Private dock');

  insert into public.property_amenities (organization_id, property_id, amenity_id) values
    (org_a, prop_a1, wifi), (org_b, prop_b1, wifi);
  insert into public.unit_amenities (organization_id, property_id, unit_id, amenity_id) values
    (org_a, prop_a1, unit_a1, wifi), (org_b, prop_b1, unit_b1, wifi);

  insert into public.guests (id, organization_id, full_name, phone, tags) values
    (guest_a, org_a, 'דנה כהן',  '050-123-4567', array['returning']),
    (guest_b, org_b, 'Yossi Levi', '052-999-8888', array['vip']);

  -- The stay every overlap test is aimed at: 10–14 March, confirmed.
  insert into public.bookings
    (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status, source)
  values
    (bk1, org_a, prop_a1, unit_a1, guest_a, '2026-03-10', '2026-03-14', 'confirmed', 'direct_manual');

  insert into public.bookings
    (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status, source)
  values
    (bk_a2, org_a, prop_a2, unit_a2, guest_a, '2026-03-10', '2026-03-14', 'confirmed', 'direct_manual');

  insert into public.bookings
    (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status, source)
  values
    (bk_b1, org_b, prop_b1, unit_b1, guest_b, '2026-03-10', '2026-03-14', 'confirmed', 'direct_manual');

  insert into public.booking_price_lines
    (organization_id, property_id, booking_id, kind, label, amount_agorot, quantity)
  values
    (org_a, prop_a1, bk1,   'accommodation', '4 nights', 260000, 4),
    (org_a, prop_a2, bk_a2, 'accommodation', '4 nights', 288000, 4),
    (org_b, prop_b1, bk_b1, 'accommodation', '4 nights', 204000, 4);

  insert into public.holds
    (id, organization_id, property_id, unit_id, check_in, check_out, reason,
     held_by_user_id, expires_at)
  values
    (hold_x, org_a, prop_a1, unit_a1, '2026-06-10', '2026-06-14',
     'agent_quote', user_g, now() + interval '30 minutes'),
    (hold_b, org_b, prop_b1, unit_b1, '2026-06-10', '2026-06-14',
     'agent_quote', user_b, now() + interval '30 minutes');


  ---------------------------------------------------------------------------
  -- 1 · The contract. These assertions exist to fail.
  ---------------------------------------------------------------------------
  select array_agg(e.enumlabel::text order by e.enumsortorder) into arr
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'booking_status' and t.typnamespace = 'public'::regnamespace;
  perform pg_temp.note('contract', 'booking_status enum matches BOOKING_STATUSES, in order',
    array_to_string(contract_statuses, ','), array_to_string(arr, ','));

  select array_agg(e.enumlabel::text order by e.enumsortorder) into arr
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'booking_source' and t.typnamespace = 'public'::regnamespace;
  perform pg_temp.note('contract', 'booking_source enum matches BOOKING_SOURCES, in order',
    array_to_string(contract_sources, ','), array_to_string(arr, ','));

  select array_agg(e.enumlabel::text order by e.enumsortorder) into arr
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'hold_reason' and t.typnamespace = 'public'::regnamespace;
  perform pg_temp.note('contract', 'hold_reason enum matches HOLD_REASONS, in order',
    array_to_string(contract_hold_reasons, ','), array_to_string(arr, ','));

  select array_agg(e.enumlabel::text order by e.enumsortorder) into arr
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'price_line_kind' and t.typnamespace = 'public'::regnamespace;
  perform pg_temp.note('contract', 'price_line_kind enum matches PRICE_LINE_KINDS, in order',
    array_to_string(contract_price_kinds, ','), array_to_string(arr, ','));

  select array_agg(x::text) into arr from unnest(public.occupying_booking_statuses()) x;
  perform pg_temp.note('contract', 'occupying_booking_statuses() matches OCCUPYING_STATUSES',
    array_to_string(contract_occupying, ','), array_to_string(arr, ','));

  select array_agg(x::text) into arr from unnest(public.terminal_booking_statuses()) x;
  perform pg_temp.note('contract', 'terminal_booking_statuses() matches TERMINAL_STATUSES',
    array_to_string(contract_terminal, ','), array_to_string(arr, ','));

  -- Every status is either occupying or it is not, and the two sets plus the
  -- rest have to account for all nineteen. Catches a status added to the enum
  -- and to the contract but forgotten in the occupancy set.
  perform pg_temp.note('contract', 'every enum status is a contract status',
    '19/19',
    (select count(*) from unnest(contract_statuses) c
      where exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                     where t.typname = 'booking_status'
                       and t.typnamespace = 'public'::regnamespace
                       and e.enumlabel = c))::text || '/' || array_length(contract_statuses, 1)::text);


  ---------------------------------------------------------------------------
  -- 2 · No double booking
  ---------------------------------------------------------------------------

  -- The central one. 12–16 March overlaps 10–14 March in the same unit.
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-03-12'', ''2026-03-16'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('exclusion', 'overlapping booking in the same unit is refused',
    'err:23P01', v);

  -- Half-open. One guest leaves on the 14th, the next arrives on the 14th.
  v := pg_temp.try(format(
    'insert into public.bookings (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, %L, ''2026-03-14'', ''2026-03-17'', ''confirmed'')',
    bk_turn, org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('exclusion', 'same-day turnaround is accepted', 'ok:1', v);

  -- ... and the turnaround booking then defends its own dates.
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-03-16'', ''2026-03-18'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('exclusion', 'the turnaround booking blocks its own dates',
    'err:23P01', v);

  -- Same dates, two units. Both stays exist and both hold the calendar: the
  -- constraint is keyed on the unit, not on the property.
  perform pg_temp.note('exclusion', 'the same dates in two different units both hold', '2',
    (select count(*) from public.unit_occupancy o
      where o.during = daterange('2026-03-10', '2026-03-14', '[)')
        and o.unit_id in (unit_a1, unit_a2))::text);

  -- An inquiry does not hold a date; an option does.
  v := pg_temp.try(format(
    'insert into public.bookings (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (''a9000000-0000-4000-8000-000000000001'', %L, %L, %L, %L, ''2026-03-11'', ''2026-03-13'', ''inquiry'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('exclusion', 'a non-occupying status (inquiry) does not block', 'ok:1', v);

  perform pg_temp.note('exclusion', 'the inquiry has no ledger row', '0',
    (select count(*) from public.unit_occupancy
      where booking_id = 'a9000000-0000-4000-8000-000000000001')::text);

  -- Promoting that inquiry to an occupying status now collides.
  v := pg_temp.try(
    'update public.bookings set status = ''option''
      where id = ''a9000000-0000-4000-8000-000000000001''');
  perform pg_temp.note('exclusion', 'promoting an inquiry into an occupying status collides',
    'err:23P01', v);

  -- Moving an existing booking onto occupied dates is refused too. A change of
  -- dates is a change of occupancy, and a constraint that only watched inserts
  -- would be trivial to walk around.
  v := pg_temp.try(format(
    'update public.bookings set check_in = ''2026-03-12'', check_out = ''2026-03-16''
      where id = %L', bk_turn));
  perform pg_temp.note('exclusion', 'moving a booking onto occupied dates is refused',
    'err:23P01', v);

  v := pg_temp.try(format(
    'update public.bookings set check_in = ''2026-03-20'', check_out = ''2026-03-22''
      where id = %L', bk_turn));
  perform pg_temp.note('control', 'moving a booking onto free dates is allowed', 'ok:1', v);
  perform pg_temp.try(format(
    'update public.bookings set check_in = ''2026-03-14'', check_out = ''2026-03-17''
      where id = %L', bk_turn));

  -- Cancelling frees the dates.
  perform pg_temp.try(format(
    'insert into public.bookings (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (''a9000000-0000-4000-8000-000000000002'', %L, %L, %L, %L, ''2026-04-10'', ''2026-04-14'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-04-11'', ''2026-04-13'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('exclusion', 'April stay blocks before cancellation', 'err:23P01', v);

  perform pg_temp.try(
    'update public.bookings set status = ''cancelled'', status_reason = ''guest changed plans''
      where id = ''a9000000-0000-4000-8000-000000000002''');
  perform pg_temp.note('exclusion', 'cancelling removes the ledger row', '0',
    (select count(*) from public.unit_occupancy
      where booking_id = 'a9000000-0000-4000-8000-000000000002')::text);
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-04-11'', ''2026-04-13'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('exclusion', 'a cancelled booking frees its dates', 'ok:1', v);

  -- Soft delete frees the dates too. This is the case that is forgotten.
  perform pg_temp.try(format(
    'insert into public.bookings (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (''a9000000-0000-4000-8000-000000000003'', %L, %L, %L, %L, ''2026-05-10'', ''2026-05-14'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.try(
    'update public.bookings set deleted_at = now()
      where id = ''a9000000-0000-4000-8000-000000000003''');
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-05-11'', ''2026-05-13'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('exclusion', 'a soft-deleted booking frees its dates', 'ok:1', v);


  ---------------------------------------------------------------------------
  -- 3 · Holds
  ---------------------------------------------------------------------------

  perform pg_temp.note('hold', 'a live hold has a ledger row', '1',
    (select count(*) from public.unit_occupancy where hold_id = hold_x)::text);

  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-06-12'', ''2026-06-16'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('hold', 'a live hold blocks an overlapping booking', 'err:23P01', v);

  v := pg_temp.try(format(
    'insert into public.holds (organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
     values (%L, %L, %L, ''2026-06-12'', ''2026-06-16'', ''staff_manual'', %L, now() + interval ''1 hour'')',
    org_a, prop_a1, unit_a1, user_a));
  perform pg_temp.note('hold', 'a live hold blocks an overlapping hold', 'err:23P01', v);

  -- expires_at is NOT NULL: an unbounded hold is not representable.
  v := pg_temp.try(format(
    'insert into public.holds (organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
     values (%L, %L, %L, ''2026-09-10'', ''2026-09-14'', ''staff_manual'', %L, null)',
    org_a, prop_a1, unit_a1, user_a));
  perform pg_temp.note('hold', 'a hold with no expiry is not representable', 'err:23502', v);

  -- A lapsed hold does not block.
  perform pg_temp.try(format(
    'insert into public.holds (id, organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
     values (''aa000000-0000-4000-8000-000000000001'', %L, %L, %L, ''2026-07-10'', ''2026-07-14'', ''guest_checkout'', %L, now() - interval ''1 minute'')',
    org_a, prop_a1, unit_a1, user_a));
  perform pg_temp.note('hold', 'a lapsed hold gets no ledger row', '0',
    (select count(*) from public.unit_occupancy
      where hold_id = 'aa000000-0000-4000-8000-000000000001')::text);
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-07-11'', ''2026-07-13'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('hold', 'an expired hold does not block a booking', 'ok:1', v);

  -- A hold that lapses *after* it was written still stops blocking, because
  -- the next writer clears it. This is expiry without a scheduled job.
  perform pg_temp.try(format(
    'insert into public.holds (id, organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
     values (''aa000000-0000-4000-8000-000000000002'', %L, %L, %L, ''2026-10-10'', ''2026-10-14'', ''guest_checkout'', %L, now() + interval ''5 minutes'')',
    org_a, prop_a1, unit_a1, user_a));
  perform pg_temp.note('hold', 'the second hold is live to begin with', '1',
    (select count(*) from public.unit_occupancy
      where hold_id = 'aa000000-0000-4000-8000-000000000002')::text);
  update public.unit_occupancy set expires_at = now() - interval '1 second'
   where hold_id = 'aa000000-0000-4000-8000-000000000002';
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-10-11'', ''2026-10-13'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('hold', 'a hold that lapsed while sitting there is swept by the next writer',
    'ok:1', v);

  -- Releasing a hold frees its dates.
  perform pg_temp.try(format(
    'insert into public.holds (id, organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
     values (''aa000000-0000-4000-8000-000000000003'', %L, %L, %L, ''2026-11-10'', ''2026-11-14'', ''staff_manual'', %L, now() + interval ''1 hour'')',
    org_a, prop_a1, unit_a1, user_a));
  perform pg_temp.try(format(
    'update public.holds set released_at = now(), released_by = %L
      where id = ''aa000000-0000-4000-8000-000000000003''', user_a));
  v := pg_temp.try(format(
    'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
     values (%L, %L, %L, %L, ''2026-11-11'', ''2026-11-13'', ''confirmed'')',
    org_a, prop_a1, unit_a1, guest_a));
  perform pg_temp.note('hold', 'a released hold frees its dates', 'ok:1', v);

  -- Conversion: the hold turns into the booking it was keeping the dates for.
  perform pg_temp.try(format(
    'insert into public.holds (id, organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
     values (''aa000000-0000-4000-8000-000000000004'', %L, %L, %L, ''2026-08-10'', ''2026-08-14'', ''agent_quote'', %L, now() + interval ''20 minutes'')',
    org_a, prop_a1, unit_a1, user_g));
  v := pg_temp.try(format(
    'insert into public.bookings (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status, source, agent_user_id)
     values (%L, %L, %L, %L, %L, ''2026-08-10'', ''2026-08-14'', ''option'', ''agent'', %L)',
    bk_conv, org_a, prop_a1, unit_a1, guest_a, user_g));
  perform pg_temp.note('hold', 'a booking on the exact dates of a live hold is refused',
    'err:23P01', v);

  perform pg_temp.note('hold', 'naming a conversion target before the booking exists is refused',
    'err:23503',
    pg_temp.try(format('update public.holds set converted_to_booking_id = %L
      where id = ''aa000000-0000-4000-8000-000000000004''', bk_conv)));

  -- The order that works: release the hold, then create the booking. Both in
  -- one transaction, which is what the service layer does.
  perform pg_temp.try(format(
    'update public.holds set released_at = now(), released_by = %L
      where id = ''aa000000-0000-4000-8000-000000000004''', user_g));
  v := pg_temp.try(format(
    'insert into public.bookings (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status, source, agent_user_id)
     values (%L, %L, %L, %L, %L, ''2026-08-10'', ''2026-08-14'', ''option'', ''agent'', %L)',
    bk_conv, org_a, prop_a1, unit_a1, guest_a, user_g));
  perform pg_temp.note('hold', 'a hold converting into a booking works', 'ok:1', v);
  v := pg_temp.try(format(
    'update public.holds set converted_to_booking_id = %L
      where id = ''aa000000-0000-4000-8000-000000000004''', bk_conv));
  perform pg_temp.note('hold', 'the converted hold records the booking it became', 'ok:1', v);
  perform pg_temp.note('hold', 'the booking now owns the dates the hold kept', '1',
    (select count(*) from public.unit_occupancy where booking_id = bk_conv)::text);

  -- The ledger is not writable by anyone but the triggers.
  perform pg_temp.note('hold', 'authenticated cannot delete a ledger row', 'err:42501',
    pg_temp.try_as(user_a, 'delete from public.unit_occupancy'));
  perform pg_temp.note('hold', 'authenticated cannot insert a ledger row', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.unit_occupancy (organization_id, property_id, unit_id, kind, booking_id, during)
       values (%L, %L, %L, ''booking'', %L, daterange(''2027-01-01'', ''2027-01-05''))',
      org_a, prop_a1, unit_a1, bk1)));


  ---------------------------------------------------------------------------
  -- 4 · The total is a sum of lines
  ---------------------------------------------------------------------------
  perform pg_temp.note('money', 'the booking total is the sum of its lines', '260000',
    (select total_agorot from public.bookings where id = bk1)::text);

  perform pg_temp.try(format(
    'insert into public.booking_price_lines (organization_id, property_id, booking_id, kind, label, amount_agorot)
     values (%L, %L, %L, ''cleaning_fee'', ''Cleaning'', 25000)', org_a, prop_a1, bk1));
  perform pg_temp.note('money', 'adding a line moves the total', '285000',
    (select total_agorot from public.bookings where id = bk1)::text);

  perform pg_temp.try(format(
    'insert into public.booking_price_lines (organization_id, property_id, booking_id, kind, label, amount_agorot)
     values (%L, %L, %L, ''discount'', ''Returning guest'', -30000)', org_a, prop_a1, bk1));
  perform pg_temp.note('money', 'a negative discount line keeps the total a plain sum', '255000',
    (select total_agorot from public.bookings where id = bk1)::text);

  perform pg_temp.try(format(
    'update public.bookings set total_agorot = 999999 where id = %L', bk1));
  perform pg_temp.note('money', 'a total typed by a caller is discarded', '255000',
    (select total_agorot from public.bookings where id = bk1)::text);

  perform pg_temp.try(format(
    'delete from public.booking_price_lines where booking_id = %L and kind = ''cleaning_fee''', bk1));
  perform pg_temp.note('money', 'removing a line moves the total back', '230000',
    (select total_agorot from public.bookings where id = bk1)::text);

  perform pg_temp.note('money', 'a positive discount line is refused', 'err:23514',
    pg_temp.try(format(
      'insert into public.booking_price_lines (organization_id, property_id, booking_id, kind, label, amount_agorot)
       values (%L, %L, %L, ''discount'', ''Wrong sign'', 5000)', org_a, prop_a1, bk1)));


  ---------------------------------------------------------------------------
  -- 5 · Status history
  ---------------------------------------------------------------------------
  perform pg_temp.note('history', 'creating a booking records a transition from nothing', '1',
    (select count(*) from public.booking_status_history
      where booking_id = bk1 and from_status is null and to_status = 'confirmed')::text);

  perform pg_temp.try(format(
    'update public.bookings set status = ''checked_in'', status_reason = ''guest arrived early''
      where id = %L', bk1));
  perform pg_temp.note('history', 'a transition is recorded with from, to and why',
    'confirmed>checked_in|guest arrived early',
    (select from_status || '>' || to_status || '|' || coalesce(reason, '')
       from public.booking_status_history
      where booking_id = bk1 and to_status = 'checked_in'));

  perform pg_temp.note('history', 'a write that does not change status records nothing new', '2',
    (select count(*) from public.booking_status_history where booking_id = bk1)::text);

  perform pg_temp.note('history', 'the history refuses UPDATE', 'err:42501',
    pg_temp.try('update public.booking_status_history set reason = ''rewritten'''));
  perform pg_temp.note('history', 'the history refuses DELETE', 'err:42501',
    pg_temp.try('delete from public.booking_status_history'));
  perform pg_temp.note('history', 'no caller is granted INSERT on the history', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.booking_status_history (organization_id, property_id, booking_id, to_status)
       values (%L, %L, %L, ''completed'')', org_a, prop_a1, bk1)));


  ---------------------------------------------------------------------------
  -- 6 · Guests: phone normalisation and deduplication
  ---------------------------------------------------------------------------
  perform pg_temp.note('phone', 'eight written forms of one mobile normalise to one key',
    '+972501234567|+972501234567|+972501234567|+972501234567|+972501234567|+972501234567|+972501234567|+972501234567',
    concat_ws('|',
      public.normalize_phone_il('0501234567'),
      public.normalize_phone_il('050-123-4567'),
      public.normalize_phone_il('050 123 4567'),
      public.normalize_phone_il('+972501234567'),
      public.normalize_phone_il('+972-50-123-4567'),
      public.normalize_phone_il('972501234567'),
      public.normalize_phone_il('00972501234567'),
      public.normalize_phone_il('+9720501234567')));

  perform pg_temp.note('phone', 'a landline and a bare nine-digit mobile normalise too',
    '+97231234567|+972501234567',
    concat_ws('|',
      public.normalize_phone_il('03-1234567'),
      public.normalize_phone_il('501234567')));

  perform pg_temp.note('phone', 'a foreign number keeps its own country code',
    '+442079460958|+12125550123',
    concat_ws('|',
      public.normalize_phone_il('+44 20 7946 0958'),
      public.normalize_phone_il('001 212 555 0123')));

  perform pg_temp.note('phone', 'nothing and nonsense normalise to null',
    'null|null',
    concat_ws('|',
      coalesce(public.normalize_phone_il(null), 'null'),
      coalesce(public.normalize_phone_il('  --  '), 'null')));

  perform pg_temp.note('guest', 'the seeded guest stored the normalised key', '+972501234567',
    (select phone_e164 from public.guests where id = guest_a));

  perform pg_temp.note('guest', 'a second guest with the same number in another format is refused',
    'err:23505',
    pg_temp.try(format(
      'insert into public.guests (organization_id, full_name, phone) values (%L, ''Duplicate'', ''+972-50-123-4567'')',
      org_a)));

  perform pg_temp.note('guest', 'the same number in another organization is accepted', 'ok:1',
    pg_temp.try(format(
      'insert into public.guests (organization_id, full_name, phone) values (%L, ''Same number, other tenant'', ''050-123-4567'')',
      org_b)));

  perform pg_temp.note('guest', 'a guest with no phone is accepted, and twice', 'ok:1',
    pg_temp.try(format(
      'insert into public.guests (organization_id, full_name, email) values (%L, ''No phone one'', ''np1@estia.test'')', org_a)));
  perform pg_temp.note('guest', 'deduplication does not collapse guests without a phone', 'ok:1',
    pg_temp.try(format(
      'insert into public.guests (organization_id, full_name, email) values (%L, ''No phone two'', ''np2@estia.test'')', org_a)));

  -- The deduplication index is partial on deleted_at is null, so a guest who
  -- was merged away or removed does not keep the number hostage.
  perform pg_temp.try(format('update public.guests set deleted_at = now() where id = %L', guest_a));
  perform pg_temp.note('guest', 'soft-deleting a guest releases the phone for reuse', 'ok:1',
    pg_temp.try(format(
      'insert into public.guests (organization_id, full_name, phone) values (%L, ''Reused number'', ''0501234567'')',
      org_a)));
  -- And the reverse is true, which is the part that is easy to get wrong:
  -- restoring the first guest while the second holds the number must fail.
  perform pg_temp.note('guest', 'restoring a guest whose number was taken is refused', 'err:23505',
    pg_temp.try(format('update public.guests set deleted_at = null where id = %L', guest_a)));
  perform pg_temp.try(format(
    'delete from public.guests where organization_id = %L and full_name = ''Reused number''', org_a));
  perform pg_temp.note('control', 'once the number is free again the guest restores', 'ok:1',
    pg_temp.try(format('update public.guests set deleted_at = null where id = %L', guest_a)));


  ---------------------------------------------------------------------------
  -- 7 · The foreign keys 0008 closed
  ---------------------------------------------------------------------------
  perform pg_temp.note('fk', 'memberships.default_property_id cannot name another tenant property',
    'err:23503',
    pg_temp.try(format('update public.memberships set default_property_id = %L where id = %L',
      prop_b1, mem_a)));
  perform pg_temp.note('fk', 'memberships.default_property_id accepts its own (positive control)',
    'ok:1',
    pg_temp.try(format('update public.memberships set default_property_id = %L where id = %L',
      prop_a1, mem_a)));

  perform pg_temp.note('fk', 'memberships.team_id cannot name another tenant team', 'err:23503',
    pg_temp.try(format('update public.memberships set team_id = %L where id = %L', team_b, mem_a)));
  perform pg_temp.note('fk', 'memberships.team_id accepts its own (positive control)', 'ok:1',
    pg_temp.try(format('update public.memberships set team_id = %L where id = %L', team_a, mem_a)));

  perform pg_temp.note('fk', 'audit_events.property_id cannot name another tenant property',
    'err:23503',
    pg_temp.try(format(
      'insert into public.audit_events (organization_id, actor_label, action, resource_type, summary, property_id)
       values (%L, ''A'', ''booking.create'', ''booking'', ''x'', %L)', org_a, prop_b1)));
  perform pg_temp.note('fk', 'audit_events.property_id accepts its own (positive control)', 'ok:1',
    pg_temp.try(format(
      'insert into public.audit_events (organization_id, actor_label, action, resource_type, summary, property_id)
       values (%L, ''A'', ''booking.create'', ''booking'', ''x'', %L)', org_a, prop_a1)));

  perform pg_temp.note_like('fk', 'a scope naming a property that does not exist is refused',
    'err:23503%does not exist in organization%',
    pg_temp.try_verbose(format(
      'update public.membership_scopes set property_ids = array[%L::uuid] where membership_id = %L',
      'ffffffff-0000-4000-8000-00000000ffff', mem_g)));

  perform pg_temp.note_like('fk', 'a scope naming another tenant property is refused',
    'err:23503%does not exist in organization%',
    pg_temp.try_verbose(format(
      'update public.membership_scopes set property_ids = array[%L::uuid] where membership_id = %L',
      prop_b1, mem_g)));

  perform pg_temp.note('fk', 'a scope naming its own property is accepted (positive control)',
    'ok:1',
    pg_temp.try(format(
      'update public.membership_scopes set property_ids = array[%L::uuid] where membership_id = %L',
      prop_a1, mem_g)));

  perform pg_temp.note_like('fk', 'an invitation scope naming another tenant property is refused',
    'err:23503%does not exist in organization%',
    pg_temp.try_verbose(format(
      'insert into public.invitations (organization_id, email, role_id, token_hash, expires_at, scope_kind, scope_property_ids)
       values (%L, ''inv@estia.test'', %L, ''booking-hash-1'', now() + interval ''7 days'', ''properties'', array[%L::uuid])',
      org_a, owner_role, prop_b1)));

  perform pg_temp.note('fk', 'an invitation scope naming its own property is accepted (positive control)',
    'ok:1',
    pg_temp.try(format(
      'insert into public.invitations (organization_id, email, role_id, token_hash, expires_at, scope_kind, scope_property_ids)
       values (%L, ''inv2@estia.test'', %L, ''booking-hash-2'', now() + interval ''7 days'', ''properties'', array[%L::uuid])',
      org_a, owner_role, prop_a1)));

  perform pg_temp.note_like('fk', 'a property named by a live scope cannot be hard-deleted',
    'err:23503%membership scope%',
    pg_temp.try_verbose(format('delete from public.properties where id = %L', prop_a3)));

  perform pg_temp.try(format(
    'update public.membership_scopes set kind = ''all_organization'', property_ids = ''{}''::uuid[]
      where membership_id = %L', mem_h));
  perform pg_temp.note('fk', 'once nothing names it, the property deletes (positive control)',
    'ok:1',
    pg_temp.try(format('delete from public.properties where id = %L', prop_a3)));


  ---------------------------------------------------------------------------
  -- 8 · Tenant isolation, as a real authenticated session
  ---------------------------------------------------------------------------

  perform pg_temp.note('sanity', 'auth.uid() resolves to user A', '1',
    pg_temp.count_as(user_a, 'select count(*) from (select auth.uid() = ''' || user_a || '''::uuid as ok) t where t.ok'));

  -- SELECT
  perform pg_temp.note('isolation', 'properties: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.properties where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'properties: A DOES see its own', '2',
    pg_temp.count_as(user_a, 'select count(*) from public.properties where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'units: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.units where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'units: A DOES see its own', '2',
    pg_temp.count_as(user_a, 'select count(*) from public.units where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'unit_groups: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.unit_groups where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'unit_groups: A DOES see its own', '1',
    pg_temp.count_as(user_a, 'select count(*) from public.unit_groups where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'teams: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.teams where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'teams: A DOES see its own', '1',
    pg_temp.count_as(user_a, 'select count(*) from public.teams where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'amenities: A sees none of B''s custom ones', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.amenities where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'amenities: A DOES see its own and the built-in catalogue', '27',
    pg_temp.count_as(user_a, 'select count(*) from public.amenities'));

  perform pg_temp.note('isolation', 'property_amenities: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.property_amenities where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'property_amenities: A DOES see its own', '1',
    pg_temp.count_as(user_a, 'select count(*) from public.property_amenities where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'unit_amenities: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.unit_amenities where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'unit_amenities: A DOES see its own', '1',
    pg_temp.count_as(user_a, 'select count(*) from public.unit_amenities where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'guests: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.guests where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'guests: A DOES see its own', '3',
    pg_temp.count_as(user_a, 'select count(*) from public.guests where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'bookings: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.bookings where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'bookings: A DOES see its own', 'true',
    pg_temp.gt0(pg_temp.count_as(user_a, 'select count(*) from public.bookings where organization_id = ''' || org_a || '''')));

  perform pg_temp.note('isolation', 'booking_price_lines: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.booking_price_lines where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'booking_price_lines: A DOES see its own', '3',
    pg_temp.count_as(user_a, 'select count(*) from public.booking_price_lines where organization_id = ''' || org_a || ''''));

  perform pg_temp.note('isolation', 'booking_status_history: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.booking_status_history where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'booking_status_history: A DOES see its own', 'true',
    pg_temp.gt0(pg_temp.count_as(user_a, 'select count(*) from public.booking_status_history where organization_id = ''' || org_a || '''')));

  perform pg_temp.note('isolation', 'holds: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.holds where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'holds: A DOES see its own', 'true',
    pg_temp.gt0(pg_temp.count_as(user_a, 'select count(*) from public.holds where organization_id = ''' || org_a || '''')));

  perform pg_temp.note('isolation', 'unit_occupancy: A sees none of B''s', '0',
    pg_temp.count_as(user_a, 'select count(*) from public.unit_occupancy where organization_id = ''' || org_b || ''''));
  perform pg_temp.note('control', 'unit_occupancy: A DOES see its own', 'true',
    pg_temp.gt0(pg_temp.count_as(user_a, 'select count(*) from public.unit_occupancy where organization_id = ''' || org_a || '''')));

  -- INSERT into B
  perform pg_temp.note('isolation', 'properties: A cannot insert into B', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.properties (organization_id, slug, name) values (%L, ''sneaky'', ''Sneaky'')', org_b)));
  perform pg_temp.note('control', 'properties: A CAN insert into its own', 'ok:1',
    pg_temp.try_as(user_a, format(
      'insert into public.properties (organization_id, slug, name) values (%L, ''legit'', ''Legit'')', org_a)));

  perform pg_temp.note('isolation', 'units: A cannot insert into B', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.units (organization_id, property_id, code, name) values (%L, %L, ''X'', ''X'')',
      org_b, prop_b1)));
  perform pg_temp.note('control', 'units: A CAN insert into its own', 'ok:1',
    pg_temp.try_as(user_a, format(
      'insert into public.units (organization_id, property_id, code, name) values (%L, %L, ''NEW'', ''New'')',
      org_a, prop_a1)));

  perform pg_temp.note('isolation', 'teams: A cannot insert into B', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.teams (organization_id, name) values (%L, ''Sneaky team'')', org_b)));
  perform pg_temp.note('control', 'teams: A CAN insert into its own', 'ok:1',
    pg_temp.try_as(user_a, format(
      'insert into public.teams (organization_id, name) values (%L, ''Legit team'')', org_a)));

  perform pg_temp.note('isolation', 'guests: A cannot insert into B', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.guests (organization_id, full_name) values (%L, ''Sneaky guest'')', org_b)));
  perform pg_temp.note('control', 'guests: A CAN insert into its own', 'ok:1',
    pg_temp.try_as(user_a, format(
      'insert into public.guests (organization_id, full_name) values (%L, ''Legit guest'')', org_a)));

  perform pg_temp.note('isolation', 'bookings: A cannot insert into B', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out)
       values (%L, %L, %L, %L, ''2027-02-01'', ''2027-02-05'')',
      org_b, prop_b1, unit_b1, guest_b)));
  perform pg_temp.note('control', 'bookings: A CAN insert into its own', 'ok:1',
    pg_temp.try_as(user_a, format(
      'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out)
       values (%L, %L, %L, %L, ''2027-02-01'', ''2027-02-05'')',
      org_a, prop_a1, unit_a1, guest_a)));

  perform pg_temp.note('isolation', 'holds: A cannot insert into B', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.holds (organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
       values (%L, %L, %L, ''2027-03-01'', ''2027-03-05'', ''staff_manual'', %L, now() + interval ''1 hour'')',
      org_b, prop_b1, unit_b1, user_a)));
  perform pg_temp.note('control', 'holds: A CAN insert into its own', 'ok:1',
    pg_temp.try_as(user_a, format(
      'insert into public.holds (organization_id, property_id, unit_id, check_in, check_out, reason, held_by_user_id, expires_at)
       values (%L, %L, %L, ''2027-03-01'', ''2027-03-05'', ''staff_manual'', %L, now() + interval ''1 hour'')',
      org_a, prop_a1, unit_a1, user_a)));

  perform pg_temp.note('isolation', 'booking_price_lines: A cannot insert onto B''s booking', 'err:42501',
    pg_temp.try_as(user_a, format(
      'insert into public.booking_price_lines (organization_id, property_id, booking_id, kind, label, amount_agorot)
       values (%L, %L, %L, ''addon'', ''Sneaky'', 100)', org_b, prop_b1, bk_b1)));
  perform pg_temp.note('control', 'booking_price_lines: A CAN insert onto its own booking', 'ok:1',
    pg_temp.try_as(user_a, format(
      'insert into public.booking_price_lines (organization_id, property_id, booking_id, kind, label, amount_agorot)
       values (%L, %L, %L, ''addon'', ''Legit'', 100)', org_a, prop_a1, bk1)));

  -- UPDATE B's rows
  perform pg_temp.note('isolation', 'properties: A''s update of B''s row touches nothing', 'ok:0',
    pg_temp.try_as(user_a, format('update public.properties set name = ''Hijacked'' where id = %L', prop_b1)));
  perform pg_temp.note('control', 'properties: A''s update of its own touches one row', 'ok:1',
    pg_temp.try_as(user_a, format('update public.properties set name = ''Renamed'' where id = %L', prop_a1)));

  perform pg_temp.note('isolation', 'units: A''s update of B''s row touches nothing', 'ok:0',
    pg_temp.try_as(user_a, format('update public.units set name = ''Hijacked'' where id = %L', unit_b1)));
  perform pg_temp.note('control', 'units: A''s update of its own touches one row', 'ok:1',
    pg_temp.try_as(user_a, format('update public.units set name = ''Renamed'' where id = %L', unit_a1)));

  perform pg_temp.note('isolation', 'guests: A''s update of B''s row touches nothing', 'ok:0',
    pg_temp.try_as(user_a, format('update public.guests set full_name = ''Hijacked'' where id = %L', guest_b)));
  perform pg_temp.note('control', 'guests: A''s update of its own touches one row', 'ok:1',
    pg_temp.try_as(user_a, format('update public.guests set full_name = ''Renamed'' where id = %L', guest_a)));

  perform pg_temp.note('isolation', 'bookings: A''s update of B''s row touches nothing', 'ok:0',
    pg_temp.try_as(user_a, format('update public.bookings set internal_notes = ''Hijacked'' where id = %L', bk_b1)));
  perform pg_temp.note('control', 'bookings: A''s update of its own touches one row', 'ok:1',
    pg_temp.try_as(user_a, format('update public.bookings set internal_notes = ''Noted'' where id = %L', bk1)));

  perform pg_temp.note('isolation', 'teams: A''s update of B''s row touches nothing', 'ok:0',
    pg_temp.try_as(user_a, format('update public.teams set name = ''Hijacked'' where id = %L', team_b)));
  perform pg_temp.note('control', 'teams: A''s update of its own touches one row', 'ok:1',
    pg_temp.try_as(user_a, format('update public.teams set name = ''Renamed team'' where id = %L', team_a)));

  perform pg_temp.note('isolation', 'holds: A''s update of B''s row touches nothing', 'ok:0',
    pg_temp.try_as(user_a, format('update public.holds set note = ''Hijacked'' where organization_id = %L', org_b)));
  perform pg_temp.note('control', 'holds: A''s update of its own touches one row', 'ok:1',
    pg_temp.try_as(user_a, format('update public.holds set note = ''Noted'' where id = %L', hold_x)));

  -- DELETE B's rows
  perform pg_temp.note('isolation', 'guests: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.guests where id = %L', guest_b)));
  perform pg_temp.note('isolation', 'bookings: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.bookings where id = %L', bk_b1)));
  perform pg_temp.note('isolation', 'units: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.units where id = %L', unit_b1)));
  perform pg_temp.note('isolation', 'teams: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.teams where id = %L', team_b)));
  perform pg_temp.note('isolation', 'amenities: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.amenities where id = %L', amen_b)));
  perform pg_temp.note('isolation', 'property_amenities: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.property_amenities where organization_id = %L', org_b)));
  perform pg_temp.note('isolation', 'unit_amenities: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.unit_amenities where organization_id = %L', org_b)));
  perform pg_temp.note('isolation', 'booking_price_lines: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.booking_price_lines where organization_id = %L', org_b)));
  perform pg_temp.note('isolation', 'holds: A''s delete of B''s row removes nothing', 'ok:0',
    pg_temp.try_as(user_a, format('delete from public.holds where organization_id = %L', org_b)));

  -- Positive controls for delete. Without these the nine rows above prove
  -- nothing: a missing GRANT would produce the same zero.
  perform pg_temp.note('control', 'amenities: A CAN delete its own', 'ok:1',
    pg_temp.try_as(user_a, format('delete from public.amenities where id = %L', amen_a)));
  perform pg_temp.note('control', 'unit_amenities: A CAN delete its own', 'ok:1',
    pg_temp.try_as(user_a, format('delete from public.unit_amenities where organization_id = %L', org_a)));
  perform pg_temp.note('control', 'property_amenities: A CAN delete its own', 'ok:1',
    pg_temp.try_as(user_a, format('delete from public.property_amenities where organization_id = %L', org_a)));
  perform pg_temp.note('control', 'booking_price_lines: A CAN delete its own', 'ok:3',
    pg_temp.try_as(user_a, format('delete from public.booking_price_lines where booking_id = %L', bk1)));
  perform pg_temp.note('control', 'holds: A CAN delete its own', 'ok:1',
    pg_temp.try_as(user_a, format('delete from public.holds where id = %L', hold_x)));
  perform pg_temp.note('control', 'bookings: A CAN delete its own', 'ok:1',
    pg_temp.try_as(user_a, format('delete from public.bookings where id = %L', bk1)));
  perform pg_temp.note('control', 'guests: A CAN delete its own', 'ok:1',
    pg_temp.try_as(user_a, format(
      'delete from public.guests where organization_id = %L and full_name = ''Legit guest''', org_a)));


  ---------------------------------------------------------------------------
  -- 9 · Scope. The agent-network rule, enforced in the query.
  ---------------------------------------------------------------------------
  -- user_g is an active member of organization A with every permission an
  -- owner has, and a scope of exactly one property. Nothing below is about
  -- what they may do — it is about what exists as far as they are concerned.

  perform pg_temp.note('scope', 'the scoped member sees one property, not both', '1',
    pg_temp.count_as(user_g, 'select count(*) from public.properties where organization_id = ''' || org_a || ''''));
  perform pg_temp.note('scope', 'the scoped member cannot see the property outside their scope', '0',
    pg_temp.count_as(user_g, 'select count(*) from public.properties where id = ''' || prop_a2 || ''''));
  perform pg_temp.note('control', 'the scoped member DOES see the property inside their scope', '1',
    pg_temp.count_as(user_g, 'select count(*) from public.properties where id = ''' || prop_a1 || ''''));

  perform pg_temp.note('scope', 'the scoped member cannot see units outside their scope', '0',
    pg_temp.count_as(user_g, 'select count(*) from public.units where property_id = ''' || prop_a2 || ''''));
  perform pg_temp.note('control', 'the scoped member DOES see units inside their scope', 'true',
    pg_temp.gt0(pg_temp.count_as(user_g, 'select count(*) from public.units where property_id = ''' || prop_a1 || '''')));

  perform pg_temp.note('scope', 'the scoped member cannot see bookings outside their scope', '0',
    pg_temp.count_as(user_g, 'select count(*) from public.bookings where property_id = ''' || prop_a2 || ''''));
  perform pg_temp.note('control', 'the scoped member DOES see bookings inside their scope', 'true',
    pg_temp.gt0(pg_temp.count_as(user_g, 'select count(*) from public.bookings where property_id = ''' || prop_a1 || '''')));

  perform pg_temp.note('scope', 'the scoped member cannot see the calendar outside their scope', '0',
    pg_temp.count_as(user_g, 'select count(*) from public.unit_occupancy where property_id = ''' || prop_a2 || ''''));
  perform pg_temp.note('control', 'the scoped member DOES see the calendar inside their scope', 'true',
    pg_temp.gt0(pg_temp.count_as(user_g, 'select count(*) from public.unit_occupancy where property_id = ''' || prop_a1 || '''')));

  perform pg_temp.note('scope', 'the scoped member cannot see price lines outside their scope', '0',
    pg_temp.count_as(user_g, 'select count(*) from public.booking_price_lines where property_id = ''' || prop_a2 || ''''));
  perform pg_temp.note('scope', 'the scoped member cannot see status history outside their scope', '0',
    pg_temp.count_as(user_g, 'select count(*) from public.booking_status_history where property_id = ''' || prop_a2 || ''''));

  perform pg_temp.note('scope', 'the scoped member cannot write a booking outside their scope', 'err:42501',
    pg_temp.try_as(user_g, format(
      'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out)
       values (%L, %L, %L, %L, ''2027-04-01'', ''2027-04-05'')',
      org_a, prop_a2, unit_a2, guest_a)));
  perform pg_temp.note('control', 'the scoped member CAN write a booking inside their scope', 'ok:1',
    pg_temp.try_as(user_g, format(
      'insert into public.bookings (organization_id, property_id, unit_id, guest_id, check_in, check_out)
       values (%L, %L, %L, %L, ''2027-04-01'', ''2027-04-05'')',
      org_a, prop_a1, unit_a1, guest_a)));

  perform pg_temp.note('scope', 'the scoped member''s update outside their scope touches nothing', 'ok:0',
    pg_temp.try_as(user_g, format('update public.units set name = ''Reached'' where id = %L', unit_a2)));
  perform pg_temp.note('control', 'the scoped member''s update inside their scope touches one row', 'ok:1',
    pg_temp.try_as(user_g, format('update public.units set name = ''Reached'' where id = %L', unit_a1)));

  perform pg_temp.note('scope', 'the scoped member''s delete outside their scope removes nothing', 'ok:0',
    pg_temp.try_as(user_g, format('delete from public.bookings where id = %L', bk_a2)));

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into booking_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from booking_results;

select seq, area, name, expected, actual, passed from booking_results order by seq;

rollback;
