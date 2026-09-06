/**
 * Not enough of something, now or on a date.
 *
 * ── The arithmetic is the inventory engine's and is not repeated ──────────
 *
 * `inventory/forecast.ts` walks the days, subtracts the reservations, adds the
 * returns from circulation and produces the shortage. This file receives that
 * result. It does not add up towels — a second count would eventually
 * disagree with the first, and the customer would be looking at two numbers
 * for one cupboard with no way to tell which was real.
 *
 * ── What a business is allowed to be told depends on what it runs ─────────
 *
 * `basic` inventory counts. It does not reserve and it does not project, and
 * `capabilitiesFor` is what says so. So:
 *
 *   · a projected shortage is emitted only where `forecast` is true — without
 *     reservations there is no future demand to walk, and a projection over no
 *     claims is a flat line dressed up as an answer;
 *   · a present shortage is emitted from `counting` up, because a business
 *     that counts can be told what it does not have.
 *
 * `preparation.ts` carries the other half of this rule: what the plan needs is
 * a fact for everybody, and reserving it from stock is a sentence only a
 * `tracked` operation may be shown.
 */

import type { Signal } from '../../types'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { canProjectStock } from '../modules'

export interface ShortageFacts {
  propertyId: string | null
  label: string
  itemId: string
  /** Hebrew. "מגבות גדולות". */
  itemLabel: string
  /** What the requirement asks for, from the preparation engine. */
  required: number
  /** What the property can actually use, from the inventory engine. */
  available: number
  /** `required − available`, as the inventory engine computed it. */
  shortfall: number
  /** The instant the items are needed. `null` means now. */
  neededBy: string | null
  bookingId: string | null
}

export function detectInventory(
  shortages: readonly ShortageFacts[],
  context: DetectorContext,
): Signal[] {
  // Counting is the floor. A business that counts nothing cannot be short of
  // anything it knows about, and telling it otherwise would be inventing a
  // cupboard.
  if (!context.modules.inventory.counting) return []

  const projecting = canProjectStock(context.modules)
  const signals: Signal[] = []

  for (const shortage of shortages) {
    if (shortage.shortfall <= 0) continue

    const future =
      shortage.neededBy !== null &&
      new Date(shortage.neededBy).getTime() > context.now.getTime()

    if (future && !projecting) continue

    const code = future ? 'inventory.projected_shortage' : 'inventory.shortage'

    signals.push({
      code,
      domain: 'inventory',
      risk: future ? 'at_risk' : 'critical',
      resourceType: 'inventory_item',
      resourceId: shortage.itemId,
      propertyId: shortage.propertyId,
      title: `${shortage.label} — חסרים ${shortage.shortfall} ${shortage.itemLabel}`,
      detail: future
        ? `לפי הצפי חסרים ${shortage.shortfall} ${shortage.itemLabel} למועד הנדרש.`
        : `חסרים ${shortage.shortfall} ${shortage.itemLabel} מתוך ${shortage.required} שנדרשים.`,
      evidence: [
        fact('stock.required', 'נדרש', shortage.required, 'preparation'),
        fact('stock.available', 'זמין', shortage.available, 'inventory'),
        fact('stock.shortfall', 'חסר', shortage.shortfall, 'inventory'),
        ...(shortage.neededBy === null
          ? []
          : [
              fact(
                'stock.needed_by',
                'נדרש עד',
                shortage.neededBy,
                'inventory',
                shortage.neededBy,
              ),
            ]),
      ],
      // The item is the aspect and the property is the resource's home. A
      // shortage of towels and a shortage of sheets at one villa are two
      // problems; the same towel shortage seen every five minutes for six
      // hours is one, which is exactly what this key has to survive.
      dedupeKey: signalKey({
        code,
        resourceType: 'property',
        resourceId: shortage.propertyId,
        aspect: shortage.itemId,
      }),
      ...(shortage.neededBy === null ? {} : { dueAt: shortage.neededBy }),
    })
  }

  return signals
}
