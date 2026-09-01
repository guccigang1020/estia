/**
 * Checking the plan against what the business actually owns.
 *
 * A requirement list is a wish until someone counts the cupboard. This file
 * does the counting: required against available, shortage against safety
 * stock, and — for a business with more than one property — what could be
 * moved instead of bought.
 *
 * ── Available is not on hand ──────────────────────────────────────────────
 *
 * `available = onHand − reserved`. Stock promised to Saturday's booking is not
 * stock for Friday's, and a check that reads `onHand` will cheerfully tell
 * both bookings that the pillows are there. Reservation is what makes the
 * answer true for the second caller as well as the first.
 *
 * ── Safety stock is a floor, not a threshold ──────────────────────────────
 *
 * The floor exists for the booking the business has not taken yet. Breaching
 * it is a decision a manager is entitled to make; making it without being told
 * is not. So a breach never blocks the plan — it raises a warning that names
 * the item and the number.
 */

import type { InventoryState } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import type {
  InventoryAlert,
  InventoryCheck,
  InventoryLine,
  ProcurementTask,
  Requirement,
  StockLevel,
  StockLocation,
  TransferSuggestion,
} from './types'

/**
 * Units that are people or time rather than things.
 *
 * Two cleaning staff is a real requirement and a real cost, and it is not a
 * shortage of staff in a cupboard. Running it through the stock check would
 * produce a procurement task to buy a person.
 */
const NON_STOCK_UNITS = new Set(['person', 'hour'])

// ── The check ─────────────────────────────────────────────────────────────

export interface InventoryCheckInput {
  requirements: readonly Requirement[]
  /** What is held where the booking is. */
  stock: readonly StockLevel[]
  /** What is held elsewhere and could be transferred in. */
  elsewhere?: readonly StockLevel[]
  destination: StockLocation
  /** ISO date the goods have to be present by. */
  neededBy: string
}

export function checkInventory(input: InventoryCheckInput): InventoryCheck {
  const { requirements, stock, destination, neededBy } = input
  const elsewhere = input.elsewhere ?? []

  const local = totalsByItem(stock)
  const lines: InventoryLine[] = []
  const alerts: InventoryAlert[] = []
  const transfers: TransferSuggestion[] = []
  const procurement: ProcurementTask[] = []

  // Remaining surplus per source location, mutated as transfers are proposed,
  // so two short items cannot both be promised the same three pillows.
  const surplus = new Map<StockLevel, number>(
    elsewhere.map((level) => [level, surplusOf(level)]),
  )

  for (const requirement of stockable(requirements)) {
    const held = local.get(requirement.itemId)
    const onHand = held?.onHand ?? 0
    const reserved = held?.reserved ?? 0
    const safetyStock = held?.safetyStock ?? 0
    const available = onHand - reserved
    const shortage = Math.max(0, requirement.quantity - available)
    const breachesSafetyStock =
      shortage === 0 && available - requirement.quantity < safetyStock

    lines.push({
      itemId: requirement.itemId,
      label: requirement.label,
      required: requirement.quantity,
      available,
      shortage,
      safetyStock,
      breachesSafetyStock,
    })

    if (breachesSafetyStock) {
      alerts.push({
        itemId: requirement.itemId,
        severity: 'warning',
        shortage: 0,
        message: `${requirement.label}: הכמות שתישאר יורדת מתחת למלאי הביטחון (${safetyStock}).`,
      })
    }

    if (shortage === 0) continue

    alerts.push({
      itemId: requirement.itemId,
      severity: 'critical',
      shortage,
      message: `${requirement.label}: נדרשים ${requirement.quantity}, זמינים ${available}. חסרים ${shortage}.`,
    })

    let outstanding = shortage
    for (const source of sourcesFor(elsewhere, requirement.itemId)) {
      if (outstanding <= 0) break
      const spare = surplus.get(source) ?? 0
      if (spare <= 0) continue

      const quantity = Math.min(spare, outstanding)
      transfers.push({
        itemId: requirement.itemId,
        from: source.location,
        to: destination,
        quantity,
      })
      surplus.set(source, spare - quantity)
      outstanding -= quantity
    }

    if (outstanding > 0) {
      procurement.push({
        itemId: requirement.itemId,
        label: requirement.label,
        quantity: outstanding,
        neededBy,
      })
    }
  }

  return {
    lines,
    alerts,
    transfers,
    procurement,
    satisfied: alerts.length === 0,
  }
}

function stockable(
  requirements: readonly Requirement[],
): readonly Requirement[] {
  return requirements.filter(
    (requirement) =>
      !NON_STOCK_UNITS.has(requirement.unit) && requirement.quantity > 0,
  )
}

interface ItemTotal {
  onHand: number
  reserved: number
  safetyStock: number
}

/**
 * Several stock rows for one item at one place, added up.
 *
 * A property that records linen in two cupboards has two rows and one
 * cupboard's worth of sheets is not the answer to "do we have enough".
 */
function totalsByItem(
  stock: readonly StockLevel[],
): ReadonlyMap<string, ItemTotal> {
  const totals = new Map<string, ItemTotal>()

  for (const level of stock) {
    const existing = totals.get(level.itemId) ?? {
      onHand: 0,
      reserved: 0,
      safetyStock: 0,
    }
    totals.set(level.itemId, {
      onHand: existing.onHand + level.onHand,
      reserved: existing.reserved + level.reserved,
      safetyStock: existing.safetyStock + level.safetyStock,
    })
  }

  return totals
}

/**
 * What a location can give away without breaching its own floor.
 *
 * Solving one property's shortage by creating another's is not a solution, so
 * the source's safety stock is subtracted before anything is offered.
 */
function surplusOf(level: StockLevel): number {
  return Math.max(0, level.onHand - level.reserved - level.safetyStock)
}

/**
 * Where to look for a transfer, warehouse first.
 *
 * A central warehouse exists to be drawn on; another property's cupboard is
 * somebody's working stock, and taking from it is the second choice even when
 * the arithmetic is identical.
 */
function sourcesFor(
  elsewhere: readonly StockLevel[],
  itemId: string,
): readonly StockLevel[] {
  return elsewhere
    .filter((level) => level.itemId === itemId && surplusOf(level) > 0)
    .sort((a, b) => {
      const left = a.location.kind === 'warehouse' ? 0 : 1
      const right = b.location.kind === 'warehouse' ? 0 : 1
      if (left !== right) return left - right
      return surplusOf(b) - surplusOf(a)
    })
}

// ── The linen lifecycle ───────────────────────────────────────────────────

/**
 * The only moves a linen set may make.
 *
 * The *states* are the product's shared `INVENTORY_STATES` — linen is stock
 * like anything else, and a second inventory vocabulary is the failure the
 * frozen contract exists to prevent. What is genuinely linen-specific is the
 * loop: nothing else in a guest house leaves the building, comes back and is
 * usable again. That loop is this table.
 *
 * It is a table rather than conditions scattered through the code that moves
 * stock, for the reason the charter gives: a status anything may write is a
 * status nobody can trust. Sheets that jump from `in_use` straight back to
 * `available` are sheets a guest slept in being handed to the next guest, and
 * the only defence against it is that the transition does not exist.
 *
 * Two paths out of the happy loop, both real. `reserved → available` is the
 * release: a booking cancelled before check-in gives its linen back untouched.
 * `damaged` is reachable from anywhere the damage is discovered, and leads
 * only out of service — a torn sheet must not be able to rejoin the cycle by
 * being washed.
 *
 * The specification described this as seven steps, ending
 * `laundry → clean → available`. `clean` is the moment of that last
 * transition rather than a state of its own; see the note in `types.ts`.
 */
export const LINEN_TRANSITIONS: Readonly<
  Record<InventoryState, readonly InventoryState[]>
> = {
  available: ['reserved', 'damaged', 'lost'],
  reserved: ['in_use', 'available'],
  in_use: ['dirty', 'damaged', 'lost'],
  dirty: ['laundry', 'damaged', 'lost'],
  // Two ways home, and both are real. A business that tracks the van marks
  // the batch 'returning' when it leaves the laundry, which is what lets a
  // forecast answer "will these be here by Friday afternoon". One that does
  // not simply marks them available when they land on the shelf.
  laundry: ['returning', 'available', 'damaged', 'lost'],
  returning: ['available', 'damaged', 'lost'],
  damaged: ['out_of_service'],
  out_of_service: [],
  // Terminal. An item that turns up again is a receipt, counted in, with a
  // movement row saying so — not a state machine quietly reversing itself.
  lost: [],
}

export function canTransitionLinen(
  from: InventoryState,
  to: InventoryState,
): boolean {
  return LINEN_TRANSITIONS[from].includes(to)
}

export function assertLinenTransition(
  from: InventoryState,
  to: InventoryState,
): void {
  if (canTransitionLinen(from, to)) return

  throw new BusinessRuleError({
    code: 'linen_transition_not_allowed',
    message: `Linen cannot move from ${from} to ${to}`,
    userMessage: 'לא ניתן להעביר את המצעים למצב הזה מהמצב הנוכחי.',
    publicDetails: { from, to },
  })
}
