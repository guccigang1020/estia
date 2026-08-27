-- ============================================================================
-- 0004_rls.sql — ESTIA foundation · the security floor
--
-- What this does
--   Turns on row level security for every table created by 0001–0003 and
--   writes the policies.
--
--   ESTIA has two floors, not one. This is the lower of them: the database
--   refuses to return another organization's rows no matter what the
--   application does — a wrong id in a URL, a call straight to the REST API,
--   a bug in a service. The permission engine in src/lib/authz is the second
--   floor, and it decides what a member may do inside their own organization.
--   If one fails the other still stands.
--
--   Three principles are visible in every policy below:
--     · Deny by default. There is no permissive USING (true) on tenant data.
--       A table with row level security on and no policy for a command
--       refuses that command; that is used deliberately, not by omission.
--     · One policy per command. FOR ALL hides the difference between reading
--       a row and creating one, and an INSERT written that way is checked with
--       USING rather than WITH CHECK — which is how a member ends up able to
--       write a row into someone else's organization.
--     · Every policy is supported by an index. A policy that forces a
--       sequential scan is a policy someone will eventually be tempted to
--       remove.
--
-- Depends on
--   0001_identity.sql, 0002_authz.sql, 0003_plans.sql.
--
-- Followed by
--   0005_audit.sql, which creates audit_events and installs its own policies.
-- ============================================================================

set search_path = public, extensions;


-- ── Helper functions ────────────────────────────────────────────────────────
--
-- All three are SECURITY DEFINER with an explicitly empty search_path. Empty,
-- not merely set: a definer function that resolves an unqualified name through
-- the caller's search_path is a privilege escalation waiting to be found, so
-- every object below is schema-qualified.
--
-- They are also the reason the tables they read are enabled but not FORCEd.
-- FORCE applies policies to the table owner as well, and the policy on
-- memberships is written in terms of my_organizations(), which reads
-- memberships. Leaving those three tables unforced keeps the lookup from
-- recursing through the policy it exists to serve.

create or replace function public.my_organizations()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'::public.membership_status;
$$;

comment on function public.my_organizations() is
  'The organizations the caller has an ACTIVE membership in. The single definition of tenant reach; every tenant policy is written as organization_id IN (SELECT public.my_organizations()). Invited, pending, suspended and removed memberships deliberately return nothing.';


create or replace function public.has_permission(target_organization_id uuid, required_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.membership_roles mr on mr.membership_id = m.id
    join public.role_permissions rp on rp.role_id = mr.role_id
    where m.user_id = (select auth.uid())
      and m.status = 'active'::public.membership_status
      and m.organization_id = has_permission.target_organization_id
      and rp.permission_code = has_permission.required_permission
  );
$$;

comment on function public.has_permission(uuid, text) is
  'Does the caller hold this grant in this organization? Used by policies that need more than tenant membership — writing team records, reading the audit trail. It is a coarse mirror of can() in src/lib/authz, not a replacement for it: scope and plan entitlements are decided in the service layer.';


create or replace function public.shares_organization_with(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs
      on theirs.organization_id = mine.organization_id
    where mine.user_id = (select auth.uid())
      and mine.status = 'active'::public.membership_status
      and theirs.user_id = shares_organization_with.other_user_id
      and theirs.status <> 'removed'::public.membership_status
  );
$$;

comment on function public.shares_organization_with(uuid) is
  'True when the caller and the given user are colleagues in at least one organization. Lets a team screen show names and avatars without opening the whole profile table.';


-- `anon` is named explicitly, and that is not redundant with FROM PUBLIC.
-- Supabase ships ALTER DEFAULT PRIVILEGES that grant EXECUTE on every new
-- function in `public` to anon, authenticated and service_role individually.
-- A revoke from PUBLIC leaves anon's own grant untouched, and an
-- unauthenticated caller can then reach these SECURITY DEFINER functions over
-- /rest/v1/rpc/. Verified against pg_proc.proacl, not assumed.
revoke all on function public.my_organizations() from public, anon;
revoke all on function public.has_permission(uuid, text) from public, anon;
revoke all on function public.shares_organization_with(uuid) from public, anon;

-- `authenticated` keeps EXECUTE, and this one is not negotiable. A row level
-- security expression is evaluated with the privileges of the querying role,
-- so a member who cannot execute my_organizations() cannot read their own
-- organization either: every policy fails with 42501 instead of returning no
-- rows. The database linter reports these three as callable by signed-in
-- users (lint 0029) and that finding is accepted deliberately — it is the
-- price of stating the tenant rule once instead of inlining the subquery into
-- thirty policies.
grant execute on function public.my_organizations() to authenticated, service_role;
grant execute on function public.has_permission(uuid, text) to authenticated, service_role;
grant execute on function public.shares_organization_with(uuid) to authenticated, service_role;


-- ── Enable row level security ───────────────────────────────────────────────
--
-- FORCE is applied where it costs nothing and closes a hole: it removes the
-- table owner's exemption, so a compromised connection running as the owner
-- still cannot read across tenants.
--
-- It is deliberately NOT applied to:
--   · memberships, membership_roles, role_permissions — read by the SECURITY
--     DEFINER helpers above; forcing them risks the lookup evaluating the very
--     policy it is being called from.
--   · permissions, roles, plans — global catalogues seeded by these migrations
--     and by future ones, which run as the owner.

alter table public.organizations              enable row level security;
alter table public.organizations              force  row level security;
alter table public.user_profiles              enable row level security;
alter table public.user_profiles              force  row level security;
alter table public.memberships                enable row level security;
alter table public.invitations                enable row level security;
alter table public.invitations                force  row level security;
alter table public.permissions                enable row level security;
alter table public.roles                      enable row level security;
alter table public.role_permissions           enable row level security;
alter table public.membership_roles           enable row level security;
alter table public.membership_scopes          enable row level security;
alter table public.membership_scopes          force  row level security;
alter table public.plans                      enable row level security;
alter table public.organization_subscriptions enable row level security;
alter table public.organization_subscriptions force  row level security;


-- ── Table privileges ────────────────────────────────────────────────────────
-- Policies filter rows; grants decide whether the command is available at all.
-- Both are needed. `anon` gets nothing: there is no anonymous surface in the
-- back office, and the guest-facing paths will use signed, single-purpose
-- tokens rather than a blanket read.

revoke all on public.organizations              from anon, authenticated;
revoke all on public.user_profiles              from anon, authenticated;
revoke all on public.memberships                from anon, authenticated;
revoke all on public.invitations                from anon, authenticated;
revoke all on public.permissions                from anon, authenticated;
revoke all on public.roles                      from anon, authenticated;
revoke all on public.role_permissions           from anon, authenticated;
revoke all on public.membership_roles           from anon, authenticated;
revoke all on public.membership_scopes          from anon, authenticated;
revoke all on public.plans                      from anon, authenticated;
revoke all on public.organization_subscriptions from anon, authenticated;

grant select, update                 on public.organizations              to authenticated;
grant select, insert, update         on public.user_profiles              to authenticated;
grant select, insert, update         on public.memberships                to authenticated;
grant select, insert, update         on public.invitations                to authenticated;
grant select                         on public.permissions                to authenticated;
grant select, insert, update, delete on public.roles                      to authenticated;
grant select, insert, delete         on public.role_permissions           to authenticated;
grant select, insert, delete         on public.membership_roles           to authenticated;
grant select, insert, update, delete on public.membership_scopes          to authenticated;
grant select                         on public.plans                      to authenticated;
grant select                         on public.organization_subscriptions to authenticated;

grant all on public.organizations              to service_role;
grant all on public.user_profiles              to service_role;
grant all on public.memberships                to service_role;
grant all on public.invitations                to service_role;
grant all on public.permissions                to service_role;
grant all on public.roles                      to service_role;
grant all on public.role_permissions           to service_role;
grant all on public.membership_roles           to service_role;
grant all on public.membership_scopes          to service_role;
grant all on public.plans                      to service_role;
grant all on public.organization_subscriptions to service_role;


-- ── Policies · organizations ────────────────────────────────────────────────
-- No INSERT policy and no DELETE policy, on purpose. Creating an organization
-- is a signup transaction — organization, owner membership and subscription
-- together — and it cannot be expressed as a policy because the creator is not
-- yet a member of anything. It runs through the service layer. Deletion does
-- not exist: an organization is closed (status) or soft-deleted, never removed,
-- because its audit trail has to survive it.

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (id in (select public.my_organizations()));

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update to authenticated
  using (
    id in (select public.my_organizations())
    and public.has_permission(id, 'organization.settings.edit')
  )
  with check (id in (select public.my_organizations()));


-- ── Policies · user_profiles ────────────────────────────────────────────────

drop policy if exists user_profiles_select on public.user_profiles;
create policy user_profiles_select on public.user_profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.shares_organization_with(id)
  );

drop policy if exists user_profiles_insert on public.user_profiles;
create policy user_profiles_insert on public.user_profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists user_profiles_update on public.user_profiles;
create policy user_profiles_update on public.user_profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));


-- ── Policies · memberships ──────────────────────────────────────────────────
-- No DELETE policy: removing a member is status = 'removed'. Deleting the row
-- would take their history with it, which is exactly what must not happen.
-- The first membership of a new organization is created by the signup
-- transaction in the service layer, since no policy can admit a caller who is
-- not yet a member of anything.

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists memberships_insert on public.memberships;
create policy memberships_insert on public.memberships
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'user.invite')
  );

drop policy if exists memberships_update on public.memberships;
create policy memberships_update on public.memberships
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      user_id = (select auth.uid())
      or public.has_permission(organization_id, 'user.edit')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (
      user_id = (select auth.uid())
      or public.has_permission(organization_id, 'user.edit')
    )
  );


-- ── Policies · invitations ──────────────────────────────────────────────────
-- Accepting an invitation is not expressible here either: the invitee is a
-- stranger to the organization until the moment they accept. That path is a
-- SECURITY DEFINER function in the service layer which verifies the token
-- hash, the expiry and the single-use flags, and creates the membership.

drop policy if exists invitations_select on public.invitations;
create policy invitations_select on public.invitations
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'user.view')
  );

drop policy if exists invitations_insert on public.invitations;
create policy invitations_insert on public.invitations
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'user.invite')
  );

drop policy if exists invitations_update on public.invitations;
create policy invitations_update on public.invitations
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'user.invite')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'user.invite')
  );


-- ── Policies · permissions ──────────────────────────────────────────────────
-- The catalogue is not tenant data — the same strings exist for every
-- customer, and the role editor has to be able to list them. This is the only
-- read policy in the file that is not scoped to an organization, and it is
-- still not USING (true): an unauthenticated caller gets nothing.

drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions
  for select to authenticated
  using ((select auth.uid()) is not null);


-- ── Policies · roles ────────────────────────────────────────────────────────
-- Built-in roles (organization_id IS NULL) are readable by everyone signed in,
-- because every organization uses them. Writes are only ever possible against
-- a custom role belonging to the caller's own organization, and the WITH CHECK
-- makes it impossible to create a role that claims to be a system or platform
-- role.

drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles
  for select to authenticated
  using (
    organization_id is null
    or organization_id in (select public.my_organizations())
  );

drop policy if exists roles_insert on public.roles;
create policy roles_insert on public.roles
  for insert to authenticated
  with check (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and is_system = false
    and is_platform = false
    and public.has_permission(organization_id, 'role.create')
  );

drop policy if exists roles_update on public.roles;
create policy roles_update on public.roles
  for update to authenticated
  using (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and is_system = false
    and public.has_permission(organization_id, 'role.create')
  )
  with check (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and is_system = false
    and is_platform = false
  );

drop policy if exists roles_delete on public.roles;
create policy roles_delete on public.roles
  for delete to authenticated
  using (
    organization_id is not null
    and organization_id in (select public.my_organizations())
    and is_system = false
    and public.has_permission(organization_id, 'role.create')
  );


-- ── Policies · role_permissions ─────────────────────────────────────────────
-- This table has no organization_id of its own; the tenant is whatever the
-- role belongs to. Editing the grants on a role is the permission.edit
-- capability, which is owner-only.

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (
    exists (
      select 1
      from public.roles r
      where r.id = role_permissions.role_id
        and (
          r.organization_id is null
          or r.organization_id in (select public.my_organizations())
        )
    )
  );

drop policy if exists role_permissions_insert on public.role_permissions;
create policy role_permissions_insert on public.role_permissions
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.roles r
      where r.id = role_permissions.role_id
        and r.organization_id is not null
        and r.is_system = false
        and r.organization_id in (select public.my_organizations())
        and public.has_permission(r.organization_id, 'permission.edit')
    )
  );

drop policy if exists role_permissions_delete on public.role_permissions;
create policy role_permissions_delete on public.role_permissions
  for delete to authenticated
  using (
    exists (
      select 1
      from public.roles r
      where r.id = role_permissions.role_id
        and r.organization_id is not null
        and r.is_system = false
        and r.organization_id in (select public.my_organizations())
        and public.has_permission(r.organization_id, 'permission.edit')
    )
  );


-- ── Policies · membership_roles ─────────────────────────────────────────────
-- No UPDATE policy: the table is nothing but its primary key, so a change is
-- a delete and an insert, both of which are audited separately.

drop policy if exists membership_roles_select on public.membership_roles;
create policy membership_roles_select on public.membership_roles
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists membership_roles_insert on public.membership_roles;
create policy membership_roles_insert on public.membership_roles
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'role.assign')
  );

drop policy if exists membership_roles_delete on public.membership_roles;
create policy membership_roles_delete on public.membership_roles
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'role.assign')
  );


-- ── Policies · membership_scopes ────────────────────────────────────────────

drop policy if exists membership_scopes_select on public.membership_scopes;
create policy membership_scopes_select on public.membership_scopes
  for select to authenticated
  using (organization_id in (select public.my_organizations()));

drop policy if exists membership_scopes_insert on public.membership_scopes;
create policy membership_scopes_insert on public.membership_scopes
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'role.assign')
  );

drop policy if exists membership_scopes_update on public.membership_scopes;
create policy membership_scopes_update on public.membership_scopes
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'role.assign')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'role.assign')
  );

drop policy if exists membership_scopes_delete on public.membership_scopes;
create policy membership_scopes_delete on public.membership_scopes
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'role.assign')
  );


-- ── Policies · plans ────────────────────────────────────────────────────────
-- A customer sees the packages that are offered, plus the one they are on even
-- if it has since been withdrawn. There are no write policies: prices are
-- edited by ESTIA staff through the back office, which uses the service role
-- and is audited.

drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans
  for select to authenticated
  using (
    deleted_at is null
    and (
      is_public
      or exists (
        select 1
        from public.organization_subscriptions s
        where s.plan_id = plans.id
          and s.organization_id in (select public.my_organizations())
      )
    )
  );


-- ── Policies · organization_subscriptions ───────────────────────────────────
-- Read-only to the customer. A subscription is written by billing, never by
-- the account it belongs to; a policy that let a member update their own
-- subscription would let them grant themselves entitlements.

drop policy if exists organization_subscriptions_select on public.organization_subscriptions;
create policy organization_subscriptions_select on public.organization_subscriptions
  for select to authenticated
  using (organization_id in (select public.my_organizations()));


-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Every organization_id, and every foreign key a policy walks. A policy
-- without a supporting index looks correct and behaves like a table scan on
-- every request; the cost only shows up once there is enough data that fixing
-- it is disruptive.
--
-- The metadata columns (created_by, updated_by, deleted_by) are deliberately
-- left unindexed. Nothing queries by them and they are ON DELETE SET NULL, so
-- the only cost is the rare deletion of an auth.users row.

-- my_organizations() reads exactly these three columns.
create index if not exists memberships_user_status_idx
  on public.memberships (user_id, status) include (organization_id);
create index if not exists memberships_organization_idx
  on public.memberships (organization_id);
create index if not exists memberships_organization_status_idx
  on public.memberships (organization_id, status);
create index if not exists memberships_default_property_idx
  on public.memberships (default_property_id) where default_property_id is not null;
create index if not exists memberships_team_idx
  on public.memberships (team_id) where team_id is not null;
create index if not exists memberships_invited_by_idx
  on public.memberships (invited_by) where invited_by is not null;

create index if not exists invitations_organization_idx
  on public.invitations (organization_id);
create index if not exists invitations_email_idx
  on public.invitations (email);
create index if not exists invitations_role_idx
  on public.invitations (role_id);
create index if not exists invitations_pending_expiry_idx
  on public.invitations (expires_at)
  where accepted_at is null and revoked_at is null;

create index if not exists roles_organization_idx
  on public.roles (organization_id) where organization_id is not null;

-- has_permission() walks membership_roles by membership, then role_permissions
-- by role. The primary keys cover the forward direction; these cover the
-- reverse lookups the role editor uses.
create index if not exists role_permissions_permission_idx
  on public.role_permissions (permission_code);
create index if not exists membership_roles_organization_idx
  on public.membership_roles (organization_id);
create index if not exists membership_roles_role_idx
  on public.membership_roles (role_id);

create index if not exists membership_scopes_organization_idx
  on public.membership_scopes (organization_id);

create index if not exists organization_subscriptions_org_idx
  on public.organization_subscriptions (organization_id);
create index if not exists organization_subscriptions_plan_idx
  on public.organization_subscriptions (plan_id);

create index if not exists plans_public_sort_idx
  on public.plans (sort_order) where is_public and deleted_at is null;

create index if not exists organizations_status_idx
  on public.organizations (status) where deleted_at is null;
