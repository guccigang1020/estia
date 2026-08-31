/**
 * The preparation policy, as a screen holds it.
 *
 * ── One shape, three places ───────────────────────────────────────────────
 *
 * `ConfigureInput` — the schema in `src/lib/preparation/catalogue.ts` — is the
 * wire shape the operation validates, and it is also exactly what the editor
 * keeps in React state and exactly what the preview action is handed. There is
 * no separate "form model" that has to be mapped onto it, because a mapping
 * between two shapes that are meant to be the same shape is where a field
 * quietly stops being saved.
 *
 * So this module is only the two directions the screen genuinely needs:
 * a stored catalogue read *into* a draft, and an empty draft for a property
 * nobody has configured. Everything else — validation, the mapping onto
 * `PreparationCatalogue`, the domain law — already lives in the domain and is
 * called from there.
 *
 * ── The empty draft contains no business numbers ──────────────────────────
 *
 * Not one bed, not one rule, not one quantity. That is deliberate and it is
 * the whole reason this screen exists: `no-hardcoded-numbers.test.ts` proves
 * the engine never invents a quantity, so a starter configuration shipped in
 * the product would be ESTIA deciding how many towels an Israeli villa needs.
 * The one exception is `minimumStaff`, which is one — not a claim about
 * cleaning, but the statement that work is done by at least one person, and a
 * zero there would show a plan recommending nobody.
 *
 * The section headings are Hebrew strings rather than numbers and are supplied
 * for a new catalogue, because `buildWorkPlan` reads `sectionLabels[key]` for
 * every section it creates and an unnamed section is a heading a cleaner
 * cannot read.
 */

import { PLAN_SECTIONS } from '@/lib/preparation'
import type {
  ConfigureInput,
  EventType,
  PlanSectionKey,
  PreparationCatalogue,
} from '@/lib/preparation'

export type PolicyDraft = ConfigureInput

/** The party the owner tries the policy out on. */
export type PreviewParty = {
  guests: number
  adults: number
  children: number
  nights: number
  eventType: EventType
}

/**
 * The Hebrew names of the plan's sections.
 *
 * Stored on the catalogue rather than fixed in code so a business that calls
 * the final walk-through something else can say so. These are the defaults a
 * property starts with, and they are the same words `example-configuration.ts`
 * uses — which is what makes the fixture and the product describe one product.
 */
export const DEFAULT_SECTION_LABELS: Readonly<Record<PlanSectionKey, string>> =
  {
    cleaning: 'ניקיון',
    bedrooms: 'חדרי שינה',
    extra_sleeping: 'מקומות שינה נוספים',
    bathrooms: 'חדרי רחצה',
    towels: 'מגבות',
    kitchen: 'מטבח',
    event_setup: 'הקמת אירוע',
    outdoor: 'חוץ',
    pool: 'בריכה',
    final_inspection: 'בדיקה סופית',
  }

/** The property characteristics ESTIA itself understands. */
export const KNOWN_FLAGS: readonly { flag: string; label: string }[] = [
  { flag: 'pool', label: 'בריכה' },
  { flag: 'outdoor', label: 'חצר או שטח חוץ' },
  { flag: 'kosher_kitchen', label: 'מטבח כשר' },
  { flag: 'accessible', label: 'נגישות' },
]

export const SECTION_LABEL_KEYS = PLAN_SECTIONS

/**
 * A property with no catalogue at all.
 *
 * Every quantity is absent rather than guessed. The owner's first act on this
 * screen is to say what beds the house has, and until they do the preview
 * honestly reports that nobody can be placed.
 */
export function emptyDraft(propertyId: string, label: string): PolicyDraft {
  return {
    propertyId,
    property: {
      label,
      bedrooms: 0,
      bathrooms: 0,
      flags: KNOWN_FLAGS.map((known) => ({
        flag: known.flag,
        on: false,
        points: 0,
      })),
      beds: [],
      extraSleepingBedTypeId: '',
      maximumSleepingPlaces: null,
    },
    bedTypes: [],
    rules: [],
    eventTemplates: [],
    complexity: {
      perGuest: 0,
      perBedroom: 0,
      perBathroom: 0,
      perExtraBed: 0,
      perExtraItem: 0,
      scorePerStaff: 0,
      // One person, because zero people is not a crew size. See the header.
      minimumStaff: 1,
      minutesPerPoint: 0,
      minimumMinutes: 0,
    },
    readinessPolicy: {
      criticalPercent: 0,
      criticalHours: 0,
      warningPercent: 0,
    },
    sectionLabels: { ...DEFAULT_SECTION_LABELS },
  }
}

/**
 * A stored catalogue, opened for editing.
 *
 * The record-shaped parts of the domain — `flags`, `perFlag`, `perEventType` —
 * come apart into lists here, which is the inverse of what `catalogueFrom`
 * does on the way back in. A flag the property does not set but does carry a
 * weight for is still listed, because losing it on a round trip through the
 * form would silently change the difficulty score.
 */
export function draftFromCatalogue(
  catalogue: PreparationCatalogue,
  propertyId: string,
  fallbackLabel: string,
): PolicyDraft {
  const configuration = catalogue.propertyConfiguration

  const flagNames = [
    ...new Set([
      ...KNOWN_FLAGS.map((known) => known.flag),
      ...Object.keys(configuration.flags),
      ...Object.keys(catalogue.complexity.perFlag),
    ]),
  ]

  return {
    propertyId,
    property: {
      label:
        configuration.label.length > 0 ? configuration.label : fallbackLabel,
      bedrooms: configuration.bedrooms,
      bathrooms: configuration.bathrooms,
      flags: flagNames.map((flag) => ({
        flag,
        on: configuration.flags[flag] ?? false,
        points: catalogue.complexity.perFlag[flag] ?? 0,
      })),
      beds: catalogue.propertyConfiguration.beds.map((stock) => ({
        bedTypeId: stock.bedTypeId,
        permanent: stock.permanent,
        storage: stock.storage,
        missing: stock.missing,
      })),
      extraSleepingBedTypeId: configuration.extraSleepingBedTypeId,
      maximumSleepingPlaces: configuration.maximumSleepingPlaces,
    },
    bedTypes: catalogue.bedTypes.map((type) => ({
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
    })),
    rules: catalogue.rules.map(toDraftRule),
    eventTemplates: catalogue.eventTemplates.map((template) => ({
      id: template.id,
      eventType: template.eventType,
      label: template.label,
      sections: [...template.sections],
      rules: template.rules.map(toDraftRule),
      points: catalogue.complexity.perEventType[template.eventType] ?? 0,
    })),
    complexity: {
      perGuest: catalogue.complexity.perGuest,
      perBedroom: catalogue.complexity.perBedroom,
      perBathroom: catalogue.complexity.perBathroom,
      perExtraBed: catalogue.complexity.perExtraBed,
      perExtraItem: catalogue.complexity.perExtraItem,
      scorePerStaff: catalogue.complexity.scorePerStaff,
      minimumStaff: catalogue.complexity.minimumStaff,
      minutesPerPoint: catalogue.complexity.minutesPerPoint,
      minimumMinutes: catalogue.complexity.minimumMinutes,
    },
    readinessPolicy: {
      criticalPercent: catalogue.readinessPolicy.criticalPercent,
      criticalHours: catalogue.readinessPolicy.criticalHours,
      warningPercent: catalogue.readinessPolicy.warningPercent,
    },
    sectionLabels: fillSectionLabels(catalogue.sectionLabels),
  }
}

/**
 * A rule, flattened for the form.
 *
 * The condition narrows to the two leaves the editor can render. A stored rule
 * carrying a nested `all`/`any`/`not` — which the engine supports and an
 * import may one day produce — comes back as *unconditional* rather than as a
 * half-rendered approximation, and the screen says so beside it. Silently
 * dropping the branch would be worse: the rule would keep firing on every
 * booking and nobody would know the condition had gone.
 */
function toDraftRule(rule: PreparationCatalogue['rules'][number]) {
  return {
    id: rule.id,
    category: rule.category,
    itemId: rule.itemId,
    label: rule.label,
    unit: rule.unit,
    quantity: {
      basis: rule.quantity.basis,
      factor: rule.quantity.factor ?? 1,
      divisor: rule.quantity.divisor ?? 1,
      plus: rule.quantity.plus ?? 0,
    },
    condition: draftCondition(rule.condition),
    buffer:
      rule.buffer === null
        ? null
        : rule.buffer.kind === 'percent'
          ? {
              kind: 'percent' as const,
              percent: rule.buffer.percent,
              amount: null,
            }
          : {
              kind: 'flat' as const,
              percent: null,
              amount: rule.buffer.amount,
            },
    section: rule.section,
    requiresPhoto: rule.requiresPhoto,
    instructions: rule.instructions,
    minutesPerUnit: rule.minutesPerUnit,
  }
}

function draftCondition(
  condition: PreparationCatalogue['rules'][number]['condition'],
): PolicyDraft['rules'][number]['condition'] {
  if (condition === null) return null

  if (condition.kind === 'compare') {
    return {
      kind: 'compare',
      basis: condition.basis,
      comparator: condition.comparator,
      value: condition.value,
      flag: null,
      equals: null,
    }
  }

  if (condition.kind === 'flag') {
    return {
      kind: 'flag',
      basis: null,
      comparator: null,
      value: null,
      flag: condition.flag,
      equals: condition.equals,
    }
  }

  return null
}

/** True when a stored rule carries a condition this editor cannot render. */
export function hasUnrenderableCondition(
  condition: PreparationCatalogue['rules'][number]['condition'],
): boolean {
  return condition !== null && draftCondition(condition) === null
}

/**
 * Every section named, even where the stored record forgot one.
 *
 * The column defaults to an empty object in 0021, so a catalogue written by
 * anything other than this screen can be missing a heading — and
 * `buildWorkPlan` would then put `undefined` where a cleaner reads a title.
 */
function fillSectionLabels(
  stored: Readonly<Partial<Record<PlanSectionKey, string>>>,
): Record<PlanSectionKey, string> {
  const labels = {} as Record<PlanSectionKey, string>
  for (const key of SECTION_LABEL_KEYS) {
    const value = stored[key]
    labels[key] =
      typeof value === 'string' && value.length > 0
        ? value
        : DEFAULT_SECTION_LABELS[key]
  }
  return labels
}
