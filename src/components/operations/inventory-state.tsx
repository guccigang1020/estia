/**
 * Where a physical item is in its cycle, named in Hebrew.
 *
 * The labels are a total `Record<InventoryState, …>` over the frozen vocabulary
 * in `src/lib/contracts/states.ts`, so a state added to the contract fails the
 * build here rather than rendering `out_of_service` at a housekeeper. Nothing
 * in this file invents a state name — this is the same discipline
 * `components/preparation/task-status.tsx` applies to `TASK_STATUSES`.
 *
 * ── Three of the seven are not "stock you have" ───────────────────────────
 *
 * `available` is the only allocatable state — `ALLOCATABLE_INVENTORY_STATES`
 * says so — and `reserved` is the one that stops two events being promised the
 * same twenty mattresses. `damaged` and `out_of_service` are stock that exists
 * and cannot be used, which is a different sentence from "we are short" and has
 * to look different: they carry the danger outline rather than a quieter badge,
 * because a cupboard that looks full of broken things is how a changeover
 * fails.
 *
 * `dirty` and `laundry` are in transit and will come back. They are warned
 * about, not alarmed about.
 *
 * No `"use client"`: it renders text.
 */

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import type { InventoryMovementKind } from '@/app/(app)/inventory/_lib/queries'
import type { InventoryState } from '@/lib/contracts/states'

export const INVENTORY_STATE_LABEL: Readonly<Record<InventoryState, string>> = {
  available: 'זמין',
  reserved: 'משוריין',
  in_use: 'בשימוש',
  dirty: 'מלוכלך',
  laundry: 'בכביסה',
  damaged: 'פגום',
  out_of_service: 'הוצא משימוש',
}

/** `public.inventory_movement_kind`, 0011. Total over the tuple beside it. */
export const MOVEMENT_KIND_LABEL: Readonly<
  Record<InventoryMovementKind, string>
> = {
  receipt: 'קליטה',
  issue: 'הוצאה',
  transfer: 'העברה',
  return: 'החזרה',
  adjustment: 'תיקון ספירה',
  loss: 'אובדן',
  count: 'ספירה',
}

/** Stock that exists and cannot be used. Not the same as being short of it. */
const UNUSABLE = new Set<InventoryState>(['damaged', 'out_of_service'])

/** Stock that is out of the cupboard and coming back. */
const IN_TRANSIT = new Set<InventoryState>(['dirty', 'laundry'])

export function isUnusable(state: InventoryState): boolean {
  return UNUSABLE.has(state)
}

function toneFor(state: InventoryState): BadgeTone {
  if (state === 'available') return 'accent'
  if (state === 'reserved' || state === 'in_use') return 'brand'
  return 'neutral'
}

export function InventoryStateBadge({
  state,
  className,
}: {
  state: InventoryState
  className?: string
}) {
  if (UNUSABLE.has(state)) {
    return (
      <Badge
        tone="neutral"
        className={cn(
          'border border-danger bg-surface font-bold text-danger',
          className,
        )}
      >
        {/* Colour is never the only signal in this product. */}
        <span aria-hidden="true">■</span>
        {INVENTORY_STATE_LABEL[state]}
      </Badge>
    )
  }

  return (
    <Badge
      tone={toneFor(state)}
      className={cn(IN_TRANSIT.has(state) && 'text-warning', className)}
    >
      {INVENTORY_STATE_LABEL[state]}
    </Badge>
  )
}
