/**
 * The billing reads, walked over the demo dataset on all three packages.
 *
 * The assertion this file exists for is the one about `QUOTA_BLOCKS_ACTION`:
 * that a quota which refuses an action and a quota which merely warns come out
 * of `quotaLines` as different things, on the same dataset, at the same moment.
 * The demo makes that easy to demonstrate — on Basic the organization is over
 * three of its four limits at once, and only one of them stops anybody working.
 */

import { describe, expect, it } from 'vitest'

import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PLANS } from '@/lib/demo/dataset'
import { DemoActorSource } from '@/lib/demo/session'
import type { Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { SEED_PLANS } from '@/lib/plans/catalog'
import { effectiveLimits } from '@/lib/plans/plan'
import { QUOTA_BLOCKS_ACTION } from '@/lib/plans/quota'

import { QUOTA_LABEL, QUOTA_MEANING, QUOTA_OVERAGE_CONSEQUENCE } from './labels'
import {
  QUOTA_ORDER,
  approachingQuotas,
  blockedQuotas,
  comparePlans,
  excludedEntitlements,
  includedEntitlements,
  listOfferedPlans,
  loadEffectivePlan,
  loadUsage,
  priceSummary,
  quotaLines,
  warningQuotas,
} from './queries'

const ORGANIZATION = DEMO_DATASET.organizationId

function client(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

/**
 * The same source the shell builds in demo mode.
 *
 * This is the point of `loadEffectivePlan` taking an `ActorSource`: the screen
 * and the switcher resolve the package through one path, so they cannot
 * disagree, and the test walks that path rather than a second one.
 */
function sourceOn(planCode: string) {
  const plan = DEMO_PLANS.find((entry) => entry.code === planCode)
  if (!plan) throw new Error(`No demo plan '${planCode}'`)
  return new DemoActorSource(new SupabaseActorSource(client()), plan)
}

async function planOn(planCode: string) {
  const plan = await loadEffectivePlan(sourceOn(planCode), ORGANIZATION)
  if (!plan) throw new Error(`No effective plan for '${planCode}'`)
  return plan
}

/* ================================================================ usage == */

describe('what the organization is using', () => {
  it('counts the properties, units and active members the dataset holds', async () => {
    const usage = await loadUsage(client(), ORGANIZATION)

    expect(usage.properties).toBe(DEMO_DATASET.tables.properties.length)
    expect(usage.units).toBe(DEMO_DATASET.tables.units.length)
    expect(usage.members).toBe(
      DEMO_DATASET.tables.memberships.filter((row) => row.status === 'active')
        .length,
    )
  })

  it('reports storage as unmeasured rather than as zero', async () => {
    const usage = await loadUsage(client(), ORGANIZATION)

    // There is no storage table, no bytes column and no upload path in any
    // migration. "0 GB used" would tell a customer they have used none of an
    // allowance the product cannot measure at all.
    expect(usage.storageGb).toBeNull()
  })
})

/* =============================================================== quotas == */

describe('a quota that blocks and a quota that warns', () => {
  it('are different things on the same usage, at the same moment', async () => {
    // Basic's catalogue limits: one property, two units, two members. The demo
    // organization has two, seven and ten of them.
    //
    // The limits are taken from `SEED_PLANS` here rather than from the demo's
    // package switcher, and that is a FINDING rather than a convenience —
    // asserted in its own right two tests below. `DemoActorSource.loadPlan`
    // substitutes the entitlement set and deliberately keeps the dataset's own
    // limits, so switching to Basic in the browser leaves this organization on
    // Pro's ceilings and no quota can be demonstrated in overage through the
    // switcher at all.
    const basic = SEED_PLANS.find((entry) => entry.code === 'basic')
    if (!basic) throw new Error('No basic plan in the catalogue')

    const usage = await loadUsage(client(), ORGANIZATION)
    const lines = quotaLines(usage, basic.limits)

    const blocked = blockedQuotas(lines)
    const warning = warningQuotas(lines)

    // Members refuses; properties and units do not. That is the whole point of
    // `QUOTA_BLOCKS_ACTION`, and it is measured here rather than asserted from
    // the constant alone.
    expect(blocked.map((line) => line.key)).toEqual(['members'])
    expect(warning.map((line) => line.key).sort()).toEqual([
      'properties',
      'units',
    ])

    for (const line of warning) {
      expect(line.state?.inOverage).toBe(true)
      expect(line.blocked).toBe(false)
      expect(QUOTA_BLOCKS_ACTION[line.key]).toBe(false)
    }
    for (const line of blocked) {
      expect(line.state?.inOverage).toBe(true)
      expect(QUOTA_BLOCKS_ACTION[line.key]).toBe(true)
    }
  })

  it('gives the two states genuinely different wording', () => {
    for (const key of QUOTA_ORDER) {
      const copy = QUOTA_OVERAGE_CONSEQUENCE[key]
      // A shared sentence would defeat the whole distinction: "you are over
      // your allowance" says nothing about whether anybody can still work.
      expect(copy.blocking).not.toBe(copy.warning)
      expect(copy.blocking.length).toBeGreaterThan(0)
      expect(copy.warning.length).toBeGreaterThan(0)
      expect(QUOTA_LABEL[key].length).toBeGreaterThan(0)
      expect(QUOTA_MEANING[key].length).toBeGreaterThan(0)
    }
  })

  it('FINDING: the demo package switcher moves entitlements and not limits', async () => {
    // `DemoActorSource.loadPlan` says so in its own comment — the
    // subscription's status, interval, prices and *limits* are facts about this
    // fictional customer and the switcher has no opinion about them. The
    // consequence for this screen is worth writing down: switching to Basic in
    // the browser leaves the organization on Pro's ceilings, so the overage and
    // blocking states cannot be walked through the demo UI even though the
    // logic behind them is exercised above.
    const catalogued = SEED_PLANS.find((entry) => entry.code === 'basic')
    const switched = await planOn('basic')

    expect(switched.plan.code).toBe('basic')
    expect(switched.plan.entitlements).not.toContain('operations')
    // The limits, however, are still the seeded subscription's package.
    expect(effectiveLimits(switched)).not.toEqual(catalogued?.limits)
    // Eleven, not Pro ten: the demo subscription carries a negotiated seat
    // override, which is what makes this assertion meaningful — the limits did
    // not follow the package down to Basic.
    expect(effectiveLimits(switched).members).toBe(11)
  })

  it('warns before the line on Pro, where the member seat count is exactly full', async () => {
    // Pro allows ten members; the demo subscription buys an eleventh, and the
    // organization has exactly eleven people. Within the limit, and at it —
    // the state worth demonstrating, because the warning that matters is the
    // one that arrives before somebody crosses.
    const plan = await planOn('pro')
    const usage = await loadUsage(client(), ORGANIZATION)
    const lines = quotaLines(usage, effectiveLimits(plan))

    expect(blockedQuotas(lines)).toEqual([])
    expect(warningQuotas(lines)).toEqual([])

    const members = lines.find((line) => line.key === 'members')
    expect(members?.state?.withinLimit).toBe(true)
    expect(members?.state?.inOverage).toBe(false)
    // `approaching` is the whole reason to tell somebody *before* they cross.
    expect(approachingQuotas(lines).map((line) => line.key)).toContain(
      'members',
    )
  })

  it('never marks the unmeasured quota as blocked', async () => {
    for (const code of ['basic', 'direct', 'pro']) {
      const plan = await planOn(code)
      const usage = await loadUsage(client(), ORGANIZATION)
      const storage = quotaLines(usage, effectiveLimits(plan)).find(
        (line) => line.key === 'storageGb',
      )

      // Storage *would* block if it were over. It cannot be over, because it
      // cannot be measured — and a screen that reported it blocked would be
      // refusing an action on a figure nobody has.
      expect(storage?.state).toBeNull()
      expect(storage?.blocks).toBe(true)
      expect(storage?.blocked).toBe(false)
      expect(storage?.unmeasuredReason).toBeDefined()
    }
  })

  it('covers every quota key, in a stable order', async () => {
    const plan = await planOn('pro')
    const usage = await loadUsage(client(), ORGANIZATION)
    const lines = quotaLines(usage, effectiveLimits(plan))

    expect(lines.map((line) => line.key)).toEqual([...QUOTA_ORDER])
    expect(new Set(QUOTA_ORDER)).toEqual(
      new Set(Object.keys(QUOTA_BLOCKS_ACTION)),
    )
  })
})

/* ============================================================ the plan === */

describe('the package the organization is on', () => {
  it('follows the demo switcher rather than the subscription row', async () => {
    // The dataset's subscription points at `pro`. Reading the row directly
    // would show `pro` while the switcher said `basic`, which is the demo
    // contradicting its own caption on the one screen about which package the
    // business is on.
    for (const code of ['basic', 'direct', 'pro']) {
      expect((await planOn(code)).plan.code).toBe(code)
    }
  })

  it('reports the agreed price and whether it is below list', async () => {
    const plan = await planOn('pro')
    const price = priceSummary(plan)

    expect(price.interval).toBe('monthly')
    expect(price.agreedAgorot).toBe(64_900)
    expect(Number.isInteger(price.agreedAgorot)).toBe(true)
    // The demo pays list price on Pro, so it is not grandfathered.
    expect(price.grandfathered).toBe(false)
  })

  it('splits the entitlements into held and not held, with nothing lost', async () => {
    const plan = await planOn('basic')
    const included = includedEntitlements(plan)
    const excluded = excludedEntitlements(plan)

    expect(included).toContain('core')
    expect(included).toContain('payments')
    expect(included).not.toContain('operations')
    expect(excluded).toContain('operations')
    // Every entitlement is on one side or the other. A feature that appeared on
    // neither would silently vanish from the comparison.
    expect(new Set([...included, ...excluded]).size).toBe(
      included.length + excluded.length,
    )
  })
})

/* ============================================================= the offer == */

describe('the other packages', () => {
  it('reads them from the plans table, not from the seed catalogue', async () => {
    const offered = await listOfferedPlans(client())

    // `plans_select` admits every public plan. `SEED_PLANS` says in its own
    // header that nothing reads it at runtime, because an administrator edits
    // prices in a back office.
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.map((plan) => plan.code)).toContain('basic')
    expect(offered.map((plan) => plan.code)).toContain('management')

    for (let index = 1; index < offered.length; index += 1) {
      expect(offered[index].sortOrder).toBeGreaterThanOrEqual(
        offered[index - 1].sortOrder,
      )
    }
  })

  it('says what a move would add and what it would take away', async () => {
    const plan = await planOn('pro')
    const usage = await loadUsage(client(), ORGANIZATION)
    const differences = comparePlans(
      await listOfferedPlans(client()),
      plan,
      usage,
    )

    // The customer's own package is not compared against itself.
    expect(differences.map((entry) => entry.plan.code)).not.toContain('pro')

    const management = differences.find(
      (entry) => entry.plan.code === 'management',
    )
    expect(management?.isUpgrade).toBe(true)
    expect(management?.gains).toContain('approvals')
    expect(management?.gains).toContain('owner_portal')
    expect(management?.losses).toEqual([])

    const basic = differences.find((entry) => entry.plan.code === 'basic')
    expect(basic?.isUpgrade).toBe(false)
    // Both directions. A table that only ever adds is a sales page.
    expect(basic?.losses).toContain('operations')
    expect(basic?.gains).toEqual([])
  })

  it('flags a ceiling the business has already passed', async () => {
    const plan = await planOn('pro')
    const usage = await loadUsage(client(), ORGANIZATION)
    const differences = comparePlans(
      await listOfferedPlans(client()),
      plan,
      usage,
    )

    const basic = differences.find((entry) => entry.plan.code === 'basic')
    const units = basic?.limitChanges.find((change) => change.key === 'units')

    // Basic allows two units and the organization has seven, so moving there
    // is not a saving — it is a refusal waiting to happen, and the screen says
    // which kind of refusal.
    expect(units?.from).toBe(15)
    expect(units?.to).toBe(2)
    expect(units?.alreadyExceeded).toBe(true)
  })

  it('never claims an unmeasured quota has been exceeded', async () => {
    const plan = await planOn('pro')
    const usage = await loadUsage(client(), ORGANIZATION)
    const differences = comparePlans(
      await listOfferedPlans(client()),
      plan,
      usage,
    )

    for (const difference of differences) {
      const storage = difference.limitChanges.find(
        (change) => change.key === 'storageGb',
      )
      expect(storage?.alreadyExceeded ?? false).toBe(false)
    }
  })
})
