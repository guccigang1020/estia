-- ============================================================================
-- 0032_store.sql — ESTIA · what else a guest can buy, and what it costs them
--
-- What this closes
--   0012 declared nine grants — `product.view`, `product.manage`,
--   `product.price_manage`, `order.view`, `order.manage`, `order.fulfil`,
--   `order.discount_manage`, `order.refund`, `provider.manage` — and there was
--   nothing behind any of them. No table, no domain, no screen. This is the
--   thing they were declared for, so it is an ADD onto that vocabulary rather
--   than a parallel `store.*` one, and there is deliberately no `store.*`
--   grant anywhere in this file.
--
-- ══ THE ONE RULE THIS SCHEMA IS BUILT AROUND ════════════════════════════════
--
--   CHANGING A PRODUCT'S PRICE MUST NEVER CHANGE AN EXISTING ORDER.
--
--   שולחן שוק is ₪1,500 today. A guest buys it. Tomorrow the owner raises it
--   to ₪1,800. That order is still ₪1,500, forever, and the next guest sees
--   ₪1,800. This is not a rendering convention that a screen remembers to
--   honour — it is the shape of `store_order_lines`, which carries
--   `unit_price_agorot` NOT NULL and has no path back to `store_items.price`
--   at read time. There is no view, no join and no generated column in this
--   file that reads a catalogue price to produce an order figure.
--
--   `store_order_lines.line_total_agorot` is GENERATED ALWAYS from the four
--   snapshot columns beside it, so no writer — not the application, not a
--   migration, not a person with psql — can store a line total that is not its
--   own parts. And `tg_store_order_totals` recomputes the ORDER's subtotal and
--   total from its lines on every line write, so an order total is the sum of
--   its lines by construction and is never re-derived from a rate.
--
--   `src/lib/store/snapshot.test.ts` is the loudest test in the module and
--   asserts exactly this against a price that moves underneath a placed order.
--
-- ══ WHAT IS SNAPSHOTTED, AND WHY EACH ONE ═══════════════════════════════════
--
--   A price is the obvious one. The others are the ones that cost money six
--   weeks later, and every one of them is a column on the line:
--
--     `item_name_snapshot`            — an archived product still has to read
--                                        back as what it was called when sold
--     `pricing_model_snapshot`        — "per guest" becoming "fixed" must not
--                                        retroactively re-price a stay
--     `fulfilment_recipe_snapshot`    — the tasks promised are the tasks owed
--     `lead_time_hours_snapshot`      — what the guest was told
--     `cancellation_policy_snapshot`  — §11: a cancelled booking is judged
--                                        order by order against the policy
--                                        each order was SOLD under, never
--                                        against today's
--
--   `store_order_line_options` does the same for the chosen variant: the
--   option's name, the value's label and its price delta are all copied, so
--   deleting an option group does not orphan an order into unreadability.
--
-- ══ THREE MODES, AND `off` IS THE DEFAULT ═══════════════════════════════════
--
--   `store_settings.mode` defaults to `off`, and `off` means the store does
--   not appear at all and bookings carry on exactly as they did before this
--   migration existed. Nothing in this file is referenced by any table in
--   0009, and no column was added to `bookings`.
--
--   `simple` is a catalogue and orders somebody handles by hand, with NO
--   payment provider anywhere. `commerce` adds live payment. `advanced` adds
--   stock, suppliers, operational recipes and margin — which is why
--   `store_items.cost_agorot` and `supplier_reference` are nullable and why
--   `tg_store_items_mode_vocabulary` refuses to let a business on `simple`
--   store them at all. A business that never asked for supplier vocabulary
--   must not be able to acquire it by accident; the refusal is in the database
--   so that a screen forgetting to hide a field cannot create the row.
--
-- ══ LIVE PAYMENT IS NEVER REQUIRED ══════════════════════════════════════════
--
--   `store_payment_mode` has seven members and `pay_now` is one of them, not
--   the default. The default is `with_booking`: the purchase joins the
--   booking's remaining balance, which is how an Israeli guesthouse actually
--   handles pool heating added by telephone.
--
--   `store_settings_no_live_payment_in_simple` is a check constraint, not a
--   guideline: an organization on `simple` cannot store `pay_now` as its
--   default mode or enable it in `payment_modes_enabled`. The one thing a
--   villa owner most fears about a "shop" is that it will demand a payment
--   provider, and the schema is where that fear is answered.
--
--   `store_order_payments` records money that moved OUTSIDE the product — a
--   bank transfer, Bit, PayBox, cash, a cheque, an external terminal — and is
--   the null implementation of the payment port in
--   `src/lib/store/payment.ts`. A second worker is building the live
--   collection policy in 0031; nothing here references it, and nothing here
--   needs to.
--
-- ══ A PROVIDER NEVER LEARNS WHO THE GUEST IS ════════════════════════════════
--
--   `store_provider_requests` has no `guest_id`, no guest name, no telephone,
--   no price, no payment column and no agent — the same argument 0029 makes
--   about laundry orders, for the same reason: the rendered request is an
--   artefact that leaves the organization addressed to a company with no
--   contractual relationship to the guest.
--
--   It carries the property, the date, the time, the service and operational
--   notes. `src/lib/store/provider-request.test.ts` asserts field by field
--   that a booking carrying all five forbidden facts renders a request
--   containing none of them. A column here would make that assertion a matter
--   of the renderer remembering rather than of there being nothing to render.
--
--   The join a manager legitimately needs — which order caused this request —
--   is `store_provider_requests.order_id`, which is INTERNAL and is not a
--   field the renderer is given.
--
-- ══ BOOKING-AWARE ELIGIBILITY IS CONFIGURATION, NOT CODE ════════════════════
--
--   A product is not merely listed; the system decides whether it can be
--   offered on THIS booking. Late checkout only where no conflicting booking
--   arrives and the cleaning schedule allows; pool heating only where the
--   property has the capability and the lead time is met; an extra mattress
--   only where capacity allows.
--
--   Every input to that decision is a column or a rule row, never a constant:
--   `lead_time_hours`, `capacity_per_day`, `max_per_booking`,
--   `requires_capability`, `min_guests`/`max_guests`,
--   `store_item_property_overrides` and `store_availability_rules`. The
--   evaluator is `src/lib/store/eligibility.ts` and it reads only from these.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, property_in_scope), 0009 (bookings,
--   guests), 0010 (payment_method), 0012 (the nine commerce grants), 0014
--   (the rule that a function in `public` is an API surface until its grants
--   say otherwise).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The vocabularies
-- ============================================================================
-- Every one of these is transcribed from `src/lib/contracts/states.ts`, in the
-- same order, and the order is load-bearing: an enum's ordinal is what
-- `order by status` sorts on, and a screen that lists an order's life out of
-- sequence is a screen nobody trusts.

-- STORE_MODES, in order.
do $$ begin
  create type public.store_mode as enum (
    'off',
    'simple',
    'commerce',
    'advanced'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_mode is
  'Transcribed from STORE_MODES in src/lib/contracts/states.ts, in the same order. `off` is the default and a first-class answer: the store does not appear and bookings carry on exactly as before. A business on `simple` must never meet supplier or margin vocabulary — see tg_store_items_mode_vocabulary.';

-- STORE_ITEM_TYPES, in order.
do $$ begin
  create type public.store_item_type as enum (
    'physical',
    'service',
    'experience',
    'property_addon',
    'package',
    'custom'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_item_type is
  'Transcribed from STORE_ITEM_TYPES. The type decides what the product can be connected to: a property_addon is checked against the calendar and the cleaning schedule, a service has a provider and a lead time, a physical item may draw on stock.';

-- STORE_PRICING_MODELS, in order.
do $$ begin
  create type public.store_pricing_model as enum (
    'fixed',
    'per_guest',
    'per_child',
    'per_night',
    'per_hour',
    'per_unit',
    'starting_from',
    'quote'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_pricing_model is
  'Transcribed from STORE_PRICING_MODELS. `quote` is a first-class answer and not a missing price: a caterer for thirty people is quoted, and a product that pretends to a fixed figure it cannot honour is worse than one that says בקש הצעה.';

-- STORE_ITEM_STATUSES, in order.
do $$ begin
  create type public.store_item_status as enum (
    'draft',
    'active',
    'paused',
    'archived'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_item_status is
  'Transcribed from STORE_ITEM_STATUSES. `archived` and never deleted: an archived product still has to be readable from the orders that bought it, at the price they paid.';

-- STORE_ORDER_STATUSES, in order.
do $$ begin
  create type public.store_order_status as enum (
    'draft',
    'pending',
    'awaiting_approval',
    'awaiting_payment',
    'confirmed',
    'in_preparation',
    'ready',
    'fulfilled',
    'completed',
    'cancelled',
    'refunded'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_order_status is
  'Transcribed from STORE_ORDER_STATUSES. Deliberately longer than most businesses will use: a bottle of wine goes pending to confirmed to completed while a DJ goes through approval, a provider request and a fulfilment window. TERMINAL_STORE_ORDER_STATUSES and COMMITTED_STORE_ORDER_STATUSES in the same contracts file name the two subsets the rules turn on.';

-- STORE_PAYMENT_STATUSES, in order.
do $$ begin
  create type public.store_payment_status as enum (
    'unpaid',
    'pending_verification',
    'partially_paid',
    'paid',
    'refunded'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_payment_status is
  'Transcribed from STORE_PAYMENT_STATUSES. Separate from the order''s own status for the reason the booking already separates the two: an order can be `confirmed` and `unpaid` when the business has chosen to add it to the booking balance, and coupling them would make that ordinary arrangement inexpressible.';

-- STORE_PAYMENT_MODES, in order.
do $$ begin
  create type public.store_payment_mode as enum (
    'with_booking',
    'pay_now',
    'manual',
    'on_arrival',
    'pay_later',
    'approval_first',
    'custom'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_payment_mode is
  'Transcribed from STORE_PAYMENT_MODES. `with_booking` is first and is the default: the purchase joins the booking''s remaining balance. `pay_now` is one option among seven and is never required — store_settings_no_live_payment_in_simple enforces that an organization on `simple` cannot reach it at all.';

-- STORE_FULFILMENT_KINDS, in order.
do $$ begin
  create type public.store_fulfilment_kind as enum (
    'none',
    'staff_task',
    'external_provider',
    'inventory',
    'custom'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_fulfilment_kind is
  'Transcribed from STORE_FULFILMENT_KINDS. What happens operationally when an item is bought. `inventory` names the stock module without depending on it: no column in this file references an inventory table, because that module is being written in parallel and a schema dependency across two unfinished modules is how both become unlandable.';

-- STORE_VISIBILITY_RULES, in order.
do $$ begin
  create type public.store_visibility_rule as enum (
    'always',
    'after_confirmation',
    'after_payment',
    'days_before_arrival',
    'during_stay'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_visibility_rule is
  'Transcribed from STORE_VISIBILITY_RULES. When an item becomes visible to a guest inside their booking.';

-- Not in the frozen contracts, because it is not a lifecycle the product talks
-- about across modules — it is local to this schema and to the two screens
-- that read it. Kept as an enum rather than as text so a typo is a failed
-- insert rather than a rule that silently never matches.
do $$ begin
  create type public.store_availability_rule_kind as enum (
    'weekday',
    'date_range',
    'blackout',
    'season'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.store_provider_request_status as enum (
    'draft',
    'sent',
    'confirmed',
    'unconfirmed',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_provider_request_status is
  'The life of one request to an outside provider. `unconfirmed` is not `draft` and not `cancelled`: it means the request went out and nobody has answered, which is the state store.provider_unconfirmed is raised from — before somebody discovers on the day that no DJ is coming.';

do $$ begin
  create type public.store_discount_kind as enum ('percent', 'amount');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.store_order_source as enum (
    -- The guest, in their own portal, on a telephone. The reason this module
    -- exists.
    'guest_portal',
    -- "The guest rang up and asked for pool heating." A first-class path, not
    -- an afterthought — see §7 of the brief and store_orders_source_actor.
    'staff',
    'automation'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.store_amendment_status as enum (
    'proposed',
    'awaiting_consent',
    'applied',
    'rejected',
    'withdrawn'
  );
exception when duplicate_object then null;
end $$;

comment on type public.store_amendment_status is
  'An amendment to a committed order is an explicit act with its own row, never a silent edit. `awaiting_consent` exists because a change that costs the guest more requires their agreement before it is applied — store_order_amendments_consent_required makes that unfakeable.';


-- ============================================================================
-- 2 · store_settings — how much of a shop this business is running
-- ============================================================================
-- One row per organization, and optionally one per property: a management
-- company may sell experiences at the Galilee house and nothing at the Carmel
-- one. `property_id is null` is the organization default and
-- `store_settings_one_per_scope_idx` makes it exactly one.

create table if not exists public.store_settings (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  -- NULL means "the organization default". A row with a property narrows it.
  property_id               uuid references public.properties (id) on delete cascade,

  mode                      public.store_mode not null default 'off',

  -- The organization's default. A product may override it; nothing may make
  -- live payment compulsory.
  default_payment_mode      public.store_payment_mode not null default 'with_booking',

  -- Which modes a guest may actually be offered at checkout. Empty means "the
  -- default only", which is the honest reading of a business that has thought
  -- about it once.
  payment_modes_enabled     public.store_payment_mode[] not null default '{}',

  -- Does a new order wait for a person before it is confirmed? Per-product
  -- `requires_approval` overrides this in either direction.
  approval_required_default boolean not null default true,

  -- Is the guest-facing store switched on at all? Distinct from `mode`: a
  -- business may run a catalogue for its own staff to sell from and never
  -- expose it to guests.
  guest_store_enabled       boolean not null default true,

  -- Shown at the top of the guest store. Hebrew, and the owner's own words.
  guest_store_heading       text,
  guest_store_intro         text,

  currency                  text not null default 'ILS',
  order_reference_prefix    text not null default 'S',

  -- How long a guest's cart survives before it is treated as abandoned.
  cart_ttl_hours            integer not null default 72,

  metadata                  jsonb not null default '{}'::jsonb,

  created_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id) on delete set null,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  version                   integer not null default 1,

  constraint store_settings_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint store_settings_prefix_present
    check (length(btrim(order_reference_prefix)) between 1 and 8),
  constraint store_settings_cart_ttl_positive check (cart_ttl_hours > 0),

  -- LIVE PAYMENT IS NEVER REQUIRED, AND ON `simple` IT IS NOT EVEN REACHABLE.
  --
  -- This is the constraint the whole payment section of the brief reduces to.
  -- A villa owner who turns the store on to sell a שולחן שוק must not be able
  -- to arrive at a screen asking for a payment provider, and the way to
  -- guarantee that is not a screen hiding a field — it is a row that cannot
  -- exist. `commerce` and `advanced` are the modes that bought live payment.
  constraint store_settings_no_live_payment_in_simple check (
    mode in ('commerce', 'advanced')
    or (default_payment_mode <> 'pay_now'
        and not ('pay_now' = any (payment_modes_enabled)))
  ),

  constraint store_settings_version_positive check (version >= 1)
);

comment on table public.store_settings is
  'How much of a shop this business is running, per organization and optionally per property. `off` is the default. store_settings_no_live_payment_in_simple is the schema''s promise that a business on `simple` can never be asked for a payment provider.';

comment on column public.store_settings.payment_modes_enabled is
  'Which modes a guest may be offered at checkout. Empty means the default only. `pay_now` cannot appear here while mode is `simple`.';

create unique index if not exists store_settings_one_per_scope_idx
  on public.store_settings (organization_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid));

drop trigger if exists store_settings_touch on public.store_settings;
create trigger store_settings_touch
  before update on public.store_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · store_categories — how the owner groups what they sell
-- ============================================================================
-- A section on the guest store, and a filter on the owner's list. Nothing is
-- hard-coded: §10 forbids rendering a section the owner has not created, and
-- an empty category is not rendered at all.

create table if not exists public.store_categories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  name             text not null,
  slug             text not null,
  description      text,
  -- A short emoji or icon key. Decoration, and nullable, because a category
  -- without one is a category and not a broken row.
  icon             text,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  deleted_at       timestamptz,
  version          integer not null default 1,

  constraint store_categories_name_present check (length(btrim(name)) > 0),
  constraint store_categories_slug_format check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  constraint store_categories_organization_slug_key unique (organization_id, slug),
  -- What store_items hangs its tenant proof on: a category from another
  -- organization cannot be referenced, because the foreign key carries the
  -- organization with it.
  constraint store_categories_id_organization_key unique (id, organization_id),
  constraint store_categories_version_positive check (version >= 1)
);

comment on table public.store_categories is
  'How the owner groups what they sell. A section on the guest store and a filter on the owner list. Never rendered when empty — §10 forbids an empty store section.';

create index if not exists store_categories_organization_idx
  on public.store_categories (organization_id, sort_order)
  where deleted_at is null;

drop trigger if exists store_categories_touch on public.store_categories;
create trigger store_categories_touch
  before update on public.store_categories
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · store_providers — the outside companies
-- ============================================================================
-- Declared before `store_items` because an item names one. Thin on commerce
-- for the same reason 0029's provider table is: what is owed to a supplier is
-- an expense in 0016's territory, and a second accounts-payable model here
-- would be a second set of numbers for the same debt.

create table if not exists public.store_providers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,

  name                text not null,
  contact_name        text,
  phone               text,
  email               text,

  -- Free text keys the owner chose — 'dj', 'catering', 'spa'. Not an enum,
  -- because the catalogue is configuration and the next business sells
  -- something nobody here thought of.
  service_types       text[] not null default '{}',

  -- How the request reaches them. Same members as 0029's channel list, spelled
  -- here as text rather than reusing `laundry_channel`: borrowing another
  -- module's enum couples two release trains for no gain.
  default_channel     text not null default 'whatsapp',

  lead_time_hours     integer not null default 24,
  notes               text,
  is_active           boolean not null default true,

  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  deleted_at          timestamptz,
  version             integer not null default 1,

  constraint store_providers_name_present check (length(btrim(name)) > 0),
  constraint store_providers_lead_time_nonnegative check (lead_time_hours >= 0),
  constraint store_providers_channel_known
    check (default_channel in ('whatsapp', 'sms', 'email', 'phone', 'print', 'copy')),
  -- A provider must be reachable by the channel it is set to. `print` and
  -- `copy` produce something a person carries, so they need neither.
  constraint store_providers_reachable check (
    default_channel not in ('whatsapp', 'sms', 'email', 'phone')
    or (default_channel in ('whatsapp', 'sms', 'phone')
        and phone is not null and length(btrim(phone)) > 0)
    or (default_channel = 'email'
        and email is not null and length(btrim(email)) > 0)
  ),
  constraint store_providers_id_organization_key unique (id, organization_id),
  constraint store_providers_version_positive check (version >= 1)
);

comment on table public.store_providers is
  'An outside company that performs a bought service — a DJ, a caterer, a masseuse. No money column: what is owed to a supplier is an expense in 0016''s territory.';

create index if not exists store_providers_organization_idx
  on public.store_providers (organization_id)
  where deleted_at is null;

drop trigger if exists store_providers_touch on public.store_providers;
create trigger store_providers_touch
  before update on public.store_providers
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · store_items — the catalogue
-- ============================================================================
-- THE TABLE THIS MODULE EXISTS AROUND, and the one whose columns are all
-- configuration. Nothing about "late checkout" or "pool heating" is written
-- into the product: they are rows here whose `lead_time_hours`,
-- `requires_capability` and `capacity_per_day` make them behave that way.

create table if not exists public.store_items (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,

  category_id              uuid,

  name                     text not null,
  slug                     text not null,
  short_description        text,
  description              text,

  item_type                public.store_item_type not null default 'service',
  status                   public.store_item_status not null default 'draft',

  -- ── Price ────────────────────────────────────────────────────────────────
  -- Integer agorot, always. `base_price_agorot` is NULL only for `quote`,
  -- which is the one pricing model that has no number to state.
  pricing_model            public.store_pricing_model not null default 'fixed',
  base_price_agorot        integer,
  -- `advanced` only. What it costs the business, so a margin can be shown.
  -- tg_store_items_mode_vocabulary refuses these on `simple` and `commerce`.
  cost_agorot              integer,
  supplier_reference       text,
  tax_rate_bps             integer,

  -- ── How it is sold ───────────────────────────────────────────────────────
  min_quantity             integer not null default 1,
  max_quantity             integer,
  max_per_booking          integer,
  unit_label               text,

  -- ── Eligibility, all of it configuration ────────────────────────────────
  -- How long before the service the guest must ask. Late checkout wants two
  -- hours; a DJ wants seventy-two.
  lead_time_hours          integer not null default 0,
  -- How many of this the business can perform in one day across the whole
  -- organization. NULL is "no ceiling", which is the honest answer for a
  -- bottle of wine.
  capacity_per_day         integer,
  -- A key on the property's own capability set — 'heated_pool', 'sound_system'.
  -- Free text for the same reason `service_types` is: the catalogue is
  -- configuration.
  requires_capability      text,
  -- Party-size bands. A romantic dinner for two is not offered to a party of
  -- twenty-five, and §10 says so.
  min_guests               integer,
  max_guests               integer,

  -- ── Where and when it is visible ────────────────────────────────────────
  visibility_rule          public.store_visibility_rule not null default 'always',
  visibility_days_before   integer,

  -- ── What happens when it is bought ──────────────────────────────────────
  requires_approval        boolean,
  payment_mode             public.store_payment_mode,
  fulfilment_kind          public.store_fulfilment_kind not null default 'none',
  -- `{ "taskType": "guest_request", "title": "...", "dueOffsetHours": -2,
  --    "checklist": ["..."], "teamId": null }`. The operational recipe, copied
  --  onto the order line at purchase so a later edit does not change what was
  --  promised.
  fulfilment_recipe        jsonb not null default '{}'::jsonb,
  provider_id              uuid,

  -- `[{ "key": "...", "label": "...", "kind": "text|choice|number",
  --     "required": bool, "choices": [...] }]`. Customization questions whose
  -- answers are stored on the order line.
  customization_questions  jsonb not null default '[]'::jsonb,

  -- `{ "kind": "free_until_hours|non_refundable|percentage",
  --    "hoursBefore": 48, "refundPercent": 100 }`. Copied onto the line, and
  -- §11 judges a cancelled booking against the copy rather than against this.
  cancellation_policy      jsonb not null default '{}'::jsonb,

  -- ── Presentation and ranking ────────────────────────────────────────────
  media                    jsonb not null default '[]'::jsonb,
  tags                     text[] not null default '{}',
  -- `{ "occasions": ["birthday"], "suitsCouple": true, "suitsFamily": false }`.
  -- What §10 ranks against the booking's own facts. It never invents: an item
  -- with an empty audience is ranked neutrally, not hidden and not promoted.
  audience                 jsonb not null default '{}'::jsonb,
  is_featured              boolean not null default false,
  sort_order               integer not null default 0,

  metadata                 jsonb not null default '{}'::jsonb,

  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users (id) on delete set null,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users (id) on delete set null,
  deleted_at               timestamptz,
  version                  integer not null default 1,

  -- One foreign key, two facts: the category exists and it is in this
  -- organization. Nothing downstream has to re-check the tenant.
  constraint store_items_category_fkey
    foreign key (category_id, organization_id)
    references public.store_categories (id, organization_id) on delete set null,
  constraint store_items_provider_fkey
    foreign key (provider_id, organization_id)
    references public.store_providers (id, organization_id) on delete set null,

  constraint store_items_name_present check (length(btrim(name)) > 0),
  constraint store_items_slug_format check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  constraint store_items_organization_slug_key unique (organization_id, slug),
  constraint store_items_id_organization_key unique (id, organization_id),

  -- A price is required unless the model is `quote`, and is never negative.
  -- A product with no price and no honest way to say so is the thing that
  -- makes a guest ring up angry.
  constraint store_items_price_present check (
    (pricing_model = 'quote' and base_price_agorot is null)
    or (pricing_model <> 'quote' and base_price_agorot is not null
        and base_price_agorot >= 0)
  ),
  constraint store_items_cost_nonnegative
    check (cost_agorot is null or cost_agorot >= 0),
  constraint store_items_tax_range
    check (tax_rate_bps is null or tax_rate_bps between 0 and 10000),
  constraint store_items_min_quantity_positive check (min_quantity >= 1),
  constraint store_items_max_quantity_sane
    check (max_quantity is null or max_quantity >= min_quantity),
  constraint store_items_max_per_booking_positive
    check (max_per_booking is null or max_per_booking >= 1),
  constraint store_items_lead_time_nonnegative check (lead_time_hours >= 0),
  constraint store_items_capacity_positive
    check (capacity_per_day is null or capacity_per_day >= 0),
  constraint store_items_guest_band_ordered check (
    min_guests is null or max_guests is null or max_guests >= min_guests
  ),
  constraint store_items_guest_band_positive check (
    (min_guests is null or min_guests >= 0)
    and (max_guests is null or max_guests >= 0)
  ),
  -- `days_before_arrival` is the one visibility rule that needs a number, and
  -- a rule that needs one and has none is a product nobody ever sees.
  constraint store_items_visibility_days check (
    (visibility_rule = 'days_before_arrival'
     and visibility_days_before is not null and visibility_days_before >= 0)
    or (visibility_rule <> 'days_before_arrival')
  ),
  -- An external-provider fulfilment has to name the provider it is external
  -- to. Discovering on the morning that the recipe pointed at nobody is the
  -- failure this prevents.
  constraint store_items_provider_when_external check (
    fulfilment_kind <> 'external_provider' or provider_id is not null
  ),
  constraint store_items_recipe_is_object
    check (jsonb_typeof(fulfilment_recipe) = 'object'),
  constraint store_items_questions_is_array
    check (jsonb_typeof(customization_questions) = 'array'),
  constraint store_items_cancellation_is_object
    check (jsonb_typeof(cancellation_policy) = 'object'),
  constraint store_items_audience_is_object
    check (jsonb_typeof(audience) = 'object'),
  constraint store_items_media_is_array
    check (jsonb_typeof(media) = 'array'),
  constraint store_items_version_positive check (version >= 1)
);

comment on table public.store_items is
  'The catalogue. Every behaviour is configuration: lead_time_hours, capacity_per_day, requires_capability and the guest band are what make one row behave like late checkout and another like a bottle of wine. Nothing about a particular product is written into the application.';

comment on column public.store_items.base_price_agorot is
  'Integer agorot. THIS COLUMN IS NEVER READ TO PRICE AN EXISTING ORDER. An order line carries its own unit_price_agorot, snapshotted at purchase, and there is no view or join in this schema that reaches from a line back to here.';

comment on column public.store_items.cost_agorot is
  '`advanced` mode only. What it costs the business, so a margin can be shown. tg_store_items_mode_vocabulary refuses a non-null value while the organization is on `simple` or `commerce`, because a business that never asked for margin vocabulary must not acquire it by a screen forgetting to hide a field.';

comment on column public.store_items.audience is
  'What §10 ranks against the booking''s own facts — a couple, a family, a 25-person birthday. An empty object is ranked neutrally. Personalization never invents: nothing here can surface a product the owner has not created.';

create index if not exists store_items_organization_status_idx
  on public.store_items (organization_id, status, sort_order)
  where deleted_at is null;

create index if not exists store_items_category_idx
  on public.store_items (organization_id, category_id)
  where deleted_at is null;

drop trigger if exists store_items_touch on public.store_items;
create trigger store_items_touch
  before update on public.store_items
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · Options, variants and add-ons
-- ============================================================================
-- A size, a guest band, a style — a choice that changes the price. Two tables
-- rather than one jsonb column, because an order line has to snapshot the
-- chosen value and a jsonb blob gives it nothing stable to point at.

create table if not exists public.store_item_options (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  item_id          uuid not null,

  name             text not null,
  -- 'single' — pick one. 'multi' — pick any number.
  selection        text not null default 'single',
  is_required      boolean not null default false,
  sort_order       integer not null default 0,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint store_item_options_item_fkey
    foreign key (item_id, organization_id)
    references public.store_items (id, organization_id) on delete cascade,
  constraint store_item_options_name_present check (length(btrim(name)) > 0),
  constraint store_item_options_selection_known
    check (selection in ('single', 'multi')),
  constraint store_item_options_id_organization_key unique (id, organization_id),
  constraint store_item_options_version_positive check (version >= 1)
);

comment on table public.store_item_options is
  'A group of choices on a product — size, guest band, style. The values live in store_item_option_values and each carries its own price delta.';

create index if not exists store_item_options_item_idx
  on public.store_item_options (organization_id, item_id, sort_order);

drop trigger if exists store_item_options_touch on public.store_item_options;
create trigger store_item_options_touch
  before update on public.store_item_options
  for each row execute function public.tg_touch_row();


create table if not exists public.store_item_option_values (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  option_id          uuid not null,

  label              text not null,
  -- Signed. A smaller size is a negative delta, and pretending otherwise would
  -- force the owner to state two prices for one product.
  price_delta_agorot integer not null default 0,
  is_default         boolean not null default false,
  is_available       boolean not null default true,
  sort_order         integer not null default 0,

  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id) on delete set null,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  version            integer not null default 1,

  constraint store_item_option_values_option_fkey
    foreign key (option_id, organization_id)
    references public.store_item_options (id, organization_id) on delete cascade,
  constraint store_item_option_values_label_present
    check (length(btrim(label)) > 0),
  constraint store_item_option_values_id_organization_key
    unique (id, organization_id),
  constraint store_item_option_values_version_positive check (version >= 1)
);

comment on column public.store_item_option_values.price_delta_agorot is
  'Signed integer agorot. Snapshotted onto store_order_line_options at purchase; changing it here never changes a placed order.';

create index if not exists store_item_option_values_option_idx
  on public.store_item_option_values (organization_id, option_id, sort_order);

drop trigger if exists store_item_option_values_touch on public.store_item_option_values;
create trigger store_item_option_values_touch
  before update on public.store_item_option_values
  for each row execute function public.tg_touch_row();


-- An extra DJ hour, lighting, a second masseuse. Bought *inside* a product
-- rather than beside it, which is why it is not simply another `store_items`
-- row: it has no independent existence and must never appear in the catalogue
-- on its own.
create table if not exists public.store_item_addons (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  item_id           uuid not null,

  name              text not null,
  description       text,
  price_agorot      integer not null default 0,
  pricing_model     public.store_pricing_model not null default 'fixed',
  max_quantity      integer,
  is_active         boolean not null default true,
  sort_order        integer not null default 0,

  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null,
  version           integer not null default 1,

  constraint store_item_addons_item_fkey
    foreign key (item_id, organization_id)
    references public.store_items (id, organization_id) on delete cascade,
  constraint store_item_addons_name_present check (length(btrim(name)) > 0),
  constraint store_item_addons_price_nonnegative check (price_agorot >= 0),
  constraint store_item_addons_max_quantity_positive
    check (max_quantity is null or max_quantity >= 1),
  constraint store_item_addons_id_organization_key unique (id, organization_id),
  constraint store_item_addons_version_positive check (version >= 1)
);

comment on table public.store_item_addons is
  'An extra bought inside a product — an additional DJ hour, lighting. Not a catalogue row of its own, because it has no independent existence and must never be listed alone.';

create index if not exists store_item_addons_item_idx
  on public.store_item_addons (organization_id, item_id, sort_order);

drop trigger if exists store_item_addons_touch on public.store_item_addons;
create trigger store_item_addons_touch
  before update on public.store_item_addons
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 7 · Packages — a combination priced as one
-- ============================================================================

create table if not exists public.store_packages (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  category_id       uuid,

  name              text not null,
  slug              text not null,
  description       text,
  short_description text,

  -- The package's own price, which is the point: it is NOT the sum of its
  -- members. A romantic evening priced at ₪690 where the parts add to ₪850 is
  -- the ordinary case, and computing the total from the members would erase
  -- the offer.
  price_agorot      integer not null,
  pricing_model     public.store_pricing_model not null default 'fixed',
  status            public.store_item_status not null default 'draft',

  media             jsonb not null default '[]'::jsonb,
  audience          jsonb not null default '{}'::jsonb,
  cancellation_policy jsonb not null default '{}'::jsonb,
  visibility_rule   public.store_visibility_rule not null default 'always',
  visibility_days_before integer,
  is_featured       boolean not null default false,
  sort_order        integer not null default 0,

  metadata          jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null,
  deleted_at        timestamptz,
  version           integer not null default 1,

  constraint store_packages_category_fkey
    foreign key (category_id, organization_id)
    references public.store_categories (id, organization_id) on delete set null,
  constraint store_packages_name_present check (length(btrim(name)) > 0),
  constraint store_packages_slug_format check (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  constraint store_packages_organization_slug_key unique (organization_id, slug),
  constraint store_packages_id_organization_key unique (id, organization_id),
  constraint store_packages_price_nonnegative check (price_agorot >= 0),
  constraint store_packages_visibility_days check (
    (visibility_rule = 'days_before_arrival'
     and visibility_days_before is not null and visibility_days_before >= 0)
    or (visibility_rule <> 'days_before_arrival')
  ),
  constraint store_packages_version_positive check (version >= 1)
);

comment on table public.store_packages is
  'A combination priced as one. price_agorot is the package''s own price and is deliberately NOT derived from its members: a package that added up to its parts would not be an offer.';

create index if not exists store_packages_organization_idx
  on public.store_packages (organization_id, status, sort_order)
  where deleted_at is null;

drop trigger if exists store_packages_touch on public.store_packages;
create trigger store_packages_touch
  before update on public.store_packages
  for each row execute function public.tg_touch_row();


create table if not exists public.store_package_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  package_id       uuid not null,
  item_id          uuid not null,

  quantity         integer not null default 1,
  sort_order       integer not null default 0,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint store_package_items_package_fkey
    foreign key (package_id, organization_id)
    references public.store_packages (id, organization_id) on delete cascade,
  constraint store_package_items_item_fkey
    foreign key (item_id, organization_id)
    references public.store_items (id, organization_id) on delete restrict,
  constraint store_package_items_quantity_positive check (quantity >= 1),
  constraint store_package_items_unique unique (package_id, item_id),
  constraint store_package_items_version_positive check (version >= 1)
);

create index if not exists store_package_items_package_idx
  on public.store_package_items (organization_id, package_id, sort_order);

drop trigger if exists store_package_items_touch on public.store_package_items;
create trigger store_package_items_touch
  before update on public.store_package_items
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 8 · store_item_property_overrides — the same product, this house
-- ============================================================================
-- Pool heating exists at the Galilee villa and not at the Carmel flat; late
-- checkout is ₪150 at one and ₪250 at the other. Without this the owner has to
-- keep two catalogues, which is how the two drift.

create table if not exists public.store_item_property_overrides (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations (id) on delete cascade,
  item_id                   uuid not null,
  property_id               uuid not null references public.properties (id) on delete cascade,

  -- FALSE is the strong statement: this product is not offered here at all.
  is_available              boolean not null default true,
  price_override_agorot     integer,
  lead_time_hours_override  integer,
  capacity_per_day_override integer,
  provider_override_id      uuid,
  notes                     text,

  created_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id) on delete set null,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  version                   integer not null default 1,

  constraint store_item_property_overrides_item_fkey
    foreign key (item_id, organization_id)
    references public.store_items (id, organization_id) on delete cascade,
  constraint store_item_property_overrides_provider_fkey
    foreign key (provider_override_id, organization_id)
    references public.store_providers (id, organization_id) on delete set null,
  constraint store_item_property_overrides_unique unique (item_id, property_id),
  constraint store_item_property_overrides_price_nonnegative
    check (price_override_agorot is null or price_override_agorot >= 0),
  constraint store_item_property_overrides_lead_nonnegative
    check (lead_time_hours_override is null or lead_time_hours_override >= 0),
  constraint store_item_property_overrides_capacity_nonnegative
    check (capacity_per_day_override is null or capacity_per_day_override >= 0),
  constraint store_item_property_overrides_version_positive check (version >= 1)
);

comment on table public.store_item_property_overrides is
  'The same product, this house. is_available = false is the strong statement: not offered here at all. A NULL override means "inherit", which is why every override column is nullable rather than defaulted.';

create index if not exists store_item_property_overrides_property_idx
  on public.store_item_property_overrides (organization_id, property_id);

drop trigger if exists store_item_property_overrides_touch
  on public.store_item_property_overrides;
create trigger store_item_property_overrides_touch
  before update on public.store_item_property_overrides
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 9 · store_availability_rules — when it can actually be had
-- ============================================================================
-- A DJ on Fridays only; no spa treatments during Pesach; the pool heated from
-- October to April. `item_id is null` means the rule applies to everything the
-- organization sells, which is how "we close for two weeks in August" is
-- expressed once rather than on every row.

create table if not exists public.store_availability_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  -- NULL means every item. See the header.
  item_id          uuid,
  -- NULL means every property.
  property_id      uuid references public.properties (id) on delete cascade,

  kind             public.store_availability_rule_kind not null,

  -- ISO weekday numbers, 1 = Monday through 7 = Sunday, matching 0029's
  -- pickup_days so the two modules cannot disagree about what "5" means.
  weekdays         smallint[] not null default '{}',
  from_date        date,
  to_date          date,
  from_time        time,
  to_time          time,

  -- A per-day ceiling that is narrower than the item's own. NULL inherits.
  max_per_day      integer,

  -- TRUE means the rule FORBIDS; FALSE means it PERMITS. A blackout is
  -- blocking; a season is permitting. Stated rather than inferred from `kind`
  -- because a business will eventually want a permitting weekday rule.
  is_blocking      boolean not null default false,
  note             text,
  is_active        boolean not null default true,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint store_availability_rules_item_fkey
    foreign key (item_id, organization_id)
    references public.store_items (id, organization_id) on delete cascade,
  constraint store_availability_rules_weekdays_valid
    check (weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  constraint store_availability_rules_dates_ordered
    check (from_date is null or to_date is null or to_date >= from_date),
  constraint store_availability_rules_max_per_day_nonnegative
    check (max_per_day is null or max_per_day >= 0),
  -- A rule of a kind that needs dates and has none matches every day, which is
  -- almost never what somebody meant by "blackout".
  constraint store_availability_rules_dated_kinds check (
    kind not in ('date_range', 'blackout', 'season')
    or (from_date is not null and to_date is not null)
  ),
  constraint store_availability_rules_weekday_kind check (
    kind <> 'weekday' or array_length(weekdays, 1) is not null
  ),
  constraint store_availability_rules_version_positive check (version >= 1)
);

comment on table public.store_availability_rules is
  'When a product can actually be had. item_id NULL means every item and property_id NULL means every property, so "we close for two weeks in August" is one row. is_blocking is stated rather than inferred from kind.';

create index if not exists store_availability_rules_item_idx
  on public.store_availability_rules (organization_id, item_id)
  where is_active;

drop trigger if exists store_availability_rules_touch on public.store_availability_rules;
create trigger store_availability_rules_touch
  before update on public.store_availability_rules
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 10 · store_promo_codes
-- ============================================================================

create table if not exists public.store_promo_codes (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,

  code              text not null,
  description       text,
  discount_kind     public.store_discount_kind not null,
  percent           integer,
  amount_agorot     integer,

  min_order_agorot  integer not null default 0,
  -- NULL is unlimited. A code with a limit and no counter is a code that gets
  -- used four hundred times.
  max_uses          integer,
  uses              integer not null default 0,
  max_uses_per_booking integer,

  valid_from        timestamptz,
  valid_until       timestamptz,
  -- Empty means every item.
  item_ids          uuid[] not null default '{}',
  is_active         boolean not null default true,

  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id) on delete set null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users (id) on delete set null,
  version           integer not null default 1,

  constraint store_promo_codes_organization_code_key unique (organization_id, code),
  constraint store_promo_codes_id_organization_key unique (id, organization_id),
  constraint store_promo_codes_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]*$'),
  -- Exactly one of the two figures, matching the kind. A percent code with an
  -- amount is two conflicting answers to one question.
  constraint store_promo_codes_figure_matches_kind check (
    (discount_kind = 'percent'
     and percent is not null and percent between 1 and 100
     and amount_agorot is null)
    or (discount_kind = 'amount'
        and amount_agorot is not null and amount_agorot > 0
        and percent is null)
  ),
  constraint store_promo_codes_min_order_nonnegative check (min_order_agorot >= 0),
  constraint store_promo_codes_uses_nonnegative check (uses >= 0),
  constraint store_promo_codes_max_uses_positive
    check (max_uses is null or max_uses >= 1),
  constraint store_promo_codes_window_ordered check (
    valid_from is null or valid_until is null or valid_until > valid_from
  ),
  constraint store_promo_codes_version_positive check (version >= 1)
);

create index if not exists store_promo_codes_organization_idx
  on public.store_promo_codes (organization_id)
  where is_active;

drop trigger if exists store_promo_codes_touch on public.store_promo_codes;
create trigger store_promo_codes_touch
  before update on public.store_promo_codes
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 11 · store_price_history — what the price used to be
-- ============================================================================
-- APPEND-ONLY. Written by tg_store_items_price_history on every price change,
-- so the record cannot depend on a screen remembering to write it.
--
-- This is NOT what protects an order — the order line's own snapshot does
-- that. This answers a different question: "we agreed ₪1,500 in March, why
-- does the catalogue say ₪1,800?" A business that cannot answer that from the
-- record argues from memory.

create table if not exists public.store_price_history (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  item_id               uuid not null,

  previous_price_agorot integer,
  new_price_agorot      integer,
  previous_pricing_model public.store_pricing_model,
  new_pricing_model     public.store_pricing_model,
  reason                text,

  changed_at            timestamptz not null default now(),
  changed_by            uuid references auth.users (id) on delete set null,

  constraint store_price_history_item_fkey
    foreign key (item_id, organization_id)
    references public.store_items (id, organization_id) on delete cascade,
  constraint store_price_history_something_changed check (
    previous_price_agorot is distinct from new_price_agorot
    or previous_pricing_model is distinct from new_pricing_model
  )
);

comment on table public.store_price_history is
  'Append-only. Written by a trigger rather than by the application, so the record of a price change cannot depend on a screen remembering. It is not what protects a placed order — store_order_lines.unit_price_agorot is — it is what answers "why does the catalogue say something different from what we agreed".';

create index if not exists store_price_history_item_idx
  on public.store_price_history (organization_id, item_id, changed_at desc);


-- ============================================================================
-- 12 · store_orders
-- ============================================================================

create table if not exists public.store_orders (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  property_id         uuid not null references public.properties (id) on delete restrict,

  -- Nullable, and deliberately: a walk-in sale at the desk has no booking, and
  -- forcing one would make the product refuse a real transaction. Almost every
  -- order has one, and the eligibility engine has nothing to say without it.
  booking_id          uuid,
  guest_id            uuid,

  reference           text not null,
  source              public.store_order_source not null default 'guest_portal',

  status              public.store_order_status not null default 'draft',
  payment_status      public.store_payment_status not null default 'unpaid',
  -- Snapshotted from the settings or the item at creation. Changing the
  -- organization default afterwards must not silently change how an existing
  -- order is expected to be paid.
  payment_mode        public.store_payment_mode not null default 'with_booking',

  currency            text not null default 'ILS',
  -- ALL FOUR ARE WRITTEN BY tg_store_order_totals FROM THE LINES.
  -- A value supplied by a caller is discarded. "Why is it ₪1,690?" has to have
  -- an answer, and the answer is the lines.
  subtotal_agorot     integer not null default 0,
  discount_agorot     integer not null default 0,
  tax_agorot          integer not null default 0,
  total_agorot        integer not null default 0,

  promo_code_id       uuid,
  -- The code as typed, snapshotted. A promo code renamed or deleted must not
  -- make an old order unreadable.
  promo_code_snapshot text,

  -- When the guest wants it. A date and an optional time, because "Friday" is
  -- a complete answer for a bottle of wine and is not one for a masseuse.
  requested_for_date  date,
  requested_for_time  time,

  guest_notes         text,
  internal_notes      text,

  approved_at         timestamptz,
  approved_by         uuid references auth.users (id) on delete set null,
  confirmed_at        timestamptz,
  fulfilled_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  refunded_at         timestamptz,

  -- How many amendments this order has survived. Read by the screens so a
  -- reader knows the figures in front of them are not the original ones.
  amendment_count     integer not null default 0,

  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  -- One foreign key, three facts: the booking exists, it is in this
  -- organization, and it is at this property. An order attached to a booking
  -- at a different house is a class of bug this makes unrepresentable.
  constraint store_orders_booking_fkey
    foreign key (booking_id, organization_id, property_id)
    references public.bookings (id, organization_id, property_id) on delete restrict,
  constraint store_orders_guest_fkey
    foreign key (guest_id, organization_id)
    references public.guests (id, organization_id) on delete restrict,
  constraint store_orders_promo_fkey
    foreign key (promo_code_id, organization_id)
    references public.store_promo_codes (id, organization_id) on delete set null,

  constraint store_orders_organization_reference_key unique (organization_id, reference),
  constraint store_orders_id_organization_key unique (id, organization_id),
  constraint store_orders_reference_present check (length(btrim(reference)) > 0),
  constraint store_orders_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint store_orders_money_nonnegative check (
    subtotal_agorot >= 0 and discount_agorot >= 0
    and tax_agorot >= 0 and total_agorot >= 0
  ),
  constraint store_orders_amendment_count_nonnegative check (amendment_count >= 0),
  -- An order created from the guest portal must belong to a booking: the
  -- portal has no other way to know who is asking. A staff order need not.
  constraint store_orders_portal_needs_booking check (
    source <> 'guest_portal' or booking_id is not null
  ),
  -- A cancelled order states why. "Cancelled by somebody, at some point, for
  -- no recorded reason" is the row a refund argument cannot be settled from.
  constraint store_orders_cancelled_pair check (
    (cancelled_at is null and cancellation_reason is null)
    or (cancelled_at is not null and cancellation_reason is not null
        and length(btrim(cancellation_reason)) > 0)
  ),
  constraint store_orders_approved_pair check (
    (approved_at is null and approved_by is null) or approved_at is not null
  ),
  constraint store_orders_version_positive check (version >= 1)
);

comment on table public.store_orders is
  'One purchase. subtotal/discount/tax/total are written by tg_store_order_totals from the lines and a caller-supplied value is discarded — a total is the sum of its lines and is never recomputed from a rate.';

comment on column public.store_orders.payment_mode is
  'Snapshotted at creation from the settings or the item. Changing the organization default afterwards must never change how an existing order is expected to be paid.';

comment on column public.store_orders.booking_id is
  'Nullable on purpose: a walk-in sale at the desk has no booking and the product must not refuse a real transaction. store_orders_portal_needs_booking requires one for a guest-portal order, which is the case where it cannot be absent.';

create index if not exists store_orders_organization_status_idx
  on public.store_orders (organization_id, status, created_at desc);

create index if not exists store_orders_booking_idx
  on public.store_orders (organization_id, booking_id)
  where booking_id is not null;

create index if not exists store_orders_property_requested_idx
  on public.store_orders (organization_id, property_id, requested_for_date);


-- ── The idempotency of a double-tapped submit ───────────────────────────────
-- The service pipeline's `idempotency_keys` table already refuses a replayed
-- operation, and this is the second net beneath it, for the case the pipeline
-- cannot see: two DIFFERENT requests that mean the same purchase, a moment
-- apart, because the guest tapped twice and the second tap generated its own
-- key on a page that had reloaded.
--
-- The key is written by the application and is documented in
-- `src/lib/store/idempotency.ts`. It is a column rather than only a table so
-- that the uniqueness is enforced where the row is, which is the only place a
-- race can actually be lost.
alter table public.store_orders
  add column if not exists submission_key text;

comment on column public.store_orders.submission_key is
  'A stable fingerprint of the purchase — organization, booking, the sorted item/quantity/option set and the requested date — from src/lib/store/idempotency.ts. Unique per organization, so a double-tapped submit cannot produce two orders even when the two requests carry different idempotency keys.';

create unique index if not exists store_orders_submission_key_idx
  on public.store_orders (organization_id, submission_key)
  where submission_key is not null;

drop trigger if exists store_orders_touch on public.store_orders;
create trigger store_orders_touch
  before update on public.store_orders
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 13 · store_order_lines — WHERE THE PRICE LIVES
-- ============================================================================
-- Read the header of this file before changing anything here.
--
-- Every `_snapshot` column is a copy taken at the moment of purchase, and
-- there is no foreign key in this table that is required to be resolvable for
-- the line to be readable: `item_id` is `on delete set null` precisely so that
-- an order survives its product being removed, with everything the order
-- needs still on the row.

create table if not exists public.store_order_lines (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references public.organizations (id) on delete cascade,
  order_id                    uuid not null,

  -- The catalogue row this came from, for reporting. NEVER read to price the
  -- line, and nullable so the line outlives the product.
  item_id                     uuid,
  package_id                  uuid,

  -- ── The snapshot ─────────────────────────────────────────────────────────
  item_name_snapshot          text not null,
  item_type_snapshot          public.store_item_type not null,
  pricing_model_snapshot      public.store_pricing_model not null,
  -- THE PRICE. Integer agorot, per unit, as it stood when the guest bought.
  unit_price_agorot           integer not null,
  -- What the chosen options added or removed, already summed. The individual
  -- deltas are in store_order_line_options; this is what the arithmetic uses.
  options_agorot              integer not null default 0,
  addons_agorot               integer not null default 0,
  line_discount_agorot        integer not null default 0,

  -- Integer, deliberately. Every pricing model produces a whole multiplier —
  -- guests, children, nights, hours, units — and a numeric quantity would make
  -- the generated total below a rounding decision rather than an arithmetic
  -- one. Where a business needs half an hour, the unit is half-hours.
  quantity                    integer not null default 1,

  -- THE INVARIANT, ENFORCED BY THE DATABASE.
  -- No writer can store a line total that is not its own parts.
  line_total_agorot           integer
    generated always as (
      (unit_price_agorot + options_agorot + addons_agorot) * quantity
      - line_discount_agorot
    ) stored,

  -- When the price was taken, and from where: `catalogue`, `override` (a
  -- property override was in force), `manual` (a person typed it) or `quote`
  -- (it was agreed off-system). A figure whose provenance is unknown is a
  -- figure nobody can defend.
  price_snapshot_at           timestamptz not null default now(),
  price_source                text not null default 'catalogue',

  -- The answers to the product's customization questions, stored with the
  -- order because that is where they are read from three weeks later.
  customization_answers       jsonb not null default '{}'::jsonb,

  -- What was promised operationally, frozen. Editing the recipe on the
  -- catalogue afterwards changes the next sale and not this one.
  fulfilment_kind_snapshot    public.store_fulfilment_kind not null default 'none',
  fulfilment_recipe_snapshot  jsonb not null default '{}'::jsonb,
  lead_time_hours_snapshot    integer not null default 0,
  -- §11 judges a cancelled booking against THIS, never against the catalogue's
  -- current policy.
  cancellation_policy_snapshot jsonb not null default '{}'::jsonb,

  provider_id                 uuid,
  line_status                 public.store_order_status not null default 'pending',
  notes                       text,
  sort_order                  integer not null default 0,

  created_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users (id) on delete set null,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users (id) on delete set null,
  version                     integer not null default 1,

  constraint store_order_lines_order_fkey
    foreign key (order_id, organization_id)
    references public.store_orders (id, organization_id) on delete cascade,
  constraint store_order_lines_item_fkey
    foreign key (item_id, organization_id)
    references public.store_items (id, organization_id) on delete set null,
  constraint store_order_lines_package_fkey
    foreign key (package_id, organization_id)
    references public.store_packages (id, organization_id) on delete set null,
  constraint store_order_lines_provider_fkey
    foreign key (provider_id, organization_id)
    references public.store_providers (id, organization_id) on delete set null,
  constraint store_order_lines_id_organization_key unique (id, organization_id),

  constraint store_order_lines_name_present
    check (length(btrim(item_name_snapshot)) > 0),
  constraint store_order_lines_unit_price_nonnegative check (unit_price_agorot >= 0),
  constraint store_order_lines_addons_nonnegative check (addons_agorot >= 0),
  constraint store_order_lines_discount_nonnegative check (line_discount_agorot >= 0),
  constraint store_order_lines_quantity_positive check (quantity >= 1),
  constraint store_order_lines_price_source_known
    check (price_source in ('catalogue', 'override', 'manual', 'quote')),
  constraint store_order_lines_answers_is_object
    check (jsonb_typeof(customization_answers) = 'object'),
  constraint store_order_lines_recipe_is_object
    check (jsonb_typeof(fulfilment_recipe_snapshot) = 'object'),
  constraint store_order_lines_cancellation_is_object
    check (jsonb_typeof(cancellation_policy_snapshot) = 'object'),
  constraint store_order_lines_lead_time_nonnegative
    check (lead_time_hours_snapshot >= 0),
  constraint store_order_lines_version_positive check (version >= 1)
);

comment on table public.store_order_lines is
  'THE PRICE SNAPSHOT. unit_price_agorot is what the guest agreed, and nothing in this schema reads store_items.base_price_agorot to produce it a second time. line_total_agorot is GENERATED ALWAYS from the columns beside it, so no writer can store a total that is not its own parts.';

comment on column public.store_order_lines.unit_price_agorot is
  'The price the guest agreed, per unit, in integer agorot. Raising the catalogue price tomorrow does not touch this row. src/lib/store/snapshot.test.ts is the assertion.';

comment on column public.store_order_lines.item_id is
  'Reporting only, and nullable on delete: the line must remain readable after its product is gone, which is why every fact the line needs is copied onto it rather than joined.';

create index if not exists store_order_lines_order_idx
  on public.store_order_lines (organization_id, order_id, sort_order);

create index if not exists store_order_lines_item_idx
  on public.store_order_lines (organization_id, item_id)
  where item_id is not null;

drop trigger if exists store_order_lines_touch on public.store_order_lines;
create trigger store_order_lines_touch
  before update on public.store_order_lines
  for each row execute function public.tg_touch_row();


create table if not exists public.store_order_line_options (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  order_line_id         uuid not null,

  -- Reporting only, and both nullable: an option group deleted from the
  -- catalogue must not make an order unreadable.
  option_id             uuid,
  option_value_id       uuid,

  option_name_snapshot  text not null,
  value_label_snapshot  text not null,
  price_delta_agorot    integer not null default 0,
  sort_order            integer not null default 0,

  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,

  constraint store_order_line_options_line_fkey
    foreign key (order_line_id, organization_id)
    references public.store_order_lines (id, organization_id) on delete cascade,
  constraint store_order_line_options_option_fkey
    foreign key (option_id, organization_id)
    references public.store_item_options (id, organization_id) on delete set null,
  constraint store_order_line_options_value_fkey
    foreign key (option_value_id, organization_id)
    references public.store_item_option_values (id, organization_id) on delete set null,
  constraint store_order_line_options_names_present check (
    length(btrim(option_name_snapshot)) > 0
    and length(btrim(value_label_snapshot)) > 0
  )
);

comment on table public.store_order_line_options is
  'The variant the guest chose, copied. The option''s name, the value''s label and its price delta are all snapshots, so deleting an option group never orphans an order into unreadability.';

create index if not exists store_order_line_options_line_idx
  on public.store_order_line_options (organization_id, order_line_id, sort_order);


-- ============================================================================
-- 14 · store_order_payments — money that moved
-- ============================================================================
-- The null implementation of the payment port. A bank transfer, Bit, PayBox,
-- cash, a cheque, an external terminal: money that moves OUTSIDE the product
-- and is recorded inside it, which is the majority of Israeli guesthouse
-- income and must not be second-class.
--
-- Nothing here talks to a provider, and nothing here is required for an order
-- to be confirmed. A second worker is building live collection in 0031; when
-- it lands, a live payment records a row here too and the two do not conflict,
-- because this table records the FACT of money rather than the mechanism.

create table if not exists public.store_order_payments (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  order_id            uuid not null,

  mode                public.store_payment_mode not null,
  method              public.payment_method not null default 'other',
  amount_agorot       integer not null,
  status              public.store_payment_status not null default 'paid',

  -- What a person can point at: a transfer reference, the last four digits, a
  -- cheque number. Never a card number, never a token.
  reference           text,
  notes               text,

  recorded_at         timestamptz not null default now(),
  recorded_by         uuid references auth.users (id) on delete set null,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint store_order_payments_order_fkey
    foreign key (order_id, organization_id)
    references public.store_orders (id, organization_id) on delete cascade,
  -- Signed: a refund is a negative row rather than a deletion, so the history
  -- of what moved survives.
  constraint store_order_payments_amount_nonzero check (amount_agorot <> 0),
  constraint store_order_payments_version_positive check (version >= 1)
);

comment on table public.store_order_payments is
  'Money that moved, recorded. The null implementation of the payment port in src/lib/store/payment.ts: a manual record of a bank transfer, Bit, PayBox, cash or a cheque. A refund is a negative row, never a deletion.';

create index if not exists store_order_payments_order_idx
  on public.store_order_payments (organization_id, order_id, recorded_at desc);

drop trigger if exists store_order_payments_touch on public.store_order_payments;
create trigger store_order_payments_touch
  before update on public.store_order_payments
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 15 · store_order_amendments — never a silent edit
-- ============================================================================
-- A committed order is not edited. It is amended, and the amendment is a row
-- with its own before, after and delta. Where the change costs the guest more,
-- `consent_required` is true and the amendment cannot reach `applied` without
-- `consent_given_at` — which is a check constraint rather than a rule a screen
-- remembers.

create table if not exists public.store_order_amendments (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  order_id            uuid not null,

  -- 'quantity' · 'add_line' · 'remove_line' · 'date' · 'price' ·
  -- 'guest_count' · 'cancel_line'. Text rather than an enum because the list
  -- will grow with the product and an enum change is a migration.
  kind                text not null,
  status              public.store_amendment_status not null default 'proposed',

  before_state        jsonb not null default '{}'::jsonb,
  after_state         jsonb not null default '{}'::jsonb,
  -- Signed. Positive means the guest owes more, which is the case that needs
  -- consent.
  delta_agorot        integer not null default 0,

  reason              text not null,
  consent_required    boolean not null default false,
  consent_given_at    timestamptz,
  consent_given_by    text,

  requested_by        uuid references auth.users (id) on delete set null,
  applied_at          timestamptz,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint store_order_amendments_order_fkey
    foreign key (order_id, organization_id)
    references public.store_orders (id, organization_id) on delete cascade,
  constraint store_order_amendments_kind_present check (length(btrim(kind)) > 0),
  constraint store_order_amendments_reason_present check (length(btrim(reason)) > 0),
  constraint store_order_amendments_before_is_object
    check (jsonb_typeof(before_state) = 'object'),
  constraint store_order_amendments_after_is_object
    check (jsonb_typeof(after_state) = 'object'),

  -- A CHANGE THAT COSTS MORE REQUIRES CONSENT, AND THE DATABASE HOLDS THE LINE.
  constraint store_order_amendments_consent_required check (
    status <> 'applied'
    or consent_required = false
    or consent_given_at is not null
  ),
  -- And an amendment that costs the guest more must have asked. A screen that
  -- forgets to set the flag cannot produce a row that skips the check above.
  constraint store_order_amendments_costlier_asks check (
    delta_agorot <= 0 or consent_required = true
  ),
  constraint store_order_amendments_applied_pair check (
    (status = 'applied') = (applied_at is not null)
  ),
  constraint store_order_amendments_version_positive check (version >= 1)
);

comment on table public.store_order_amendments is
  'An amendment to a committed order, never a silent edit. store_order_amendments_costlier_asks forces consent_required on any change that costs the guest more, and store_order_amendments_consent_required refuses to apply it until the guest agreed.';

create index if not exists store_order_amendments_order_idx
  on public.store_order_amendments (organization_id, order_id, created_at desc);

drop trigger if exists store_order_amendments_touch on public.store_order_amendments;
create trigger store_order_amendments_touch
  before update on public.store_order_amendments
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 16 · store_provider_requests — what leaves the organization
-- ============================================================================
-- READ THE HEADER. There is no guest name, no telephone, no email, no price,
-- no payment column and no agent in this table, and that is a design decision
-- rather than an omission to be corrected later.

create table if not exists public.store_provider_requests (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  -- Internal. The join a manager needs, and never a field the renderer is
  -- given.
  order_id            uuid not null,
  order_line_id       uuid,
  provider_id         uuid not null,

  property_id         uuid not null references public.properties (id) on delete restrict,

  status              public.store_provider_request_status not null default 'draft',
  channel             text not null default 'whatsapp',

  -- What the provider is actually told.
  service_name        text not null,
  service_date        date not null,
  service_time        time,
  duration_minutes    integer,
  quantity            integer not null default 1,
  operational_notes   text,

  -- An opaque per-organization string. Not the order reference, so that a
  -- provider holding one cannot enumerate the others.
  reference           text not null,

  sent_at             timestamptz,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint store_provider_requests_order_fkey
    foreign key (order_id, organization_id)
    references public.store_orders (id, organization_id) on delete cascade,
  constraint store_provider_requests_line_fkey
    foreign key (order_line_id, organization_id)
    references public.store_order_lines (id, organization_id) on delete set null,
  constraint store_provider_requests_provider_fkey
    foreign key (provider_id, organization_id)
    references public.store_providers (id, organization_id) on delete restrict,
  constraint store_provider_requests_organization_reference_key
    unique (organization_id, reference),
  constraint store_provider_requests_service_present
    check (length(btrim(service_name)) > 0),
  constraint store_provider_requests_quantity_positive check (quantity >= 1),
  constraint store_provider_requests_duration_positive
    check (duration_minutes is null or duration_minutes > 0),
  constraint store_provider_requests_channel_known
    check (channel in ('whatsapp', 'sms', 'email', 'phone', 'print', 'copy')),
  -- A request that claims to have been sent has a moment it was sent at.
  constraint store_provider_requests_sent_pair check (
    status in ('draft') or sent_at is not null
  ),
  constraint store_provider_requests_confirmed_pair check (
    (status = 'confirmed') = (confirmed_at is not null)
  ),
  constraint store_provider_requests_version_positive check (version >= 1)
);

comment on table public.store_provider_requests is
  'What leaves the organization addressed to a company with no contractual relationship to the guest. There is no guest name, telephone, email, price, payment state or agent column here, by design — src/lib/store/provider-request.test.ts asserts field by field that none of them appears in the rendered request, and a column here would make that a matter of the renderer remembering.';

comment on column public.store_provider_requests.reference is
  'Opaque, per organization, and deliberately not the order reference: a provider holding one must not be able to guess another.';

create index if not exists store_provider_requests_order_idx
  on public.store_provider_requests (organization_id, order_id);

create index if not exists store_provider_requests_provider_idx
  on public.store_provider_requests (organization_id, provider_id, service_date);

drop trigger if exists store_provider_requests_touch on public.store_provider_requests;
create trigger store_provider_requests_touch
  before update on public.store_provider_requests
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 17 · The triggers that make the rules unfakeable
-- ============================================================================

-- ── A total is the sum of its lines ─────────────────────────────────────────
-- Runs after every write to `store_order_lines` and rewrites the order's four
-- money columns from the lines that now exist. A caller-supplied subtotal is
-- therefore discarded, exactly the way 0009 discards a caller-supplied booking
-- total. There is no path by which an order total and its lines disagree.
--
-- The discount is the ORDER-level one — a promo code — and is held on the
-- order rather than recomputed here, because it is not derivable from the
-- lines. It is clamped to the subtotal so a total can never go negative.

create or replace function public.tg_store_order_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
  v_subtotal integer;
  v_discount integer;
begin
  select coalesce(sum(l.line_total_agorot), 0)
  into v_subtotal
  from public.store_order_lines l
  where l.order_id = v_order_id;

  select least(coalesce(o.discount_agorot, 0), v_subtotal)
  into v_discount
  from public.store_orders o
  where o.id = v_order_id;

  update public.store_orders
  set subtotal_agorot = v_subtotal,
      discount_agorot = coalesce(v_discount, 0),
      total_agorot    = v_subtotal - coalesce(v_discount, 0) + coalesce(tax_agorot, 0)
  where id = v_order_id;

  return null;
end;
$$;

comment on function public.tg_store_order_totals() is
  'Rewrites an order''s subtotal, discount and total from its lines after every line write. A caller-supplied total is discarded, the same way 0009 discards a caller-supplied booking total: "why is it 1,690?" has to have an answer, and the answer is the lines.';

revoke all on function public.tg_store_order_totals() from public, anon, authenticated, service_role;

drop trigger if exists store_order_lines_totals on public.store_order_lines;
create trigger store_order_lines_totals
  after insert or update or delete on public.store_order_lines
  for each row execute function public.tg_store_order_totals();


-- ── A committed order's lines are frozen ────────────────────────────────────
-- From `confirmed` onward — COMMITTED_STORE_ORDER_STATUSES — a guest has been
-- told something and money may have moved. Changing a price or a quantity
-- after that is an amendment with its own row, never an UPDATE.
--
-- What is still allowed is the line's own fulfilment progress: `line_status`
-- and `notes` move as the work is done, and blocking those would make the
-- committed order unworkable.

create or replace function public.tg_store_order_lines_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.store_order_status;
begin
  select o.status into v_status
  from public.store_orders o
  where o.id = coalesce(new.order_id, old.order_id);

  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status not in (
    'confirmed', 'in_preparation', 'ready', 'fulfilled', 'completed'
  ) then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    raise exception 'store_order_line_committed'
      using hint = 'ההזמנה כבר אושרה מול האורח. שינוי נעשה כתיקון עם תיעוד, לא במחיקת שורה.',
            errcode = 'P0010';
  end if;

  if new.unit_price_agorot is distinct from old.unit_price_agorot
     or new.quantity is distinct from old.quantity
     or new.options_agorot is distinct from old.options_agorot
     or new.addons_agorot is distinct from old.addons_agorot
     or new.line_discount_agorot is distinct from old.line_discount_agorot
     or new.item_name_snapshot is distinct from old.item_name_snapshot then
    raise exception 'store_order_line_committed'
      using hint = 'ההזמנה כבר אושרה מול האורח. שינוי מחיר או כמות נעשה כתיקון עם תיעוד והסכמה.',
            errcode = 'P0010';
  end if;

  return new;
end;
$$;

comment on function public.tg_store_order_lines_frozen() is
  'Refuses a price, quantity or name change on a line whose order has reached COMMITTED_STORE_ORDER_STATUSES. Fulfilment progress — line_status, notes — is deliberately still allowed, because a committed order still has to be worked.';

revoke all on function public.tg_store_order_lines_frozen() from public, anon, authenticated, service_role;

drop trigger if exists store_order_lines_frozen on public.store_order_lines;
create trigger store_order_lines_frozen
  before update or delete on public.store_order_lines
  for each row execute function public.tg_store_order_lines_frozen();


-- ── The price history writes itself ─────────────────────────────────────────

create or replace function public.tg_store_items_price_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.base_price_agorot is not distinct from old.base_price_agorot
     and new.pricing_model is not distinct from old.pricing_model then
    return new;
  end if;

  insert into public.store_price_history (
    organization_id, item_id,
    previous_price_agorot, new_price_agorot,
    previous_pricing_model, new_pricing_model,
    changed_by
  )
  values (
    new.organization_id, new.id,
    old.base_price_agorot, new.base_price_agorot,
    old.pricing_model, new.pricing_model,
    (select auth.uid())
  );

  return new;
end;
$$;

comment on function public.tg_store_items_price_history() is
  'Appends to store_price_history on every price or pricing-model change, so the record cannot depend on a screen remembering to write it.';

revoke all on function public.tg_store_items_price_history() from public, anon, authenticated, service_role;

drop trigger if exists store_items_price_history on public.store_items;
create trigger store_items_price_history
  after update on public.store_items
  for each row execute function public.tg_store_items_price_history();


-- ── A business on `simple` never meets supplier or margin vocabulary ────────
-- §5, enforced where it cannot be forgotten. `cost_agorot` and
-- `supplier_reference` are `advanced` concepts; an organization that has not
-- asked for `advanced` cannot store them, so no screen can accidentally
-- surface a margin an owner never agreed to think about.

create or replace function public.tg_store_items_mode_vocabulary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode public.store_mode;
begin
  if new.cost_agorot is null
     and (new.supplier_reference is null
          or length(btrim(new.supplier_reference)) = 0) then
    return new;
  end if;

  select s.mode into v_mode
  from public.store_settings s
  where s.organization_id = new.organization_id
    and s.property_id is null;

  if v_mode is distinct from 'advanced'::public.store_mode then
    raise exception 'store_advanced_vocabulary_only'
      using hint = 'עלות וספק שייכים למצב המתקדם של החנות. שנה את מצב החנות להגדרה ״מתקדם״ כדי להשתמש בהם.',
            errcode = 'P0011';
  end if;

  return new;
end;
$$;

comment on function public.tg_store_items_mode_vocabulary() is
  'A business on `simple` or `commerce` cannot store cost_agorot or supplier_reference. §5 of the brief made unfakeable: a screen forgetting to hide a field cannot create the row.';

revoke all on function public.tg_store_items_mode_vocabulary() from public, anon, authenticated, service_role;

drop trigger if exists store_items_mode_vocabulary on public.store_items;
create trigger store_items_mode_vocabulary
  before insert or update on public.store_items
  for each row execute function public.tg_store_items_mode_vocabulary();


-- ============================================================================
-- 18 · Row level security
-- ============================================================================

alter table public.store_settings                enable row level security;
alter table public.store_settings                force  row level security;
alter table public.store_categories              enable row level security;
alter table public.store_categories              force  row level security;
alter table public.store_providers               enable row level security;
alter table public.store_providers               force  row level security;
alter table public.store_items                   enable row level security;
alter table public.store_items                   force  row level security;
alter table public.store_item_options            enable row level security;
alter table public.store_item_options            force  row level security;
alter table public.store_item_option_values      enable row level security;
alter table public.store_item_option_values      force  row level security;
alter table public.store_item_addons             enable row level security;
alter table public.store_item_addons             force  row level security;
alter table public.store_packages                enable row level security;
alter table public.store_packages                force  row level security;
alter table public.store_package_items           enable row level security;
alter table public.store_package_items           force  row level security;
alter table public.store_item_property_overrides enable row level security;
alter table public.store_item_property_overrides force  row level security;
alter table public.store_availability_rules      enable row level security;
alter table public.store_availability_rules      force  row level security;
alter table public.store_promo_codes             enable row level security;
alter table public.store_promo_codes             force  row level security;
alter table public.store_price_history           enable row level security;
alter table public.store_price_history           force  row level security;
alter table public.store_orders                  enable row level security;
alter table public.store_orders                  force  row level security;
alter table public.store_order_lines             enable row level security;
alter table public.store_order_lines             force  row level security;
alter table public.store_order_line_options      enable row level security;
alter table public.store_order_line_options      force  row level security;
alter table public.store_order_payments          enable row level security;
alter table public.store_order_payments          force  row level security;
alter table public.store_order_amendments        enable row level security;
alter table public.store_order_amendments        force  row level security;
alter table public.store_provider_requests       enable row level security;
alter table public.store_provider_requests       force  row level security;

-- 0014's discipline: revoke from anon and authenticated first, then hand back
-- only what the policies are written for. `anon` gets nothing anywhere in this
-- file — a store order names a property, a date and a guest, and an
-- unauthenticated read of it is an occupancy calendar with a shopping list
-- attached.
revoke all on public.store_settings                from anon, authenticated;
revoke all on public.store_categories              from anon, authenticated;
revoke all on public.store_providers               from anon, authenticated;
revoke all on public.store_items                   from anon, authenticated;
revoke all on public.store_item_options            from anon, authenticated;
revoke all on public.store_item_option_values      from anon, authenticated;
revoke all on public.store_item_addons             from anon, authenticated;
revoke all on public.store_packages                from anon, authenticated;
revoke all on public.store_package_items           from anon, authenticated;
revoke all on public.store_item_property_overrides from anon, authenticated;
revoke all on public.store_availability_rules      from anon, authenticated;
revoke all on public.store_promo_codes             from anon, authenticated;
revoke all on public.store_price_history           from anon, authenticated;
revoke all on public.store_orders                  from anon, authenticated;
revoke all on public.store_order_lines             from anon, authenticated;
revoke all on public.store_order_line_options      from anon, authenticated;
revoke all on public.store_order_payments          from anon, authenticated;
revoke all on public.store_order_amendments        from anon, authenticated;
revoke all on public.store_provider_requests       from anon, authenticated;

grant select, insert, update, delete on public.store_settings                to authenticated;
grant select, insert, update, delete on public.store_categories              to authenticated;
grant select, insert, update, delete on public.store_providers               to authenticated;
grant select, insert, update, delete on public.store_items                   to authenticated;
grant select, insert, update, delete on public.store_item_options            to authenticated;
grant select, insert, update, delete on public.store_item_option_values      to authenticated;
grant select, insert, update, delete on public.store_item_addons             to authenticated;
grant select, insert, update, delete on public.store_packages                to authenticated;
grant select, insert, update, delete on public.store_package_items           to authenticated;
grant select, insert, update, delete on public.store_item_property_overrides to authenticated;
grant select, insert, update, delete on public.store_availability_rules      to authenticated;
grant select, insert, update, delete on public.store_promo_codes             to authenticated;
grant select                         on public.store_price_history           to authenticated;
grant select, insert, update         on public.store_orders                  to authenticated;
grant select, insert, update, delete on public.store_order_lines             to authenticated;
grant select, insert, update, delete on public.store_order_line_options      to authenticated;
grant select, insert, update         on public.store_order_payments          to authenticated;
grant select, insert, update         on public.store_order_amendments        to authenticated;
grant select, insert, update         on public.store_provider_requests       to authenticated;

grant select, insert, update, delete on public.store_settings                to service_role;
grant select, insert, update, delete on public.store_categories              to service_role;
grant select, insert, update, delete on public.store_providers               to service_role;
grant select, insert, update, delete on public.store_items                   to service_role;
grant select, insert, update, delete on public.store_item_options            to service_role;
grant select, insert, update, delete on public.store_item_option_values      to service_role;
grant select, insert, update, delete on public.store_item_addons             to service_role;
grant select, insert, update, delete on public.store_packages                to service_role;
grant select, insert, update, delete on public.store_package_items           to service_role;
grant select, insert, update, delete on public.store_item_property_overrides to service_role;
grant select, insert, update, delete on public.store_availability_rules      to service_role;
grant select, insert, update, delete on public.store_promo_codes             to service_role;
grant select                         on public.store_price_history           to service_role;
grant select, insert, update         on public.store_orders                  to service_role;
grant select, insert, update, delete on public.store_order_lines             to service_role;
grant select, insert, update, delete on public.store_order_line_options      to service_role;
grant select, insert, update         on public.store_order_payments          to service_role;
grant select, insert, update         on public.store_order_amendments        to service_role;
grant select, insert, update         on public.store_provider_requests       to service_role;

-- An order is never deleted, by anybody. It is cancelled — `cancelled` is in
-- STORE_ORDER_STATUSES for exactly this — because a purchase that was made and
-- called off is a thing that happened, and a business that cannot show the
-- record of a cancelled order cannot argue about a refund. Revoked from
-- service_role too, which carries BYPASSRLS and would otherwise be the one
-- caller policies cannot stop. The same applies to the money, the amendments
-- and the price history: all four are the evidence.
revoke delete, truncate on public.store_orders            from service_role;
revoke delete, truncate on public.store_order_payments    from service_role;
revoke delete, truncate on public.store_order_amendments  from service_role;
revoke delete, truncate on public.store_price_history     from service_role;
revoke insert, update    on public.store_price_history    from authenticated, service_role;


-- ── Policies · configuration read by `product.view`, written by the two
--    management grants ─────────────────────────────────────────────────────
-- `product.price_manage` is separate from `product.manage` on purpose and 0012
-- declared it that way: a person may be trusted to write a description and not
-- to move a price. It is enforced by the price-history trigger being the only
-- writer of history and by the application's `product.price` operation, not by
-- a column-level policy, because Postgres column privileges do not compose
-- with RLS in a way anybody can read six months later.

drop policy if exists store_settings_select on public.store_settings;
create policy store_settings_select on public.store_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_settings_insert on public.store_settings;
create policy store_settings_insert on public.store_settings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_settings_update on public.store_settings;
create policy store_settings_update on public.store_settings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_settings_delete on public.store_settings;
create policy store_settings_delete on public.store_settings
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );


-- The catalogue tables all share one shape: read on `product.view`, write on
-- `product.manage`. Written out per table rather than generated, because a
-- policy a reader cannot see in full is a policy nobody audits.

drop policy if exists store_categories_select on public.store_categories;
create policy store_categories_select on public.store_categories
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_categories_write on public.store_categories;
create policy store_categories_write on public.store_categories
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_items_select on public.store_items;
create policy store_items_select on public.store_items
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_items_write on public.store_items;
create policy store_items_write on public.store_items
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_item_options_select on public.store_item_options;
create policy store_item_options_select on public.store_item_options
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_item_options_write on public.store_item_options;
create policy store_item_options_write on public.store_item_options
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_item_option_values_select on public.store_item_option_values;
create policy store_item_option_values_select on public.store_item_option_values
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_item_option_values_write on public.store_item_option_values;
create policy store_item_option_values_write on public.store_item_option_values
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_item_addons_select on public.store_item_addons;
create policy store_item_addons_select on public.store_item_addons
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_item_addons_write on public.store_item_addons;
create policy store_item_addons_write on public.store_item_addons
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_packages_select on public.store_packages;
create policy store_packages_select on public.store_packages
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_packages_write on public.store_packages;
create policy store_packages_write on public.store_packages
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_package_items_select on public.store_package_items;
create policy store_package_items_select on public.store_package_items
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_package_items_write on public.store_package_items;
create policy store_package_items_write on public.store_package_items
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_item_property_overrides_select
  on public.store_item_property_overrides;
create policy store_item_property_overrides_select
  on public.store_item_property_overrides
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_item_property_overrides_write
  on public.store_item_property_overrides;
create policy store_item_property_overrides_write
  on public.store_item_property_overrides
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'product.manage')
  );

drop policy if exists store_availability_rules_select on public.store_availability_rules;
create policy store_availability_rules_select on public.store_availability_rules
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'product.view')
  );

drop policy if exists store_availability_rules_write on public.store_availability_rules;
create policy store_availability_rules_write on public.store_availability_rules
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'product.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'product.manage')
  );


-- ── Policies · store_providers ──────────────────────────────────────────────
-- READING A PROVIDER IS `provider.manage`, NOT `product.view`.
--
-- The same asymmetry 0029 makes about laundry providers, for the same reason.
-- A provider row is commercial information — a supplier's name and a contact's
-- telephone number — and the way to guarantee a receptionist does not have it
-- is not a screen omitting a column, it is a policy returning no rows.

drop policy if exists store_providers_select on public.store_providers;
create policy store_providers_select on public.store_providers
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'provider.manage')
  );

drop policy if exists store_providers_write on public.store_providers;
create policy store_providers_write on public.store_providers
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'provider.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'provider.manage')
  );


-- ── Policies · store_promo_codes ────────────────────────────────────────────
-- A promo code is a discount, and 0012 has a grant for exactly that.

drop policy if exists store_promo_codes_select on public.store_promo_codes;
create policy store_promo_codes_select on public.store_promo_codes
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.view')
  );

drop policy if exists store_promo_codes_write on public.store_promo_codes;
create policy store_promo_codes_write on public.store_promo_codes
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.discount_manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.discount_manage')
  );


-- ── Policies · store_price_history ──────────────────────────────────────────
-- Read by `product.price_manage`: it is the price conversation, and a person
-- who may not move a price does not need the record of who did. Nothing may
-- write it from the application at all — the grants above take INSERT and
-- UPDATE away, and the SECURITY DEFINER trigger is the only writer.

drop policy if exists store_price_history_select on public.store_price_history;
create policy store_price_history_select on public.store_price_history
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'product.price_manage')
  );


-- ── Policies · orders ───────────────────────────────────────────────────────
-- Read on `order.view`, create and change on `order.manage`. Property scope
-- applies to every one of them: a property-scoped manager sees the orders of
-- their own houses and not the portfolio's.

drop policy if exists store_orders_select on public.store_orders;
create policy store_orders_select on public.store_orders
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'order.view')
  );

drop policy if exists store_orders_insert on public.store_orders;
create policy store_orders_insert on public.store_orders
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'order.manage')
  );

drop policy if exists store_orders_update on public.store_orders;
create policy store_orders_update on public.store_orders
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (public.has_permission(organization_id, 'order.manage')
         or public.has_permission(organization_id, 'order.fulfil'))
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and (public.has_permission(organization_id, 'order.manage')
         or public.has_permission(organization_id, 'order.fulfil'))
  );

-- The lines follow the order, and prove their scope through it rather than
-- carrying a property of their own: one fact, one place.
drop policy if exists store_order_lines_select on public.store_order_lines;
create policy store_order_lines_select on public.store_order_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.view')
    and exists (
      select 1 from public.store_orders o
      where o.id = store_order_lines.order_id
        and o.organization_id = store_order_lines.organization_id
        and public.property_in_scope(o.property_id, o.organization_id)
    )
  );

drop policy if exists store_order_lines_write on public.store_order_lines;
create policy store_order_lines_write on public.store_order_lines
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
    and exists (
      select 1 from public.store_orders o
      where o.id = store_order_lines.order_id
        and o.organization_id = store_order_lines.organization_id
        and public.property_in_scope(o.property_id, o.organization_id)
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
    and exists (
      select 1 from public.store_orders o
      where o.id = store_order_lines.order_id
        and o.organization_id = store_order_lines.organization_id
        and public.property_in_scope(o.property_id, o.organization_id)
    )
  );

drop policy if exists store_order_line_options_select on public.store_order_line_options;
create policy store_order_line_options_select on public.store_order_line_options
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.view')
  );

drop policy if exists store_order_line_options_write on public.store_order_line_options;
create policy store_order_line_options_write on public.store_order_line_options
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
  );

-- Money. Read with the order; recorded by `order.manage`; a NEGATIVE row — a
-- refund — additionally needs `order.refund`, which is in SENSITIVE_ACTIONS
-- and therefore also demands a stated reason at the service layer.
drop policy if exists store_order_payments_select on public.store_order_payments;
create policy store_order_payments_select on public.store_order_payments
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.view')
  );

drop policy if exists store_order_payments_insert on public.store_order_payments;
create policy store_order_payments_insert on public.store_order_payments
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (
      (amount_agorot > 0
       and public.has_permission(organization_id, 'order.manage'))
      or (amount_agorot < 0
          and public.has_permission(organization_id, 'order.refund'))
    )
  );

drop policy if exists store_order_payments_update on public.store_order_payments;
create policy store_order_payments_update on public.store_order_payments
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
  );

drop policy if exists store_order_amendments_select on public.store_order_amendments;
create policy store_order_amendments_select on public.store_order_amendments
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.view')
  );

drop policy if exists store_order_amendments_write on public.store_order_amendments;
create policy store_order_amendments_write on public.store_order_amendments
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'order.manage')
  );

-- A provider request is read by whoever may work an order and written by
-- whoever may fulfil one: `order.fulfil` is the grant for doing the work, and
-- sending a request to an outside company in the organization's name is the
-- work.
drop policy if exists store_provider_requests_select on public.store_provider_requests;
create policy store_provider_requests_select on public.store_provider_requests
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'order.view')
  );

drop policy if exists store_provider_requests_write on public.store_provider_requests;
create policy store_provider_requests_write on public.store_provider_requests
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'order.fulfil')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'order.fulfil')
  );


-- ============================================================================
-- 19 · Rehearsal
-- ============================================================================
-- The same shape 0026, 0027 and 0029 used: assert what this migration assumed,
-- so a schema that has drifted fails here rather than at the moment a guest
-- presses "שלח הזמנה".

do $$
declare
  missing text;
  v_generated text;
begin
  -- The tables this depends on, and the ones it just created.
  select string_agg(name, ', ') into missing
  from (values
    ('organizations'), ('properties'), ('bookings'), ('guests'),
    ('store_settings'), ('store_categories'), ('store_providers'),
    ('store_items'), ('store_item_options'), ('store_item_option_values'),
    ('store_item_addons'), ('store_packages'), ('store_package_items'),
    ('store_item_property_overrides'), ('store_availability_rules'),
    ('store_promo_codes'), ('store_price_history'), ('store_orders'),
    ('store_order_lines'), ('store_order_line_options'),
    ('store_order_payments'), ('store_order_amendments'),
    ('store_provider_requests')
  ) as t(name)
  where not exists (
    select 1 from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
    where n2.nspname = 'public' and c.relname = t.name and c.relkind = 'r'
  );

  if missing is not null then
    raise exception 'tables missing for 0032: %', missing;
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
    raise exception 'functions missing for 0032: %', missing;
  end if;

  -- The nine grants this module is written against. 0012 owns the catalogue,
  -- and there is deliberately no `store.*` grant among them: if one of these
  -- were renamed there, every policy above would silently refuse everybody,
  -- which reads on screen as "the store is empty".
  select string_agg(code, ', ') into missing
  from (values
    ('product.view'), ('product.manage'), ('product.price_manage'),
    ('order.view'), ('order.manage'), ('order.fulfil'),
    ('order.discount_manage'), ('order.refund'), ('provider.manage')
  ) as g(code)
  where not exists (
    select 1 from public.permissions where permissions.code = g.code
  );

  if missing is not null then
    raise exception 'permissions missing for 0032: %', missing;
  end if;

  -- There must be no `store.*` grant. §104 of the brief: the nine grants above
  -- already carry the `commerce` entitlement, and a parallel vocabulary would
  -- mean two answers to "may this person price a product".
  select string_agg(code, ', ') into missing
  from public.permissions
  where code like 'store.%';

  if missing is not null then
    raise exception 'a store.* grant exists and must not: %', missing;
  end if;

  -- ── THE PRICE SNAPSHOT, ASSERTED IN THE SCHEMA ──────────────────────────
  -- `line_total_agorot` must be a GENERATED column. If somebody ever converts
  -- it to an ordinary one "to make an import easier", a line total stops being
  -- the sum of its parts and the whole guarantee at the top of this file is
  -- gone silently.
  select a.attgenerated::text into v_generated
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public'
    and c.relname = 'store_order_lines'
    and a.attname = 'line_total_agorot';

  if v_generated is distinct from 's' then
    raise exception
      'store_order_lines.line_total_agorot is not a stored generated column — a line total could be written that is not the sum of its parts';
  end if;

  -- And the snapshot columns themselves must be NOT NULL. A nullable
  -- unit_price is an order that has to go and ask the catalogue.
  select string_agg(a.attname, ', ') into missing
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public'
    and c.relname = 'store_order_lines'
    and a.attname in (
      'unit_price_agorot', 'item_name_snapshot', 'pricing_model_snapshot',
      'item_type_snapshot', 'quantity'
    )
    and not a.attnotnull;

  if missing is not null then
    raise exception 'snapshot columns are nullable on store_order_lines: %', missing;
  end if;

  -- ── THE PROVIDER LEARNS NOTHING ABOUT THE GUEST ─────────────────────────
  -- Asserted against the catalogue rather than trusted to review. A column
  -- added here later would make src/lib/store/provider-request.test.ts a
  -- statement about the renderer instead of about the schema.
  select string_agg(a.attname, ', ') into missing
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public'
    and c.relname = 'store_provider_requests'
    and a.attnum > 0
    and not a.attisdropped
    and (a.attname like '%guest%'
         or a.attname like '%phone%'
         or a.attname like '%email%'
         or a.attname like '%price%'
         or a.attname like '%agorot%'
         or a.attname like '%payment%'
         or a.attname like '%agent%');

  if missing is not null then
    raise exception
      'store_provider_requests carries guest or money columns and must not: %', missing;
  end if;

  -- Every table must have RLS both enabled and forced. Forced is the half
  -- people forget, and without it the table owner reads everything.
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public'
    and c.relname like 'store\_%'
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);

  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  -- `anon` must hold nothing anywhere in this schema.
  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and table_name like 'store\_%';

  if missing is not null then
    raise exception 'anon still holds privileges on: %', missing;
  end if;

  -- The four triggers that make the rules unfakeable.
  select string_agg(name, ', ') into missing
  from (values
    ('store_order_lines_totals'), ('store_order_lines_frozen'),
    ('store_items_price_history'), ('store_items_mode_vocabulary')
  ) as t(name)
  where not exists (
    select 1 from pg_trigger where tgname = t.name and not tgisinternal
  );

  if missing is not null then
    raise exception 'triggers missing for 0032: %', missing;
  end if;
end $$;
