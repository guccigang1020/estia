-- ============================================================================
-- guest_journey.sql — ESTIA · proof that the guest-facing surface discloses
--                     exactly one booking, and only what it is allowed to
--
-- What this is
--   Every other proof in this directory asks whether a member of organization
--   A can reach organization B. This one asks a harder question, because the
--   guest portal deliberately breaks the rule the rest of the schema relies
--   on: a guest has no account, no auth.uid() and no membership, so no RLS
--   policy can express "exactly this booking". 0033 and 0034 answer that with
--   SECURITY DEFINER functions that take a 32-byte capability and return a
--   hand-picked projection. They are the only functions in this schema that
--   `anon` may execute, and they run as their owner — which means RLS is not
--   protecting anything inside them. The function body IS the security
--   boundary. So it is the function body that has to be tested.
--
--   Two distinct things are proved here, and they fail in different ways:
--
--     1. The floor. `anon` cannot reach any journey table directly, and the
--        internal helpers that return whole rows are not executable by anon.
--        If this breaks, the capability model is irrelevant.
--     2. The projection. A token for booking A never yields booking B, and
--        each gated secret is SQL NULL until its own condition is met. If
--        this breaks, the floor holds and somebody's door code still leaks.
--
--   Nothing here asserts through has_table_privilege. A privilege check
--   proves a grant exists; only running the statement proves the policy
--   filters and only calling the function proves the projection gates.
--
-- A note on how anon assertions are written
--   The result table is a temp table owned by the session owner, and `anon`
--   has no INSERT on it. So each assertion switches to anon, captures what it
--   found into a variable, resets the role, and only then records the row.
--   Capturing first and recording second is not a style preference; writing
--   the result while still impersonating anon fails with 42501 and would look
--   exactly like the assertion passing.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/guest_journey.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK; it leaves no rows behind. One result
--   row per assertion plus a TOTAL. `passed = false` anywhere is a defect.
--
-- KNOWN FAILURES — read this before "fixing" the test
--   Three assertions below FAIL against the schema as it stands, deliberately.
--   Each states what security or correctness requires, not what the code
--   currently does. Do not soften them to make the suite green — the fixes
--   belong in migrations.
--
--   1 & 2 · `stay`: a cancelled booking whose dates are current still returns
--     the wifi password and the property guide. `v_in_stay` in 0034 §9 is
--     computed from the calendar and the status list without ever consulting
--     the cancellation guard that 0038 added one field group above it. 0038
--     closed the arrival gate for a cancelled stay; the during-stay gate has
--     the identical hole and nobody closed it. A guest whose stay is not
--     happening keeps a credential to the property's network for the rest of
--     the original date range.
--
--   3 · `token`: 0033 raises `guest_link_revoked` with errcode P0004, which
--     is PostgreSQL's reserved `assert_failure`. WHEN OTHERS is documented
--     not to catch it, so a revoked link aborts any PL/pgSQL caller that
--     wraps the portal in a generic handler — including, before it was worked
--     around, this file. See the comment beside that assertion.
--
-- Depends on
--   0001_identity.sql … 0007_user_profiles_trigger.sql, 0008_accommodation.sql,
--   0009_booking_core.sql, 0033_guest_link.sql, 0034_guest_journey.sql,
--   0037_guest_audit_actor.sql, 0038_cancelled_revokes_arrival.sql.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table journey_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := 'b9000000-0000-4000-8000-00000000000a';
  org_b   constant uuid := 'b9000000-0000-4000-8000-00000000000b';
  usr_a   constant uuid := 'b9a00000-0000-4000-8000-00000000000a';
  usr_b   constant uuid := 'b9a00000-0000-4000-8000-00000000000b';
  mem_a   constant uuid := 'b9d00000-0000-4000-8000-00000000000a';
  mem_b   constant uuid := 'b9d00000-0000-4000-8000-00000000000b';
  prop_a  constant uuid := 'b9b00000-0000-4000-8000-00000000000a';
  prop_b  constant uuid := 'b9b00000-0000-4000-8000-00000000000b';
  -- One unit per booking. `unit_occupancy_no_overlap` is a real exclusion
  -- constraint: the same unit cannot hold two overlapping stays, and several
  -- of the bookings below deliberately share a date range because they differ
  -- only in status. Giving them separate units keeps the fixture legal without
  -- weakening what is being tested — none of these assertions is about units.
  unit_a1 constant uuid := 'b9c00000-0000-4000-8000-000000000001';
  unit_a2 constant uuid := 'b9c00000-0000-4000-8000-000000000002';
  unit_a3 constant uuid := 'b9c00000-0000-4000-8000-000000000003';
  unit_a4 constant uuid := 'b9c00000-0000-4000-8000-000000000004';
  unit_a5 constant uuid := 'b9c00000-0000-4000-8000-000000000005';
  unit_a6 constant uuid := 'b9c00000-0000-4000-8000-000000000006';
  unit_a7 constant uuid := 'b9c00000-0000-4000-8000-000000000007';
  unit_b  constant uuid := 'b9c00000-0000-4000-8000-00000000000b';
  gst_a   constant uuid := 'b9e00000-0000-4000-8000-00000000000a';
  gst_b   constant uuid := 'b9e00000-0000-4000-8000-00000000000b';

  -- Organization A's bookings, one per gate this file exercises.
  bk_future  constant uuid := 'b9f00000-0000-4000-8000-000000000001'; -- confirmed, arrives later
  bk_stay    constant uuid := 'b9f00000-0000-4000-8000-000000000002'; -- confirmed, stay in progress
  bk_unconf  constant uuid := 'b9f00000-0000-4000-8000-000000000003'; -- stay in progress, never confirmed
  bk_cancel  constant uuid := 'b9f00000-0000-4000-8000-000000000004'; -- cancelled mid-stay, was released
  bk_noshow  constant uuid := 'b9f00000-0000-4000-8000-000000000005'; -- no-show, was released
  bk_revoked constant uuid := 'b9f00000-0000-4000-8000-000000000006'; -- link revoked
  bk_expired constant uuid := 'b9f00000-0000-4000-8000-000000000007'; -- link expired
  -- Organization B's single booking. Everything about it must stay invisible.
  bk_b       constant uuid := 'b9f00000-0000-4000-8000-00000000000b';

  total_a constant bigint := 111100;
  total_b constant bigint := 999900;

  owner_role uuid;

  tok_future  text;  tok_stay    text;  tok_unconf text;
  tok_cancel  text;  tok_noshow  text;
  tok_revoked text;  tok_expired text;  tok_b      text;
  ref_a text; ref_b text;

  j        jsonb;
  j_b      jsonb;
  s        jsonb;
  released boolean;
  v_booking  public.bookings%rowtype;
  v_settings public.guest_journey_settings%rowtype;
  v_journey  public.booking_guest_journey%rowtype;

  n_rows bigint;
  err    text;
begin
  ---------------------------------------------------------------------------
  -- Fixture. Written as the owner, which has BYPASSRLS: setting up the world
  -- is not what is under test.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (usr_a, 'journey-a@estia.test'),
    (usr_b, 'journey-b@estia.test');

  -- 0007 put a trigger on auth.users that creates the profile row, so these
  -- already exist by the time we get here and a plain INSERT raises 23505.
  insert into public.user_profiles (id, full_name) values
    (usr_a, 'Journey Operator A'), (usr_b, 'Journey Operator B')
  on conflict (id) do update set full_name = excluded.full_name;

  insert into public.organizations (id, slug, name) values
    (org_a, 'journey-org-a', 'Journey Organization A'),
    (org_b, 'journey-org-b', 'Journey Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, usr_a, org_a, 'active', now()),
    (mem_b, usr_b, org_b, 'active', now());
  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role), (mem_b, org_b, owner_role);
  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'), (mem_b, org_b, 'all_organization');

  insert into public.properties (id, organization_id, slug, name, address_line1, city) values
    (prop_a, org_a, 'journey-prop-a', 'Property A', 'A-STREET-SECRET 1', 'Tel Aviv'),
    (prop_b, org_b, 'journey-prop-b', 'Property B', 'B-STREET-SECRET 9', 'Haifa');

  insert into public.units (id, organization_id, property_id, code, name) values
    (unit_a1, org_a, prop_a, 'UA1', 'Unit A1'),
    (unit_a2, org_a, prop_a, 'UA2', 'Unit A2'),
    (unit_a3, org_a, prop_a, 'UA3', 'Unit A3'),
    (unit_a4, org_a, prop_a, 'UA4', 'Unit A4'),
    (unit_a5, org_a, prop_a, 'UA5', 'Unit A5'),
    (unit_a6, org_a, prop_a, 'UA6', 'Unit A6'),
    (unit_a7, org_a, prop_a, 'UA7', 'Unit A7'),
    (unit_b,  org_b, prop_b, 'UB',  'Unit B');

  -- Distinctive names, because several assertions below look for B's guest
  -- name anywhere in A's payload and a name like "Guest" would match by luck.
  insert into public.guests (id, organization_id, full_name) values
    (gst_a, org_a, 'Alice Alphaonly'),
    (gst_b, org_b, 'Bruno Betaonly');

  -- No total_agorot here on purpose. `bookings_freeze_total` recomputes it
  -- from booking_price_lines on every write, so a total written directly is
  -- silently replaced by 0 — which would make the two "carries A's total, not
  -- B's" assertions below compare 0 against 0 and pass without meaning
  -- anything. The totals are given to the bookings the way the product gives
  -- them: as price lines, immediately after.
  insert into public.bookings
    (id, organization_id, property_id, unit_id, guest_id, check_in, check_out, status)
  values
    (bk_future,  org_a, prop_a, unit_a1, gst_a, current_date + 30, current_date + 34, 'confirmed'),
    (bk_stay,    org_a, prop_a, unit_a2, gst_a, current_date -  1, current_date +  2, 'confirmed'),
    (bk_unconf,  org_a, prop_a, unit_a3, gst_a, current_date -  1, current_date +  2, 'confirmed'),
    (bk_cancel,  org_a, prop_a, unit_a4, gst_a, current_date -  1, current_date +  2, 'cancelled'),
    (bk_noshow,  org_a, prop_a, unit_a5, gst_a, current_date -  1, current_date +  2, 'no_show'),
    (bk_revoked, org_a, prop_a, unit_a6, gst_a, current_date + 30, current_date + 34, 'confirmed'),
    (bk_expired, org_a, prop_a, unit_a7, gst_a, current_date + 30, current_date + 34, 'confirmed'),
    (bk_b,       org_b, prop_b, unit_b,  gst_b, current_date + 30, current_date + 34, 'confirmed');

  insert into public.booking_price_lines
    (organization_id, property_id, booking_id, kind, label, amount_agorot)
  values
    (org_a, prop_a, bk_future, 'accommodation', 'Four nights', total_a),
    (org_b, prop_b, bk_b,      'accommodation', 'Four nights', total_b);

  update public.bookings set guest_link_revoked_at = now()               where id = bk_revoked;
  update public.bookings set guest_link_expires_at = now() - interval '1 day' where id = bk_expired;

  -- Org-level settings for both. 'after_confirmation' is the shipped default
  -- and the one 0038 was written about.
  insert into public.guest_journey_settings (organization_id, arrival_release) values
    (org_a, 'after_confirmation'),
    (org_b, 'after_confirmation');

  -- The secrets. Every value is tagged with its organization so an assertion
  -- can look for B's string inside A's payload and mean something.
  insert into public.guest_journey_content
    (organization_id, property_id, address_note, directions, map_url, access_instructions,
     access_code, parking, wifi_network, wifi_password, property_guide, emergency_contact,
     checkout_instructions)
  values
    (org_a, prop_a, 'ADDRNOTE-A', 'DIRECTIONS-A', 'https://map.invalid/A', 'ENTRY-A',
     'DOORCODE-A', 'PARKING-A', 'WIFINET-A', 'WIFIPASS-A', 'GUIDE-A', 'ICE-A', 'CHECKOUT-A'),
    (org_b, prop_b, 'ADDRNOTE-B', 'DIRECTIONS-B', 'https://map.invalid/B', 'ENTRY-B',
     'DOORCODE-B', 'PARKING-B', 'WIFINET-B', 'WIFIPASS-B', 'GUIDE-B', 'ICE-B', 'CHECKOUT-B');

  insert into public.booking_guest_journey (booking_id, organization_id) values
    (bk_future, org_a), (bk_stay, org_a), (bk_unconf, org_a), (bk_cancel, org_a),
    (bk_noshow, org_a), (bk_revoked, org_a), (bk_expired, org_a), (bk_b, org_b);

  -- The guest confirmed every booking except bk_unconf. That is the whole
  -- point of bk_unconf: it separates "the stay has begun" from "the arrival
  -- gate has opened", which is what the wifi assertions turn on.
  insert into public.booking_guest_confirmations
    (organization_id, booking_id, booking_version, snapshot)
  values
    (org_a, bk_future, 1, '{}'::jsonb),
    (org_a, bk_stay,   1, '{}'::jsonb),
    (org_a, bk_cancel, 1, '{}'::jsonb),
    (org_a, bk_noshow, 1, '{}'::jsonb),
    (org_b, bk_b,      1, '{}'::jsonb);

  -- And an operator manually released arrival on the two that were later
  -- cancelled. This is the case 0038 exists for: somebody deliberately opened
  -- the gate, and cancelling has to be able to close it again.
  update public.booking_guest_journey set manual_released_at = now()
    where booking_id in (bk_cancel, bk_noshow);

  insert into public.guest_requests
    (organization_id, booking_id, property_id, category, client_key, body)
  values
    (org_a, bk_stay, prop_a, 'towels', 'journey-req-a', 'REQUESTBODY-A'),
    (org_b, bk_b,    prop_b, 'towels', 'journey-req-b', 'REQUESTBODY-B');

  insert into public.guest_contract_templates (organization_id, title, body) values
    (org_a, 'Terms A', 'CONTRACTBODY-A'),
    (org_b, 'Terms B', 'CONTRACTBODY-B');

  insert into public.guest_link_sends (organization_id, booking_id, channel) values
    (org_a, bk_future, 'email'),
    (org_b, bk_b,      'email');

  select guest_token into tok_future  from public.bookings where id = bk_future;
  select guest_token into tok_stay    from public.bookings where id = bk_stay;
  select guest_token into tok_unconf  from public.bookings where id = bk_unconf;
  select guest_token into tok_cancel  from public.bookings where id = bk_cancel;
  select guest_token into tok_noshow  from public.bookings where id = bk_noshow;
  select guest_token into tok_revoked from public.bookings where id = bk_revoked;
  select guest_token into tok_expired from public.bookings where id = bk_expired;
  select guest_token, reference into tok_b, ref_b from public.bookings where id = bk_b;
  select reference into ref_a from public.bookings where id = bk_future;

  ---------------------------------------------------------------------------
  -- 1 · The floor: anon reaches no journey table directly.
  --
  -- These are the tables 0033 and 0034 added, plus the three older ones the
  -- portal reads through. If any of them answers `anon` at all, the whole
  -- capability design is decoration — a guest could enumerate the schema
  -- instead of presenting a token.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.bookings;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from bookings', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.guest_requests;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from guest_requests', '42501', err, err = '42501');

  -- The table the door codes and wifi passwords actually live in.
  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.guest_journey_content;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from guest_journey_content', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.booking_guest_journey;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from booking_guest_journey', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.guest_journey_settings;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from guest_journey_settings', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.booking_guest_details;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from booking_guest_details', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.booking_guest_confirmations;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from booking_guest_confirmations', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.booking_contract_signatures;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from booking_contract_signatures', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.guest_contract_templates;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from guest_contract_templates', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.guest_link_sends;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from guest_link_sends', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.guests;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from guests', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_rows from public.properties;
    err := 'NO ERROR — anon read ' || n_rows || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot select from properties', '42501', err, err = '42501');

  -- Writing is refused too. A guest who could insert a request into any
  -- booking could spam an operator's queue on behalf of somebody else.
  begin
    execute 'set local role anon';
    insert into public.guest_requests
      (organization_id, booking_id, property_id, category, client_key, body)
      values (org_a, bk_stay, prop_a, 'other', 'journey-forged', 'forged');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_tables', 'anon cannot insert into guest_requests directly', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 2 · The internal helpers stay internal.
  --
  -- `guest_link_booking` returns a whole bookings row and `guest_arrival_
  -- released` is the security decision itself. Both are SECURITY DEFINER, so
  -- if anon could call either, the projection above them would be bypassable.
  -- 0034 revokes them from anon, authenticated, public and service_role; this
  -- is that revocation, asserted rather than assumed.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role anon';
    perform public.guest_link_booking(tok_future);
    err := 'NO ERROR — anon executed guest_link_booking()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_functions', 'anon cannot execute guest_link_booking()', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    perform public.guest_link_booking(tok_future);
    err := 'NO ERROR — authenticated executed guest_link_booking()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_functions', 'authenticated cannot execute guest_link_booking()', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    perform public.guest_journey_effective_settings(org_a, prop_a);
    err := 'NO ERROR — anon executed guest_journey_effective_settings()';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_functions', 'anon cannot execute guest_journey_effective_settings()', '42501', err, err = '42501');

  -- Exactly one guest_arrival_released, or 0038's `create or replace` made an
  -- overload and the old permissive body is still what callers reach. 0038
  -- asserted this at migration time; it is asserted again here because a
  -- later migration could reintroduce the overload.
  select count(*) into n_rows
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guest_arrival_released';
  insert into journey_results (area, name, expected, actual, passed) values
    ('anon_functions', 'guest_arrival_released is not overloaded', '1', n_rows::text, n_rows = 1);

  ---------------------------------------------------------------------------
  -- 3 · A token is a capability for exactly one booking.
  --
  -- The interesting failure is not "A sees an error". It is "A sees B", so
  -- these look for B's actual strings anywhere in A's payload rather than
  -- checking a single field and hoping.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role anon';
    s := public.guest_portal_session(tok_future);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; s := null;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'session(token A) returns A''s own reference', ref_a,
     coalesce(s->>'reference', 'null') || coalesce(' err=' || err, ''),
     coalesce(s->>'reference' = ref_a, false));

  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'session(token A) does not carry B''s reference', 'absent',
     case when coalesce(s::text,'') like '%' || ref_b || '%' then 'PRESENT — ' || ref_b
          else 'absent' end,
     coalesce(s::text,'') not like '%' || ref_b || '%');

  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'session(token A) carries A''s guest, not B''s', 'Alice, no Bruno',
     coalesce(s->>'guestFirstName','null') ||
     case when coalesce(s::text,'') like '%Betaonly%' then ' + LEAKED BRUNO' else '' end,
     coalesce(s->>'guestFirstName' = 'Alice', false)
     and coalesce(s::text,'') not like '%Betaonly%');

  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'session(token A) carries A''s total, not B''s', total_a::text,
     coalesce(s->>'totalAgorot','null'),
     coalesce((s->>'totalAgorot')::bigint = total_a, false));

  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'session(token A) does not carry B''s total', 'absent',
     case when coalesce(s::text,'') like '%' || total_b::text || '%' then 'PRESENT'
          else 'absent' end,
     coalesce(s::text,'') not like '%' || total_b::text || '%');

  -- Positive control. Without it every assertion above would also pass if the
  -- function simply returned nothing to anybody.
  begin
    execute 'set local role anon';
    j_b := public.guest_portal_session(tok_b);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j_b := null;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'CONTROL: session(token B) does return B''s reference', ref_b,
     coalesce(j_b->>'reference','null') || coalesce(' err=' || err, ''),
     coalesce(j_b->>'reference' = ref_b, false));

  begin
    execute 'set local role anon';
    j := public.guest_portal_journey(tok_future);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j := null;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'journey(token A) returns a payload at all', 'not null',
     case when j is null then 'null' else 'payload' end || coalesce(' err=' || err, ''),
     j is not null);

  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'journey(token A) carries none of B''s secrets', 'absent',
     case when coalesce(j::text,'') like '%DOORCODE-B%' then 'LEAKED DOORCODE-B'
          when coalesce(j::text,'') like '%WIFIPASS-B%' then 'LEAKED WIFIPASS-B'
          when coalesce(j::text,'') like '%DIRECTIONS-B%' then 'LEAKED DIRECTIONS-B'
          when coalesce(j::text,'') like '%B-STREET-SECRET%' then 'LEAKED ADDRESS-B'
          else 'absent' end,
     coalesce(j::text,'') not like '%DOORCODE-B%'
     and coalesce(j::text,'') not like '%WIFIPASS-B%'
     and coalesce(j::text,'') not like '%DIRECTIONS-B%'
     and coalesce(j::text,'') not like '%B-STREET-SECRET%');

  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'journey(token A) carries none of B''s guest requests', 'absent',
     case when coalesce(j::text,'') like '%REQUESTBODY-B%' then 'LEAKED' else 'absent' end,
     coalesce(j::text,'') not like '%REQUESTBODY-B%');

  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'journey(token A) carries A''s total, not B''s', total_a::text,
     coalesce(j->'current'->>'totalAgorot','null'),
     coalesce((j->'current'->>'totalAgorot')::bigint = total_a, false));

  -- A token that was never issued.
  begin
    execute 'set local role anon';
    perform public.guest_portal_journey('journey-proof-not-a-real-token-000000');
    err := 'NO ERROR — AN UNISSUED TOKEN RESOLVED';
  exception when others then err := sqlerrm;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'an unissued token resolves to nothing', 'guest_link_not_found',
     err, err = 'guest_link_not_found');

  -- `when assert_failure or others` rather than plain `when others`, and that
  -- is not defensive style — it is working around the defect asserted two
  -- assertions below. 0033 raises `guest_link_revoked` with errcode P0004,
  -- which is PostgreSQL's reserved `assert_failure`, and WHEN OTHERS is
  -- documented not to catch that one. Without naming the condition explicitly
  -- this proof aborts here instead of recording a result.
  begin
    execute 'set local role anon';
    perform public.guest_portal_journey(tok_revoked);
    err := 'NO ERROR — A REVOKED LINK RESOLVED';
  exception when assert_failure or others then err := sqlerrm;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'a revoked link resolves to nothing', 'refused',
     err, err <> 'NO ERROR — A REVOKED LINK RESOLVED');

  -- OPEN DEFECT. P0004 is `assert_failure`, which PostgreSQL reserves for a
  -- broken internal invariant: WHEN OTHERS deliberately does not catch it, so
  -- that a genuine assertion failure cannot be swallowed by a generic
  -- handler. A guest clicking a link an operator revoked is an ordinary
  -- expected event, not a broken invariant. Giving it this errcode means
  -- every PL/pgSQL caller that wraps the portal in WHEN OTHERS aborts its
  -- transaction instead of handling the case, and every monitor that watches
  -- for assertion failures sees one each time a revoked link is opened.
  --
  -- The sibling refusals in 0033 get P0002 / P0005 / P0007, none of which
  -- collide. This one is a one-character mistake with real consequences, and
  -- the assertion is left RED until a migration changes it. See the header.
  select count(*) into n_rows
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'guest_link_booking'
     and p.prosrc like '%P0004%';
  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'no guest-link refusal uses the reserved assert_failure errcode', '0',
     n_rows::text || ' function(s) raise P0004', n_rows = 0);

  begin
    execute 'set local role anon';
    perform public.guest_portal_journey(tok_expired);
    err := 'NO ERROR — AN EXPIRED LINK RESOLVED';
  exception when others then err := sqlerrm;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('token', 'an expired link resolves to nothing', 'refused',
     err, err <> 'NO ERROR — AN EXPIRED LINK RESOLVED');

  ---------------------------------------------------------------------------
  -- 4 · 0038 — a cancelled stay discloses nothing operational.
  --
  -- Both bookings below were confirmed by the guest AND manually released by
  -- an operator. Before 0038 all three clauses said "disclose". The guard has
  -- to beat every one of them, which is why it is tested here with both
  -- overrides deliberately switched on.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role anon';
    j := public.guest_portal_journey(tok_cancel);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j := null;
  end;
  execute 'reset role';

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'cancelled + confirmed + manually released: arrival NOT released', 'false',
     coalesce(j->'arrival'->>'released','null') || coalesce(' err=' || err, ''),
     coalesce((j->'arrival'->>'released') = 'false', false));

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'cancelled booking discloses no access code', 'null',
     coalesce(j->'arrival'->>'accessCode','null'),
     j->'arrival'->>'accessCode' is null);

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'cancelled booking discloses no street address', 'null',
     coalesce(j->'arrival'->>'addressLine1','null'),
     j->'arrival'->>'addressLine1' is null);

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'cancelled booking discloses no directions', 'null',
     coalesce(j->'arrival'->>'directions','null'),
     j->'arrival'->>'directions' is null);

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'cancelled booking discloses no parking notes', 'null',
     coalesce(j->'arrival'->>'parking','null'),
     j->'arrival'->>'parking' is null);

  -- The door code must not appear anywhere in the payload, not merely be
  -- absent from the field a reviewer thought to check.
  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'DOORCODE-A appears nowhere in a cancelled payload', 'absent',
     case when coalesce(j::text,'') like '%DOORCODE-A%' then 'PRESENT' else 'absent' end,
     coalesce(j::text,'') not like '%DOORCODE-A%');

  -- The link itself still works. 0038 withholds the secret, not the page: a
  -- cancelled guest must still be able to see that it was cancelled.
  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'a cancelled booking''s portal still opens', 'cancelled',
     coalesce(j->'current'->>'status','null'),
     coalesce(j->'current'->>'status' = 'cancelled', false));

  begin
    execute 'set local role anon';
    j := public.guest_portal_journey(tok_noshow);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j := null;
  end;
  execute 'reset role';

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'no_show + confirmed + manually released: arrival NOT released', 'false',
     coalesce(j->'arrival'->>'released','null') || coalesce(' err=' || err, ''),
     coalesce((j->'arrival'->>'released') = 'false', false));

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'no_show booking discloses no access code', 'null',
     coalesce(j->'arrival'->>'accessCode','null'),
     j->'arrival'->>'accessCode' is null);

  -- CONTROL. Without this the whole section would pass if the function had
  -- simply stopped disclosing arrival details to anybody.
  begin
    execute 'set local role anon';
    j := public.guest_portal_journey(tok_future);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j := null;
  end;
  execute 'reset role';

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'CONTROL: a confirmed booking DOES release arrival', 'true',
     coalesce(j->'arrival'->>'released','null') || coalesce(' err=' || err, ''),
     coalesce((j->'arrival'->>'released') = 'true', false));

  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'CONTROL: a confirmed booking DOES disclose its access code', 'DOORCODE-A',
     coalesce(j->'arrival'->>'accessCode','null'),
     coalesce(j->'arrival'->>'accessCode' = 'DOORCODE-A', false));

  -- The same decision taken directly, on composite values, with no table and
  -- no projection in the way. If the projection above ever stops calling the
  -- function, this keeps the function itself honest.
  v_booking.status := 'cancelled'::public.booking_status;
  v_settings.arrival_release := 'after_confirmation';
  v_settings.arrival_release_hours := 24;
  v_journey.manual_released_at := now();
  released := public.guest_arrival_released(v_booking, v_settings, v_journey, true, true, now());
  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'guest_arrival_released() itself refuses a cancelled booking', 'false',
     coalesce(released::text,'null'), released is false);

  v_booking.status := 'no_show'::public.booking_status;
  released := public.guest_arrival_released(v_booking, v_settings, v_journey, true, true, now());
  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'guest_arrival_released() itself refuses a no_show booking', 'false',
     coalesce(released::text,'null'), released is false);

  v_booking.status := 'confirmed'::public.booking_status;
  v_journey.manual_released_at := null;
  released := public.guest_arrival_released(v_booking, v_settings, v_journey, true, false, now());
  insert into journey_results (area, name, expected, actual, passed) values
    ('cancelled', 'CONTROL: guest_arrival_released() still releases a confirmed booking', 'true',
     coalesce(released::text,'null'), released is true);

  ---------------------------------------------------------------------------
  -- 5 · The wifi password is gated by the stay, not by the arrival gate.
  --
  -- These two gates are independent in 0034 and the pair of assertions below
  -- is what proves it, in both directions:
  --
  --   bk_future  arrival OPEN,   stay not begun  →  wifi must be withheld
  --   bk_unconf  arrival CLOSED, stay in progress →  wifi must be given
  --
  -- Either one alone would be satisfied by a single shared flag.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role anon';
    j := public.guest_portal_journey(tok_future);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j := null;
  end;
  execute 'reset role';

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'arrival is released for the future booking (premise)', 'true',
     coalesce(j->'arrival'->>'released','null') || coalesce(' err=' || err, ''),
     coalesce((j->'arrival'->>'released') = 'true', false));

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'wifi password withheld before the stay, though arrival is released', 'null',
     coalesce(j->'stay'->>'wifiPassword','null'),
     j->'stay'->>'wifiPassword' is null);

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'WIFIPASS-A appears nowhere in a pre-stay payload', 'absent',
     case when coalesce(j::text,'') like '%WIFIPASS-A%' then 'PRESENT' else 'absent' end,
     coalesce(j::text,'') not like '%WIFIPASS-A%');

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'property guide withheld before the stay', 'null',
     coalesce(j->'stay'->>'propertyGuide','null'),
     j->'stay'->>'propertyGuide' is null);

  begin
    execute 'set local role anon';
    j := public.guest_portal_journey(tok_unconf);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j := null;
  end;
  execute 'reset role';

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'arrival NOT released for the unconfirmed booking (premise)', 'false',
     coalesce(j->'arrival'->>'released','null') || coalesce(' err=' || err, ''),
     coalesce((j->'arrival'->>'released') = 'false', false));

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'CONTROL: wifi password IS given once the stay has begun', 'WIFIPASS-A',
     coalesce(j->'stay'->>'wifiPassword','null'),
     coalesce(j->'stay'->>'wifiPassword' = 'WIFIPASS-A', false));

  -- The independence, stated as one assertion: this booking hands over the
  -- wifi while still withholding the door code.
  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'the two gates are independent: wifi given, access code still withheld', 'wifi=yes code=null',
     'wifi=' || case when j->'stay'->>'wifiPassword' is not null then 'yes' else 'no' end ||
     ' code=' || coalesce(j->'arrival'->>'accessCode','null'),
     j->'stay'->>'wifiPassword' is not null and j->'arrival'->>'accessCode' is null);

  ---------------------------------------------------------------------------
  -- 6 · OPEN DEFECT — a cancelled stay still hands over the wifi password.
  --
  -- `v_in_stay` in 0034 §9 is `status in ('checked_in','in_house',
  -- 'checkout_pending') or (current_date between check_in and check_out)`.
  -- The calendar arm never consults the cancellation guard 0038 added, so a
  -- booking cancelled during what would have been the stay keeps returning
  -- `wifiPassword`, `wifiNetwork`, `propertyGuide` and `emergencyContact` for
  -- the rest of the original date range.
  --
  -- This is the same defect 0038 fixed, in the field group immediately below
  -- the one it fixed. The wifi password is a credential to the property's
  -- network, handed to somebody whose stay is not happening.
  --
  -- The two assertions below state what security requires. They are RED
  -- against the current schema and are meant to be: the fix is a migration,
  -- not an edit to this file. See the header.
  ---------------------------------------------------------------------------
  begin
    execute 'set local role anon';
    j := public.guest_portal_journey(tok_cancel);
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; j := null;
  end;
  execute 'reset role';

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'a cancelled stay discloses no wifi password', 'null',
     coalesce(j->'stay'->>'wifiPassword','null'),
     j->'stay'->>'wifiPassword' is null);

  insert into journey_results (area, name, expected, actual, passed) values
    ('stay', 'a cancelled stay discloses no property guide', 'null',
     coalesce(j->'stay'->>'propertyGuide','null'),
     j->'stay'->>'propertyGuide' is null);

  ---------------------------------------------------------------------------
  -- 7 · The operator side of these tables still isolates by organization.
  --
  -- The portal is one door onto this data; the dashboard is the other. These
  -- assert the ordinary tenant rule as a real `authenticated` session, so a
  -- policy loosened to make the portal work cannot quietly open the operator
  -- side too.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', usr_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.guest_journey_content
      where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A sees none of B''s guest_journey_content', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.guest_journey_content;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'CONTROL: operator A does see its own guest_journey_content', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.guest_requests where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A sees none of B''s guest_requests', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.guest_requests;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'CONTROL: operator A does see its own guest_requests', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.booking_guest_journey where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A sees none of B''s booking_guest_journey', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.booking_guest_confirmations where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A sees none of B''s booking_guest_confirmations', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.guest_contract_templates where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A sees none of B''s guest_contract_templates', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.guest_link_sends where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A sees none of B''s guest_link_sends', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- A token is not a tenant boundary crossing either: operator A must not be
  -- able to write into B's journey rows even though the portal can read them.
  begin
    execute 'set local role authenticated';
    insert into public.guest_requests
      (organization_id, booking_id, property_id, category, client_key, body)
      values (org_b, bk_b, prop_b, 'other', 'journey-smuggled', 'smuggled');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A cannot insert a guest_request into B', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    update public.guest_journey_content set access_code = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A cannot rewrite B''s access code', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.guest_journey_content set access_code = 'ROTATED-A' where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'CONTROL: operator A CAN rotate its own access code', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- Stealing a token does not help an operator either: the guest_token column
  -- of another organization's booking must not be readable.
  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.bookings where id = bk_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into journey_results (area, name, expected, actual, passed) values
    ('operator', 'operator A cannot read B''s booking (and so cannot read its token)', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The tally is appended as a final row so the whole run is one result set.
insert into journey_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from journey_results;

select seq, area, name, expected, actual, passed from journey_results order by seq;

rollback;
