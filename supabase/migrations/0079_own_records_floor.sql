-- ============================================================================
-- 0079_own_records_floor.sql — ESTIA · the second floor, for records
--
-- ── The exposure ───────────────────────────────────────────────────────────
--
-- An external sales agent could read every other agent's bookings, commissions
-- and leads by querying PostgREST directly.
--
-- The chain, every link verified against the live catalogue:
--
--   1. `lifecycle.ts` gives every agent `scope: { kind: 'own_records' }`.
--   2. `AGENT_BASE` in `roles.ts` grants `lead.view`, `commission.view` and
--      `agent_statement.view` to EVERY agent preset; the selling presets add
--      `booking.view`.
--   3. `property_in_scope()` returns TRUE for `own_records` — deliberately.
--   4. `bookings_select`, `commissions_select`, `leads_select` and
--      `holds_select` are `tenant AND property_in_scope AND has_permission`.
--
-- So at the database floor an agent's scope narrowed nothing, and the three
-- clauses that were meant to protect a rival's deal all passed.
--
-- `can()` refuses correctly — `isWithinScope` returns false for a record the
-- caller neither owns nor created, and `src/lib/agents/isolation.test.ts`
-- proves it on the booking, commission, lead, statement and export paths. But
-- an agent holds a browser session and the publishable key is public by
-- design, so `can()` is not the only door: a request straight to PostgREST
-- never passes through it.
--
-- The architecture's premise is TWO INDEPENDENT FLOORS. One of them was not
-- there for these four tables.
--
-- ── WHY 0008 IS NOT WRONG, AND WHAT IT ACTUALLY SAID ═══════════════════════
--
-- `property_in_scope()` returning true for `own_records` is correct and stays.
-- Its own comment gives the reason and also names the other half of the deal:
--
--   "`team` and `own_records` narrow *records* … and a property carries
--    neither. … The narrowing for those two scopes happens on the task, the
--    booking assignment and the checklist — records that do carry the field —
--    and it is can() that does it."
--
-- The first half was built. The second half — the narrowing on the records
-- that DO carry the field — was never written into the policies. This is that
-- half, and it is written where the comment says it belongs.
--
-- ── IT MIRRORS `can()` AND INVENTS NOTHING ═════════════════════════════════
--
-- `src/lib/authz/can.ts`:
--
--     case 'own_records':
--       return resource.assignedToUserId === userId
--           || resource.createdByUserId === userId
--
-- Two owners, either one. `record_in_scope` below is that sentence in SQL, and
-- a second opinion about what "own" means is the one thing this must not be.
--
-- Per table, which column plays which part:
--   bookings     → agent_user_id (assigned), created_by
--   commissions  → agent_user_id (assigned), created_by
--   leads        → assigned_to_user_id, agent_user_id, created_by
--   holds        → held_by_user_id (assigned), created_by
--
-- ── WHO THIS DOES NOT TOUCH ════════════════════════════════════════════════
--
-- Nobody whose scope row is anything other than `own_records`, which is every
-- ordinary employee: the first workspace owner is written an explicit
-- `all_organization` row by `create_first_workspace` (0064), and staff roles
-- are scoped to properties or units.
--
-- Cleaners and maintenance hold no `booking.view` at all (`roles.ts`), so the
-- bookings policy already refused them before this migration and refuses them
-- after it, for the same reason.
--
-- And it takes nothing away that `can()` was granting: for every row this now
-- hides, the application engine was already returning false. The two floors
-- disagreed, the database was the permissive one, and this is them agreeing.
--
-- ── ONE DIVERGENCE LEFT STANDING, DELIBERATELY ═════════════════════════════
--
-- A member with NO scope row is treated as organization-wide by the database
-- (`s.id is null` in `property_in_scope`) and as `own_records` by
-- `resolve.ts:118`, which falls back so a missing row cannot lock a real
-- employee out. This migration narrows only on an EXPLICIT `own_records` row
-- and leaves the no-row case as it was.
--
-- That is a smaller divergence of the same family and it is named rather than
-- quietly closed: changing it means knowing who currently has no scope row,
-- and there is no organization on this database to ask. Recorded in
-- OPEN_GAPS.md instead of guessed at here.
--
-- Depends on 0002 (memberships, membership_scopes), 0008 (`property_in_scope`),
-- 0009 (bookings, holds), 0012 (commissions), 0074 (leads).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The narrowing, in one place
-- ============================================================================

create or replace function public.record_in_scope(
  target_organization_id uuid,
  owner_assigned         uuid,
  owner_created          uuid,
  owner_extra            uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    -- Not narrowed at all unless the caller carries an EXPLICIT own_records
    -- scope in this organization. Everything else — all_organization,
    -- properties, units, team, and a member with no scope row — passes
    -- through untouched, so this can only ever remove rows from the one
    -- scope that was always supposed to be narrow.
    not exists (
      select 1
      from public.memberships m
      join public.membership_scopes s on s.membership_id = m.id
      where m.user_id = (select auth.uid())
        and m.status = 'active'::public.membership_status
        and m.organization_id = record_in_scope.target_organization_id
        and s.kind = 'own_records'::public.membership_scope_kind
    )
    -- `coalesce` per comparison, not around the whole disjunction: a NULL
    -- owner column must read as "not mine", and `x = null` is NULL rather
    -- than false. Without this an unassigned row would be visible to
    -- everybody under the one scope meant to see almost nothing.
    or coalesce(owner_assigned = (select auth.uid()), false)
    or coalesce(owner_created  = (select auth.uid()), false)
    or coalesce(owner_extra    = (select auth.uid()), false);
$$;

comment on function public.record_in_scope(uuid, uuid, uuid, uuid) is
  'Does the caller''s scope reach this RECORD? Mirrors the own_records branch of isWithinScope() in src/lib/authz/can.ts: assigned-to or created-by, either one. Returns true unchanged for every other scope kind, so it narrows only the scope that was always meant to be narrow. Companion to property_in_scope(), which deliberately does NOT narrow for own_records because a property carries no owner.';

revoke all on function public.record_in_scope(uuid, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.record_in_scope(uuid, uuid, uuid, uuid)
  to authenticated, service_role;


-- ============================================================================
-- 2 · The four policies
-- ============================================================================
-- Each keeps every clause it had and gains one. Rewritten in full rather than
-- patched, because a policy is replaced wholesale and half of one is not a
-- thing Postgres will hold.

drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view')
    and public.record_in_scope(organization_id, agent_user_id, created_by)
  );

drop policy if exists commissions_select on public.commissions;
create policy commissions_select on public.commissions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'commission.view')
    and public.record_in_scope(organization_id, agent_user_id, created_by)
  );

-- Leads carry three owners: the person it is assigned to, the agent who
-- brought it, and whoever typed it in. All three count, because all three are
-- "theirs" in the sentence a person would say.
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      property_id is null
      or public.property_in_scope(property_id, organization_id)
    )
    and public.has_permission(organization_id, 'lead.view')
    and public.record_in_scope(
          organization_id, assigned_to_user_id, created_by, agent_user_id)
  );

-- A hold is the one that leaks a rival's intent rather than their money:
-- `held_by_user_id` on somebody else's hold says which agent is mid-deal on
-- which nights, which is exactly what `agentAvailabilityCalendar` collapses to
-- `unavailable` so that an external seller cannot learn it.
drop policy if exists holds_select on public.holds;
create policy holds_select on public.holds
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.unit_in_scope(unit_id, property_id, organization_id)
    and public.has_permission(organization_id, 'booking.view')
    and public.record_in_scope(organization_id, held_by_user_id, created_by)
  );


-- ============================================================================
-- 3 · The rehearsal
-- ============================================================================
-- The policies cannot be exercised from here: this runs as the migration role,
-- which bypasses row level security. What CAN be exercised, and is, is the
-- whole of the new decision — `record_in_scope` is where every bit of the
-- narrowing lives, and the policies are one call each.
--
-- So the block below sets a real session, gives it a real own_records
-- membership, and runs the function against rows it owns and rows it does not.

do $$
declare
  v_uid     uuid;
  v_other   uuid := '00000000-0000-4000-8000-0000000000ff';
  v_org     uuid;
  v_member  uuid;
  v_cfg     text;
  v_n       integer;
begin
  /* The function is pinned. */

  select coalesce(array_to_string(p.proconfig, ','), '') into v_cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_in_scope';
  if v_cfg is null or v_cfg not like '%search_path=%' then
    raise exception 'record_in_scope has a mutable search_path';
  end if;

  /* All four policies actually call it. A policy that forgot would leave the
     table exactly as exposed as it was, and would look fixed. */

  select count(*) into v_n
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('bookings', 'commissions', 'leads', 'holds')
     and p.polname in ('bookings_select', 'commissions_select',
                       'leads_select', 'holds_select')
     and pg_get_expr(p.polqual, p.polrelid) like '%record_in_scope%';
  if v_n <> 4 then
    raise exception
      'expected four policies narrowed by record_in_scope, found %', v_n;
  end if;

  /* ── The decision, run against a real membership ───────────────────────── */

  select id into v_uid from auth.users
   where email_confirmed_at is not null order by created_at limit 1;

  if v_uid is null then
    raise notice
      'no confirmed user exists, so record_in_scope was NOT exercised';
  else
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
      true);

    v_org := public.create_first_workspace(
      'rehearsal-0079-must-not-survive', 'רפטיציה 0079',
      'villa'::public.organization_business_type, 'Asia/Jerusalem');

    select id into v_member from public.memberships
     where organization_id = v_org and user_id = v_uid;

    /* 1. As created — an `all_organization` scope row from 0064 — nothing is
          narrowed, including a row owned by somebody else entirely. */

    if not public.record_in_scope(v_org, v_other, v_other) then
      raise exception
        'an all_organization member was narrowed out of another person''s row';
    end if;

    /* 2. Now narrow the very same membership to own_records. */

    update public.membership_scopes
       set kind = 'own_records'::public.membership_scope_kind
     where membership_id = v_member;

    -- Somebody else's row, on both owner columns. This is the exposure.
    if public.record_in_scope(v_org, v_other, v_other) then
      raise exception
        'an own_records member can still read another agent''s record';
    end if;

    -- Assigned to them.
    if not public.record_in_scope(v_org, v_uid, v_other) then
      raise exception 'an own_records member cannot read their own record';
    end if;

    -- Created by them, assigned to nobody.
    if not public.record_in_scope(v_org, null, v_uid) then
      raise exception 'an own_records member cannot read what they created';
    end if;

    -- The third owner column, which only leads use.
    if not public.record_in_scope(v_org, v_other, v_other, v_uid) then
      raise exception 'the third owner column does not count as ownership';
    end if;

    -- An unassigned, unattributed row is NOT everybody's. This is the null
    -- comparison the coalesce above exists for, and getting it wrong would
    -- have made every orphan row visible under the narrowest scope there is.
    if public.record_in_scope(v_org, null, null) then
      raise exception 'a row owned by nobody was visible under own_records';
    end if;

    /* 3. A different organization's row is not reached either — the narrowing
          asks about membership IN THAT ORGANIZATION, so a person holding
          own_records here must not be widened by a scope they hold elsewhere. */

    if public.record_in_scope(
         '00000000-0000-4000-8000-000000000000'::uuid, v_other, v_other)
    then
      -- Not a failure of this function on its own: the tenant clause in every
      -- policy already refuses a foreign organization. Asserted so that the
      -- narrowing is never mistaken for the tenant boundary.
      raise notice
        'record_in_scope does not narrow for a foreign organization — the '
        'tenant clause in each policy is what refuses it';
    end if;

    raise exception 'ESTIA_REHEARSAL_ROLLBACK';
  exception
    when others then
      perform set_config('request.jwt.claims', '', true);
      if sqlerrm <> 'ESTIA_REHEARSAL_ROLLBACK' then raise; end if;
  end;
  end if;

  perform set_config('request.jwt.claims', '', true);

  if exists (
    select 1 from public.organizations
     where slug = 'rehearsal-0079-must-not-survive'
  ) then
    raise exception 'the rehearsal left an organization behind';
  end if;
end $$;
