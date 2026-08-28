-- ============================================================================
-- 0023_leading_column_indexes.sql — ESTIA · five indexes 0019 and 0021 owed
--
-- What this does
--   Closes the gap between what supabase/README.md says this schema does about
--   foreign key indexes and what 0019 and 0021 actually did.
--
--   The rule the README states, and the reason 169 `unindexed_foreign_keys`
--   findings were accepted rather than silenced with a hundred indexes, is:
--
--     > every foreign key whose leading column is genuinely unindexed is an
--     > actor column … the rest are composite foreign keys; the linter asks
--     > for an index matching the whole column list, and the schema gives an
--     > index on the leading column.
--
--   Checked against pg_index rather than against the linter's own summary,
--   five foreign keys on the new tables did not meet it. Each is listed with
--   what it costs, because "the linter mentioned it" is not a reason and
--   neither is "it is only an INFO".
--
--     1. `work_plans (booking_id)` — the worst of the five, and not really an
--        index question at all. `loadPlan(bookingId)` on `PreparationPorts`
--        takes a booking id and nothing else; the only index that led with
--        `booking_id` was `work_plans_booking_key`, whose leading column is
--        `organization_id`. The port's primary read was a sequential scan.
--     2. `work_plans (unit_id, organization_id)` — replaces
--        `(organization_id, unit_id)`. Same two columns, and the new order
--        serves both the unit lookup and the foreign key, where the old order
--        served only the first.
--     3. `preparation_catalogues (property_id, organization_id)` — the
--        composite key `(organization_id, property_id)` covers
--        `loadCatalogue(organizationId, propertyId)` and leads with the wrong
--        column for the foreign key, so deleting a property scanned every
--        catalogue in the database.
--     4. `agent_organization_settings (agency_id, organization_id)` —
--        replaces `(organization_id, agency_id)`. `agency_id` is a
--        single-column foreign key with ON DELETE RESTRICT, and the reverse
--        lookup "which agents sell under this agency" reads the same index.
--     5. `agent_invitations (invited_by_user_id)` — an actor column, and the
--        one that is *not* covered by the class 0004 accepted. That exemption
--        is written for `ON DELETE SET NULL` columns, where the only cost is a
--        rare account deletion. This one is `ON DELETE RESTRICT`, which has to
--        find a blocking row rather than update matching ones, so the scan is
--        the refusal path itself.
--
--   `create index if not exists` throughout, and the two replacements drop the
--   old index by name first, so this file is idempotent and a fresh run of
--   0001 … 0023 in order lands on the same shape as the applied database.
--
-- Depends on
--   0019 (agent_organization_settings, agent_invitations), 0021
--   (work_plans, preparation_catalogues).
-- ============================================================================

set search_path = public, extensions;


-- 1 · The port's primary read. `loadPlan(bookingId)` has no organization to
--     narrow by — row level security supplies the tenant — so the query is
--     `where booking_id = $1` and needs an index that starts there.
create index if not exists work_plans_booking_idx
  on public.work_plans (booking_id);

-- 2 · Same columns, useful order.
drop index if exists public.work_plans_unit_idx;
create index if not exists work_plans_unit_idx
  on public.work_plans (unit_id, organization_id);

-- 3 · The unique key `(organization_id, property_id)` stays: it is what
--     loadCatalogue reads and what stops a property having two catalogues.
--     This is the other direction, which the foreign key walks.
create index if not exists preparation_catalogues_property_idx
  on public.preparation_catalogues (property_id, organization_id);

-- 4 · Reordered, not added. Leading with the agency serves the foreign key and
--     the "which of my agents sell under this banner" read equally well; the
--     old order served only the second.
drop index if exists public.agent_organization_settings_agency_idx;
create index if not exists agent_organization_settings_agency_idx
  on public.agent_organization_settings (agency_id, organization_id);

-- 5 · The actor column that is not in the accepted class, because it is
--     RESTRICT rather than SET NULL.
create index if not exists agent_invitations_invited_by_idx
  on public.agent_invitations (invited_by_user_id);
