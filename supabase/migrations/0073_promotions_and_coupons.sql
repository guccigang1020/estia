-- ============================================================================
-- 0073_promotions_and_coupons.sql — ESTIA · the campaign catalogue, and the
-- one thing a campaign catalogue has to get right
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- `docs/spec/20-pricing.md` §3.5 defines `promotions`, `coupons` and
-- `discount_redemptions`. None of the three exists. `promotion` is today a
-- member of `PRICE_LINE_KINDS` — a line on a booking — and the screen at
-- `/promotions` says so in its own header, at length, and renders commission
-- rules instead of campaign cards because drawing cards over nothing would
-- let a business plan a season around tiles that apply to no booking.
--
-- That sentence stops being true here.
--
-- ── THE RULE THIS FILE EXISTS FOR ──────────────────────────────────────────
--
-- **A coupon is redeemed at most the number of times it says it may be.**
--
-- Two guests submit `SUMMER25` in the same millisecond against a limit of one.
-- The tempting implementation reads the count, compares it to the limit and
-- inserts. Both reads return zero, both comparisons pass, both rows land, and
-- the business has given away twice what it agreed to. No amount of care in
-- TypeScript fixes that, because the losing step is not a decision — it is the
-- gap between a read and a write, and the only place that gap can be closed is
-- the database.
--
-- So the limit is held by TWO mechanisms, and it matters which one is which:
--
--   1. **A serialising row lock, for the friendly refusal.**
--      `public.redeem_discount` opens with `select … for update` on the
--      promotion (or coupon) row. Two concurrent redemptions of the same code
--      are thereby ordered: the second waits. When it resumes it counts the
--      redemptions in a NEW statement, and under READ COMMITTED — which is
--      what PostgREST and every request path here run at — a new statement
--      takes a NEW snapshot, so it sees the row the first caller committed. It
--      computes ordinal 2 against a limit of 1 and raises a refusal a person
--      can read: "הקופון כבר מומש".
--
--   2. **A unique index on the allocated ordinal, which is what actually
--      holds the line.**
--      `discount_redemptions.redemption_index` is unique per promotion and per
--      coupon. Mechanism 1 is an argument about snapshot behaviour; mechanism 2
--      is a fact about an index. If the argument is ever wrong — a caller runs
--      at REPEATABLE READ, where the waiting transaction keeps its original
--      snapshot and counts zero; a future writer reaches past the function; a
--      replica lags — both callers compute ordinal 1, and the second INSERT is
--      refused by the index with 23505. There is no interleaving in which two
--      rows carry the same ordinal for the same coupon, because that is what a
--      unique index means.
--
--      The rehearsal at the foot of this file inserts that second row against
--      the real index and requires the refusal. It is the guard a reader will
--      most doubt, so it is the one that is executed rather than described.
--
--   `single_use` is not a third mechanism. §3.5 asks for
--   `unique (coupon_id) where single_use`, which cannot be written: a partial
--   index may not read a column in another table. It is expressed instead as
--   `check (not single_use or max_redemptions = 1)` on `coupons` — the same
--   guarantee, stated where it is checkable, and then enforced by 1 and 2.
--
-- **`budget_agorot` is weaker, and this file says so rather than implying
-- otherwise.** A cumulative-spend ceiling is a sum across rows, and no
-- constraint in PostgreSQL can express one. It is held by the row lock alone.
-- That is genuinely less than the redemption cap, and the honest consequence
-- is that a budget can be overshot by one redemption if a caller runs at an
-- isolation level the lock does not serialise. The redemption count cannot.
--
-- ── THE SECOND RULE: A DISCOUNT GIVEN IN MARCH IS PART OF WHAT IS OWED ─────
--
-- Editing a promotion must not change a booking already taken. Three things
-- make that true, and none of them is a second freezing mechanism:
--
--   · **The money already lives in `booking_price_lines`** (0009), written
--     once. `bookings.total_agorot` is a trigger-maintained sum of those
--     lines. Nothing in this file recomputes a price, and there is no read
--     path from `promotions` to an existing booking.
--
--   · **`discount_redemptions` freezes the TERMS as well as the amount.**
--     `terms` holds the discount kind, the value, the basis and the code as
--     they stood at the instant of redemption, and the row is append-only:
--     privileges revoked, a statement-level trigger refusing UPDATE, and a
--     row-level trigger refusing DELETE while the booking still exists —
--     precisely the treatment `booking_status_history` gets in 0009.
--
--   · **`price_line_id` points at the exact money.** A redemption may name the
--     `booking_price_lines` row it produced, and `redeem_discount` refuses the
--     pair unless that line belongs to the same booking and its
--     `amount_agorot` is the exact negation of the redemption's. Two copies of
--     a number that can never disagree, because the one write that creates
--     both checks them against each other and nothing may edit either after.
--
--   `booking_price_snapshots` (0072, spec §3.7) is the third leg and it is
--   DELIBERATELY NOT REFERENCED BY A FOREIGN KEY HERE. It is another author's
--   table landing in the same wave; a composite FK onto a column name this
--   file has only read in prose would be a migration that cannot run, and an
--   unrunnable migration is an unreviewed one. The join is
--   `discount_redemptions.booking_id` → `booking_price_snapshots.booking_id`,
--   which needs no column from this file to be correct, and a later migration
--   may narrow it once 0072 is applied. Inventing a private snapshot column
--   here to avoid the dependency would have been the second freezing
--   mechanism the brief forbids.
--
-- ── THE THIRD RULE: A CODE IS COMPARED FOLDED AND STORED AS TYPED ──────────
--
-- A guest typing `summer25` must match the coupon printed as `SUMMER25`, and
-- the card in their hand must still read `SUMMER25`. So `code` is stored
-- exactly as the issuer typed it, and `code_folded` is a STORED GENERATED
-- column — `upper(btrim(code))` — carrying the unique index. A generated
-- column rather than an expression index on purpose: the fold is then visible
-- in `\d coupons`, so nobody writes a lookup on `code` and wonders why a
-- lowercase code was rejected as unknown.
--
-- The consequence is that §8's `^[A-Z0-9-]+$` for a coupon code is relaxed
-- here to accept either case. That pattern describes how a code is PRINTED. A
-- CHECK that refused `Summer25` at issue time would make the fold pointless in
-- the only direction it is ever used, and would put a validation error in
-- front of a business that typed its own campaign name in the wrong shift
-- state. Promotion codes keep §8's lowercase rule, because a promotion code is
-- a machine identifier that no guest ever types.
--
-- ── MONEY IS INTEGER AGOROT, AND THE PERCENTAGE ROUNDS ONE WAY ─────────────
--
-- Every amount here is `integer` agorot. Every percentage is `integer` basis
-- points, for `properties.tax_rate_bps`'s reason: a rate stored as `0.05`
-- produces an invoice that does not add up.
--
-- The rounding of a percentage discount happens exactly once, in
-- `src/lib/promotions/discount.ts`, using `roundAgorot` from
-- `src/lib/booking/pricing.ts` — half away from zero on the magnitude, which
-- for a discount means the half-agora goes to the guest. There is no second
-- definition and this file does not add one: the database stores the rate, not
-- the result, so there is nothing here to round. That is deliberate. A
-- computed-discount column would be a second answer to a question that already
-- has one, and the two would drift the first time the rounding rule was
-- touched.
--
-- ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
--
-- **A coupon redemption does not consume its parent promotion's limit.** A
-- coupon carries its own `max_redemptions`, `max_per_guest` and
-- `budget_agorot`, and `promotion_id` is a lineage link for reporting. The
-- alternative — a coupon decrementing both — would make `max_redemptions` on a
-- campaign mean two different things depending on how the discount reached the
-- booking, and no screen could then state what a number on it meant.
--
-- **`coupons` does not carry `kind`, `stackable`, `exclusive_group` or
-- `priority`.** Those four exist to order campaigns against each other in
-- §7.9. Rule 30 says a coupon is a separate axis applied after the promotions,
-- at most one per booking — so a coupon never enters that ordering and columns
-- describing its place in it would be columns nothing could read.
--
-- **A coupon's discount terms are copied from its promotion, not inherited.**
-- `coupons.discount_kind` / `discount_value` / `applies_to` are NOT NULL and
-- are written at issue time. A coupon is a printed promise; a campaign whose
-- percentage is edited next month must not change what a card handed out today
-- is worth. That is the same law as the booking freeze, one level up.
--
-- Depends on 0001 (`organizations`, `tg_touch_row`), 0004 (`my_organizations`,
-- `has_permission`), 0008 (`properties`, `property_in_scope`) and 0009
-- (`bookings`, `guests`, `booking_price_lines`, `booking_source`).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · A key on somebody else's table
-- ============================================================================
-- `booking_price_lines` has only a primary key on `id`, so nothing can name it
-- tenant-safely. Every cross-table reference in this schema is composite —
-- `(id, organization_id)` — because a plain `references x (id)` accepts a
-- stranger's uuid and the database has no way to notice.
--
-- This is exactly what `0062_composite_keys_for_inbox_references.sql` did for
-- three tables the unified inbox needed to point at, and its argument applies
-- unchanged: `id` is already the primary key, so `unique (id, organization_id)`
-- adds no uniqueness that was not already enforced. No insert anywhere can
-- begin failing because of it. It exists to be pointed at, not to reject.
--
-- 0062 made the case that a change to another module's table deserves its own
-- migration rather than being buried mid-feature. That is still right, and it
-- is not available: this slice was allotted one migration number. So it is the
-- first section instead of a separate file, under its own heading, ahead of
-- everything it is needed for.

alter table public.booking_price_lines
  drop constraint if exists booking_price_lines_id_organization_key;
alter table public.booking_price_lines
  add constraint booking_price_lines_id_organization_key
  unique (id, organization_id);


-- ============================================================================
-- 2 · The three closed vocabularies
-- ============================================================================
-- Enums rather than `text` + CHECK, which is what §3.5 writes. An enum makes
-- the set legible in `\d`, refuses a typo at the point of the write rather
-- than in a constraint message, and cannot be widened by accident.
--
-- The names are prefixed `promotion_` on purpose. `0072_pricing.sql` is being
-- written in parallel and creates `rate_plan_kind`, `rate_scope`,
-- `rate_calendar_source` and `rate_modifier_kind`; a bare `discount_kind` here
-- is a name a neighbouring migration could plausibly want, and two migrations
-- racing for one type name is a deployment that fails on somebody else's
-- machine.

do $$ begin
  -- Transcribed from `promotion_kind` in docs/spec/20-pricing.md §3.5, and
  -- mirrored by PROMOTION_KINDS in src/lib/promotions/types.ts.
  create type public.promotion_kind as enum (
    'early_bird',
    'last_minute',
    'midweek',
    'long_stay',
    'repeat_guest',
    'direct_booking',
    'agent_campaign'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.promotion_discount_kind as enum (
    -- `discount_value` is basis points: 500 = 5%. See the header.
    'percent',
    -- `discount_value` is agorot.
    'fixed',
    -- `discount_value` is a whole number of nights. The agorot such a discount
    -- is worth cannot be known from this table — it depends on which nights
    -- were sold and at what nightly rate — so it is resolved in
    -- src/lib/promotions/discount.ts against the real nightly amounts, and
    -- never estimated here.
    'free_nights'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  -- §6 rule 32. A discount lands on the stay or on the accommodation lines
  -- alone, and never on VAT and never on a security deposit — the first is
  -- somebody else's money and the second is the guest's own, held.
  create type public.promotion_applies_to as enum (
    'stay_total',
    'accommodation_only'
  );
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 3 · The condition language, closed on purpose
-- ============================================================================
-- §7.6. Six node shapes and nothing else, the same argument as
-- `QuantityExpression` in `src/lib/preparation/types.ts`: what the language
-- cannot say is a SECOND PROMOTION, not a bigger language. A grammar that
-- grows to fit every campaign becomes a program nobody can audit, stored in a
-- column, deciding what customers pay.
--
-- The validator is a function rather than an inline CHECK expression for
-- 0067's reason: the rehearsal at the foot of this file RUNS it against real
-- values. A guard nobody has executed is a guard whose behaviour nobody knows.
--
-- The TypeScript evaluator in `src/lib/promotions/conditions.ts` reads the same
-- shapes and fails closed on a fact it was not given. Postgres cannot know a
-- booking's facts, so it checks the SHAPE and the evaluator checks the truth —
-- the same division 0067 draws around `template_id`.

-- Six levels. A condition tree is a business rule a person has to be able to
-- read aloud on the phone; past six nestings nobody can, and the honest fix is
-- two promotions in an `exclusive_group` rather than a deeper tree.
create or replace function public.promotion_condition_valid(
  p_node jsonb,
  p_depth integer default 0
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_kind  text;
  v_child jsonb;
begin
  if p_depth > 6 then
    return false;
  end if;
  if p_node is null or pg_catalog.jsonb_typeof(p_node) <> 'object' then
    return false;
  end if;

  v_kind := p_node ->> 'kind';
  if v_kind is null then
    return false;
  end if;

  case v_kind

    -- { kind:'compare', basis, comparator, value } — `nights >= 5`.
    -- `basis` is FactBasis from src/lib/preparation/types.ts. The list is
    -- shared with the preparation rules deliberately, so that "per guest"
    -- means the same thing to a towel rule and to a discount rule.
    when 'compare' then
      return (p_node ->> 'basis') in (
               'guests', 'adults', 'children', 'nights', 'bedrooms',
               'bathrooms', 'permanent_capacity', 'sleeping_places',
               'extra_beds', 'booking')
         and (p_node ->> 'comparator') in ('lt', 'lte', 'eq', 'gte', 'gt')
         and pg_catalog.jsonb_typeof(p_node -> 'value') = 'number';

    -- { kind:'advance', comparator, days } — early bird and last minute.
    -- §6 rule 36: measured from the booking's creation day in the property's
    -- local time, never from now(), or the discount would evaporate on any
    -- later repricing.
    when 'advance' then
      return (p_node ->> 'comparator') in ('lt', 'lte', 'eq', 'gte', 'gt')
         and pg_catalog.jsonb_typeof(p_node -> 'days') = 'number';

    -- { kind:'weekday_set', all_of: [0..6] } — midweek. 0 = Sunday.
    when 'weekday_set' then
      if pg_catalog.jsonb_typeof(p_node -> 'all_of') <> 'array' then
        return false;
      end if;
      return not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_node -> 'all_of') as day
        where pg_catalog.jsonb_typeof(day.value) <> 'number'
           or (day.value)::text::numeric not between 0 and 6
      );

    -- { kind:'source', any_of: BookingSource[] } — direct booking.
    --
    -- Transcribed from BOOKING_SOURCES in 0009 rather than read from
    -- `enum_range(null::public.booking_source)`, and the reason is honesty
    -- about volatility: `enum_range` is STABLE, and a function that calls it
    -- while declaring itself IMMUTABLE is a function whose declaration is a
    -- lie — one that a CHECK constraint and an expression index would both
    -- believe. The cost is a list that can drift, so the rehearsal at the foot
    -- of this file compares it against the real enum and fails if it has.
    when 'source' then
      if pg_catalog.jsonb_typeof(p_node -> 'any_of') <> 'array' then
        return false;
      end if;
      return not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(p_node -> 'any_of') as src
        where src.value not in (
          'direct_website', 'direct_manual', 'agent', 'agency',
          'airbnb', 'booking_com', 'vrbo', 'other_channel')
      );

    -- { kind:'guest_history', min_completed_bookings } — the repeat guest.
    -- §6 rule 35: counted within this organization only. A returning guest of
    -- another business is not a returning guest here.
    when 'guest_history' then
      return pg_catalog.jsonb_typeof(p_node -> 'min_completed_bookings') = 'number';

    -- Composition. `of` is a list for all/any, a single node for not.
    when 'all', 'any' then
      if pg_catalog.jsonb_typeof(p_node -> 'of') <> 'array' then
        return false;
      end if;
      for v_child in
        select value from pg_catalog.jsonb_array_elements(p_node -> 'of')
      loop
        if not public.promotion_condition_valid(v_child, p_depth + 1) then
          return false;
        end if;
      end loop;
      return true;

    when 'not' then
      return public.promotion_condition_valid(p_node -> 'of', p_depth + 1);

    else
      return false;
  end case;
end $$;

comment on function public.promotion_condition_valid(jsonb, integer) is
  'The closed condition language of docs/spec/20-pricing.md §7.6, checked for shape. Six node kinds and six levels of nesting. What the language cannot express is a second promotion, not a larger grammar — the same argument as QuantityExpression in src/lib/preparation/types.ts. Truth is decided by src/lib/promotions/conditions.ts against a booking''s facts; only shape can be decided here.';

revoke all on function public.promotion_condition_valid(jsonb, integer) from public, anon;
grant execute on function public.promotion_condition_valid(jsonb, integer)
  to authenticated, service_role;


-- ============================================================================
-- 4 · promotions — the campaign
-- ============================================================================

create table if not exists public.promotions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null
    references public.organizations (id) on delete cascade,

  -- Stored as typed. Compared folded. See the header.
  code              text not null,
  code_folded       text generated always as (upper(btrim(code))) stored,
  name              text not null,

  kind              public.promotion_kind not null,

  -- The empty `all` is "no condition at all", which is a real and common
  -- campaign — a flat 5% for direct bookings has nothing to test beyond the
  -- source, and even that is often left to the channel scope. It is spelled as
  -- an empty conjunction rather than as NULL so that every reader of this
  -- column receives the same shape.
  conditions        jsonb not null default '{"kind": "all", "of": []}'::jsonb,

  discount_kind     public.promotion_discount_kind not null,
  -- bps for percent · agorot for fixed · whole nights for free_nights. The
  -- ranges are enforced per kind below, because a single range that admitted
  -- all three would admit nonsense in each.
  discount_value    integer not null,
  applies_to        public.promotion_applies_to not null default 'stay_total',

  -- §7.9. `stackable = false` and a candidate already selected means this one
  -- is skipped; selected and not stackable stops the list.
  stackable         boolean not null default false,
  exclusive_group   text,
  priority          integer not null default 0,

  -- Null is "no limit", in all three. Not zero: zero is a limit, and a
  -- promotion with a limit of zero is one that can never fire, which is a
  -- state somebody would reach by leaving a field blank.
  max_redemptions   integer,
  max_per_guest     integer,
  budget_agorot     integer,

  -- timestamptz and not date, per §3.5: a campaign ends at midnight in the
  -- property's time zone, and midnight is an instant.
  effective_from    timestamptz not null default now(),
  effective_to      timestamptz,

  -- Paused, or exhausted. §9 requires that a promotion which reaches its
  -- redemption ceiling switches itself off, and that the switching off does
  -- not depend on the notification being delivered — so `redeem_discount`
  -- does it, inside the same transaction and under the same lock.
  is_active         boolean not null default true,
  deactivated_at    timestamptz,
  deactivated_by    uuid references auth.users (id) on delete set null,
  deactivation_reason text,

  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null,
  version           integer not null default 1,

  constraint promotions_id_organization_key unique (id, organization_id),

  -- §3.5: a duplicate code is a bug. Folded, so `SUMMER` and `summer` are the
  -- same campaign and cannot both exist — which is what makes a folded lookup
  -- able to return exactly one row.
  constraint promotions_organization_code_key unique (organization_id, code_folded),

  -- §8. Lower case only: this one is a machine identifier and no guest types
  -- it. The coupon code, which they do type, is looser on purpose.
  constraint promotions_code_shape check (
    code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  constraint promotions_name_not_blank check (length(btrim(name)) > 0),

  constraint promotions_conditions_shape check (
    public.promotion_condition_valid(conditions)),

  -- §8: 0.01% to 100% for a percentage. Never above 100%: a discount larger
  -- than the thing discounted is a refund, and §6 rule 23 says a price
  -- calculator does not invent refunds.
  constraint promotions_discount_value_range check (
    case discount_kind
      when 'percent'     then discount_value between 1 and 10000
      when 'fixed'       then discount_value >= 1
      when 'free_nights' then discount_value between 1 and 365
    end),

  constraint promotions_max_redemptions_positive check (
    max_redemptions is null or max_redemptions >= 1),
  constraint promotions_max_per_guest_positive check (
    max_per_guest is null or max_per_guest >= 1),
  constraint promotions_budget_nonnegative check (
    budget_agorot is null or budget_agorot >= 0),

  constraint promotions_window_ordered check (
    effective_to is null or effective_to > effective_from),

  constraint promotions_exclusive_group_shape check (
    exclusive_group is null
    or exclusive_group ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),

  -- A campaign that is off says when and why. The same shape as
  -- automation_rules in 0067: the state and its explanation are one fact.
  constraint promotions_deactivation_is_stamped check (
    is_active or deactivated_at is not null),

  constraint promotions_version_positive check (version >= 1)
);

comment on table public.promotions is
  'A commercial campaign: who qualifies (conditions, §7.6), what they get (discount_kind/value), and how much of it the business is willing to give away (max_redemptions, max_per_guest, budget_agorot). It is not a price. The price is booking_price_lines, and no read path leads from here to a booking that already exists — see §6 rule 37.';
comment on column public.promotions.code is
  'Stored exactly as typed. Compared through code_folded, which carries the unique index, so a guest typing summer25 reaches SUMMER25.';
comment on column public.promotions.code_folded is
  'upper(btrim(code)), generated and stored. A generated column rather than an expression index so that the fold is visible in the table definition and nobody writes a lookup against the raw code.';
comment on column public.promotions.discount_value is
  'Basis points for percent (500 = 5%), agorot for fixed, whole nights for free_nights. Always an integer: a rate stored as 0.05 produces an invoice that does not add up, which is the same argument as properties.tax_rate_bps. The agorot a discount is finally worth is computed once in src/lib/promotions/discount.ts and stored on the booking, never here.';
comment on column public.promotions.max_redemptions is
  'The ceiling this whole file exists for. Null means no limit. Enforced by public.redeem_discount under a row lock and, decisively, by the unique index on discount_redemptions.redemption_index — see the header.';
comment on column public.promotions.budget_agorot is
  'A cumulative ceiling on what has been given away. Held by the row lock in redeem_discount and by nothing else: a sum across rows is not something a constraint can express. Weaker than max_redemptions, and stated as weaker rather than implied to be equal.';
comment on column public.promotions.is_active is
  'False when a person paused the campaign or when it reached max_redemptions. §9 requires that exhaustion switches it off independently of any notification being delivered, so redeem_discount does it in the same transaction as the redemption that filled it.';

-- "Which campaigns could apply to a booking being priced right now" is asked on
-- every quote, so it is a partial index over the live rows rather than a scan
-- of every campaign the business has ever run.
create index if not exists promotions_live_idx
  on public.promotions (organization_id, priority desc, code)
  where is_active;


-- ============================================================================
-- 5 · coupons — one printed instance of a campaign
-- ============================================================================
-- The terms are copied here, not inherited. See WHAT IS NOT HERE in the
-- header: a coupon is a promise already handed to somebody.

create table if not exists public.coupons (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null
    references public.organizations (id) on delete cascade,

  -- The campaign this coupon was cut from. Lineage and reporting; the parent's
  -- limits are NOT consumed by redeeming this coupon.
  promotion_id      uuid not null,

  code              text not null,
  code_folded       text generated always as (upper(btrim(code))) stored,

  -- A coupon issued to one named guest, or to nobody in particular. Null is
  -- "bearer": a code on a flyer, valid for whoever types it.
  issued_to_guest_id uuid,

  -- Copied from the promotion at issue time and never re-read from it.
  discount_kind     public.promotion_discount_kind not null,
  discount_value    integer not null,
  applies_to        public.promotion_applies_to not null default 'stay_total',
  conditions        jsonb not null default '{"kind": "all", "of": []}'::jsonb,

  single_use        boolean not null default true,
  max_redemptions   integer not null default 1,
  max_per_guest     integer,
  budget_agorot     integer,

  effective_from    timestamptz not null default now(),
  effective_to      timestamptz,
  -- §3.5 names this separately from effective_to, and they are different
  -- facts: the campaign window is when the offer runs, expires_at is when this
  -- particular card stops working. A coupon printed for a wedding party may
  -- outlive the campaign, or die before it.
  expires_at        timestamptz,

  is_active         boolean not null default true,
  deactivated_at    timestamptz,
  deactivated_by    uuid references auth.users (id) on delete set null,
  deactivation_reason text,

  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null,
  version           integer not null default 1,

  constraint coupons_id_organization_key unique (id, organization_id),

  constraint coupons_promotion_fkey
    foreign key (promotion_id, organization_id)
    references public.promotions (id, organization_id) on delete restrict,

  -- `restrict`, matching `bookings_guest_fkey` in 0009 exactly. Guests are
  -- SOFT deleted in this product (`guests.deleted_at`), so this refuses
  -- nothing the product does, and it refuses the thing it should: a guest row
  -- cannot be erased out from under a coupon issued to them.
  --
  -- Not `set null`, which was the first instinct and is wrong twice over. A
  -- composite foreign key nulls EVERY referencing column unless a column list
  -- says otherwise, and `organization_id` is NOT NULL — so a bare clause fails
  -- at delete time with an error nobody can act on. (0031 and 0032 carry that
  -- shape today; it is not corrected here because those are not this slice's
  -- tables and a silent fix in somebody else's file is worse than a report.)
  constraint coupons_guest_fkey
    foreign key (issued_to_guest_id, organization_id)
    references public.guests (id, organization_id) on delete restrict,

  constraint coupons_organization_code_key unique (organization_id, code_folded),

  -- §8 relaxed to either case, deliberately. See the header: the uppercase
  -- pattern in the spec describes how a code is printed, and refusing a
  -- lowercase one at issue time would defeat the fold in the only direction it
  -- is ever used.
  constraint coupons_code_shape check (code ~ '^[A-Za-z0-9-]{4,24}$'),

  constraint coupons_conditions_shape check (
    public.promotion_condition_valid(conditions)),

  constraint coupons_discount_value_range check (
    case discount_kind
      when 'percent'     then discount_value between 1 and 10000
      when 'fixed'       then discount_value >= 1
      when 'free_nights' then discount_value between 1 and 365
    end),

  -- §3.5 asks for `unique (coupon_id) where single_use`. That index cannot be
  -- written — a partial index may not read `single_use` from another table —
  -- so the same guarantee is stated here, where it IS checkable, and then
  -- enforced by the ordinal index on discount_redemptions.
  constraint coupons_single_use_is_one check (
    not single_use or max_redemptions = 1),

  constraint coupons_max_redemptions_positive check (max_redemptions >= 1),
  constraint coupons_max_per_guest_positive check (
    max_per_guest is null or max_per_guest >= 1),
  constraint coupons_budget_nonnegative check (
    budget_agorot is null or budget_agorot >= 0),

  constraint coupons_window_ordered check (
    effective_to is null or effective_to > effective_from),

  constraint coupons_deactivation_is_stamped check (
    is_active or deactivated_at is not null),

  constraint coupons_version_positive check (version >= 1)
);

comment on table public.coupons is
  'One issued instance of a promotion, with its terms copied rather than inherited. A campaign whose percentage is edited next month must not change what a card handed to a guest today is worth — the same freezing law as a booking, one level up. max_redemptions defaults to 1 because the overwhelmingly common coupon is single use, and a default that has to be remembered is a default that gives money away.';
comment on column public.coupons.promotion_id is
  'Lineage, for reporting. Redeeming a coupon does NOT consume the parent campaign''s max_redemptions or budget: a coupon carries its own. Double counting would make a number on the promotions screen mean two different things depending on how the discount reached the booking.';
comment on column public.coupons.issued_to_guest_id is
  'The named holder, or null for a bearer code on a flyer. on delete restrict, matching bookings_guest_fkey in 0009: guests are soft deleted in this product, so nothing legitimate is refused, and a guest row cannot be erased out from under a coupon issued to them.';
comment on column public.coupons.expires_at is
  'When this card stops working, which is a different fact from when the campaign stops running. Both are checked; whichever comes first wins.';

create index if not exists coupons_promotion_idx
  on public.coupons (organization_id, promotion_id);

-- "How many of this guest's coupons are still live" — the only per-guest read.
create index if not exists coupons_guest_idx
  on public.coupons (organization_id, issued_to_guest_id)
  where issued_to_guest_id is not null;


-- ============================================================================
-- 6 · discount_redemptions — the ledger, and the ceiling
-- ============================================================================
-- One row per act of giving money away. Append only, and never written by a
-- request path: `redeem_discount` in section 8 is the only writer.

create table if not exists public.discount_redemptions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null
    references public.organizations (id) on delete cascade,
  property_id       uuid not null,
  booking_id        uuid not null,

  -- Exactly one of the two. A redemption is either a campaign firing on a
  -- booking or a coupon being spent, and the limits it consumes are the ones
  -- belonging to whichever it is.
  promotion_id      uuid,
  coupon_id         uuid,

  -- Who received it, when that is known. Required whenever the subject caps
  -- redemptions per guest, because a limit that cannot be attributed is not a
  -- limit — redeem_discount refuses that combination rather than silently
  -- letting max_per_guest through.
  guest_id          uuid,

  -- ── THE ORDINAL ─────────────────────────────────────────────────────────
  -- 1 for the first redemption of this promotion or coupon, 2 for the second.
  -- Allocated by redeem_discount under a row lock and made unrepeatable by the
  -- two partial unique indexes below. This is the mechanism that stops a
  -- coupon being over-redeemed; everything else is a friendlier error message
  -- in front of it.
  redemption_index  integer not null,
  -- The same idea per guest, so max_per_guest is held by an index rather than
  -- by a count somebody remembered to take.
  guest_redemption_index integer,

  -- The magnitude, positive. booking_price_lines stores the same money
  -- negative so that a booking total stays a plain sum; here it is positive
  -- because it is summed against budget_agorot, which is a positive ceiling.
  -- redeem_discount is the one place that converts, and it verifies the two
  -- against each other when a price line is named.
  amount_agorot     integer not null,

  -- ── THE FREEZE ──────────────────────────────────────────────────────────
  -- The terms as they stood at this instant: code, discount kind, value,
  -- basis, name. Editing the promotion afterwards cannot reach this row, and
  -- nothing may update it. "Why did this guest pay ₪278 less in March" is
  -- answerable from this row alone, forever.
  terms             jsonb not null,

  -- The booking_price_lines row this redemption produced, when the caller
  -- names it. Composite, via the key added in section 1.
  price_line_id     uuid,

  redeemed_at       timestamptz not null default now(),
  -- ⚠️ A KNOWN INTERACTION, RECORDED RATHER THAN DISCOVERED LATER.
  -- `set null` here is the house pattern and matches
  -- `booking_status_history.changed_by` in 0009 exactly — including the
  -- consequence, which is that hard-deleting an `auth.users` row would fire a
  -- SET NULL update against a table whose statement-level trigger refuses all
  -- updates, and the DELETE would fail with "append-only" from a statement
  -- that never named this table. 0009 already has that property, so this adds
  -- nothing new and the database already declines to hard-delete auth users;
  -- ESTIA deactivates people rather than erasing them, and the permanent
  -- record of who did what is `audit_events`, which nothing deletes.
  --
  -- If the product ever does need to erase an auth row, the fix is one change
  -- in one place — narrow both append-only triggers to `before update of
  -- <every column except the attribution one>` — and it belongs in a migration
  -- that changes 0009's table and this one together, not in a quiet
  -- divergence here.
  redeemed_by       uuid references auth.users (id) on delete set null,

  constraint discount_redemptions_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete cascade,

  constraint discount_redemptions_promotion_fkey
    foreign key (promotion_id, organization_id)
    references public.promotions (id, organization_id) on delete restrict,

  constraint discount_redemptions_coupon_fkey
    foreign key (coupon_id, organization_id)
    references public.coupons (id, organization_id) on delete restrict,

  -- ── Why neither of these is `set null` ──────────────────────────────────
  -- This table refuses UPDATE at statement level. A referential SET NULL is an
  -- UPDATE, and it would fire that trigger and fail — so erasing a guest, or a
  -- price line, would raise "discount_redemptions is append-only" from a
  -- statement that never mentioned this table. Append-only means a row is
  -- written once and never touched again, and a foreign key that quietly edits
  -- one is not append-only, whatever the comment above it says.
  --
  -- `restrict` on the guest, matching `bookings_guest_fkey` in 0009. Guests are
  -- soft deleted here, so nothing the product does is refused.
  constraint discount_redemptions_guest_fkey
    foreign key (guest_id, organization_id)
    references public.guests (id, organization_id) on delete restrict,

  -- `cascade` on the price line, and NOT `restrict`. A price line only ever
  -- disappears when its booking is hard deleted, and this row already cascades
  -- from that same booking — so `restrict` here would make `booking.delete`
  -- impossible by refusing a cascade that was going to remove this row anyway.
  -- The DELETE trigger lets it through for 0009's reason: by the time the
  -- cascade fires the booking is gone, which is exactly the discriminator.
  constraint discount_redemptions_price_line_fkey
    foreign key (price_line_id, organization_id)
    references public.booking_price_lines (id, organization_id) on delete cascade,

  constraint discount_redemptions_one_subject check (
    num_nonnulls(promotion_id, coupon_id) = 1),

  constraint discount_redemptions_index_positive check (redemption_index >= 1),
  constraint discount_redemptions_guest_index_positive check (
    guest_redemption_index is null or guest_redemption_index >= 1),
  -- A per-guest ordinal without a guest is an ordinal that counts nothing.
  constraint discount_redemptions_guest_index_needs_guest check (
    guest_redemption_index is null or guest_id is not null),

  -- Zero is not a redemption. A promotion that worked out to nothing —
  -- §7.10, `discountable = 0` — omits its line entirely rather than recording
  -- a redemption of ₪0 that consumed one of a hundred available.
  constraint discount_redemptions_amount_positive check (amount_agorot >= 1),

  constraint discount_redemptions_terms_is_object check (
    jsonb_typeof(terms) = 'object')
);

comment on table public.discount_redemptions is
  'One row per act of giving money away, append only, written exclusively by public.redeem_discount. It carries the frozen terms as well as the amount, so the discount a guest was given in March stays readable after the campaign has been edited or switched off. The unique indexes on redemption_index are what stop a coupon being redeemed more times than it says.';
comment on column public.discount_redemptions.redemption_index is
  'The ordinal of this redemption within its promotion or coupon: 1, 2, 3. Allocated under a row lock and made unrepeatable by discount_redemptions_promotion_ordinal_key / _coupon_ordinal_key. Two concurrent redemptions against a limit of one both compute 1 in the worst case, and the index refuses the second — which is the whole reason the limit is not checked in TypeScript.';
comment on column public.discount_redemptions.terms is
  'The discount as it stood at this instant — code, kind, value, basis, name. A copy and not a pointer, for the reason FinanceSnapshot.lines gives in src/lib/finance/snapshot.ts: a pointer survives only as long as nobody edits or renumbers the thing it points at, and both happen.';
comment on column public.discount_redemptions.amount_agorot is
  'The magnitude, positive, because it is summed against budget_agorot. The same money appears negative on booking_price_lines so that a booking total stays a plain addition. redeem_discount converts, and checks the two agree when price_line_id is given.';
comment on column public.discount_redemptions.price_line_id is
  'The booking_price_lines row this redemption produced, when the caller can name it. Nullable because the ordering of the two writes belongs to the booking-creation path and not to this file; when it IS given, redeem_discount refuses the pair unless the line is on the same booking and its amount is the exact negation of this one.';

-- ── The ceiling, as two indexes ─────────────────────────────────────────────
-- Partial, because exactly one of the two subject columns is ever set.

create unique index if not exists discount_redemptions_promotion_ordinal_key
  on public.discount_redemptions (promotion_id, redemption_index)
  where promotion_id is not null;

create unique index if not exists discount_redemptions_coupon_ordinal_key
  on public.discount_redemptions (coupon_id, redemption_index)
  where coupon_id is not null;

create unique index if not exists discount_redemptions_promotion_guest_ordinal_key
  on public.discount_redemptions (promotion_id, guest_id, guest_redemption_index)
  where promotion_id is not null and guest_id is not null;

create unique index if not exists discount_redemptions_coupon_guest_ordinal_key
  on public.discount_redemptions (coupon_id, guest_id, guest_redemption_index)
  where coupon_id is not null and guest_id is not null;

-- §17: "a discount applied twice to the same booking". Not a race — a double
-- click — but the same refusal.
create unique index if not exists discount_redemptions_booking_promotion_key
  on public.discount_redemptions (booking_id, promotion_id)
  where promotion_id is not null;

-- §6 rule 30: at most one coupon per booking. Not one per coupon per booking —
-- ONE, whichever it is. A booking that stacked two coupons would be a booking
-- nobody could explain to the guest whose second code was silently ignored.
create unique index if not exists discount_redemptions_booking_one_coupon_key
  on public.discount_redemptions (booking_id)
  where coupon_id is not null;

-- The read the screen makes: what has this campaign given away so far.
create index if not exists discount_redemptions_promotion_idx
  on public.discount_redemptions (organization_id, promotion_id, redeemed_at desc)
  where promotion_id is not null;

create index if not exists discount_redemptions_coupon_idx
  on public.discount_redemptions (organization_id, coupon_id, redeemed_at desc)
  where coupon_id is not null;

-- The read the booking screen makes: what was taken off this stay.
create index if not exists discount_redemptions_booking_idx
  on public.discount_redemptions (organization_id, booking_id);


-- ============================================================================
-- 7 · Append-only, and the touch triggers
-- ============================================================================
-- Two independent refusals on the ledger, for 0009's reason: the table owner
-- is not bound by grants and service_role has BYPASSRLS, so revoked privileges
-- alone are not the whole answer.

create or replace function public.tg_discount_redemptions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'discount_redemptions is append-only; % is not permitted. A discount that was given is part of what a guest owes.',
    tg_op
    using errcode = '42501';
end;
$$;

comment on function public.tg_discount_redemptions_append_only() is
  'Refuses UPDATE on discount_redemptions. Statement-level, so a statement that would have matched no rows is refused as loudly as one that would have matched many. There is no legitimate update: a correction is a credit note, and that lives in 21-finance.';

create or replace function public.tg_discount_redemptions_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Row-level rather than statement-level, and for exactly 0009's reason: the
  -- ON DELETE CASCADE from a hard-deleted booking has to be let through, and
  -- by the time that cascade fires the parent is already gone. So the rule is
  -- stated precisely — you may not delete the redemption history of a booking
  -- that still exists — rather than absolutely.
  if exists (select 1 from public.bookings b where b.id = old.booking_id) then
    raise exception
      'discount_redemptions is append-only; DELETE is not permitted while the booking exists'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

comment on function public.tg_discount_redemptions_no_delete() is
  'Refuses to delete the redemption history of a booking that still exists, while letting the cascade from a hard-deleted booking through. Same discriminator as tg_booking_status_history_no_delete in 0009.';

drop trigger if exists discount_redemptions_no_update on public.discount_redemptions;
create trigger discount_redemptions_no_update
  before update on public.discount_redemptions
  for each statement execute function public.tg_discount_redemptions_append_only();

drop trigger if exists discount_redemptions_no_delete on public.discount_redemptions;
create trigger discount_redemptions_no_delete
  before delete on public.discount_redemptions
  for each row execute function public.tg_discount_redemptions_no_delete();

drop trigger if exists promotions_touch on public.promotions;
create trigger promotions_touch
  before update on public.promotions
  for each row execute function public.tg_touch_row();

drop trigger if exists coupons_touch on public.coupons;
create trigger coupons_touch
  before update on public.coupons
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 8 · Row level security
-- ============================================================================
-- Two floors, and this is the lower one. `can(actor, grant, resource)` in
-- src/lib/authz runs above it; neither is a substitute for the other.

alter table public.promotions            enable row level security;
alter table public.promotions            force  row level security;
alter table public.coupons               enable row level security;
alter table public.coupons               force  row level security;
alter table public.discount_redemptions  enable row level security;
alter table public.discount_redemptions  force  row level security;

revoke all on public.promotions           from anon, authenticated;
revoke all on public.coupons              from anon, authenticated;
revoke all on public.discount_redemptions from anon, authenticated;

grant select, insert, update on public.promotions to authenticated, service_role;
grant select, insert, update on public.coupons    to authenticated, service_role;

-- READ ONLY, for everybody. The ledger is written by redeem_discount and by
-- nothing else — not by a request path, not by service_role, not by an
-- operation that decides it knows better. A row here is the record that money
-- was given away, and the whole design of the ceiling depends on there being
-- exactly one writer that allocates the ordinal.
--
-- ── Why the definer function can still write, with the table FORCED ────────
-- The obvious objection: FORCE ROW LEVEL SECURITY subjects the table's OWNER
-- to its policies, and there is no INSERT policy below. In this project that
-- does not block the write, and `0065_force_identity_rls.sql` is where the
-- reason is verified rather than assumed: FORCE does not subject a role
-- holding BYPASSRLS, and `postgres` and `service_role` both hold it here
-- (checked against `pg_roles.rolbypassrls`). `redeem_discount` is SECURITY
-- DEFINER and owned by `postgres`, so it writes; `service_role` holds
-- BYPASSRLS too and is stopped instead by the REVOKE above, because a
-- privilege and a policy are two different gates and only one of them is
-- bypassed. This is the same arrangement `record_booking_status` relies on for
-- `booking_status_history` in 0009, which is likewise forced with no INSERT
-- policy.
grant select on public.discount_redemptions to authenticated, service_role;

-- A campaign that was ever redeemed cannot be erased. 0067's argument, and it
-- is stronger here: a deleted promotion takes with it the explanation for
-- every price a guest was quoted under it. Pausing is an UPDATE.
revoke delete, truncate on public.promotions           from authenticated, service_role;
revoke delete, truncate on public.coupons              from authenticated, service_role;
revoke insert, update, delete, truncate
  on public.discount_redemptions from authenticated, service_role;

-- ── promotions ──────────────────────────────────────────────────────────────
-- `pricing.manage` throughout, from PERMISSIONS in src/lib/authz/permissions.ts.
-- There is no separate view grant for a campaign in the catalogue and this file
-- does not invent one: §2 puts the promotions screen in front of the revenue
-- manager, the owner, the general manager and the property manager, and all
-- four hold pricing.manage. Reception never reads this table — it submits a
-- code, and the lookup happens inside redeem_discount.
--
-- No property_in_scope clause, and that is a fact about the table rather than
-- an omission: a promotion has no property column. §3.5 scopes a campaign to an
-- organization, and a business that wants one property's campaign expresses it
-- as a condition, not as a scope. The redemption ledger, which DOES name a
-- property, is scoped.

drop policy if exists promotions_select on public.promotions;
create policy promotions_select on public.promotions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists promotions_insert on public.promotions;
create policy promotions_insert on public.promotions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists promotions_update on public.promotions;
create policy promotions_update on public.promotions
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  );

-- ── coupons ─────────────────────────────────────────────────────────────────

drop policy if exists coupons_select on public.coupons;
create policy coupons_select on public.coupons
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists coupons_insert on public.coupons;
create policy coupons_insert on public.coupons
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  );

drop policy if exists coupons_update on public.coupons;
create policy coupons_update on public.coupons
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'pricing.manage')
  );

-- ── discount_redemptions ────────────────────────────────────────────────────
-- `booking.view_price`, not `pricing.manage`. A reduction is a price, which is
-- the same call the existing /promotions screen already makes about the
-- discount lines it shows. A revenue manager reading their campaign's uptake
-- and a receptionist reading what came off one booking are the same question
-- asked at two zoom levels, and both are answered by the same grant.
--
-- Scoped by property as well as by tenant: a property manager confined to two
-- properties must not read what was discounted on a third.

drop policy if exists discount_redemptions_select on public.discount_redemptions;
create policy discount_redemptions_select on public.discount_redemptions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view_price')
  );


-- ============================================================================
-- 9 · redeem_discount — the only writer, and the atomic allocation
-- ============================================================================
-- ── Why this is SECURITY DEFINER ────────────────────────────────────────────
--
-- 0061's argument, unchanged. A receptionist creating a booking with a coupon
-- holds `booking.create` and does not hold `pricing.manage`; they can neither
-- read `coupons` nor insert into `discount_redemptions`, and both refusals are
-- correct and neither should be relaxed. The alternative is a service-role
-- client in the booking write path — a credential that bypasses row level
-- security on the whole database, introduced so that a coupon can be counted.
--
-- So the counting happens here. RLS is bypassed for the body, which means the
-- membership check below is not belt and braces: it is the ONLY tenant
-- boundary in this function, and without it any signed-in user could redeem
-- against any organization's coupon by passing its id. `search_path` is pinned
-- to '' and every reference is schema-qualified, so the function cannot be
-- redirected at a shadowing table.
--
-- The permission asked for is `booking.create`, because redeeming is something
-- that happens while a booking is being taken. Asking for `pricing.manage`
-- would put every reservation behind the revenue manager.
--
-- ── The allocation, step by step ────────────────────────────────────────────
--
--   1. `select … for update` on the subject row. Two callers redeeming the
--      same code are serialised here, and only here.
--   2. A SEPARATE statement counts the existing redemptions. Under READ
--      COMMITTED that statement takes a fresh snapshot, so the caller that
--      waited sees the row the other one committed. This is the step that
--      produces a readable refusal.
--   3. The INSERT carries the ordinal. The unique index refuses a duplicate
--      whatever step 2 believed — a different isolation level, a future
--      caller, a bug in this function. 23505 is translated back into the same
--      Hebrew-facing business error, so a race and a full coupon look
--      identical to the person holding the phone, which is correct: they are.

create or replace function public.redeem_discount(
  p_organization_id uuid,
  p_booking_id      uuid,
  p_property_id     uuid,
  p_amount_agorot   integer,
  p_terms           jsonb,
  p_promotion_id    uuid default null,
  p_coupon_id       uuid default null,
  p_guest_id        uuid default null,
  p_price_line_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_redemptions integer;
  v_max_per_guest   integer;
  v_budget_agorot   integer;
  v_is_active       boolean;
  v_effective_from  timestamptz;
  v_effective_to    timestamptz;
  v_expires_at      timestamptz;
  v_ordinal         integer;
  v_guest_ordinal   integer;
  v_spent           integer;
  v_line_amount     integer;
  v_line_booking    uuid;
  v_id              uuid;
begin
  /* ── the tenant boundary, which RLS is not providing here ──────────────── */

  if p_organization_id is null then
    raise exception 'an organization must be named' using errcode = '22004';
  end if;

  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  if not public.has_permission(p_organization_id, 'booking.create') then
    raise exception 'booking.create is required to redeem a discount'
      using errcode = '42501';
  end if;

  -- Built-ins are written bare here and below. `set search_path = ''` does not
  -- remove pg_catalog: it is always searched first regardless, so a bare
  -- `coalesce` or `num_nonnulls` cannot be shadowed. COALESCE in particular
  -- CANNOT be schema-qualified — it is SQL syntax, not a function call.
  if num_nonnulls(p_promotion_id, p_coupon_id) <> 1 then
    raise exception 'a redemption names exactly one promotion or one coupon'
      using errcode = '22023';
  end if;

  if p_amount_agorot is null or p_amount_agorot < 1 then
    -- §7.10: a discount that worked out to nothing omits its line. It must not
    -- consume one of a hundred available redemptions on the way past.
    raise exception 'a redemption of zero is not a redemption'
      using errcode = '22023';
  end if;

  /* ── 1 · the lock that serialises two guests typing the same code ──────── */

  if p_promotion_id is not null then
    select p.max_redemptions, p.max_per_guest, p.budget_agorot,
           p.is_active, p.effective_from, p.effective_to, null::timestamptz
      into v_max_redemptions, v_max_per_guest, v_budget_agorot,
           v_is_active, v_effective_from, v_effective_to, v_expires_at
    from public.promotions p
    where p.id = p_promotion_id
      and p.organization_id = p_organization_id
    for update;
  else
    select c.max_redemptions, c.max_per_guest, c.budget_agorot,
           c.is_active, c.effective_from, c.effective_to, c.expires_at
      into v_max_redemptions, v_max_per_guest, v_budget_agorot,
           v_is_active, v_effective_from, v_effective_to, v_expires_at
    from public.coupons c
    where c.id = p_coupon_id
      and c.organization_id = p_organization_id
    for update;
  end if;

  if not found then
    raise exception 'no such promotion or coupon in this organization'
      using errcode = 'no_data_found';
  end if;

  if not v_is_active then
    raise exception 'this discount is not active' using errcode = '23514';
  end if;

  if pg_catalog.now() < v_effective_from
     or (v_effective_to is not null and pg_catalog.now() >= v_effective_to)
     or (v_expires_at   is not null and pg_catalog.now() >= v_expires_at) then
    -- Half-open, like every range in the product: the instant of
    -- effective_to is outside the window, not the last moment inside it.
    raise exception 'this discount is outside its window' using errcode = '23514';
  end if;

  -- A per-guest ceiling that cannot be attributed is not a ceiling. Refusing
  -- is the only honest option: silently letting the redemption through would
  -- make max_per_guest a field that works except when it matters.
  if v_max_per_guest is not null and p_guest_id is null then
    raise exception 'this discount is limited per guest and no guest was named'
      using errcode = '22023';
  end if;

  /* ── the price line, when one is named, must be the same money ─────────── */

  if p_price_line_id is not null then
    select l.amount_agorot, l.booking_id
      into v_line_amount, v_line_booking
    from public.booking_price_lines l
    where l.id = p_price_line_id
      and l.organization_id = p_organization_id;

    if not found or v_line_booking is distinct from p_booking_id then
      raise exception 'the price line named is not on this booking'
        using errcode = '23503';
    end if;
    if v_line_amount <> -p_amount_agorot then
      -- Two copies of one number, checked against each other at the one write
      -- that creates both. After this they are frozen: the line is written
      -- once and the redemption is append-only, so they can never drift.
      raise exception
        'the price line says % and the redemption says %; a discount has one amount',
        v_line_amount, -p_amount_agorot
        using errcode = '23514';
    end if;
  end if;

  /* ── 2 · count, in a new statement and therefore a new snapshot ────────── */

  select pg_catalog.count(*), coalesce(pg_catalog.sum(r.amount_agorot), 0)
    into v_ordinal, v_spent
  from public.discount_redemptions r
  where (p_promotion_id is not null and r.promotion_id = p_promotion_id)
     or (p_coupon_id    is not null and r.coupon_id    = p_coupon_id);

  v_ordinal := v_ordinal + 1;

  if v_max_redemptions is not null and v_ordinal > v_max_redemptions then
    raise exception 'this discount has been redeemed % times already, and its limit is %',
      v_ordinal - 1, v_max_redemptions
      using errcode = '23505';
  end if;

  -- The budget. Held by the lock above and by nothing else — a sum across rows
  -- is not expressible as a constraint. Stated in the header as the weaker of
  -- the two ceilings rather than implied to be equal to the other.
  if v_budget_agorot is not null and v_spent + p_amount_agorot > v_budget_agorot then
    raise exception 'this discount has a budget of % and % of it is spent',
      v_budget_agorot, v_spent
      using errcode = '23514';
  end if;

  if p_guest_id is not null then
    select pg_catalog.count(*) + 1 into v_guest_ordinal
    from public.discount_redemptions r
    where r.guest_id = p_guest_id
      and ((p_promotion_id is not null and r.promotion_id = p_promotion_id)
        or (p_coupon_id    is not null and r.coupon_id    = p_coupon_id));

    if v_max_per_guest is not null and v_guest_ordinal > v_max_per_guest then
      raise exception 'this guest has already used this discount % times',
        v_guest_ordinal - 1
        using errcode = '23505';
    end if;
  end if;

  /* ── 3 · the insert, whose ordinal the unique index will not repeat ────── */

  begin
    insert into public.discount_redemptions (
      organization_id, property_id, booking_id,
      promotion_id, coupon_id, guest_id,
      redemption_index, guest_redemption_index,
      amount_agorot, terms, price_line_id, redeemed_by
    ) values (
      p_organization_id, p_property_id, p_booking_id,
      p_promotion_id, p_coupon_id, p_guest_id,
      v_ordinal, v_guest_ordinal,
      p_amount_agorot, coalesce(p_terms, '{}'::jsonb),
      p_price_line_id, (select auth.uid())
    )
    returning id into v_id;
  exception
    when unique_violation then
      -- The index caught what the count did not: another transaction took this
      -- ordinal. To the person on the phone this is the same event as a full
      -- coupon, and it is — the code is spent. The message says so rather than
      -- naming an index.
      raise exception 'this discount has already been redeemed'
        using errcode = '23505';
  end;

  /* ── 4 · exhaustion switches the campaign off, under the same lock ─────── */
  -- §9: the disabling must not depend on a notification being delivered. So it
  -- happens here, in the transaction that filled the campaign, while the row
  -- is still locked.

  if v_max_redemptions is not null and v_ordinal = v_max_redemptions then
    if p_promotion_id is not null then
      update public.promotions
      set is_active = false,
          deactivated_at = pg_catalog.now(),
          deactivation_reason = 'max_redemptions_reached'
      where id = p_promotion_id and organization_id = p_organization_id;
    else
      update public.coupons
      set is_active = false,
          deactivated_at = pg_catalog.now(),
          deactivation_reason = 'max_redemptions_reached'
      where id = p_coupon_id and organization_id = p_organization_id;
    end if;
  end if;

  return v_id;
end;
$$;

comment on function public.redeem_discount(uuid, uuid, uuid, integer, jsonb, uuid, uuid, uuid, uuid) is
  'The only writer of discount_redemptions. SECURITY DEFINER so that a receptionist holding booking.create — and not pricing.manage — can spend a coupon without any request path holding a service-role client; membership and booking.create are therefore checked explicitly inside, because row level security is bypassed for the body. Allocates redemption_index under a row lock; the unique index on that ordinal is what actually stops a coupon being over-redeemed, and this function''s counting only exists to turn that refusal into a sentence a person can read.';

revoke all on function public.redeem_discount(uuid, uuid, uuid, integer, jsonb, uuid, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.redeem_discount(uuid, uuid, uuid, integer, jsonb, uuid, uuid, uuid, uuid)
  to authenticated, service_role;


-- ============================================================================
-- 10 · Rehearsal
-- ============================================================================
-- Exercised, not asserted.
--
-- The behavioural half runs against TEMPORARY tables created with
-- `like public.x including all`, which the server fills in from its own
-- catalogue — so the CHECK constraints, the generated columns and the partial
-- unique indexes exercised below are the REAL ones and not a copy this file
-- typed out. What LIKE does not copy is foreign keys, privileges and row level
-- security, which is why no organization needs seeding and why those three are
-- checked structurally instead.
--
-- The redemption ceiling is the guard a reader will most doubt, so it is the
-- first thing exercised and it is exercised the way it will actually fail:
-- two rows that both believe they are the first.

do $$
declare
  v_offending text;
  v_folded    text;
  v_rows      integer;
begin

  /* ══ THE CEILING ═══════════════════════════════════════════════════════ */
  -- Two callers, each convinced it is redemption number one. This is exactly
  -- the state a REPEATABLE READ transaction reaches after waiting on the row
  -- lock, and exactly what a read-then-write in TypeScript produces. The index
  -- refuses the second row.

  execute 'drop table if exists pg_temp.redemptions_rehearsal';
  execute 'create temp table redemptions_rehearsal
             (like public.discount_redemptions including all)';

  execute 'insert into pg_temp.redemptions_rehearsal
             (organization_id, property_id, booking_id, coupon_id,
              redemption_index, amount_agorot, terms)
           values ($1, $2, $3, $4, 1, 27800, $5)'
    using '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid,
          '00000000-0000-4000-8000-000000000003'::uuid,
          '00000000-0000-4000-8000-000000000004'::uuid,
          '{"code": "SUMMER25", "discount_kind": "percent", "discount_value": 500}'::jsonb;

  begin
    -- A DIFFERENT booking, so nothing but the ordinal index can refuse it.
    execute 'insert into pg_temp.redemptions_rehearsal
               (organization_id, property_id, booking_id, coupon_id,
                redemption_index, amount_agorot, terms)
             values ($1, $2, $3, $4, 1, 27800, $5)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-00000000000a'::uuid,
            '00000000-0000-4000-8000-000000000004'::uuid,
            '{"code": "SUMMER25"}'::jsonb;
    raise exception
      'a single-use coupon was redeemed twice: the ordinal index did not hold';
  exception
    when unique_violation then null;
  end;

  -- Ordinal 2 IS allowed — the index caps nothing by itself, it only refuses a
  -- repeat. The cap is max_redemptions, checked by redeem_discount against
  -- this ordinal. If this insert failed, the index would be refusing honest
  -- redemptions of a coupon with a limit of ten.
  execute 'insert into pg_temp.redemptions_rehearsal
             (organization_id, property_id, booking_id, coupon_id,
              redemption_index, amount_agorot, terms)
           values ($1, $2, $3, $4, 2, 27800, $5)'
    using '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid,
          '00000000-0000-4000-8000-00000000000b'::uuid,
          '00000000-0000-4000-8000-000000000004'::uuid,
          '{"code": "SUMMER25"}'::jsonb;

  -- Two coupons on one booking. §6 rule 30.
  begin
    execute 'insert into pg_temp.redemptions_rehearsal
               (organization_id, property_id, booking_id, coupon_id,
                redemption_index, amount_agorot, terms)
             values ($1, $2, $3, $4, 1, 500, $5)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-00000000000b'::uuid,
            '00000000-0000-4000-8000-00000000000c'::uuid,
            '{"code": "OTHER"}'::jsonb;
    raise exception 'a booking took two coupons';
  exception
    when unique_violation then null;
  end;

  -- The same promotion twice on one booking. §17.
  execute 'insert into pg_temp.redemptions_rehearsal
             (organization_id, property_id, booking_id, promotion_id,
              redemption_index, amount_agorot, terms)
           values ($1, $2, $3, $4, 1, 1000, $5)'
    using '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid,
          '00000000-0000-4000-8000-00000000000d'::uuid,
          '00000000-0000-4000-8000-00000000000e'::uuid,
          '{"code": "direct"}'::jsonb;
  begin
    execute 'insert into pg_temp.redemptions_rehearsal
               (organization_id, property_id, booking_id, promotion_id,
                redemption_index, amount_agorot, terms)
             values ($1, $2, $3, $4, 2, 1000, $5)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-00000000000d'::uuid,
            '00000000-0000-4000-8000-00000000000e'::uuid,
            '{"code": "direct"}'::jsonb;
    raise exception 'one promotion was applied twice to one booking';
  exception
    when unique_violation then null;
  end;

  -- Both subjects, or neither.
  begin
    execute 'insert into pg_temp.redemptions_rehearsal
               (organization_id, property_id, booking_id,
                redemption_index, amount_agorot, terms)
             values ($1, $2, $3, 1, 1000, ''{}''::jsonb)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-00000000000f'::uuid;
    raise exception 'a redemption named neither a promotion nor a coupon';
  exception
    when check_violation then null;
  end;

  -- A redemption of nothing, which would consume a slot for no money.
  begin
    execute 'insert into pg_temp.redemptions_rehearsal
               (organization_id, property_id, booking_id, coupon_id,
                redemption_index, amount_agorot, terms)
             values ($1, $2, $3, $4, 9, 0, ''{}''::jsonb)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000011'::uuid,
            '00000000-0000-4000-8000-000000000004'::uuid;
    raise exception 'a redemption of zero agorot consumed a redemption slot';
  exception
    when check_violation then null;
  end;

  -- A per-guest ordinal with no guest attached to it.
  begin
    execute 'insert into pg_temp.redemptions_rehearsal
               (organization_id, property_id, booking_id, coupon_id,
                redemption_index, guest_redemption_index, amount_agorot, terms)
             values ($1, $2, $3, $4, 9, 1, 1000, ''{}''::jsonb)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-000000000012'::uuid,
            '00000000-0000-4000-8000-000000000004'::uuid;
    raise exception 'a per-guest ordinal counted nobody';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.redemptions_rehearsal';


  /* ══ THE FOLD ══════════════════════════════════════════════════════════ */
  -- summer25 must reach SUMMER25, and the card must still read SUMMER25.

  execute 'drop table if exists pg_temp.coupons_rehearsal';
  execute 'create temp table coupons_rehearsal
             (like public.coupons including all)';

  execute 'insert into pg_temp.coupons_rehearsal
             (organization_id, promotion_id, code, discount_kind, discount_value)
           values ($1, $2, ''SUMMER25'', ''percent'', 500)'
    using '00000000-0000-4000-8000-000000000001'::uuid,
          '00000000-0000-4000-8000-000000000002'::uuid;

  execute 'select code_folded from pg_temp.coupons_rehearsal' into v_folded;
  if v_folded <> 'SUMMER25' then
    raise exception 'the code fold produced %, so a lookup would miss', v_folded;
  end if;

  begin
    execute 'insert into pg_temp.coupons_rehearsal
               (organization_id, promotion_id, code, discount_kind, discount_value)
             values ($1, $2, ''summer25'', ''percent'', 500)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid;
    raise exception
      'summer25 and SUMMER25 are two coupons, so one code has two answers';
  exception
    when unique_violation then null;
  end;

  -- Stored as typed: the row that survived still reads SUMMER25, not a folded
  -- copy of itself.
  execute 'select count(*) from pg_temp.coupons_rehearsal where code = ''SUMMER25'''
    into v_rows;
  if v_rows <> 1 then
    raise exception 'the code was not stored as it was typed';
  end if;

  -- A guest typing it in lower case still finds it.
  execute 'select count(*) from pg_temp.coupons_rehearsal
             where code_folded = upper(btrim(''  summer25  ''))'
    into v_rows;
  if v_rows <> 1 then
    raise exception 'a guest typing summer25 could not find SUMMER25';
  end if;

  -- single_use means exactly one, expressed where it is checkable.
  begin
    execute 'insert into pg_temp.coupons_rehearsal
               (organization_id, promotion_id, code, discount_kind,
                discount_value, single_use, max_redemptions)
             values ($1, $2, ''WINTER-9'', ''percent'', 500, true, 5)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid;
    raise exception 'a single-use coupon claimed five redemptions';
  exception
    when check_violation then null;
  end;

  -- A code nobody could type on a keyboard, and one too short to be a coupon.
  begin
    execute 'insert into pg_temp.coupons_rehearsal
               (organization_id, promotion_id, code, discount_kind, discount_value)
             values ($1, $2, ''קיץ 25'', ''percent'', 500)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000000002'::uuid;
    raise exception 'a coupon code could contain characters the pattern forbids';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.coupons_rehearsal';


  /* ══ THE PROMOTION'S OWN CONSTRAINTS ═══════════════════════════════════ */

  execute 'drop table if exists pg_temp.promotions_rehearsal';
  execute 'create temp table promotions_rehearsal
             (like public.promotions including all)';

  -- A percentage above 100%, which §6 rule 23 says is a refund and not a
  -- discount.
  begin
    execute 'insert into pg_temp.promotions_rehearsal
               (organization_id, code, name, kind, discount_kind, discount_value)
             values ($1, ''too-much'', ''יותר מדי'', ''direct_booking'', ''percent'', 15000)'
      using '00000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'a promotion could give away 150%%';
  exception
    when check_violation then null;
  end;

  -- A limit of zero, which is what a blank field becomes if the column admits
  -- it: a campaign that can never fire and that nobody can tell from one that
  -- has no limit at all.
  begin
    execute 'insert into pg_temp.promotions_rehearsal
               (organization_id, code, name, kind, discount_kind,
                discount_value, max_redemptions)
             values ($1, ''zero-cap'', ''אפס'', ''midweek'', ''percent'', 500, 0)'
      using '00000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'a promotion could carry a limit of zero redemptions';
  exception
    when check_violation then null;
  end;

  -- A window that ends before it begins.
  begin
    execute 'insert into pg_temp.promotions_rehearsal
               (organization_id, code, name, kind, discount_kind, discount_value,
                effective_from, effective_to)
             values ($1, ''backwards'', ''הפוך'', ''midweek'', ''percent'', 500,
                     ''2026-05-01T00:00:00Z'', ''2026-04-01T00:00:00Z'')'
      using '00000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'a campaign could end before it started';
  exception
    when check_violation then null;
  end;

  -- Switched off with no record of when.
  begin
    execute 'insert into pg_temp.promotions_rehearsal
               (organization_id, code, name, kind, discount_kind,
                discount_value, is_active)
             values ($1, ''silent-off'', ''כבוי'', ''midweek'', ''percent'', 500, false)'
      using '00000000-0000-4000-8000-000000000001'::uuid;
    raise exception 'a campaign could be switched off with no time on it';
  exception
    when check_violation then null;
  end;

  -- A condition tree the evaluator could never read.
  begin
    execute 'insert into pg_temp.promotions_rehearsal
               (organization_id, code, name, kind, discount_kind,
                discount_value, conditions)
             values ($1, ''bad-tree'', ''תנאי'', ''long_stay'', ''percent'', 500, $2)'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            '{"kind": "sql", "run": "drop table bookings"}'::jsonb;
    raise exception 'a promotion could carry a condition no evaluator knows';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.promotions_rehearsal';


  /* ══ THE CONDITION LANGUAGE, RUN AGAINST REAL VALUES ═══════════════════ */

  if not public.promotion_condition_valid('{"kind": "all", "of": []}'::jsonb) then
    raise exception 'the empty condition — a campaign with no test — is rejected';
  end if;
  if not public.promotion_condition_valid(
    '{"kind": "compare", "basis": "nights", "comparator": "gte", "value": 5}'::jsonb) then
    raise exception 'long stay cannot be expressed';
  end if;
  if not public.promotion_condition_valid(
    '{"kind": "advance", "comparator": "gte", "days": 90}'::jsonb) then
    raise exception 'early bird cannot be expressed';
  end if;
  if not public.promotion_condition_valid(
    '{"kind": "weekday_set", "all_of": [0, 1, 2, 3]}'::jsonb) then
    raise exception 'midweek cannot be expressed';
  end if;
  if not public.promotion_condition_valid(
    '{"kind": "source", "any_of": ["direct_website", "direct_manual"]}'::jsonb) then
    raise exception 'direct booking cannot be expressed';
  end if;
  if not public.promotion_condition_valid(
    '{"kind": "guest_history", "min_completed_bookings": 1}'::jsonb) then
    raise exception 'the repeat guest cannot be expressed';
  end if;
  if not public.promotion_condition_valid(
    '{"kind": "not", "of": {"kind": "source", "any_of": ["airbnb"]}}'::jsonb) then
    raise exception 'negation cannot be expressed';
  end if;

  if public.promotion_condition_valid(
    '{"kind": "compare", "basis": "moon_phase", "comparator": "gte", "value": 5}'::jsonb) then
    raise exception 'a condition could test a fact no booking has';
  end if;
  if public.promotion_condition_valid(
    '{"kind": "compare", "basis": "nights", "comparator": "like", "value": 5}'::jsonb) then
    raise exception 'a condition could use a comparator the evaluator has no case for';
  end if;
  if public.promotion_condition_valid(
    '{"kind": "compare", "basis": "nights", "comparator": "gte", "value": "5"}'::jsonb) then
    -- src/lib/promotions/conditions.ts does not coerce, deliberately — 0067's
    -- lesson. A string here evaluates to "not comparable" forever, and the
    -- campaign sits on the screen looking configured and never fires once.
    raise exception 'a threshold could be a string that no comparison will match';
  end if;
  if public.promotion_condition_valid(
    '{"kind": "source", "any_of": ["carrier_pigeon"]}'::jsonb) then
    raise exception 'a condition could name a booking source that does not exist';
  end if;
  if public.promotion_condition_valid(
    '{"kind": "weekday_set", "all_of": [0, 9]}'::jsonb) then
    raise exception 'a condition could name a ninth day of the week';
  end if;
  if public.promotion_condition_valid('[]'::jsonb) then
    raise exception 'a condition could be an array';
  end if;
  if public.promotion_condition_valid('null'::jsonb) then
    raise exception 'a condition could be json null';
  end if;
  -- The transcribed booking-source list, checked against the real enum. The
  -- validator cannot read the enum without declaring a volatility it does not
  -- have (see the `source` arm), so the drift is caught here instead — at
  -- migration time, loudly, rather than by a campaign that silently stops
  -- accepting a channel somebody added.
  select string_agg(drifted.label, ', ') into v_offending
  from (
    select shipped.value::text
    from unnest(enum_range(null::public.booking_source)) as shipped(value)
    except
    select transcribed.value
    from unnest(array[
      'direct_website', 'direct_manual', 'agent', 'agency',
      'airbnb', 'booking_com', 'vrbo', 'other_channel'
    ]) as transcribed(value)
  ) as drifted(label);
  if v_offending is not null then
    raise exception
      'booking_source has gained % since promotion_condition_valid transcribed it, so a campaign cannot name that channel',
      v_offending;
  end if;

  -- Seven levels: one past the limit. Built rather than typed, so the test is
  -- of the limit and not of somebody's bracket counting.
  if public.promotion_condition_valid(
    ('{"kind":"all","of":[{"kind":"all","of":[{"kind":"all","of":['
     || '{"kind":"all","of":[{"kind":"all","of":[{"kind":"all","of":['
     || '{"kind":"all","of":[{"kind":"compare","basis":"nights",'
     || '"comparator":"gte","value":2}]}]}]}]}]}]}]}')::jsonb) then
    raise exception 'a condition tree could nest past the readable limit';
  end if;


  /* ══ WHAT LIKE DOES NOT COPY: PRIVILEGES AND ROW LEVEL SECURITY ════════ */

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'promotions'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'promotions is not forced';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'coupons'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'coupons is not forced';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'discount_redemptions'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'discount_redemptions is not forced';
  end if;

  select string_agg(distinct table_name || ' → ' || grantee::text, ', ')
    into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('promotions', 'coupons', 'discount_redemptions')
    and grantee in ('anon', 'PUBLIC');
  if v_offending is not null then
    raise exception 'the campaign catalogue is reachable by: %', v_offending;
  end if;

  -- The ledger has exactly one writer, and it is not a request path.
  --
  -- The three request roles only. The table's OWNER keeps its implicit
  -- privileges and must — `redeem_discount` is SECURITY DEFINER and runs as
  -- that owner, which is the single writer this check exists to leave in
  -- place. Naming the roles rather than asking for "anybody" is the difference
  -- between a check that passes and one that refuses its own design.
  select string_agg(distinct grantee::text, ', ') into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'discount_redemptions'
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_offending is not null then
    raise exception
      'discount_redemptions can be written directly by: % — the ordinal would then be allocated by somebody who is not counting',
      v_offending;
  end if;

  -- A campaign that was redeemed must not be erasable.
  select string_agg(distinct table_name || ' → ' || grantee::text, ', ')
    into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('promotions', 'coupons')
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    and privilege_type in ('DELETE', 'TRUNCATE');
  if v_offending is not null then
    raise exception 'a campaign can be deleted, taking its prices with it: %',
      v_offending;
  end if;

  -- Every policy asks both questions. A policy that named the tenant and
  -- forgot the permission would let anybody in the organization write a
  -- campaign, which is the difference between a discount and a shared till.
  select string_agg(c.relname || '.' || p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('promotions', 'coupons', 'discount_redemptions')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%my_organizations%';
  if v_offending is not null then
    raise exception 'policies without a tenant boundary: %', v_offending;
  end if;

  select string_agg(c.relname || '.' || p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('promotions', 'coupons', 'discount_redemptions')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%has_permission%';
  if v_offending is not null then
    raise exception 'policies that ask for no permission: %', v_offending;
  end if;

  -- The ledger names a property, so it is scoped by one.
  select string_agg(p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'discount_redemptions'
    and coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        not like '%property_in_scope%';
  if v_offending is not null then
    raise exception
      'the redemption ledger is readable outside a reader''s properties: %',
      v_offending;
  end if;


  /* ══ THE DEFINER FUNCTION ══════════════════════════════════════════════ */

  select array_to_string(p.proconfig, ',') into v_offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'redeem_discount';
  if v_offending is null or v_offending not like '%search_path=%' then
    raise exception
      'redeem_discount is SECURITY DEFINER without a pinned search_path';
  end if;

  select array_to_string(p.proconfig, ',') into v_offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'promotion_condition_valid';
  if v_offending is null or v_offending not like '%search_path=%' then
    raise exception 'the condition guard has a mutable search_path';
  end if;

  -- A REVOKE FROM PUBLIC does not remove Supabase's explicit grant to anon.
  -- Both were named; this checks that naming them worked.
  select string_agg(routine_name || ' → ' || grantee::text, ', ')
    into v_offending
  from information_schema.role_routine_grants
  where routine_schema = 'public'
    and routine_name in ('redeem_discount', 'promotion_condition_valid')
    and grantee in ('anon', 'PUBLIC');
  if v_offending is not null then
    raise exception 'anon may execute: %', v_offending;
  end if;

  -- The tenant boundary, exercised rather than asserted, exactly as 0061 does.
  -- Running as the migration role there is no auth.uid(), so my_organizations()
  -- is empty and every id is foreign — which is the case that must be refused.
  -- If this ever stops raising, the function has stopped checking membership.
  begin
    perform public.redeem_discount(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000003'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid,
      27800,
      '{}'::jsonb,
      null,
      '00000000-0000-4000-8000-000000000004'::uuid);
    raise exception
      'redeem_discount accepted an organization the caller is not a member of';
  exception
    when insufficient_privilege then null;
  end;


  /* ══ THE KEY SECTION 1 ADDED ═══════════════════════════════════════════ */

  if not exists (
    select 1 from pg_constraint
    where conname = 'booking_price_lines_id_organization_key'
      and conrelid = 'public.booking_price_lines'::regclass
  ) then
    raise exception
      'booking_price_lines cannot be referenced tenant-safely, so a redemption could name a stranger''s price line';
  end if;

  if exists (select 1 from public.promotions)
  or exists (select 1 from public.coupons)
  or exists (select 1 from public.discount_redemptions) then
    raise exception 'the rehearsal gave money away';
  end if;
end $$;
