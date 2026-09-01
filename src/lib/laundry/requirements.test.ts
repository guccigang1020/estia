/**
 * The engine, and the one property a literal scan cannot prove.
 *
 * `no-hardcoded-numbers.test.ts` shows that no business figure is written down
 * in this directory. It cannot show that the figures which come out are the
 * ones preparation put in — a module that recomputed `guests × 1` would pass
 * that scan and produce the right answer for this customer.
 *
 * So the load-bearing test in this file is `derives every quantity from the
 * preparation requirement`: it changes the canonical input and asserts the
 * output moves with it. That is the only assertion that distinguishes a copied
 * number from a re-derived one, and it is why it is first.
 */

import { describe, expect, it } from 'vitest'

import type { Requirement } from '../preparation/types'
import {
  FORBIDDEN_IN_SIMPLE,
  forbiddenSimpleWords,
  hasSection,
  routeFor,
  sectionsFor,
  vocabularyFor,
} from './mode'
import { applyAdjustment, calculatedOnly, explainQuantity } from './override'
import { buildLaundryRequirements, mergeRequirements } from './requirements'
import { resolveSettings } from './settings'
import {
  GALILEE,
  GALILEE_REQUIREMENTS,
  ORGANIZATION,
  PROFILES,
  REQUIRED_BY,
  SETTINGS,
} from './testing/example-configuration'

function build(requirements: readonly Requirement[] = GALILEE_REQUIREMENTS) {
  return buildLaundryRequirements({
    settings: SETTINGS,
    profiles: PROFILES,
    requirements,
    propertyId: GALILEE,
    requiredBy: REQUIRED_BY,
    bookingId: 'booking-1',
  })
}

function find(
  result: ReturnType<typeof build>,
  itemId: string,
): NonNullable<ReturnType<typeof build>['requirements'][number]> {
  const found = result.requirements.find((entry) => entry.itemId === itemId)
  if (!found) throw new Error(`no laundry requirement for ${itemId}`)
  return found
}

// ── The property the scan cannot prove ────────────────────────────────────

describe('the quantity comes from preparation', () => {
  it('derives every quantity from the preparation requirement', () => {
    const before = build()
    const beforeTowels = find(before, 'towel_bath')

    // Change ONLY the canonical requirement — as editing a preparation rule
    // would — and nothing else. If this module were recomputing from a guest
    // count, the output would not move.
    const edited = GALILEE_REQUIREMENTS.map((requirement) =>
      requirement.itemId === 'towel_bath'
        ? {
            ...requirement,
            quantity: requirement.quantity + 1,
            sources: requirement.sources.map((source) => ({
              ...source,
              base: source.base + 1,
              buffered: source.buffered + 1,
            })),
          }
        : requirement,
    )

    const after = find(build(edited), 'towel_bath')

    expect(after.preparationQuantity).toBe(beforeTowels.preparationQuantity + 1)
    expect(after.quantity).toBe(beforeTowels.quantity + 1)
  })

  it('copies the preparation figure rather than transforming it', () => {
    const towels = find(build(), 'towel_bath')
    const canonical = GALILEE_REQUIREMENTS.find(
      (entry) => entry.itemId === 'towel_bath',
    )

    expect(towels.preparationQuantity).toBe(canonical?.quantity)
  })

  it('adds the item profile buffer and nothing else', () => {
    const towels = find(build(), 'towel_bath')
    const profile = PROFILES.find((entry) => entry.itemId === 'towel_bath')

    expect(towels.buffer).toBe(profile?.minimumBuffer)
    expect(towels.quantity).toBe(
      towels.preparationQuantity + (profile?.minimumBuffer ?? 0),
    )
  })

  it('rounds up to whole bundles where the provider counts in bundles', () => {
    const linen = find(build(), 'linen_set')
    const profile = PROFILES.find((entry) => entry.itemId === 'linen_set')
    const bundleSize = profile?.bundleSize ?? 1

    expect(linen.bundleSize).toBe(bundleSize)
    expect(linen.quantity % bundleSize).toBe(0)
    expect(linen.quantity).toBeGreaterThanOrEqual(
      linen.preparationQuantity + linen.buffer,
    )
    expect(linen.quantity - bundleSize).toBeLessThan(
      linen.preparationQuantity + linen.buffer,
    )
  })
})

// ── The filter ────────────────────────────────────────────────────────────

describe('what goes to a wash', () => {
  it('sends only items whose profile says so', () => {
    const result = build()
    const sent = result.requirements.map((entry) => entry.itemId)

    expect(sent).toContain('towel_bath')
    expect(sent).toContain('linen_set')
    expect(sent).not.toContain('mattress')
    expect(sent).not.toContain('toilet_paper')
  })

  it('reports what it skipped, and why, rather than dropping it', () => {
    const result = build()

    const mattress = result.skipped.find((entry) => entry.itemId === 'mattress')
    const paper = result.skipped.find(
      (entry) => entry.itemId === 'toilet_paper',
    )

    expect(mattress?.reason).toBe('no_profile')
    expect(paper?.reason).toBe('not_laundry_managed')

    // Every skipped item explains itself in Hebrew, because a shorter list is
    // indistinguishable from a correct one.
    for (const entry of result.skipped) {
      expect(entry.explanation.length).toBeGreaterThan(0)
      expect(entry.explanation).toContain(entry.label)
    }
  })

  it('accounts for every canonical requirement exactly once', () => {
    const result = build()

    expect(result.requirements.length + result.skipped.length).toBe(
      GALILEE_REQUIREMENTS.length,
    )
  })

  it('refuses to send an item the organization will not let leave', () => {
    const restricted = PROFILES.map((profile) =>
      profile.itemId === 'linen_set'
        ? { ...profile, externalLaundryAllowed: false }
        : profile,
    )

    const result = buildLaundryRequirements({
      settings: SETTINGS,
      profiles: restricted,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: null,
    })

    expect(
      result.skipped.find((entry) => entry.itemId === 'linen_set')?.reason,
    ).toBe('external_not_allowed')
  })
})

// ── Explainability ────────────────────────────────────────────────────────

describe('every number shows its arithmetic', () => {
  it('explains the chain from the preparation rule to the order', () => {
    const linen = find(build(), 'linen_set')

    // Preparation's own figure, preparation's buffer, the laundry buffer and
    // the bundle rounding: four steps, because the fixture exercises all four.
    expect(linen.explanation.map((step) => step.kind)).toEqual([
      'preparation',
      'preparation_buffer',
      'laundry_buffer',
      'bundle',
    ])

    // The last step's value is the number on the order. A chain whose end
    // disagrees with the figure beside it is worse than no chain.
    expect(linen.explanation.at(-1)?.value).toBe(linen.quantity)
  })

  it('names the numbers in the sentence, not only in the field', () => {
    const towels = find(build(), 'towel_bath')
    const first = towels.explanation[0]

    expect(first?.text).toContain(String(first?.value))
    expect(first?.text).toContain(towels.label)
  })

  it('leaves out steps that did nothing', () => {
    const hand = find(build(), 'towel_hand')

    // No laundry buffer and no bundling on this item, so neither step appears.
    expect(hand.explanation.map((step) => step.kind)).toEqual(['preparation'])
  })
})

// ── Merging ───────────────────────────────────────────────────────────────

describe('two bookings at one property', () => {
  it('adds them up and keeps the tighter deadline', () => {
    const early = build().requirements
    const late = buildLaundryRequirements({
      settings: SETTINGS,
      profiles: PROFILES,
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: '2026-09-05T13:00:00.000Z',
      bookingId: 'booking-2',
    }).requirements

    const merged = mergeRequirements([...early, ...late])
    const towels = merged.find((entry) => entry.itemId === 'towel_bath')
    const single = early.find((entry) => entry.itemId === 'towel_bath')

    expect(towels?.preparationQuantity).toBe(
      (single?.preparationQuantity ?? 0) * 2,
    )
    // The EARLIER deadline. Taking the later one produces an order that is on
    // time for the merge and late for one of its members.
    expect(towels?.requiredBy).toBe(REQUIRED_BY)
  })
})

// ── Modes ─────────────────────────────────────────────────────────────────

describe('the five modes', () => {
  it('gives `off` no sections at all', () => {
    expect(sectionsFor('off')).toEqual([])
  })

  it('gives `simple` a list and a forecast, and no orders or providers', () => {
    expect(hasSection('simple', 'requirements')).toBe(true)
    expect(hasSection('simple', 'forecast')).toBe(true)
    expect(hasSection('simple', 'orders')).toBe(false)
    expect(hasSection('simple', 'providers')).toBe(false)
    expect(hasSection('simple', 'tasks')).toBe(false)
  })

  it('never shows a `simple` business a word from an operation it lacks', () => {
    const words = Object.values(vocabularyFor('simple')).join(' ')
    expect(forbiddenSimpleWords(words)).toEqual([])
  })

  it('has a forbidden list that is not empty, so the check means something', () => {
    // A guard whose list is empty passes for ever and proves nothing.
    expect(FORBIDDEN_IN_SIMPLE.length).toBeGreaterThan(0)
    expect(forbiddenSimpleWords(FORBIDDEN_IN_SIMPLE.join(' '))).toEqual(
      FORBIDDEN_IN_SIMPLE,
    )
  })

  it('routes per item only under hybrid', () => {
    expect(routeFor('external', null)).toBe('external')
    expect(routeFor('internal', 'external')).toBe('internal')
    expect(routeFor('hybrid', 'external')).toBe('external')
    expect(routeFor('hybrid', 'internal')).toBe('internal')
    // The conservative fallback: an unrouted item stays inside the building.
    expect(routeFor('hybrid', null)).toBe('internal')
  })

  it('still builds a plan for a business that has configured nothing', () => {
    // `off` is the default and preparation must work completely without any of
    // this. The engine answering at all is what proves the section is optional
    // rather than a dependency.
    const { settings, source } = resolveSettings(ORGANIZATION, [], GALILEE)

    expect(source).toBe('default')
    expect(settings.mode).toBe('off')

    const result = buildLaundryRequirements({
      settings,
      profiles: [],
      requirements: GALILEE_REQUIREMENTS,
      propertyId: GALILEE,
      requiredBy: REQUIRED_BY,
      bookingId: null,
    })

    expect(result.requirements).toEqual([])
    expect(result.skipped).toHaveLength(GALILEE_REQUIREMENTS.length)
  })
})

describe('settings resolution', () => {
  it('prefers a property row whole, and says where it came from', () => {
    const property = {
      ...SETTINGS,
      propertyId: GALILEE,
      mode: 'simple' as const,
    }
    const resolved = resolveSettings(
      ORGANIZATION,
      [SETTINGS, property],
      GALILEE,
    )

    expect(resolved.source).toBe('property')
    expect(resolved.settings.mode).toBe('simple')
  })

  it('falls back to the organization row for another property', () => {
    const property = {
      ...SETTINGS,
      propertyId: GALILEE,
      mode: 'simple' as const,
    }
    const resolved = resolveSettings(
      ORGANIZATION,
      [SETTINGS, property],
      'other',
    )

    expect(resolved.source).toBe('organization')
    expect(resolved.settings.mode).toBe(SETTINGS.mode)
  })
})

// ── Manual override ───────────────────────────────────────────────────────

describe('a person changing a number', () => {
  it('keeps the calculated figure, the adjustment and the final apart', () => {
    const start = calculatedOnly(find(build(), 'towel_bath').quantity)
    const adjusted = applyAdjustment(start, {
      adjustment: 4,
      reason: 'אירוע גדול, מרווח נוסף',
      adjustedByUserId: 'user-1',
      at: REQUIRED_BY,
    })

    expect(adjusted.calculated).toBe(start.calculated)
    expect(adjusted.adjustment).toBe(4)
    expect(adjusted.final).toBe(start.calculated + 4)
    expect(adjusted.reason).toBe('אירוע גדול, מרווח נוסף')
  })

  it('never destroys the calculated figure, however many times it is edited', () => {
    const start = calculatedOnly(find(build(), 'linen_set').quantity)

    const once = applyAdjustment(start, {
      adjustment: 5,
      reason: 'ראשון',
      adjustedByUserId: 'user-1',
      at: REQUIRED_BY,
    })
    const twice = applyAdjustment(once, {
      adjustment: -2,
      reason: 'שני',
      adjustedByUserId: 'user-2',
      at: REQUIRED_BY,
    })

    expect(twice.calculated).toBe(start.calculated)
    // The second adjustment REPLACES the first rather than adding to it: the
    // person typing it is looking at a screen showing the first one.
    expect(twice.adjustment).toBe(-2)
    expect(twice.final).toBe(start.calculated - 2)
  })

  it('refuses an adjustment with no stated reason', () => {
    expect(() =>
      applyAdjustment(calculatedOnly(10), {
        adjustment: 1,
        reason: '   ',
        adjustedByUserId: 'user-1',
        at: REQUIRED_BY,
      }),
    ).toThrow(/reason/i)
  })

  it('refuses an adjustment that would make the quantity negative', () => {
    expect(() =>
      applyAdjustment(calculatedOnly(10), {
        adjustment: -20,
        reason: 'טעות',
        adjustedByUserId: 'user-1',
        at: REQUIRED_BY,
      }),
    ).toThrow(/negative/i)
  })

  it('shows the override as one more step in the same chain', () => {
    const towels = find(build(), 'towel_bath')
    const adjusted = applyAdjustment(calculatedOnly(towels.quantity), {
      adjustment: 4,
      reason: 'אירוע גדול',
      adjustedByUserId: 'user-1',
      at: REQUIRED_BY,
    })

    const chain = explainQuantity(towels.explanation, adjusted)

    expect(chain).toHaveLength(towels.explanation.length + 1)
    expect(chain.at(-1)?.kind).toBe('adjustment')
    expect(chain.at(-1)?.value).toBe(adjusted.final)
    // The reason is IN the explanation, not only in a column somewhere.
    expect(chain.at(-1)?.text).toContain('אירוע גדול')
  })
})
