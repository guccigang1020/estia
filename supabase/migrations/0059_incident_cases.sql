-- ============================================================================
-- 0059_incident_cases.sql — ESTIA · damage, deposits and who decides
--
-- What was there and what was not
--   `/incidents` existed with about 669 lines and QUERIED NOTHING — no
--   `.from(...)`, no `.rpc(...)`. Presentation with no data behind it. The
--   grants `incident.create`, `incident.view`, `incident.update` and
--   `incident.resolve` all existed, and `incident.opened` was already a frozen
--   event the notification catalogue routes.
--
--   A cleaner reporting a fault already opens a `tasks` row, because
--   `defineTaskCreation` takes the permission as a parameter and the wiring
--   passes `incident.create`. This builds ON that: a case carries `task_id`
--   and is opened on a fault report rather than instead of it. The two lists
--   answer different questions — has anybody picked this up, against who are
--   we waiting on.
--
-- THE RULE THIS MODULE EXISTS FOR
--   AI or a photo comparison may never assert liability. A before/after
--   difference is EVIDENCE; a person decides. That is enforced at three
--   floors, and the database holds two of them:
--
--     1. `decided_by` is NOT NULL and references a real user. A decision with
--        no decider cannot be written.
--     2. `incident_liability_insert` requires `decided_by = auth.uid()` — not
--        merely that the caller holds `incident.resolve`. One person cannot
--        record another as the decider.
--     3. (Domain) `evaluateLiability` refuses a `system` or `ai_agent` actor
--        holding every grant, and the module exports nothing matching
--        /^(infer|decideFrom|liabilityFrom)/.
--
--   `incident_liability_basis` has no `photo_comparison`, no `automatic` and
--   no `detected` member. There is no value a comparison could file itself
--   under.
--
-- Evidence stores no bytes
--   `media_ref` is an opaque pointer, capped at 512 characters and refusing
--   `data:` and `blob:`. There is no `data`, `bytes` or `content` column and
--   there must never be one — `site_media` and `payment_proofs` are shaped the
--   same way, and an evidence row whose content an ordinary UPDATE can rewrite
--   is not evidence.
--
-- Liability decisions are append only
--   A revised decision is a NEW row naming the one it supersedes. The first
--   question in a dispute six months later is what was decided at the time and
--   by whom, and an UPDATE deletes exactly that.
--
-- Money is separately gated
--   `incident_cost_lines` and the decision's amounts ask for `expense.view` as
--   well as `incident.view`. That is what lets a maintenance handyman work a
--   damage case and never learn what it cost.
--
-- Depends on
--   0008 (properties, units), 0009 (bookings), 0011 (tasks and the composite
--   keys), 0004 (RLS helpers).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabularies
-- ============================================================================

do $$ begin
  create type public.incident_case_type as enum (
    'property_damage', 'item_damage', 'item_loss', 'guest_reported_issue',
    'maintenance_failure', 'cleaning_damage', 'access_incident', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_origin as enum (
    'pre_stay_inspection', 'cleaner_report', 'guest_report', 'maintenance',
    'checkout_inspection', 'inventory_discrepancy');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_case_status as enum (
    'open', 'investigating', 'awaiting_guest', 'awaiting_vendor',
    'awaiting_approval', 'resolved', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_question_audience as enum
    ('guest', 'vendor', 'owner', 'internal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_evidence_kind as enum (
    'before_photo', 'after_photo', 'video', 'staff_statement',
    'guest_statement', 'invoice', 'repair_estimate', 'inventory_record',
    'timestamp');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_evidence_source as enum
    ('staff', 'guest', 'vendor', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_cost_kind as enum (
    'estimated_damage', 'repair_quote', 'actual_repair', 'replacement',
    'extra_cleaning', 'lost_revenue', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_liability_outcome as enum (
    'guest_responsible', 'owner_responsible', 'business_expense',
    'shared', 'undetermined');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.incident_liability_basis as enum (
    'evidence_reviewed', 'guest_admission', 'vendor_report', 'contract_terms',
    'staff_investigation', 'management_judgment');
exception when duplicate_object then null; end $$;

comment on type public.incident_liability_basis is
  'Every value is something a PERSON did. There is deliberately no photo_comparison, no automatic and no detected member: a comparison produces differences and must not be able to name itself as the basis of a liability decision.';

do $$ begin
  create type public.inspection_stage as enum
    ('pre_stay', 'stay', 'checkout', 'post_stay');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.inspection_condition as enum
    ('intact', 'worn', 'damaged', 'missing', 'not_checked');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 2 · The case
-- ============================================================================

create table if not exists public.incident_cases (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  property_id     uuid not null,
  unit_id         uuid,
  booking_id      uuid,
  task_id         uuid,
  case_type       public.incident_case_type not null,
  origin          public.incident_origin not null,
  status          public.incident_case_status not null default 'open',
  title           text not null,
  description     text,
  occurred_at     timestamptz,
  opened_at       timestamptz not null default now(),
  opened_by       uuid references auth.users (id) on delete set null,
  resolved_at     timestamptz,
  closed_at       timestamptz,
  closed_by       uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         integer not null default 1,
  constraint incident_cases_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint incident_cases_unit_fkey foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete set null (unit_id),
  constraint incident_cases_booking_fkey foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete set null (booking_id),
  constraint incident_cases_task_fkey foreign key (task_id, organization_id, property_id)
    references public.tasks (id, organization_id, property_id) on delete set null (task_id),
  constraint incident_cases_id_organization_key unique (id, organization_id),
  constraint incident_cases_id_org_property_key unique (id, organization_id, property_id),
  constraint incident_cases_title_not_blank check (length(btrim(title)) > 0),
  constraint incident_cases_occurred_before_opened
    check (occurred_at is null or occurred_at <= opened_at),
  constraint incident_cases_resolved_stamp
    check ((status in ('resolved', 'closed')) = (resolved_at is not null)),
  constraint incident_cases_closed_stamp
    check ((status = 'closed') = (closed_at is not null))
);

comment on table public.incident_cases is
  'A fault that costs money. A fault REPORT is a task and lives on /incidents; a case is opened ON one — task_id — rather than instead of it, and the two lists answer different questions: has anybody picked this up, against who are we waiting on.';

create index if not exists incident_cases_org_property_status_idx
  on public.incident_cases (organization_id, property_id, status, opened_at);
create index if not exists incident_cases_booking_idx
  on public.incident_cases (organization_id, booking_id) where booking_id is not null;
create index if not exists incident_cases_task_idx
  on public.incident_cases (organization_id, task_id) where task_id is not null;
create index if not exists incident_cases_waiting_idx
  on public.incident_cases (organization_id, opened_at)
  where status in ('awaiting_guest', 'awaiting_vendor', 'awaiting_approval');

drop trigger if exists incident_cases_touch on public.incident_cases;
create trigger incident_cases_touch
  before update on public.incident_cases
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · Open questions
-- ============================================================================

create table if not exists public.incident_case_questions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id         uuid not null,
  audience        public.incident_question_audience not null,
  question        text not null,
  asked_at        timestamptz not null default now(),
  asked_by        uuid references auth.users (id) on delete set null,
  answered_at     timestamptz,
  answer          text,
  constraint incident_case_questions_case_fkey foreign key (case_id, organization_id)
    references public.incident_cases (id, organization_id) on delete cascade,
  constraint incident_case_questions_not_blank check (length(btrim(question)) > 0),
  constraint incident_case_questions_answer_pair
    check ((answered_at is null) = (answer is null))
);

comment on constraint incident_case_questions_answer_pair on public.incident_case_questions is
  'Answered means BOTH. A stamp with no text is somebody closing a question by clicking, and the workflow must not read that as answered.';

create index if not exists incident_case_questions_open_idx
  on public.incident_case_questions (organization_id, case_id) where answered_at is null;


-- ============================================================================
-- 4 · Evidence — references and statements, never bytes
-- ============================================================================

create table if not exists public.incident_evidence (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id         uuid not null,
  kind            public.incident_evidence_kind not null,
  media_ref       text,
  content_type    text,
  byte_size       bigint,
  statement       text,
  captured_at     timestamptz,
  recorded_at     timestamptz not null default now(),
  source          public.incident_evidence_source not null,
  recorded_by     uuid references auth.users (id) on delete set null,
  note            text,
  constraint incident_evidence_case_fkey foreign key (case_id, organization_id)
    references public.incident_cases (id, organization_id) on delete cascade,
  constraint incident_evidence_id_organization_key unique (id, organization_id),
  -- A row is EITHER a reference or a statement, never both.
  constraint incident_evidence_one_of check (num_nonnulls(media_ref, statement) <= 1),
  constraint incident_evidence_media_kinds_have_a_reference check (
    kind not in ('before_photo', 'after_photo', 'video', 'invoice', 'repair_estimate')
    or (media_ref is not null and length(btrim(media_ref)) > 0)
  ),
  constraint incident_evidence_statement_kinds_have_text check (
    kind not in ('staff_statement', 'guest_statement')
    or (statement is not null and length(btrim(statement)) > 0)
  ),
  constraint incident_evidence_reference_is_not_a_payload check (
    media_ref is null
    or (media_ref not like 'data:%' and media_ref not like 'blob:%'
        and length(media_ref) <= 512)
  ),
  constraint incident_evidence_byte_size_nonnegative check (
    byte_size is null or byte_size >= 0
  )
);

comment on table public.incident_evidence is
  'An opaque pointer into the object store, or a statement. THERE IS NO data, bytes OR content COLUMN AND THERE MUST NEVER BE ONE — site_media and payment_proofs are shaped the same way, and an evidence row whose content an ordinary UPDATE can rewrite is not evidence.';

create index if not exists incident_evidence_case_idx
  on public.incident_evidence (organization_id, case_id, recorded_at);


-- ============================================================================
-- 5 · What it cost
-- ============================================================================

create table if not exists public.incident_cost_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id         uuid not null,
  kind            public.incident_cost_kind not null,
  description     text not null,
  amount_agorot   bigint not null,
  incurred_on     date,
  evidence_id     uuid,
  recorded_by     uuid references auth.users (id) on delete set null,
  recorded_at     timestamptz not null default now(),
  constraint incident_cost_lines_case_fkey foreign key (case_id, organization_id)
    references public.incident_cases (id, organization_id) on delete cascade,
  constraint incident_cost_lines_evidence_fkey foreign key (evidence_id, organization_id)
    references public.incident_evidence (id, organization_id) on delete set null (evidence_id),
  constraint incident_cost_lines_description_not_blank check (length(btrim(description)) > 0),
  constraint incident_cost_lines_amount_nonnegative check (amount_agorot >= 0)
);

create index if not exists incident_cost_lines_case_idx
  on public.incident_cost_lines (organization_id, case_id, recorded_at);


-- ============================================================================
-- 6 · Who decided, and on what basis
-- ============================================================================

create table if not exists public.incident_liability_decisions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  case_id                  uuid not null,
  outcome                  public.incident_liability_outcome not null,
  decided_by               uuid not null references auth.users (id) on delete restrict,
  decided_at               timestamptz not null default now(),
  basis                    public.incident_liability_basis not null,
  rationale                text not null,
  assessed_total_agorot    bigint not null,
  guest_charge_agorot      bigint not null default 0,
  owner_charge_agorot      bigint not null default 0,
  business_absorbed_agorot bigint not null default 0,
  supporting_evidence_ids  uuid[] not null default '{}',
  supersedes_decision_id   uuid,
  constraint incident_liability_case_fkey foreign key (case_id, organization_id)
    references public.incident_cases (id, organization_id) on delete cascade,
  constraint incident_liability_supersedes_fkey
    foreign key (supersedes_decision_id, organization_id)
    references public.incident_liability_decisions (id, organization_id)
    on delete set null (supersedes_decision_id),
  constraint incident_liability_id_organization_key unique (id, organization_id),
  constraint incident_liability_rationale_is_a_sentence check (length(btrim(rationale)) >= 10),
  constraint incident_liability_amounts_nonnegative check (
    assessed_total_agorot >= 0 and guest_charge_agorot >= 0
    and owner_charge_agorot >= 0 and business_absorbed_agorot >= 0
  ),
  constraint incident_liability_allocation_balances check (
    guest_charge_agorot + owner_charge_agorot + business_absorbed_agorot
      = assessed_total_agorot
  ),
  constraint incident_liability_guest_charge_needs_guest_outcome check (
    guest_charge_agorot = 0 or outcome in ('guest_responsible', 'shared')
  )
);

comment on table public.incident_liability_decisions is
  'Append only. A revised decision is a NEW row naming the one it supersedes: the first question in a dispute six months later is what was decided at the time and by whom, and an UPDATE deletes exactly that.';
comment on column public.incident_liability_decisions.decided_by is
  'NOT NULL, and this is the point of the whole module. A liability decision with no decider cannot be written, cannot be read back and does not typecheck. AI or a photo comparison may never assert liability — a comparison produces differences, and a person decides.';
comment on constraint incident_liability_allocation_balances on public.incident_liability_decisions is
  'Exact, to the agora. A decision allocating 1,410 of a 1,400 cost is one somebody discovers when a guest disputes ten agorot.';

create index if not exists incident_liability_case_idx
  on public.incident_liability_decisions (organization_id, case_id, decided_at desc);


-- ============================================================================
-- 7 · Inspections
-- ============================================================================

create table if not exists public.incident_inspections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  property_id     uuid not null,
  unit_id         uuid not null,
  booking_id      uuid,
  case_id         uuid,
  stage           public.inspection_stage not null,
  performed_by    uuid references auth.users (id) on delete set null,
  performed_at    timestamptz not null default now(),
  notes           text,
  constraint incident_inspections_property_fkey foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint incident_inspections_unit_fkey foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete cascade,
  constraint incident_inspections_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete set null (booking_id),
  constraint incident_inspections_case_fkey foreign key (case_id, organization_id)
    references public.incident_cases (id, organization_id) on delete set null (case_id),
  constraint incident_inspections_id_organization_key unique (id, organization_id)
);

create index if not exists incident_inspections_booking_idx
  on public.incident_inspections (organization_id, booking_id, performed_at)
  where booking_id is not null;
create index if not exists incident_inspections_unit_idx
  on public.incident_inspections (organization_id, unit_id, performed_at);
create unique index if not exists incident_inspections_stage_per_booking_idx
  on public.incident_inspections (organization_id, booking_id, stage)
  where booking_id is not null;

comment on index public.incident_inspections_stage_per_booking_idx is
  'One record per stage per stay. A second checkout inspection is an edit of the first, not a second checkout.';

create table if not exists public.incident_inspection_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  inspection_id   uuid not null,
  item_key        text not null,
  label           text not null,
  condition       public.inspection_condition not null default 'not_checked',
  quantity        integer,
  evidence_ids    uuid[] not null default '{}',
  note            text,
  sort_order      integer not null default 0,
  constraint incident_inspection_items_inspection_fkey
    foreign key (inspection_id, organization_id)
    references public.incident_inspections (id, organization_id) on delete cascade,
  constraint incident_inspection_items_key_not_blank check (length(btrim(item_key)) > 0),
  constraint incident_inspection_items_quantity_nonnegative check (
    quantity is null or quantity >= 0
  ),
  constraint incident_inspection_items_unique_key unique (inspection_id, item_key)
);

comment on column public.incident_inspection_items.item_key is
  'Stable across stages, which is what pairs a pre-stay row with its checkout row and makes a difference computable at all.';

create index if not exists incident_inspection_items_inspection_idx
  on public.incident_inspection_items (organization_id, inspection_id, sort_order);


-- ============================================================================
-- 8 · Row level security
-- ============================================================================

alter table public.incident_cases               enable row level security;
alter table public.incident_cases               force  row level security;
alter table public.incident_case_questions      enable row level security;
alter table public.incident_case_questions      force  row level security;
alter table public.incident_evidence            enable row level security;
alter table public.incident_evidence            force  row level security;
alter table public.incident_cost_lines          enable row level security;
alter table public.incident_cost_lines          force  row level security;
alter table public.incident_liability_decisions enable row level security;
alter table public.incident_liability_decisions force  row level security;
alter table public.incident_inspections         enable row level security;
alter table public.incident_inspections         force  row level security;
alter table public.incident_inspection_items    enable row level security;
alter table public.incident_inspection_items    force  row level security;

revoke all on public.incident_cases               from anon, authenticated;
revoke all on public.incident_case_questions      from anon, authenticated;
revoke all on public.incident_evidence            from anon, authenticated;
revoke all on public.incident_cost_lines          from anon, authenticated;
revoke all on public.incident_liability_decisions from anon, authenticated;
revoke all on public.incident_inspections         from anon, authenticated;
revoke all on public.incident_inspection_items    from anon, authenticated;

grant select, insert, update on public.incident_cases               to authenticated, service_role;
grant select, insert, update on public.incident_case_questions      to authenticated, service_role;
grant select, insert         on public.incident_evidence            to authenticated, service_role;
grant select, insert         on public.incident_cost_lines          to authenticated, service_role;
grant select, insert         on public.incident_liability_decisions to authenticated, service_role;
grant select, insert, update on public.incident_inspections         to authenticated, service_role;
grant select, insert, update on public.incident_inspection_items    to authenticated, service_role;

-- Cases are closed, never deleted. Evidence and decisions are append only.
revoke delete, truncate on public.incident_evidence            from authenticated, service_role;
revoke delete, truncate on public.incident_liability_decisions from authenticated, service_role;
revoke delete, truncate on public.incident_cases               from authenticated, service_role;


-- ============================================================================
-- 9 · Policies
-- ============================================================================

drop policy if exists incident_cases_select on public.incident_cases;
create policy incident_cases_select on public.incident_cases
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'incident.view')
  );

drop policy if exists incident_cases_insert on public.incident_cases;
create policy incident_cases_insert on public.incident_cases
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'incident.create')
  );

drop policy if exists incident_cases_update on public.incident_cases;
create policy incident_cases_update on public.incident_cases
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (public.has_permission(organization_id, 'incident.update')
         or public.has_permission(organization_id, 'incident.resolve'))
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (public.has_permission(organization_id, 'incident.update')
         or public.has_permission(organization_id, 'incident.resolve'))
  );

drop policy if exists incident_case_questions_select on public.incident_case_questions;
create policy incident_case_questions_select on public.incident_case_questions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and exists (
      select 1 from public.incident_cases c
      where c.id = incident_case_questions.case_id
        and c.organization_id = incident_case_questions.organization_id
        and public.property_in_scope(c.property_id, c.organization_id)
    )
    and public.has_permission(organization_id, 'incident.view')
  );

drop policy if exists incident_case_questions_write on public.incident_case_questions;
create policy incident_case_questions_write on public.incident_case_questions
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'incident.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'incident.update')
  );

drop policy if exists incident_evidence_select on public.incident_evidence;
create policy incident_evidence_select on public.incident_evidence
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and exists (
      select 1 from public.incident_cases c
      where c.id = incident_evidence.case_id
        and c.organization_id = incident_evidence.organization_id
        and public.property_in_scope(c.property_id, c.organization_id)
    )
    and public.has_permission(organization_id, 'incident.view')
  );

drop policy if exists incident_evidence_insert on public.incident_evidence;
create policy incident_evidence_insert on public.incident_evidence
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'incident.update')
  );

-- Money is gated separately from the case, which is what lets a maintenance
-- handyman work a damage case and never learn what it cost.
drop policy if exists incident_cost_lines_select on public.incident_cost_lines;
create policy incident_cost_lines_select on public.incident_cost_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'incident.view')
    and public.has_permission(organization_id, 'expense.view')
  );

drop policy if exists incident_cost_lines_insert on public.incident_cost_lines;
create policy incident_cost_lines_insert on public.incident_cost_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'incident.update')
    and public.has_permission(organization_id, 'expense.create')
  );

drop policy if exists incident_liability_select on public.incident_liability_decisions;
create policy incident_liability_select on public.incident_liability_decisions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'incident.view')
  );

-- `decided_by = auth.uid()` is the load-bearing half. Not merely "holds
-- incident.resolve" — the row must name the person actually making the
-- request, so one person cannot record another as the decider.
drop policy if exists incident_liability_insert on public.incident_liability_decisions;
create policy incident_liability_insert on public.incident_liability_decisions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'incident.resolve')
    and decided_by = (select auth.uid())
  );

drop policy if exists incident_inspections_select on public.incident_inspections;
create policy incident_inspections_select on public.incident_inspections
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (public.has_permission(organization_id, 'incident.view')
         or public.has_permission(organization_id, 'task.view'))
  );

drop policy if exists incident_inspections_write on public.incident_inspections;
create policy incident_inspections_write on public.incident_inspections
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (public.has_permission(organization_id, 'task.complete')
         or public.has_permission(organization_id, 'incident.update'))
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (public.has_permission(organization_id, 'task.complete')
         or public.has_permission(organization_id, 'incident.update'))
  );

drop policy if exists incident_inspection_items_select on public.incident_inspection_items;
create policy incident_inspection_items_select on public.incident_inspection_items
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and exists (
      select 1 from public.incident_inspections i
      where i.id = incident_inspection_items.inspection_id
        and i.organization_id = incident_inspection_items.organization_id
    )
  );

drop policy if exists incident_inspection_items_write on public.incident_inspection_items;
create policy incident_inspection_items_write on public.incident_inspection_items
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and exists (
      select 1 from public.incident_inspections i
      where i.id = incident_inspection_items.inspection_id
        and i.organization_id = incident_inspection_items.organization_id
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and exists (
      select 1 from public.incident_inspections i
      where i.id = incident_inspection_items.inspection_id
        and i.organization_id = incident_inspection_items.organization_id
    )
  );


-- ============================================================================
-- 10 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('incident_cases'), ('incident_case_questions'), ('incident_evidence'),
    ('incident_cost_lines'), ('incident_liability_decisions'),
    ('incident_inspections'), ('incident_inspection_items')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0059: %', missing;
  end if;

  -- THE MODULE'S ONE RULE, at the floor. A liability decision must name the
  -- human who made it, and the policy must require that human to be the
  -- caller — not merely somebody holding the grant.
  if (select attnotnull from pg_attribute
      where attrelid = 'public.incident_liability_decisions'::regclass
        and attname = 'decided_by') is not true then
    raise exception
      'a liability decision could be written with no decider, and a photo comparison could assert liability';
  end if;

  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'incident_liability_decisions'
      and p.polname = 'incident_liability_insert'
      and pg_get_expr(p.polwithcheck, p.polrelid) like '%auth.uid()%'
  ) then
    raise exception
      'the liability insert policy does not require decided_by to be the caller, so one person could record another as the decider';
  end if;

  -- No bytes, ever.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'incident_evidence'
      and column_name in ('data', 'bytes', 'content', 'blob', 'base64')
  ) then
    raise exception
      'incident_evidence has a payload column, and evidence an UPDATE can rewrite is not evidence';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'incident_liability_allocation_balances'
      and conrelid = 'public.incident_liability_decisions'::regclass
  ) then
    raise exception 'a liability decision could allocate more or less than the assessed total';
  end if;

  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'incident_%'
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon' and table_name like 'incident_%';
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;
end $$;
