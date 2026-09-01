-- ============================================================================
-- 0030_inventory_forecast.sql — ESTIA · stock stops being a single number and
--                               becomes a timeline
--
-- What this closes
--   0011 gave the product `inventory_items` and `inventory_movements`, and they
--   are good tables: the quantity is derived from an append-only ledger, and
--   `quantity_reserved` is already the column that stops two events being
--   promised the same twenty mattresses. What they cannot answer is the
--   question the business actually asks, which is about *next Saturday*.
--
--     Fifty bath towels. Villa A needs twenty-five on Friday, Villa B needs
--     thirty on Saturday, and Friday's do not come back clean before Saturday.
--
--   Every "total stock minus total requirement" answer says 50 ≥ 30 and
--   reports nothing. The true answer is a shortage of five on Saturday, and it
--   is only reachable by walking the days in order: items come back — from
--   guest use, from the laundry, from another property — *between* bookings.
--
--   Four things were missing for that walk, and this file adds them.
--
--     1. Two states. `returning` and `lost` are in the frozen contract and are
--        not in the enum. A forecast has to distinguish "still in the machine"
--        from "in the van, here by Friday afternoon", and "gone" from
--        "broken" — one is investigated, the other is written off.
--     2. Per-organization settings, because `off` is a first-class answer.
--        A single villa owner runs the whole product with no stock module at
--        all, and the settings row is where that is said once rather than
--        inferred from an empty table.
--     3. Reservations against a *booking*, with dates. `quantity_reserved` is
--        a total; a timeline needs to know which day each promise falls on.
--     4. Discrepancies and cross-property transfers — the two things an
--        `advanced` operation does that a `tracked` one does not.
--
-- Adding an enum value and using it in the same transaction
--   `alter type ... add value` is permitted inside a transaction block on
--   PostgreSQL 12 and later, but the *new value cannot be used* until that
--   transaction commits: a cast, a default, a comparison or a check constraint
--   naming `'returning'` raises 55P02 `unsafe_use_of_new_value_of_enum_type`.
--
--   So §1 stands alone and ends with an explicit `commit;`. A runner that
--   wrapped this file in a transaction has that wrapper closed there; a runner
--   that did not gets a harmless "no transaction in progress" warning. Either
--   way §2 onward begins after the new labels are durable, which is the
--   property that matters.
--
--   §2 onward is therefore statement-at-a-time rather than one unit. Every
--   statement below is idempotent — `if not exists`, `create or replace`,
--   `drop policy if exists` — so a failure part way through is repaired by
--   running the file again, which is the same promise 0001–0029 make.
--
--   Nothing in §2 needs `'returning'` or `'lost'` as a literal in any case.
--   The rehearsal in §9 proves they exist by reading `pg_enum`, which is a
--   catalogue read and not a use of the value.
--
-- Depends on
--   0001 (organizations, tg_touch_row, tg_touch_updated_at), 0004
--   (my_organizations, has_permission, and the shape every policy here
--   copies), 0008 (properties), 0009 (bookings), 0011 (inventory_state,
--   inventory_items, inventory_movements, tasks,
--   allocatable_inventory_states), 0012 (the permission catalogue that already
--   contains inventory.view / edit / adjust / import / transfer), 0014 (a
--   function in `public` is an API surface until its grants say otherwise),
--   0023 (leading-column index discipline).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The two states the contract already has and the enum does not
-- ============================================================================
-- Positioned, not appended. `src/lib/contracts/states.ts` declares
-- INVENTORY_STATES in one order and says "the database enums use these exact
-- strings, in this exact order" — so `returning` goes before `damaged` and
-- `lost` after `out_of_service`. Order is not cosmetic: an enum sorts by it,
-- and a screen that lists states by their natural order would otherwise show
-- the cycle out of sequence.

alter type public.inventory_state add value if not exists 'returning' before 'damaged';
alter type public.inventory_state add value if not exists 'lost' after 'out_of_service';

comment on type public.inventory_state is
  'Transcribed from INVENTORY_STATES in src/lib/contracts/states.ts, in the same order. `reserved` stops two events being promised the same twenty mattresses. `returning` is washed and on its way back but not yet on the shelf — a forecast has to know whether these will be here by Friday afternoon, and "between the van and the cupboard" is a different answer from "still in the machine". `lost` is not `damaged`: one is investigated, the other is repaired or written off.';

-- Everything above must be durable before anything below may name the new
-- labels. See the header.
commit;


-- ============================================================================
-- 2 · The vocabularies this file adds
-- ============================================================================
-- Fresh types rather than values on existing ones, so none of them is subject
-- to the restriction §1 works around.

set search_path = public, extensions;

-- INVENTORY_MODES, in order. `off` is first because it is the default and
-- because it is a real answer rather than an unfinished configuration.
do $$ begin
  create type public.inventory_mode as enum (
    'off',
    'basic',
    'tracked',
    'advanced'
  );
exception when duplicate_object then null;
end $$;

comment on type public.inventory_mode is
  'Transcribed from INVENTORY_MODES in src/lib/contracts/states.ts. How much stock arithmetic a business has asked for. `off` is the default and a first-class answer: preparation, the cleaner''s plan, the laundry list, bookings and finance all work without a single counted item — what is skipped is validation against stock and the forward forecast, not the operation.';

-- The life of one promise of stock to one booking.
do $$ begin
  create type public.inventory_reservation_status as enum (
    'reserved',
    -- The booking was cancelled or the dates moved. The stock comes back
    -- untouched; this is `reserved -> available` in LINEN_TRANSITIONS.
    'released',
    -- The linen actually left the cupboard. The reservation stops holding
    -- `quantity_reserved` because a movement now holds the quantity itself.
    'consumed',
    -- The stay ended and the promise expired without anybody closing it. Kept
    -- apart from `consumed` because one is an operation and the other is a
    -- gap in one, and a report that merges them cannot show the gap.
    'expired'
  );
exception when duplicate_object then null;
end $$;

-- What was decided about a difference between expected and collected.
do $$ begin
  create type public.inventory_discrepancy_resolution as enum (
    'unresolved',
    'found',
    'damaged',
    'guest_loss',
    'correction',
    'investigating',
    'written_off'
  );
exception when duplicate_object then null;
end $$;

comment on type public.inventory_discrepancy_resolution is
  'Why the count came back different. `correction` is the honest common case — somebody miscounted — and it is deliberately not the default, because defaulting to "we were wrong" is how guest loss stops being visible. `unresolved` is the default and is a queue, not a verdict.';

-- Moving stock between properties is a request before it is a movement.
do $$ begin
  create type public.inventory_transfer_status as enum (
    -- Produced by the forecast. Nobody has asked for it.
    'suggested',
    'requested',
    'approved',
    'rejected',
    'in_transit',
    'completed',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.inventory_transfer_status is
  'A transfer is suggested by the forecast, requested by a person and approved by somebody who is entitled to take stock away from the property that holds it. `suggested` exists so the engine can write down what it would do without doing it: taking another property''s working stock without asking solves one shortage by creating another.';


-- ============================================================================
-- 3 · inventory_settings
-- ============================================================================
-- One row per organization, and the row may be absent — the application reads
-- a missing row as the `off` default rather than as an error, because a
-- business that never opened the stock module has nothing to configure and
-- must not be told its deployment is broken.
--
-- The columns are the questions the forecast asks and cannot answer alone.

create table if not exists public.inventory_settings (
  organization_id            uuid primary key
    references public.organizations (id) on delete cascade,

  mode                       public.inventory_mode not null default 'off',

  -- The floor kept for the booking that has not been taken yet. Absolute
  -- units and a percentage of the par level, because both are things a real
  -- operator says: "always keep ten spare sheets" and "always keep twenty
  -- percent". The engine takes the larger of the two — see
  -- `safetyBufferFor` in src/lib/inventory/settings.ts — so setting one and
  -- leaving the other at zero behaves exactly as the operator expects.
  safety_buffer_units        integer not null default 0,
  safety_buffer_percent      integer not null default 0,

  -- How far ahead a projected shortage is worth telling somebody about. Beyond
  -- it the arithmetic is still computed and shown on the forecast screen; what
  -- changes is whether it raises `inventory.projected_shortage`. A horizon of
  -- ninety days would make the alert list a permanent wall of noise, which is
  -- how an alert stops being read.
  shortage_warning_horizon_days integer not null default 7,

  -- The forecast horizon the screens offer as their widest window.
  forecast_horizon_days      integer not null default 30,

  -- Days from "a guest used it" to "it is clean and on the shelf again". The
  -- single most load-bearing number in this file: it is what makes Friday's
  -- towels unavailable on Saturday. Null means the business has not said, and
  -- the engine then schedules no return at all rather than guessing one —
  -- guessing short is how a forecast promises towels that are still wet.
  linen_turnaround_days      integer,

  -- May one property's surplus answer another's shortage without a transfer?
  -- False for most: two villas an hour apart do not share a cupboard.
  shared_stock               boolean not null default false,
  -- Whether a booking may hold stock at all. Off in `basic`, where counting is
  -- all the business asked for.
  reservations_enabled       boolean not null default false,
  -- A central store that is not a property. Drawn on before another property's
  -- working stock.
  warehouse_enabled          boolean not null default false,
  -- Expected-versus-collected after checkout. `advanced` only.
  discrepancy_tracking       boolean not null default false,
  -- Cross-property transfers. `advanced` only.
  transfers_enabled          boolean not null default false,

  metadata                   jsonb not null default '{}'::jsonb,

  created_at                 timestamptz not null default now(),
  created_by                 uuid references auth.users (id) on delete set null,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references auth.users (id) on delete set null,
  version                    integer not null default 1,

  constraint inventory_settings_buffer_nonnegative check (
    safety_buffer_units >= 0
    and safety_buffer_percent between 0 and 100
  ),
  -- A horizon of zero would mean "warn about nothing", which is `mode = off`
  -- said in a second place. One day is the smallest honest answer.
  constraint inventory_settings_horizons_sane check (
    shortage_warning_horizon_days between 1 and 365
    and forecast_horizon_days between 1 and 365
    and shortage_warning_horizon_days <= forecast_horizon_days
  ),
  constraint inventory_settings_turnaround_sane check (
    linen_turnaround_days is null
    or linen_turnaround_days between 0 and 60
  ),
  constraint inventory_settings_version_positive check (version >= 1)
);

comment on table public.inventory_settings is
  'How much stock arithmetic one organization has asked for, and the numbers the forecast cannot invent. A missing row means `off`, which is the default and a legitimate answer — the application reads the absence rather than requiring a row to exist before a villa owner can take a booking.';
comment on column public.inventory_settings.linen_turnaround_days is
  'Days from "a guest used it" to "clean and back on the shelf". This is the number that makes Friday''s towels unavailable on Saturday, and it is nullable on purpose: a business that has not said gets no projected return at all, because guessing short is how a forecast promises towels that are still in the machine.';
comment on column public.inventory_settings.shared_stock is
  'Whether one property''s surplus counts toward another''s requirement without a transfer. False for most operations: two villas an hour apart do not share a cupboard, and a forecast that pretends otherwise reports no shortage on the morning of one.';

drop trigger if exists inventory_settings_touch on public.inventory_settings;
create trigger inventory_settings_touch
  before update on public.inventory_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · inventory_reservations
-- ============================================================================
-- `inventory_items.quantity_reserved` is a total. This is the detail behind
-- it: which booking, which item, and — the part the forecast lives on — which
-- days.
--
-- The two must not drift, so nothing writes `quantity_reserved` directly. §5
-- is the only path, it moves the column and inserts the row in one statement,
-- and the CHECK from 0011 is what refuses the oversell.

create table if not exists public.inventory_reservations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  property_id        uuid not null,
  item_id            uuid not null,
  -- Nullable: an owner blocking linen for a private stay, or an event that is
  -- not a booking, is a real reservation with nothing to point at.
  booking_id         uuid,

  quantity           integer not null,
  status             public.inventory_reservation_status not null default 'reserved',

  -- The window the stock is spoken for. `needed_from` is the day it has to be
  -- clean and present; `needed_to` is the day it stops being promised. Dates
  -- rather than timestamps, because a changeover is a day in the property's
  -- own calendar and an hour would imply a precision nobody records.
  needed_from        date not null,
  needed_to          date not null,

  note               text,
  released_reason    text,

  metadata           jsonb not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  version            integer not null default 1,

  constraint inventory_reservations_item_fkey
    foreign key (item_id, organization_id, property_id)
    references public.inventory_items (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_reservations_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint inventory_reservations_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id)
    on delete set null (booking_id),

  constraint inventory_reservations_quantity_positive check (quantity > 0),
  constraint inventory_reservations_window_ordered check (needed_to >= needed_from),
  constraint inventory_reservations_released_reason check (
    status <> 'released' or released_reason is not null
  ),
  constraint inventory_reservations_version_positive check (version >= 1)
);

comment on table public.inventory_reservations is
  'Which booking has been promised which stock, and on which days. `inventory_items.quantity_reserved` is the total of the live rows here; the dates are what the forecast walks. A total alone cannot answer "is there enough on Saturday" — it says fifty towels and twenty-five promised, and the thirty needed on Saturday still fail.';

-- One live reservation per booking and item. A second click on "reserve" is
-- the ordinary case, not the exotic one, and without this it silently doubles
-- the promise.
create unique index if not exists inventory_reservations_booking_item_idx
  on public.inventory_reservations (organization_id, booking_id, item_id)
  where booking_id is not null and status = 'reserved';

create index if not exists inventory_reservations_organization_idx
  on public.inventory_reservations (organization_id, needed_from)
  where status = 'reserved';
create index if not exists inventory_reservations_property_idx
  on public.inventory_reservations (property_id, needed_from)
  where status = 'reserved';
create index if not exists inventory_reservations_item_idx
  on public.inventory_reservations (item_id, needed_from);
create index if not exists inventory_reservations_booking_idx
  on public.inventory_reservations (booking_id)
  where booking_id is not null;

drop trigger if exists inventory_reservations_touch on public.inventory_reservations;
create trigger inventory_reservations_touch
  before update on public.inventory_reservations
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · Reserving, and why two people cannot reserve the same towels
-- ============================================================================
-- The whole of the concurrency answer is in three lines of this function, and
-- it is worth being precise about which three, because the obvious ones are
-- not the load-bearing ones.
--
--   `select ... for update` takes the row lock. Two concurrent callers
--   serialise here rather than both reading `quantity_reserved = 40`.
--
--   `set quantity_reserved = quantity_reserved + p_quantity` is *relative*.
--   Under READ COMMITTED the second transaction re-reads the row the first
--   one committed and adds to the new value, so nothing is lost even if the
--   lock were somehow released early.
--
--   `inventory_items_reserved_within_quantity`, from 0011, is the backstop and
--   the actual guarantee: `quantity_reserved <= quantity`, enforced by the
--   database on every path including `service_role` and `postgres`. An
--   oversell is refused by a CHECK, not by a branch somebody could forget to
--   write — the same discipline `unit_occupancy_no_overlap` applies to double
--   bookings.
--
-- The explicit pre-check exists only to produce a sentence a person can read.
-- Remove it and the operation is still correct; it simply fails with 23514 and
-- a constraint name instead of "there are eighteen free and you asked for
-- twenty-five".
--
-- SECURITY DEFINER with an empty search_path, and it re-asks `has_permission`
-- itself rather than trusting the caller — a definer function that skipped the
-- grant check would be a hole around every policy in §8.

create or replace function public.reserve_inventory(
  p_item_id      uuid,
  p_quantity     integer,
  p_needed_from  date,
  p_needed_to    date,
  p_booking_id   uuid default null,
  p_note         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item      public.inventory_items%rowtype;
  v_free      integer;
  v_id        uuid;
  v_existing  public.inventory_reservations%rowtype;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'reservation_quantity_invalid'
      using hint = 'הכמות לשריון חייבת להיות גדולה מאפס.', errcode = '22023';
  end if;

  if p_needed_from is null or p_needed_to is null or p_needed_to < p_needed_from then
    raise exception 'reservation_window_invalid'
      using hint = 'טווח התאריכים לשריון אינו תקין.', errcode = '22023';
  end if;

  -- The lock. Everything after this line is serialised per item.
  select * into v_item
  from public.inventory_items
  where id = p_item_id and deleted_at is null
  for update;

  if not found then
    raise exception 'inventory_item_not_found'
      using hint = 'הפריט לא נמצא.', errcode = 'P0002';
  end if;

  if not public.has_permission(v_item.organization_id, 'inventory.adjust') then
    raise exception 'not_permitted'
      using hint = 'אין לך הרשאה לשריין מלאי.', errcode = '42501';
  end if;

  -- Reserving the same booking's item twice is one reservation, raised or
  -- lowered. Without this the partial unique index refuses the second call
  -- with 23505 and the caller cannot tell "already reserved" from "somebody
  -- else got there".
  if p_booking_id is not null then
    select * into v_existing
    from public.inventory_reservations
    where organization_id = v_item.organization_id
      and booking_id = p_booking_id
      and item_id = p_item_id
      and status = 'reserved'
    for update;
  end if;

  v_free := v_item.quantity - v_item.quantity_reserved
            + coalesce(v_existing.quantity, 0);

  if v_free < p_quantity then
    raise exception 'inventory_insufficient'
      using hint = format(
              'זמינים %s בלבד, ונדרשו %s. חלק מהמלאי כבר משוריין להזמנה אחרת.',
              v_free, p_quantity),
            errcode = '23514';
  end if;

  if v_existing.id is not null then
    update public.inventory_items
       set quantity_reserved = quantity_reserved - v_existing.quantity + p_quantity
     where id = p_item_id;

    update public.inventory_reservations
       set quantity    = p_quantity,
           needed_from = p_needed_from,
           needed_to   = p_needed_to,
           note        = coalesce(p_note, note),
           updated_by  = (select auth.uid())
     where id = v_existing.id;

    v_id := v_existing.id;
  else
    -- Relative, never absolute. See the header of this section.
    update public.inventory_items
       set quantity_reserved = quantity_reserved + p_quantity
     where id = p_item_id;

    insert into public.inventory_reservations (
      organization_id, property_id, item_id, booking_id,
      quantity, needed_from, needed_to, note, created_by, updated_by
    ) values (
      v_item.organization_id, v_item.property_id, p_item_id, p_booking_id,
      p_quantity, p_needed_from, p_needed_to, p_note,
      (select auth.uid()), (select auth.uid())
    )
    returning id into v_id;
  end if;

  return jsonb_build_object(
    'reservationId', v_id,
    'itemId', p_item_id,
    'organizationId', v_item.organization_id,
    'propertyId', v_item.property_id,
    'quantity', p_quantity,
    'freeAfter', v_free - p_quantity
  );
end;
$$;

comment on function public.reserve_inventory(uuid, integer, date, date, uuid, text) is
  'The only path that moves inventory_items.quantity_reserved. Locks the item row, adds relatively rather than absolutely, and leans on inventory_items_reserved_within_quantity from 0011 as the actual guarantee — an oversell is refused by a CHECK on every path including service_role, not by a branch somebody could forget to write. Re-asks has_permission itself because a SECURITY DEFINER function that trusted its caller would be a hole around every policy in this file.';

revoke all on function public.reserve_inventory(uuid, integer, date, date, uuid, text) from public, anon;
grant execute on function public.reserve_inventory(uuid, integer, date, date, uuid, text) to authenticated, service_role;


-- Releasing is the same discipline in reverse, and it is a function for the
-- same reason: `quantity_reserved = quantity_reserved - n` cannot be expressed
-- through PostgREST, and a read-modify-write from the application would lose
-- one of two concurrent releases.
create or replace function public.release_inventory_reservation(
  p_reservation_id uuid,
  p_reason         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.inventory_reservations%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'release_reason_required'
      using hint = 'יש לציין סיבה לשחרור השריון.', errcode = '22023';
  end if;

  select * into v_row
  from public.inventory_reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found'
      using hint = 'השריון לא נמצא.', errcode = 'P0002';
  end if;

  if not public.has_permission(v_row.organization_id, 'inventory.adjust') then
    raise exception 'not_permitted'
      using hint = 'אין לך הרשאה לשחרר שריון מלאי.', errcode = '42501';
  end if;

  -- Idempotent. A second click releases nothing twice, which is what stops
  -- `quantity_reserved` drifting below the sum of the live rows.
  if v_row.status <> 'reserved' then
    return jsonb_build_object(
      'reservationId', v_row.id, 'released', false, 'status', v_row.status
    );
  end if;

  update public.inventory_items
     set quantity_reserved = greatest(0, quantity_reserved - v_row.quantity)
   where id = v_row.item_id;

  update public.inventory_reservations
     set status          = 'released',
         released_reason = p_reason,
         updated_by      = (select auth.uid())
   where id = v_row.id;

  return jsonb_build_object(
    'reservationId', v_row.id, 'released', true, 'status', 'released'
  );
end;
$$;

comment on function public.release_inventory_reservation(uuid, text) is
  'Gives promised stock back. Idempotent by status, because a second click must not lower quantity_reserved twice — that drift is invisible until a forecast reports stock that no cupboard contains.';

revoke all on function public.release_inventory_reservation(uuid, text) from public, anon;
grant execute on function public.release_inventory_reservation(uuid, text) to authenticated, service_role;


-- ============================================================================
-- 6 · inventory_discrepancies
-- ============================================================================
-- Expected twelve towels back and collected nine. That difference is a fact
-- long before anybody knows what it means, and the product's job is to name it
-- and keep it nameable — not to decide silently that somebody miscounted.

create table if not exists public.inventory_discrepancies (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  property_id        uuid not null,
  item_id            uuid not null,
  booking_id         uuid,
  task_id            uuid,

  expected_quantity  integer not null,
  collected_quantity integer not null,
  -- Generated, so it cannot disagree with the two numbers it comes from.
  -- Negative is the ordinary case: less came back than went out.
  difference         integer generated always as (collected_quantity - expected_quantity) stored,

  resolution         public.inventory_discrepancy_resolution not null default 'unresolved',
  resolution_note    text,
  -- The compensating movement that closed it, when the resolution wrote one.
  movement_id        uuid references public.inventory_movements (id) on delete set null,

  detected_at        timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid references auth.users (id) on delete set null,

  metadata           jsonb not null default '{}'::jsonb,

  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  version            integer not null default 1,

  constraint inventory_discrepancies_item_fkey
    foreign key (item_id, organization_id, property_id)
    references public.inventory_items (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_discrepancies_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id)
    on delete set null (booking_id),
  constraint inventory_discrepancies_task_fkey
    foreign key (task_id, organization_id)
    references public.tasks (id, organization_id) on delete set null (task_id),

  constraint inventory_discrepancies_counts_nonnegative check (
    expected_quantity >= 0 and collected_quantity >= 0
  ),
  -- A discrepancy of zero is not a discrepancy. Recording one would put a
  -- permanent row of nothing on a screen whose whole job is to be short.
  constraint inventory_discrepancies_difference_nonzero check (
    collected_quantity <> expected_quantity
  ),
  -- A resolution without a note is a verdict nobody can audit. `unresolved`
  -- is exempt because it is the absence of one.
  constraint inventory_discrepancies_resolution_note check (
    resolution = 'unresolved'
    or (resolution_note is not null and length(btrim(resolution_note)) > 0)
  ),
  constraint inventory_discrepancies_resolved_pair check (
    (resolution = 'unresolved' and resolved_at is null)
    or (resolution <> 'unresolved' and resolved_at is not null)
  ),
  constraint inventory_discrepancies_version_positive check (version >= 1)
);

comment on table public.inventory_discrepancies is
  'Expected versus collected, after a checkout. The difference is generated from the two counts so it cannot disagree with them, and the resolution defaults to `unresolved` rather than to `correction`: defaulting to "we miscounted" is how guest loss stops being visible.';

create index if not exists inventory_discrepancies_organization_idx
  on public.inventory_discrepancies (organization_id, detected_at desc);
create index if not exists inventory_discrepancies_property_idx
  on public.inventory_discrepancies (property_id, detected_at desc);
create index if not exists inventory_discrepancies_item_idx
  on public.inventory_discrepancies (item_id, detected_at desc);
create index if not exists inventory_discrepancies_open_idx
  on public.inventory_discrepancies (organization_id, detected_at desc)
  where resolution = 'unresolved';
create index if not exists inventory_discrepancies_booking_idx
  on public.inventory_discrepancies (booking_id) where booking_id is not null;

drop trigger if exists inventory_discrepancies_touch on public.inventory_discrepancies;
create trigger inventory_discrepancies_touch
  before update on public.inventory_discrepancies
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · inventory_transfers
-- ============================================================================
-- Stock moving from one property to another. A row exists from the moment the
-- forecast *suggests* one, which is the point: solving a shortage at Villa B
-- by quietly emptying Villa A's cupboard is not a solution, and the only way
-- to keep it from happening is for the suggestion to be a proposal with a
-- named approver rather than a movement.
--
-- The movement itself stays in `inventory_movements`, where all stock movement
-- lives. This table is the decision; that table is the fact.

create table if not exists public.inventory_transfers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  item_id             uuid not null,
  from_property_id    uuid not null,
  to_property_id      uuid not null,
  -- The counterpart item row at the destination, when one exists. Null means
  -- the destination has never stocked this and a row must be created on
  -- completion.
  to_item_id          uuid,

  quantity            integer not null,
  status              public.inventory_transfer_status not null default 'suggested',

  -- The day the stock has to be at the destination. This is what makes a
  -- transfer an answer to a *projected* shortage rather than to a present one.
  needed_by           date,
  reason              text,

  requested_by        uuid references auth.users (id) on delete set null,
  requested_at        timestamptz,
  decided_by          uuid references auth.users (id) on delete set null,
  decided_at          timestamptz,
  decision_note       text,
  completed_at        timestamptz,

  -- The two ledger rows this produced, once it completed.
  out_movement_id     uuid references public.inventory_movements (id) on delete set null,
  in_movement_id      uuid references public.inventory_movements (id) on delete set null,

  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint inventory_transfers_item_fkey
    foreign key (item_id, organization_id, from_property_id)
    references public.inventory_items (id, organization_id, property_id)
    on delete cascade,
  constraint inventory_transfers_from_property_fkey
    foreign key (from_property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint inventory_transfers_to_property_fkey
    foreign key (to_property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint inventory_transfers_to_item_fkey
    foreign key (to_item_id, organization_id, to_property_id)
    references public.inventory_items (id, organization_id, property_id)
    on delete set null (to_item_id),

  constraint inventory_transfers_quantity_positive check (quantity > 0),
  -- Moving stock to where it already is is a no-op with a paper trail.
  constraint inventory_transfers_distinct_properties check (
    from_property_id <> to_property_id
  ),
  -- A rejection with no reason is a decision nobody can appeal.
  constraint inventory_transfers_decision_note check (
    status <> 'rejected'
    or (decision_note is not null and length(btrim(decision_note)) > 0)
  ),
  constraint inventory_transfers_decided_pair check (
    (decided_at is null and decided_by is null) or decided_at is not null
  ),
  constraint inventory_transfers_version_positive check (version >= 1)
);

comment on table public.inventory_transfers is
  'Moving stock between properties, as a decision rather than as a movement. A row exists from the moment the forecast suggests one, and nothing leaves a cupboard until somebody entitled to empty it has approved. The movements themselves stay in inventory_movements — this table is the decision, that table is the fact.';

create index if not exists inventory_transfers_organization_idx
  on public.inventory_transfers (organization_id, created_at desc);
create index if not exists inventory_transfers_from_idx
  on public.inventory_transfers (from_property_id, status);
create index if not exists inventory_transfers_to_idx
  on public.inventory_transfers (to_property_id, status);
create index if not exists inventory_transfers_item_idx
  on public.inventory_transfers (item_id, status);
create index if not exists inventory_transfers_open_idx
  on public.inventory_transfers (organization_id, needed_by)
  where status in ('suggested', 'requested', 'approved', 'in_transit');

drop trigger if exists inventory_transfers_touch on public.inventory_transfers;
create trigger inventory_transfers_touch
  before update on public.inventory_transfers
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 8 · Row level security, grants and policies
-- ============================================================================
-- The shape is 0004's and 0011's, unchanged: tenant, then property scope where
-- the table has one, then the grant. `force` is on all four because the table
-- owner is not otherwise bound by its own policies.

alter table public.inventory_settings      enable row level security;
alter table public.inventory_settings      force  row level security;
alter table public.inventory_reservations  enable row level security;
alter table public.inventory_reservations  force  row level security;
alter table public.inventory_discrepancies enable row level security;
alter table public.inventory_discrepancies force  row level security;
alter table public.inventory_transfers     enable row level security;
alter table public.inventory_transfers     force  row level security;

-- Revoke first, grant deliberately. A table created by `postgres` carries no
-- grants to `authenticated`, but saying so out loud is what makes a later
-- `grant all` visible in review.
revoke all on public.inventory_settings      from anon, authenticated;
revoke all on public.inventory_reservations  from anon, authenticated;
revoke all on public.inventory_discrepancies from anon, authenticated;
revoke all on public.inventory_transfers     from anon, authenticated;

grant select, insert, update         on public.inventory_settings      to authenticated;
-- No DELETE on reservations: releasing is a status and a reason, not a
-- vanishing. "We promised these and then did not" is a fact worth keeping.
grant select, insert, update         on public.inventory_reservations  to authenticated;
grant select, insert, update         on public.inventory_discrepancies to authenticated;
grant select, insert, update         on public.inventory_transfers     to authenticated;

grant select, insert, update         on public.inventory_settings      to service_role;
grant select, insert, update         on public.inventory_reservations  to service_role;
grant select, insert, update         on public.inventory_discrepancies to service_role;
grant select, insert, update         on public.inventory_transfers     to service_role;


-- ── inventory_settings ─────────────────────────────────────────────────────
-- Read by anybody who may see stock at all, because every inventory screen has
-- to know whether the module is on before it renders a single widget. Written
-- only by `inventory.edit`: the mode decides whether an entire capability
-- exists for the organization, and that is not a housekeeping decision.

drop policy if exists inventory_settings_select on public.inventory_settings;
create policy inventory_settings_select on public.inventory_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_settings_insert on public.inventory_settings;
create policy inventory_settings_insert on public.inventory_settings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.edit')
  );

drop policy if exists inventory_settings_update on public.inventory_settings;
create policy inventory_settings_update on public.inventory_settings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.edit')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.edit')
  );


-- ── inventory_reservations ─────────────────────────────────────────────────
-- `inventory.adjust` and not `inventory.edit`, matching 0012's own note: edit
-- renames an item and changes its par level; adjust moves a quantity. A
-- promise of stock to a booking is a quantity.
--
-- INSERT and UPDATE policies exist even though `reserve_inventory` is SECURITY
-- DEFINER and bypasses them. That is deliberate: the grant above admits direct
-- writes from PostgREST, and a table with a grant and no policy is a table
-- whose refusals are accidental.

drop policy if exists inventory_reservations_select on public.inventory_reservations;
create policy inventory_reservations_select on public.inventory_reservations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_reservations_insert on public.inventory_reservations;
create policy inventory_reservations_insert on public.inventory_reservations
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_reservations_update on public.inventory_reservations;
create policy inventory_reservations_update on public.inventory_reservations
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.adjust')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.adjust')
  );


-- ── inventory_discrepancies ────────────────────────────────────────────────
-- Raised by whoever counted — a cleaner holds no inventory grant, so in
-- practice the supervisor who checks the count — and resolved by
-- `inventory.adjust`, because every resolution except `investigating` ends in
-- a compensating movement.

drop policy if exists inventory_discrepancies_select on public.inventory_discrepancies;
create policy inventory_discrepancies_select on public.inventory_discrepancies
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_discrepancies_insert on public.inventory_discrepancies;
create policy inventory_discrepancies_insert on public.inventory_discrepancies
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.adjust')
  );

drop policy if exists inventory_discrepancies_update on public.inventory_discrepancies;
create policy inventory_discrepancies_update on public.inventory_discrepancies
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.adjust')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.adjust')
  );


-- ── inventory_transfers ────────────────────────────────────────────────────
-- `inventory.transfer` for the write, which is a permission 0012 already
-- carries and no role held a use for until now. The SELECT is `inventory.view`
-- so that the property giving stock away can see what is being asked of it —
-- a transfer visible only to the requester is a transfer the source property
-- discovers by opening an empty cupboard.

drop policy if exists inventory_transfers_select on public.inventory_transfers;
create policy inventory_transfers_select on public.inventory_transfers
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.view')
  );

drop policy if exists inventory_transfers_insert on public.inventory_transfers;
create policy inventory_transfers_insert on public.inventory_transfers
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.transfer')
  );

drop policy if exists inventory_transfers_update on public.inventory_transfers;
create policy inventory_transfers_update on public.inventory_transfers
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.transfer')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'inventory.transfer')
  );


-- ============================================================================
-- 9 · The rehearsal
-- ============================================================================
-- Asks the live catalogue what this file actually produced, rather than
-- trusting that it produced what it says. The enum check reads `pg_enum` and
-- never casts a literal, because casting `'returning'` here would raise 55P02
-- if §1's commit had not taken — which is exactly the failure this rehearsal
-- exists to catch, and it must report it rather than become it.

do $$
declare
  missing        text;
  v_labels       text[];
  v_returning    integer;
  v_damaged      integer;
  v_lost         integer;
  v_out          integer;
  unprotected    text;
begin
  -- ── The two new labels, and their positions ─────────────────────────────
  select array_agg(e.enumlabel::text order by e.enumsortorder)
    into v_labels
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'inventory_state';

  if not ('returning' = any(v_labels)) or not ('lost' = any(v_labels)) then
    raise exception
      'inventory_state is missing returning and/or lost — section 1 did not commit. Labels: %',
      array_to_string(v_labels, ', ');
  end if;

  v_returning := array_position(v_labels, 'returning');
  v_damaged   := array_position(v_labels, 'damaged');
  v_out       := array_position(v_labels, 'out_of_service');
  v_lost      := array_position(v_labels, 'lost');

  -- The contract says "in this exact order". A `returning` that sorts after
  -- `damaged` would render the cycle out of sequence on every screen that
  -- lists states in their natural order.
  if v_returning >= v_damaged or v_lost <= v_out then
    raise exception
      'inventory_state label order does not match INVENTORY_STATES: %',
      array_to_string(v_labels, ', ');
  end if;

  -- ── The four tables ─────────────────────────────────────────────────────
  select string_agg(name, ', ') into missing
  from (values
    ('inventory_settings'), ('inventory_reservations'),
    ('inventory_discrepancies'), ('inventory_transfers')
  ) as t(name)
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t.name and c.relkind = 'r'
  );

  if missing is not null then
    raise exception 'tables missing for 0030: %', missing;
  end if;

  -- ── Every one of them actually enforces RLS ─────────────────────────────
  -- `enable` without `force` leaves the owner unfiltered, and the owner is who
  -- the migration runs as. 0004's whole lesson.
  select string_agg(c.relname, ', ') into unprotected
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'inventory_settings', 'inventory_reservations',
      'inventory_discrepancies', 'inventory_transfers'
    )
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if unprotected is not null then
    raise exception 'RLS not enabled and forced on: %', unprotected;
  end if;

  -- ── And each one has a policy, not merely a grant ───────────────────────
  select string_agg(t.name, ', ') into missing
  from (values
    ('inventory_settings'), ('inventory_reservations'),
    ('inventory_discrepancies'), ('inventory_transfers')
  ) as t(name)
  where (
    select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = t.name
  ) < 3;

  if missing is not null then
    raise exception
      'fewer than three policies (select/insert/update) on: %', missing;
  end if;

  -- ── The concurrency guarantee this file leans on ────────────────────────
  -- `reserve_inventory` adds relatively and lets the CHECK refuse the
  -- oversell. Without the CHECK the function is a race with extra steps.
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventory_items_reserved_within_quantity'
  ) then
    raise exception
      'inventory_items_reserved_within_quantity is missing — reserve_inventory has no backstop and two concurrent reservations can oversell';
  end if;

  -- ── The functions, and who may call them ────────────────────────────────
  select string_agg(name, ', ') into missing
  from (values ('reserve_inventory'), ('release_inventory_reservation')) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name
  );

  if missing is not null then
    raise exception '0030 functions missing: %', missing;
  end if;

  select string_agg(p.proname, ', ') into missing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('reserve_inventory', 'release_inventory_reservation')
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if missing is not null then
    raise exception 'anon still holds EXECUTE on: %', missing;
  end if;

  -- ── The permissions the policies name ───────────────────────────────────
  --
  -- 0011 made exactly this mistake with the commission codes: a policy naming
  -- a permission no role holds admits nobody, silently. So it is checked — and
  -- it is a NOTICE rather than an exception, which is a deliberate and
  -- uncomfortable choice worth writing down.
  --
  -- `inventory.view` and `inventory.edit` have been in `public.permissions`
  -- since 0012. `inventory.adjust`, `inventory.import` and `inventory.transfer`
  -- were in `src/lib/authz/permissions.ts` and *not* in the database's own
  -- catalogue, so `has_permission(org, 'inventory.adjust')` answered false for
  -- everybody including the owner. **0035 fixes that** and is the only file
  -- that may: `role_permissions.permission_code` is a foreign key onto
  -- `permissions`, and two migrations seeding one catalogue is how a catalogue
  -- stops being one.
  --
  -- 0035 runs *after* this file. Raising here would therefore make a clean
  -- rebuild — 0001 through 0035, in order, on an empty database — fail at 0030
  -- on a gap that 0035 exists to close five files later. That is a worse
  -- failure than the one it would be guarding against, because it is the one
  -- that stops anybody from provisioning at all.
  --
  -- The NOTICE names the file to run. Silence would have been the wrong
  -- answer too: a policy admitting nobody looks identical to a policy working.
  select string_agg(code, ', ') into missing
  from (values
    ('inventory.view'), ('inventory.edit'), ('inventory.adjust'),
    ('inventory.import'), ('inventory.transfer')
  ) as t(code)
  where not exists (
    select 1 from public.permissions where public.permissions.code = t.code
  );

  if missing is not null then
    raise notice
      '0030: permissions named by these policies are not in public.permissions yet: %. Until 0035 has run, has_permission() answers false for them and the policies above admit nobody. This is expected during a clean rebuild and is a defect at any other time.',
      missing;
  end if;

  if exists (select 1 from public.permissions where code = 'inventory.transfer')
     and not exists (
       select 1 from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       where r.organization_id is null
         and r.code = 'organization_owner'
         and rp.permission_code = 'inventory.transfer'
     )
  then
    -- The catalogue has the code and no seeded role holds it. That is not an
    -- ordering artefact — it is the 0011 commission mistake happening again,
    -- and it is worth stopping for.
    raise exception
      'inventory.transfer exists in the catalogue and organization_owner does not hold it; inventory_transfers_insert would admit nobody';
  end if;
end $$;
