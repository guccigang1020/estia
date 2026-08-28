-- ============================================================================
-- 0015_agent_network.sql — ESTIA · the commercial relationship above the
--                          membership
--
-- What this does
--   Closes the five gaps the agent domain in src/lib/agents/ found once it was
--   written against the schema rather than beside it:
--
--     1. `agent_commission_rules` (+ `agent_commission_rule_versions`) — the
--        commission rule as a record with history, which is what §8 asks for
--        and what "why did I get less than we agreed" needs to be answerable.
--     2. `agencies`, `agency_memberships`, `agency_agreements` — the entity
--        `bookings.agency_id` and `commissions.agency_id` have been pointing at
--        with no foreign key since 0009 and 0011.
--     3. Five columns on `commissions`, so a commission can explain itself:
--        `rule_id`, `rule_version`, `base`, `explanation`, `eligibility`.
--     4. `holds.extension_count`, which deletes the parallel ledger the domain
--        built to work around its absence, and without which the extension cap
--        cannot be enforced.
--     5. `agent_payout_batches` and `agent_payout_batch_lines`, so a payment is
--        a row with a unique reference rather than a group-by on free text.
--
-- ── The one table where the tenant rule does not apply ──────────────────────
--
--   `agencies` deliberately has **no `organization_id`**, and that absence is
--   the design rather than an omission. An agency sells for several businesses
--   at once — docs/ARCHITECTURE.md §12, and the header of
--   src/lib/agents/agency.ts — so an agency owned by one organization could not
--   sell for a second, which is the entire reason it is an entity and not a row
--   on somebody's team list.
--
--   Every other policy in this database is
--   `organization_id in (select my_organizations())`. This one cannot be, so it
--   is written out by hand from the two relationships that actually exist:
--
--     · **you are in it** — an active `agency_memberships` row for the caller;
--     · **your business works with it** — the caller is an active member of an
--       organization that has a non-draft `agency_agreements` row naming the
--       agency.
--
--   Non-draft rather than active, and that is a decision worth stating. A draft
--   is not a relationship and must not reveal that a rival's agency exists. A
--   *terminated* one still is: an agency that stopped working with a business
--   in March is still owed money on stays happening in August, and a statement
--   that cannot render the payee's name is a statement nobody can send. Access
--   to what the agency *sells* stops with the agreement — that is the ladders'
--   job, on each membership — but the identity of a counterparty the business
--   still owes money to does not vanish.
--
--   Both directions are proven in supabase/tests/agents.sql, with positive
--   controls, because a policy this shape is exactly the one where "nobody can
--   see anything" and "isolation works" look identical.
--
-- ── Scope arrays: NULL and '{}' are different answers ───────────────────────
--
--   `matchesScope` in src/lib/agents/commission.ts reads `null` as "any" and an
--   empty array as "nothing". So the scope columns on `agent_commission_rules`
--   are nullable with **no default**: a rule that names no properties applies
--   everywhere, and a rule whose property list was emptied applies nowhere.
--   Defaulting them to '{}' would silently turn every unscoped rule into a rule
--   that pays nobody.
--
-- Depends on
--   0001 (organizations, tg_touch_row), 0004 (my_organizations,
--   has_permission), 0008 (properties, units), 0009 (bookings, holds), 0011
--   (commissions), 0012 (the agent-network permission codes this file's
--   policies name).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- Types
-- ============================================================================

-- COMMISSION_BASES, from src/lib/agents/commission.ts.
do $$ begin
  create type public.commission_base as enum ('whole_booking', 'accommodation_only');
exception when duplicate_object then null;
end $$;

comment on type public.commission_base is
  'What the commission is computed on. whole_booking is everything the guest pays; accommodation_only is the nights alone. A refundable deposit is excluded from both — nobody earns commission on money going back to the guest — and so is a previously written commission line, so recalculating cannot pay commission on commission.';

-- COMMISSION_RULE_KINDS.
do $$ begin
  create type public.commission_rule_kind as enum ('none', 'percentage', 'fixed', 'tiered');
exception when duplicate_object then null;
end $$;

comment on type public.commission_rule_kind is
  'Transcribed from COMMISSION_RULE_KINDS. `none` is an agent with no commission — a real arrangement, and deliberately not the same as a percentage of zero.';

-- COMMISSION_CONDITIONS. The eligibility ladder: a commission is a promise long
-- before it is a debt, and these are the facts that turn one into the other.
do $$ begin
  create type public.commission_condition as enum (
    'deposit_received',
    'payment_received',
    'guest_arrived',
    'stay_completed',
    'cancellation_window_passed'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.agency_status as enum ('active', 'inactive');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.agency_member_role as enum ('manager', 'agent');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.agency_membership_status as enum ('active', 'suspended', 'removed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.agency_agreement_status as enum ('draft', 'active', 'terminated');
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- agencies — the one table with no organization_id
-- ============================================================================

create table if not exists public.agencies (
  id                  uuid primary key default gen_random_uuid(),

  name                text not null,
  -- For the invoice the business receives. Never per-organization: it is the
  -- agency's own tax identity, the same in every deal it signs.
  tax_id              text,

  contact_phone       text,
  -- Generated for the same reason guests.phone_e164 is: so no write path can
  -- skip it and no two spellings of one number can disagree.
  contact_phone_e164  text generated always as (public.normalize_phone_il(contact_phone)) stored,
  contact_email       citext,

  address_line1       text,
  city                text,
  country             text not null default 'IL',

  status              public.agency_status not null default 'active',
  note                text,

  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,
  deleted_at          timestamptz,
  deleted_by          uuid references auth.users (id) on delete set null,

  constraint agencies_name_not_blank check (length(btrim(name)) > 0),
  constraint agencies_country_format check (country ~ '^[A-Z]{2}$'),
  constraint agencies_email_format check (
    contact_email is null or (contact_email::text) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint agencies_version_positive check (version >= 1),
  constraint agencies_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.agencies is
  'An agency, globally. It carries no organization_id, and that absence is the design: an agency sells for several organizations at once, so one that belonged to a single tenant could not be what it is. Its row level security is therefore written by hand from two relationships — membership of the agency, and a non-draft agreement with the caller organization — and is the only policy in this database not expressed as organization_id IN (SELECT my_organizations()).';
comment on column public.agencies.tax_id is
  'The agency own tax identity, used on the invoice the business receives. Unique among live agencies: two rows with one tax id are one legal entity entered twice.';

-- A legal entity, once. Name is deliberately not unique — two unrelated
-- agencies really can be called the same thing — but a tax id is the state's
-- own identifier and a duplicate is a data-entry error.
create unique index if not exists agencies_tax_id_idx
  on public.agencies (tax_id) where tax_id is not null and deleted_at is null;
create index if not exists agencies_name_idx
  on public.agencies (lower(name)) where deleted_at is null;
create index if not exists agencies_phone_idx
  on public.agencies (contact_phone_e164) where contact_phone_e164 is not null;

drop trigger if exists agencies_touch on public.agencies;
create trigger agencies_touch
  before update on public.agencies
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- agency_memberships — also global
-- ============================================================================
-- A person is a member of the agency, not of the agency-inside-one-business.
-- The same person then holds a separate ESTIA membership per organization, with
-- its own ladders; this table says nothing about what they may do, only who
-- they sell under.

create table if not exists public.agency_memberships (
  agency_id   uuid not null references public.agencies (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,

  role        public.agency_member_role not null default 'agent',
  status      public.agency_membership_status not null default 'active',

  joined_at   timestamptz not null default now(),
  left_at     timestamptz,

  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1,

  primary key (agency_id, user_id),
  constraint agency_memberships_left_pair check (
    status <> 'removed' or left_at is not null
  ),
  constraint agency_memberships_version_positive check (version >= 1)
);

comment on table public.agency_memberships is
  'Who sells under an agency banner. Global, like the agency itself. It confers no permission in any organization: what an agent may do comes from their ESTIA membership and its ladders, and this row only says whose banner they carry.';

create index if not exists agency_memberships_user_idx
  on public.agency_memberships (user_id) where status = 'active';
create index if not exists agency_memberships_agency_idx
  on public.agency_memberships (agency_id, status);

drop trigger if exists agency_memberships_touch on public.agency_memberships;
create trigger agency_memberships_touch
  before update on public.agency_memberships
  for each row execute function public.tg_touch_row();


-- ============================================================================
-- agency_agreements — the bridge, and the only tenant-shaped table here
-- ============================================================================
-- A commercial document with a start and an end. Ending it removes the agency's
-- reach without deleting anything: the bookings, the commissions and the
-- attribution all stand, and only the access stops.

create table if not exists public.agency_agreements (
  id                  uuid primary key default gen_random_uuid(),
  agency_id           uuid not null references public.agencies (id) on delete restrict,
  organization_id     uuid not null references public.organizations (id) on delete cascade,

  -- The commercial terms, in the same shape as agent_commission_rules.rule.
  rule                jsonb not null default '{"kind":"none"}'::jsonb,
  base                public.commission_base not null default 'whole_booking',

  active_from         date not null default current_date,
  active_until        date,
  payment_terms_days  integer not null default 30,

  status              public.agency_agreement_status not null default 'draft',
  signed_at           timestamptz,
  terminated_at       timestamptz,
  termination_reason  text,

  note                text,
  metadata            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id) on delete set null,
  version             integer not null default 1,

  constraint agency_agreements_id_organization_key unique (id, organization_id),
  constraint agency_agreements_dates_ordered check (
    active_until is null or active_until >= active_from
  ),
  constraint agency_agreements_terms_nonnegative check (payment_terms_days >= 0),
  constraint agency_agreements_rule_kind check (
    rule ->> 'kind' in ('none', 'percentage', 'fixed', 'tiered')
  ),
  constraint agency_agreements_terminated_pair check (
    (status = 'terminated') = (terminated_at is not null)
  ),
  constraint agency_agreements_version_positive check (version >= 1)
);

comment on table public.agency_agreements is
  'What connects an agency to an organization: a commercial document with a start and an end. Terminating it stops the access and touches nothing else — an agency that stopped working with a business in March is still owed money on stays happening in August.';

-- One live agreement per pair. Two active agreements would mean two commission
-- rules for the same sale, and no principled way to choose between them.
create unique index if not exists agency_agreements_live_idx
  on public.agency_agreements (agency_id, organization_id)
  where status = 'active';
create index if not exists agency_agreements_organization_idx
  on public.agency_agreements (organization_id, status);
create index if not exists agency_agreements_agency_idx
  on public.agency_agreements (agency_id, status);

drop trigger if exists agency_agreements_touch on public.agency_agreements;
create trigger agency_agreements_touch
  before update on public.agency_agreements
  for each row execute function public.tg_touch_row();


-- ── Closing the bare uuid columns 0009 and 0011 left open ───────────────────
-- `bookings.agency_id` and `commissions.agency_id` have been uuid with no
-- foreign key since they were created, because the table they point at did not
-- exist. RESTRICT rather than CASCADE or SET NULL: attribution is what a
-- commission argument is settled from, and an agency whose name is on a booking
-- is not something to erase.

do $$ begin
  alter table public.bookings
    add constraint bookings_agency_fkey
    foreign key (agency_id) references public.agencies (id) on delete restrict;
exception when duplicate_object or duplicate_table then null;
end $$;

do $$ begin
  alter table public.commissions
    add constraint commissions_agency_fkey
    foreign key (agency_id) references public.agencies (id) on delete restrict;
exception when duplicate_object or duplicate_table then null;
end $$;


-- ============================================================================
-- agent_commission_rules — the rule as a record
-- ============================================================================

create table if not exists public.agent_commission_rules (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,

  -- Both nullable, and both null is the organization's default rule. The domain
  -- picks the most specific match by priority; it is not this table's job.
  agent_user_id           uuid references auth.users (id) on delete cascade,
  agency_id               uuid references public.agencies (id) on delete restrict,

  name                    text,
  rule                    jsonb not null,
  base                    public.commission_base not null default 'whole_booking',

  -- ── Scope. NULL means "any"; '{}' means "nothing". No defaults, on purpose:
  -- defaulting to '{}' would turn every unscoped rule into one that pays
  -- nobody, which is the failure mode this comment exists to prevent.
  property_ids            uuid[],
  unit_ids                uuid[],
  rate_plan_ids           uuid[],
  period_from             date,
  period_to               date,

  eligibility_conditions  public.commission_condition[] not null default '{}',

  -- Higher wins when two rules both match.
  priority                integer not null default 0,
  effective_from          date,
  effective_until         date,

  note                    text,
  metadata                jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id) on delete set null,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id) on delete set null,
  version                 integer not null default 1,
  deleted_at              timestamptz,
  deleted_by              uuid references auth.users (id) on delete set null,

  constraint agent_commission_rules_id_organization_key unique (id, organization_id),
  constraint agent_commission_rules_rule_kind check (
    rule ->> 'kind' in ('none', 'percentage', 'fixed', 'tiered')
  ),
  -- A percentage rule needs a percentage; a fixed rule needs an amount; a
  -- tiered rule needs brackets. A rule that cannot be evaluated is a rule that
  -- silently pays nothing.
  constraint agent_commission_rules_rule_shape check (
    case rule ->> 'kind'
      when 'none'       then true
      when 'percentage' then jsonb_typeof(rule -> 'percent') = 'number'
      when 'fixed'      then jsonb_typeof(rule -> 'amountAgorot') = 'number'
      when 'tiered'     then jsonb_typeof(rule -> 'tiers') = 'array'
                             and jsonb_array_length(rule -> 'tiers') > 0
                             and (rule ->> 'mode') in ('marginal', 'whole')
      else false
    end
  ),
  constraint agent_commission_rules_period_ordered check (
    period_from is null or period_to is null or period_to >= period_from
  ),
  constraint agent_commission_rules_effective_ordered check (
    effective_from is null or effective_until is null or effective_until >= effective_from
  ),
  constraint agent_commission_rules_version_positive check (version >= 1),
  constraint agent_commission_rules_deleted_pair check (
    (deleted_at is null and deleted_by is null) or deleted_at is not null
  )
);

comment on table public.agent_commission_rules is
  'The commission rule: rate, base, scope and eligibility, with a version. §8 asks for a rule that is a record with history, and this is the current version of it — every version ever written is kept in agent_commission_rule_versions, which is what lets a commission from last year explain itself under last year terms.';
comment on column public.agent_commission_rules.property_ids is
  'NULL means any property; an empty array means no property at all. The two are different answers and matchesScope() in src/lib/agents/commission.ts reads them that way, which is why this column has no default.';
comment on column public.agent_commission_rules.eligibility_conditions is
  'The facts that must hold before the commission becomes eligible. An empty array means eligible as soon as it is created — which is a real arrangement, and the reason this one does default to empty.';

create index if not exists agent_commission_rules_organization_idx
  on public.agent_commission_rules (organization_id, priority desc) where deleted_at is null;
create index if not exists agent_commission_rules_agent_idx
  on public.agent_commission_rules (organization_id, agent_user_id) where agent_user_id is not null;
create index if not exists agent_commission_rules_agency_idx
  on public.agent_commission_rules (organization_id, agency_id) where agency_id is not null;

drop trigger if exists agent_commission_rules_touch on public.agent_commission_rules;
create trigger agent_commission_rules_touch
  before update on public.agent_commission_rules
  for each row execute function public.tg_touch_row();


-- ── The history ─────────────────────────────────────────────────────────────
-- A snapshot per version, written by trigger. This is what makes `rule_id` plus
-- `rule_version` on a commission mean something: without it, editing a rule
-- rewrites the terms of every commission ever calculated under it, which is
-- precisely the argument the module exists to prevent.

create table if not exists public.agent_commission_rule_versions (
  rule_id                 uuid not null,
  version                 integer not null,
  organization_id         uuid not null,

  agent_user_id           uuid,
  agency_id               uuid,
  name                    text,
  rule                    jsonb not null,
  base                    public.commission_base not null,
  property_ids            uuid[],
  unit_ids                uuid[],
  rate_plan_ids           uuid[],
  period_from             date,
  period_to               date,
  eligibility_conditions  public.commission_condition[] not null,
  priority                integer not null,
  effective_from          date,
  effective_until         date,

  recorded_at             timestamptz not null default now(),
  recorded_by             uuid references auth.users (id) on delete set null,

  primary key (rule_id, version),
  constraint agent_commission_rule_versions_rule_fkey
    foreign key (rule_id, organization_id)
    references public.agent_commission_rules (id, organization_id) on delete cascade
);

comment on table public.agent_commission_rule_versions is
  'Every version of every commission rule, written by trigger and never by a caller. A commission stores rule_id and rule_version, and this is the table that turns that pair back into the terms as they stood — the answer to "why did I get less than we agreed".';

create index if not exists agent_commission_rule_versions_organization_idx
  on public.agent_commission_rule_versions (organization_id);

create or replace function public.tg_commission_rules_record_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.agent_commission_rule_versions (
    rule_id, version, organization_id, agent_user_id, agency_id, name, rule, base,
    property_ids, unit_ids, rate_plan_ids, period_from, period_to,
    eligibility_conditions, priority, effective_from, effective_until, recorded_by
  )
  values (
    new.id, new.version, new.organization_id, new.agent_user_id, new.agency_id,
    new.name, new.rule, new.base, new.property_ids, new.unit_ids, new.rate_plan_ids,
    new.period_from, new.period_to, new.eligibility_conditions, new.priority,
    new.effective_from, new.effective_until,
    coalesce(new.updated_by, new.created_by, (select auth.uid()))
  )
  on conflict (rule_id, version) do nothing;

  return null;
end;
$$;

comment on function public.tg_commission_rules_record_version() is
  'Snapshots a commission rule into agent_commission_rule_versions on every insert and update. SECURITY DEFINER because no caller is granted INSERT on that table: recording the terms must not be something a write path can skip.';

revoke all on function public.tg_commission_rules_record_version() from public, anon, authenticated, service_role;

drop trigger if exists agent_commission_rules_record_version on public.agent_commission_rules;
create trigger agent_commission_rules_record_version
  after insert or update on public.agent_commission_rules
  for each row execute function public.tg_commission_rules_record_version();


-- ============================================================================
-- commissions — five columns so a commission can explain itself
-- ============================================================================
-- The domain has been putting these in `metadata`, which works, is untyped and
-- is unconstrained: nothing stopped a row arriving with no rule reference at
-- all, and the first time that matters is during an argument about money.

alter table public.commissions
  add column if not exists rule_id      uuid,
  add column if not exists rule_version integer,
  add column if not exists base         public.commission_base not null default 'whole_booking',
  add column if not exists explanation  text,
  add column if not exists eligibility  jsonb not null default '[]'::jsonb;

do $$ begin
  alter table public.commissions
    add constraint commissions_rule_fkey
    foreign key (rule_id, organization_id)
    references public.agent_commission_rules (id, organization_id) on delete restrict;
exception when duplicate_object or duplicate_table then null;
end $$;

do $$ begin
  alter table public.commissions
    add constraint commissions_rule_version_pair check (
      (rule_id is null) = (rule_version is null)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.commissions
    add constraint commissions_eligibility_is_array check (
      jsonb_typeof(eligibility) = 'array'
    );
exception when duplicate_object then null;
end $$;

comment on column public.commissions.rule_id is
  'The rule this commission was calculated under. ON DELETE RESTRICT: a rule that has paid somebody is not deletable, because the commission would stop being explicable.';
comment on column public.commissions.rule_version is
  'The version of that rule at the moment of calculation. Together with rule_id it resolves against agent_commission_rule_versions, so editing the rule tomorrow does not rewrite what was agreed yesterday.';
comment on column public.commissions.explanation is
  'The sentence the calculation produced — "10% of ₪5,000". Stored rather than recomputed, because recomputing it next year would use next year rules.';
comment on column public.commissions.eligibility is
  'The conditions that had to hold, as a JSON array of commission_condition values. A commission whose conditions nobody recorded cannot be shown to have been earned.';

create index if not exists commissions_rule_idx
  on public.commissions (rule_id, rule_version) where rule_id is not null;


-- ============================================================================
-- holds.extension_count — deleting a parallel ledger
-- ============================================================================
-- src/lib/agents/holds.ts built `AgentHoldLedgerEntry` keyed by hold id purely
-- because `holds` carried neither a creation timestamp nor an extension
-- counter. It carries `created_at` already; this is the other half. With both,
-- the daily maximum and the extension cap are computable from the hold itself
-- and the parallel table stops being necessary.

alter table public.holds
  add column if not exists extension_count integer not null default 0;

do $$ begin
  alter table public.holds
    add constraint holds_extension_count_nonnegative check (extension_count >= 0);
exception when duplicate_object then null;
end $$;

comment on column public.holds.extension_count is
  'How many times this hold has been extended. The extension cap in §6 cannot be enforced without it, and its absence is why the agent domain kept a second ledger keyed by hold id.';

-- The daily cap counts an agent's holds since the start of their day.
create index if not exists holds_agent_created_idx
  on public.holds (organization_id, held_by_user_id, created_at);


-- ============================================================================
-- Payout batches — money grouped by a row, not by a string
-- ============================================================================

create table if not exists public.agent_payout_batches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  agent_user_id    uuid not null references auth.users (id) on delete restrict,
  agency_id        uuid references public.agencies (id) on delete restrict,

  -- The business's own reference for the payment. Unique per organization: a
  -- batch identified by a string nothing constrains is a batch that can be
  -- created twice and paid twice.
  reference        text not null,
  total_agorot     integer not null default 0,
  currency         text not null default 'ILS',

  note             text,
  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  paid_at          timestamptz,
  paid_by          uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  constraint agent_payout_batches_id_organization_key unique (id, organization_id),
  constraint agent_payout_batches_reference_key unique (organization_id, reference),
  constraint agent_payout_batches_reference_not_blank check (length(btrim(reference)) > 0),
  constraint agent_payout_batches_total_nonnegative check (total_agorot >= 0),
  constraint agent_payout_batches_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint agent_payout_batches_version_positive check (version >= 1)
);

comment on table public.agent_payout_batches is
  'One payment to one agent, covering many approved commissions. The reference is unique per organization, which is the difference between recording a payment and being able to reprint it — and between paying once and paying twice.';

create index if not exists agent_payout_batches_agent_idx
  on public.agent_payout_batches (organization_id, agent_user_id);
create index if not exists agent_payout_batches_agency_idx
  on public.agent_payout_batches (agency_id) where agency_id is not null;

drop trigger if exists agent_payout_batches_touch on public.agent_payout_batches;
create trigger agent_payout_batches_touch
  before update on public.agent_payout_batches
  for each row execute function public.tg_touch_row();


create table if not exists public.agent_payout_batch_lines (
  batch_id         uuid not null,
  commission_id    uuid not null,
  organization_id  uuid not null,

  amount_agorot    integer not null,
  created_at       timestamptz not null default now(),

  primary key (batch_id, commission_id),
  constraint agent_payout_batch_lines_batch_fkey
    foreign key (batch_id, organization_id)
    references public.agent_payout_batches (id, organization_id) on delete cascade,
  constraint agent_payout_batch_lines_commission_fkey
    foreign key (commission_id) references public.commissions (id) on delete restrict,
  -- The guarantee. One commission belongs to at most one batch, ever, and it is
  -- the database that says so rather than a check in buildPayoutBatch() that a
  -- second concurrent run would sail past.
  constraint agent_payout_batch_lines_commission_key unique (commission_id),
  constraint agent_payout_batch_lines_amount_nonnegative check (amount_agorot >= 0)
);

comment on table public.agent_payout_batch_lines is
  'Which commissions a payout covers. `unique (commission_id)` is the whole point: a commission can be in one batch and never in two, so "paid twice" stops being possible rather than being something an application check tries to notice.';

create index if not exists agent_payout_batch_lines_organization_idx
  on public.agent_payout_batch_lines (organization_id);
create index if not exists agent_payout_batch_lines_commission_idx
  on public.agent_payout_batch_lines (commission_id);

-- The batch total is the sum of its lines, maintained the way a booking total
-- is: owned by the database, never typed by a caller.
create or replace function public.tg_payout_lines_recalc_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := coalesce(new.batch_id, old.batch_id);
begin
  update public.agent_payout_batches b
     set total_agorot = coalesce((
           select sum(l.amount_agorot)
             from public.agent_payout_batch_lines l
            where l.batch_id = target), 0)
   where b.id = target;
  return null;
end;
$$;

comment on function public.tg_payout_lines_recalc_total() is
  'Keeps agent_payout_batches.total_agorot equal to the sum of its lines. A payout total that is not the sum of what it covers is a payment nobody can reconcile.';

revoke all on function public.tg_payout_lines_recalc_total() from public, anon, authenticated, service_role;

drop trigger if exists agent_payout_batch_lines_recalc_total on public.agent_payout_batch_lines;
create trigger agent_payout_batch_lines_recalc_total
  after insert or update or delete on public.agent_payout_batch_lines
  for each row execute function public.tg_payout_lines_recalc_total();


-- ============================================================================
-- The agency visibility helpers
-- ============================================================================
-- SECURITY DEFINER with an empty search_path, exactly as 0004 and 0008 built
-- theirs, and owned by `postgres` whose rolbypassrls is true — so a policy that
-- calls one of these cannot recurse through the policy on the table it reads.

create or replace function public.my_agencies()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select am.agency_id
  from public.agency_memberships am
  where am.user_id = (select auth.uid())
    and am.status = 'active'::public.agency_membership_status;
$$;

comment on function public.my_agencies() is
  'The agencies the caller actively belongs to. One half of the agencies policy: you can see an agency you are in.';

create or replace function public.agencies_my_organizations_work_with()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct aa.agency_id
  from public.agency_agreements aa
  join public.memberships m on m.organization_id = aa.organization_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'::public.membership_status
    and aa.status <> 'draft'::public.agency_agreement_status;
$$;

comment on function public.agencies_my_organizations_work_with() is
  'The agencies one of the caller organizations has a non-draft agreement with. The other half of the agencies policy. Non-draft rather than active on purpose: a draft is not a relationship and must not reveal that a rival agency exists, while a terminated one still is — an agency owed money for a past stay has to be nameable on the statement that pays it.';

create or replace function public.is_agency_manager(target_agency_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.agency_memberships am
    where am.agency_id = is_agency_manager.target_agency_id
      and am.user_id = (select auth.uid())
      and am.status = 'active'::public.agency_membership_status
      and am.role = 'manager'::public.agency_member_role
  );
$$;

comment on function public.is_agency_manager(uuid) is
  'Does the caller manage this agency? An agency has no organization to gate its own membership list on, so this is what stands in for it.';

-- `anon` by name, for the reason 0004 spells out: Supabase grants it EXECUTE on
-- every new function in `public` through ALTER DEFAULT PRIVILEGES, and a
-- REVOKE FROM PUBLIC leaves that grant standing. `authenticated` keeps EXECUTE
-- because a policy expression is evaluated with the querying role privileges.
revoke all on function public.my_agencies() from public, anon;
revoke all on function public.agencies_my_organizations_work_with() from public, anon;
revoke all on function public.is_agency_manager(uuid) from public, anon;
grant execute on function public.my_agencies() to authenticated, service_role;
grant execute on function public.agencies_my_organizations_work_with() to authenticated, service_role;
grant execute on function public.is_agency_manager(uuid) to authenticated, service_role;


-- ============================================================================
-- Row level security
-- ============================================================================

alter table public.agencies                      enable row level security;
alter table public.agencies                      force  row level security;
alter table public.agency_memberships            enable row level security;
alter table public.agency_memberships            force  row level security;
alter table public.agency_agreements             enable row level security;
alter table public.agency_agreements             force  row level security;
alter table public.agent_commission_rules        enable row level security;
alter table public.agent_commission_rules        force  row level security;
alter table public.agent_commission_rule_versions enable row level security;
alter table public.agent_commission_rule_versions force  row level security;
alter table public.agent_payout_batches          enable row level security;
alter table public.agent_payout_batches          force  row level security;
alter table public.agent_payout_batch_lines      enable row level security;
alter table public.agent_payout_batch_lines      force  row level security;

revoke all on public.agencies                       from anon, authenticated;
revoke all on public.agency_memberships             from anon, authenticated;
revoke all on public.agency_agreements              from anon, authenticated;
revoke all on public.agent_commission_rules         from anon, authenticated;
revoke all on public.agent_commission_rule_versions from anon, authenticated;
revoke all on public.agent_payout_batches           from anon, authenticated;
revoke all on public.agent_payout_batch_lines       from anon, authenticated;

grant select, insert, update         on public.agencies                 to authenticated;
grant select, insert, update         on public.agency_memberships       to authenticated;
grant select, insert, update         on public.agency_agreements        to authenticated;
grant select, insert, update, delete on public.agent_commission_rules   to authenticated;
grant select                         on public.agent_commission_rule_versions to authenticated;
grant select, insert, update         on public.agent_payout_batches     to authenticated;
grant select, insert, delete         on public.agent_payout_batch_lines to authenticated;

grant select, insert, update         on public.agencies                 to service_role;
grant select, insert, update         on public.agency_memberships       to service_role;
grant select, insert, update         on public.agency_agreements        to service_role;
grant select, insert, update, delete on public.agent_commission_rules   to service_role;
grant select                         on public.agent_commission_rule_versions to service_role;
grant select, insert, update         on public.agent_payout_batches     to service_role;
grant select, insert, delete         on public.agent_payout_batch_lines to service_role;

-- Supabase default privileges hand service_role everything on a new table, and
-- it carries BYPASSRLS. Taking these back is what makes the rules true for a
-- background job as well.
revoke insert, update, delete, truncate on public.agent_commission_rule_versions from service_role;
revoke delete, truncate                 on public.agencies                 from service_role;
revoke delete, truncate                 on public.agency_memberships       from service_role;
revoke delete, truncate                 on public.agency_agreements        from service_role;
revoke delete, truncate                 on public.agent_payout_batches     from service_role;


-- ── Policies · agencies ─────────────────────────────────────────────────────
-- The hand-written one. Read the header of this file before changing it.
--
-- INSERT carries neither test, and that is not an oversight: somebody creating
-- an agency is creating a row no relationship can name yet, exactly as 0004
-- found for organizations. The gate is the `agency.manage` grant in one of the
-- caller's own organizations, which is the narrowest thing that can be checked
-- before the agency exists.

drop policy if exists agencies_select on public.agencies;
create policy agencies_select on public.agencies
  for select to authenticated
  using (
    id in (select public.my_agencies())
    or id in (select public.agencies_my_organizations_work_with())
  );

drop policy if exists agencies_insert on public.agencies;
create policy agencies_insert on public.agencies
  for insert to authenticated
  with check (
    exists (
      select 1 from public.memberships m
      where m.user_id = (select auth.uid())
        and m.status = 'active'::public.membership_status
        and public.has_permission(m.organization_id, 'agency.manage')
    )
  );

-- Editing an agency belongs to the agency, not to a customer of it. A business
-- that works with an agency can read its details and cannot rewrite them.
drop policy if exists agencies_update on public.agencies;
create policy agencies_update on public.agencies
  for update to authenticated
  using (public.is_agency_manager(id))
  with check (public.is_agency_manager(id));


-- ── Policies · agency_memberships ───────────────────────────────────────────
-- Visible to the agency's own people, and to a business that works with them:
-- knowing which agents sell under a banner you have signed with is the point of
-- signing with a banner. Writable only by a manager of that agency.

drop policy if exists agency_memberships_select on public.agency_memberships;
create policy agency_memberships_select on public.agency_memberships
  for select to authenticated
  using (
    agency_id in (select public.my_agencies())
    or agency_id in (select public.agencies_my_organizations_work_with())
  );

drop policy if exists agency_memberships_insert on public.agency_memberships;
create policy agency_memberships_insert on public.agency_memberships
  for insert to authenticated
  with check (public.is_agency_manager(agency_id));

drop policy if exists agency_memberships_update on public.agency_memberships;
create policy agency_memberships_update on public.agency_memberships
  for update to authenticated
  using (
    public.is_agency_manager(agency_id)
    or user_id = (select auth.uid())
  )
  with check (
    public.is_agency_manager(agency_id)
    or user_id = (select auth.uid())
  );


-- ── Policies · agency_agreements ────────────────────────────────────────────
-- This one does have an organization_id, so the tenant rule applies to the
-- business side. The agency side is added beside it: an agency must be able to
-- read the terms it signed.

drop policy if exists agency_agreements_select on public.agency_agreements;
create policy agency_agreements_select on public.agency_agreements
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    or agency_id in (select public.my_agencies())
  );

drop policy if exists agency_agreements_insert on public.agency_agreements;
create policy agency_agreements_insert on public.agency_agreements
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent_agreement.manage')
  );

drop policy if exists agency_agreements_update on public.agency_agreements;
create policy agency_agreements_update on public.agency_agreements
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent_agreement.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent_agreement.manage')
  );


-- ── Policies · agent_commission_rules ───────────────────────────────────────
-- Ordinary tenant data. Reading the terms is `agent_agreement.view`; writing
-- them is `agent_agreement.manage`, which 0012 deliberately keeps apart from
-- `commission.approve` — whoever sets the price of a sale is not whoever
-- releases the money.

drop policy if exists agent_commission_rules_select on public.agent_commission_rules;
create policy agent_commission_rules_select on public.agent_commission_rules
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'agent_agreement.view')
      or agent_user_id = (select auth.uid())
    )
  );

drop policy if exists agent_commission_rules_insert on public.agent_commission_rules;
create policy agent_commission_rules_insert on public.agent_commission_rules
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent_agreement.manage')
  );

drop policy if exists agent_commission_rules_update on public.agent_commission_rules;
create policy agent_commission_rules_update on public.agent_commission_rules
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent_agreement.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent_agreement.manage')
  );

drop policy if exists agent_commission_rules_delete on public.agent_commission_rules;
create policy agent_commission_rules_delete on public.agent_commission_rules
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'agent_agreement.manage')
  );


-- ── Policies · agent_commission_rule_versions ───────────────────────────────
-- SELECT only. There is no INSERT policy because there is no INSERT grant: the
-- trigger writes it, and history a caller could write is not history.

drop policy if exists agent_commission_rule_versions_select on public.agent_commission_rule_versions;
create policy agent_commission_rule_versions_select on public.agent_commission_rule_versions
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'agent_agreement.view')
      or agent_user_id = (select auth.uid())
    )
  );


-- ── Policies · payout batches ───────────────────────────────────────────────
-- An agent may read their own payouts without holding any finance grant — it is
-- their money — and only `commission.payout` creates one.

drop policy if exists agent_payout_batches_select on public.agent_payout_batches;
create policy agent_payout_batches_select on public.agent_payout_batches
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (
      public.has_permission(organization_id, 'commission.view')
      or agent_user_id = (select auth.uid())
    )
  );

drop policy if exists agent_payout_batches_insert on public.agent_payout_batches;
create policy agent_payout_batches_insert on public.agent_payout_batches
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.payout')
  );

drop policy if exists agent_payout_batches_update on public.agent_payout_batches;
create policy agent_payout_batches_update on public.agent_payout_batches
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.payout')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.payout')
  );

drop policy if exists agent_payout_batch_lines_select on public.agent_payout_batch_lines;
create policy agent_payout_batch_lines_select on public.agent_payout_batch_lines
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and exists (
      select 1 from public.agent_payout_batches b
      where b.id = agent_payout_batch_lines.batch_id
        and b.organization_id = agent_payout_batch_lines.organization_id
        and (
          public.has_permission(b.organization_id, 'commission.view')
          or b.agent_user_id = (select auth.uid())
        )
    )
  );

drop policy if exists agent_payout_batch_lines_insert on public.agent_payout_batch_lines;
create policy agent_payout_batch_lines_insert on public.agent_payout_batch_lines
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.payout')
  );

-- A line may be taken off a batch that has not been paid yet. Once `paid_at` is
-- set the batch is a record of money that left, and 0010's rule applies: it is
-- corrected with another entry, not edited.
drop policy if exists agent_payout_batch_lines_delete on public.agent_payout_batch_lines;
create policy agent_payout_batch_lines_delete on public.agent_payout_batch_lines
  for delete to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'commission.payout')
    and exists (
      select 1 from public.agent_payout_batches b
      where b.id = agent_payout_batch_lines.batch_id
        and b.organization_id = agent_payout_batch_lines.organization_id
        and b.paid_at is null
    )
  );
