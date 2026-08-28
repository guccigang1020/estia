-- ============================================================================
-- 0016_finance.sql — ESTIA · what was taken, not what was asked for
--
-- ── The money bug this file exists to fix ───────────────────────────────────
--
--   0010 gave `payments` one amount column and bounded refunds against it:
--
--       CHECK (amount_refunded_agorot >= 0
--              AND amount_refunded_agorot <= amount_agorot)
--
--   `amount_agorot` is what was *asked for*. On a card, that is not what was
--   taken. A deposit is authorised for ₪1,000 and often released untouched;
--   a partial capture takes ₪400 of it. The database had no way to say so, and
--   the constraint therefore permitted a ₪600 refund against ₪400 of real
--   money — cash out of the business, allowed by the very constraint that was
--   supposed to bound it.
--
--   Reproduced before the fix, as the owner, with no application in the way:
--
--       refund of 60000 against 40000 captured  ->  ACCEPTED
--       payments.amount_refunded_agorot         ->  60000
--
--   `authorized_agorot` and `captured_agorot` are added, and the ceiling is
--   rewritten against `captured_agorot`. src/lib/finance/refunds.ts says the
--   same rule three times over and names this as the enforcement an attacker
--   cannot reach: "The ceiling is measured against capturedAgorot, never
--   against the status."
--
-- ── Why a table for provider events, and not two columns ────────────────────
--
--   The brief offered `applied_event_ids text[]` plus `last_provider_event_at`
--   or a `payment_provider_events` table, and preferred the table. So does
--   this file, for three reasons the array cannot give:
--
--     · **The uniqueness is the idempotency.** `unique (organization_id,
--       provider, event_id)` makes a duplicate webhook fail at the index, in
--       the same way 0010's idempotency keys do. An array needs read, test,
--       append — three steps with a race between them, which is the exact
--       shape of bug this database keeps refusing to have.
--     · **An event arrives before its payment is known.** A webhook naming a
--       provider reference we have not seen has nowhere to go in an array on a
--       row that does not exist yet. As a table it is recorded, unmatched, and
--       reconcilable.
--     · **It is evidence.** The payload is what settles a dispute with the
--       processor, and an array of ids keeps none of it.
--
--   `payments.last_provider_event_at` is kept as well, because that one really
--   is a property of the payment: it is what makes an out-of-order webhook
--   detectable without reading the whole event table.
--
-- ── Two other things worth stating ──────────────────────────────────────────
--
--   **The adapter must not write `payments.amount_refunded_agorot`.** Confirmed
--   against the live database rather than assumed: 0010 installed
--   `refunds_recalc_payment`, an AFTER INSERT OR UPDATE OR DELETE trigger that
--   recomputes the column from the settled refunds. A caller that also writes
--   it is overwritten on the next refund change, silently and correctly. That
--   trigger is updated here, because the refund status vocabulary changes below.
--
--   **Archival is not a status.** `invoices.archived_at` is its own column, per
--   src/lib/finance/invoices.ts: "A product that made archival a status would
--   eventually have somebody tidy up a year's revenue." `status` stays the
--   answer to "is this document legally in force".
--
-- ── A contract collision, reported rather than resolved ─────────────────────
--
--   `COMMISSION_BASES` is declared twice in the codebase with different
--   members: `whole_booking | accommodation_only` in src/lib/agents, and
--   `stay_total | gross_revenue | net_revenue` in src/lib/finance. They are not
--   the same axis. 0015 created `public.commission_base` for the first; this
--   file adds `public.commission_basis` for the second and touches neither
--   module. Which of the two `commissions` should carry is a decision for
--   whoever owns those files, not for a migration to settle by picking one.
--
-- Depends on
--   0010 (payments, refunds, invoices, credit_notes), 0011 (commissions),
--   0012 (the permission catalogue), 0015 (agent_payout_batches).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- Types — transcribed from src/lib/finance/types.ts
-- ============================================================================

do $$ begin
  create type public.payment_purpose as enum (
    'deposit', 'balance', 'full', 'instalment', 'partial', 'security_deposit', 'fee'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.collection_channel as enum (
    'payment_link', 'hosted_page', 'terminal', 'manual'
  );
exception when duplicate_object then null;
end $$;

comment on type public.collection_channel is
  'How the money was collected. `manual` and `terminal` are what make cash and desk payments excludable from provider reconciliation — without this column a cash payment looks like a provider payment the processor has never heard of.';

do $$ begin
  create type public.payment_attention as enum (
    'reconcile_unknown', 'refund_after_cancellation', 'overpaid'
  );
exception when duplicate_object then null;
end $$;

comment on type public.payment_attention is
  'Why a person has to look at this payment. An unresolved `unknown` is either a guest who paid and has no booking or one who has a booking and did not pay, and both need a human.';

do $$ begin
  create type public.refund_status as enum (
    'requested', 'approved', 'rejected', 'processed', 'failed', 'unknown'
  );
exception when duplicate_object then null;
end $$;

comment on type public.refund_status is
  'Transcribed from REFUND_STATUSES. A refund is not a payment and does not share its life: 0010 typed this column as payment_status, which had no word for "rejected" and called a completed refund "paid".';

do $$ begin
  create type public.refund_reason as enum (
    'guest_cancellation', 'business_cancellation', 'overpayment', 'service_failure',
    'goodwill', 'duplicate_charge', 'deposit_release', 'correction'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.instalment_cadence as enum ('weekly', 'monthly');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.expense_kind as enum ('fixed', 'variable');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.expense_frequency as enum (
    'one_time', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.expense_scope_kind as enum (
    'organization', 'property', 'unit', 'booking'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.allocation_method as enum (
    'per_day', 'per_occupied_night', 'per_booking', 'per_guest',
    'by_revenue', 'by_unit', 'custom'
  );
exception when duplicate_object then null;
end $$;

-- The finance module's COMMISSION_BASES. See the header: this is a different
-- axis from public.commission_base, which 0015 created for src/lib/agents.
do $$ begin
  create type public.commission_basis as enum (
    'stay_total', 'gross_revenue', 'net_revenue'
  );
exception when duplicate_object then null;
end $$;

comment on type public.commission_basis is
  'COMMISSION_BASES as src/lib/finance/types.ts declares them. Deliberately not the same type as public.commission_base, which carries the src/lib/agents vocabulary. The two modules disagree; this migration records the disagreement rather than resolving it.';


-- ============================================================================
-- 1 · payments — authorized, captured, and a ceiling that means something
-- ============================================================================

alter table public.payments
  add column if not exists authorized_agorot     integer not null default 0,
  add column if not exists captured_agorot       integer not null default 0,
  add column if not exists purpose               public.payment_purpose not null default 'full',
  add column if not exists channel               public.collection_channel not null default 'manual',
  add column if not exists requires_attention    public.payment_attention,
  add column if not exists unknown_since         timestamptz,
  add column if not exists last_provider_event_at timestamptz,
  add column if not exists schedule_id           uuid,
  add column if not exists instalment_number     integer,
  add column if not exists due_on                date;

-- Backfill before the constraint, so the rule is imposed on data that already
-- satisfies it rather than on data that has to be repaired afterwards. A
-- settled payment captured what it asked for; an authorised one reserved it.
update public.payments
   set captured_agorot = case
         when status = any (public.settled_payment_statuses())
           or status = 'refunded'::public.payment_status
         then amount_agorot else 0 end,
       authorized_agorot = case
         when status = 'authorized'::public.payment_status then amount_agorot
         when status = any (public.settled_payment_statuses()) then amount_agorot
         else 0 end
 where captured_agorot = 0 and authorized_agorot = 0;

-- The fix. Refunds are bounded by what was taken, never by what was asked for.
alter table public.payments drop constraint if exists payments_refunded_range;
alter table public.payments
  add constraint payments_refunded_within_captured check (
    amount_refunded_agorot >= 0
    and amount_refunded_agorot <= captured_agorot
  );

do $$ begin
  alter table public.payments
    add constraint payments_amounts_within_requested check (
      authorized_agorot between 0 and amount_agorot
      and captured_agorot between 0 and amount_agorot
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.payments
    add constraint payments_instalment_pair check (
      (schedule_id is null) = (instalment_number is null)
      and (instalment_number is null or instalment_number >= 1)
    );
exception when duplicate_object then null;
end $$;

-- An unknown payment is one nobody has resolved yet, and the moment it became
-- unknown is what an ageing report is built on.
do $$ begin
  alter table public.payments
    add constraint payments_unknown_has_moment check (
      status <> 'unknown'::public.payment_status or unknown_since is not null
    );
exception when duplicate_object then null;
end $$;

comment on column public.payments.amount_agorot is
  'What was asked for. Not what was taken — see captured_agorot. Bounding a refund by this column is the bug 0016 fixed.';
comment on column public.payments.authorized_agorot is
  'Reserved on the card and not yet taken. A deposit is often authorised and released untouched, which is why this is a separate number from the one below.';
comment on column public.payments.captured_agorot is
  'Actually taken. The only basis a refund may be measured against, and the column payments_refunded_within_captured bounds amount_refunded_agorot by.';
comment on column public.payments.channel is
  'How it was collected. `manual` and `terminal` are what let cash and desk payments be excluded from provider reconciliation.';
comment on column public.payments.unknown_since is
  'When this payment became unknown. An unresolved unknown is either a guest who paid and has no booking or one who has a booking and did not pay; both age, and both need a person.';
comment on column public.payments.last_provider_event_at is
  'The timestamp of the newest provider event applied. What makes an out-of-order webhook detectable without reading the event table.';

create index if not exists payments_attention_idx
  on public.payments (organization_id, requires_attention)
  where requires_attention is not null;
create index if not exists payments_unknown_idx
  on public.payments (organization_id, unknown_since)
  where status = 'unknown';
create index if not exists payments_due_idx
  on public.payments (organization_id, due_on) where due_on is not null;
create index if not exists payments_schedule_idx
  on public.payments (schedule_id, instalment_number) where schedule_id is not null;
-- Reconciliation runs against the provider; cash and manual are not in it.
create index if not exists payments_channel_idx
  on public.payments (organization_id, channel);


-- ============================================================================
-- 2 · payment_provider_events — a duplicate webhook is a no-op
-- ============================================================================

create table if not exists public.payment_provider_events (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  payment_id        uuid,

  provider          text not null,
  -- The processor's own id for this event. Unique per organization and
  -- provider: that index is the idempotency, not a check somebody performs.
  event_id          text not null,
  event_type        text not null,
  provider_ref      text,

  -- The processor's clock, not ours. An event older than what the payment has
  -- already applied is stale and must not move it backwards.
  occurred_at       timestamptz,
  received_at       timestamptz not null default now(),
  applied_at        timestamptz,
  outcome           text,

  payload           jsonb not null default '{}'::jsonb,

  constraint payment_provider_events_payment_fkey
    foreign key (payment_id, organization_id)
    references public.payments (id, organization_id) on delete set null (payment_id),
  constraint payment_provider_events_unique unique (organization_id, provider, event_id),
  constraint payment_provider_events_provider_not_blank check (length(btrim(provider)) > 0),
  constraint payment_provider_events_event_id_not_blank check (length(btrim(event_id)) > 0),
  constraint payment_provider_events_outcome check (
    outcome is null
    or outcome in ('applied', 'duplicate', 'stale', 'mismatched_reference', 'ignored')
  )
);

comment on table public.payment_provider_events is
  'Every webhook the processor sent, once. `unique (organization_id, provider, event_id)` is what makes a duplicate delivery a no-op — at the index, with no read to race against. payment_id is nullable on purpose: an event naming a reference we have not seen yet is recorded and reconciled, not dropped.';
comment on column public.payment_provider_events.payload is
  'The processor own message, kept whole. It is the evidence a dispute is settled with, and an array of event ids keeps none of it.';

create index if not exists payment_provider_events_payment_idx
  on public.payment_provider_events (payment_id) where payment_id is not null;
create index if not exists payment_provider_events_organization_idx
  on public.payment_provider_events (organization_id, received_at desc);
create index if not exists payment_provider_events_unmatched_idx
  on public.payment_provider_events (organization_id, received_at)
  where payment_id is null;
create index if not exists payment_provider_events_ref_idx
  on public.payment_provider_events (organization_id, provider_ref)
  where provider_ref is not null;


-- ============================================================================
-- 3 · refunds — a refund is not a payment
-- ============================================================================

alter table public.refunds
  add column if not exists approval_status    public.approval_status not null default 'requested',
  add column if not exists requested_by       uuid references auth.users (id) on delete set null,
  add column if not exists reason_code        public.refund_reason,
  add column if not exists requested_at       timestamptz not null default now(),
  add column if not exists processed_at       timestamptz,
  add column if not exists settled_by_event_id uuid;

-- The status column was payment_status, which has no word for a rejected
-- refund and calls a completed one "paid". Mapped rather than dropped, so an
-- existing row keeps its meaning.
do $$
begin
  if (select atttypid from pg_attribute
       where attrelid = 'public.refunds'::regclass and attname = 'status')
     = 'public.payment_status'::regtype
  then
    alter table public.refunds alter column status drop default;
    alter table public.refunds
      alter column status type public.refund_status
      using (case status::text
               when 'pending'            then 'requested'
               when 'authorized'         then 'approved'
               when 'paid'               then 'processed'
               when 'partially_paid'     then 'processed'
               when 'refunded'           then 'processed'
               when 'partially_refunded' then 'processed'
               when 'failed'             then 'failed'
               when 'cancelled'          then 'rejected'
               else 'unknown'
             end)::public.refund_status;
    alter table public.refunds alter column status set default 'requested';
  end if;
end $$;

do $$ begin
  alter table public.refunds
    add constraint refunds_event_fkey
    foreign key (settled_by_event_id)
    references public.payment_provider_events (id) on delete set null;
exception when duplicate_object or duplicate_table then null;
end $$;

do $$ begin
  alter table public.refunds
    add constraint refunds_processed_has_moment check (
      status <> 'processed'::public.refund_status or processed_at is not null
    );
exception when duplicate_object then null;
end $$;

comment on column public.refunds.approval_status is
  'Whether a person allowed this refund, on the shared APPROVAL_STATUSES vocabulary rather than a private one. Separate from `status`, which is what the processor did with it: a refund can be approved and still fail.';
comment on column public.refunds.requested_by is
  'Who asked for it. A refund nobody is named on is a refund nobody can be asked about.';

create index if not exists refunds_approval_idx
  on public.refunds (organization_id, approval_status);
create index if not exists refunds_requested_by_idx
  on public.refunds (requested_by) where requested_by is not null;

-- The recalculation follows the new vocabulary: a refund has moved money when
-- the processor has processed it, and not before.
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
              and r.status = 'processed'::public.refund_status
         ), 0)
   where p.id = target;

  if tg_op = 'UPDATE' and new.payment_id is distinct from old.payment_id then
    update public.payments p
       set amount_refunded_agorot = coalesce((
             select sum(r.amount_agorot)
               from public.refunds r
              where r.payment_id = old.payment_id
                and r.status = 'processed'::public.refund_status
           ), 0)
     where p.id = old.payment_id;
  end if;

  return null;
end;
$$;

comment on function public.tg_refunds_recalc_payment() is
  'Recomputes payments.amount_refunded_agorot from the processed refunds. The column is owned by this trigger and never by an adapter: a caller that writes it is overwritten on the next refund change. The ceiling is the CHECK on that column, which since 0016 bounds it by captured_agorot rather than by the amount requested.';

revoke all on function public.tg_refunds_recalc_payment() from public, anon, authenticated, service_role;


-- ============================================================================
-- 4 · payment_schedules
-- ============================================================================

create table if not exists public.payment_schedules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  booking_id       uuid not null,

  total_agorot     integer not null default 0,
  currency         text not null default 'ILS',
  cadence          public.instalment_cadence,

  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint payment_schedules_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete cascade,
  constraint payment_schedules_id_organization_key unique (id, organization_id),
  constraint payment_schedules_total_nonnegative check (total_agorot >= 0),
  constraint payment_schedules_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint payment_schedules_version_positive check (version >= 1)
);

comment on table public.payment_schedules is
  'A booking paid in instalments. The schedule holds the plan; each payment row carries schedule_id and instalment_number, so what was planned and what actually arrived are two records that can be compared rather than one that can only be overwritten.';

create table if not exists public.payment_schedule_instalments (
  schedule_id       uuid not null,
  organization_id   uuid not null,
  instalment_number integer not null,

  amount_agorot     integer not null,
  due_on            date not null,
  purpose           public.payment_purpose not null default 'instalment',

  created_at        timestamptz not null default now(),

  primary key (schedule_id, instalment_number),
  constraint payment_schedule_instalments_schedule_fkey
    foreign key (schedule_id, organization_id)
    references public.payment_schedules (id, organization_id) on delete cascade,
  constraint payment_schedule_instalments_number_positive check (instalment_number >= 1),
  constraint payment_schedule_instalments_amount_positive check (amount_agorot > 0)
);

comment on table public.payment_schedule_instalments is
  'One row per planned instalment. A table rather than JSON on the schedule, so a payment can point at the instalment it settles with a real foreign key.';

do $$ begin
  alter table public.payments
    add constraint payments_schedule_fkey
    foreign key (schedule_id, organization_id)
    references public.payment_schedules (id, organization_id) on delete set null (schedule_id);
exception when duplicate_object or duplicate_table then null;
end $$;

create index if not exists payment_schedules_booking_idx
  on public.payment_schedules (booking_id);
create index if not exists payment_schedules_organization_idx
  on public.payment_schedules (organization_id);
create index if not exists payment_schedule_instalments_due_idx
  on public.payment_schedule_instalments (organization_id, due_on);

drop trigger if exists payment_schedules_touch on public.payment_schedules;
create trigger payment_schedules_touch before update on public.payment_schedules
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · finance_snapshots — insert-only, so a rule change cannot rewrite March
-- ============================================================================
-- The natural key is `(organization_id, booking_id, captured_at)`, exactly as
-- src/lib/finance/snapshot.ts says: capturedAt "is part of the snapshot's
-- identity, and its sort order". There is no surrogate id, because a second row
-- with the same capture instant is not a second snapshot.
--
-- A superseded snapshot is retained and never modified: it is the evidence for
-- the statement that was already sent. That is why this table has no UPDATE and
-- no DELETE for anybody.

create table if not exists public.finance_snapshots (
  organization_id         uuid not null,
  booking_id              uuid not null,
  captured_at             timestamptz not null,

  property_id             uuid,
  unit_id                 uuid not null,
  captured_by             uuid references auth.users (id) on delete set null,
  -- Mandatory. "Why did March's profit change?" must have an answer with a
  -- name and a timestamp on it.
  reason                  text not null,
  revision                integer not null default 1,
  supersedes_captured_at  timestamptz,

  check_in                date not null,
  check_out               date not null,
  nights                  integer not null,
  guests                  integer not null,

  lines                   jsonb not null default '[]'::jsonb,
  total_agorot            integer not null default 0,
  stay_total_agorot       integer not null default 0,
  deposit_agorot          integer not null default 0,
  tax_agorot              integer not null default 0,
  tax_rate_percent        numeric(6,3) not null default 0,
  currency                text not null default 'ILS',

  commission_rule         jsonb,
  owner_share_rule        jsonb,
  expense_rules           jsonb not null default '[]'::jsonb,

  created_at              timestamptz not null default now(),

  primary key (organization_id, booking_id, captured_at),
  constraint finance_snapshots_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  constraint finance_snapshots_reason_not_blank check (length(btrim(reason)) > 0),
  constraint finance_snapshots_revision_positive check (revision >= 1),
  constraint finance_snapshots_dates_ordered check (check_out > check_in),
  constraint finance_snapshots_nights_positive check (nights >= 1),
  constraint finance_snapshots_guests_positive check (guests >= 1),
  constraint finance_snapshots_lines_is_array check (jsonb_typeof(lines) = 'array'),
  constraint finance_snapshots_expense_rules_is_array check (jsonb_typeof(expense_rules) = 'array'),
  constraint finance_snapshots_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- The first revision supersedes nothing; every later one names what it
  -- replaced, so the chain can be walked back.
  constraint finance_snapshots_supersedes_pair check (
    (revision = 1) = (supersedes_captured_at is null)
  )
);

comment on table public.finance_snapshots is
  'The financial basis of a booking, frozen at an instant. Insert-only: a superseded snapshot is retained and never modified, because it is the evidence for the statement that was already sent. This is what makes a rule change unable to rewrite last month profit.';
comment on column public.finance_snapshots.captured_at is
  'Part of the identity, not metadata. Two captures at one instant are one capture, which is why it is in the primary key.';

create index if not exists finance_snapshots_booking_idx
  on public.finance_snapshots (booking_id, captured_at desc);
create index if not exists finance_snapshots_organization_idx
  on public.finance_snapshots (organization_id, captured_at desc);

create or replace function public.tg_finance_snapshots_insert_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'finance_snapshots is insert-only; % is not permitted', tg_op
    using errcode = '42501',
          hint = 'Capture a new snapshot with a reason. The superseded one is the evidence for statements already sent.';
end;
$$;

revoke all on function public.tg_finance_snapshots_insert_only() from public, anon, authenticated, service_role;

drop trigger if exists finance_snapshots_no_update on public.finance_snapshots;
create trigger finance_snapshots_no_update
  before update on public.finance_snapshots
  for each statement execute function public.tg_finance_snapshots_insert_only();

drop trigger if exists finance_snapshots_no_delete on public.finance_snapshots;
create trigger finance_snapshots_no_delete
  before delete on public.finance_snapshots
  for each statement execute function public.tg_finance_snapshots_insert_only();


-- ============================================================================
-- 6 · expense_rules and expense_allocations
-- ============================================================================
-- The rule's history is not a second table here: `finance_snapshots` embeds the
-- rules as they stood (`SnapshottedExpenseRule` carries ruleId and ruleVersion),
-- so the evidence is already retained by the insert-only table above. What this
-- needs is a version that moves on every edit, which `tg_touch_row` provides.

create table if not exists public.expense_rules (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,

  label              text not null,
  category           text not null,
  kind               public.expense_kind not null default 'fixed',
  frequency          public.expense_frequency not null default 'monthly',
  amount_agorot      integer not null default 0,
  -- The VariableFormula union: per_night, per_guest_night, per_booking,
  -- per_guest, percent_of_revenue. NULL for a fixed rule.
  formula            jsonb,
  allocation         public.allocation_method not null default 'per_booking',

  scope_kind         public.expense_scope_kind not null default 'organization',
  scope_property_id  uuid,
  scope_unit_id      uuid,
  scope_booking_id   uuid,

  effective_from     date not null default current_date,
  -- Exclusive. NULL means still in force.
  effective_to       date,
  approval_required  boolean not null default false,

  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  version            integer not null default 1,
  deleted_at         timestamptz,
  deleted_by         uuid references auth.users (id) on delete set null,

  constraint expense_rules_id_organization_key unique (id, organization_id),
  constraint expense_rules_label_not_blank check (length(btrim(label)) > 0),
  constraint expense_rules_category_not_blank check (length(btrim(category)) > 0),
  constraint expense_rules_amount_nonnegative check (amount_agorot >= 0),
  constraint expense_rules_dates_ordered check (
    effective_to is null or effective_to > effective_from
  ),
  -- A scope that names nothing at the level it claims is a rule nobody can
  -- apply. `organization` names nothing by definition; the other three must.
  constraint expense_rules_scope_target check (
    case scope_kind
      when 'organization' then scope_property_id is null and scope_unit_id is null and scope_booking_id is null
      when 'property'     then scope_property_id is not null
      when 'unit'         then scope_unit_id is not null
      when 'booking'      then scope_booking_id is not null
    end
  ),
  -- A variable rule is computed from a formula; a fixed one is not.
  constraint expense_rules_formula_pair check (
    (kind = 'variable') = (formula is not null)
  ),
  constraint expense_rules_formula_kind check (
    formula is null
    or formula ->> 'kind' in ('per_night','per_guest_night','per_booking','per_guest','percent_of_revenue')
  ),
  constraint expense_rules_version_positive check (version >= 1),
  constraint expense_rules_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.expense_rules is
  'What the business spends, as a rule rather than a row per month. Its version moves on every edit through tg_touch_row, and finance_snapshots keeps the terms as they stood — so a rule edited today does not change what a booking cost in March.';
comment on column public.expense_rules.effective_to is
  'Exclusive, and NULL means still in force. Matching the half-open convention every date range in this product uses.';

create index if not exists expense_rules_organization_idx
  on public.expense_rules (organization_id) where deleted_at is null;
create index if not exists expense_rules_scope_property_idx
  on public.expense_rules (scope_property_id) where scope_property_id is not null;
create index if not exists expense_rules_scope_unit_idx
  on public.expense_rules (scope_unit_id) where scope_unit_id is not null;
create index if not exists expense_rules_scope_booking_idx
  on public.expense_rules (scope_booking_id) where scope_booking_id is not null;
create index if not exists expense_rules_live_idx
  on public.expense_rules (organization_id, effective_from)
  where deleted_at is null and effective_to is null;

drop trigger if exists expense_rules_touch on public.expense_rules;
create trigger expense_rules_touch before update on public.expense_rules
  for each row execute function public.tg_touch_row();


create table if not exists public.expense_allocations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  rule_id           uuid not null,
  rule_version      integer not null,
  booking_id        uuid not null,

  method            public.allocation_method not null,
  period_start      date not null,
  period_end        date not null,
  amount_agorot     integer not null,
  weight            numeric(12,6) not null default 0,
  basis             text,

  allocated_at      timestamptz not null default now(),
  allocated_by      uuid references auth.users (id) on delete set null,

  constraint expense_allocations_rule_fkey
    foreign key (rule_id, organization_id)
    references public.expense_rules (id, organization_id) on delete restrict,
  constraint expense_allocations_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id) on delete cascade,
  -- One share per rule, per booking, per period. Running an allocation twice
  -- must not charge a booking twice, and this is what says so.
  constraint expense_allocations_unique unique (rule_id, booking_id, period_start, period_end),
  constraint expense_allocations_period_ordered check (period_end > period_start),
  constraint expense_allocations_amount_nonnegative check (amount_agorot >= 0)
);

comment on table public.expense_allocations is
  'The result of spreading an expense across bookings: what src/lib/finance computes, written down so a report can be reproduced. `unique (rule_id, booking_id, period_start, period_end)` is what stops a second allocation run charging the same booking twice.';

create index if not exists expense_allocations_organization_idx
  on public.expense_allocations (organization_id, period_start);
create index if not exists expense_allocations_booking_idx
  on public.expense_allocations (booking_id);
create index if not exists expense_allocations_rule_idx
  on public.expense_allocations (rule_id, rule_version);


-- ============================================================================
-- 7 · commission_statements, and the two columns a commission was missing
-- ============================================================================

create table if not exists public.commission_statements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  agent_user_id    uuid not null references auth.users (id) on delete restrict,

  -- Half-open [period_start, period_end), measured on became-eligible.
  period_start     date not null,
  period_end       date not null,
  total_agorot     integer not null default 0,
  currency         text not null default 'ILS',
  issued_at        timestamptz,

  note             text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint commission_statements_id_organization_key unique (id, organization_id),
  constraint commission_statements_period_ordered check (period_end > period_start),
  constraint commission_statements_total_nonnegative check (total_agorot >= 0),
  constraint commission_statements_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint commission_statements_version_positive check (version >= 1),
  -- One statement per agent per period. A second one is a reprint, not a new
  -- document, and two would mean two totals for one month.
  constraint commission_statements_period_key unique (organization_id, agent_user_id, period_start, period_end)
);

comment on table public.commission_statements is
  'The period statement for one agent. `estimated` and `pending` commissions never appear on one — a statement is a document an agent treats as a promise. Unique per agent and period, because two statements for one month are two totals for one month.';

create index if not exists commission_statements_agent_idx
  on public.commission_statements (organization_id, agent_user_id, period_start desc);

drop trigger if exists commission_statements_touch on public.commission_statements;
create trigger commission_statements_touch before update on public.commission_statements
  for each row execute function public.tg_touch_row();


-- `payout_batches` is not created as a second table. 0015 already built
-- `agent_payout_batches` for the same concept from src/lib/agents, with the
-- unique reference and the one-batch-per-commission guarantee the brief asks
-- for. Two tables would mean two answers to "has this commission been paid",
-- which is the failure both were built to prevent. What the finance module
-- needs that it lacked is an approver and the ability to cover more than one
-- agent, so those are added to the existing table.
alter table public.agent_payout_batches
  add column if not exists approved_by uuid references auth.users (id) on delete set null,
  add column if not exists approved_at timestamptz;

alter table public.agent_payout_batches alter column agent_user_id drop not null;

comment on column public.agent_payout_batches.agent_user_id is
  'The agent this batch pays. Nullable since 0016: src/lib/agents builds one batch per agent and enforces that in the domain, while src/lib/finance groups by period and may cover several. The database allows both and neither module has to lie about what it produced.';
comment on column public.agent_payout_batches.approved_by is
  'Who released the money. src/lib/finance PayoutBatch carries approvedByUserId, and a payout nobody approved is a payout nobody is answerable for.';

alter table public.commissions
  add column if not exists statement_id       uuid,
  add column if not exists payout_batch_id    uuid,
  add column if not exists clawback_required  boolean not null default false;

do $$ begin
  alter table public.commissions
    add constraint commissions_statement_fkey
    foreign key (statement_id, organization_id)
    references public.commission_statements (id, organization_id)
    on delete set null (statement_id);
exception when duplicate_object or duplicate_table then null;
end $$;

do $$ begin
  alter table public.commissions
    add constraint commissions_payout_batch_fkey
    foreign key (payout_batch_id, organization_id)
    references public.agent_payout_batches (id, organization_id)
    on delete set null (payout_batch_id);
exception when duplicate_object or duplicate_table then null;
end $$;

comment on column public.commissions.clawback_required is
  'The stay was cancelled or refunded after the commission was paid. Money already sent has to come back, and a flag on the row is what puts it on somebody list rather than leaving it to be noticed.';

create index if not exists commissions_statement_idx
  on public.commissions (statement_id) where statement_id is not null;
create index if not exists commissions_payout_batch_idx
  on public.commissions (payout_batch_id) where payout_batch_id is not null;
create index if not exists commissions_clawback_idx
  on public.commissions (organization_id) where clawback_required;


-- ============================================================================
-- 8 · Documents that can itemise
-- ============================================================================
-- An invoice storing only subtotal, tax and total cannot answer "why ₪3,835?",
-- which is the one question an invoice exists to answer. Lines as rows rather
-- than as JSON, so the total can be checked against them and so a line can be
-- queried — a tax report grouped by line kind is not a thing you write against
-- a jsonb blob twice.

-- 0010 gave `invoices` a key on (id, organization_id, property_id). A line
-- belongs to the document, not to the property, so it needs the two-column
-- form. Purely additive: `id` is already the primary key.
do $$ begin
  alter table public.invoices
    add constraint invoices_id_organization_key unique (id, organization_id);
exception when duplicate_object or duplicate_table then null;
end $$;

create table if not exists public.invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  invoice_id       uuid not null,

  kind             public.price_line_kind not null,
  label            text not null,
  amount_agorot    integer not null,
  quantity         numeric(12,3) not null default 1,
  line_date        date,
  sort_order       integer not null default 0,

  created_at       timestamptz not null default now(),

  constraint invoice_lines_invoice_fkey
    foreign key (invoice_id, organization_id)
    references public.invoices (id, organization_id) on delete cascade,
  constraint invoice_lines_label_not_blank check (length(btrim(label)) > 0),
  constraint invoice_lines_quantity_positive check (quantity > 0)
);

comment on table public.invoice_lines is
  'What the invoice is made of. Rows rather than JSON so the document can be itemised, queried and checked — "why ₪3,835?" is the question an invoice exists to answer, and a total with no lines cannot.';

create index if not exists invoice_lines_invoice_idx
  on public.invoice_lines (invoice_id, sort_order);
create index if not exists invoice_lines_organization_idx
  on public.invoice_lines (organization_id);

create table if not exists public.credit_note_lines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  credit_note_id   uuid not null,

  kind             public.price_line_kind not null,
  label            text not null,
  amount_agorot    integer not null,
  quantity         numeric(12,3) not null default 1,
  line_date        date,
  sort_order       integer not null default 0,

  created_at       timestamptz not null default now(),

  constraint credit_note_lines_note_fkey
    foreign key (credit_note_id) references public.credit_notes (id) on delete cascade,
  constraint credit_note_lines_label_not_blank check (length(btrim(label)) > 0),
  constraint credit_note_lines_quantity_positive check (quantity > 0)
);

comment on table public.credit_note_lines is
  'What the credit note reverses, line by line. The amount is always positive: the direction is the document type, not the sign.';

create index if not exists credit_note_lines_note_idx
  on public.credit_note_lines (credit_note_id, sort_order);
create index if not exists credit_note_lines_organization_idx
  on public.credit_note_lines (organization_id);

-- Archival is not a status, and this is the column that keeps it from becoming
-- one. An archived tax invoice is still legally in force; `status` remains the
-- answer to that question and `archived_at` is an operational convenience.
alter table public.invoices
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references auth.users (id) on delete set null,
  add column if not exists snapshot_captured_at timestamptz;

comment on column public.invoices.archived_at is
  'Filed away by somebody working the list. Deliberately not a status value: a product that made archival a status would eventually have somebody tidy up a year of revenue, and "is this document legally in force" would stop being answerable from status.';
comment on column public.invoices.snapshot_captured_at is
  'Which finance snapshot the lines were taken from, so an invoice reprinted next year is identical to the one that was sent.';

create index if not exists invoices_archived_idx
  on public.invoices (organization_id) where archived_at is null;


-- ============================================================================
-- 9 · commission.manage joins the catalogue
-- ============================================================================

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
values ('commission.manage', 'action'::public.permission_kind, 'agent', false, 1155)
on conflict (code) do update
  set kind = excluded.kind, category = excluded.category,
      is_owner_only = excluded.is_owner_only;

-- The derivation from 0002 and 0012, re-run so the new code reaches the two
-- roles that are computed rather than listed.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r cross join public.permissions p
where r.code = 'organization_owner' and r.organization_id is null and not p.is_platform
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r cross join public.permissions p
where r.code = 'administrator' and r.organization_id is null
  and not p.is_platform and not p.is_owner_only
on conflict do nothing;

-- Whoever already manages the commercial terms manages the commissions.
insert into public.role_permissions (role_id, permission_code)
select r.id, 'commission.manage'
from public.roles r
where r.organization_id is null and r.code in ('general_manager', 'finance_manager')
on conflict do nothing;


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.payment_provider_events        enable row level security;
alter table public.payment_provider_events        force  row level security;
alter table public.payment_schedules              enable row level security;
alter table public.payment_schedules              force  row level security;
alter table public.payment_schedule_instalments   enable row level security;
alter table public.payment_schedule_instalments   force  row level security;
alter table public.finance_snapshots              enable row level security;
alter table public.finance_snapshots              force  row level security;
alter table public.expense_rules                  enable row level security;
alter table public.expense_rules                  force  row level security;
alter table public.expense_allocations            enable row level security;
alter table public.expense_allocations            force  row level security;
alter table public.commission_statements          enable row level security;
alter table public.commission_statements          force  row level security;
alter table public.invoice_lines                  enable row level security;
alter table public.invoice_lines                  force  row level security;
alter table public.credit_note_lines              enable row level security;
alter table public.credit_note_lines              force  row level security;

revoke all on public.payment_provider_events      from anon, authenticated;
revoke all on public.payment_schedules            from anon, authenticated;
revoke all on public.payment_schedule_instalments from anon, authenticated;
revoke all on public.finance_snapshots            from anon, authenticated;
revoke all on public.expense_rules                from anon, authenticated;
revoke all on public.expense_allocations          from anon, authenticated;
revoke all on public.commission_statements        from anon, authenticated;
revoke all on public.invoice_lines                from anon, authenticated;
revoke all on public.credit_note_lines            from anon, authenticated;

grant select, insert, update         on public.payment_provider_events      to authenticated;
grant select, insert, update, delete on public.payment_schedules            to authenticated;
grant select, insert, update, delete on public.payment_schedule_instalments to authenticated;
grant select, insert                 on public.finance_snapshots            to authenticated;
grant select, insert, update, delete on public.expense_rules                to authenticated;
grant select, insert, update, delete on public.expense_allocations          to authenticated;
grant select, insert, update         on public.commission_statements        to authenticated;
grant select, insert, update, delete on public.invoice_lines                to authenticated;
grant select, insert, update, delete on public.credit_note_lines            to authenticated;

grant select, insert, update         on public.payment_provider_events      to service_role;
grant select, insert, update, delete on public.payment_schedules            to service_role;
grant select, insert, update, delete on public.payment_schedule_instalments to service_role;
grant select, insert                 on public.finance_snapshots            to service_role;
grant select, insert, update, delete on public.expense_rules                to service_role;
grant select, insert, update, delete on public.expense_allocations          to service_role;
grant select, insert, update         on public.commission_statements        to service_role;
grant select, insert, update, delete on public.invoice_lines                to service_role;
grant select, insert, update, delete on public.credit_note_lines            to service_role;

-- Insert-only means insert-only for the background job too.
revoke update, delete, truncate on public.finance_snapshots       from service_role;
revoke delete, truncate         on public.payment_provider_events from service_role;
revoke delete, truncate         on public.commission_statements   from service_role;


drop policy if exists payment_provider_events_select on public.payment_provider_events;
create policy payment_provider_events_select on public.payment_provider_events
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.view')
  );

drop policy if exists payment_provider_events_insert on public.payment_provider_events;
create policy payment_provider_events_insert on public.payment_provider_events
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.create')
  );

drop policy if exists payment_provider_events_update on public.payment_provider_events;
create policy payment_provider_events_update on public.payment_provider_events
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.capture')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.capture')
  );


drop policy if exists payment_schedules_select on public.payment_schedules;
create policy payment_schedules_select on public.payment_schedules
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.view')
  );

drop policy if exists payment_schedules_insert on public.payment_schedules;
create policy payment_schedules_insert on public.payment_schedules
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
  );

drop policy if exists payment_schedules_update on public.payment_schedules;
create policy payment_schedules_update on public.payment_schedules
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
  );

drop policy if exists payment_schedules_delete on public.payment_schedules;
create policy payment_schedules_delete on public.payment_schedules
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'payment.create')
  );

drop policy if exists payment_schedule_instalments_select on public.payment_schedule_instalments;
create policy payment_schedule_instalments_select on public.payment_schedule_instalments
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.view')
  );

drop policy if exists payment_schedule_instalments_insert on public.payment_schedule_instalments;
create policy payment_schedule_instalments_insert on public.payment_schedule_instalments
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.create')
  );

drop policy if exists payment_schedule_instalments_update on public.payment_schedule_instalments;
create policy payment_schedule_instalments_update on public.payment_schedule_instalments
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.create')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.create')
  );

drop policy if exists payment_schedule_instalments_delete on public.payment_schedule_instalments;
create policy payment_schedule_instalments_delete on public.payment_schedule_instalments
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'payment.create')
  );


-- No UPDATE and no DELETE policy on the snapshots, because there is no grant.
drop policy if exists finance_snapshots_select on public.finance_snapshots;
create policy finance_snapshots_select on public.finance_snapshots
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'finance.view')
  );

drop policy if exists finance_snapshots_insert on public.finance_snapshots;
create policy finance_snapshots_insert on public.finance_snapshots
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'finance.view')
  );


drop policy if exists expense_rules_select on public.expense_rules;
create policy expense_rules_select on public.expense_rules
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.view')
  );

drop policy if exists expense_rules_insert on public.expense_rules;
create policy expense_rules_insert on public.expense_rules
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.create')
  );

drop policy if exists expense_rules_update on public.expense_rules;
create policy expense_rules_update on public.expense_rules
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.create')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.create')
  );

drop policy if exists expense_rules_delete on public.expense_rules;
create policy expense_rules_delete on public.expense_rules
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.approve')
  );

drop policy if exists expense_allocations_select on public.expense_allocations;
create policy expense_allocations_select on public.expense_allocations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.view')
  );

drop policy if exists expense_allocations_insert on public.expense_allocations;
create policy expense_allocations_insert on public.expense_allocations
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.create')
  );

drop policy if exists expense_allocations_update on public.expense_allocations;
create policy expense_allocations_update on public.expense_allocations
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.create')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.create')
  );

drop policy if exists expense_allocations_delete on public.expense_allocations;
create policy expense_allocations_delete on public.expense_allocations
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'expense.create')
  );


drop policy if exists commission_statements_select on public.commission_statements;
create policy commission_statements_select on public.commission_statements
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'commission.view')
      or agent_user_id = (select auth.uid())
    )
  );

drop policy if exists commission_statements_insert on public.commission_statements;
create policy commission_statements_insert on public.commission_statements
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.manage')
  );

drop policy if exists commission_statements_update on public.commission_statements;
create policy commission_statements_update on public.commission_statements
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.manage')
  );


-- Document lines follow their document: reading them is invoice.view, writing
-- them is invoice.issue, exactly as 0010 gated the documents themselves.
drop policy if exists invoice_lines_select on public.invoice_lines;
create policy invoice_lines_select on public.invoice_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists invoice_lines_insert on public.invoice_lines;
create policy invoice_lines_insert on public.invoice_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists invoice_lines_update on public.invoice_lines;
create policy invoice_lines_update on public.invoice_lines
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists invoice_lines_delete on public.invoice_lines;
create policy invoice_lines_delete on public.invoice_lines
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists credit_note_lines_select on public.credit_note_lines;
create policy credit_note_lines_select on public.credit_note_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.view')
  );

drop policy if exists credit_note_lines_insert on public.credit_note_lines;
create policy credit_note_lines_insert on public.credit_note_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists credit_note_lines_update on public.credit_note_lines;
create policy credit_note_lines_update on public.credit_note_lines
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );

drop policy if exists credit_note_lines_delete on public.credit_note_lines;
create policy credit_note_lines_delete on public.credit_note_lines
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'invoice.issue')
  );
