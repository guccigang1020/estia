-- ============================================================================
-- 0061_webhook_enqueue.sql — ESTIA · the fan-out, in the database
--
-- ── The problem this solves ────────────────────────────────────────────────
--
-- A booking clerk creates a booking. The operation emits `booking.created`.
-- Somebody's endpoint is subscribed to it, and a delivery row has to appear.
--
-- The clerk cannot write that row. `authenticated` has no INSERT on
-- `webhook_deliveries` at all, and reading `webhook_endpoints` needs
-- `integration.manage`, which a booking clerk has no business holding. Both
-- of those refusals are correct and neither should be relaxed.
--
-- The obvious alternative is to hand the request path a service-role client
-- and do the fan-out in TypeScript. That would work, and it would put a
-- credential that bypasses row level security into every write path in the
-- product — into `bookings`, `guests`, `tasks`, `laundry`, twenty modules —
-- so that a webhook can be queued. The blast radius of that mistake is the
-- whole database, and it would be introduced for a feature most tenants do
-- not use.
--
-- So the fan-out happens here instead. One SECURITY DEFINER function, one
-- INSERT … SELECT, and no request path ever holds a privileged client.
--
-- ── Membership is checked EXPLICITLY, because RLS is not ───────────────────
--
-- SECURITY DEFINER means row level security is bypassed for the body of this
-- function. The `p_organization_id not in (select my_organizations())` guard
-- is therefore not belt-and-braces — it is the ONLY tenant boundary in here,
-- and without it any signed-in user could queue deliveries into any
-- organization's endpoints by passing its id.
--
-- `search_path` is pinned to '' and every reference is schema-qualified, so
-- the function cannot be redirected at a shadowing table.
--
-- Depends on 0060 (the webhook tables) and 0004 (`my_organizations`).
-- ============================================================================

set search_path = public, extensions;

create or replace function public.enqueue_webhook_deliveries(
  p_organization_id uuid,
  p_event_name text,
  p_payload jsonb,
  p_property_id uuid default null,
  p_correlation_id text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued integer;
begin
  if p_organization_id is null or p_event_name is null then
    return 0;
  end if;

  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  insert into public.webhook_deliveries (
    organization_id, endpoint_id, event_name, event_payload,
    property_id, correlation_id, status, attempts, next_attempt_at
  )
  select e.organization_id, e.id, p_event_name, coalesce(p_payload, 'null'::jsonb),
         p_property_id, p_correlation_id, 'pending', 0, now()
  from public.webhook_endpoints e
  where e.organization_id = p_organization_id
    and e.status = 'active'
    and p_event_name = any (e.events);

  get diagnostics queued = row_count;
  return queued;
end;
$$;

comment on function public.enqueue_webhook_deliveries(uuid, text, jsonb, uuid, text) is
  'The fan-out, done in the database so that no user request path needs a service-role client. authenticated cannot insert into webhook_deliveries and cannot read webhook_endpoints without integration.manage — and a booking clerk creating a booking holds neither, yet their booking must still reach a subscriber. SECURITY DEFINER bridges that, so membership is checked EXPLICITLY here: it is the only tenant boundary left once RLS is bypassed.';

revoke all on function public.enqueue_webhook_deliveries(uuid, text, jsonb, uuid, text)
  from public, anon;
grant execute on function public.enqueue_webhook_deliveries(uuid, text, jsonb, uuid, text)
  to authenticated, service_role;


-- ============================================================================
-- Rehearsal
-- ============================================================================

do $$
declare
  cfg text;
begin
  select array_to_string(p.proconfig, ',') into cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enqueue_webhook_deliveries';

  if cfg is null or cfg not like '%search_path=%' then
    raise exception
      'enqueue_webhook_deliveries is SECURITY DEFINER without a pinned search_path';
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'enqueue_webhook_deliveries'
      and grantee = 'anon'
  ) then
    raise exception 'anon may execute the webhook fan-out';
  end if;

  -- The guard, exercised rather than asserted. Running as the migration role
  -- there is no `auth.uid()`, so `my_organizations()` is empty and any id is
  -- foreign — which is exactly the case that must be refused. If the function
  -- ever stops raising here, it has stopped checking membership.
  begin
    perform public.enqueue_webhook_deliveries(
      '00000000-0000-4000-8000-000000000000', 'booking.created', '{}'::jsonb);
    raise exception 'the fan-out accepted an organization the caller is not in';
  exception
    when insufficient_privilege then null;
  end;
end $$;
