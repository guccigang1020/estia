-- ============================================================================
-- 0072_pricing.sql — ESTIA · the rate card, and the price that cannot move
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- `docs/spec/20-pricing.md` is a 1,076-line master specification and none of
-- its tables existed. `pricing.manage` has been in the permission catalogue
-- since 0012; `dynamic_pricing` is an entitlement sold in the Pro and
-- Management packages since 0003; `agent_commission_rules.rate_plan_ids` has
-- pointed at `rate_plans` since 0015 and 0070 indexed the fact that it is
-- usually null. Three parts of the product already name a rate card that was
-- never built. This builds seven of its nine tables.
--
-- ── THE RULE THAT MAKES THIS WORTH ANYTHING ────────────────────────────────
--
-- **A booking's price is frozen the moment it is taken, and no later change
-- to any rate source moves it by one agora.**
--
-- A guest who booked in March at March's rate still owes March's price when
-- somebody opens the booking in August, after every season, modifier and
-- policy has changed underneath. Recomputing on read is how a business
-- accidentally re-prices a stay somebody already paid for, and it is the one
-- failure in this module that cannot be corrected afterwards because nobody
-- notices it happened.
--
-- Four mechanisms, because one would be a preference:
--
--   1. THE MONEY IS ALREADY WRITTEN ONCE. `booking_price_lines` (0009) holds
--      the amounts, and `bookings.total_agorot` is a trigger-maintained sum of
--      them. Nothing in this migration touches either. The rate tables below
--      are read to PRODUCE lines, never to explain lines that already exist.
--
--   2. `booking_price_snapshots` IS APPEND-ONLY. Privileges are revoked and a
--      trigger refuses UPDATE — except the single legal mutation, setting
--      `superseded_by` from null exactly once, which is how a re-pricing
--      records that it replaced an earlier answer instead of erasing it.
--      Same twin refusal as `booking_status_history` in 0009 and
--      `audit_events` in 0005: the table owner is not bound by grants, and
--      `service_role` carries BYPASSRLS, so a grant alone is not a rule.
--
--   3. THE SNAPSHOT IS THE EXPLANATION, NOT THE PRICE. It stores the inputs
--      and the per-night resolution — which rule won, at what specificity,
--      what the base was, which addition applied and why, whether the night
--      was clamped. It stores no total. There is deliberately no function
--      here, and no function in `src/lib/pricing`, that takes a booking id
--      and returns money: the only way to get a number out of this module is
--      to hand `resolvePricing` a full set of inputs, and a caller holding a
--      full set of inputs is a caller pricing something new.
--
--   4. WHAT WAS TRUE IS COPIED, NOT REFERENCED. `cancellation_policy`,
--      `tax_rate_bps`, `tourist_vat_exempt` and `rate_plan_version` are
--      written into the snapshot rather than pointed at. A pointer to
--      `rate_plans` survives only until somebody edits the plan, and editing
--      the plan is the exact event this table exists to survive. The same
--      argument `src/lib/finance/snapshot.ts` makes about `FinanceSnapshot`
--      copying its lines rather than pointing at them (spec §3.7.1) — and the
--      direction stays one-way: pricing never reads a finance snapshot, and
--      finance never prices.
--
-- ── A RECOMMENDATION IS NEVER A PRICE (spec §6 rule 24, 🔒) ────────────────
--
-- `rate_suggestions` is a separate table from `rate_calendar` for one reason:
-- there is no write path from the first to the second. A suggestion becomes a
-- price only by a person approving it — which writes a `rate_calendar` row
-- with `source = 'ai_approved'`, `suggestion_id` naming the suggestion and
-- `approved_by` naming the person, all three enforced together by a CHECK — or
-- by an `auto_apply` policy a named person switched on, whose limits are in
-- `dynamic_pricing_policies` and whose every application still lands in
-- `rate_calendar` carrying that person's name. "The system did it" is not an
-- admissible answer, so the schema cannot represent it.
--
-- `deterministic_agorot` is stored beside `suggested_agorot` because otherwise
-- "did the recommendations improve anything" is unanswerable, and that is the
-- only question that justifies the engine existing.
--
-- ── PERCENTAGES ARE BASIS POINTS (spec §3.4, 🔒) ───────────────────────────
--
-- `rate_modifiers.adjust_value` is integer bps for a percentage and integer
-- agorot for a fixed amount. Never `numeric`, for `properties.tax_rate_bps`'s
-- reason: a percentage stored as the float `0.15` produces an invoice that
-- does not add up, and an invoice that does not add up is an argument with a
-- guest that the business loses.
--
-- ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
--
-- **`promotions`, `coupons` and `discount_redemptions`** (spec §3.5). They are
-- another agent's migration in this repository. The seam they need is left
-- open deliberately and in three places, so that migration adds tables and
-- changes nothing here:
--
--   · `booking_price_snapshots.inputs` carries the promotion and coupon codes
--     that were presented, and `.resolution` carries which were selected and
--     what each removed — as recorded values, with **no foreign key** to
--     either table. A snapshot must survive a promotion being deleted; that
--     is the whole point of a snapshot, and an FK would make it false.
--   · `rate_plans.floor_agorot` / `ceiling_agorot` are the clamp a discount
--     is checked against (spec §6 rule 22), and they live here because they
--     belong to the rate card rather than to any campaign.
--   · Discounts are lines on the stay total (`priceStay` step 4), not
--     adjustments to a night. Nothing in this file computes one, and nothing
--     in it needs to know one exists.
--
-- **The AI engine itself.** `rate_suggestions` stores what a suggestion is and
-- what happened to it. No suggestion is produced by anything in this
-- deployment, and the screen says so in Hebrew rather than showing an empty
-- list that implies a silent engine. Spec §11 leaves the buy-or-build decision
-- open and marks it ❓; the storage is valid either way, which is exactly why
-- it can be built before that decision is made.
--
-- **Any change to `booking_price_lines` or `bookings`.** Deliberate. The money
-- is owned by 0009 and by the booking module, and a second writer of a total
-- is how two screens end up disagreeing about a price.
--
-- Depends on 0001 (organizations, `tg_touch_row`), 0004 (`my_organizations`,
-- `has_permission`), 0008 (properties, units, unit_groups, `property_in_scope`)
-- and 0009 (bookings, `booking_source`, btree_gist).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabulary
-- ============================================================================
-- Enums rather than text with a CHECK, for the reason 0008 and 0009 give: the
-- value list is a contract shared with `src/lib/pricing/types.ts`, and a typo
-- in a text column is a row that silently never matches.

do $$ begin
  -- Which commercial relationship a plan prices. `requires_grant` decides who
  -- may SELECT it; this decides what it means.
  create type public.rate_plan_kind as enum (
    'flexible',
    'non_refundable',
    'direct',
    'agent',
    'ota',
    'corporate',
    'owner_special'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  -- What a rate rule or modifier attaches to. The order is the specificity
  -- order of spec §7.2 and `public.rate_rule_specificity` depends on it being
  -- these three and no others.
  create type public.rate_scope as enum (
    'unit',
    'unit_group',
    'property'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  -- How a single night's manual price came to be. `ai_approved` is the ONLY
  -- value that may carry a suggestion, and it may not exist without one.
  create type public.rate_calendar_source as enum (
    'manual',
    'ai_approved',
    'channel_sync'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.rate_modifier_kind as enum (
    'weekend',
    'holiday',
    'occupancy',
    'guest_count',
    'event_type'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  -- `auto_applied` is a terminal state distinct from `approved`, so a report
  -- can separate what a person decided from what a policy decided on their
  -- behalf. Collapsing the two would make spec §12's accountability rule
  -- unmeasurable a year later.
  create type public.rate_suggestion_status as enum (
    'pending',
    'approved',
    'rejected',
    'expired',
    'auto_applied'
  );
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 2 · rate_plans — which price list a stay is sold from
-- ============================================================================

-- The SHAPE of a derived rate, and nothing more.
--
-- A function rather than an inline CHECK expression for 0067's reason: the
-- rehearsal at the foot of this file RUNS it against real documents instead of
-- reading that a constraint exists. A guard nobody has executed is a guard
-- nobody knows the behaviour of.
--
-- What it deliberately does NOT check is whether the parent plan exists,
-- whether the chain is shorter than four links, or whether it closes a cycle.
-- None of the three is a property of one row, and spec §7.8 puts all three at
-- SAVE time in the resolver so that no quote ever discovers them.
create or replace function public.rate_plan_derivation_valid(p_derivation jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- CASE and not a chain of AND, for the reason 0067 gives at length:
  -- jsonb accessors raise on a value of the wrong type, and SQL does not
  -- promise to evaluate the arms of an AND left to right. CASE does promise
  -- it, so the type test genuinely guards everything below it.
  select case
    -- Null is an independent rate. It is the common case, not a missing value.
    when p_derivation is null then true
    when pg_catalog.jsonb_typeof(p_derivation) <> 'object' then false
    when p_derivation -> 'from_rate_plan_id' is null then false
    when pg_catalog.jsonb_typeof(p_derivation -> 'from_rate_plan_id') <> 'string'
      then false
    when (p_derivation ->> 'from_rate_plan_id')
         !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then false
    when pg_catalog.jsonb_typeof(p_derivation -> 'adjust') <> 'object' then false
    -- The two kinds the resolver implements. A third would be stored, would
    -- pass every test, and would price nothing.
    when (p_derivation -> 'adjust' ->> 'kind') not in ('percent', 'fixed')
      then false
    when pg_catalog.jsonb_typeof(p_derivation -> 'adjust' -> 'value') <> 'number'
      then false
    else true
  end;
$$;

comment on function public.rate_plan_derivation_valid(jsonb) is
  'The shape of a derived rate: a parent plan id and a percent-or-fixed adjustment. Null is an independent rate and is the common case. Deliberately does not check that the parent exists, that the chain is under four links, or that it closes a cycle — none is a property of one row, and spec §7.8 puts all three in the resolver at save time so no quote ever discovers them.';

revoke all on function public.rate_plan_derivation_valid(jsonb) from public, anon;
grant execute on function public.rate_plan_derivation_valid(jsonb)
  to authenticated, service_role;


-- Exactly one plan is chosen per quote (spec §7.8), and the choice happens
-- BEFORE any night is priced. That ordering is the answer to the question the
-- whole specification is built around: an agent rate is not a discount, it is
-- a different rule table, which is why it neither competes nor stacks with a
-- promotion — it preceded it.

create table if not exists public.rate_plans (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  -- Null is "every property in this business", not a missing value. The same
  -- convention `automation_rules` uses in 0067 and for the same reason: a plan
  -- that has to be duplicated per property is a plan that drifts per property.
  property_id      uuid,

  -- A stable machine identifier, exactly like `plans.code`. It survives the
  -- display name changing, which matters because `code asc` is the final
  -- tie-breaker when two plans are equally eligible (spec §7.8) — an
  -- arbitrary but STABLE order is what makes a quote reproducible.
  code             text not null,
  name             text not null,
  kind             public.rate_plan_kind not null default 'direct',

  -- Empty array means every channel. Null would mean the same thing and would
  -- need every reader to decide which; the array is `not null default '{}'`
  -- so there is one answer.
  channel_scope    public.booking_source[] not null default '{}',

  -- The grant a person must hold to sell from this plan. Checked in
  -- `rate_plans_select` below AND by `can()` in the service layer — the two
  -- floors of docs/ARCHITECTURE.md. A plan of kind `agent` normally carries
  -- `rate.view_agent`; nothing forces the pairing, because a business may
  -- legitimately have a corporate plan that only management may quote.
  requires_grant   text,

  -- Null is an independent rate. Otherwise
  -- `{ from_rate_plan_id, adjust: { kind: 'percent'|'fixed', value } }`,
  -- resolved recursively to depth 3 by `src/lib/pricing`. The depth limit and
  -- the cycle check are in the code rather than here: Postgres can check the
  -- SHAPE of a derivation, and only the resolver can walk one. Spec §7.8 puts
  -- cycle rejection at SAVE time for that reason.
  derivation       jsonb,

  min_nights       integer,
  max_nights       integer,
  advance_days_min integer,
  advance_days_max integer,

  -- The tiers as they were when a booking was taken get copied into
  -- `booking_price_snapshots.cancellation_policy`. This column is what a NEW
  -- quote reads; it is never what an old booking is judged by.
  cancellation_policy jsonb not null default '{}'::jsonb,

  -- The deterministic guard rails of spec §6 rules 14, 15 and 22. A night is
  -- clamped into this range after every addition and before the single
  -- rounding, and the clamp is recorded in the resolution rather than applied
  -- silently — a business that never learns its rate card is producing prices
  -- below its own floor will keep producing them.
  floor_agorot     integer,
  ceiling_agorot   integer,

  priority         integer not null default 0,
  is_active        boolean not null default true,

  -- Half-open [effective_from, effective_to), like every range in the product.
  effective_from   date not null default current_date,
  effective_to     date,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint rate_plans_id_organization_key unique (id, organization_id),
  constraint rate_plans_code_key unique (organization_id, code),

  constraint rate_plans_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  -- The shape spec §8 gives: lowercase latin, digits, hyphen, underscore.
  constraint rate_plans_code_shape check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  constraint rate_plans_name_not_blank check (length(btrim(name)) > 0),

  -- A floor above a ceiling is not a strict rate card, it is an unsaveable
  -- one: every night would clamp to the ceiling and then fail the floor, and
  -- the resolver would have to pick a winner. Spec §6 rule 15 puts the
  -- refusal in the database so no resolver ever has to.
  constraint rate_plans_floor_below_ceiling check (
    floor_agorot is null
    or ceiling_agorot is null
    or floor_agorot <= ceiling_agorot),
  constraint rate_plans_floor_nonnegative check (
    floor_agorot is null or floor_agorot >= 0),
  constraint rate_plans_ceiling_nonnegative check (
    ceiling_agorot is null or ceiling_agorot >= 0),

  constraint rate_plans_nights_range check (
    (min_nights is null or min_nights between 1 and 365)
    and (max_nights is null or max_nights between 1 and 365)
    and (min_nights is null or max_nights is null or min_nights <= max_nights)),

  constraint rate_plans_advance_range check (
    (advance_days_min is null or advance_days_min >= 0)
    and (advance_days_max is null or advance_days_max >= 0)
    and (advance_days_min is null or advance_days_max is null
         or advance_days_min <= advance_days_max)),

  constraint rate_plans_effective_ordered check (
    effective_to is null or effective_to > effective_from),

  -- Shape only. Whether the referenced plan exists, whether the chain is
  -- shorter than four and whether it closes a cycle are the resolver's, and
  -- the resolver refuses at save time.
  constraint rate_plans_derivation_shape check (
    public.rate_plan_derivation_valid(derivation)),

  constraint rate_plans_version_positive check (version >= 1)
);

comment on table public.rate_plans is
  'Which price list a stay is sold from: direct, agent, OTA, corporate. Exactly one is chosen per quote and the choice happens before any night is priced, which is why an agent rate neither competes nor stacks with a promotion — it preceded it. Referenced by agent_commission_rules.rate_plan_ids since 0015.';
comment on column public.rate_plans.property_id is
  'Null is every property in this business, not a missing value. Same convention as automation_rules in 0067: a plan duplicated per property is a plan that drifts per property.';
comment on column public.rate_plans.code is
  'A stable machine identifier that survives the display name changing. It is also the final tie-breaker when two plans are equally eligible (spec §7.8) — arbitrary, but stable, which is what makes a quote reproducible a year later.';
comment on column public.rate_plans.requires_grant is
  'The grant a person must hold to sell from this plan. Enforced in rate_plans_select AND by can() in the service layer — the two floors. Not constrained to the catalogue here: Postgres does not know it, and a plan naming an unknown grant is refused by the operation rather than stored pointing at nothing.';
comment on column public.rate_plans.derivation is
  'Null is an independent rate. Otherwise { from_rate_plan_id, adjust: { kind, value } }, resolved to depth 3 by src/lib/pricing. The CHECK is shape only: a cycle can only be found by walking the chain, and spec §7.8 puts that refusal at save time so no quote ever discovers it.';
comment on column public.rate_plans.floor_agorot is
  'The deterministic floor of spec §6 rules 14 and 22. A night is clamped into [floor, ceiling] after every addition and before the single rounding, and the clamp is recorded in the resolution rather than applied silently.';

create index if not exists rate_plans_eligible_idx
  on public.rate_plans (organization_id, property_id, is_active);

drop trigger if exists rate_plans_touch on public.rate_plans;
create trigger rate_plans_touch
  before update on public.rate_plans
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · rate_rules — what a single night costs, over a range
-- ============================================================================

-- Written and stored, never typed. Spec §7.2 fixes the ladder, and a column a
-- caller may fill in is a ladder a caller may climb: a `property` rule sent
-- with `specificity = 100` would beat the unit rule that should have won, and
-- nothing downstream would look wrong.
create or replace function public.rate_rule_specificity(
  p_scope_kind public.rate_scope,
  p_weekdays   smallint[]
)
returns smallint
language sql
immutable
set search_path = ''
as $$
  -- The eight rungs of spec §7.2, less the two this function cannot produce:
  -- 100 belongs to rate_calendar (a single unit on a single day) and 0 is
  -- units.base_price_agorot, the last floor. Both are levels the resolver
  -- assigns; neither is a rule row.
  select case p_scope_kind
    when 'unit'       then case when coalesce(pg_catalog.array_length(p_weekdays, 1), 0) > 0 then 80 else 70 end
    when 'unit_group' then case when coalesce(pg_catalog.array_length(p_weekdays, 1), 0) > 0 then 60 else 50 end
    when 'property'   then case when coalesce(pg_catalog.array_length(p_weekdays, 1), 0) > 0 then 40 else 30 end
  end::smallint;
$$;

comment on function public.rate_rule_specificity(public.rate_scope, smallint[]) is
  'The specificity ladder of spec §7.2, computed from what the rule actually says rather than accepted from the writer. A property rule sent with specificity 100 would beat the unit rule that should have won and nothing downstream would look wrong, which is why this is a function and a trigger rather than a column default.';

revoke all on function public.rate_rule_specificity(public.rate_scope, smallint[])
  from public, anon;
grant execute on function public.rate_rule_specificity(public.rate_scope, smallint[])
  to authenticated, service_role;


-- The weekday set, checked as a set. `0` is Sunday and `6` is Saturday, the
-- convention `dayOfWeek` in src/lib/hebrew-calendar uses; a duplicate entry is
-- refused because `[5,5,6]` and `[5,6]` price identically and only one of them
-- can be what somebody meant.
create or replace function public.rate_weekdays_valid(p_weekdays smallint[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_weekdays is null then true
    when pg_catalog.array_length(p_weekdays, 1) is null then true
    when pg_catalog.array_length(p_weekdays, 1) > 7 then false
    when exists (
      select 1 from pg_catalog.unnest(p_weekdays) as d(day)
      where d.day < 0 or d.day > 6
    ) then false
    -- Distinct count against total count: the set has to be a set.
    when (select pg_catalog.count(distinct d.day) from pg_catalog.unnest(p_weekdays) as d(day))
       <> pg_catalog.array_length(p_weekdays, 1) then false
    else true
  end;
$$;

comment on function public.rate_weekdays_valid(smallint[]) is
  '0=Sunday … 6=Saturday, at most seven of them, no duplicates. A duplicate is refused because [5,5,6] and [5,6] price identically and only one of them can be what somebody meant.';

revoke all on function public.rate_weekdays_valid(smallint[]) from public, anon;
grant execute on function public.rate_weekdays_valid(smallint[])
  to authenticated, service_role;


create table if not exists public.rate_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  property_id      uuid not null,
  rate_plan_id     uuid not null,

  scope_kind       public.rate_scope not null,
  -- The unit, unit group or property this rule prices. Not a foreign key,
  -- because it points at one of three tables depending on `scope_kind`, and
  -- three nullable columns with a CHECK that exactly one is set would make
  -- every query in the resolver a three-way coalesce. The tenant boundary is
  -- carried by `organization_id` and `property_id`, which ARE keyed, so a
  -- dangling `scope_id` can name a deleted unit but can never name another
  -- business's unit.
  scope_id         uuid not null,

  -- Computed by the trigger below from `scope_kind` and `weekdays`. Stored
  -- rather than derived at read time because it is the leading sort key of
  -- every quote and an index on a function of two columns is one more thing
  -- that can silently disagree with the resolver.
  specificity      smallint not null default 0,

  -- The season. Half-open [date_from, date_to).
  date_from        date not null,
  date_to          date not null,
  weekdays         smallint[] not null default '{}',

  nightly_agorot   integer not null,
  min_nights       integer,
  priority         integer not null default 0,
  -- Hebrew, and it reaches the guest's breakdown through the snapshot's
  -- resolution. This is what turns "₪1,450" into "₪1,450 · עונת סוכות · שבת",
  -- which is the difference between a price and an explanation.
  label            text,

  -- The rule's own validity, which is NOT the season it prices. Spec §6 rule
  -- 39: editing a rule closes the old row and opens a new one, so the same
  -- season can be priced by two rows that were true at different times, and
  -- §7.2's third tie-breaker is `effective_from desc`. Without these columns
  -- that tie-breaker has nothing to read and an edit would have to overwrite
  -- history in place.
  effective_from   date not null default current_date,
  effective_to     date,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint rate_rules_id_organization_key unique (id, organization_id),

  constraint rate_rules_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint rate_rules_plan_fkey
    foreign key (rate_plan_id, organization_id)
    references public.rate_plans (id, organization_id) on delete cascade,

  -- Spec §8: a night costs between nothing and ₪100,000. The upper bound is
  -- not a business limit, it is a typo limit — ₪1,450 entered in agorot as
  -- 145000 is right and as 14500000 is a finger that slipped.
  constraint rate_rules_nightly_range check (
    nightly_agorot between 0 and 10000000),
  constraint rate_rules_dates_ordered check (date_to > date_from),
  constraint rate_rules_effective_ordered check (
    effective_to is null or effective_to > effective_from),
  constraint rate_rules_weekdays_valid check (
    public.rate_weekdays_valid(weekdays)),
  constraint rate_rules_min_nights_range check (
    min_nights is null or min_nights between 1 and 365),
  -- The trigger computes it; the constraint means a writer that reached past
  -- the trigger still cannot store a rung that is not on the ladder.
  constraint rate_rules_specificity_computed check (
    specificity = public.rate_rule_specificity(scope_kind, weekdays)),
  constraint rate_rules_version_positive check (version >= 1)
);

comment on table public.rate_rules is
  'What a single night costs, over a range: the season, the weekday set, the scope. Range-shaped and therefore separate from rate_calendar, which is one unit on one day. The winning rule for a night is chosen by specificity desc, priority desc, effective_from desc, id asc — four tie-breakers, exhaustive, so the same inputs give the same number on every run.';
comment on column public.rate_rules.scope_id is
  'The unit, unit group or property this rule prices, per scope_kind. Deliberately not a foreign key: it points at one of three tables, and three nullable columns with a CHECK would make every resolver query a three-way coalesce. The tenant boundary is carried by organization_id and property_id, which are keyed — so a stale scope_id can name a deleted unit and can never name another business unit.';
comment on column public.rate_rules.specificity is
  'Computed by trigger from scope_kind and weekdays, never accepted from the writer. See public.rate_rule_specificity.';
comment on column public.rate_rules.effective_from is
  'The rule row validity, which is not the season it prices. Editing a rule closes the old row and opens a new one (spec §6 rule 39), so one season can be priced by two rows that were true at different times, and effective_from desc is the third tie-breaker of §7.2.';
comment on column public.rate_rules.label is
  'Hebrew, and it reaches the guest breakdown through the snapshot resolution. The difference between "₪1,450" and "₪1,450 · עונת סוכות · שבת".';


create or replace function public.tg_rate_rule_specificity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Overwritten, not validated. A caller may send anything; it is discarded.
  new.specificity := public.rate_rule_specificity(new.scope_kind, new.weekdays);
  return new;
end $$;

comment on function public.tg_rate_rule_specificity() is
  'Overwrites rate_rules.specificity from the rule own scope and weekday set on every write. Discards whatever the caller sent rather than validating it, because a value that is always computed has no legitimate caller-supplied form.';

drop trigger if exists rate_rules_specificity on public.rate_rules;
create trigger rate_rules_specificity
  before insert or update on public.rate_rules
  for each row execute function public.tg_rate_rule_specificity();

drop trigger if exists rate_rules_touch on public.rate_rules;
create trigger rate_rules_touch
  before update on public.rate_rules
  for each row execute function public.tg_touch_row();


-- ── Spec §6 rule 6 · non-determinism is prevented, not avoided ──────────────
--
-- Two rules on the same scope, at the same specificity, at the same priority,
-- whose seasons overlap and whose validity windows overlap, have no defined
-- winner beyond `id asc` — and a rate card whose answer depends on which uuid
-- the server generated is a rate card nobody can predict from the screen. §7.2
-- keeps the `id` tie-breaker because "must not happen" and "will not happen"
-- are different statements, and this constraint is the second one.
--
-- BOTH ranges are in the exclusion. The season range alone would refuse the
-- correction that §6 rule 39 requires — close the old row, open a new one for
-- the same season — because the two rows genuinely do overlap in season. They
-- do not overlap in validity, and that is what makes them a history rather
-- than a contradiction.
--
-- Known strictness, stated rather than discovered: two same-specificity,
-- same-priority rules with DISJOINT weekday sets over one season are refused
-- even though they could never both win a night. Postgres cannot express
-- array disjointness in a gist exclusion, and the workaround is one line —
-- give one of them a different priority. Refusing a representable-but-unclear
-- rate card is the cheaper error.
do $$ begin
  alter table public.rate_rules
    add constraint rate_rules_no_ambiguous_overlap
    exclude using gist (
      rate_plan_id with =,
      scope_kind   with =,
      scope_id     with =,
      specificity  with =,
      priority     with =,
      daterange(date_from, date_to, '[)') with &&,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[)') with &&
    );
exception when duplicate_object then null; end $$;

-- "Every rule that touches this range", which is the only query the resolver
-- ever runs against this table.
create index if not exists rate_rules_span_idx
  on public.rate_rules
  using gist (rate_plan_id, scope_id, daterange(date_from, date_to, '[)'));

create index if not exists rate_rules_plan_idx
  on public.rate_rules (organization_id, rate_plan_id, scope_kind, scope_id);


-- ============================================================================
-- 4 · rate_calendar — the hand-set price for one unit on one night
-- ============================================================================
-- A separate table from rate_rules because the access pattern is entirely
-- different: pointwise by day, written in bulk by the calendar screen and by
-- the approval flow, read for every night of every quote. It also sits at the
-- top of the specificity ladder unconditionally (100), which is the schema
-- saying that a person who typed a number for a specific night on a specific
-- unit meant it.

create table if not exists public.rate_calendar (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  property_id      uuid not null,
  unit_id          uuid not null,
  rate_plan_id     uuid not null,

  date             date not null,
  nightly_agorot   integer not null,

  source           public.rate_calendar_source not null default 'manual',
  -- The only route by which a recommendation becomes a price. Not a foreign
  -- key with ON DELETE CASCADE for the obvious reason: deleting the
  -- suggestion must not delete the price somebody approved.
  suggestion_id    uuid,
  approved_by      uuid references auth.users (id) on delete set null,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  -- Two people editing the same night is the ordinary case on this table, not
  -- the exotic one, so `version` is here to be checked. Spec §10: a mismatch
  -- is a 409 that is NOT automatically retried, because an automatic retry
  -- here is precisely the lost update the column exists to prevent.
  version          integer not null default 1,

  constraint rate_calendar_id_organization_key unique (id, organization_id),
  constraint rate_calendar_night_key unique (unit_id, rate_plan_id, date),

  constraint rate_calendar_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete cascade,
  constraint rate_calendar_plan_fkey
    foreign key (rate_plan_id, organization_id)
    references public.rate_plans (id, organization_id) on delete cascade,
  -- The foreign key to `rate_suggestions` is added in section 6, once that
  -- table exists. It cannot be here and it cannot be ON DELETE SET NULL: a
  -- composite key set to null would null `organization_id` too, and that
  -- column is NOT NULL — so the cascade would raise rather than tidy.

  constraint rate_calendar_nightly_range check (
    nightly_agorot between 0 and 10000000),

  -- 🔒 The accountability constraint of spec §6 rules 24 and 27, stated as one
  -- CHECK because the three facts are one fact: an AI-originated price names
  -- the suggestion it came from AND the person who let it through, and a
  -- price that is not AI-originated may claim neither. "The system did it" is
  -- not representable.
  constraint rate_calendar_ai_is_attributed check (
    case source
      when 'ai_approved' then suggestion_id is not null and approved_by is not null
      else suggestion_id is null
    end),

  constraint rate_calendar_version_positive check (version >= 1)
);

comment on table public.rate_calendar is
  'The hand-set price for one unit on one night. Separate from rate_rules because the access pattern is pointwise rather than ranged, and top of the specificity ladder unconditionally: a person who typed a number for a specific night on a specific unit meant it.';
comment on column public.rate_calendar.suggestion_id is
  'The only route by which a recommendation becomes a price. Deliberately ON DELETE SET NULL rather than CASCADE: deleting the suggestion must not delete the price somebody approved.';
comment on column public.rate_calendar.version is
  'Two people editing the same night is the ordinary case here. A save states its expectedVersion and a mismatch is a 409 that is not automatically retried — an automatic retry is exactly the lost update this column exists to prevent (spec §10).';

-- The calendar screen reads a plan across a month; a quote reads a unit across
-- a stay. Two indexes because they are two different leading columns and one
-- of them would otherwise scan.
create index if not exists rate_calendar_plan_month_idx
  on public.rate_calendar (organization_id, rate_plan_id, date);
create index if not exists rate_calendar_unit_night_idx
  on public.rate_calendar (organization_id, unit_id, date);

drop trigger if exists rate_calendar_touch on public.rate_calendar;
create trigger rate_calendar_touch
  before update on public.rate_calendar
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · rate_modifiers — the additions to a night
-- ============================================================================
-- Weekend, holiday, occupancy, guest count, event type. At most ONE calendar
-- addition applies to any night and it is the MAXIMUM of the weekend and
-- holiday additions rather than their sum (spec §6 rule 9): a Saturday that is
-- also chol hamoed is one expensive night, not two. That rule lives in the
-- resolver because it is a choice between rows; what lives here is the shape
-- that makes the choice computable.

create table if not exists public.rate_modifiers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  property_id      uuid not null,
  -- Null applies to every plan in scope. A modifier is usually a property of
  -- the calendar rather than of a commercial relationship: a Saturday is a
  -- Saturday whether the guest booked direct or through an agent.
  rate_plan_id     uuid,

  kind             public.rate_modifier_kind not null,
  scope_kind       public.rate_scope not null,
  scope_id         uuid not null,

  -- Per `kind`, and the closed shapes are in src/lib/pricing/types.ts:
  --   weekend      { weekdays: number[] }
  --   holiday      { special_day_kinds: SpecialDayKind[] }
  --   occupancy    { from_percent, to_percent }   half-open [from, to)
  --   guest_count  { from, to }
  --   event_type   { any_of: EventType[] }
  trigger_config   jsonb not null default '{}'::jsonb,

  adjust_kind      text not null,
  -- 🔒 bps for a percentage, agorot for a fixed amount. Integer, always. Same
  -- argument as properties.tax_rate_bps: a percentage stored as the float 0.15
  -- produces an invoice that does not add up.
  adjust_value     integer not null,

  priority         integer not null default 0,
  is_active        boolean not null default true,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint rate_modifiers_id_organization_key unique (id, organization_id),

  constraint rate_modifiers_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint rate_modifiers_plan_fkey
    foreign key (rate_plan_id, organization_id)
    references public.rate_plans (id, organization_id) on delete cascade,

  constraint rate_modifiers_adjust_kind check (
    adjust_kind in ('percent', 'fixed')),

  -- Spec §8: −100% to +1,000% in bps for a percentage; a fixed addition is a
  -- price and obeys the same typo limit every other price here does. A
  -- percentage below −10000 bps would make a night cost less than nothing
  -- before the clamp ever saw it.
  constraint rate_modifiers_adjust_range check (
    case adjust_kind
      when 'percent' then adjust_value between -10000 and 100000
      else adjust_value between -10000000 and 10000000
    end),

  constraint rate_modifiers_trigger_is_object check (
    jsonb_typeof(trigger_config) = 'object'),

  constraint rate_modifiers_version_positive check (version >= 1)
);

comment on table public.rate_modifiers is
  'The additions to a night: weekend, holiday, occupancy, guest count, event type. At most one CALENDAR addition applies to any night, and it is the maximum of the weekend and holiday additions rather than their sum (spec §6 rule 9) — a Saturday that is also chol hamoed is one expensive night, not two. That choice is the resolver; this is the shape that makes it computable.';
comment on column public.rate_modifiers.adjust_value is
  'Basis points for a percentage, agorot for a fixed amount. Integer, always, and never numeric — the same argument as properties.tax_rate_bps: a percentage stored as the float 0.15 produces an invoice that does not add up.';
comment on column public.rate_modifiers.trigger_config is
  'The condition, per kind. Closed shapes, mirrored in src/lib/pricing/types.ts. Postgres checks that it is an object; the resolver checks that it is the right object for the kind, because only the resolver knows what each kind reads.';

create index if not exists rate_modifiers_lookup_idx
  on public.rate_modifiers (organization_id, property_id, kind, scope_id)
  where is_active;

drop trigger if exists rate_modifiers_touch on public.rate_modifiers;
create trigger rate_modifiers_touch
  before update on public.rate_modifiers
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · rate_suggestions — what the engine proposed, and what a person decided
-- ============================================================================
-- 🔒 A suggestion is not a price. It becomes one only through rate_calendar,
-- and only carrying a person's name. See the header.

create table if not exists public.rate_suggestions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  property_id      uuid not null,
  unit_id          uuid not null,
  rate_plan_id     uuid not null,

  date             date not null,

  -- What the deterministic engine said, stored beside what was proposed. Spec
  -- §12: without it, "did the recommendations improve anything" cannot be
  -- answered, and that is the only question that justifies the engine.
  deterministic_agorot integer not null,
  suggested_agorot     integer not null,
  confidence_bps       integer,

  -- Hebrew, shown to the approver, and NOT NULL. Spec §3.6: a recommendation
  -- without an explanation cannot be approved, so one cannot be stored either
  -- — a row with no rationale would sit in the queue forever looking like
  -- work somebody had to do.
  rationale        text not null,

  -- A fingerprint of the inputs. Two proposals from identical inputs must be
  -- the same row rather than two rows a person has to decide twice, which is
  -- what the unique index below enforces.
  inputs_hash      text not null,

  status           public.rate_suggestion_status not null default 'pending',
  -- Spec §4.2: a recommendation about tomorrow is not relevant the day after.
  expires_at       timestamptz,

  decided_by       uuid references auth.users (id) on delete set null,
  decided_at       timestamptz,
  decision_reason  text,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint rate_suggestions_id_organization_key unique (id, organization_id),
  constraint rate_suggestions_inputs_key
    unique (organization_id, unit_id, rate_plan_id, date, inputs_hash),

  constraint rate_suggestions_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete cascade,
  constraint rate_suggestions_plan_fkey
    foreign key (rate_plan_id, organization_id)
    references public.rate_plans (id, organization_id) on delete cascade,

  constraint rate_suggestions_amounts_range check (
    deterministic_agorot between 0 and 10000000
    and suggested_agorot between 0 and 10000000),
  constraint rate_suggestions_confidence_range check (
    confidence_bps is null or confidence_bps between 0 and 10000),
  constraint rate_suggestions_rationale_not_blank check (
    length(btrim(rationale)) >= 8),
  constraint rate_suggestions_hash_shape check (
    inputs_hash ~ '^[0-9a-f]{8,64}$'),

  -- A decided suggestion names who decided it and when. A pending one names
  -- neither. The third state — decided by nobody — is what an automatic
  -- application would be if `auto_applied` were allowed to skip the stamp, and
  -- it is not representable.
  constraint rate_suggestions_decision_is_stamped check (
    case status
      when 'pending' then decided_at is null
      when 'expired' then true
      else decided_at is not null
    end),
  -- Spec §5.4 and §13: a rejection states a reason. An approval does not need
  -- one — the price it wrote is the record — but a refusal that says nothing
  -- teaches the engine nothing and teaches the next approver less.
  constraint rate_suggestions_rejection_has_a_reason check (
    status <> 'rejected'
    or (decision_reason is not null and length(btrim(decision_reason)) >= 3)),

  constraint rate_suggestions_version_positive check (version >= 1)
);

comment on table public.rate_suggestions is
  'What the pricing engine proposed for one night, and what a person decided about it. A suggestion is never a price: the only route to rate_calendar is an approval carrying a person name, or an auto_apply policy that person switched on. No engine in this deployment writes rows here yet, and the screen says so rather than showing an empty list that implies a silent engine.';
comment on column public.rate_suggestions.deterministic_agorot is
  'What the deterministic resolver said, stored beside what was proposed. Without it, "did the recommendations improve anything" is unanswerable — and that is the only question that justifies the engine existing (spec §12).';
comment on column public.rate_suggestions.rationale is
  'Hebrew, shown to the approver, and NOT NULL. A recommendation without an explanation cannot be approved, so it must not be storable either: it would sit in the queue forever looking like work somebody had to do.';
comment on column public.rate_suggestions.inputs_hash is
  'A fingerprint of the inputs the proposal was made from. Two proposals from identical inputs are one row, not two decisions — enforced by rate_suggestions_inputs_key.';

create index if not exists rate_suggestions_queue_idx
  on public.rate_suggestions (organization_id, property_id, date)
  where status = 'pending';

drop trigger if exists rate_suggestions_touch on public.rate_suggestions;
create trigger rate_suggestions_touch
  before update on public.rate_suggestions
  for each row execute function public.tg_touch_row();

-- The link back from section 4, now that there is something to link to.
-- `no action` rather than `set null` or `cascade`: nulling a composite key
-- would null `organization_id`, and cascading would delete the price somebody
-- approved because the recommendation behind it was tidied away. In practice
-- no role holds DELETE on `rate_suggestions` at all, and this is what makes
-- that true from the calendar's side as well.
do $$ begin
  alter table public.rate_calendar
    add constraint rate_calendar_suggestion_fkey
    foreign key (suggestion_id, organization_id)
    references public.rate_suggestions (id, organization_id) on delete no action;
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 7 · dynamic_pricing_policies — the limits on automatic application
-- ============================================================================
-- The paid feature `dynamic_pricing` sells this row. What it actually stores
-- is the set of conditions under which a machine may move a price without
-- asking — every one of them a bound, and all of them ANDed (spec §6 rule 26).
-- One failing leaves the suggestion pending and waiting for a person.

create table if not exists public.dynamic_pricing_policies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  -- Null is the organization-wide policy. A property row replaces it
  -- wholesale, exactly as automation_rules and guest_journey_settings do: a
  -- half-inherited automatic-pricing policy is one nobody can predict, and
  -- this is the one policy in the product that spends money by itself.
  property_id      uuid,

  auto_apply       boolean not null default false,
  -- How far from the deterministic price a proposal may move and still be
  -- applied without a person. Bps, and NOT NULL with a conservative default:
  -- an unbounded delta is the whole risk of the feature, and a null that some
  -- reader treats as "no limit" is that risk arriving by accident.
  max_delta_bps    integer not null default 1000,
  -- Per unit per day. A policy that may move one night's price ten times in a
  -- day is a policy that is arguing with itself.
  max_daily_changes integer not null default 1,
  floor_agorot     integer,
  ceiling_agorot   integer,

  -- 🔒 Who switched it on. This is what is written to
  -- audit_events.on_behalf_of_user_id on every automatic change, which is the
  -- whole of spec §6 rule 27: "the system did it" is not an admissible
  -- answer, so the schema refuses a policy that is on with nobody behind it.
  enabled_by_user_id uuid references auth.users (id) on delete set null,
  enabled_at       timestamptz,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint dynamic_pricing_policies_id_organization_key
    unique (id, organization_id),

  constraint dynamic_pricing_policies_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  constraint dynamic_pricing_policies_delta_range check (
    max_delta_bps between 0 and 10000),
  constraint dynamic_pricing_policies_daily_range check (
    max_daily_changes between 0 and 24),
  constraint dynamic_pricing_policies_floor_below_ceiling check (
    floor_agorot is null
    or ceiling_agorot is null
    or floor_agorot <= ceiling_agorot),
  constraint dynamic_pricing_policies_bounds_nonnegative check (
    (floor_agorot is null or floor_agorot >= 0)
    and (ceiling_agorot is null or ceiling_agorot >= 0)),

  constraint dynamic_pricing_policies_auto_is_attributed check (
    not auto_apply
    or (enabled_by_user_id is not null and enabled_at is not null)),

  constraint dynamic_pricing_policies_version_positive check (version >= 1)
);

comment on table public.dynamic_pricing_policies is
  'The conditions under which a machine may move a price without asking. Every field is a bound and all of them are ANDed (spec §6 rule 26); one failing leaves the suggestion pending for a person. enabled_by_user_id is written to audit_events.on_behalf_of_user_id on every automatic change, which is why a policy that is on with nobody behind it is not representable.';
comment on column public.dynamic_pricing_policies.max_delta_bps is
  'How far from the deterministic price a proposal may move and still apply automatically. NOT NULL with a conservative default, because an unbounded delta is the whole risk of this feature and a null some reader treats as "no limit" is that risk arriving by accident.';

create unique index if not exists dynamic_pricing_policies_org_key
  on public.dynamic_pricing_policies (organization_id)
  where property_id is null;
create unique index if not exists dynamic_pricing_policies_property_key
  on public.dynamic_pricing_policies (organization_id, property_id)
  where property_id is not null;

-- 🔒 Who switched automatic pricing on, taken from the session and never from
-- the caller. A column a writer may fill in is a column that can name somebody
-- else, and `on_behalf_of_user_id` in the audit trail is copied from here — so
-- a caller-supplied value would put an innocent person's name on every
-- automatic price change the policy ever makes.
--
-- This REPLACES `tg_touch_row` on this table rather than sitting beside it: it
-- does the same two things and adds three, and two BEFORE UPDATE triggers both
-- writing `version` would be two answers to the same question.
create or replace function public.tg_dynamic_pricing_policy_is_attributed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.updated_by := new.created_by;
    if new.auto_apply then
      new.enabled_at         := pg_catalog.now();
      new.enabled_by_user_id := (select auth.uid());
    else
      new.enabled_at         := null;
      new.enabled_by_user_id := null;
    end if;
    return new;
  end if;

  -- Restored from the row before anything is stamped, so an UPDATE that names
  -- these columns cannot rewrite who turned automatic pricing on last March.
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.enabled_at         := old.enabled_at;
  new.enabled_by_user_id := old.enabled_by_user_id;

  if new.auto_apply and not old.auto_apply then
    new.enabled_at         := pg_catalog.now();
    new.enabled_by_user_id := (select auth.uid());
  elsif old.auto_apply and not new.auto_apply then
    -- Switched off, and the name stays. A policy that ran for six months and
    -- was quietly turned off the week before somebody asked why prices moved
    -- must still say who ran it.
    null;
  end if;

  new.updated_at := pg_catalog.now();
  new.updated_by := (select auth.uid());
  new.version    := old.version + 1;
  return new;
end $$;

comment on function public.tg_dynamic_pricing_policy_is_attributed() is
  'Stamps who switched automatic pricing on and when, from auth.uid() rather than from the caller, and restores those columns from the existing row on every UPDATE so only a real transition can move them. audit_events.on_behalf_of_user_id is copied from enabled_by_user_id, so a caller-supplied value would put an innocent person name on every automatic price change the policy makes. Takes the place of tg_touch_row here so that version has exactly one writer.';

drop trigger if exists dynamic_pricing_policies_is_attributed
  on public.dynamic_pricing_policies;
create trigger dynamic_pricing_policies_is_attributed
  before insert or update on public.dynamic_pricing_policies
  for each row execute function public.tg_dynamic_pricing_policy_is_attributed();


-- ============================================================================
-- 8 · booking_price_snapshots — 🔒 the freeze
-- ============================================================================
-- The hardest thing in this specification to add afterwards, which is why it
-- is here in the migration that creates the rate card rather than in one that
-- follows it.
--
-- What this table is NOT: the price. The price is `booking_price_lines`, it is
-- written once, and `bookings.total_agorot` is a trigger-maintained sum of it.
-- This table is the EXPLANATION — why those lines and not others — and the
-- separation is what removes the temptation to recompute. There is no path
-- that reads a snapshot and produces money from it.

create table if not exists public.booking_price_snapshots (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  property_id      uuid not null,
  booking_id       uuid not null,

  -- 1, 2, 3 … Every re-pricing is a NEW ROW. Never an UPDATE, which is what
  -- the trigger below makes true rather than hoped for.
  sequence         integer not null,

  -- A content hash of inputs + resolution. Identical configurations share it,
  -- so "did anything actually change" is answerable without diffing two
  -- jsonb documents by eye, and a quote can carry it so that creating a
  -- booking from a stale quote is detectable (spec §17).
  hash             text not null,

  captured_at      timestamptz not null default now(),
  -- The date the effective-dating was resolved against. Defaults to the day
  -- the booking was created, and it is stored because `early_bird` and
  -- `last_minute` are measured from it: recomputing them against now() would
  -- make an early-bird discount evaporate at the next re-pricing (spec §6
  -- rule 36).
  effective_on     date not null,

  -- Without this, a change to the resolver code silently re-explains an old
  -- price with new logic. The number would not move — nothing recomputes it —
  -- but the explanation beside it would, which is a subtler version of the
  -- same lie.
  engine_version   text not null,

  -- Recorded, not enforced. A snapshot must outlive the plan it was priced
  -- from, so there is no foreign key here and no CASCADE: an FK would let
  -- deleting a rate plan take the explanation of a paid stay with it. The
  -- plan cannot in fact be deleted — no role holds DELETE on rate_plans — and
  -- this column is correct even if that ever changes.
  rate_plan_id     uuid,
  rate_plan_version integer,

  -- The full StayPricingRequest as it was handed to priceStay, and the
  -- per-night account of which rule won, at what specificity, what the base
  -- was, which addition applied and why, and whether the night was clamped.
  inputs           jsonb not null default '{}'::jsonb,
  resolution       jsonb not null default '{}'::jsonb,

  -- Burned here as well as on `bookings` (0009). Two copies is not
  -- duplication: the booking column is what an invoice reads, and this one is
  -- part of the explanation of how the total was reached. A VAT change on 1
  -- January must leave both alone.
  tax_rate_bps     integer,
  tourist_vat_exempt boolean not null default false,

  -- The policy AS IT WAS, copied. Not a pointer to rate_plans, because
  -- editing the plan is precisely the event this table exists to survive.
  cancellation_policy jsonb not null default '{}'::jsonb,

  -- The snapshot that replaced this one. Null is the live one. This is the
  -- only column an UPDATE may ever touch, and only from null.
  superseded_by    uuid,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,

  constraint booking_price_snapshots_id_organization_key
    unique (id, organization_id),
  constraint booking_price_snapshots_sequence_key
    unique (booking_id, sequence),

  constraint booking_price_snapshots_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id)
    on delete cascade,
  constraint booking_price_snapshots_superseded_fkey
    foreign key (superseded_by, organization_id)
    references public.booking_price_snapshots (id, organization_id)
    on delete no action,

  constraint booking_price_snapshots_sequence_positive check (sequence >= 1),
  constraint booking_price_snapshots_hash_shape check (
    hash ~ '^[0-9a-f]{8,64}$'),
  constraint booking_price_snapshots_engine_version_shape check (
    engine_version ~ '^[0-9a-z][0-9a-z.+_-]{0,39}$'),
  constraint booking_price_snapshots_documents_are_objects check (
    jsonb_typeof(inputs) = 'object'
    and jsonb_typeof(resolution) = 'object'
    and jsonb_typeof(cancellation_policy) = 'object'),
  constraint booking_price_snapshots_tax_range check (
    tax_rate_bps is null or tax_rate_bps between 0 and 10000),
  -- A snapshot cannot supersede itself, which would make the "which one is
  -- live" query return nothing at all.
  constraint booking_price_snapshots_not_self_superseding check (
    superseded_by is null or superseded_by <> id)
);

comment on table public.booking_price_snapshots is
  'Why a booking costs what it costs: the inputs, and the per-night account of which rule won and what was added. Append-only, one row per pricing, never an UPDATE. It is deliberately NOT the price — booking_price_lines is, and it is written once — because a table that held both the money and the explanation would invite recomputing the first from the second, which is how a business re-prices a stay somebody already paid for.';
comment on column public.booking_price_snapshots.sequence is
  '1, 2, 3 … Every re-pricing is a new row and the previous one is marked superseded rather than changed, so the price a guest agreed to in March is still readable in August alongside the one that replaced it.';
comment on column public.booking_price_snapshots.effective_on is
  'The date effective-dating was resolved against, stored because early_bird and last_minute are measured from it. Recomputing them against now() would make an early-bird discount evaporate at the next re-pricing (spec §6 rule 36).';
comment on column public.booking_price_snapshots.engine_version is
  'The resolver version. Without it a change to the pricing code silently re-explains an old price with new logic: the number would not move — nothing recomputes it — but the explanation beside it would, which is a subtler version of the same lie.';
comment on column public.booking_price_snapshots.cancellation_policy is
  'The policy as it was, copied rather than referenced. Editing the rate plan is precisely the event this table exists to survive, so a pointer would be false by the time anybody read it.';
comment on column public.booking_price_snapshots.superseded_by is
  'The snapshot that replaced this one; null is the live one. The only column an UPDATE may touch, and only from null — see tg_booking_price_snapshot_append_only.';

create index if not exists booking_price_snapshots_history_idx
  on public.booking_price_snapshots (booking_id, sequence desc);
-- "The one in force", which is the only question a booking screen asks.
create unique index if not exists booking_price_snapshots_live_idx
  on public.booking_price_snapshots (booking_id)
  where superseded_by is null;


-- ── Append-only, with exactly one legal mutation ────────────────────────────
-- Row-level rather than statement-level, unlike booking_status_history, and
-- the difference is the point: there IS one legitimate update here — a
-- re-pricing marking the row it replaced — and it has to be told apart from
-- every other update, which needs the row.

create or replace function public.tg_booking_price_snapshot_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Everything except `superseded_by` must be byte-identical. Listed
  -- explicitly rather than compared with `to_jsonb(new) - 'superseded_by'`,
  -- because a column added later would be silently mutable under that form and
  -- loudly refused under this one.
  if new.id                  is distinct from old.id
  or new.organization_id     is distinct from old.organization_id
  or new.property_id         is distinct from old.property_id
  or new.booking_id          is distinct from old.booking_id
  or new.sequence            is distinct from old.sequence
  or new.hash                is distinct from old.hash
  or new.captured_at         is distinct from old.captured_at
  or new.effective_on        is distinct from old.effective_on
  or new.engine_version      is distinct from old.engine_version
  or new.rate_plan_id        is distinct from old.rate_plan_id
  or new.rate_plan_version   is distinct from old.rate_plan_version
  or new.inputs              is distinct from old.inputs
  or new.resolution          is distinct from old.resolution
  or new.tax_rate_bps        is distinct from old.tax_rate_bps
  or new.tourist_vat_exempt  is distinct from old.tourist_vat_exempt
  or new.cancellation_policy is distinct from old.cancellation_policy
  or new.created_at          is distinct from old.created_at
  or new.created_by          is distinct from old.created_by
  then
    raise exception
      'booking_price_snapshots is append-only; a re-pricing is a new row'
      using errcode = '42501';
  end if;

  -- And `superseded_by` moves once, from null. Letting it be re-pointed would
  -- allow the chain to be rewritten so that a price nobody agreed to appears
  -- to be the live one.
  if old.superseded_by is not null
     and new.superseded_by is distinct from old.superseded_by then
    raise exception
      'a superseded price snapshot cannot be re-pointed at another one'
      using errcode = '42501';
  end if;

  return new;
end $$;

comment on function public.tg_booking_price_snapshot_append_only() is
  'Refuses every UPDATE to a price snapshot except setting superseded_by once, from null. Row-level rather than statement-level — unlike booking_status_history — because there is exactly one legitimate update here and telling it apart from the rest needs the row. The columns are listed explicitly so that a column added later is loudly refused rather than silently mutable.';

create or replace function public.tg_booking_price_snapshot_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Exactly the discriminator 0009 uses for booking_status_history: refuse
  -- every direct attempt, and let the ON DELETE CASCADE from a hard-deleted
  -- booking through, because by then the parent is already gone.
  if exists (select 1 from public.bookings b where b.id = old.booking_id) then
    raise exception
      'booking_price_snapshots is append-only; DELETE is not permitted while the booking exists'
      using errcode = '42501';
  end if;
  return old;
end $$;

comment on function public.tg_booking_price_snapshot_no_delete() is
  'Refuses to delete the price history of a booking that still exists. Row-level so the cascade from a hard-deleted booking passes, which is the same discriminator booking_status_history uses in 0009.';

drop trigger if exists booking_price_snapshots_append_only
  on public.booking_price_snapshots;
create trigger booking_price_snapshots_append_only
  before update on public.booking_price_snapshots
  for each row execute function public.tg_booking_price_snapshot_append_only();

drop trigger if exists booking_price_snapshots_no_delete
  on public.booking_price_snapshots;
create trigger booking_price_snapshots_no_delete
  before delete on public.booking_price_snapshots
  for each row execute function public.tg_booking_price_snapshot_no_delete();


-- ============================================================================
-- 9 · capture_booking_price_snapshot — the only way a snapshot is written
-- ============================================================================
-- SECURITY DEFINER for one reason and no other: no role is granted INSERT on
-- `booking_price_snapshots`. Recording why a price is what it is must not be
-- something a write path can skip, forget or reorder — the same argument 0009
-- makes for the status history, and the reason that table's INSERT is a
-- trigger rather than a caller's statement.
--
-- Two rows move together here: the new snapshot, and the previous live one
-- marked superseded. Two sequential statements from the request path can
-- interleave with another re-pricing and leave a booking with two live
-- snapshots or none, and the partial unique index would then reject the
-- SECOND writer — after the first had already committed a price. One
-- function, one statement pair, one lock.
--
-- Because SECURITY DEFINER bypasses row level security for this body, the
-- membership check and the permission check inside are not belt and braces:
-- they are the only authorization left.

create or replace function public.capture_booking_price_snapshot(
  p_organization_id     uuid,
  p_booking_id          uuid,
  p_hash                text,
  p_engine_version      text,
  p_effective_on        date default current_date,
  p_rate_plan_id        uuid default null,
  p_rate_plan_version   integer default null,
  p_inputs              jsonb default '{}'::jsonb,
  p_resolution          jsonb default '{}'::jsonb,
  p_tax_rate_bps        integer default null,
  p_tourist_vat_exempt  boolean default false,
  p_cancellation_policy jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_property_id uuid;
  v_previous_id uuid;
  v_sequence    integer;
  v_snapshot_id uuid;
begin
  if p_organization_id is null or p_booking_id is null then
    raise exception 'a price snapshot belongs to a booking, and one was not named'
      using errcode = '22004';
  end if;

  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  -- `booking.view_price` rather than `pricing.manage`: this records the price
  -- of a stay, which a receptionist taking a booking does, and it is not an
  -- edit to the rate card, which they may not make.
  if not public.has_permission(p_organization_id, 'booking.view_price') then
    raise exception 'booking.view_price is required to record a price'
      using errcode = '42501';
  end if;

  -- Read under a row lock, so two concurrent re-pricings serialise here
  -- rather than at the unique index — where the loser would have discovered
  -- the conflict only after computing a whole quote.
  select b.property_id into v_property_id
  from public.bookings b
  where b.id = p_booking_id and b.organization_id = p_organization_id
  for update;

  if v_property_id is null then
    raise exception 'no such booking in this organization'
      using errcode = 'no_data_found';
  end if;

  select s.id, s.sequence into v_previous_id, v_sequence
  from public.booking_price_snapshots s
  where s.booking_id = p_booking_id and s.superseded_by is null;

  -- The new id is generated here rather than by the column default, because
  -- the previous snapshot has to be marked BEFORE the new row is inserted:
  -- `booking_price_snapshots_live_idx` is unique on the booking among rows
  -- with `superseded_by is null`, so two live rows never coexist even for the
  -- width of one statement. The whole pair is one transaction, so an insert
  -- that fails rolls the mark back and the old snapshot is live again — the
  -- ordering costs nothing and buys the invariant.
  v_snapshot_id := pg_catalog.gen_random_uuid();

  if v_previous_id is not null then
    update public.booking_price_snapshots
       set superseded_by = v_snapshot_id
     where id = v_previous_id;
  end if;

  insert into public.booking_price_snapshots (
    id,
    organization_id, property_id, booking_id, sequence,
    hash, effective_on, engine_version,
    rate_plan_id, rate_plan_version,
    inputs, resolution,
    tax_rate_bps, tourist_vat_exempt, cancellation_policy,
    created_by
  ) values (
    v_snapshot_id,
    p_organization_id,
    v_property_id,
    p_booking_id,
    coalesce(v_sequence, 0) + 1,
    p_hash,
    coalesce(p_effective_on, current_date),
    p_engine_version,
    p_rate_plan_id,
    p_rate_plan_version,
    coalesce(p_inputs, '{}'::jsonb),
    coalesce(p_resolution, '{}'::jsonb),
    p_tax_rate_bps,
    coalesce(p_tourist_vat_exempt, false),
    coalesce(p_cancellation_policy, '{}'::jsonb),
    (select auth.uid())
  );

  return v_snapshot_id;
end $$;

comment on function public.capture_booking_price_snapshot(uuid, uuid, text, text, date, uuid, integer, jsonb, jsonb, integer, boolean, jsonb) is
  'The only way a price snapshot is written: no role holds INSERT on the table. Moves two rows together — the new snapshot and the previous one marked superseded — under a lock on the booking, because two sequential statements from the request path can interleave and leave a booking with two live snapshots or none. SECURITY DEFINER for that reason only; membership and booking.view_price are checked inside because RLS is bypassed for this body.';

revoke all on function public.capture_booking_price_snapshot(uuid, uuid, text, text, date, uuid, integer, jsonb, jsonb, integer, boolean, jsonb)
  from public, anon;
grant execute on function public.capture_booking_price_snapshot(uuid, uuid, text, text, date, uuid, integer, jsonb, jsonb, integer, boolean, jsonb)
  to authenticated, service_role;


-- ============================================================================
-- 10 · Row level security
-- ============================================================================
-- Enabled AND forced on every table, `anon` and `authenticated` revoked whole
-- and then granted back explicitly. A REVOKE FROM PUBLIC does not remove
-- Supabase's own grant to `anon`, which is why `anon` is named.

alter table public.rate_plans               enable row level security;
alter table public.rate_plans               force  row level security;
alter table public.rate_rules               enable row level security;
alter table public.rate_rules               force  row level security;
alter table public.rate_calendar            enable row level security;
alter table public.rate_calendar            force  row level security;
alter table public.rate_modifiers           enable row level security;
alter table public.rate_modifiers           force  row level security;
alter table public.rate_suggestions         enable row level security;
alter table public.rate_suggestions         force  row level security;
alter table public.dynamic_pricing_policies enable row level security;
alter table public.dynamic_pricing_policies force  row level security;
alter table public.booking_price_snapshots  enable row level security;
alter table public.booking_price_snapshots  force  row level security;

revoke all on public.rate_plans               from anon, authenticated;
revoke all on public.rate_rules               from anon, authenticated;
revoke all on public.rate_calendar            from anon, authenticated;
revoke all on public.rate_modifiers           from anon, authenticated;
revoke all on public.rate_suggestions         from anon, authenticated;
revoke all on public.dynamic_pricing_policies from anon, authenticated;
revoke all on public.booking_price_snapshots  from anon, authenticated;

-- A rate plan is never deleted. It is named by every snapshot that was ever
-- priced from it and by `agent_commission_rules.rate_plan_ids`, and `is_active`
-- plus `effective_to` already express "stop selling this". Deleting one would
-- make a paid stay's explanation point at nothing.
grant select, insert, update on public.rate_plans to authenticated, service_role;
revoke delete, truncate on public.rate_plans from authenticated, service_role;

-- Rules and modifiers CAN be deleted: a season typed against the wrong unit is
-- a mistake with no history worth keeping, and every booking priced from it
-- already carries its own frozen copy in a snapshot. That is the whole payoff
-- of the freeze — the rate card can be corrected freely because correcting it
-- reaches nothing that was already sold.
grant select, insert, update, delete on public.rate_rules     to authenticated, service_role;
grant select, insert, update, delete on public.rate_calendar  to authenticated, service_role;
grant select, insert, update, delete on public.rate_modifiers to authenticated, service_role;

-- A suggestion is decided, never removed: `rejected` and `expired` are the
-- record that the engine proposed something and a person said no, and
-- measuring the engine needs both.
grant select, insert, update on public.rate_suggestions to authenticated, service_role;
revoke delete, truncate on public.rate_suggestions from authenticated, service_role;

grant select, insert, update on public.dynamic_pricing_policies
  to authenticated, service_role;
revoke delete, truncate on public.dynamic_pricing_policies
  from authenticated, service_role;

-- Read only, for everybody. Written exclusively by
-- `capture_booking_price_snapshot`, which runs as the owner, and updated only
-- by that function's supersede statement — which the append-only trigger
-- allows and which nothing else can reach without an INSERT grant to pair it
-- with. Supabase's ALTER DEFAULT PRIVILEGES hands service_role everything on a
-- new table and service_role also carries BYPASSRLS, so the revoke below is
-- the only thing between a background job and a hand-edited price history.
grant select on public.booking_price_snapshots to authenticated, service_role;
revoke insert, update, delete, truncate on public.booking_price_snapshots
  from authenticated, service_role;


-- ── Policies · rate_plans ───────────────────────────────────────────────────
-- Reading the rate card and editing it are different rights, and the split is
-- the three circles of trust in spec §13: `rate.view_public` is nearly
-- everybody, `pricing.manage` is the revenue owner. The plan's own
-- `requires_grant` narrows further — an agent plan is invisible to somebody
-- without `rate.view_agent`, in the ROW rather than in the response shaping,
-- because a hidden button is not security.

drop policy if exists rate_plans_select on public.rate_plans;
create policy rate_plans_select on public.rate_plans
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'rate.view_public')
    and (requires_grant is null
         or public.has_permission(organization_id, requires_grant))
  );

drop policy if exists rate_plans_insert on public.rate_plans;
create policy rate_plans_insert on public.rate_plans
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists rate_plans_update on public.rate_plans;
create policy rate_plans_update on public.rate_plans
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'pricing.manage')
  );


-- ── Policies · rate_rules, rate_calendar, rate_modifiers ────────────────────
-- The same three questions on each: the tenant, the property scope, the
-- permission. A property manager scoped to properties [4,7] cannot read the
-- rate card of property 9 — refused by the row, not filtered from the result,
-- which is what spec §19 test 22 demands and what makes it true in an export
-- as well as on a screen.

drop policy if exists rate_rules_select on public.rate_rules;
create policy rate_rules_select on public.rate_rules
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'rate.view_public')
  );

drop policy if exists rate_rules_write on public.rate_rules;
create policy rate_rules_write on public.rate_rules
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists rate_calendar_select on public.rate_calendar;
create policy rate_calendar_select on public.rate_calendar
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'rate.view_public')
  );

drop policy if exists rate_calendar_write on public.rate_calendar;
create policy rate_calendar_write on public.rate_calendar
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists rate_modifiers_select on public.rate_modifiers;
create policy rate_modifiers_select on public.rate_modifiers
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'rate.view_public')
  );

drop policy if exists rate_modifiers_write on public.rate_modifiers;
create policy rate_modifiers_write on public.rate_modifiers
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  );


-- ── Policies · rate_suggestions and dynamic_pricing_policies ────────────────
-- `pricing.manage` to READ a suggestion, not `rate.view_public`. A
-- recommendation carries the deterministic price beside the proposal and the
-- floor beside both, which together are most of what `rate.net` protects —
-- and spec §2 gives the recommendations screen to the revenue owner alone.

drop policy if exists rate_suggestions_select on public.rate_suggestions;
create policy rate_suggestions_select on public.rate_suggestions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists rate_suggestions_insert on public.rate_suggestions;
create policy rate_suggestions_insert on public.rate_suggestions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists rate_suggestions_update on public.rate_suggestions;
create policy rate_suggestions_update on public.rate_suggestions
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists dynamic_pricing_policies_select
  on public.dynamic_pricing_policies;
create policy dynamic_pricing_policies_select on public.dynamic_pricing_policies
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists dynamic_pricing_policies_insert
  on public.dynamic_pricing_policies;
create policy dynamic_pricing_policies_insert on public.dynamic_pricing_policies
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists dynamic_pricing_policies_update
  on public.dynamic_pricing_policies;
create policy dynamic_pricing_policies_update on public.dynamic_pricing_policies
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'pricing.manage')
  );


-- ── Policies · booking_price_snapshots ──────────────────────────────────────
-- SELECT only, and gated on `booking.view_price` rather than on
-- `rate.view_public`: the snapshot explains what one guest was charged, which
-- is a different circle of trust from the rate card (spec §13). An agent who
-- may quote from the public rates has no business reading the resolution of
-- somebody else's stay.

drop policy if exists booking_price_snapshots_select
  on public.booking_price_snapshots;
create policy booking_price_snapshots_select on public.booking_price_snapshots
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view_price')
  );


-- ============================================================================
-- 11 · Rehearsal
-- ============================================================================
-- Exercised, not asserted. The behavioural half runs against TEMPORARY tables
-- created with `like public.x including all`, which the server fills in from
-- its own catalogue — so the CHECK constraints, defaults and exclusion
-- constraints exercised below are the real ones rather than a copy this file
-- typed out, and no seeded organization is needed. What LIKE does not copy is
-- foreign keys and row level security, so those two are checked structurally.

do $$
declare
  v_specificity smallint;
  v_offending   text;
  v_superseded  uuid;
begin
  /* ── the specificity ladder, run against real inputs ─────────────────── */

  if public.rate_rule_specificity('unit', array[5,6]::smallint[]) <> 80 then
    raise exception 'a weekday rule on a unit is not the second rung';
  end if;
  if public.rate_rule_specificity('unit', '{}'::smallint[]) <> 70 then
    raise exception 'a plain unit rule is not the third rung';
  end if;
  if public.rate_rule_specificity('unit_group', array[5]::smallint[]) <> 60 then
    raise exception 'a weekday rule on a unit group is not the fourth rung';
  end if;
  if public.rate_rule_specificity('unit_group', '{}'::smallint[]) <> 50 then
    raise exception 'a plain unit group rule is not the fifth rung';
  end if;
  if public.rate_rule_specificity('property', array[5,6]::smallint[]) <> 40 then
    raise exception 'a weekday rule on a property is not the sixth rung';
  end if;
  if public.rate_rule_specificity('property', '{}'::smallint[]) <> 30 then
    raise exception 'a plain property rule is not the seventh rung';
  end if;
  -- The ladder must be strictly descending, or two rungs tie and the whole
  -- resolution order collapses into the id tie-breaker.
  if not (public.rate_rule_specificity('unit', array[5]::smallint[])
          > public.rate_rule_specificity('unit', '{}'::smallint[])
          and public.rate_rule_specificity('unit', '{}'::smallint[])
          > public.rate_rule_specificity('unit_group', array[5]::smallint[])
          and public.rate_rule_specificity('unit_group', array[5]::smallint[])
          > public.rate_rule_specificity('unit_group', '{}'::smallint[])
          and public.rate_rule_specificity('unit_group', '{}'::smallint[])
          > public.rate_rule_specificity('property', array[5]::smallint[])
          and public.rate_rule_specificity('property', array[5]::smallint[])
          > public.rate_rule_specificity('property', '{}'::smallint[])) then
    raise exception 'the specificity ladder is not strictly descending';
  end if;

  /* ── the weekday guard ───────────────────────────────────────────────── */

  if not public.rate_weekdays_valid('{}'::smallint[]) then
    raise exception 'an empty weekday set — meaning every day — is refused';
  end if;
  if not public.rate_weekdays_valid(array[5,6]::smallint[]) then
    raise exception 'the Israeli weekend is refused';
  end if;
  if public.rate_weekdays_valid(array[5,5,6]::smallint[]) then
    raise exception 'a duplicated weekday is accepted, so two arrays price alike';
  end if;
  if public.rate_weekdays_valid(array[7]::smallint[]) then
    raise exception 'a day of week outside 0..6 is accepted';
  end if;
  if public.rate_weekdays_valid(array[-1]::smallint[]) then
    raise exception 'a negative day of week is accepted';
  end if;

  /* ── the derivation shape guard ──────────────────────────────────────── */

  if not public.rate_plan_derivation_valid(null) then
    raise exception 'an independent rate plan is refused';
  end if;
  if not public.rate_plan_derivation_valid(
    ('{"from_rate_plan_id":"00000000-0000-4000-8000-000000000000",'
     || '"adjust":{"kind":"percent","value":-1000}}')::jsonb) then
    raise exception 'a well-formed derivation is refused';
  end if;
  if public.rate_plan_derivation_valid('{"adjust":{"kind":"percent","value":1}}'::jsonb) then
    raise exception 'a derivation could name no parent plan';
  end if;
  if public.rate_plan_derivation_valid(
    ('{"from_rate_plan_id":"00000000-0000-4000-8000-000000000000",'
     || '"adjust":{"kind":"multiply","value":2}}')::jsonb) then
    raise exception 'a derivation could adjust in a way no resolver implements';
  end if;
  if public.rate_plan_derivation_valid(
    ('{"from_rate_plan_id":"00000000-0000-4000-8000-000000000000",'
     || '"adjust":{"kind":"percent","value":"a lot"}}')::jsonb) then
    raise exception 'a derivation adjustment could be a string';
  end if;
  if public.rate_plan_derivation_valid('[]'::jsonb) then
    raise exception 'a derivation could be an array';
  end if;

  /* ── rate_plans: the floor cannot sit above the ceiling ──────────────── */

  execute 'drop table if exists pg_temp.rate_plans_rehearsal';
  execute 'create temp table rate_plans_rehearsal
             (like public.rate_plans including all)';

  begin
    execute 'insert into pg_temp.rate_plans_rehearsal
               (organization_id, code, name, floor_agorot, ceiling_agorot)
             values ($1, $2, $3, 220000, 90000)'
      using '00000000-0000-4000-8000-000000000000'::uuid, 'direct', 'ישיר';
    raise exception
      'a rate plan could have a floor above its ceiling, so every night both clamps and fails';
  exception
    when check_violation then null;
  end;

  begin
    execute 'insert into pg_temp.rate_plans_rehearsal
               (organization_id, code, name) values ($1, $2, $3)'
      using '00000000-0000-4000-8000-000000000000'::uuid, 'Direct Rate', 'ישיר';
    raise exception 'a rate plan code could be something no url or import can carry';
  exception
    when check_violation then null;
  end;

  begin
    execute 'insert into pg_temp.rate_plans_rehearsal
               (organization_id, code, name, effective_from, effective_to)
             values ($1, $2, $3, ''2026-05-01'', ''2026-01-01'')'
      using '00000000-0000-4000-8000-000000000000'::uuid, 'ota', 'OTA';
    raise exception 'a rate plan could end before it began';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.rate_plans_rehearsal';

  /* ── rate_rules: specificity is computed, and ambiguity is refused ───── */

  execute 'drop table if exists pg_temp.rate_rules_rehearsal';
  execute 'create temp table rate_rules_rehearsal
             (like public.rate_rules including all)';
  execute 'create trigger rehearsal_specificity
             before insert or update on pg_temp.rate_rules_rehearsal
             for each row execute function public.tg_rate_rule_specificity()';

  -- The writer says 100 — the calendar's rung, which no rule may claim — and
  -- the trigger discards it.
  execute 'insert into pg_temp.rate_rules_rehearsal
             (id, organization_id, property_id, rate_plan_id, scope_kind,
              scope_id, specificity, date_from, date_to, weekdays,
              nightly_agorot, priority, effective_from)
           values ($1, $2, $3, $4, ''unit'', $5, 100,
                   ''2026-09-25'', ''2026-10-16'', array[5,6]::smallint[],
                   140000, 0, ''2026-01-01'')'
    using '00000000-0000-4000-8000-00000000000a'::uuid,
          '00000000-0000-4000-8000-000000000000'::uuid,
          '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid,
          '00000000-0000-4000-8000-000000000003'::uuid;

  execute 'select specificity from pg_temp.rate_rules_rehearsal'
    into v_specificity;
  if v_specificity <> 80 then
    raise exception
      'a caller could set its own specificity, so a property rule can outrank a unit rule';
  end if;

  -- The same scope, specificity and priority, over an overlapping season and
  -- an overlapping validity window: no defined winner, refused.
  begin
    execute 'insert into pg_temp.rate_rules_rehearsal
               (organization_id, property_id, rate_plan_id, scope_kind,
                scope_id, date_from, date_to, weekdays, nightly_agorot, priority)
             values ($1, $2, $3, ''unit'', $4,
                     ''2026-10-01'', ''2026-10-20'', array[5,6]::smallint[],
                     190000, 0)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000003'::uuid;
    raise exception
      'two rules could tie on the same night, so a quote depends on which uuid was generated';
  exception
    when exclusion_violation then null;
  end;

  -- The correction of spec §6 rule 39 is NOT refused: same season, same
  -- priority, later validity window. If this raised, editing a rule would be
  -- impossible without destroying the row it replaced.
  execute 'update pg_temp.rate_rules_rehearsal
             set effective_to = ''2026-06-01'' where id = $1'
    using '00000000-0000-4000-8000-00000000000a'::uuid;
  execute 'insert into pg_temp.rate_rules_rehearsal
             (organization_id, property_id, rate_plan_id, scope_kind,
              scope_id, date_from, date_to, weekdays, nightly_agorot,
              priority, effective_from)
           values ($1, $2, $3, ''unit'', $4,
                   ''2026-09-25'', ''2026-10-16'', array[5,6]::smallint[],
                   155000, 0, ''2026-06-01'')'
    using '00000000-0000-4000-8000-000000000000'::uuid,
          '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid,
          '00000000-0000-4000-8000-000000000003'::uuid;

  -- A price fifty times what anybody charges is a finger that slipped.
  begin
    execute 'insert into pg_temp.rate_rules_rehearsal
               (organization_id, property_id, rate_plan_id, scope_kind,
                scope_id, date_from, date_to, nightly_agorot, priority)
             values ($1, $2, $3, ''property'', $4,
                     ''2027-01-01'', ''2027-02-01'', 900000000, 5)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'a night could cost ₪9,000,000';
  exception
    when check_violation then null;
  end;

  -- And the computed specificity survives a writer that reached past the
  -- trigger entirely: the CHECK still holds it to the ladder.
  execute 'alter table pg_temp.rate_rules_rehearsal disable trigger rehearsal_specificity';
  begin
    execute 'insert into pg_temp.rate_rules_rehearsal
               (organization_id, property_id, rate_plan_id, scope_kind,
                scope_id, specificity, date_from, date_to, nightly_agorot)
             values ($1, $2, $3, ''property'', $4, 100,
                     ''2028-01-01'', ''2028-02-01'', 100000)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000004'::uuid;
    raise exception
      'a writer past the trigger could store a rung that is not on the ladder';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.rate_rules_rehearsal';

  /* ── rate_calendar: an AI price names its suggestion and its approver ── */

  execute 'drop table if exists pg_temp.rate_calendar_rehearsal';
  execute 'create temp table rate_calendar_rehearsal
             (like public.rate_calendar including all)';

  begin
    execute 'insert into pg_temp.rate_calendar_rehearsal
               (organization_id, property_id, unit_id, rate_plan_id, date,
                nightly_agorot, source)
             values ($1, $2, $3, $4, ''2026-10-03'', 161000, ''ai_approved'')'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000003'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid;
    raise exception
      'a machine could set a price with no suggestion and nobody approving it';
  exception
    when check_violation then null;
  end;

  begin
    execute 'insert into pg_temp.rate_calendar_rehearsal
               (organization_id, property_id, unit_id, rate_plan_id, date,
                nightly_agorot, source, suggestion_id)
             values ($1, $2, $3, $4, ''2026-10-03'', 161000, ''manual'', $5)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000003'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000009'::uuid;
    raise exception
      'a hand-typed price could claim it came from a recommendation';
  exception
    when check_violation then null;
  end;

  -- The legitimate one is accepted, which is the half that proves the CHECK
  -- above is a rule rather than a wall.
  execute 'insert into pg_temp.rate_calendar_rehearsal
             (organization_id, property_id, unit_id, rate_plan_id, date,
              nightly_agorot, source, suggestion_id, approved_by)
           values ($1, $2, $3, $4, ''2026-10-03'', 161000, ''ai_approved'', $5, $6)'
    using '00000000-0000-4000-8000-000000000000'::uuid,
          '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000003'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid,
          '00000000-0000-4000-8000-000000000009'::uuid,
          '00000000-0000-4000-8000-00000000000b'::uuid;

  execute 'drop table pg_temp.rate_calendar_rehearsal';

  /* ── dynamic_pricing_policies: automatic with nobody behind it ───────── */

  execute 'drop table if exists pg_temp.dpp_rehearsal';
  execute 'create temp table dpp_rehearsal
             (like public.dynamic_pricing_policies including all)';
  execute 'create trigger rehearsal_dpp_attributed
             before insert or update on pg_temp.dpp_rehearsal
             for each row execute function public.tg_dynamic_pricing_policy_is_attributed()';

  begin
    execute 'insert into pg_temp.dpp_rehearsal
               (organization_id, max_delta_bps) values ($1, 90000)'
      using '00000000-0000-4000-8000-000000000000'::uuid;
    raise exception 'a policy could allow a price to move by 900 percent';
  exception
    when check_violation then null;
  end;

  -- Without the trigger, automatic pricing with nobody behind it is not
  -- representable at all. Proven by disabling the trigger and trying — the
  -- CHECK has to hold on its own, because a writer that reaches past the
  -- trigger is exactly the writer this rule exists for.
  execute 'alter table pg_temp.dpp_rehearsal disable trigger rehearsal_dpp_attributed';
  begin
    execute 'insert into pg_temp.dpp_rehearsal (organization_id, auto_apply)
             values ($1, true)'
      using '00000000-0000-4000-8000-000000000000'::uuid;
    raise exception
      'automatic pricing could be switched on with nobody behind it, and "the system did it" would be the only answer anybody ever got';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.dpp_rehearsal';

  /* ── booking_price_snapshots: the freeze, exercised ──────────────────── */

  execute 'drop table if exists pg_temp.snapshots_rehearsal';
  execute 'create temp table snapshots_rehearsal
             (like public.booking_price_snapshots including all)';
  execute 'create trigger rehearsal_append_only
             before update on pg_temp.snapshots_rehearsal
             for each row execute function public.tg_booking_price_snapshot_append_only()';

  execute 'insert into pg_temp.snapshots_rehearsal
             (id, organization_id, property_id, booking_id, sequence, hash,
              effective_on, engine_version, inputs, resolution)
           values ($1, $2, $3, $4, 1, ''a1b2c3d4'', ''2026-03-02'', ''1.0.0'',
                   ''{"nights":3}''::jsonb, ''{"02/10":{"base":140000}}''::jsonb)'
    using '00000000-0000-4000-8000-0000000000f1'::uuid,
          '00000000-0000-4000-8000-000000000000'::uuid,
          '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000005'::uuid;

  -- 🔒 The one that matters: the resolution of a stay somebody already paid
  -- for cannot be rewritten to say something else.
  begin
    execute 'update pg_temp.snapshots_rehearsal
               set resolution = ''{"02/10":{"base":95000}}''::jsonb';
    raise exception
      'a booking price explanation could be rewritten in place, so a paid stay can be re-priced silently';
  exception
    when insufficient_privilege then null;
  end;

  begin
    execute 'update pg_temp.snapshots_rehearsal set inputs = ''{"nights":2}''::jsonb';
    raise exception 'the inputs a price was computed from could be edited afterwards';
  exception
    when insufficient_privilege then null;
  end;

  begin
    execute 'update pg_temp.snapshots_rehearsal set effective_on = ''2026-08-01''';
    raise exception
      'the effective date could be moved, so an early-bird discount evaporates on the next read';
  exception
    when insufficient_privilege then null;
  end;

  -- A re-pricing IS allowed: the first row marked superseded, then a second
  -- row. That order, and not the other one — the partial unique index refuses
  -- two live snapshots even for the width of one statement, which is what
  -- `capture_booking_price_snapshot` is built around.
  execute 'update pg_temp.snapshots_rehearsal set superseded_by = $1 where id = $2'
    using '00000000-0000-4000-8000-0000000000f2'::uuid,
          '00000000-0000-4000-8000-0000000000f1'::uuid;

  execute 'insert into pg_temp.snapshots_rehearsal
             (id, organization_id, property_id, booking_id, sequence, hash,
              effective_on, engine_version)
           values ($1, $2, $3, $4, 2, ''d4c3b2a1'', ''2026-03-02'', ''1.0.0'')'
    using '00000000-0000-4000-8000-0000000000f2'::uuid,
          '00000000-0000-4000-8000-000000000000'::uuid,
          '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000005'::uuid;

  execute 'select superseded_by from pg_temp.snapshots_rehearsal where id = $1'
    into v_superseded
    using '00000000-0000-4000-8000-0000000000f1'::uuid;
  if v_superseded is null then
    raise exception
      'a re-pricing could not mark the snapshot it replaced, so both would look live';
  end if;

  -- And it moves once. Re-pointing the chain would let a price nobody agreed
  -- to become the live one.
  begin
    execute 'update pg_temp.snapshots_rehearsal set superseded_by = $1 where id = $2'
      using '00000000-0000-4000-8000-0000000000f3'::uuid,
            '00000000-0000-4000-8000-0000000000f1'::uuid;
    raise exception 'the supersession chain could be rewritten';
  exception
    when insufficient_privilege then null;
  end;

  -- Two live snapshots on one booking is not representable, so "what does
  -- this booking cost" has exactly one answer.
  begin
    execute 'insert into pg_temp.snapshots_rehearsal
               (organization_id, property_id, booking_id, sequence, hash,
                effective_on, engine_version)
             values ($1, $2, $3, 3, ''0f0f0f0f'', ''2026-03-02'', ''1.0.0'')'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000005'::uuid;
    raise exception 'a booking could have two live price snapshots at once';
  exception
    when unique_violation then null;
  end;

  execute 'drop table pg_temp.snapshots_rehearsal';

  /* ── what LIKE does not copy: privileges and row level security ───────── */

  select string_agg(c.relname, ', ') into v_offending
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('rate_plans', 'rate_rules', 'rate_calendar',
                      'rate_modifiers', 'rate_suggestions',
                      'dynamic_pricing_policies', 'booking_price_snapshots')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_offending is not null then
    raise exception 'row level security is not enabled and forced on: %', v_offending;
  end if;

  select string_agg(distinct table_name || ' → ' || grantee::text, ', ')
    into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('rate_plans', 'rate_rules', 'rate_calendar',
                       'rate_modifiers', 'rate_suggestions',
                       'dynamic_pricing_policies', 'booking_price_snapshots')
    and grantee in ('anon', 'PUBLIC');
  if v_offending is not null then
    raise exception 'the rate card is reachable without signing in: %', v_offending;
  end if;

  -- 🔒 Nobody may write a price snapshot directly. The whole freeze rests on
  -- this: if a request path could INSERT here, it could also write a snapshot
  -- that disagrees with the price lines, and the two would drift apart with
  -- no way to tell which was right. The owner's own grants are not in scope —
  -- the triggers and the definer function run as the owner, which is the
  -- point — so the grantee list names the roles a request can actually arrive
  -- as.
  select string_agg(distinct grantee::text || ' ' || privilege_type, ', ')
    into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'booking_price_snapshots'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC');
  if v_offending is not null then
    raise exception
      'a price snapshot can be written outside capture_booking_price_snapshot: %',
      v_offending;
  end if;

  select string_agg(distinct table_name || ' → ' || grantee::text, ', ')
    into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('rate_plans', 'rate_suggestions',
                       'dynamic_pricing_policies')
    and privilege_type in ('DELETE', 'TRUNCATE')
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC');
  if v_offending is not null then
    raise exception
      'a rate plan, a suggestion or a policy can be deleted, so what priced a paid stay is erasable: %',
      v_offending;
  end if;

  -- Every policy on every table asks all three questions. A policy that named
  -- the tenant and forgot the permission would let anybody in the business
  -- rewrite the rate card.
  select string_agg(c.relname || '.' || p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('rate_plans', 'rate_rules', 'rate_calendar',
                      'rate_modifiers', 'rate_suggestions',
                      'dynamic_pricing_policies', 'booking_price_snapshots')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%my_organizations%';
  if v_offending is not null then
    raise exception 'policies without a tenant boundary: %', v_offending;
  end if;

  select string_agg(c.relname || '.' || p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('rate_plans', 'rate_rules', 'rate_calendar',
                      'rate_modifiers', 'rate_suggestions',
                      'dynamic_pricing_policies', 'booking_price_snapshots')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%property_in_scope%';
  if v_offending is not null then
    raise exception 'policies without a property scope: %', v_offending;
  end if;

  select string_agg(c.relname || '.' || p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('rate_plans', 'rate_rules', 'rate_calendar',
                      'rate_modifiers', 'rate_suggestions',
                      'dynamic_pricing_policies', 'booking_price_snapshots')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%has_permission%';
  if v_offending is not null then
    raise exception 'policies that ask for no permission: %', v_offending;
  end if;

  -- Every function this migration adds pins its search_path. One that did not
  -- could be made to resolve `bookings` to a table an attacker controls.
  select string_agg(p.proname, ', ') into v_offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('rate_rule_specificity', 'rate_weekdays_valid',
                      'rate_plan_derivation_valid', 'tg_rate_rule_specificity',
                      'tg_booking_price_snapshot_append_only',
                      'tg_booking_price_snapshot_no_delete',
                      'capture_booking_price_snapshot')
    and (p.proconfig is null
         or array_to_string(p.proconfig, ',') not like '%search_path=%');
  if v_offending is not null then
    raise exception 'functions with a mutable search_path: %', v_offending;
  end if;

  -- Supabase ALTER DEFAULT PRIVILEGES grants `anon` EXECUTE on every new
  -- function in `public`, and a REVOKE FROM PUBLIC leaves that grant standing
  -- — 0004 found this against pg_proc.proacl rather than assuming it. So the
  -- revoke names `anon`, and this checks that it took.
  select string_agg(distinct routine_name || ' → ' || grantee::text, ', ')
    into v_offending
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('capture_booking_price_snapshot',
                         'rate_rule_specificity', 'rate_weekdays_valid',
                         'rate_plan_derivation_valid')
    and grantee in ('anon', 'PUBLIC');
  if v_offending is not null then
    raise exception 'anon may execute a pricing function: %', v_offending;
  end if;

  -- The definer function must be a definer function. If it were ever changed
  -- to INVOKER it would fail for everybody rather than once, because no role
  -- holds INSERT on the table it writes.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'capture_booking_price_snapshot'
      and p.prosecdef
  ) then
    raise exception
      'capture_booking_price_snapshot is not SECURITY DEFINER, so nothing can write a snapshot at all';
  end if;

  -- The tenant guard, run rather than read. As the migration role there is no
  -- auth.uid(), so my_organizations() is empty and every organization is
  -- foreign — which is exactly the case that must be refused. If this stops
  -- raising, the function has stopped checking membership, and any signed-in
  -- user could write a price explanation into a business they have never
  -- worked for.
  begin
    perform public.capture_booking_price_snapshot(
      '00000000-0000-4000-8000-000000000000'::uuid,
      '00000000-0000-4000-8000-000000000005'::uuid,
      'a1b2c3d4',
      '1.0.0');
    raise exception
      'capture_booking_price_snapshot accepted an organization the caller is not in';
  exception
    when insufficient_privilege then null;
  end;

  if exists (select 1 from public.rate_plans)
  or exists (select 1 from public.rate_rules)
  or exists (select 1 from public.rate_calendar)
  or exists (select 1 from public.booking_price_snapshots) then
    raise exception 'the rehearsal left a price behind';
  end if;
end $$;
