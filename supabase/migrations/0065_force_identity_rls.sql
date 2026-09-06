-- ============================================================================
-- 0065_force_identity_rls.sql — ESTIA · the seven that were exempt, and a
-- function that could be redirected
--
-- ── What G-024 asked for, and why it could not be done until now ───────────
--
-- Seven tables had row level security ENABLED and not FORCED: `memberships` ·
-- `membership_roles` · `roles` · `role_permissions` · `permissions` · `plans` ·
-- `platform_staff`. Every other table in the database is forced. These seven
-- are exactly the ones the permission system rests on, which is what makes the
-- exemption worth removing and also what made it frightening.
--
-- The exemption was deliberate. Somebody joining their first organization has
-- to be written into `memberships` before any policy can admit them, and that
-- write was done by the owner, which FORCE would have subjected to the very
-- policies that have no answer for it.
--
-- The register's advice was to force them "and then prove the first join still
-- works", and the honest blocker was that there was nothing to prove it
-- against. `0064_first_workspace.sql` changed that: the first join now happens
-- inside `create_first_workspace`, and the rehearsal at the foot of this file
-- RUNS it under the new setting rather than reasoning about it.
--
-- ── Why forcing is safe, stated precisely ──────────────────────────────────
--
-- FORCE ROW LEVEL SECURITY subjects a table's OWNER to its policies. It does
-- not subject a role holding BYPASSRLS, and in this project `postgres` and
-- `service_role` both hold it (verified: `pg_roles.rolbypassrls`). All three
-- signup paths run as one of those two — the SECURITY DEFINER function is
-- owned by `postgres`, the `DATABASE_URL` path connects as the owner, and the
-- compensated path uses the service role — so none of them changes behaviour.
--
-- What DOES change is the case nobody planned for: a future migration, script
-- or psql session that connects as the owner and reads these tables while
-- believing it is scoped to one tenant. Today it would silently see every
-- organization's memberships. That is the whole reason to close it.
--
-- ── And one function that could be pointed at the wrong table ──────────────
--
-- `try_cast_inet(text)` is the only function in `public` without a pinned
-- `search_path`, and Supabase's own advisor flags it. It is NOT SECURITY
-- DEFINER, so it runs with the caller's privileges and the risk is small —
-- but a report with one permanent finding is a report people stop reading,
-- and that costs more than this line does.
--
-- Depends on 0064 (`create_first_workspace`, which the rehearsal exercises).
-- ============================================================================

set search_path = public, extensions;

alter table public.memberships       force row level security;
alter table public.membership_roles  force row level security;
alter table public.roles             force row level security;
alter table public.role_permissions  force row level security;
alter table public.permissions       force row level security;
alter table public.plans             force row level security;
alter table public.platform_staff    force row level security;

alter function public.try_cast_inet(text) set search_path = '';

-- ── Rehearsal ──────────────────────────────────────────────────────────────
--
-- Two checks. The first is bookkeeping. The second is the one that matters:
-- it CREATES A WORKSPACE under the new setting and then throws it away, so a
-- migration that broke the first join could not complete.
do $$
declare
  v_unforced text;
  v_cfg      text;
  v_uid      uuid;
  v_org      uuid;
  v_rows     integer;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_unforced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relrowsecurity and not c.relforcerowsecurity;

  if v_unforced is not null then
    raise exception 'still not forced: %', v_unforced;
  end if;

  select array_to_string(p.proconfig, ',') into v_cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'try_cast_inet';

  if v_cfg is null or v_cfg not like '%search_path=%' then
    raise exception 'try_cast_inet still has a mutable search_path';
  end if;

  -- The proof. Any confirmed account will do — the function writes for its
  -- caller and this block only needs somebody real to be the caller.
  select id into v_uid from auth.users
  where email_confirmed_at is not null order by created_at limit 1;

  if v_uid is null then
    raise notice 'no confirmed user exists, so the first join was NOT exercised';
  else
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
        true);

      v_org := public.create_first_workspace(
        'rehearsal-0065-must-not-survive', 'רפטיציה',
        'villa'::public.organization_business_type, 'Asia/Jerusalem');

      select count(*) into v_rows from public.memberships
      where organization_id = v_org and user_id = v_uid;

      if v_rows <> 1 then
        raise exception
          'forcing row level security broke the first join: % membership rows', v_rows;
      end if;

      -- Everything above happened inside this BEGIN block, which plpgsql runs
      -- as a subtransaction. Raising here unwinds all of it, so the proof
      -- leaves no organization behind — the same shape as
      -- `supabase/tests/isolation.sql`, which ends in ROLLBACK for the same
      -- reason.
      raise exception 'ESTIA_REHEARSAL_ROLLBACK';
    exception
      when others then
        if sqlerrm <> 'ESTIA_REHEARSAL_ROLLBACK' then raise; end if;
    end;
  end if;

  if exists (
    select 1 from public.organizations
    where slug = 'rehearsal-0065-must-not-survive'
  ) then
    raise exception 'the rehearsal left an organization behind';
  end if;
end $$;
