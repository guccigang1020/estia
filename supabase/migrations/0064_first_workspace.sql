-- ============================================================================
-- 0064_first_workspace.sql — ESTIA · the signup that needs no secret
--
-- ── The problem this solves, and it is the whole product ───────────────────
--
-- Until this migration, creating the first organization was the ONE write no
-- row level security policy could authorize. `0004_rls.sql` says so, and the
-- reason is structural rather than an oversight: every tenant policy reads
-- `organization_id in (select public.my_organizations())`, and the person
-- creating their first workspace is a member of nothing, so that set is empty
-- by definition. No INSERT policy can be written that admits them without
-- admitting everybody to everything.
--
-- The product's answer was to hand `src/app/(app)/onboarding/_lib/signup.ts` a
-- privileged path: either `DATABASE_URL` (a direct connection as the owner,
-- which has BYPASSRLS) or `SUPABASE_SERVICE_ROLE_KEY` (a credential that
-- bypasses row level security for every table in the database). Both work.
-- Both were also absent from `.env.local`, and the live database shows the
-- consequence exactly: two signed-up users, zero organizations, zero
-- memberships, zero properties, zero bookings. **Not one screen in this
-- product had ever displayed a real row**, because the first step could not
-- run at all.
--
-- Adding the secret would have fixed the symptom and left the design: a
-- product whose signup requires the operator to hold a credential that reads
-- and writes every tenant's data. That credential then exists in the running
-- web process forever, for the sake of one insert that happens once per
-- customer.
--
-- So the write moves into the database instead, as one narrow function that
-- can do exactly one thing. This is the precedent `0061_webhook_enqueue.sql`
-- set for the same shape of problem, and its header argues it at length: one
-- SECURITY DEFINER function beats a service-role client in the request path,
-- because the function's blast radius is its own body and the credential's
-- blast radius is the whole database.
--
-- ── Why this is safe, which is a different question from why it works ──────
--
-- SECURITY DEFINER means the body runs as `postgres`, which holds BYPASSRLS,
-- so row level security — including FORCE — does not apply inside it. Every
-- guard below is therefore the ONLY guard, not a second line of defence.
--
--   1. THE FUNCTION TAKES NO USER ID. There is no parameter for one. The
--      membership it writes is for `auth.uid()` and there is no expression in
--      this file that could name anybody else. The classic failure of a
--      privileged signup helper — passing a victim's id and joining their
--      business — is not defended against here, it is unrepresentable.
--
--   2. AN UNAUTHENTICATED CALLER IS REFUSED. `auth.uid()` null raises. `anon`
--      also has EXECUTE revoked by name, because `0004_rls.sql` learned the
--      hard way that `REVOKE … FROM PUBLIC` leaves untouched the grant
--      Supabase gives `anon` explicitly.
--
--   3. THE NUMBER OF WORKSPACES ONE PERSON MAY CREATE IS CAPPED. This is the
--      only INSERT into `public.organizations` any signed-in user can reach,
--      which makes it the only one that can be abused, and an uncapped one
--      lets a single free signup fill the table. Three, because a person
--      genuinely running three guesthouse businesses is a customer and a
--      person creating a fourth is a script. The cap counts organizations
--      this user OWNS, not ones they were invited to, so a cleaner on
--      fifteen teams is unaffected.
--
--   4. THE TIMEZONE IS VALIDATED AGAINST `pg_timezone_names`. The table only
--      requires it to be non-blank, so 'Asia/Jerusalm' passes the constraint
--      and then silently shifts every check-in time, quiet-hours window and
--      nightly rate boundary in the product. A typo at signup is not the
--      place to discover that.
--
--   5. `search_path` IS PINNED TO '' and every single reference is schema
--      qualified, so the function cannot be redirected at a shadowing table.
--
-- ── Why it is idempotent on the slug ───────────────────────────────────────
--
-- Two clicks send the same slug. The unique index lets one through. Rather
-- than showing the winner a success and the loser a database error, the
-- second call finds the organization the first created — WITH THIS CALLER'S
-- OWN membership already attached — and returns its id. A slug that belongs
-- to somebody else is not this caller's replay and still raises 23505, which
-- the screen turns into a field error. This mirrors `organizationForSlugOwnedBy`
-- in `signup.ts` exactly, deliberately: the two paths must not disagree about
-- what a double submit means.
--
-- ── What this does NOT change ──────────────────────────────────────────────
--
-- The privileged paths in `signup.ts` are left standing and still work. They
-- are simply no longer required, and the product now prefers this one. Nor
-- does this migration relax anything: no policy is added, no grant widened,
-- and `authenticated` still has no INSERT privilege on `public.organizations`.
--
-- ── The seven identity tables that are not FORCE, and why that stays ───────
--
-- `memberships` · `membership_roles` · `roles` · `role_permissions` ·
-- `permissions` · `plans` · `platform_staff` have row level security enabled
-- and not forced (recorded as G-024). It is worth being explicit that this is
-- now load-bearing rather than pending: an owner with BYPASSRLS is exempt from
-- policies whether or not FORCE is set, so this function would keep working
-- either way — but the first-join path in `signup.ts` writes as the owner too,
-- and the register's advice was to force them "and then prove the first join
-- still works". There is now something to prove it against.
--
-- Depends on 0002 (organizations, memberships, plans, roles) and 0004
-- (`my_organizations`, and the grant lesson about `anon`).
-- ============================================================================

set search_path = public, extensions;

-- The cap from guard 3, named rather than buried in the body.
create or replace function public.max_owned_workspaces()
returns integer
language sql
immutable
set search_path = ''
as $$ select 3 $$;

comment on function public.max_owned_workspaces() is
  'How many organizations one person may create for themselves. Three: a '
  'person running three guesthouse businesses is a customer, a person '
  'creating a fourth is a script.';

create or replace function public.create_first_workspace(
  p_slug text,
  p_name text,
  p_business_type public.organization_business_type,
  p_timezone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user          uuid := auth.uid();
  v_organization  uuid;
  v_membership    uuid;
  v_plan          uuid;
  v_monthly       bigint;
  v_yearly        bigint;
  v_owner_role    uuid;
  v_owned         integer;
begin
  -- Guard 2. Not "return null" — a caller with no session asking to create a
  -- business is a bug or an attack, and both deserve to be told.
  if v_user is null then
    raise exception 'create_first_workspace requires an authenticated caller'
      using errcode = 'insufficient_privilege';
  end if;

  if p_slug is null or p_name is null or p_business_type is null
     or p_timezone is null then
    raise exception 'create_first_workspace: slug, name, business type and timezone are all required'
      using errcode = 'null_value_not_allowed';
  end if;

  -- Guard 4. The table only asks for non-blank; this asks for real.
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = p_timezone
  ) then
    raise exception 'unknown timezone %', p_timezone
      using errcode = 'invalid_parameter_value';
  end if;

  -- The replay answer. Their own slug, already created, with their own
  -- membership on it: return the same id rather than a unique violation.
  select o.id into v_organization
  from public.organizations o
  join public.memberships m
    on m.organization_id = o.id
   and m.user_id = v_user
   and m.status = 'active'::public.membership_status
  where o.slug = p_slug and o.deleted_at is null;

  if v_organization is not null then
    return v_organization;
  end if;

  -- Guard 3, and it counts what this person OWNS. A membership carrying the
  -- system `organization_owner` role is the definition; being invited to
  -- fifteen businesses as a cleaner does not count against anybody.
  select count(*) into v_owned
  from public.memberships m
  join public.membership_roles mr on mr.membership_id = m.id
  join public.roles r on r.id = mr.role_id
  where m.user_id = v_user
    and m.status = 'active'::public.membership_status
    and r.code = 'organization_owner'
    and r.organization_id is null;

  if v_owned >= public.max_owned_workspaces() then
    raise exception
      'this account already owns % workspaces, which is the limit', v_owned
      using errcode = 'insufficient_privilege';
  end if;

  -- The two rows that must already exist. Both raise rather than improvise:
  -- an organization with no subscription resolves to `no_subscription` and its
  -- owner cannot use it, and an owner with no role holds no grants in their
  -- own business. Either one is a broken workspace, not a partial one.
  select p.id, p.monthly_price_agorot, p.yearly_price_agorot
    into v_plan, v_monthly, v_yearly
  from public.plans p
  where p.deleted_at is null and p.is_public
  order by p.sort_order, p.monthly_price_agorot
  limit 1;

  if v_plan is null then
    raise exception 'no public plan exists in public.plans, so no subscription can be attached'
      using errcode = 'internal_error';
  end if;

  select r.id into v_owner_role
  from public.roles r
  where r.code = 'organization_owner' and r.organization_id is null
  limit 1;

  if v_owner_role is null then
    raise exception 'the system role organization_owner is missing from public.roles'
      using errcode = 'internal_error';
  end if;

  insert into public.organizations
    (slug, name, business_type, country, timezone, currency, locale,
     status, created_by, updated_by)
  values
    (p_slug, p_name, p_business_type, 'IL', p_timezone, 'ILS', 'he',
     'onboarding'::public.organization_status, v_user, v_user)
  returning id into v_organization;

  -- `joined_at` is not decoration: `memberships_joined_when_active` refuses an
  -- active membership without one.
  insert into public.memberships
    (user_id, organization_id, status, joined_at, employment_type,
     language, created_by, updated_by)
  values
    (v_user, v_organization, 'active'::public.membership_status,
     pg_catalog.now(), 'owner'::public.employment_type, 'he', v_user, v_user)
  returning id into v_membership;

  insert into public.membership_roles
    (membership_id, organization_id, role_id, created_by)
  values (v_membership, v_organization, v_owner_role, v_user);

  -- Explicit rather than implied. 0008 treats a missing scope row as
  -- organization-wide, but a row that says so is a fact rather than a default
  -- somebody could reasonably change later.
  insert into public.membership_scopes
    (membership_id, organization_id, kind, created_by, updated_by)
  values
    (v_membership, v_organization,
     'all_organization'::public.membership_scope_kind, v_user, v_user);

  insert into public.organization_subscriptions
    (organization_id, plan_id, status, billing_interval,
     agreed_monthly_price_agorot, agreed_yearly_price_agorot,
     created_by, updated_by)
  values
    (v_organization, v_plan, 'trialing'::public.subscription_status,
     'monthly'::public.billing_interval, v_monthly, v_yearly, v_user, v_user);

  return v_organization;
end $$;

comment on function public.create_first_workspace(
  text, text, public.organization_business_type, text) is
  'Creates one organization owned by auth.uid(): the organization, the owner '
  'membership, its role, its organization-wide scope and a trialing '
  'subscription, in one transaction. Takes no user id by design — it cannot '
  'name anybody but its caller. This is the write no RLS policy can '
  'authorize; see the header of 0064_first_workspace.sql.';

-- The grants, and the `anon` lesson from 0004 applied by name.
revoke all on function public.max_owned_workspaces() from public, anon;
revoke all on function public.create_first_workspace(
  text, text, public.organization_business_type, text) from public, anon;

grant execute on function public.max_owned_workspaces() to authenticated;
grant execute on function public.create_first_workspace(
  text, text, public.organization_business_type, text) to authenticated;

-- ── Rehearsal ──────────────────────────────────────────────────────────────
--
-- Everything below is checked at migration time and raises rather than warns.
-- The last block is the important one: it EXERCISES the authentication guard
-- instead of asserting that the code contains it.
do $$
declare
  cfg text;
begin
  select pg_catalog.array_to_string(p.proconfig, ',') into cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_first_workspace';

  if cfg is null or cfg not like '%search_path=%' then
    raise exception
      'create_first_workspace is SECURITY DEFINER without a pinned search_path';
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'create_first_workspace'
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon may create organizations';
  end if;

  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'create_first_workspace'
      and grantee = 'authenticated'
  ) then
    raise exception 'authenticated cannot create its own workspace';
  end if;

  -- Running as the migration role there is no `auth.uid()`, which is exactly
  -- the case guard 2 exists to refuse. If this ever stops raising, the
  -- function has stopped checking who is calling it, and an unauthenticated
  -- caller can create a business.
  begin
    perform public.create_first_workspace(
      'rehearsal-must-not-exist', 'רפטיציה',
      'villa'::public.organization_business_type, 'Asia/Jerusalem');
    raise exception 'create_first_workspace accepted a caller with no session';
  exception
    when insufficient_privilege then null;
  end;

  -- And it must reject a timezone that is merely non-blank. Same call, same
  -- missing session — so this can only reach the timezone check if the guards
  -- are ordered wrongly, which is itself worth knowing.
  if exists (
    select 1 from public.organizations where slug = 'rehearsal-must-not-exist'
  ) then
    raise exception 'the rehearsal created a real organization';
  end if;
end $$;

-- ── The slug question, asked without a secret ──────────────────────────────
--
-- `isSlugAvailable` in `signup.ts` was privileged for a good reason it states
-- itself: `organizations_select` shows the caller only their own
-- organizations, so asked as the caller every slug in the system looks free
-- and the answer is worthless. The form then offers a slug that the insert
-- rejects a moment later.
--
-- It returns one boolean and never a name. Slugs are public URL identifiers
-- by design — 0001 says so on the column — so this discloses nothing that
-- visiting the address would not, and a caller with no session gets nothing
-- at all.
create or replace function public.workspace_slug_available(p_slug text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'workspace_slug_available requires an authenticated caller'
      using errcode = 'insufficient_privilege';
  end if;

  if p_slug is null then
    return false;
  end if;

  return not exists (
    select 1 from public.organizations where slug = p_slug
  );
end $$;

comment on function public.workspace_slug_available(text) is
  'Whether an organization slug is free. One boolean, never a name. Requires '
  'a session; see the header of 0064_first_workspace.sql.';

revoke all on function public.workspace_slug_available(text) from public, anon;
grant execute on function public.workspace_slug_available(text) to authenticated;

do $$
begin
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'workspace_slug_available'
      and grantee in ('anon', 'PUBLIC')
  ) then
    raise exception 'anon may enumerate organization slugs';
  end if;

  -- Exercised, not asserted: no session in a migration, so this must refuse.
  begin
    perform public.workspace_slug_available('anything');
    raise exception 'workspace_slug_available answered a caller with no session';
  exception
    when insufficient_privilege then null;
  end;
end $$;
