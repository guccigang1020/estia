/**
 * What the settings operations must never let somebody do.
 *
 * The tests are grouped by the thing that breaks in the product when the rule
 * is absent, not by function name — a suite that reads as a list of methods
 * proves the methods exist and nothing else.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError } from '../authz/can'
import { BusinessRuleError, ValidationError } from '../errors'
import { actorFor, ORG, PROPERTY } from '../finance/testing'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'

import { collectionFixture, journeyFixture } from './fixtures'
import { JOURNEY_PRESETS, SHIPPED_JOURNEY_SETTINGS } from './presets'
import type { ReconfirmationVerdict } from './reconfirmation'
import {
  InMemoryJourneySettingsRepository,
  defineJourneySettingsOperations,
  effectiveSettings,
  stripRecord,
  type JourneySettingsInput,
} from './settings'
import { buildSteps } from './steps'
import type { GuestJourneySettings } from './types'

const NOW = new Date('2026-09-02T09:00:00.000Z')

/** Nothing has moved since the guest approved. These tests are about settings. */
const UNCHANGED: ReconfirmationVerdict = {
  changed: false,
  required: false,
  changes: [],
  informational: [],
}

let repository: InMemoryJourneySettingsRepository
let audit: InMemoryAuditWriter
let idempotency: InMemoryIdempotencyStore
let events: InMemoryEventBus
let ops: ReturnType<typeof defineJourneySettingsOperations>

beforeEach(() => {
  repository = new InMemoryJourneySettingsRepository()
  audit = new InMemoryAuditWriter()
  idempotency = new InMemoryIdempotencyStore()
  events = new InMemoryEventBus()
  ops = defineJourneySettingsOperations({ repository })
})

function services(): OperationServices {
  return { audit, idempotency, events }
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    actor: actorFor('administrator'),
    auditActor: { type: 'user', userId: 'user-admin', label: 'דנה כהן' },
    correlationId: 'corr-1',
    now: NOW,
    reason: null,
    ...overrides,
  }
}

function input(
  overrides: Partial<JourneySettingsInput> = {},
): JourneySettingsInput {
  return { ...SHIPPED_JOURNEY_SETTINGS, propertyId: null, ...overrides }
}

/* ------------------------------------------------------------------------ */

describe('the shipped defaults', () => {
  /**
   * The transcription this module carries, pinned to the one the portal uses.
   *
   * `QUIET_SETTINGS` in `fixtures.ts` is what the guest journey's own suites
   * treat as "a business that has never configured anything", and the SQL
   * fallback in `guest_journey_effective_settings` is what the database
   * returns for the same case. If this assertion ever fails, the settings
   * screen is showing a business something other than what its guests get.
   */
  it('match the journey fixtures, field for field', async () => {
    const journey = journeyFixture()
    expect(SHIPPED_JOURNEY_SETTINGS).toEqual(journey.settings)
  })
})

describe('a business that asks for nothing but an approval', () => {
  /**
   * The rule the whole screen exists for: switched off must be a complete
   * configuration, not an unfinished one. Saved through the operation, read
   * back, and put through the portal's own `buildSteps`.
   */
  it('produces a portal with exactly one step and nothing else', async () => {
    await ops.saveSettings.run({
      request: {
        input: input({
          requireGuestConfirmation: true,
          contractMode: 'disabled',
          requiredDetailFields: [],
          optionalDetailFields: [],
          requestsEnabled: false,
          requestCategories: [],
          checkoutDeclarationEnabled: false,
          reviewEnabled: false,
          reviewUrl: null,
          rebookEnabled: false,
        }),
      },
      context: context(),
      services: services(),
    })

    const saved = await repository.loadSettings(ORG, null)
    expect(saved).not.toBeNull()

    const steps = buildSteps(
      journeyFixture({ settings: stripRecord(saved!) }),
      collectionFixture(),
      UNCHANGED,
    )

    expect(steps.map((step) => step.id)).toEqual(['confirm'])
  })

  it('grows a contract step the moment a contract is switched on', async () => {
    await ops.saveSettings.run({
      request: { input: input({ contractMode: 'mandatory' }) },
      context: context(),
      services: services(),
    })

    const saved = await repository.loadSettings(ORG, null)
    const steps = buildSteps(
      journeyFixture({ settings: stripRecord(saved!) }),
      collectionFixture(),
      UNCHANGED,
    )

    expect(steps.map((step) => step.id)).toEqual(['confirm', 'contract'])
  })
})

describe('the arrival release, which is a security control', () => {
  it('refuses a release that can never happen', async () => {
    await expect(
      ops.saveSettings.run({
        request: {
          input: input({
            arrivalRelease: 'after_contract',
            contractMode: 'disabled',
          }),
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(audit.records).toHaveLength(0)
    expect(repository.settings).toHaveLength(0)
  })

  it('accepts the same release once a contract exists', async () => {
    const outcome = await ops.saveSettings.run({
      request: {
        input: input({
          arrivalRelease: 'after_contract',
          contractMode: 'mandatory',
        }),
      },
      context: context(),
      services: services(),
    })

    expect(outcome.data.arrivalRelease).toBe('after_contract')
  })

  it('keeps the timed release inside the column constraint', async () => {
    await expect(
      ops.saveSettings.run({
        request: {
          input: input({
            arrivalRelease: 'hours_before',
            arrivalReleaseHours: 5_000,
          }),
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('steps that would render empty', () => {
  it('refuses a review with no link', async () => {
    await expect(
      ops.saveSettings.run({
        request: { input: input({ reviewEnabled: true, reviewUrl: null }) },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a review link that is not a link', async () => {
    await expect(
      ops.saveSettings.run({
        request: {
          input: input({ reviewEnabled: true, reviewUrl: 'גוגל ביקורות' }),
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses requests with nothing that may be requested', async () => {
    await expect(
      ops.saveSettings.run({
        request: {
          input: input({ requestsEnabled: true, requestCategories: [] }),
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses one field asked for twice', async () => {
    await expect(
      ops.saveSettings.run({
        request: {
          input: input({
            requiredDetailFields: ['full_name', 'phone'],
            optionalDetailFields: ['phone'],
          }),
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

describe('who may change it', () => {
  it('refuses a cleaner', async () => {
    await expect(
      ops.saveSettings.run({
        request: { input: input() },
        context: context({ actor: actorFor('cleaner') }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(repository.settings).toHaveLength(0)
  })

  /**
   * A member narrowed to two properties may configure those two, and may not
   * touch the default every property inherits. `withinScope` answers false for
   * a narrowed membership asked about a resource with no property, and that is
   * the answer this test pins.
   */
  it('refuses the organization default to a property-scoped member', async () => {
    const scoped = actorFor('administrator', {
      scope: { kind: 'properties', propertyIds: [PROPERTY] },
    })

    await expect(
      ops.saveSettings.run({
        request: { input: input({ propertyId: null }) },
        context: context({ actor: scoped }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

describe('an audit event for every change', () => {
  it('names the fields that moved', async () => {
    await ops.saveSettings.run({
      request: { input: input({ contractMode: 'mandatory' }) },
      context: context(),
      services: services(),
    })

    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].summary).toContain('חוזה')
  })

  /** A door code in the audit table is a door code the whole team can read. */
  it('never carries a door code or a wifi password', async () => {
    await ops.saveContent.run({
      request: {
        input: {
          propertyId: PROPERTY,
          addressNote: 'הבית הצהוב בקצה הרחוב',
          directions: null,
          mapUrl: null,
          accessInstructions: null,
          accessCode: '4821#',
          parking: null,
          wifiNetwork: 'estia-guest',
          wifiPassword: 'sup3rsecret',
          propertyGuide: null,
          emergencyContact: null,
          checkoutInstructions: null,
        },
      },
      context: context(),
      services: services(),
    })

    const record = audit.records[0]
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('4821#')
    expect(serialized).not.toContain('sup3rsecret')
    expect(record.summary).toContain('קוד כניסה')
  })

  it('stores an empty door code as absent rather than as blank', async () => {
    await ops.saveContent.run({
      request: {
        input: {
          propertyId: PROPERTY,
          addressNote: '   ',
          directions: null,
          mapUrl: null,
          accessInstructions: null,
          accessCode: '',
          parking: null,
          wifiNetwork: null,
          wifiPassword: null,
          propertyGuide: null,
          emergencyContact: null,
          checkoutInstructions: null,
        },
      },
      context: context(),
      services: services(),
    })

    const saved = await repository.loadContent(ORG, PROPERTY)
    expect(saved?.accessCode).toBeNull()
    expect(saved?.addressNote).toBeNull()
  })
})

describe('precedence between a property and the organization', () => {
  it('lets a property row win wholesale', async () => {
    await ops.saveSettings.run({
      request: { input: input({ contractMode: 'mandatory' }) },
      context: context(),
      services: services(),
    })
    await ops.saveSettings.run({
      request: {
        input: input({ propertyId: PROPERTY, contractMode: 'disabled' }),
      },
      context: context(),
      services: services(),
    })

    const rows = await repository.listSettings(ORG)

    expect(effectiveSettings(rows, PROPERTY).source).toBe('property')
    expect(effectiveSettings(rows, PROPERTY).settings.contractMode).toBe(
      'disabled',
    )
    expect(effectiveSettings(rows, null).settings.contractMode).toBe(
      'mandatory',
    )
  })

  it('falls back to the shipped defaults when nothing was ever saved', () => {
    const resolved = effectiveSettings([], null)
    expect(resolved.source).toBe('shipped')
    expect(resolved.settings).toEqual(SHIPPED_JOURNEY_SETTINGS)
  })

  it('returns a property to the organization default when cleared', async () => {
    await ops.saveSettings.run({
      request: { input: input({ propertyId: PROPERTY }) },
      context: context(),
      services: services(),
    })

    await ops.clearPropertySettings.run({
      request: { input: { propertyId: PROPERTY } },
      context: context(),
      services: services(),
    })

    const rows = await repository.listSettings(ORG)
    expect(effectiveSettings(rows, PROPERTY).source).toBe('shipped')
  })
})

describe('applying a preset', () => {
  const professional = JOURNEY_PRESETS.find(
    (preset) => preset.id === 'professional',
  )!

  it('states what it changed, and changes nothing the second time', async () => {
    const first = await ops.applyPreset.run({
      request: { input: { propertyId: null, presetId: 'professional' } },
      context: context(),
      services: services(),
    })

    expect(first.data.changes.length).toBeGreaterThan(0)
    const versionAfterFirst = first.data.settings.version

    const second = await ops.applyPreset.run({
      request: { input: { propertyId: null, presetId: 'professional' } },
      context: context(),
      services: services(),
    })

    expect(second.data.changes).toHaveLength(0)
    expect(second.data.settings.version).toBe(versionAfterFirst)
    // Applying it twice is still two things somebody did, and both are in the
    // trail. What must not double is the write.
    expect(audit.records).toHaveLength(2)
  })

  it('leaves the review off, and says so, when there is no link', async () => {
    const outcome = await ops.applyPreset.run({
      request: { input: { propertyId: null, presetId: 'professional' } },
      context: context(),
      services: services(),
    })

    expect(professional.settings.reviewEnabled).toBe(true)
    expect(outcome.data.settings.reviewEnabled).toBe(false)
    expect(outcome.data.notes.join(' ')).toContain('קישור')
  })

  it('keeps a review link the business already pasted in', async () => {
    await ops.saveSettings.run({
      request: {
        input: input({
          reviewEnabled: true,
          reviewUrl: 'https://g.page/r/estia/review',
        }),
      },
      context: context(),
      services: services(),
    })

    const outcome = await ops.applyPreset.run({
      request: { input: { propertyId: null, presetId: 'full_commerce' } },
      context: context(),
      services: services(),
    })

    expect(outcome.data.settings.reviewUrl).toBe(
      'https://g.page/r/estia/review',
    )
    expect(outcome.data.settings.reviewEnabled).toBe(true)
  })

  it('never narrows what voids an approval the guest already gave', async () => {
    await ops.saveSettings.run({
      request: {
        input: input({
          reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
        }),
      },
      context: context(),
      services: services(),
    })

    const outcome = await ops.applyPreset.run({
      request: { input: { propertyId: null, presetId: 'simple_villa' } },
      context: context(),
      services: services(),
    })

    expect(outcome.data.settings.reconfirmationTriggers.sort()).toEqual(
      ['cancellation', 'dates', 'guests', 'price'].sort(),
    )
  })

  it('is refused to a cleaner', async () => {
    await expect(
      ops.applyPreset.run({
        request: { input: { propertyId: null, presetId: 'simple_villa' } },
        context: context({ actor: actorFor('cleaner') }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('produces a portal a person could also have configured by hand', async () => {
    // Every preset must pass the same coherence rules a hand edit passes.
    for (const preset of JOURNEY_PRESETS) {
      const fresh = new InMemoryJourneySettingsRepository()
      const isolated = defineJourneySettingsOperations({ repository: fresh })

      const outcome = await isolated.applyPreset.run({
        request: { input: { propertyId: null, presetId: preset.id } },
        context: context(),
        services: { audit: new InMemoryAuditWriter() },
      })

      const settings: GuestJourneySettings = stripRecord(outcome.data.settings)
      const steps = buildSteps(
        journeyFixture({ settings }),
        collectionFixture(),
        UNCHANGED,
      )

      expect(steps.length).toBeGreaterThan(0)
    }
  })
})
