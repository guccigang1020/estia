-- ============================================================================
-- 0055_laundry_orders_record_the_providers_confirmation.sql — ESTIA
--
-- The defect
--   `laundry_orders` has `sent_at` and no confirmation column. So the question
--   the laundry detector has to answer — has the provider actually AGREED to
--   this turnaround? — is unfalsifiable. The only timestamp available is the
--   moment WE sent the request, and reading that as their agreement would
--   record our own message as their answer.
--
--   The consequence in the product: an organization in `external` laundry mode
--   sees `laundry.unconfirmed` on every open order, permanently. A signal that
--   is always true is a signal nobody reads, which is the same failure as not
--   having one — and it would have been the first thing Autopilot said to
--   every laundry customer on every pass.
--
-- How it was found
--   By the agent wiring the detector fact sources, which returned the field as
--   null and said why, rather than filling it from `sent_at` because a column
--   was there.
--
-- Why `confirmed_by` is text
--   The party confirming is at the LAUNDRY, not in this database. Recording
--   who at the provider agreed, as they gave it, is the honest shape. A
--   foreign key to `auth.users` would force their answer to be filed under one
--   of our own staff, which is a small lie that becomes the record.
--
-- Depends on
--   0029 (laundry_orders).
-- ============================================================================

set search_path = public, extensions;

alter table public.laundry_orders
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by text;

comment on column public.laundry_orders.confirmed_at is
  'When the PROVIDER agreed to the turnaround, which is a different fact from sent_at — the moment we asked. Null means unconfirmed, and that is what makes "the provider has not confirmed" a falsifiable claim rather than a sentence true of every open order.';
comment on column public.laundry_orders.confirmed_by is
  'Who at the provider confirmed, as they gave it. Text and not a reference to auth.users, because the party confirming is at the laundry and not in this database; a foreign key would force their answer to be filed under one of our own staff.';

-- A confirmation cannot precede the request that prompted it, and cannot exist
-- for an order nobody sent.
do $$ begin
  alter table public.laundry_orders
    add constraint laundry_orders_confirmed_after_sent check (
      confirmed_at is null
      or (sent_at is not null and confirmed_at >= sent_at)
    );
exception when duplicate_object then null;
end $$;

create index if not exists laundry_orders_unconfirmed_idx
  on public.laundry_orders (organization_id, sent_at)
  where sent_at is not null and confirmed_at is null;

comment on index public.laundry_orders_unconfirmed_idx is
  'Sent and not yet agreed to. What the laundry detector scans, and what the deadline-risk signal is actually about.';


-- ============================================================================
-- Rehearsal
-- ============================================================================

do $$
declare
  def text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'laundry_orders'
      and column_name = 'confirmed_at'
  ) then
    raise exception 'laundry_orders.confirmed_at is missing';
  end if;

  select pg_get_constraintdef(oid) into def
  from pg_constraint
  where conname = 'laundry_orders_confirmed_after_sent'
    and conrelid = 'public.laundry_orders'::regclass;

  if def is null then
    raise exception
      'a laundry order could record a confirmation before the request that prompted it';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'laundry_orders_unconfirmed_idx'
  ) then
    raise exception 'the unconfirmed-order index is missing';
  end if;
end $$;
