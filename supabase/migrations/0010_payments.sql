-- ============================================================================
-- 0010_payments.sql — ESTIA · the money that arrives, and the paper that
--                     proves it
--
-- What this does
--   Creates the financial core on top of the booking domain: `payments`,
--   `payment_attempts`, `refunds`, `deposits`, `invoices`, `credit_notes`, and
--   the counter that hands out gapless invoice numbers without a race.
--
--   Every enum here is transcribed from src/lib/contracts/states.ts, in the
--   same order, spelled the same way. That file says it plainly — "the database
--   enums use these exact strings, in this exact order" — and
--   supabase/tests/payments.sql contains an assertion that fails the moment the
--   two drift.
--
-- ── The rule this file exists to enforce: a retry must not cost money ───────
--
--   A payment request is sent twice more often than anyone expects. A phone
--   loses signal after the request left it. A webhook is delivered twice
--   because the acknowledgement was lost, not the message. A guest presses the
--   button again because nothing visibly happened. All three are one event on
--   the business's side, and all three must end in one charge.
--
--   0006 built `idempotency_keys` for the operation layer. This file closes the
--   same hole one level down, on the rows themselves: every table where a
--   retry could duplicate a financial record carries `idempotency_key`, unique
--   per organization. Scoped per organization and never globally, for the
--   reason 0006 gives — keys are chosen by clients, and two tenants sending
--   `retry-1` is the ordinary case, not a theoretical one.
--
--   The uniqueness is the guarantee, not a check the application performs. A
--   second insert with the same key fails with 23505 however many transactions
--   are in flight, exactly as the exclusion constraint in 0009 refuses the
--   second overlapping booking.
--
-- ── `unknown` is a status, and that is the point ────────────────────────────
--
--   PAYMENT_STATUSES carries `unknown` because a processor that times out has
--   either charged the card or not, and we cannot tell. Recording that as
--   `failed` is how a guest is charged twice on the retry. `payment_attempts`
--   is what makes `unknown` recoverable: one row per call to the processor,
--   with the key that was sent and whatever came back, so a reconciliation can
--   ask the provider about a specific attempt instead of guessing.
--
-- ── What is deliberately not soft-deletable ─────────────────────────────────
--
--   `payments`, `payment_attempts`, `refunds`, `invoices` and `credit_notes`
--   have no `deleted_at`, and no DELETE grant. A financial record is cancelled,
--   voided, refunded or credited — all of which are states with a date and an
--   author — and never removed. An issued invoice is immutable in its money
--   fields by trigger as well as by convention, because in Israel an issued tax
--   invoice is corrected with a credit note and not with an UPDATE.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, units, property_in_scope), 0009
--   (bookings, guests, and the composite keys the foreign keys below rely on).
--
-- Followed by
--   0011_operations.sql — tasks, inventory, approvals and commissions.
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- Types — transcribed from src/lib/contracts/states.ts
-- ============================================================================

-- PAYMENT_STATUSES, in order.
do $$ begin
  create type public.payment_status as enum (
    'pending',
    'authorized',
    'paid',
    'partially_paid',
    'failed',
    'refunded',
    'partially_refunded',
    'cancelled',
    'unknown'
  );
exception when duplicate_object then null;
end $$;

comment on type public.payment_status is
  'Transcribed from PAYMENT_STATUSES in src/lib/contracts/states.ts, in the same order. `authorized` and `paid` are separate because a deposit is often held without being taken. `unknown` is the one that matters most: a processor that timed out has either charged the card or not, and reporting that as failed is how a guest is charged twice on the retry.';

-- PAYMENT_METHODS, in order.
do $$ begin
  create type public.payment_method as enum (
    'card',
    'bit',
    'bank_transfer',
    'cash',
    'paybox',
    'other'
  );
exception when duplicate_object then null;
end $$;

-- Not from the contract. A document kind, not a payment state: whether an
-- invoice has been paid is a question for `payments`, not for the paper.
do $$ begin
  create type public.invoice_kind as enum (
    'proforma',
    'tax_invoice',
    'receipt',
    'tax_invoice_receipt'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.invoice_status as enum (
    'draft',
    'issued',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.invoice_status is
  'The life of the document itself: drafted, issued, cancelled. Deliberately not a payment state — an invoice that has been paid is a fact about `payments`, and duplicating it here is how two screens end up disagreeing about whether money arrived.';


-- ── The settled set, stated once ────────────────────────────────────────────
-- SETTLED_PAYMENT_STATUSES from the contract: the statuses where money has
-- actually moved to the business. Used by the refund ceiling and by the
-- deposit arithmetic, so it is a function rather than a list repeated twice.

create or replace function public.settled_payment_statuses()
returns public.payment_status[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'paid',
    'partially_paid',
    'partially_refunded'
  ]::public.payment_status[];
$$;

comment on function public.settled_payment_statuses() is
  'Transcribed from SETTLED_PAYMENT_STATUSES in src/lib/contracts/states.ts: the statuses in which money has actually reached the business. `refunded` is absent on purpose — the money came and went, and a fully refunded payment can back no further refund.';

grant execute on function public.settled_payment_statuses() to authenticated, service_role;


-- ============================================================================
-- payments
-- ============================================================================
-- Money received against a stay. One row per intent to collect, whatever
-- happened to it afterwards: a failed card is a payment in status `failed`,
-- not an absence, because "we tried and it was declined" is something a
-- receptionist has to be able to see.

create table if not exists public.payments (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null,
  property_id             uuid not null,
  booking_id              uuid not null,

  status                  public.payment_status not null default 'pending',
  method                  public.payment_method not null,

  amount_agorot           integer not null,
  currency                text not null default 'ILS',
  -- Maintained by trigger from `refunds`, never by a caller. A refunded total
  -- that disagrees with the refunds themselves is an argument with a customer
  -- that the business loses.
  amount_refunded_agorot  integer not null default 0,

  -- ── The retry guard ──────────────────────────────────────────────────────
  -- Unique per organization. A second insert carrying the same key fails with
  -- 23505 regardless of how many transactions are in flight; there is no read
  -- and therefore no window.
  idempotency_key         text,

  -- ── The processor ────────────────────────────────────────────────────────
  provider                text,
  provider_payment_id     text,
  provider_reference      text,
  -- Whatever the provider calls this state. Kept beside our own rather than
  -- instead of it: their vocabulary changes, ours is a contract.
  provider_status         text,
  failure_code            text,
  failure_message         text,

  authorized_at           timestamptz,
  paid_at                 timestamptz,
  failed_at               timestamptz,
  cancelled_at            timestamptz,

  -- Who paid, when it is not the booking's guest — a parent, a company.
  payer_name              text,
  payer_reference         text,
  note                    text,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,

  -- One foreign key, three facts: the booking exists, it is in this property,
  -- and that property is in this organization.
  constraint payments_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,

  -- What the attempts and the refunds hang their tenant proof on.
  constraint payments_id_organization_key unique (id, organization_id),
  constraint payments_id_organization_property_key unique (id, organization_id, property_id),

  constraint payments_amount_positive check (amount_agorot > 0),
  constraint payments_refunded_range check (
    amount_refunded_agorot >= 0 and amount_refunded_agorot <= amount_agorot
  ),
  constraint payments_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint payments_idempotency_key_not_blank check (
    idempotency_key is null or length(btrim(idempotency_key)) > 0
  ),
  -- Money that has arrived has a moment at which it arrived. Stamped by
  -- trigger, so this cannot be tripped by an ordinary caller — it catches a
  -- direct write that skipped the trigger path.
  constraint payments_paid_has_moment check (
    status <> all (array['paid', 'partially_paid', 'refunded', 'partially_refunded']::public.payment_status[])
    or paid_at is not null
  ),
  constraint payments_version_positive check (version >= 1)
);

comment on table public.payments is
  'Money received against a stay: one row per intent to collect, in whatever state that intent ended. A declined card is a row in status failed, not an absence — "we tried and it was declined" is something a receptionist has to be able to see. Never deleted: cancelled, voided and refunded are states with a date and an author.';
comment on column public.payments.idempotency_key is
  'Client-chosen, unique per organization. The reason a lost connection, a double-delivered webhook and an impatient guest all end in one charge. The uniqueness is the guarantee; no application check can close that window, because a check is a read and a read has a gap after it.';
comment on column public.payments.amount_refunded_agorot is
  'The sum of settled refunds against this payment, maintained by trigger and never by a caller.';
comment on column public.payments.provider_status is
  'The processor own word for this state, kept beside ours rather than instead of it. Their vocabulary changes; PAYMENT_STATUSES is a contract.';

create unique index if not exists payments_organization_idempotency_idx
  on public.payments (organization_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists payments_touch on public.payments;
create trigger payments_touch
  before update on public.payments
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- payment_attempts
-- ============================================================================
-- One row per call to the processor. This is what makes `unknown` recoverable:
-- a timed-out attempt records the key that was sent, so reconciliation can ask
-- the provider about that exact request rather than guessing whether the card
-- was charged.
--
-- Its own idempotency key, separate from the payment's: the payment key stops
-- a second payment being created, and the attempt key stops a second charge
-- being sent for the payment that already exists.

create table if not exists public.payment_attempts (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  payment_id            uuid not null,

  attempt_number        integer not null default 1,
  status                public.payment_status not null default 'pending',

  idempotency_key       text,

  provider              text,
  provider_request_id   text,
  provider_response     jsonb,
  http_status           integer,
  error_code            text,
  error_message         text,

  started_at            timestamptz not null default now(),
  completed_at          timestamptz,

  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  version               integer not null default 1,

  constraint payment_attempts_payment_fkey
    foreign key (payment_id, organization_id)
    references public.payments (id, organization_id) on delete cascade,
  constraint payment_attempts_number_unique unique (payment_id, attempt_number),
  constraint payment_attempts_number_positive check (attempt_number >= 1),
  constraint payment_attempts_idempotency_key_not_blank check (
    idempotency_key is null or length(btrim(idempotency_key)) > 0
  ),
  constraint payment_attempts_version_positive check (version >= 1)
);

comment on table public.payment_attempts is
  'One row per call to the payment processor, including the ones that timed out. The record that makes an unknown payment recoverable: it holds the key that was sent, so a reconciliation asks the provider about a specific request instead of guessing whether the card was charged.';
comment on column public.payment_attempts.idempotency_key is
  'The key sent to the processor. Separate from payments.idempotency_key on purpose: that one stops a second payment being created, this one stops a second charge being sent for the payment that already exists.';

create unique index if not exists payment_attempts_organization_idempotency_idx
  on public.payment_attempts (organization_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists payment_attempts_touch on public.payment_attempts;
create trigger payment_attempts_touch
  before update on public.payment_attempts
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- refunds
-- ============================================================================
-- Money going back. Attached to the payment it reverses rather than to the
-- booking alone, because "which charge is this reversing" is the first
-- question a chargeback asks.

create table if not exists public.refunds (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  property_id          uuid not null,
  booking_id           uuid not null,
  payment_id           uuid not null,

  status               public.payment_status not null default 'pending',
  amount_agorot        integer not null,
  currency             text not null default 'ILS',

  reason               text,
  -- A refund is frequently an exception someone had to allow. The approval
  -- that permitted it lives in 0011; this is the free-text record of who and
  -- why, which survives whether or not a formal approval was raised.
  approved_by          uuid references auth.users (id) on delete set null,

  idempotency_key      text,

  provider             text,
  provider_refund_id   text,
  failure_code         text,
  failure_message      text,

  refunded_at          timestamptz,
  failed_at            timestamptz,

  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,

  constraint refunds_payment_fkey
    foreign key (payment_id, organization_id, property_id)
    references public.payments (id, organization_id, property_id) on delete restrict,
  constraint refunds_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,
  constraint refunds_amount_positive check (amount_agorot > 0),
  constraint refunds_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint refunds_idempotency_key_not_blank check (
    idempotency_key is null or length(btrim(idempotency_key)) > 0
  ),
  constraint refunds_version_positive check (version >= 1)
);

comment on table public.refunds is
  'Money going back, attached to the payment it reverses. The total refunded against a payment can never exceed what was taken — enforced by a trigger that sums the settled refunds, because that is a rule across rows and no CHECK can see across rows.';

create unique index if not exists refunds_organization_idempotency_idx
  on public.refunds (organization_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists refunds_touch on public.refunds;
create trigger refunds_touch
  before update on public.refunds
  for each row execute function public.tg_touch_row();


-- ── The refund ceiling ──────────────────────────────────────────────────────
-- A CHECK cannot see other rows, so this is a trigger: after any change to a
-- refund, the payment's `amount_refunded_agorot` is recomputed from the
-- settled refunds and written back. The column has a CHECK bounding it by
-- `amount_agorot`, so refunding more than was taken fails with 23514 — the
-- constraint refuses it, not a branch in the application.

create or replace function public.tg_refunds_recalc_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := coalesce(new.payment_id, old.payment_id);
begin
  update public.payments p
     set amount_refunded_agorot = coalesce((
           select sum(r.amount_agorot)
             from public.refunds r
            where r.payment_id = target
              and r.status = any (public.settled_payment_statuses())
         ), 0)
   where p.id = target;

  if tg_op = 'UPDATE' and new.payment_id is distinct from old.payment_id then
    update public.payments p
       set amount_refunded_agorot = coalesce((
             select sum(r.amount_agorot)
               from public.refunds r
              where r.payment_id = old.payment_id
                and r.status = any (public.settled_payment_statuses())
           ), 0)
     where p.id = old.payment_id;
  end if;

  return null;
end;
$$;

comment on function public.tg_refunds_recalc_payment() is
  'Recomputes payments.amount_refunded_agorot from the settled refunds after any change to a refund. The ceiling itself is the CHECK on that column: refunding more than was taken fails with 23514, from the constraint rather than from a branch somebody could forget to write.';

drop trigger if exists refunds_recalc_payment on public.refunds;
create trigger refunds_recalc_payment
  after insert or update or delete on public.refunds
  for each row execute function public.tg_refunds_recalc_payment();


-- ============================================================================
-- deposits
-- ============================================================================
-- The security deposit: money held, not earned. One per booking, because
-- `BookingSnapshot.depositHeldAgorot` in src/lib/booking/state-machine.ts is
-- singular and the `completed` transition refuses to close a booking while the
-- business is still holding the guest's money.
--
-- Four amounts rather than one, because a deposit is four different facts:
-- what was asked for, what is actually held, what has gone back, and what was
-- kept against damage. A single `amount` column forces the other three to be
-- reconstructed from prose in a note field.

create table if not exists public.deposits (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  property_id          uuid not null,
  booking_id           uuid not null,

  status               public.payment_status not null default 'pending',
  method               public.payment_method,

  required_agorot      integer not null default 0,
  held_agorot          integer not null default 0,
  released_agorot      integer not null default 0,
  forfeited_agorot     integer not null default 0,
  currency             text not null default 'ILS',

  -- The charge that took it, when it was actually taken rather than merely
  -- authorised on the card.
  payment_id           uuid,

  idempotency_key      text,

  authorized_at        timestamptz,
  captured_at          timestamptz,
  released_at          timestamptz,
  released_by          uuid references auth.users (id) on delete set null,
  forfeited_at         timestamptz,
  -- Keeping a guest's deposit is the single most disputed act in this product.
  -- The reason is required by the CHECK below, not by a form.
  forfeit_reason       text,

  note                 text,
  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,

  constraint deposits_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,
  constraint deposits_payment_fkey
    foreign key (payment_id, organization_id, property_id)
    references public.payments (id, organization_id, property_id)
    on delete set null (payment_id),
  -- One deposit per booking. The domain treats "the deposit held" as a single
  -- number; two rows would make that number ambiguous.
  constraint deposits_booking_key unique (booking_id),
  constraint deposits_amounts_nonnegative check (
    required_agorot >= 0 and held_agorot >= 0
    and released_agorot >= 0 and forfeited_agorot >= 0
  ),
  -- Nothing may leave a deposit that never entered it.
  constraint deposits_disbursed_within_held check (
    released_agorot + forfeited_agorot <= held_agorot
  ),
  constraint deposits_forfeit_has_reason check (
    forfeited_agorot = 0 or length(btrim(coalesce(forfeit_reason, ''))) > 0
  ),
  constraint deposits_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint deposits_idempotency_key_not_blank check (
    idempotency_key is null or length(btrim(idempotency_key)) > 0
  ),
  constraint deposits_version_positive check (version >= 1)
);

comment on table public.deposits is
  'The security deposit: money held and not earned. One per booking, because the booking state machine treats "the deposit held" as a single number and refuses to complete a stay while it is above zero. Four amounts — required, held, released, forfeited — because a deposit is four facts, and collapsing them forces the rest to be reconstructed from a note.';
comment on column public.deposits.forfeit_reason is
  'Required by CHECK whenever anything is forfeited. Keeping a guest money is the most disputed act in the product, and a reason recorded months later is a reason invented months later.';

create unique index if not exists deposits_organization_idempotency_idx
  on public.deposits (organization_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists deposits_touch on public.deposits;
create trigger deposits_touch
  before update on public.deposits
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- Invoice numbering — gapless, and without a race
-- ============================================================================
-- An Israeli tax invoice carries a sequential number per business, and a gap
-- in the sequence is a question from the tax authority. "Read the highest
-- number, add one, insert" is the double-booking race wearing a different hat:
-- two requests read the same number and one of them fails on the unique index
-- — or worse, on a table without one, both succeed and two invoices share a
-- number.
--
-- So allocation is a single statement against a counter row, and the row lock
-- is the serialisation. No read, no window.

create table if not exists public.invoice_sequences (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  series           text not null default 'default',
  -- Israeli practice numbers per calendar year. `0` means one unbroken run.
  year             integer not null default 0,
  next_number      bigint not null default 1,

  updated_at       timestamptz not null default now(),

  primary key (organization_id, series, year),
  constraint invoice_sequences_series_not_blank check (length(btrim(series)) > 0),
  constraint invoice_sequences_next_positive check (next_number >= 1),
  constraint invoice_sequences_year_range check (year = 0 or year between 2000 and 2200)
);

comment on table public.invoice_sequences is
  'The counter behind gapless invoice numbering. Allocation is one INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so the row lock serialises concurrent issuers. Read-then-write would be the double-booking race in different clothes.';

create or replace function public.next_invoice_number(
  target_organization_id uuid,
  target_series text default 'default',
  target_year integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated bigint;
begin
  -- One statement, and the row lock is the serialisation. On the insert path
  -- the row is created holding 2, so the number allocated is 1; on the
  -- conflict path the counter moves to old + 1 and the number allocated is
  -- old. `next_number - 1` is therefore right on both paths, with no branch
  -- and no read.
  insert into public.invoice_sequences (organization_id, series, year, next_number)
  values (target_organization_id, target_series, target_year, 2)
  on conflict (organization_id, series, year) do update
    set next_number = invoice_sequences.next_number + 1,
        updated_at  = now()
  returning next_number - 1
  into allocated;

  return allocated;
end;
$$;

comment on function public.next_invoice_number(uuid, text, integer) is
  'Allocates the next invoice number for an organization, series and year in one statement. The counter row lock is what serialises two issuers; there is no read to race against. SECURITY DEFINER because the counter is not writable by callers.';

revoke all on function public.next_invoice_number(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.next_invoice_number(uuid, text, integer) to service_role;


-- ============================================================================
-- invoices
-- ============================================================================

create table if not exists public.invoices (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  property_id         uuid not null,
  booking_id          uuid not null,

  kind                public.invoice_kind not null default 'tax_invoice',
  status              public.invoice_status not null default 'draft',

  series              text not null default 'default',
  year                integer not null default 0,
  -- NULL while the document is a draft. Allocated by next_invoice_number() at
  -- the moment of issue, which is the moment it becomes a legal document.
  number              bigint,
  -- What is printed: "2026-000184". Kept as its own column so the display form
  -- survives a change in how numbers are composed.
  display_number      text,

  -- Who it is made out to, snapshotted. A guest may correct their name
  -- tomorrow; an issued invoice may not change.
  customer_name       text not null,
  customer_tax_id     text,
  customer_address    text,
  customer_email      citext,

  subtotal_agorot     integer not null default 0,
  tax_agorot          integer not null default 0,
  total_agorot        integer not null default 0,
  tax_rate_bps        integer,
  -- Snapshotted from the property. The rule that applied is a fact about the
  -- document, not a lookup that can be re-evaluated later.
  tourist_vat_exempt  boolean not null default false,
  currency            text not null default 'ILS',

  issued_at           timestamptz,
  due_date            date,
  cancelled_at        timestamptz,
  cancelled_by        uuid references auth.users (id) on delete set null,
  cancellation_reason text,

  idempotency_key     text,

  provider            text,
  provider_invoice_id text,
  document_url        text,

  note                text,
  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint invoices_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,
  constraint invoices_id_organization_property_key unique (id, organization_id, property_id),
  constraint invoices_number_unique unique (organization_id, series, year, number),

  constraint invoices_customer_name_not_blank check (length(btrim(customer_name)) > 0),
  constraint invoices_series_not_blank check (length(btrim(series)) > 0),
  constraint invoices_amounts_nonnegative check (
    subtotal_agorot >= 0 and tax_agorot >= 0 and total_agorot >= 0
  ),
  constraint invoices_total_is_sum check (total_agorot = subtotal_agorot + tax_agorot),
  constraint invoices_tax_rate_range check (tax_rate_bps is null or tax_rate_bps between 0 and 10000),
  constraint invoices_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- An issued document has a number and a moment; a draft has neither.
  constraint invoices_issued_pair check (
    (status = 'draft' and issued_at is null and number is null)
    or (status <> 'draft' and issued_at is not null and number is not null)
  ),
  constraint invoices_cancelled_pair check (
    (status = 'cancelled') = (cancelled_at is not null)
  ),
  constraint invoices_idempotency_key_not_blank check (
    idempotency_key is null or length(btrim(idempotency_key)) > 0
  ),
  constraint invoices_version_positive check (version >= 1)
);

comment on table public.invoices is
  'A document, not a payment state. Whether it has been paid is a question for `payments`; duplicating that here is how two screens end up disagreeing about whether money arrived. Immutable in its money fields once issued, by trigger: an issued tax invoice is corrected with a credit note, never with an UPDATE.';
comment on column public.invoices.number is
  'NULL while the document is a draft. Allocated by next_invoice_number() at the moment of issue — in one statement, so two issuers cannot take the same number.';
comment on column public.invoices.customer_name is
  'Snapshotted. The guest may correct their name tomorrow; an issued invoice may not change.';

create unique index if not exists invoices_organization_idempotency_idx
  on public.invoices (organization_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists invoices_touch on public.invoices;
create trigger invoices_touch
  before update on public.invoices
  for each row execute function public.tg_touch_row();


-- ── An issued invoice is frozen ─────────────────────────────────────────────
-- Not a matter of discipline. Once `issued_at` is set, the money fields, the
-- number, the customer and the booking are refused on UPDATE. What is still
-- allowed is everything that does not change what the document says:
-- cancelling it, attaching the provider's copy, notes and metadata.

create or replace function public.tg_invoices_freeze_issued()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.issued_at is null then
    return new;
  end if;

  if new.number             is distinct from old.number
     or new.series          is distinct from old.series
     or new.year            is distinct from old.year
     or new.kind            is distinct from old.kind
     or new.booking_id      is distinct from old.booking_id
     or new.customer_name   is distinct from old.customer_name
     or new.customer_tax_id is distinct from old.customer_tax_id
     or new.subtotal_agorot is distinct from old.subtotal_agorot
     or new.tax_agorot      is distinct from old.tax_agorot
     or new.total_agorot    is distinct from old.total_agorot
     or new.tax_rate_bps    is distinct from old.tax_rate_bps
     or new.currency        is distinct from old.currency
     or new.issued_at       is distinct from old.issued_at
  then
    raise exception
      'invoice % is issued; its number, customer and amounts cannot be changed', old.id
      using errcode = '42501',
            hint = 'Cancel it and issue a credit note. An issued tax invoice is corrected, not edited.';
  end if;

  return new;
end;
$$;

comment on function public.tg_invoices_freeze_issued() is
  'Refuses any change to the number, customer, booking or amounts of an issued invoice. Cancelling it, attaching the provider copy and editing notes stay allowed — none of those change what the document says.';

drop trigger if exists invoices_freeze_issued on public.invoices;
create trigger invoices_freeze_issued
  before update on public.invoices
  for each row execute function public.tg_invoices_freeze_issued();


-- ============================================================================
-- credit_notes
-- ============================================================================
-- The instrument that corrects an issued invoice. Carries its own number in
-- its own series, for the same reason invoices do.

create table if not exists public.credit_notes (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  property_id         uuid not null,
  invoice_id          uuid not null,
  booking_id          uuid not null,

  status              public.invoice_status not null default 'draft',

  series              text not null default 'credit',
  year                integer not null default 0,
  number              bigint,
  display_number      text,

  amount_agorot       integer not null,
  tax_agorot          integer not null default 0,
  currency            text not null default 'ILS',

  reason              text not null,
  issued_at           timestamptz,
  cancelled_at        timestamptz,

  idempotency_key     text,

  provider            text,
  provider_document_id text,
  document_url        text,

  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint credit_notes_invoice_fkey
    foreign key (invoice_id, organization_id, property_id)
    references public.invoices (id, organization_id, property_id) on delete restrict,
  constraint credit_notes_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,
  constraint credit_notes_number_unique unique (organization_id, series, year, number),
  constraint credit_notes_amount_positive check (amount_agorot > 0),
  constraint credit_notes_tax_nonnegative check (tax_agorot >= 0),
  constraint credit_notes_reason_not_blank check (length(btrim(reason)) > 0),
  constraint credit_notes_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint credit_notes_issued_pair check (
    (status = 'draft' and issued_at is null and number is null)
    or (status <> 'draft' and issued_at is not null and number is not null)
  ),
  constraint credit_notes_idempotency_key_not_blank check (
    idempotency_key is null or length(btrim(idempotency_key)) > 0
  ),
  constraint credit_notes_version_positive check (version >= 1)
);

comment on table public.credit_notes is
  'The instrument that corrects an issued invoice. Its own series and number, for the same reason an invoice has one. The total credited against an invoice may never exceed the invoice — enforced by trigger, because that is a rule across rows.';

create unique index if not exists credit_notes_organization_idempotency_idx
  on public.credit_notes (organization_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists credit_notes_touch on public.credit_notes;
create trigger credit_notes_touch
  before update on public.credit_notes
  for each row execute function public.tg_touch_row();


-- ── A credit note cannot exceed its invoice ─────────────────────────────────
-- Across rows, so a trigger rather than a CHECK. Counted over notes that are
-- not cancelled, so cancelling one frees the amount again.

create or replace function public.tg_credit_notes_within_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invoice_total bigint;
  credited      bigint;
begin
  select i.total_agorot into invoice_total
    from public.invoices i where i.id = new.invoice_id;

  select coalesce(sum(c.amount_agorot), 0) into credited
    from public.credit_notes c
   where c.invoice_id = new.invoice_id
     and c.status <> 'cancelled'::public.invoice_status;

  if credited > invoice_total then
    raise exception
      'credit notes against invoice % total %, which exceeds the invoice total of %',
      new.invoice_id, credited, invoice_total
      using errcode = '23514';
  end if;

  return null;
end;
$$;

comment on function public.tg_credit_notes_within_invoice() is
  'Refuses a credit note that would take the total credited past the invoice total. Counted over notes that are not cancelled, so cancelling one frees the amount again.';

drop trigger if exists credit_notes_within_invoice on public.credit_notes;
create trigger credit_notes_within_invoice
  after insert or update on public.credit_notes
  for each row execute function public.tg_credit_notes_within_invoice();


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.payments          enable row level security;
alter table public.payments          force  row level security;
alter table public.payment_attempts  enable row level security;
alter table public.payment_attempts  force  row level security;
alter table public.refunds           enable row level security;
alter table public.refunds           force  row level security;
alter table public.deposits          enable row level security;
alter table public.deposits          force  row level security;
alter table public.invoices          enable row level security;
alter table public.invoices          force  row level security;
alter table public.credit_notes      enable row level security;
alter table public.credit_notes      force  row level security;
alter table public.invoice_sequences enable row level security;
alter table public.invoice_sequences force  row level security;

revoke all on public.payments          from anon, authenticated;
revoke all on public.payment_attempts  from anon, authenticated;
revoke all on public.refunds           from anon, authenticated;
revoke all on public.deposits          from anon, authenticated;
revoke all on public.invoices          from anon, authenticated;
revoke all on public.credit_notes      from anon, authenticated;
revoke all on public.invoice_sequences from anon, authenticated;

-- No DELETE anywhere in this file. A financial record is cancelled, voided,
-- refunded or credited — every one of those a state with a date and an author
-- — and never removed. The absence of the grant is the enforcement; the
-- absence of a policy is the second, independent one.
grant select, insert, update on public.payments         to authenticated;
grant select, insert, update on public.payment_attempts to authenticated;
grant select, insert, update on public.refunds          to authenticated;
grant select, insert, update on public.deposits         to authenticated;
grant select, insert, update on public.invoices         to authenticated;
grant select, insert, update on public.credit_notes     to authenticated;

grant select, insert, update on public.payments         to service_role;
grant select, insert, update on public.payment_attempts to service_role;
grant select, insert, update on public.refunds          to service_role;
grant select, insert, update on public.deposits         to service_role;
grant select, insert, update on public.invoices         to service_role;
grant select, insert, update on public.credit_notes     to service_role;

-- Supabase ALTER DEFAULT PRIVILEGES hands service_role everything on a new
-- table, and service_role carries BYPASSRLS, so the grant is the only thing
-- standing between a background job and a deleted payment record.
revoke delete, truncate on public.payments         from service_role;
revoke delete, truncate on public.payment_attempts from service_role;
revoke delete, truncate on public.refunds          from service_role;
revoke delete, truncate on public.deposits         from service_role;
revoke delete, truncate on public.invoices         from service_role;
revoke delete, truncate on public.credit_notes     from service_role;

-- The counter is nobody's to read or write. It is reached only through
-- next_invoice_number(), which is SECURITY DEFINER; the numbers themselves
-- appear on the invoices.
revoke all on public.invoice_sequences from anon, authenticated, service_role;


-- ── Policies · payments ─────────────────────────────────────────────────────
-- Tenant, then property scope, then grant — the same three terms as `bookings`
-- in 0009. `payment.view` is a real gate: a cleaner holds booking.view and
-- must not see what the stay cost, let alone the card that paid for it.

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.view')
  );

drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
  );

-- Capturing an authorisation, marking a transfer received, voiding a pending
-- charge: all of them are updates, and `payment.capture` is the grant that
-- separates recording an intent from moving the money.
drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'payment.capture')
      or public.has_permission(organization_id, 'payment.void')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'payment.capture')
      or public.has_permission(organization_id, 'payment.void')
    )
  );


-- ── Policies · payment_attempts ─────────────────────────────────────────────
-- No property_id: an attempt belongs to a payment, and the payment carries the
-- property. The scope term is therefore an EXISTS against the parent, which
-- keeps one definition of "which properties may this member reach" rather than
-- two that can drift.

drop policy if exists payment_attempts_select on public.payment_attempts;
create policy payment_attempts_select on public.payment_attempts
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.view')
    and exists (
      select 1 from public.payments p
      where p.id = payment_attempts.payment_id
        and p.organization_id = payment_attempts.organization_id
        and public.property_in_scope(p.property_id, p.organization_id)
    )
  );

drop policy if exists payment_attempts_insert on public.payment_attempts;
create policy payment_attempts_insert on public.payment_attempts
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.create')
    and exists (
      select 1 from public.payments p
      where p.id = payment_attempts.payment_id
        and p.organization_id = payment_attempts.organization_id
        and public.property_in_scope(p.property_id, p.organization_id)
    )
  );

drop policy if exists payment_attempts_update on public.payment_attempts;
create policy payment_attempts_update on public.payment_attempts
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.capture')
    and exists (
      select 1 from public.payments p
      where p.id = payment_attempts.payment_id
        and p.organization_id = payment_attempts.organization_id
        and public.property_in_scope(p.property_id, p.organization_id)
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.capture')
  );


-- ── Policies · refunds ──────────────────────────────────────────────────────

drop policy if exists refunds_select on public.refunds;
create policy refunds_select on public.refunds
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.view')
  );

drop policy if exists refunds_insert on public.refunds;
create policy refunds_insert on public.refunds
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.refund')
  );

drop policy if exists refunds_update on public.refunds;
create policy refunds_update on public.refunds
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.refund')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.refund')
  );


-- ── Policies · deposits ─────────────────────────────────────────────────────
-- Reading a deposit is `booking.view_deposit`, which the permission catalogue
-- already separates from `booking.view_price` — how much of a guest's money the
-- business is holding is not the same fact as what the stay cost.

drop policy if exists deposits_select on public.deposits;
create policy deposits_select on public.deposits
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view_deposit')
  );

drop policy if exists deposits_insert on public.deposits;
create policy deposits_insert on public.deposits
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'deposit.hold')
  );

-- Either grant, because both acts are updates of this row and the two are
-- held by different people: taking a deposit is front desk, giving it back is
-- the decision the booking state machine gates behind `deposit.release`.
drop policy if exists deposits_update on public.deposits;
create policy deposits_update on public.deposits
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'deposit.hold')
      or public.has_permission(organization_id, 'deposit.release')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'deposit.hold')
      or public.has_permission(organization_id, 'deposit.release')
    )
  );


-- ── Policies · invoices and credit_notes ────────────────────────────────────

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.issue')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists credit_notes_select on public.credit_notes;
create policy credit_notes_select on public.credit_notes
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists credit_notes_insert on public.credit_notes;
create policy credit_notes_insert on public.credit_notes
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists credit_notes_update on public.credit_notes;
create policy credit_notes_update on public.credit_notes
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.issue')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'invoice.issue')
  );


-- ============================================================================
-- Indexes
-- ============================================================================
-- Every organization_id, every foreign key a policy walks, and the columns a
-- reconciliation actually filters on. The metadata columns (created_by,
-- updated_by) are left unindexed for the reason 0004 gives.

create index if not exists payments_organization_idx
  on public.payments (organization_id);
create index if not exists payments_property_idx
  on public.payments (property_id);
create index if not exists payments_booking_idx
  on public.payments (booking_id);
create index if not exists payments_organization_status_idx
  on public.payments (organization_id, status);
-- Reconciliation looks a payment up by what the provider called it.
create index if not exists payments_provider_payment_idx
  on public.payments (organization_id, provider, provider_payment_id)
  where provider_payment_id is not null;
-- "What came in today", the single most-run finance query.
create index if not exists payments_organization_paid_at_idx
  on public.payments (organization_id, paid_at desc) where paid_at is not null;

create index if not exists payment_attempts_organization_idx
  on public.payment_attempts (organization_id);
create index if not exists payment_attempts_payment_idx
  on public.payment_attempts (payment_id, attempt_number);
-- The reconciliation query: attempts that never came back.
create index if not exists payment_attempts_unresolved_idx
  on public.payment_attempts (organization_id, started_at)
  where status in ('pending', 'unknown');

create index if not exists refunds_organization_idx
  on public.refunds (organization_id);
create index if not exists refunds_property_idx
  on public.refunds (property_id);
create index if not exists refunds_payment_idx
  on public.refunds (payment_id);
create index if not exists refunds_booking_idx
  on public.refunds (booking_id);
create index if not exists refunds_organization_status_idx
  on public.refunds (organization_id, status);

create index if not exists deposits_organization_idx
  on public.deposits (organization_id);
create index if not exists deposits_property_idx
  on public.deposits (property_id);
create index if not exists deposits_payment_idx
  on public.deposits (payment_id) where payment_id is not null;
-- The one that matters operationally: deposits still being held.
create index if not exists deposits_held_idx
  on public.deposits (organization_id)
  where held_agorot > released_agorot + forfeited_agorot;

create index if not exists invoices_organization_idx
  on public.invoices (organization_id);
create index if not exists invoices_property_idx
  on public.invoices (property_id);
create index if not exists invoices_booking_idx
  on public.invoices (booking_id);
create index if not exists invoices_organization_issued_idx
  on public.invoices (organization_id, issued_at desc) where issued_at is not null;

create index if not exists credit_notes_organization_idx
  on public.credit_notes (organization_id);
create index if not exists credit_notes_property_idx
  on public.credit_notes (property_id);
create index if not exists credit_notes_invoice_idx
  on public.credit_notes (invoice_id);
create index if not exists credit_notes_booking_idx
  on public.credit_notes (booking_id);
