/**
 * One cell of the policy matrix — and, when the platform forbids it, the
 * reason printed in the cell itself.
 *
 * ── A ceiling the customer cannot see is a ceiling they fight ────────────
 *
 * `autopilot_safety_rules` caps `business_impact` and
 * `money_access_cancellation` at `ask_approval` for every customer on every
 * package, and no tenant role may write the table. A matrix that rendered
 * `auto` as an ordinary choice for those actions would let somebody select it,
 * save, watch nothing change, select it again, and eventually conclude the
 * product is broken. 0046's own policy grants every reader `select` on the
 * safety rules for exactly this: so the ceiling can be shown.
 *
 * So a blocked cell is `aria-disabled`, visibly struck through, and carries
 * the rule's stored `reason` — which is a sentence ESTIA wrote about refunds
 * and locked doors, not a rule id.
 *
 * ── This component decides nothing ───────────────────────────────────────
 *
 * `state` arrives already resolved. The comparison "is `auto` above this
 * action's ceiling" is an ordinal test over `AUTOPILOT_DISPOSITIONS` against
 * rows in a platform table, and doing it in a component would put a second
 * copy of the safety floor in the browser — where it would be the copy that
 * disagrees. See `settings/_lib/ceiling.ts`, which reads the rules on the
 * server, and the integration note there.
 *
 * ── There is no `<input>` here ───────────────────────────────────────────
 *
 * The matrix is rendered read-only until the configuration write path exists.
 * A radio that posts nowhere is a control that loses the customer's afternoon,
 * which is the failure this whole file is about.
 *
 * No `'use client'`.
 */

import { cn } from '@/components/ui/cn'
import type { AutopilotDisposition } from '@/lib/contracts/states'

import { DISPOSITION_LABEL, DISPOSITION_MEANING } from './labels'

export type CellState =
  /** What this organization has chosen for this action. */
  | 'selected'
  /** A choice they could move to. */
  | 'available'
  /** Above the platform ceiling. Never selectable, on any package. */
  | 'blocked'

export type PolicyMatrixCellProps = {
  disposition: AutopilotDisposition
  state: CellState
  /** The safety rule's own words. Required when `state` is `blocked`. */
  blockedReason?: string
}

const CLASS: Record<CellState, string> = {
  selected: 'border-primary bg-primary-soft text-primary font-semibold',
  available: 'border-border bg-surface text-muted-foreground',
  blocked:
    'border-dashed border-border bg-muted text-muted-foreground line-through decoration-muted-foreground/60',
}

export function PolicyMatrixCell({
  disposition,
  state,
  blockedReason,
}: PolicyMatrixCellProps) {
  const label = DISPOSITION_LABEL[disposition]

  return (
    <div
      aria-disabled={state === 'blocked' || undefined}
      // The whole cell carries the sentence, so a screen reader hears why the
      // option is unavailable rather than only that it is.
      aria-label={
        state === 'blocked'
          ? `${label} — לא זמין. ${blockedReason ?? ''}`
          : `${label} — ${DISPOSITION_MEANING[disposition]}`
      }
      title={
        state === 'blocked' ? blockedReason : DISPOSITION_MEANING[disposition]
      }
      className={cn(
        'flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg border px-2 py-1.5 text-center text-xs',
        CLASS[state],
      )}
    >
      <span>{label}</span>
      {state === 'blocked' && (
        <span className="text-[0.625rem] leading-tight no-underline">
          חסום ע״י ESTIA
        </span>
      )}
    </div>
  )
}

/**
 * The reason, in full, under the row it applies to.
 *
 * The cell carries the sentence for a screen reader and a hover; this prints
 * it where somebody scanning the matrix will actually read it. Both, because
 * a `title` attribute is invisible on a touch screen and this product is used
 * on a phone in a corridor.
 */
export function CeilingNote({ reason }: { reason: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground">תקרת ESTIA:</span> {reason}
    </p>
  )
}
