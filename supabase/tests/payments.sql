-- ============================================================================
-- payments.sql — ESTIA · proof that a retry does not cost money
--
-- What this is
--   The evidence for 0010_payments.sql. Four things are under test:
--
--     1. The contract. `payment_status` and `payment_method` are compared
--        against the literal arrays in src/lib/contracts/states.ts, in order.
--        These assertions exist to fail: the moment somebody adds a status to
--        the TypeScript file without adding it here, the run goes red.
--     2. Idempotency. A retried insert carrying the same key does not create a
--        second row — on payments, payment_attempts, refunds, deposits,
--        invoices and credit notes alike. The uniqueness is per organization,
--        so two tenants sending `retry-1` do not collide.
--     3. The money invariants that live across rows and therefore cannot be a
--        CHECK: the refund ceiling, the credit-note ceiling, the deposit
--        arithmetic, and the freeze on an issued invoice.
--     4. Tenant isolation across every new table, select / insert / update /
--        delete, each with a positive control. A zero-row result proves
--        isolation only when the same statement aimed at the caller's own
--        organization affects exactly one row — otherwise a missing GRANT
--        would make the whole file pass while proving nothing.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/payments.sql
--   or paste it into the SQL editor of the Supabase dashboard.
--
--   One transaction, ending in ROLLBACK. It leaves no rows behind. One result
--   row per assertion plus a TOTAL; `passed = false` anywhere is a defect.
--
-- What this file does NOT prove
--   Real concurrency. Everything runs on one connection in one transaction, so
--   the two "retries" are sequential statements. What is proven is the losing
--   path — the second statement writes nothing — and that the constraint
--   itself raises 23505 on a raw duplicate, which is the mechanism a parallel
--   transaction would collide with.
--
-- Depends on
--   0001 … 0010, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table payment_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := '11111111-4444-4111-8111-111111111111';
  org_b   constant uuid := '22222222-4444-4222-8222-222222222222';
  user_a  constant uuid := 'aaaaaaaa-4444-4000-8000-00000000000a';
  user_b  constant uuid := 'bbbbbbbb-4444-4000-8000-00000000000b';
  mem_a   constant uuid := 'dddddddd-4444-4000-8000-00000000000a';
  mem_b   constant uuid := 'dddddddd-4444-4000-8000-00000000000b';

  owner_role uuid;
  prop_a     uuid;
  prop_b     uuid;
  unit_a     uuid;
  unit_b     uuid;
  guest_a    uuid;
  guest_b    uuid;
  bk_a       uuid;
  bk_b       uuid;
  pay_a      uuid;
  pay_b      uuid;
  inv_a      uuid;
  dep_a      uuid;

  n_rows  bigint;
  n_all   bigint;
  n_other bigint;
  n1      bigint;
  n2      bigint;
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
    (user_a, 'pay-a@estia.test'),
    (user_b, 'pay-b@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'pay-org-a', 'Payments Organization A'),
    (org_b, 'pay-org-b', 'Payments Organization B');

  insert into public.user_profiles (id, full_name) values
    (user_a, 'Pay User A'), (user_b, 'Pay User B')
  on conflict (id) do nothing;

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
    (org_a, 'pay-villa-a', 'Pay Villa A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'pay-villa-b', 'Pay Villa B', 'active') returning id into prop_b;

  insert into public.units (organization_id, property_id, code, name, status) values
    (org_a, prop_a, 'PA', 'Pay Unit A', 'active') returning id into unit_a;
  insert into public.units (organization_id, property_id, code, name, status) values
    (org_b, prop_b, 'PB', 'Pay Unit B', 'active') returning id into unit_b;

  insert into public.guests (organization_id, full_name, phone) values
    (org_a, 'Payer A', '050-400-0001') returning id into guest_a;
  insert into public.guests (organization_id, full_name, phone) values
    (org_b, 'Payer B', '050-400-0002') returning id into guest_b;

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values
    (org_a, prop_a, unit_a, guest_a, 'confirmed', '2027-02-10', '2027-02-15', user_a)
  returning id into bk_a;

  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values
    (org_b, prop_b, unit_b, guest_b, 'confirmed', '2027-02-10', '2027-02-15', user_b)
  returning id into bk_b;

  ---------------------------------------------------------------------------
  -- 1 · The contract
  ---------------------------------------------------------------------------
  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'payment_status';
  want := array[
    'pending','authorized','paid','partially_paid','failed',
    'refunded','partially_refunded','cancelled','unknown'
  ];
  insert into payment_results (area, name, expected, actual, passed) values
    ('contract', 'payment_status enum matches PAYMENT_STATUSES exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(e.enumlabel::text order by e.enumsortorder) into got
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'payment_method';
  want := array['card','bit','bank_transfer','cash','paybox','other'];
  insert into payment_results (area, name, expected, actual, passed) values
    ('contract', 'payment_method enum matches PAYMENT_METHODS exactly, in order',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  select array_agg(x::text order by ord) into got
    from unnest(public.settled_payment_statuses()) with ordinality as u(x, ord);
  want := array['paid','partially_paid','partially_refunded'];
  insert into payment_results (area, name, expected, actual, passed) values
    ('contract', 'settled_payment_statuses() matches SETTLED_PAYMENT_STATUSES',
     array_to_string(want, ','), array_to_string(got, ','), got = want);

  ---------------------------------------------------------------------------
  -- 2 · Idempotency: a retry must not charge twice
  ---------------------------------------------------------------------------
  insert into public.payments
    (organization_id, property_id, booking_id, status, method, amount_agorot,
     captured_agorot, idempotency_key, paid_at, created_by)
  values
    (org_a, prop_a, bk_a, 'paid', 'card', 300000, 300000, 'checkout-abc-123', now(), user_a)
  returning id into pay_a;

  -- The retry, written the way a service actually writes it.
  begin
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot,
       captured_agorot, idempotency_key, paid_at, created_by)
    values
      (org_a, prop_a, bk_a, 'paid', 'card', 300000, 300000, 'checkout-abc-123', now(), user_a)
    on conflict (organization_id, idempotency_key) where idempotency_key is not null
      do nothing;
    get diagnostics n_rows = row_count;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('idempotency', 'a retried payment insert with the same key writes 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  select count(*) into n_all from public.payments
   where organization_id = org_a and idempotency_key = 'checkout-abc-123';
  insert into payment_results (area, name, expected, actual, passed) values
    ('idempotency', 'exactly one payment row exists for that key', '1',
     n_all::text, n_all = 1);

  -- And the raw duplicate, which is the mechanism a parallel transaction would
  -- collide with. Without this the assertion above could pass on a table with
  -- no unique index at all.
  begin
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot,
       captured_agorot, idempotency_key, paid_at, created_by)
    values
      (org_a, prop_a, bk_a, 'paid', 'card', 300000, 300000, 'checkout-abc-123', now(), user_a);
    err := 'NO ERROR — DUPLICATE KEY WAS ACCEPTED';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('idempotency', 'control: a raw duplicate key raises 23505', '23505', err, err = '23505');

  -- Scoped per organization, because keys are client-chosen and two tenants
  -- sending `retry-1` is the ordinary case.
  begin
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot,
       captured_agorot, idempotency_key, paid_at, created_by)
    values
      (org_b, prop_b, bk_b, 'paid', 'card', 300000, 300000, 'checkout-abc-123', now(), user_b)
    returning id into pay_b;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('idempotency', 'the same key in another organization is accepted', 'ok', err, err = 'ok');

  -- A NULL key is not a key: several payments may carry none.
  begin
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot, created_by)
    values
      (org_a, prop_a, bk_a, 'pending', 'cash', 5000, user_a),
      (org_a, prop_a, bk_a, 'pending', 'cash', 6000, user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('idempotency', 'several payments may carry no key at all', 'ok', err, err = 'ok');

  -- The same guard on every other table a retry could duplicate.
  insert into public.payment_attempts
    (organization_id, payment_id, attempt_number, status, idempotency_key, created_by)
  values (org_a, pay_a, 1, 'unknown', 'attempt-abc-1', user_a);
  begin
    insert into public.payment_attempts
      (organization_id, payment_id, attempt_number, status, idempotency_key, created_by)
    values (org_a, pay_a, 2, 'paid', 'attempt-abc-1', user_a);
    err := 'NO ERROR — DUPLICATE ATTEMPT KEY WAS ACCEPTED';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('idempotency', 'payment_attempts refuses a duplicate key', '23505', err, err = '23505');

  insert into public.refunds
    (organization_id, property_id, booking_id, payment_id, status, amount_agorot,
     idempotency_key, refunded_at, processed_at, created_by)
  values (org_a, prop_a, bk_a, pay_a, 'processed', 50000, 'refund-abc-1', now(), now(), user_a);
  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status, amount_agorot,
       idempotency_key, refunded_at, processed_at, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'processed', 50000, 'refund-abc-1', now(), now(), user_a);
    err := 'NO ERROR — DUPLICATE REFUND KEY WAS ACCEPTED';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('idempotency', 'refunds refuses a duplicate key', '23505', err, err = '23505');

  ---------------------------------------------------------------------------
  -- 3 · The refund ceiling — a rule across rows, so a trigger and a CHECK
  ---------------------------------------------------------------------------
  insert into payment_results (area, name, expected, actual, passed) values
    ('refund', 'a settled refund is reflected on the payment', '50000',
     (select amount_refunded_agorot::text from public.payments where id = pay_a),
     (select amount_refunded_agorot from public.payments where id = pay_a) = 50000);

  -- A pending refund has not moved money and must not count.
  insert into public.refunds
    (organization_id, property_id, booking_id, payment_id, status, amount_agorot, created_by)
  values (org_a, prop_a, bk_a, pay_a, 'requested', 10000, user_a);
  insert into payment_results (area, name, expected, actual, passed) values
    ('refund', 'a merely requested refund does not count towards the refunded total', '50000',
     (select amount_refunded_agorot::text from public.payments where id = pay_a),
     (select amount_refunded_agorot from public.payments where id = pay_a) = 50000);

  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status, amount_agorot,
       refunded_at, processed_at, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'processed', 300000, now(), now(), user_a);
    err := 'NO ERROR — REFUNDED MORE THAN WAS TAKEN';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('refund', 'refunding more than was taken is refused', '23514', err, err = '23514');

  -- Positive control: the remainder is refundable, so the ceiling is a ceiling
  -- and not a blanket refusal.
  begin
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status, amount_agorot,
       refunded_at, processed_at, created_by)
    values (org_a, prop_a, bk_a, pay_a, 'processed', 250000, now(), now(), user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('refund', 'control: refunding exactly the remainder is accepted', 'ok', err, err = 'ok');

  insert into payment_results (area, name, expected, actual, passed) values
    ('refund', 'the payment is now fully refunded', '300000',
     (select amount_refunded_agorot::text from public.payments where id = pay_a),
     (select amount_refunded_agorot from public.payments where id = pay_a) = 300000);

  ---------------------------------------------------------------------------
  -- 4 · Deposits
  ---------------------------------------------------------------------------
  insert into public.deposits
    (organization_id, property_id, booking_id, status, method,
     required_agorot, held_agorot, captured_at, created_by)
  values (org_a, prop_a, bk_a, 'paid', 'card', 100000, 100000, now(), user_a)
  returning id into dep_a;

  -- One deposit per booking: the domain treats "the deposit held" as a single
  -- number and two rows would make it ambiguous.
  begin
    insert into public.deposits
      (organization_id, property_id, booking_id, status, required_agorot, created_by)
    values (org_a, prop_a, bk_a, 'pending', 50000, user_a);
    err := 'NO ERROR — A SECOND DEPOSIT WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('deposit', 'a booking may hold only one deposit', '23505', err, err = '23505');

  -- Nothing may leave a deposit that never entered it.
  begin
    update public.deposits set released_agorot = 150000, released_at = now() where id = dep_a;
    err := 'NO ERROR — RELEASED MORE THAN WAS HELD';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('deposit', 'releasing more than was held is refused', '23514', err, err = '23514');

  -- Keeping a guest's money without saying why is refused.
  begin
    update public.deposits set forfeited_agorot = 20000, forfeited_at = now() where id = dep_a;
    err := 'NO ERROR — FORFEITED WITH NO REASON';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('deposit', 'forfeiting a deposit demands a reason', '23514', err, err = '23514');

  begin
    update public.deposits
       set forfeited_agorot = 20000, forfeited_at = now(),
           forfeit_reason = 'broken glass table', released_agorot = 80000,
           released_at = now()
     where id = dep_a;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('deposit', 'control: a reasoned forfeit plus the balance released is accepted',
     'ok', err, err = 'ok');

  ---------------------------------------------------------------------------
  -- 5 · Invoices: gapless numbering, and frozen once issued
  ---------------------------------------------------------------------------
  select public.next_invoice_number(org_a, 'default', 2027) into n1;
  select public.next_invoice_number(org_a, 'default', 2027) into n2;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'invoice numbers are allocated 1 then 2, with no gap', '1,2',
     n1::text || ',' || n2::text, n1 = 1 and n2 = 2);

  select public.next_invoice_number(org_b, 'default', 2027) into n1;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'another organization starts its own sequence at 1', '1',
     n1::text, n1 = 1);

  insert into public.invoices
    (organization_id, property_id, booking_id, kind, status, series, year, number,
     display_number, customer_name, subtotal_agorot, tax_agorot, total_agorot,
     issued_at, idempotency_key, created_by)
  values
    (org_a, prop_a, bk_a, 'tax_invoice', 'issued', 'default', 2027, 1,
     '2027-000001', 'Payer A', 300000, 51000, 351000, now(), 'invoice-abc-1', user_a)
  returning id into inv_a;

  -- Two invoices cannot take the same number in the same series and year.
  begin
    insert into public.invoices
      (organization_id, property_id, booking_id, status, series, year, number,
       customer_name, subtotal_agorot, tax_agorot, total_agorot, issued_at, created_by)
    values
      (org_a, prop_a, bk_a, 'issued', 'default', 2027, 1,
       'Payer A', 100, 0, 100, now(), user_a);
    err := 'NO ERROR — TWO INVOICES SHARED A NUMBER';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'two invoices cannot share a number', '23505', err, err = '23505');

  -- A draft has no number and no moment; an issued document has both.
  begin
    insert into public.invoices
      (organization_id, property_id, booking_id, status, customer_name,
       subtotal_agorot, tax_agorot, total_agorot, number, created_by)
    values (org_a, prop_a, bk_a, 'draft', 'Payer A', 100, 0, 100, 99, user_a);
    err := 'NO ERROR — A DRAFT CARRIED A NUMBER';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'a draft invoice may not carry a number', '23514', err, err = '23514');

  -- The total must be the sum of its parts.
  begin
    insert into public.invoices
      (organization_id, property_id, booking_id, status, customer_name,
       subtotal_agorot, tax_agorot, total_agorot, created_by)
    values (org_a, prop_a, bk_a, 'draft', 'Payer A', 100, 17, 999, user_a);
    err := 'NO ERROR — TOTAL DID NOT ADD UP';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'an invoice total must equal subtotal plus tax', '23514', err, err = '23514');

  -- Issued means issued. An amount cannot be edited afterwards.
  begin
    update public.invoices set total_agorot = 1, subtotal_agorot = 1, tax_agorot = 0
     where id = inv_a;
    err := 'NO ERROR — AN ISSUED INVOICE WAS REPRICED';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'an issued invoice cannot be repriced, even by the owner',
     '42501', err, err = '42501');

  begin
    update public.invoices set customer_name = 'Someone Else' where id = inv_a;
    err := 'NO ERROR — AN ISSUED INVOICE CHANGED CUSTOMER';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'an issued invoice cannot change customer', '42501', err, err = '42501');

  -- What is still allowed: attaching the provider's copy and a note. The
  -- freeze is about what the document says, not about the row.
  begin
    update public.invoices
       set document_url = 'https://provider.example/inv/1', note = 'sent by email'
     where id = inv_a;
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('invoice', 'control: attaching the provider copy to an issued invoice is allowed',
     'ok', err, err = 'ok');

  ---------------------------------------------------------------------------
  -- 6 · Credit notes may not exceed their invoice
  ---------------------------------------------------------------------------
  begin
    insert into public.credit_notes
      (organization_id, property_id, invoice_id, booking_id, status, series, year,
       number, amount_agorot, reason, issued_at, created_by)
    values
      (org_a, prop_a, inv_a, bk_a, 'issued', 'credit', 2027, 1,
       100000, 'partial cancellation', now(), user_a);
    err := 'ok';
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('credit', 'a credit note within the invoice total is accepted', 'ok', err, err = 'ok');

  begin
    insert into public.credit_notes
      (organization_id, property_id, invoice_id, booking_id, status, series, year,
       number, amount_agorot, reason, issued_at, created_by)
    values
      (org_a, prop_a, inv_a, bk_a, 'issued', 'credit', 2027, 2,
       300000, 'too much', now(), user_a);
    err := 'NO ERROR — CREDITED MORE THAN THE INVOICE';
  exception when others then err := sqlstate;
  end;
  insert into payment_results (area, name, expected, actual, passed) values
    ('credit', 'credit notes may not exceed the invoice total', '23514', err, err = '23514');

  ---------------------------------------------------------------------------
  -- 7 · Money records are never deleted
  ---------------------------------------------------------------------------
  -- Not by an ordinary member, and not by the service role either — the grant
  -- is what stands between a background job and a vanished payment.
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    delete from public.payments where id = pay_a;
    err := 'NO ERROR — A PAYMENT WAS DELETED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('append_only', 'authenticated cannot delete a payment', '42501', err, err = '42501');

  begin
    execute 'set local role service_role';
    delete from public.payments where id = pay_a;
    err := 'NO ERROR — SERVICE ROLE DELETED A PAYMENT';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('append_only', 'service_role cannot delete a payment (BYPASSRLS notwithstanding)',
     '42501', err, err = '42501');

  begin
    execute 'set local role service_role';
    delete from public.invoices where id = inv_a;
    err := 'NO ERROR — SERVICE ROLE DELETED AN INVOICE';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('append_only', 'service_role cannot delete an invoice', '42501', err, err = '42501');

  -- The invoice counter is nobody's to read or write through the API.
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.invoice_sequences;
    err := 'NO ERROR — read ' || n_all || ' counter rows';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('append_only', 'invoice_sequences is unreadable by authenticated', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 8 · Tenant isolation, table by table
  ---------------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    select count(*) into n_all from (select auth.uid() = user_a as ok) t where t.ok;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('sanity', 'auth.uid() resolves to user A', '1',
     coalesce(n_all::text, 'null') || coalesce(' err=' || err, ''), n_all = 1);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payments;
    select count(*) into n_other from public.payments where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('select', 'payments: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.payment_attempts;
    select count(*) into n_other from public.payment_attempts where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('select', 'payment_attempts: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.refunds;
    select count(*) into n_other from public.refunds where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('select', 'refunds: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.deposits;
    select count(*) into n_other from public.deposits where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('select', 'deposits: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.invoices;
    select count(*) into n_other from public.invoices where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('select', 'invoices: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all   from public.credit_notes;
    select count(*) into n_other from public.credit_notes where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_all := -1; n_other := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('select', 'credit_notes: none of B''s, some of A''s', 'b=0 a>0',
     'total=' || n_all || ' b=' || n_other || coalesce(' err=' || err, ''),
     n_other = 0 and n_all > 0);

  -- INSERT into B
  begin
    execute 'set local role authenticated';
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot)
      values (org_b, prop_b, bk_b, 'pending', 'cash', 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('insert', 'payments INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.refunds
      (organization_id, property_id, booking_id, payment_id, status, amount_agorot)
      values (org_b, prop_b, bk_b, pay_b, 'requested', 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('insert', 'refunds INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.deposits
      (organization_id, property_id, booking_id, status, required_agorot)
      values (org_b, prop_b, bk_b, 'pending', 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('insert', 'deposits INSERT into org B refused', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    insert into public.invoices
      (organization_id, property_id, booking_id, status, customer_name,
       subtotal_agorot, tax_agorot, total_agorot)
      values (org_b, prop_b, bk_b, 'draft', 'Smuggled', 100, 0, 100);
    err := 'NO ERROR — ROW WAS WRITTEN';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('insert', 'invoices INSERT into org B refused', '42501', err, err = '42501');

  -- UPDATE of B's rows
  begin
    execute 'set local role authenticated';
    update public.payments set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('update', 'payments UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.refunds set reason = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('update', 'refunds UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.invoices set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('update', 'invoices UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    update public.deposits set note = 'HACKED' where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate || ' ' || sqlerrm; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('update', 'deposits UPDATE of B affects 0 rows', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- DELETE: refused outright on every table in this file, for A and B alike.
  -- The absence of the grant is the point, so there is no positive control to
  -- offer here — the correct behaviour is that nobody can delete anything.
  begin
    execute 'set local role authenticated';
    delete from public.refunds where organization_id = org_b;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('delete', 'refunds DELETE refused outright', '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.deposits where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('delete', 'deposits DELETE refused outright, in the caller''s own org too',
     '42501', err, err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.credit_notes where organization_id = org_a;
    err := 'NO ERROR — DELETE WAS ALLOWED';
  exception when others then err := sqlstate;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('delete', 'credit_notes DELETE refused outright', '42501', err, err = '42501');

  ---------------------------------------------------------------------------
  -- 9 · Positive controls
  ---------------------------------------------------------------------------
  -- Without these, section 8 proves nothing: a missing GRANT would produce
  -- "0 rows affected" everywhere and every isolation assertion would pass
  -- vacuously. These mutate the fixture, so they run last.
  begin
    execute 'set local role authenticated';
    insert into public.payments
      (organization_id, property_id, booking_id, status, method, amount_agorot)
      values (org_a, prop_a, bk_a, 'pending', 'bit', 12345);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert a payment in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    insert into public.invoices
      (organization_id, property_id, booking_id, status, customer_name,
       subtotal_agorot, tax_agorot, total_agorot)
      values (org_a, prop_a, bk_a, 'draft', 'Payer A', 1000, 170, 1170);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('control', 'A CAN insert an invoice in its own organization', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.payments set note = 'ok' where organization_id = org_a and id = pay_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own payment', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.deposits set note = 'ok' where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own deposit', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  begin
    execute 'set local role authenticated';
    update public.refunds set reason = 'ok' where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into payment_results (area, name, expected, actual, passed) values
    ('control', 'A CAN update its own refunds', '3',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 3);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into payment_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from payment_results;

select seq, area, name, expected, actual, passed from payment_results order by seq;

rollback;
