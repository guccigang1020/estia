/**
 * A booking's status, named in Hebrew and grouped by what it means.
 *
 * The label comes from `BOOKING_STATUS_LABEL`, which is a total record over
 * `BookingStatus` — so a status added to the contract without a Hebrew name
 * fails the build instead of rendering `deposit_release` at a guesthouse
 * owner. Nothing here maps a status to text of its own.
 *
 * The tone is the only judgement this file makes, and it is deliberately
 * coarse: three groups, not nineteen colours. Colour is never the only signal
 * — the word is always there — so the grouping is an aid to scanning a list,
 * not information a colour-blind reader has to decode.
 *
 * No `"use client"`: it renders text.
 */

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import {
  OCCUPYING_STATUSES,
  TERMINAL_STATUSES,
  type BookingStatus,
} from '@/lib/booking/types'
import { BOOKING_STATUS_LABEL } from '@/lib/booking/state-machine'

const OCCUPYING = new Set<BookingStatus>(OCCUPYING_STATUSES)
const TERMINAL = new Set<BookingStatus>(TERMINAL_STATUSES)

/**
 * `cancelled` and `no_show` are the two a person scanning a list must never
 * mistake for a live booking, so they are the only ones that leave the neutral
 * palette for a muted, struck-through treatment. `completed` is terminal and
 * benign, and is left neutral rather than dressed as a failure.
 */
function toneFor(status: BookingStatus): BadgeTone {
  if (status === 'cancelled' || status === 'no_show') return 'neutral'
  if (OCCUPYING.has(status)) return 'brand'
  return 'neutral'
}

export function BookingStatusBadge({
  status,
  className,
}: {
  status: BookingStatus
  className?: string
}) {
  const isVoided = status === 'cancelled' || status === 'no_show'

  return (
    <Badge
      tone={toneFor(status)}
      className={cn(isVoided && 'line-through opacity-70', className)}
    >
      {BOOKING_STATUS_LABEL[status]}
    </Badge>
  )
}

/** Does this status hold the calendar? Used to explain a list, never to decide. */
export function occupiesCalendar(status: BookingStatus): boolean {
  return OCCUPYING.has(status)
}

export function isTerminal(status: BookingStatus): boolean {
  return TERMINAL.has(status)
}
