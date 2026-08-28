/**
 * What the Hebrew calendar says about this month.
 *
 * An Israeli guesthouse is priced and staffed off this list, not off the civil
 * month: chol hamoed Pesach and Sukkot are peak domestic-tourism weeks, bein
 * hazmanim is the single biggest driver of occupancy, and a Friday arrival is a
 * different operational day from a Tuesday one. The list is
 * `specialDaysBetween` verbatim — every name, short name and kind is the
 * calendar module's, so nothing here can name a festival the domain does not.
 *
 * THE HONEST GAP. Shabbat times are not on this panel because they are not
 * computable from a date: candle lighting and havdalah need the property's
 * latitude and a solar calculation, and `shabbatWindow` returns `null` for both
 * by design. The panel says so rather than showing an empty field, and it says
 * it in the calendar module's own words — `SHABBAT_TIMES_UNAVAILABLE` — so the
 * explanation cannot drift from the reason.
 */

import { Badge, type BadgeTone } from '@/components/ui/badge'
import {
  SHABBAT_TIMES_UNAVAILABLE,
  type SpecialDay,
  type SpecialDayKind,
} from '@/lib/hebrew-calendar'

const KIND_LABEL: Record<SpecialDayKind, string> = {
  yom_tov: 'חג',
  chol_hamoed: 'חול המועד',
  minor: 'מועד',
  bein_hazmanim: 'בין הזמנים',
}

const KIND_TONE: Record<SpecialDayKind, BadgeTone> = {
  yom_tov: 'accent',
  chol_hamoed: 'brand',
  minor: 'neutral',
  bein_hazmanim: 'neutral',
}

export type SpecialDaysPanelProps = {
  days: readonly SpecialDay[]
  /** Number of Shabbatot in the month, from `shabbatDatesBetween`. */
  shabbatCount: number
}

export function SpecialDaysPanel({
  days,
  shabbatCount,
}: SpecialDaysPanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {shabbatCount === 1
          ? 'שבת אחת בחודש הזה'
          : `${shabbatCount} שבתות בחודש הזה`}
        {days.length > 0
          ? `, ועוד ${days.length} ימים מיוחדים בלוח העברי.`
          : '. אין ימים מיוחדים נוספים בלוח העברי.'}
      </p>

      {days.length > 0 && (
        <ul className="flex flex-col gap-2">
          {days.map((day) => (
            <li
              key={`${day.date}-${day.name}`}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-2 last:border-b-0 last:pb-0"
            >
              <span className="flex items-baseline gap-2">
                <Badge tone={KIND_TONE[day.kind]}>{KIND_LABEL[day.kind]}</Badge>
                <span className="text-sm font-medium text-foreground">
                  {day.name}
                </span>
              </span>
              <span
                dir="ltr"
                className="text-xs text-muted-foreground tabular-nums"
              >
                {day.date}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        {SHABBAT_TIMES_UNAVAILABLE}
      </p>
    </div>
  )
}
