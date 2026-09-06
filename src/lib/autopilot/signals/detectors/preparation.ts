/**
 * The plan, and whether the work behind it will be done in time.
 *
 * ── The module-awareness rule lives here in its sharpest form ─────────────
 *
 * The preparation engine says a changeover needs six more towels than the
 * house holds. What Autopilot is allowed to SAY about that depends entirely on
 * what the organization runs:
 *
 *   inventory off        "ההכנה דורשת 6 מגבות נוספות."
 *   inventory basic      the same. Counting is not reserving.
 *   inventory tracked    "אפשר לשריין 6 מגבות מהמלאי."
 *
 * The fact is identical in all three. The sentence is not, and getting it
 * wrong is not a wording nit: "שריינו מהמלאי" told to a business with no stock
 * module is an instruction to use a screen that does not exist, delivered as
 * an alert. `canReserveStock` is the only thing that decides, and it reads
 * `InventoryCapabilities`, which is the module's own answer.
 *
 * ── Behind schedule is arithmetic somebody else did ───────────────────────
 *
 * The typical duration and the percentage complete both come from the
 * preparation engine. This file subtracts and compares. It does not estimate
 * how long a villa takes, because a number invented here would be a number no
 * rule produced and no customer could change.
 */

import type { Signal } from '../../types'
import { localTime, minutesBetween } from '../deadlines'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { canReserveStock, isModuleEnabled } from '../modules'

/** Something the plan needs beyond what the property already holds. */
export interface AdditionalItem {
  itemId: string
  /** Hebrew. "מגבות". */
  label: string
  quantity: number
}

export interface PreparationFacts {
  bookingId: string
  propertyId: string | null
  label: string
  /** Whether a plan exists for this changeover. */
  planGenerated: boolean
  /** Whether the people doing the work can see it. */
  planPublished: boolean
  /** 0–100 from the preparation engine, or `null` with no plan. */
  percentComplete: number | null
  /** The engine's typical duration for this property, in minutes. */
  typicalMinutes: number | null
  arrivalAt: string | null
  startedAt: string | null
  additionalItems: readonly AdditionalItem[]
}

const COMPLETE = 100

export function detectPreparation(
  changeovers: readonly PreparationFacts[],
  context: DetectorContext,
): Signal[] {
  if (!isModuleEnabled(context.modules, 'preparation')) return []

  const signals: Signal[] = []

  for (const changeover of changeovers) {
    if (!changeover.planGenerated) {
      signals.push(
        plain(
          changeover,
          'preparation.plan_missing',
          'לא נוצרה תוכנית הכנה',
          'אין תוכנית הכנה לאירוח הזה, ולכן אין למי מהצוות מה לבצע.',
          'at_risk',
          [fact('preparation.plan', 'תוכנית הכנה', false, 'preparation')],
        ),
      )
      // Nothing below this line is answerable without a plan. Emitting a
      // "behind schedule" signal for work that was never described would be a
      // second alarm about the same absence.
      continue
    }

    if (!changeover.planPublished) {
      signals.push(
        plain(
          changeover,
          'preparation.plan_unpublished',
          'תוכנית ההכנה לא פורסמה',
          'התוכנית קיימת ולא פורסמה, כך שהצוות אינו רואה אותה.',
          'at_risk',
          [
            fact('preparation.plan', 'תוכנית הכנה', true, 'preparation'),
            fact('preparation.published', 'פורסמה', false, 'preparation'),
          ],
        ),
      )
    }

    signals.push(...behindSchedule(changeover, context))
    signals.push(...additionalItems(changeover, context))
  }

  return signals
}

/**
 * Is there still time to finish.
 *
 * The comparison the brief asks for, in one line: the work left, against the
 * time left. Both numbers, and the wall clock either side of them, go into the
 * evidence so the screen can say the whole sentence rather than a percentage.
 */
function behindSchedule(
  changeover: PreparationFacts,
  context: DetectorContext,
): Signal[] {
  if (changeover.arrivalAt === null) return []
  if (changeover.typicalMinutes === null) return []

  const arrival = new Date(changeover.arrivalAt)
  if (Number.isNaN(arrival.getTime())) return []

  const done = Math.min(COMPLETE, Math.max(0, changeover.percentComplete ?? 0))
  if (done >= COMPLETE) return []

  const remaining = Math.round(
    (changeover.typicalMinutes * (COMPLETE - done)) / COMPLETE,
  )
  const minutesLeft = minutesBetween(context.now, arrival)
  if (minutesLeft > remaining) return []

  return [
    plain(
      changeover,
      'preparation.behind_schedule',
      'ההכנה לא תספיק עד ההגעה',
      `נותרו ${remaining} דקות עבודה ו-${Math.max(0, minutesLeft)} דקות עד ההגעה.`,
      minutesLeft <= 0 ? 'critical' : 'at_risk',
      [
        fact(
          'preparation.typical_minutes',
          'משך הכנה טיפוסי בדקות',
          changeover.typicalMinutes,
          'preparation',
        ),
        fact(
          'preparation.percent_complete',
          'אחוז ההכנה שהושלם',
          done,
          'preparation',
        ),
        fact(
          'preparation.remaining_minutes',
          'דקות עבודה שנותרו',
          remaining,
          'preparation',
        ),
        fact(
          'preparation.started',
          'העבודה החלה',
          changeover.startedAt !== null,
          'preparation',
          changeover.startedAt ?? undefined,
        ),
        fact(
          'arrival.at',
          'שעת ההגעה',
          localTime(arrival, context.timeZone),
          'booking',
          changeover.arrivalAt,
        ),
        fact(
          'arrival.now',
          'השעה כעת',
          localTime(context.now, context.timeZone),
          'deadlines',
          context.now.toISOString(),
        ),
      ],
    ),
  ]
}

/** What the plan needs and the house does not have. See the header. */
function additionalItems(
  changeover: PreparationFacts,
  context: DetectorContext,
): Signal[] {
  if (changeover.additionalItems.length === 0) return []

  const reservable = canReserveStock(context.modules)
  const listed = changeover.additionalItems
    .map((item) => `${item.quantity} ${item.label}`)
    .join(', ')

  return [
    plain(
      changeover,
      'preparation.additional_items',
      'ההכנה דורשת פריטים נוספים',
      reservable
        ? `אפשר לשריין מהמלאי: ${listed}.`
        : `ההכנה דורשת בנוסף: ${listed}.`,
      'at_risk',
      changeover.additionalItems.map((item) =>
        fact(
          `preparation.additional.${item.itemId}`,
          item.label,
          item.quantity,
          'preparation',
        ),
      ),
    ),
  ]
}

function plain(
  changeover: PreparationFacts,
  code: string,
  headline: string,
  detail: string,
  risk: Signal['risk'],
  evidence: Signal['evidence'],
): Signal {
  return {
    code,
    domain: 'preparation',
    risk,
    resourceType: 'booking',
    resourceId: changeover.bookingId,
    propertyId: changeover.propertyId,
    title: `${changeover.label} — ${headline}`,
    detail,
    evidence,
    dedupeKey: signalKey({
      code,
      resourceType: 'booking',
      resourceId: changeover.bookingId,
    }),
    ...(changeover.arrivalAt === null ? {} : { dueAt: changeover.arrivalAt }),
  }
}
