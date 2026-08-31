/**
 * The dashboard lists a plan's entitlements by name, and the demo caught this
 * the first time anybody looked at it: `agent_network` sat in the middle of a
 * Hebrew list, in English, because the map was `Partial` and the fallback
 * printed the code. Nothing failed. The screen simply said something in the
 * wrong language to a customer.
 *
 * The map is total now, so a missing label is a typecheck error. This file
 * covers the half a type cannot: that the value is actually Hebrew and
 * actually different from the code, which `agent_network: 'agent_network'`
 * would satisfy the compiler with.
 */

import { describe, expect, it } from 'vitest'

import { ENTITLEMENTS } from '@/lib/plans/entitlements'

import { ENTITLEMENT_LABELS, entitlementLabel } from './labels'

/** Hebrew letters. `API` is deliberately not one — see the test below. */
const HEBREW = /[֐-׿]/

describe('entitlement labels', () => {
  it.each(ENTITLEMENTS)('names %s in something other than its code', (code) => {
    expect(ENTITLEMENT_LABELS[code]).not.toBe(code)
    expect(ENTITLEMENT_LABELS[code].trim().length).toBeGreaterThan(0)
  })

  it('writes the labels in Hebrew, apart from the ones that are proper names', () => {
    // `API`, and `AI` inside `תוכן AI`, are read in Latin script by the people
    // who use this product. Everything else has to be Hebrew, which is the
    // property that failed on `agent_network`.
    const exempt = new Set(['api_access'])

    for (const code of ENTITLEMENTS) {
      if (exempt.has(code)) continue
      expect(ENTITLEMENT_LABELS[code]).toMatch(HEBREW)
    }
  })

  it('still falls back for a code the catalogue does not know', () => {
    // The database can hand a screen an entitlement this build has never heard
    // of. Showing the raw code is the honest outcome there; the type system
    // covers the case that is actually preventable.
    expect(entitlementLabel('not_a_real_entitlement')).toBe(
      'not_a_real_entitlement',
    )
  })
})
