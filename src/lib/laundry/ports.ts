/**
 * What this module needs from the outside, declared as interfaces it owns.
 *
 * ══ WHY THERE IS NO IMPORT OF `src/lib/inventory` ANYWHERE HERE ══════════
 *
 * The laundry module genuinely wants stock. "You need 30 sheets, you have 22,
 * eight of which are in the machine" is a better sentence than "you need 30",
 * and `laundry.shortage_detected` exists in the frozen event catalogue to
 * carry exactly that.
 *
 * It cannot have it by importing the stock engine, and the reason is not
 * architectural taste. `src/lib/inventory/**` is being written right now, by a
 * different worker, in a different worktree. A module that is not on disk is
 * not a missing feature at runtime — it is a RESOLUTION ERROR, and a
 * resolution error in a shared chunk takes down every page in the application
 * for everybody. That has already happened once in this codebase, and the
 * ownership register exists because of it.
 *
 * A dynamic `import()` does not help. It defers *evaluation*, not resolution:
 * the bundler still has to find the module at build time, and a specifier it
 * cannot resolve is a build failure or a chunk that throws on first use. There
 * is no syntax that makes "maybe this file exists" safe.
 *
 * So the dependency is INVERTED. This module declares the shape it needs, ships
 * an implementation that honestly reports "I do not know", and the composition
 * root supplies a real one when there is one to supply. When the stock engine
 * lands, one file changes — the wiring — and nothing in this directory does.
 *
 * ── "Unknown" is a first-class answer and not a zero ──────────────────────
 *
 * `nullStockPort` returns `null`, not an empty stock level. The difference is
 * the whole point of the null implementation being written carefully rather
 * than as a stub: a screen told "0 available" renders a shortage of thirty and
 * sends somebody to buy sheets they already own. A screen told `null` renders
 * "מלאי אינו מנוהל" and asks nobody to do anything.
 *
 * This is the same lesson `MissingDemoTable` teaches in `src/lib/demo/client.ts`
 * — "none, and I meant it" and "nobody has said" must not look the same.
 */

import type { LaundryRequirement } from './types'

// ── Stock ─────────────────────────────────────────────────────────────────

/**
 * What is on the shelf for one item at one property.
 *
 * A deliberately small subset of whatever the stock engine's own type turns
 * out to be. A port that mirrored a whole foreign type would have to be
 * rewritten the day that type changed, which is the coupling the port exists
 * to avoid.
 */
export interface LaundryStockLevel {
  itemId: string
  propertyId: string
  /** Clean, on the shelf, not promised to anybody else. */
  available: number
  /** Currently at a laundry or in a machine. */
  inLaundry: number
  /** Washed and on its way back, but not yet on the shelf. */
  returning: number
}

/**
 * Where stock comes from, if anywhere.
 *
 * One method, `null` for "not managed". Not two methods, not a capability
 * flag: a caller that has to ask `isAvailable()` before `levels()` is a caller
 * that will one day forget, and the forgetting looks like a zero.
 */
export interface LaundryStockPort {
  /**
   * Levels for these items at these properties, or `null` when this
   * organization does not track stock at all.
   *
   * Returning `null` from the whole call rather than per item is deliberate:
   * "we track stock but not this item" and "we do not track stock" produce
   * different screens, and the first is an empty entry in a non-null map.
   */
  levels(args: {
    organizationId: string
    itemIds: readonly string[]
    propertyIds: readonly string[]
  }): Promise<readonly LaundryStockLevel[] | null>
}

/**
 * The implementation that ships today.
 *
 * Not a stub, not a TODO, and not a throw. It is the correct behaviour for an
 * organization with `INVENTORY_MODES` set to `off` — which the frozen contract
 * calls "a first-class answer and the default" — and it will still be the
 * correct behaviour for that organization after the stock engine lands.
 */
export const nullStockPort: LaundryStockPort = {
  async levels() {
    return null
  },
}

// ── What a caller does with the answer ────────────────────────────────────

/**
 * One item that will not go round.
 *
 * `available` is nullable for the reason in the header: a shortage computed
 * against unknown stock is not a shortage, it is a guess, and the screen shows
 * the requirement without a verdict.
 */
export interface LaundryShortage {
  itemId: string
  label: string
  propertyId: string
  required: number
  /** `null` when stock is not managed. */
  available: number | null
  /** `null` when `available` is. Never a negative number. */
  shortage: number | null
  /** Hebrew, and honest about not knowing. */
  explanation: string
}

/**
 * Compare requirements against whatever the port could tell us.
 *
 * `levels` of `null` produces a list where every `shortage` is `null` and
 * every explanation says stock is not managed. That list is still returned,
 * because a screen that shows nothing when stock is unmanaged is a screen that
 * looks broken to the customer who has not switched stock on — which is most
 * of them.
 */
export function assessStock(
  requirements: readonly LaundryRequirement[],
  levels: readonly LaundryStockLevel[] | null,
): readonly LaundryShortage[] {
  const index = new Map(
    (levels ?? []).map((level) => [
      `${level.propertyId} ${level.itemId}`,
      level,
    ]),
  )

  return requirements.map((requirement) => {
    const base = {
      itemId: requirement.itemId,
      label: requirement.label,
      propertyId: requirement.propertyId,
      required: requirement.quantity,
    }

    if (levels === null) {
      return {
        ...base,
        available: null,
        shortage: null,
        explanation: `${requirement.label}: ${requirement.quantity} נדרשים. מלאי אינו מנוהל בעסק הזה, ולכן אין באפשרותנו לומר אם הכמות קיימת.`,
      }
    }

    const level = index.get(`${requirement.propertyId} ${requirement.itemId}`)

    if (!level) {
      return {
        ...base,
        available: null,
        shortage: null,
        explanation: `${requirement.label}: ${requirement.quantity} נדרשים. הפריט אינו נספר במלאי, ולכן אין באפשרותנו לומר אם הכמות קיימת.`,
      }
    }

    const shortage = Math.max(0, requirement.quantity - level.available)

    return {
      ...base,
      available: level.available,
      shortage,
      explanation:
        shortage > 0
          ? `${requirement.label}: ${requirement.quantity} נדרשים, ${level.available} זמינים — חסרים ${shortage}. ${level.inLaundry} בכביסה ו-${level.returning} בדרך חזרה.`
          : `${requirement.label}: ${requirement.quantity} נדרשים, ${level.available} זמינים.`,
    }
  })
}

/** Only the ones that are genuinely, knowably short. */
export function shortagesOnly(
  assessed: readonly LaundryShortage[],
): readonly LaundryShortage[] {
  return assessed.filter(
    (entry) => entry.shortage !== null && entry.shortage > 0,
  )
}
