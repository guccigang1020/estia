-- ============================================================================
-- 0026_agent_floor_alignment.sql — ESTIA · the database stops declining two
--                                  features the product offers
--
-- Three drifts, all found the same way: by asking the live database what it
-- actually grants instead of reading what the migrations were supposed to have
-- granted, and by rehearsing each repair before writing it down.
--
--   1. An agent may raise a discount approval in the engine and may not at the
--      database floor.
--   2. Anybody who raised an approval could approve it, by naming somebody
--      else as the decider. Unreachable for an agent until §1, which is why it
--      is closed here and not filed for later.
--   3. An agent's membership has nowhere to record the inventory they may
--      sell, because the only role that can write a scope row is one the agent
--      network manager does not hold.
--
-- Only §1 and §3 grant anything, and neither widens anybody's authority. The
-- first brings four seeded roles onto the catalogue in code that already
-- describes them; the third gives an existing permission — `agent.scope.manage`,
-- which the catalogue calls "the blast radius, not an attribute" — the table it
-- was always about. §2 takes something away, from everybody, and the engine
-- already refused it.
--
-- Depends on
--   0002 (membership_scopes and its policies), 0004 (my_organizations,
--   has_permission), 0011 (approvals and approvals_insert), 0012 (the
--   catalogue and the four agent preset roles), 0019
--   (agent_organization_settings), 0025 (is_agent_membership,
--   membership_holds_elevated_authority).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · An agent may ask
-- ============================================================================
-- `AGENT_BASE` in src/lib/authz/roles.ts gives all four presets
-- `approval.request`, and says why at length:
--
--   > When a discount exceeds their cap the product raises an approval rather
--   > than refusing. Without this grant that flow has nowhere to start, the
--   > refusal is final, and the negotiation moves to WhatsApp — where the sale
--   > leaves the system entirely.
--
-- `approvals_insert` from 0011 requires `has_permission(org, 'approval.request')`
-- and `requested_by = auth.uid()`. The second half an agent satisfies; the
-- first they did not, because 0012 seeded the four roles from lists that
-- predate `AGENT_BASE` growing this member. So `raiseDiscountApproval` composed
-- a request the domain permitted, and the insert was refused by row level
-- security — a feature offered on screen and silently declined underneath.
--
-- The drift was checked in both directions before it was closed. Of the twenty
-- system roles, sixteen agree with grantsForSystemRole() exactly; the four
-- agent presets differ by this one code and by nothing else, in the direction
-- of the database being narrower. Nothing here widens the engine to match a
-- database, which would be the dangerous half of the same repair.
--
-- Note for whoever reads 0012 next: its blocks DELETE any grant not in their
-- literal list, so re-running that file would remove these four rows again.
-- The lists there are the seed of the day they were written; this is the
-- current word on the four agent roles.

insert into public.role_permissions (role_id, permission_code)
select r.id, 'approval.request'
from public.roles r
where r.organization_id is null
  and r.is_system
  and r.code in ('referral_agent', 'sales_agent', 'senior_agent', 'agency_manager')
on conflict do nothing;


-- ============================================================================
-- 2 · …and asking is not the same as answering
-- ============================================================================
-- Found while rehearsing section 1, and it is section 1's problem rather than
-- a separate one: before the grant above, an agent could not insert an
-- approval at all and therefore could never reach this. Shipping section 1
-- alone would have handed every agent in the product a way to approve their
-- own discount.
--
-- ── What the old policy admitted ────────────────────────────────────────────
--
--   `approvals_update` from 0011 admits `approval.decide` OR
--   `requested_by = auth.uid()`, on both the USING and the WITH CHECK side.
--   The comment above it says "withdrawing your own request is not a decision
--   and needs only the right to have made it", which is the right rule — but
--   the predicate does not say it. It admits the requester whatever they are
--   changing the status *to*.
--
--   `approvals_no_self_approval` looks like the backstop and is not.
--   `tg_approvals_stamp_decision` fills `decided_by` with
--   `coalesce(new.decided_by, auth.uid())`, so a requester who names somebody
--   else as the decider satisfies `decided_by <> requested_by` and the row
--   commits as approved, attributed to a person who never saw it. Rehearsed
--   against the live database: the update matched one row.
--
-- ── The rule, now written down ──────────────────────────────────────────────
--
--   Leaving a row in a *decided* state requires `approval.decide`. A requester
--   keeps every other transition — `withdrawn` above all, which is the one the
--   0011 comment was protecting, and `expired`, which nobody decides.
--
--   Expressed on WITH CHECK, which sees the row as it will be. A policy cannot
--   compare OLD with NEW, and it does not need to: what matters is not which
--   status it came from but that nobody without the right to decide may leave
--   an approval sitting in a decided state.
--
--   src/lib/agents/operations.ts already declares `permission:
--   'approval.decide'` on the decide operation, so this takes nothing from any
--   path the product actually uses. It brings the floor onto the engine, which
--   is what the whole file is for.

drop policy if exists approvals_update on public.approvals;
create policy approvals_update on public.approvals
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      property_id is null
      or public.property_in_scope(property_id, organization_id)
    )
    and (
      public.has_permission(organization_id, 'approval.decide')
      or requested_by = (select auth.uid())
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'approval.decide')
      or (
        requested_by = (select auth.uid())
        and status not in ('approved'::public.approval_status,
                           'rejected'::public.approval_status)
      )
    )
  );

comment on policy approvals_update on public.approvals is
  'Deciding is approval.decide. Withdrawing your own request is not a decision and needs only the right to have made it — but leaving the row approved or rejected is, whoever is named as the decider, which is the hole a requester could otherwise walk through by filling in decided_by themselves.';


-- ============================================================================
-- 3 · An agent's membership can hold the reach it was given
-- ============================================================================
-- `Actor.scope` comes from `membership_scopes`, and `attachExistingUser` in
-- src/lib/persistence/agents.ts wrote a membership, its role and its terms and
-- no scope row at all. Every agent in the product therefore resolved to the
-- `own_records` fallback in src/lib/actor/resolve.ts — which reaches no
-- property and no unit, because neither carries an assignee — while the
-- inventory reach an owner configured sat in `agent_organization_settings`
-- being read by nothing.
--
-- The repair is that the adapter now writes the row. This migration is what
-- lets the person who runs the agent network write it.
--
-- ── Why the existing policy is not enough ───────────────────────────────────
--
--   `membership_scopes_insert` and `_update` from 0004 require `role.assign`.
--   0025 explains at length why the agent network manager must not be handed
--   that: it guards every membership in the organization, so whoever runs the
--   sellers could re-scope an administrator. `general_manager` holds
--   `agent.scope.manage` and not `role.assign`, so without this section the
--   attach would fail for exactly the caller 0025 exists to admit — and it
--   would fail loudly, because the adapter treats a refused scope write as
--   fatal rather than returning an agent who reaches nothing.
--
-- ── The narrowing, in the shape 0025 established ────────────────────────────
--
--   1. `agent.scope.manage` and not `agent.membership.manage`. The two reach
--      the same three roles today, and the catalogue describes this one as the
--      permission that decides an agent's blast radius. A policy named for
--      what it does survives the next role that holds only one of them.
--   2. only a membership that has agent terms — so this reaches no employee;
--   3. never a membership holding elevated authority, so an administrator who
--      is also an agent stays out of reach, which is the case a rule written
--      as "not the owner" would have missed;
--   4. never `team`. An agent's reach is derived from `AgentInventoryScope`,
--      which has three variants and no team among them; `own_records` is the
--      fourth value the adapter writes, for a reach the table cannot hold.
--      A team scope on an agent could only come from somewhere that is not the
--      agent domain, and there is no reason to admit it here.
--   5. additive. Both policies are new and permissive, `role.assign` keeps
--      every path it had, and nobody loses anything.
--
-- ── Why the adapter writes the scope last ───────────────────────────────────
--
--   `is_agent_membership` is true only once `agent_organization_settings`
--   holds a row, so the scope cannot be written beside the membership the way
--   the preset role is. `attachExistingUser` therefore writes the terms first
--   and the scope after them, and a unit test pins that order.

drop policy if exists membership_scopes_insert_agent on public.membership_scopes;
create policy membership_scopes_insert_agent on public.membership_scopes
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.scope.manage')
    and public.is_agent_membership(membership_id)
    and not public.membership_holds_elevated_authority(membership_id)
    and kind <> 'team'
  );

comment on policy membership_scopes_insert_agent on public.membership_scopes is
  'Record the inventory an agent may sell, as the grant their actor resolves from. Only a membership that has agent terms, never one holding elevated authority, and never a team scope.';

drop policy if exists membership_scopes_update_agent on public.membership_scopes;
create policy membership_scopes_update_agent on public.membership_scopes
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.scope.manage')
    and public.is_agent_membership(membership_id)
    and not public.membership_holds_elevated_authority(membership_id)
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent.scope.manage')
    and public.is_agent_membership(membership_id)
    and not public.membership_holds_elevated_authority(membership_id)
    and kind <> 'team'
  );

comment on policy membership_scopes_update_agent on public.membership_scopes is
  'Follow the terms when an owner narrows or widens an agent on the settings screen. Without it the scope row would go stale the first time somebody edited the reach, which is the same defect one level down.';


-- ============================================================================
-- 4 · Drift fails loudly
-- ============================================================================
-- The guard 0012 and 0025 carry, with the numbers of today. The four agent
-- figures are the ones this migration moved, and they are asserted rather than
-- described so that a future edit of either list has to come back here.
--
-- These match grantsForSystemRole() in src/lib/authz/roles.ts exactly, which
-- was verified role by role against the live database before this file was
-- written: sixteen of the twenty system roles agreed byte for byte, and the
-- four below disagreed by `approval.request` alone.

do $$
declare
  action_count integer;
  field_count  integer;
  owner_count  integer;
  admin_count  integer;
  gm_count     integer;
  ref_count    integer;
  sales_count  integer;
  senior_count integer;
  agency_count integer;

  function_missing text;
begin
  select count(*) into action_count from public.permissions where kind = 'action';
  select count(*) into field_count  from public.permissions where kind = 'field';
  if action_count <> 134 or field_count <> 13 then
    raise exception
      'permission catalogue drift: expected 134 action and 13 field permissions, found % and %',
      action_count, field_count;
  end if;

  select count(*) into owner_count  from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'organization_owner' and r.organization_id is null;
  select count(*) into admin_count  from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'administrator'      and r.organization_id is null;
  select count(*) into gm_count     from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'general_manager'    and r.organization_id is null;
  select count(*) into ref_count    from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'referral_agent'     and r.organization_id is null;
  select count(*) into sales_count  from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'sales_agent'        and r.organization_id is null;
  select count(*) into senior_count from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'senior_agent'       and r.organization_id is null;
  select count(*) into agency_count from public.role_permissions rp join public.roles r on r.id = rp.role_id
   where r.code = 'agency_manager'     and r.organization_id is null;

  -- 142 / 138 / 90 are unchanged from 0025 and are here as the control: this
  -- migration touched four roles and must not have touched a fifth.
  if owner_count <> 142 or admin_count <> 138 or gm_count <> 90 then
    raise exception
      'derived role drift: expected owner 142, administrator 138, general_manager 90; found %, %, %',
      owner_count, admin_count, gm_count;
  end if;

  -- 4/19/27/35 before this file, 5/20/28/36 after it, and the same four
  -- numbers grantsForSystemRole() resolves to in code.
  if ref_count <> 5 or sales_count <> 20 or senior_count <> 28 or agency_count <> 36 then
    raise exception
      'agent preset drift: expected referral 5, sales 20, senior 28, agency 36; found %, %, %, %',
      ref_count, sales_count, senior_count, agency_count;
  end if;

  -- A policy naming a permission no role holds admits nobody, silently. 0011
  -- made exactly that mistake with the commission codes and said so.
  if not exists (
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    where r.code = 'general_manager' and r.organization_id is null
      and rp.permission_code = 'agent.scope.manage'
  ) then
    raise exception
      'general_manager does not hold agent.scope.manage; the membership_scopes policies above would admit nobody';
  end if;

  -- Both policies call 0025's helpers. A missing one is a 42883 at request
  -- time, on the path that admits an agent to the product.
  select string_agg(name, ', ') into function_missing
  from (values ('is_agent_membership'), ('membership_holds_elevated_authority')) as f(name)
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = f.name
  );

  if function_missing is not null then
    raise exception '0025 helpers missing: %', function_missing;
  end if;
end $$;
