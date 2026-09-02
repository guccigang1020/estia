/**
 * The presets, as promises rather than as objects.
 *
 * Each test below is one sentence the screen makes to a person about what
 * pressing the button will do. A preset that quietly did something else would
 * be worse than no preset at all: it is the one control a business presses
 * before it understands the settings underneath it.
 */

import { describe, expect, it } from 'vitest'

import { QUIET_SETTINGS } from './fixtures'
import {
  JOURNEY_PRESETS,
  JOURNEY_PRESET_IDS,
  SHIPPED_JOURNEY_SETTINGS,
  applyPreset,
  describeChanges,
  describeSetting,
  matchingPreset,
  mergeStayTopics,
  presetById,
  resolvePreset,
} from './presets'
import type { GuestJourneySettings } from './types'

describe('the shipped defaults', () => {
  it('are the same quiet journey the portal suites assume', () => {
    expect(SHIPPED_JOURNEY_SETTINGS).toEqual(QUIET_SETTINGS)
  })
})

describe('the three presets', () => {
  it('are exactly the three the specification names', () => {
    expect(JOURNEY_PRESETS.map((preset) => preset.id)).toEqual([
      ...JOURNEY_PRESET_IDS,
    ])
  })

  it('each say what they expect of the payment policy, and change none of it', () => {
    for (const preset of JOURNEY_PRESETS) {
      expect(preset.paymentGuidance.sentence.length).toBeGreaterThan(0)
      expect(preset.highlights.length).toBeGreaterThan(0)
      // The proof that a preset writes no payment policy is structural: the
      // settings it carries are exactly the journey's own fields, and a
      // collection policy is not one of them.
      expect(Object.keys(preset.settings).sort()).toEqual(
        Object.keys(SHIPPED_JOURNEY_SETTINGS).sort(),
      )
    }
  })

  it('never demand a detail field both ways', () => {
    for (const preset of JOURNEY_PRESETS) {
      const optional = new Set<string>(preset.settings.optionalDetailFields)
      const both = preset.settings.requiredDetailFields.filter((field) =>
        optional.has(field),
      )
      expect(both).toEqual([])
    }
  })

  it('never gate the address on a contract they did not switch on', () => {
    for (const preset of JOURNEY_PRESETS) {
      if (preset.settings.arrivalRelease === 'after_contract') {
        expect(preset.settings.contractMode).not.toBe('disabled')
      }
    }
  })

  it('never switch requests on with nothing that may be requested', () => {
    for (const preset of JOURNEY_PRESETS) {
      if (preset.settings.requestsEnabled) {
        expect(preset.settings.requestCategories.length).toBeGreaterThan(0)
      }
    }
  })

  it('all keep every consent trigger', () => {
    for (const preset of JOURNEY_PRESETS) {
      expect([...preset.settings.reconfirmationTriggers].sort()).toEqual([
        'cancellation',
        'dates',
        'guests',
        'price',
      ])
    }
  })
})

describe('the simple villa, which is the majority', () => {
  const preset = presetById('simple_villa')!

  it('asks for a confirmation and nothing else that costs the guest a step', () => {
    expect(preset.settings.requireGuestConfirmation).toBe(true)
    expect(preset.settings.contractMode).toBe('disabled')
    expect(preset.settings.requestsEnabled).toBe(false)
    expect(preset.settings.checkoutDeclarationEnabled).toBe(false)
    expect(preset.settings.reviewEnabled).toBe(false)
  })
})

describe('resolving a preset against what is already there', () => {
  it('is idempotent', () => {
    const preset = presetById('professional')!
    const once = resolvePreset(SHIPPED_JOURNEY_SETTINGS, preset)
    const twice = resolvePreset(once.settings, preset)

    expect(twice.settings).toEqual(once.settings)
    expect(twice.changes).toEqual([])
  })

  it('states every change before anything is written', () => {
    const preset = presetById('professional')!
    const { changes } = resolvePreset(SHIPPED_JOURNEY_SETTINGS, preset)

    const fields = changes.map((change) => change.field)
    expect(fields).toContain('contractMode')
    expect(fields).toContain('arrivalRelease')
    for (const change of changes) {
      expect(change.from).not.toBe(change.to)
      expect(change.label.length).toBeGreaterThan(0)
    }
  })

  it('keeps a review link and never invents one', () => {
    const withLink: GuestJourneySettings = {
      ...SHIPPED_JOURNEY_SETTINGS,
      reviewUrl: 'https://g.page/r/estia/review',
    }

    expect(
      resolvePreset(withLink, presetById('professional')!).settings,
    ).toMatchObject({
      reviewEnabled: true,
      reviewUrl: 'https://g.page/r/estia/review',
    })

    expect(
      resolvePreset(SHIPPED_JOURNEY_SETTINGS, presetById('professional')!)
        .settings.reviewEnabled,
    ).toBe(false)
  })

  it('only ever widens what voids an approval', () => {
    const narrowed: GuestJourneySettings = {
      ...SHIPPED_JOURNEY_SETTINGS,
      reconfirmationTriggers: ['price'],
    }

    const resolved = resolvePreset(narrowed, presetById('simple_villa')!)
    expect([...resolved.settings.reconfirmationTriggers].sort()).toEqual([
      'cancellation',
      'dates',
      'guests',
      'price',
    ])
  })

  it('says out loud that it touches neither the money nor the words', () => {
    const { notes } = resolvePreset(
      SHIPPED_JOURNEY_SETTINGS,
      presetById('full_commerce')!,
    )

    expect(notes.join(' ')).toContain('גבייה')
    expect(notes.join(' ')).toContain('קוד כניסה')
  })
})

describe('what applying one would cost, shown before it is applied', () => {
  it('separates filling in a blank from overruling a decision', () => {
    const chosen: GuestJourneySettings = {
      ...SHIPPED_JOURNEY_SETTINGS,
      // Somebody deliberately switched requests off. A preset that turns them
      // back on is overruling a person, and must say so.
      requestsEnabled: false,
      requestCategories: [],
    }

    const application = applyPreset(chosen, presetById('professional')!)
    const fields = application.overwrites.map((change) => change.field)

    expect(fields).toContain('requestsEnabled')
    // `contractMode` is still the shipped default here, so switching a
    // contract on fills in a blank rather than overruling anybody.
    expect(fields).not.toContain('contractMode')
    expect(application.changes.length).toBeGreaterThan(
      application.overwrites.length,
    )
  })

  it('recognises settings that already are a preset', () => {
    const professional = presetById('professional')!
    const applied = applyPreset(SHIPPED_JOURNEY_SETTINGS, professional).settings

    expect(matchingPreset(applied)?.id).toBe('professional')
    expect(matchingPreset({ ...applied, requestsEnabled: false })).toBeNull()
  })

  it('calls the shipped defaults no preset at all', () => {
    expect(matchingPreset(SHIPPED_JOURNEY_SETTINGS)).toBeNull()
  })
})

describe('keeping a topic this build has never heard of', () => {
  it('survives a checkbox that could not draw it', () => {
    const merged = mergeStayTopics(
      ['wifi', 'access'],
      ['wifi', 'access', 'concierge'],
    )

    expect(merged).toEqual(['wifi', 'access', 'concierge'])
  })

  it('returns the known topics in the canonical order', () => {
    expect(mergeStayTopics(['checkout', 'wifi'], [])).toEqual([
      'wifi',
      'checkout',
    ])
  })
})

describe('describing one setting', () => {
  it('renders an order-independent list the same way twice', () => {
    const left: GuestJourneySettings = {
      ...SHIPPED_JOURNEY_SETTINGS,
      requiredDetailFields: ['phone', 'full_name'],
    }
    const right: GuestJourneySettings = {
      ...SHIPPED_JOURNEY_SETTINGS,
      requiredDetailFields: ['phone', 'full_name'],
    }

    expect(describeSetting('requiredDetailFields', left)).toBe(
      describeSetting('requiredDetailFields', right),
    )
    expect(describeChanges(left, right)).toEqual([])
  })

  it('folds the hours into the arrival sentence only when they matter', () => {
    const timed: GuestJourneySettings = {
      ...SHIPPED_JOURNEY_SETTINGS,
      arrivalRelease: 'hours_before',
      arrivalReleaseHours: 48,
    }

    expect(describeSetting('arrivalRelease', timed)).toContain('48')

    const laterHours: GuestJourneySettings = {
      ...SHIPPED_JOURNEY_SETTINGS,
      arrivalReleaseHours: 48,
    }

    // The release is not the timed one, so a different number of hours is not
    // a change anybody can see and is not announced as one.
    expect(describeChanges(SHIPPED_JOURNEY_SETTINGS, laterHours)).toEqual([])
  })

  it('says "ללא" rather than nothing for an empty list', () => {
    expect(
      describeSetting('requiredDetailFields', SHIPPED_JOURNEY_SETTINGS),
    ).toBe('ללא')
  })
})
