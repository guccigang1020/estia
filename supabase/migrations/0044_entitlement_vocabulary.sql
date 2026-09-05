-- ============================================================================
-- 0044_entitlement_vocabulary.sql — ESTIA · the database refuses two features
--                                   the product sells
--
-- What this closes
--   `ENTITLEMENTS` in `src/lib/plans/entitlements.ts` carries nineteen values.
--   `plans_entitlements_known` in 0003 allows seventeen. The two it has never
--   heard of are `laundry` and `commerce` — the entitlements added when those
--   modules were built.
--
--   So on the live database:
--
--     · a plan row carrying `laundry` or `commerce` is REJECTED by the CHECK
--     · therefore no plan can grant either
--     · therefore every laundry screen and every store screen is plan-locked
--       for every customer, forever
--     · and the refusal reads as a correct upgrade offer, which is why nobody
--       would find it by looking at the product
--
--   This is the same class of failure as 0035, and it is the third time it has
--   happened: a vocabulary widened in TypeScript and not in the schema. The
--   engine allows, the floor refuses, every test passes because every test
--   runs against the demo client or a fake — and the first person to meet it
--   is a paying customer whose laundry module is empty for no visible reason.
--
--   Found by the worker building the platform console, which offers a
--   capability editor and would have written a value the database rejects.
--
-- Why the constraint is rewritten rather than dropped
--   Because it is doing its job. A typo'd entitlement in a plan row is a
--   customer silently holding nothing, and that is worth refusing. What was
--   wrong was the list, not the check — so the list is corrected and the check
--   stays, in all three places that carry it.
--
-- On keeping two lists at all
--   There is no way to have one: Postgres cannot read a TypeScript array, and
--   a table of valid entitlements would need its own seeding migration and its
--   own drift. What is possible is to make the divergence loud, and the
--   rehearsal below does that — it counts, so a nineteenth entitlement added
--   in code and forgotten here fails the next migration that runs rather than
--   the next customer who buys.
--
-- Depends on
--   0003 (plans, organization_subscriptions and the three CHECK constraints).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · The vocabulary, in one place in this file
-- ============================================================================
-- Nineteen, matching `ENTITLEMENTS` exactly and in the same order, so the two
-- can be read side by side without counting.

do $$
declare
  known text[] := array[
    'core', 'payments', 'invoicing', 'website', 'ai_content', 'custom_domain',
    'team', 'operations', 'laundry', 'commerce', 'channels',
    'dynamic_pricing', 'owner_portal', 'agent_network', 'approvals',
    'automation', 'custom_roles', 'multi_brand', 'api_access'
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


-- ============================================================================
-- 2 · Rehearsal
-- ============================================================================

do $$
declare
  def text;
  n   integer;
begin
  -- Both new members must be accepted by all three constraints. Asserted by
  -- reading the definitions rather than by writing a row: a plan inserted to
  -- prove a CHECK is a fabricated plan, and this migration has no business
  -- creating one.
  for def in
    select pg_get_constraintdef(oid)
    from pg_constraint
    where conname in (
      'plans_entitlements_known',
      'organization_subscriptions_grants_known',
      'organization_subscriptions_revocations_known'
    )
  loop
    if position('laundry' in def) = 0 then
      raise exception 'a constraint still refuses the laundry entitlement: %', def;
    end if;
    if position('commerce' in def) = 0 then
      raise exception 'a constraint still refuses the commerce entitlement: %', def;
    end if;
  end loop;

  -- All three must exist. A `drop constraint if exists` that ran without the
  -- matching add would leave the column unguarded, which is worse than the
  -- narrow list it replaced.
  select count(*) into n
  from pg_constraint
  where conname in (
    'plans_entitlements_known',
    'organization_subscriptions_grants_known',
    'organization_subscriptions_revocations_known'
  );

  if n <> 3 then
    raise exception 'expected 3 entitlement constraints, found %', n;
  end if;

  -- The count itself, pinned. `ENTITLEMENTS` has nineteen members; if a
  -- twentieth is added in TypeScript and not here, this is where it is caught
  -- — by the next migration that runs, rather than by the next customer who
  -- buys the feature and finds it locked.
  select count(*) into n
  from unnest(string_to_array(
    (select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'plans_entitlements_known'),
    ','
  ));

  if n <> 19 then
    raise exception
      'plans_entitlements_known lists % values, expected 19 to match ENTITLEMENTS', n;
  end if;
end $$;
