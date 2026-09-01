/**
 * The three-column quantity, on screen.
 *
 * `calculated`, `adjustment` and `final` are stored separately and the
 * calculated figure is never destroyed — the argument is in
 * `src/lib/laundry/override.ts` and the database enforces it with a generated
 * column. This is the screen half of the same idea: a line that a person
 * changed shows BOTH numbers and the reason, rather than the final figure with
 * a pencil icon beside it.
 *
 * The pencil-icon version is the one that loses the argument three weeks
 * later. "Did we send the wrong number, or did the engine" is answerable only
 * if both numbers are visible at once, and a reader who has to hover, click or
 * open a history panel to see the engine's figure is a reader who will not.
 */

import { Badge } from '@/components/ui/badge'
import type { OrderLineQuantity, RequirementUnit } from '@/lib/laundry'

const UNIT_LABEL: Readonly<Record<RequirementUnit, string>> = {
  piece: 'יח׳',
  set: 'מערכות',
  pack: 'חבילות',
  person: 'לאדם',
  hour: 'שעות',
}

export type QuantityProps = {
  quantity: OrderLineQuantity
  unit: RequirementUnit
}

export function Quantity({ quantity, unit }: QuantityProps) {
  const adjusted = quantity.adjustment !== 0
  const sign = quantity.adjustment > 0 ? '+' : ''

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-display text-lg font-bold tabular-nums text-foreground">
          {quantity.final}
        </span>
        <span className="text-xs text-muted-foreground">
          {UNIT_LABEL[unit]}
        </span>
        {adjusted && <Badge tone="accent">שונה ידנית</Badge>}
      </div>

      {adjusted && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {/* Both numbers, always, side by side. */}
          <span>
            חישוב המערכת:{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {quantity.calculated}
            </span>
            {' · '}
            שינוי:{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {sign}
              {quantity.adjustment}
            </span>
          </span>
          {/* The reason is mandatory in the database and shown here without a
              fallback: a blank would mean a constraint was bypassed, and an
              invented "no reason given" would hide that. */}
          {quantity.reason !== null && (
            <span>
              הנימוק: <span className="text-foreground">{quantity.reason}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
