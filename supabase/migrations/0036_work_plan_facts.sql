-- ============================================================================
-- 0036_work_plan_facts.sql — ESTIA · a cleaner can read "שתי מיטות תינוק"
--
-- What this closes
--   `/preparation/[bookingId]` renders a work plan from `toCleanerView`, which
--   carries no guest and no money by construction. It could not carry the four
--   facts the person doing the work actually needs either — when the guests
--   arrive, what kind of stay it is, how many are coming, and what they asked
--   for — because those live on `public.bookings`, and `bookings_select`
--   requires `booking.view`. Housekeeping does not hold it. So the screen said
--   "these details are not open to your permission" and a cleaner fetched no
--   cot, because nobody had told them to.
--
-- The fix that was rejected, and why
--   Granting housekeeping `booking.view`. It would work, and it would hand
--   them the guest's name, the total, the deposit and the acquisition source
--   in order to let them read one sentence about a cot. That is the exact
--   privacy inversion the role model exists to prevent, and it would be done
--   in the permission catalogue, where nobody reviewing a preparation change
--   would ever look at it.
--
-- The fix that was taken
--   The same one 0021 already took for the rules. A plan carries
--   `snapshot_hash` and never re-reads the catalogue, because the catalogue
--   can move underneath it. The booking facts get the same treatment: captured
--   when the plan is computed, stored beside it, read from it. A cleaner reads
--   `work_plans`, whose select policy asks for `task.view` and nothing more,
--   and never reaches the booking row at all.
--
--   What is deliberately NOT here is the whole of the argument. No guest, no
--   guest id, no price, no total, no deposit, no source, no channel, no agent.
--   Six columns, each of which a person standing in a doorway with a mop needs
--   in order to do the job correctly. A field cannot leak from a table that
--   has nowhere to put it.
--
-- These move; the snapshot does not
--   Worth stating because the two mechanisms look alike and are opposites. The
--   frozen *rules* must never change, or a plan built in March re-costs itself
--   in April. The *facts* are measurements of a booking that is still alive: a
--   stay that slides a week has a new arrival and a party that grows has new
--   counts, and a deadline on a cleaner's screen that did not move with the
--   booking would be worse than no deadline. `savePlan` rewrites them on every
--   revision, from what `assemblePlan` already produces.
--
-- Nullable, and not back-filled
--   A plan stored before this migration has no facts, and there is no honest
--   way to give it any: computing them means reading the booking, which is the
--   read this whole migration exists to remove. So the columns are nullable,
--   `toPlanFacts` returns null when they are absent, and the screen renders
--   without them and says so. The next recomputation fills them in.
--
-- What is NOT in this migration, and why
--   `work_plans.delta`, `supersedes_version`, `change_reason` and `changed_by`
--   have existed since 0021 and nothing ever wrote them, so every revision was
--   copied into `work_plan_versions` with no account of what moved. That is
--   fixed in the same wave — in `savePlan`, which now takes a `PlanRevision` —
--   and needs no schema change, which is why there is no section for it below.
--
--   `work_plan_versions` does not gain these six columns. Its insert list
--   lives inside `tg_work_plans_record_version`, a SECURITY DEFINER function
--   0021 owns, and rewriting another migration's privileged trigger to carry a
--   copy of facts already on the row it points at is a larger change than the
--   gap justifies. The consequence is real and small: the history can say a
--   plan went from twenty-five guests' worth of work to thirty, through the
--   delta, and cannot say the arrival moved. Named here rather than left to be
--   discovered.
--
-- Depends on
--   0021 (work_plans, and its select policy), 0028 (booking_event_type).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The facts the plan was computed for
-- ============================================================================
-- `arrival_at` is an instant and not a date. `bookings.arrival_time` is a
-- `time` with no zone and the check-in beside it is a `date`; composing them
-- happens once, in `arrivalInstant`, against Asia/Jerusalem. Storing the
-- resolved instant means the readiness countdown cannot be recomputed wrongly
-- by a second reader in a second time zone.
--
-- `guests` is every head, infants included — the number the stay was priced
-- and its capacity checked against. `adults` and `children` are the two the
-- quantity rules can multiply.

alter table public.work_plans
  add column if not exists arrival_at timestamptz,
  add column if not exists event_type public.booking_event_type,
  add column if not exists special_requests text,
  add column if not exists guests integer,
  add column if not exists adults integer,
  add column if not exists children integer;

comment on column public.work_plans.arrival_at is
  'When the guests arrive, resolved to an instant in the property time zone. The deadline every readiness figure is measured against, stored here so a cleaner can see it without holding booking.view. Rewritten on every revision: a stay that moves has a new deadline.';
comment on column public.work_plans.event_type is
  'What kind of stay this plan was built for. Copied from the booking at computation time; the event template it selected is already inside the snapshot.';
comment on column public.work_plans.special_requests is
  'The guest own words, copied from bookings.special_requests when the plan was computed. This column is the entire reason the migration exists: a cleaner has to be able to read "two baby cots" and must not be given booking.view in order to do it.';
comment on column public.work_plans.guests is
  'Every head the plan was computed for, infants included.';
comment on column public.work_plans.adults is
  'Of those, the adults. One of the two bases the quantity rules multiply.';
comment on column public.work_plans.children is
  'Of those, the children. Infants are guests - adults - children and are not stored separately: an infant takes a cot, which is already an ordinary item on the plan, and not a bed.';


-- ============================================================================
-- 2 · What cannot be stored
-- ============================================================================
-- The all-or-nothing rule is the one worth reading. Half a set of facts is not
-- a state any code has to represent, and `toPlanFacts` in
-- `src/lib/persistence/preparation.ts` refuses to: it treats one absent column
-- as "this plan predates 0036" and returns null for the lot. That reading is
-- only safe while the database enforces it, so it does.
--
-- `special_requests` is excluded from the count on purpose. A guest who asked
-- for nothing is an ordinary guest, not a plan with no facts.

alter table public.work_plans
  add constraint work_plans_facts_together check (
    num_nonnulls(arrival_at, event_type, guests, adults, children) in (0, 5)
  ),
  add constraint work_plans_guests_nonnegative check (
    guests is null or guests >= 0
  ),
  add constraint work_plans_adults_nonnegative check (
    adults is null or adults >= 0
  ),
  add constraint work_plans_children_nonnegative check (
    children is null or children >= 0
  ),
  -- Infants are the slack in this inequality, so it is `>=` and not `=`.
  add constraint work_plans_guests_cover_party check (
    guests is null or guests >= adults + children
  ),
  -- The same ceiling `bookings_special_requests_length` sets, because this is
  -- a copy of that column and a copy that could hold more eventually would.
  add constraint work_plans_special_requests_length check (
    special_requests is null or length(special_requests) <= 1000
  );


-- ============================================================================
-- 3 · No new policy, and that is the point
-- ============================================================================
-- `work_plans_select` in 0021 already reads:
--
--     organization_id in (select public.my_organizations())
--     and public.property_in_scope(property_id, organization_id)
--     and public.has_permission(organization_id, 'task.view')
--
-- Six columns added to that table are six columns a `task.view` holder can
-- read, scoped to their own properties, with no change here. That is the whole
-- mechanism: the permission a cleaner already holds is the one that opens
-- these, and the permission they must never hold stays exactly as narrow as it
-- was.


-- ============================================================================
-- 4 · Rehearsal
-- ============================================================================
-- Assert what this migration assumed, so a drifted schema fails here rather
-- than at the moment a cleaner opens a plan and finds a blank where a deadline
-- and a cot request should be.

do $$
declare
  missing text;
  facts_ok boolean;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('arrival_at'), ('event_type'), ('special_requests'),
    ('guests'), ('adults'), ('children'),
    -- The four this wave writes and did not add. 0021 created them and
    -- nothing ever populated them; `savePlan` does now.
    ('delta'), ('supersedes_version'), ('change_reason'), ('changed_by')
  ) as c(name)
  where not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'work_plans'
      and column_name = c.name
  );

  if missing is not null then
    raise exception 'work_plans is missing columns after 0036: %', missing;
  end if;

  -- Every one of the six must be nullable. A NOT NULL among them would refuse
  -- every plan written before this migration on its next save, which is a
  -- cleaner ticking a section off and being told the server broke.
  select string_agg(column_name, ', ') into missing
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'work_plans'
    and column_name in (
      'arrival_at', 'event_type', 'special_requests',
      'guests', 'adults', 'children'
    )
    and is_nullable = 'NO';

  if missing is not null then
    raise exception '0036 columns must be nullable, these are not: %', missing;
  end if;

  select string_agg(name, ', ') into missing
  from (values
    ('work_plans_facts_together'),
    ('work_plans_guests_nonnegative'),
    ('work_plans_adults_nonnegative'),
    ('work_plans_children_nonnegative'),
    ('work_plans_guests_cover_party'),
    ('work_plans_special_requests_length')
  ) as k(name)
  where not exists (
    select 1 from pg_constraint where conname = k.name
  );

  if missing is not null then
    raise exception '0036 constraints missing: %', missing;
  end if;

  -- The all-or-nothing rule, exercised rather than assumed. Unlike 0028's
  -- rehearsal there is nothing to fabricate: the expression is pure and can be
  -- evaluated on its own, with no row and no trigger anywhere near it.
  select
    num_nonnulls(
      null::timestamptz, null::public.booking_event_type,
      null::int, null::int, null::int
    ) in (0, 5)
    and num_nonnulls(
      now(), 'accommodation'::public.booking_event_type, 1, 1, 0
    ) in (0, 5)
    and not (
      num_nonnulls(
        now(), null::public.booking_event_type, 1, 1, 0
      ) in (0, 5)
    )
  into facts_ok;

  if not facts_ok then
    raise exception
      'work_plans_facts_together does not mean what 0036 assumes it means';
  end if;

  -- `work_plans_select` must still be the only gate and must still be the task
  -- permission. A future migration that narrowed it to `booking.view` would
  -- take a cleaner's plan away, and this is where that shows up.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'work_plans'
      and policyname = 'work_plans_select'
      and qual like '%task.view%'
  ) then
    raise exception
      'work_plans_select no longer grants on task.view; 0036 assumed it does';
  end if;
end $$;
