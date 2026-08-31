/**
 * An amount of money, or the reason there is no amount.
 *
 * ── The whole point of this component ─────────────────────────────────────
 *
 * `redact()` deletes the key. A screen that then wrote `{payment.amountAgorot}`
 * would render nothing at all, and an empty cell in a money column reads as
 * ₪0 — a number, and a wrong one. This is the one place that decides what an
 * absent amount looks like, and it says so in words.
 *
 * `undefined` means "withheld from this reader". `null` means "there is no
 * such amount", which is a different sentence and is spelled with an en dash
 * rather than a claim about permissions.
 *
 * Money arrives as integer agorot and is formatted here and only here.
 * `formatAgorot` is the product's one ₪ formatter; nothing in this directory
 * divides by 100.
 *
 * No `"use client"`: a number in, markup out.
 */

import { WITHHELD } from '@/app/(app)/finance/_lib/labels'
import { cn } from '@/components/ui/cn'
import { formatAgorot } from '@/lib/plans/plan'

export function Money({
  agorot,
  className,
  emphasis = false,
}: {
  /** Integer agorot; `undefined` when redacted; `null` when there is none. */
  agorot: number | null | undefined
  className?: string
  emphasis?: boolean
}) {
  if (agorot === undefined) {
    return (
      <span className={cn('text-muted-foreground', className)}>{WITHHELD}</span>
    )
  }

  if (agorot === null) {
    return (
      <span
        aria-label="אין סכום"
        className={cn('text-muted-foreground', className)}
      >
        –
      </span>
    )
  }

  return (
    <span
      className={cn(
        'tabular-nums',
        emphasis && 'font-semibold',
        // A negative amount is a credit. Coloured because it is the line a
        // reader scanning for "why is this less" is looking for — and it still
        // carries its minus sign, so colour is never the only signal.
        agorot < 0 && 'text-success',
        className,
      )}
    >
      {formatAgorot(agorot)}
    </span>
  )
}
