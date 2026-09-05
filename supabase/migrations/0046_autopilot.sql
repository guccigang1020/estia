-- ============================================================================
-- 0046_autopilot.sql — ESTIA · the intelligent operations layer
--
-- What this is
--   Autopilot watches the operation ESTIA already runs, notices where the real
--   state has drifted from the expected one, and — inside guardrails the
--   customer set and the platform can override — does something about it.
--
--   It is NOT a second automation engine. `src/lib/automation/engine.ts`
--   already validates events, refuses another tenant's, checks the package,
--   checks the grant per action, claims idempotency and writes audit. Autopilot
--   sits ABOVE that: it decides WHAT should happen and WHETHER a person must
--   agree first, and then the work goes through the same domain commands a
--   human click goes through. Nothing here writes to bookings, tasks, orders,
--   payments or inventory. Every table in this file records a DECISION.
--
-- The five floors, outermost first
--   1. Platform capability      — `autopilot_capability`, and ESTIA can suspend
--   2. Plan entitlement         — `autopilot`, which is what the product reads
--   3. Organization level       — `autopilot_settings.level`
--   4. Policy matrix            — `autopilot_policies`, per action kind
--   5. Safety level             — a platform floor no customer can lower
--
--   Plus two narrowings: a property may sit lower than its organization, and a
--   booking may be marked manual-only. Neither may sit HIGHER, which is the
--   whole reason they are separate tables with their own CHECKs rather than a
--   nullable column somebody could set to 'autopilot' on one villa.
--
-- Why the capability state does not gate anything
--   `platform/capabilities.ts` argues that a second table answering "does this
--   customer have X" is a second answer, and the day the two disagree nobody
--   knows which one the customer is living in. So `autopilot_capability` holds
--   the platform's WORKFLOW — eligible, trial, suspended, and who decided —
--   and the gate stays the `autopilot` entitlement in
--   `organization_subscriptions`. The console writes both in one operation.
--   The rehearsal at the bottom asserts they cannot silently diverge.
--
-- Why the entitlement vocabulary moves again
--   0044 corrected three CHECK constraints to nineteen members and pinned the
--   count so that a twentieth added in TypeScript and forgotten here would fail
--   the next migration rather than the next customer. This is that twentieth,
--   and this is that failure arriving on time.
--
-- Depends on
--   0002 (permissions), 0003 (plans, organization_subscriptions), 0004 (RLS
--   helpers), 0041 (platform staff), 0044 (the entitlement constraints).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The twentieth entitlement
-- ============================================================================
-- Same shape as 0044, one member longer. Written out in full rather than as an
-- `array_append` on a constraint definition, because a constraint you cannot
-- read in one place is a constraint nobody checks against the TypeScript.

do $$
declare
  known text[] := array[
    'core', 'payments', 'invoicing', 'website', 'ai_content', 'custom_domain',
    'team', 'operations', 'laundry', 'commerce', 'channels',
    'dynamic_pricing', 'owner_portal', 'agent_network', 'approvals',
    'automation', 'custom_roles', 'multi_brand', 'api_access', 'autopilot'
  ];
begin
  alter table public.plans
    drop constraint if exists plans_entitlements_known;
  execute format(
    'alter table public.plans add constraint plans_entitlements_known ' ||
    'check (entitlements <@ %L::text[])', known
  );

  alter table public.organization_subscriptions
    drop constraint if exists organization_subscriptions_grants_known;
  execute format(
    'alter table public.organization_subscriptions ' ||
    'add constraint organization_subscriptions_grants_known ' ||
    'check (entitlement_grants <@ %L::text[])', known
  );

  alter table public.organization_subscriptions
    drop constraint if exists organization_subscriptions_revocations_known;
  execute format(
    'alter table public.organization_subscriptions ' ||
    'add constraint organization_subscriptions_revocations_known ' ||
    'check (entitlement_revocations <@ %L::text[])', known
  );
end $$;

-- Deliberately NOT added to any plan. `catalog.test.ts` lists `autopilot` in
-- ADD_ON_ONLY with the argument: the brief opens by saying Autopilot must not
-- be available automatically to every organization, and putting it on a
-- package is exactly how it would become available automatically to everyone
-- who bought that package. It reaches a customer through
-- `organization_subscriptions.entitlement_grants`, written by the console.


-- ============================================================================
-- 2 · The eight grants
-- ============================================================================
-- The floor beneath `autopilot.*` in `src/lib/authz/permissions.ts`. Three
-- times now a vocabulary has been widened in TypeScript and not in the schema
-- — 0035, 0044, and the `booking.manage` defect in 0042 — so this is written
-- in the same migration as the tables that need it rather than left to a later
-- catalogue wave.

insert into public.permissions (code, kind, category, is_owner_only, sort_order)
values
  ('autopilot.view',          'action'::public.permission_kind, 'governance', false, 1600),
  ('autopilot.use',           'action'::public.permission_kind, 'governance', false, 1610),
  -- Pressing the button on one prepared action. Never implies configure: a
  -- shift manager who may approve a reminder must not thereby be able to set
  -- the whole business to automatic.
  ('autopilot.approve',       'action'::public.permission_kind, 'governance', false, 1620),
  ('autopilot.configure',     'action'::public.permission_kind, 'governance', false, 1630),
  -- The kill switch and the pause. Separate from configure because it is
  -- urgent: the person who has to stop it at 23:00 is rarely the person who
  -- set it up, and making them wait for someone with configure rights is how a
  -- safety control becomes decorative.
  ('autopilot.pause',         'action'::public.permission_kind, 'governance', false, 1640),
  ('autopilot.activity_view', 'action'::public.permission_kind, 'governance', false, 1650),
  ('autopilot.override',      'action'::public.permission_kind, 'governance', false, 1660),
  ('autopilot.rules_manage',  'action'::public.permission_kind, 'governance', false, 1670)
on conflict (code) do nothing;


-- ============================================================================
-- 3 · Platform capability
-- ============================================================================

do $$ begin
  create type public.autopilot_capability_state as enum (
    'not_available',
    'eligible',
    'trial',
    'enabled',
    'suspended',
    'disabled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.autopilot_capability_state is
  'Transcribed from AUTOPILOT_CAPABILITY_STATES. The platform''s record of WHY an organization does or does not hold the autopilot entitlement. Not the gate — the entitlement is the gate, so that the product reads one answer.';

create table if not exists public.autopilot_capability (
  organization_id   uuid primary key references public.organizations (id) on delete cascade,
  state             public.autopilot_capability_state not null default 'not_available',
  trial_ends_at     timestamptz,
  action_limit      integer,
  note              text,
  decided_by        uuid references auth.users (id) on delete set null,
  decided_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  constraint autopilot_capability_trial_has_end check (
    state <> 'trial'::public.autopilot_capability_state or trial_ends_at is not null
  ),
  constraint autopilot_capability_suspension_has_note check (
    state not in (
      'suspended'::public.autopilot_capability_state,
      'disabled'::public.autopilot_capability_state
    )
    or (note is not null and length(btrim(note)) > 0)
  ),
  constraint autopilot_capability_limit_positive check (
    action_limit is null or action_limit > 0
  ),
  constraint autopilot_capability_version_positive check (version >= 1)
);

comment on table public.autopilot_capability is
  'One row per organization ESTIA has made a decision about. No row means not_available, which is the honest default and not an unfinished state — most customers will never be offered this.';
comment on column public.autopilot_capability.trial_ends_at is
  'Enforced rather than remembered: a trial with no end is a free tier nobody decided to sell. The CHECK refuses a trial without one.';
comment on column public.autopilot_capability.note is
  'Required to suspend or disable. Somebody withdrew a capability from a paying customer and the reason must survive the person who withdrew it.';
comment on column public.autopilot_capability.action_limit is
  'Optional ceiling on automatic actions per day, for a beta cohort. Null is no ceiling, not zero.';

drop trigger if exists autopilot_capability_touch on public.autopilot_capability;
create trigger autopilot_capability_touch
  before update on public.autopilot_capability
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 4 · Organization settings
-- ============================================================================

do $$ begin
  create type public.autopilot_level as enum (
    'off',
    'advisory',
    'assisted',
    'autopilot',
    'custom'
  );
exception when duplicate_object then null;
end $$;

comment on type public.autopilot_level is
  'Transcribed from AUTOPILOT_LEVELS in order. The first four are a ladder and each is a superset of the one before, so "at least assisted" is an ordinal comparison. `custom` is last deliberately: it means the policy matrix decides action by action, and no comparison should read it as the highest rung.';

do $$ begin
  create type public.autopilot_run_mode as enum ('live', 'simulation');
exception when duplicate_object then null;
end $$;

comment on type public.autopilot_run_mode is
  'simulation is not a debug flag. It is the rollout path: a business runs it for a fortnight, reads what ESTIA WOULD have done, and switches on real automation having already seen it. Everything downstream reads this one value, so no path can forget.';

create table if not exists public.autopilot_settings (
  organization_id        uuid primary key references public.organizations (id) on delete cascade,
  level                  public.autopilot_level not null default 'off',
  run_mode               public.autopilot_run_mode not null default 'simulation',
  simulation_started_at  timestamptz,
  -- The kill switch. A boolean rather than level='off' so that switching it
  -- back on restores the configuration the business spent an afternoon on
  -- instead of asking them to rebuild it under pressure.
  enabled                boolean not null default true,
  paused_until           timestamptz,
  paused_by              uuid references auth.users (id) on delete set null,
  paused_reason          text,
  preset                 text not null default 'safe',
  daily_brief_enabled    boolean not null default true,
  daily_brief_at         time not null default '07:30',
  evening_summary_enabled boolean not null default false,
  evening_summary_at     time not null default '20:00',
  lookahead_hours        integer not null default 72,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  created_by             uuid references auth.users (id) on delete set null,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users (id) on delete set null,
  version                integer not null default 1,
  constraint autopilot_settings_preset_known check (
    preset in ('safe', 'advanced', 'custom')
  ),
  constraint autopilot_settings_lookahead_range check (
    lookahead_hours between 1 and 336
  ),
  constraint autopilot_settings_pause_has_actor check (
    paused_until is null or paused_by is not null
  ),
  constraint autopilot_settings_version_positive check (version >= 1)
);

comment on table public.autopilot_settings is
  'What one organization has let ESTIA do. No row means level `off` and run_mode `simulation`, which is a complete and deliberately timid configuration: a customer whose entitlement was granted this morning must not wake up to messages having been sent overnight.';
comment on column public.autopilot_settings.run_mode is
  'Defaults to simulation even for a customer who chose `autopilot`. Switching to live is its own decision, made on a screen that shows what simulation recorded.';
comment on column public.autopilot_settings.enabled is
  'The kill switch, and separate from `level` on purpose. Turning it off must not cost the business the policy matrix they configured, because the moment they need it off is the moment they have no time to rebuild it.';
comment on column public.autopilot_settings.paused_until is
  'A temporary stop — an hour, a day, until a date. Past that instant the row means nothing and the engine ignores it, so an expired pause cannot silently keep a business switched off.';

drop trigger if exists autopilot_settings_touch on public.autopilot_settings;
create trigger autopilot_settings_touch
  before update on public.autopilot_settings
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 5 · Property narrowing
-- ============================================================================
-- A property may sit LOWER than its organization and never higher. Gradual
-- adoption is the use case: the whole business on advisory, one villa on
-- autopilot — no, the other way round, and that asymmetry is the point. A
-- business rolling this out moves one property UP by moving the organization
-- up and holding the others DOWN.

create table if not exists public.autopilot_property_settings (
  property_id      uuid primary key references public.properties (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  level            public.autopilot_level not null,
  note             text,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  constraint autopilot_property_settings_not_custom check (
    level <> 'custom'::public.autopilot_level
  ),
  constraint autopilot_property_settings_version_positive check (version >= 1)
);

comment on table public.autopilot_property_settings is
  'A property held BELOW its organization. `custom` is refused because a second policy matrix per property is a second set of rules to reason about during an incident; a property narrows the ladder or it says nothing.';

drop trigger if exists autopilot_property_settings_touch on public.autopilot_property_settings;
create trigger autopilot_property_settings_touch
  before update on public.autopilot_property_settings
  for each row execute function public.tg_touch_row();

create index if not exists autopilot_property_settings_org_idx
  on public.autopilot_property_settings (organization_id);


-- ============================================================================
-- 6 · Booking narrowing
-- ============================================================================

do $$ begin
  create type public.autopilot_booking_handling as enum (
    'normal',
    'high_attention',
    'manual_only'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.autopilot_booking_overrides (
  booking_id       uuid primary key references public.bookings (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  handling         public.autopilot_booking_handling not null,
  note             text,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  constraint autopilot_booking_overrides_version_positive check (version >= 1)
);

comment on table public.autopilot_booking_overrides is
  'One booking treated differently — a wedding, a returning VIP, a complaint in progress. A table rather than a column on bookings: this is Autopilot''s opinion about a booking, not a fact about it, and bookings already carries enough that other modules must not add to.';
comment on column public.autopilot_booking_overrides.handling is
  'high_attention keeps every watch running and stops every outward action without a person. manual_only stops the actions too. Neither stops the WATCHING, because the bookings somebody marks are the ones they most want to be warned about.';

drop trigger if exists autopilot_booking_overrides_touch on public.autopilot_booking_overrides;
create trigger autopilot_booking_overrides_touch
  before update on public.autopilot_booking_overrides
  for each row execute function public.tg_touch_row();

create index if not exists autopilot_booking_overrides_org_idx
  on public.autopilot_booking_overrides (organization_id, handling);


-- ============================================================================
-- 7 · The policy matrix
-- ============================================================================

do $$ begin
  create type public.autopilot_disposition as enum (
    'off',
    'suggest',
    'ask_approval',
    'auto'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.action_safety_level as enum (
    'information',
    'safe_internal',
    'external_communication',
    'business_impact',
    'money_access_cancellation'
  );
exception when duplicate_object then null;
end $$;

comment on type public.action_safety_level is
  'Transcribed from ACTION_SAFETY_LEVELS, ascending. The names carry the meaning rather than the 0..4 of the brief, because a column holding `3` is a column nobody can read during an incident. The whole safety engine is an ordinal comparison against this order.';

create table if not exists public.autopilot_policies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  property_id      uuid references public.properties (id) on delete cascade,
  action_kind      text not null,
  disposition      public.autopilot_disposition not null default 'suggest',
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,
  constraint autopilot_policies_action_kind_shape check (
    action_kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  constraint autopilot_policies_version_positive check (version >= 1)
);

comment on table public.autopilot_policies is
  'One cell of the matrix: what Autopilot may do with one action kind, for one organization, optionally narrowed to one property. A missing row means the level''s default rather than `off`, so a business can move the whole ladder without having written a row per action first.';
comment on column public.autopilot_policies.action_kind is
  'A member of the action catalogue in `src/lib/autopilot/actions.ts`. Text rather than an enum for the same reason `notifications.event_name` is: the catalogue is frozen in TypeScript, it grows, and a second copy as a Postgres enum is a second catalogue to migrate in step. The shape is constrained here; the vocabulary is constrained by the only type the engine accepts.';

create unique index if not exists autopilot_policies_org_action_idx
  on public.autopilot_policies (organization_id, action_kind)
  where property_id is null;

create unique index if not exists autopilot_policies_property_action_idx
  on public.autopilot_policies (property_id, action_kind)
  where property_id is not null;

drop trigger if exists autopilot_policies_touch on public.autopilot_policies;
create trigger autopilot_policies_touch
  before update on public.autopilot_policies
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 8 · Platform safety floor
-- ============================================================================
-- What no customer may switch to `auto`, whatever their matrix says. Owned by
-- ESTIA, not by the tenant: `organization_id` is deliberately absent, there is
-- no policy granting anybody but platform staff a write, and the decision
-- function reads it before it reads anything the customer configured.

create table if not exists public.autopilot_safety_rules (
  id                   uuid primary key default gen_random_uuid(),
  action_kind          text,
  max_safety_level     public.action_safety_level not null,
  max_disposition      public.autopilot_disposition not null,
  reason               text not null,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now(),
  constraint autopilot_safety_rules_reason_not_blank check (
    length(btrim(reason)) > 0
  ),
  constraint autopilot_safety_rules_action_kind_shape check (
    action_kind is null
    or action_kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  )
);

comment on table public.autopilot_safety_rules is
  'The ceiling a customer cannot raise. A null action_kind means every action at or above max_safety_level, which is the rule that actually matters and would otherwise have to be written once per action name.';

drop trigger if exists autopilot_safety_rules_touch on public.autopilot_safety_rules;
create trigger autopilot_safety_rules_touch
  before update on public.autopilot_safety_rules
  for each row execute function public.tg_touch_row();

-- The floor ESTIA ships with. Money, access and cancellation are never
-- automatic, and business-impact actions are never more than a prepared
-- suggestion, no matter what a customer sets. Seeded here rather than in
-- application code because a safety rule that lives only in a running process
-- is a safety rule that is absent during a migration, a backfill, or anything
-- somebody runs with psql at 02:00.
insert into public.autopilot_safety_rules
  (action_kind, max_safety_level, max_disposition, reason)
select null,
       'money_access_cancellation'::public.action_safety_level,
       'ask_approval'::public.autopilot_disposition,
       'Money, guest access and the loss of a booking are never automatic. A refund sent by mistake is a phone call; a cancellation sent by mistake is a family arriving at a locked door.'
where not exists (
  select 1 from public.autopilot_safety_rules
  where action_kind is null
    and max_safety_level = 'money_access_cancellation'::public.action_safety_level
);

insert into public.autopilot_safety_rules
  (action_kind, max_safety_level, max_disposition, reason)
select null,
       'business_impact'::public.action_safety_level,
       'ask_approval'::public.autopilot_disposition,
       'Changing a price, a discount or what a booking requires is a commercial decision. ESTIA may prepare one and may never make one.'
where not exists (
  select 1 from public.autopilot_safety_rules
  where action_kind is null
    and max_safety_level = 'business_impact'::public.action_safety_level
);


-- ============================================================================
-- 9 · Exceptions
-- ============================================================================

do $$ begin
  create type public.autopilot_domain as enum (
    'safety',
    'arrival_risk',
    'guest_access',
    'payment_risk',
    'preparation',
    'maintenance',
    'inventory',
    'laundry',
    'staff',
    'sales_opportunity',
    'optimization'
  );
exception when duplicate_object then null;
end $$;

comment on type public.autopilot_domain is
  'Transcribed from AUTOPILOT_DOMAINS, and the ORDER is the triage priority. Safety first, optimization last, and nothing reorders them per organization: a business that could put revenue above a guest being locked out is a business ESTIA should not help build.';

do $$ begin
  create type public.autopilot_risk_state as enum (
    'ready',
    'on_track',
    'at_risk',
    'critical'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.autopilot_exception_state as enum (
    'new',
    'acknowledged',
    'in_progress',
    'resolved',
    'dismissed'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.autopilot_exceptions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  property_id        uuid references public.properties (id) on delete cascade,
  domain             public.autopilot_domain not null,
  risk               public.autopilot_risk_state not null default 'at_risk',
  state              public.autopilot_exception_state not null default 'new',
  code               text not null,
  title              text not null,
  detail             text not null,
  -- What it is about. Text rather than a foreign key per module, because an
  -- exception can be about a booking, a task, a laundry order or a unit, and
  -- eleven nullable columns is eleven ways to write a row that points at
  -- nothing.
  resource_type      text not null,
  resource_id        text,
  evidence           jsonb not null default '[]'::jsonb,
  -- The dependency edge. A laundry delay causes an inventory shortage causes a
  -- preparation risk causes an arrival risk: four rows, one incident, and the
  -- screen shows the root with its consequences beneath it rather than four
  -- alarms that look unrelated at 06:00.
  caused_by          uuid references public.autopilot_exceptions (id) on delete set null,
  due_at             timestamptz,
  warn_at            timestamptz,
  critical_at        timestamptz,
  owner_user_id      uuid references auth.users (id) on delete set null,
  dedupe_key         text not null,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  seen_count         integer not null default 1,
  decided_at         timestamptz,
  decided_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            integer not null default 1,
  constraint autopilot_exceptions_dedupe unique (organization_id, dedupe_key),
  constraint autopilot_exceptions_code_shape check (
    code ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  constraint autopilot_exceptions_title_not_blank check (length(btrim(title)) > 0),
  constraint autopilot_exceptions_detail_not_blank check (length(btrim(detail)) > 0),
  constraint autopilot_exceptions_resource_not_blank check (
    length(btrim(resource_type)) > 0
  ),
  constraint autopilot_exceptions_evidence_is_array check (
    jsonb_typeof(evidence) = 'array'
  ),
  constraint autopilot_exceptions_not_self_caused check (caused_by is distinct from id),
  constraint autopilot_exceptions_decided_pair check (
    state not in (
      'resolved'::public.autopilot_exception_state,
      'dismissed'::public.autopilot_exception_state
    )
    or decided_at is not null
  ),
  constraint autopilot_exceptions_thresholds_ordered check (
    warn_at is null or critical_at is null or warn_at <= critical_at
  ),
  constraint autopilot_exceptions_seen_positive check (seen_count >= 1),
  constraint autopilot_exceptions_version_positive check (version >= 1)
);

comment on table public.autopilot_exceptions is
  'Something is not as it should be. One row per ONGOING problem rather than per detection: a shortage noticed on every pass for six hours is one exception with a seen_count of 72, not 72 alerts. The unique dedupe_key is what makes that a property of the shape rather than of every detector remembering to look first.';
comment on column public.autopilot_exceptions.evidence is
  'The facts that produced this, each with its source. What makes "Villa A may not be ready" answerable with "the cleaner has not started, typical preparation is 105 minutes, arrival is in 78" rather than with a number nobody can argue with.';
comment on column public.autopilot_exceptions.caused_by is
  'Points at the ROOT, not at the previous alert. Deduplication stops repeats of one problem; this stops four different problems that are really one from arriving as four.';
comment on column public.autopilot_exceptions.dedupe_key is
  'Derived from the code and the resource, never from the clock — a key containing a timestamp deduplicates nothing, which is the classic way this table would fill with the same row.';

create index if not exists autopilot_exceptions_open_idx
  on public.autopilot_exceptions (organization_id, domain, risk, due_at)
  where state in (
    'new'::public.autopilot_exception_state,
    'acknowledged'::public.autopilot_exception_state,
    'in_progress'::public.autopilot_exception_state
  );

create index if not exists autopilot_exceptions_property_idx
  on public.autopilot_exceptions (organization_id, property_id, last_seen_at desc);

create index if not exists autopilot_exceptions_root_idx
  on public.autopilot_exceptions (caused_by) where caused_by is not null;

create index if not exists autopilot_exceptions_resource_idx
  on public.autopilot_exceptions (organization_id, resource_type, resource_id);

drop trigger if exists autopilot_exceptions_touch on public.autopilot_exceptions;
create trigger autopilot_exceptions_touch
  before update on public.autopilot_exceptions
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 10 · Actions
-- ============================================================================

do $$ begin
  create type public.autopilot_action_outcome as enum (
    'planned',
    'awaiting_approval',
    'approved',
    'executed',
    'executed_unaudited',
    'failed',
    'retrying',
    'needs_review',
    'suppressed',
    'simulated',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

comment on type public.autopilot_action_outcome is
  'executed_unaudited is not a tidy state and is not meant to be: the work happened and the record of it did not. Both alternatives are lies, and it is exactly the state somebody needs to be told about. suppressed and simulated are first-class successes — an action correctly declined is the system working.';

do $$ begin
  create type public.autopilot_confidence as enum ('low', 'medium', 'high');
exception when duplicate_object then null;
end $$;

create table if not exists public.autopilot_actions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  property_id         uuid references public.properties (id) on delete cascade,
  exception_id        uuid references public.autopilot_exceptions (id) on delete set null,
  action_kind         text not null,
  safety_level        public.action_safety_level not null,
  disposition         public.autopilot_disposition not null,
  run_mode            public.autopilot_run_mode not null default 'live',
  outcome             public.autopilot_action_outcome not null default 'planned',
  confidence          public.autopilot_confidence not null default 'medium',
  -- WHY. Rendered to a person who asks "why did ESTIA do this?", so it is
  -- prose in their language and not a rule id they would have to look up.
  reason              text not null,
  trigger_event       text,
  evidence            jsonb not null default '[]'::jsonb,
  -- WHAT it asked the product to do. The input to a domain command, never a
  -- table name and never a column: Autopilot calls the same operation a person
  -- clicking a button calls, and this is that operation's request.
  command             text,
  command_input       jsonb not null default '{}'::jsonb,
  result              jsonb not null default '{}'::jsonb,
  suppressed_reason   text,
  error_code          text,
  error_detail        text,
  attempt             integer not null default 1,
  idempotency_key     text not null,
  correlation_id      uuid,
  requested_by        uuid references auth.users (id) on delete set null,
  approved_by         uuid references auth.users (id) on delete set null,
  approved_at         timestamptz,
  scheduled_for       timestamptz,
  executed_at         timestamptz,
  undone_at           timestamptz,
  undone_by           uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,
  constraint autopilot_actions_idempotent unique (organization_id, idempotency_key),
  constraint autopilot_actions_kind_shape check (
    action_kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  constraint autopilot_actions_reason_not_blank check (length(btrim(reason)) > 0),
  constraint autopilot_actions_evidence_is_array check (
    jsonb_typeof(evidence) = 'array'
  ),
  constraint autopilot_actions_attempt_positive check (attempt >= 1),
  -- Every refusal names itself. "Autopilot did nothing" with no reason
  -- attached is the fastest way to lose a customer's trust in it.
  constraint autopilot_actions_suppressed_has_reason check (
    outcome <> 'suppressed'::public.autopilot_action_outcome
    or (suppressed_reason is not null and length(btrim(suppressed_reason)) > 0)
  ),
  constraint autopilot_actions_failed_has_code check (
    outcome <> 'failed'::public.autopilot_action_outcome
    or (error_code is not null and length(btrim(error_code)) > 0)
  ),
  constraint autopilot_actions_approved_pair check (
    (approved_by is null) = (approved_at is null)
  ),
  constraint autopilot_actions_executed_has_time check (
    outcome not in (
      'executed'::public.autopilot_action_outcome,
      'executed_unaudited'::public.autopilot_action_outcome
    )
    or executed_at is not null
  ),
  -- A simulated run may not claim it did anything, and a live execution may
  -- not be filed as a simulation. This is the constraint that makes §97 —
  -- "verify no external action occurs" — a property of the schema.
  constraint autopilot_actions_simulation_never_executes check (
    run_mode <> 'simulation'::public.autopilot_run_mode
    or outcome in (
      'simulated'::public.autopilot_action_outcome,
      'suppressed'::public.autopilot_action_outcome,
      'cancelled'::public.autopilot_action_outcome,
      'planned'::public.autopilot_action_outcome
    )
  ),
  constraint autopilot_actions_live_never_simulated check (
    run_mode <> 'live'::public.autopilot_run_mode
    or outcome <> 'simulated'::public.autopilot_action_outcome
  ),
  constraint autopilot_actions_undone_pair check (
    (undone_at is null) = (undone_by is null)
  ),
  constraint autopilot_actions_version_positive check (version >= 1)
);

comment on table public.autopilot_actions is
  'Every action Autopilot planned, including every one it decided not to take. A table that recorded only what happened would show an empty screen to the customer most worried about what it might do — so suppressed, simulated and cancelled are rows here, and their count is what the activity screen reports.';
comment on column public.autopilot_actions.idempotency_key is
  'Unique per organization. Derived from the triggering event''s own key plus the action kind and the resource, so a redelivered webhook is a failed insert rather than a second message to the same guest. The guarantee is this constraint, not a handler remembering to look first.';
comment on column public.autopilot_actions.command is
  'The domain command this called — `defineOperation`, the same one a person''s click calls. Autopilot writes no business table directly, so validation, permissions, audit, events and invariants all still happen. A row here with a command nothing dispatches is the shape a bypass would take.';
comment on column public.autopilot_actions.reason is
  'Prose, in the reader''s language, composed when the decision was made and stored. Never re-derived: an action taken about a booking that has since been cancelled must still say what it said at the time.';
comment on column public.autopilot_actions.run_mode is
  'Copied from the settings at plan time and then owned here. Not a join, because reading it live would let a business switch to live at noon and have the morning''s simulated actions suddenly claim they were real.';

create index if not exists autopilot_actions_org_time_idx
  on public.autopilot_actions (organization_id, created_at desc);

create index if not exists autopilot_actions_pending_idx
  on public.autopilot_actions (organization_id, outcome, scheduled_for)
  where outcome in (
    'planned'::public.autopilot_action_outcome,
    'awaiting_approval'::public.autopilot_action_outcome,
    'approved'::public.autopilot_action_outcome,
    'retrying'::public.autopilot_action_outcome
  );

create index if not exists autopilot_actions_review_idx
  on public.autopilot_actions (organization_id, created_at desc)
  where outcome in (
    'failed'::public.autopilot_action_outcome,
    'needs_review'::public.autopilot_action_outcome,
    'executed_unaudited'::public.autopilot_action_outcome
  );

create index if not exists autopilot_actions_exception_idx
  on public.autopilot_actions (exception_id) where exception_id is not null;

drop trigger if exists autopilot_actions_touch on public.autopilot_actions;
create trigger autopilot_actions_touch
  before update on public.autopilot_actions
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 11 · Learned patterns
-- ============================================================================
-- An observed pattern is NOT a rule, and this table exists so the two can
-- never be confused. Nothing reads `autopilot_rule_candidates` when deciding
-- what to do; the decision engine reads `autopilot_policies` and the module's
-- own configuration. A candidate becomes real only when a person with
-- `autopilot.rules_manage` acts on it, and what they create is an ordinary row
-- in whichever table already owns that rule.

do $$ begin
  create type public.autopilot_rule_candidate_state as enum (
    'observed',
    'proposed',
    'adopted',
    'rejected',
    'muted'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.autopilot_rule_candidates (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  property_id       uuid references public.properties (id) on delete cascade,
  state             public.autopilot_rule_candidate_state not null default 'observed',
  pattern_code      text not null,
  summary           text not null,
  -- The evidence a person needs to agree or disagree: what was observed, how
  -- many times, over what period, and what the suggested rule would do.
  occurrences       integer not null default 1,
  observed_from     date not null,
  observed_to       date not null,
  sample            jsonb not null default '[]'::jsonb,
  proposal          jsonb not null default '{}'::jsonb,
  decided_at        timestamptz,
  decided_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  version           integer not null default 1,
  constraint autopilot_rule_candidates_unique
    unique (organization_id, property_id, pattern_code),
  constraint autopilot_rule_candidates_code_shape check (
    pattern_code ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  constraint autopilot_rule_candidates_summary_not_blank check (
    length(btrim(summary)) > 0
  ),
  constraint autopilot_rule_candidates_occurrences_positive check (occurrences >= 1),
  constraint autopilot_rule_candidates_window_ordered check (observed_to >= observed_from),
  constraint autopilot_rule_candidates_sample_is_array check (
    jsonb_typeof(sample) = 'array'
  ),
  constraint autopilot_rule_candidates_decided_pair check (
    state not in (
      'adopted'::public.autopilot_rule_candidate_state,
      'rejected'::public.autopilot_rule_candidate_state
    )
    or (decided_at is not null and decided_by is not null)
  ),
  constraint autopilot_rule_candidates_version_positive check (version >= 1)
);

comment on table public.autopilot_rule_candidates is
  'What the business keeps doing by hand. A PROPOSAL and never a rule: nothing in the decision path reads this table, and `adopted` requires a named person and a timestamp because turning somebody''s habit into a standing instruction is a decision they have to have made.';
comment on column public.autopilot_rule_candidates.proposal is
  'What the rule WOULD be, in the vocabulary of whichever module owns it. Stored rather than regenerated so that what a person approved is what gets created, even if the pattern has moved on since.';

create index if not exists autopilot_rule_candidates_open_idx
  on public.autopilot_rule_candidates (organization_id, state, occurrences desc);

drop trigger if exists autopilot_rule_candidates_touch on public.autopilot_rule_candidates;
create trigger autopilot_rule_candidates_touch
  before update on public.autopilot_rule_candidates
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- 12 · Row level security
-- ============================================================================

alter table public.autopilot_capability          enable row level security;
alter table public.autopilot_capability          force  row level security;
alter table public.autopilot_settings            enable row level security;
alter table public.autopilot_settings            force  row level security;
alter table public.autopilot_property_settings   enable row level security;
alter table public.autopilot_property_settings   force  row level security;
alter table public.autopilot_booking_overrides   enable row level security;
alter table public.autopilot_booking_overrides   force  row level security;
alter table public.autopilot_policies            enable row level security;
alter table public.autopilot_policies            force  row level security;
alter table public.autopilot_safety_rules        enable row level security;
alter table public.autopilot_safety_rules        force  row level security;
alter table public.autopilot_exceptions          enable row level security;
alter table public.autopilot_exceptions          force  row level security;
alter table public.autopilot_actions             enable row level security;
alter table public.autopilot_actions             force  row level security;
alter table public.autopilot_rule_candidates     enable row level security;
alter table public.autopilot_rule_candidates     force  row level security;

revoke all on public.autopilot_capability        from anon, authenticated;
revoke all on public.autopilot_settings          from anon, authenticated;
revoke all on public.autopilot_property_settings from anon, authenticated;
revoke all on public.autopilot_booking_overrides from anon, authenticated;
revoke all on public.autopilot_policies          from anon, authenticated;
revoke all on public.autopilot_safety_rules      from anon, authenticated;
revoke all on public.autopilot_exceptions        from anon, authenticated;
revoke all on public.autopilot_actions           from anon, authenticated;
revoke all on public.autopilot_rule_candidates   from anon, authenticated;

grant select                         on public.autopilot_capability        to authenticated;
grant select, insert, update         on public.autopilot_settings          to authenticated;
grant select, insert, update, delete on public.autopilot_property_settings to authenticated;
grant select, insert, update, delete on public.autopilot_booking_overrides to authenticated;
grant select, insert, update, delete on public.autopilot_policies          to authenticated;
grant select                         on public.autopilot_safety_rules      to authenticated;
grant select, insert, update         on public.autopilot_exceptions        to authenticated;
grant select, insert, update         on public.autopilot_actions           to authenticated;
grant select, insert, update         on public.autopilot_rule_candidates   to authenticated;

grant select, insert, update         on public.autopilot_capability        to service_role;
grant select, insert, update         on public.autopilot_settings          to service_role;
grant select, insert, update, delete on public.autopilot_property_settings to service_role;
grant select, insert, update, delete on public.autopilot_booking_overrides to service_role;
grant select, insert, update, delete on public.autopilot_policies          to service_role;
grant select, insert, update         on public.autopilot_safety_rules      to service_role;
grant select, insert, update         on public.autopilot_exceptions        to service_role;
grant select, insert, update         on public.autopilot_actions           to service_role;
grant select, insert, update         on public.autopilot_rule_candidates   to service_role;

-- The record of what Autopilot did is append-only in the ways that matter. An
-- action can be superseded, cancelled or undone — all of which are UPDATEs
-- that leave the row — and it can never be removed, because "ESTIA sent that
-- message" must not be deletable by the party who would most like it gone.
revoke delete, truncate on public.autopilot_actions    from authenticated, service_role;
revoke delete, truncate on public.autopilot_exceptions from authenticated, service_role;

-- The safety floor is ESTIA's. No tenant writes it, and service_role — which
-- carries BYPASSRLS and is the one caller a policy cannot stop — cannot delete
-- it either.
revoke insert, delete, truncate on public.autopilot_safety_rules
  from authenticated, service_role;
revoke update on public.autopilot_safety_rules from authenticated;

-- Capability is the platform's decision about a customer. The customer may
-- read it — being told "you are on trial until the 14th" is the point — and
-- may never write it.
revoke insert, update, delete, truncate on public.autopilot_capability
  from authenticated;


-- ============================================================================
-- 13 · Policies
-- ============================================================================

drop policy if exists autopilot_capability_select on public.autopilot_capability;
create policy autopilot_capability_select on public.autopilot_capability
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    or public.is_platform_staff()
  );

drop policy if exists autopilot_capability_platform_write on public.autopilot_capability;
create policy autopilot_capability_platform_write on public.autopilot_capability
  for all to authenticated
  using (public.has_platform_permission('platform.organization.manage'))
  with check (public.has_platform_permission('platform.organization.manage'));

drop policy if exists autopilot_settings_select on public.autopilot_settings;
create policy autopilot_settings_select on public.autopilot_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'autopilot.view')
  );

drop policy if exists autopilot_settings_insert on public.autopilot_settings;
create policy autopilot_settings_insert on public.autopilot_settings
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'autopilot.configure')
  );

-- Configure OR pause. The kill switch is on this row, and a person holding
-- only `autopilot.pause` must be able to reach it — the WITH CHECK cannot tell
-- which column moved, so the narrowing that `pause` may only flip `enabled`
-- and `paused_until` lives in the operation, and this policy is the floor that
-- keeps everybody else off the row entirely.
drop policy if exists autopilot_settings_update on public.autopilot_settings;
create policy autopilot_settings_update on public.autopilot_settings
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'autopilot.configure')
      or public.has_permission(organization_id, 'autopilot.pause')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'autopilot.configure')
      or public.has_permission(organization_id, 'autopilot.pause')
    )
  );

drop policy if exists autopilot_property_settings_select on public.autopilot_property_settings;
create policy autopilot_property_settings_select on public.autopilot_property_settings
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'autopilot.view')
  );

drop policy if exists autopilot_property_settings_write on public.autopilot_property_settings;
create policy autopilot_property_settings_write on public.autopilot_property_settings
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'autopilot.override')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.property_in_scope(property_id, organization_id)
    and public.has_permission(organization_id, 'autopilot.override')
  );

drop policy if exists autopilot_booking_overrides_select on public.autopilot_booking_overrides;
create policy autopilot_booking_overrides_select on public.autopilot_booking_overrides
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'autopilot.view')
  );

drop policy if exists autopilot_booking_overrides_write on public.autopilot_booking_overrides;
create policy autopilot_booking_overrides_write on public.autopilot_booking_overrides
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'autopilot.override')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'autopilot.override')
  );

drop policy if exists autopilot_policies_select on public.autopilot_policies;
create policy autopilot_policies_select on public.autopilot_policies
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.view')
  );

drop policy if exists autopilot_policies_write on public.autopilot_policies;
create policy autopilot_policies_write on public.autopilot_policies
  for all to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.configure')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.configure')
  );

-- Everybody who can see Autopilot at all can read the safety floor. A ceiling
-- the customer cannot see is a ceiling they will spend an afternoon trying to
-- configure their way past.
drop policy if exists autopilot_safety_rules_select on public.autopilot_safety_rules;
create policy autopilot_safety_rules_select on public.autopilot_safety_rules
  for select to authenticated
  using (true);

drop policy if exists autopilot_safety_rules_platform_write on public.autopilot_safety_rules;
create policy autopilot_safety_rules_platform_write on public.autopilot_safety_rules
  for update to authenticated
  using (public.has_platform_permission('platform.organization.manage'))
  with check (public.has_platform_permission('platform.organization.manage'));

drop policy if exists autopilot_exceptions_select on public.autopilot_exceptions;
create policy autopilot_exceptions_select on public.autopilot_exceptions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.view')
  );

drop policy if exists autopilot_exceptions_insert on public.autopilot_exceptions;
create policy autopilot_exceptions_insert on public.autopilot_exceptions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.use')
  );

drop policy if exists autopilot_exceptions_update on public.autopilot_exceptions;
create policy autopilot_exceptions_update on public.autopilot_exceptions
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.use')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.use')
  );

-- Reading the log needs `activity_view`, not `view`. Somebody who can see
-- today's exceptions is not thereby entitled to the full history of every
-- message ESTIA has sent on the business's behalf.
drop policy if exists autopilot_actions_select on public.autopilot_actions;
create policy autopilot_actions_select on public.autopilot_actions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.activity_view')
  );

drop policy if exists autopilot_actions_insert on public.autopilot_actions;
create policy autopilot_actions_insert on public.autopilot_actions
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.use')
  );

drop policy if exists autopilot_actions_update on public.autopilot_actions;
create policy autopilot_actions_update on public.autopilot_actions
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and (
      public.has_permission(organization_id, 'autopilot.approve')
      or public.has_permission(organization_id, 'autopilot.use')
    )
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and (
      public.has_permission(organization_id, 'autopilot.approve')
      or public.has_permission(organization_id, 'autopilot.use')
    )
  );

drop policy if exists autopilot_rule_candidates_select on public.autopilot_rule_candidates;
create policy autopilot_rule_candidates_select on public.autopilot_rule_candidates
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.view')
  );

drop policy if exists autopilot_rule_candidates_insert on public.autopilot_rule_candidates;
create policy autopilot_rule_candidates_insert on public.autopilot_rule_candidates
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'autopilot.use')
  );

drop policy if exists autopilot_rule_candidates_update on public.autopilot_rule_candidates;
create policy autopilot_rule_candidates_update on public.autopilot_rule_candidates
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'autopilot.rules_manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'autopilot.rules_manage')
  );


-- ============================================================================
-- 14 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
  n       integer;
begin
  select string_agg(name, ', ') into missing
  from (values
    ('autopilot_capability'), ('autopilot_settings'),
    ('autopilot_property_settings'), ('autopilot_booking_overrides'),
    ('autopilot_policies'), ('autopilot_safety_rules'),
    ('autopilot_exceptions'), ('autopilot_actions'),
    ('autopilot_rule_candidates')
  ) as t(name)
  where to_regclass('public.' || t.name) is null;
  if missing is not null then
    raise exception 'tables missing for 0046: %', missing;
  end if;

  -- The eight grants must exist as rows, not merely as TypeScript. This is the
  -- 0035 defect, and it has now happened three times.
  select string_agg(code, ', ') into missing
  from (values
    ('autopilot.view'), ('autopilot.use'), ('autopilot.approve'),
    ('autopilot.configure'), ('autopilot.pause'), ('autopilot.activity_view'),
    ('autopilot.override'), ('autopilot.rules_manage')
  ) as g(code)
  where not exists (
    select 1 from public.permissions where permissions.code = g.code
  );
  if missing is not null then
    raise exception 'autopilot permissions missing from the catalogue: %', missing;
  end if;

  -- The entitlement vocabulary is now twenty. Pinned for the same reason 0044
  -- pinned nineteen: a twenty-first added in TypeScript and forgotten here
  -- should fail the next migration, not the next customer who buys it.
  select count(*) into n
  from unnest(string_to_array(
    (select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'plans_entitlements_known'),
    ','
  ));
  if n <> 20 then
    raise exception
      'plans_entitlements_known lists % values, expected 20 to match ENTITLEMENTS', n;
  end if;

  if position('autopilot' in (
       select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'organization_subscriptions_grants_known')) = 0 then
    raise exception
      'organization_subscriptions_grants_known still refuses the autopilot entitlement, so no customer could ever be granted it';
  end if;

  -- Autopilot is add-on-only BY DESIGN. A plan carrying it would hand the
  -- capability to everyone on that package, which the brief opens by
  -- forbidding. Asserted by reading the rows, because this is the one place
  -- the decision is enforceable.
  if exists (select 1 from public.plans where 'autopilot' = any (entitlements)) then
    raise exception
      'a plan now carries the autopilot entitlement; it is add-on-only and is granted per customer through organization_subscriptions.entitlement_grants';
  end if;

  -- The safety floor must be present and must actually forbid something. A
  -- floor that exists and permits everything is the more dangerous of the two
  -- failures, because it reads as protection.
  if not exists (
    select 1 from public.autopilot_safety_rules
    where action_kind is null
      and max_safety_level = 'money_access_cancellation'::public.action_safety_level
      and max_disposition <> 'auto'::public.autopilot_disposition
  ) then
    raise exception
      'the money/access/cancellation safety rule is missing or permits auto — Autopilot could refund, cancel or unlock without a person';
  end if;

  if exists (
    select 1 from public.autopilot_safety_rules
    where max_disposition = 'auto'::public.autopilot_disposition
  ) then
    raise exception
      'a platform safety rule permits auto, which makes it a ceiling that is not a ceiling';
  end if;

  -- Simulation cannot execute. This is E2E section 97 as a constraint rather
  -- than as a test: the schema refuses the row, so no code path can produce it.
  if not exists (
    select 1 from pg_constraint
    where conname = 'autopilot_actions_simulation_never_executes'
      and conrelid = 'public.autopilot_actions'::regclass
  ) then
    raise exception
      'autopilot_actions_simulation_never_executes is missing — a simulated run could record a real execution';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'autopilot_actions_idempotent'
      and conrelid = 'public.autopilot_actions'::regclass
  ) then
    raise exception
      'autopilot_actions_idempotent is missing — one event could send the same guest two messages';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'autopilot_exceptions_dedupe'
      and conrelid = 'public.autopilot_exceptions'::regclass
  ) then
    raise exception
      'autopilot_exceptions_dedupe is missing — one ongoing problem would arrive as one alert per detection pass';
  end if;

  -- RLS everywhere, enabled AND forced.
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public'
    and c.relname like 'autopilot%'
    and c.relkind = 'r'
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if missing is not null then
    raise exception 'RLS not enabled and forced on: %', missing;
  end if;

  -- anon holds nothing. Autopilot reads the whole operation of a business and
  -- there is no public door onto any of it.
  select string_agg(distinct table_name, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee = 'anon'
    and table_name like 'autopilot%';
  if missing is not null then
    raise exception 'anon holds privileges on: %', missing;
  end if;

  -- The record cannot be erased, including by the role that bypasses RLS.
  select string_agg(distinct table_name || ' → ' || grantee, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('autopilot_actions', 'autopilot_exceptions')
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('DELETE', 'TRUNCATE');
  if missing is not null then
    raise exception 'delete is still granted on the Autopilot record: %', missing;
  end if;

  -- And the safety floor cannot be written by a tenant or dropped by anybody.
  select string_agg(distinct grantee, ', ') into missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'autopilot_safety_rules'
    and grantee in ('anon', 'authenticated', 'service_role')
    and privilege_type in ('INSERT', 'DELETE', 'TRUNCATE');
  if missing is not null then
    raise exception
      'the platform safety floor is writable by: % — a tenant could raise its own ceiling', missing;
  end if;

  -- No credential columns. Autopilot sends through the transports the
  -- notification module owns and holds no keys of its own.
  select string_agg(c.relname || '.' || a.attname, ', ') into missing
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n2 on n2.oid = c.relnamespace
  where n2.nspname = 'public'
    and c.relname like 'autopilot%'
    and c.relkind = 'r'
    and a.attnum > 0
    and not a.attisdropped
    and (a.attname like '%secret%'
         or a.attname like '%token%'
         or a.attname like '%api_key%'
         or a.attname like '%credential%'
         or a.attname like '%password%');
  if missing is not null then
    raise exception '0046 carries credential columns and must not: %', missing;
  end if;

  select string_agg(name, ', ') into missing
  from (values
    ('autopilot_capability_touch'), ('autopilot_settings_touch'),
    ('autopilot_property_settings_touch'), ('autopilot_booking_overrides_touch'),
    ('autopilot_policies_touch'), ('autopilot_safety_rules_touch'),
    ('autopilot_exceptions_touch'), ('autopilot_actions_touch'),
    ('autopilot_rule_candidates_touch')
  ) as t(name)
  where not exists (
    select 1 from pg_trigger where tgname = t.name and not tgisinternal
  );
  if missing is not null then
    raise exception 'triggers missing for 0046: %', missing;
  end if;
end $$;
