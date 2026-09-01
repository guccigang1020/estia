/**
 * Only the actions this organization can actually take.
 *
 * The failure this guards against is soft and expensive: a screen offers
 * "transfer from another property" to a business with one villa, the person
 * clicks, the action refuses, and they stop trusting the whole screen. So the
 * set of buttons is a function of the capabilities and is asserted as one.
 */

import { describe, expect, it } from 'vitest'

import { actionIsAvailable, buildActions, suggestedActionFrom } from './actions'
import { capabilitiesFor, startingSettingsFor } from './settings'
import type { ForecastRow } from './types'

const ROW: ForecastRow = {
  date: '2026-09-05',
  propertyId: 'property-a',
  itemId: 'item-towel',
  label: 'מגבת גוף',
  openingClean: 25,
  incoming: 0,
  required: 30,
  expectedClean: 25,
  shortage: 5,
  closingClean: 0,
  safetyBuffer: 6,
  breachesBuffer: false,
  reserved: 25,
}

function kindsFor(mode: 'basic' | 'tracked' | 'advanced') {
  const capabilities = capabilitiesFor(startingSettingsFor('org-1', mode))
  return buildActions({
    row: ROW,
    capabilities,
    settings: startingSettingsFor('org-1', mode),
  }).map((action) => action.kind)
}

describe('the actions offered depend on the capabilities', () => {
  it('basic offers no laundry, no transfer and no purchase', () => {
    expect(kindsFor('basic')).toEqual([
      'adjust_buffer',
      'mark_corrected',
      'ignore',
    ])
  })

  it('tracked adds the laundry loop and a purchase request', () => {
    const kinds = kindsFor('tracked')

    expect(kinds).toContain('accelerate_laundry')
    expect(kinds).toContain('order_laundry')
    expect(kinds).toContain('purchase_request')
    expect(kinds).not.toContain('transfer_from_property')
  })

  it('advanced adds the cross-property transfer', () => {
    expect(kindsFor('advanced')).toContain('transfer_from_property')
  })

  it('mark_corrected and ignore are always available', () => {
    for (const mode of ['basic', 'tracked', 'advanced'] as const) {
      expect(kindsFor(mode)).toContain('mark_corrected')
      expect(kindsFor(mode)).toContain('ignore')
    }
  })
})

describe('the suggestion is the cheapest real answer', () => {
  it('prefers hurrying a wash over buying towels', () => {
    const capabilities = capabilitiesFor(
      startingSettingsFor('org-1', 'tracked'),
    )
    const actions = buildActions({
      row: ROW,
      capabilities,
      settings: startingSettingsFor('org-1', 'tracked'),
    })

    expect(suggestedActionFrom(actions)).toBe('accelerate_laundry')
  })

  it('never suggests marking corrected or ignoring', () => {
    const capabilities = capabilitiesFor(startingSettingsFor('org-1', 'basic'))
    const actions = buildActions({
      row: ROW,
      capabilities,
      settings: startingSettingsFor('org-1', 'basic'),
    })

    // Those are the two that make a shortage disappear without answering it.
    expect(suggestedActionFrom(actions)).toBe('adjust_buffer')
  })
})

describe('the screen and the write path ask one question', () => {
  it('actionIsAvailable agrees with buildActions', () => {
    for (const mode of ['basic', 'tracked', 'advanced'] as const) {
      const capabilities = capabilitiesFor(startingSettingsFor('org-1', mode))
      const offered = buildActions({
        row: ROW,
        capabilities,
        settings: startingSettingsFor('org-1', mode),
      })

      for (const action of offered) {
        expect(actionIsAvailable(action.kind, capabilities)).toBe(true)
      }
    }
  })

  it('refuses a transfer under tracked, which is what the screen does not offer', () => {
    const capabilities = capabilitiesFor(
      startingSettingsFor('org-1', 'tracked'),
    )
    expect(actionIsAvailable('transfer_from_property', capabilities)).toBe(
      false,
    )
  })
})

describe('every action explains itself', () => {
  it('carries a detail sentence and, where it lives elsewhere, a destination', () => {
    const capabilities = capabilitiesFor(
      startingSettingsFor('org-1', 'advanced'),
    )
    const actions = buildActions({
      row: ROW,
      capabilities,
      settings: startingSettingsFor('org-1', 'advanced'),
    })

    expect(actions.every((action) => action.detail.length > 0)).toBe(true)
    expect(
      actions.find((action) => action.kind === 'transfer_from_property')?.href,
    ).toContain('/inventory/shortages')
    // `ignore` has nowhere to go: it is answered on the alert itself.
    expect(actions.find((action) => action.kind === 'ignore')?.href).toBeNull()
  })
})
