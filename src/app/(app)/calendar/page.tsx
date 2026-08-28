import type { Metadata } from 'next'

import Link from 'next/link'

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { AvailabilityForm } from '@/components/calendar/availability-form'
import { CalendarLegend } from '@/components/calendar/calendar-legend'
import { DomainErrorPanel } from '@/components/calendar/domain-error'
import { MonthGrid } from '@/components/calendar/month-grid'
import { MonthNav } from '@/components/calendar/month-nav'
import { SpecialDaysPanel } from '@/components/calendar/special-days-panel'
import { legendStates } from '@/components/calendar/state-meta'
import { ModuleEmptyState } from '@/components/states/empty-state'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { addDays, localDate } from '@/lib/booking/dates'
import { shabbatDatesBetween } from '@/lib/hebrew-calendar'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES } from '../_lib/context'
import { requireCalendarAccess } from './_lib/access'
import {
  loadMonthAvailability,
  statesPresent,
  type UnitMonth,
} from './_lib/availability'
import { loadCalendarUnits } from './_lib/inventory'
import {
  buildMonthDays,
  hebrewMonthSpan,
  monthKeyOf,
  monthLabel,
  monthRange,
  monthSpecialDays,
  parseMonthKey,
  shiftMonthWithin,
} from './_lib/month'

export const metadata: Metadata = { title: 'יומן' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The multi-unit calendar.
 *
 * WHAT IS ON IT, AND WHERE EACH PART COMES FROM.
 *
 *   · The rows are `public.units`, narrowed by row level security to the
 *     caller's organization and scope, and then by `can()` per row. Neither
 *     floor is redundant: `units_select` carries no permission check at all.
 *   · Every cell is the availability engine's answer — `availabilityCalendar`
 *     for a reader entitled to the internal diary, `agentAvailabilityCalendar`
 *     for one who is not. There is no second definition of "free" on this page.
 *   · Every Hebrew date, holiday and Shabbat mark is `src/lib/hebrew-calendar`,
 *     which drives what a night is worth and who has to work it.
 *
 * THE MONTH IS IN THE URL. `?month=2026-09`, validated by `parseMonthKey` and
 * falling back to the month containing today *at the property* — `localDate`,
 * not the server's clock, because at 22:30 UTC it is already tomorrow in Israel
 * and a calendar that opened on yesterday would be wrong for two hours a day.
 *
 * NO NUMBER HERE WAS INVENTED. There is no occupancy percentage, no revenue
 * figure and no "X nights sold": nothing in the domain produces them yet, and a
 * fabricated one is a number somebody eventually repeats to their accountant.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, params] = await Promise.all([
    requireCalendarAccess(),
    searchParams,
  ])

  const now = new Date()
  const today = localDate(now)
  const currentMonth = monthKeyOf(today)
  const month = parseMonthKey(firstParam(params.month)) ?? currentMonth
  const range = monthRange(month)

  const days = buildMonthDays(month)
  const specialDays = monthSpecialDays(month)
  const shabbatot = shabbatDatesBetween(
    days[0].date,
    days[days.length - 1].date,
  )

  const narrowed = access.selectedPropertyId !== ALL_PROPERTIES

  let rows: UnitMonth[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  try {
    const db = await createClient()
    const units = await loadCalendarUnits({
      db,
      actor: access.actor,
      organizationId: access.organizationId,
      selectedPropertyId: access.selectedPropertyId,
    })

    rows = await loadMonthAvailability({
      db,
      actor: access.actor,
      organizationId: access.organizationId,
      units,
      range,
      now,
    })
  } catch (error) {
    // The technical text stays in the log; the screen gets the Hebrew sentence
    // the domain wrote, and both carry the same correlation id.
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const monthHref = (key: string | null) =>
    key === null ? undefined : `/calendar?month=${key}`

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          יומן
        </h1>
        <p className="text-muted-foreground">
          שורה לכל יחידה, עמודה לכל לילה. מצב הלילה מגיע ממנוע הזמינות — אותו
          מנוע שחוסם הזמנה כפולה — ולא מחישוב של המסך הזה.
        </p>
      </header>

      <MonthNav
        label={monthLabel(month)}
        hebrewLabel={hebrewMonthSpan(month)}
        previousHref={monthHref(shiftMonthWithin(month, -1))}
        nextHref={monthHref(shiftMonthWithin(month, 1))}
        todayHref={month === currentMonth ? undefined : monthHref(currentMonth)}
      />

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : (
        <CalendarBody
          rows={rows}
          days={days}
          month={month}
          narrowed={narrowed}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle as="h2">הלוח העברי בחודש הזה</CardTitle>
            <CardDescription>
              חגים, חול המועד ובין הזמנים — מה שמזיז את המחיר ואת הסידור.
            </CardDescription>
          </CardHeader>
          <div className="mt-5">
            <SpecialDaysPanel
              days={specialDays}
              shabbatCount={shabbatot.length}
            />
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">בדיקת זמינות מהירה</CardTitle>
            <CardDescription>
              בחר תאריכים ומספר אורחים כדי לראות אילו יחידות פנויות, ובאיזה
              מחיר.
            </CardDescription>
          </CardHeader>
          <div className="mt-5 flex flex-col gap-4">
            <AvailabilityForm
              action="/calendar/check"
              checkIn={today}
              checkOut={addDays(today, 1)}
              guests={2}
              month={month}
            />
            <Link
              href="/calendar/check"
              className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              מסך בדיקת הזמינות המלא
            </Link>
          </div>
        </Card>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

function CalendarBody({
  rows,
  days,
  month,
  narrowed,
}: {
  rows: readonly UnitMonth[]
  days: ReturnType<typeof buildMonthDays>
  month: string
  narrowed: boolean
}) {
  if (rows.length === 0) {
    // "You have never added a unit" and "your property filter hides them all"
    // look identical on screen and are opposite situations. `resolveEmptyReason`
    // is the guard against telling somebody with forty units that they have
    // none — and it will not claim `no_results` without a known total, so the
    // honest answer for an unfiltered empty list is the onboarding copy.
    const reason =
      resolveEmptyReason({
        visibleCount: 0,
        hasActiveFilters: narrowed,
      }) ?? 'no_data'

    return (
      <ModuleEmptyState
        module="units"
        reason={reason}
        filterSummary={narrowed ? 'נכס אחד נבחר בסרגל העליון' : undefined}
      />
    )
  }

  const present = statesPresent(rows)

  return (
    <div className="flex flex-col gap-4">
      <MonthGrid
        caption={`זמינות היחידות לחודש ${monthLabel(month)}, שורה לכל יחידה ועמודה לכל לילה.`}
        days={days.map((day) => ({
          date: day.date,
          dayOfMonth: day.dayOfMonth,
          weekdayLetter: day.weekdayLetter,
          hebrewDay: day.hebrewDay,
          hebrewFull: day.hebrewFull,
          shabbat: day.shabbat,
          peak: day.peak,
          specialShortName: day.special?.shortName ?? null,
          specialName: day.special?.name ?? null,
        }))}
        rows={rows.map((row) => ({
          unitId: row.unit.id,
          unitName: row.unit.name,
          unitCode: row.unit.code,
          propertyName: row.unit.propertyName,
          states: row.days.map((day) => day.state),
        }))}
      />

      <CalendarLegend
        states={legendStates(present)}
        note={
          present.has('unavailable')
            ? 'תפוס אינו מפרט אם מדובר בהזמנה או בהחזקה — זהו מידע על עסקה של מוכר אחר.'
            : undefined
        }
      />
    </div>
  )
}
