/**
 * Expected twelve towels back and got nine.
 *
 * ── Why the difference is not immediately a loss ──────────────────────────
 *
 * Three towels short after a checkout has five plausible explanations and the
 * product knows none of them: a guest took them, a cleaner put them in the
 * wrong cupboard, three were binned as ruined, the count going out was wrong,
 * or the count coming back was. Four of those cost nothing and one is a charge
 * to a guest. A module that wrote off the difference automatically would send
 * an invoice for a miscount, and one that ignored it would never notice a
 * property losing linen at a steady rate.
 *
 * So the difference is *named* and left `unresolved`, which is a queue rather
 * than a verdict, and a person picks from the five. The default is deliberately
 * not `correction`: defaulting to "we miscounted" is exactly how guest loss
 * stops being visible.
 *
 * ── Advanced only, and that is a real gate ────────────────────────────────
 *
 * Counting linen back in is fifteen minutes per changeover. A business that
 * has not asked for it must never be shown an empty discrepancy screen with a
 * badge on it, and `capabilities.discrepancies` is what decides — not the
 * mode, which only says the feature is *possible*.
 *
 * ── Every resolution except two ends in a movement ────────────────────────
 *
 * `found` and `correction` end in a compensating movement that puts the count
 * right. `damaged`, `guest_loss` and `written_off` end in a movement that
 * takes the stock out of circulation under the right heading — `damaged` and
 * `lost` are separate states in the contract precisely because one is repaired
 * or written off and the other is investigated. `investigating` writes no
 * movement, because nothing has been decided yet.
 *
 * Never an edit of `inventory_items.quantity`. 0011 derives it from the ledger,
 * and a resolution that typed over it would produce a number that disagrees
 * with the movements that made it.
 */

import type { InventoryState } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import type {
  Discrepancy,
  DiscrepancyResolution,
  InventoryCapabilities,
} from './types'

export const DISCREPANCY_RESOLUTION_LABEL: Readonly<
  Record<DiscrepancyResolution, string>
> = {
  unresolved: 'לא טופל',
  found: 'נמצא',
  damaged: 'נפגם',
  guest_loss: 'אבד אצל האורח',
  correction: 'תיקון ספירה',
  investigating: 'בבירור',
  written_off: 'נמחק מהמלאי',
}

export const DISCREPANCY_RESOLUTION_HELP: Readonly<
  Record<DiscrepancyResolution, string>
> = {
  unresolved: 'הפער נרשם ועדיין לא הוכרע.',
  found: 'הפריטים אותרו. נרשמת תנועת קליטה שמחזירה אותם לספירה.',
  damaged: 'הפריטים קיימים ואינם ראויים לשימוש. עוברים ל״פגום״.',
  guest_loss: 'הפריטים לא חזרו. עוברים ל״אבד״, וזו הרשומה שמאפשרת חיוב.',
  correction: 'הספירה הייתה שגויה. נרשמת תנועת תיקון בלבד.',
  investigating: 'עדיין בבירור. לא נרשמת תנועה עד שתהיה הכרעה.',
  written_off: 'נמחק מהמלאי לאחר בירור, בלי חיוב לאורח.',
}

export interface CountBack {
  propertyId: string
  itemId: string
  label: string
  bookingId: string | null
  expected: number
  collected: number
  /** ISO date of the count. */
  countedOn: string
}

/**
 * The differences worth recording, out of a whole changeover's counts.
 *
 * A zero difference is not a discrepancy — the migration refuses one with a
 * CHECK — and recording it would put a permanent row of nothing on a screen
 * whose whole job is to be short.
 */
export function findDiscrepancies(
  counts: readonly CountBack[],
  capabilities: InventoryCapabilities,
): readonly Omit<Discrepancy, 'id'>[] {
  if (!capabilities.discrepancies) return []

  return counts
    .filter((count) => count.collected !== count.expected)
    .map((count) => ({
      propertyId: count.propertyId,
      itemId: count.itemId,
      label: count.label,
      bookingId: count.bookingId,
      expected: count.expected,
      collected: count.collected,
      difference: count.collected - count.expected,
      resolution: 'unresolved' as const,
      resolutionNote: null,
      detectedOn: count.countedOn,
      resolvedOn: null,
    }))
}

/** The arithmetic, said out loud, exactly as a shortage alert says its own. */
export function explainDiscrepancy(discrepancy: {
  label: string
  expected: number
  collected: number
  difference: number
}): string {
  const missing = Math.abs(discrepancy.difference)
  if (discrepancy.difference < 0) {
    return (
      `${discrepancy.label}: יצאו ${discrepancy.expected}, חזרו ` +
      `${discrepancy.collected}. חסרים ${missing}.`
    )
  }
  return (
    `${discrepancy.label}: יצאו ${discrepancy.expected}, חזרו ` +
    `${discrepancy.collected}. עודף ${missing}.`
  )
}

/** What a resolution does to the ledger, if anything. */
export interface ResolutionEffect {
  /** The movement kind, or null when nothing is written. */
  movementKind: 'receipt' | 'adjustment' | 'loss' | null
  /** Signed. Positive puts stock back into the count. */
  quantityDelta: number
  /** The state the affected units end in, when the movement moves one. */
  toState: InventoryState | null
  /** Hebrew, for the ledger's `reason` column. */
  reason: string
}

/**
 * What closing this discrepancy this way actually does.
 *
 * Returned as data rather than performed, so the screen can say what the
 * button will do before it is pressed and the write path has exactly one
 * description of the act to follow.
 */
export function resolutionEffect(
  discrepancy: Pick<Discrepancy, 'difference' | 'label'>,
  resolution: DiscrepancyResolution,
  note: string,
): ResolutionEffect {
  if (resolution === 'unresolved') {
    throw new BusinessRuleError({
      code: 'discrepancy_resolution_required',
      message: 'unresolved is the absence of a resolution, not one.',
      userMessage: 'יש לבחור כיצד לסגור את הפער.',
    })
  }

  if (note.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'discrepancy_note_required',
      message: 'A resolution without a note is a verdict nobody can audit.',
      userMessage: 'יש לכתוב נימוק לסגירת הפער.',
    })
  }

  // `difference` is negative when less came back than went out, which is the
  // ordinary case. `missing` is that as a positive count, because every
  // sentence below is about a number of things.
  const missing = Math.abs(discrepancy.difference)

  switch (resolution) {
    case 'found':
      return {
        movementKind: 'receipt',
        quantityDelta: missing,
        toState: 'available',
        reason: `${discrepancy.label}: ${missing} אותרו לאחר הספירה. ${note}`,
      }
    case 'correction':
      return {
        movementKind: 'adjustment',
        quantityDelta: discrepancy.difference,
        toState: null,
        reason: `${discrepancy.label}: תיקון ספירה של ${discrepancy.difference}. ${note}`,
      }
    case 'damaged':
      return {
        movementKind: 'adjustment',
        quantityDelta: 0 - missing,
        toState: 'damaged',
        reason: `${discrepancy.label}: ${missing} נפגמו ואינם ראויים לשימוש. ${note}`,
      }
    case 'guest_loss':
      return {
        movementKind: 'loss',
        quantityDelta: 0 - missing,
        // `lost`, not `damaged`. The contract keeps them apart because one is
        // investigated and possibly charged, and the other is repaired or
        // written off — merging them loses the conversation.
        toState: 'lost',
        reason: `${discrepancy.label}: ${missing} לא חזרו מהאורח. ${note}`,
      }
    case 'written_off':
      return {
        movementKind: 'loss',
        quantityDelta: 0 - missing,
        toState: 'lost',
        reason: `${discrepancy.label}: ${missing} נמחקו מהמלאי לאחר בירור. ${note}`,
      }
    case 'investigating':
      // Nothing is written. A movement recorded now would have to be reversed
      // when the answer arrives, and the ledger is append-only.
      return {
        movementKind: null,
        quantityDelta: 0,
        toState: null,
        reason: `${discrepancy.label}: בבירור. ${note}`,
      }
  }
}

/** A discrepancy nobody has decided about yet. */
export function isOpen(discrepancy: Pick<Discrepancy, 'resolution'>): boolean {
  return (
    discrepancy.resolution === 'unresolved' ||
    discrepancy.resolution === 'investigating'
  )
}
