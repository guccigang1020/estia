-- ============================================================================
-- 0069_teams_and_custom_roles.sql — ESTIA · the two tables nobody could write
--
-- ── What was actually wrong ────────────────────────────────────────────────
--
-- `public.teams` has existed since 0008 with policies, indexes and two foreign
-- keys pointing at it — `memberships.team_id` and the `team` variant of
-- `membership_scopes` — and no code path in the product ever inserted a row.
-- Team-scoped permission was therefore a shape in the schema that no customer
-- could reach: to scope somebody to a team you first need a team, and there
-- was no way to make one.
--
-- `public.roles` had the same hole on the customer side. Every row in it is
-- seeded by 0002 and 0012; `roles_insert` has always admitted a custom role,
-- `custom_roles` is sold in the Management plan (0003), and nothing in the
-- product ever created one. A paid feature with no code behind it.
--
-- This migration does not create either table. It adds the guards that make
-- writing to them safe, and the one privileged door a write genuinely needs.
--
-- ══ CAN THE DATABASE ENFORCE "A ROLE MAY NOT GRANT MORE THAN ITS AUTHOR
--    HOLDS"?  YES — AND IT DOES, BELOW. ═════════════════════════════════════
--
-- Stated plainly because the answer is usually "no" and here it is "yes".
--
-- The rule is enforceable in SQL because the database already owns both halves
-- of the comparison: `public.has_permission(organization_id, code)` answers
-- "does the CALLER hold this grant" from `memberships → membership_roles →
-- role_permissions`, and the row being inserted names the grant being handed
-- out. So `tg_role_permission_within_reach` below asks, for every single row
-- written into `role_permissions`, whether the caller holds that exact grant,
-- and refuses with 42501 when they do not.
--
-- That closes the real attack rather than a hypothetical one. `permission.edit`
-- is itself a grantable permission: an owner may put it into a custom role and
-- hand that role to a manager. From that moment the manager can edit role
-- grants while holding perhaps a tenth of the catalogue — and without this
-- trigger they could mint a role carrying `organization.settings.edit`,
-- `payment.refund` or `organization.billing.manage`, assign it to themselves,
-- and hold it. Row level security cannot see that: `role_permissions_insert`
-- checks that the caller holds `permission.edit`, which by then is true.
--
-- ── The one gap, named rather than hidden ─────────────────────────────────
--
-- The trigger lets a caller with no `auth.uid()` through. That is not a
-- loophole left for convenience — it is the seeding path: 0002 and 0012 insert
-- the system roles' grants as the migration role, where there is no caller to
-- compare against and `has_permission` is empty by construction, so every
-- seed row would be refused. The set of callers with no `auth.uid()` is
-- exactly {migrations, the service role}, and this codebase's standing rule is
-- that a service-role client never appears in a request path. Nothing reachable
-- from a browser arrives here without a JWT.
--
-- The application floor above this — `assertGrantable` in
-- `src/lib/authz/grantable.ts` — asks the same question against the resolved
-- `Actor`, so a refusal reaches the person as Hebrew naming the grants they
-- tried to hand out rather than as a Postgres error code. Both floors, as
-- always: neither is a substitute for the other.
--
-- ── What else is here ─────────────────────────────────────────────────────
--
--   · `tg_roles_system_is_read_only` — a system role (`is_system`,
--     `organization_id is null`) can never be edited or deleted by a signed-in
--     caller, and a custom role can never be mutated INTO one. The catalogue
--     in `src/lib/authz/roles.ts` is the source of truth for those, and 0002's
--     seed is the only thing entitled to write them.
--
--   · `assign_membership_to_team` — one SECURITY DEFINER function so that
--     moving somebody between teams does not require `user.edit`. Argued at
--     length at its own definition.
--
-- Depends on 0001 (memberships), 0002 (roles, role_permissions), 0004
-- (my_organizations, has_permission), 0008 (teams).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- The escalation floor
-- ============================================================================

-- Deliberately NOT security definer. The trigger runs as the caller, so
-- `public.roles` is read through `roles_select` — which admits the global
-- catalogue and the caller's own organizations and nothing else. A role id
-- belonging to a third organization therefore reads as NULL here and lands in
-- the refusal below, which is the right answer for a reason the function does
-- not have to know.
--
-- `search_path` is pinned anyway: an unqualified name in a trigger body is a
-- redirection waiting to be found, whether or not the function is privileged.
create or replace function public.tg_role_permission_within_reach()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_role_id   uuid;
  v_org       uuid;
  v_is_system boolean;
begin
  -- NEW is unassigned in a DELETE trigger and OLD is unassigned in an INSERT,
  -- so every reference to either is reached through TG_OP. `coalesce(new, old)`
  -- would read the unassigned one and raise before any rule was applied.
  if tg_op = 'DELETE' then
    v_role_id := old.role_id;
  else
    v_role_id := new.role_id;
  end if;

  -- The seeding path. See the header: there is no caller to compare against,
  -- and this branch is unreachable from a request because every request
  -- carries a JWT.
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select r.organization_id, r.is_system
    into v_org, v_is_system
    from public.roles r
   where r.id = v_role_id;

  -- Not found, a system role, or a platform role: all three answer the same
  -- way. `is_system` implies `organization_id is null` by
  -- `roles_system_is_global`, so a role with no organization is either one of
  -- ESTIA's or one this caller may not read.
  if v_org is null or coalesce(v_is_system, true) then
    raise exception
      'role % is not a custom role of an organization you may edit', v_role_id
      using errcode = '42501';
  end if;

  -- Removing a grant narrows a role, so there is nothing to escalate. The
  -- system-role refusal above still applies to a DELETE, which is the half
  -- that matters: nobody signed in may strip a grant off `cleaner`.
  if tg_op = 'DELETE' then
    return old;
  end if;

  -- THE RULE. Asked per row, against the caller's own grants.
  if not public.has_permission(v_org, new.permission_code) then
    raise exception
      'you do not hold %, so a role you author may not grant it',
      new.permission_code
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.tg_role_permission_within_reach() is
  'Refuses any grant written into role_permissions that the CALLER does not themselves hold, so a custom role can never carry more authority than the person composing it. Row level security cannot express this: it admits the write on the strength of permission.edit, which the escalating caller has by then. Callers with no auth.uid() (migrations, the service role) are exempt because that is the seed path — see the header of 0069_teams_and_custom_roles.sql.';

-- Fires after `role_permissions_grantable` (0002), which refuses platform.*
-- grants on customer roles. Two triggers, two different rules, and the
-- alphabetical firing order is not relied on by either.
drop trigger if exists role_permissions_within_reach on public.role_permissions;
create trigger role_permissions_within_reach
  before insert or update or delete on public.role_permissions
  for each row execute function public.tg_role_permission_within_reach();


-- ============================================================================
-- A system role is read-only, forever
-- ============================================================================
--
-- `roles_update` and `roles_delete` already carry `is_system = false`, so for
-- `authenticated` this is the second floor rather than the first. It is worth
-- having because the two rules are separable: a future policy edit that
-- widened the update policy would silently make sixteen shipped roles editable,
-- and the grants of those roles do not even live in this table — they are
-- derived in `grantsForSystemRole()`. A screen offering to edit them would be
-- offering to edit something the engine does not read.

create or replace function public.tg_roles_system_is_read_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The seed path again: 0002 upserts the eighteen system roles, and 0012 and
  -- 0035 update them when the catalogue grows. TG_OP rather than
  -- `coalesce(new, old)`, because the unassigned one of the pair raises when
  -- it is read.
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'a system role cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.is_system or new.is_platform then
      raise exception
        'a system role is shipped by ESTIA and cannot be created by a customer'
        using errcode = '42501';
    end if;
    if new.organization_id is null then
      raise exception 'a custom role must belong to an organization'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.is_system then
    raise exception 'a system role cannot be edited' using errcode = '42501';
  end if;

  -- A custom role may not be mutated into a system one, moved to another
  -- tenant, or promoted to ESTIA staff. Each of these would be an escalation
  -- dressed as an ordinary rename.
  if new.is_system or new.is_platform
     or new.organization_id is distinct from old.organization_id then
    raise exception
      'a custom role cannot change its organization or become a system role'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.tg_roles_system_is_read_only() is
  'A role with is_system is ESTIA''s: never edited, never deleted, never created by a customer, and a custom role can never be mutated into one. The grants of those roles are derived in src/lib/authz/roles.ts rather than stored here, so editing the row would change the label and not the authority.';

drop trigger if exists roles_system_is_read_only on public.roles;
create trigger roles_system_is_read_only
  before insert or update or delete on public.roles
  for each row execute function public.tg_roles_system_is_read_only();


-- ============================================================================
-- Moving somebody between teams
-- ============================================================================
--
-- ── Why this is a function and not an UPDATE ───────────────────────────────
--
-- `memberships_update` (0004) admits a caller holding `user.edit`, which is
-- correct for the table: `memberships` carries everybody's status, employment
-- type and landing property, and editing those is organization-wide authority.
--
-- But putting a cleaner into the housekeeping crew is `team.manage`, and the
-- people who hold `team.manage` mostly do not hold `user.edit` — an operations
-- manager and a general manager both hold the first and neither holds the
-- second. So the feature had two possible shapes:
--
--   · widen `memberships_update` to admit `team.manage`. That hands an
--     operations manager the right to change an administrator's STATUS, which
--     is a far larger authority than the one being asked for. The policy would
--     have been weakened to make a feature work, which this codebase does not
--     do — and 0025 already refused the same trade for the agent network.
--   · one SECURITY DEFINER function that can change exactly one column.
--
-- This is the second. It narrows rather than widens: nothing reachable through
-- it can touch `status`, `employment_type` or anything else on the row.
--
-- SECURITY DEFINER means row level security is bypassed inside the body, so
-- the membership check here is not belt-and-braces — it is the only tenant
-- boundary left. `search_path` is pinned to '' and every reference is
-- schema-qualified, exactly as in 0061.

create or replace function public.assign_membership_to_team(
  p_membership_id uuid,
  p_team_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if p_membership_id is null then
    raise exception 'a membership is required' using errcode = '42501';
  end if;

  select m.organization_id into v_org
    from public.memberships m
   where m.id = p_membership_id;

  -- "No such membership" and "not your organization" answer identically, for
  -- the reason 0033 and 0066 give: a refusal that distinguishes them is an
  -- oracle for probing which ids exist.
  if v_org is null or v_org not in (select public.my_organizations()) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  if not public.has_permission(v_org, 'team.manage') then
    raise exception 'team.manage is required to move somebody between teams'
      using errcode = '42501';
  end if;

  -- NULL is a legitimate argument: it takes somebody out of every team. A
  -- named team must exist, belong to this organization, and not be archived —
  -- assigning into an archived team is how an archive quietly refills.
  if p_team_id is not null and not exists (
    select 1
      from public.teams t
     where t.id = p_team_id
       and t.organization_id = v_org
       and t.deleted_at is null
  ) then
    raise exception 'no such team in this organization' using errcode = '42501';
  end if;

  update public.memberships
     set team_id = p_team_id,
         updated_by = (select auth.uid())
   where id = p_membership_id;
end;
$$;

comment on function public.assign_membership_to_team(uuid, uuid) is
  'Sets memberships.team_id and nothing else. Exists so that team.manage is enough to move somebody between teams without widening memberships_update, which is written around user.edit because that table carries the status of everybody in the organization. SECURITY DEFINER, so membership and team.manage are checked EXPLICITLY inside — they are the only tenant boundary once row level security is bypassed.';

-- `anon` is named, and that is not redundant with FROM PUBLIC: Supabase ships
-- ALTER DEFAULT PRIVILEGES granting EXECUTE on every new function in `public`
-- to anon individually, and a revoke from PUBLIC leaves that grant standing.
revoke all on function public.assign_membership_to_team(uuid, uuid)
  from public, anon;
grant execute on function public.assign_membership_to_team(uuid, uuid)
  to authenticated, service_role;


-- ============================================================================
-- Indexes the new screens read through
-- ============================================================================

-- The teams panel counts how many people are in each team, and the archive
-- refusal asks whether any remain. `memberships_team_idx` (0004) covers the
-- lookup by team; this covers the roster's own narrowing.
create index if not exists memberships_organization_team_idx
  on public.memberships (organization_id, team_id)
  where team_id is not null;

-- The role editor reads a custom role's grants by role. `role_permissions_pkey`
-- leads on `role_id`, so the forward direction is already covered; this is the
-- one the delete refusal uses, counting holders of a role about to be removed.
-- `membership_roles_role_idx` (0004) already exists for it — named here so a
-- reader of this file does not go looking.


-- ============================================================================
-- Rehearsal
-- ============================================================================
--
-- Exercised, not asserted. Every guard below is RUN against a throwaway
-- organization and a fabricated caller, and the whole thing is unwound.
--
-- The caller is fabricated on purpose: `auth.uid()` reads a JWT claim, so a
-- `sub` that matches no `auth.users` row is enough to leave the seed path and
-- enter the enforcing branch — which is precisely the branch that has to be
-- proven. `has_permission` then answers false for everything, which is the
-- position of every escalating caller at the moment they try.

do $$
declare
  v_cfg      text;
  v_pinned   integer;
  v_org      uuid;
  v_role     uuid;
  v_system   uuid;
  v_held     text;
  v_unheld   text;
  v_caller   text := '11111111-1111-4111-8111-111111111111';
begin
  -- ── Bookkeeping ──────────────────────────────────────────────────────────
  -- Counted as well as inspected. A loop over a query that returns nothing
  -- passes silently, which would let a renamed function look like a pinned one.
  v_pinned := 0;

  for v_cfg in
    select array_to_string(p.proconfig, ',')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('tg_role_permission_within_reach',
                         'tg_roles_system_is_read_only',
                         'assign_membership_to_team')
  loop
    if v_cfg is null or v_cfg not like '%search_path=%' then
      raise exception 'a 0069 function has a mutable search_path';
    end if;
    v_pinned := v_pinned + 1;
  end loop;

  if v_pinned <> 3 then
    raise exception
      'expected three 0069 functions with a pinned search_path, found %', v_pinned;
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
     where routine_schema = 'public'
       and routine_name = 'assign_membership_to_team'
       and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon may move people between teams';
  end if;

  -- The tenant guard of the team door, run as the migration role: there is no
  -- `auth.uid()`, so `my_organizations()` is empty and every id is foreign.
  -- If this ever stops raising, the function has stopped checking membership.
  begin
    perform public.assign_membership_to_team(
      '00000000-0000-4000-8000-000000000000'::uuid, null);
    raise exception 'the team door accepted a membership in nobody organization';
  exception
    when insufficient_privilege then null;
  end;

  select r.id into v_system
    from public.roles r
   where r.code = 'cleaner' and r.organization_id is null;

  if v_system is null then
    raise exception 'the cleaner system role is missing, so 0002 did not run';
  end if;

  -- One grant the role holds and one it does not, both discovered rather than
  -- typed. A hardcoded code would turn "0012 adjusted the cleaner's grants"
  -- into a migration that fails for a reason unrelated to what it is testing.
  select rp.permission_code into v_held
    from public.role_permissions rp
   where rp.role_id = v_system
   limit 1;

  select p.code into v_unheld
    from public.permissions p
   where not p.is_platform
     and not exists (
       select 1 from public.role_permissions rp
        where rp.role_id = v_system and rp.permission_code = p.code
     )
   limit 1;

  if v_held is null or v_unheld is null then
    raise exception 'the cleaner role has no grants, or holds every permission';
  end if;

  -- ── The guards, run against a real row ───────────────────────────────────
  begin
    insert into public.organizations (slug, name)
    values ('rehearsal-0069-must-not-survive', 'רפטיציה 0069')
    returning id into v_org;

    -- Created with no caller, which is the seed path and must be allowed.
    insert into public.roles (organization_id, code, name, is_system)
    values (v_org, 'rehearsal_role', 'תפקיד רפטיציה', false)
    returning id into v_role;

    -- From here on there IS a caller, and they hold nothing anywhere.
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_caller, 'role', 'authenticated')::text, true);

    -- 1. The escalation rule itself. The caller holds no grant in v_org, so
    --    every grant is beyond their reach — including a mild one.
    begin
      insert into public.role_permissions (role_id, permission_code)
      values (v_role, 'organization.settings.edit');
      raise exception
        'a role was granted organization.settings.edit by somebody without it';
    exception
      when insufficient_privilege then null;
    end;

    -- 2. A system role's grants are not editable by a signed-in caller.
    begin
      insert into public.role_permissions (role_id, permission_code)
      values (v_system, v_unheld);
      raise exception 'a system role accepted a new grant';
    exception
      when insufficient_privilege then null;
    end;

    begin
      delete from public.role_permissions
       where role_id = v_system and permission_code = v_held;
      raise exception 'a grant was stripped off a system role';
    exception
      when insufficient_privilege then null;
    end;

    -- 3. A system role is neither editable nor deletable.
    begin
      update public.roles set name = 'לא' where id = v_system;
      raise exception 'a system role was renamed';
    exception
      when insufficient_privilege then null;
    end;

    begin
      delete from public.roles where id = v_system;
      raise exception 'a system role was deleted';
    exception
      when insufficient_privilege then null;
    end;

    -- 4. A custom role cannot be promoted into a system one.
    begin
      update public.roles set is_system = true, organization_id = null
       where id = v_role;
      raise exception 'a custom role promoted itself to a system role';
    exception
      when insufficient_privilege then null;
    end;

    -- Everything above happened inside this block, which plpgsql runs as a
    -- subtransaction. Raising unwinds all of it, so the rehearsal leaves no
    -- organization and no role behind.
    raise exception 'ESTIA_REHEARSAL_ROLLBACK';
  exception
    when others then
      perform set_config('request.jwt.claims', '', true);
      if sqlerrm <> 'ESTIA_REHEARSAL_ROLLBACK' then raise; end if;
  end;

  perform set_config('request.jwt.claims', '', true);

  if exists (
    select 1 from public.organizations
     where slug = 'rehearsal-0069-must-not-survive'
  ) then
    raise exception 'the rehearsal left an organization behind';
  end if;
end $$;
