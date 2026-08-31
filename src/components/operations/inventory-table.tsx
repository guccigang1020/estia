/**
 * Stock by item and location, and the ledger that produced it.
 *
 * ── Three quantities, not one ─────────────────────────────────────────────
 *
 * "34 סטים" is not an answer to "can I promise twenty of these to the wedding
 * on Friday". What is *held*, what is already *promised* and what is therefore
 * *free* are three facts, and `quantity_reserved` exists in 0011 precisely so
 * the third can be computed. A table printing only the first shows sufficient
 * stock right up to the morning both events need it.
 *
 * ── The reorder point is on the row, not in a separate report ─────────────
 *
 * `min_quantity` is where somebody has to order more. A shortage noticed when a
 * cleaner opens an empty cupboard has already cost a changeover, so the row
 * says so where the row is read. An item nobody set a minimum for is not short
 * and is not marked — a permanent warning is a warning nobody reads.
 *
 * ── The ledger is append-only and shown as such ───────────────────────────
 *
 * `inventory_movements` refuses UPDATE and DELETE at the database. A correction
 * is a compensating row, so "we thought we had forty and we have thirty-two" is
 * still on the list underneath the count that replaced it. Signed deltas are
 * printed with their sign for the same reason.
 *
 * No `"use client"`: rows in, markup out.
 */

import type {
  InventoryListItem,
  InventoryMovement,
} from '@/app/(app)/inventory/_lib/queries'
import { Money } from '@/components/finance/money'
import { cn } from '@/components/ui/cn'
import { formatDayMonthYear } from '@/lib/booking'

import {
  INVENTORY_STATE_LABEL,
  InventoryStateBadge,
  MOVEMENT_KIND_LABEL,
  isUnusable,
} from './inventory-state'
import { Absent, Cell, Td, Th } from './table-parts'

export function InventoryTable({
  items,
  caption,
}: {
  items: readonly InventoryListItem[]
  caption: string
}) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {items.map((item) => (
          <li
            key={item.id}
            className={cn(
              'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft',
              isShort(item) && 'border-s-4 border-s-warning',
              isUnusable(item.state) && 'border-s-4 border-s-danger',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-display text-base font-bold text-foreground">
                {item.name}
              </span>
              <InventoryStateBadge state={item.state} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="מיקום">
                <Where item={item} />
              </Cell>
              <Cell label="במלאי">
                <Quantities item={item} />
              </Cell>
              <Cell label="נקודת הזמנה">
                <Reorder item={item} />
              </Cell>
              <Cell label="שווי">
                <Money agorot={item.valueAgorot} emphasis />
              </Cell>
            </dl>

            <Shortage item={item} />
          </li>
        ))}
      </ul>

      {/* -------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft sm:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 border-collapse text-start text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>פריט</Th>
                <Th>מיקום</Th>
                <Th>מצב</Th>
                <Th align="end">במלאי</Th>
                <Th align="end">פנוי</Th>
                <Th align="end">שווי</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={cn(
                    'transition-colors hover:bg-muted',
                    isShort(item) && 'border-s-4 border-s-warning',
                    isUnusable(item.state) &&
                      'border-s-4 border-s-danger bg-danger/5',
                  )}
                >
                  <Td>
                    <span className="font-medium text-foreground">
                      {item.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {item.sku !== null && (
                        <span dir="ltr" className="font-mono">
                          {item.sku}
                        </span>
                      )}
                      {item.sku !== null && item.category !== null && ' · '}
                      {item.category}
                    </span>
                  </Td>
                  <Td>
                    <Where item={item} />
                  </Td>
                  <Td>
                    <InventoryStateBadge state={item.state} />
                    <Counted item={item} />
                  </Td>
                  <Td align="end">
                    <span className="font-semibold tabular-nums">
                      {item.quantity}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {item.unitOfMeasure}
                    </span>
                    <Shortage item={item} />
                  </Td>
                  <Td align="end">
                    <span className="tabular-nums">{item.quantityFree}</span>
                    {item.quantityReserved > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        משוריין {item.quantityReserved}
                      </span>
                    )}
                  </Td>
                  <Td align="end">
                    <Money agorot={item.valueAgorot} emphasis />
                    {item.unitCostAgorot !== undefined &&
                      item.unitCostAgorot !== null && (
                        <span className="block text-xs text-muted-foreground">
                          ליחידה <Money agorot={item.unitCostAgorot} />
                        </span>
                      )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/**
 * The stock ledger, newest first.
 *
 * A list rather than a table: it is a narrative — what moved, how much, why and
 * when — and it is read down rather than across. Rendered identically on both
 * sizes for that reason.
 */
export function MovementList({
  movements,
}: {
  movements: readonly InventoryMovement[]
}) {
  return (
    <ol className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-soft">
      {movements.map((movement) => (
        <li key={movement.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-foreground">
              {movement.itemName ?? 'פריט שאינו זמין לך'}
            </span>
            <span
              className={cn(
                'font-semibold tabular-nums',
                movement.quantityDelta < 0 ? 'text-warning' : 'text-success',
              )}
            >
              {/* The sign is printed, not implied by colour. */}
              {movement.quantityDelta > 0 ? '+' : ''}
              {movement.quantityDelta}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{MOVEMENT_KIND_LABEL[movement.kind]}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDayMonthYear(movement.occurredOn)}</span>
            {movement.toState !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {movement.fromState === null
                    ? INVENTORY_STATE_LABEL[movement.toState]
                    : `${INVENTORY_STATE_LABEL[movement.fromState]} ← ${
                        INVENTORY_STATE_LABEL[movement.toState]
                      }`}
                </span>
              </>
            )}
          </div>

          {movement.reason !== null && (
            <p className="max-w-prose text-xs text-muted-foreground">
              {movement.reason}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}

/* ------------------------------------------------------------ fragments -- */

function isShort(item: InventoryListItem): boolean {
  return item.minQuantity !== null && item.quantity <= item.minQuantity
}

function Where({ item }: { item: InventoryListItem }) {
  const place = item.location ?? item.unitName ?? item.propertyName
  if (place === null) return <Absent />

  return (
    <span className="flex flex-col">
      <span>{place}</span>
      {item.propertyName !== null && place !== item.propertyName && (
        <span className="text-xs text-muted-foreground">
          {item.propertyName}
        </span>
      )}
    </span>
  )
}

function Quantities({ item }: { item: InventoryListItem }) {
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">
        {item.quantity} {item.unitOfMeasure}
      </span>
      <span className="text-xs text-muted-foreground">
        פנוי {item.quantityFree}
        {item.quantityReserved > 0 && ` · משוריין ${item.quantityReserved}`}
      </span>
    </span>
  )
}

function Reorder({ item }: { item: InventoryListItem }) {
  if (item.minQuantity === null) {
    return <span className="text-muted-foreground">לא הוגדרה</span>
  }
  return (
    <span className="tabular-nums">
      {item.minQuantity}
      {item.parLevel !== null && (
        <span className="text-xs text-muted-foreground">
          {' '}
          (יעד {item.parLevel})
        </span>
      )}
    </span>
  )
}

/**
 * The sentence a shortage is worth, on the row where it is read.
 *
 * "יש להזמין" rather than a coloured number: the person reading this has to
 * decide whether to telephone the supplier this morning, and a tint does not
 * tell them that.
 */
function Shortage({ item }: { item: InventoryListItem }) {
  if (!isShort(item)) return null
  return (
    <span className="mt-1 block text-xs font-medium text-warning">
      מתחת לנקודת ההזמנה ({item.minQuantity}) — יש להזמין
    </span>
  )
}

function Counted({ item }: { item: InventoryListItem }) {
  if (item.lastCountedOn === null) {
    return (
      <span className="mt-1 block text-xs text-muted-foreground">
        לא נספר מעולם
      </span>
    )
  }
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      נספר {formatDayMonthYear(item.lastCountedOn)}
    </span>
  )
}
