-- ============================================================================
-- 0029_laundry.sql — ESTIA · what has to be clean, and who is washing it
--
-- What this does
--   Five tables, and one idea holding them together: the laundry module never
--   decides *how much* of anything is needed. Preparation already decided that
--   — `preparation_snapshots` froze the rules and `work_plans` holds the
--   computed requirement — and this schema stores only the two things
--   preparation has no opinion about: which of those items go to a wash at
--   all, and what happened to them once they did.
--
--     `laundry_settings`       how much of a laundry operation this business
--                              runs, per organization and per property
--     `laundry_item_profiles`  which catalogue items are laundry, and how they
--                              are counted, bundled and routed
--     `laundry_providers`      the outside companies
--     `laundry_orders`         one run — one provider, one required-by
--     `laundry_order_lines`    what is in it, per property, per item
--
-- ── Why there is no `laundry_requirements` table ────────────────────────────
--
--   A laundry requirement is a *projection*: this booking's linen requirement,
--   filtered to the items whose profile says `laundry_managed`, grouped by the
--   day it must be clean by. Every input to it is already stored — the frozen
--   snapshot in `preparation_snapshots`, the plan in `work_plans`, the profile
--   below — and storing the output as well would create a second number for
--   the same fact, which drifts the first time somebody edits a profile and
--   the projection is not recomputed.
--
--   What IS stored is the moment a projection became a commitment: an order.
--   That is a different kind of fact — a message went to an outside company —
--   and it is stored with the quantity it was sent with, frozen, in
--   `laundry_order_lines.calculated_quantity`.
--
-- ── The three-column quantity, and why none of them may be dropped ──────────
--
--   `calculated_quantity` is what the engine derived from the preparation
--   requirement. `adjustment_quantity` is what a human added or removed, with
--   `adjustment_reason` beside it and NOT NULL-enforced when it is non-zero.
--   `final_quantity` is a generated column: the sum, computed by the database,
--   so no writer can ever store a final that is not its two parts.
--
--   The reason this is three columns rather than one is the argument in
--   `src/lib/laundry/override.ts`: an override that overwrites the calculated
--   figure destroys the only evidence of what the system thought, and the
--   question asked three weeks later is never "how many did we send" — the
--   delivery note answers that — but "did we send the wrong number, or did the
--   engine". One column cannot answer it, and the generated column means the
--   answer cannot be faked.
--
-- ── A provider never learns who the guest is ───────────────────────────────
--
--   `laundry_orders` has no `guest_id`, no `booking_id`, and no money column
--   anywhere in this migration. That is not an omission to be corrected later:
--   the rendered order message is the one artefact in this product that leaves
--   the organization addressed to a company with no contractual relationship
--   to the guest, and `src/lib/laundry/message.test.ts` asserts field by field
--   that a guest's name, telephone, price, payment state and agent do not
--   appear in it. A column here would make that assertion a matter of the
--   renderer remembering, rather than of there being nothing to render.
--
--   The join that a manager legitimately needs — which booking caused this
--   line — is `laundry_order_lines.source_booking_id`, which is INTERNAL: it
--   is read by ESTIA's own screens under `laundry.view` and it is not a field
--   the message renderer is given. The provider gets `reference`, which is an
--   opaque per-organization string.
--
-- ── `property_id` is nullable on an order, and that is the consolidation ────
--
--   One van collects from three houses on Thursday. The specification is
--   explicit that the per-property breakdown must survive — never collapsed
--   into a total — so the breakdown lives on the LINES, each of which carries
--   a NOT NULL `property_id`, and the order itself carries NULL to mean "more
--   than one". `laundry_orders_property_matches_lines` is not expressible as a
--   check constraint over another table, so it is a trigger.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, property_in_scope), 0009 (bookings),
--   0012 (laundry.view, laundry.manage, laundry.order_create,
--   laundry.order_send, laundry.provider_manage), 0014 (the rule that a
--   function in `public` is an API surface until its grants say otherwise),
--   0021 (preparation_catalogues — the item ids these profiles key on).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The vocabularies
-- ============================================================================
-- Every one of these is transcribed from `src/lib/contracts/states.ts`, in the
-- same order, and the order is load-bearing: an enum's ordinal is what
-- `order by status` sorts on, and a dashboard that lists an order's life out of
-- sequence is a dashboard nobody trusts.

-- LAUNDRY_MODES, in order.
do $$ begin
  create type public.laundry_mode as enum (
    'off',
    'simple',
    'internal',
    'external',
    'hybrid'
  );
exception when duplicate_object then null;
end $$;

comment on type public.laundry_mode is
  'Transcribed from LAUNDRY_MODES in src/lib/contracts/states.ts, in the same order. `off` is a first-class answer and the default: preparation works completely without any of this. A business on `simple` must never be shown warehouse or logistics vocabulary — see src/lib/laundry/mode.ts.';

-- LAUNDRY_STATUSES, in order.
do $$ begin
  create type public.laundry_status as enum (
    'draft',
    'awaiting_approval',
    'to_collect',
    'collected',
    'sorting',
    'washing',
    'drying',
    'folding',
    'ready',
    'delivered_to_property',
    'completed',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.laundry_status is
  'Transcribed from LAUNDRY_STATUSES in src/lib/contracts/states.ts, in the same order. Deliberately longer than most businesses will use: a `simple` operation moves draft to completed and never touches the middle, an internal laundry room uses every state, and both mean the same thing by "washing".';

-- LAUNDRY_DISPATCH_MODES, in order.
do $$ begin
  create type public.laundry_dispatch_mode as enum (
    'manual_send',
    'approval_required',
    'auto_send'
  );
exception when duplicate_object then null;
end $$;

comment on type public.laundry_dispatch_mode is
  'Transcribed from LAUNDRY_DISPATCH_MODES. The column default is `approval_required` and that is a safety decision rather than a taste one: an order sent automatically is a message in the organization''s name to an outside company, and a business must opt into that rather than discover it.';

-- LAUNDRY_CHANNELS, in order.
do $$ begin
  create type public.laundry_channel as enum (
    'whatsapp',
    'sms',
    'email',
    'print',
    'export',
    'copy'
  );
exception when duplicate_object then null;
end $$;

-- REQUIREMENT_UNITS, from src/lib/preparation/types.ts, in order.
--
-- Reused rather than restated. A laundry line counts the same things a
-- preparation requirement counts, and a second unit vocabulary would mean a
-- requirement measured in `set` could become an order line measured in
-- something the preparation engine has never heard of.
do $$ begin
  create type public.requirement_unit as enum (
    'piece',
    'set',
    'pack',
    'person',
    'hour'
  );
exception when duplicate_object then null;
end $$;

comment on type public.requirement_unit is
  'Transcribed from REQUIREMENT_UNITS in src/lib/preparation/types.ts, in the same order. Shared with laundry deliberately: a laundry line counts what a preparation requirement counts, and two unit vocabularies would let a requirement measured in sets become an order line measured in something preparation never heard of.';

-- Which way one item goes, under `hybrid`.
--
-- Not in the frozen contracts, because it is not a lifecycle — it is one
-- item's routing, and it exists only because `hybrid` is the real shape of
-- many businesses: they wash towels themselves and send linen out. Under every
-- other mode this column is ignored, and `laundry_item_profiles_route_needed`
-- below is what stops a hybrid organization from having an item with no answer.
do $$ begin
  create type public.laundry_route as enum (
    'internal',
    'external'
  );
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 2 · laundry_settings — how much of an operation this is
-- ============================================================================
-- One row per organization with `property_id` NULL, and optionally one row per
-- property that overrides it. Two partial unique indexes rather than one
-- constraint, because `unique (organization_id, property_id)` does not
-- constrain the NULL row at all in Postgres — NULLs are distinct — and an
-- organization with two conflicting defaults is a business that cannot be told
-- which mode it is in.
--
-- The override is per property and NOT per column: a property row supplies a
-- whole configuration or none. Column-level fallback reads well in a
-- specification and produces, in practice, a screen where a manager cannot tell
-- which of six values they are actually running on. `resolveSettings` in
-- src/lib/laundry/settings.ts picks one row and says which.

create table if not exists public.laundry_settings (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  -- NULL is the organization-wide row. A uuid is a property override.
  property_id             uuid,

  mode                    public.laundry_mode not null default 'off',
  dispatch_mode           public.laundry_dispatch_mode not null default 'approval_required',
  default_channel         public.laundry_channel not null default 'whatsapp',
  default_provider_id     uuid,

  -- Hours, not days. A provider quoting "next day" and one quoting "48 hours"
  -- are both ordinary, and a day-granularity column cannot express the first
  -- one honestly against a Friday afternoon arrival.
  turnaround_hours        integer not null default 24,

  -- ISO weekday numbers, 1 = Monday .. 7 = Sunday. An array rather than seven
  -- booleans so a screen can render them in the customer's own order, and
  -- `iso` rather than `dow` because Postgres has both and the two disagree
  -- about Sunday, which in Israel is a working day and therefore the one that
  -- matters.
  pickup_days             smallint[] not null default '{}',
  delivery_days           smallint[] not null default '{}',

  forecast_horizon_days   integer not null default 7,

  -- Free text the renderer appends to every order for this organization —
  -- a gate code, a delivery instruction. Never guest information; see the
  -- header.
  standing_notes          text,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,

  constraint laundry_settings_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  -- A positive turnaround. Zero would mean the linen returns at the instant it
  -- was collected, which makes every deadline-risk comparison pass.
  constraint laundry_settings_turnaround_positive
    check (turnaround_hours > 0),

  -- The horizon a business may ask the forecast for. The engine itself accepts
  -- any positive integer — `src/lib/laundry/no-hardcoded-numbers.test.ts`
  -- proves it by running the forecast over a randomly chosen horizon — so this
  -- is the product's offered set rather than an arithmetic limit, and it lives
  -- here because a migration is where a business number belongs.
  constraint laundry_settings_horizon_offered
    check (forecast_horizon_days in (3, 7, 14, 30)),

  constraint laundry_settings_pickup_days_valid
    check (pickup_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  constraint laundry_settings_delivery_days_valid
    check (delivery_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),

  constraint laundry_settings_version_positive check (version >= 1)
);

comment on table public.laundry_settings is
  'How much of a laundry operation a business runs, per organization and optionally per property. One row with property_id NULL is the organization default; a property row overrides it whole rather than column by column, so a manager can always be told which single configuration they are running on. `off` is the default and preparation works completely without any of this.';

comment on column public.laundry_settings.pickup_days is
  'ISO weekday numbers, 1 = Monday .. 7 = Sunday. ISO rather than Postgres `dow` because the two disagree about Sunday, which in Israel is a working day.';

-- The organization-wide row: exactly one, enforced where a plain unique
-- constraint would enforce nothing.
create unique index if not exists laundry_settings_organization_default_key
  on public.laundry_settings (organization_id)
  where property_id is null;

create unique index if not exists laundry_settings_property_key
  on public.laundry_settings (organization_id, property_id)
  where property_id is not null;

drop trigger if exists laundry_settings_touch on public.laundry_settings;
create trigger laundry_settings_touch
  before update on public.laundry_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · laundry_providers — the outside companies
-- ============================================================================
-- Deliberately thin on commerce. There is a `price_list` because a manager
-- comparing two providers needs one, and there is no invoice, no payment and
-- no balance: money owed to a supplier is `expenses` in 0016's territory, and
-- a second accounts-payable model living in the laundry module would be a
-- second set of numbers for the same debt.

create table if not exists public.laundry_providers (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,

  name                    text not null,
  contact_name            text,
  phone                   text,
  email                   text,

  -- How this provider is reached by default. An order may override it, because
  -- the person who normally gets a WhatsApp is on holiday and email is what is
  -- left.
  default_channel         public.laundry_channel not null default 'whatsapp',

  turnaround_hours        integer not null default 24,
  pickup_days             smallint[] not null default '{}',
  delivery_days           smallint[] not null default '{}',

  -- Pieces, not money. A provider that will not send a van for six towels is
  -- an operational fact the order builder has to respect.
  minimum_order_units     integer not null default 0,

  -- `{ "<itemId>": { "label": text, "unitAgorot": integer } }`. Agorot, like
  -- every other money value in this schema.
  price_list              jsonb not null default '{}'::jsonb,

  notes                   text,
  is_active               boolean not null default true,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  deleted_at              timestamptz,
  version                 integer not null default 1,

  constraint laundry_providers_name_present
    check (length(btrim(name)) > 0),
  constraint laundry_providers_turnaround_positive
    check (turnaround_hours > 0),
  constraint laundry_providers_minimum_not_negative
    check (minimum_order_units >= 0),
  constraint laundry_providers_price_list_is_object
    check (jsonb_typeof(price_list) = 'object'),
  constraint laundry_providers_pickup_days_valid
    check (pickup_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  constraint laundry_providers_delivery_days_valid
    check (delivery_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),

  -- A provider must be reachable by the channel it is set to. `print`,
  -- `export` and `copy` produce something a person carries, so they need
  -- neither; the other three do, and an order that cannot be delivered is
  -- better refused here than discovered at the moment somebody presses send.
  constraint laundry_providers_reachable check (
    default_channel not in ('whatsapp', 'sms', 'email')
    or (default_channel in ('whatsapp', 'sms') and phone is not null
        and length(btrim(phone)) > 0)
    or (default_channel = 'email' and email is not null
        and length(btrim(email)) > 0)
  ),

  constraint laundry_providers_version_positive check (version >= 1)
);

comment on table public.laundry_providers is
  'An outside laundry company. Thin on commerce on purpose: there is a price list so a manager can compare, and no invoice, payment or balance — what is owed to a supplier is an expense in 0016''s territory, and a second accounts-payable model here would be a second set of numbers for the same debt.';

create index if not exists laundry_providers_organization_idx
  on public.laundry_providers (organization_id)
  where deleted_at is null;

drop trigger if exists laundry_providers_touch on public.laundry_providers;
create trigger laundry_providers_touch
  before update on public.laundry_providers
  for each row execute function public.tg_touch_row();

-- The settings' default provider, added after the table it points at exists.
do $$ begin
  alter table public.laundry_settings
    add constraint laundry_settings_provider_fkey
    foreign key (default_provider_id)
    references public.laundry_providers (id) on delete set null;
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 4 · laundry_item_profiles — which items are laundry at all
-- ============================================================================
-- THE TABLE THIS MODULE EXISTS AROUND.
--
-- The engine's job is not to send every preparation item to the laundry.
-- Sheets, pillowcases, duvet covers, towels, blankets, bath mats and robes go;
-- mattresses, cribs, tables, toilet paper and coffee do not. It would be one
-- afternoon's work to write that list in TypeScript and it would be wrong by
-- the second customer — the one with linen-lined bassinets, or the one whose
-- "towels" are the property's and never leave it.
--
-- So it is a row per item, keyed on the organization's own catalogue key: the
-- same `itemId` that `preparation_rules` uses inside
-- `preparation_catalogues.rules`. An item with no profile row is NOT laundry,
-- which is the safe default in both directions — nothing is sent that nobody
-- asked to send, and nothing is silently dropped from a wash it was configured
-- for.

create table if not exists public.laundry_item_profiles (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,

  -- The organization's own catalogue key, joining this to the preparation
  -- rules that produce the quantity. Text rather than a foreign key because
  -- 0021 stores the catalogue as jsonb — see its header for why — so there is
  -- no row to point at.
  item_id                 text not null,
  label                   text not null,

  -- Does this item go to a wash at all.
  laundry_managed         boolean not null default false,
  -- Can it survive one. A weighted blanket may be laundry-managed and dry-clean
  -- only; the two are different facts and collapsing them sends it to a machine.
  washable                boolean not null default true,
  -- May it leave the premises. Some organizations will not send monogrammed
  -- linen to a third party at any price.
  external_laundry_allowed boolean not null default true,

  -- Under `hybrid`, which way this one goes. Ignored under every other mode.
  route                   public.laundry_route,

  default_provider_id     uuid references public.laundry_providers (id) on delete set null,

  -- Overrides the settings' and the provider's, for this item only. A duvet
  -- takes longer than a hand towel and every provider knows it.
  turnaround_hours        integer,

  unit                    public.requirement_unit not null default 'piece',

  -- How many pieces the provider counts as one billable bundle. 1 means the
  -- item is counted individually, which is the ordinary case.
  bundle_size             integer not null default 1,

  -- Spare capacity added to every laundry requirement for this item, on top of
  -- whatever buffer preparation already applied. Distinct from preparation's
  -- buffer and deliberately so: preparation's covers a guest who wants a second
  -- towel, this one covers a sheet that comes back stained.
  minimum_buffer          integer not null default 0,

  notes                   text,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,

  constraint laundry_item_profiles_item_key unique (organization_id, item_id),

  constraint laundry_item_profiles_item_present
    check (length(btrim(item_id)) > 0),
  constraint laundry_item_profiles_label_present
    check (length(btrim(label)) > 0),
  constraint laundry_item_profiles_bundle_positive
    check (bundle_size >= 1),
  constraint laundry_item_profiles_buffer_not_negative
    check (minimum_buffer >= 0),
  constraint laundry_item_profiles_turnaround_positive
    check (turnaround_hours is null or turnaround_hours > 0),

  -- An item that may not be washed cannot be laundry-managed. The two columns
  -- are independent facts and this is the one combination that is not a fact
  -- but a contradiction.
  constraint laundry_item_profiles_managed_is_washable
    check (not laundry_managed or washable),

  -- An item routed externally that is not allowed out. Same shape of
  -- contradiction, caught here rather than at the moment an order is built.
  constraint laundry_item_profiles_route_permitted
    check (route is distinct from 'external'::public.laundry_route
           or external_laundry_allowed),

  constraint laundry_item_profiles_version_positive check (version >= 1)
);

comment on table public.laundry_item_profiles is
  'Which catalogue items are laundry, and how each is counted, bundled, buffered and routed. The list of what counts as linen is CONFIGURATION and never code — a hardcoded list is wrong by the second customer. An item with no row here is not laundry, which is the safe default in both directions.';

comment on column public.laundry_item_profiles.minimum_buffer is
  'Spare added to this item''s laundry requirement, on top of whatever buffer preparation already applied. Deliberately distinct: preparation''s buffer covers a guest who wants a second towel, this one covers a sheet that comes back stained.';

create index if not exists laundry_item_profiles_organization_idx
  on public.laundry_item_profiles (organization_id);

create index if not exists laundry_item_profiles_managed_idx
  on public.laundry_item_profiles (organization_id, laundry_managed);

drop trigger if exists laundry_item_profiles_touch on public.laundry_item_profiles;
create trigger laundry_item_profiles_touch
  before update on public.laundry_item_profiles
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · laundry_orders — one run
-- ============================================================================
-- One provider, one required-by, one or many properties.
--
-- `requirement_key` is the durable half of idempotency. The service pipeline's
-- `IdempotencyStore` already refuses a replayed request, and it is scoped to
-- the organization and the operation and keyed on whatever the caller passed —
-- which means it protects a double-clicked form and nothing else. Two
-- different sessions, or a job re-run after a deploy, produce two requests
-- with two keys and the store has no opinion. This constraint does: the key is
-- derived from the provider, the required-by day and the content of the lines
-- (see `orderRequirementKey` in src/lib/laundry/orders.ts), so the *same wash*
-- cannot be ordered twice however it is submitted, and a genuinely different
-- wash for the same provider on the same day gets a different key and is
-- allowed through.

create table if not exists public.laundry_orders (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,

  -- NULL means consolidated: more than one property in one run. The breakdown
  -- is never collapsed — it lives on the lines, each of which carries a
  -- property. `tg_laundry_orders_property_agrees` keeps the two honest.
  property_id             uuid,

  provider_id             uuid references public.laundry_providers (id) on delete restrict,

  status                  public.laundry_status not null default 'draft',
  -- Which mode produced it, frozen. An organization that moves from `external`
  -- to `internal` in March must not make February's orders unreadable.
  mode                    public.laundry_mode not null,
  dispatch_mode           public.laundry_dispatch_mode not null default 'approval_required',
  channel                 public.laundry_channel not null default 'whatsapp',

  -- What the provider is told to call it, and the only identifier they get.
  -- Opaque on purpose: see the header.
  reference               text not null,

  -- The idempotency anchor. See above.
  requirement_key         text not null,

  -- When the linen has to be back and clean. Not the arrival — the arrival is
  -- a booking's business and this table holds no booking.
  required_by             timestamptz not null,
  pickup_at               timestamptz,
  -- Collected plus turnaround, computed by the engine and stored so a
  -- dashboard does not have to re-derive it from a provider whose turnaround
  -- may have changed since.
  expected_return_at      timestamptz,
  returned_at             timestamptz,
  sent_at                 timestamptz,
  sent_by                 uuid references auth.users (id) on delete set null,

  -- The rendered message, frozen at the moment it was sent. What was actually
  -- said, rather than what the renderer would say today.
  sent_body               text,

  -- Internal only. Never rendered into the provider message.
  internal_notes          text,
  -- Rendered into the provider message. Reviewed by whoever sends it.
  provider_notes          text,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,

  constraint laundry_orders_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  constraint laundry_orders_reference_key unique (organization_id, reference),
  constraint laundry_orders_requirement_key unique (organization_id, requirement_key),

  constraint laundry_orders_reference_present
    check (length(btrim(reference)) > 0),
  constraint laundry_orders_requirement_key_present
    check (length(btrim(requirement_key)) > 0),

  -- An order that has gone out names who sent it and what was said. Three
  -- columns that are meaningless apart, so they are constrained together.
  constraint laundry_orders_sent_is_complete check (
    (sent_at is null and sent_by is null and sent_body is null)
    or (sent_at is not null and sent_body is not null)
  ),

  -- A sent order is not a draft. `COMMITTED_LAUNDRY_STATUSES` in the frozen
  -- contract names the moment an order stops being freely editable, and this
  -- is the database half of it.
  constraint laundry_orders_sent_has_left_draft check (
    sent_at is null
    or status not in ('draft', 'awaiting_approval')
  ),

  -- An external order needs somebody to send it to. An internal batch does not
  -- — there is no outside company — so the provider is required by mode
  -- rather than by NOT NULL.
  constraint laundry_orders_provider_by_mode check (
    mode <> 'external'::public.laundry_mode or provider_id is not null
  ),

  constraint laundry_orders_return_after_pickup check (
    pickup_at is null or expected_return_at is null
    or expected_return_at >= pickup_at
  ),

  constraint laundry_orders_version_positive check (version >= 1)
);

comment on table public.laundry_orders is
  'One laundry run: one provider, one required-by, one or many properties. Carries no guest, no booking and no money — the rendered message leaves the organization addressed to a company with no relationship to the guest, and the privacy guarantee is that there is nothing here to leak rather than that the renderer remembers to omit it.';

comment on column public.laundry_orders.requirement_key is
  'Derived from the provider, the required-by day and the content of the lines. The durable half of idempotency: the pipeline''s store protects a double-clicked form, and this protects the same wash arriving from a different session or a re-run job.';

comment on column public.laundry_orders.property_id is
  'NULL means consolidated — more than one property in one run. The per-property breakdown is never collapsed into a total; it lives on the lines.';

create index if not exists laundry_orders_organization_status_idx
  on public.laundry_orders (organization_id, status, required_by);

create index if not exists laundry_orders_property_idx
  on public.laundry_orders (organization_id, property_id, required_by);

create index if not exists laundry_orders_provider_idx
  on public.laundry_orders (organization_id, provider_id, required_by);

drop trigger if exists laundry_orders_touch on public.laundry_orders;
create trigger laundry_orders_touch
  before update on public.laundry_orders
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · laundry_order_lines — the breakdown that must survive
-- ============================================================================
-- One row per property per item. NOT one row per item with the properties
-- summed: the specification's word for that is "collapsed into a total", and
-- the reason it matters is the van. A consolidated order of 74 linen sets tells
-- a driver nothing; 30 to the Galilee house, 44 to the Carmel one is the
-- delivery.
--
-- `final_quantity` is GENERATED. See the header for why the three columns
-- exist; the generated column is why they cannot disagree.

create table if not exists public.laundry_order_lines (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  order_id                uuid not null references public.laundry_orders (id) on delete cascade,

  -- NOT NULL, even on a single-property order. The breakdown is the record.
  property_id             uuid not null,

  item_id                 text not null,
  label                   text not null,
  unit                    public.requirement_unit not null default 'piece',

  -- What the engine derived from the canonical preparation requirement.
  -- Frozen at the moment the order was built and never rewritten.
  calculated_quantity     integer not null,
  -- What a person added or removed. Signed.
  adjustment_quantity     integer not null default 0,
  -- The sum, computed by the database so no writer can store a third number.
  final_quantity          integer generated always as
                            (calculated_quantity + adjustment_quantity) stored,
  adjustment_reason       text,
  adjusted_by             uuid references auth.users (id) on delete set null,
  adjusted_at             timestamptz,

  -- The arithmetic, in the organization's own words: "25 מגבות = 25 אורחים ×
  -- 1 לאורח". Written by the engine that did the multiplying, because only it
  -- knows which rule produced which part. A generic breakdown can show the
  -- number and not the sentence, which is the black box the charter forbids.
  explanation             jsonb not null default '[]'::jsonb,

  -- Internal. Which booking caused this line, for ESTIA's own screens. Never
  -- given to the message renderer — see the header.
  source_booking_id       uuid references public.bookings (id) on delete set null,

  -- Per line, because a consolidated order can carry two properties with two
  -- different arrival times and the tighter one is what the provider must meet.
  required_by             timestamptz not null,

  notes                   text,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,

  constraint laundry_order_lines_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  constraint laundry_order_lines_item_key
    unique (order_id, property_id, item_id),

  constraint laundry_order_lines_item_present
    check (length(btrim(item_id)) > 0),
  constraint laundry_order_lines_label_present
    check (length(btrim(label)) > 0),

  -- The engine never computes a negative requirement.
  constraint laundry_order_lines_calculated_not_negative
    check (calculated_quantity >= 0),

  -- An adjustment must not drive the order below nothing. Removing a line
  -- entirely is a deletion, which is a different act with a different audit
  -- event; an adjustment of -30 against a calculated 25 is a mistake.
  constraint laundry_order_lines_final_not_negative
    check (calculated_quantity + adjustment_quantity >= 0),

  -- AN OVERRIDE WITHOUT A REASON IS NOT AN OVERRIDE. The interesting question
  -- three weeks later is never "was it adjusted" but "what did they say at the
  -- time", and a nullable reason column is one nobody fills in.
  constraint laundry_order_lines_adjustment_is_explained check (
    adjustment_quantity = 0
    or (adjustment_reason is not null
        and length(btrim(adjustment_reason)) > 0
        and adjusted_at is not null)
  ),

  constraint laundry_order_lines_explanation_is_array
    check (jsonb_typeof(explanation) = 'array'),

  constraint laundry_order_lines_version_positive check (version >= 1)
);

comment on table public.laundry_order_lines is
  'One row per property per item, never summed across properties: a consolidated order of 74 linen sets tells a driver nothing, and 30 to one house and 44 to the other is the delivery. final_quantity is generated from calculated plus adjustment so the three numbers cannot disagree, and an adjustment without a stated reason is refused by constraint.';

comment on column public.laundry_order_lines.explanation is
  'The arithmetic in the organization''s own words, written by the engine that did the multiplying. A generic breakdown can show the number and not the sentence, which is the black box the charter forbids.';

create index if not exists laundry_order_lines_order_idx
  on public.laundry_order_lines (order_id);

create index if not exists laundry_order_lines_organization_property_idx
  on public.laundry_order_lines (organization_id, property_id, required_by);

create index if not exists laundry_order_lines_booking_idx
  on public.laundry_order_lines (organization_id, source_booking_id)
  where source_booking_id is not null;

drop trigger if exists laundry_order_lines_touch on public.laundry_order_lines;
create trigger laundry_order_lines_touch
  before update on public.laundry_order_lines
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · The two rules a check constraint cannot express
-- ============================================================================

-- A line belongs to its order's organization, and to its order's property when
-- that order names one.
--
-- The first half is the tenant boundary and RLS already enforces it for an
-- ordinary caller — but `service_role` carries BYPASSRLS, and a background job
-- writing a line with the wrong `organization_id` would produce a row that one
-- tenant's policies admit and another tenant's order owns. The second half is
-- the consolidation invariant: an order that names a property may not carry a
-- line for a different one, because the order's own `property_id` is what the
-- dashboard filters on.

create or replace function public.tg_laundry_order_lines_agree()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order public.laundry_orders%rowtype;
begin
  select * into v_order
  from public.laundry_orders
  where id = new.order_id;

  if not found then
    raise exception 'laundry order % does not exist', new.order_id
      using errcode = '23503';
  end if;

  if v_order.organization_id <> new.organization_id then
    raise exception
      'laundry order line organization % does not match its order''s %',
      new.organization_id, v_order.organization_id
      using errcode = '23514';
  end if;

  if v_order.property_id is not null
     and v_order.property_id <> new.property_id then
    raise exception
      'laundry order % names property % and cannot carry a line for %',
      v_order.id, v_order.property_id, new.property_id
      using errcode = '23514',
            hint = 'A consolidated order carries property_id NULL; the breakdown lives on the lines.';
  end if;

  return new;
end;
$$;

comment on function public.tg_laundry_order_lines_agree() is
  'Refuses a laundry order line whose organization differs from its order''s, or whose property differs from an order that names one. The first half survives BYPASSRLS, which policies do not; the second is the consolidation invariant — a consolidated order carries property_id NULL and the breakdown lives on the lines.';

revoke all on function public.tg_laundry_order_lines_agree()
  from public, anon, authenticated, service_role;

drop trigger if exists laundry_order_lines_agree on public.laundry_order_lines;
create trigger laundry_order_lines_agree
  before insert or update on public.laundry_order_lines
  for each row execute function public.tg_laundry_order_lines_agree();


-- A committed order's lines are not silently edited.
--
-- `COMMITTED_LAUNDRY_STATUSES` names the moment an order leaves the
-- organization: a provider was told, a van came, a machine ran. Changing
-- quantities after that point is an amendment or a new order, never an edit —
-- and `calculated_quantity` is never editable after the order exists at all,
-- because it is the record of what the engine said.
--
-- An ADJUSTMENT is still permitted on a committed order, deliberately. The van
-- arriving and finding four fewer sheets than the note said is exactly when
-- somebody needs to write down what really went, and refusing that would mean
-- the record stops matching reality precisely when it starts to matter. What
-- is refused is a rewrite of the engine's figure.

create or replace function public.tg_laundry_order_lines_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.calculated_quantity <> old.calculated_quantity then
    raise exception
      'laundry order line % may not have its calculated quantity rewritten (% to %)',
      old.id, old.calculated_quantity, new.calculated_quantity
      using errcode = '23514',
            hint = 'Record the difference as adjustment_quantity with a reason; the calculated figure is what the engine said and is evidence.';
  end if;

  if new.item_id <> old.item_id or new.property_id <> old.property_id then
    raise exception
      'laundry order line % may not be repointed at another item or property',
      old.id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.tg_laundry_order_lines_frozen() is
  'Refuses a rewrite of a laundry order line''s calculated quantity, item or property. Adjustments stay permitted on a committed order — the van finding four fewer sheets than the note said is exactly when somebody must be able to write down what really went — and only the engine''s own figure is frozen.';

revoke all on function public.tg_laundry_order_lines_frozen()
  from public, anon, authenticated, service_role;

drop trigger if exists laundry_order_lines_frozen on public.laundry_order_lines;
create trigger laundry_order_lines_frozen
  before update on public.laundry_order_lines
  for each row execute function public.tg_laundry_order_lines_frozen();


-- ============================================================================
-- 8 · Row level security
-- ============================================================================

alter table public.laundry_settings       enable row level security;
alter table public.laundry_settings       force  row level security;
alter table public.laundry_providers      enable row level security;
alter table public.laundry_providers      force  row level security;
alter table public.laundry_item_profiles  enable row level security;
alter table public.laundry_item_profiles  force  row level security;
alter table public.laundry_orders         enable row level security;
alter table public.laundry_orders         force  row level security;
alter table public.laundry_order_lines    enable row level security;
alter table public.laundry_order_lines    force  row level security;

revoke all on public.laundry_settings      from anon, authenticated;
revoke all on public.laundry_providers     from anon, authenticated;
revoke all on public.laundry_item_profiles from anon, authenticated;
revoke all on public.laundry_orders        from anon, authenticated;
revoke all on public.laundry_order_lines   from anon, authenticated;

grant select, insert, update, delete on public.laundry_settings      to authenticated;
grant select, insert, update, delete on public.laundry_providers     to authenticated;
grant select, insert, update, delete on public.laundry_item_profiles to authenticated;
grant select, insert, update         on public.laundry_orders        to authenticated;
grant select, insert, update, delete on public.laundry_order_lines   to authenticated;

grant select, insert, update, delete on public.laundry_settings      to service_role;
grant select, insert, update, delete on public.laundry_providers     to service_role;
grant select, insert, update, delete on public.laundry_item_profiles to service_role;
grant select, insert, update         on public.laundry_orders        to service_role;
grant select, insert, update, delete on public.laundry_order_lines   to service_role;

-- An order is never deleted, by anybody. It is cancelled — `cancelled` is in
-- LAUNDRY_STATUSES for exactly this — because a run that went to a provider
-- and was called off is a thing that happened, and a business that cannot show
-- the record of a cancelled order cannot argue with the invoice for it.
-- Revoked from service_role too, which carries BYPASSRLS and would otherwise
-- be the one caller policies cannot stop.
revoke delete, truncate on public.laundry_orders from service_role;


-- ── Policies · laundry_settings ─────────────────────────────────────────────
-- Reading is `laundry.view`: the mode decides what the whole section looks
-- like, and a screen that cannot read it cannot render honestly. Writing is
-- `laundry.manage`, which is the grant for configuring the operation rather
-- than working it.

drop policy if exists laundry_settings_select on public.laundry_settings;
create policy laundry_settings_select on public.laundry_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.view')
  );

drop policy if exists laundry_settings_insert on public.laundry_settings;
create policy laundry_settings_insert on public.laundry_settings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.manage')
  );

drop policy if exists laundry_settings_update on public.laundry_settings;
create policy laundry_settings_update on public.laundry_settings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.manage')
  );

drop policy if exists laundry_settings_delete on public.laundry_settings;
create policy laundry_settings_delete on public.laundry_settings
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.manage')
  );


-- ── Policies · laundry_providers ────────────────────────────────────────────
-- READING A PROVIDER IS `laundry.provider_manage`, NOT `laundry.view`.
--
-- This is the one asymmetry in the file and it is deliberate. 0035 assigns the
-- five laundry grants, and the row that matters here is the housekeeping
-- supervisor: they hold `laundry.view`, `laundry.manage` and
-- `laundry.order_create` — they have to see what must be clean by Friday and
-- raise the run for it — and they hold NEITHER `laundry.order_send` NOR
-- `laundry.provider_manage`. A cleaner holds none of the five and does not
-- reach the section at all.
--
-- A provider row is commercial information: a supplier's name, a named
-- contact, a telephone number and a price list. Keeping it from the person who
-- raises the order is not distrust — it is that raising a wash and choosing
-- who the business deals with are different acts — and the way to guarantee it
-- is not a screen omitting a column, it is a policy returning no rows.

drop policy if exists laundry_providers_select on public.laundry_providers;
create policy laundry_providers_select on public.laundry_providers
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.provider_manage')
  );

drop policy if exists laundry_providers_insert on public.laundry_providers;
create policy laundry_providers_insert on public.laundry_providers
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.provider_manage')
  );

drop policy if exists laundry_providers_update on public.laundry_providers;
create policy laundry_providers_update on public.laundry_providers
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.provider_manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.provider_manage')
  );

drop policy if exists laundry_providers_delete on public.laundry_providers;
create policy laundry_providers_delete on public.laundry_providers
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.provider_manage')
  );


-- ── Policies · laundry_item_profiles ────────────────────────────────────────
-- Reading is `laundry.view`, because the profile is half of the explanation:
-- somebody asking why the list says 28 sheets when 25 beds are made is owed the
-- buffer that produced the difference. It carries no commercial information —
-- the provider it names is a uuid, and the provider row itself is behind
-- `laundry.provider_manage` above.

drop policy if exists laundry_item_profiles_select on public.laundry_item_profiles;
create policy laundry_item_profiles_select on public.laundry_item_profiles
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.view')
  );

drop policy if exists laundry_item_profiles_insert on public.laundry_item_profiles;
create policy laundry_item_profiles_insert on public.laundry_item_profiles
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.manage')
  );

drop policy if exists laundry_item_profiles_update on public.laundry_item_profiles;
create policy laundry_item_profiles_update on public.laundry_item_profiles
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.manage')
  );

drop policy if exists laundry_item_profiles_delete on public.laundry_item_profiles;
create policy laundry_item_profiles_delete on public.laundry_item_profiles
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'laundry.manage')
  );


-- ── Policies · laundry_orders ───────────────────────────────────────────────
-- Reading an order is `laundry.view`. An internal batch IS the housekeeping
-- supervisor's work list, and hiding it from them would mean the internal mode
-- has no worker. What they cannot read is the provider row it points at, which
-- is the previous block — so they see "12 סדינים, מוכן ליום חמישי" and not who
-- is washing them or for how much.
--
-- Creating is `laundry.order_create`. Updating is `laundry.order_create` too,
-- and NOT `order_send`: advancing an order through `washing` and `folding` is
-- the ordinary work of the module, while sending it to an outside company is
-- the act that leaves the building. `order_send` gates that one act, and it is
-- checked in `sendOrder` in src/lib/laundry/operations.ts where the message is
-- actually rendered — a policy cannot tell an update that sets `status` from
-- one that sets `sent_at`, and pretending otherwise would put the whole
-- module behind the strictest grant.
--
-- 0035 makes that split real at the floor rather than only in the engine: a
-- housekeeping supervisor holds `order_create` and not `order_send`, so the
-- supervisor who raises Thursday's run and the manager who sends it to the
-- provider are two different people by permission, not by convention.

drop policy if exists laundry_orders_select on public.laundry_orders;
create policy laundry_orders_select on public.laundry_orders
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.view')
  );

drop policy if exists laundry_orders_insert on public.laundry_orders;
create policy laundry_orders_insert on public.laundry_orders
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.order_create')
  );

drop policy if exists laundry_orders_update on public.laundry_orders;
create policy laundry_orders_update on public.laundry_orders
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.order_create')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'laundry.order_create')
  );


-- ── Policies · laundry_order_lines ──────────────────────────────────────────
-- The same reach as the order, restated on the line, because a policy that
-- delegated to the parent through an EXISTS would be a second query per row on
-- the module's hottest read.

drop policy if exists laundry_order_lines_select on public.laundry_order_lines;
create policy laundry_order_lines_select on public.laundry_order_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'laundry.view')
  );

drop policy if exists laundry_order_lines_insert on public.laundry_order_lines;
create policy laundry_order_lines_insert on public.laundry_order_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'laundry.order_create')
  );

drop policy if exists laundry_order_lines_update on public.laundry_order_lines;
create policy laundry_order_lines_update on public.laundry_order_lines
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'laundry.order_create')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'laundry.order_create')
  );

drop policy if exists laundry_order_lines_delete on public.laundry_order_lines;
create policy laundry_order_lines_delete on public.laundry_order_lines
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'laundry.manage')
  );


-- ============================================================================
-- 9 · Rehearsal
-- ============================================================================
-- The same shape 0026 and 0027 used: assert what this migration assumed, so a
-- schema that has drifted fails here rather than at the moment a manager
-- presses send on an order.

do $$
declare
  missing text;
  n       integer;
begin
  -- The tables this depends on, and the ones it just created.
  select string_agg(name, ', ') into missing
  from (values
    ('organizations'), ('properties'), ('bookings'),
    ('laundry_settings'), ('laundry_providers'), ('laundry_item_profiles'),
    ('laundry_orders'), ('laundry_order_lines')
  ) as t(name)
  where not exists (
    select 1 from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
    where n2.nspname = 'public' and c.relname = t.name and c.relkind = 'r'
  );

  if missing is not null then
    raise exception 'tables missing for 0029: %', missing;
  end if;

  -- The helpers every policy above is written in terms of. A rename would make
  -- the policies fail open or fail closed, and neither is discoverable from a
  -- screen.
  select string_agg(name, ', ') into missing
  from (values
    ('my_organizations'), ('has_permission'), ('property_in_scope'),
    ('tg_touch_row')
  ) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
    where n2.nspname = 'public' and p.proname = f.name
  );

  if missing is not null then
    raise exception 'functions missing for 0029: %', missing;
  end if;

  -- The five grants this module is written against. 0012 owns the catalogue;
  -- if a grant were renamed there, every policy above would silently refuse
  -- everybody, which reads on screen as "the laundry section is empty".
  select string_agg(code, ', ') into missing
  from (values
    ('laundry.view'), ('laundry.manage'), ('laundry.order_create'),
    ('laundry.order_send'), ('laundry.provider_manage')
  ) as g(code)
  where not exists (
    select 1 from public.permissions where permissions.code = g.code
  );

  if missing is not null then
    raise exception 'permissions missing for 0029: %', missing;
  end if;

  -- Every one of the five tables must have RLS both enabled and forced. Forced
  -- is the half people forget, and without it the table owner reads
  -- everything.
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public'
    and c.relname in (
      'laundry_settings', 'laundry_providers', 'laundry_item_profiles',
      'laundry_orders', 'laundry_order_lines'
    )
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  -- `anon` must hold nothing on any of them. A laundry order names a property
  -- and a required-by; an unauthenticated read of it is an occupancy calendar.
  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and table_name in (
      'laundry_settings', 'laundry_providers', 'laundry_item_profiles',
      'laundry_orders', 'laundry_order_lines'
    );

  if missing is not null then
    raise exception 'anon still holds privileges on: %', missing;
  end if;

  -- The generated column. If `final_quantity` were ever converted to an
  -- ordinary column, a writer could store a final that is not its two parts
  -- and the whole three-column argument in the header would be decoration.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'laundry_order_lines'
      and column_name = 'final_quantity'
      and is_generated = 'ALWAYS'
  ) then
    raise exception
      'laundry_order_lines.final_quantity is not a generated column — calculated, adjustment and final could disagree';
  end if;

  -- The idempotency anchor. Losing it turns a re-run job into a second van.
  if not exists (
    select 1 from pg_constraint where conname = 'laundry_orders_requirement_key'
  ) then
    raise exception
      'laundry_orders_requirement_key missing — the same wash could be ordered twice';
  end if;

  -- Exactly one organization-wide settings row is possible. A plain unique
  -- constraint would not give this, because NULLs are distinct.
  if not exists (
    select 1 from pg_class where relname = 'laundry_settings_organization_default_key'
  ) then
    raise exception
      'laundry_settings_organization_default_key missing — an organization could hold two conflicting defaults';
  end if;

  -- No column anywhere in this module may name a guest, a price or a payment.
  -- The privacy guarantee in the header is that there is nothing to leak, and
  -- this is what keeps that true through the next migration that adds "just
  -- one useful column".
  select string_agg(table_name || '.' || column_name, ', ') into missing
  from information_schema.columns
  where table_schema = 'public'
    and table_name in (
      'laundry_settings', 'laundry_providers', 'laundry_item_profiles',
      'laundry_orders', 'laundry_order_lines'
    )
    and (
      column_name like '%guest%'
      or column_name like '%price%' and table_name <> 'laundry_providers'
      or column_name like '%payment%'
      or column_name like '%agent%'
      or column_name like '%amount%'
    );

  if missing is not null then
    raise exception
      'a laundry table carries guest or commercial columns, which the order message must never be able to render: %',
      missing;
  end if;

  -- And the two triggers that hold the consolidation invariant.
  select count(*) into n
  from pg_trigger
  where tgname in ('laundry_order_lines_agree', 'laundry_order_lines_frozen')
    and not tgisinternal;

  if n <> 2 then
    raise exception
      'expected both laundry_order_lines triggers, found %', n;
  end if;
end $$;
