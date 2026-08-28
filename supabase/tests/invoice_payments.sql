-- ============================================================================
-- invoice_payments.sql — ESTIA · proof for 0022
--
-- What this is
--   The evidence for the join table that replaces
--   `invoices.metadata.payment_ids`, which src/lib/persistence/finance.ts
--   flagged in its own header as a stopgap.
--
--   Three things an array of ids could not do, proved one at a time:
--
--     · answer from the payment's side;
--     · refuse an id that names nothing;
--     · refuse a link between an invoice for one stay and a payment against
--       another.
--
--   The third is the one worth reading. Both foreign keys name the booking as
--   well as the organization, so the coherence check is declarative — no
--   trigger, no application rule, nothing to forget.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invoice_payments.sql
--
--   One transaction, ending in ROLLBACK. Every isolation claim has a positive
--   control beside it: a zero-row result proves isolation only when the same
--   statement aimed at the caller's own organization affects exactly one row.
--
-- Depends on
--   0001 … 0022, applied in order.
-- ============================================================================

begin;

set search_path = public, extensions;

create temp table ip_results (
  seq       serial primary key,
  area      text    not null,
  name      text    not null,
  expected  text    not null,
  actual    text    not null,
  passed    boolean not null
);

do $$
declare
  org_a   constant uuid := '5e5e5e5e-6666-4111-8111-111111111111';
  org_b   constant uuid := '6f6f6f6f-6666-4222-8222-222222222222';
  user_a  constant uuid := 'aaaa6666-6666-4000-8000-00000000000a';
  user_b  constant uuid := 'bbbb6666-6666-4000-8000-00000000000b';
  -- An active member of A holding no role: reading an allocation is a grant,
  -- not a consequence of membership.
  plain_a constant uuid := 'cccc6666-6666-4000-8000-00000000000c';
  mem_a   constant uuid := 'dddd6666-6666-4000-8000-00000000000a';
  mem_b   constant uuid := 'dddd6666-6666-4000-8000-00000000000b';
  mem_p   constant uuid := 'dddd6666-6666-4000-8000-00000000000c';

  owner_role uuid;
  prop_a  uuid; prop_b  uuid;
  unit_a  uuid; unit_b  uuid;
  guest_a uuid; guest_b uuid;
  bk_a1   uuid; bk_a2   uuid; bk_b uuid;
  inv_a1  uuid; inv_a1b uuid; inv_b uuid;
  pay_a1  uuid; pay_a1b uuid; pay_a2 uuid; pay_b uuid;

  n_rows bigint;
  n_all  bigint;
  err    text;
  txt    text;
begin
  ---------------------------------------------------------------------------
  -- Fixture
  ---------------------------------------------------------------------------
  select id into owner_role from public.roles
    where code = 'organization_owner' and organization_id is null;

  insert into auth.users (id, email) values
    (user_a, 'ip-a@estia.test'), (user_b, 'ip-b@estia.test'), (plain_a, 'ip-p@estia.test');

  insert into public.organizations (id, slug, name) values
    (org_a, 'ip-org-a', 'Invoice Payments Organization A'),
    (org_b, 'ip-org-b', 'Invoice Payments Organization B');

  insert into public.memberships (id, user_id, organization_id, status, joined_at) values
    (mem_a, user_a, org_a, 'active', now()),
    (mem_b, user_b, org_b, 'active', now()),
    (mem_p, plain_a, org_a, 'active', now());

  insert into public.membership_roles (membership_id, organization_id, role_id) values
    (mem_a, org_a, owner_role), (mem_b, org_b, owner_role);

  insert into public.membership_scopes (membership_id, organization_id, kind) values
    (mem_a, org_a, 'all_organization'),
    (mem_b, org_b, 'all_organization'),
    (mem_p, org_a, 'all_organization');

  insert into public.properties (organization_id, slug, name, status) values
    (org_a, 'ip-villa-a', 'Invoice Villa A', 'active') returning id into prop_a;
  insert into public.properties (organization_id, slug, name, status) values
    (org_b, 'ip-villa-b', 'Invoice Villa B', 'active') returning id into prop_b;

  insert into public.units (organization_id, property_id, code, name, status) values
    (org_a, prop_a, 'IA', 'Invoice Unit A', 'active') returning id into unit_a;
  insert into public.units (organization_id, property_id, code, name, status) values
    (org_b, prop_b, 'IB', 'Invoice Unit B', 'active') returning id into unit_b;

  insert into public.guests (organization_id, full_name, phone) values
    (org_a, 'Invoice Guest A', '050-770-0001') returning id into guest_a;
  insert into public.guests (organization_id, full_name, phone) values
    (org_b, 'Invoice Guest B', '050-770-0002') returning id into guest_b;

  -- Two stays inside organization A. The second is what makes the coherence
  -- check testable without leaving the tenant.
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_a, prop_a, unit_a, guest_a, 'inquiry', '2027-05-01', '2027-05-03', user_a)
  returning id into bk_a1;
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_a, prop_a, unit_a, guest_a, 'inquiry', '2027-06-01', '2027-06-03', user_a)
  returning id into bk_a2;
  insert into public.bookings
    (organization_id, property_id, unit_id, guest_id, status, check_in, check_out, created_by)
  values (org_b, prop_b, unit_b, guest_b, 'inquiry', '2027-05-01', '2027-05-03', user_b)
  returning id into bk_b;

  insert into public.invoices
    (organization_id, property_id, booking_id, status, customer_name,
     subtotal_agorot, tax_agorot, total_agorot, created_by)
  values (org_a, prop_a, bk_a1, 'draft', 'Invoice Guest A', 100000, 17000, 117000, user_a)
  returning id into inv_a1;
  insert into public.invoices
    (organization_id, property_id, booking_id, status, customer_name,
     subtotal_agorot, tax_agorot, total_agorot, created_by)
  values (org_a, prop_a, bk_a1, 'draft', 'Invoice Guest A', 50000, 8500, 58500, user_a)
  returning id into inv_a1b;
  insert into public.invoices
    (organization_id, property_id, booking_id, status, customer_name,
     subtotal_agorot, tax_agorot, total_agorot, created_by)
  values (org_b, prop_b, bk_b, 'draft', 'Invoice Guest B', 100000, 17000, 117000, user_b)
  returning id into inv_b;

  -- A deposit and a balance against the first stay, one payment against the
  -- second, one in the other organization.
  insert into public.payments
    (organization_id, property_id, booking_id, status, method, amount_agorot,
     captured_agorot, paid_at, created_by)
  values (org_a, prop_a, bk_a1, 'paid', 'card', 30000, 30000, now(), user_a)
  returning id into pay_a1;
  insert into public.payments
    (organization_id, property_id, booking_id, status, method, amount_agorot,
     captured_agorot, paid_at, created_by)
  values (org_a, prop_a, bk_a1, 'paid', 'card', 87000, 87000, now(), user_a)
  returning id into pay_a1b;
  insert into public.payments
    (organization_id, property_id, booking_id, status, method, amount_agorot,
     captured_agorot, paid_at, created_by)
  values (org_a, prop_a, bk_a2, 'paid', 'card', 117000, 117000, now(), user_a)
  returning id into pay_a2;
  insert into public.payments
    (organization_id, property_id, booking_id, status, method, amount_agorot,
     captured_agorot, paid_at, created_by)
  values (org_b, prop_b, bk_b, 'paid', 'card', 117000, 117000, now(), user_b)
  returning id into pay_b;

  ---------------------------------------------------------------------------
  -- 1 · The shape an array could not hold
  ---------------------------------------------------------------------------
  insert into public.invoice_payments
    (invoice_id, payment_id, organization_id, booking_id, created_by)
  values (inv_a1, pay_a1, org_a, bk_a1, user_a);

  insert into ip_results (area, name, expected, actual, passed) values
    ('shape', 'a payment can be attributed to an invoice', '1',
     (select count(*)::text from public.invoice_payments where invoice_id = inv_a1),
     (select count(*) from public.invoice_payments where invoice_id = inv_a1) = 1);

  -- Both directions of many-to-many, because both really happen: a deposit and
  -- a balance covering one document, and one payment settling two.
  insert into public.invoice_payments
    (invoice_id, payment_id, organization_id, booking_id, created_by)
  values (inv_a1, pay_a1b, org_a, bk_a1, user_a);

  insert into ip_results (area, name, expected, actual, passed) values
    ('shape', 'an invoice can be covered by a deposit and a balance', '2',
     (select count(*)::text from public.invoice_payments where invoice_id = inv_a1),
     (select count(*) from public.invoice_payments where invoice_id = inv_a1) = 2);

  insert into public.invoice_payments
    (invoice_id, payment_id, organization_id, booking_id, created_by)
  values (inv_a1b, pay_a1b, org_a, bk_a1, user_a);

  insert into ip_results (area, name, expected, actual, passed) values
    ('shape', 'one payment can settle two invoices', '2',
     (select count(*)::text from public.invoice_payments where payment_id = pay_a1b),
     (select count(*) from public.invoice_payments where payment_id = pay_a1b) = 2);

  -- The question the jsonb array could not answer at all.
  insert into ip_results (area, name, expected, actual, passed) values
    ('shape', 'the reverse question is answerable: which invoices does this payment cover',
     '2',
     (select count(distinct i.id)::text from public.invoice_payments ip
        join public.invoices i on i.id = ip.invoice_id
       where ip.payment_id = pay_a1b),
     (select count(distinct i.id) from public.invoice_payments ip
        join public.invoices i on i.id = ip.invoice_id
       where ip.payment_id = pay_a1b) = 2);

  begin
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    values (inv_a1, pay_a1, org_a, bk_a1, user_a);
    err := 'NO ERROR — ONE PAYMENT ATTRIBUTED TWICE TO ONE INVOICE';
  exception when others then err := sqlstate;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('shape', 'the same payment cannot be attributed twice to one invoice',
     '23505', err, err = '23505');

  ---------------------------------------------------------------------------
  -- 2 · The three things an array of ids stored happily
  ---------------------------------------------------------------------------
  -- (a) An id that names nothing.
  begin
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    values (inv_a1, '00000000-0000-4000-8000-000000000000', org_a, bk_a1, user_a);
    err := 'NO ERROR — A LINK TO A PAYMENT THAT DOES NOT EXIST';
  exception when others then err := sqlstate;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('integrity', 'a link to a payment that does not exist is refused',
     '23503', err, err = '23503');

  -- (b) The wrong stay. Same organization, same property, same guest — and a
  --     payment for June set against the invoice for May.
  begin
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    values (inv_a1, pay_a2, org_a, bk_a1, user_a);
    err := 'NO ERROR — A JUNE PAYMENT SETTLED A MAY INVOICE';
  exception when others then err := sqlstate;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('integrity', 'a payment against another booking cannot settle this invoice',
     '23503', err, err = '23503');

  -- …and it is refused from the other side too: naming the payment's own
  -- booking does not rescue it, because then the invoice stops matching.
  begin
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    values (inv_a1, pay_a2, org_a, bk_a2, user_a);
    err := 'NO ERROR — THE MISMATCH WAS LAUNDERED THROUGH THE BOOKING COLUMN';
  exception when others then err := sqlstate;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('integrity', 'quoting the payment''s own booking does not rescue the mismatch',
     '23503', err, err = '23503');

  -- Positive control for both: the same statement, aimed at the invoice that
  -- does belong to that stay, stores.
  begin
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    select i.id, pay_a2, org_a, bk_a2, user_a
      from public.invoices i where i.booking_id = bk_a2 limit 1;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('control', 'there is no invoice for the June stay yet, so nothing to link', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  insert into public.invoices
    (organization_id, property_id, booking_id, status, customer_name,
     subtotal_agorot, tax_agorot, total_agorot, created_by)
  values (org_a, prop_a, bk_a2, 'draft', 'Invoice Guest A', 100000, 17000, 117000, user_a);

  begin
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    select i.id, pay_a2, org_a, bk_a2, user_a
      from public.invoices i where i.booking_id = bk_a2 limit 1;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('control', 'the June payment CAN settle the June invoice', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- (c) A link across tenants. The same composite key that catches the wrong
  --     stay catches this, which is why there is no separate rule for it.
  begin
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    values (inv_a1, pay_b, org_a, bk_a1, user_a);
    err := 'NO ERROR — A LINK BETWEEN TWO TENANTS';
  exception when others then err := sqlstate;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('integrity', 'a payment in another organization cannot settle this invoice',
     '23503', err, err = '23503');

  ---------------------------------------------------------------------------
  -- 3 · What the table refuses to become
  ---------------------------------------------------------------------------
  -- No UPDATE, matching the absent UPDATE policy. A change of attribution is a
  -- delete and an insert, both separately visible.
  insert into ip_results (area, name, expected, actual, passed) values
    ('contract', 'no caller holds UPDATE on invoice_payments', 'none',
     coalesce((select string_agg(distinct grantee, ', ')
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'invoice_payments'
         and privilege_type = 'UPDATE'
         and grantee in ('anon', 'authenticated', 'service_role')), 'none'),
     not exists (select 1 from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'invoice_payments'
         and privilege_type = 'UPDATE'
         and grantee in ('anon', 'authenticated', 'service_role')));

  insert into ip_results (area, name, expected, actual, passed) values
    ('contract', 'anon holds nothing on invoice_payments', 'none',
     coalesce((select string_agg(distinct privilege_type, ', ')
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'invoice_payments'
         and grantee = 'anon'), 'none'),
     not exists (select 1 from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'invoice_payments'
         and grantee = 'anon'));

  -- The two foreign keys say different things about deletion on purpose: a
  -- document that is gone has no allocations, but money that moved is
  -- corrected with another entry and never erased.
  insert into ip_results (area, name, expected, actual, passed) values
    ('contract', 'the invoice side is CASCADE and the payment side is RESTRICT', 'c/r',
     (select (select confdeltype::text from pg_constraint
                where conname = 'invoice_payments_invoice_fkey') || '/' ||
             (select confdeltype::text from pg_constraint
                where conname = 'invoice_payments_payment_fkey')),
     (select confdeltype from pg_constraint where conname = 'invoice_payments_invoice_fkey') = 'c'
     and (select confdeltype from pg_constraint where conname = 'invoice_payments_payment_fkey') = 'r');

  begin
    delete from public.payments where id = pay_a1;
    err := 'NO ERROR — A PAYMENT AN INVOICE ACCOUNTS FOR WAS DELETED';
  exception when others then err := sqlstate;
  end;
  insert into ip_results (area, name, expected, actual, passed) values
    ('contract', 'a payment an invoice accounts for cannot be deleted',
     '23503 or 42501', err, err in ('23503', '42501'));

  ---------------------------------------------------------------------------
  -- 4 · Tenant isolation, with a positive control on every claim
  ---------------------------------------------------------------------------
  insert into public.invoice_payments
    (invoice_id, payment_id, organization_id, booking_id, created_by)
  values (inv_b, pay_b, org_b, bk_b, user_b);

  perform set_config('request.jwt.claims',
    json_build_object('sub', user_b::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.invoice_payments where organization_id = org_a;
    select count(*) into n_all  from public.invoice_payments where organization_id = org_b;
    err := null;
  exception when others then err := sqlstate; n_rows := -1; n_all := -1;
  end;
  execute 'reset role';
  insert into ip_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot read which payments settle A''s invoices', 'other=0',
     'other=' || n_rows || coalesce(' err=' || err, ''), n_rows = 0);
  insert into ip_results (area, name, expected, actual, passed) values
    ('control', 'B CAN read its own allocations', 'own=1', 'own=' || n_all, n_all = 1);

  -- Written with VALUES, never INSERT … SELECT from a filtered table: a
  -- filtered source touches zero rows and proves the reader was filtered, not
  -- that the writer was refused.
  begin
    execute 'set local role authenticated';
    insert into public.invoice_payments
      (invoice_id, payment_id, organization_id, booking_id, created_by)
    values (inv_a1b, pay_a1, org_a, bk_a1, user_b);
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ip_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot attribute a payment inside A', '42501',
     n_rows::text || coalesce(' err=' || err, ''), err = '42501');

  begin
    execute 'set local role authenticated';
    delete from public.invoice_payments where organization_id = org_a;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ip_results (area, name, expected, actual, passed) values
    ('isolation', 'B cannot unpick A''s allocations', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  begin
    execute 'set local role authenticated';
    delete from public.invoice_payments where organization_id = org_b;
    get diagnostics n_rows = row_count; err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ip_results (area, name, expected, actual, passed) values
    ('control', 'B CAN correct its own allocation', '1',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 1);

  -- Reading an allocation is a grant. An active member holding no role sees
  -- nothing, in their own organization.
  perform set_config('request.jwt.claims',
    json_build_object('sub', plain_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_rows from public.invoice_payments where organization_id = org_a;
    err := null;
  exception when others then err := sqlstate; n_rows := -1;
  end;
  execute 'reset role';
  insert into ip_results (area, name, expected, actual, passed) values
    ('isolation', 'a member of A with no invoice.view grant reads nothing', '0',
     n_rows::text || coalesce(' err=' || err, ''), n_rows = 0);

  -- Positive control for that zero: A's owner, who does hold the grant, in the
  -- same organization and against the same rows.
  perform set_config('request.jwt.claims',
    json_build_object('sub', user_a::text, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    select count(*) into n_all from public.invoice_payments where organization_id = org_a;
    err := null;
  exception when others then err := sqlstate; n_all := -1;
  end;
  execute 'reset role';
  insert into ip_results (area, name, expected, actual, passed) values
    ('control', 'A''s owner CAN read the same allocations', 'own=4',
     'own=' || n_all || coalesce(' err=' || err, ''), n_all = 4);

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

insert into ip_results (area, name, expected, actual, passed)
select 'TOTAL', 'every assertion passed', '0 failed',
       count(*) || ' assertions, ' || count(*) filter (where not passed) || ' failed',
       count(*) filter (where not passed) = 0
from ip_results;

select seq, area, name, expected, actual, passed from ip_results order by seq;

rollback;
