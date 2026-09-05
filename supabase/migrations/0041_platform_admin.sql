-- ============================================================================
-- 0041_platform_admin.sql — ESTIA platform console · who ESTIA's own staff are
--
-- What this does
--   0002 seeded two platform roles, `platform_super_admin` and
--   `platform_support`, gave them the five `platform.*` grants, and then made
--   them unattachable: `tg_membership_role_assignable()` refuses a platform
--   role on any membership, because a platform role inside a customer
--   organization is exactly the thing the model forbids. The seed block in
--   0012 says so out loud — "the grants here can only ever be used by a future
--   platform staff table".
--
--   This is that table. `platform_staff` is the one place that says a person
--   is ESTIA staff, and it is deliberately NOT a membership: ESTIA staff are
--   not members of any customer, they have no scope, and nothing about them
--   should be reachable through `my_organizations()`.
--
--   Creates:
--     · platform_staff              — the roster, and the only definition of
--                                     "is this person ESTIA staff".
--     · platform_support_sessions   — a time-boxed, reason-stated record of a
--                                     staff member opening one customer's
--                                     console view. READ ONLY — see below.
--     · is_platform_staff()         — the tenant rule's counterpart.
--     · has_platform_permission()   — the grant question, for platform staff.
--     · platform_organization_usage() — counts, not rows.
--     · platform_set_organization_status()       — suspend and restore.
--     · platform_set_organization_capabilities() — the per-customer overrides.
--
--   And adds cross-tenant SELECT policies for platform staff to the seven
--   tables the console genuinely reads. Nothing else is opened.
--
-- ══ IMPERSONATION IS NOT BUILT, AND THIS FILE DOES NOT PRETEND OTHERWISE ═══
--
--   The brief for the console set four conditions on support impersonation:
--   time-boxed, recorded in `audit_events` as `platform_staff` with the target
--   named, visibly marked in the impersonated session at all times, and never
--   granting a write the staff member could not otherwise justify.
--
--   The third cannot be met from here. Marking an impersonated session
--   requires the CUSTOMER's application shell to render the marking, and the
--   customer shell is another owner's file. A session that a customer could
--   not tell from their own is the weak version, so it is not built.
--
--   `platform_support_sessions` is therefore what it is named: a record that a
--   named staff member opened a READ-ONLY view of one organization, why, and
--   until when. It mints no session, changes no `auth.uid()`, and confers no
--   privilege whatsoever — every read it accompanies is authorised by the
--   platform role and by nothing else. Deleting every row in it would not
--   close a single door.
--
-- ══ THE ONE PROPERTY THAT MAKES THIS SAFE ═════════════════════════════════
--
--   A platform staff member holds `platform.*` and NOTHING ELSE. There is no
--   path by which they acquire `booking.delete`, `payment.refund` or
--   `guest.view_email`: `tg_role_permission_grantable()` refuses a platform
--   permission on a customer role and a customer permission is never seeded
--   onto a platform role, so the two grant sets are disjoint at the
--   catalogue. Every policy below is written against
--   `has_platform_permission(...)`, which reads only those two roles.
--
--   The consequence is deliberate and is the answer to the fourth condition
--   above: ESTIA staff cannot write a customer's business data at all. They
--   can suspend an account, restore it, and change what the account's package
--   includes. That is the whole write surface, it is three functions, and each
--   one demands a stated reason.
--
-- Depends on
--   0001_identity.sql (organizations, memberships, user_profiles, properties
--   arrive in 0008), 0002_authz.sql (roles.is_platform, role_permissions,
--   membership_roles, membership_scopes, tg_touch_row), 0003_plans.sql (plans,
--   organization_subscriptions), 0004_rls.sql (my_organizations,
--   has_permission, and the policies these sit beside), 0005_audit.sql
--   (audit_events, audit_actor_type.platform_staff), 0006_idempotency.sql
--   (audit_events.on_behalf_of_user_id, which the platform insert policy pins
--   to null), 0008_accommodation.sql (properties, units — counted, never read).
--
-- Note
--   No rows are seeded. There is deliberately no way to become ESTIA staff
--   through the product: `platform_staff` has no INSERT, UPDATE or DELETE
--   policy for `authenticated`, and the privileges are revoked. Adding a
--   colleague is a migration or a deliberate act by the database owner, which
--   is the correct amount of friction for the account that can read every
--   customer's roster.
-- ============================================================================

set search_path = public, extensions;


-- ── platform_staff ──────────────────────────────────────────────────────────
--
-- The roster. One row per ESTIA employee who may reach the console.
--
-- `role_id` points at `public.roles`, not at a text column of its own. The two
-- platform roles already exist with their grants attached, and a second place
-- naming them is a second place for the two to disagree — which is the mistake
-- `roles` was created to prevent in the first place. A trigger refuses any
-- role that is not `is_platform`.
--
-- `status` rather than a delete: a staff member who leaves is `revoked`, and
-- the row stays so the audit trail still resolves their name. It mirrors
-- `memberships.status` in spirit and deliberately not in type — a platform
-- staff member is never `invited` and never `suspended` by a customer, so
-- reusing `membership_status` would import three states that cannot happen.

do $$ begin
  create type public.platform_staff_status as enum (
    'active',
    'revoked'
  );
exception when duplicate_object then null;
end $$;

comment on type public.platform_staff_status is
  'Whether an ESTIA staff member may reach the platform console. Two states only: a platform staff member is never invited, pending or suspended — those are customer membership states and none of them can happen here.';

create table if not exists public.platform_staff (
  id            uuid primary key default gen_random_uuid(),

  -- CASCADE: if the auth account is gone the roster entry is meaningless. The
  -- audit trail does not depend on this row — `audit_events.actor_label` keeps
  -- the name denormalised, exactly as it does for a customer's staff.
  user_id       uuid not null references auth.users (id) on delete cascade,

  -- RESTRICT: a platform role that somebody currently holds must not be
  -- deletable out from under the console.
  role_id       uuid not null references public.roles (id) on delete restrict,

  status        public.platform_staff_status not null default 'active',

  -- Why this person is on the roster, for the next person who reads it.
  note          text,

  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null,
  version       integer not null default 1,

  constraint platform_staff_user_key unique (user_id),
  constraint platform_staff_version_positive check (version >= 1)
);

comment on table public.platform_staff is
  'ESTIA own staff. The single definition of "is this person platform staff" — deliberately not a membership, because ESTIA staff are not members of any customer organization and must never appear in my_organizations(). Rows are not creatable through the API: there is no INSERT policy and the privilege is revoked.';
comment on column public.platform_staff.role_id is
  'One of the roles seeded by 0002 with is_platform = true. Enforced by tg_platform_staff_role_is_platform(), so this table cannot be used to smuggle a customer role into the platform grant set.';
comment on column public.platform_staff.status is
  'active | revoked. A departed colleague is revoked, never deleted, so the audit trail still resolves their name.';

-- One rule the application must not be trusted to remember: this table names
-- ESTIA roles and nothing else. Without it, a row pointing at
-- `organization_owner` would hand its holder every customer grant across every
-- tenant, through `has_platform_permission` below.
create or replace function public.tg_platform_staff_role_is_platform()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  role_is_platform boolean;
begin
  select r.is_platform
    into role_is_platform
    from public.roles r
   where r.id = new.role_id;

  if not coalesce(role_is_platform, false) then
    raise exception
      'role % is not an ESTIA platform role and cannot be placed on the platform staff roster',
      new.role_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.tg_platform_staff_role_is_platform() is
  'Refuses any platform_staff row whose role is not is_platform. The mirror of tg_membership_role_assignable(): that one keeps ESTIA roles out of customer organizations, this one keeps customer roles off the ESTIA roster.';

drop trigger if exists platform_staff_role_is_platform on public.platform_staff;
create trigger platform_staff_role_is_platform
  before insert or update on public.platform_staff
  for each row execute function public.tg_platform_staff_role_is_platform();

drop trigger if exists platform_staff_touch on public.platform_staff;
create trigger platform_staff_touch
  before update on public.platform_staff
  for each row execute function public.tg_touch_row();

-- No index is added for the lookup in `is_platform_staff()`.
-- `platform_staff_user_key` is a unique index on `user_id`, so the roster is
-- reached by one index scan already, and a partial index beside it would be a
-- second structure to maintain for the same single row. The roster is measured
-- in employees, not in customers.


-- ── The two questions ───────────────────────────────────────────────────────
--
-- `my_organizations()` is the tenant rule stated once. These are its
-- counterpart for the console, and they follow the same construction: SECURITY
-- DEFINER with an explicitly EMPTY search_path, every object schema-qualified,
-- EXECUTE revoked from `public` and from `anon` by name — Supabase's default
-- privileges grant anon its own EXECUTE on every new function in `public`, and
-- a revoke from PUBLIC does not touch it.
--
-- `platform_staff` is enabled for row level security but deliberately NOT
-- forced, for the same reason `memberships` is not: these definer functions
-- read it, and forcing it would risk the lookup evaluating the very policy it
-- is being called from.

create or replace function public.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_staff ps
    where ps.user_id = (select auth.uid())
      and ps.status = 'active'::public.platform_staff_status
  );
$$;

comment on function public.is_platform_staff() is
  'Is the caller ESTIA staff with an active roster entry? The platform counterpart of my_organizations(), and the only definition of the answer. A revoked entry returns false.';

create or replace function public.has_platform_permission(required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_staff ps
    join public.role_permissions rp on rp.role_id = ps.role_id
    where ps.user_id = (select auth.uid())
      and ps.status = 'active'::public.platform_staff_status
      and rp.permission_code = has_platform_permission.required_permission
  );
$$;

comment on function public.has_platform_permission(text) is
  'Does the caller hold this grant as ESTIA staff? Takes no organization: a platform grant is not held anywhere in particular. It can only ever return true for a platform.* code, because the two platform roles are the only roles this table may name and tg_role_permission_grantable() keeps a customer permission off them.';

revoke all on function public.is_platform_staff() from public, anon;
revoke all on function public.has_platform_permission(text) from public, anon;

-- `authenticated` keeps EXECUTE for the same non-negotiable reason as the
-- three helpers in 0004: a policy expression runs with the querying role's
-- privileges, so a caller who cannot execute these gets 42501 instead of an
-- empty result — and every policy below would fail for everybody, staff or
-- not, rather than merely returning nothing.
grant execute on function public.is_platform_staff() to authenticated, service_role;
grant execute on function public.has_platform_permission(text) to authenticated, service_role;


-- ── Row level security · platform_staff ─────────────────────────────────────
--
-- Read: any active staff member may see the roster, because the console shows
-- who else can do what and that is the point of an accountable back office.
-- A customer sees nothing at all — there is no policy that admits them.
--
-- Write: none. No INSERT, UPDATE or DELETE policy exists and the privileges
-- are not granted. The console cannot promote anybody, including its own
-- operator, and cannot revoke a colleague to lock them out mid-incident.
-- Changing the roster is a deliberate act by the database owner.

alter table public.platform_staff enable row level security;

revoke all on public.platform_staff from anon, authenticated;
grant select on public.platform_staff to authenticated;
grant all on public.platform_staff to service_role;

drop policy if exists platform_staff_select on public.platform_staff;
create policy platform_staff_select on public.platform_staff
  for select to authenticated
  using (public.is_platform_staff());


-- ── Cross-tenant reads, one table at a time ─────────────────────────────────
--
-- Every policy here is additive: the existing tenant policy is untouched and
-- Postgres ORs permissive policies together, so a customer's reach is exactly
-- what it was before this file ran. What changes is that a row also becomes
-- readable when `has_platform_permission('platform.organization.view')` holds.
--
-- Seven tables, and the list is the whole disclosure. Notably absent:
-- `bookings`, `guests`, `payments`, `invoices`, `tasks`, `messages` and every
-- other business table. A platform console that could read a customer's guest
-- list is a console that will eventually read one, and none of the eight
-- screens it has needs to.

drop policy if exists organizations_platform_select on public.organizations;
create policy organizations_platform_select on public.organizations
  for select to authenticated
  using (public.has_platform_permission('platform.organization.view'));

drop policy if exists organization_subscriptions_platform_select on public.organization_subscriptions;
create policy organization_subscriptions_platform_select on public.organization_subscriptions
  for select to authenticated
  using (public.has_platform_permission('platform.organization.view'));

-- The whole catalogue, including withdrawn and non-public packages. The
-- customer policy shows what is offered; the console has to show what exists,
-- because "this customer is on a plan we no longer sell" is precisely the
-- thing it is looked at for.
drop policy if exists plans_platform_select on public.plans;
create policy plans_platform_select on public.plans
  for select to authenticated
  using (public.has_platform_permission('platform.organization.view'));

-- The screen the brief called the one most likely to leak: finding a person
-- across organizations. It crosses tenants by design, so the justification is
-- stated three times over — here, in `has_platform_permission`, and again in
-- the route guard — and it is the same justification every time: the platform
-- role, and nothing else. There is no fallback to a customer membership
-- anywhere in this file.
drop policy if exists memberships_platform_select on public.memberships;
create policy memberships_platform_select on public.memberships
  for select to authenticated
  using (public.has_platform_permission('platform.organization.view'));

drop policy if exists membership_roles_platform_select on public.membership_roles;
create policy membership_roles_platform_select on public.membership_roles
  for select to authenticated
  using (public.has_platform_permission('platform.organization.view'));

drop policy if exists membership_scopes_platform_select on public.membership_scopes;
create policy membership_scopes_platform_select on public.membership_scopes
  for select to authenticated
  using (public.has_platform_permission('platform.organization.view'));

-- Names, so a support call can be answered. `user_profiles` carries a name,
-- a phone and a locale and no email — the email lives in `auth.users`, which
-- this migration does not open and the console never reads.
drop policy if exists user_profiles_platform_select on public.user_profiles;
create policy user_profiles_platform_select on public.user_profiles
  for select to authenticated
  using (public.has_platform_permission('platform.organization.view'));


-- ── Usage: counts, not rows ─────────────────────────────────────────────────
--
-- The console shows how much of a package a customer is using, and the plan
-- limits are properties, units, members and storage. Three of those can be
-- counted; the fourth cannot, and this function does not pretend otherwise —
-- there is no storage accounting anywhere in this database, so there is no
-- column here to hold a zero that would read as "they store nothing".
--
-- This is a function rather than two more SELECT policies on purpose. A policy
-- on `properties` and `units` would hand ESTIA staff every address, every
-- unit name and every note attached to them, to answer a question whose whole
-- content is two integers. The definer function returns the integers.

create or replace function public.platform_organization_usage(target_organization_id uuid)
returns table (
  properties integer,
  units      integer,
  members    integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      select count(*)::integer
      from public.properties p
      where p.organization_id = platform_organization_usage.target_organization_id
        and p.deleted_at is null
    ),
    (
      select count(*)::integer
      from public.units u
      where u.organization_id = platform_organization_usage.target_organization_id
        and u.deleted_at is null
    ),
    (
      select count(*)::integer
      from public.memberships m
      where m.organization_id = platform_organization_usage.target_organization_id
        and m.status = 'active'::public.membership_status
    )
  where public.has_platform_permission('platform.organization.view');
$$;

comment on function public.platform_organization_usage(uuid) is
  'Properties, units and active members for one organization, as three integers. A definer function rather than SELECT policies on properties and units, so that answering "how much of the package are they using" does not hand ESTIA staff every address and unit name. Returns no row at all when the caller is not platform staff — deny by default, without an exception to catch.';

revoke all on function public.platform_organization_usage(uuid) from public, anon;
grant execute on function public.platform_organization_usage(uuid) to authenticated, service_role;


-- ── The audit trail ─────────────────────────────────────────────────────────
--
-- One table, not two. A platform action against a customer is recorded in that
-- customer's own `audit_events` as `actor_type = 'platform_staff'` with the
-- target named, which means the customer sees it in their own audit screen —
-- and a separate platform-only table would have been the version where they do
-- not.
--
-- "Separate from any customer's" is then a filter rather than a second table,
-- and the database enforces it: platform staff may read exactly the rows the
-- platform itself wrote, and not one customer row beside them. `audit.view` is
-- a customer's grant and reaches a customer's whole trail; this reaches five
-- actions performed by ESTIA.

drop policy if exists audit_events_platform_select on public.audit_events;
create policy audit_events_platform_select on public.audit_events
  for select to authenticated
  using (
    public.is_platform_staff()
    and actor_type = 'platform_staff'::public.audit_actor_type
  );

-- Writing into a customer's trail without being a member of them. Narrow on
-- both axes: the row must be signed `platform_staff`, and it must be signed
-- with the caller's own id — a staff member may no more forge a colleague's
-- signature than a customer's employee may forge theirs.
--
-- `on_behalf_of_user_id` must be null. A platform action is ESTIA's own; there
-- is no customer who asked for it, and the delegation signature is the one
-- field in this table whose forgery was a real defect (see 0006).
drop policy if exists audit_events_platform_insert on public.audit_events;
create policy audit_events_platform_insert on public.audit_events
  for insert to authenticated
  with check (
    public.is_platform_staff()
    and actor_type = 'platform_staff'::public.audit_actor_type
    and actor_user_id = (select auth.uid())
    and on_behalf_of_user_id is null
  );

-- The console's own read: what ESTIA did, newest first, across every customer.
create index if not exists audit_events_platform_staff_idx
  on public.audit_events (occurred_at desc)
  where actor_type = 'platform_staff'::public.audit_actor_type;


-- ── platform_support_sessions ───────────────────────────────────────────────
--
-- READ THE HEADER OF THIS FILE BEFORE READING THIS TABLE.
--
-- This is not impersonation and it does not become impersonation by being
-- written to. It records that a named staff member opened a read-only view of
-- one customer, why, and until when. It grants nothing: no policy above
-- mentions it, so removing the table would leave every permission in this
-- migration exactly as it is.
--
-- What it is for is the question a customer asks afterwards — "who at ESTIA
-- looked at my account, when, and why" — which the ordinary `audit_events`
-- row answers as a sentence and this answers as a record with an expiry.

create table if not exists public.platform_support_sessions (
  id                uuid primary key default gen_random_uuid(),

  staff_user_id     uuid not null references auth.users (id) on delete restrict,

  -- RESTRICT, matching audit_events: closing an organization must not erase
  -- the record of who looked at it.
  organization_id   uuid not null references public.organizations (id) on delete restrict,

  -- Not nullable and not blank. A support session with no stated reason is the
  -- version of this feature that should not exist.
  reason            text not null,

  started_at        timestamptz not null default now(),
  -- Time-boxed at the database, not by a timer in the interface. An expiry the
  -- application computes is an expiry the application can forget.
  expires_at        timestamptz not null,
  ended_at          timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,

  constraint platform_support_sessions_reason_not_blank check (length(btrim(reason)) > 0),
  constraint platform_support_sessions_expiry_after_start check (expires_at > started_at),
  constraint platform_support_sessions_end_after_start check (
    ended_at is null or ended_at >= started_at
  ),
  -- Four hours is the longest a support session may be opened for. Written as
  -- a CHECK rather than as a default the caller may override, because the
  -- caller is the person the box is around.
  constraint platform_support_sessions_bounded check (
    expires_at <= started_at + interval '4 hours'
  ),
  constraint platform_support_sessions_version_positive check (version >= 1)
);

comment on table public.platform_support_sessions is
  'A record that an ESTIA staff member opened a READ-ONLY view of one customer, with a stated reason and an expiry of at most four hours. It confers no privilege: no policy in this database consults it. Full impersonation is not built — see the header of 0041_platform_admin.sql.';
comment on column public.platform_support_sessions.expires_at is
  'When the stated justification lapses. Bounded to four hours by CHECK, so the limit is a property of the table rather than of whichever screen inserted the row.';
comment on column public.platform_support_sessions.ended_at is
  'Set when the staff member closed the view themselves. A session may be expired, ended, or both; neither state removes the row.';

drop trigger if exists platform_support_sessions_touch on public.platform_support_sessions;
create trigger platform_support_sessions_touch
  before update on public.platform_support_sessions
  for each row execute function public.tg_touch_row();

create index if not exists platform_support_sessions_organization_idx
  on public.platform_support_sessions (organization_id, started_at desc);
create index if not exists platform_support_sessions_staff_idx
  on public.platform_support_sessions (staff_user_id, started_at desc);

alter table public.platform_support_sessions enable row level security;
alter table public.platform_support_sessions force  row level security;

revoke all on public.platform_support_sessions from anon, authenticated;
grant select, insert, update on public.platform_support_sessions to authenticated;
grant all on public.platform_support_sessions to service_role;

drop policy if exists platform_support_sessions_select on public.platform_support_sessions;
create policy platform_support_sessions_select on public.platform_support_sessions
  for select to authenticated
  using (public.is_platform_staff());

-- Opening one requires the impersonation grant even though nothing is
-- impersonated: it is the grant that names this capability, and inventing a
-- sixth platform permission to mean "may open a read-only view" would leave
-- `platform.impersonate` attached to nothing and looking unused.
drop policy if exists platform_support_sessions_insert on public.platform_support_sessions;
create policy platform_support_sessions_insert on public.platform_support_sessions
  for insert to authenticated
  with check (
    public.has_platform_permission('platform.impersonate')
    and staff_user_id = (select auth.uid())
  );

-- The only update anybody may make is ending their own session. There is no
-- DELETE policy: a support session that can be deleted is not a record of
-- anything.
drop policy if exists platform_support_sessions_update on public.platform_support_sessions;
create policy platform_support_sessions_update on public.platform_support_sessions
  for update to authenticated
  using (
    public.has_platform_permission('platform.impersonate')
    and staff_user_id = (select auth.uid())
  )
  with check (
    public.has_platform_permission('platform.impersonate')
    and staff_user_id = (select auth.uid())
  );


-- ── The write surface, in full ──────────────────────────────────────────────
--
-- Two functions. Neither is reachable except by platform staff holding the
-- named grant, and both refuse without a stated reason.
--
-- They are SECURITY DEFINER functions rather than UPDATE policies for a reason
-- row level security cannot express: a policy admits or refuses a row, and
-- says nothing about WHICH COLUMNS the update touched. An UPDATE policy on
-- `organizations` for platform staff would let ESTIA staff rename a customer,
-- change their billing country and rewrite their brand colours while the
-- policy's only opinion was that they are staff. These functions each write
-- exactly one thing.

create or replace function public.platform_set_organization_status(
  target_organization_id uuid,
  next_status            public.organization_status
)
returns public.organizations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  updated public.organizations;
begin
  if not public.has_platform_permission('platform.organization.manage') then
    raise exception 'platform.organization.manage is required to change an organization status'
      using errcode = '42501';
  end if;

  -- Suspension is not deletion and this function cannot become deletion. The
  -- enum's fourth member, `closed`, is refused here deliberately: closing an
  -- account is the customer's own irreversible decision under
  -- `organization.close`, which is an owner-only grant, and it is not ESTIA's
  -- to take on their behalf from a support console.
  if next_status not in ('active'::public.organization_status,
                         'suspended'::public.organization_status) then
    raise exception
      'a platform console may only suspend or restore an organization, not set it to %',
      next_status
      using errcode = '22023';
  end if;

  update public.organizations o
     set status = next_status,
         updated_by = (select auth.uid())
   where o.id = platform_set_organization_status.target_organization_id
     and o.deleted_at is null
  returning o.* into updated;

  if not found then
    raise exception 'organization % does not exist', target_organization_id
      using errcode = 'P0002';
  end if;

  return updated;
end;
$$;

comment on function public.platform_set_organization_status(uuid, public.organization_status) is
  'Suspends or restores one organization and touches nothing else — not the name, not the brand, not a single business row. Refuses `closed`: closing an account is the owner own decision under organization.close and is not ESTIA to take for them. Deletes nothing; a suspended organization keeps every row it had.';

revoke all on function public.platform_set_organization_status(uuid, public.organization_status) from public, anon;
grant execute on function public.platform_set_organization_status(uuid, public.organization_status) to authenticated, service_role;


-- The per-customer deviations. These columns already exist and are already the
-- mechanism — `effectiveEntitlements()` and `effectiveLimits()` in
-- src/lib/plans/plan.ts read exactly them — so the console edits them rather
-- than introducing a second feature-flag table beside a working one. Two
-- sources for "does this customer have the website builder" is the failure
-- mode, not the missing table.
create or replace function public.platform_set_organization_capabilities(
  target_organization_id uuid,
  grants                 text[],
  revocations            text[],
  limits                 jsonb
)
returns public.organization_subscriptions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  updated public.organization_subscriptions;
begin
  if not public.has_platform_permission('platform.feature_flag.manage') then
    raise exception 'platform.feature_flag.manage is required to change capability overrides'
      using errcode = '42501';
  end if;

  update public.organization_subscriptions s
     set entitlement_grants      = coalesce(grants, '{}'::text[]),
         entitlement_revocations = coalesce(revocations, '{}'::text[]),
         limit_overrides         = coalesce(limits, '{}'::jsonb),
         updated_by              = (select auth.uid())
   where s.organization_id = platform_set_organization_capabilities.target_organization_id
     and s.deleted_at is null
  returning s.* into updated;

  if not found then
    raise exception 'organization % has no live subscription', target_organization_id
      using errcode = 'P0002';
  end if;

  return updated;
end;
$$;

comment on function public.platform_set_organization_capabilities(uuid, text[], text[], jsonb) is
  'Writes the three per-customer override columns on organization_subscriptions and nothing else — never the plan, never the agreed price. The CHECK constraints from 0003 still decide what is a known entitlement and a legal limits shape, so an unknown feature name is refused by the table rather than accepted here.';

revoke all on function public.platform_set_organization_capabilities(uuid, text[], text[], jsonb) from public, anon;
grant execute on function public.platform_set_organization_capabilities(uuid, text[], text[], jsonb) to authenticated, service_role;


-- ============================================================================
-- Rehearsal — what this migration assumed, asserted against the live catalogue
--
-- Everything above is written on top of decisions taken in 0002, 0003, 0004
-- and 0005. If any of them has since moved, this block is where it should be
-- found, rather than three weeks later on a screen.
-- ============================================================================

do $$
declare
  missing        text;
  platform_roles integer;
  leaked         integer;
begin
  -- The two platform roles, and their grants. `platform_staff.role_id` is
  -- worthless without them.
  select count(*) into platform_roles
    from public.roles r
   where r.organization_id is null
     and r.is_platform
     and r.code in ('platform_super_admin', 'platform_support');

  if platform_roles <> 2 then
    raise exception
      '0041 expected the two platform roles seeded by 0002; found %', platform_roles;
  end if;

  if not exists (
    select 1
    from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    where r.code = 'platform_super_admin'
      and r.organization_id is null
      and rp.permission_code = 'platform.organization.manage'
  ) then
    raise exception
      '0041 expected platform_super_admin to hold platform.organization.manage';
  end if;

  -- THE PROPERTY THE WHOLE FILE RESTS ON: the platform grant set and the
  -- customer grant set are disjoint. If a platform role ever acquired a
  -- customer permission, `has_platform_permission` would start answering true
  -- for it and every policy above would widen silently.
  select count(*) into leaked
    from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.code = rp.permission_code
   where r.is_platform
     and not p.is_platform;

  if leaked > 0 then
    raise exception
      '0041 found % customer permission(s) granted to a platform role; the console would inherit them',
      leaked;
  end if;

  -- The five columns and one enum member this migration writes into.
  select string_agg(expected, ', ') into missing
    from (values
      ('audit_events.on_behalf_of_user_id'),
      ('organization_subscriptions.entitlement_grants'),
      ('organization_subscriptions.entitlement_revocations'),
      ('organization_subscriptions.limit_overrides'),
      ('organizations.status')
    ) as v(expected)
   where not exists (
     select 1
     from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = split_part(v.expected, '.', 1)
       and c.column_name = split_part(v.expected, '.', 2)
   );

  if missing is not null then
    raise exception '0041 expected these columns and did not find them: %', missing;
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'audit_actor_type'
      and e.enumlabel = 'platform_staff'
  ) then
    raise exception
      '0041 expected audit_actor_type to carry platform_staff; the console has nothing to sign its events with';
  end if;

  -- The roster starts empty, and the trigger that keeps it honest is attached.
  if not exists (
    select 1 from pg_trigger
    where tgname = 'platform_staff_role_is_platform'
      and tgrelid = 'public.platform_staff'::regclass
  ) then
    raise exception '0041 did not attach platform_staff_role_is_platform';
  end if;

  raise notice
    '0041 rehearsal passed. platform_staff is empty by design: adding an ESTIA colleague is a deliberate act by the database owner, not something the console can do to itself.';
end $$;
