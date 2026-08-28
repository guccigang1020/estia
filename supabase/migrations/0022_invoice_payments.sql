-- ============================================================================
-- 0022_invoice_payments.sql — ESTIA · which payment accounts for which invoice
--
-- What this does
--   One join table, replacing the jsonb array
--   src/lib/persistence/finance.ts flagged in its own header as a stopgap
--   rather than a design:
--
--     metadata: { payment_ids: [...invoice.paymentIds] }
--
-- ── Why an array could not stay ─────────────────────────────────────────────
--
--   **It only answers in one direction.** `Invoice.paymentIds` reads forwards:
--   given an invoice, which payments. The question a business actually asks
--   during a reconciliation is the reverse — given this payment, which invoice
--   accounts for it — and a jsonb array cannot be indexed into that question
--   usefully. A GIN index over `metadata` would answer it slowly and would
--   answer it about the whole `metadata` blob, not about payment ids.
--
--   **Nothing checks that the ids exist.** An array holds any uuid at all. A
--   typo, a stale id from a deleted draft, a payment belonging to another
--   organization — all of them store cleanly, and the first time anybody finds
--   out is when a reconciliation is short and nobody can say which line is
--   wrong. A row with foreign keys cannot hold a payment that is not there.
--
--   **It cannot say the two are about the same stay.** This is the one that
--   matters most and is the reason the table carries `booking_id`. Both
--   foreign keys below name `(id, organization_id, booking_id)`, so a link
--   between an invoice for booking A and a payment against booking B is
--   refused by the database rather than discovered during an audit. Tenant
--   isolation comes along for free in the same key: neither end can be a row
--   from another organization, so this table cannot become a bridge between
--   two tenants.
--
--   Many-to-many is the true shape, in both directions: one payment can settle
--   several invoices, and an invoice is routinely covered by a deposit and a
--   balance. Neither side can be a column on the other.
--
-- ── What this table deliberately does not hold ──────────────────────────────
--
--   No allocated amount. `Invoice.paymentIds` is a list of ids and nothing
--   more, and a per-link amount would be a second answer to "how much of this
--   payment went here" with nothing in the domain to keep it honest — the
--   first partial allocation would leave the sum of the links disagreeing with
--   `payments.amount_agorot` and no rule to say which is right. When the
--   finance domain grows split allocations it will bring the arithmetic with
--   it, and the column belongs in the migration that carries that rule.
--
--   No `status`. Whether an invoice has been paid is a question for
--   `payments`, which is what 0010's own comment on `invoices` says at length.
--   This table records attribution, not settlement.
--
--   No UPDATE. The row is its key: changing which payment a link names is
--   deleting one link and creating another, and both are separately visible.
--   0004 made the same call for `membership_roles`.
--
-- ── The stopgap is not removed here ─────────────────────────────────────────
--
--   `src/lib/persistence/finance.ts` still writes `metadata.payment_ids` on
--   every insert and update of an invoice. This migration does not and cannot
--   change that — it adds the storage the adapter's own header asked for, and
--   the adapter is not this file's to edit. Until it moves, `metadata` is a
--   duplicate of this table rather than the source, and whoever moves it
--   should backfill from the array and then stop writing it, in that order.
--
-- Depends on
--   0004 (my_organizations, has_permission), 0010 (invoices, payments), 0012
--   (invoice.view, invoice.issue).
-- ============================================================================

set search_path = public, extensions;


-- ── Keys both ends of the link can be named by ──────────────────────────────
-- `payments` already has `(id, organization_id)` and
-- `(id, organization_id, property_id)`; `invoices` has the second of those.
-- Neither has a key including the booking, which is the column that makes the
-- coherence check below possible. Added the way 0011 added
-- `bookings_id_organization_key`.

do $$ begin
  alter table public.invoices
    add constraint invoices_id_organization_booking_key unique (id, organization_id, booking_id);
exception when duplicate_object or duplicate_table then null;
end $$;

do $$ begin
  alter table public.payments
    add constraint payments_id_organization_booking_key unique (id, organization_id, booking_id);
exception when duplicate_object or duplicate_table then null;
end $$;


-- ============================================================================
-- invoice_payments
-- ============================================================================

create table if not exists public.invoice_payments (
  invoice_id      uuid not null,
  payment_id      uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Carried, not derived. It is what both foreign keys are checked against,
  -- and it is why an invoice for one stay cannot be settled by a payment
  -- against another.
  booking_id      uuid not null,

  metadata        jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,

  primary key (invoice_id, payment_id),

  -- CASCADE from the invoice: a document that is gone has no allocations.
  constraint invoice_payments_invoice_fkey
    foreign key (invoice_id, organization_id, booking_id)
    references public.invoices (id, organization_id, booking_id) on delete cascade,
  -- RESTRICT from the payment: 0010's rule is that money that moved is
  -- corrected with another entry and never erased, so a payment that has been
  -- attributed to a document cannot quietly disappear from underneath it.
  constraint invoice_payments_payment_fkey
    foreign key (payment_id, organization_id, booking_id)
    references public.payments (id, organization_id, booking_id) on delete restrict
);

comment on table public.invoice_payments is
  'Which payments account for which invoice. Many-to-many in both directions: one payment can settle several invoices, and an invoice is routinely covered by a deposit and a balance. It replaces invoices.metadata.payment_ids, which src/lib/persistence/finance.ts flagged as a stopgap — an array answers only forwards, checks nothing, and cannot say that the invoice and the payment are about the same stay. Attribution only: whether an invoice has been paid is still a question for payments.';
comment on column public.invoice_payments.booking_id is
  'The stay both ends belong to. Present so the two foreign keys can each name it, which is what refuses a link between an invoice for one booking and a payment against another — the error an array of ids has no way to catch.';

-- The reverse question, which is the one the array could not answer: given
-- this payment, which invoice accounts for it. The primary key already covers
-- the forward direction.
create index if not exists invoice_payments_payment_idx
  on public.invoice_payments (payment_id);
create index if not exists invoice_payments_organization_idx
  on public.invoice_payments (organization_id);
create index if not exists invoice_payments_booking_idx
  on public.invoice_payments (organization_id, booking_id);


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.invoice_payments enable row level security;
alter table public.invoice_payments force  row level security;

revoke all on public.invoice_payments from anon, authenticated;

-- No UPDATE grant, matching the absent UPDATE policy: two independent
-- refusals for the same thing.
grant select, insert, delete on public.invoice_payments to authenticated;
grant select, insert, delete on public.invoice_payments to service_role;
revoke update, truncate on public.invoice_payments from service_role;


-- ── Policies ────────────────────────────────────────────────────────────────
-- Reading an allocation is `invoice.view` and writing one is `invoice.issue`,
-- exactly as 0010 gated the documents and 0016 gated their lines. No
-- `property_in_scope` test: this table has no property_id of its own, and both
-- ends already carry one behind their own policies — a caller who cannot see
-- the invoice cannot learn anything from a link to it.

drop policy if exists invoice_payments_select on public.invoice_payments;
create policy invoice_payments_select on public.invoice_payments
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists invoice_payments_insert on public.invoice_payments;
create policy invoice_payments_insert on public.invoice_payments
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );

-- A misallocation is corrected by removing the link and adding the right one.
-- That is not the same act as editing money: neither the payment nor the
-- invoice changes, only which of them is said to answer for the other.
drop policy if exists invoice_payments_delete on public.invoice_payments;
create policy invoice_payments_delete on public.invoice_payments
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );
