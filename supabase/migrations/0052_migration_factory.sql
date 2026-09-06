-- ============================================================================
-- 0052_migration_factory.sql — ESTIA · bringing another system's history in
--
-- Why this is P1 and not admin convenience
--   An Israeli villa operator with three years of bookings in another PMS
--   cannot move to ESTIA unless their history moves with them. Migration is a
--   sales capability, and the screen that earns the operator's trust is the
--   dry-run report — which is why the dry run in `src/lib/migration/dryrun.ts`
--   takes no writer, no client and no operation at all. It is structurally
--   incapable of writing rather than merely discouraged from it.
--
-- The ledger, and why it is not keyed on the session
--   `import_records_ledger_key` is unique on (organization, entity,
--   record_key) and deliberately NOT on session_id. Keyed with the session,
--   every re-import would be a fresh session and would therefore duplicate
--   everything — which is exactly the failure the ledger exists to prevent.
--
--   Keyed without it, re-running the SAME export is a no-op, and a CORRECTED
--   export updates the row it already made. `content_hash` is what
--   distinguishes those two cases. The rehearsal asserts the index definition
--   does not mention session_id, because that is a mistake somebody would
--   make while "tidying up" and it would not fail any test.
--
-- Two grants rather than `integration.manage`
--   Connecting an account and importing three years of somebody else's
--   bookings are not the same act. The second writes into the calendar, the
--   guest list and the financial history at once, and getting it wrong is not
--   undone by disconnecting anything. `migration.view` and `migration.apply`
--   split reading the dry-run report from running the import.
--
-- What is deliberately absent
--   There is no delete on `import_records`. Clearing the ledger would make
--   every past import runnable again, and the second run would duplicate a
--   business's entire history. `import_field_mappings` IS deletable, because a
--   saved column mapping is a convenience and deleting one costs nothing.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0002 (permissions), 0004
--   (my_organizations, has_permission).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Two grants
-- ============================================================================

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
values
  ('migration.view',  'action'::public.permission_kind, 'governance', false, 1710),
  ('migration.apply', 'action'::public.permission_kind, 'governance', false, 1720)
on conflict (code) do nothing;


-- ============================================================================
-- 2 · Vocabularies — transcribed from src/lib/migration/types.ts, in order
-- ============================================================================

do $$ begin
  create type public.import_entity as enum (
    'organizations', 'properties', 'units', 'guests', 'bookings',
    'blocked_dates', 'pricing', 'owners', 'agents', 'notes');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.import_source_format as enum (
    'csv', 'tsv', 'excel', 'excel_binary', 'ical', 'unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.import_session_status as enum (
    'draft', 'mapped', 'validated', 'dry_run', 'applying', 'completed',
    'failed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.import_conflict_kind as enum (
    'booking_overlaps_booking', 'booking_overlaps_import',
    'booking_overlaps_owner_stay', 'booking_overlaps_maintenance',
    'unit_mismatch', 'guest_merge_candidate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.import_conflict_decision as enum (
    'undecided', 'keep_existing', 'import_anyway', 'skip_record', 'merge');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.import_record_outcome as enum (
    'created', 'updated', 'skipped_unchanged', 'skipped_by_decision',
    'needs_manual_update', 'failed');
exception when duplicate_object then null; end $$;

comment on type public.import_record_outcome is
  'needs_manual_update is a first-class outcome and not a failure: the source corrected a row ESTIA already holds, and there is no domain command that can apply the correction. Writing it directly would break the one rule the import exists to keep, so the row is reported for a person instead.';


-- ============================================================================
-- 3 · Sessions
-- ============================================================================

create table if not exists public.import_sessions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status          public.import_session_status not null default 'draft',
  entity          public.import_entity not null,
  source_format   public.import_source_format not null default 'unknown',
  file_name       text,
  file_hash       text,
  row_count       integer not null default 0,
  mappings        jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint import_sessions_row_count_nonneg check (row_count >= 0),
  constraint import_sessions_mappings_array check (jsonb_typeof(mappings) = 'array'),
  constraint import_sessions_completed_pair check (
    completed_at is null
    or status in ('completed'::public.import_session_status,
                  'failed'::public.import_session_status,
                  'cancelled'::public.import_session_status)
  )
);

comment on table public.import_sessions is
  'One upload, from parse to completion report. file_hash is what makes re-running the SAME file a no-op rather than a duplicate import; a corrected file has a different hash and updates instead.';

create index if not exists import_sessions_org_idx
  on public.import_sessions (organization_id, created_at desc);
create index if not exists import_sessions_open_idx
  on public.import_sessions (organization_id, status)
  where status not in ('completed'::public.import_session_status,
                       'failed'::public.import_session_status,
                       'cancelled'::public.import_session_status);

drop trigger if exists import_sessions_touch on public.import_sessions;
create trigger import_sessions_touch
  before update on public.import_sessions
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · The ledger
-- ============================================================================

create table if not exists public.import_records (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  session_id      uuid not null references public.import_sessions (id) on delete cascade,
  entity          public.import_entity not null,
  record_key      text not null,
  content_hash    text not null,
  estia_id        text,
  row_number      integer not null,
  outcome         public.import_record_outcome,
  message         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint import_records_row_number_positive check (row_number >= 1),
  constraint import_records_key_not_blank check (length(btrim(record_key)) > 0)
);

comment on table public.import_records is
  'THE IDEMPOTENCY LEDGER. One row per source record, keyed on (organization, entity, record_key) — not per session — so re-importing the same export creates nothing the second time, and a corrected export updates the row it already made rather than adding a second. The uniqueness is the guarantee; nothing relies on a handler looking first.';
comment on column public.import_records.content_hash is
  'What makes "unchanged" distinguishable from "changed". A redelivered row with the same hash is skipped_unchanged; a different hash is a correction, which is why the ledger survives its session.';
comment on column public.import_records.estia_id is
  'The row ESTIA created. Null while the dry run has only inspected the record — which is how a dry run is visible in this table without having written anything into the product.';

create unique index if not exists import_records_ledger_key
  on public.import_records (organization_id, entity, record_key);
create index if not exists import_records_session_idx
  on public.import_records (session_id, row_number);

drop trigger if exists import_records_touch on public.import_records;
create trigger import_records_touch
  before update on public.import_records
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · Conflicts
-- ============================================================================

create table if not exists public.import_conflicts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  session_id      uuid not null references public.import_sessions (id) on delete cascade,
  conflict_id     text not null,
  kind            public.import_conflict_kind not null,
  row_number      integer not null,
  entity          public.import_entity not null,
  side_left       jsonb not null default '{}'::jsonb,
  side_right      jsonb not null default '{}'::jsonb,
  question        text not null,
  decision        public.import_conflict_decision not null default 'undecided',
  decided_at      timestamptz,
  decided_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint import_conflicts_row_number_positive check (row_number >= 1),
  constraint import_conflicts_question_not_blank check (length(btrim(question)) > 0),
  constraint import_conflicts_decided_pair check (
    decision = 'undecided'::public.import_conflict_decision
    or (decided_at is not null and decided_by is not null)
  )
);

comment on table public.import_conflicts is
  'A record the import will not decide by itself. Both sides are stored so a person can see what they are choosing between; a conflict is never auto-discarded, and import_conflicts_decided_pair means every decision names who made it.';

create unique index if not exists import_conflicts_identity
  on public.import_conflicts (session_id, conflict_id);
create index if not exists import_conflicts_open_idx
  on public.import_conflicts (organization_id, session_id, row_number)
  where decision = 'undecided'::public.import_conflict_decision;

drop trigger if exists import_conflicts_touch on public.import_conflicts;
create trigger import_conflicts_touch
  before update on public.import_conflicts
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · Saved column mappings
-- ============================================================================

create table if not exists public.import_field_mappings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null,
  entity          public.import_entity not null,
  source_format   public.import_source_format not null,
  signature       text not null,
  mappings        jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  constraint import_field_mappings_name_not_blank check (length(btrim(name)) > 0),
  constraint import_field_mappings_signature_not_blank check (
    length(btrim(signature)) > 0
  ),
  constraint import_field_mappings_array check (jsonb_typeof(mappings) = 'array')
);

comment on table public.import_field_mappings is
  'A saved column mapping, keyed on the SIGNATURE of the source header row. The point is that the second export from the same system needs no re-mapping — which is what makes a monthly import bearable rather than a project.';

create unique index if not exists import_field_mappings_identity
  on public.import_field_mappings (organization_id, entity, signature);

drop trigger if exists import_field_mappings_touch on public.import_field_mappings;
create trigger import_field_mappings_touch
  before update on public.import_field_mappings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · Row level security
-- ============================================================================

alter table public.import_sessions       enable row level security;
alter table public.import_sessions       force  row level security;
alter table public.import_records        enable row level security;
alter table public.import_records        force  row level security;
alter table public.import_conflicts      enable row level security;
alter table public.import_conflicts      force  row level security;
alter table public.import_field_mappings enable row level security;
alter table public.import_field_mappings force  row level security;

revoke all on public.import_sessions       from anon, authenticated;
revoke all on public.import_records        from anon, authenticated;
revoke all on public.import_conflicts      from anon, authenticated;
revoke all on public.import_field_mappings from anon, authenticated;

grant select, insert, update on public.import_sessions       to authenticated;
grant select, insert, update on public.import_records        to authenticated;
grant select, insert, update on public.import_conflicts      to authenticated;
grant select, insert, update, delete on public.import_field_mappings to authenticated;

grant select, insert, update on public.import_sessions       to service_role;
grant select, insert, update on public.import_records        to service_role;
grant select, insert, update on public.import_conflicts      to service_role;
grant select, insert, update, delete on public.import_field_mappings to service_role;

-- Clearing the ledger would make every past import runnable again, and the
-- second run would duplicate a business's entire history. A saved column
-- mapping is a convenience and stays deletable.
revoke delete, truncate on public.import_records from authenticated, service_role;


-- ============================================================================
-- 8 · Policies
-- ============================================================================

drop policy if exists import_sessions_select on public.import_sessions;
create policy import_sessions_select on public.import_sessions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.view')
  );

drop policy if exists import_sessions_write on public.import_sessions;
create policy import_sessions_write on public.import_sessions
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  );

drop policy if exists import_records_select on public.import_records;
create policy import_records_select on public.import_records
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.view')
  );

drop policy if exists import_records_write on public.import_records;
create policy import_records_write on public.import_records
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  );

drop policy if exists import_conflicts_select on public.import_conflicts;
create policy import_conflicts_select on public.import_conflicts
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.view')
  );

drop policy if exists import_conflicts_write on public.import_conflicts;
create policy import_conflicts_write on public.import_conflicts
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  );

drop policy if exists import_field_mappings_select on public.import_field_mappings;
create policy import_field_mappings_select on public.import_field_mappings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.view')
  );

drop policy if exists import_field_mappings_write on public.import_field_mappings;
create policy import_field_mappings_write on public.import_field_mappings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'migration.apply')
  );


-- ============================================================================
-- 9 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('import_sessions'), ('import_records'), ('import_conflicts'),
    ('import_field_mappings')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0052: %', missing;
  end if;

  select string_agg(code, ', ') into missing
  from (values ('migration.view'), ('migration.apply')) as g(code)
  where not exists (select 1 from public.permissions where permissions.code = g.code);
  if missing is not null then
    raise exception 'permissions missing for 0052: %', missing;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'import_records_ledger_key'
  ) then
    raise exception
      'the import ledger has no unique key, so re-importing the same file would duplicate every row';
  end if;

  -- Keyed WITH session_id, every re-import is a fresh session and duplicates
  -- everything. This is the mistake somebody makes while tidying up, and it
  -- would fail no test.
  if (select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'import_records_ledger_key')
     like '%session_id%' then
    raise exception
      'the import ledger key includes session_id, which makes every re-import a fresh set of duplicates';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'import_conflicts_decided_pair'
      and conrelid = 'public.import_conflicts'::regclass
  ) then
    raise exception 'a conflict could be decided with nobody named';
  end if;

  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'import_%'
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon' and table_name like 'import_%';
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;

  select string_agg(distinct grantee, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'import_records'
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('DELETE', 'TRUNCATE');
  if missing is not null then
    raise exception
      'delete is granted on the import ledger, so somebody could clear it and re-import everything twice: %', missing;
  end if;
end $$;
