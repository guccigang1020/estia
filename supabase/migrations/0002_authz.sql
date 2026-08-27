-- ============================================================================
-- 0002_authz.sql — ESTIA foundation · roles, permissions and scope
--
-- What this does
--   Puts the permission catalogue into the database as data, so that the
--   authorization question is always "does this actor hold this grant?" and
--   never "is this actor a manager?". A custom role built by a customer is
--   then the same kind of object as a role ESTIA ships with — a name attached
--   to a set of grants — and the engine cannot tell them apart.
--
--   Creates: permissions, roles, role_permissions, membership_roles,
--   membership_scopes. Seeds the 98 permissions and 7 field permissions from
--   src/lib/authz/permissions.ts, the 16 system roles and 2 platform roles
--   from src/lib/authz/roles.ts, and their grants.
--
--   organization_owner and administrator are not listed. They are derived in
--   SQL from the permissions table, the same way grantsForSystemRole() derives
--   them in TypeScript, so a permission added next year is covered by the two
--   most senior roles automatically instead of being quietly missing.
--
-- Depends on
--   0001_identity.sql (organizations, memberships, invitations,
--   public.membership_scope_kind, public.tg_touch_row).
--
-- Note
--   Row level security for these tables is installed by 0004_rls.sql.
-- ============================================================================

set search_path = public, extensions;


-- ── Types ───────────────────────────────────────────────────────────────────
-- PERMISSIONS and FIELD_PERMISSIONS live in one table, told apart by `kind`,
-- because the authorization engine treats them identically: both are members
-- of the `Grant` union in TypeScript.

do $$ begin
  create type public.permission_kind as enum (
    'action',
    'field'
  );
exception when duplicate_object then null;
end $$;


-- ── permissions ─────────────────────────────────────────────────────────────
-- The catalogue. Global, not tenant data: the same strings exist for every
-- organization. Adding a capability to ESTIA means adding a row here first.

create table if not exists public.permissions (
  code           text primary key,
  kind           public.permission_kind not null default 'action',
  category       text not null,

  -- Generated, so the rule "platform permissions never belong to a customer
  -- role" cannot drift away from the naming convention it is based on.
  is_platform    boolean not null generated always as (code like 'platform.%') stored,

  -- The OWNER_ONLY set from src/lib/authz/roles.ts. Administrator is defined
  -- as "everything the owner has, minus these".
  is_owner_only  boolean not null default false,

  description    text,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),

  constraint permissions_code_not_blank check (length(btrim(code)) > 0),
  constraint permissions_category_not_blank check (length(btrim(category)) > 0),
  -- Written against `code` rather than the generated `is_platform` column so
  -- the constraint does not depend on generation order. Same rule: a platform
  -- permission is ESTIA's, and owner-only is a statement about a customer.
  constraint permissions_platform_not_owner_only check (
    not (code like 'platform.%' and is_owner_only)
  )
);

comment on table public.permissions is
  'The permission catalogue: every capability in ESTIA, named exactly once. Global rather than per-tenant. Mirrors PERMISSIONS and FIELD_PERMISSIONS in src/lib/authz/permissions.ts and must stay identical to them.';
comment on column public.permissions.kind is
  'action = a PERMISSIONS entry (may I do this?). field = a FIELD_PERMISSIONS entry (may I see this column?).';
comment on column public.permissions.is_platform is
  'True for platform.* — ESTIA staff only. Never grantable to a role inside a customer organization.';

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
select v.code, v.kind::public.permission_kind, v.category, v.is_owner_only,
       (row_number() over ())::integer * 10
from (values
  -- ── Organization ─────────────────────────────────────────────────────────
  ('organization.view',                 'action', 'organization',  false),
  ('organization.settings.edit',        'action', 'organization',  false),
  ('organization.billing.manage',       'action', 'organization',  true),
  ('organization.transfer_ownership',   'action', 'organization',  true),
  ('organization.close',                'action', 'organization',  true),

  -- ── Property & Unit ──────────────────────────────────────────────────────
  ('property.view',                     'action', 'property',      false),
  ('property.create',                   'action', 'property',      false),
  ('property.update',                   'action', 'property',      false),
  ('property.delete',                   'action', 'property',      false),
  ('unit.manage',                       'action', 'property',      false),

  -- ── Booking ──────────────────────────────────────────────────────────────
  ('booking.view',                      'action', 'booking',       false),
  ('booking.create',                    'action', 'booking',       false),
  ('booking.update',                    'action', 'booking',       false),
  ('booking.cancel',                    'action', 'booking',       false),
  ('booking.delete',                    'action', 'booking',       false),
  ('booking.change_status',             'action', 'booking',       false),
  ('booking.override_price',            'action', 'booking',       false),
  ('booking.override_availability',     'action', 'booking',       false),
  ('booking.export',                    'action', 'booking',       false),
  ('booking.assign',                    'action', 'booking',       false),
  ('booking.note.internal',             'action', 'booking',       false),

  -- ── Guest ────────────────────────────────────────────────────────────────
  ('guest.view',                        'action', 'guest',         false),
  ('guest.create',                      'action', 'guest',         false),
  ('guest.update',                      'action', 'guest',         false),
  ('guest.delete',                      'action', 'guest',         false),
  ('guest.export',                      'action', 'guest',         false),

  -- ── Finance ──────────────────────────────────────────────────────────────
  ('finance.view',                      'action', 'finance',       false),
  ('payment.view',                      'action', 'finance',       false),
  ('payment.create',                    'action', 'finance',       false),
  ('payment.capture',                   'action', 'finance',       false),
  ('payment.refund',                    'action', 'finance',       false),
  ('payment.void',                      'action', 'finance',       false),
  ('deposit.hold',                      'action', 'finance',       false),
  ('deposit.release',                   'action', 'finance',       false),
  ('expense.view',                      'action', 'finance',       false),
  ('expense.create',                    'action', 'finance',       false),
  ('expense.approve',                   'action', 'finance',       false),
  ('invoice.view',                      'action', 'finance',       false),
  ('invoice.issue',                     'action', 'finance',       false),
  ('report.financial.view',             'action', 'finance',       false),
  ('report.financial.export',           'action', 'finance',       false),

  -- ── Team & access ────────────────────────────────────────────────────────
  ('user.view',                         'action', 'team',          false),
  ('user.invite',                       'action', 'team',          false),
  ('user.edit',                         'action', 'team',          false),
  ('user.suspend',                      'action', 'team',          false),
  ('user.remove',                       'action', 'team',          false),
  ('role.create',                       'action', 'team',          false),
  ('role.assign',                       'action', 'team',          false),
  ('permission.edit',                   'action', 'team',          true),
  ('team.manage',                       'action', 'team',          false),

  -- ── Operations ───────────────────────────────────────────────────────────
  ('task.view',                         'action', 'operations',    false),
  ('task.create',                       'action', 'operations',    false),
  ('task.assign',                       'action', 'operations',    false),
  ('task.update',                       'action', 'operations',    false),
  ('task.complete',                     'action', 'operations',    false),
  ('task.verify',                       'action', 'operations',    false),
  ('checklist.manage',                  'action', 'operations',    false),
  ('inventory.view',                    'action', 'operations',    false),
  ('inventory.edit',                    'action', 'operations',    false),
  ('incident.view',                     'action', 'operations',    false),
  ('incident.create',                   'action', 'operations',    false),
  ('incident.update',                   'action', 'operations',    false),
  ('incident.resolve',                  'action', 'operations',    false),

  -- ── Communication ────────────────────────────────────────────────────────
  ('message.view',                      'action', 'communication', false),
  ('message.send',                      'action', 'communication', false),
  ('message.assign',                    'action', 'communication', false),
  ('template.manage',                   'action', 'communication', false),

  -- ── Sales & marketing ────────────────────────────────────────────────────
  ('product.view',                      'action', 'sales',         false),
  ('product.manage',                    'action', 'sales',         false),
  ('order.view',                        'action', 'sales',         false),
  ('order.fulfil',                      'action', 'sales',         false),
  ('review.view',                       'action', 'sales',         false),
  ('review.manage',                     'action', 'sales',         false),
  ('site.view',                         'action', 'sales',         false),
  ('site.edit_content',                 'action', 'sales',         false),
  ('site.edit_design',                  'action', 'sales',         false),
  ('site.manage_seo',                   'action', 'sales',         false),
  ('site.manage_domain',                'action', 'sales',         false),
  ('site.publish',                      'action', 'sales',         false),
  ('site.rollback',                     'action', 'sales',         false),
  ('site.ai_generate',                  'action', 'sales',         false),
  ('pricing.manage',                    'action', 'sales',         false),
  ('channel.manage',                    'action', 'sales',         false),

  -- ── Owners ───────────────────────────────────────────────────────────────
  ('owner.view',                        'action', 'owners',        false),
  ('owner.manage',                      'action', 'owners',        false),
  ('owner_statement.view',              'action', 'owners',        false),
  ('owner_statement.issue',             'action', 'owners',        false),

  -- ── Governance ───────────────────────────────────────────────────────────
  ('audit.view',                        'action', 'governance',    false),
  ('approval.request',                  'action', 'governance',    false),
  ('approval.decide',                   'action', 'governance',    false),
  ('automation.view',                   'action', 'governance',    false),
  ('automation.manage',                 'action', 'governance',    false),
  ('integration.manage',                'action', 'governance',    false),

  -- ── Platform (ESTIA staff only, never granted to a customer role) ────────
  ('platform.organization.view',        'action', 'platform',      false),
  ('platform.organization.manage',      'action', 'platform',      false),
  ('platform.plan.manage',              'action', 'platform',      false),
  ('platform.impersonate',              'action', 'platform',      false),
  ('platform.feature_flag.manage',      'action', 'platform',      false),

  -- ── Field-level permissions ──────────────────────────────────────────────
  -- Access to a record is not access to every column of it. A cleaner needs
  -- the booking to know which unit to prepare, and must not receive the
  -- guest's phone number or what they paid.
  ('guest.view_contact',                'field',  'guest',         false),
  ('guest.view_document_id',            'field',  'guest',         false),
  ('booking.view_price',                'field',  'booking',       false),
  ('booking.view_source',               'field',  'booking',       false),
  ('booking.view_deposit',              'field',  'booking',       false),
  ('booking.view_profitability',        'field',  'booking',       false),
  ('owner.view_commission',             'field',  'owners',        false)
) as v(code, kind, category, is_owner_only)
on conflict (code) do update
  set kind          = excluded.kind,
      category      = excluded.category,
      is_owner_only = excluded.is_owner_only,
      sort_order    = excluded.sort_order;

-- Guard rail. If the catalogue above ever stops matching permissions.ts, this
-- migration fails loudly instead of leaving a silent hole in the two derived
-- roles below.
do $$
declare
  action_count integer;
  field_count  integer;
begin
  select count(*) into action_count from public.permissions where kind = 'action';
  select count(*) into field_count  from public.permissions where kind = 'field';
  if action_count <> 98 or field_count <> 7 then
    raise exception
      'permission catalogue drift: expected 98 action and 7 field permissions, found % and %',
      action_count, field_count;
  end if;
end $$;


-- ── roles ───────────────────────────────────────────────────────────────────
-- organization_id NULL means a built-in role shared by every tenant.
-- organization_id set means a custom role belonging to that one customer.

create table if not exists public.roles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations (id) on delete cascade,

  code             text not null,
  name             text not null,
  description      text,

  is_system        boolean not null default false,
  is_platform      boolean not null default false,
  sort_order       integer not null default 0,
  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  deleted_at       timestamptz,
  deleted_by       uuid references auth.users (id) on delete set null,

  constraint roles_code_not_blank check (length(btrim(code)) > 0),
  constraint roles_version_positive check (version >= 1),
  -- A system role is global; a custom role belongs to exactly one customer.
  -- There is no third possibility.
  constraint roles_system_is_global check (
    (is_system and organization_id is null) or (not is_system and organization_id is not null)
  ),
  -- A platform role is a system role, and can never be a customer's role.
  constraint roles_platform_implies_system check (not is_platform or is_system),
  constraint roles_custom_organization_key unique (organization_id, code)
);

comment on table public.roles is
  'A named bundle of permissions. organization_id NULL is a role ESTIA ships with, shared by every tenant; organization_id set is a role a customer composed for themselves. The authorization engine treats both identically.';
comment on column public.roles.is_platform is
  'ESTIA staff role. Flagged so it can never be attached to a membership in a customer organization — see tg_membership_role_assignable().';

-- Built-in role codes are unique across the whole catalogue, not per tenant.
create unique index if not exists roles_system_code_idx
  on public.roles (code)
  where organization_id is null;

drop trigger if exists roles_touch on public.roles;
create trigger roles_touch
  before update on public.roles
  for each row execute function public.tg_touch_row();

-- The forward reference from 0001: an invitation names the role the invitee
-- will receive. Restricted, so deleting a role cannot orphan a live invite.
do $$ begin
  alter table public.invitations
    add constraint invitations_role_id_fkey
    foreign key (role_id) references public.roles (id) on delete restrict;
exception when duplicate_object then null;
end $$;


-- ── role_permissions ────────────────────────────────────────────────────────

create table if not exists public.role_permissions (
  role_id          uuid not null references public.roles (id) on delete cascade,
  -- Restricted on purpose: a permission is never deleted from the catalogue
  -- without deliberately deciding what happens to the roles that hold it.
  permission_code  text not null references public.permissions (code) on delete restrict,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,

  constraint role_permissions_pkey primary key (role_id, permission_code)
);

comment on table public.role_permissions is
  'Which grants a role carries. The single source of an actor grant set, together with membership_roles.';

-- A customer's role may never hold a platform.* permission, whatever the
-- application layer believes.
create or replace function public.tg_role_permission_grantable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  role_organization_id uuid;
  role_is_platform     boolean;
  permission_is_platform boolean;
begin
  select r.organization_id, r.is_platform
    into role_organization_id, role_is_platform
    from public.roles r
   where r.id = new.role_id;

  select p.is_platform
    into permission_is_platform
    from public.permissions p
   where p.code = new.permission_code;

  if permission_is_platform and not coalesce(role_is_platform, false) then
    raise exception
      'permission % is a platform permission and cannot be granted to role %',
      new.permission_code, new.role_id
      using errcode = '42501';
  end if;

  if permission_is_platform and role_organization_id is not null then
    raise exception
      'platform permissions cannot be granted to a role owned by an organization'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists role_permissions_grantable on public.role_permissions;
create trigger role_permissions_grantable
  before insert or update on public.role_permissions
  for each row execute function public.tg_role_permission_grantable();


-- ── membership_roles ────────────────────────────────────────────────────────
-- organization_id is denormalised here so that row level security can filter
-- without a join, and the composite foreign key proves it is the membership's
-- own organization rather than trusting the writer.

create table if not exists public.membership_roles (
  membership_id    uuid not null,
  organization_id  uuid not null,
  role_id          uuid not null references public.roles (id) on delete cascade,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,

  constraint membership_roles_pkey primary key (membership_id, role_id),
  constraint membership_roles_membership_fkey
    foreign key (membership_id, organization_id)
    references public.memberships (id, organization_id) on delete cascade
);

comment on table public.membership_roles is
  'Roles held by a membership. A member may hold several; their grants are the union. organization_id is denormalised for row level security and is proven correct by a composite foreign key to memberships.';

-- Two rules the application must not be trusted to remember:
--   1. A platform role never attaches to a membership in a customer org.
--   2. A custom role only attaches inside the organization that owns it.
create or replace function public.tg_membership_role_assignable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  role_organization_id uuid;
  role_is_platform     boolean;
begin
  select r.organization_id, r.is_platform
    into role_organization_id, role_is_platform
    from public.roles r
   where r.id = new.role_id;

  if role_is_platform then
    raise exception
      'role % is an ESTIA platform role and cannot be assigned inside a customer organization',
      new.role_id
      using errcode = '42501';
  end if;

  if role_organization_id is not null and role_organization_id <> new.organization_id then
    raise exception
      'role % belongs to another organization', new.role_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists membership_roles_assignable on public.membership_roles;
create trigger membership_roles_assignable
  before insert or update on public.membership_roles
  for each row execute function public.tg_membership_role_assignable();


-- ── membership_scopes ───────────────────────────────────────────────────────
-- A role says what someone may do; a scope says where. One row per membership,
-- because Actor.scope in src/lib/authz/can.ts is a single value, not a list.

create table if not exists public.membership_scopes (
  id               uuid primary key default gen_random_uuid(),
  membership_id    uuid not null,
  organization_id  uuid not null,

  kind             public.membership_scope_kind not null default 'all_organization',
  property_ids     uuid[] not null default '{}'::uuid[],
  unit_ids         uuid[] not null default '{}'::uuid[],
  team_ids         uuid[] not null default '{}'::uuid[],

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint membership_scopes_membership_key unique (membership_id),
  constraint membership_scopes_version_positive check (version >= 1),
  constraint membership_scopes_membership_fkey
    foreign key (membership_id, organization_id)
    references public.memberships (id, organization_id) on delete cascade,
  -- Mirrors the Scope union exactly: each variant carries the ids it needs and
  -- nothing else, so an unresolvable combination cannot be stored.
  constraint membership_scopes_shape check (
    case kind
      when 'properties' then
        array_length(property_ids, 1) is not null
        and unit_ids = '{}'::uuid[] and team_ids = '{}'::uuid[]
      when 'units' then
        array_length(unit_ids, 1) is not null
        and property_ids = '{}'::uuid[] and team_ids = '{}'::uuid[]
      when 'team' then
        array_length(team_ids, 1) is not null
        and property_ids = '{}'::uuid[] and unit_ids = '{}'::uuid[]
      else
        property_ids = '{}'::uuid[] and unit_ids = '{}'::uuid[] and team_ids = '{}'::uuid[]
    end
  )
);

comment on table public.membership_scopes is
  'Where a membership permissions apply: the whole organization, named properties, named units, a team, or only records assigned to the person. One row per membership, matching the Scope union in src/lib/authz/can.ts.';

drop trigger if exists membership_scopes_touch on public.membership_scopes;
create trigger membership_scopes_touch
  before update on public.membership_scopes
  for each row execute function public.tg_touch_row();


-- ── Seed · system and platform roles ────────────────────────────────────────
-- The 16 roles of SYSTEM_ROLES and the 2 of PLATFORM_ROLES, in the order they
-- appear in src/lib/authz/roles.ts.

insert into public.roles (organization_id, code, name, description, is_system, is_platform, sort_order)
values
  (null, 'organization_owner',      'בעל העסק',        'שליטה מלאה בארגון, כולל חיוב, הרשאות והעברת בעלות.',            true, false, 10),
  (null, 'administrator',           'מנהל מערכת',      'כל הפעולות בארגון, למעט הפעולות השמורות לבעלים.',                true, false, 20),
  (null, 'general_manager',         'מנהל כללי',       'ניהול תפעולי ומסחרי מלא של העסק.',                               true, false, 30),
  (null, 'property_manager',        'מנהל נכס',        'אותה עוצמה תפעולית כמו מנהל כללי, מוגבלת לנכסים שהוקצו לו.',     true, false, 40),
  (null, 'reservation_manager',     'מנהל הזמנות',     'ניהול הזמנות, זמינות ומחירים מול אורחים.',                       true, false, 50),
  (null, 'reception',               'קבלה',            'קבלת אורחים ותפעול יומיומי, ללא רווחיות וללא ייצוא.',            true, false, 60),
  (null, 'revenue_manager',         'מנהל הכנסות',     'תמחור, ערוצי הפצה ותפוסה.',                                      true, false, 70),
  (null, 'finance_manager',         'מנהל כספים',      'תשלומים, פיקדונות, חשבוניות, הוצאות ודוחות.',                    true, false, 80),
  (null, 'accountant',              'הנהלת חשבונות',   'צפייה וייצוא בלבד. אינו משנה רשומה תפעולית.',                    true, false, 90),
  (null, 'operations_manager',      'מנהל תפעול',      'משימות, ניקיון, תחזוקה, תקלות ומלאי.',                           true, false, 100),
  (null, 'housekeeping_supervisor', 'אחראי משק בית',   'הקצאה ובקרה של עבודות ניקיון והכנת יחידות.',                     true, false, 110),
  (null, 'cleaner',                 'מנקה',            'משימות בלבד. אינו רואה פרטי אורח, מחיר או כסף.',                 true, false, 120),
  (null, 'maintenance',             'אחזקה',           'תקלות, משימות תחזוקה ומלאי.',                                    true, false, 130),
  (null, 'property_owner',          'בעל נכס',         'בעל נכס חיצוני. רואה את הנכס שלו בלבד.',                         true, false, 140),
  (null, 'external_vendor',         'ספק חיצוני',      'קבלן המחזיק במשימה בודדת. אינו חלק מהעסק.',                      true, false, 150),
  (null, 'marketing_editor',        'עורך שיווק',      'כותב ומעצב תוכן לאתר. הפרסום עצמו נשאר בידי מנהל.',              true, false, 160),
  (null, 'platform_super_admin',    'מנהל-על ESTIA',   'צוות ESTIA. גישה לניהול הפלטפורמה.',                             true, true,  900),
  (null, 'platform_support',        'תמיכת ESTIA',     'צוות ESTIA. צפייה לצורכי תמיכה.',                                true, true,  910)
on conflict (code) where organization_id is null do update
  set name        = excluded.name,
      description = excluded.description,
      is_system   = excluded.is_system,
      is_platform = excluded.is_platform,
      sort_order  = excluded.sort_order;


-- ── Seed · derived roles ────────────────────────────────────────────────────
-- organization_owner and administrator are computed from the catalogue rather
-- than listed, exactly as grantsForSystemRole() does:
--
--   ALL_ORGANIZATION_GRANTS = every permission that is not platform.*
--                             (action and field alike)
--   organization_owner      = ALL_ORGANIZATION_GRANTS
--   administrator           = ALL_ORGANIZATION_GRANTS minus OWNER_ONLY
--
-- Written as a query so that adding a permission tomorrow reaches both roles
-- without anyone remembering to edit a list.

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join public.permissions p
where r.code = 'organization_owner'
  and r.organization_id is null
  and not p.is_platform
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join public.permissions p
where r.code = 'administrator'
  and r.organization_id is null
  and not p.is_platform
  and not p.is_owner_only
on conflict do nothing;


-- ── Seed · composed roles ───────────────────────────────────────────────────
-- Transcribed from COMPOSED_ROLE_GRANTS in src/lib/authz/roles.ts, keeping the
-- same reusable bundles so the two files can be compared line by line.

with booking_read(code) as (
  values ('booking.view'), ('guest.view'), ('property.view')
),
booking_desk(code) as (
  select code from booking_read
  union values
    ('booking.create'),
    ('booking.update'),
    ('booking.cancel'),
    ('booking.change_status'),
    ('booking.assign'),
    ('booking.note.internal'),
    ('guest.create'),
    ('guest.update'),
    ('guest.view_contact'),
    ('booking.view_price'),
    ('message.view'),
    ('message.send')
),
operations_core(code) as (
  values
    ('task.view'),
    ('task.create'),
    ('task.assign'),
    ('task.update'),
    ('task.complete'),
    ('task.verify'),
    ('checklist.manage'),
    ('incident.view'),
    ('incident.create'),
    ('incident.update'),
    ('incident.resolve'),
    ('inventory.view'),
    ('inventory.edit')
),
finance_core(code) as (
  values
    ('finance.view'),
    ('payment.view'),
    ('payment.create'),
    ('payment.capture'),
    ('payment.refund'),
    ('payment.void'),
    ('deposit.hold'),
    ('deposit.release'),
    ('expense.view'),
    ('expense.create'),
    ('expense.approve'),
    ('invoice.view'),
    ('invoice.issue'),
    ('report.financial.view'),
    ('report.financial.export'),
    ('booking.view_price'),
    ('booking.view_deposit'),
    ('booking.view_profitability')
),
marketing_core(code) as (
  values
    ('site.view'),
    ('site.edit_content'),
    ('site.edit_design'),
    ('site.manage_seo'),
    ('site.ai_generate'),
    ('review.view'),
    ('review.manage'),
    ('product.view'),
    ('property.view')
),
grant_set(role_code, code) as (
  -- general_manager
  select 'general_manager', code from booking_desk
  union select 'general_manager', code from operations_core
  union values
    ('general_manager', 'booking.override_price'),
    ('general_manager', 'booking.override_availability'),
    ('general_manager', 'booking.export'),
    ('general_manager', 'booking.view_source'),
    ('general_manager', 'guest.export'),
    ('general_manager', 'property.create'),
    ('general_manager', 'property.update'),
    ('general_manager', 'unit.manage'),
    ('general_manager', 'pricing.manage'),
    ('general_manager', 'product.view'),
    ('general_manager', 'product.manage'),
    ('general_manager', 'order.view'),
    ('general_manager', 'order.fulfil'),
    ('general_manager', 'review.view'),
    ('general_manager', 'review.manage'),
    ('general_manager', 'user.view'),
    ('general_manager', 'user.invite'),
    ('general_manager', 'team.manage'),
    ('general_manager', 'message.assign'),
    ('general_manager', 'template.manage'),
    ('general_manager', 'automation.view'),
    ('general_manager', 'expense.view'),
    ('general_manager', 'expense.create'),
    ('general_manager', 'approval.request')

  -- property_manager — the same operational reach, confined by scope
  union select 'property_manager', code from booking_desk
  union select 'property_manager', code from operations_core
  union values
    ('property_manager', 'booking.export'),
    ('property_manager', 'booking.view_source'),
    ('property_manager', 'unit.manage'),
    ('property_manager', 'property.update'),
    ('property_manager', 'product.view'),
    ('property_manager', 'order.view'),
    ('property_manager', 'order.fulfil'),
    ('property_manager', 'review.view'),
    ('property_manager', 'user.view'),
    ('property_manager', 'message.assign'),
    ('property_manager', 'expense.view'),
    ('property_manager', 'expense.create'),
    ('property_manager', 'approval.request')

  -- reservation_manager
  union select 'reservation_manager', code from booking_desk
  union values
    ('reservation_manager', 'booking.override_price'),
    ('reservation_manager', 'booking.override_availability'),
    ('reservation_manager', 'booking.export'),
    ('reservation_manager', 'booking.view_source'),
    ('reservation_manager', 'booking.view_deposit'),
    ('reservation_manager', 'payment.view'),
    ('reservation_manager', 'payment.create'),
    ('reservation_manager', 'invoice.view'),
    ('reservation_manager', 'template.manage'),
    ('reservation_manager', 'approval.request')

  -- reception — deliberately without profitability or export
  union select 'reception', code from booking_read
  union values
    ('reception', 'booking.update'),
    ('reception', 'booking.change_status'),
    ('reception', 'booking.note.internal'),
    ('reception', 'guest.create'),
    ('reception', 'guest.update'),
    ('reception', 'guest.view_contact'),
    ('reception', 'booking.view_price'),
    ('reception', 'booking.view_deposit'),
    ('reception', 'message.view'),
    ('reception', 'message.send'),
    ('reception', 'task.view'),
    ('reception', 'task.create'),
    ('reception', 'incident.create'),
    ('reception', 'payment.view'),
    ('reception', 'payment.create'),
    ('reception', 'order.view'),
    ('reception', 'order.fulfil')

  -- revenue_manager
  union select 'revenue_manager', code from booking_read
  union values
    ('revenue_manager', 'booking.view_price'),
    ('revenue_manager', 'booking.view_source'),
    ('revenue_manager', 'pricing.manage'),
    ('revenue_manager', 'booking.override_price'),
    ('revenue_manager', 'channel.manage'),
    ('revenue_manager', 'report.financial.view'),
    ('revenue_manager', 'unit.manage')

  -- finance_manager
  union select 'finance_manager', code from booking_read
  union select 'finance_manager', code from finance_core
  union values
    ('finance_manager', 'guest.view_contact'),
    ('finance_manager', 'owner.view'),
    ('finance_manager', 'owner_statement.view'),
    ('finance_manager', 'owner_statement.issue'),
    ('finance_manager', 'owner.view_commission'),
    ('finance_manager', 'approval.decide'),
    ('finance_manager', 'booking.export')

  -- accountant — read and export, never alters an operational record
  union values
    ('accountant', 'finance.view'),
    ('accountant', 'payment.view'),
    ('accountant', 'expense.view'),
    ('accountant', 'invoice.view'),
    ('accountant', 'report.financial.view'),
    ('accountant', 'report.financial.export'),
    ('accountant', 'booking.view'),
    ('accountant', 'booking.view_price'),
    ('accountant', 'property.view'),
    ('accountant', 'owner_statement.view')

  -- operations_manager
  union select 'operations_manager', code from operations_core
  union select 'operations_manager', code from booking_read
  union values
    ('operations_manager', 'task.assign'),
    ('operations_manager', 'user.view'),
    ('operations_manager', 'team.manage'),
    ('operations_manager', 'expense.view'),
    ('operations_manager', 'expense.create'),
    ('operations_manager', 'approval.request')

  -- housekeeping_supervisor
  union values
    ('housekeeping_supervisor', 'task.view'),
    ('housekeeping_supervisor', 'task.create'),
    ('housekeeping_supervisor', 'task.assign'),
    ('housekeeping_supervisor', 'task.update'),
    ('housekeeping_supervisor', 'task.complete'),
    ('housekeeping_supervisor', 'task.verify'),
    ('housekeeping_supervisor', 'checklist.manage'),
    ('housekeeping_supervisor', 'incident.view'),
    ('housekeeping_supervisor', 'incident.create'),
    ('housekeeping_supervisor', 'incident.update'),
    ('housekeeping_supervisor', 'inventory.view'),
    ('housekeeping_supervisor', 'inventory.edit'),
    ('housekeeping_supervisor', 'user.view'),
    ('housekeeping_supervisor', 'property.view'),
    ('housekeeping_supervisor', 'booking.view')

  -- cleaner — the sharpest test of the privacy model: which unit and when,
  -- never a phone number and never a price
  union values
    ('cleaner', 'task.view'),
    ('cleaner', 'task.update'),
    ('cleaner', 'task.complete'),
    ('cleaner', 'incident.create')

  -- maintenance
  union values
    ('maintenance', 'task.view'),
    ('maintenance', 'task.update'),
    ('maintenance', 'task.complete'),
    ('maintenance', 'incident.view'),
    ('maintenance', 'incident.create'),
    ('maintenance', 'incident.update'),
    ('maintenance', 'inventory.view')

  -- property_owner — sees their asset, nothing else
  union values
    ('property_owner', 'property.view'),
    ('property_owner', 'booking.view'),
    ('property_owner', 'owner_statement.view'),
    ('property_owner', 'report.financial.view')

  -- external_vendor — a contractor holding a single job
  union values
    ('external_vendor', 'task.view'),
    ('external_vendor', 'task.update'),
    ('external_vendor', 'task.complete')

  -- marketing_editor
  union select 'marketing_editor', code from marketing_core
)
insert into public.role_permissions (role_id, permission_code)
select r.id, g.code
from grant_set g
join public.roles r
  on r.code = g.role_code
 and r.organization_id is null
on conflict do nothing;


-- ── Seed · platform role grants ─────────────────────────────────────────────
-- These roles exist so ESTIA staff access is modelled rather than improvised.
-- They are unassignable inside a customer organization by trigger, so the
-- grants here can only ever be used by a future platform staff table.

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join public.permissions p
where r.code = 'platform_super_admin'
  and r.organization_id is null
  and p.is_platform
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r
cross join public.permissions p
where r.code = 'platform_support'
  and r.organization_id is null
  and p.code = 'platform.organization.view'
on conflict do nothing;


-- Every composed role must have received at least one grant. A role seeded
-- with nothing means a code was mistyped above.
do $$
declare
  empty_role text;
begin
  select string_agg(r.code, ', ')
    into empty_role
    from public.roles r
   where r.organization_id is null
     and not exists (select 1 from public.role_permissions rp where rp.role_id = r.id);
  if empty_role is not null then
    raise exception 'system roles seeded with no permissions: %', empty_role;
  end if;
end $$;
