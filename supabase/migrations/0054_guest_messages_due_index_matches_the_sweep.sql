-- ============================================================================
-- 0054_guest_messages_due_index_matches_the_sweep.sql — ESTIA
--
-- What this corrects
--   0053 created `guest_messages_due_idx` as `(scheduled_for) where outcome =
--   'deferred'`. Two things are wrong with it, both found by the agent that
--   wrote the release sweep against it rather than by anyone reading it.
--
--   1. The sweep is PER ORGANIZATION, and so is row level security. An index
--      leading with `scheduled_for` makes every sweep scan other tenants' rows
--      and discard them. `notification_deliveries_due_idx` in 0043 already
--      leads with `organization_id`; this is the same query and should have
--      had the same shape from the start.
--
--   2. It covers only `deferred`. A process that dies between claiming a row
--      and settling it leaves a `pending` guest message that nothing can find
--      — the claim succeeded, the send never happened, and no sweep will look
--      at it again. 0043's index covers both states for exactly that reason,
--      and 0053 did not copy it.
--
-- Scope
--   Index only. No data and no schema move.
--
-- Depends on
--   0053 (the table and the original index).
-- ============================================================================

set search_path = public, extensions;

drop index if exists public.guest_messages_due_idx;

create index if not exists guest_messages_due_idx
  on public.guest_messages (organization_id, scheduled_for)
  where outcome in (
    'deferred'::public.notification_delivery_status,
    'pending'::public.notification_delivery_status
  );

comment on index public.guest_messages_due_idx is
  'What the release sweep scans. Leads with organization_id because the sweep is per tenant and so is RLS, and covers `pending` as well as `deferred` because a process that dies between the claim and the settle leaves a pending row that nothing else can find.';


-- ============================================================================
-- Rehearsal
-- ============================================================================

do $$
declare
  def text;
begin
  select indexdef into def
  from pg_indexes
  where schemaname = 'public' and indexname = 'guest_messages_due_idx';

  if def is null then
    raise exception 'guest_messages_due_idx is missing';
  end if;

  if position('organization_id, scheduled_for' in def) = 0 then
    raise exception
      'the due index does not lead with organization_id, so every sweep scans other tenants'' rows: %', def;
  end if;

  if position('pending' in def) = 0 then
    raise exception
      'the due index does not cover pending, so a row claimed and never settled is invisible to the sweep: %', def;
  end if;
end $$;
