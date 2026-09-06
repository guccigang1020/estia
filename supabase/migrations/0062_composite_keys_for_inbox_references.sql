-- ============================================================================
-- 0062_composite_keys_for_inbox_references.sql — ESTIA
--
-- Three tables the unified inbox needs to reference, none of which could be
-- referenced tenant-safely.
--
-- Every cross-table reference in this schema is a COMPOSITE foreign key that
-- names the tenant alongside the row — `(property_id, organization_id)`,
-- `(booking_id, organization_id, property_id)`. That shape is not decoration:
-- it is what makes it impossible to attach one organization's row to another
-- organization's parent by passing an id. A plain `references x(id)` would
-- accept a stranger's uuid and the database would have no way to know.
--
-- `site_booking_requests`, `guest_requests` and `guest_messages` each had only
-- a primary key on `id`, so `0063` could not name them that way. This adds the
-- key each of them was missing.
--
-- ── Why this is safe to add to tables three other modules own ──────────────
--
-- `id` is already the primary key of all three, so `unique (id,
-- organization_id)` adds no uniqueness that was not already enforced. There is
-- no insert anywhere in the product that can begin failing because of it, and
-- no read whose plan changes in a way that matters. It is a constraint that
-- exists to be pointed at, not to reject anything.
--
-- It is separated from 0063 for exactly that reason: a change to somebody
-- else's table should be legible on its own, with its own justification, and
-- not buried in the middle of a feature migration where a reviewer scanning
-- for "what did the inbox do" would scroll past it.
-- ============================================================================

set search_path = public, extensions;

alter table public.site_booking_requests
  drop constraint if exists site_booking_requests_id_organization_key;
alter table public.site_booking_requests
  add constraint site_booking_requests_id_organization_key
  unique (id, organization_id);

alter table public.guest_requests
  drop constraint if exists guest_requests_id_organization_key;
alter table public.guest_requests
  add constraint guest_requests_id_organization_key
  unique (id, organization_id);

alter table public.guest_messages
  drop constraint if exists guest_messages_id_organization_key;
alter table public.guest_messages
  add constraint guest_messages_id_organization_key
  unique (id, organization_id);


-- ============================================================================
-- Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  select string_agg(t.name, ', ') into missing
  from (values
    ('site_booking_requests'), ('guest_requests'), ('guest_messages')
  ) as t(name)
  where not exists (
    select 1 from pg_constraint
    where conrelid = ('public.' || t.name)::regclass
      and contype = 'u'
      and conname = t.name || '_id_organization_key'
  );
  if missing is not null then
    raise exception 'composite key missing on: %', missing;
  end if;
end $$;
