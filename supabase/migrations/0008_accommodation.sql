-- ============================================================================
-- 0008_accommodation.sql — ESTIA · what is actually being sold
--
-- What this does
--   Creates the accommodation core — `teams`, `properties`, `unit_groups`,
--   `units`, `amenities` and the two join tables — and then closes the
--   forward references that 0001 and 0005 deliberately left open because
--   these tables did not exist yet.
--
--   Four constraints were waiting for this file:
--       · memberships.default_property_id  -> properties
--       · memberships.team_id              -> teams
--       · audit_events.property_id         -> properties
--       · the scope arrays on membership_scopes and invitations
--
--   The first three are real foreign keys, and composite ones: they prove not
--   only that the row exists but that it belongs to the same organization.
--   The fourth cannot be a foreign key at all — PostgreSQL has no constraint
--   from an array element to a table — so it is closed by triggers instead,
--   in both directions: a scope may not name a property that does not exist
--   in its organization, and a property named by a live scope may not be
--   hard-deleted out from under it. That is strictly more than a foreign key
--   would have given, because a foreign key could not have checked the tenant.
--
-- Scope, and why it lives in the database
--   docs/ARCHITECTURE.md §12 states the rule for the agent network as law:
--   enforcement is in the query, not in a filter applied to the result. A
--   search engine that reads the whole inventory and narrows afterwards has
--   already leaked. So `property_in_scope()` and `unit_in_scope()` are RLS
--   predicates, and a member scoped to two properties cannot make the third
--   one appear by asking a different way.
--
-- Depends on
--   0001_identity.sql (organizations, memberships, invitations, tg_touch_row,
--   membership_scope_kind), 0004_rls.sql (my_organizations), 0005_audit.sql
--   (audit_events).
--
-- Followed by
--   0009_booking_core.sql, which adds guests, bookings and holds on top of
--   these tables and relies on the composite unique keys declared here.
-- ============================================================================

set search_path = public, extensions;


-- ── Types ───────────────────────────────────────────────────────────────────

do $$ begin
  create type public.property_type as enum (
    'zimmer',
    'villa',
    'apartment',
    'boutique_hotel',
    'hostel',
    'complex',
    'camping',
    'other'
  );
exception when duplicate_object then null;
end $$;

comment on type public.property_type is
  'What kind of place this is. Deliberately separate from organization_business_type: a management company is a kind of business, not a kind of building, and one organization can run a villa and a hostel at once.';

do $$ begin
  create type public.property_status as enum (
    'draft',
    'active',
    'inactive',
    'archived'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.unit_type as enum (
    'room',
    'suite',
    'studio',
    'apartment',
    'cabin',
    'villa',
    'dorm_bed',
    'tent',
    'pitch',
    'other'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.unit_status as enum (
    'draft',
    'active',
    'maintenance',
    'inactive',
    'archived'
  );
exception when duplicate_object then null;
end $$;

comment on type public.unit_status is
  'A unit that is not active is not sellable. It still blocks its own dates through existing bookings: withdrawing a unit from sale must never silently release stays that were already sold in it.';

do $$ begin
  create type public.team_kind as enum (
    'housekeeping',
    'maintenance',
    'front_desk',
    'management',
    'sales',
    'other'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.amenity_category as enum (
    'general',
    'kitchen',
    'bathroom',
    'outdoor',
    'entertainment',
    'accessibility',
    'family',
    'wellness',
    'services'
  );
exception when duplicate_object then null;
end $$;


-- ── teams ───────────────────────────────────────────────────────────────────
-- Named here rather than "later, when we do shift management", because
-- `memberships.team_id` has existed since 0001 and a column that points
-- nowhere is a column nobody can trust. A team may be organization-wide or
-- attached to one property — the housekeeping crew of a specific villa is the
-- ordinary case, not the exception.

create table if not exists public.teams (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  -- Set once properties exist below; the constraint is added after that table.
  property_id      uuid,

  name             text not null,
  description      text,
  kind             public.team_kind not null default 'other',
  color            text,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  deleted_at       timestamptz,
  deleted_by       uuid references auth.users (id) on delete set null,

  -- Lets memberships.team_id prove, with one composite foreign key, that the
  -- team belongs to the same organization as the membership.
  constraint teams_id_organization_key unique (id, organization_id),
  constraint teams_name_not_blank check (length(btrim(name)) > 0),
  constraint teams_color_format check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint teams_version_positive check (version >= 1),
  constraint teams_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.teams is
  'A group of members who work together: a housekeeping crew, a maintenance crew, a front desk. The target of the team scope in membership_scopes, and the closing side of the memberships.team_id reference that 0001 left open.';
comment on column public.teams.property_id is
  'The property this team works at, when it works at exactly one. NULL means organization-wide.';

create unique index if not exists teams_organization_name_idx
  on public.teams (organization_id, lower(name)) where deleted_at is null;

drop trigger if exists teams_touch on public.teams;
create trigger teams_touch
  before update on public.teams
  for each row execute function public.tg_touch_row();


-- ── properties ──────────────────────────────────────────────────────────────
-- The place. Everything below it — units, bookings, holds, housekeeping — is
-- reached through it, and the property is the unit of scope: "property
-- manager" is meaningless until it names which properties.
--
-- Money on a property is settings, not amounts, so there is nothing in agorot
-- here. Tax is: rate in basis points (1700 = 17%), whether the displayed price
-- already contains it, and whether this property applies the Israeli zero-rate
-- for foreign tourists — which is a real rule about real invoices, not a
-- future nicety, and a booking cannot be re-taxed retroactively.

create table if not exists public.properties (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,

  slug                    citext not null,
  name                    text not null,
  legal_name              text,
  description             text,
  property_type           public.property_type not null default 'other',
  status                  public.property_status not null default 'draft',

  -- Where it is. Free-form lines rather than a normalised address table: an
  -- Israeli address is not a US address, and the only consumers are a label,
  -- a map pin and a tax invoice.
  address_line1           text,
  address_line2           text,
  city                    text,
  region                  text,
  postal_code             text,
  country                 text not null default 'IL',
  latitude                numeric(9,6),
  longitude               numeric(9,6),

  timezone                text not null default 'Asia/Jerusalem',
  currency                text not null default 'ILS',

  -- The house defaults. A unit carries its own times (a suite with a late
  -- checkout is normal); these are what a new unit starts from and what the
  -- guest-facing pages state for the property as a whole.
  default_check_in_time   time not null default '15:00',
  default_check_out_time  time not null default '11:00',
  min_nights              integer not null default 1,

  -- Policy. Structured where something computes against it, prose where a
  -- human reads it. Both, because a cancellation policy is simultaneously a
  -- refund calculation and a paragraph the guest agreed to.
  policies                jsonb not null default '{}'::jsonb,
  house_rules             text,
  cancellation_policy     jsonb not null default '{}'::jsonb,
  cancellation_policy_text text,

  -- Tax.
  tax_id                  text,
  tax_rate_bps            integer not null default 1700,
  tax_included_in_price   boolean not null default true,
  tourist_vat_exempt      boolean not null default false,

  contact_name            text,
  contact_phone           text,
  contact_email           citext,

  cover_image_url         text,
  sort_order              integer not null default 0,

  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,
  deleted_at              timestamptz,
  deleted_by              uuid references auth.users (id) on delete set null,

  -- The key every child table hangs its tenant proof on.
  constraint properties_id_organization_key unique (id, organization_id),
  constraint properties_name_not_blank check (length(btrim(name)) > 0),
  constraint properties_slug_format check (
    (slug::text) ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' and length(slug::text) between 2 and 63
  ),
  constraint properties_country_format check (country ~ '^[A-Z]{2}$'),
  constraint properties_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint properties_timezone_not_blank check (length(btrim(timezone)) > 0),
  constraint properties_latitude_range check (latitude is null or latitude between -90 and 90),
  constraint properties_longitude_range check (longitude is null or longitude between -180 and 180),
  -- A pin is two numbers or none. Half a coordinate puts a property in the
  -- Gulf of Guinea, which is where every zero-latitude bug ends up.
  constraint properties_coordinates_paired check (
    (latitude is null) = (longitude is null)
  ),
  constraint properties_tax_rate_range check (tax_rate_bps between 0 and 10000),
  constraint properties_min_nights_positive check (min_nights >= 1),
  constraint properties_version_positive check (version >= 1),
  constraint properties_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.properties is
  'A place that is let out: a zimmer, a villa, a boutique hotel. Belongs to exactly one organization and is the anchor of the properties scope — a member scoped to a list of properties reaches nothing outside it, enforced by RLS and not by a filter on the result.';
comment on column public.properties.slug is
  'Case-insensitive identifier used in URLs, unique per organization among live properties.';
comment on column public.properties.tax_rate_bps is
  'VAT in basis points; 1700 is 17%. Integer for the same reason money is: a rate stored as 0.17 float eventually renders an invoice that does not add up.';
comment on column public.properties.tourist_vat_exempt is
  'Israeli zero-rate for foreign tourists on accommodation. A property-level default; the booking records what was actually applied.';
comment on column public.properties.default_check_in_time is
  'House default. Each unit carries its own times — this is what a new unit starts from and what the property pages state.';

create unique index if not exists properties_organization_slug_idx
  on public.properties (organization_id, slug) where deleted_at is null;

drop trigger if exists properties_touch on public.properties;
create trigger properties_touch
  before update on public.properties
  for each row execute function public.tg_touch_row();

-- Now that properties exists, close the team -> property reference.
-- ON DELETE SET NULL names its column explicitly (PostgreSQL 15+): a plain
-- SET NULL on a composite key would try to null organization_id too, which is
-- NOT NULL, and the delete would fail with an error about the wrong thing.
do $$ begin
  alter table public.teams
    add constraint teams_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id)
    on delete set null (property_id);
exception when duplicate_object then null;
end $$;


-- ── unit_groups ─────────────────────────────────────────────────────────────
-- Interchangeable units, sold as one thing. "A double room" is a group; room
-- 12 is a unit. Availability is still computed per unit — a group that could
-- be overbooked because it counts rather than allocates is the classic hotel
-- oversell — but pricing, photos and the listing hang off the group.

create table if not exists public.unit_groups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null,
  property_id      uuid not null,

  name             text not null,
  description      text,
  sort_order       integer not null default 0,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  deleted_at       timestamptz,
  deleted_by       uuid references auth.users (id) on delete set null,

  constraint unit_groups_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  -- Lets a unit prove its group is in the same property, not merely the same
  -- organization.
  constraint unit_groups_id_property_key unique (id, organization_id, property_id),
  constraint unit_groups_name_not_blank check (length(btrim(name)) > 0),
  constraint unit_groups_version_positive check (version >= 1),
  constraint unit_groups_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.unit_groups is
  'A set of interchangeable units within one property, for listing and pricing. Availability is never computed from a group count — it is computed per unit, because a group that counts rather than allocates is how a hotel oversells.';

drop trigger if exists unit_groups_touch on public.unit_groups;
create trigger unit_groups_touch
  before update on public.unit_groups
  for each row execute function public.tg_touch_row();


-- ── units ───────────────────────────────────────────────────────────────────
-- The thing a stay is actually sold against, and therefore the thing the
-- no-double-booking guarantee in 0009 is keyed on.
--
-- `bathrooms` is numeric(3,1) and not an integer, because 2.5 bathrooms is a
-- real listing and rounding it in either direction is a complaint.

create table if not exists public.units (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  property_id              uuid not null,
  unit_group_id            uuid,

  code                     text not null,
  name                     text not null,
  description              text,
  unit_type                public.unit_type not null default 'room',
  status                   public.unit_status not null default 'draft',

  -- Capacity.
  max_guests               integer not null default 2,
  standard_guests          integer not null default 2,
  max_adults               integer,
  max_children             integer,
  bedrooms                 integer not null default 1,
  bathrooms                numeric(3,1) not null default 1,
  beds                     integer not null default 1,
  size_sqm                 numeric(8,2),
  floor                    text,

  -- Money, in agorot, as integers. Never a float, never a decimal string:
  -- see src/lib/plans/plan.ts for the reasoning this product settled on.
  base_price_agorot        integer not null default 0,
  extra_guest_price_agorot integer not null default 0,
  cleaning_fee_agorot      integer not null default 0,
  deposit_agorot           integer not null default 0,

  check_in_time            time not null default '15:00',
  check_out_time           time not null default '11:00',
  min_nights               integer not null default 1,
  max_nights               integer,

  cover_image_url          text,
  sort_order               integer not null default 0,

  metadata                 jsonb not null default '{}'::jsonb,

  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users (id) on delete set null,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users (id) on delete set null,
  version                  integer not null default 1,
  deleted_at               timestamptz,
  deleted_by               uuid references auth.users (id) on delete set null,

  constraint units_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,
  constraint units_group_fkey
    foreign key (unit_group_id, organization_id, property_id)
    references public.unit_groups (id, organization_id, property_id) on delete set null (unit_group_id),

  -- One key, three guarantees: a booking or a hold that references
  -- (unit_id, organization_id, property_id) has proven in a single foreign
  -- key that the unit is in that property and that property is in that
  -- organization. Nothing in 0009 has to re-check it.
  constraint units_id_organization_property_key unique (id, organization_id, property_id),

  constraint units_code_not_blank check (length(btrim(code)) > 0),
  constraint units_name_not_blank check (length(btrim(name)) > 0),
  constraint units_max_guests_positive check (max_guests >= 1),
  constraint units_standard_guests_range check (standard_guests between 1 and max_guests),
  constraint units_max_adults_range check (max_adults is null or max_adults between 1 and max_guests),
  constraint units_max_children_range check (max_children is null or max_children between 0 and max_guests),
  constraint units_bedrooms_nonnegative check (bedrooms >= 0),
  constraint units_bathrooms_nonnegative check (bathrooms >= 0),
  constraint units_beds_nonnegative check (beds >= 0),
  constraint units_size_positive check (size_sqm is null or size_sqm > 0),
  constraint units_base_price_nonnegative check (base_price_agorot >= 0),
  constraint units_extra_guest_price_nonnegative check (extra_guest_price_agorot >= 0),
  constraint units_cleaning_fee_nonnegative check (cleaning_fee_agorot >= 0),
  constraint units_deposit_nonnegative check (deposit_agorot >= 0),
  constraint units_min_nights_positive check (min_nights >= 1),
  constraint units_max_nights_range check (max_nights is null or max_nights >= min_nights),
  constraint units_version_positive check (version >= 1),
  constraint units_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.units is
  'One lettable unit: a room, a cabin, a whole villa. Stays are sold against a unit, so this is what the exclusion constraint in 0009 keys on — the calendar is decided per unit and never per group.';
comment on column public.units.base_price_agorot is
  'Nightly rate in agorot as an integer. The starting point for a quote, not the price of a stay: the price of a stay is the sum of its price lines.';
comment on column public.units.deposit_agorot is
  'Security deposit in agorot. Held and released, not earned; it appears on a booking as a deposit price line.';
comment on column public.units.status is
  'A unit that is not active cannot be sold. It does not release stays that were already sold in it.';

create unique index if not exists units_property_code_idx
  on public.units (property_id, lower(code)) where deleted_at is null;

drop trigger if exists units_touch on public.units;
create trigger units_touch
  before update on public.units
  for each row execute function public.tg_touch_row();


-- ── amenities ───────────────────────────────────────────────────────────────
-- A catalogue, on the same pattern as `roles` in 0002: organization_id NULL is
-- an amenity ESTIA ships and every customer shares, organization_id set is one
-- a customer invented. Both are the same kind of thing to everything that
-- reads them, which is the point — a second table for custom amenities means
-- every listing query becomes a union.

create table if not exists public.amenities (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations (id) on delete cascade,

  code             text not null,
  name             text not null,
  name_he          text,
  category         public.amenity_category not null default 'general',
  icon             text,
  sort_order       integer not null default 0,

  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  deleted_at       timestamptz,
  deleted_by       uuid references auth.users (id) on delete set null,

  constraint amenities_code_format check (code ~ '^[a-z0-9_]{2,48}$'),
  constraint amenities_name_not_blank check (length(btrim(name)) > 0),
  constraint amenities_version_positive check (version >= 1),
  constraint amenities_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.amenities is
  'The amenity catalogue. organization_id NULL is built in and shared by every tenant; organization_id set is a customer own. Same shape either way, so a listing never has to union two tables.';

-- Two partial uniques rather than one over COALESCE: the built-in catalogue is
-- unique by code globally, a custom amenity only within its organization.
create unique index if not exists amenities_builtin_code_idx
  on public.amenities (code) where organization_id is null;
create unique index if not exists amenities_organization_code_idx
  on public.amenities (organization_id, code) where organization_id is not null;

drop trigger if exists amenities_touch on public.amenities;
create trigger amenities_touch
  before update on public.amenities
  for each row execute function public.tg_touch_row();


create table if not exists public.property_amenities (
  organization_id  uuid not null,
  property_id      uuid not null,
  amenity_id       uuid not null references public.amenities (id) on delete cascade,

  notes            text,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,

  primary key (property_id, amenity_id),
  constraint property_amenities_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade
);

comment on table public.property_amenities is
  'Which amenities a property has. organization_id is denormalised for row level security and proven correct by a composite foreign key to properties.';


create table if not exists public.unit_amenities (
  organization_id  uuid not null,
  property_id      uuid not null,
  unit_id          uuid not null,
  amenity_id       uuid not null references public.amenities (id) on delete cascade,

  quantity         integer not null default 1,
  notes            text,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,

  primary key (unit_id, amenity_id),
  constraint unit_amenities_unit_fkey
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id) on delete cascade,
  constraint unit_amenities_quantity_positive check (quantity >= 1)
);

comment on table public.unit_amenities is
  'Which amenities a unit has, and how many of them. A unit does not inherit its property amenities implicitly — a pool belongs to the property, a jacuzzi belongs to the cabin, and collapsing the two makes a listing lie.';


-- ── Built-in amenity catalogue ──────────────────────────────────────────────
-- Modest on purpose. A short list every customer recognises beats a long list
-- nobody curates; anything missing is one row in their own organization.

insert into public.amenities (code, name, name_he, category, sort_order) values
  ('wifi',             'Wi-Fi',                 'אינטרנט אלחוטי',   'general',       10),
  ('parking',          'Parking',               'חניה',             'general',       20),
  ('air_conditioning', 'Air conditioning',      'מיזוג אוויר',      'general',       30),
  ('heating',          'Heating',               'חימום',            'general',       40),
  ('tv',               'Television',            'טלוויזיה',         'entertainment', 50),
  ('kitchen',          'Kitchen',               'מטבח',             'kitchen',       60),
  ('kitchenette',      'Kitchenette',           'מטבחון',           'kitchen',       70),
  ('coffee_machine',   'Coffee machine',        'מכונת קפה',        'kitchen',       80),
  ('washing_machine',  'Washing machine',       'מכונת כביסה',      'general',       90),
  ('private_bathroom', 'Private bathroom',      'חדר רחצה פרטי',    'bathroom',     100),
  ('jacuzzi',          'Jacuzzi',               'ג׳קוזי',           'wellness',     110),
  ('sauna',            'Sauna',                 'סאונה',            'wellness',     120),
  ('pool',             'Swimming pool',         'בריכה',            'outdoor',      130),
  ('private_pool',     'Private pool',          'בריכה פרטית',      'outdoor',      140),
  ('bbq',              'Barbecue',              'מנגל',             'outdoor',      150),
  ('garden',           'Garden',                'גינה',             'outdoor',      160),
  ('balcony',          'Balcony',               'מרפסת',            'outdoor',      170),
  ('sea_view',         'Sea view',              'נוף לים',          'outdoor',      180),
  ('mountain_view',    'Mountain view',         'נוף להרים',        'outdoor',      190),
  ('workspace',        'Workspace',             'עמדת עבודה',       'services',     200),
  ('breakfast',        'Breakfast',             'ארוחת בוקר',       'services',     210),
  ('crib',             'Crib',                  'מיטת תינוק',       'family',       220),
  ('high_chair',       'High chair',            'כיסא אוכל לתינוק', 'family',       230),
  ('pet_friendly',     'Pets allowed',          'ידידותי לחיות מחמד','general',      240),
  ('wheelchair_access','Wheelchair accessible', 'נגיש לכיסא גלגלים','accessibility', 250),
  ('smoking_allowed',  'Smoking allowed',       'מותר לעשן',        'general',      260)
on conflict (code) where organization_id is null do nothing;


-- ============================================================================
-- Closing the constraints 0001 and 0005 left open
-- ============================================================================

-- ── memberships.default_property_id and memberships.team_id ─────────────────
-- Both composite, so the database now refuses a member whose landing property
-- or team belongs to a different organization than the membership itself —
-- which is the actual bug a plain single-column foreign key would have let
-- through.

do $$ begin
  alter table public.memberships
    add constraint memberships_default_property_fkey
    foreign key (default_property_id, organization_id)
    references public.properties (id, organization_id)
    on delete set null (default_property_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.memberships
    add constraint memberships_team_fkey
    foreign key (team_id, organization_id)
    references public.teams (id, organization_id)
    on delete set null (team_id);
exception when duplicate_object then null;
end $$;

-- ── audit_events.property_id ────────────────────────────────────────────────
-- RESTRICT, not SET NULL, and that is forced rather than chosen: SET NULL is
-- an UPDATE, and 0005 installed a statement-level trigger that raises on any
-- UPDATE of audit_events. A cascade would therefore not silently blank the
-- column — it would abort the delete with a confusing error about
-- append-only-ness. RESTRICT says the real rule out loud: the history of what
-- happened at a property outlives the property, and a property with a trail
-- is closed (status, deleted_at) rather than removed.

do $$ begin
  alter table public.audit_events
    add constraint audit_events_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id)
    on delete restrict;
exception when duplicate_object then null;
end $$;

comment on column public.audit_events.property_id is
  'The property the action touched, when it had one. Composite foreign key to properties (id, organization_id) since 0008, so an event cannot name a property from another tenant. ON DELETE RESTRICT: the trail outlives the property, and SET NULL is impossible here because this table refuses UPDATE.';


-- ── The scope arrays ────────────────────────────────────────────────────────
-- `membership_scopes.property_ids` / `unit_ids` / `team_ids` and the three
-- matching columns on `invitations` are uuid[]. PostgreSQL has no foreign key
-- from an array element, so these are closed with triggers instead — and the
-- triggers do more than a foreign key could, because they also check the
-- tenant. A scope naming a property that exists in somebody else's
-- organization was, until now, a perfectly storable row.
--
-- Both directions are closed:
--   · forward — a scope may not name a row that does not exist in its
--     organization (tg_validate_scope_refs, on insert and update);
--   · backward — a property, unit or team named by a live scope or a live
--     invitation may not be hard-deleted (tg_guard_scope_references).
--
-- Soft deletion is deliberately still allowed. Archiving a property must not
-- require unpicking everybody's scope first; it is the hard DELETE, the one
-- that would leave a dangling id behind, that is refused.

create or replace function public.tg_validate_scope_refs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_json  jsonb  := to_jsonb(new);
  v_org     uuid   := (row_json ->> 'organization_id')::uuid;
  v_props   uuid[];
  v_units   uuid[];
  v_teams   uuid[];
  v_bad     uuid;
begin
  select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_props
    from jsonb_array_elements_text(coalesce(row_json -> tg_argv[0], '[]'::jsonb));
  select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_units
    from jsonb_array_elements_text(coalesce(row_json -> tg_argv[1], '[]'::jsonb));
  select coalesce(array_agg(value::uuid), '{}'::uuid[]) into v_teams
    from jsonb_array_elements_text(coalesce(row_json -> tg_argv[2], '[]'::jsonb));

  select x into v_bad from unnest(v_props) x
   where not exists (
     select 1 from public.properties p
      where p.id = x and p.organization_id = v_org
   ) limit 1;
  if v_bad is not null then
    raise exception
      'scope names property % , which does not exist in organization %', v_bad, v_org
      using errcode = '23503';
  end if;

  select x into v_bad from unnest(v_units) x
   where not exists (
     select 1 from public.units u
      where u.id = x and u.organization_id = v_org
   ) limit 1;
  if v_bad is not null then
    raise exception
      'scope names unit % , which does not exist in organization %', v_bad, v_org
      using errcode = '23503';
  end if;

  select x into v_bad from unnest(v_teams) x
   where not exists (
     select 1 from public.teams t
      where t.id = x and t.organization_id = v_org
   ) limit 1;
  if v_bad is not null then
    raise exception
      'scope names team % , which does not exist in organization %', v_bad, v_org
      using errcode = '23503';
  end if;

  return new;
end;
$$;

comment on function public.tg_validate_scope_refs() is
  'Referential integrity for the uuid[] scope columns, which cannot carry a foreign key. Checks that every id names a row that exists AND belongs to the same organization — the second half is something a foreign key could not have enforced. Takes the three column names as trigger arguments so membership_scopes and invitations share one implementation.';

revoke all on function public.tg_validate_scope_refs() from public, anon, authenticated;

drop trigger if exists membership_scopes_validate_refs on public.membership_scopes;
create trigger membership_scopes_validate_refs
  before insert or update on public.membership_scopes
  for each row execute function public.tg_validate_scope_refs('property_ids', 'unit_ids', 'team_ids');

drop trigger if exists invitations_validate_scope_refs on public.invitations;
create trigger invitations_validate_scope_refs
  before insert or update on public.invitations
  for each row execute function public.tg_validate_scope_refs('scope_property_ids', 'scope_unit_ids', 'scope_team_ids');


create or replace function public.tg_guard_scope_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  execute format(
    'select count(*) from public.membership_scopes where %I @> array[$1]::uuid[]',
    tg_argv[0]
  ) into n using old.id;
  if n > 0 then
    raise exception
      'cannot delete % % : % membership scope(s) still name it', tg_table_name, old.id, n
      using errcode = '23503',
            hint = 'Soft-delete it instead, or narrow the scopes that reference it.';
  end if;

  execute format(
    'select count(*) from public.invitations where %I @> array[$1]::uuid[] '
    '  and accepted_at is null and revoked_at is null',
    tg_argv[1]
  ) into n using old.id;
  if n > 0 then
    raise exception
      'cannot delete % % : % live invitation(s) name it', tg_table_name, old.id, n
      using errcode = '23503',
            hint = 'Soft-delete it instead, or revoke the invitations that reference it.';
  end if;

  return old;
end;
$$;

comment on function public.tg_guard_scope_references() is
  'The reverse half of the scope array integrity: refuses to hard-delete a property, unit or team that a membership scope or a live invitation still names. Soft deletion is still allowed on purpose — archiving a property must not require unpicking everybody scope first.';

revoke all on function public.tg_guard_scope_references() from public, anon, authenticated;

drop trigger if exists properties_guard_scope_refs on public.properties;
create trigger properties_guard_scope_refs
  before delete on public.properties
  for each row execute function public.tg_guard_scope_references('property_ids', 'scope_property_ids');

drop trigger if exists units_guard_scope_refs on public.units;
create trigger units_guard_scope_refs
  before delete on public.units
  for each row execute function public.tg_guard_scope_references('unit_ids', 'scope_unit_ids');

drop trigger if exists teams_guard_scope_refs on public.teams;
create trigger teams_guard_scope_refs
  before delete on public.teams
  for each row execute function public.tg_guard_scope_references('team_ids', 'scope_team_ids');


-- ============================================================================
-- Scope, as a row level security predicate
-- ============================================================================
--
-- Two functions, and the split between them is not cosmetic — it is what keeps
-- the policies from calling themselves.
--
--   property_in_scope() reads memberships, membership_scopes and units. It is
--     used by every policy keyed on a property. It never reads `properties`,
--     so the policy on `properties` can call it safely.
--   unit_in_scope() is handed the property_id and therefore reads only
--     memberships and membership_scopes. It is used by every policy keyed on a
--     unit, so the policy on `units` never reads `units`.
--
-- There is consequently no cycle at all, and both tables can carry FORCE — the
-- owner exemption is removed, unlike the three tables 0004 had to leave
-- unforced. (The functions are owned by `postgres`, whose rolbypassrls is
-- true, so they would have been safe regardless; the shape above means they
-- would still be safe if that ever stopped being true.)
--
-- Both mirror isWithinScope() in src/lib/authz/can.ts, with one deliberate
-- difference that has to be stated rather than discovered. `team` and
-- `own_records` narrow *records* — by resource.teamId, by
-- resource.assignedToUserId — and a property carries neither. The application
-- engine therefore returns false for a property under those scopes; the
-- database returns true. If the database returned false, a housekeeper would
-- be unable to read the name of the property they are standing in, and every
-- screen would have to route around RLS to work at all. The narrowing for
-- those two scopes happens on the task, the booking assignment and the
-- checklist — records that do carry the field — and it is can() that does it.
-- RLS here is the tenant-and-property floor, not the whole engine.

create or replace function public.property_in_scope(
  target_property_id uuid,
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    left join public.membership_scopes s on s.membership_id = m.id
    where m.user_id = (select auth.uid())
      and m.status = 'active'::public.membership_status
      and m.organization_id = property_in_scope.target_organization_id
      and (
        s.id is null
        or s.kind = 'all_organization'::public.membership_scope_kind
        or s.kind = 'team'::public.membership_scope_kind
        or s.kind = 'own_records'::public.membership_scope_kind
        or (
          s.kind = 'properties'::public.membership_scope_kind
          and property_in_scope.target_property_id = any (s.property_ids)
        )
        or (
          s.kind = 'units'::public.membership_scope_kind
          and exists (
            select 1 from public.units u
            where u.id = any (s.unit_ids)
              and u.property_id = property_in_scope.target_property_id
          )
        )
      )
  );
$$;

comment on function public.property_in_scope(uuid, uuid) is
  'Does the caller scope reach this property? Mirrors isWithinScope() in src/lib/authz/can.ts for the properties and units variants. Reads memberships, membership_scopes and units, and deliberately never properties, so the policy on properties can call it without recursing. A member with no scope row is treated as organization-wide, matching the default in 0002.';

create or replace function public.unit_in_scope(
  target_unit_id uuid,
  target_property_id uuid,
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    left join public.membership_scopes s on s.membership_id = m.id
    where m.user_id = (select auth.uid())
      and m.status = 'active'::public.membership_status
      and m.organization_id = unit_in_scope.target_organization_id
      and (
        s.id is null
        or s.kind = 'all_organization'::public.membership_scope_kind
        or s.kind = 'team'::public.membership_scope_kind
        or s.kind = 'own_records'::public.membership_scope_kind
        or (
          s.kind = 'properties'::public.membership_scope_kind
          and unit_in_scope.target_property_id = any (s.property_ids)
        )
        or (
          s.kind = 'units'::public.membership_scope_kind
          and unit_in_scope.target_unit_id = any (s.unit_ids)
        )
      )
  );
$$;

comment on function public.unit_in_scope(uuid, uuid, uuid) is
  'Does the caller scope reach this unit? Takes the property id as an argument rather than looking it up, so it reads neither units nor properties and the policy on units can call it without recursing. Every caller already holds a composite foreign key proving the pair is genuine.';

-- Same reasoning as 0004: `anon` is revoked explicitly because Supabase grants
-- it EXECUTE on every new function in `public` through ALTER DEFAULT
-- PRIVILEGES, and a REVOKE FROM PUBLIC leaves that grant standing.
-- `authenticated` keeps EXECUTE for the reason 0004 spells out — a policy
-- expression runs with the querying role privileges, so a member who cannot
-- execute these cannot read their own property either. Linter 0029 will report
-- both, and both are accepted on the same terms as the three in 0004.
revoke all on function public.property_in_scope(uuid, uuid) from public, anon;
revoke all on function public.unit_in_scope(uuid, uuid, uuid) from public, anon;
grant execute on function public.property_in_scope(uuid, uuid) to authenticated, service_role;
grant execute on function public.unit_in_scope(uuid, uuid, uuid) to authenticated, service_role;


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.teams              enable row level security;
alter table public.teams              force  row level security;
alter table public.properties         enable row level security;
alter table public.properties         force  row level security;
alter table public.unit_groups        enable row level security;
alter table public.unit_groups        force  row level security;
alter table public.units              enable row level security;
alter table public.units              force  row level security;
alter table public.amenities          enable row level security;
alter table public.amenities          force  row level security;
alter table public.property_amenities enable row level security;
alter table public.property_amenities force  row level security;
alter table public.unit_amenities     enable row level security;
alter table public.unit_amenities     force  row level security;

revoke all on public.teams              from anon, authenticated;
revoke all on public.properties         from anon, authenticated;
revoke all on public.unit_groups        from anon, authenticated;
revoke all on public.units              from anon, authenticated;
revoke all on public.amenities          from anon, authenticated;
revoke all on public.property_amenities from anon, authenticated;
revoke all on public.unit_amenities     from anon, authenticated;

grant select, insert, update, delete on public.teams              to authenticated;
grant select, insert, update, delete on public.properties         to authenticated;
grant select, insert, update, delete on public.unit_groups        to authenticated;
grant select, insert, update, delete on public.units              to authenticated;
grant select, insert, update, delete on public.amenities          to authenticated;
grant select, insert, delete         on public.property_amenities to authenticated;
grant select, insert, update, delete on public.unit_amenities     to authenticated;

grant all on public.teams              to service_role;
grant all on public.properties         to service_role;
grant all on public.unit_groups        to service_role;
grant all on public.units              to service_role;
grant all on public.amenities          to service_role;
grant all on public.property_amenities to service_role;
grant all on public.unit_amenities     to service_role;


-- ── Policies · teams ────────────────────────────────────────────────────────
-- Teams are organization-wide furniture: everybody in the organization can see
-- that the housekeeping crew exists, and managing them is team.manage.

drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists teams_insert on public.teams;
create policy teams_insert on public.teams
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'team.manage')
  );

drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'team.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'team.manage')
  );

drop policy if exists teams_delete on public.teams;
create policy teams_delete on public.teams
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'team.manage')
  );


-- ── Policies · properties ───────────────────────────────────────────────────
-- Two conditions on every one of them, and the second is the one that matters
-- for the agent network: the tenant floor, and then the caller scope. An agent
-- scoped to two villas cannot see the third, cannot count it, and cannot learn
-- that it exists — because the row never leaves the database, not because a
-- screen hides it.
--
-- INSERT does not carry the scope check: a member creating a property is
-- creating something no scope can name yet. property.create is the gate.

drop policy if exists properties_select on public.properties;
create policy properties_select on public.properties
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(id, organization_id)
  );

drop policy if exists properties_insert on public.properties;
create policy properties_insert on public.properties
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'property.create')
  );

drop policy if exists properties_update on public.properties;
create policy properties_update on public.properties
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists properties_delete on public.properties;
create policy properties_delete on public.properties
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(id, organization_id)
    and public.has_permission(organization_id, 'property.delete')
  );


-- ── Policies · unit_groups ──────────────────────────────────────────────────

drop policy if exists unit_groups_select on public.unit_groups;
create policy unit_groups_select on public.unit_groups
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
  );

drop policy if exists unit_groups_insert on public.unit_groups;
create policy unit_groups_insert on public.unit_groups
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );

drop policy if exists unit_groups_update on public.unit_groups;
create policy unit_groups_update on public.unit_groups
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );

drop policy if exists unit_groups_delete on public.unit_groups;
create policy unit_groups_delete on public.unit_groups
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );


-- ── Policies · units ────────────────────────────────────────────────────────

drop policy if exists units_select on public.units;
create policy units_select on public.units
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(id, property_id, organization_id)
  );

drop policy if exists units_insert on public.units;
create policy units_insert on public.units
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );

drop policy if exists units_update on public.units;
create policy units_update on public.units
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(id, property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(id, property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );

drop policy if exists units_delete on public.units;
create policy units_delete on public.units
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(id, property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );


-- ── Policies · amenities ────────────────────────────────────────────────────
-- The built-in catalogue behaves exactly like the built-in roles in 0004:
-- readable by anyone signed in, writable by nobody through this API. A custom
-- amenity is ordinary tenant data.

drop policy if exists amenities_select on public.amenities;
create policy amenities_select on public.amenities
  for select to authenticated
  using (
    (organization_id is null and (select auth.uid()) is not null)
    or organization_id in (select public.my_organizations())
  );

drop policy if exists amenities_insert on public.amenities;
create policy amenities_insert on public.amenities
  for insert to authenticated
  with check (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists amenities_update on public.amenities;
create policy amenities_update on public.amenities
  for update to authenticated
  using (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'property.update')
  )
  with check (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists amenities_delete on public.amenities;
create policy amenities_delete on public.amenities
  for delete to authenticated
  using (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'property.update')
  );


-- ── Policies · property_amenities / unit_amenities ──────────────────────────
-- No UPDATE policy on property_amenities: the row is its primary key plus a
-- note, so a change is a delete and an insert.

drop policy if exists property_amenities_select on public.property_amenities;
create policy property_amenities_select on public.property_amenities
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
  );

drop policy if exists property_amenities_insert on public.property_amenities;
create policy property_amenities_insert on public.property_amenities
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists property_amenities_delete on public.property_amenities;
create policy property_amenities_delete on public.property_amenities
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'property.update')
  );

drop policy if exists unit_amenities_select on public.unit_amenities;
create policy unit_amenities_select on public.unit_amenities
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
  );

drop policy if exists unit_amenities_insert on public.unit_amenities;
create policy unit_amenities_insert on public.unit_amenities
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );

drop policy if exists unit_amenities_update on public.unit_amenities;
create policy unit_amenities_update on public.unit_amenities
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );

drop policy if exists unit_amenities_delete on public.unit_amenities;
create policy unit_amenities_delete on public.unit_amenities
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'unit.manage')
  );


-- ============================================================================
-- Indexes
-- ============================================================================
-- Every organization_id, every foreign key a policy walks, and the array
-- columns the delete guard above has to search. The metadata columns
-- (created_by, updated_by, deleted_by) are left unindexed for the reason 0004
-- gives: nothing queries by them, they are all ON DELETE SET NULL, and the
-- only cost is the rare removal of an auth.users row.

create index if not exists teams_organization_idx
  on public.teams (organization_id) where deleted_at is null;
create index if not exists teams_property_idx
  on public.teams (property_id) where property_id is not null;

create index if not exists properties_organization_idx
  on public.properties (organization_id) where deleted_at is null;
create index if not exists properties_organization_status_idx
  on public.properties (organization_id, status) where deleted_at is null;

create index if not exists unit_groups_organization_idx
  on public.unit_groups (organization_id) where deleted_at is null;
create index if not exists unit_groups_property_idx
  on public.unit_groups (property_id) where deleted_at is null;

create index if not exists units_organization_idx
  on public.units (organization_id) where deleted_at is null;
create index if not exists units_property_idx
  on public.units (property_id) where deleted_at is null;
create index if not exists units_property_status_idx
  on public.units (property_id, status) where deleted_at is null;
create index if not exists units_group_idx
  on public.units (unit_group_id) where unit_group_id is not null;

create index if not exists amenities_organization_idx
  on public.amenities (organization_id) where organization_id is not null;

create index if not exists property_amenities_organization_idx
  on public.property_amenities (organization_id);
create index if not exists property_amenities_amenity_idx
  on public.property_amenities (amenity_id);

create index if not exists unit_amenities_organization_idx
  on public.unit_amenities (organization_id);
create index if not exists unit_amenities_amenity_idx
  on public.unit_amenities (amenity_id);
create index if not exists unit_amenities_property_idx
  on public.unit_amenities (property_id);

-- The delete guard asks "does any scope contain this id?", which is a
-- containment search over a uuid[] and therefore GIN. Without these it is a
-- sequential scan of membership_scopes on every property deletion.
-- `invitations` is deliberately left without them: it holds at most one live
-- row per address per organization, so it is small by construction.
create index if not exists membership_scopes_property_ids_idx
  on public.membership_scopes using gin (property_ids);
create index if not exists membership_scopes_unit_ids_idx
  on public.membership_scopes using gin (unit_ids);
create index if not exists membership_scopes_team_ids_idx
  on public.membership_scopes using gin (team_ids);
