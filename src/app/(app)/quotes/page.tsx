import type { Metadata } from 'next'
import Link from 'next/link'

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { PlanLock } from '@/components/distribution/plan-lock'
import { Money } from '@/components/finance/money'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import { cn } from '@/components/ui/cn'
import { holdsGrant } from '@/lib/authz/can'
import { HOLD_REASON_LABEL, formatDayMonthYear } from '@/lib/booking'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireDistributionGrant } from '../agents/_lib/gate'
import {
  QUOTE_OUTCOMES,
  QUOTE_OUTCOME_LABEL,
  quoteOutcomeTone,
  type QuoteOutcome,
} from '../agents/_lib/labels'
import {
  QUOTE_PAGE_SIZE,
  countQuotes,
  listDiscountRequests,
  listQuotes,
  quoteTally,
  type DiscountRequest,
  type QuoteListItem,
} from './_lib/queries'

export const metadata: Metadata = { title: 'הצעות מחיר' }

const OUTCOME_KEY = 'outcome'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What was offered, and what came of it.
 *
 * ══ WHAT THIS SCREEN IS HONEST ABOUT ═════════════════════════════════════
 *
 * There is no `quotes` table. Sixty tables exist in `supabase/migrations` and
 * none of them stores a quote: pricing a proposed stay is a calculation
 * `calendar/_lib/quote.ts` performs on demand, and it is written down nowhere.
 * The permission catalogue has `quote.view` and `quote.create` because the
 * capability is real; the document is not.
 *
 * What *is* written down is what a quote leaves behind, and this screen is
 * exactly that and says so on the page rather than only in a comment:
 *
 *   · the **hold** placed while the customer decides — the dates come off the
 *     market, and `converted_to_booking_id`, `released_at` and `expires_at`
 *     record what became of the offer;
 *   · the **discount request** raised when the offer went below the seller's
 *     cap — the negotiation, kept inside the product instead of on WhatsApp.
 *
 * Drawing a quotes pipeline out of nothing would have been the easy screen and
 * the dishonest one. A business would use it to answer "how many offers are
 * open" and the answer would be fabricated.
 *
 * THE OUTCOME IS DERIVED IN ONE PLACE. `quoteOutcome` in `_lib/queries.ts`, so
 * the tally above the list and the badges in it cannot disagree. A hold that
 * became a booking is `won` even though its expiry has since passed, because
 * the first thing that happened is what became of it.
 *
 * WHAT AN EXTERNAL AGENT SEES. Their own offers. `can()` is asked per row with
 * `family: 'booking'` — the family `RESOURCE_FAMILIES` lists "bookings, holds,
 * quotes, leads" under — and an agent's default scope is `own_records`, so the
 * same `hold.view` serves the desk and the seller and the scope answers
 * "whose". No filter was written for them.
 *
 * GATING. `quote.view`, which is deliberately mapped to **no entitlement**:
 * `plans/entitlements.ts` is explicit that a single-cabin owner on the cheapest
 * package holding a room for a telephone caller is the core product, and
 * charging for it would be gating the core behind an add-on. So this screen is
 * the one in the distribution section that a Basic organization reaches — and
 * the plan-lock branch is still written, because the mapping is the catalogue's
 * to change and this route should follow it rather than assume it.
 */
export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, context, params] = await Promise.all([
    requireDistributionGrant('quote.view'),
    shellContext(),
    searchParams,
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="הצעות מחיר אינן כלולות בחבילה שלך"
        body="הצעת מחיר תופסת את התאריכים בזמן שהלקוח מחליט, ומראה מה קרה איתה בסוף."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const outcome = parseOutcome(firstParam(params[OUTCOME_KEY]))
  // One instant for the whole render, so the tally and the badges are decided
  // at the same moment. Two `new Date()` calls a millisecond apart can put an
  // offer on one side of its expiry in the count and the other in the list.
  const now = new Date()

  let quotes: readonly QuoteListItem[] = []
  let total = 0
  let discounts: readonly DiscountRequest[] | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[quotes, total, discounts] = await Promise.all([
      listQuotes({
        db,
        actor,
        organizationId: actor.organizationId,
        propertyId,
        outcome,
        now,
      }),
      countQuotes(db, actor.organizationId, propertyId),
      listDiscountRequests({
        db,
        actor,
        organizationId: actor.organizationId,
        propertyId,
      }),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const tally = quoteTally(quotes)
  const emptyReason = resolveEmptyReason({
    visibleCount: quotes.length,
    totalCount: total,
    hasActiveFilters: outcome !== null || propertyId !== null,
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            הצעות מחיר
          </h1>
          {holdsGrant(actor, 'quote.create') && (
            <Button href="/quotes/new" size="sm">
              הצעה חדשה
            </Button>
          )}
        </div>
        <p className="text-muted-foreground">
          {propertyName
            ? `ההצעות שיצאו ב״${propertyName}״.`
            : 'ההצעות שיצאו — שלך ושל הדסק, בטווח שלך.'}{' '}
          הצעת מחיר תופסת את היחידה לזמן קצוב בזמן שהלקוח מחליט, כך שהיא לא
          תימכר מתחת לו.
        </p>
      </header>

      {/* The honest statement, on the screen and not only in the code. */}
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">
          הצעת מחיר אינה מסמך שנשמר במערכת.
        </span>{' '}
        המחיר מחושב מחדש בכל פעם שמבקשים אותו, ומה שנשמר הוא מה שההצעה השאירה
        אחריה: השריון על התאריכים, ובקשת ההנחה אם ההצעה ירדה מתחת לתקרה של
        הסוכן. זה מה שמוצג כאן.
      </p>

      <OutcomeFilter selected={outcome} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'calendar'}
          title={
            emptyReason === 'no_results'
              ? 'אין הצעות במצב הזה'
              : 'עוד לא יצאה הצעת מחיר'
          }
          body={
            emptyReason === 'no_results'
              ? `אין הצעה שמצבה ״${outcome === null ? '' : QUOTE_OUTCOME_LABEL[outcome]}״${propertyName ? ` ב״${propertyName}״` : ''}. הצעות אחרות קיימות במערכת — ניקוי הסינון יחזיר אותן.`
              : 'הצעה נוצרת כשמישהו תופס יחידה לתאריכים בזמן שהלקוח מחליט. היא פגה מעצמה אם איש לא חוזר אליה, ואפשר לשחרר אותה ידנית — בשני המקרים התאריכים חוזרים למכירה.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/quotes" variant="secondary">
                נקה סינון
              </Button>
            ) : holdsGrant(actor, 'quote.create') ? (
              <Button href="/quotes/new">צור הצעה ראשונה</Button>
            ) : null
          }
        />
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-4">
            {QUOTE_OUTCOMES.map((entry) => (
              <div
                key={entry}
                className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-soft"
              >
                <dt className="text-xs text-muted-foreground">
                  {QUOTE_OUTCOME_LABEL[entry]}
                </dt>
                <dd className="font-display text-xl font-bold tabular-nums text-foreground">
                  {tally[entry]}
                </dd>
              </div>
            ))}
          </dl>

          <QuoteList quotes={quotes} />

          {quotes.length === QUOTE_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגות {QUOTE_PAGE_SIZE} ההצעות האחרונות. צמצם את הסינון כדי לראות
              הצעות נוספות.
            </p>
          )}
        </>
      )}

      <DiscountPanel requests={discounts} />
    </div>
  )
}

/* --------------------------------------------------------------- parts -- */

function QuoteList({ quotes }: { quotes: readonly QuoteListItem[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {quotes.map((quote) => (
        <li
          key={quote.id}
          className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-soft"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-display text-base font-bold text-foreground">
              {quote.unitLabel ?? 'יחידה שאינה גלויה לך'}
            </span>
            <Badge
              tone={quoteOutcomeTone(quote.outcome)}
              className={cn(
                quote.outcome === 'expired' && 'line-through opacity-70',
              )}
            >
              {QUOTE_OUTCOME_LABEL[quote.outcome]}
            </Badge>
          </div>

          <p className="text-sm text-muted-foreground">
            {formatDayMonthYear(quote.checkIn)} –{' '}
            {formatDayMonthYear(quote.checkOut)} ·{' '}
            {HOLD_REASON_LABEL[quote.reason]}
            {' · '}
            {quote.issuedByName ?? 'מי שהוציא את ההצעה אינו גלוי לך'}
          </p>

          <p className="text-xs text-muted-foreground">
            <Deadline quote={quote} />
          </p>

          {quote.convertedToBookingId !== null && (
            <Link
              href={`/bookings/${quote.convertedToBookingId}`}
              className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              להזמנה שנוצרה ממנה
            </Link>
          )}

          {quote.note !== null && (
            <p className="text-sm text-foreground">{quote.note}</p>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The one date that matters, chosen by what actually happened.
 *
 * Printing all four columns on every row makes the reader work out which one is
 * current — the same decision `LadderMoment` makes on the commissions table.
 */
function Deadline({ quote }: { quote: QuoteListItem }) {
  if (quote.releasedAt !== null) {
    return <>שוחררה ב־{formatDayMonthYear(quote.releasedAt.slice(0, 10))}</>
  }
  if (quote.outcome === 'won') {
    return <>הוצעה ב־{formatDayMonthYear(quote.issuedAt.slice(0, 10))}</>
  }
  return (
    <>
      {quote.outcome === 'expired' ? 'פגה ב־' : 'תקפה עד '}
      {formatDayMonthYear(quote.expiresAt.slice(0, 10))}
      {', '}
      {new Date(quote.expiresAt).toLocaleTimeString('he-IL', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Jerusalem',
      })}
    </>
  )
}

/**
 * The negotiations that went above a seller's cap.
 *
 * `null` and empty are rendered differently on purpose: "nobody asked for a
 * discount" and "you may not see who did" are different sentences, and the
 * second is a permission fact rather than a commercial one.
 */
function DiscountPanel({
  requests,
}: {
  requests: readonly DiscountRequest[] | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">בקשות הנחה</CardTitle>
      </CardHeader>
      <p className="mt-2 text-sm text-muted-foreground">
        כשסוכן מבקש הנחה מעבר לתקרה שלו, המערכת לא מסרבת — היא פותחת בקשת אישור.
        זה מה שמשאיר את המשא ומתן בתוך המערכת במקום בוואטסאפ.
      </p>

      {requests === null ? (
        <p className="mt-3 text-sm text-muted-foreground">
          בקשות אישור אינן גלויות לך. זו אינה טענה שלא הוגשו בקשות.
        </p>
      ) : requests.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          עוד לא הוגשה בקשת הנחה בטווח שלך.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-border">
          {requests.map((request) => (
            <li key={request.id} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-foreground">
                  {request.requestedByName ?? 'מבקש שאינו גלוי לך'}
                </span>
                <Badge>{request.status}</Badge>
                {request.requestedBps !== null && request.limitBps !== null && (
                  <span className="text-sm text-muted-foreground">
                    ביקש {request.requestedBps / 100}% מול תקרה של{' '}
                    {request.limitBps / 100}%
                  </span>
                )}
                {request.requestedAgorot !== null && (
                  <span className="text-sm text-muted-foreground">
                    ביקש <Money agorot={request.requestedAgorot} /> מול תקרה של{' '}
                    <Money agorot={request.limitAgorot} />
                  </span>
                )}
              </div>
              <p className="text-sm text-foreground">{request.reason}</p>
              {request.decidedAt !== null && (
                <p className="text-xs text-muted-foreground">
                  הוכרעה על ידי {request.decidedByName ?? 'מכריע שאינו גלוי לך'}{' '}
                  ב־{formatDayMonthYear(request.decidedAt.slice(0, 10))}
                  {request.decisionNote !== null && (
                    <> · {request.decisionNote}</>
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function OutcomeFilter({ selected }: { selected: QuoteOutcome | null }) {
  return (
    <form
      method="get"
      action="/quotes"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label="סינון הצעות מחיר"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="מה קרה עם ההצעה">
          <Select name={OUTCOME_KEY} defaultValue={selected ?? ''}>
            <option value="">הכול</option>
            {QUOTE_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {QUOTE_OUTCOME_LABEL[outcome]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm">
          סנן
        </Button>
        {selected !== null && (
          <Button href="/quotes" variant="ghost" size="sm">
            נקה סינון
          </Button>
        )}
      </div>
    </form>
  )
}

/**
 * The outcome out of the URL, refusing anything that is not one.
 *
 * `QUOTE_OUTCOMES` is this module's own tuple, so a hand-edited URL cannot put
 * an unknown value in front of a comparison and quietly empty the list.
 */
function parseOutcome(raw: string | null): QuoteOutcome | null {
  if (raw === null) return null
  return (QUOTE_OUTCOMES as readonly string[]).includes(raw)
    ? (raw as QuoteOutcome)
    : null
}
