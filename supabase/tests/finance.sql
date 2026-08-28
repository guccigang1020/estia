-- ============================================================================
-- finance.sql — ESTIA · proof that a refund is bounded by what was taken
--
-- What this is
--   The evidence for 0016_finance.sql. The first section is the one that
--   matters: 0010 bounded refunds by `amount_agorot`, which is what was *asked
--   for*, so the database's own constraint permitted refunding ₪600 against a
--   payment where only ₪400 had been captured. That is money out of the
--   business, allowed by the constraint that was supposed to stop it.
--
--   Before the fix, run as the owner with no application in the way:
--
--       refund of 60000 against 40000 captured  ->  ACCEPTED
--       CHECK (amount_refunded_agorot <= amount_agorot)
--
--   After:
--
--       refund of 60000 against 40000 captured  ->  23514
--       CHECK (amount_refunded_agorot <= captured_agorot)
--
--   The assertions below re-prove that on every run, together with the
--   controls that stop it being a blanket refusal.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/finance.sql
--
--   One transaction, ending in ROLLBACK. One row per assertion plus a TOTAL.
--
-- Depends on
--   0001 … 0016, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table finance_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := '11111111-6666-4111-8111-111111111111';
  org_b   constant uuid := '22222222-6666-4222-8222-222222222222';
  user_a  constant uuid := 'aaaaaaaa-6666-4000-8000-00000000000a';
  user_b  constant uuid := 'bbbbbbbb-6666-4000-8000-00000000000b';
  agent_1 constant uuid := 'e1111111-6666-4000-8000-00000000000a';
  mem_a   constant uuid := 'dddddddd-6666-4000-8000-00000000000a';
  mem_b   constant uuid := 'dddddddd-6666-4000-8000-00000000000b';

  owner_role uuid;
  prop_a  uuid; prop_b  uuid;
  unit_a  uuid; unit_b  uuid;
  guest_a uuid; guest_b uuid;
  bk_a    uuid; bk_b    uuid;
  pay_a   uuid; pay_b   uuid;
  sched_a uuid;
  inv_a   uuid;
  cn_a    uuid;
  rule_a  uuid; rule_b uuid;
  stmt_a  uuid;
  snap_at timestamptz := '2027-03-01 09:00:00+00';

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
    (user_a, 'fin-a@estia.test'), (user_b, 'fin-b@estia.test'),
    (agent_1, 'fin-agent@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'fin-org-a', 'Finance Organization A'),
    (org_b, 'fin-org-b', 'Finance Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now());
  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role), (mem_b, org_b, owner_role);
  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'), (mem_b, org_b, 'all_organization');

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'fin-villa-a', 'Finance Villa A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'fin-villa-b', 'Finance Villa B', 'active') returning id into prop_b;

  insert into public.units (organization_id, property_id, code, name, status) values
    (org_a, prop_a, 'FA', 'Finance Unit A', 'active') returning id into unit_a;
  insert into public.units (organization_id, property_id, code, name, status) values
    (org_b, prop_b, 'FB', 'Finance Unit B', 'active') returning id into unit_b;

  insert into public.guests (organization_id, full_name, phone) values
    (org_a, 'Finance Guest A', '050-660-0001') returning id into guest_a;
  insert into public.guests (organization_id, full_name, phone) values
    (org_b, 'Finance Guest B', '050-660-0002') returning id into guest_b;

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_a, prop_a, unit_a, guest_a, 'confirmed', '2027-03-10', '2027-03-15', user_a)
  returning id into bk_a;
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_b, prop_b, unit_b, guest_b, 'confirmed', '2027-03-10', '2027-03-15', user_b)
  returning id into bk_b;

  ---------------------------------------------------------------------------
  -- 1 · THE MONEY BUG. Authorized 1,000; captured 400; refund 600 refused.
  ---------------------------------------------------------------------------
  insert into finance_results (area, name, expected, actual, passed) values
    ('overrefund', 'the ceiling is measured against captured_agorot, not amount_agorot',
     'captured_agorot',
     (select case when pg_get_constraintdef(oid) like '%captured_agorot%'
                  then 'captured_agorot' else pg_get_constraintdef(oid) end
        from pg_constraint where conname = 'payments_refunded_within_captured'),
     (select pg_get_constraintdef(oid) like '%captured_agorot%'
        from pg_constraint where conname = 'payments_refunded_within_captured'));

  insert into public.payments
    (organization_id, property_id, booking_id, status, method, purpose, channel,
     amount_agorot, authorized_agorot, captured_agorot, paid_at, created_by)
  values
    (org_a, prop_a, bk_a, 'partially_paid', 'card', 'security_deposit', 'hosted_page',
     100000, 100000, 40000, now(), user_a)
  returning id into pay_a;

  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status,
       amount_agorot, processed_at, refunded_at, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'processed', 60000, now(), now(), user_a);
    err := 'ACCEPTED — STILL BROKEN';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('overrefund', 'refunding 60000 against 40000 captured is refused',
     '23514', err, err = '23514');

  -- The control. Without it the assertion above could hold on a schema that
  -- refuses every refund.
  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status,
       amount_agorot, processed_at, refunded_at, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'processed', 40000, now(), now(), user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'refunding exactly what was captured is accepted', 'ok', err, err = 'ok');

  insert into finance_results (area, name, expected, actual, passed) values
    ('overrefund', 'the refunded total is maintained by the trigger, not the caller',
     '40000',
     (select amount_refunded_agorot::text from public.payments where id = pay_a),
     (select amount_refunded_agorot from public.payments where id = pay_a) = 40000);

  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status,
       amount_agorot, processed_at, refunded_at, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'processed', 1, now(), now(), user_a);
    err := 'ACCEPTED — ONE AGORA PAST THE CAPTURED TOTAL';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('overrefund', 'one agora past the captured total is refused', '23514', err, err = '23514');

  -- A refund that has only been requested is not money and must not count.
  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status,
       amount_agorot, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'requested', 99999, user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('overrefund', 'a merely requested refund is allowed and does not move the total',
     'ok', err, err = 'ok');
  insert into finance_results (area, name, expected, actual, passed) values
    ('overrefund', 'the refunded total is unchanged by a requested refund', '40000',
     (select amount_refunded_agorot::text from public.payments where id = pay_a),
     (select amount_refunded_agorot from public.payments where id = pay_a) = 40000);

  -- Neither amount may exceed what was asked for.
  begin
    update public.payments set captured_agorot = 200000 where id = pay_a;
    err := 'ACCEPTED — CAPTURED MORE THAN REQUESTED';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('overrefund', 'capturing more than was requested is refused', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 2 · The refund vocabulary
  ---------------------------------------------------------------------------
  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'refund_status';
  want := array['requested','approved','rejected','processed','failed','unknown'];
  insert into finance_results (area, name, expected, actual, passed) values
    ('contract', 'refund_status matches REFUND_STATUSES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  insert into finance_results (area, name, expected, actual, passed) values
    ('contract', 'refunds.status is refund_status and not payment_status', 'refund_status',
     (select format_type(atttypid, null) from pg_attribute
       where attrelid = 'public.refunds'::regclass and attname = 'status'),
     (select format_type(atttypid, null) from pg_attribute
       where attrelid = 'public.refunds'::regclass and attname = 'status') = 'refund_status');

  insert into finance_results (area, name, expected, actual, passed) values
    ('contract', 'refunds carries approval_status on the shared vocabulary', 'approval_status',
     (select format_type(atttypid, null) from pg_attribute
       where attrelid = 'public.refunds'::regclass and attname = 'approval_status'),
     (select format_type(atttypid, null) from pg_attribute
       where attrelid = 'public.refunds'::regclass and attname = 'approval_status') = 'approval_status');

  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status, amount_agorot, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'processed', 1, user_a);
    err := 'ACCEPTED — PROCESSED WITH NO MOMENT';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('refund', 'a processed refund must record when', '23514', err, err = '23514');

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'payment_purpose';
  want := array['deposit','balance','full','instalment','partial','security_deposit','fee'];
  insert into finance_results (area, name, expected, actual, passed) values
    ('contract', 'payment_purpose matches PAYMENT_PURPOSES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'collection_channel';
  want := array['payment_link','hosted_page','terminal','manual'];
  insert into finance_results (area, name, expected, actual, passed) values
    ('contract', 'collection_channel matches COLLECTION_CHANNELS exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  -- Cash is excludable from provider reconciliation because the channel says so.
  insert into public.payments
    (organization_id, property_id, booking_id, status, method, purpose, channel,
     amount_agorot, captured_agorot, paid_at, created_by)
  values (org_a, prop_a, bk_a, 'paid', 'cash', 'balance', 'manual',
          20000, 20000, now(), user_a);
  insert into finance_results (area, name, expected, actual, passed) values
    ('reconcile', 'cash is separable from provider payments by channel', '1',
     (select count(*)::text from public.payments
       where organization_id = org_a and channel = 'manual'),
     (select count(*) from public.payments
       where organization_id = org_a and channel = 'manual') = 1);

  -- An unknown payment has to say when it became unknown.
  begin
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot, created_by)
    values (org_a, prop_a, bk_a, 'unknown', 'card', 5000, user_a);
    err := 'ACCEPTED — UNKNOWN WITH NO MOMENT';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('attention', 'an unknown payment must record when it became unknown',
     '23514', err, err = '23514');

  begin
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot,
       unknown_since, requires_attention, created_by)
    values (org_a, prop_a, bk_a, 'unknown', 'card', 5000, now(), 'reconcile_unknown', user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'an unknown payment with a moment and a flag is accepted', 'ok', err, err = 'ok');

  ---------------------------------------------------------------------------
  -- 3 · Provider events: duplicate and out-of-order webhooks
  ---------------------------------------------------------------------------
  insert into public.payment_provider_events
    (organization_id, payment_id, provider, event_id, event_type, occurred_at, payload)
  values (org_a, pay_a, 'stripe', 'evt_1', 'payment_intent.succeeded',
          now() - interval '1 minute', '{"ok":true}'::jsonb);

  begin
    insert into public.payment_provider_events
      (organization_id, payment_id, provider, event_id, event_type, payload)
    values (org_a, pay_a, 'stripe', 'evt_1', 'payment_intent.succeeded', '{}'::jsonb);
    err := 'ACCEPTED — DUPLICATE WEBHOOK';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('webhook', 'a duplicate provider event is refused at the index', '23505', err, err = '23505');

  -- The same event id from a different provider is a different event.
  begin
    insert into public.payment_provider_events
      (organization_id, payment_id, provider, event_id, event_type, payload)
    values (org_a, pay_a, 'tranzila', 'evt_1', 'capture', '{}'::jsonb);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'the same event id from another provider is accepted', 'ok', err, err = 'ok');

  -- And in another organization: keys are scoped per tenant, as everywhere.
  begin
    insert into public.payment_provider_events
      (organization_id, provider, event_id, event_type, payload)
    values (org_b, 'stripe', 'evt_1', 'payment_intent.succeeded', '{}'::jsonb);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'the same event id in another organization is accepted', 'ok', err, err = 'ok');

  -- An event about a payment we have not seen is recorded, not dropped.
  insert into finance_results (area, name, expected, actual, passed) values
    ('webhook', 'an unmatched event is kept with a null payment', '1',
     (select count(*)::text from public.payment_provider_events
       where organization_id = org_b and payment_id is null),
     (select count(*) from public.payment_provider_events
       where organization_id = org_b and payment_id is null) = 1);

  ---------------------------------------------------------------------------
  -- 4 · Payment schedules
  ---------------------------------------------------------------------------
  insert into public.payment_schedules
    (organization_id, property_id, booking_id, total_agorot, cadence, created_by)
  values (org_a, prop_a, bk_a, 300000, 'monthly', user_a)
  returning id into sched_a;

  insert into public.payment_schedule_instalments
    (schedule_id, organization_id, instalment_number, amount_agorot, due_on, purpose)
  values
    (sched_a, org_a, 1, 100000, '2027-01-01', 'deposit'),
    (sched_a, org_a, 2, 100000, '2027-02-01', 'instalment'),
    (sched_a, org_a, 3, 100000, '2027-03-01', 'balance');

  begin
    insert into public.payment_schedule_instalments
      (schedule_id, organization_id, instalment_number, amount_agorot, due_on)
    values (sched_a, org_a, 1, 50000, '2027-01-15');
    err := 'ACCEPTED — TWO INSTALMENTS WITH ONE NUMBER';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('schedule', 'two instalments cannot share a number', '23505', err, err = '23505');

  begin
    update public.payments
       set schedule_id = sched_a, instalment_number = 1, due_on = '2027-01-01'
     where id = pay_a;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'a payment can be attached to an instalment', 'ok', err, err = 'ok');

  begin
    update public.payments set schedule_id = sched_a, instalment_number = null where id = pay_a;
    err := 'ACCEPTED — A SCHEDULE WITH NO INSTALMENT NUMBER';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('schedule', 'a schedule reference without an instalment number is refused',
     '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 5 · finance_snapshots: a rule change cannot rewrite last month
  ---------------------------------------------------------------------------
  insert into public.finance_snapshots
    (organization_id, booking_id, captured_at, property_id, unit_id, captured_by,
     reason, revision, check_in, check_out, nights, guests,
     lines, total_agorot, stay_total_agorot, tax_agorot, tax_rate_percent)
  values
    (org_a, bk_a, snap_at, prop_a, unit_a, user_a,
     'booking confirmed', 1, '2027-03-10', '2027-03-15', 5, 2,
     '[{"kind":"accommodation","label":"5 nights","amount":500000,"quantity":5,"date":null}]'::jsonb,
     500000, 500000, 72650, 17.0);

  begin
    insert into public.finance_snapshots
      (organization_id, booking_id, captured_at, unit_id, reason, revision,
       check_in, check_out, nights, guests)
    values (org_a, bk_a, snap_at, unit_a, 'duplicate capture', 1,
            '2027-03-10', '2027-03-15', 5, 2);
    err := 'ACCEPTED — TWO SNAPSHOTS AT ONE INSTANT';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('snapshot', 'two captures at one instant are one capture', '23505', err, err = '23505');

  begin
    update public.finance_snapshots set total_agorot = 1
     where organization_id = org_a and booking_id = bk_a;
    err := 'ACCEPTED — A SNAPSHOT WAS REWRITTEN';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('snapshot', 'a snapshot cannot be updated, even by the owner', '42501', err, err = '42501');

  begin
    delete from public.finance_snapshots
     where organization_id = org_a and booking_id = bk_a;
    err := 'ACCEPTED — A SNAPSHOT WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('snapshot', 'a snapshot cannot be deleted, even by the owner', '42501', err, err = '42501');

  -- Re-snapshotting is the sanctioned way, and it retains the original.
  begin
    insert into public.finance_snapshots
      (organization_id, booking_id, captured_at, property_id, unit_id, captured_by,
       reason, revision, supersedes_captured_at, check_in, check_out, nights, guests,
       total_agorot, stay_total_agorot)
    values (org_a, bk_a, snap_at + interval '1 day', prop_a, unit_a, user_a,
            'guest added a night', 2, snap_at, '2027-03-10', '2027-03-16', 6, 2,
            600000, 600000);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'a re-snapshot with a reason is accepted', 'ok', err, err = 'ok');

  insert into finance_results (area, name, expected, actual, passed) values
    ('snapshot', 'the superseded capture is retained', '2',
     (select count(*)::text from public.finance_snapshots
       where organization_id = org_a and booking_id = bk_a),
     (select count(*) from public.finance_snapshots
       where organization_id = org_a and booking_id = bk_a) = 2);

  insert into finance_results (area, name, expected, actual, passed) values
    ('snapshot', 'the original still says 500000 after the revision', '500000',
     (select total_agorot::text from public.finance_snapshots
       where organization_id = org_a and booking_id = bk_a and captured_at = snap_at),
     (select total_agorot from public.finance_snapshots
       where organization_id = org_a and booking_id = bk_a and captured_at = snap_at) = 500000);

  begin
    insert into public.finance_snapshots
      (organization_id, booking_id, captured_at, unit_id, reason, revision,
       check_in, check_out, nights, guests)
    values (org_a, bk_a, snap_at + interval '2 days', unit_a, '  ', 3,
            '2027-03-10', '2027-03-15', 5, 2);
    err := 'ACCEPTED — A BLANK REASON';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('snapshot', 'a snapshot demands a stated reason', '23514', err, err = '23514');

  begin
    insert into public.finance_snapshots
      (organization_id, booking_id, captured_at, unit_id, reason, revision,
       check_in, check_out, nights, guests)
    values (org_a, bk_a, snap_at + interval '3 days', unit_a, 'no predecessor named', 2,
            '2027-03-10', '2027-03-15', 5, 2);
    err := 'ACCEPTED — A REVISION THAT SUPERSEDES NOTHING';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('snapshot', 'a later revision must name what it replaced', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 6 · Expense rules and allocations
  ---------------------------------------------------------------------------
  insert into public.expense_rules
    (organization_id, label, category, kind, frequency, amount_agorot,
     allocation, scope_kind, created_by)
  values (org_a, 'Cleaning contract', 'housekeeping', 'fixed', 'monthly',
          400000, 'per_occupied_night', 'organization', user_a)
  returning id into rule_a;

  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'a new expense rule starts at version 1', '1',
     (select version::text from public.expense_rules where id = rule_a),
     (select version from public.expense_rules where id = rule_a) = 1);

  update public.expense_rules set amount_agorot = 450000, updated_by = user_a where id = rule_a;
  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'editing an expense rule bumps its version', '2',
     (select version::text from public.expense_rules where id = rule_a),
     (select version from public.expense_rules where id = rule_a) = 2);

  -- A variable rule needs a formula; a fixed one must not have any.
  begin
    insert into public.expense_rules
      (organization_id, label, category, kind, created_by)
    values (org_a, 'Broken variable', 'other', 'variable', user_a);
    err := 'ACCEPTED — A VARIABLE RULE WITH NO FORMULA';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'a variable rule with no formula is refused', '23514', err, err = '23514');

  begin
    insert into public.expense_rules
      (organization_id, label, category, kind, formula, created_by)
    values (org_a, 'Broken fixed', 'other', 'fixed',
            '{"kind":"per_night","rateAgorot":100}'::jsonb, user_a);
    err := 'ACCEPTED — A FIXED RULE WITH A FORMULA';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'a fixed rule carrying a formula is refused', '23514', err, err = '23514');

  begin
    insert into public.expense_rules
      (organization_id, label, category, kind, formula, created_by)
    values (org_a, 'Unknown formula', 'other', 'variable',
            '{"kind":"per_fortnight","rateAgorot":100}'::jsonb, user_a);
    err := 'ACCEPTED — AN UNKNOWN FORMULA KIND';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'an unknown formula kind is refused', '23514', err, err = '23514');

  -- A property-scoped rule that names no property cannot be applied.
  begin
    insert into public.expense_rules
      (organization_id, label, category, scope_kind, created_by)
    values (org_a, 'Scoped to nothing', 'other', 'property', user_a);
    err := 'ACCEPTED — A PROPERTY RULE WITH NO PROPERTY';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'a property-scoped rule must name a property', '23514', err, err = '23514');

  begin
    insert into public.expense_rules
      (organization_id, label, category, kind, formula, allocation, created_by)
    values (org_a, 'Per night linen', 'housekeeping', 'variable',
            '{"kind":"per_night","rateAgorot":1500}'::jsonb, 'per_occupied_night', user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'a well-formed variable rule is accepted', 'ok', err, err = 'ok');

  insert into public.expense_allocations
    (organization_id, rule_id, rule_version, booking_id, method,
     period_start, period_end, amount_agorot, weight, allocated_by)
  values (org_a, rule_a, 2, bk_a, 'per_occupied_night',
          '2027-03-01', '2027-04-01', 90000, 0.2, user_a);

  begin
    insert into public.expense_allocations
      (organization_id, rule_id, rule_version, booking_id, method,
       period_start, period_end, amount_agorot, allocated_by)
    values (org_a, rule_a, 2, bk_a, 'per_occupied_night',
            '2027-03-01', '2027-04-01', 90000, user_a);
    err := 'ACCEPTED — THE SAME BOOKING CHARGED TWICE';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'a second allocation run cannot charge the same booking twice',
     '23505', err, err = '23505');

  begin
    delete from public.expense_rules where id = rule_a;
    err := 'ACCEPTED — A RULE WITH ALLOCATIONS WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('expense', 'a rule that has been allocated cannot be deleted', '23503', err, err = '23503');

  ---------------------------------------------------------------------------
  -- 7 · Commission statements, batches and clawback
  ---------------------------------------------------------------------------
  insert into public.commission_statements
    (organization_id, agent_user_id, period_start, period_end, total_agorot,
     issued_at, created_by)
  values (org_a, agent_1, '2027-03-01', '2027-04-01', 50000, now(), user_a)
  returning id into stmt_a;

  begin
    insert into public.commission_statements
      (organization_id, agent_user_id, period_start, period_end, created_by)
    values (org_a, agent_1, '2027-03-01', '2027-04-01', user_a);
    err := 'ACCEPTED — TWO STATEMENTS FOR ONE MONTH';
  exception when others then err := sqlstate;
  end;
  insert into finance_results (area, name, expected, actual, passed) values
    ('statement', 'one statement per agent per period', '23505', err, err = '23505');

  insert into finance_results (area, name, expected, actual, passed) values
    ('commission', 'commissions carry statement_id, payout_batch_id and clawback_required', '3',
     (select count(*)::text from information_schema.columns
       where table_schema='public' and table_name='commissions'
         and column_name in ('statement_id','payout_batch_id','clawback_required')),
     (select count(*) from information_schema.columns
       where table_schema='public' and table_name='commissions'
         and column_name in ('statement_id','payout_batch_id','clawback_required')) = 3);

  ---------------------------------------------------------------------------
  -- 8 · Documents that itemise, and archival that is not a status
  ---------------------------------------------------------------------------
  insert into public.invoices
    (organization_id, property_id, booking_id, kind, status, series, year, number,
     display_number, customer_name, subtotal_agorot, tax_agorot, total_agorot,
     issued_at, snapshot_captured_at, created_by)
  values (org_a, prop_a, bk_a, 'tax_invoice', 'issued', 'default', 2027, 1,
          '2027-000001', 'Finance Guest A', 327778, 55722, 383500,
          now(), snap_at, user_a)
  returning id into inv_a;

  insert into public.invoice_lines
    (organization_id, invoice_id, kind, label, amount_agorot, quantity, sort_order)
  values
    (org_a, inv_a, 'accommodation', '5 nights', 300000, 5, 1),
    (org_a, inv_a, 'cleaning_fee', 'Cleaning', 27778, 1, 2),
    (org_a, inv_a, 'tax', 'VAT 17%', 55722, 1, 3);

  insert into finance_results (area, name, expected, actual, passed) values
    ('document', 'the invoice lines add up to the invoice total', '383500',
     (select sum(amount_agorot)::text from public.invoice_lines where invoice_id = inv_a),
     (select sum(amount_agorot) from public.invoice_lines where invoice_id = inv_a) = 383500);

  insert into finance_results (area, name, expected, actual, passed) values
    ('document', 'why 3,835.00 is answerable from the document itself', '3',
     (select count(*)::text from public.invoice_lines where invoice_id = inv_a),
     (select count(*) from public.invoice_lines where invoice_id = inv_a) = 3);

  -- Archival leaves the status alone: an archived tax invoice is still in force.
  update public.invoices set archived_at = now(), archived_by = user_a where id = inv_a;
  insert into finance_results (area, name, expected, actual, passed) values
    ('document', 'archiving an invoice does not change its status', 'issued',
     (select status::text from public.invoices where id = inv_a),
     (select status from public.invoices where id = inv_a) = 'issued');
  insert into finance_results (area, name, expected, actual, passed) values
    ('document', 'archival is its own column', 'true',
     (select (archived_at is not null)::text from public.invoices where id = inv_a),
     (select archived_at is not null from public.invoices where id = inv_a));

  insert into public.credit_notes
    (organization_id, property_id, invoice_id, booking_id, status, series, year,
     number, amount_agorot, reason, issued_at, created_by)
  values (org_a, prop_a, inv_a, bk_a, 'issued', 'credit', 2027, 1,
          100000, 'one night removed', now(), user_a)
  returning id into cn_a;

  insert into public.credit_note_lines
    (organization_id, credit_note_id, kind, label, amount_agorot, quantity)
  values (org_a, cn_a, 'accommodation', '1 night', 100000, 1);

  insert into finance_results (area, name, expected, actual, passed) values
    ('document', 'a credit note itemises too, with a positive amount', '100000',
     (select sum(amount_agorot)::text from public.credit_note_lines where credit_note_id = cn_a),
     (select sum(amount_agorot) from public.credit_note_lines where credit_note_id = cn_a) = 100000);

  -- Deleting the document takes its lines with it, and only that way.
  insert into finance_results (area, name, expected, actual, passed) values
    ('document', 'the invoice line count before the document is touched', '3',
     (select count(*)::text from public.invoice_lines where invoice_id = inv_a),
     (select count(*) from public.invoice_lines where invoice_id = inv_a) = 3);

  ---------------------------------------------------------------------------
  -- 9 · Tenant isolation
  ---------------------------------------------------------------------------
  -- Give organization B one of each, so "0 of B's" is a real zero.
  insert into public.payments
    (organization_id, property_id, booking_id, status, method, amount_agorot,
     captured_agorot, paid_at, created_by)
  values (org_b, prop_b, bk_b, 'paid', 'card', 10000, 10000, now(), user_b)
  returning id into pay_b;

  insert into public.payment_schedules
    (organization_id, property_id, booking_id, total_agorot, created_by)
  values (org_b, prop_b, bk_b, 10000, user_b);

  insert into public.finance_snapshots
    (organization_id, booking_id, captured_at, property_id, unit_id, reason,
     revision, check_in, check_out, nights, guests)
  values (org_b, bk_b, snap_at, prop_b, unit_b, 'B snapshot', 1,
          '2027-03-10', '2027-03-15', 5, 2);

  insert into public.expense_rules (organization_id, label, category, created_by)
  values (org_b, 'B expense', 'other', user_b) returning id into rule_b;

  insert into public.expense_allocations
    (organization_id, rule_id, rule_version, booking_id, method,
     period_start, period_end, amount_agorot)
  values (org_b, rule_b, 1, bk_b, 'per_booking', '2027-03-01', '2027-04-01', 1000);

  insert into public.commission_statements
    (organization_id, agent_user_id, period_start, period_end, created_by)
  values (org_b, agent_1, '2027-03-01', '2027-04-01', user_b);

  insert into public.invoices
    (organization_id, property_id, booking_id, status, customer_name,
     subtotal_agorot, tax_agorot, total_agorot, created_by)
  values (org_b, prop_b, bk_b, 'draft', 'B Guest', 1000, 170, 1170, user_b);

  insert into public.invoice_lines (organization_id, invoice_id, kind, label, amount_agorot)
  select org_b, i.id, 'accommodation', 'B line', 1170
    from public.invoices i where i.organization_id = org_b limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     n_all::text || coalesce(' err=' || err, ''), n_all = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_provider_events;
    select count(*) into n_other from public.payment_provider_events where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'payment_provider_events: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_schedules;
    select count(*) into n_other from public.payment_schedules where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'payment_schedules: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_schedule_instalments;
    select count(*) into n_other from public.payment_schedule_instalments where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'payment_schedule_instalments: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.finance_snapshots;
    select count(*) into n_other from public.finance_snapshots where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'finance_snapshots: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.expense_rules;
    select count(*) into n_other from public.expense_rules where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'expense_rules: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.expense_allocations;
    select count(*) into n_other from public.expense_allocations where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'expense_allocations: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.commission_statements;
    select count(*) into n_other from public.commission_statements where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'commission_statements: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.invoice_lines;
    select count(*) into n_other from public.invoice_lines where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'invoice_lines: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.credit_note_lines;
    select count(*) into n_other from public.credit_note_lines where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('select', 'credit_note_lines: none of B''s, and A''s are visible', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  -- INSERT into organization B
  begin
    execute 'set local role authenticated';
    insert into public.payment_provider_events (organization_id, provider, event_id, event_type)
      values (org_b, 'stripe', 'smuggled', 'x');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('insert', 'payment_provider_events INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.finance_snapshots
      (organization_id, booking_id, captured_at, unit_id, reason, revision,
       check_in, check_out, nights, guests)
      values (org_b, bk_b, now(), unit_b, 'smuggled', 1, '2027-03-10','2027-03-15',5,2);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('insert', 'finance_snapshots INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.expense_rules (organization_id, label, category)
      values (org_b, 'smuggled', 'other');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('insert', 'expense_rules INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.commission_statements
      (organization_id, agent_user_id, period_start, period_end)
      values (org_b, agent_1, '2027-05-01', '2027-06-01');
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('insert', 'commission_statements INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.invoice_lines (organization_id, invoice_id, kind, label, amount_agorot)
      select org_b, i.id, 'accommodation', 'smuggled', 1
        from public.invoices i where i.organization_id = org_b limit 1;
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('insert', 'invoice_lines INSERT into org B refused', '42501', err, err = '42501');

  -- UPDATE and DELETE of B's rows
  begin
    execute 'set local role authenticated';
    update public.expense_rules set label = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('update', 'expense_rules UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.commission_statements set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('update', 'commission_statements UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.payment_schedules set total_agorot = 1 where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('update', 'payment_schedules UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.invoice_lines set label = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('update', 'invoice_lines UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.expense_allocations where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('delete', 'expense_allocations DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.invoice_lines where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('delete', 'invoice_lines DELETE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- Insert-only means nobody deletes a snapshot, in any organization.
  begin
    execute 'set local role authenticated';
    delete from public.finance_snapshots where organization_id = org_a;
    err := 'NO ERROR — A SNAPSHOT WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('delete', 'finance_snapshots DELETE refused outright, own org included',
     '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 10 · Positive controls
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    insert into public.payment_provider_events
      (organization_id, payment_id, provider, event_id, event_type)
      values (org_a, pay_a, 'stripe', 'evt-control', 'capture');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'A CAN record a provider event in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.finance_snapshots
      (organization_id, booking_id, captured_at, property_id, unit_id, reason, revision,
       supersedes_captured_at, check_in, check_out, nights, guests)
      values (org_a, bk_a, snap_at + interval '5 days', prop_a, unit_a,
              'control capture', 3, snap_at + interval '1 day',
              '2027-03-10','2027-03-16',6,2);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'A CAN capture a snapshot in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.expense_rules (organization_id, label, category)
      values (org_a, 'Own organization expense', 'other');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert an expense rule in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.commission_statements
      (organization_id, agent_user_id, period_start, period_end)
      values (org_a, agent_1, '2027-04-01', '2027-05-01');
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'A CAN issue a statement in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.payment_schedules
      (organization_id, property_id, booking_id, total_agorot)
      values (org_a, prop_a, bk_a, 5000);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'A CAN create a payment schedule in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.expense_rules set category = 'ok' where id = rule_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own expense rule', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    delete from public.invoice_lines where organization_id = org_a and invoice_id = inv_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into finance_results (area, name, expected, actual, passed) values
    ('control', 'A CAN delete its own invoice lines', '3',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 3);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into finance_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from finance_results;

select seq, area, name, expected, actual, passed from finance_results order by seq;

rollback;
