/**
 * What a counted difference means, and what it might cost.
 *
 * ══ An unexplained variance is unexplained ════════════════════════════════
 *
 * This is the rule the whole file is built around, and it is a rule about
 * *language* as much as about behaviour. Eleven towels are missing after a
 * stocktake. The product knows seven plausible explanations and has evidence
 * for none of them, so the seventh classification is `unknown` — and `unknown`
 * is never named, labelled, hinted at or commented as an accusation against a
 * person. Not in the type, not in a Hebrew string, not in a variable name.
 *
 * That is not squeamishness. A hospitality business runs on cleaners,
 * handymen and laundry drivers who work alone in empty houses, and a screen
 * that turns "we cannot account for eleven towels" into an accusation is a
 * screen that will one day be shown to one of them. The honest sentence is
 * the one the product can support: eleven units, unexplained.
 *
 * `loss.test.ts` greps this module's own source and the counting screens for
 * accusatory vocabulary and fails on a match. The guest-book module set that
 * precedent for compliance claims and the argument is identical here: the risk
 * is a label somebody adds in six months meaning well, a review catches that
 * once, and a test catches it on every commit.
 *
 * ══ Reusable and consumable are classified differently ════════════════════
 *
 * `in_laundry` is offered only for an item the ledger shows circulating —
 * units in `dirty`, `laundry`, `returning`, `in_use` or `reserved`. That is
 * the product's only evidence, without a new column, that this is linen
 * rather than soap, and offering "it is in the wash" as an explanation for a
 * missing bottle of shampoo is how a classification list stops being read.
 *
 * The gate is presence, not a ceiling. It would be tempting to refuse
 * `in_laundry` beyond the number the ledger already has in the wash, and it
 * would be wrong: the expected figure this variance was measured against
 * (`onHandClean`) has *already* excluded those units. A shortfall explained by
 * laundry is precisely the case where the ledger's own split is stale —
 * somebody carried three towels to the machine and recorded nothing — so the
 * correction moves units from `available` to `laundry` rather than writing
 * anything off.
 *
 * ══ Money is an estimate and cannot be rendered as anything else ══════════
 *
 * `ReplacementExposure` has a private constructor, no bare amount on the
 * instance, and one renderable string that always carries the qualifier. The
 * figure is `method.totalAgorot`, reachable only by holding the object that
 * explains how it was reached — the same shape `TimeSavedEstimate` in
 * `src/lib/autopilot/learning/value.ts` uses, and for the same reason: a
 * number that escapes its method becomes a number somebody repeats to their
 * accountant.
 *
 * Two honesty details inside the method:
 *
 *   `basis` says out loud that the recorded purchase cost is standing in for
 *   a replacement cost, because nobody in this product has priced replacement
 *   separately and pretending otherwise is a bigger lie than the arithmetic.
 *
 *   `unpricedUnits` counts unexplained units excluded because their item
 *   carries no cost at all. Without it the total silently understates, which
 *   is the failure direction that looks like good news.
 *
 * Integer agorot throughout. Nothing here divides by 100 except the shared
 * display formatter.
 */

import { BusinessRuleError } from '../errors'
import { formatAgorot } from '../plans/plan'

import type { InventoryState } from '../contracts/states'

/* ----------------------------------------------------------- vocabulary -- */

/**
 * The seven explanations, exactly as the brief names them.
 *
 * Ordered from "nothing happened" to "we do not know", which is also roughly
 * the order a reconciler should consider them in: check the arithmetic, check
 * the other cupboards, check the wash, and only then start writing stock off.
 */
export const LOSS_CLASSES = [
  'count_error',
  'in_laundry',
  'found_at_property',
  'damaged',
  'disposed',
  'lost',
  'unknown',
] as const

export type LossClass = (typeof LOSS_CLASSES)[number]

export const LOSS_CLASS_LABEL: Readonly<Record<LossClass, string>> = {
  count_error: 'טעות ספירה',
  in_laundry: 'בכביסה',
  found_at_property: 'נמצא בנכס',
  damaged: 'נפגם',
  disposed: 'הוצא משימוש',
  lost: 'לא אותר',
  unknown: 'לא הוסבר',
}

export const LOSS_CLASS_HELP: Readonly<Record<LossClass, string>> = {
  count_error:
    'הספירה בפועל מדויקת יותר מהרישום. נרשמת תנועת ספירה שמיישרת את ' +
    'המערכת למה שנמצא על המדף.',
  in_laundry:
    'הפריטים קיימים ונמצאים במחזור הכביסה, אך רשומים במערכת כזמינים. ' +
    'נרשמת תנועה שמעבירה אותם למצב ״כביסה״. לא נגרע דבר מהמלאי.',
  found_at_property:
    'הפריטים אותרו במקום אחר בנכס אחרי הספירה. הרישום היה נכון והספירה ' +
    'הייתה חלקית — לא נרשמת תנועה.',
  damaged: 'הפריטים קיימים ואינם ראויים לשימוש. עוברים למצב ״פגום״.',
  disposed: 'הפריטים הושלכו או הוצאו משימוש ביודעין. נגרעים מהמלאי עם נימוק.',
  lost: 'הפריטים לא אותרו בבירור שנעשה. נגרעים מהמלאי עם נימוק.',
  unknown:
    'ההפרש נבדק ולא נמצא לו הסבר. זו תשובה לגיטימית: לא נרשמת תנועת ' +
    'מלאי, הפריטים נשארים ברישום, וההפרש נשאר גלוי בדוח החשיפה.',
}

/**
 * Is this variance still without an explanation?
 *
 * `null` and `unknown` are both unexplained and they are not the same thing.
 * `null` is a queue — nobody has looked yet. `unknown` is a verdict — somebody
 * looked and found nothing. The distinction is the one `inventory_discrepancies`
 * draws between `unresolved` and a resolution, kept identical on purpose.
 * Exposure counts both, because in neither case does the product know what
 * happened.
 */
export function isUnexplained(classification: LossClass | null): boolean {
  return classification === null || classification === 'unknown'
}

/* --------------------------------------------------------------- effects -- */

/** What classifying this variance this way does to the ledger, if anything. */
export interface LossEffect {
  /** The movement kind, or null when nothing is written. */
  movementKind: 'adjustment' | 'loss' | 'count' | null
  /** Signed. Negative takes units out of the allocatable position. */
  quantityDelta: number
  /** The state the affected units end in, when the movement moves one. */
  toState: InventoryState | null
  /** Hebrew, for the ledger's `reason` column. */
  reason: string
  /** True when the count is the more recent physical observation. */
  correctsLedger: boolean
}

export interface LossEffectInput {
  label: string
  /** `expected − counted`. Positive is missing; negative is surplus. */
  variance: number
  /** Units the snapshot showed in circulating states. Evidence of linen. */
  circulating: number
  classification: LossClass
  note: string | null
}

/** Classifications that require a stated reason, because they remove stock. */
const NOTE_REQUIRED: readonly LossClass[] = ['damaged', 'disposed', 'lost']

/** Classifications that can explain a surplus. The rest cannot. */
const SURPLUS_ALLOWED: readonly LossClass[] = ['count_error', 'unknown']

/**
 * The classifications this particular variance may legitimately be given.
 *
 * Returned as data so a screen renders exactly the options the operation will
 * accept. A dropdown offering a choice the write path then refuses teaches a
 * person to distrust the screen, which is the same argument `buildActions`
 * makes for shortage actions.
 */
export function classificationsFor(variance: {
  variance: number
  circulating: number
}): readonly LossClass[] {
  if (variance.variance === 0) return []

  if (variance.variance < 0) return SURPLUS_ALLOWED

  return LOSS_CLASSES.filter(
    (one) => one !== 'in_laundry' || variance.circulating > 0,
  )
}

/**
 * What this classification does, decided once and performed elsewhere.
 *
 * Returned rather than performed so the screen can say what the button will
 * do before it is pressed and the write path has exactly one description of
 * the act to follow — the discipline `resolutionEffect` established for
 * checkout discrepancies.
 */
export function lossEffect(input: LossEffectInput): LossEffect {
  const { label, variance, classification, note } = input

  if (variance === 0) {
    throw new BusinessRuleError({
      code: 'inventory.variance_zero',
      message: 'a variance of zero is not a variance',
      userMessage: 'אין כאן הפרש לסווג.',
    })
  }

  if (variance < 0 && !SURPLUS_ALLOWED.includes(classification)) {
    throw new BusinessRuleError({
      code: 'inventory.variance_surplus_classification',
      message: `'${classification}' cannot explain a surplus`,
      userMessage:
        `נספרו ${Math.abs(variance)} יחידות מעבר לצפוי ב״${label}״. עודף ` +
        `לא יכול להיות מוסבר כ״${LOSS_CLASS_LABEL[classification]}״ — ` +
        'העודף מצביע על רישום חסר, לא על פריט שנעלם.',
    })
  }

  if (classification === 'in_laundry' && input.circulating === 0) {
    throw new BusinessRuleError({
      code: 'inventory.variance_not_circulated',
      message: 'the ledger shows no circulating units for this item',
      userMessage:
        `אין רישום של יחידות במחזור עבור ״${label}״, ולכן ״בכביסה״ אינו ` +
        'הסבר אפשרי כאן. הסיווג הזה מיועד לפריטים שחוזרים — מצעים ומגבות — ' +
        'ולא למתכלים.',
    })
  }

  if (
    NOTE_REQUIRED.includes(classification) &&
    (note ?? '').trim().length === 0
  ) {
    throw new BusinessRuleError({
      code: 'inventory.variance_note_required',
      message: `'${classification}' removes stock and requires a note`,
      userMessage:
        'גריעה מהמלאי בלי נימוק היא מספר שאיש לא יוכל להסביר בעוד חודשיים. ' +
        'כתוב מה נבדק ומה הוחלט.',
    })
  }

  // Every sentence below is about a number of things, so the sign is taken
  // off here and the direction is carried by the branch.
  const units = Math.abs(variance)
  const written = (note ?? '').trim()
  const tail = written.length === 0 ? '' : ` ${written}`

  switch (classification) {
    case 'count_error':
      // The shelf beats the ledger. A physical stocktake is exactly what a
      // `count` movement records, and `applyImport` already treats a differing
      // imported quantity the same way. The delta is `counted − expected`, so
      // this branch is the only one that handles a surplus by adding.
      return {
        movementKind: 'count',
        quantityDelta: 0 - variance,
        toState: null,
        reason: `${label}: יישור לספירה בפועל, הפרש של ${0 - variance}.` + tail,
        correctsLedger: true,
      }

    case 'found_at_property':
      // The units exist and the sheet was short, so the ledger was right and
      // nothing is written. Deliberately the opposite of `count_error`: there
      // the record was wrong, here the count was.
      return {
        movementKind: null,
        quantityDelta: 0,
        toState: null,
        reason: `${label}: ${units} אותרו בנכס לאחר הספירה.` + tail,
        correctsLedger: false,
      }

    case 'in_laundry':
      // Nothing is written off. The units are moved to the state they were
      // actually in, which is the correction the ledger needed.
      return {
        movementKind: 'adjustment',
        quantityDelta: 0 - units,
        toState: 'laundry',
        reason: `${label}: ${units} נמצאים במחזור הכביסה ולא על המדף.` + tail,
        correctsLedger: false,
      }

    case 'damaged':
      return {
        movementKind: 'adjustment',
        quantityDelta: 0 - units,
        toState: 'damaged',
        reason: `${label}: ${units} נפגמו ואינם ראויים לשימוש.` + tail,
        correctsLedger: false,
      }

    case 'disposed':
      // `lost` is the nearest state the frozen contract carries; there is no
      // `disposed`. `resolutionEffect` already makes the same compromise for
      // `written_off`, and the difference between the two lives in the reason
      // line rather than in a state the contract does not have.
      return {
        movementKind: 'loss',
        quantityDelta: 0 - units,
        toState: 'lost',
        reason: `${label}: ${units} הוצאו משימוש ביודעין.` + tail,
        correctsLedger: false,
      }

    case 'lost':
      return {
        movementKind: 'loss',
        quantityDelta: 0 - units,
        toState: 'lost',
        reason: `${label}: ${units} לא אותרו בבירור.` + tail,
        correctsLedger: false,
      }

    case 'unknown':
      // Nothing is written, and that is the point. Writing off a difference
      // nobody has explained is deciding it, and the ledger is append-only —
      // the decision could not then be taken back.
      return {
        movementKind: null,
        quantityDelta: 0,
        toState: null,
        reason: `${label}: הפרש של ${units} נבדק ולא הוסבר.` + tail,
        correctsLedger: false,
      }
  }
}

/* -------------------------------------------------------------- exposure -- */

export interface ExposureLine {
  itemId: string
  label: string
  /** Unexplained units missing. A surplus contributes nothing. */
  units: number
  /** Agorot per unit, from the snapshot. */
  replacementCostAgorot: number
  /** `units × replacementCostAgorot`. Integer agorot. */
  agorot: number
}

/**
 * How the figure was reached, carried with it and inseparable from it.
 *
 * `totalAgorot` lives here rather than on the estimate on purpose: a caller
 * reaches the number only through the object that explains it.
 */
export interface ExposureMethod {
  /** The word that marks the figure. Hebrew. */
  qualifier: string
  /** Where the per-unit cost came from, and what it is not. */
  basis: string
  /** Every item that contributed. The reader's way to disagree. */
  table: readonly ExposureLine[]
  totalAgorot: number
  /** Unexplained units left out because their item carries no cost. */
  unpricedUnits: number
  unpricedItems: number
  /** Hebrew: how it was computed, and what it must not be called. */
  disclaimer: string
}

const QUALIFIER = 'הערכת חשיפה'

const BASIS =
  'העלות ליחידה נלקחת מהעלות שנרשמה לפריט במלאי — מה שהעסק שילם — ולא ' +
  'ממחיר החלפה שנבדק מול ספק היום. אף אחד לא תמחר החלפה בנפרד.'

const DISCLAIMER =
  'זו הערכה ולא אובדן מאומת. היא מוכפלת מהפרשים שנבדקו ולא הוסבר להם ' +
  'מקור, ומשקפת כמה היה עולה להחליף אותם אילו היו באמת חסרים. הפרש בלי ' +
  'הסבר נשאר בלי הסבר — המספר הזה אינו קובע מה קרה ואינו מייחס אותו לאיש.'

/**
 * What unexplained variances would cost to replace, if they were real.
 *
 * The constructor is private and `from` is the only way in, so every instance
 * carries a method with a table, a basis and a disclaimer. There is no
 * `agorot` field on the instance.
 */
export class ReplacementExposure {
  readonly method: ExposureMethod
  /** The only renderable form. Always carries the qualifier. */
  readonly formatted: string

  private constructor(method: ExposureMethod, formatted: string) {
    this.method = method
    this.formatted = formatted
  }

  static from(inputs: readonly ExposureInput[]): ReplacementExposure {
    const table: ExposureLine[] = []
    let totalAgorot = 0
    let unpricedUnits = 0
    let unpricedItems = 0

    for (const input of inputs) {
      // Explained variances are not exposure, and neither is a surplus:
      // finding two more towels than expected costs nothing to replace.
      if (!isUnexplained(input.classification)) continue
      if (input.variance <= 0) continue

      const units = input.variance

      if (input.replacementCostAgorot === null) {
        unpricedUnits += units
        unpricedItems += 1
        continue
      }

      const agorot = units * input.replacementCostAgorot
      totalAgorot += agorot
      table.push({
        itemId: input.itemId,
        label: input.label,
        units,
        replacementCostAgorot: input.replacementCostAgorot,
        agorot,
      })
    }

    const method: ExposureMethod = {
      qualifier: QUALIFIER,
      basis: BASIS,
      table,
      totalAgorot,
      unpricedUnits,
      unpricedItems,
      disclaimer: DISCLAIMER,
    }

    const missing =
      unpricedUnits === 0
        ? ''
        : ` (${unpricedUnits} יחידות ללא עלות רשומה אינן נכללות)`

    return new ReplacementExposure(
      method,
      `${QUALIFIER}: כ-${formatAgorot(totalAgorot)}${missing}`,
    )
  }

  /** So even a careless string coercion carries the qualifier. */
  toString(): string {
    return this.formatted
  }
}

export interface ExposureInput {
  itemId: string
  label: string
  /** `expected − counted`. Only a positive value can be exposure. */
  variance: number
  classification: LossClass | null
  replacementCostAgorot: number | null
}

/** The estimate for a whole session. One call, one object, one method. */
export function estimateExposure(
  inputs: readonly ExposureInput[],
): ReplacementExposure {
  return ReplacementExposure.from(inputs)
}
