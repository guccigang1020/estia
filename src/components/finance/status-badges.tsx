/**
 * The three finance ladders, named in Hebrew and grouped by what they mean.
 *
 * Every label comes from the domain — `PAYMENT_STATUS_LABEL` and
 * `COMMISSION_STATUS_LABEL` are total records over their contracts, so a status
 * added without a Hebrew name fails the build instead of rendering
 * `partially_refunded` at a guesthouse owner. Nothing here maps a status to
 * text of its own; the tone is the only judgement, and it is made in
 * `finance/_lib/labels.ts` where a test can reach it.
 *
 * ── `unknown` is the reason this file exists rather than one shared badge ──
 *
 * A processor that timed out has left the business unable to say whether the
 * card was charged. That is not a failure and must not look like one: it is
 * the one payment status that leaves the neutral palette, it is not struck
 * through — struck-through text reads as "this is over", and an unknown
 * payment is the one row still waiting for somebody — and the screens above it
 * count such rows out loud rather than leaving them to be spotted.
 *
 * Colour is never the only signal. The word is always rendered.
 *
 * No `"use client"`: these render text.
 */

import {
  commissionStatusTone,
  commissionStatusVoided,
  invoiceStatusTone,
  paymentStatusTone,
  paymentStatusVoided,
} from '@/app/(app)/finance/_lib/labels'
import { INVOICE_STATUS_LABEL } from '@/app/(app)/finance/_lib/labels'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import type { CommissionStatus, PaymentStatus } from '@/lib/contracts/states'
import {
  COMMISSION_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  type InvoiceStatus,
} from '@/lib/finance'

export function PaymentStatusBadge({
  status,
  className,
}: {
  status: PaymentStatus
  className?: string
}) {
  return (
    <Badge
      tone={paymentStatusTone(status)}
      className={cn(
        paymentStatusVoided(status) && 'line-through opacity-70',
        className,
      )}
    >
      {PAYMENT_STATUS_LABEL[status]}
    </Badge>
  )
}

export function InvoiceStatusBadge({
  status,
  className,
}: {
  status: InvoiceStatus
  className?: string
}) {
  return (
    <Badge
      tone={invoiceStatusTone(status)}
      className={cn(
        status === 'cancelled' && 'line-through opacity-70',
        className,
      )}
    >
      {INVOICE_STATUS_LABEL[status]}
    </Badge>
  )
}

export function CommissionStatusBadge({
  status,
  className,
}: {
  status: CommissionStatus
  className?: string
}) {
  return (
    <Badge
      tone={commissionStatusTone(status)}
      className={cn(
        commissionStatusVoided(status) && 'line-through opacity-70',
        className,
      )}
    >
      {COMMISSION_STATUS_LABEL[status]}
    </Badge>
  )
}
