-- ============================================================================
-- 0025_agent_membership_authority.sql — ESTIA · the general manager can use
--                                       the feature the catalogue says they own
--
-- What this fixes
--   `src/lib/authz/roles.ts` gives `general_manager` the agent network —
--   `agent.view`, `agent.invite`, `agent.manage`, `agent.scope.manage`,
--   `agency.manage`, the agreement, the limits, the audit trail — and calls
--   them its owner in as many words.
--
--   Two of the acts at the centre of that feature do not touch an agent table
--   at all. *Adding* an agent writes `memberships` and `membership_roles`;
--   *suspending* one writes `memberships`, because 0019 deliberately kept the
--   status on the membership rather than copying it onto the terms. Those two
--   tables are policed by the organization-wide team grants:
--
--       memberships_update      → membership AND has_permission('user.edit')
--       membership_roles_insert → membership AND has_permission('role.assign')
--
--   `general_manager` holds neither, and neither appears in any composed role
--   in roles.ts — only `organization_owner` and `administrator` have them, by
--   catalogue derivation. So adding and suspending an agent were
--   owner-and-administrator-only while every screen said otherwise, and
--   src/lib/agents/operations.ts asserted the two grants by name in the domain
--   precisely so the refusal was honest rather than a NotFoundError about a
--   membership that plainly exists.
--
-- ── Why not simply give the GM user.edit and role.assign ────────────────────
--
--   Because `memberships_update` guards EVERY membership in the organization.
--   It cannot see that the row it is admitting happens to belong to an agent.
--   Handing `user.edit` to whoever runs the sellers would let them suspend an
--   administrator, or reinstate a membership somebody else removed. That is a
--   privilege escalation dressed as a bug fix, and it would be granted to a
--   role that thousands of installations hand out freely.
--
-- ── What is done instead ────────────────────────────────────────────────────
--
--   The authority is named for what it actually is —
--   `agent.membership.manage` — and given policies of its own, narrowed to
--   match the name rather than to match convenience:
--
--     1. it reaches a membership only when that membership has agent terms
--        (an `agent_organization_settings` row exists for it);
--     2. it never reaches a membership that itself holds elevated authority,
--        so an owner or an administrator who also happens to be an agent stays
--        out of reach — which is the case a narrower rule written as "not the
--        owner" would have missed;
--     3. on `membership_roles` it may insert only the four global agent preset
--        roles, and only onto a membership that holds no non-agent role — so
--        it cannot promote a cleaner into a seller, and cannot bolt an agent
--        role onto an administrator;
--     4. it is additive. Both policies are new and permissive; `user.edit` and
--        `role.assign` keep every path they had, and nobody loses anything.
--
--   Point 3 is why `membership_roles_insert_agent` does not also require agent
--   terms to exist: `attachExistingUser` writes the membership and its role
--   *before* the terms row, so at the moment of the insert there is nothing to
--   test. "Holds no non-agent role" is the condition that is true then — a
--   membership under construction has no roles at all — and still true when a
--   removed agent is re-admitted.
--
-- ── What is deliberately NOT granted ────────────────────────────────────────
--
--   No DELETE on `membership_roles`. Taking an agent's role away is not how an
--   agent relationship ends — `memberships.status` is — and a delete policy
--   would be a second, unaudited way to leave somebody signed in with no
--   grants and no explanation, which is the exact outcome 0019 and
--   src/lib/persistence/agents.ts spend paragraphs preventing.
--
--   No `memberships_insert`. Creating a membership for somebody who has none
--   cannot be narrowed to "agent memberships only", because there is no agent
--   membership yet to test against. A general manager already holds
--   `user.invite`, so that branch works without widening anything.
--
-- Depends on
--   0004 (my_organizations, has_permission, memberships/membership_roles
--   policies), 0012 (the permission catalogue and the four agent preset
--   roles), 0019 (agent_organization_settings).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The permission joins the catalogue
-- ============================================================================
-- Sort order 1085, between `agent.manage` (1080) and `agent.scope.manage`
-- (1090), which is where src/lib/authz/permissions.ts lists it.

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
values ('agent.membership.manage', 'action'::public.permission_kind, 'agent', false, 1085)
on conflict (code) do update
  set kind = excluded.kind, category = excluded.category,
      is_owner_only = excluded.is_owner_only;

-- The derivation from 0002, 0012 and 0016, re-run so the new code reaches the
-- two roles that are computed rather than listed.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r cross join public.permissions p
where r.code = 'organization_owner' and r.organization_id is null and not p.is_platform
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
from public.roles r cross join public.permissions p
where r.code = 'administrator' and r.organization_id is null
  and not p.is_platform and not p.is_owner_only
on conflict do nothing;

-- The role the whole migration exists for. `general_manager` and nobody else:
-- a property manager approves the agent bookings that land on their property
-- and does not decide who the agents are, and a finance manager pays them
-- without admitting them.
insert into public.role_permissions (role_id, permission_code)
select r.id, 'agent.membership.manage'
from public.roles r
where r.organization_id is null and r.code = 'general_manager'
on conflict do nothing;


-- ============================================================================
-- 2 · The three questions the policies ask
-- ============================================================================
-- SECURITY DEFINER for the ordinary reason: a policy is evaluated with the
-- privileges of the querying role, and the caller must be able to answer
-- "does that membership hold an administrator's grants" without being able to
-- read the rows that say so.
--
-- STABLE, and `set search_path = ''` so every name is schema-qualified and no
-- caller can shadow a table out from under them. Same shape as
-- my_organizations() and has_permission() in 0004.

/**
 * Is this membership one of the four global agent preset roles?
 */
create or replace function public.is_agent_preset_role(target_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.roles r
    where r.id = is_agent_preset_role.target_role_id
      and r.organization_id is null
      and r.is_system
      and r.code in (
        'referral_agent', 'sales_agent', 'senior_agent', 'agency_manager'
      )
  );
$$;

comment on function public.is_agent_preset_role(uuid) is
  'One of the four global agent preset roles seeded by 0012 — AGENT_PRESET_ROLE in src/lib/agents/access.ts. A customer-composed role is not one of these however it is named, because the check is on the row and not on the code alone.';


/**
 * Does this membership have agent terms — is it an agent at all?
 */
create or replace function public.is_agent_membership(target_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.agent_organization_settings s
    where s.membership_id = is_agent_membership.target_membership_id
  );
$$;

comment on function public.is_agent_membership(uuid) is
  'True when agent_organization_settings holds terms for this membership. The definition of "this row belongs to the agent network", used to keep agent.membership.manage away from every other membership in the organization.';


/**
 * Does this membership hold authority that a network manager must not touch?
 *
 * Written as a question about *grants* rather than about role codes. "Not the
 * owner" would be the obvious rule and the wrong one: it misses an
 * administrator, it misses a custom role a customer built that happens to
 * carry `role.assign`, and it misses the next senior role somebody adds. The
 * codes below are the ones whose holder can change who may do what — plus
 * every owner-only and every platform permission, which are owner-only and
 * platform for exactly this reason.
 *
 * `agent.membership.manage` is in the list, so two general managers cannot
 * suspend each other.
 */
create or replace function public.membership_holds_elevated_authority(
  target_membership_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership_roles mr
    join public.role_permissions rp on rp.role_id = mr.role_id
    join public.permissions p on p.code = rp.permission_code
    where mr.membership_id = membership_holds_elevated_authority.target_membership_id
      and (
        p.is_owner_only
        or p.is_platform
        or p.code in (
          'user.edit', 'user.suspend', 'user.remove',
          'role.create', 'role.assign',
          'agent.membership.manage'
        )
      )
  );
$$;

comment on function public.membership_holds_elevated_authority(uuid) is
  'True when this membership holds any grant that decides who may do what — the owner-only set, the platform set, the team-and-access set, and agent.membership.manage itself. An owner or administrator who is also an agent is therefore out of reach of whoever runs the agent network, and so is another network manager.';


/**
 * Does this membership hold nothing but agent preset roles?
 *
 * True for a membership under construction, which holds no roles at all, and
 * true for an existing agent. False for a receptionist, which is what stops
 * `agent.membership.manage` from bolting a seller's role onto somebody else's
 * staff record.
 */
create or replace function public.membership_holds_only_agent_roles(
  target_membership_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.membership_roles mr
    where mr.membership_id = membership_holds_only_agent_roles.target_membership_id
      and not public.is_agent_preset_role(mr.role_id)
  );
$$;

comment on function public.membership_holds_only_agent_roles(uuid) is
  'True when the membership holds only agent preset roles, which includes holding none at all — the state attachExistingUser writes the role into, before the terms row exists.';


-- 0004 explains why `anon` is named explicitly and is not redundant with
-- FROM PUBLIC: Supabase ships ALTER DEFAULT PRIVILEGES granting EXECUTE on
-- every new function in `public` to anon individually, and a revoke from
-- PUBLIC leaves that grant standing.
revoke all on function public.is_agent_preset_role(uuid) from public, anon;
revoke all on function public.is_agent_membership(uuid) from public, anon;
revoke all on function public.membership_holds_elevated_authority(uuid) from public, anon;
revoke all on function public.membership_holds_only_agent_roles(uuid) from public, anon;

-- `authenticated` keeps EXECUTE for the reason 0004 gives: a policy expression
-- runs with the querying role's privileges, so a member who cannot execute
-- these gets 42501 instead of a refusal.
grant execute on function public.is_agent_preset_role(uuid) to authenticated, service_role;
grant execute on function public.is_agent_membership(uuid) to authenticated, service_role;
grant execute on function public.membership_holds_elevated_authority(uuid) to authenticated, service_role;
grant execute on function public.membership_holds_only_agent_roles(uuid) to authenticated, service_role;


-- ============================================================================
-- 3 · The policies
-- ============================================================================
-- Both are additional PERMISSIVE policies. `memberships_update` and
-- `membership_roles_insert` from 0004 are untouched and still say exactly what
-- they said; a caller now passes if either policy admits them, which is the
-- widening — and it is a widening only over rows these predicates admit.

drop policy if exists memberships_update_agent on public.memberships;
create policy memberships_update_agent on public.memberships
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.membership.manage')
    and public.is_agent_membership(id)
    and not public.membership_holds_elevated_authority(id)
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.membership.manage')
    and public.is_agent_membership(id)
    and not public.membership_holds_elevated_authority(id)
  );

comment on policy memberships_update_agent on public.memberships is
  'Suspend, reinstate and remove an agent. The status lives here rather than on the terms row (0019), so the network manager has to reach this table — and reaches nothing in it that is not an agent, and nothing that holds elevated authority.';

drop policy if exists membership_roles_insert_agent on public.membership_roles;
create policy membership_roles_insert_agent on public.membership_roles
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.membership.manage')
    and public.is_agent_preset_role(role_id)
    and not public.membership_holds_elevated_authority(membership_id)
    and public.membership_holds_only_agent_roles(membership_id)
  );

comment on policy membership_roles_insert_agent on public.membership_roles is
  'Give a new or re-admitted agent the role their preset names — without which the membership resolves with no grants at all. Only the four agent preset roles, and only onto a membership that holds nothing else.';


-- ============================================================================
-- 4 · Drift fails loudly
-- ============================================================================
-- The same guard 0012 carries, with the numbers of today. 0016 added
-- `commission.manage` and moved these from 132/140/136 without updating the
-- assertion in 0012 — which is only invisible because 0012 had already run.
-- Stated here in full so the next reader has the current figures in one place.

do $$
declare
  action_count integer;
  field_count  integer;
  owner_count  integer;
  admin_count  integer;
  gm_count     integer;
begin
  select count(*) into action_count from public.permissions where kind = 'action';
  select count(*) into field_count  from public.permissions where kind = 'field';
  if action_count <> 134 or field_count <> 13 then
    raise exception
      'permission catalogue drift: expected 134 action and 13 field permissions, found % and %',
      action_count, field_count;
  end if;

  select count(*) into owner_count
    from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'organization_owner' and r.organization_id is null;

  select count(*) into admin_count
    from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'administrator' and r.organization_id is null;

  select count(*) into gm_count
    from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'general_manager' and r.organization_id is null;

  -- grantsForSystemRole() in src/lib/authz/roles.ts resolves the two derived
  -- roles to 142 and 138 exactly.
  --
  -- `general_manager` is 90 here and 89 there, and the difference is real
  -- rather than an arithmetic slip: 0016 §9 granted `commission.manage` to
  -- general_manager and finance_manager in SQL, and roles.ts composes that
  -- code into no role at all. The database is therefore one grant wider than
  -- the engine for those two roles, which is the safe direction — can() is the
  -- stricter floor and refuses first — but it is a divergence and it is
  -- recorded here rather than absorbed. Closing it means editing roles.ts,
  -- which widens what the engine allows and is a decision, not a cleanup.
  if owner_count <> 142 or admin_count <> 138 or gm_count <> 90 then
    raise exception
      'derived role drift: expected owner 142, administrator 138, general_manager 90; found %, %, %',
      owner_count, admin_count, gm_count;
  end if;

  if not exists (
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    where r.code = 'general_manager' and r.organization_id is null
      and rp.permission_code = 'agent.membership.manage'
  ) then
    raise exception
      'general_manager does not hold agent.membership.manage; has_permission would return false and the policies below would admit nobody';
  end if;
end $$;
