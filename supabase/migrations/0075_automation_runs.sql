-- ============================================================================
-- 0075_automation_runs.sql — ESTIA · what the rules decided, and the switch
--                            that would let them act
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- `0067_automation_rules.sql` gave a business the switch, and said in its own
-- WHAT IS NOT HERE section that nothing runs the rules: `(app)/_lib/events.ts`
-- publishes domain events to webhooks and nothing else, so an enabled rule was
-- an intention nobody read.
--
-- This migration is the half of that gap it is honest to close today, and it
-- deliberately is not the other half.
--
-- ── THE CONSTRAINT THAT SHAPES THIS FILE ───────────────────────────────────
--
-- **There are zero organizations on this database.** Nothing built here can be
-- observed working before it reaches a paying customer, and an automation
-- runner is software that acts on somebody's business by itself and sends
-- messages to their guests. Shipping the acting half untested against any real
-- data would be the most dangerous thing this repository could do.
--
-- So the work is split in two and only the first half is live:
--
--   1. **EVALUATION — live.** On every domain event the product raises, the
--      rules whose trigger matches are resolved against this organization's
--      stored state, their conditions are evaluated, and the DECISION is
--      recorded in `automation_runs`: which rule, which event, what it decided,
--      why, and what it WOULD have done. Nothing is performed. This is the
--      audit trail that makes switching the second half on safe, and it can be
--      read on screen from a customer's first day.
--
--   2. **PERFORMING — built, and off.** `automation_execution_consent` is the
--      switch, it is absent by default, and turning it on requires a person:
--      the CHECK below refuses `performing_enabled` without a `consented_by`,
--      and `consented_by` is taken from `auth.uid()` by a trigger rather than
--      from the caller. A service_role import cannot set it. No environment
--      variable reaches it. `automation_runs.performed_at` exists, is
--      constrained, and NOTHING in this deployment can write it: no role holds
--      UPDATE on the table and the one function that inserts leaves it null.
--      Making that column writable is a separate migration, made by somebody
--      who can watch what happens.
--
-- ── WHY THE RECORDER IS A SECURITY DEFINER FUNCTION ────────────────────────
--
-- The same problem 0061 was written for, and the same answer.
--
-- A receptionist confirms a booking. `booking.confirmed` is published. Three
-- library rules listen to it, and whether they are on is a row in
-- `automation_rules` — which 0067 gates behind `automation.view`, a grant only
-- an owner and a general manager hold. The receptionist can read neither the
-- rules nor write the decision, and both refusals are correct.
--
-- The obvious fix is to hand the request path a service-role client. That would
-- put a credential which bypasses row level security into every write path in
-- the product so that a decision can be logged. So the resolution and the write
-- happen HERE instead, inside one SECURITY DEFINER function, called with the
-- CALLER'S client. Membership is checked explicitly, because row level security
-- is bypassed in the body and that check is the only tenant boundary left.
--
-- And the function RETURNS NOTHING ABOUT THE CONFIGURATION. It reads
-- `automation_rules` internally and hands back a count. A function that
-- returned "this rule is on, with this threshold" would have quietly widened
-- 0067's read policy to every member of the organization; this one does not,
-- which is the same discipline `enqueue_webhook_deliveries` keeps around
-- `webhook_endpoints`.
--
-- ── WHY A THRESHOLD IS COMPARED IN SQL, WHICH LOOKS LIKE DUPLICATION ───────
--
-- The condition evaluator is `src/lib/automation/conditions.ts` and it is not
-- restated here. What IS restated is one numeric comparison, and only because
-- of the boundary above: the caller cannot see the stored threshold, so it
-- cannot finish the comparison that uses it.
--
-- The split is exactly the line `parameters.ts` already draws. A parameter may
-- only replace the NUMBER in a numeric condition that is already in the rule —
-- it cannot add a condition, change an action or change a trigger. So the
-- caller evaluates every condition a parameter cannot touch, in TypeScript,
-- with the real evaluator, and sends the remainder as a `gate`: a fact, an
-- operator and the shipped default. This function applies the stored number to
-- that gate and to nothing else.
--
-- The gate fails closed the way `conditions.ts` does: a fact that is absent or
-- is not a number does not match, rather than being coerced into one that does.
-- The rehearsal at the foot of this file exercises all four operators and both
-- refusals.
--
-- ── IDEMPOTENCY IS THE DATABASE'S JOB, NOT A GUARD IN TYPESCRIPT ───────────
--
-- `automation_runs_once` is `unique (organization_id, event_key, template_id)`
-- and the insert is `on conflict do nothing`. The same event delivered twice —
-- a retried request, a duplicated publish, two application instances racing —
-- produces one decision per rule and no error. A TypeScript "have I seen this"
-- check would be two statements with a window between them, and both callers
-- would win it.
--
-- ── WHAT THE RECORD DOES NOT CLAIM ─────────────────────────────────────────
--
-- It says what the RULE decided. It does not say the action would have been
-- allowed: the permission and plan floors are per action, they belong to
-- `runAutomations`, and the event bus has no actor to ask them about. A record
-- reading `would_act` therefore means "this rule is on here and its conditions
-- held", not "this would have happened" — and the screen says so in Hebrew
-- rather than letting a row imply an engine.
--
-- Depends on 0001 (organizations), 0004 (`my_organizations`, `has_permission`),
-- 0008 (properties) and 0067 (`automation_rules`).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The shapes the two jsonb columns may take
-- ============================================================================
-- Functions rather than inline CHECK expressions for 0067's reason: the
-- rehearsal at the foot of this file RUNS them against real inputs instead of
-- reading that a constraint exists.

create or replace function public.automation_actions_valid(p_actions jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- CASE and not a chain of AND, for the reason 0067 gives about
  -- `automation_parameters_valid`: `jsonb_array_length` RAISES on a value that
  -- is not an array, and only CASE promises the arms are evaluated in order.
  select case
    when p_actions is null then false
    when pg_catalog.jsonb_typeof(p_actions) <> 'array' then false
    -- Eight is the size of AUTOMATION_ACTION_KINDS, and no rule in the library
    -- names more than two. A longer list is not a rule, it is somebody using
    -- the column as storage.
    when pg_catalog.jsonb_array_length(p_actions) > 8 then false
    when exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_actions) as element(entry)
      where pg_catalog.jsonb_typeof(element.entry) <> 'object'
         -- Exactly two keys, both strings. This column is rendered on a screen,
         -- so it must not be able to carry a structure the screen never
         -- expected — the note is shown to a manager as the sentence the rule
         -- would have written into the audit trail.
         or (select pg_catalog.count(*)
             from pg_catalog.jsonb_object_keys(element.entry)) <> 2
         or pg_catalog.jsonb_typeof(element.entry -> 'kind') is distinct from 'string'
         or pg_catalog.jsonb_typeof(element.entry -> 'note') is distinct from 'string'
         or (element.entry ->> 'kind') !~ '^[a-z][a-z_]{1,39}$'
         or pg_catalog.length(element.entry ->> 'note') not between 1 and 200
    ) then false
    else true
  end;
$$;

comment on function public.automation_actions_valid(jsonb) is
  'What a rule WOULD have performed: an array of at most eight {kind, note} objects and nothing else. Narrow because the column is rendered on the automations screen, and a jsonb column a request path fills is the one an injection would be worth attempting.';

revoke all on function public.automation_actions_valid(jsonb) from public, anon;
grant execute on function public.automation_actions_valid(jsonb)
  to authenticated, service_role;


create or replace function public.automation_facts_valid(p_facts jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_facts is null then false
    when pg_catalog.jsonb_typeof(p_facts) <> 'object' then false
    when (select pg_catalog.count(*)
          from pg_catalog.jsonb_object_keys(p_facts)) > 24 then false
    when exists (
      select 1
      from pg_catalog.jsonb_each(p_facts) as entry(key, value)
      -- Flat, and scalar. `AutomationFacts` in src/lib/automation/types.ts is a
      -- flat record of scalars precisely so that no rule can reach into a
      -- nested structure the product did not mean to expose, and a store that
      -- accepted a deeper shape would be the place that promise stops holding.
      where entry.key !~ '^[a-z][a-z0-9_]{0,39}$'
         or pg_catalog.jsonb_typeof(entry.value)
              not in ('string', 'number', 'boolean', 'null')
         or (pg_catalog.jsonb_typeof(entry.value) = 'string'
             and pg_catalog.length(entry.value #>> '{}') > 120)
    ) then false
    else true
  end;
$$;

comment on function public.automation_facts_valid(jsonb) is
  'The facts a decision was made on: a flat object of at most twenty-four scalars, keyed by identifiers. The caller sends only the fields the rule library actually compares, so this column is the reason a "did not match" is diagnosable rather than a shrug.';

revoke all on function public.automation_facts_valid(jsonb) from public, anon;
grant execute on function public.automation_facts_valid(jsonb)
  to authenticated, service_role;


-- ============================================================================
-- 2 · The switch that would let an automation act
-- ============================================================================
-- One row per organization, absent by default. Absent is off, and off is the
-- state every organization is in.

create table if not exists public.automation_execution_consent (
  organization_id     uuid primary key
    references public.organizations (id) on delete cascade,

  -- The whole point of this table. False everywhere, and nothing in the
  -- product turns it true: a person does, on a screen, once they can watch
  -- what happens.
  performing_enabled  boolean not null default false,

  -- Hebrew, and required when the switch is on. A consent with no sentence is
  -- a checkbox somebody clicked past; this is the note that says what was
  -- agreed to, and it is what an incident review reads first.
  note                text,

  consented_at        timestamptz,
  consented_by        uuid references auth.users (id) on delete set null,
  revoked_at          timestamptz,
  revoked_by          uuid references auth.users (id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  version             integer not null default 1,

  -- A PERSON, not a process. `enabled_by` on automation_rules may be null for a
  -- service_role import, and that is the honest answer there because storing an
  -- intention harms nobody. This is the switch that lets software message
  -- somebody's guests, so the same latitude would be an unattended import
  -- turning on autonomous messaging. `consented_by` comes from `auth.uid()`,
  -- which is null for service_role — so this CHECK is what makes the switch
  -- unreachable except by a signed-in human.
  constraint automation_execution_consent_is_a_persons_decision check (
    not performing_enabled
    or (consented_at is not null and consented_by is not null)),

  constraint automation_execution_consent_is_explained check (
    not performing_enabled
    or (note is not null and pg_catalog.length(pg_catalog.btrim(note)) >= 10)),

  constraint automation_execution_consent_note_bounded check (
    note is null or pg_catalog.length(note) <= 500),

  constraint automation_execution_consent_version_positive check (version >= 1)
);

comment on table public.automation_execution_consent is
  'Whether this organization has authorised ESTIA to PERFORM the actions its automations decide on, rather than only record the decisions. Absent is off and every organization is absent. The row cannot claim consent without a signed-in person''s id and a sentence saying what was agreed, so neither a service_role import nor an environment variable can reach it. Nothing in this deployment performs anything: see the header of 0075.';
comment on column public.automation_execution_consent.performing_enabled is
  'Off. Turning it on is a decision a named person makes on a screen once they can watch what the rules do; the evaluation record in automation_runs is what they watch.';
comment on column public.automation_execution_consent.note is
  'What was agreed, in the consenting person''s own words. Required while the switch is on, because "who turned this on and what did they think it would do" is the question asked after something goes wrong.';


create or replace function public.tg_automation_consent_is_attributed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A row cannot arrive carrying a history it did not earn.
    new.revoked_at := null;
    new.revoked_by := null;
    if new.performing_enabled then
      new.consented_at := pg_catalog.now();
      new.consented_by := (select auth.uid());
    else
      new.consented_at := null;
      new.consented_by := null;
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id then
    raise exception 'a consent row cannot be moved to another organization'
      using errcode = 'check_violation';
  end if;

  -- Restored before anything is stamped, so an UPDATE that names these columns
  -- cannot rewrite who authorised autonomous messaging last March.
  new.created_at   := old.created_at;
  new.consented_at := old.consented_at;
  new.consented_by := old.consented_by;
  new.revoked_at   := old.revoked_at;
  new.revoked_by   := old.revoked_by;

  if new.performing_enabled and not old.performing_enabled then
    new.consented_at := pg_catalog.now();
    new.consented_by := (select auth.uid());
  elsif old.performing_enabled and not new.performing_enabled then
    new.revoked_at := pg_catalog.now();
    new.revoked_by := (select auth.uid());
  end if;

  new.updated_at := pg_catalog.now();
  new.version    := old.version + 1;
  return new;
end $$;

comment on function public.tg_automation_consent_is_attributed() is
  'Stamps who authorised an organization''s automations to act, and when, from auth.uid() rather than from the caller. Restores the history columns on every UPDATE so only a real transition can move them. With the CHECK on the table this is what makes the performing switch unreachable by anything but a signed-in person.';

drop trigger if exists automation_execution_consent_is_attributed
  on public.automation_execution_consent;
create trigger automation_execution_consent_is_attributed
  before insert or update on public.automation_execution_consent
  for each row execute function public.tg_automation_consent_is_attributed();


-- ============================================================================
-- 3 · The decision record
-- ============================================================================

create table if not exists public.automation_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  property_id      uuid,

  -- The stored row that decided it, when one did. Null is the third state
  -- `state.ts` names and not a missing value: nobody has decided about this
  -- rule, and the library's own `enabled` stood.
  rule_id          uuid,

  template_id      text not null,
  event_name       text not null,

  -- Stable across redeliveries of one logical event. This plus the template is
  -- the whole idempotency mechanism; see the header.
  event_key        text not null,
  correlation_id   text,

  occurred_at      timestamptz not null,
  decided_at       timestamptz not null default now(),

  -- 'shipped' | 'organization' | 'property' — which of the three answers in
  -- state.ts decided. A manager reading "this did not run" needs to know
  -- whether the business switched it off or never touched it.
  source           text not null,

  decision         text not null,
  -- Why it did not act, from the condition evaluator. Null for a decision that
  -- has no "why".
  reason           text,

  -- What it WOULD have performed. Not what it did: nothing performs.
  would_perform    jsonb not null default '[]'::jsonb,
  facts            jsonb not null default '{}'::jsonb,

  -- ── The performing half, present and unwritable ──────────────────────────
  -- No role holds UPDATE on this table and the recorder leaves both null, so
  -- there is no code path in this deployment that can set them. They are here
  -- so that the constraints which will govern performing are declared and
  -- rehearsed before anything can perform, rather than written in a hurry on
  -- the day somebody wants to switch it on.
  performed_at     timestamptz,
  performed_outcome text,

  -- Every reference to this row from anywhere else must carry the tenant with
  -- it, so a foreign key can never bridge two organizations.
  constraint automation_runs_id_organization_key unique (id, organization_id),

  -- The idempotency. One decision per rule per logical event, enforced where
  -- two concurrent deliveries cannot both win.
  constraint automation_runs_once
    unique (organization_id, event_key, template_id),

  constraint automation_runs_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  -- Composite, so a decision can never point at another organization's rule.
  -- Cascade is reachable only by deleting the organization — 0067 refuses
  -- DELETE on automation_rules to every role — and the runs are going with it.
  constraint automation_runs_rule_fkey
    foreign key (rule_id, organization_id)
    references public.automation_rules (id, organization_id) on delete cascade,

  constraint automation_runs_template_shape check (
    template_id ~ '^[a-z][a-z0-9-]{2,63}$'),

  -- The shape of a name in src/lib/contracts/events.ts. Membership of that
  -- frozen catalogue is the code's job, exactly as 0067 divides it for
  -- template ids: Postgres cannot know the catalogue and must not pretend to.
  constraint automation_runs_event_shape check (
    event_name ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),

  constraint automation_runs_event_key_bounded check (
    pg_catalog.length(event_key) between 1 and 200),

  constraint automation_runs_correlation_bounded check (
    correlation_id is null or pg_catalog.length(correlation_id) <= 200),

  constraint automation_runs_reason_bounded check (
    reason is null or pg_catalog.length(reason) <= 300),

  constraint automation_runs_source check (
    source in ('shipped', 'organization', 'property')),

  constraint automation_runs_decision check (
    decision in ('would_act', 'skipped_conditions', 'skipped_disabled')),

  -- A decision a stored row made names that row; one the library made cannot,
  -- because there is no row to name. Written as an equivalence so neither
  -- direction can drift.
  constraint automation_runs_source_names_its_row check (
    (source = 'shipped') = (rule_id is null)),

  constraint automation_runs_would_perform_shape check (
    public.automation_actions_valid(would_perform)),

  constraint automation_runs_facts_shape check (
    public.automation_facts_valid(facts)),

  -- A rule that decided not to act cannot have acted. If performing is ever
  -- switched on, this is what stops a bug recording work against a decision
  -- that refused it.
  constraint automation_runs_only_acts_when_it_would check (
    performed_at is null or decision = 'would_act'),

  -- And a performed run says what happened. Half a record is worse than none:
  -- a timestamp with no outcome reads as success to every screen.
  constraint automation_runs_performed_is_stamped check (
    (performed_at is null) = (performed_outcome is null)),

  constraint automation_runs_performed_outcome_shape check (
    performed_outcome is null
    or performed_outcome in ('executed', 'executed_unaudited', 'failed',
                             'refused_permission', 'refused_plan',
                             'skipped_duplicate'))
);

comment on table public.automation_runs is
  'One row per automation rule per domain event: what the rule decided, why, and what it WOULD have performed. Nothing performs — see the header of 0075. This is the record that makes switching the performing half on safe, and it is the only honest thing to ship first when there is no organization on the database to watch a runner work.';
comment on column public.automation_runs.event_key is
  'Stable across redeliveries of one logical event. With template_id it is the unique constraint automation_runs_once, which is where duplicate delivery is refused — in the database, not in a TypeScript guard that would leave a window between the read and the write.';
comment on column public.automation_runs.decision is
  'What the RULE decided, and nothing more. would_act means the rule is on here and its conditions held; it does NOT mean the action was permitted. The permission and plan floors are per action and belong to runAutomations, which the event bus has no actor to run.';
comment on column public.automation_runs.source is
  'Which of the three answers in src/lib/automation/state.ts decided: shipped (nobody has touched the rule), organization, or property. A rule that did not run for want of a decision and one switched off on purpose are different facts.';
comment on column public.automation_runs.performed_at is
  'Always null. No role holds UPDATE on this table and the recorder never writes it, so nothing in this deployment can set it. Present so that the constraints governing performing are declared and rehearsed before anything performs.';

-- "What did the rules decide lately" is the screen's only question.
create index if not exists automation_runs_recent_idx
  on public.automation_runs (organization_id, decided_at desc);

-- And "why does this rule never do anything", which is asked per rule.
create index if not exists automation_runs_by_rule_idx
  on public.automation_runs (organization_id, template_id, decided_at desc);


-- ============================================================================
-- 4 · Row level security
-- ============================================================================

alter table public.automation_execution_consent enable row level security;
alter table public.automation_execution_consent force  row level security;
alter table public.automation_runs              enable row level security;
alter table public.automation_runs              force  row level security;

revoke all on public.automation_execution_consent from anon, authenticated;
revoke all on public.automation_runs              from anon, authenticated;

grant select, insert, update on public.automation_execution_consent
  to authenticated, service_role;
revoke delete, truncate on public.automation_execution_consent
  from authenticated, service_role;

-- SELECT only, for everybody. The single writer is
-- `public.record_automation_evaluation`, which is SECURITY DEFINER because the
-- person whose action raised the event cannot read the rules that react to it.
-- Granting INSERT here as well would give a request path a second way in that
-- skips the membership check and the idempotency the function performs.
grant select on public.automation_runs to authenticated, service_role;
revoke insert, update, delete, truncate on public.automation_runs
  from authenticated, service_role;

drop policy if exists automation_execution_consent_select
  on public.automation_execution_consent;
create policy automation_execution_consent_select
  on public.automation_execution_consent
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'automation.view')
  );

-- Two grants, deliberately. `automation.manage` is the right to choose which
-- rules a business wants; letting software act on the business without a person
-- in the loop is a change to how the organization runs, which is what
-- `organization.settings.edit` names. Requiring both means the decision cannot
-- be made by somebody whose job is only to tune the rule library.
drop policy if exists automation_execution_consent_insert
  on public.automation_execution_consent;
create policy automation_execution_consent_insert
  on public.automation_execution_consent
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'automation.manage')
    and public.has_permission(organization_id, 'organization.settings.edit')
  );

drop policy if exists automation_execution_consent_update
  on public.automation_execution_consent;
create policy automation_execution_consent_update
  on public.automation_execution_consent
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'automation.manage')
    and public.has_permission(organization_id, 'organization.settings.edit')
  )
  with check (
    organization_id in (select public.my_organizations())
    and public.has_permission(organization_id, 'automation.manage')
    and public.has_permission(organization_id, 'organization.settings.edit')
  );

-- The decision record is read by whoever may read the automation screen, and by
-- nobody else: it names which rules a business runs and on what facts.
drop policy if exists automation_runs_select on public.automation_runs;
create policy automation_runs_select on public.automation_runs
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'automation.view')
  );


-- ============================================================================
-- 5 · The recorder
-- ============================================================================
-- The one writer. SECURITY DEFINER for 0061's reason and with 0061's
-- safeguards: pinned empty search_path, every object schema-qualified, and an
-- EXPLICIT membership check, which is the only tenant boundary once row level
-- security is bypassed in the body.
--
-- `p_candidates` is an array of objects, one per library rule whose trigger
-- matched this event, each shaped:
--
--   { "template_id":     "review-request-after-stay",
--     "shipped_enabled": false,          -- the library's own answer
--     "conditions_met":  true,           -- every condition a parameter cannot
--                                        -- touch, evaluated by conditions.ts
--     "reason":          "…",            -- why not, when not
--     "gates":           [ {"key": "minimum_nights",
--                           "operator": "at_least",
--                           "fact": 3,
--                           "shipped": 2} ],
--     "would_perform":   [ {"kind": "request_review", "note": "…"} ],
--     "facts":           {"nights": 3} }
--
-- The gates are the only part evaluated here, and only because the caller may
-- not read the threshold. See the header.

create or replace function public.record_automation_evaluation(
  p_organization_id uuid,
  p_property_id     uuid,
  p_event_name      text,
  p_event_key       text,
  p_correlation_id  text,
  p_occurred_at     timestamptz,
  p_candidates      jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate jsonb;
  v_gate      jsonb;
  v_template  text;
  v_rule      public.automation_rules%rowtype;
  v_found     boolean;
  v_source    text;
  v_enabled   boolean;
  v_met       boolean;
  v_reason    text;
  v_decision  text;
  v_threshold numeric;
  v_fact      numeric;
  v_holds     boolean;
  v_written   integer;
  v_recorded  integer := 0;
begin
  -- A publish with nothing to identify is not an error worth failing an
  -- operation over. Nothing is recorded and the caller is told nothing was.
  if p_organization_id is null
  or p_event_name is null
  or p_event_key is null then
    return 0;
  end if;

  -- Refused rather than truncated. `event_key` is the identity two deliveries
  -- of one event are compared on, and a key trimmed to fit would silently make
  -- two different events look like the same one — which is the failure the
  -- unique constraint exists to prevent, arriving through the door meant to
  -- enforce it. `correlation_id` below IS truncated, because it is for tracing
  -- and nothing is decided on it.
  if pg_catalog.length(p_event_key) > 200 then
    raise exception 'an automation event key is longer than the record allows'
      using errcode = 'check_violation';
  end if;

  if p_organization_id not in (select public.my_organizations()) then
    raise exception 'not a member of this organization'
      using errcode = '42501';
  end if;

  if p_candidates is null
  or pg_catalog.jsonb_typeof(p_candidates) <> 'array' then
    return 0;
  end if;

  -- The library has fourteen rules and one event reaches at most a handful of
  -- them. A longer list is a caller using the recorder as storage.
  if pg_catalog.jsonb_array_length(p_candidates) > 16 then
    raise exception 'too many automation candidates for one event'
      using errcode = 'check_violation';
  end if;

  for v_candidate in
    select element.entry
    from pg_catalog.jsonb_array_elements(p_candidates) as element(entry)
  loop
    if pg_catalog.jsonb_typeof(v_candidate) <> 'object' then
      raise exception 'an automation candidate must be an object'
        using errcode = 'check_violation';
    end if;

    v_template := v_candidate ->> 'template_id';
    if v_template is null then
      raise exception 'an automation candidate must name a rule'
        using errcode = 'check_violation';
    end if;

    /* ── which answer decides here ──────────────────────────────────────── */
    -- The property row REPLACES the organization row wholesale, exactly as
    -- resolveRules does and as 0034 does for the guest journey. `order by
    -- (property_id is null)` puts the property row first because false sorts
    -- before true; when the event names no property only the organization row
    -- can match, because `property_id = null` is never true.
    --
    -- No explicit reset is needed before this: SELECT ... INTO assigns NULL to
    -- every field of the target when the query returns no row, so a candidate
    -- with no stored row cannot inherit the previous iteration's rule.
    select r.* into v_rule
    from public.automation_rules r
    where r.organization_id = p_organization_id
      and r.template_id = v_template
      and (r.property_id is null or r.property_id = p_property_id)
    order by (r.property_id is null)
    limit 1;

    v_found := found;

    if v_found then
      v_enabled := v_rule.enabled;
      v_source  := case
                     when v_rule.property_id is null then 'organization'
                     else 'property'
                   end;
    else
      -- An absent row is NOT a disabled rule. The library's own answer stands,
      -- and five of the fourteen shipped rules are on for a business that has
      -- never opened the automation screen.
      v_enabled := coalesce(
        (case when pg_catalog.jsonb_typeof(v_candidate -> 'shipped_enabled')
                     = 'boolean'
              then (v_candidate ->> 'shipped_enabled')::boolean
         end), false);
      v_source  := 'shipped';
    end if;

    /* ── the conditions ─────────────────────────────────────────────────── */
    v_met := coalesce(
      (case when pg_catalog.jsonb_typeof(v_candidate -> 'conditions_met')
                   = 'boolean'
            then (v_candidate ->> 'conditions_met')::boolean
       end), false);
    v_reason := pg_catalog.left(v_candidate ->> 'reason', 300);

    if pg_catalog.jsonb_typeof(v_candidate -> 'gates') = 'array' then
      for v_gate in
        select element.entry
        from pg_catalog.jsonb_array_elements(v_candidate -> 'gates')
          as element(entry)
      loop
        exit when not v_met;

        -- The stored number, or the one the library ships. A row written
        -- before a parameter existed carries nothing for it, and falling back
        -- to the shipped value is the difference between "the threshold is its
        -- default" and "the threshold is zero".
        v_threshold := null;
        if v_found
           and pg_catalog.jsonb_typeof(
                 v_rule.parameters -> (v_gate ->> 'key')) = 'number' then
          v_threshold := (v_rule.parameters ->> (v_gate ->> 'key'))::numeric;
        elsif pg_catalog.jsonb_typeof(v_gate -> 'shipped') = 'number' then
          v_threshold := (v_gate ->> 'shipped')::numeric;
        end if;

        -- Absence and a non-number both fail closed, which is the one decision
        -- in conditions.ts worth arguing about and is restated rather than
        -- softened here: a rule that refunds a deposit when damage_reported is
        -- false must not fire because nobody said anything about damage.
        v_fact := null;
        if pg_catalog.jsonb_typeof(v_gate -> 'fact') = 'number' then
          v_fact := (v_gate ->> 'fact')::numeric;
        end if;

        if v_fact is null or v_threshold is null then
          v_holds := false;
          v_reason := coalesce(v_reason,
            'הערך ״' || coalesce(v_gate ->> 'key', '?') ||
            '״ אינו מספר, ולכן לא ניתן להשוות אותו.');
        else
          v_holds := case (v_gate ->> 'operator')
                       when 'greater_than' then v_fact >  v_threshold
                       when 'at_least'     then v_fact >= v_threshold
                       when 'less_than'    then v_fact <  v_threshold
                       when 'at_most'      then v_fact <= v_threshold
                     end;
          -- An operator this function does not know is not "true".
          if v_holds is null then
            v_holds := false;
          end if;
          if not v_holds then
            v_reason := coalesce(v_reason,
              'הערך ״' || coalesce(v_gate ->> 'key', '?') ||
              '״ שהוגדר כאן לא התקיים באירוע הזה.');
          end if;
        end if;

        v_met := v_met and v_holds;
      end loop;
    end if;

    /* ── the decision ───────────────────────────────────────────────────── */
    if not v_enabled then
      v_decision := 'skipped_disabled';
    elsif not v_met then
      v_decision := 'skipped_conditions';
    else
      v_decision := 'would_act';
    end if;

    insert into public.automation_runs (
      organization_id, property_id, rule_id, template_id,
      event_name, event_key, correlation_id, occurred_at,
      source, decision, reason, would_perform, facts
    )
    values (
      p_organization_id,
      p_property_id,
      case when v_found then v_rule.id end,
      v_template,
      p_event_name,
      p_event_key,
      pg_catalog.left(p_correlation_id, 200),
      coalesce(p_occurred_at, pg_catalog.now()),
      v_source,
      v_decision,
      case when v_decision = 'would_act' then null else v_reason end,
      case when pg_catalog.jsonb_typeof(v_candidate -> 'would_perform') = 'array'
           then v_candidate -> 'would_perform' else '[]'::jsonb end,
      case when pg_catalog.jsonb_typeof(v_candidate -> 'facts') = 'object'
           then v_candidate -> 'facts' else '{}'::jsonb end
    )
    -- The idempotency, and the reason it is here rather than in TypeScript: two
    -- deliveries of the same event race, and both would pass a read-then-write
    -- guard. One of them loses this insert and neither fails.
    on conflict on constraint automation_runs_once do nothing;

    get diagnostics v_written = row_count;
    v_recorded := v_recorded + v_written;
  end loop;

  return v_recorded;
end;
$$;

comment on function public.record_automation_evaluation(uuid, uuid, text, text, text, timestamptz, jsonb) is
  'Records what each automation rule decided about one domain event. SECURITY DEFINER because the person whose action raised the event — a receptionist confirming a booking — cannot read automation_rules, which 0067 gates behind automation.view, and cannot write automation_runs. Membership is therefore checked explicitly: it is the only tenant boundary left once RLS is bypassed. Returns a count and NEVER the configuration it read, so 0067''s read policy is not widened. Performs nothing.';

revoke all on function public.record_automation_evaluation(
  uuid, uuid, text, text, text, timestamptz, jsonb) from public, anon;
grant execute on function public.record_automation_evaluation(
  uuid, uuid, text, text, text, timestamptz, jsonb)
  to authenticated, service_role;


-- ============================================================================
-- 6 · Rehearsal
-- ============================================================================
-- Exercised, not asserted.
--
-- The behavioural half runs against TEMPORARY tables created with
-- `like public.x including all`, which the server fills in from its own
-- catalogue — so the CHECK constraints, defaults and unique indexes exercised
-- below are the real ones rather than a copy this file typed out, and no seeded
-- organization is needed. What LIKE does not copy is foreign keys and row level
-- security, which is why those two are checked structurally instead.

do $$
declare
  v_enabled   boolean;
  v_offending text;
  v_rows      integer;
begin
  /* ── the two shape guards, run against real values ───────────────────── */

  if not public.automation_actions_valid(
       '[{"kind": "notify_team", "note": "הצוות עודכן"}]'::jsonb) then
    raise exception 'the action guard rejects a real action list';
  end if;
  if not public.automation_actions_valid('[]'::jsonb) then
    raise exception 'the action guard rejects a rule that would do nothing yet';
  end if;
  if public.automation_actions_valid('{}'::jsonb) then
    raise exception 'the would-perform column could hold an object';
  end if;
  if public.automation_actions_valid('null'::jsonb) then
    raise exception 'the would-perform column could hold json null';
  end if;
  if public.automation_actions_valid('[{"kind": "notify_team"}]'::jsonb) then
    raise exception 'an action could be recorded with no sentence on it';
  end if;
  if public.automation_actions_valid(
       '[{"kind": "notify_team", "note": "x", "extra": 1}]'::jsonb) then
    raise exception 'an action could carry a field the screen never expected';
  end if;
  if public.automation_actions_valid(
       '[{"kind": "Notify Team", "note": "x"}]'::jsonb) then
    raise exception 'an action kind could be something no catalogue holds';
  end if;
  if public.automation_actions_valid(
       ('[{"kind": "notify_team", "note": "'
        || pg_catalog.repeat('א', 201) || '"}]')::jsonb) then
    raise exception 'an action note is unbounded';
  end if;

  if not public.automation_facts_valid('{"nights": 3}'::jsonb) then
    raise exception 'the fact guard rejects a real fact set';
  end if;
  if not public.automation_facts_valid('{}'::jsonb) then
    raise exception 'the fact guard rejects a rule with no conditions';
  end if;
  if public.automation_facts_valid('{"nights": {"value": 3}}'::jsonb) then
    raise exception
      'a fact could be nested, and a rule could reach into a structure';
  end if;
  if public.automation_facts_valid('[]'::jsonb) then
    raise exception 'a fact set could be an array';
  end if;
  if public.automation_facts_valid('{"Nights": 3}'::jsonb) then
    raise exception 'a fact key could be something no condition names';
  end if;
  if public.automation_facts_valid(
       ('{"source": "' || pg_catalog.repeat('א', 121) || '"}')::jsonb) then
    raise exception 'a fact string is unbounded';
  end if;

  /* ── the consent switch, run against real inserts ─────────────────────── */

  execute 'drop table if exists pg_temp.automation_consent_rehearsal';
  execute 'create temp table automation_consent_rehearsal
             (like public.automation_execution_consent including all)';
  execute 'create trigger rehearsal_consent_is_attributed
             before insert or update on pg_temp.automation_consent_rehearsal
             for each row
             execute function public.tg_automation_consent_is_attributed()';

  -- The default is off, and off is what an organization gets by existing.
  execute 'insert into pg_temp.automation_consent_rehearsal (organization_id)
           values ($1)'
    using '00000000-0000-4000-8000-000000000000'::uuid;
  execute 'select performing_enabled from pg_temp.automation_consent_rehearsal'
    into v_enabled;
  if v_enabled then
    raise exception 'an organization is allowed to act by default';
  end if;

  -- Switching it on as the migration role has no auth.uid(), so the trigger
  -- writes a null `consented_by` and the CHECK must refuse it. This is the
  -- unattended import case, and it is the whole reason the constraint exists.
  begin
    execute 'update pg_temp.automation_consent_rehearsal
               set performing_enabled = true, note = $1'
      using 'הופעל על ידי תהליך אוטומטי';
    raise exception
      'automations could be switched on to ACT with nobody''s name on it';
  exception
    when check_violation then null;
  end;

  -- And with the trigger out of the way — a writer that reached past it — the
  -- CHECK still holds on its own.
  execute 'alter table pg_temp.automation_consent_rehearsal
             disable trigger rehearsal_consent_is_attributed';
  begin
    execute 'insert into pg_temp.automation_consent_rehearsal
               (organization_id, performing_enabled, note, consented_at)
             values ($1, true, $2, pg_catalog.now())'
      using '00000000-0000-4000-8000-000000000001'::uuid,
            'נבדק על ידי מנהל שצפה בהחלטות במשך שבוע';
    raise exception
      'consent could be recorded without the id of the person who gave it';
  exception
    when check_violation then null;
  end;

  -- A consent with no sentence is a checkbox somebody clicked past.
  begin
    execute 'insert into pg_temp.automation_consent_rehearsal
               (organization_id, performing_enabled, consented_at, consented_by)
             values ($1, true, pg_catalog.now(), $2)'
      using '00000000-0000-4000-8000-000000000002'::uuid,
            '00000000-0000-4000-8000-00000000000a'::uuid;
    raise exception 'consent could be given without saying what was agreed';
  exception
    when check_violation then null;
  end;

  execute 'alter table pg_temp.automation_consent_rehearsal
             enable trigger rehearsal_consent_is_attributed';
  execute 'drop table pg_temp.automation_consent_rehearsal';

  /* ── the decision record, run against real inserts ────────────────────── */

  execute 'drop table if exists pg_temp.automation_runs_rehearsal';
  execute 'create temp table automation_runs_rehearsal
             (like public.automation_runs including all)';

  execute 'insert into pg_temp.automation_runs_rehearsal
             (organization_id, template_id, event_name, event_key,
              occurred_at, source, decision, would_perform, facts)
           values ($1, $2, $3, $4, pg_catalog.now(), $5, $6, $7, $8)'
    using '00000000-0000-4000-8000-000000000000'::uuid,
          'payment-failed-alert', 'payment.failed', 'evt-1',
          'shipped', 'would_act',
          '[{"kind": "notify_team", "note": "הצוות עודכן"}]'::jsonb,
          '{"status": "failed"}'::jsonb;

  -- The same event delivered twice is one decision. This is the constraint the
  -- recorder's ON CONFLICT rides on, so it is exercised rather than trusted.
  begin
    execute 'insert into pg_temp.automation_runs_rehearsal
               (organization_id, template_id, event_name, event_key,
                occurred_at, source, decision)
             values ($1, $2, $3, $4, pg_catalog.now(), $5, $6)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            'payment-failed-alert', 'payment.failed', 'evt-1',
            'shipped', 'skipped_disabled';
    raise exception 'one event could be decided twice for the same rule';
  exception
    when unique_violation then null;
  end;

  -- A different rule on the same event is a different decision, and must not
  -- be deduplicated away by it.
  execute 'insert into pg_temp.automation_runs_rehearsal
             (organization_id, template_id, event_name, event_key,
              occurred_at, source, decision)
           values ($1, $2, $3, $4, pg_catalog.now(), $5, $6)'
    using '00000000-0000-4000-8000-000000000000'::uuid,
          'payment-unknown-alert', 'payment.failed', 'evt-1',
          'shipped', 'skipped_disabled';
  execute 'select pg_catalog.count(*)::integer
             from pg_temp.automation_runs_rehearsal'
    into v_rows;
  if v_rows <> 2 then
    raise exception
      'two rules on one event did not produce two decisions (got %)', v_rows;
  end if;

  -- The library decided, so there is no row to name.
  begin
    execute 'update pg_temp.automation_runs_rehearsal set rule_id = $1'
      using '00000000-0000-4000-8000-00000000000b'::uuid;
    raise exception
      'a decision could claim the shipped default AND name a stored row';
  exception
    when check_violation then null;
  end;

  -- Nothing performed, so nothing may claim an outcome.
  begin
    execute 'update pg_temp.automation_runs_rehearsal
               set performed_at = pg_catalog.now()
             where decision = ''would_act''';
    raise exception 'a run could record a time it acted and never say what happened';
  exception
    when check_violation then null;
  end;

  -- And a rule that refused cannot have acted.
  begin
    execute 'update pg_temp.automation_runs_rehearsal
               set performed_at = pg_catalog.now(), performed_outcome = $1
             where decision = ''skipped_disabled'''
      using 'executed';
    raise exception 'a rule that was switched off could record having acted';
  exception
    when check_violation then null;
  end;

  -- An event name that could not be in the frozen catalogue.
  begin
    execute 'insert into pg_temp.automation_runs_rehearsal
               (organization_id, template_id, event_name, event_key,
                occurred_at, source, decision)
             values ($1, $2, $3, $4, pg_catalog.now(), $5, $6)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            'payment-failed-alert', 'Payment Failed', 'evt-2',
            'shipped', 'would_act';
    raise exception 'a decision could name an event no catalogue holds';
  exception
    when check_violation then null;
  end;

  -- A decision this product does not make.
  begin
    execute 'insert into pg_temp.automation_runs_rehearsal
               (organization_id, template_id, event_name, event_key,
                occurred_at, source, decision)
             values ($1, $2, $3, $4, pg_catalog.now(), $5, $6)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            'payment-failed-alert', 'payment.failed', 'evt-3',
            'shipped', 'performed_it';
    raise exception 'a decision could be a word nothing renders';
  exception
    when check_violation then null;
  end;

  -- A would_perform list the screen could not render.
  begin
    execute 'insert into pg_temp.automation_runs_rehearsal
               (organization_id, template_id, event_name, event_key,
                occurred_at, source, decision, would_perform)
             values ($1, $2, $3, $4, pg_catalog.now(), $5, $6, $7)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            'payment-failed-alert', 'payment.failed', 'evt-4',
            'shipped', 'would_act', '{"kind": "notify_team"}'::jsonb;
    raise exception 'the would-perform column could hold anything at all';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.automation_runs_rehearsal';

  /* ── the recorder's membership guard, exercised ───────────────────────── */
  -- Running as the migration role there is no `auth.uid()`, so
  -- `my_organizations()` is empty and every id is foreign — which is exactly
  -- the case that must be refused. If this ever stops raising, the function has
  -- stopped being a tenant boundary.

  begin
    perform public.record_automation_evaluation(
      '00000000-0000-4000-8000-000000000000'::uuid,
      null, 'booking.confirmed', 'evt-guard', null, pg_catalog.now(),
      '[]'::jsonb);
    raise exception
      'the recorder accepted an organization the caller is not a member of';
  exception
    when insufficient_privilege then null;
  end;

  /* ── what LIKE does not copy: privileges and row level security ───────── */

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'automation_runs'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'automation_runs is not forced';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'automation_execution_consent'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'automation_execution_consent is not forced';
  end if;

  select string_agg(distinct grantee::text, ', ') into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('automation_runs', 'automation_execution_consent')
    and grantee in ('anon', 'PUBLIC');
  if v_offending is not null then
    raise exception 'the automation record is reachable by: %', v_offending;
  end if;

  -- No request path may write a decision. The recorder is the only writer, and
  -- it is the only place the membership check and the idempotency live.
  -- Filtered by grantee, and not by privilege alone: the table's OWNER holds
  -- every privilege on it implicitly and appears in this view, so a check that
  -- forgot the grantee would raise on a correctly locked table.
  select string_agg(distinct privilege_type::text, ', ') into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'automation_runs'
    and privilege_type <> 'SELECT'
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC');
  if v_offending is not null then
    raise exception
      'automation_runs is writable outside the recorder, by: %', v_offending;
  end if;

  -- Which is also what keeps `performed_at` unwritable. Said as its own
  -- sentence because it is the promise this whole migration is built on.
  if exists (
    select 1 from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'automation_runs'
      and column_name = 'performed_at'
      and privilege_type in ('UPDATE', 'INSERT')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  ) then
    raise exception 'something in this deployment can claim an automation acted';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'automation_execution_consent'
      and privilege_type in ('DELETE', 'TRUNCATE')
      and grantee in ('authenticated', 'service_role', 'anon', 'PUBLIC')
  ) then
    raise exception
      'a consent to act could be deleted, so who gave it is erasable';
  end if;

  -- Every policy asks all three questions, exactly as 0067 requires of its own.
  select string_agg(p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('automation_runs', 'automation_execution_consent')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%my_organizations%';
  if v_offending is not null then
    raise exception 'policies without a tenant boundary: %', v_offending;
  end if;

  select string_agg(p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('automation_runs', 'automation_execution_consent')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%has_permission%';
  if v_offending is not null then
    raise exception 'policies that ask for no permission: %', v_offending;
  end if;

  -- Turning on autonomous action needs both grants. A policy that lost one of
  -- them would let somebody who may tune the rule library decide the business
  -- runs itself.
  select string_agg(p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'automation_execution_consent'
    and p.polcmd in ('a', 'w')
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%organization.settings.edit%';
  if v_offending is not null then
    raise exception
      'a consent policy that does not ask for organization.settings.edit: %',
      v_offending;
  end if;

  -- The definer function must not be redirectable at a shadowing table.
  select array_to_string(p.proconfig, ',') into v_offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_automation_evaluation';
  if v_offending is null or v_offending not like '%search_path=%' then
    raise exception
      'record_automation_evaluation is SECURITY DEFINER without a pinned search_path';
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('record_automation_evaluation',
                           'automation_actions_valid',
                           'automation_facts_valid')
      and grantee = 'anon'
  ) then
    raise exception 'anon may execute the automation recorder';
  end if;

  for v_offending in
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('automation_actions_valid', 'automation_facts_valid',
                        'tg_automation_consent_is_attributed')
      and (p.proconfig is null
           or array_to_string(p.proconfig, ',') not like '%search_path=%')
  loop
    raise exception '% has a mutable search_path', v_offending;
  end loop;

  if exists (select 1 from public.automation_runs) then
    raise exception 'the rehearsal recorded a decision';
  end if;
  if exists (select 1 from public.automation_execution_consent) then
    raise exception 'the rehearsal consented to something';
  end if;
end $$;
