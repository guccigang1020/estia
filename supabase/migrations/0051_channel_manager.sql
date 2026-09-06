-- ============================================================================
-- 0051_channel_manager.sql — ESTIA · the channel manager
--
-- What this is, and what already existed
--   `/channels` has existed for a while and is a REPORT of bookings by source
--   channel. It queries `bookings` and nothing else. It is correct, it is
--   kept, and it is not a channel manager: there were zero connection,
--   listing, mapping, reservation or sync tables in this database.
--
--   This adds them. The report becomes a section of the merged screen, with
--   its own argument intact — counting channel bookings is not
--   synchronisation, and that distinction is what a double booking is made of.
--
-- There is still exactly one availability engine
--   `src/lib/booking/availability.ts` decides what is free. Nothing here
--   reimplements an overlap test or minimum-nights arithmetic;
--   `reconciliation.ts` compares two already-computed answers and reports the
--   difference. Booking.com's calendar must never become a second source of
--   truth about a night.
--
-- There are no credentials in this schema
--   `credential_ref` holds a NAME in a secret store. The same decision
--   `payment_collection_settings.live_provider` and `site_generation_requests`
--   took, so the product can say "nothing is configured" without ever having
--   read a secret. The rehearsal refuses any column that looks like one.
--
--   There is also no HTTP call to any OTA anywhere in `src/lib/channels/`. The
--   null connector declares zero capabilities and refuses honestly, and a
--   connector that does not declare a capability is refused rather than
--   called and hoped over.
--
-- The two constraints this module is built around
--   `channel_mapping_one_active_per_listing` — two active mappings for one
--   listing means a reservation picks a bedroom by coin toss. Partial on
--   `state = 'active'` so suspended history survives, because the wrong
--   mapping must be suspendable rather than deletable: every past exception
--   and reservation references it.
--
--   `channel_reservations_ledger_key` — this IS the guarantee that one OTA
--   reservation produces one booking, not a handler remembering to look
--   first. The same argument 0006 makes about idempotency keys.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission, property_in_scope), 0008 (properties, units and their
--   composite unique keys), 0009 (bookings).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Vocabularies — transcribed from src/lib/channels/types.ts, in order
-- ============================================================================

do $$ begin
  create type public.channel_code as enum ('booking_com', 'airbnb', 'expedia', 'direct');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_connector_state as enum
    ('draft', 'connecting', 'active', 'paused', 'disconnected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_capability as enum (
    'discover_listings', 'push_availability', 'push_rates', 'push_restrictions',
    'pull_reservations', 'acknowledge_modification', 'acknowledge_cancellation',
    'receive_webhooks');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_mapping_state as enum
    ('draft', 'validated', 'active', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_reservation_status as enum ('new', 'modified', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_exception_kind as enum (
    'mapping_missing', 'duplicate_mapping', 'availability_mismatch',
    'rate_push_failed', 'stale_webhook', 'unknown_booking',
    'modification_conflict', 'cancellation_conflict', 'duplicate_booking',
    'invalid_reservation');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_exception_severity as enum ('warning', 'urgent', 'critical');
exception when duplicate_object then null; end $$;

comment on type public.channel_exception_severity is
  'ASCENDING, and the order is load-bearing: the exception centre sorts on it and SEVERITY_RANK in src/lib/channels/exceptions.ts mirrors it. Reordering silently changes what a person sees first.';

do $$ begin
  create type public.channel_exception_state as enum
    ('open', 'acknowledged', 'resolved', 'dismissed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_sync_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_sync_status as enum ('ok', 'partial', 'refused');
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 2 · Connections
-- ============================================================================

create table if not exists public.channel_connections (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations (id) on delete cascade,
  property_id           uuid references public.properties (id) on delete cascade,
  channel_code          public.channel_code not null,
  state                 public.channel_connector_state not null default 'draft',
  capabilities          public.channel_capability[] not null default '{}',
  credential_ref        text,
  credentials_expire_at timestamptz,
  external_account_id   text,
  last_inbound_sync_at  timestamptz,
  last_outbound_sync_at timestamptz,
  last_webhook_at       timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users (id) on delete set null,
  version               integer not null default 1,
  constraint channel_connections_property_in_org
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id),
  constraint channel_connections_credential_ref_not_blank
    check (credential_ref is null or length(btrim(credential_ref)) > 0),
  constraint channel_connections_version_positive check (version >= 1)
);

comment on table public.channel_connections is
  'One account on one channel, optionally narrowed to one property. The composite FK is what stops a connection naming a property from another tenant; the organization_id column alone cannot.';
comment on column public.channel_connections.credential_ref is
  'A NAME in a secret store, never a secret. There is no credential column anywhere in this schema and none may be added — the same decision payment_collection_settings and site_generation_requests took, so the product can say "nothing is configured" without ever having read one.';

create unique index if not exists channel_connections_one_per_scope
  on public.channel_connections (
    organization_id, channel_code,
    coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

comment on index public.channel_connections_one_per_scope is
  'coalesce because NULL <> NULL in a unique index: without it two organization-wide connections to Booking.com would both be allowed, and every availability push would go out twice with two different cursors.';

create index if not exists channel_connections_org_idx
  on public.channel_connections (organization_id);
create index if not exists channel_connections_active_idx
  on public.channel_connections (organization_id, channel_code)
  where state = 'active';

drop trigger if exists channel_connections_touch on public.channel_connections;
create trigger channel_connections_touch
  before update on public.channel_connections
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 3 · Listings
-- ============================================================================

create table if not exists public.channel_listings (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  connection_id        uuid not null references public.channel_connections (id) on delete cascade,
  channel_code         public.channel_code not null,
  external_listing_id  text not null,
  external_variant_id  text,
  external_variant_key text generated always as (coalesce(external_variant_id, '-')) stored,
  name                 text not null,
  max_occupancy        integer,
  active               boolean not null default true,
  discovered_at        timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint channel_listings_variant_not_sentinel check (
    external_variant_id is null
    or (length(btrim(external_variant_id)) > 0 and external_variant_id <> '-')
  ),
  constraint channel_listings_occupancy_positive check (
    max_occupancy is null or max_occupancy >= 1
  )
);

comment on column public.channel_listings.external_variant_key is
  'The generated sentinel, and the reason the identity index works at all: a whole-property listing has external_variant_id IS NULL, and a plain unique index on a nullable column permits unlimited duplicates. Matches listingKey() in mapping.ts, and channel_listings_variant_not_sentinel stops a variant literally named "-" colliding with "no variant".';
comment on table public.channel_listings is
  'Discovery UPSERTS on the identity index and marks vanished listings inactive. It must never delete-then-insert: every mapping and every exception references the listing id.';

create unique index if not exists channel_listings_identity
  on public.channel_listings (connection_id, external_listing_id, external_variant_key);
create index if not exists channel_listings_org_idx
  on public.channel_listings (organization_id);

drop trigger if exists channel_listings_touch on public.channel_listings;
create trigger channel_listings_touch
  before update on public.channel_listings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · Mappings
-- ============================================================================

create table if not exists public.channel_listing_mappings (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete cascade,
  connection_id        uuid not null references public.channel_connections (id) on delete cascade,
  channel_code         public.channel_code not null,
  external_listing_id  text not null,
  external_variant_id  text,
  external_variant_key text generated always as (coalesce(external_variant_id, '-')) stored,
  property_id          uuid not null,
  unit_id              uuid not null,
  state                public.channel_mapping_state not null default 'draft',
  mapped_by            uuid references auth.users (id) on delete set null,
  mapped_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null,
  version              integer not null default 1,
  constraint channel_mappings_unit_in_property
    foreign key (unit_id, organization_id, property_id)
    references public.units (id, organization_id, property_id),
  constraint channel_mappings_version_positive check (version >= 1)
);

comment on table public.channel_listing_mappings is
  'Which unit a listing sells. channel_mappings_unit_in_property uses the existing composite key on units, so a mapping physically cannot name a unit from a different property — which is what makes property_in_scope() in the policy a true statement about the unit as well.';

create unique index if not exists channel_mapping_one_active_per_listing
  on public.channel_listing_mappings
     (connection_id, external_listing_id, external_variant_key)
  where state = 'active';

comment on index public.channel_mapping_one_active_per_listing is
  'THE CONSTRAINT THIS MODULE IS BUILT AROUND, and the enforcement behind resolveListing''s `ambiguous` refusal: two active mappings for one listing means a reservation picks a bedroom by coin toss. PARTIAL on state=active so suspended history survives — the wrong mapping must be suspendable rather than deletable, because every past exception and reservation references it.';

create index if not exists channel_mappings_org_idx
  on public.channel_listing_mappings (organization_id);
create index if not exists channel_mappings_unit_idx
  on public.channel_listing_mappings (unit_id) where state = 'active';
create index if not exists channel_mappings_conn_idx
  on public.channel_listing_mappings (connection_id, state);

drop trigger if exists channel_listing_mappings_touch on public.channel_listing_mappings;
create trigger channel_listing_mappings_touch
  before update on public.channel_listing_mappings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · The idempotency ledger
-- ============================================================================

create table if not exists public.channel_reservations (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  connection_id           uuid not null references public.channel_connections (id) on delete restrict,
  channel_code            public.channel_code not null,
  external_reservation_id text not null,
  ledger_key              text not null,
  revision                integer,
  content_fingerprint     text not null,
  booking_id              uuid references public.bookings (id) on delete set null,
  last_status             public.channel_reservation_status not null,
  payload                 jsonb not null default '{}'::jsonb,
  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint channel_reservations_ledger_key_derived check (
    ledger_key = 'channel:' || channel_code::text || ':' || external_reservation_id
  ),
  constraint channel_reservations_revision_nonnegative check (
    revision is null or revision >= 0
  ),
  constraint channel_reservations_seen_order check (last_seen_at >= first_seen_at)
);

comment on table public.channel_reservations is
  'The idempotency ledger. connection_id is ON DELETE RESTRICT — the opposite of the other tables and deliberately so: deleting a connection must never delete this ledger, because that makes every past reservation ingestable again and duplicates every booking the channel ever sent. Rows here are never deleted; archive instead.';
comment on column public.channel_reservations.ledger_key is
  'channel_reservations_ledger_key IS the guarantee that one OTA reservation produces one booking — not a handler remembering to look first, the same argument 0006 makes. The derived CHECK stops the stored key drifting from the two columns it comes from, because a key that never matches the next delivery creates a second booking.';
comment on column public.channel_reservations.payload is
  'The channel''s raw reservation, which contains guest personal data. RESERVATION_COLUMNS in repository.ts never selects it and no screen renders it. Nothing in the module reads it — drop the column if the business would rather not hold it at all.';

create unique index if not exists channel_reservations_ledger_key
  on public.channel_reservations (organization_id, ledger_key);
create index if not exists channel_reservations_booking_idx
  on public.channel_reservations (organization_id, booking_id);
create index if not exists channel_reservations_recent_idx
  on public.channel_reservations (connection_id, last_seen_at desc);

drop trigger if exists channel_reservations_touch on public.channel_reservations;
create trigger channel_reservations_touch
  before update on public.channel_reservations
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 6 · Sync runs
-- ============================================================================

create table if not exists public.channel_sync_runs (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  connection_id      uuid not null references public.channel_connections (id) on delete cascade,
  direction          public.channel_sync_direction not null,
  capability         public.channel_capability not null,
  status             public.channel_sync_status not null,
  started_at         timestamptz not null,
  finished_at        timestamptz not null,
  entities_attempted integer not null default 0,
  entities_accepted  integer not null default 0,
  entities_rejected  integer not null default 0,
  failed_entities    text[] not null default '{}',
  refusal_kind       text,
  refusal_detail     text,
  correlation_id     uuid not null,
  created_at         timestamptz not null default now(),
  constraint channel_sync_runs_time_order check (finished_at >= started_at),
  constraint channel_sync_runs_counts_sane check (
    entities_accepted + entities_rejected <= entities_attempted
  ),
  constraint channel_sync_runs_refusal_has_kind check (
    status <> 'refused' or refusal_kind is not null
  )
);

comment on table public.channel_sync_runs is
  'One push or pull. channel_sync_runs_counts_sane is what stops "the push worked" being recorded over a batch where nine of two hundred dates bounced — the most expensive kind of true statement in this module. This is the only table here that grows without bound; a rolling window is appropriate and health reads a 24-hour slice.';
comment on column public.channel_sync_runs.refusal_detail is
  'Must never contain a credential.';

create index if not exists channel_sync_runs_health_idx
  on public.channel_sync_runs (organization_id, connection_id, started_at desc);


-- ============================================================================
-- 7 · Exceptions
-- ============================================================================

create table if not exists public.channel_exceptions (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  connection_id           uuid references public.channel_connections (id) on delete set null,
  channel_code            public.channel_code not null,
  kind                    public.channel_exception_kind not null,
  severity                public.channel_exception_severity not null,
  state                   public.channel_exception_state not null default 'open',
  title                   text not null,
  detail                  text not null,
  external_reservation_id text,
  external_listing_id     text,
  booking_id              uuid references public.bookings (id) on delete set null,
  unit_id                 uuid references public.units (id) on delete set null,
  property_id             uuid references public.properties (id) on delete set null,
  dedupe_key              text not null,
  occurred_at             timestamptz not null,
  resolved_at             timestamptz,
  resolved_by             uuid references auth.users (id) on delete set null,
  resolution_note         text,
  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,
  constraint channel_exceptions_settled_pair check (
    (state in ('resolved', 'dismissed')) = (resolved_at is not null)
  ),
  constraint channel_exceptions_dismissal_has_reason check (
    state <> 'dismissed'
    or (resolution_note is not null and length(btrim(resolution_note)) > 0)
  ),
  constraint channel_exceptions_version_positive check (version >= 1)
);

comment on table public.channel_exceptions is
  'What went wrong and what to do about it. Every kind has a resolution path in EXCEPTION_PLAYBOOK.';
comment on constraint channel_exceptions_dismissal_has_reason on public.channel_exceptions is
  'Dismissing without a stated reason is how a queue gets cleared instead of worked, and it is unrecoverable afterwards.';
comment on column public.channel_exceptions.dedupe_key is
  'Collapses an unmapped listing that redelivers every four minutes into ONE row. Without it the exception centre becomes the screen nobody opens, which is the same failure as not having one.';

create unique index if not exists channel_exceptions_dedupe
  on public.channel_exceptions (organization_id, dedupe_key);
create index if not exists channel_exceptions_queue_idx
  on public.channel_exceptions (organization_id, severity, occurred_at)
  where state in ('open', 'acknowledged');
create index if not exists channel_exceptions_conn_idx
  on public.channel_exceptions (connection_id)
  where state in ('open', 'acknowledged');

drop trigger if exists channel_exceptions_touch on public.channel_exceptions;
create trigger channel_exceptions_touch
  before update on public.channel_exceptions
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 8 · Row level security
-- ============================================================================
-- No DELETE policy on any table, and the absence is the enforcement: a
-- connection is disconnected, a listing is marked inactive, a mapping is
-- suspended, an exception is resolved. Nothing here is deleted.

alter table public.channel_connections      enable row level security;
alter table public.channel_connections      force  row level security;
alter table public.channel_listings         enable row level security;
alter table public.channel_listings         force  row level security;
alter table public.channel_listing_mappings enable row level security;
alter table public.channel_listing_mappings force  row level security;
alter table public.channel_reservations     enable row level security;
alter table public.channel_reservations     force  row level security;
alter table public.channel_sync_runs        enable row level security;
alter table public.channel_sync_runs        force  row level security;
alter table public.channel_exceptions       enable row level security;
alter table public.channel_exceptions       force  row level security;

revoke all on public.channel_connections      from anon, authenticated;
revoke all on public.channel_listings         from anon, authenticated;
revoke all on public.channel_listing_mappings from anon, authenticated;
revoke all on public.channel_reservations     from anon, authenticated;
revoke all on public.channel_sync_runs        from anon, authenticated;
revoke all on public.channel_exceptions       from anon, authenticated;

grant select, insert, update on public.channel_connections      to authenticated;
grant select, insert, update on public.channel_listings         to authenticated;
grant select, insert, update on public.channel_listing_mappings to authenticated;
grant select, insert, update on public.channel_reservations     to authenticated;
grant select, insert         on public.channel_sync_runs        to authenticated;
grant select, insert, update on public.channel_exceptions       to authenticated;

grant select, insert, update on public.channel_connections      to service_role;
grant select, insert, update on public.channel_listings         to service_role;
grant select, insert, update on public.channel_listing_mappings to service_role;
grant select, insert, update on public.channel_reservations     to service_role;
grant select, insert         on public.channel_sync_runs        to service_role;
grant select, insert, update on public.channel_exceptions       to service_role;

revoke delete, truncate on public.channel_reservations from authenticated, service_role;
revoke delete, truncate on public.channel_sync_runs    from authenticated, service_role;


-- ============================================================================
-- 9 · Policies
-- ============================================================================

drop policy if exists channel_connections_all on public.channel_connections;
create policy channel_connections_all on public.channel_connections
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and (property_id is null or public.property_in_scope(property_id, organization_id))
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and (property_id is null or public.property_in_scope(property_id, organization_id))
  );

-- Scope reaches a listing through the connection, which is the only thing
-- that owns it.
drop policy if exists channel_listings_all on public.channel_listings;
create policy channel_listings_all on public.channel_listings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and exists (
      select 1 from public.channel_connections c
      where c.id = channel_listings.connection_id
        and c.organization_id = channel_listings.organization_id
        and (c.property_id is null
             or public.property_in_scope(c.property_id, c.organization_id))
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and exists (
      select 1 from public.channel_connections c
      where c.id = channel_listings.connection_id
        and c.organization_id = channel_listings.organization_id
        and (c.property_id is null
             or public.property_in_scope(c.property_id, c.organization_id))
    )
  );

-- property_id is NOT NULL here, so there is no null branch and there must not
-- be one: a mapping with no property is a mapping no scope check constrains.
drop policy if exists channel_listing_mappings_all on public.channel_listing_mappings;
create policy channel_listing_mappings_all on public.channel_listing_mappings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and public.property_in_scope(property_id, organization_id)
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and public.property_in_scope(property_id, organization_id)
  );

drop policy if exists channel_reservations_all on public.channel_reservations;
create policy channel_reservations_all on public.channel_reservations
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
  );

-- A run is a fact: select and insert only, no update.
drop policy if exists channel_sync_runs_select on public.channel_sync_runs;
create policy channel_sync_runs_select on public.channel_sync_runs
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
  );

drop policy if exists channel_sync_runs_insert on public.channel_sync_runs;
create policy channel_sync_runs_insert on public.channel_sync_runs
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
  );

drop policy if exists channel_exceptions_all on public.channel_exceptions;
create policy channel_exceptions_all on public.channel_exceptions
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and (property_id is null or public.property_in_scope(property_id, organization_id))
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'channel.manage')
    and (property_id is null or public.property_in_scope(property_id, organization_id))
  );


-- ============================================================================
-- 10 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('channel_connections'), ('channel_listings'), ('channel_listing_mappings'),
    ('channel_reservations'), ('channel_sync_runs'), ('channel_exceptions')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0051: %', missing;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'channel_mapping_one_active_per_listing'
  ) then
    raise exception
      'two active mappings for one listing would be permitted, and a reservation would pick a bedroom by coin toss';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'channel_reservations_ledger_key'
  ) then
    raise exception
      'the idempotency ledger has no unique key, so one OTA reservation could become two bookings';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'channel_reservations_ledger_key_derived'
      and conrelid = 'public.channel_reservations'::regclass
  ) then
    raise exception
      'the stored ledger key could drift from the columns it is derived from';
  end if;

  -- Deleting a connection must never delete the ledger.
  if (select confdeltype from pg_constraint
      where conrelid = 'public.channel_reservations'::regclass
        and contype = 'f'
        and conname like '%connection_id%') is distinct from 'r' then
    raise exception
      'channel_reservations.connection_id is not RESTRICT — deleting a connection would make every past reservation ingestable again';
  end if;

  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'channel_%'
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon' and table_name like 'channel_%';
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;

  -- No credentials, ever. `credential_ref` is a NAME and is exempted by name.
  select string_agg(c.relname || '.' || a.attname, ', ') into missing
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'channel_%'
    and a.attnum > 0 and not a.attisdropped
    and (a.attname like '%secret%' or a.attname like '%api_key%'
         or a.attname like '%password%' or a.attname like '%token%'
         or (a.attname like '%credential%'
             and a.attname not in ('credential_ref', 'credentials_expire_at')));
  if missing is not null then
    raise exception '0051 carries credential columns and must not: %', missing;
  end if;
end $$;
