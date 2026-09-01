/**
 * One run, as a card.
 *
 * ── The per-property breakdown is on the card, not behind it ──────────────
 *
 * A consolidated order shows every property and its own line count, in the
 * list, without opening anything. The specification's rule is that the
 * breakdown is never collapsed into a total, and a card that showed "74
 * מערכות מצעים" with the split one click away has collapsed it — the person
 * scanning a list of Thursday's runs is exactly the person who needs to see
 * that two houses are involved.
 *
 * ── What a card does not show ─────────────────────────────────────────────
 *
 * No guest, no booking reference, no money. Not because the card omits them
 * but because `LaundryOrder` does not carry them; see the header of
 * `src/lib/laundry/types.ts`. The provider's NAME is passed in separately and
 * is `null` for anybody without `laundry.provider_manage` — a cleaner sees the
 * run and not who is washing it.
 */

import { Badge } from '@/components/ui/badge'
import type { LaundryOrder, LaundryStatus } from '@/lib/laundry'
import { TERMINAL_LAUNDRY_STATUSES } from '@/lib/contracts/states'

export type OrderCardProps = {
  order: LaundryOrder
  /** Hebrew status label, already chosen for the mode. */
  statusLabel: string
  /** `null` when this reader may not see providers. Not "unknown provider". */
  providerName: string | null
  /** Property id → name. */
  properties: ReadonlyMap<string, string>
  /** Rendered when the linen cannot be back in time. */
  overdue: boolean
  requiredByLabel: string
  relativeLabel: string
}

function tone(status: LaundryStatus, overdue: boolean) {
  if (overdue) return 'accent' as const
  if (TERMINAL_LAUNDRY_STATUSES.includes(status)) return 'neutral' as const
  return 'brand' as const
}

export function LaundryOrderCard({
  order,
  statusLabel,
  providerName,
  properties,
  overdue,
  requiredByLabel,
  relativeLabel,
}: OrderCardProps) {
  // Grouped here rather than by the caller, because every screen that renders
  // a card needs the same grouping and two implementations would eventually
  // count differently.
  const byProperty = new Map<string, number>()
  for (const line of order.lines) {
    byProperty.set(
      line.propertyId,
      (byProperty.get(line.propertyId) ?? 0) + line.quantity.final,
    )
  }

  const units = [...byProperty.values()].reduce((sum, n) => sum + n, 0)

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <a
            href={`/laundry/orders/${order.id}`}
            className="font-display text-base font-bold text-foreground underline-offset-4 hover:underline"
          >
            {order.reference}
          </a>
          <span className="text-xs text-muted-foreground">
            נדרש {requiredByLabel} · {relativeLabel}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone(order.status, overdue)}>{statusLabel}</Badge>
          {overdue && <Badge tone="accent">באיחור</Badge>}
        </div>
      </div>

      {/* THE BREAKDOWN. One row per property, never a single total. */}
      <ul className="flex flex-col gap-1.5">
        {[...byProperty.entries()].map(([propertyId, quantity]) => (
          <li
            key={propertyId}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="min-w-0 truncate text-foreground">
              {properties.get(propertyId) ?? propertyId}
            </span>
            <span className="shrink-0 tabular-nums font-semibold text-foreground">
              {quantity}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <span>
          {order.lines.length === 1
            ? 'פריט אחד'
            : `${order.lines.length} פריטים`}
          {' · '}
          {units} יחידות
        </span>

        {/* `null` means "you may not see this", which is a different sentence
            from "there is no provider" — and a cleaner gets neither, because
            the whole row is omitted rather than filled with a placeholder. */}
        {providerName !== null && <span>{providerName}</span>}

        {order.propertyId === null && byProperty.size > 1 && (
          <span>איסוף מאוחד</span>
        )}
      </div>
    </article>
  )
}
