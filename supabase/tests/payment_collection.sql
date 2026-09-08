-- ============================================================================
-- payment_collection.sql — ESTIA · proof that 0031's four tables keep one
--                          organization's money arrangements out of another's
--
-- What this is
--   The evidence for 0031_payment_collection.sql at the floor. That migration
--   creates four tables — `payment_collection_settings`,
--   `payment_collection_overrides`, `payment_manual_channels` and
--   `payment_proofs` — enables and forces row level security on all four, and
--   writes a policy set for each. The migration's own rehearsal asserts that
--   RLS is switched on. Switched on is not the same as working: a policy can be
--   present, enabled, forced, and still admit a stranger. This file runs the
--   actual statements.
--
--   Every assertion below is executed as a real `authenticated` session with
--   `request.jwt.claims` set the way GoTrue sets it, so `auth.uid()` returns
--   the test user and `my_organizations()`, `property_in_scope()` and
--   `has_permission()` resolve against a real membership. Nothing is asserted
--   against the owner connection, because the owner is exactly the actor RLS
--   does not constrain — the owner is used only to build the fixture.
--
--   For each of the four tables, in a session belonging to organization A:
--
--     · SELECT returns A's rows and none of B's;
--     · INSERT carrying B's organization_id is refused with 42501;
--     · UPDATE aimed at B's rows affects zero rows;
--     · DELETE aimed at B's rows affects zero rows where 0031 grants DELETE
--       (`payment_collection_overrides`, `payment_manual_channels`) and is
--       refused outright with 42501 where it does not
--       (`payment_collection_settings`, `payment_proofs` — a settings row is
--       edited and never removed, and a proof is evidence that gets rejected
--       rather than erased);
--     · and, beside each of those, a positive control: the same statement
--       aimed at organization A affects the number of rows it should.
--
--   The positive controls are not decoration. A missing GRANT produces exactly
--   the same zero as a working policy, so without them every isolation
--   assertion in this file would pass on a table nobody can reach at all.
--
--   `payment_proofs` gets more than the pattern. It holds what a guest
--   uploaded about their own payment — an opaque `storage_key` into whatever
--   implements the ProofStorage port, the file name the guest's browser sent,
--   and the guest's free-text note. A leak there is not a leak of
--   configuration; it is somebody's bank screenshot. So A is made to try to
--   read B's storage keys, file names and notes by value as well as by count,
--   and the full set of storage keys visible to A is compared against the one
--   key A is entitled to.
--
--   Finally: `anon` reaches none of the four tables. 0031 revokes every
--   privilege from `anon` on all four deliberately — the whole guest surface is
--   the two SECURITY DEFINER functions, and a guest holding a link must never
--   be able to walk the tables underneath them.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/payment_collection.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   The whole script runs inside one transaction and ends with ROLLBACK, so it
--   leaves no rows behind. It prints one row per assertion and a final tally;
--   `passed = false` anywhere is a security defect, not a flaky test.
--
-- What this file does NOT prove
--   The guest surface. `guest_collection_context()` and
--   `submit_payment_proof()` are SECURITY DEFINER and are authorized by a
--   token rather than by RLS, so they are a different proof about a different
--   mechanism. This file proves only that the tables themselves refuse a
--   member of the wrong organization.
--
-- Depends on
--   0001 … 0031, applied in order. In particular 0007, whose
--   `on_auth_user_created` trigger writes `public.user_profiles` for us — the
--   fixture below updates that row rather than inserting one.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table collection_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := 'f9000031-0000-4111-8111-00000000000a';
  org_b   constant uuid := 'f9000031-0000-4222-8222-00000000000b';
  user_a  constant uuid := 'f9a00031-0000-4000-8000-00000000000a';
  user_b  constant uuid := 'f9a00031-0000-4000-8000-00000000000b';
  mem_a   constant uuid := 'f9d00031-0000-4000-8000-00000000000a';
  mem_b   constant uuid := 'f9d00031-0000-4000-8000-00000000000b';

  -- The three guest-supplied strings on organization B's proof. A must never
  -- see any of them.
  key_b       constant text := 'collect-proof-b/receipts/2027/transfer-b.jpg';
  file_b      constant text := 'collect-proof-b-transfer.jpg';
  note_b      constant text := 'collect-proof-b note: sent from account 12-345-678901';
  key_a       constant text := 'collect-proof-a/receipts/2027/transfer-a.jpg';

  owner_role uuid;
  prop_a     uuid;
  prop_b     uuid;
  unit_a     uuid;
  unit_b     uuid;
  guest_a    uuid;
  guest_b    uuid;
  bk_a1      uuid;
  bk_a2      uuid;
  bk_b1      uuid;
  bk_b2      uuid;

  n_all   bigint;
  n_other bigint;
  n_rows  bigint;
  err     text;
  txt     text;
begin
  ---------------------------------------------------------------------------
  -- Fixture. Written as the owner, which has BYPASSRLS: setting up the world
  -- is not what is under test.
  --
  -- 0007 put `on_auth_user_created` on auth.users, which creates the
  -- user_profiles row itself. Inserting one here raises 23505 and takes the
  -- whole file with it, so the names are set with an UPDATE.
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'collect-proof-a@estia.test'),
    (user_b, 'collect-proof-b@estia.test');

  update public.user_profiles set full_name = 'Collect Proof User A' where id = user_a;
  update public.user_profiles set full_name = 'Collect Proof User B' where id = user_b;

  insert into public.organizations (id, slug, name) values
    (org_a, 'collect-proof-org-a', 'Collection Organization A'),
    (org_b, 'collect-proof-org-b', 'Collection Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now());

  -- organization_owner holds payment.policy_manage, payment.view and
  -- payment.create, which is what every policy in 0031 asks for. A user
  -- without them would fail these assertions for the wrong reason.
  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role),
    (mem_b, org_b, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'),
    (mem_b, org_b, 'all_organization');

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'collect-proof-villa-a', 'Collect Proof Villa A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'collect-proof-villa-b', 'Collect Proof Villa B', 'active') returning id into prop_b;

  insert into public.units (organization_id, property_id, code, name, status) values
    (org_a, prop_a, 'collect-proof-a', 'Collect Proof Unit A', 'active') returning id into unit_a;
  insert into public.units (organization_id, property_id, code, name, status) values
    (org_b, prop_b, 'collect-proof-b', 'Collect Proof Unit B', 'active') returning id into unit_b;

  insert into public.guests (organization_id, full_name, phone) values
    (org_a, 'Collect Proof Guest A', '050-310-0001') returning id into guest_a;
  insert into public.guests (organization_id, full_name, phone) values
    (org_b, 'Collect Proof Guest B', '050-310-0002') returning id into guest_b;

  -- Two stays per organization. The second one on each side exists so that the
  -- "insert into B is refused" and "insert into A is accepted" assertions have
  -- a booking free of the one-row-per-booking uniqueness on the overrides
  -- table, and therefore test the policy rather than a unique index.
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_a, prop_a, unit_a, guest_a, 'confirmed', '2027-03-01', '2027-03-05', user_a)
  returning id into bk_a1;
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_a, prop_a, unit_a, guest_a, 'confirmed', '2027-04-01', '2027-04-05', user_a)
  returning id into bk_a2;
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_b, prop_b, unit_b, guest_b, 'confirmed', '2027-03-01', '2027-03-05', user_b)
  returning id into bk_b1;
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_b, prop_b, unit_b, guest_b, 'confirmed', '2027-04-01', '2027-04-05', user_b)
  returning id into bk_b2;

  -- ── The four tables under test, one row per organization ─────────────────
  insert into public.payment_collection_settings
    (organization_id, policy, requirements, deposit_percent_bps,
     live_payments_enabled, guest_instructions, created_by)
  values
    (org_a, 'deposit', array['contract_signed','deposit_recorded']::public.confirmation_requirement[],
     3000, false, 'collect-proof-a instructions', user_a),
    (org_b, 'deposit', array['deposit_recorded']::public.confirmation_requirement[],
     5000, false, 'collect-proof-b instructions', user_b);

  insert into public.payment_collection_overrides
    (organization_id, property_id, booking_id, policy, reason, set_by, created_by)
  values
    (org_a, prop_a, bk_a1, 'none', 'collect-proof-a returning family', user_a, user_a),
    (org_b, prop_b, bk_b1, 'none', 'collect-proof-b corporate account', user_b, user_b);

  insert into public.payment_manual_channels
    (organization_id, channel, enabled, display_name, instructions, sort_order, created_by)
  values
    (org_a, 'bank_transfer', true, 'collect-proof-a bank', 'collect-proof-a IBAN IL00 0000 0000', 1, user_a),
    (org_a, 'cash', true, 'collect-proof-a cash', null, 2, user_a),
    (org_b, 'bank_transfer', true, 'collect-proof-b bank', 'collect-proof-b IBAN IL99 9999 9999', 1, user_b);

  -- The evidence rows. B's carries a storage key, a file name and a guest note
  -- that A must not be able to read by any route.
  insert into public.payment_proofs
    (organization_id, property_id, booking_id, storage_key, file_name, content_type,
     byte_size, submitted_by_guest, submitted_by, note, created_by)
  values
    (org_a, prop_a, bk_a1, key_a, 'collect-proof-a-transfer.jpg', 'image/jpeg',
     140000, true, null, 'collect-proof-a note', user_a),
    (org_b, prop_b, bk_b1, key_b, file_b, 'image/jpeg',
     150000, true, null, note_b, user_b);

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
  insert into collection_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  -- ═══ payment_collection_settings ═════════════════════════════════════════

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_collection_settings;
    select count(*) into n_other from public.payment_collection_settings
     where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_collection_settings: A sees its own row and none of B''s',
     'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  -- B's guest_instructions are shown to B's guests above a bank account
  -- number. A must not be able to read the string at all.
  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.payment_collection_settings
     where guest_instructions = 'collect-proof-b instructions';
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_collection_settings: B''s guest instructions invisible to A', '0',
     n_other::text || coalesce(' err=' || err, ''), n_other = 0);

  begin
    execute 'set local role authenticated';
    insert into public.payment_collection_settings
      (organization_id, policy, guest_instructions)
      values (org_b, 'full', 'smuggled into B');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('insert', 'payment_collection_settings INSERT into org B refused', '42501',
     err, err = '42501');

  begin
    execute 'set local role authenticated';
    update public.payment_collection_settings set guest_instructions = 'HACKED'
     where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('update', 'payment_collection_settings UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- 0031 grants no DELETE on this table to anybody but the owner: a settings
  -- row is one per organization and is edited, never removed. So the correct
  -- answer here is an outright refusal, not a zero.
  begin
    execute 'set local role authenticated';
    delete from public.payment_collection_settings where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('delete', 'payment_collection_settings DELETE of B refused outright', '42501',
     err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.payment_collection_settings where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('delete', 'payment_collection_settings DELETE refused in A''s own org too',
     '42501', err, err = '42501');

  -- ═══ payment_collection_overrides ════════════════════════════════════════

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_collection_overrides;
    select count(*) into n_other from public.payment_collection_overrides
     where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_collection_overrides: A sees its own row and none of B''s',
     'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  -- The reason on an override is the sentence somebody wrote about a discount
  -- given to a named guest. Reading another tenant's is reading their book.
  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.payment_collection_overrides
     where reason = 'collect-proof-b corporate account';
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_collection_overrides: B''s stated reason invisible to A', '0',
     n_other::text || coalesce(' err=' || err, ''), n_other = 0);

  begin
    execute 'set local role authenticated';
    insert into public.payment_collection_overrides
      (organization_id, property_id, booking_id, policy, reason)
      values (org_b, prop_b, bk_b2, 'none', 'smuggled into B');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('insert', 'payment_collection_overrides INSERT into org B refused', '42501',
     err, err = '42501');

  begin
    execute 'set local role authenticated';
    update public.payment_collection_overrides set reason = 'HACKED'
     where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('update', 'payment_collection_overrides UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- DELETE is granted here — removing an override is the honest way to restore
  -- the organization default — so the isolation claim is a zero, not a refusal.
  begin
    execute 'set local role authenticated';
    delete from public.payment_collection_overrides where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('delete', 'payment_collection_overrides DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- ═══ payment_manual_channels ═════════════════════════════════════════════

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_manual_channels;
    select count(*) into n_other from public.payment_manual_channels
     where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_manual_channels: A sees its own 2 rows and none of B''s',
     'total=2 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 2 and n_other = 0);

  -- The instruction text on a channel is a bank account number. This is the
  -- single most valuable string in the table.
  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.payment_manual_channels
     where instructions = 'collect-proof-b IBAN IL99 9999 9999';
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_manual_channels: B''s bank details invisible to A', '0',
     n_other::text || coalesce(' err=' || err, ''), n_other = 0);

  begin
    execute 'set local role authenticated';
    insert into public.payment_manual_channels
      (organization_id, channel, enabled, instructions)
      values (org_b, 'bit', true, 'smuggled into B');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('insert', 'payment_manual_channels INSERT into org B refused', '42501',
     err, err = '42501');

  -- Rewriting another tenant's account number is the attack that actually
  -- pays: the guest page renders whatever is in this column.
  begin
    execute 'set local role authenticated';
    update public.payment_manual_channels set instructions = 'IBAN IL13 1337 1337'
     where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('update', 'payment_manual_channels UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.payment_manual_channels where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('delete', 'payment_manual_channels DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- ═══ payment_proofs ══════════════════════════════════════════════════════
  -- The table where a leak matters most in this module: these rows are what a
  -- guest photographed of their own bank screen.

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_proofs;
    select count(*) into n_other from public.payment_proofs where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_proofs: A sees its own row and none of B''s', 'total=1 b=0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_all = 1 and n_other = 0);

  -- By value rather than by tenant id: the storage key is the handle that
  -- would fetch the file itself out of whatever implements ProofStorage.
  begin
    execute 'set local role authenticated';
    select count(*) into n_other from public.payment_proofs
     where storage_key = key_b or file_name = file_b or note = note_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_other := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_proofs: B''s storage key, file name and guest note all invisible',
     '0', n_other::text || coalesce(' err=' || err, ''), n_other = 0);

  -- And the whole set of keys A can see, listed out, so that a policy which
  -- leaked B's row under some other predicate would still be caught.
  begin
    execute 'set local role authenticated';
    select coalesce(string_agg(storage_key, ',' order by storage_key), '(none)')
      into txt from public.payment_proofs;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; txt := null;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('select', 'payment_proofs: every storage key A can see belongs to A',
     key_a, coalesce(txt, 'null') || coalesce(' err=' || err, ''), txt = key_a);

  -- A staff upload into B, shaped so that the only thing wrong with it is the
  -- organization: `submitted_by_guest` is false and `submitted_by` is the
  -- caller, which is what 0031's WITH CHECK demands of a legitimate one.
  begin
    execute 'set local role authenticated';
    insert into public.payment_proofs
      (organization_id, property_id, booking_id, storage_key, file_name,
       content_type, byte_size, submitted_by_guest, submitted_by)
      values (org_b, prop_b, bk_b2, 'collect-proof-smuggled/into-b.jpg',
              'collect-proof-smuggled.jpg', 'image/jpeg', 1000, false, user_a);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('insert', 'payment_proofs INSERT into org B refused', '42501', err, err = '42501');

  -- Accepting somebody else's proof is how an unpaid booking becomes a
  -- confirmed one.
  begin
    execute 'set local role authenticated';
    update public.payment_proofs
       set review = 'accepted', reviewed_at = now(), reviewed_by = user_a
     where organization_id = org_b;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('update', 'payment_proofs UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- 0031 grants no DELETE on proofs to anybody but the owner: a proof is
  -- evidence, and the way to dispose of one is to reject it, which is a state
  -- with a date and a decider. So the correct answer is a refusal.
  begin
    execute 'set local role authenticated';
    delete from public.payment_proofs where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('delete', 'payment_proofs DELETE of B refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.payment_proofs where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('delete', 'payment_proofs DELETE refused in A''s own org too — evidence is not erased',
     '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- Anonymous callers. 0031 revokes every privilege on all four tables from
  -- `anon`: the guest surface is the two SECURITY DEFINER functions and
  -- nothing else, so a stranger holding a link cannot walk the tables under
  -- them.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.payment_collection_settings;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot select payment_collection_settings', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.payment_collection_overrides;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot select payment_collection_overrides', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.payment_manual_channels;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot select payment_manual_channels', '42501', err, err = '42501');

  begin
    execute 'set local role anon';
    select count(*) into n_all from public.payment_proofs;
    err := 'NO ERROR — anon read ' || n_all || ' rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('anon', 'anon cannot select payment_proofs', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- Positive controls.
  --
  -- Without these, everything above proves nothing. A revoked GRANT, a policy
  -- whose USING clause is simply `false`, or a table nobody can reach at all
  -- would produce the same zeros and the same 42501s, and this file would go
  -- green while proving that the module is unusable rather than that it is
  -- isolated. Each control is the identical statement aimed at organization A,
  -- and must affect exactly the number of rows it names.
  --
  -- They mutate the fixture, so they run last.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  -- ── payment_collection_settings ─────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    update public.payment_collection_settings set guest_instructions = 'edited by A'
     where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own payment_collection_settings', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- The table holds one row per organization, so the INSERT control needs A's
  -- row gone first. Removed as the owner, which is fixture work and not the
  -- thing under test.
  execute 'reset role';
  delete from public.payment_collection_settings where organization_id = org_a;

  begin
    execute 'set local role authenticated';
    insert into public.payment_collection_settings
      (organization_id, policy, guest_instructions)
      values (org_a, 'manual', 'written by A');
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert payment_collection_settings for its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── payment_collection_overrides ────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    update public.payment_collection_overrides set reason = 'edited by A'
     where booking_id = bk_a1;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own payment_collection_overrides row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.payment_collection_overrides
      (organization_id, property_id, booking_id, policy, reason)
      values (org_a, prop_a, bk_a2, 'none', 'written by A');
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a payment_collection_overrides row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.payment_collection_overrides where booking_id = bk_a2;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own payment_collection_overrides row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── payment_manual_channels ─────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    update public.payment_manual_channels set display_name = 'edited by A'
     where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own payment_manual_channels rows', '2',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 2);

  begin
    execute 'set local role authenticated';
    insert into public.payment_manual_channels
      (organization_id, channel, enabled, instructions)
      values (org_a, 'bit', true, '050-310-0001');
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a payment_manual_channels row in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.payment_manual_channels
     where organization_id = org_a and channel = 'bit';
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own payment_manual_channels row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- ── payment_proofs ──────────────────────────────────────────────────────
  begin
    execute 'set local role authenticated';
    update public.payment_proofs
       set review = 'accepted', reviewed_at = now(), reviewed_by = user_a
     where organization_id = org_a;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN accept its own payment_proofs row', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.payment_proofs
      (organization_id, property_id, booking_id, storage_key, file_name,
       content_type, byte_size, submitted_by_guest, submitted_by)
      values (org_a, prop_a, bk_a2, 'collect-proof-a/receipts/2027/staff-upload.jpg',
              'collect-proof-a-staff.jpg', 'image/jpeg', 90000, false, user_a);
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into collection_results (area, name, expected, actual, passed) values
    ('control', 'A CAN upload a payment proof on a guest''s behalf in its own org', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- The tally is appended as a final row so the whole run is one result set.
insert into collection_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from collection_results;

select seq, area, name, expected, actual, passed from collection_results order by seq;

rollback;
