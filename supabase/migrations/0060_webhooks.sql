-- ============================================================================
-- 0060_webhooks.sql — ESTIA · outbound webhooks
--
-- The first of the four modules the Market Leadership Program names and the
-- product did not have at all: no domain, no screen, no table. §164 says one
-- at a time, so this is webhooks alone — the inbound public API needs an API
-- credential and a rate limit and is deliberately not started here.
--
-- Direction matters and is the first thing to state. This is ESTIA SENDING.
-- `channel_connections` already carries `receive_webhooks` and
-- `last_webhook_at`, which is somebody else's traffic ARRIVING. Modelling both
-- directions in one place is how a receiver ends up able to trigger a send.
--
-- ── The three tables, and why the middle one exists ─────────────────────────
--
--   `webhook_endpoints`         where to send, and what to send there
--   `webhook_endpoint_secrets`  how it is signed — SEPARATE ON PURPOSE
--   `webhook_deliveries`        one row per event per subscriber, with state
--
-- The secret cannot be hashed. HMAC needs the secret itself to compute a
-- signature, so there is no one-way function to hide behind, and the only
-- remaining protection is who may read the column. Hence the split, exactly
-- as `guide_entry_secrets` is split out of `guide_entries` in 0058:
-- **`authenticated` holds no privilege on the secrets table at all.** Not
-- SELECT, not anything. Only `service_role` — the sender — can read it, and
-- the rehearsal at the bottom fails the migration if that ever stops being
-- true.
--
-- ── Empty means nothing, never everything ──────────────────────────────────
--
-- `events` is a `text[]` of names from `src/lib/contracts/events.ts`, and an
-- empty array delivers nothing. The other reading — empty as wildcard — is
-- the shape of accident where a half-configured endpoint starts receiving
-- every guest's details the moment somebody saves the form. There is no
-- wildcard in this module anywhere.
--
-- The database checks only that each entry is a non-blank dotted name; the
-- frozen catalogue is enforced in the domain, where it lives. That check
-- needs `unnest`, and a CHECK constraint may not contain a subquery —
-- Postgres has never allowed it, and 0042 shipped unrunnable for exactly this
-- reason. So the guard is an IMMUTABLE function and the constraint calls it,
-- the same resolution `site_claims_are_sourced` uses.
--
-- ── `blocked` is not `exhausted` ───────────────────────────────────────────
--
-- A delivery refused before anything was sent — an unsafe address, a disabled
-- endpoint — is `blocked`. It must never count toward the endpoint's failure
-- streak, because that would disable a customer's perfectly good endpoint on
-- account of the product's own refusal.
--
-- Depends on 0001 (organizations), 0004 (RLS helpers), 0011 (tg_touch_row).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabularies
-- ============================================================================

do $$ begin
  create type public.webhook_endpoint_status as enum
    ('active', 'paused', 'disabled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.webhook_disable_reason as enum
    ('too_many_failures', 'receiver_said_gone', 'address_became_unsafe');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.webhook_delivery_status as enum
    ('pending', 'succeeded', 'exhausted', 'blocked');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 2 · The guard the constraint could not hold itself
-- ============================================================================

create or replace function public.webhook_events_are_named(p_events text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_events is null
      or not exists (
        select 1
        from unnest(p_events) as e
        where e is null
           or length(btrim(e)) = 0
           or position('.' in e) = 0
      );
$$;

comment on function public.webhook_events_are_named(text[]) is
  'A CHECK constraint may not contain a subquery — Postgres has never allowed it — and this shape needs unnest. Same resolution as site_claims_are_sourced in 0042: the guard becomes an IMMUTABLE function and the constraint calls it.';

revoke all on function public.webhook_events_are_named(text[]) from public, anon;
grant execute on function public.webhook_events_are_named(text[])
  to authenticated, service_role;


-- ============================================================================
-- 3 · Where to send
-- ============================================================================

create table if not exists public.webhook_endpoints (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  url                  text not null,
  description          text,
  events               text[] not null default '{}',
  status               public.webhook_endpoint_status not null default 'active',
  disabled_reason      public.webhook_disable_reason,
  consecutive_failures integer not null default 0,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,
  constraint webhook_endpoints_id_organization_key unique (id, organization_id),
  constraint webhook_endpoints_url_is_https
    check (url like 'https://%' and length(url) <= 2048),
  constraint webhook_endpoints_url_has_no_credentials
    check (position('@' in split_part(split_part(url, '://', 2), '/', 1)) = 0),
  constraint webhook_endpoints_events_are_named
    check (public.webhook_events_are_named(events)),
  constraint webhook_endpoints_failures_nonnegative
    check (consecutive_failures >= 0),
  constraint webhook_endpoints_disabled_reason_needs_disabled
    check (disabled_reason is null or status = 'disabled')
);

comment on table public.webhook_endpoints is
  'Outbound only. A business registers a URL and subscribes it to domain events. This is NOT the channel manager inbound webhook (channel_connections.receive_webhooks) — confusing the two directions in one table is how a receiver ends up able to trigger a send.';
comment on column public.webhook_endpoints.events is
  'Domain event names from src/lib/contracts/events.ts. EMPTY MEANS NOTHING, never everything: there is no wildcard in this module, because a wildcard that arrives by accident is a data leak with a shrug. The catalogue itself is enforced in the domain — the database checks only that each entry is a non-blank dotted name.';
comment on constraint webhook_endpoints_url_is_https on public.webhook_endpoints is
  'A second floor under src/lib/webhooks/url-safety.ts. http makes the signature pointless — whoever can read the body can replay it — so it is refused rather than discouraged.';

create index if not exists webhook_endpoints_org_status_idx
  on public.webhook_endpoints (organization_id, status);
create index if not exists webhook_endpoints_active_idx
  on public.webhook_endpoints (organization_id) where status = 'active';

drop trigger if exists webhook_endpoints_touch on public.webhook_endpoints;
create trigger webhook_endpoints_touch
  before update on public.webhook_endpoints
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · How it is signed — the table `authenticated` cannot see
-- ============================================================================

create table if not exists public.webhook_endpoint_secrets (
  endpoint_id     uuid not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  signing_secret  text not null,
  is_previous     boolean not null default false,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  primary key (endpoint_id, signing_secret),
  constraint webhook_endpoint_secrets_endpoint_fkey
    foreign key (endpoint_id, organization_id)
    references public.webhook_endpoints (id, organization_id) on delete cascade,
  constraint webhook_endpoint_secrets_is_hex
    check (signing_secret ~ '^[0-9a-f]{64}$'),
  constraint webhook_endpoint_secrets_previous_expires
    check (is_previous = (expires_at is not null))
);

comment on table public.webhook_endpoint_secrets is
  'Split out of webhook_endpoints for the reason guide_entry_secrets is split out of guide_entries: authenticated holds NO privilege here at all, so no ordinary read can return a signing secret. It cannot be hashed — HMAC needs the secret itself — so the protection is the grant, and the grant is the whole design.';
comment on column public.webhook_endpoint_secrets.is_previous is
  'During a rotation both secrets are live and every delivery is signed with both, so a receiver that has updated and one that has not both verify. Without this, rotating means a window where every delivery fails — which means nobody rotates.';

create index if not exists webhook_endpoint_secrets_endpoint_idx
  on public.webhook_endpoint_secrets (organization_id, endpoint_id);


-- ============================================================================
-- 5 · What was sent, and what happened
-- ============================================================================

create table if not exists public.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  endpoint_id      uuid not null,
  event_name       text not null,
  event_payload    jsonb not null,
  property_id      uuid,
  correlation_id   text,
  status           public.webhook_delivery_status not null default 'pending',
  attempts         integer not null default 0,
  next_attempt_at  timestamptz,
  last_status_code integer,
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  constraint webhook_deliveries_endpoint_fkey
    foreign key (endpoint_id, organization_id)
    references public.webhook_endpoints (id, organization_id) on delete cascade,
  constraint webhook_deliveries_event_named check (length(btrim(event_name)) > 0),
  constraint webhook_deliveries_attempts_nonnegative check (attempts >= 0),
  constraint webhook_deliveries_pending_has_a_next_attempt
    check ((status = 'pending') = (next_attempt_at is not null)),
  constraint webhook_deliveries_delivered_stamp
    check ((status = 'succeeded') = (delivered_at is not null)),
  constraint webhook_deliveries_status_code_is_http
    check (last_status_code is null
           or (last_status_code >= 100 and last_status_code <= 599)),
  constraint webhook_deliveries_error_is_bounded
    check (last_error is null or length(last_error) <= 2000)
);

comment on table public.webhook_deliveries is
  'One row per event per subscribing endpoint, carrying its own attempt state. The id is what the receiver deduplicates on and is stable across retries: at-least-once is a promise, not an edge case, because a 200 that never reached us is indistinguishable from a timeout.';
comment on column public.webhook_deliveries.status is
  'blocked is deliberately not exhausted. Nothing was attempted — an unsafe address, a disabled endpoint — and counting it as a delivery failure would disable an endpoint for the product own refusal.';
comment on column public.webhook_deliveries.event_payload is
  'The domain event payload verbatim. This module never reads a row to enrich it, and that restraint is its main privacy control: what a webhook can leak is bounded by what the emitting operation already chose to put in the event.';

-- The sweep's index. Deliberately NOT led by organization_id: the sweep asks
-- "what is due anywhere" once and then iterates tenants, exactly as the
-- release sweep does. Every per-tenant read that follows uses the index below.
create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (next_attempt_at)
  where status = 'pending';
create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (organization_id, endpoint_id, created_at desc);
create index if not exists webhook_deliveries_failures_idx
  on public.webhook_deliveries (organization_id, created_at desc)
  where status in ('exhausted', 'blocked');


-- ============================================================================
-- 6 · Row level security
-- ============================================================================

alter table public.webhook_endpoints        enable row level security;
alter table public.webhook_endpoints        force  row level security;
alter table public.webhook_endpoint_secrets enable row level security;
alter table public.webhook_endpoint_secrets force  row level security;
alter table public.webhook_deliveries       enable row level security;
alter table public.webhook_deliveries       force  row level security;

revoke all on public.webhook_endpoints        from anon, authenticated;
revoke all on public.webhook_endpoint_secrets from anon, authenticated;
revoke all on public.webhook_deliveries       from anon, authenticated;

grant select, insert, update on public.webhook_endpoints  to authenticated;
grant select                 on public.webhook_deliveries to authenticated;
grant all on public.webhook_endpoints        to service_role;
grant all on public.webhook_endpoint_secrets to service_role;
grant all on public.webhook_deliveries       to service_role;

-- Deliveries are written by the sender, which runs as service_role. A person
-- reads them and never writes one: "mark this delivered" from a browser is
-- not a thing that should be expressible.

drop policy if exists webhook_endpoints_select on public.webhook_endpoints;
create policy webhook_endpoints_select on public.webhook_endpoints
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'integration.manage')
  );

drop policy if exists webhook_endpoints_insert on public.webhook_endpoints;
create policy webhook_endpoints_insert on public.webhook_endpoints
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'integration.manage')
  );

drop policy if exists webhook_endpoints_update on public.webhook_endpoints;
create policy webhook_endpoints_update on public.webhook_endpoints
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'integration.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'integration.manage')
  );

drop policy if exists webhook_deliveries_select on public.webhook_deliveries;
create policy webhook_deliveries_select on public.webhook_deliveries
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'integration.manage')
  );


-- ============================================================================
-- 7 · Rehearsal
-- ============================================================================

do $$
declare
  offending text;
begin
  if to_regclass('public.webhook_endpoints') is null
     or to_regclass('public.webhook_endpoint_secrets') is null
     or to_regclass('public.webhook_deliveries') is null then
    raise exception 'webhook tables missing';
  end if;

  -- THE ONE THAT MATTERS. The secret is not hashed and cannot be, so the
  -- grant is the only thing standing between an ordinary session and the
  -- ability to forge a delivery from ESTIA.
  select string_agg(distinct grantee || ' on ' || table_name, ', ')
    into offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'webhook_endpoint_secrets'
    and grantee in ('anon', 'authenticated');
  if offending is not null then
    raise exception
      'a signing secret is reachable by an ordinary read: %', offending;
  end if;

  select string_agg(distinct grantee || ' on ' || table_name, ', ')
    into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon'
    and table_name like 'webhook_%';
  if offending is not null then
    raise exception 'anon holds privileges on: %', offending;
  end if;

  select string_agg(c.relname, ', ') into offending
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'webhook\_%'
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if offending is not null then
    raise exception 'RLS not enabled and forced on: %', offending;
  end if;

  if public.webhook_events_are_named(array['booking.created']) is not true then
    raise exception 'a valid event name was refused';
  end if;
  if public.webhook_events_are_named(array['nodot']) is not false then
    raise exception 'an unnamespaced event name was accepted';
  end if;
  if public.webhook_events_are_named(array['booking.created', '']) is not false
  then
    raise exception 'a blank event name was accepted';
  end if;
end $$;
