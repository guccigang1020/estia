/**
 * The one thing about the plan catalogue that cannot be checked by reading it.
 *
 * `ENTITLEMENTS` is the vocabulary and `SEED_PLANS` is what is actually for
 * sale, and nothing connected the two. An entitlement can therefore be added
 * to the vocabulary, mapped to a dozen grants, wired into route guards and
 * menu entries and screens — and sold by no package at all, which means every
 * one of those screens is permanently plan-locked for every customer.
 *
 * That is not hypothetical. It happened twice in one afternoon, to `laundry`
 * and to `commerce`, and it was found by a worker whose HTTP check showed a
 * plan lock for the organization owner on a Management plan and who was
 * unwilling to write it off as a demo quirk. The failure is silent in exactly
 * the wrong way: every unit test passes, the engine is correct, the refusal is
 * even worded correctly — it simply refuses everybody, forever.
 *
 * So the catalogue is checked against the vocabulary here.
 */

import { describe, expect, it } from 'vitest'

import { SEED_PLANS } from './catalog'
import { ENTITLEMENTS, type Entitlement } from './entitlements'

/**
 * Entitlements that are deliberately sold by no package.
 *
 * Empty today, and it exists so that "sold by nobody" has to be *stated*
 * rather than merely be the case. `agent_network` is the shape this is for: it
 * is absent from Basic on purpose and reaches that customer through
 * `subscription.entitlementGrants` as a paid add-on — but it is still listed
 * on three packages, so it is not add-on-only. Anything genuinely sold only as
 * an add-on belongs here, with the reason beside it.
 */
const ADD_ON_ONLY: readonly Entitlement[] = [
  // Pre-existing, and found by this test on its first run rather than by
  // anybody reading the catalogue. No grant in `ENTITLEMENT_FOR_GRANT` maps to
  // it and no screen is behind it, so today it gates nothing and its absence
  // costs no customer anything — `labels.test.ts` already exempts it for the
  // same reason. It stays out of every package until there is an API to sell,
  // and it is named here so that the day somebody puts a route behind it, this
  // list is the thing they have to edit and therefore the thing that reminds
  // them to price it.
  'api_access',
]

describe('every entitlement is actually for sale', () => {
  const sold = new Set<Entitlement>(
    SEED_PLANS.flatMap((plan) => plan.entitlements),
  )

  it.each(ENTITLEMENTS)(
    '%s is on a package or declared add-on-only',
    (code) => {
      const isSold = sold.has(code)
      const isAddOnOnly = ADD_ON_ONLY.includes(code)

      // The message matters more than the assertion: somebody meeting this
      // failure has just added an entitlement and needs to be told the step they
      // missed, not merely that a set does not contain a string.
      expect(
        isSold || isAddOnOnly,
        `'${code}' is in ENTITLEMENTS and on no package in SEED_PLANS. ` +
          'Every screen behind it is plan-locked for every customer, including ' +
          'the owner, and the refusal reads as a correct upgrade offer rather ' +
          'than as a bug. Add it to a plan, or to ADD_ON_ONLY with the reason.',
      ).toBe(true)
    },
  )

  it('does not list an entitlement no longer in the vocabulary', () => {
    const vocabulary = new Set<string>(ENTITLEMENTS)
    const unknown = [...sold].filter((code) => !vocabulary.has(code))

    // The other direction, and the one that produces a silent over-grant: a
    // package selling a name the engine no longer recognises grants nothing
    // and refuses nothing, so nobody notices until a customer asks where the
    // feature they paid for went.
    expect(unknown).toEqual([])
  })

  it('sells `core` on every package', () => {
    // Not an entitlement so much as the floor. A package without it is a
    // package that cannot take a booking.
    for (const plan of SEED_PLANS) {
      expect(plan.entitlements, plan.code).toContain('core')
    }
  })
})
