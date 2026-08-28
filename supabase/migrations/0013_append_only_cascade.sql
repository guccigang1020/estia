-- ============================================================================
-- 0013_append_only_cascade.sql — ESTIA · two append-only tables that could not
--                                be deleted through
--
-- What this fixes
--   A contradiction between two rules that were each correct on their own, and
--   which the test files found the moment they asserted a positive control.
--
--   `booking_status_history` and `inventory_movements` are append-only: the
--   privileges are revoked and a statement-level trigger refuses UPDATE and
--   DELETE, so the record of what happened cannot be rewritten. Both also hang
--   off their parent with ON DELETE CASCADE.
--
--   Those two facts cannot both hold. Deleting a booking makes the foreign key
--   issue a DELETE against `booking_status_history`, the append-only guard
--   refuses it with 42501, and the whole statement aborts. The practical
--   effect was that **no booking that had ever had a status recorded could be
--   hard-deleted by anybody** — and since the creation of a booking writes its
--   first history row by trigger, that meant every booking, including one
--   entered by mistake thirty seconds earlier. `inventory_items` had exactly
--   the same shape: an item with any stock movement could not be removed.
--
--   Neither was visible in a green migration. Both surfaced as a failing
--   positive control:
--
--       supabase/tests/booking.sql    'A CAN delete its own booking'
--       supabase/tests/operations.sql 'A CAN delete its own inventory item'
--
--   which is the whole reason those controls are written. The isolation
--   assertions beside them passed either way.
--
-- ── The fix, and why it is this one ─────────────────────────────────────────
--
--   The guard is replaced by one that can tell the two cases apart:
--
--     · a direct DELETE, aimed at history whose parent is still there — the
--       thing the append-only rule exists to refuse;
--     · the cascade, which only ever runs after the parent row has already
--       gone, and which is not a rewrite of history but the removal of the
--       thing the history was about.
--
--   An AFTER STATEMENT trigger with a transition table can see every row the
--   statement removed, so the discriminator is exact and needs no flag, no
--   session variable and no trust in the caller: if a single row's parent is
--   still present, this was not a cascade, and it is refused.
--
--   The alternative — dropping DELETE on bookings entirely and making them
--   soft-delete-only — was rejected because `booking.delete` is a real grant
--   in the catalogue and erasing a mistaken enquiry is a real thing a business
--   asks for. Note that a booking with money against it still cannot be
--   deleted: 0010 and 0011 point `payments`, `refunds`, `deposits`, `invoices`,
--   `credit_notes` and `commissions` at it with ON DELETE RESTRICT, and that
--   is deliberate and unchanged.
--
-- ── The same contradiction in a second form: ON DELETE SET NULL ─────────────
--
--   `inventory_movements` referenced `tasks` and `bookings` with SET NULL. A
--   SET NULL is an UPDATE, and this table refuses UPDATE — so deleting a
--   booking that a stock movement mentioned failed with 42501 as well, from a
--   direction nobody would think to look.
--
--   0008 already met this exact problem with `audit_events.property_id` and
--   answered it correctly: the trail outlives the thing it describes, so the
--   reference becomes ON DELETE RESTRICT. The same answer applies here. A
--   booking that caused stock to move cannot be erased while the ledger says
--   it did — and the caller gets 23503 naming the real reason, rather than a
--   confusing 42501 about privileges.
--
-- ── What is deliberately still true ─────────────────────────────────────────
--
--   Both tables still refuse every UPDATE, from every role including the table
--   owner and service_role, on zero-row statements as loudly as on real ones.
--   That trigger is untouched.
--
--   One narrow path remains, and it is stated here rather than left to be
--   found: `booking_status_history.changed_by` and
--   `inventory_movements.created_by` reference `auth.users` with ON DELETE SET
--   NULL, which is an UPDATE the guard refuses. Deleting an auth account that
--   has ever changed a booking status will therefore fail. This is not new and
--   not confined to these tables — `audit_events.actor_user_id` has had the
--   same shape since 0005 — so it is recorded in supabase/README.md as a known
--   limitation to be settled once, for every append-only table at the same
--   time, rather than differently in three places.
--
-- Depends on
--   0009 (booking_status_history), 0011 (inventory_movements).
-- ============================================================================

set search_path = public, extensions;


-- ── The discriminating guard ────────────────────────────────────────────────
-- One function for both tables. The parent table and the referencing column
-- are passed as trigger arguments, so the two append-only ledgers share an
-- implementation rather than growing two that can drift apart.
--
-- Zero rows is allowed here, unlike in the UPDATE guard, and that is not an
-- oversight. A DELETE that matched nothing removed nothing, so there is no
-- history to protect; refusing it would additionally break the cascade from a
-- parent that happens to have no child rows, since PostgreSQL issues the
-- child DELETE either way.

create or replace function public.tg_append_only_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_table  text := tg_argv[0];
  parent_column text := tg_argv[1];
  n_surviving   bigint;
begin
  execute format(
    'select count(*) from removed r '
    'where exists (select 1 from %s p where p.id = (to_jsonb(r) ->> %L)::uuid)',
    parent_table, parent_column
  ) into n_surviving;

  if n_surviving > 0 then
    raise exception
      '% is append-only; DELETE is not permitted', tg_table_name
      using errcode = '42501',
            hint = 'Rows go only with the parent they belong to. Record a compensating entry instead.';
  end if;

  return null;
end;
$$;

comment on function public.tg_append_only_delete_guard() is
  'Refuses a DELETE against an append-only ledger unless every row removed has already lost its parent — which is true only of the ON DELETE CASCADE, and never of a caller deleting history directly. Uses an AFTER STATEMENT transition table, so the discriminator is a fact about the rows rather than a flag anybody could set.';

revoke all on function public.tg_append_only_delete_guard() from public, anon, authenticated;


-- ── booking_status_history ──────────────────────────────────────────────────

drop trigger if exists booking_status_history_no_delete on public.booking_status_history;
create trigger booking_status_history_no_delete
  after delete on public.booking_status_history
  referencing old table as removed
  for each statement
  execute function public.tg_append_only_delete_guard('public.bookings', 'booking_id');

comment on table public.booking_status_history is
  'Every status transition of every booking: from, to, who, when, why. Append-only, and written only by the trigger on bookings — no caller is granted INSERT, so a status cannot change without the transition being recorded. It is removed only by the cascade from deleting the booking itself; a direct DELETE is refused, and so is any UPDATE.';


-- ── inventory_movements ─────────────────────────────────────────────────────

drop trigger if exists inventory_movements_no_delete on public.inventory_movements;
create trigger inventory_movements_no_delete
  after delete on public.inventory_movements
  referencing old table as removed
  for each statement
  execute function public.tg_append_only_delete_guard('public.inventory_items', 'item_id');

comment on table public.inventory_movements is
  'The stock ledger: one row per change, signed, append-only. The item quantity is derived from it by trigger. A correction is a compensating movement and never an edit — "we thought we had forty and we have thirty-two" is itself a fact worth keeping, and an edit erases it. It is removed only by the cascade from deleting the item itself.';


-- ── The SET NULL references, which were UPDATEs in disguise ─────────────────
-- RESTRICT, on the reasoning 0008 gave for audit_events.property_id: the trail
-- outlives what it describes, and SET NULL is impossible on a table that
-- refuses UPDATE. The caller now gets 23503 naming the movement, instead of
-- 42501 about a privilege they do hold.

alter table public.inventory_movements
  drop constraint if exists inventory_movements_task_fkey;
alter table public.inventory_movements
  add constraint inventory_movements_task_fkey
  foreign key (task_id, organization_id)
  references public.tasks (id, organization_id) on delete restrict;

alter table public.inventory_movements
  drop constraint if exists inventory_movements_booking_fkey;
alter table public.inventory_movements
  add constraint inventory_movements_booking_fkey
  foreign key (booking_id, organization_id, property_id)
  references public.bookings (id, organization_id, property_id) on delete restrict;

comment on column public.inventory_movements.task_id is
  'The task the movement happened for, when there was one. ON DELETE RESTRICT rather than SET NULL: SET NULL is an UPDATE, and this table refuses UPDATE. Same reasoning as audit_events.property_id in 0008.';
comment on column public.inventory_movements.booking_id is
  'The stay the movement happened for, when there was one. ON DELETE RESTRICT, for the reason on task_id: a booking that caused stock to move cannot be erased while the ledger says it did.';
