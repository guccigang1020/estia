import type { Metadata } from 'next'

import Link from 'next/link'

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { AvailabilityForm } from '@/components/calendar/availability-form'
import { DomainErrorPanel } from '@/components/calendar/domain-error'
import { QuoteBreakdown } from '@/components/calendar/quote-breakdown'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { addDays, isIsoDate, localDate } from '@/lib/booking/dates'
import { holdsGrant } from '@/lib/authz/can'
import { toLogEntry } from '@/lib/errors'
import { summarizeStay } from '@/lib/hebrew-calendar'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES } from '../../_lib/context'
import { requireCalendarAccess } from '../_lib/access'
import { loadSellability, type UnitSellability } from '../_lib/availability'
import { loadCalendarUnits } from '../_lib/inventory'
import { fitsParty, quoteFor, type UnitQuote } from '../_lib/quote'

export const metadata: Metadata = { title: 'בדיקת זמינות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What is free, and for how much.
 *
 * ONE ENGINE, ASKED ONCE PER UNIT. `checkAvailability` decides whether a stay
 * can be sold — over occupying statuses, live holds, blocked dates and the
 * length-of-stay floor — and it collects *every* blocker rather than the first,
 * so this screen can say "taken, and below the three-night minimum" in one
 * breath instead of revealing problems one at a time. A reader who may not see
 * the internal diary goes through `agentCanSell`, which gives the same verdict
 * with reasons that never name somebody else's booking.
 *
 * THE PRICE IS A SEPARATE QUESTION, AND A SEPARATE PERMISSION. Availability is
 * `availability.view`; the rate a guest is quoted is `rate.view_public`. A
 * business genuinely grants one without the other — a housekeeping supervisor
 * needs to know a unit is taken and has no business seeing what it sold for —
 * so the price block is gated on its own grant rather than riding along.
 *
 * CAPACITY IS NOT AVAILABILITY. `checkAvailability` knows nothing about
 * `max_guests`, and pretending otherwise would put a made-up rule inside the
 * one answer the product cannot afford to have two of. A unit that is free but
 * too small is reported as free and too small.
 */
export default async function AvailabilityCheckPage({
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

  const requestedCheckIn = firstParam(params.checkIn)
  const requestedCheckOut = firstParam(params.checkOut)
  const requestedGuests = firstParam(params.guests)

  const checkIn = isIsoDate(requestedCheckIn) ? requestedCheckIn : null
  const checkOut = isIsoDate(requestedCheckOut) ? requestedCheckOut : null
  const guests = parseGuests(requestedGuests)

  // A search runs only when all three arrived. Guessing at a missing one would
  // put a result on screen that nobody asked for.
  const searched = checkIn !== null && checkOut !== null && guests !== null

  const showPrice = holdsGrant(access.actor, 'rate.view_public')
  const narrowed = access.selectedPropertyId !== ALL_PROPERTIES

  let results: UnitSellability[] = []
  let quotes = new Map<string, UnitQuote | null>()
  let unitCount = 0
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  if (searched) {
    try {
      const db = await createClient()
      const units = await loadCalendarUnits({
        db,
        actor: access.actor,
        organizationId: access.organizationId,
        selectedPropertyId: access.selectedPropertyId,
      })
      unitCount = units.length

      results = await loadSellability({
        db,
        actor: access.actor,
        organizationId: access.organizationId,
        units,
        range: { checkIn, checkOut },
        now,
      })

      if (showPrice) {
        quotes = new Map(
          results
            // Only where the engine said yes. A quote for dates that cannot be
            // sold is a number with no meaning behind it.
            .filter((result) => result.available)
            .map((result) => [
              result.unit.id,
              quoteFor(result.unit, { checkIn, checkOut }, guests),
            ]),
        )
      }
    } catch (error) {
      console.error(toLogEntry(error, correlationId))
      failure = error
    }
  }

  const stay = checkIn && checkOut ? summarizeStay({ checkIn, checkOut }) : null

  const available = results.filter((result) => result.available)
  const unavailable = results.filter((result) => !result.available)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          בדיקת זמינות
        </h1>
        <p className="text-muted-foreground">
          התשובה מגיעה ממנוע הזמינות. היא נכונה לרגע הזה ואינה שומרת את התאריכים
          — מי שמאשר הזמנה ראשון מקבל אותם, וההגנה האמיתית היא במסד.
        </p>
        <Link
          href="/calendar"
          className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          חזרה ליומן החודשי
        </Link>
      </header>

      <Card>
        <AvailabilityForm
          action="/calendar/check"
          checkIn={checkIn ?? today}
          checkOut={checkOut ?? addDays(today, 1)}
          guests={guests ?? 2}
        />
      </Card>

      {stay && stay.nights > 0 && (
        <StaySummary
          nights={stay.nights}
          peakDates={stay.peakDates}
          specialNames={[...stay.yomTov, ...stay.cholHaMoed].map(
            (day) => day.name,
          )}
          shabbatCount={stay.shabbatDates.length}
        />
      )}

      {!searched && (
        <p className="text-sm text-muted-foreground">
          בחר תאריך הגעה, תאריך עזיבה ומספר אורחים, ולחץ ״בדוק זמינות״.
        </p>
      )}

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : null}

      {searched && !failure && unitCount === 0 && (
        <ModuleEmptyState
          module="units"
          reason="no_data"
          filterSummary={narrowed ? 'נכס אחד נבחר בסרגל העליון' : undefined}
        />
      )}

      {searched && !failure && unitCount > 0 && (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-4">
            <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
              פנוי · {available.length} מתוך {results.length}
            </h2>

            {available.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                אף יחידה אינה פנויה בתאריכים אלה. הסיבות מופיעות ברשימה למטה.
              </p>
            ) : (
              <ul className="grid gap-5 lg:grid-cols-2">
                {available.map((result) => (
                  <li key={result.unit.id}>
                    <AvailableUnitCard
                      result={result}
                      guests={guests ?? 0}
                      quote={quotes.get(result.unit.id) ?? null}
                      showPrice={showPrice}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {unavailable.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
                לא פנוי · {unavailable.length}
              </h2>
              <ul className="flex flex-col gap-3">
                {unavailable.map((result) => (
                  <li key={result.unit.id}>
                    <UnavailableUnitRow result={result} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

/**
 * The party size, or `null`.
 *
 * Refuses anything that is not a whole number of at least one, rather than
 * coercing it: `Number('')` is `0` and `Number('2 adults')` is `NaN`, and both
 * would reach `priceStay` as a party nobody typed.
 */
function parseGuests(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const guests = Number(value)
  return Number.isInteger(guests) && guests >= 1 ? guests : null
}

function StaySummary({
  nights,
  peakDates,
  specialNames,
  shabbatCount,
}: {
  nights: number
  peakDates: readonly string[]
  specialNames: readonly string[]
  shabbatCount: number
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">מה יש בשהות הזו</CardTitle>
        <CardDescription>
          מהלוח העברי. לילות שיא הם שבת, חג וחול המועד — ולא בין הזמנים, שהוא
          סימן ביקוש ולא תוספת ללילה.
        </CardDescription>
      </CardHeader>

      <dl className="mt-5 grid gap-3 sm:grid-cols-3">
        <Fact label="לילות" value={String(nights)} />
        <Fact label="מתוכם שבת" value={String(shabbatCount)} />
        <Fact label="לילות שיא" value={String(peakDates.length)} />
      </dl>

      {specialNames.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {[...new Set(specialNames)].map((name) => (
            <li key={name}>
              <Badge tone="accent">{name}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-muted px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-lg font-bold text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  )
}

function AvailableUnitCard({
  result,
  guests,
  quote,
  showPrice,
}: {
  result: UnitSellability
  guests: number
  quote: UnitQuote | null
  showPrice: boolean
}) {
  const fits = fitsParty(result.unit, guests)

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle as="h3">{result.unit.name}</CardTitle>
        <CardDescription>
          <span dir="ltr">{result.unit.code}</span> · {result.unit.propertyName}{' '}
          · עד {result.unit.maxGuests} אורחים
        </CardDescription>
      </CardHeader>

      <p className="mt-4 flex items-center gap-2 text-sm font-medium text-success">
        <span aria-hidden="true">✓</span>
        פנוי ל-{result.nights} לילות
      </p>

      {!fits && (
        // Free, and too small. Said as its own fact rather than folded into
        // availability — see the note at the top of this file.
        <p className="mt-2 flex items-start gap-2 text-sm text-warning">
          <span aria-hidden="true">!</span>
          <span>
            היחידה מכילה עד {result.unit.maxGuests} אורחים, והבקשה היא ל-
            {guests}. התפוסה אינה חלק ממנוע הזמינות — זו השוואה לנתון היחידה.
          </span>
        </p>
      )}

      <div className="mt-5 border-t border-border pt-4">
        {!showPrice ? (
          <p className="text-sm text-muted-foreground">
            אין לך הרשאה לראות מחירים ({'rate.view_public'}), ולכן מוצגת כאן
            הזמינות בלבד.
          </p>
        ) : quote === null ? (
          <p className="text-sm text-muted-foreground">
            ליחידה הזו עוד לא הוגדר מחיר ללילה, ולכן אין הצעת מחיר להציג.
          </p>
        ) : (
          <QuoteBreakdown
            lines={quote.lines}
            totalAgorot={quote.totalAgorot}
            stayTotalAgorot={quote.stayTotalAgorot}
            depositAgorot={quote.depositAgorot}
            taxAgorot={quote.taxAgorot}
            taxIncludedAgorot={quote.taxIncludedAgorot}
          />
        )}
      </div>
    </Card>
  )
}

function UnavailableUnitRow({ result }: { result: UnitSellability }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">{result.unit.name}</span>
        <span className="text-xs text-muted-foreground">
          <span dir="ltr">{result.unit.code}</span> · {result.unit.propertyName}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {result.reasons.map((reason) => (
          <li
            key={reason}
            className="flex items-start gap-2 text-sm text-muted-foreground"
          >
            <span aria-hidden="true">✕</span>
            <span>{reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
