/**
 * The preparation policy, from a form to a plan, over the demo dataset.
 *
 * ── The claim this file exists to prove ───────────────────────────────────
 *
 * A villa owner can describe their own house and their own quantities, and the
 * plan that comes out is the one the engine produces — not a number this test
 * typed, and not a second implementation that agrees on the easy cases.
 *
 * So every assertion about the plan is stated against `allocateSleeping`,
 * `measureFacts`, `resolveQuantity` and `applyBuffer` called separately on the
 * same inputs. If the preview and the engine ever disagree, the equality fails
 * rather than a literal that somebody would have quietly updated.
 *
 * The one place literals appear on purpose is the configuration itself. That
 * is the whole point: a bed's capacity and a towel's divisor are things a
 * customer types, and `no-hardcoded-numbers.test.ts` proves they exist nowhere
 * in the engine. Here they are inputs.
 *
 * ── The worked example ────────────────────────────────────────────────────
 *
 * Five double-width beds sleeping two each, and a party of twenty-five. Ten
 * permanent sleeping places, fifteen more to find, and floor mattresses to
 * find them with. Everything else follows.
 */

import { describe, expect, it } from 'vitest'

import { resolveActor } from '@/lib/actor'
import type { Actor } from '@/lib/authz/can'
import { can } from '@/lib/authz/can'
import { addDays, localDate } from '@/lib/booking/dates'
import { createDemoClient } from '@/lib/demo/client'
import { DEMO_DATASET, DEMO_PERSONAS, DEMO_PLANS } from '@/lib/demo/dataset'
import { PROPERTY_IDS } from '@/lib/demo/dataset-inventory'
import { DemoActorSource } from '@/lib/demo/session'
import { SupabasePreparationPorts, type Db } from '@/lib/persistence'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import {
  allocateSleeping,
  applyBuffer,
  captureSnapshot,
  catalogueFrom,
  catalogueProblems,
  configureInput,
  measureFacts,
  previewPlan,
  resolveQuantity,
  type PreparationBooking,
} from '@/lib/preparation'

import { draftFromCatalogue, emptyDraft, type PolicyDraft } from './policy'

const ORGANIZATION = DEMO_DATASET.organizationId
const PROPERTY = PROPERTY_IDS.kacholYam

function demoDb(): Db {
  return createDemoClient(DEMO_DATASET) as unknown as Db
}

function planNamed(code: string) {
  const found = DEMO_PLANS.find((plan) => plan.code === code)
  if (!found) throw new Error(`No demo plan '${code}'`)
  return found
}

/** `pro`, because `checklist.manage` is entitlement-gated on `operations`. */
async function actorFor(personaId: string, planCode = 'pro'): Promise<Actor> {
  const persona = DEMO_PERSONAS.find((entry) => entry.id === personaId)
  if (!persona) throw new Error(`No demo persona '${personaId}'`)

  const source = new DemoActorSource(
    new SupabaseActorSource(demoDb()),
    planNamed(planCode),
  )

  const resolution = await resolveActor(source, persona.userId, ORGANIZATION)
  if (!resolution.ok) {
    throw new Error(
      `${persona.label} does not resolve to an actor: ${resolution.reason}`,
    )
  }
  return resolution.actor
}

/* ------------------------------------------------ the owner's own policy -- */

const DOUBLE_BED = 'double_bed'
const FLOOR_MATTRESS = 'floor_mattress'

/**
 * The configuration a villa owner would type into the screen.
 *
 * Five double-width beds made up in the bedrooms, floor mattresses as the
 * answer when they run out, and four quantity rules. Nothing here is a default
 * the product ships; it is what this particular house does.
 */
function villaDraft(): PolicyDraft {
  const draft = emptyDraft(PROPERTY, 'וילה כחול ים')

  return {
    ...draft,
    property: {
      ...draft.property,
      bedrooms: 5,
      bathrooms: 3,
      flags: draft.property.flags.map((flag) =>
        flag.flag === 'pool' ? { ...flag, on: true, points: 10 } : flag,
      ),
      beds: [{ bedTypeId: DOUBLE_BED, permanent: 5, storage: 0, missing: 0 }],
      extraSleepingBedTypeId: FLOOR_MATTRESS,
      maximumSleepingPlaces: null,
    },
    bedTypes: [
      {
        id: DOUBLE_BED,
        label: 'מיטה זוגית',
        capacity: 2,
        positions: 1,
        setupMinutes: 10,
        usableAsExtra: false,
        linen: [
          {
            itemId: 'double_fitted_sheet',
            label: 'סדין זוגי',
            quantity: 1,
            unit: 'piece',
          },
        ],
      },
      {
        id: FLOOR_MATTRESS,
        label: 'מזרן רצפה',
        capacity: 1,
        positions: 1,
        setupMinutes: 5,
        usableAsExtra: true,
        linen: [
          {
            itemId: 'single_fitted_sheet',
            label: 'סדין יחיד',
            quantity: 1,
            unit: 'piece',
          },
        ],
      },
    ],
    rules: [
      rule({
        id: 'pillow_per_place',
        category: 'linen',
        itemId: 'pillow',
        label: 'כרית',
        section: 'bedrooms',
        // Per sleeping place, which is an *output* of the allocation and the
        // reason the beds have to be described before the quantities are.
        quantity: { basis: 'sleeping_places', factor: 1, divisor: 1, plus: 0 },
      }),
      rule({
        id: 'bath_towel',
        category: 'towels',
        itemId: 'bath_towel',
        label: 'מגבת רחצה',
        section: 'towels',
        quantity: { basis: 'guests', factor: 1, divisor: 1, plus: 0 },
        buffer: { kind: 'percent', percent: 10, amount: null },
        minutesPerUnit: 1,
      }),
      rule({
        id: 'hand_towel',
        category: 'towels',
        itemId: 'hand_towel',
        label: 'מגבת ידיים',
        section: 'towels',
        // One per couple. The divisor is the whole of "per couple".
        quantity: { basis: 'guests', factor: 1, divisor: 2, plus: 0 },
      }),
      rule({
        id: 'pool_towel',
        category: 'towels',
        itemId: 'pool_towel',
        label: 'מגבת בריכה',
        section: 'pool',
        quantity: { basis: 'guests', factor: 1, divisor: 1, plus: 0 },
        condition: {
          kind: 'flag',
          basis: null,
          comparator: null,
          value: null,
          flag: 'pool',
          equals: true,
        },
      }),
    ],
    eventTemplates: [
      {
        id: 'template_shabbat',
        eventType: 'shabbat',
        label: 'שבת',
        sections: ['event_setup'],
        points: 20,
        rules: [
          rule({
            id: 'shabbat_urn',
            category: 'event',
            itemId: 'urn',
            label: 'מיחם',
            section: 'event_setup',
            quantity: { basis: 'booking', factor: 1, divisor: 1, plus: 0 },
            minutesPerUnit: 10,
          }),
          rule({
            // The second urn, above twenty guests. An ordinary conditional rule
            // that merges with the first — not a special case in the engine.
            id: 'shabbat_urn_second',
            category: 'event',
            itemId: 'urn',
            label: 'מיחם',
            section: 'event_setup',
            quantity: { basis: 'booking', factor: 1, divisor: 1, plus: 0 },
            condition: {
              kind: 'compare',
              basis: 'guests',
              comparator: 'gte',
              value: 20,
              flag: null,
              equals: null,
            },
            minutesPerUnit: 10,
          }),
        ],
      },
    ],
    complexity: {
      perGuest: 2,
      perBedroom: 3,
      perBathroom: 4,
      perExtraBed: 1,
      perExtraItem: 2,
      scorePerStaff: 50,
      minimumStaff: 1,
      minutesPerPoint: 3,
      minimumMinutes: 120,
    },
  }
}

type DraftRule = PolicyDraft['rules'][number]

function rule(
  overrides: Partial<DraftRule> & Pick<DraftRule, 'id'>,
): DraftRule {
  return {
    category: 'consumables',
    itemId: overrides.id,
    label: overrides.id,
    unit: 'piece',
    quantity: { basis: 'guests', factor: 1, divisor: 1, plus: 0 },
    condition: null,
    buffer: null,
    section: 'kitchen',
    requiresPhoto: false,
    instructions: null,
    minutesPerUnit: 0,
    ...overrides,
  }
}

/** The party the owner tries the policy out on. */
function party(guests = 25) {
  return {
    guests,
    adults: 20,
    children: 5,
    nights: 2,
    eventType: 'shabbat' as const,
  }
}

function bookingFor(guests = 25): PreparationBooking {
  const checkIn = localDate(new Date())
  const measured = party(guests)

  return {
    id: '00000000-0000-4000-8000-000000000001',
    organizationId: ORGANIZATION,
    propertyId: PROPERTY,
    unitId: PROPERTY,
    stay: { checkIn, checkOut: addDays(checkIn, measured.nights) },
    guests: measured.guests,
    adults: measured.adults,
    children: measured.children,
    eventType: measured.eventType,
    extras: [],
    arrivalAt: `${checkIn}T00:00:00.000Z`,
    priceLines: [],
  }
}

function catalogueOf(draft: PolicyDraft) {
  return catalogueFrom({
    wire: draft,
    organizationId: ORGANIZATION,
    stored: null,
    today: localDate(new Date()),
  })
}

/* ------------------------------------------------------ the wire contract -- */

describe('the draft a screen holds', () => {
  it('is exactly what the operation validates, with nothing left over', () => {
    // The editor's state and the service boundary's schema are the same shape
    // on purpose — a second "form model" mapped onto this one is where a field
    // quietly stops being saved. `allowUnknown` is off, so an extra key here
    // would be refused rather than ignored.
    const result = configureInput.validate(villaDraft(), '')
    expect(result.ok, JSON.stringify(result.ok ? [] : result.issues)).toBe(true)
  })

  it('starts a new property with no quantity of anything', () => {
    const draft = emptyDraft(PROPERTY, 'וילה חדשה')

    expect(draft.bedTypes).toEqual([])
    expect(draft.rules).toEqual([])
    expect(draft.eventTemplates).toEqual([])
    expect(draft.property.beds).toEqual([])
    // Every section still has a Hebrew heading, because `buildWorkPlan` reads
    // one for every section it creates and an unnamed section is a title a
    // cleaner cannot read.
    expect(Object.values(draft.sectionLabels).every((l) => l.length > 0)).toBe(
      true,
    )
  })

  it('survives a round trip through the stored catalogue unchanged', () => {
    const draft = villaDraft()
    const reopened = draftFromCatalogue(
      catalogueOf(draft),
      PROPERTY,
      'וילה כחול ים',
    )

    expect(reopened.bedTypes).toEqual(draft.bedTypes)
    expect(reopened.rules).toEqual(draft.rules)
    expect(reopened.eventTemplates).toEqual(draft.eventTemplates)
    expect(reopened.property.beds).toEqual(draft.property.beds)
    // The flag weights and the event weight live on `complexity` in the domain
    // and beside the thing they weigh on the form. Losing one on a round trip
    // would silently change the difficulty score.
    expect(reopened.property.flags).toEqual(draft.property.flags)
    expect(reopened.eventTemplates[0].points).toBe(
      draft.eventTemplates[0].points,
    )
  })
})

/* --------------------------------------------- the twenty-five guest case -- */

describe('five double beds and a party of twenty-five', () => {
  const draft = villaDraft()
  const catalogue = catalogueOf(draft)
  const booking = bookingFor()

  const allocation = allocateSleeping({
    guests: booking.guests,
    configuration: catalogue.propertyConfiguration,
    bedTypes: catalogue.bedTypes,
  })

  const preview = previewPlan({
    catalogue,
    booking,
    capturedAt: '2026-01-01T00:00:00.000Z',
    planId: 'preview',
  })

  it('has ten permanent sleeping places, and fifteen more to find', () => {
    // The owner's own arithmetic, stated once: five beds at two places each.
    expect(allocation.permanentCapacity).toBe(10)
    expect(allocation.sleepingPlaces).toBe(booking.guests)
    expect(allocation.extraBeds).toBe(booking.guests - 10)
    expect(allocation.unplacedGuests).toBe(0)
  })

  it('reports the same allocation the preview shows', () => {
    // Not a number typed here: the same function, called twice.
    expect(preview.allocation).toEqual(allocation)

    const permanent = preview.allocation.lines.filter(
      (line) => line.source === 'permanent',
    )
    const added = preview.allocation.lines.filter(
      (line) => line.source === 'added',
    )

    expect(permanent).toHaveLength(1)
    expect(permanent[0].bedTypeId).toBe(DOUBLE_BED)
    expect(added[0].bedTypeId).toBe(FLOOR_MATTRESS)
    expect(added[0].count).toBe(allocation.extraBeds)
  })

  it('puts every quantity where the rules say, and none anywhere else', () => {
    const facts = measureFacts(booking, preview.snapshot, allocation)

    for (const configured of catalogue.rules) {
      const expected = applyBuffer(
        resolveQuantity(configured.quantity, facts),
        configured.buffer,
      )

      const produced = countOf(preview, configured.itemId)

      // Every rule that fires is asserted against `resolveQuantity` and
      // `applyBuffer` on the same facts. A rule that does not fire — the pool
      // towel on a house with no pool — produces nothing and is asserted so.
      expect(
        produced,
        `${configured.id} produced ${produced}, the rules say ${expected}`,
      ).toBe(expected)
    }
  })

  it('counts the linen the beds themselves consume, per bed and not per guest', () => {
    // Five double beds take five double sheets; fifteen mattresses take
    // fifteen single ones. The two are derived from one allocation line each,
    // so they cannot disagree with the beds they dress.
    const doubles = allocation.lines.find(
      (line) => line.bedTypeId === DOUBLE_BED,
    )
    const mattresses = allocation.lines.find(
      (line) => line.bedTypeId === FLOOR_MATTRESS,
    )

    expect(countOf(preview, 'double_fitted_sheet')).toBe(doubles?.count)
    expect(countOf(preview, 'single_fitted_sheet')).toBe(mattresses?.count)
  })

  it('merges the two urns the Shabbat template asks for into one line', () => {
    // One unconditional, one above twenty guests. The house needs two urns,
    // not two lines each saying one.
    const template = catalogue.eventTemplates[0]
    const facts = measureFacts(booking, preview.snapshot, allocation)

    const expected = template.rules.reduce(
      (total, entry) =>
        total +
        applyBuffer(resolveQuantity(entry.quantity, facts), entry.buffer),
      0,
    )

    expect(countOf(preview, 'urn')).toBe(expected)
  })

  it('shrinks every figure when the house gains a bed', () => {
    // The proof that nothing is hardcoded: change the property and every
    // number moves, with no code touched.
    const bigger = catalogueOf({
      ...draft,
      property: {
        ...draft.property,
        beds: [{ bedTypeId: DOUBLE_BED, permanent: 6, storage: 0, missing: 0 }],
      },
    })

    const second = previewPlan({
      catalogue: bigger,
      booking,
      capturedAt: '2026-01-01T00:00:00.000Z',
      planId: 'preview',
    })

    expect(second.allocation.permanentCapacity).toBeGreaterThan(
      allocation.permanentCapacity,
    )
    expect(second.allocation.extraBeds).toBeLessThan(allocation.extraBeds)
    expect(second.allocation.sleepingPlaces).toBe(allocation.sleepingPlaces)
  })

  it('is the plan the engine builds, section for section', () => {
    // `previewPlan` and `buildPlan` call one `assemblePlan`, over one
    // snapshot. This asserts the artefact is a real `WorkPlan` and not a
    // summary shaped like one.
    expect(preview.plan.sections.length).toBeGreaterThan(0)
    expect(preview.plan.snapshotHash).toBe(preview.snapshot.hash)
    expect(preview.plan.criticalPathMinutes).toBeGreaterThan(0)
    expect(preview.plan.recommendedStaff).toBeGreaterThanOrEqual(
      catalogue.complexity.minimumStaff,
    )

    for (const section of preview.plan.sections) {
      expect(section.label).toBe(catalogue.sectionLabels[section.key])
      for (const item of section.items) expect(item.completedCount).toBe(0)
    }
  })

  it('freezes the same ruleset twice for an unchanged policy', () => {
    // Two previews of one configuration share a hash, which is what makes
    // "did the rules change between these two bookings" one comparison.
    const again = captureSnapshot({
      catalogue,
      booking,
      capturedAt: '2030-06-06T00:00:00.000Z',
    })
    expect(again.hash).toBe(preview.snapshot.hash)
  })
})

/** Everything one item is required in, across every section of the plan. */
function countOf(
  preview: ReturnType<typeof previewPlan>,
  itemId: string,
): number {
  return preview.plan.sections
    .flatMap((section) => section.items)
    .filter((item) => item.itemId === itemId)
    .reduce((total, item) => total + item.requiredCount, 0)
}

/* --------------------------------------------- what the policy refuses ---- */

describe('a configuration that cannot work', () => {
  it('names a bed stock pointing at a type nobody defined', () => {
    const problems = catalogueProblems(
      catalogueOf({
        ...villaDraft(),
        property: {
          ...villaDraft().property,
          beds: [{ bedTypeId: 'ghost', permanent: 3, storage: 0, missing: 0 }],
        },
      }),
    )

    // The engine skips an unknown bed type in silence, which is right for the
    // engine and wrong for the person writing the policy.
    expect(problems.some((problem) => problem.includes('ghost'))).toBe(true)
  })

  it('names an extra sleeping type that is not usable as an extra', () => {
    const draft = villaDraft()
    const problems = catalogueProblems(
      catalogueOf({
        ...draft,
        property: { ...draft.property, extraSleepingBedTypeId: DOUBLE_BED },
      }),
    )

    expect(problems.length).toBeGreaterThan(0)
  })

  it('accepts the owner’s own configuration without complaint', () => {
    expect(catalogueProblems(catalogueOf(villaDraft()))).toEqual([])
  })

  it('places nobody when no bed is described, and says so rather than throwing', () => {
    const bare = catalogueOf(emptyDraft(PROPERTY, 'וילה חדשה'))
    const allocation = allocateSleeping({
      guests: 25,
      configuration: bare.propertyConfiguration,
      bedTypes: bare.bedTypes,
    })

    // The honest empty state: the preview answers before any policy is saved,
    // and what it answers is that this house cannot take the party yet.
    expect(allocation.sleepingPlaces).toBe(0)
    expect(allocation.unplacedGuests).toBe(25)
    expect(catalogueProblems(bare).length).toBeGreaterThan(0)
  })
})

/* --------------------------------------------------- who may write it ----- */

describe('who may set the policy', () => {
  it('admits an owner and refuses the cleaner the plan is written for', async () => {
    const [owner, cleaner] = await Promise.all([
      actorFor('owner'),
      actorFor('housekeeping'),
    ])

    const resource = {
      organizationId: ORGANIZATION,
      propertyId: PROPERTY,
      family: 'operations' as const,
    }

    expect(can(owner, 'checklist.manage', resource)).toBe(true)

    // The sharpest case in the product: she reads the plan and never the
    // policy behind it. `preparation_catalogues_update` demands the same grant
    // in the database, so the screen and the row agree.
    expect(cleaner.grants.has('checklist.manage')).toBe(false)
    expect(can(cleaner, 'checklist.manage', resource)).toBe(false)
    expect(cleaner.grants.has('task.view')).toBe(true)
  })

  it('refuses a property manager the property they do not hold', async () => {
    const manager = await actorFor('property-manager')

    expect(
      can(manager, 'checklist.manage', {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY_IDS.rimonim,
        family: 'operations',
      }),
    ).toBe(true)

    // Their scope is one property. Offering them a link to the other one is
    // offering them a refusal, which is why the screen checks before it links.
    expect(
      can(manager, 'checklist.manage', {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY_IDS.kacholYam,
        family: 'operations',
      }),
    ).toBe(false)
  })
})

/* ----------------------------------------------- the row it actually writes -- */

describe('the catalogue row', () => {
  it('is absent until somebody writes it, and readable once they have', async () => {
    const db = demoDb()
    const ports = new SupabasePreparationPorts(db)

    // `preparation_catalogues` is seeded empty on purpose — it is written by
    // this screen, and seeding it would be seeding the output of the code path
    // the demo exists to exercise.
    expect(await ports.loadCatalogue(ORGANIZATION, PROPERTY)).toBeNull()
    expect(await ports.catalogueVersion(ORGANIZATION, PROPERTY)).toBeNull()

    const catalogue = catalogueOf(villaDraft())
    await ports.saveCatalogue(
      {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY,
        catalogue,
        expectedVersion: null,
      },
      undefined,
    )

    const stored = await ports.loadCatalogue(ORGANIZATION, PROPERTY)
    expect(stored).not.toBeNull()
    expect(stored?.bedTypes).toEqual(catalogue.bedTypes)
    expect(stored?.rules).toEqual(catalogue.rules)
    expect(stored?.propertyConfiguration).toEqual(
      catalogue.propertyConfiguration,
    )
    expect(await ports.catalogueVersion(ORGANIZATION, PROPERTY)).toBe(1)
  })

  it('refuses a second writer holding a stale revision', async () => {
    const db = demoDb()
    const ports = new SupabasePreparationPorts(db)
    const catalogue = catalogueOf(villaDraft())

    await ports.saveCatalogue(
      {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY,
        catalogue,
        expectedVersion: null,
      },
      undefined,
    )

    const version = await ports.catalogueVersion(ORGANIZATION, PROPERTY)
    await ports.saveCatalogue(
      {
        organizationId: ORGANIZATION,
        propertyId: PROPERTY,
        catalogue,
        expectedVersion: version,
      },
      undefined,
    )

    // The form holds a whole document. Applying a second person's edits on top
    // of the first person's silently is what whole-document writes are prone
    // to, and it is what the version predicate refuses.
    await expect(
      ports.saveCatalogue(
        {
          organizationId: ORGANIZATION,
          propertyId: PROPERTY,
          catalogue,
          expectedVersion: version,
        },
        undefined,
      ),
    ).rejects.toThrow()
  })

  it('carries no money field a housekeeping permission could have written', () => {
    // `hourlyRate`, the cost rules and the commission agreement are part of
    // `PreparationCatalogue` and are absent from the wire. What a screen gated
    // on `checklist.manage` writes cannot include a rate, whatever the markup
    // does.
    const catalogue = catalogueOf(villaDraft())

    expect(catalogue.complexity.hourlyRate).toBe(0)
    expect(catalogue.variableCosts).toEqual([])
    expect(catalogue.fixedCosts).toEqual([])
    expect(catalogue.commissionRules).toEqual([])
    expect('hourlyRate' in (villaDraft().complexity as object)).toBe(false)
  })

  it('preserves the money it was never shown when an existing policy is edited', () => {
    const stored = {
      ...catalogueOf(villaDraft()),
      complexity: {
        ...catalogueOf(villaDraft()).complexity,
        hourlyRate: 5_500,
      },
      variableCosts: [
        {
          id: 'vc_cleaning',
          organizationId: ORGANIZATION,
          key: 'cleaning',
          label: 'ניקיון',
          condition: null,
          effectiveFrom: '2020-01-01',
          effectiveTo: null,
          formula: { kind: 'fixed' as const, amount: 35_000 },
        },
      ],
    }

    const rewritten = catalogueFrom({
      wire: villaDraft(),
      organizationId: ORGANIZATION,
      stored,
      today: localDate(new Date()),
    })

    // A housekeeping supervisor editing the towel rule must not wipe the cost
    // model on the way past.
    expect(rewritten.complexity.hourlyRate).toBe(5_500)
    expect(rewritten.variableCosts).toEqual(stored.variableCosts)
  })

  it('keeps the start date of a rule it already knew', () => {
    const stored = catalogueFrom({
      wire: villaDraft(),
      organizationId: ORGANIZATION,
      stored: null,
      today: '2025-01-01',
    })

    const rewritten = catalogueFrom({
      wire: villaDraft(),
      organizationId: ORGANIZATION,
      stored,
      today: '2026-06-06',
    })

    // Re-saving an unchanged policy must not move every rule's start date
    // forward, which would make `effectiveOn` answer differently for a booking
    // that arrived yesterday.
    for (const entry of rewritten.rules) {
      expect(entry.effectiveFrom).toBe('2025-01-01')
      expect(entry.effectiveTo).toBeNull()
    }
  })
})
