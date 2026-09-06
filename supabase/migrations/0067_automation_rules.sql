-- ============================================================================
-- 0067_automation_rules.sql — ESTIA · the switch the automation screen never had
--
-- ── The gap this closes ────────────────────────────────────────────────────
--
-- `src/lib/automation` is a complete domain: a library of fourteen rules, a
-- condition evaluator that fails closed on a missing fact, an engine with
-- per-action permission checks and an idempotency ledger, and a dry run that
-- shows a business what those rules WOULD do to rows that are really in this
-- database.
--
-- **None of it can be switched on.** There is no table, so `library.ts` says
-- in its own header that a template is a definition that gets copied, and
-- `automations/page.tsx` says on screen that there are no toggles because a
-- toggle that forgets itself on reload is worse than none. Both sentences are
-- true and both stop being true here.
--
-- ── THE RULE THAT MAKES THIS WORTH ANYTHING ────────────────────────────────
--
-- **A rule that was ever switched on cannot be erased. It can only be switched
-- off, and both acts name a person and a time.**
--
-- An automation is software acting on a business by itself: messaging guests,
-- issuing invoices, blocking availability. The question asked after something
-- goes wrong is never "is it on now" — it is "who turned it on, when, with
-- what threshold, and who turned it off the week before the incident". If
-- disabling deleted the row, that answer would disappear at exactly the moment
-- it is worth having, and nothing in the product would notice.
--
-- So, three mechanisms, because one is a preference and three are a design:
--
--   1. NO DELETE PRIVILEGE. `authenticated` and `service_role` are refused
--      `delete` and `truncate` outright, the same way 0063 refuses them on
--      `conversation_messages` and 0066 on `guest_reviews`. Disabling is an
--      UPDATE. The row survives the business changing its mind.
--
--   2. EVERY STATE CHANGE IS STAMPED. A trigger writes `enabled_at`/
--      `enabled_by` when a rule goes on and `disabled_at`/`disabled_by` when
--      it goes off, from `auth.uid()` rather than from the caller — so the
--      attribution is the session's, not a field somebody may fill in. CHECK
--      constraints refuse a row that claims to be enabled without the stamp,
--      so a write that bypassed the trigger could not leave one behind.
--
--   3. THE AUDIT EVENT IS THE DURABLE COPY. `enabled_by` is
--      `on delete set null` — a person can leave and their auth row can go —
--      and `audit_events` keeps the name and the sentence permanently. The
--      column answers "who owns this rule today"; the audit trail answers
--      "who decided this", and that one cannot be edited.
--
-- ── PARAMETERS ARE NUMBERS, AND NOTHING ELSE ───────────────────────────────
--
-- `parameters` is the one column whose content changes what a rule DOES, so it
-- is the one column an injection would be worth attempting. It holds a flat
-- object of finite numbers, validated by `public.automation_parameters_valid`,
-- and the reason it is that narrow is `conditions.ts`: comparisons there do not
-- coerce, deliberately, so a string parameter reaching a numeric condition
-- would evaluate `not_comparable` forever and the rule would sit on the screen
-- looking configured while never firing once. Every tunable clause in the
-- shipped library is a numeric threshold. Widening this is a migration and a
-- validator, not a value somebody drops into jsonb.
--
-- ── WHAT THE DATABASE CANNOT CHECK, AND WHO DOES ───────────────────────────
--
-- `template_id` names a rule in `src/lib/automation/library.ts`. Postgres has
-- no way to know that catalogue, so the CHECK here enforces only the SHAPE of
-- a library id — a row can never name something the code could not have
-- shipped — and `automation.enable` refuses an id the library does not carry,
-- with a 404 rather than a stored row pointing at nothing. That division is
-- deliberate and it is the same one 0063 draws around event names.
--
-- ── SCOPE: NULL IS THE ORGANIZATION, NOT A MISSING VALUE ───────────────────
--
-- One row per rule per organization, and optionally one per property, exactly
-- as `guest_journey_settings` in 0034: the property row overrides the
-- organization row WHOLESALE rather than field by field, because a half
-- inherited policy is one nobody can predict from the screen. Two partial
-- unique indexes rather than `unique nulls not distinct`, for 0034's reason —
-- the latter needs the reader to already know that a null property is a real
-- key value here, and the pair below says it out loud.
--
-- ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
--
-- **The runner.** Nothing in this deployment feeds `runAutomations` a live
-- event: `(app)/_lib/events.ts` publishes to webhooks and says in its own
-- header that automations are "one `subscribers` entry" away and deliberately
-- not turned on, and no performer exists for any of the eight action kinds.
-- This migration therefore stores INTENT, which is a real and separately
-- useful thing — it is what a runner will read on its first day — and the
-- automations screen says so in Hebrew rather than letting a switch imply an
-- engine. A table that quietly promised execution would be the exact failure
-- the rest of that module spends its whole design avoiding.
--
-- Depends on 0001 (organizations, `tg_touch_row`), 0004 (`my_organizations`,
-- `has_permission`) and 0008 (properties, `property_in_scope`).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The shape a parameter set may take
-- ============================================================================
-- A function rather than an inline CHECK expression for one reason: the
-- rehearsal at the foot of this file RUNS it, against real inputs, instead of
-- reading that a constraint exists. A guard nobody has executed is a guard
-- nobody knows the behaviour of.

create or replace function public.automation_parameters_valid(p_parameters jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- CASE, and not a chain of AND, deliberately. `jsonb_object_keys` and
  -- `jsonb_each` RAISE on a value that is not an object — a jsonb array would
  -- error rather than answer false — and SQL does not promise to evaluate the
  -- arms of an AND in the order they are written. CASE does promise it, so the
  -- type test genuinely guards the two calls below it.
  select case
    when p_parameters is null then false
    when pg_catalog.jsonb_typeof(p_parameters) <> 'object' then false
    -- Sixteen is not a capacity limit, it is a shape limit: no rule in the
    -- library has more than one tunable clause, and a parameter set with
    -- dozens of keys is not a configured rule, it is somebody using the column
    -- as storage.
    when (select pg_catalog.count(*)
          from pg_catalog.jsonb_object_keys(p_parameters)) > 16 then false
    when exists (
      select 1
      from pg_catalog.jsonb_each(p_parameters) as entry(key, value)
      where pg_catalog.jsonb_typeof(entry.value) <> 'number'
         -- The key is an identifier in the rule's parameter catalogue. A key
         -- that cannot be one is a key no code will ever read.
         or entry.key !~ '^[a-z][a-z0-9_]{1,39}$'
    ) then false
    else true
  end;
$$;

comment on function public.automation_parameters_valid(jsonb) is
  'A flat object of finite numbers, keyed by identifiers, at most sixteen of them. Numbers only because comparisons in src/lib/automation/conditions.ts deliberately do not coerce: a string parameter reaching a numeric condition evaluates not_comparable forever, which is a rule that looks configured on screen and never fires once.';

revoke all on function public.automation_parameters_valid(jsonb) from public, anon;
grant execute on function public.automation_parameters_valid(jsonb)
  to authenticated, service_role;


-- ============================================================================
-- 2 · The state of one rule, for one organization
-- ============================================================================

create table if not exists public.automation_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null
    references public.organizations (id) on delete cascade,
  -- Null is the organization-wide state, not a missing value. See the header.
  property_id      uuid,

  -- The rule in src/lib/automation/library.ts this row configures. Shape only
  -- is checkable here; membership of the catalogue is the operation's job.
  template_id      text not null,

  -- Off is the default for a row that exists at all, so an INSERT that failed
  -- half way through cannot leave an automation running that nobody switched
  -- on. `enabled` here is the ORGANIZATION'S answer; the library's own
  -- `enabled` remains the shipped default for a rule with no row.
  enabled          boolean not null default false,

  parameters       jsonb not null default '{}'::jsonb,

  enabled_at       timestamptz,
  enabled_by       uuid references auth.users (id) on delete set null,
  disabled_at      timestamptz,
  disabled_by      uuid references auth.users (id) on delete set null,

  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  version          integer not null default 1,

  -- Every reference to this row from anywhere else must carry the tenant with
  -- it, so a foreign key can never bridge two organizations.
  constraint automation_rules_id_organization_key unique (id, organization_id),

  constraint automation_rules_property_fkey
    foreign key (property_id, organization_id)
    references public.properties (id, organization_id) on delete cascade,

  -- Kebab-case, like every id in the library. A row can name a rule the code
  -- has not shipped yet; it can never name something that could not be one.
  constraint automation_rules_template_shape check (
    template_id ~ '^[a-z][a-z0-9-]{2,63}$'),

  constraint automation_rules_parameters_shape check (
    public.automation_parameters_valid(parameters)),

  -- An automation that is running with nobody's name on it is the state this
  -- whole table exists to prevent, so it is not representable.
  constraint automation_rules_enabled_is_stamped check (
    not enabled or enabled_at is not null),
  -- And one that was switched off says when. A row that has never been on
  -- carries neither stamp, which is the third state and a real one.
  constraint automation_rules_disabled_is_stamped check (
    enabled or enabled_at is null or disabled_at is not null),

  constraint automation_rules_version_positive check (version >= 1)
);

comment on table public.automation_rules is
  'Which of the shipped automation rules this organization has switched on, and with what thresholds. One row per rule per organization, optionally one per property which overrides it wholesale. A rule with no row is the library default — that is why the table is sparse and why an absent row is not the same as a disabled one. Nothing runs these yet; see the WHAT IS NOT HERE section of 0067.';
comment on column public.automation_rules.property_id is
  'Null is the organization-wide state, not a missing value. A property row overrides the organization row wholesale rather than field by field, because a half-inherited policy is one nobody can predict from the screen. Same argument as guest_journey_settings in 0034.';
comment on column public.automation_rules.template_id is
  'The rule in src/lib/automation/library.ts. Postgres cannot know that catalogue, so the CHECK enforces the shape of a library id and the automation.enable operation refuses an id the library does not carry.';
comment on column public.automation_rules.parameters is
  'Tunable thresholds, as a flat object of numbers. See public.automation_parameters_valid and the header.';
comment on column public.automation_rules.enabled_by is
  'Who switched it on, taken from auth.uid() and never from the caller. Null only where there was no signed-in person — a service_role import — which is the honest answer rather than a borrowed name. on delete set null, so somebody can leave the business; the permanent answer to who decided this is the audit event, which cannot be edited.';

create unique index if not exists automation_rules_org_default_key
  on public.automation_rules (organization_id, template_id)
  where property_id is null;

create unique index if not exists automation_rules_org_property_key
  on public.automation_rules (organization_id, template_id, property_id)
  where property_id is not null;

-- "Which rules are live in this organization" is the question a runner asks on
-- every event, so it gets a partial index rather than a scan over every rule
-- anybody has ever touched.
create index if not exists automation_rules_live_idx
  on public.automation_rules (organization_id, template_id)
  where enabled;


-- ============================================================================
-- 3 · Every change names a person and a time
-- ============================================================================
-- This replaces `tg_touch_row` rather than sitting beside it: it does the same
-- two things — stamp `updated_at`, bump `version` — and adds the three that
-- matter here. Two BEFORE UPDATE triggers both writing `version` would be two
-- answers to the same question.

create or replace function public.tg_automation_rule_is_attributed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The parameter shape, checked here as well as by the constraint, so the
  -- refusal a person sees names the column rather than a constraint name.
  if not public.automation_parameters_valid(new.parameters) then
    raise exception
      'automation parameters must be a flat object of numbers keyed by identifiers'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    -- Taken from the session, never from the caller. A column a writer may
    -- fill in is a column that can say somebody else did this, and the whole
    -- value of this table is that it cannot.
    new.created_by  := (select auth.uid());
    new.updated_by  := new.created_by;
    -- A row cannot arrive carrying a history. It has none: it is being created.
    new.disabled_at := null;
    new.disabled_by := null;
    if new.enabled then
      new.enabled_at := pg_catalog.now();
      new.enabled_by := (select auth.uid());
    else
      new.enabled_at := null;
      new.enabled_by := null;
    end if;
    return new;
  end if;

  -- Never rewritten by an update. A row that changed which rule it configures
  -- would take its own history with it, which is the one thing this table is
  -- for.
  if new.organization_id is distinct from old.organization_id
  or new.template_id     is distinct from old.template_id
  or new.property_id     is distinct from old.property_id
  then
    raise exception
      'an automation rule row cannot be moved to another rule, property or organization'
      using errcode = 'check_violation';
  end if;

  -- The history is restored from the row before anything is stamped, so an
  -- UPDATE that names these columns cannot rewrite who switched a rule on last
  -- March. Only the transition below may move them, and only to now().
  new.created_at  := old.created_at;
  new.created_by  := old.created_by;
  new.enabled_at  := old.enabled_at;
  new.enabled_by  := old.enabled_by;
  new.disabled_at := old.disabled_at;
  new.disabled_by := old.disabled_by;

  if new.enabled and not old.enabled then
    new.enabled_at := pg_catalog.now();
    new.enabled_by := (select auth.uid());
  elsif old.enabled and not new.enabled then
    new.disabled_at := pg_catalog.now();
    new.disabled_by := (select auth.uid());
  end if;

  new.updated_at := pg_catalog.now();
  new.updated_by := (select auth.uid());
  new.version    := old.version + 1;
  return new;
end $$;

comment on function public.tg_automation_rule_is_attributed() is
  'Stamps who switched an automation on or off and when, from auth.uid() rather than from the caller; restores the four history columns from the existing row on every UPDATE so they can only ever be moved by a real transition; and refuses to let a row change which rule, property or organization it configures. Takes the place of tg_touch_row on this table so that version has exactly one writer.';

drop trigger if exists automation_rules_is_attributed on public.automation_rules;
create trigger automation_rules_is_attributed
  before insert or update on public.automation_rules
  for each row execute function public.tg_automation_rule_is_attributed();


-- ============================================================================
-- 4 · Row level security
-- ============================================================================

alter table public.automation_rules enable row level security;
alter table public.automation_rules force  row level security;

revoke all on public.automation_rules from anon, authenticated;
grant select, insert, update on public.automation_rules to authenticated, service_role;

-- Never. Switching a rule off is an UPDATE that leaves a row saying who did it
-- and when; a DELETE would erase the only record that the rule was ever on.
revoke delete, truncate on public.automation_rules from authenticated, service_role;

-- `property_id is null or in scope`, in every policy. A rule row with no
-- property is the organization-wide state and belongs to whoever may read
-- automation; one that names a property obeys the same scope every other row
-- of that property does. Omitting the null branch would hide the default state
-- of every rule from everybody, which is most of the table.

drop policy if exists automation_rules_select on public.automation_rules;
create policy automation_rules_select on public.automation_rules
  for select to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'automation.view')
  );

drop policy if exists automation_rules_insert on public.automation_rules;
create policy automation_rules_insert on public.automation_rules
  for insert to authenticated
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'automation.manage')
  );

drop policy if exists automation_rules_update on public.automation_rules;
create policy automation_rules_update on public.automation_rules
  for update to authenticated
  using (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'automation.manage')
  )
  with check (
    organization_id in (select public.my_organizations())
    and (property_id is null
         or public.property_in_scope(property_id, organization_id))
    and public.has_permission(organization_id, 'automation.manage')
  );


-- ============================================================================
-- 5 · Rehearsal
-- ============================================================================
-- Exercised, not asserted.
--
-- The behavioural half runs against a TEMPORARY table created with
-- `like public.automation_rules including all`, which the server fills in from
-- its own catalogue — so the CHECK constraints and defaults being exercised
-- below are the real ones rather than a copy this file typed out. The real
-- trigger function is attached to it. What LIKE does not copy is foreign keys
-- and row level security, which is why this needs no seeded organization and
-- why those two are checked structurally instead.

do $$
declare
  v_stamp     timestamptz;
  v_off       timestamptz;
  v_version   integer;
  v_offending text;
begin
  /* ── the parameter guard, run against real values ────────────────────── */

  if not public.automation_parameters_valid('{"minimum_nights": 2}'::jsonb) then
    raise exception 'the parameter guard rejects a valid parameter set';
  end if;
  if not public.automation_parameters_valid('{}'::jsonb) then
    raise exception 'the parameter guard rejects a rule with nothing to tune';
  end if;
  if public.automation_parameters_valid('{"minimum_nights": "2"}'::jsonb) then
    raise exception
      'a parameter could be a string, and a numeric condition would never match it';
  end if;
  if public.automation_parameters_valid('{"nested": {"a": 1}}'::jsonb) then
    raise exception 'a parameter could be an object';
  end if;
  if public.automation_parameters_valid('{"list": [1, 2]}'::jsonb) then
    raise exception 'a parameter could be an array';
  end if;
  if public.automation_parameters_valid('{"Minimum Nights": 2}'::jsonb) then
    raise exception 'a parameter key could be something no code will read';
  end if;
  if public.automation_parameters_valid('[]'::jsonb) then
    raise exception 'a parameter set could be an array rather than an object';
  end if;
  if public.automation_parameters_valid('null'::jsonb) then
    raise exception 'a parameter set could be json null';
  end if;

  /* ── the constraints and the trigger, run against a real insert ──────── */

  execute 'drop table if exists pg_temp.automation_rules_rehearsal';
  execute 'create temp table automation_rules_rehearsal
             (like public.automation_rules including all)';
  execute 'create trigger rehearsal_is_attributed
             before insert or update on pg_temp.automation_rules_rehearsal
             for each row execute function public.tg_automation_rule_is_attributed()';

  -- Switching a rule on stamps it. Nothing supplied `enabled_at`.
  execute 'insert into pg_temp.automation_rules_rehearsal
             (organization_id, template_id, enabled, parameters)
           values ($1, $2, true, $3)'
    using '00000000-0000-4000-8000-000000000000'::uuid,
          'review-request-after-stay',
          '{"minimum_nights": 3}'::jsonb;

  execute 'select enabled_at from pg_temp.automation_rules_rehearsal'
    into v_stamp;
  if v_stamp is null then
    raise exception 'a rule was switched on with nobody and no time on it';
  end if;

  -- Switching it off records that too, and does not erase the first stamp.
  execute 'update pg_temp.automation_rules_rehearsal set enabled = false';
  execute 'select enabled_at, disabled_at, version
             from pg_temp.automation_rules_rehearsal'
    into v_stamp, v_off, v_version;
  if v_off is null then
    raise exception 'a rule was switched off and left no record of it';
  end if;
  if v_stamp is null then
    raise exception 'switching a rule off erased when it was switched on';
  end if;
  if v_version <> 2 then
    raise exception 'the version did not move, so optimistic locking is blind here';
  end if;

  -- The history cannot be rewritten by naming its columns. This is the one an
  -- attacker with the manage permission would reach for: erase who switched it
  -- on, keep the rule running.
  execute 'update pg_temp.automation_rules_rehearsal
             set enabled_at = null, enabled_by = null, disabled_at = null';
  execute 'select enabled_at, disabled_at from pg_temp.automation_rules_rehearsal'
    into v_stamp, v_off;
  if v_stamp is null or v_off is null then
    raise exception 'the record of who switched a rule on could be erased';
  end if;

  -- A row cannot be re-pointed at another rule, taking its history with it.
  begin
    execute 'update pg_temp.automation_rules_rehearsal
               set template_id = ''payment-failed-alert''';
    raise exception 'a rule row could be moved to a different rule';
  exception
    when check_violation then null;
  end;

  -- A non-numeric parameter is refused before it is stored.
  begin
    execute 'insert into pg_temp.automation_rules_rehearsal
               (organization_id, template_id, parameters)
             values ($1, $2, $3)'
      using '00000000-0000-4000-8000-000000000000'::uuid,
            'payment-failed-alert',
            '{"minimum_nights": "three"}'::jsonb;
    raise exception 'a rule accepted a parameter no condition could compare';
  exception
    when check_violation then null;
  end;

  -- A template id that could not be a library id is refused.
  begin
    execute 'insert into pg_temp.automation_rules_rehearsal
               (organization_id, template_id)
             values ($1, $2)'
      using '00000000-0000-4000-8000-000000000000'::uuid, 'Not A Rule Id';
    raise exception 'a rule row could name something the library could not ship';
  exception
    when check_violation then null;
  end;

  -- Enabled with no stamp is not representable, even by a writer that reached
  -- past the trigger. Proven by disabling the trigger and trying.
  execute 'alter table pg_temp.automation_rules_rehearsal disable trigger rehearsal_is_attributed';
  begin
    execute 'insert into pg_temp.automation_rules_rehearsal
               (organization_id, template_id, enabled)
             values ($1, $2, true)'
      using '00000000-0000-4000-8000-000000000000'::uuid, 'task-overdue-alert';
    raise exception 'a rule could be enabled with nobody''s name on it';
  exception
    when check_violation then null;
  end;

  execute 'drop table pg_temp.automation_rules_rehearsal';

  /* ── what LIKE does not copy: privileges and row level security ───────── */

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'automation_rules'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'automation_rules is not forced';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'automation_rules'
      and privilege_type in ('DELETE', 'TRUNCATE')
      and grantee in ('authenticated', 'service_role', 'anon', 'PUBLIC')
  ) then
    raise exception
      'an automation rule can be deleted, so who switched it on is erasable';
  end if;

  select string_agg(distinct grantee::text, ', ') into v_offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'automation_rules'
    and grantee in ('anon', 'PUBLIC');
  if v_offending is not null then
    raise exception 'automation_rules is reachable by: %', v_offending;
  end if;

  -- Every policy asks all three questions. A policy that named the tenant and
  -- forgot the permission would let anybody in the organization switch a rule
  -- on, which is the difference between automation and a shared root account.
  select string_agg(p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'automation_rules'
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%my_organizations%';
  if v_offending is not null then
    raise exception 'policies without a tenant boundary: %', v_offending;
  end if;

  select string_agg(p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'automation_rules'
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%property_in_scope%';
  if v_offending is not null then
    raise exception 'policies without a property scope: %', v_offending;
  end if;

  select string_agg(p.polname, ', ') into v_offending
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'automation_rules'
    and (
      coalesce(pg_get_expr(p.polqual, p.polrelid), '')
      || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
    ) not like '%has_permission%';
  if v_offending is not null then
    raise exception 'policies that ask for no permission: %', v_offending;
  end if;

  select array_to_string(p.proconfig, ',') into v_offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'automation_parameters_valid';
  if v_offending is null or v_offending not like '%search_path=%' then
    raise exception 'the parameter guard has a mutable search_path';
  end if;

  select array_to_string(p.proconfig, ',') into v_offending
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tg_automation_rule_is_attributed';
  if v_offending is null or v_offending not like '%search_path=%' then
    raise exception 'the attribution trigger has a mutable search_path';
  end if;

  if exists (select 1 from public.automation_rules) then
    raise exception 'the rehearsal switched an automation on';
  end if;
end $$;
