-- ============================================================================
-- 0021_preparation.sql — ESTIA · the frozen catalogue, and the plan built from
--                        it
--
-- What this does
--   Three tables, plus the revision chain that makes the middle one mean
--   anything:
--
--     `preparation_catalogues`  the live configuration, per property
--     `preparation_snapshots`   one frozen copy per booking — insert only
--     `work_plans`              the computed plan, with `work_plan_versions`
--
-- ── Why this is not `tasks` ─────────────────────────────────────────────────
--
--   The projection almost writes itself. A plan is a list of jobs, a task is a
--   job, `tasks` already carries a property, a unit, a booking, an assignee and
--   a status, and `task_checklists` already holds items with counts. Six of the
--   `WorkPlan` fields would map straight across.
--
--   It would lose the two that matter.
--
--   **The revision chain.** `recomputePlan` in src/lib/preparation/operations.ts
--   produces a `PlanDelta` on every recomputation and the header says it is
--   "never suppressed": a booking that grows from twenty-five guests to thirty
--   while a cleaner is halfway through the bedrooms is named there as the
--   single most expensive silent change in the domain. `tasks` has one row and
--   no history of what the row used to require, so the delta would be computed
--   against nothing.
--
--   **The frozen snapshot.** This is the whole mechanism that stops historical
--   drift. A plan built in March is costed against the catalogue as it stood in
--   March, and stays costed that way after somebody edits the prices in April.
--   `operations.ts` enforces it structurally by *not having* a
--   `loadCatalogue(bookingId)`: every path except a brand-new plan is forced
--   through the stored snapshot. `tasks` has nowhere to put a frozen catalogue,
--   so the projection would quietly delete that guarantee — and the loss would
--   surface months later as a slowly wrong number on an owner's statement,
--   which is the worst way for a defect to be discovered.
--
--   So these are their own tables. `tasks` remains what it is: the board a
--   person works from. A section of a plan can become a task; a plan is not one.
--
-- ── Why the payload is jsonb here and rows in `invoice_lines` ───────────────
--
--   0016 made invoice lines rows rather than jsonb, on the grounds that a tax
--   report by line kind is not something anybody writes against a blob. That
--   reasoning is right there and wrong here, and the difference is worth
--   stating rather than looking like an inconsistency.
--
--   An invoice line is *reported on*: summed, grouped, filtered, across
--   documents and across years. A catalogue entry is an *input to a
--   computation* — read whole, hashed whole, and frozen whole the moment it
--   matters. Nothing asks "which bed types exist across organizations"; what is
--   asked is "what did this plan cost", and the answer is one snapshot read.
--   Normalising a `PreparationCatalogue` would produce ten tables, ten sets of
--   policies, and a content hash computed by joining them back together — with
--   a new way for the hash to disagree with what was actually stored.
--
--   The columns are jsonb rather than one `document` column, though, and that
--   is not cosmetic: `PreparationSnapshot` has eleven named parts, each with a
--   type, and eleven columns with eleven shape constraints is eleven places
--   the database refuses a malformed write. One blob is none.
--
-- ── `version` on `work_plans` is not the optimistic lock ────────────────────
--
--   Everywhere else in this schema `version` is owned by the database and
--   incremented by `tg_touch_row`. Here it is the domain's **plan revision** —
--   `WorkPlan.version`, the number `versionPlan` advances and `PlanDelta`
--   reports as `fromVersion` / `toVersion`. It is written by the caller.
--
--   So `tg_touch_row` is deliberately not installed on `work_plans`; a
--   trigger that stamps `updated_at` alone is. There is no optimistic lock to
--   lose: `savePlan(plan, tx)` on `PreparationPorts` takes no expected version,
--   so there is nothing for a lock to compare against, and inventing a second
--   integer column would have produced two numbers called "version" on one row.
--
--   What replaces it is narrower and answers the real risk: a trigger refuses a
--   write that moves the revision *backwards*, because a recompute that stored
--   version 1 over version 3 would silently discard two revisions of work.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, units, property_in_scope), 0009
--   (bookings), 0012 (task.view, task.create, task.update, task.complete,
--   task.verify, checklist.manage).
-- ============================================================================

set search_path = public, extensions;


-- ── A touch trigger that does not own `version` ─────────────────────────────
-- `tg_touch_row` stamps updated_at *and* increments version, which is right
-- for every table whose version is an optimistic lock and wrong for the one
-- whose version is a domain revision the caller writes.

create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.tg_touch_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at and leaves version alone. For work_plans, whose version column is the domain plan revision rather than an optimistic lock — see the header of 0021.';


-- ============================================================================
-- preparation_catalogues — the live configuration
-- ============================================================================
-- Per property, because `loadCatalogue(organizationId, propertyId)` is the
-- port's signature and `PreparationCatalogue.propertyConfiguration` is a single
-- property's layout. The organization-wide parts — rules, event templates,
-- cost models — are repeated per property rather than shared, which is the
-- honest reading of the type: `captureSnapshot` freezes exactly this object,
-- and a catalogue assembled from two sources at read time would freeze
-- something no row ever held.

create table if not exists public.preparation_catalogues (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  property_id             uuid not null,

  bed_types               jsonb not null default '[]'::jsonb,
  rules                   jsonb not null default '[]'::jsonb,
  event_templates         jsonb not null default '[]'::jsonb,
  property_configuration  jsonb not null default '{}'::jsonb,
  variable_costs          jsonb not null default '[]'::jsonb,
  fixed_costs             jsonb not null default '[]'::jsonb,
  commission_rules        jsonb not null default '[]'::jsonb,
  complexity              jsonb not null default '{}'::jsonb,
  readiness_policy        jsonb not null default '{}'::jsonb,
  section_labels          jsonb not null default '{}'::jsonb,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,

  constraint preparation_catalogues_property_key unique (organization_id, property_id),
  constraint preparation_catalogues_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  -- Shape, on every part. The columns are NOT NULL, so `jsonb_typeof` here can
  -- never itself be NULL and the coalesce 0017 had to add is not needed — that
  -- lesson was about a key that might be *absent from* a jsonb value, not
  -- about a column that cannot be missing.
  constraint preparation_catalogues_arrays_are_arrays check (
    jsonb_typeof(bed_types) = 'array'
    and jsonb_typeof(rules) = 'array'
    and jsonb_typeof(event_templates) = 'array'
    and jsonb_typeof(variable_costs) = 'array'
    and jsonb_typeof(fixed_costs) = 'array'
    and jsonb_typeof(commission_rules) = 'array'
  ),
  constraint preparation_catalogues_objects_are_objects check (
    jsonb_typeof(property_configuration) = 'object'
    and jsonb_typeof(complexity) = 'object'
    and jsonb_typeof(readiness_policy) = 'object'
    and jsonb_typeof(section_labels) = 'object'
  ),
  constraint preparation_catalogues_version_positive check (version >= 1)
);

comment on table public.preparation_catalogues is
  'Everything an organization has configured for preparing one property: bed types, requirement rules, event templates, the cost models, the complexity weights and the readiness policy. This is the *live* set — it changes when somebody edits a rule. Nothing computes from it directly: captureSnapshot freezes it against a booking first, and preparation_snapshots is what every later read goes through.';

create index if not exists preparation_catalogues_organization_idx
  on public.preparation_catalogues (organization_id);

drop trigger if exists preparation_catalogues_touch on public.preparation_catalogues;
create trigger preparation_catalogues_touch
  before update on public.preparation_catalogues
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- preparation_snapshots — insert only, and that is the entire point
-- ============================================================================
-- One per booking. `buildPlan` takes it once — "The snapshot is taken here and
-- never again", and its own rule refuses to build a second plan for a booking
-- that already has one — so `unique (booking_id)` is not a convenience, it is
-- the statement that a booking has exactly one frozen ruleset for ever.
--
-- Append-only by revoked privileges *and* by trigger, the same pair 0005 uses
-- for audit_events and for the same reason stated there: service_role and
-- postgres carry BYPASSRLS, so policies alone do not stop a background job. A
-- snapshot that can be edited is not a snapshot; it is a second live
-- catalogue wearing a timestamp, and every historical cost in the product
-- silently follows it.

create table if not exists public.preparation_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  property_id             uuid not null,
  booking_id              uuid not null,

  -- Content hash. Identical configurations share one, and tampering shows.
  hash                    text not null,
  captured_at             timestamptz not null default now(),
  -- The date whose rules were resolved. Usually the booking's arrival.
  effective_on            date not null,

  bed_types               jsonb not null default '[]'::jsonb,
  rules                   jsonb not null default '[]'::jsonb,
  event_templates         jsonb not null default '[]'::jsonb,
  property_configuration  jsonb not null default '{}'::jsonb,
  variable_costs          jsonb not null default '[]'::jsonb,
  fixed_costs             jsonb not null default '[]'::jsonb,
  -- Singular, and nullable. The catalogue carries every commission rule; the
  -- snapshot carries the one that was selected, or none.
  commission_rule         jsonb,
  complexity              jsonb not null default '{}'::jsonb,
  readiness_policy        jsonb not null default '{}'::jsonb,
  section_labels          jsonb not null default '{}'::jsonb,
  -- What the guest was quoted, frozen alongside what it costs to deliver.
  price_lines             jsonb not null default '[]'::jsonb,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,

  constraint preparation_snapshots_booking_key unique (booking_id),
  -- What a work plan's snapshot_hash points at.
  constraint preparation_snapshots_booking_hash_key unique (booking_id, hash),
  -- RESTRICT. A booking that has been costed cannot be erased out from under
  -- the record that explains what it cost — the same posture 0016 records for
  -- finance_snapshots, where a DELETE on bookings fails for the same reason.
  constraint preparation_snapshots_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,

  constraint preparation_snapshots_hash_not_blank check (length(btrim(hash)) > 0),
  constraint preparation_snapshots_arrays_are_arrays check (
    jsonb_typeof(bed_types) = 'array'
    and jsonb_typeof(rules) = 'array'
    and jsonb_typeof(event_templates) = 'array'
    and jsonb_typeof(variable_costs) = 'array'
    and jsonb_typeof(fixed_costs) = 'array'
    and jsonb_typeof(price_lines) = 'array'
  ),
  constraint preparation_snapshots_objects_are_objects check (
    jsonb_typeof(property_configuration) = 'object'
    and jsonb_typeof(complexity) = 'object'
    and jsonb_typeof(readiness_policy) = 'object'
    and jsonb_typeof(section_labels) = 'object'
    and (commission_rule is null or jsonb_typeof(commission_rule) = 'object')
  )
);

comment on table public.preparation_snapshots is
  'The frozen ruleset one booking is computed against, for ever. One row per booking, written once by buildPlan and never updated or deleted — by revoked privileges and by trigger, not by convention. This is the record that keeps a March plan costing what it cost in March after the catalogue prices change in April; everything downstream reads it rather than the live catalogue, which is why PreparationPorts deliberately has no loadCatalogue(bookingId).';
comment on column public.preparation_snapshots.hash is
  'Content hash of the frozen configuration. Identical configurations share one, so tampering with a stored snapshot shows as a hash that no longer describes its own contents. work_plans.snapshot_hash is a foreign key onto it, which is what makes "this plan was built from this snapshot" a fact the database holds rather than a claim the writer makes.';

create index if not exists preparation_snapshots_organization_idx
  on public.preparation_snapshots (organization_id);
create index if not exists preparation_snapshots_property_idx
  on public.preparation_snapshots (organization_id, property_id);

create or replace function public.tg_preparation_snapshots_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'preparation_snapshots is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

comment on function public.tg_preparation_snapshots_append_only() is
  'Refuses UPDATE and DELETE on preparation_snapshots. Statement-level, so a statement matching no rows is refused as loudly as one matching many — and it holds against service_role and postgres, which row level security does not.';

drop trigger if exists preparation_snapshots_no_update on public.preparation_snapshots;
create trigger preparation_snapshots_no_update
  before update on public.preparation_snapshots
  for each statement execute function public.tg_preparation_snapshots_append_only();

drop trigger if exists preparation_snapshots_no_delete on public.preparation_snapshots;
create trigger preparation_snapshots_no_delete
  before delete on public.preparation_snapshots
  for each statement execute function public.tg_preparation_snapshots_append_only();


-- ============================================================================
-- work_plans
-- ============================================================================

create table if not exists public.work_plans (
  id                      uuid primary key,
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  property_id             uuid not null,
  unit_id                 uuid not null,
  booking_id              uuid not null,

  -- The domain's plan revision. See the header: not an optimistic lock.
  version                 integer not null default 1,
  -- The rules this plan was built from. Never re-read from the catalogue.
  snapshot_hash           text not null,

  sections                jsonb not null default '[]'::jsonb,
  -- Total estimated minutes along the longest dependency chain.
  critical_path_minutes   integer not null default 0,
  -- Recommended crew, from the complexity score.
  recommended_staff       integer not null default 1,

  -- What changed when this revision was made. `PlanDelta` is produced by every
  -- recomputation and the domain says it is never suppressed; without a column
  -- it would exist only inside the audit summary sentence, which is prose.
  delta                   jsonb,
  supersedes_version      integer,
  changed_by              uuid references auth.users (id) on delete set null,
  change_reason           text,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,

  -- One plan per booking, which is what buildPlan's `preparation_plan_exists`
  -- rule already assumes in the domain. Asserted here so a second writer
  -- cannot create the situation that rule exists to prevent.
  constraint work_plans_booking_key unique (organization_id, booking_id),
  -- What the history points at. Deliberately not `(id, version)`: a foreign
  -- key onto the revision number would break the moment the revision advanced,
  -- because the referenced row no longer carries the old value. 0015 makes the
  -- same choice for agent_commission_rule_versions, and for the same reason.
  constraint work_plans_id_organization_key unique (id, organization_id),

  -- CASCADE, unlike the snapshot's RESTRICT. A plan is a computed artefact and
  -- can be rebuilt from the snapshot; the snapshot is evidence and cannot be
  -- rebuilt from anything. The two foreign keys point at the same booking and
  -- say different things about it on purpose.
  constraint work_plans_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete cascade,
  constraint work_plans_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete restrict,
  -- The plan names the snapshot it was built from, and the pair has to exist.
  -- A plan whose snapshot_hash matches nothing stored is a plan that cannot
  -- explain its own numbers.
  constraint work_plans_snapshot_fkey
    foreign key (booking_id, snapshot_hash)
    references public.preparation_snapshots (booking_id, hash) on delete restrict,

  constraint work_plans_version_positive check (version >= 1),
  constraint work_plans_supersedes_lower check (
    supersedes_version is null or supersedes_version < version
  ),
  constraint work_plans_sections_is_array check (jsonb_typeof(sections) = 'array'),
  constraint work_plans_delta_is_object check (
    delta is null or jsonb_typeof(delta) = 'object'
  ),
  constraint work_plans_minutes_nonnegative check (critical_path_minutes >= 0),
  constraint work_plans_staff_nonnegative check (recommended_staff >= 0)
);

comment on table public.work_plans is
  'The computed preparation plan for one booking: its sections, its critical path and the crew it needs. A versioned artefact, not a task — public.tasks is the board a person works from and has neither a revision chain nor anywhere to freeze a catalogue. version here is the domain plan revision written by the caller, not an optimistic lock; work_plan_versions is the history and a trigger refuses a write that moves it backwards.';
comment on column public.work_plans.snapshot_hash is
  'The frozen ruleset this plan was built from, as a foreign key onto preparation_snapshots. Never re-read from the live catalogue: rebuilding a March plan against April prices is the historical-drift bug this whole group of tables exists to prevent.';

create index if not exists work_plans_organization_idx
  on public.work_plans (organization_id);
create index if not exists work_plans_property_idx
  on public.work_plans (organization_id, property_id);
create index if not exists work_plans_unit_idx
  on public.work_plans (organization_id, unit_id);


-- ── The revision chain ──────────────────────────────────────────────────────
-- A copy per revision, written by trigger and by no caller — the pattern 0015
-- established for agent_commission_rule_versions, and history a caller could
-- write is not history.
--
-- `on conflict do nothing` matters here more than it did there.
-- `completePlanSection` and `overridePlanSection` both call `savePlan` without
-- advancing the version: a cleaner ticking items is not a new revision of what
-- the work *is*. So the history records each revision as it stood when it was
-- created, and the running completion state lives on `work_plans` alone. That
-- is the intended reading — the question this table answers is "what did we
-- decide had to be done, and when did that change", not "what was ticked at
-- 14:32".

create table if not exists public.work_plan_versions (
  plan_id                 uuid not null,
  version                 integer not null,
  organization_id         uuid not null,
  property_id             uuid not null,
  unit_id                 uuid not null,
  booking_id              uuid not null,

  snapshot_hash           text not null,
  sections                jsonb not null,
  critical_path_minutes   integer not null,
  recommended_staff       integer not null,
  delta                   jsonb,
  supersedes_version      integer,
  change_reason           text,

  recorded_at             timestamptz not null default now(),
  recorded_by             uuid references auth.users (id) on delete set null,

  primary key (plan_id, version),
  constraint work_plan_versions_plan_fkey
    foreign key (plan_id, organization_id)
    references public.work_plans (id, organization_id) on delete cascade
);

comment on table public.work_plan_versions is
  'Every revision of every work plan, written by trigger and never by a caller. What makes a PlanDelta answerable three weeks later: "the plan changed from twenty-five guests to thirty" is a claim until both versions are readable.';

create index if not exists work_plan_versions_organization_idx
  on public.work_plan_versions (organization_id);
create index if not exists work_plan_versions_booking_idx
  on public.work_plan_versions (booking_id);

create or replace function public.tg_work_plans_record_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.work_plan_versions (
    plan_id, version, organization_id, property_id, unit_id, booking_id,
    snapshot_hash, sections, critical_path_minutes, recommended_staff,
    delta, supersedes_version, change_reason, recorded_by
  )
  values (
    new.id, new.version, new.organization_id, new.property_id, new.unit_id,
    new.booking_id, new.snapshot_hash, new.sections, new.critical_path_minutes,
    new.recommended_staff, new.delta, new.supersedes_version, new.change_reason,
    coalesce(new.changed_by, new.updated_by, new.created_by, (select auth.uid()))
  )
  on conflict (plan_id, version) do nothing;

  return null;
end;
$$;

comment on function public.tg_work_plans_record_version() is
  'Snapshots a work plan into work_plan_versions on insert and on every update that advances the revision. SECURITY DEFINER because no caller is granted INSERT on that table: recording a revision must not be something a write path can skip.';

revoke all on function public.tg_work_plans_record_version() from public, anon, authenticated, service_role;

drop trigger if exists work_plans_record_version on public.work_plans;
create trigger work_plans_record_version
  after insert or update on public.work_plans
  for each row execute function public.tg_work_plans_record_version();


-- ── The revision cannot go backwards ────────────────────────────────────────
-- The one guarantee the missing optimistic lock would otherwise have given.
-- A recompute that stored version 1 over version 3 would discard two revisions
-- of work with no error and no trace; the history table would still hold them,
-- and the live row would disagree with its own history, which is worse than
-- either.

create or replace function public.tg_work_plans_version_forward()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version < old.version then
    raise exception 'work_plans.version cannot move backwards (% -> %)', old.version, new.version
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.tg_work_plans_version_forward() is
  'Refuses a work plan update that lowers the revision. work_plans.version is written by the caller rather than by tg_touch_row, so this is what stands in for the lost optimistic lock — narrowed to the failure that actually matters, which is silently discarding revisions.';

drop trigger if exists work_plans_version_forward on public.work_plans;
create trigger work_plans_version_forward
  before update on public.work_plans
  for each row execute function public.tg_work_plans_version_forward();

drop trigger if exists work_plans_touch on public.work_plans;
create trigger work_plans_touch
  before update on public.work_plans
  for each row execute function public.tg_touch_updated_at();


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.preparation_catalogues enable row level security;
alter table public.preparation_catalogues force  row level security;
alter table public.preparation_snapshots  enable row level security;
alter table public.preparation_snapshots  force  row level security;
alter table public.work_plans             enable row level security;
alter table public.work_plans             force  row level security;
alter table public.work_plan_versions     enable row level security;
alter table public.work_plan_versions     force  row level security;

revoke all on public.preparation_catalogues from anon, authenticated;
revoke all on public.preparation_snapshots  from anon, authenticated;
revoke all on public.work_plans             from anon, authenticated;
revoke all on public.work_plan_versions     from anon, authenticated;

grant select, insert, update, delete on public.preparation_catalogues to authenticated;
grant select, insert                 on public.preparation_snapshots  to authenticated;
grant select, insert, update         on public.work_plans             to authenticated;
grant select                         on public.work_plan_versions     to authenticated;

grant select, insert, update, delete on public.preparation_catalogues to service_role;
grant select, insert                 on public.preparation_snapshots  to service_role;
grant select, insert, update         on public.work_plans             to service_role;
grant select                         on public.work_plan_versions     to service_role;

-- service_role carries BYPASSRLS and is handed everything on a new table by
-- Supabase's default privileges. Taking these back is what makes the two
-- append-only guarantees true for a background job as well.
revoke update, delete, truncate         on public.preparation_snapshots from service_role;
revoke insert, update, delete, truncate on public.work_plan_versions    from service_role;
revoke delete, truncate                 on public.work_plans            from service_role;


-- ── Policies · preparation_catalogues ───────────────────────────────────────
-- Reading it is `task.view`: it is what every plan in the property is built
-- from, and a supervisor who can see the plans has to be able to see why they
-- say what they say. Editing it is `checklist.manage`, which 0012 already
-- separates from doing the work — changing the rule that says every bed needs
-- fresh linen is a different act from ticking that the linen is on.

drop policy if exists preparation_catalogues_select on public.preparation_catalogues;
create policy preparation_catalogues_select on public.preparation_catalogues
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.view')
  );

drop policy if exists preparation_catalogues_insert on public.preparation_catalogues;
create policy preparation_catalogues_insert on public.preparation_catalogues
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'checklist.manage')
  );

drop policy if exists preparation_catalogues_update on public.preparation_catalogues;
create policy preparation_catalogues_update on public.preparation_catalogues
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'checklist.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'checklist.manage')
  );

drop policy if exists preparation_catalogues_delete on public.preparation_catalogues;
create policy preparation_catalogues_delete on public.preparation_catalogues
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'checklist.manage')
  );


-- ── Policies · preparation_snapshots ────────────────────────────────────────
-- SELECT and INSERT only, matching the revoked privileges: two independent
-- refusals for the same thing, which is how 0005 wrote audit_events. The
-- insert is `task.create`, because taking the snapshot is part of building the
-- plan and src/lib/preparation/operations.ts gates `buildPlan` on exactly that.

drop policy if exists preparation_snapshots_select on public.preparation_snapshots;
create policy preparation_snapshots_select on public.preparation_snapshots
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.view')
  );

drop policy if exists preparation_snapshots_insert on public.preparation_snapshots;
create policy preparation_snapshots_insert on public.preparation_snapshots
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.create')
  );


-- ── Policies · work_plans ───────────────────────────────────────────────────
-- Four grants on the update, for the reason 0011 gives for `tasks`: four
-- different people move a plan and 0012 already separates them. A cleaner
-- holds `task.complete` and not `task.update`, and must still be able to say
-- the bedrooms are done; a supervisor closing a section with items
-- outstanding holds `task.verify`.
--
-- No DELETE policy and no DELETE grant. A plan is superseded, never removed —
-- and its history has a foreign key onto it.

drop policy if exists work_plans_select on public.work_plans;
create policy work_plans_select on public.work_plans
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.view')
  );

drop policy if exists work_plans_insert on public.work_plans;
create policy work_plans_insert on public.work_plans
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.create')
  );

drop policy if exists work_plans_update on public.work_plans;
create policy work_plans_update on public.work_plans
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'task.update')
      or public.has_permission(organization_id, 'task.complete')
      or public.has_permission(organization_id, 'task.verify')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'task.update')
      or public.has_permission(organization_id, 'task.complete')
      or public.has_permission(organization_id, 'task.verify')
    )
  );


-- ── Policies · work_plan_versions ───────────────────────────────────────────
-- SELECT only. There is no INSERT policy because there is no INSERT grant: the
-- trigger writes it.

drop policy if exists work_plan_versions_select on public.work_plan_versions;
create policy work_plan_versions_select on public.work_plan_versions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.view')
  );
