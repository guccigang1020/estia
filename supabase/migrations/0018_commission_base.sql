-- ============================================================================
-- 0018_commission_base.sql — ESTIA · the enum that stopped describing the code
--
-- What this does
--   Replaces `public.commission_base` with the six members of
--   `COMMISSION_BASES` in src/lib/contracts/states.ts, and rewrites every
--   stored `whole_booking` as `stay_total`.
--
--   0015 created the type with two members, `whole_booking` and
--   `accommodation_only`, transcribed from what src/lib/agents/commission.ts
--   said at the time. Four modules were later found declaring the list
--   differently; unifying them produced six members, and `whole_booking` was
--   renamed to `stay_total` in the process. It does not exist in the code at
--   all any more.
--
--   The drift therefore cuts both ways, and both directions are live bugs:
--
--     · `stay_total` — which src/lib/agents/commission.ts explicitly supports
--       — cannot be stored, so `assertStorableBase` in
--       src/lib/persistence/agents.ts refuses the write rather than let a raw
--       22P02 come back from inside it, and both commission methods on the
--       finance port raise SchemaNotProvisionedError outright;
--     · a stored `whole_booking` is a value no TypeScript union accepts, so
--       `asEnum` refuses the read — on the record that decides what a person
--       is paid.
--
-- ── Why this is a type swap and not ALTER TYPE … ADD VALUE ──────────────────
--
--   The comment left in src/lib/persistence/agents.ts sketches the migration
--   as five ADD VALUEs plus a data fix. That does not work here, for two
--   independent reasons.
--
--   **ADD VALUE cannot be used in the transaction that adds it.** PostgreSQL
--   permits `ALTER TYPE … ADD VALUE` inside a transaction block from 12
--   onwards, but a value added there cannot be *referenced* until that
--   transaction commits — an `UPDATE … SET base = 'stay_total'` in the same
--   unit fails with 55P04, `unsafe use of new value`. So the sketch is not one
--   migration; it is two, with a window in between during which the enum
--   accepts `stay_total` and the rows have not moved. Nothing in this
--   repository applies migrations in halves.
--
--   **There is no ALTER TYPE … DROP VALUE.** PostgreSQL has never had one. So
--   even after five ADD VALUEs and a data migration, `whole_booking` would
--   still be a member — still writable by any caller, still returnable by any
--   read, and still a value the domain has no meaning for. The read-side half
--   of the bug would survive the migration that was supposed to close it.
--
--   Renaming the old type, creating the new one, and moving each column across
--   with a USING clause does both jobs at once, in one transaction, with the
--   old value gone at the end. The USING clause *is* the data migration: the
--   `whole_booking` rows are rewritten as `stay_total` by the same statement
--   that changes the column's type, so there is no moment at which a row holds
--   a value its column cannot express.
--
--   The cost of the swap is a table rewrite per column, which is why it is done
--   now rather than later. All four tables are empty on this project; the
--   statement is written to be correct whatever they hold.
--
-- ── The four columns ────────────────────────────────────────────────────────
--
--     commissions.base                        default 'whole_booking'
--     agent_commission_rules.base             default 'whole_booking'
--     agent_commission_rule_versions.base     no default
--     agency_agreements.base                  default 'whole_booking'
--
--   Checked against pg_attribute, not against the migration files: a column
--   missed here would be dropped by the CASCADE the swap would otherwise need,
--   and the check constraints, indexes, views and functions that could also
--   depend on the type were all confirmed absent before this was written.
--
--   The three defaults become `stay_total`, which is what `whole_booking`
--   meant. A default is a decision about rows nobody filled in, and changing
--   what it means while keeping its spelling would be the same drift again.
--
-- Depends on
--   0015 (the type and three of the four columns), 0016 (unchanged — the
--   separate `public.commission_basis` type it created is a different axis and
--   is deliberately not touched here).
-- ============================================================================

set search_path = public, extensions;


-- ── What is about to move ───────────────────────────────────────────────────
-- Counted before the swap, while the old member still exists, and raised as a
-- notice so an operator running this by hand sees what it did rather than
-- having to reconstruct it afterwards.

do $$
declare
  n_commissions bigint;
  n_rules       bigint;
  n_versions    bigint;
  n_agreements  bigint;
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'commission_base'
      and e.enumlabel = 'whole_booking'
  ) then
    raise notice '0018: commission_base has already been migrated; nothing to count';
    return;
  end if;

  select count(*) into n_commissions from public.commissions where base::text = 'whole_booking';
  select count(*) into n_rules       from public.agent_commission_rules where base::text = 'whole_booking';
  select count(*) into n_versions    from public.agent_commission_rule_versions where base::text = 'whole_booking';
  select count(*) into n_agreements  from public.agency_agreements where base::text = 'whole_booking';

  raise notice '0018: rewriting whole_booking -> stay_total in commissions=%, agent_commission_rules=%, agent_commission_rule_versions=%, agency_agreements=%',
    n_commissions, n_rules, n_versions, n_agreements;
end $$;


-- ── The swap ────────────────────────────────────────────────────────────────
-- Guarded so the file is idempotent: a second run finds no `whole_booking`
-- member and does nothing.

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'commission_base'
      and e.enumlabel = 'whole_booking'
  ) then
    return;
  end if;

  alter type public.commission_base rename to commission_base_v1;

  create type public.commission_base as enum (
    'accommodation_only',
    'stay_total',
    'gross_revenue',
    'net_revenue',
    'net_of_direct_costs',
    'net_contribution'
  );

  -- Defaults are dropped first and restored last. A default is an expression
  -- of the old type, and ALTER COLUMN TYPE will not carry it across.
  alter table public.commissions             alter column base drop default;
  alter table public.agent_commission_rules  alter column base drop default;
  alter table public.agency_agreements       alter column base drop default;

  alter table public.commissions
    alter column base type public.commission_base
    using (case base::text when 'whole_booking' then 'stay_total' else base::text end)::public.commission_base;

  alter table public.agent_commission_rules
    alter column base type public.commission_base
    using (case base::text when 'whole_booking' then 'stay_total' else base::text end)::public.commission_base;

  -- agent_commission_rule_versions refuses INSERT, UPDATE and DELETE to every
  -- role including service_role, because history a caller could write is not
  -- history. That is a privilege rule and DDL run by the owner is not subject
  -- to it, so the frozen terms move across with everything else — a version
  -- row left saying `whole_booking` would be exactly the unreadable value this
  -- migration exists to remove, on the table that answers "what did we agree".
  alter table public.agent_commission_rule_versions
    alter column base type public.commission_base
    using (case base::text when 'whole_booking' then 'stay_total' else base::text end)::public.commission_base;

  alter table public.agency_agreements
    alter column base type public.commission_base
    using (case base::text when 'whole_booking' then 'stay_total' else base::text end)::public.commission_base;

  alter table public.commissions            alter column base set default 'stay_total'::public.commission_base;
  alter table public.agent_commission_rules alter column base set default 'stay_total'::public.commission_base;
  alter table public.agency_agreements      alter column base set default 'stay_total'::public.commission_base;

  -- Fails loudly if anything still depends on the old type. That is the
  -- intent: a silent CASCADE here would drop the dependent object rather than
  -- report it.
  drop type public.commission_base_v1;
end $$;


comment on type public.commission_base is
  'What a commission is computed on. The six members of COMMISSION_BASES in src/lib/contracts/states.ts, and nothing else. 0015 created this type with whole_booking and accommodation_only; whole_booking was renamed to stay_total when four modules were found declaring the list differently, and 0018 replaced the type rather than widening it — because ALTER TYPE has no DROP VALUE, and leaving whole_booking behind would leave the database able to produce a value no TypeScript union accepts.';

comment on column public.commissions.base is
  'The revenue figure the rate was applied to. Frozen with the commission: recomputing it against today''s definition of "stay total" would change what somebody was already paid.';


-- ── A guard against the next drift ──────────────────────────────────────────
-- The failure this file closes was not the rename. It was that nothing
-- compared the database vocabulary with the code, so the two disagreed
-- for two migrations without anybody noticing. This function makes the
-- comparison a statement a test can execute.
--
-- Deliberately not a constraint and not a trigger: the code side of the
-- comparison is a TypeScript array this database cannot read, so the honest
-- thing is a function that reports the members and a test in
-- supabase/tests/agent_settings.sql that holds them against the expected list.

create or replace function public.commission_base_members()
returns text[]
language sql
stable
set search_path = ''
as $$
  select array_agg(e.enumlabel::text order by e.enumsortorder)
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'commission_base';
$$;

comment on function public.commission_base_members() is
  'The members of public.commission_base, in order. Exists so a test can assert the database vocabulary equals COMMISSION_BASES in src/lib/contracts/states.ts — the comparison nobody was making when the two drifted apart.';

revoke all on function public.commission_base_members() from public, anon;
grant execute on function public.commission_base_members() to authenticated, service_role;
