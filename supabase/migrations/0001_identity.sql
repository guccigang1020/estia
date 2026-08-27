-- ============================================================================
-- 0001_identity.sql — ESTIA foundation · identity and tenancy
--
-- What this does
--   Creates the identity spine of the product:
--       User -> Membership -> Organization
--   There is deliberately no `organization_id` on a user. The same person can
--   be a manager in one organization, a property owner in a second and an
--   accountant in a third, with one login, one password and one MFA enrolment.
--   Every tenant-scoped fact hangs off `memberships`, never off the user.
--
--   Also declares the shared enum types used by later migrations, the row
--   metadata trigger that makes optimistic locking possible, and the
--   invitation record (single-use, expiring, hashed token).
--
-- Depends on
--   An empty Supabase database: schema `auth` with `auth.users`, and the
--   roles `anon`, `authenticated`, `service_role`.
--
-- Followed by
--   0002_authz.sql, 0003_plans.sql, 0004_rls.sql, 0005_audit.sql.
--   Row level security for the tables created here is installed by 0004.
--   Until 0004 runs the database is not safe to expose.
-- ============================================================================

set search_path = public, extensions;

-- ── Extensions ──────────────────────────────────────────────────────────────
-- citext is used for every value that is logically case-insensitive: email
-- addresses and slugs. Comparing them with lower() at every call site is the
-- kind of rule that holds for two years and then does not.

create schema if not exists extensions;
create extension if not exists citext with schema extensions;


-- ── Shared enum types ───────────────────────────────────────────────────────
-- Declared here, in the first migration, because more than one later file
-- needs them. `membership_scope_kind` in particular is used both by
-- `invitations` below (an invitation carries the scope the member will get)
-- and by `membership_scopes` in 0002.

do $$ begin
  create type public.organization_status as enum (
    'onboarding',
    'active',
    'suspended',
    'closed'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.organization_business_type as enum (
    'zimmer',
    'villa',
    'apartment',
    'boutique_hotel',
    'hostel',
    'complex',
    'management_company',
    'other'
  );
exception when duplicate_object then null;
end $$;

-- Matches MembershipStatus in src/lib/authz/can.ts exactly, in the same order.
do $$ begin
  create type public.membership_status as enum (
    'invited',
    'pending',
    'active',
    'suspended',
    'removed'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.employment_type as enum (
    'employee',
    'contractor',
    'freelancer',
    'agency',
    'owner',
    'other'
  );
exception when duplicate_object then null;
end $$;

-- Matches the Scope union in src/lib/authz/can.ts: one variant per member.
do $$ begin
  create type public.membership_scope_kind as enum (
    'all_organization',
    'properties',
    'units',
    'team',
    'own_records'
  );
exception when duplicate_object then null;
end $$;


-- ── Row metadata trigger ────────────────────────────────────────────────────
-- Bumps `version` and stamps `updated_at` on every update. This is what makes
-- optimistic locking possible: a writer sends the version it read, and a write
-- against a stale version affects zero rows instead of silently overwriting
-- somebody else's change. Adding this later means auditing every write path in
-- the system, so it exists from the first table.

create or replace function public.tg_touch_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

comment on function public.tg_touch_row() is
  'BEFORE UPDATE trigger: stamps updated_at and increments version. The version column is owned by the database, not by callers.';


-- ── organizations ───────────────────────────────────────────────────────────
-- The paying customer. Every business record in ESTIA belongs to exactly one
-- of these, and row level security is written in terms of it.

create table if not exists public.organizations (
  id                     uuid primary key default gen_random_uuid(),

  slug                   citext not null,
  name                   text   not null,
  legal_name             text,
  business_type          public.organization_business_type not null default 'other',

  country                text not null default 'IL',
  timezone               text not null default 'Asia/Jerusalem',
  currency               text not null default 'ILS',
  locale                 text not null default 'he-IL',

  -- Brand. Present from day one because a hierarchy or a look-and-feel added
  -- on top of live data is expensive; a column nobody fills in is free.
  logo_url               text,
  logo_dark_url          text,
  brand_primary_color    text,
  brand_secondary_color  text,

  status                 public.organization_status not null default 'onboarding',
  metadata               jsonb not null default '{}'::jsonb,

  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users (id) on delete set null,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users (id) on delete set null,
  version                integer not null default 1,
  deleted_at             timestamptz,
  deleted_by             uuid references auth.users (id) on delete set null,

  constraint organizations_slug_key unique (slug),
  constraint organizations_slug_format check (
    (slug::text) ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' and length(slug::text) between 2 and 63
  ),
  constraint organizations_name_not_blank check (length(btrim(name)) > 0),
  constraint organizations_country_format check (country ~ '^[A-Z]{2}$'),
  constraint organizations_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint organizations_timezone_not_blank check (length(btrim(timezone)) > 0),
  constraint organizations_locale_not_blank check (length(btrim(locale)) > 0),
  constraint organizations_primary_color_format check (
    brand_primary_color is null or brand_primary_color ~ '^#[0-9A-Fa-f]{6}$'
  ),
  constraint organizations_secondary_color_format check (
    brand_secondary_color is null or brand_secondary_color ~ '^#[0-9A-Fa-f]{6}$'
  ),
  constraint organizations_version_positive check (version >= 1),
  constraint organizations_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.organizations is
  'A customer of ESTIA — the tenant boundary. Every business record carries an organization_id pointing here, and every row level security policy is written in terms of it.';
comment on column public.organizations.slug is
  'Case-insensitive public identifier used in URLs. Immutable in practice; changing it breaks links.';
comment on column public.organizations.status is
  'Lifecycle of the account. A closed organization keeps all of its data; closure is not deletion.';

drop trigger if exists organizations_touch on public.organizations;
create trigger organizations_touch
  before update on public.organizations
  for each row execute function public.tg_touch_row();


-- ── user_profiles ───────────────────────────────────────────────────────────
-- The person, once, across every organization they belong to. This table has
-- no organization_id on purpose: a profile belongs to a human being, not to a
-- tenant. Everything tenant-specific about that human lives on `memberships`.

create table if not exists public.user_profiles (
  id                uuid primary key references auth.users (id) on delete cascade,

  full_name         text,
  phone             text,
  locale            text not null default 'he-IL',
  timezone          text not null default 'Asia/Jerusalem',
  avatar_url        text,

  -- Set when the account is required to carry a second factor. Null means the
  -- requirement has not been imposed, not that MFA is absent.
  mfa_enforced_at   timestamptz,

  metadata          jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,

  constraint user_profiles_version_positive check (version >= 1),
  constraint user_profiles_phone_format check (
    phone is null or phone ~ '^\+?[0-9 ()-]{6,32}$'
  )
);

comment on table public.user_profiles is
  'Profile data for an authenticated person, keyed one-to-one to auth.users. Deliberately has no organization_id: a person is not owned by a tenant. Their relationship to each organization lives in memberships.';
comment on column public.user_profiles.mfa_enforced_at is
  'When multi-factor authentication became mandatory for this account.';

drop trigger if exists user_profiles_touch on public.user_profiles;
create trigger user_profiles_touch
  before update on public.user_profiles
  for each row execute function public.tg_touch_row();


-- ── memberships ─────────────────────────────────────────────────────────────
-- The join that replaces user.organization_id, and the anchor of the whole
-- authorization model. Roles (0002) and scopes (0002) attach here, not to the
-- user.

create table if not exists public.memberships (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users (id) on delete cascade,
  organization_id           uuid not null references public.organizations (id) on delete cascade,

  status                    public.membership_status not null default 'invited',
  joined_at                 timestamptz,
  invited_by                uuid references auth.users (id) on delete set null,
  last_active_at            timestamptz,

  -- The property this member lands on when they sign in. No foreign key yet:
  -- `properties` arrives in a later migration, which will add the constraint.
  default_property_id       uuid,
  -- Likewise `teams`. Carried from the first migration because adding a column
  -- to a live memberships table means revisiting every authorization path.
  team_id                   uuid,

  employment_type           public.employment_type,
  language                  text not null default 'he',
  notification_preferences  jsonb not null default '{}'::jsonb,
  metadata                  jsonb not null default '{}'::jsonb,

  created_at                timestamptz not null default now(),
  created_by                uuid references auth.users (id) on delete set null,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references auth.users (id) on delete set null,
  version                   integer not null default 1,

  constraint memberships_user_organization_key unique (user_id, organization_id),
  -- Lets child tables carry a denormalised organization_id and prove, with a
  -- composite foreign key, that it is the membership's own organization.
  constraint memberships_id_organization_key unique (id, organization_id),
  constraint memberships_version_positive check (version >= 1),
  constraint memberships_joined_when_active check (
    status <> 'active' or joined_at is not null
  ),
  constraint memberships_language_not_blank check (length(btrim(language)) > 0)
);

comment on table public.memberships is
  'The relationship between a person and an organization: status, scope anchor and per-organization preferences. Replaces user.organization_id. A user may hold many memberships.';
comment on column public.memberships.status is
  'invited | pending | active | suspended | removed. Removing a member sets status to removed — it never deletes the row, because their work must stay attributed to them. This table therefore has no soft-delete columns: status is the single removal mechanism.';
comment on column public.memberships.default_property_id is
  'Landing property for this member. Foreign key deferred until the properties table exists.';
comment on column public.memberships.team_id is
  'Team this member belongs to. Foreign key deferred until the teams table exists.';

drop trigger if exists memberships_touch on public.memberships;
create trigger memberships_touch
  before update on public.memberships
  for each row execute function public.tg_touch_row();


-- ── invitations ─────────────────────────────────────────────────────────────
-- Single-use and expiring. The raw token is generated by the application,
-- shown once in the invitation link and never stored; only its hash lands
-- here, so a leaked database backup does not hand out organization access.
--
-- `role_id` has no foreign key in this file because `roles` is created by
-- 0002. That migration adds the constraint — see invitations_role_id_fkey.

create table if not exists public.invitations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,

  email                citext not null,
  role_id              uuid not null,

  scope_kind           public.membership_scope_kind not null default 'all_organization',
  scope_property_ids   uuid[] not null default '{}'::uuid[],
  scope_unit_ids       uuid[] not null default '{}'::uuid[],
  scope_team_ids       uuid[] not null default '{}'::uuid[],

  -- Hash only. Never the token itself.
  token_hash           text not null,
  expires_at           timestamptz not null,

  accepted_at          timestamptz,
  accepted_by          uuid references auth.users (id) on delete set null,
  revoked_at           timestamptz,
  revoked_by           uuid references auth.users (id) on delete set null,
  invited_by           uuid references auth.users (id) on delete set null,
  message              text,

  metadata             jsonb not null default '{}'::jsonb,

  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,

  constraint invitations_token_hash_key unique (token_hash),
  constraint invitations_version_positive check (version >= 1),
  constraint invitations_email_format check ((email::text) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint invitations_expires_after_creation check (expires_at > created_at),
  -- Single use: an invitation is consumed once, and cannot be both used and
  -- withdrawn.
  constraint invitations_single_outcome check (accepted_at is null or revoked_at is null),
  constraint invitations_accepted_pair check (
    (accepted_at is null and accepted_by is null) or accepted_at is not null
  ),
  -- Mirrors the Scope union: each variant carries exactly the ids it needs and
  -- no others.
  constraint invitations_scope_shape check (
    case scope_kind
      when 'properties' then
        array_length(scope_property_ids, 1) is not null
        and scope_unit_ids = '{}'::uuid[] and scope_team_ids = '{}'::uuid[]
      when 'units' then
        array_length(scope_unit_ids, 1) is not null
        and scope_property_ids = '{}'::uuid[] and scope_team_ids = '{}'::uuid[]
      when 'team' then
        array_length(scope_team_ids, 1) is not null
        and scope_property_ids = '{}'::uuid[] and scope_unit_ids = '{}'::uuid[]
      else
        scope_property_ids = '{}'::uuid[]
        and scope_unit_ids = '{}'::uuid[]
        and scope_team_ids = '{}'::uuid[]
    end
  )
);

comment on table public.invitations is
  'A pending offer of membership in an organization. Single-use and expiring. Stores only a hash of the invitation token, so the database never holds a credential that could be replayed.';
comment on column public.invitations.token_hash is
  'Hash of the invitation token. The raw token exists only in the link sent to the invitee.';
comment on column public.invitations.role_id is
  'The role the invitee receives on acceptance. Foreign key to public.roles is added by 0002_authz.sql.';

-- At most one live invitation per address per organization. Accepted and
-- revoked rows stay for the history and are excluded from the constraint.
create unique index if not exists invitations_one_live_per_email_idx
  on public.invitations (organization_id, email)
  where accepted_at is null and revoked_at is null;

drop trigger if exists invitations_touch on public.invitations;
create trigger invitations_touch
  before update on public.invitations
  for each row execute function public.tg_touch_row();
