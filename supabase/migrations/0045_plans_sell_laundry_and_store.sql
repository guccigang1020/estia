-- ============================================================================
-- 0045_plans_sell_laundry_and_store.sql — ESTIA · nobody could buy two modules
--
-- What this closes
--   0044 corrected the CHECK constraints so `laundry` and `commerce` are legal
--   values. This puts them on the plans that sell them, which is the half that
--   actually opens the modules: a legal value nothing grants is still nothing
--   granted.
--
--   The four plan rows in this database match `SEED_PLANS` in
--   `src/lib/plans/catalog.ts` in every respect except these two entitlements,
--   which did not exist when 0003 seeded them. Verified column by column
--   before writing:
--
--     basic       core payments invoicing                             ← correct
--     direct      … agent_network                                     ← +2
--     pro         … dynamic_pricing agent_network                     ← +2
--     management  … multi_brand agent_network                         ← +2
--
--   Until now, every laundry screen and every store screen was plan-locked for
--   every customer on every package, and the refusal read as a correct upgrade
--   offer — which is why it survived a working demo, a green suite and three
--   sessions of review. The demo has no plans table to disagree with, and no
--   test asserts what a *row* in this database contains.
--
-- Why `basic` gets neither, and why that is a decision rather than an omission
--   `catalog.ts` argues it: laundry and the store both start at Direct, not
--   with `operations`. Laundry in `simple` mode is a list of what must be
--   clean by Friday — exactly what one cabin owner needs, and needing no crew
--   — and selling a שולחן שוק is how a small villa makes its margin. But Basic
--   is the package for somebody who wants a calendar and an invoice, and both
--   modules stay available to them through
--   `organization_subscriptions.entitlement_grants` as an add-on. The ladder
--   is a default, not a wall.
--
-- Idempotent, deliberately
--   `array_append` guarded by a membership test, so re-running this changes
--   nothing and a plan that already carries the entitlement is left alone. A
--   migration that corrupts an array by running twice is worse than one that
--   did not run.
--
-- Depends on
--   0003 (plans and their seeded rows), 0044 (the constraints that would
--   otherwise refuse both values).
-- ============================================================================

set search_path = public, extensions;


-- ============================================================================
-- 1 · Sell them
-- ============================================================================

update public.plans
set entitlements = array_append(entitlements, 'laundry')
where code in ('direct', 'pro', 'management')
  and not ('laundry' = any (entitlements));

update public.plans
set entitlements = array_append(entitlements, 'commerce')
where code in ('direct', 'pro', 'management')
  and not ('commerce' = any (entitlements));


-- ============================================================================
-- 2 · Rehearsal
-- ============================================================================

do $$
declare
  missing text;
  basic   text[];
begin
  -- The three that must now carry both.
  select string_agg(code, ', ') into missing
  from public.plans
  where code in ('direct', 'pro', 'management')
    and not ('laundry' = any (entitlements) and 'commerce' = any (entitlements));

  if missing is not null then
    raise exception 'these plans still cannot sell laundry or the store: %', missing;
  end if;

  -- And the one that must not, because that is a product decision and a
  -- migration that quietly widened Basic would be giving away two modules.
  select entitlements into basic from public.plans where code = 'basic';

  if 'laundry' = any (basic) or 'commerce' = any (basic) then
    raise exception
      'basic was given laundry or commerce; catalog.ts sells both from direct upward';
  end if;

  -- Nothing else moved. Basic is exactly its three, as 0003 seeded it.
  if array_length(basic, 1) <> 3 then
    raise exception 'basic now carries % entitlements, expected 3',
      array_length(basic, 1);
  end if;
end $$;
