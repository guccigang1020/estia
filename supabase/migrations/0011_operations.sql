-- ============================================================================
-- 0011_operations.sql — ESTIA · the work, the things, the exceptions and the
--                       money owed to somebody else
--
-- What this does
--   Creates the operational core: `tasks`, `task_assignments`,
--   `task_checklists`, `inventory_items`, `inventory_movements`, `approvals`
--   and `commissions`.
--
--   Every enum here is transcribed from src/lib/contracts/states.ts, in the
--   same order, spelled the same way. supabase/tests/operations.sql asserts it,
--   so a value added to one side and not the other fails a test rather than
--   surfacing as a screen that cannot render a status.
--
-- ── Four decisions worth stating up front ───────────────────────────────────
--
--   **A task happens at a property, and `property_id` is NOT NULL.** Row level
--   security narrows by property; a nullable scope anchor is a hole RLS cannot
--   close, because `property_id IS NULL OR in_scope(...)` hands every
--   organization-wide row to a member scoped to one villa. A finance task names
--   the property it concerns. `approvals` is the one table here where
--   `property_id` is nullable, because a governance request genuinely can be
--   about the business rather than about a place — and its policy is written
--   to say so out loud rather than to leave it implied.
--
--   **The stock ledger is the truth, and the item's count is derived.**
--   `inventory_movements` is append-only and a trigger applies each delta to
--   `inventory_items.quantity`. A count that can be typed over is a count that
--   silently disagrees with the twenty movements that produced it, and the
--   disagreement is discovered on the morning both events need the mattresses.
--
--   **An approval may not be decided by the person who asked for it.** The
--   whole point of the mechanism is that exceeding a limit becomes a request
--   rather than a refusal; a requester who can approve their own request has
--   a limit in name only. Enforced by CHECK, so it holds against the service
--   role and the table owner as well.
--
--   **A commission is not payable until it was approved.** COMMISSION_STATUSES
--   is a ladder for a reason the contract states plainly: paying on `estimated`
--   means paying for stays that never happened. `paid` therefore requires an
--   `approved_at`, by CHECK.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, units, teams, property_in_scope,
--   unit_in_scope), 0009 (bookings), 0010 (payments — commissions reference
--   nothing in it, but the file order is the dependency order of the domain).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- Types — transcribed from src/lib/contracts/states.ts
-- ============================================================================

-- TASK_STATUSES, in order. `blocked` is deliberately distinct from
-- `in_progress`: a cleaner waiting for linen that has not arrived is not making
-- progress, and a board that cannot show the difference cannot show a
-- supervisor where the day is stuck.
do $$ begin
  create type public.task_status as enum (
    'new',
    'assigned',
    'accepted',
    'in_progress',
    'blocked',
    'awaiting_approval',
    'completed',
    'verified',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.task_status is
  'Transcribed from TASK_STATUSES in src/lib/contracts/states.ts, in the same order. `verified` follows `completed` because a business may require inspection before a unit counts as ready; where it does not, the two collapse.';

-- TASK_TYPES, in order.
do $$ begin
  create type public.task_type as enum (
    'cleaning',
    'preparation',
    'inspection',
    'maintenance',
    'guest_request',
    'delivery',
    'inventory',
    'finance',
    'administrative',
    'custom'
  );
exception when duplicate_object then null;
end $$;

-- TASK_PRIORITIES, in order.
do $$ begin
  create type public.task_priority as enum ('low', 'normal', 'high', 'critical');
exception when duplicate_object then null;
end $$;

-- INVENTORY_STATES, in order.
do $$ begin
  create type public.inventory_state as enum (
    'available',
    'reserved',
    'in_use',
    'dirty',
    'laundry',
    'damaged',
    'out_of_service'
  );
exception when duplicate_object then null;
end $$;

comment on type public.inventory_state is
  'Transcribed from INVENTORY_STATES in src/lib/contracts/states.ts, in the same order. `reserved` is what stops two events being promised the same twenty mattresses; without it, stock looks sufficient right up to the morning both events need it.';

-- APPROVAL_STATUSES, in order.
do $$ begin
  create type public.approval_status as enum (
    'requested',
    'approved',
    'rejected',
    'expired',
    'withdrawn'
  );
exception when duplicate_object then null;
end $$;

-- APPROVAL_TYPES, in order.
do $$ begin
  create type public.approval_type as enum (
    'discount',
    'refund',
    'expense',
    'maintenance',
    'agent_booking',
    'owner_request',
    'price_override',
    'availability_override'
  );
exception when duplicate_object then null;
end $$;

-- COMMISSION_STATUSES, in order.
do $$ begin
  create type public.commission_status as enum (
    'estimated',
    'pending',
    'eligible',
    'approved',
    'paid',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.commission_status is
  'Transcribed from COMMISSION_STATUSES in src/lib/contracts/states.ts, in the same order. A ladder, not a set of flags: a commission is a promise long before it is a debt, and paying on `estimated` means paying for stays that never happened.';

-- Not from the contract: why a quantity moved.
do $$ begin
  create type public.inventory_movement_kind as enum (
    'receipt',
    'issue',
    'transfer',
    'return',
    'adjustment',
    'loss',
    'count'
  );
exception when duplicate_object then null;
end $$;

-- ALLOCATABLE_INVENTORY_STATES, stated once.
create or replace function public.allocatable_inventory_states()
returns public.inventory_state[]
language sql
immutable
set search_path = ''
as $$
  select array['available']::public.inventory_state[];
$$;

comment on function public.allocatable_inventory_states() is
  'Transcribed from ALLOCATABLE_INVENTORY_STATES in src/lib/contracts/states.ts: the states in which stock can still be promised to a future booking. One element today, and a function rather than a literal so that widening it is one edit rather than a search.';

grant execute on function public.allocatable_inventory_states() to authenticated, service_role;


-- ============================================================================
-- tasks
-- ============================================================================
-- The unit of operational work. A cleaning, a repair, a guest request, an
-- inspection — one shape, because a board that has to union four tables is a
-- board nobody keeps current.

create table if not exists public.tasks (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  -- NOT NULL. See the header: RLS narrows by property, and a nullable anchor
  -- is a hole the policy cannot close.
  property_id          uuid not null,
  unit_id              uuid,
  booking_id           uuid,

  task_type            public.task_type not null default 'custom',
  status               public.task_status not null default 'new',
  priority             public.task_priority not null default 'normal',

  title                text not null,
  description          text,

  -- The person answerable for it. Denormalised from task_assignments on
  -- purpose: the `own_records` scope in src/lib/authz/can.ts narrows by
  -- assignedToUserId, and a scope that had to aggregate a join could not be a
  -- policy expression.
  assigned_to_user_id  uuid references auth.users (id) on delete set null,
  team_id              uuid,

  scheduled_start_at   timestamptz,
  scheduled_end_at     timestamptz,
  due_at               timestamptz,
  estimated_minutes    integer,
  actual_minutes       integer,

  -- Stamped by trigger from the status, never typed. A completed_at that
  -- disagrees with the status is a report that disagrees with the board.
  started_at           timestamptz,
  completed_at         timestamptz,
  verified_at          timestamptz,
  verified_by          uuid references auth.users (id) on delete set null,
  cancelled_at         timestamptz,

  blocked_reason       text,
  cancellation_reason  text,
  completion_note      text,
  requires_photo       boolean not null default false,

  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,
  deleted_at           timestamptz,
  deleted_by           uuid references auth.users (id) on delete set null,

  constraint tasks_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint tasks_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id)
    on delete set null (unit_id),
  constraint tasks_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id)
    on delete set null (booking_id),
  constraint tasks_team_fkey
    foreign key (team_id, organization_id)
    references public.teams (id, organization_id)
    on delete set null (team_id),

  constraint tasks_id_organization_key unique (id, organization_id),
  constraint tasks_id_organization_property_key unique (id, organization_id, property_id),

  constraint tasks_title_not_blank check (length(btrim(title)) > 0),
  constraint tasks_minutes_positive check (
    (estimated_minutes is null or estimated_minutes > 0)
    and (actual_minutes is null or actual_minutes >= 0)
  ),
  constraint tasks_schedule_ordered check (
    scheduled_start_at is null or scheduled_end_at is null
    or scheduled_end_at >= scheduled_start_at
  ),
  -- A supervisor looking at a stuck board needs the reason, not the fact.
  constraint tasks_blocked_has_reason check (
    status <> 'blocked' or length(btrim(coalesce(blocked_reason, ''))) > 0
  ),
  constraint tasks_cancelled_has_reason check (
    status <> 'cancelled' or length(btrim(coalesce(cancellation_reason, ''))) > 0
  ),
  -- The stamping trigger guarantees these; the CHECK catches a write that
  -- reached the table some other way.
  constraint tasks_completed_has_moment check (
    status not in ('completed', 'verified') or completed_at is not null
  ),
  constraint tasks_verified_has_moment check (
    status <> 'verified' or verified_at is not null
  ),
  constraint tasks_version_positive check (version >= 1),
  constraint tasks_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.tasks is
  'The unit of operational work: a cleaning, a repair, a guest request, an inspection. One shape rather than four tables, because a board that has to union four tables is a board nobody keeps current. property_id is NOT NULL because row level security narrows by property and a nullable anchor is a hole a policy cannot close.';
comment on column public.tasks.assigned_to_user_id is
  'The person answerable, denormalised from task_assignments. The own_records scope in src/lib/authz/can.ts narrows by this column, and a scope that had to aggregate a join could not be a policy expression.';
comment on column public.tasks.completed_at is
  'Stamped by trigger from the status, never typed. A completion time that disagrees with the status is a report that disagrees with the board.';

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch
  before update on public.tasks
  for each row execute function public.tg_touch_row();


-- ── The status stamps ───────────────────────────────────────────────────────
-- One place, so "when did this actually finish" has one answer. Named
-- `tasks_stamp_status` so it sorts before `tasks_touch` and both run.

create or replace function public.tg_tasks_stamp_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'in_progress'::public.task_status and new.started_at is null then
    new.started_at := now();
  end if;

  if new.status in ('completed'::public.task_status, 'verified'::public.task_status)
     and new.completed_at is null then
    new.completed_at := now();
  end if;

  if new.status = 'verified'::public.task_status and new.verified_at is null then
    new.verified_at := now();
  end if;

  if new.status = 'cancelled'::public.task_status and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;

  return new;
end;
$$;

comment on function public.tg_tasks_stamp_status() is
  'Stamps started_at, completed_at, verified_at and cancelled_at from the status. The moments are owned by the database in the same way version is, so a report and a board cannot disagree about when work finished.';

drop trigger if exists tasks_stamp_status on public.tasks;
create trigger tasks_stamp_status
  before insert or update on public.tasks
  for each row execute function public.tg_tasks_stamp_status();


-- ============================================================================
-- task_assignments
-- ============================================================================
-- Several people on one task, each with a part in it. Kept as rows rather than
-- an array on the task, because accepting, declining and being taken off again
-- are events with times and reasons, and an array cannot carry any of them.

create table if not exists public.task_assignments (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  task_id           uuid not null,
  user_id           uuid not null references auth.users (id) on delete cascade,

  -- What this person is on the task for. Text and not an enum: it is a label a
  -- coordinator chooses, not a state anything computes against.
  assignment_role   text not null default 'assignee',

  assigned_at       timestamptz not null default now(),
  assigned_by       uuid references auth.users (id) on delete set null,
  -- A cleaner who has seen the job and taken it is different from one who has
  -- merely been given it. A board that cannot tell has no idea whether the day
  -- is covered.
  accepted_at       timestamptz,
  declined_at       timestamptz,
  declined_reason   text,
  unassigned_at     timestamptz,

  metadata          jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,

  constraint task_assignments_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete cascade,
  constraint task_assignments_role_not_blank check (length(btrim(assignment_role)) > 0),
  constraint task_assignments_not_both check (
    accepted_at is null or declined_at is null
  ),
  constraint task_assignments_declined_has_reason check (
    declined_at is null or length(btrim(coalesce(declined_reason, ''))) > 0
  ),
  constraint task_assignments_version_positive check (version >= 1)
);

comment on table public.task_assignments is
  'Who is on a task, and what happened to that assignment: accepted, declined with a reason, taken off again. Rows rather than an array on the task, because each of those is an event with a time and an array cannot carry one.';

-- One live assignment per person per task. Partial, so the same person can be
-- put back on a task they were taken off.
create unique index if not exists task_assignments_live_idx
  on public.task_assignments (task_id, user_id)
  where unassigned_at is null;

drop trigger if exists task_assignments_touch on public.task_assignments;
create trigger task_assignments_touch
  before update on public.task_assignments
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- task_checklists
-- ============================================================================
-- What actually has to be done, item by item. The reason a cleaning is a
-- standard rather than a hope, and the reason an inspection can be evidenced.

create table if not exists public.task_checklists (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  task_id          uuid not null,

  position         integer not null default 0,
  label            text not null,
  description      text,

  is_required      boolean not null default true,
  requires_photo   boolean not null default false,

  is_done          boolean not null default false,
  done_at          timestamptz,
  done_by          uuid references auth.users (id) on delete set null,
  photo_url        text,
  note             text,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          integer not null default 1,

  constraint task_checklists_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete cascade,
  constraint task_checklists_position_unique unique (task_id, position),
  constraint task_checklists_label_not_blank check (length(btrim(label)) > 0),
  constraint task_checklists_done_pair check (
    (is_done and done_at is not null) or (not is_done and done_at is null)
  ),
  -- An item that demands evidence cannot be ticked without it. This is the
  -- whole value of `requires_photo`: enforced here, it is a standard; enforced
  -- in a form, it is a suggestion.
  constraint task_checklists_photo_required check (
    not is_done or not requires_photo or length(btrim(coalesce(photo_url, ''))) > 0
  ),
  constraint task_checklists_version_positive check (version >= 1)
);

comment on table public.task_checklists is
  'The items a task is made of. `requires_photo` is enforced by CHECK and not by a form: an item that demands evidence cannot be ticked without it, which is the difference between a standard and a suggestion.';

drop trigger if exists task_checklists_touch on public.task_checklists;
create trigger task_checklists_touch
  before update on public.task_checklists
  for each row execute function public.tg_touch_row();


-- ── Ticking an item stamps it ───────────────────────────────────────────────

create or replace function public.tg_task_checklists_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_done and new.done_at is null then
    new.done_at := now();
    new.done_by := coalesce(new.done_by, (select auth.uid()));
  elsif not new.is_done then
    new.done_at := null;
    new.done_by := null;
  end if;
  return new;
end;
$$;

comment on function public.tg_task_checklists_stamp() is
  'Stamps done_at and done_by when an item is ticked, and clears both when it is un-ticked. Keeps the CHECK on the pair satisfiable without every caller remembering to set two columns.';

drop trigger if exists task_checklists_stamp on public.task_checklists;
create trigger task_checklists_stamp
  before insert or update on public.task_checklists
  for each row execute function public.tg_task_checklists_stamp();


-- ============================================================================
-- inventory_items
-- ============================================================================
-- The physical things: linen, mattresses, keys, welcome baskets. `quantity` is
-- derived from the movement ledger below and is not a number a caller types.

create table if not exists public.inventory_items (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  property_id        uuid not null,
  unit_id            uuid,

  sku                text,
  name               text not null,
  category           text,
  description        text,

  state              public.inventory_state not null default 'available',

  quantity           integer not null default 0,
  -- Promised to a future booking or event but not yet taken. The column that
  -- stops two events being sold the same twenty mattresses.
  quantity_reserved  integer not null default 0,
  unit_of_measure    text not null default 'unit',
  -- The reorder point. A shortage that is only noticed when a cleaner opens an
  -- empty cupboard has already cost a changeover.
  min_quantity       integer,
  par_level          integer,

  unit_cost_agorot   integer,
  location           text,
  last_counted_at    timestamptz,

  metadata           jsonb not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  version            integer not null default 1,
  deleted_at         timestamptz,
  deleted_by         uuid references auth.users (id) on delete set null,

  constraint inventory_items_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint inventory_items_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id)
    on delete set null (unit_id),

  constraint inventory_items_id_organization_key unique (id, organization_id),
  constraint inventory_items_id_organization_property_key unique (id, organization_id, property_id),

  constraint inventory_items_name_not_blank check (length(btrim(name)) > 0),
  constraint inventory_items_uom_not_blank check (length(btrim(unit_of_measure)) > 0),
  -- Stock cannot go below zero. This is the constraint that refuses a movement
  -- issuing more than exists, from the trigger that applies it.
  constraint inventory_items_quantity_nonnegative check (quantity >= 0),
  constraint inventory_items_reserved_within_quantity check (
    quantity_reserved >= 0 and quantity_reserved <= quantity
  ),
  constraint inventory_items_thresholds_nonnegative check (
    (min_quantity is null or min_quantity >= 0)
    and (par_level is null or par_level >= 0)
  ),
  constraint inventory_items_cost_nonnegative check (
    unit_cost_agorot is null or unit_cost_agorot >= 0
  ),
  constraint inventory_items_version_positive check (version >= 1),
  constraint inventory_items_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.inventory_items is
  'The physical things a property runs on. `quantity` is derived from inventory_movements by trigger, not typed: a count that can be overwritten is a count that silently disagrees with the movements that produced it, and the disagreement surfaces on the morning both events need the mattresses.';
comment on column public.inventory_items.quantity_reserved is
  'Promised to a future booking or event but not yet taken. The column that stops two events being sold the same twenty mattresses.';

create unique index if not exists inventory_items_sku_idx
  on public.inventory_items (organization_id, property_id, lower(sku))
  where sku is not null and deleted_at is null;

drop trigger if exists inventory_items_touch on public.inventory_items;
create trigger inventory_items_touch
  before update on public.inventory_items
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- inventory_movements
-- ============================================================================
-- Append-only, on the same terms as audit_events in 0005 and
-- booking_status_history in 0009: the privileges are revoked and a
-- statement-level trigger refuses UPDATE and DELETE, because the table owner
-- is not bound by grants and service_role carries BYPASSRLS.
--
-- A correction is a compensating movement, not an edit. That is not
-- bureaucracy: "we thought we had forty and we have thirty-two" is itself a
-- fact worth keeping, and an edit erases it.

create table if not exists public.inventory_movements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,
  item_id          uuid not null,

  kind             public.inventory_movement_kind not null,
  -- Signed: negative takes stock away. Signed rather than a direction column
  -- so the balance is a plain sum, exactly as booking price lines are.
  quantity_delta   integer not null,

  from_state       public.inventory_state,
  to_state         public.inventory_state,
  from_unit_id     uuid,
  to_unit_id       uuid,

  task_id          uuid,
  booking_id       uuid,

  reason           text,
  occurred_at      timestamptz not null default now(),

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,

  constraint inventory_movements_item_fkey
    foreign key (item_id, organization_id, property_id)
    references public.inventory_items (id, organization_id, property_id) on delete cascade,
  constraint inventory_movements_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete set null (task_id),
  constraint inventory_movements_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id)
    on delete set null (booking_id),
  -- A movement of nothing is not a movement.
  constraint inventory_movements_delta_nonzero check (quantity_delta <> 0),
  constraint inventory_movements_transfer_units check (
    kind <> 'transfer' or (from_unit_id is not null or to_unit_id is not null)
  )
);

comment on table public.inventory_movements is
  'The stock ledger: one row per change, signed, append-only. The item quantity is derived from it by trigger. A correction is a compensating movement and never an edit — "we thought we had forty and we have thirty-two" is itself a fact worth keeping, and an edit erases it.';

create or replace function public.tg_inventory_movements_apply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.inventory_items
     set quantity = quantity + new.quantity_delta
   where id = new.item_id;

  if new.to_state is not null then
    update public.inventory_items
       set state = new.to_state
     where id = new.item_id;
  end if;

  return null;
end;
$$;

comment on function public.tg_inventory_movements_apply() is
  'Applies a movement delta to the item quantity. A movement that would take stock below zero fails on the inventory_items_quantity_nonnegative CHECK with 23514 — issuing more than exists is refused by the constraint, not by a branch somebody could forget to write.';

drop trigger if exists inventory_movements_apply on public.inventory_movements;
create trigger inventory_movements_apply
  after insert on public.inventory_movements
  for each row execute function public.tg_inventory_movements_apply();


create or replace function public.tg_inventory_movements_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'inventory_movements is append-only; % is not permitted', tg_op
    using errcode = '42501',
          hint = 'Record a compensating movement instead.';
end;
$$;

drop trigger if exists inventory_movements_no_update on public.inventory_movements;
create trigger inventory_movements_no_update
  before update on public.inventory_movements
  for each statement execute function public.tg_inventory_movements_append_only();

drop trigger if exists inventory_movements_no_delete on public.inventory_movements;
create trigger inventory_movements_no_delete
  before delete on public.inventory_movements
  for each statement execute function public.tg_inventory_movements_append_only();


-- ============================================================================
-- approvals
-- ============================================================================
-- A request to do something the requester may not do alone. The product treats
-- exceeding a limit as a request rather than a refusal — an agent who needs a
-- 12% discount when 5% is allowed gets a flow, not a closed door.
--
-- `property_id` is nullable here and only here: an expense or an owner request
-- can genuinely be about the business rather than about a place. The policy
-- below says so explicitly rather than leaving it implied.

-- An approval's property anchor is nullable, so its reference to a booking
-- cannot use the (id, organization_id, property_id) key 0009 declared — the
-- third column would not be there to match on. A two-column key gives the same
-- tenant proof to a reference that does not know the property. Purely
-- additive: `id` is already the primary key, so this asserts nothing new about
-- the data and costs one index.
do $$ begin
  alter table public.bookings
    add constraint bookings_id_organization_key unique (id, organization_id);
exception when duplicate_object or duplicate_table then null;
end $$;

create table if not exists public.approvals (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null,
  property_id          uuid,

  approval_type        public.approval_type not null,
  status               public.approval_status not null default 'requested',

  booking_id           uuid,
  task_id              uuid,
  -- Anything else the request is about, when it is not a booking or a task.
  -- Deliberately not a foreign key: a generic pointer that pretended to be one
  -- would be a lie the database could not keep.
  subject_type         text,
  subject_id           uuid,

  requested_by         uuid not null references auth.users (id) on delete restrict,
  requested_at         timestamptz not null default now(),
  -- Why, in the requester's words. Required: a request nobody can evaluate is
  -- a request that gets approved out of politeness.
  reason               text not null,
  -- The ask and the ceiling it exceeds, so a decider sees the size of the
  -- exception rather than being told there is one.
  requested_value_bps  integer,
  limit_value_bps      integer,
  requested_agorot     integer,
  limit_agorot         integer,

  decided_by           uuid references auth.users (id) on delete set null,
  decided_at           timestamptz,
  decision_note        text,
  -- An unanswered request must not hold a sale open forever.
  expires_at           timestamptz,

  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  version              integer not null default 1,

  constraint approvals_organization_fkey
    foreign key (organization_id)
    references public.organizations (id) on delete cascade,
  constraint approvals_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id)
    on delete set null (property_id),
  constraint approvals_booking_fkey
    foreign key (booking_id, organization_id)
    references public.bookings (id, organization_id)
    on delete set null (booking_id),
  constraint approvals_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id)
    on delete set null (task_id),

  constraint approvals_reason_not_blank check (length(btrim(reason)) > 0),
  constraint approvals_subject_pair check (
    (subject_type is null) = (subject_id is null)
  ),
  constraint approvals_decided_pair check (
    (status in ('approved', 'rejected')) = (decided_at is not null)
  ),
  constraint approvals_decider_recorded check (
    decided_at is null or decided_by is not null
  ),
  -- The rule the whole mechanism rests on. A requester who can approve their
  -- own request has a limit in name only.
  constraint approvals_no_self_approval check (
    decided_by is null or decided_by <> requested_by
  ),
  constraint approvals_bps_range check (
    (requested_value_bps is null or requested_value_bps between 0 and 100000)
    and (limit_value_bps is null or limit_value_bps between 0 and 100000)
  ),
  constraint approvals_version_positive check (version >= 1)
);

comment on table public.approvals is
  'A request to do something the requester may not do alone. Exceeding a limit becomes a request rather than a refusal. Self-approval is refused by CHECK, so the rule holds against the service role and the table owner as well — a requester who can approve their own request has a limit in name only.';
comment on column public.approvals.property_id is
  'Nullable, and the only nullable property anchor in this migration: an expense or an owner request can genuinely be about the business rather than about a place. The SELECT policy states the consequence out loud instead of leaving it implied.';
comment on column public.approvals.expires_at is
  'When the request lapses. `expired` exists in APPROVAL_STATUSES because an unanswered request must not hold a sale open forever.';

drop trigger if exists approvals_touch on public.approvals;
create trigger approvals_touch
  before update on public.approvals
  for each row execute function public.tg_touch_row();

create or replace function public.tg_approvals_stamp_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('approved'::public.approval_status, 'rejected'::public.approval_status)
     and new.decided_at is null then
    new.decided_at := now();
    new.decided_by := coalesce(new.decided_by, (select auth.uid()));
  end if;
  return new;
end;
$$;

comment on function public.tg_approvals_stamp_decision() is
  'Stamps decided_at and decided_by when an approval is approved or rejected. Leaves expired and withdrawn alone: neither is a decision, and recording a decider for them would invent one.';

drop trigger if exists approvals_stamp_decision on public.approvals;
create trigger approvals_stamp_decision
  before insert or update on public.approvals
  for each row execute function public.tg_approvals_stamp_decision();


-- ============================================================================
-- commissions
-- ============================================================================
-- What an agent is owed, and how sure we are of it. The ladder in
-- COMMISSION_STATUSES is the whole design: estimated when the booking is made,
-- eligible only once the business's conditions are met, approved by a person,
-- and only then paid.

create table if not exists public.commissions (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null,
  property_id           uuid not null,
  booking_id            uuid not null,

  -- One of the two is required. An agency keeps the commercial relationship
  -- when the individual leaves, which is why `bookings` denormalises both.
  agent_user_id         uuid references auth.users (id) on delete set null,
  agency_id             uuid,

  status                public.commission_status not null default 'estimated',

  -- What it was computed on and how, kept beside the amount. A commission
  -- nobody can recompute is a commission nobody can defend in an argument.
  basis_agorot          integer not null default 0,
  rate_bps              integer,
  amount_agorot         integer not null default 0,
  currency              text not null default 'ILS',

  eligible_at           timestamptz,
  approved_at           timestamptz,
  approved_by           uuid references auth.users (id) on delete set null,
  paid_at               timestamptz,
  payout_reference      text,
  cancelled_at          timestamptz,
  cancellation_reason   text,

  note                  text,
  metadata              jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  version               integer not null default 1,

  constraint commissions_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,
  constraint commissions_has_a_payee check (
    agent_user_id is not null or agency_id is not null
  ),
  constraint commissions_amounts_nonnegative check (
    basis_agorot >= 0 and amount_agorot >= 0
  ),
  constraint commissions_rate_range check (rate_bps is null or rate_bps between 0 and 10000),
  constraint commissions_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- The ladder, as constraints. Paying on `estimated` means paying for stays
  -- that never happened; this is the sentence from the contract, enforced.
  constraint commissions_eligible_has_moment check (
    status not in ('eligible', 'approved', 'paid') or eligible_at is not null
  ),
  constraint commissions_approved_has_moment check (
    status not in ('approved', 'paid') or (approved_at is not null and approved_by is not null)
  ),
  constraint commissions_paid_has_moment check (
    status <> 'paid' or paid_at is not null
  ),
  constraint commissions_cancelled_has_reason check (
    status <> 'cancelled' or length(btrim(coalesce(cancellation_reason, ''))) > 0
  ),
  constraint commissions_version_positive check (version >= 1)
);

comment on table public.commissions is
  'What an agent is owed, and how sure we are of it. The COMMISSION_STATUSES ladder is enforced by CHECK rather than remembered by a service: `paid` requires an approval, and an approval requires eligibility. Paying on estimated means paying for stays that never happened.';
comment on column public.commissions.basis_agorot is
  'What the commission was computed on. Kept beside the amount because a commission nobody can recompute is a commission nobody can defend in an argument.';

-- One live commission per booking per payee. Cancelled ones are excluded, so a
-- commission written off and replaced is possible.
create unique index if not exists commissions_booking_agent_idx
  on public.commissions (booking_id, agent_user_id)
  where agent_user_id is not null and status <> 'cancelled';
create unique index if not exists commissions_booking_agency_idx
  on public.commissions (booking_id, agency_id)
  where agent_user_id is null and agency_id is not null and status <> 'cancelled';

drop trigger if exists commissions_touch on public.commissions;
create trigger commissions_touch
  before update on public.commissions
  for each row execute function public.tg_touch_row();

create or replace function public.tg_commissions_stamp_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('eligible'::public.commission_status,
                    'approved'::public.commission_status,
                    'paid'::public.commission_status)
     and new.eligible_at is null then
    new.eligible_at := now();
  end if;

  if new.status in ('approved'::public.commission_status, 'paid'::public.commission_status)
     and new.approved_at is null then
    new.approved_at := now();
    new.approved_by := coalesce(new.approved_by, (select auth.uid()));
  end if;

  if new.status = 'paid'::public.commission_status and new.paid_at is null then
    new.paid_at := now();
  end if;

  if new.status = 'cancelled'::public.commission_status and new.cancelled_at is null then
    new.cancelled_at := now();
  end if;

  return new;
end;
$$;

comment on function public.tg_commissions_stamp_status() is
  'Stamps the ladder moments from the status. It fills a missing moment rather than inventing an approver: approved_by falls back to the caller, and a status set with no authenticated caller and no approver named still fails the CHECK, which is the correct outcome.';

drop trigger if exists commissions_stamp_status on public.commissions;
create trigger commissions_stamp_status
  before insert or update on public.commissions
  for each row execute function public.tg_commissions_stamp_status();


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.tasks               enable row level security;
alter table public.tasks               force  row level security;
alter table public.task_assignments    enable row level security;
alter table public.task_assignments    force  row level security;
alter table public.task_checklists     enable row level security;
alter table public.task_checklists     force  row level security;
alter table public.inventory_items     enable row level security;
alter table public.inventory_items     force  row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_movements force  row level security;
alter table public.approvals           enable row level security;
alter table public.approvals           force  row level security;
alter table public.commissions         enable row level security;
alter table public.commissions         force  row level security;

revoke all on public.tasks               from anon, authenticated;
revoke all on public.task_assignments    from anon, authenticated;
revoke all on public.task_checklists     from anon, authenticated;
revoke all on public.inventory_items     from anon, authenticated;
revoke all on public.inventory_movements from anon, authenticated;
revoke all on public.approvals           from anon, authenticated;
revoke all on public.commissions         from anon, authenticated;

-- Tasks are cancelled, not deleted: `cancelled` is in TASK_STATUSES and the
-- history of what was asked for is the point. Same for approvals — `withdrawn`
-- is the exit — and for commissions, which are money.
grant select, insert, update         on public.tasks               to authenticated;
grant select, insert, update, delete on public.task_assignments    to authenticated;
grant select, insert, update, delete on public.task_checklists     to authenticated;
grant select, insert, update, delete on public.inventory_items     to authenticated;
grant select, insert                 on public.inventory_movements to authenticated;
grant select, insert, update         on public.approvals           to authenticated;
grant select, insert, update         on public.commissions         to authenticated;

grant select, insert, update         on public.tasks               to service_role;
grant select, insert, update, delete on public.task_assignments    to service_role;
grant select, insert, update, delete on public.task_checklists     to service_role;
grant select, insert, update, delete on public.inventory_items     to service_role;
grant select, insert                 on public.inventory_movements to service_role;
grant select, insert, update         on public.approvals           to service_role;
grant select, insert, update         on public.commissions         to service_role;

-- Supabase default privileges hand service_role everything on a new table, and
-- service_role carries BYPASSRLS. Taking these back is what makes the ledger
-- and the append-only rules true for a background job as well.
revoke delete, truncate         on public.tasks               from service_role;
revoke update, delete, truncate on public.inventory_movements from service_role;
revoke delete, truncate         on public.approvals           from service_role;
revoke delete, truncate         on public.commissions         from service_role;


-- ── Policies · tasks ────────────────────────────────────────────────────────
-- Tenant, then property scope, then grant. `task.view` is what a cleaner
-- holds; it gets them the board for the properties they are scoped to and
-- nothing else.

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.view')
  );

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'task.create')
  );

-- Four grants, because four different people move a task and the catalogue
-- already separates them: editing it, assigning it, finishing it, signing it
-- off. A cleaner holds task.complete and not task.update, and must still be
-- able to say the room is done.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'task.update')
      or public.has_permission(organization_id, 'task.assign')
      or public.has_permission(organization_id, 'task.complete')
      or public.has_permission(organization_id, 'task.verify')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (
      public.has_permission(organization_id, 'task.update')
      or public.has_permission(organization_id, 'task.assign')
      or public.has_permission(organization_id, 'task.complete')
      or public.has_permission(organization_id, 'task.verify')
    )
  );


-- ── Policies · task_assignments ─────────────────────────────────────────────
-- No property_id of its own; the task carries it. The scope term is an EXISTS
-- against the parent, so there is one definition of which properties a member
-- reaches rather than two that can drift.

drop policy if exists task_assignments_select on public.task_assignments;
create policy task_assignments_select on public.task_assignments
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'task.view')
    and exists (
      select 1 from public.tasks t
      where t.id = task_assignments.task_id
        and t.organization_id = task_assignments.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  );

drop policy if exists task_assignments_insert on public.task_assignments;
create policy task_assignments_insert on public.task_assignments
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'task.assign')
    and exists (
      select 1 from public.tasks t
      where t.id = task_assignments.task_id
        and t.organization_id = task_assignments.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  );

-- The assignee accepting or declining is an UPDATE of their own row, and they
-- do not hold task.assign. Naming that case is the difference between a board
-- that reflects the day and one that only a coordinator can touch.
drop policy if exists task_assignments_update on public.task_assignments;
create policy task_assignments_update on public.task_assignments
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      user_id = (select auth.uid())
      or public.has_permission(organization_id, 'task.assign')
    )
    and exists (
      select 1 from public.tasks t
      where t.id = task_assignments.task_id
        and t.organization_id = task_assignments.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (
      user_id = (select auth.uid())
      or public.has_permission(organization_id, 'task.assign')
    )
  );

drop policy if exists task_assignments_delete on public.task_assignments;
create policy task_assignments_delete on public.task_assignments
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'task.assign')
    and exists (
      select 1 from public.tasks t
      where t.id = task_assignments.task_id
        and t.organization_id = task_assignments.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  );


-- ── Policies · task_checklists ──────────────────────────────────────────────
-- Composing the list is `checklist.manage`; ticking an item is `task.complete`,
-- because the person doing the work is not the person who wrote the standard.

drop policy if exists task_checklists_select on public.task_checklists;
create policy task_checklists_select on public.task_checklists
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'task.view')
    and exists (
      select 1 from public.tasks t
      where t.id = task_checklists.task_id
        and t.organization_id = task_checklists.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  );

drop policy if exists task_checklists_insert on public.task_checklists;
create policy task_checklists_insert on public.task_checklists
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'checklist.manage')
      or public.has_permission(organization_id, 'task.update')
    )
    and exists (
      select 1 from public.tasks t
      where t.id = task_checklists.task_id
        and t.organization_id = task_checklists.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  );

drop policy if exists task_checklists_update on public.task_checklists;
create policy task_checklists_update on public.task_checklists
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'checklist.manage')
      or public.has_permission(organization_id, 'task.complete')
    )
    and exists (
      select 1 from public.tasks t
      where t.id = task_checklists.task_id
        and t.organization_id = task_checklists.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'checklist.manage')
      or public.has_permission(organization_id, 'task.complete')
    )
  );

drop policy if exists task_checklists_delete on public.task_checklists;
create policy task_checklists_delete on public.task_checklists
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'checklist.manage')
    and exists (
      select 1 from public.tasks t
      where t.id = task_checklists.task_id
        and t.organization_id = task_checklists.organization_id
        and public.property_in_scope(t.property_id, t.organization_id)
    )
  );


-- ── Policies · inventory_items and inventory_movements ──────────────────────

drop policy if exists inventory_items_select on public.inventory_items;
create policy inventory_items_select on public.inventory_items
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_items_insert on public.inventory_items;
create policy inventory_items_insert on public.inventory_items
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.edit')
  );

drop policy if exists inventory_items_update on public.inventory_items;
create policy inventory_items_update on public.inventory_items
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.edit')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.edit')
  );

drop policy if exists inventory_items_delete on public.inventory_items;
create policy inventory_items_delete on public.inventory_items
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.edit')
  );

-- No UPDATE and no DELETE policy, because there is no grant for either. The
-- ledger is append-only twice over: privileges, and the statement trigger.
drop policy if exists inventory_movements_select on public.inventory_movements;
create policy inventory_movements_select on public.inventory_movements
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_movements_insert on public.inventory_movements;
create policy inventory_movements_insert on public.inventory_movements
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'inventory.edit')
  );


-- ── Policies · approvals ────────────────────────────────────────────────────
-- The property term is `property_id IS NULL OR in_scope(...)`, and that is a
-- deliberate widening, not an oversight: an approval with no property is
-- organization-level governance, and it is gated by the approval grants alone.
-- A member scoped to one villa who holds approval.request can therefore see
-- organization-level requests. That is the trade for being able to raise one.

drop policy if exists approvals_select on public.approvals;
create policy approvals_select on public.approvals
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      property_id is null
      or public.property_in_scope(property_id, organization_id)
    )
    and (
      public.has_permission(organization_id, 'approval.decide')
      or (
        public.has_permission(organization_id, 'approval.request')
        and requested_by = (select auth.uid())
      )
    )
  );

drop policy if exists approvals_insert on public.approvals;
create policy approvals_insert on public.approvals
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (
      property_id is null
      or public.property_in_scope(property_id, organization_id)
    )
    and public.has_permission(organization_id, 'approval.request')
    -- A request is raised in your own name. Raising one as somebody else would
    -- put their name on an exception they never asked for.
    and requested_by = (select auth.uid())
  );

-- Deciding is `approval.decide`; withdrawing your own request is not a
-- decision and needs only the right to have made it.
drop policy if exists approvals_update on public.approvals;
create policy approvals_update on public.approvals
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      property_id is null
      or public.property_in_scope(property_id, organization_id)
    )
    and (
      public.has_permission(organization_id, 'approval.decide')
      or requested_by = (select auth.uid())
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'approval.decide')
      or requested_by = (select auth.uid())
    )
  );


-- ── Policies · commissions ──────────────────────────────────────────────────
-- Gated on `finance.view` here, and tightened to `commission.view`,
-- `commission.approve` and `commission.payout` by 0012 section 9 — the
-- migration that seeds those three codes into the catalogue.
--
-- The order is forced rather than chosen. `has_permission()` compares a plain
-- string, so a policy may name any code it likes; but a code no role can hold
-- denies everybody, which would make `commissions` unreadable between this
-- migration and the next. `finance.view` is the widest gate that works today
-- and the narrowest that does not lock the table.

drop policy if exists commissions_select on public.commissions;
create policy commissions_select on public.commissions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'finance.view')
  );

drop policy if exists commissions_insert on public.commissions;
create policy commissions_insert on public.commissions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'finance.view')
  );

drop policy if exists commissions_update on public.commissions;
create policy commissions_update on public.commissions
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'finance.view')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'finance.view')
  );


-- ============================================================================
-- Indexes
-- ============================================================================

create index if not exists tasks_organization_idx
  on public.tasks (organization_id) where deleted_at is null;
create index if not exists tasks_property_status_idx
  on public.tasks (property_id, status) where deleted_at is null;
create index if not exists tasks_unit_idx
  on public.tasks (unit_id) where unit_id is not null;
create index if not exists tasks_booking_idx
  on public.tasks (booking_id) where booking_id is not null;
create index if not exists tasks_team_idx
  on public.tasks (team_id) where team_id is not null;
-- "My work today", which is the single most-run query in the product.
create index if not exists tasks_assignee_due_idx
  on public.tasks (assigned_to_user_id, due_at)
  where assigned_to_user_id is not null and deleted_at is null;
-- The overdue sweep.
create index if not exists tasks_open_due_idx
  on public.tasks (organization_id, due_at)
  where deleted_at is null
    and status not in ('completed', 'verified', 'cancelled');

create index if not exists task_assignments_organization_idx
  on public.task_assignments (organization_id);
create index if not exists task_assignments_task_idx
  on public.task_assignments (task_id);
create index if not exists task_assignments_user_idx
  on public.task_assignments (user_id) where unassigned_at is null;
create index if not exists task_assignments_assigned_by_idx
  on public.task_assignments (assigned_by) where assigned_by is not null;

create index if not exists task_checklists_organization_idx
  on public.task_checklists (organization_id);
create index if not exists task_checklists_task_idx
  on public.task_checklists (task_id, position);

create index if not exists inventory_items_organization_idx
  on public.inventory_items (organization_id) where deleted_at is null;
create index if not exists inventory_items_property_idx
  on public.inventory_items (property_id) where deleted_at is null;
create index if not exists inventory_items_unit_idx
  on public.inventory_items (unit_id) where unit_id is not null;
create index if not exists inventory_items_state_idx
  on public.inventory_items (organization_id, state) where deleted_at is null;
-- The shortage query, which is what makes `min_quantity` worth storing.
create index if not exists inventory_items_below_minimum_idx
  on public.inventory_items (property_id)
  where deleted_at is null and min_quantity is not null and quantity < min_quantity;

create index if not exists inventory_movements_organization_idx
  on public.inventory_movements (organization_id);
create index if not exists inventory_movements_property_idx
  on public.inventory_movements (property_id);
create index if not exists inventory_movements_item_idx
  on public.inventory_movements (item_id, occurred_at desc);
create index if not exists inventory_movements_task_idx
  on public.inventory_movements (task_id) where task_id is not null;
create index if not exists inventory_movements_booking_idx
  on public.inventory_movements (booking_id) where booking_id is not null;

create index if not exists approvals_organization_idx
  on public.approvals (organization_id);
create index if not exists approvals_property_idx
  on public.approvals (property_id) where property_id is not null;
create index if not exists approvals_booking_idx
  on public.approvals (booking_id) where booking_id is not null;
create index if not exists approvals_task_idx
  on public.approvals (task_id) where task_id is not null;
create index if not exists approvals_requested_by_idx
  on public.approvals (requested_by);
create index if not exists approvals_decided_by_idx
  on public.approvals (decided_by) where decided_by is not null;
-- The queue a decider opens, and the sweep that expires what nobody answered.
create index if not exists approvals_open_idx
  on public.approvals (organization_id, requested_at) where status = 'requested';
create index if not exists approvals_expiry_idx
  on public.approvals (expires_at) where status = 'requested' and expires_at is not null;

create index if not exists commissions_organization_idx
  on public.commissions (organization_id);
create index if not exists commissions_property_idx
  on public.commissions (property_id);
create index if not exists commissions_booking_idx
  on public.commissions (booking_id);
create index if not exists commissions_agent_idx
  on public.commissions (organization_id, agent_user_id) where agent_user_id is not null;
create index if not exists commissions_agency_idx
  on public.commissions (organization_id, agency_id) where agency_id is not null;
create index if not exists commissions_approved_by_idx
  on public.commissions (approved_by) where approved_by is not null;
-- The payout run: what is owed and cleared to pay.
create index if not exists commissions_payable_idx
  on public.commissions (organization_id, status) where status in ('eligible', 'approved');
