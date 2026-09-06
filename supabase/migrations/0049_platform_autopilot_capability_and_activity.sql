-- ============================================================================
-- 0049_platform_autopilot_capability_and_activity.sql — ESTIA
--
-- What this closes
--   0046 revoked INSERT, UPDATE, DELETE and TRUNCATE on autopilot_capability
--   from `authenticated`, and in the same file created
--   `autopilot_capability_platform_write` as a policy FOR ALL to
--   `authenticated`. A policy cannot grant a privilege that was revoked, so
--   that policy is unreachable and the platform console had no way to write
--   the row at all. The capability control was dead on arrival.
--
--   Found by the agent building the console, which discovered it could not
--   perform the one operation the screen exists for.
--
-- Why a definer function rather than granting the writes back
--   Because the capability row and the entitlement must move together. The
--   state is the platform's record of WHY a customer has Autopilot; the
--   entitlement is what the product actually reads. Two PostgREST statements
--   are two transactions unless DATABASE_URL points at the pooler — and a
--   half-commit there leaves a customer holding one and not the other, which
--   is precisely the divergence `platform/capabilities.ts` argues no product
--   should ever be able to reach. One function, one transaction, both halves.
--
--   It re-checks `platform.organization.manage` on its own account. SECURITY
--   DEFINER takes the policy that would have refused out of the path, so the
--   function has to ask the question the policy is no longer there to ask.
--
-- Why the two readers exist and why they return so little
--   Platform staff are members of no organization, so the per-tenant SELECT
--   policies on autopilot_actions correctly return them nothing. The fix is
--   NOT a cross-tenant SELECT policy on that table: its rows carry `reason`,
--   `evidence`, `command_input` and `error_detail` — the guest's own words and
--   the body of every message ESTIA sent on a customer's behalf. A policy
--   would hand all of it to ESTIA staff for every customer.
--
--   So the console gets counts and a narrow incident list instead: what kind
--   of action, how dangerous, under which disposition, and the machine
--   -readable failure code. Enough to run the fleet, nothing anyone could read
--   a guest's message from. Same argument and same shape as
--   `platform_organization_usage()` in 0041.
--
-- Depends on
--   0041 (platform staff and has_platform_permission), 0046 (the tables).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Writing a capability decision, both halves, one transaction
-- ============================================================================

create or replace function public.platform_set_autopilot_capability(
  p_organization_id  uuid,
  p_state            public.autopilot_capability_state,
  p_trial_ends_at    timestamptz,
  p_action_limit     integer,
  p_note             text,
  p_grants           text[],
  p_revocations      text[],
  p_limits           jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_sub   public.organization_subscriptions%rowtype;
begin
  if not public.has_platform_permission('platform.organization.manage') then
    raise exception 'platform_permission_denied'
      using hint = 'אין לך הרשאה לשנות יכולות של ארגון.', errcode = '42501';
  end if;

  if p_organization_id is null then
    raise exception 'organization_required'
      using hint = 'לא נבחר ארגון.', errcode = 'P0002';
  end if;

  if p_state in ('suspended', 'disabled')
     and (p_note is null or length(btrim(p_note)) = 0) then
    raise exception 'note_required'
      using hint = 'השהיה או ביטול של יכולת דורשים נימוק שנשמר.', errcode = 'P0006';
  end if;

  if p_state = 'trial' and p_trial_ends_at is null then
    raise exception 'trial_end_required'
      using hint = 'תקופת ניסיון חייבת תאריך סיום.', errcode = 'P0006';
  end if;

  select * into v_sub
  from public.organization_subscriptions
  where organization_id = p_organization_id
  order by created_at desc
  limit 1;

  if not found then
    raise exception 'no_live_subscription'
      using hint = 'לארגון אין מנוי פעיל, ולכן אי אפשר להעניק את היכולת.',
            errcode = 'P0002';
  end if;

  insert into public.autopilot_capability as c
    (organization_id, state, trial_ends_at, action_limit, note, decided_by, decided_at)
  values
    (p_organization_id, p_state, p_trial_ends_at, p_action_limit, p_note, v_actor, now())
  on conflict (organization_id) do update
    set state         = excluded.state,
        trial_ends_at = excluded.trial_ends_at,
        action_limit  = excluded.action_limit,
        note          = excluded.note,
        decided_by    = excluded.decided_by,
        decided_at    = excluded.decided_at,
        version       = c.version + 1;

  update public.organization_subscriptions
  set entitlement_grants      = coalesce(p_grants, '{}'),
      entitlement_revocations = coalesce(p_revocations, '{}'),
      limit_overrides         = coalesce(p_limits, limit_overrides)
  where id = v_sub.id;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'state',          p_state,
    'entitled',       ('autopilot' = any (coalesce(p_grants, '{}')))
                        and not ('autopilot' = any (coalesce(p_revocations, '{}')))
  );
end;
$$;

comment on function public.platform_set_autopilot_capability(uuid, public.autopilot_capability_state, timestamptz, integer, text, text[], text[], jsonb) is
  'Writes the capability row and the entitlement overrides in ONE transaction. It exists because those two must never diverge — the state is the platform''s record of why, the entitlement is what the product reads — and two PostgREST statements are two transactions unless DATABASE_URL points at the pooler, which is exactly where a half-commit would leave a customer holding one and not the other. Re-checks the platform permission on its own account, because SECURITY DEFINER takes the policy that would have refused out of the path. It also exists because 0046 revoked INSERT and UPDATE on autopilot_capability from authenticated while leaving a write policy in place: the policy was unreachable and the console had no way in at all.';

revoke all on function public.platform_set_autopilot_capability(uuid, public.autopilot_capability_state, timestamptz, integer, text, text[], text[], jsonb) from public, anon, authenticated, service_role;
grant execute on function public.platform_set_autopilot_capability(uuid, public.autopilot_capability_state, timestamptz, integer, text, text[], text[], jsonb) to authenticated;


-- ============================================================================
-- 2 · Fleet activity, as counts and nothing else
-- ============================================================================

create or replace function public.platform_autopilot_activity()
returns table (
  organization_id     uuid,
  planned             bigint,
  awaiting_approval   bigint,
  executed            bigint,
  executed_unaudited  bigint,
  failed              bigint,
  needs_review        bigint,
  suppressed          bigint,
  simulated           bigint,
  cancelled           bigint,
  automatic_attempts  bigint,
  automatic_successes bigint,
  last_action_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.organization_id,
    count(*) filter (where a.outcome = 'planned'),
    count(*) filter (where a.outcome = 'awaiting_approval'),
    count(*) filter (where a.outcome = 'executed'),
    count(*) filter (where a.outcome = 'executed_unaudited'),
    count(*) filter (where a.outcome = 'failed'),
    count(*) filter (where a.outcome = 'needs_review'),
    count(*) filter (where a.outcome = 'suppressed'),
    count(*) filter (where a.outcome = 'simulated'),
    count(*) filter (where a.outcome = 'cancelled'),
    count(*) filter (where a.disposition = 'auto'),
    count(*) filter (where a.disposition = 'auto'
                       and a.outcome in ('executed', 'executed_unaudited')),
    max(a.created_at)
  from public.autopilot_actions a
  where public.has_platform_permission('platform.organization.view')
  group by a.organization_id;
$$;

comment on function public.platform_autopilot_activity() is
  'Counts only. Deliberately returns no reason, no evidence, no command payload and no error detail — those carry the guest''s own words and the body of every message sent on the customer''s behalf, and a platform SELECT policy on autopilot_actions would hand all of it to ESTIA staff. Same argument and same shape as platform_organization_usage() in 0041. The permission is checked inside the query so a caller without it gets no rows rather than an error confirming the table has any.';

revoke all on function public.platform_autopilot_activity() from public, anon, authenticated, service_role;
grant execute on function public.platform_autopilot_activity() to authenticated;


-- ============================================================================
-- 3 · Incidents, narrow by construction
-- ============================================================================

create or replace function public.platform_autopilot_incidents(p_limit integer default 100)
returns table (
  organization_id uuid,
  action_kind     text,
  safety_level    public.action_safety_level,
  disposition     public.autopilot_disposition,
  run_mode        public.autopilot_run_mode,
  outcome         public.autopilot_action_outcome,
  error_code      text,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.organization_id, a.action_kind, a.safety_level, a.disposition,
         a.run_mode, a.outcome, a.error_code, a.created_at
  from public.autopilot_actions a
  where public.has_platform_permission('platform.organization.view')
    and a.outcome in ('failed', 'needs_review', 'executed_unaudited')
  order by a.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

comment on function public.platform_autopilot_incidents(integer) is
  'The narrow incident list: what kind of action, how dangerous, under which disposition, and the machine-readable failure code. The detailed failure text is excluded along with the reason, the evidence and the command payload — a failure message can quote the payload that failed, and that payload is the customer''s data.';

revoke all on function public.platform_autopilot_incidents(integer) from public, anon, authenticated, service_role;
grant execute on function public.platform_autopilot_incidents(integer) to authenticated;


-- ============================================================================
-- 4 · Rehearsal
-- ============================================================================

do $$
declare
  n integer;
  missing text;
begin
  select count(*) into n
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public'
    and p.proname in ('platform_set_autopilot_capability',
                      'platform_autopilot_activity',
                      'platform_autopilot_incidents')
    and p.prosecdef
    and exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) c
      where c like 'search_path=%'
    );
  if n <> 3 then
    raise exception
      'expected 3 SECURITY DEFINER functions with a pinned search_path, found %', n;
  end if;

  select string_agg(p.proname, ', ') into missing
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public'
    and p.proname in ('platform_set_autopilot_capability',
                      'platform_autopilot_activity',
                      'platform_autopilot_incidents')
    and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if missing is not null then
    raise exception
      'the console cannot execute %, so the screen that needs it is dead', missing;
  end if;

  select string_agg(p.proname, ', ') into missing
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public'
    and p.proname in ('platform_set_autopilot_capability',
                      'platform_autopilot_activity',
                      'platform_autopilot_incidents')
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if missing is not null then
    raise exception 'anon can execute: %', missing;
  end if;

  -- The privacy floor, asserted by reading the function bodies rather than by
  -- trusting the comment above them.
  select string_agg(p.proname, ', ') into missing
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public'
    and p.proname in ('platform_autopilot_activity', 'platform_autopilot_incidents')
    and (p.prosrc like '%command_input%' or p.prosrc like '%evidence%'
         or p.prosrc like '%error_detail%' or p.prosrc like '%a.reason%');
  if missing is not null then
    raise exception
      'a platform reader selects a column carrying customer or guest content: %', missing;
  end if;
end $$;
