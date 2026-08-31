/**
 * Writing the configuration down.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 *
 * `PreparationCatalogue` is the record every quantity in this domain is
 * computed from — bed types and their capacity, the rules that turn a party
 * into towels and pillows, the event templates. `operations.ts` reads it once,
 * in `buildPlan`, and freezes it. Nothing anywhere wrote it. The engine's own
 * guard test proves it never invents a quantity, which means an organization
 * with no catalogue gets an empty plan and no way to fix that from inside the
 * product.
 *
 * So this is the write side, and it is deliberately a *separate* port list and
 * a separate factory from `PreparationPorts`. That is not tidiness. The header
 * of `operations.ts` makes a structural argument — there is no
 * `loadCatalogue(bookingId)`, so every path except a brand-new plan is forced
 * through the stored snapshot — and folding a catalogue *writer* into the same
 * port list would put the live configuration within reach of the operations
 * that must never see it.
 *
 * ── Why the input is the whole catalogue and not a patch ──────────────────
 *
 * A rule set is read as a whole and has to be written as one: a patch language
 * over an array of rules needs identity, ordering and deletion semantics, and
 * every one of those is a chance for a rule to survive an edit that meant to
 * remove it. The version check is what makes whole-document writes safe —
 * two people editing the same property's policy is a conflict the second one
 * is told about, not a silent overwrite.
 *
 * ── What the wire does not carry ──────────────────────────────────────────
 *
 * **Money.** `hourlyRate`, the variable and fixed cost rules and the
 * commission agreement are all part of `PreparationCatalogue` and none of them
 * appears in `ConfigureInput`. They are preserved from the stored row instead.
 * The permission that opens this operation is `checklist.manage`, which a
 * housekeeping supervisor holds and which says nothing about money — so a
 * screen gated on it must not be able to write a rate, however carefully the
 * screen itself is built.
 *
 * **Effective dates.** A rule that is new to the catalogue starts on the day
 * it is saved; a rule whose id is already stored keeps the date it already
 * had. Nobody types an effective date, because the thing effective dating
 * protects — a booking recomputing itself against next month's rules — is
 * already protected by the snapshot, and a date field on a settings form is a
 * date somebody eventually types wrong.
 */

import { BusinessRuleError } from '../errors'
import {
  defineOperation,
  s,
  type Infer,
  type Operation,
  type TransactionHandle,
} from '../service'
import type { Resource } from '../authz/can'
import {
  CONDITION_COMPARATORS,
  EVENT_TYPES,
  FACT_BASES,
  PLAN_SECTIONS,
  REQUIREMENT_CATEGORIES,
  REQUIREMENT_UNITS,
  type BedType,
  type ComplexityConfiguration,
  type EventTemplate,
  type EventType,
  type PlanSectionKey,
  type PreparationCatalogue,
  type PreparationRule,
  type PropertyConfiguration,
  type PropertyFlags,
  type QuantityExpression,
  type RequirementBuffer,
  type RuleCondition,
} from './types'

// ── Ports ─────────────────────────────────────────────────────────────────

/**
 * What writing a catalogue needs, and nothing else.
 *
 * `catalogueVersion` is separate from `loadCatalogue` because the domain value
 * has no version field and should not grow one: the version is a fact about
 * the row, the catalogue is a fact about the business, and putting the row's
 * bookkeeping inside the frozen snapshot would change the snapshot's hash
 * every time somebody re-saved an unchanged policy.
 */
export interface PreparationCataloguePorts {
  loadCatalogue(
    organizationId: string,
    propertyId: string,
  ): Promise<PreparationCatalogue | null>
  /** `null` when the property has no catalogue row yet. */
  catalogueVersion(
    organizationId: string,
    propertyId: string,
  ): Promise<number | null>
  saveCatalogue(
    input: {
      organizationId: string
      propertyId: string
      catalogue: PreparationCatalogue
      /** `null` to insert. A number to update that revision and no other. */
      expectedVersion: number | null
    },
    tx: TransactionHandle,
  ): Promise<void>
}

// ── The wire shape ────────────────────────────────────────────────────────

const identifier = s.string({ label: 'מזהה', min: 1 })
const shownName = s.string({ label: 'שם', min: 1 })
const count = s.number({ label: 'כמות', min: 0, integer: true })
const weight = s.number({ label: 'משקל', min: 0 })

/**
 * A condition, flattened.
 *
 * `RuleCondition` is a recursive union — `all`, `any`, `not` nest arbitrarily —
 * and this schema admits only the two leaves a person can be asked to fill in
 * on a form: a comparison against a measured quantity, and a property flag.
 * The nesting stays in the type because the engine supports it and an import
 * may one day carry it; what a settings screen accepts is narrower on purpose,
 * because a rule builder with parentheses in it stops being editable by the
 * person who runs the house.
 */
const conditionInput = s.nullable(
  s.object({
    kind: s.enumOf(['compare', 'flag'] as const, { label: 'סוג תנאי' }),
    basis: s.nullable(s.enumOf(FACT_BASES, { label: 'בסיס' })),
    comparator: s.nullable(
      s.enumOf(CONDITION_COMPARATORS, { label: 'השוואה' }),
    ),
    value: s.nullable(s.number({ label: 'ערך' })),
    flag: s.nullable(s.string({ label: 'מאפיין' })),
    equals: s.nullable(s.boolean({ label: 'מתקיים' })),
  }),
)

type ConditionInput = NonNullable<Infer<typeof conditionInput>>

const bufferInput = s.nullable(
  s.object({
    kind: s.enumOf(['percent', 'flat'] as const, { label: 'סוג מרווח' }),
    percent: s.nullable(s.number({ label: 'אחוז', min: 0 })),
    amount: s.nullable(s.number({ label: 'תוספת', min: 0 })),
  }),
)

const ruleInput = s.object({
  id: identifier,
  category: s.enumOf(REQUIREMENT_CATEGORIES, { label: 'קטגוריה' }),
  itemId: identifier,
  label: shownName,
  unit: s.enumOf(REQUIREMENT_UNITS, { label: 'יחידת מידה' }),
  quantity: s.object({
    basis: s.enumOf(FACT_BASES, { label: 'לפי' }),
    factor: s.number({ label: 'מכפיל', min: 0 }),
    divisor: s.number({ label: 'מחלק', min: 0 }),
    plus: s.number({ label: 'תוספת קבועה' }),
  }),
  condition: conditionInput,
  buffer: bufferInput,
  section: s.enumOf(PLAN_SECTIONS, { label: 'מקטע' }),
  requiresPhoto: s.boolean({ label: 'דורש צילום' }),
  instructions: s.nullable(s.string({ label: 'הנחיה' })),
  minutesPerUnit: s.number({ label: 'דקות ליחידה', min: 0 }),
})

const bedTypeInput = s.object({
  id: identifier,
  label: shownName,
  capacity: count,
  positions: count,
  setupMinutes: count,
  usableAsExtra: s.boolean({ label: 'שימושי כתוספת' }),
  linen: s.arrayOf(
    s.object({
      itemId: identifier,
      label: shownName,
      quantity: count,
      unit: s.enumOf(REQUIREMENT_UNITS, { label: 'יחידת מידה' }),
    }),
    { label: 'מצעים' },
  ),
})

const sectionLabelsInput = s.object({
  cleaning: shownName,
  bedrooms: shownName,
  extra_sleeping: shownName,
  bathrooms: shownName,
  towels: shownName,
  kitchen: shownName,
  event_setup: shownName,
  outdoor: shownName,
  pool: shownName,
  final_inspection: shownName,
})

export const configureInput = s.object({
  propertyId: s.uuid({ label: 'נכס' }),

  property: s.object({
    label: shownName,
    bedrooms: count,
    bathrooms: count,
    /**
     * A record on the domain side, a list on the wire. `PropertyFlags` is an
     * open string map so a customer can write rules against a fact ESTIA has
     * never heard of, and a schema language with no record type would
     * otherwise force that map closed.
     */
    flags: s.arrayOf(
      s.object({
        flag: identifier,
        on: s.boolean({ label: 'קיים' }),
        /** Points this flag adds to the difficulty score. */
        points: weight,
      }),
      { label: 'מאפייני הנכס' },
    ),
    beds: s.arrayOf(
      s.object({
        bedTypeId: identifier,
        permanent: count,
        storage: count,
        missing: count,
      }),
      { label: 'מלאי המיטות' },
    ),
    extraSleepingBedTypeId: identifier,
    maximumSleepingPlaces: s.nullable(
      s.number({ label: 'תקרת מקומות שינה', min: 0, integer: true }),
    ),
  }),

  bedTypes: s.arrayOf(bedTypeInput, { label: 'סוגי מיטות' }),
  rules: s.arrayOf(ruleInput, { label: 'כללי כמות' }),

  eventTemplates: s.arrayOf(
    s.object({
      id: identifier,
      eventType: s.enumOf(EVENT_TYPES, { label: 'סוג אירוע' }),
      label: shownName,
      sections: s.arrayOf(s.enumOf(PLAN_SECTIONS, { label: 'מקטע' })),
      rules: s.arrayOf(ruleInput, { label: 'כללי התבנית' }),
      /** Points this event type adds to the difficulty score. */
      points: weight,
    }),
    { label: 'תבניות אירוע' },
  ),

  /**
   * The crew and the clock. Money is absent on purpose — see the header.
   */
  complexity: s.object({
    perGuest: weight,
    perBedroom: weight,
    perBathroom: weight,
    perExtraBed: weight,
    perExtraItem: weight,
    scorePerStaff: weight,
    minimumStaff: count,
    minutesPerPoint: weight,
    minimumMinutes: count,
  }),

  readinessPolicy: s.object({
    criticalPercent: s.number({ label: 'אחוז קריטי', min: 0, max: 100 }),
    criticalHours: s.number({ label: 'שעות לפני הגעה', min: 0 }),
    warningPercent: s.number({ label: 'אחוז אזהרה', min: 0, max: 100 }),
  }),

  sectionLabels: sectionLabelsInput,
})

export type ConfigureInput = Infer<typeof configureInput>

/** What the caller gets back. Counts, so the screen can say what it wrote. */
export interface ConfigureResult {
  propertyId: string
  /** True when this property had no catalogue at all until now. */
  created: boolean
  bedTypes: number
  rules: number
  eventTemplates: number
  version: number
}

interface CatalogueEntity {
  /** `null` for a property nobody has configured yet. An ordinary state. */
  catalogue: PreparationCatalogue | null
}

// ── Mapping the wire onto the domain ──────────────────────────────────────

function flagsOf(
  flags: readonly { flag: string; on: boolean; points: number }[],
): PropertyFlags {
  const record: Record<string, boolean> = {}
  for (const entry of flags) record[entry.flag] = entry.on
  return record
}

function flagWeightsOf(
  flags: readonly { flag: string; on: boolean; points: number }[],
): Readonly<Record<string, number>> {
  const record: Record<string, number> = {}
  for (const entry of flags) record[entry.flag] = entry.points
  return record
}

function conditionOf(input: ConditionInput | null): RuleCondition | null {
  if (input === null) return null

  if (input.kind === 'flag') {
    if (input.flag === null) return null
    return { kind: 'flag', flag: input.flag, equals: input.equals ?? true }
  }

  if (input.basis === null || input.comparator === null || input.value === null)
    return null

  return {
    kind: 'compare',
    basis: input.basis,
    comparator: input.comparator,
    value: input.value,
  }
}

function bufferOf(input: Infer<typeof bufferInput>): RequirementBuffer | null {
  if (input === null) return null
  if (input.kind === 'percent') {
    return input.percent === null
      ? null
      : { kind: 'percent', percent: input.percent }
  }
  return input.amount === null ? null : { kind: 'flat', amount: input.amount }
}

function quantityOf(input: {
  basis: QuantityExpression['basis']
  factor: number
  divisor: number
  plus: number
}): QuantityExpression {
  return {
    basis: input.basis,
    factor: input.factor,
    divisor: input.divisor,
    plus: input.plus,
  }
}

type WireRule = ConfigureInput['rules'][number]

/**
 * One rule, dated.
 *
 * `effectiveFrom` is the stored date for a rule the catalogue already knows by
 * id, and today's date for one it does not. That keeps a re-save of an
 * unchanged policy from moving every rule's start date forward, which would
 * make `effectiveOn` answer differently for a booking arriving yesterday.
 */
function ruleOf(
  input: WireRule,
  organizationId: string,
  today: string,
  stored: ReadonlyMap<string, PreparationRule>,
): PreparationRule {
  const previous = stored.get(input.id)

  return {
    id: input.id,
    organizationId,
    category: input.category,
    itemId: input.itemId,
    label: input.label,
    unit: input.unit,
    quantity: quantityOf(input.quantity),
    condition: conditionOf(input.condition),
    buffer: bufferOf(input.buffer),
    section: input.section,
    requiresPhoto: input.requiresPhoto,
    instructions: input.instructions,
    minutesPerUnit: input.minutesPerUnit,
    effectiveFrom: previous?.effectiveFrom ?? today,
    effectiveTo: null,
  }
}

function storedRules(
  catalogue: PreparationCatalogue | null,
): ReadonlyMap<string, PreparationRule> {
  const index = new Map<string, PreparationRule>()
  if (!catalogue) return index

  for (const rule of catalogue.rules) index.set(rule.id, rule)
  for (const template of catalogue.eventTemplates) {
    for (const rule of template.rules) index.set(rule.id, rule)
  }
  return index
}

/**
 * The catalogue this save produces.
 *
 * Everything the wire carries is replaced; everything it does not carry is
 * taken from the stored row. The second half is the load-bearing one: an
 * organization's cost model and commission agreement survive a housekeeping
 * supervisor editing the towel rule, because they were never in the request
 * to begin with.
 */
export function catalogueFrom(input: {
  wire: ConfigureInput
  organizationId: string
  stored: PreparationCatalogue | null
  today: string
}): PreparationCatalogue {
  const { wire, organizationId, stored, today } = input
  const previous = storedRules(stored)

  const bedTypes: readonly BedType[] = wire.bedTypes.map((type) => ({
    id: type.id,
    label: type.label,
    capacity: type.capacity,
    positions: type.positions,
    setupMinutes: type.setupMinutes,
    usableAsExtra: type.usableAsExtra,
    linen: type.linen.map((item) => ({
      itemId: item.itemId,
      label: item.label,
      quantity: item.quantity,
      unit: item.unit,
    })),
  }))

  const propertyConfiguration: PropertyConfiguration = {
    organizationId,
    propertyId: wire.propertyId,
    // A catalogue is per property, and `PropertyConfiguration.unitId` names a
    // single unit. Nothing on this screen chooses one, so it stays null rather
    // than being guessed from whichever unit happened to be first.
    unitId: stored?.propertyConfiguration.unitId ?? null,
    label: wire.property.label,
    bedrooms: wire.property.bedrooms,
    bathrooms: wire.property.bathrooms,
    flags: flagsOf(wire.property.flags),
    beds: wire.property.beds.map((stock) => ({
      bedTypeId: stock.bedTypeId,
      permanent: stock.permanent,
      storage: stock.storage,
      missing: stock.missing,
    })),
    extraSleepingBedTypeId: wire.property.extraSleepingBedTypeId,
    maximumSleepingPlaces: wire.property.maximumSleepingPlaces,
  }

  const eventTemplates: readonly EventTemplate[] = wire.eventTemplates.map(
    (template) => ({
      id: template.id,
      organizationId,
      eventType: template.eventType,
      label: template.label,
      sections: [...template.sections] as readonly PlanSectionKey[],
      rules: template.rules.map((rule) =>
        ruleOf(rule, organizationId, today, previous),
      ),
    }),
  )

  const perEventType: Partial<Record<EventType, number>> = {}
  for (const template of wire.eventTemplates) {
    perEventType[template.eventType] = template.points
  }

  const complexity: ComplexityConfiguration = {
    perGuest: wire.complexity.perGuest,
    perBedroom: wire.complexity.perBedroom,
    perBathroom: wire.complexity.perBathroom,
    perExtraBed: wire.complexity.perExtraBed,
    perExtraItem: wire.complexity.perExtraItem,
    perEventType,
    perFlag: flagWeightsOf(wire.property.flags),
    scorePerStaff: wire.complexity.scorePerStaff,
    minimumStaff: wire.complexity.minimumStaff,
    minutesPerPoint: wire.complexity.minutesPerPoint,
    minimumMinutes: wire.complexity.minimumMinutes,
    // Never on the wire. The rate a business pays its cleaners is a finance
    // fact, and `checklist.manage` is not a finance permission.
    hourlyRate: stored?.complexity.hourlyRate ?? 0,
  }

  return {
    organizationId,
    bedTypes,
    rules: wire.rules.map((rule) =>
      ruleOf(rule, organizationId, today, previous),
    ),
    eventTemplates,
    propertyConfiguration,
    variableCosts: stored?.variableCosts ?? [],
    fixedCosts: stored?.fixedCosts ?? [],
    commissionRules: stored?.commissionRules ?? [],
    complexity,
    readinessPolicy: {
      criticalPercent: wire.readinessPolicy.criticalPercent,
      criticalHours: wire.readinessPolicy.criticalHours,
      warningPercent: wire.readinessPolicy.warningPercent,
    },
    sectionLabels: wire.sectionLabels,
  }
}

// ── The domain law ────────────────────────────────────────────────────────

/**
 * What a catalogue must satisfy before it is worth storing.
 *
 * Every one of these is a rule the engine reads silently and cannot report on
 * its own: a bed stock pointing at a bed type nobody defined contributes
 * nothing to the allocation and disappears without a word, and an extra
 * sleeping type that is not `usableAsExtra` leaves a shortfall unplaced.
 * Refusing here is the difference between a policy that is wrong and a policy
 * that is quietly incomplete.
 *
 * Exported because the screen runs the same checks before it offers to save —
 * one list of rules, asked twice, rather than two lists that disagree.
 */
export function catalogueProblems(
  catalogue: PreparationCatalogue,
): readonly string[] {
  const problems: string[] = []
  const types = new Map(catalogue.bedTypes.map((type) => [type.id, type]))

  if (catalogue.bedTypes.length === 0) {
    problems.push('לא הוגדר אף סוג מיטה, ולכן אי אפשר לשבץ אף אורח.')
  }

  const seen = new Set<string>()
  for (const type of catalogue.bedTypes) {
    if (seen.has(type.id)) {
      problems.push(`סוג המיטה "${type.label}" מוגדר יותר מפעם אחת.`)
    }
    seen.add(type.id)

    if (type.capacity <= 0) {
      problems.push(`ל"${type.label}" אין אף מקום שינה, ולכן היא לא תשבץ איש.`)
    }
  }

  for (const stock of catalogue.propertyConfiguration.beds) {
    if (!types.has(stock.bedTypeId)) {
      problems.push(
        `במלאי המיטות מופיע סוג "${stock.bedTypeId}" שאינו מוגדר, והוא ייעלם מהחישוב בלי הודעה.`,
      )
    }
  }

  const extra = types.get(
    catalogue.propertyConfiguration.extraSleepingBedTypeId,
  )
  if (!extra) {
    problems.push(
      'לא נבחר סוג המיטה שמובא כשנגמרים המקומות, ולכן מסיבה גדולה תישאר בלי פתרון.',
    )
  } else if (!extra.usableAsExtra || extra.capacity <= 0) {
    problems.push(
      `"${extra.label}" נבחרה כתוספת אך אינה מסומנת כשימושית כתוספת, ולכן לא תובא בפועל.`,
    )
  }

  const ruleIds = new Set<string>()
  const allRules = [
    ...catalogue.rules,
    ...catalogue.eventTemplates.flatMap((template) => template.rules),
  ]
  for (const rule of allRules) {
    if (ruleIds.has(rule.id)) {
      problems.push(`מזהה הכלל "${rule.id}" מופיע יותר מפעם אחת.`)
    }
    ruleIds.add(rule.id)
  }

  return problems
}

// ── The operation ─────────────────────────────────────────────────────────

export interface CatalogueOperations {
  configureProperty: Operation<ConfigureInput, CatalogueEntity, ConfigureResult>
}

export function createCatalogueOperations(
  ports: PreparationCataloguePorts,
): CatalogueOperations {
  const configureProperty = defineOperation<
    ConfigureInput,
    CatalogueEntity,
    ConfigureResult
  >({
    name: 'preparation.catalogue.configure',
    permission: 'checklist.manage',
    resourceType: 'preparation_catalogue',
    input: configureInput,

    /**
     * Loads whether or not there is a catalogue.
     *
     * A `null` return would make the pipeline raise `NotFoundError`, and a
     * property nobody has configured yet is not missing — it is the state
     * every property starts in. So the resource is the *property*, the entity
     * carries a nullable catalogue, and `version` is `undefined` on the first
     * save so that no `expectedVersion` can match and the caller does not have
     * to guess one.
     */
    loadResource: async ({ input, context }) => {
      const organizationId = context.actor.organizationId
      const [catalogue, version] = await Promise.all([
        ports.loadCatalogue(organizationId, input.propertyId),
        ports.catalogueVersion(organizationId, input.propertyId),
      ])

      const resource: Resource = {
        organizationId,
        propertyId: input.propertyId,
        family: 'operations',
      }

      return {
        resource,
        entity: { catalogue },
        version: version ?? undefined,
      }
    },

    rule: ({ input, context, now }) => {
      const problems = catalogueProblems(
        catalogueFrom({
          wire: input,
          organizationId: context.actor.organizationId,
          // Validation reads bed types, stock and rule ids and never a date,
          // so the stored catalogue is deliberately not consulted here: the
          // question is whether what arrived is coherent on its own.
          stored: null,
          today: isoDateOf(now),
        }),
      )

      if (problems.length > 0) {
        throw new BusinessRuleError({
          code: 'preparation_catalogue_incomplete',
          message: `The submitted catalogue has ${problems.length} problem(s): ${problems.join(' ')}`,
          userMessage: problems[0],
          publicDetails: { problems },
        })
      }
    },

    execute: async ({ input, entity, context, version, now, tx }) => {
      const organizationId = context.actor.organizationId

      const catalogue = catalogueFrom({
        wire: input,
        organizationId,
        stored: entity.catalogue,
        today: isoDateOf(now),
      })

      // The version the pipeline already read and already compared against the
      // caller's `expectedVersion`. Reading it a second time here would open
      // exactly the window optimistic locking exists to close.
      await ports.saveCatalogue(
        {
          organizationId,
          propertyId: input.propertyId,
          catalogue,
          expectedVersion: version,
        },
        tx,
      )

      return {
        propertyId: input.propertyId,
        created: entity.catalogue === null,
        bedTypes: catalogue.bedTypes.length,
        rules: catalogue.rules.length,
        eventTemplates: catalogue.eventTemplates.length,
        version: (version ?? 0) + 1,
      }
    },

    audit: ({ result, input, entity }) => ({
      resourceId: result.propertyId,
      propertyId: result.propertyId,
      summary: result.created
        ? `נקבעה מדיניות הכנה ל״${input.property.label}״: ${result.bedTypes} סוגי מיטות, ${result.rules} כללי כמות, ${result.eventTemplates} תבניות אירוע`
        : `עודכנה מדיניות ההכנה של ״${input.property.label}״: ${result.bedTypes} סוגי מיטות (${entity.catalogue?.bedTypes.length ?? 0} קודם), ${result.rules} כללי כמות (${entity.catalogue?.rules.length ?? 0} קודם), ${result.eventTemplates} תבניות אירוע`,
      before: entity.catalogue
        ? {
            bedTypes: entity.catalogue.bedTypes.length,
            rules: entity.catalogue.rules.length,
            eventTemplates: entity.catalogue.eventTemplates.length,
          }
        : null,
      after: {
        bedTypes: result.bedTypes,
        rules: result.rules,
        eventTemplates: result.eventTemplates,
      },
    }),
  })

  return { configureProperty }
}

/**
 * The calendar day of an instant, as the ISO string every effective date in
 * this domain is compared as. Split rather than sliced, so no length constant
 * has to be maintained beside a format.
 */
function isoDateOf(now: Date): string {
  return now.toISOString().split('T')[0]
}
