/**
 * The price of a stay, explained.
 *
 * EVERY NUMBER ON THIS COMPONENT CAME OUT OF `priceStay`. The lines are its
 * lines, the total is `sumLines(lines)` by construction, and the deposit and
 * the VAT figure are fields it returned. Nothing is added up here, so the
 * breakdown and the total cannot drift — which is the whole reason the pricing
 * engine returns lines rather than a number with an explanation beside it.
 *
 * `formatAgorot` from `src/lib/plans/plan.ts` is the product's one money
 * formatter; a second one here would eventually render ₪1,234.5.
 */

import { formatAgorot } from '@/lib/plans/plan'
import type { PriceLine } from '@/lib/booking/types'

export type QuoteBreakdownProps = {
  lines: readonly PriceLine[]
  totalAgorot: number
  stayTotalAgorot: number
  depositAgorot: number
  /** VAT charged as its own line. Zero when the rates already contain it. */
  taxAgorot: number
  /** VAT contained in a tax-inclusive total, or `null` when it is a line. */
  taxIncludedAgorot: number | null
}

export function QuoteBreakdown({
  lines,
  totalAgorot,
  stayTotalAgorot,
  depositAgorot,
  taxAgorot,
  taxIncludedAgorot,
}: QuoteBreakdownProps) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1.5">
        {lines.map((line, index) => (
          <li
            key={`${line.kind}-${line.date ?? index}`}
            className="flex items-baseline justify-between gap-4 text-sm"
          >
            <span className="min-w-0 text-muted-foreground">{line.label}</span>
            <span
              dir="ltr"
              className="shrink-0 font-medium text-foreground tabular-nums"
            >
              {formatAgorot(line.amount)}
            </span>
          </li>
        ))}
      </ul>

      <dl className="flex flex-col gap-1.5 border-t border-border pt-3 text-sm">
        {depositAgorot > 0 && (
          <Row label="מתוכם פיקדון מוחזר" value={depositAgorot} muted />
        )}
        {taxIncludedAgorot !== null && (
          <Row label="מתוכם מע״מ" value={taxIncludedAgorot} muted />
        )}
        {taxAgorot > 0 && <Row label="מע״מ" value={taxAgorot} muted />}
        <Row label="עלות השהות" value={stayTotalAgorot} muted />
        <Row label="סך הכול לתשלום" value={totalAgorot} />
      </dl>
    </div>
  )
}

function Row({
  label,
  value,
  muted = false,
}: {
  label: string
  value: number
  muted?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={muted ? 'text-muted-foreground' : 'font-semibold'}>
        {label}
      </dt>
      <dd
        dir="ltr"
        className={
          muted
            ? 'text-muted-foreground tabular-nums'
            : 'font-display text-lg font-bold text-foreground tabular-nums'
        }
      >
        {formatAgorot(value)}
      </dd>
    </div>
  )
}
