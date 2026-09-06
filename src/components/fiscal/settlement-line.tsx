/**
 * §148 on screen: the money and the paperwork, side by side, never merged.
 *
 * The component takes a `SettlementView` and nothing else. It has no props for
 * "is this complete" and no branch that decides completeness for itself — the
 * only thing it can render as issued is a `fiscal.state === 'issued'`, which
 * the domain will only produce when a vendor supplied a document number. A
 * component with a `complete` boolean prop would be a second opinion, and it
 * would be the one on screen.
 *
 * Two badges rather than one, because "תשלום נרשם · מסמך חשבונאי ממתין" is two
 * facts and a single badge would have to pick one of them to be wrong about.
 *
 * No `"use client"`: it renders text.
 */

import { Badge, type BadgeTone } from '@/components/ui/badge'
import {
  fiscalLabel,
  moneyLabel,
  type FiscalSide,
  type MoneySide,
  type SettlementView,
} from '@/lib/fiscal'

/**
 * Tone is about attention, not about approval.
 *
 * `accent` is used for exactly the states where a person has to do something,
 * so a list scanned quickly shows the work rather than the health. Money that
 * arrived and paperwork that is done are both quiet.
 */
const MONEY_TONE: Record<MoneySide['state'], BadgeTone> = {
  not_received: 'neutral',
  received: 'brand',
  refunded: 'neutral',
  unknown: 'accent',
}

const FISCAL_TONE: Record<FiscalSide['state'], BadgeTone> = {
  not_required: 'neutral',
  pending: 'neutral',
  retrying: 'neutral',
  needs_review: 'accent',
  unknown: 'accent',
  issued: 'brand',
  cancelled: 'neutral',
  credited: 'neutral',
}

export function SettlementLine({ view }: { view: SettlementView }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={MONEY_TONE[view.money.state]}>
          {moneyLabel(view.money)}
        </Badge>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <Badge tone={FISCAL_TONE[view.fiscal.state]}>
          {fiscalLabel(view.fiscal)}
        </Badge>
      </div>

      {/*
       * The number, only where the union carries one. There is no fallback to
       * an id, an ellipsis or an empty string: a document number is what a
       * business searches its accounting system by, and anything printed in
       * that position that is not one is worse than nothing.
       */}
      {view.fiscal.state === 'issued' && (
        <p className="text-sm text-muted-foreground">
          מסמך{' '}
          <span dir="ltr" className="font-mono">
            {view.fiscal.documentNumber}
          </span>
          {view.fiscal.issueDate !== null && ` · ${view.fiscal.issueDate}`}
        </p>
      )}

      {(view.fiscal.state === 'needs_review' ||
        view.fiscal.state === 'unknown' ||
        view.fiscal.state === 'retrying') && (
        <p className="text-sm text-muted-foreground">{view.fiscal.reason}</p>
      )}
    </div>
  )
}
