-- ============================================================================
-- 0078_automation_ledger.sql — ESTIA · the durable claim, and the record of
--                              what was actually done
--
-- ── The gap this closes, in its own words ──────────────────────────────────
--
-- `src/lib/automation/performing.ts` names two things that must exist before
-- the performing half can ever be switched on. This migration is the first of
-- them, and it is quoted rather than paraphrased:
--
--   "A DURABLE LEDGER. `AutomationLedger` is injected and the only
--    implementation in this codebase is `InMemoryAutomationLedger`, which is
--    atomic because JavaScript is single-threaded and for no other reason. Two
--    application instances behind a load balancer would each keep their own
--    idea of which keys are taken, and the failure that produces — 'we sent the
--    guest two payment links' — is precisely what the ledger exists to
--    prevent."
--
-- On Vercel that is not a hypothetical. Two concurrent requests are two lambda
-- invocations with two heaps, so an in-memory ledger does not deduplicate
-- anything the moment the product has more than one visitor.
--
-- ── WHY NOT `idempotency_keys` ═════════════════════════════════════════════
--
-- It has the right atomicity and the wrong lifetime. `idempotency_keys` rows
-- carry `expires_at` — one hour unreserved, twenty-four hours once completed —
-- and `purge_expired_idempotency_keys()` deletes them, because a client's retry
-- token is *meant* to become reusable. An automation claim means "this rule has
-- already acted on this event, and must never act on it again". Hanging it off
-- a table whose whole design is expiry would mean a guest receiving the same
-- message a day later, from a sweeper doing exactly its job.
--
-- So: the same primitive, a different table, no expiry, and nothing that
-- deletes a row except the release the engine itself performs.
--
-- ── THE CLAIM IS ONE STATEMENT, AND THAT IS THE WHOLE MECHANISM ════════════
--
--     insert into automation_ledger (organization_id, key) values ($1, $2)
--       on conflict do nothing
--       returning true
--
-- The primary key decides it. Two deliveries of one event racing each other
-- both run this; exactly one gets a row back and performs. A `select` followed
-- by an `insert` would reopen precisely the window this exists to close — the
-- same sentence `0075` already makes about `automation_runs_once`, and the same
-- answer.
--
-- ── ATTRIBUTION, AND THE ONE THING A MEMBER COULD DO WITH THIS ═════════════
--
-- The claim functions ask for membership and not for a permission, because the
-- caller is whoever's action raised the event — a receptionist taking a
-- booking, not somebody administering automations. Requiring `automation.manage`
-- would mean automations only ran for managers.
--
-- The cost is stated rather than hidden: a member who can guess an execution
-- key could claim it first and silently suppress that automation. Two things
-- bound it. `claimed_by` records who, defaulted from `auth.uid()` so the caller
-- cannot forge it; and `automation_runs` still records the decision, so a rule
-- that decided `would_act` while nothing was performed is visible on the
-- screen rather than invisible. Somebody with `automation.manage` can already
-- switch the rule off outright, so this is only a floor for everybody else.
--
-- ── AND THE RECORD OF WHAT HAPPENED ════════════════════════════════════════
--
-- 0075 declared `automation_runs.performed_at` and `performed_outcome`, wrote
-- the constraints that govern them, and then granted UPDATE to nobody — on
-- purpose, so that a deployment which cannot perform also cannot claim to have
-- performed. That stays true: this migration does not grant UPDATE either.
-- `automation_run_performed` is a SECURITY DEFINER door with its own guards,
-- and it is the only way those two columns can ever be written.
--
-- The guards are the interesting part. The stamp is **write-once** — a second
-- call is refused rather than allowed to overwrite — and it is refused for a
-- decision that was not `would_act`, so nothing can record work against a rule
-- that declined to do any. The table's own constraints say the same thing; the
-- function says it earlier, with a message.
--
-- Depends on 0001 (organizations), 0004 (`my_organizations`, `has_permission`)
-- and 0075 (`automation_runs`).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The ledger
-- ============================================================================

create table if not exists public.automation_ledger (
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,

  -- `executionKey` from src/lib/automation/engine.ts:
  --   `${event.idempotencyKey}::${rule.id}::${index}::${action.kind}`
  -- Stored whole rather than hashed. A hash would be shorter and would make
  -- every forensic question ("which rule kept claiming this?") unanswerable,
  -- for a table that holds one short row per action performed.
  key              text not null,

  claimed_at       timestamptz not null default now(),

  -- Who was in the request when the claim was taken. Defaulted from the
  -- session rather than passed in, so a caller cannot name somebody else.
  -- Null for a claim taken with no session, which is the service_role path.
  claimed_by       uuid default auth.uid(),

  -- The claim IS the primary key. Nothing about this table is correct if this
  -- line is ever relaxed into a plain index.
  constraint automation_ledger_pkey primary key (organization_id, key),

  constraint automation_ledger_key_bounded
    check (pg_catalog.length(key) between 1 and 500)
);

comment on table public.automation_ledger is
  'One row per automation action performed, keyed by executionKey from src/lib/automation/engine.ts. The primary key is the deduplication: claim is a single insert … on conflict do nothing, so two concurrent deliveries of one event cannot both perform. Deliberately NOT idempotency_keys, which expires by design; an automation claim must never expire, or a guest receives the same message tomorrow.';
comment on column public.automation_ledger.claimed_by is
  'From auth.uid(), not from the caller. A member could suppress an automation by claiming its key first; this is what makes that attributable rather than invisible.';

-- "What has this organization's automation done" is the only question asked of
-- this table beyond the claim itself, and it is asked most-recent-first.
create index if not exists automation_ledger_recent_idx
  on public.automation_ledger (organization_id, claimed_at desc);


-- ============================================================================
-- 2 · Row level security
-- ============================================================================
-- Readable by whoever may read the automation screen. Never writable by a
-- request path: both writes go through the functions below, which is what
-- keeps the membership check and the atomicity in one place instead of
-- duplicated into a policy that a later `insert` could bypass.

alter table public.automation_ledger enable row level security;
alter table public.automation_ledger force  row level security;

revoke all on public.automation_ledger from anon, authenticated;
grant select on public.automation_ledger to authenticated, service_role;
revoke insert, update, delete, truncate on public.automation_ledger
  from authenticated, service_role;

drop policy if exists automation_ledger_select on public.automation_ledger;
create policy automation_ledger_select on public.automation_ledger
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'automation.view')
  );


-- ============================================================================
-- 3 · Claim and release
-- ============================================================================

create or replace function public.automation_ledger_claim(
  p_organization_id uuid,
  p_key             text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_taken boolean;
begin
  -- The tenant boundary, explicit, because SECURITY DEFINER has just bypassed
  -- row level security. Same shape as `record_automation_evaluation` in 0075
  -- and for the same reason: the performing half runs in the request of the
  -- person whose action raised the event, so membership is the honest floor
  -- and there is no service-role escape hatch to widen it.
  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  if p_key is null or pg_catalog.length(pg_catalog.btrim(p_key)) = 0 then
    raise exception 'מפתח ביצוע ריק'
      using errcode = 'check_violation';
  end if;

  -- One statement. The primary key decides who won; nothing here re-checks it.
  insert into public.automation_ledger (organization_id, key)
  values (p_organization_id, p_key)
  on conflict (organization_id, key) do nothing
  returning true into v_taken;

  return coalesce(v_taken, false);
end;
$$;

comment on function public.automation_ledger_claim(uuid, text) is
  'Claims one execution key, atomically. Returns true when this caller took it and false when somebody already held it. A single insert … on conflict do nothing: the primary key is the race, not application code.';

create or replace function public.automation_ledger_release(
  p_organization_id uuid,
  p_key             text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  -- Unconditional. The engine releases only a claim it took and only when a
  -- retry could plausibly succeed; a release for a key nobody holds is a
  -- no-op, and turning it into an error would fail a run that succeeded.
  delete from public.automation_ledger
   where organization_id = p_organization_id
     and key = p_key;
end;
$$;

comment on function public.automation_ledger_release(uuid, text) is
  'Hands a claim back so a later delivery may try again. Called by runAutomations only for a retryable failure: a permanent failure keeps its claim, so the next delivery does not reproduce the identical failure and the identical alert.';

revoke all on function public.automation_ledger_claim(uuid, text)
  from public, anon;
revoke all on function public.automation_ledger_release(uuid, text)
  from public, anon;
grant execute on function public.automation_ledger_claim(uuid, text)
  to authenticated, service_role;
grant execute on function public.automation_ledger_release(uuid, text)
  to authenticated, service_role;


-- ============================================================================
-- 4 · The stamp on the decision record
-- ============================================================================

create or replace function public.automation_run_performed(
  p_organization_id uuid,
  p_event_key       text,
  p_template_id     text,
  p_outcome         text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision  text;
  v_performed timestamptz;
begin
  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  select r.decision, r.performed_at
    into v_decision, v_performed
    from public.automation_runs r
   where r.organization_id = p_organization_id
     and r.event_key = p_event_key
     and r.template_id = p_template_id;

  if not found then
    -- Not an error the caller can fix by retrying, and not silence either:
    -- performing without a decision record means the evaluation half did not
    -- run, and that is a wiring fault worth surfacing.
    raise exception 'אין רישום החלטה לאירוע הזה, ולכן אין למה לצרף ביצוע'
      using errcode = 'no_data_found';
  end if;

  if v_performed is not null then
    -- Write-once. A second stamp would overwrite the first outcome, and the
    -- record of what an automation did to somebody's guest is not a field
    -- that gets corrected in place.
    raise exception 'הריצה הזאת כבר סומנה כבוצעה'
      using errcode = 'unique_violation';
  end if;

  if v_decision <> 'would_act' then
    raise exception 'לא ניתן לרשום ביצוע על החלטה שלא לפעול'
      using errcode = 'check_violation';
  end if;

  update public.automation_runs r
     set performed_at = pg_catalog.now(),
         performed_outcome = p_outcome
   where r.organization_id = p_organization_id
     and r.event_key = p_event_key
     and r.template_id = p_template_id;
end;
$$;

comment on function public.automation_run_performed(uuid, text, text, text) is
  'The only way automation_runs.performed_at and performed_outcome are ever written. No role holds UPDATE on that table and this migration does not grant it. Write-once, and refused for a decision that was not would_act.';

revoke all on function
  public.automation_run_performed(uuid, text, text, text) from public, anon;
grant execute on function
  public.automation_run_performed(uuid, text, text, text)
  to authenticated, service_role;


-- ============================================================================
-- 5 · The rehearsal
-- ============================================================================
-- Runs the guards rather than asserting they exist. Everything below happens
-- inside a subtransaction that is unwound at the end, so the rehearsal leaves
-- no organization, no ledger row and no run behind.

do $$
declare
  v_org       uuid;
  v_uid       uuid;
  v_first     boolean;
  v_second    boolean;
  v_again     boolean;
  v_run       uuid;
  v_outcome   text;
  v_stamped   timestamptz;
  v_n         integer;
  v_cfg       text;
begin
  /* The three functions are pinned, because SECURITY DEFINER without a pinned
     search_path is the vulnerability 0061 exists to prevent. */

  v_n := 0;
  for v_cfg in
    select coalesce(array_to_string(p.proconfig, ','), '')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('automation_ledger_claim',
                         'automation_ledger_release',
                         'automation_run_performed')
  loop
    if v_cfg not like '%search_path=%' then
      raise exception 'an automation ledger function has a mutable search_path';
    end if;
    v_n := v_n + 1;
  end loop;

  -- Counted, because a loop over nothing passes silently and "the function is
  -- missing" would then read as "the function is safe".
  if v_n <> 3 then
    raise exception 'expected three pinned automation functions, found %', v_n;
  end if;

  /* The table is forced, not merely enabled. */

  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'automation_ledger'
     and c.relrowsecurity and c.relforcerowsecurity;
  if v_n <> 1 then
    raise exception 'automation_ledger does not force row level security';
  end if;

  /* And no request role can write it directly. */

  if has_table_privilege('authenticated', 'public.automation_ledger', 'INSERT')
     or has_table_privilege('authenticated', 'public.automation_ledger', 'UPDATE')
     or has_table_privilege('authenticated', 'public.automation_ledger', 'DELETE')
  then
    raise exception 'authenticated can write automation_ledger directly';
  end if;

  if has_table_privilege('authenticated', 'public.automation_runs', 'UPDATE')
     or has_table_privilege('service_role', 'public.automation_runs', 'UPDATE')
  then
    raise exception 'a role holds UPDATE on automation_runs';
  end if;

  /* ── The tenant boundary, exercised ────────────────────────────────────── */
  -- Running as the migration role there is no `auth.uid()`, so
  -- `my_organizations()` is empty and every id is foreign. That is exactly the
  -- case that must be refused, and 0075 exercises its recorder the same way.
  -- If this ever stops raising, these functions have stopped being a boundary.

  begin
    perform public.automation_ledger_claim(
      '00000000-0000-4000-8000-000000000000'::uuid, 'evt::rule::0::notify_team');
    raise exception 'the ledger claimed a key for a foreign organization';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.automation_ledger_release(
      '00000000-0000-4000-8000-000000000000'::uuid, 'evt::rule::0::notify_team');
    raise exception 'the ledger released a key for a foreign organization';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.automation_run_performed(
      '00000000-0000-4000-8000-000000000000'::uuid,
      'evt', 'rehearsal-template', 'executed');
    raise exception 'a run was stamped for a foreign organization';
  exception
    when insufficient_privilege then null;
  end;

  /* ── The guards, run against real rows ─────────────────────────────────── */
  -- The functions above refuse without a session, so the rest needs one. Any
  -- confirmed account will do: `create_first_workspace` writes the membership
  -- for its own caller, which is what makes `my_organizations()` answer. The
  -- same borrowing 0065 does, and for the same reason.

  select id into v_uid from auth.users
   where email_confirmed_at is not null order by created_at limit 1;

  if v_uid is null then
    raise notice
      'no confirmed user exists, so the ledger was NOT exercised end to end';
  else
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
      true);

    v_org := public.create_first_workspace(
      'rehearsal-0078-must-not-survive', 'רפטיציה 0078',
      'villa'::public.organization_business_type, 'Asia/Jerusalem');

    /* 1. The claim is taken once and refused the second time. */

    v_first  := public.automation_ledger_claim(v_org, 'evt::rule::0::notify_team');
    v_second := public.automation_ledger_claim(v_org, 'evt::rule::0::notify_team');

    if not v_first then
      raise exception 'the first claim on a fresh key was refused';
    end if;
    if v_second then
      raise exception 'the same key was claimed twice';
    end if;

    /* 2. Released, it can be claimed again. That is what makes a retry after a
          transient failure possible at all. */

    perform public.automation_ledger_release(v_org, 'evt::rule::0::notify_team');
    v_again := public.automation_ledger_claim(v_org, 'evt::rule::0::notify_team');
    if not v_again then
      raise exception 'a released key could not be claimed again';
    end if;

    /* 3. Releasing a key nobody holds is a no-op and not an error. */

    perform public.automation_ledger_release(v_org, 'never-claimed');

    /* 4. An empty key is refused rather than stored. */

    begin
      perform public.automation_ledger_claim(v_org, '   ');
      raise exception 'a blank execution key was accepted';
    exception
      when check_violation then null;
    end;

    /* 5. The stamp needs a decision record to attach to. */

    begin
      perform public.automation_run_performed(
        v_org, 'evt-missing', 'template-that-never-ran', 'executed');
      raise exception 'a performance was recorded against no decision';
    exception
      when no_data_found then null;
    end;

    /* 6. A decision that declined to act cannot be marked performed. */

    insert into public.automation_runs
      (organization_id, template_id, event_name, event_key, occurred_at,
       source, decision, reason)
    values
      (v_org, 'rehearsal-template', 'booking.created', 'evt-declined',
       pg_catalog.now(), 'shipped', 'skipped_conditions', 'רפטיציה');

    begin
      perform public.automation_run_performed(
        v_org, 'evt-declined', 'rehearsal-template', 'executed');
      raise exception 'work was recorded against a rule that declined to act';
    exception
      when check_violation then null;
    end;

    /* 7. A decision that would act is stamped once, and only once. */

    insert into public.automation_runs
      (organization_id, template_id, event_name, event_key, occurred_at,
       source, decision)
    values
      (v_org, 'rehearsal-template', 'booking.created', 'evt-acted',
       pg_catalog.now(), 'shipped', 'would_act')
    returning id into v_run;

    perform public.automation_run_performed(
      v_org, 'evt-acted', 'rehearsal-template', 'executed');

    select performed_at, performed_outcome
      into v_stamped, v_outcome
      from public.automation_runs where id = v_run;

    if v_stamped is null or v_outcome <> 'executed' then
      raise exception 'the run was not stamped';
    end if;

    begin
      perform public.automation_run_performed(
        v_org, 'evt-acted', 'rehearsal-template', 'failed');
      raise exception 'a performed run was stamped a second time';
    exception
      when unique_violation then null;
    end;

    select performed_outcome into v_outcome
      from public.automation_runs where id = v_run;
    if v_outcome <> 'executed' then
      raise exception 'the second stamp overwrote the first outcome';
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
     where slug = 'rehearsal-0078-must-not-survive'
  ) then
    raise exception 'the rehearsal left an organization behind';
  end if;

  if exists (select 1 from public.automation_ledger) then
    raise exception 'the rehearsal left a ledger claim behind';
  end if;
end $$;
