import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { BookingFiltersBar } from '@/components/booking/booking-filters'
import { BookingTable } from '@/components/booking/booking-table'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { can } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'

import { ALL_PROPERTIES } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { shellContext } from '../_lib/context'
import {
  BOOKING_PAGE_SIZE,
  countBookings,
  listBookings,
  type BookingListItem,
} from './_lib/queries'
import {
  dateRangeIssue,
  describeFilters,
  hasActiveFilters,
  parseBookingFilters,
} from './_lib/filters'
import { bookingWiring } from './_lib/wiring'

export const metadata: Metadata = { title: 'הזמנות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The bookings list.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.bookings` for the organization the
 * shell resolved, narrowed to the selected property, read through the
 * request-scoped Supabase client under row level security. Every value shown
 * is a column or an embedded name; the night count comes from `nightsBetween`
 * and the money from `formatAgorot` over the stored `total_agorot`. There is
 * no derived occupancy figure, no computed revenue and no placeholder total,
 * because none of those is a number this screen was given.
 *
 * GATING, IN TWO INDEPENDENT PLACES. `requireGrant('booking.view')` refuses
 * the route. `can(actor, 'booking.view_price')` decides whether the money
 * column exists at all — and it is not the only thing standing between a
 * cleaner and a price: `booking_price_lines_select` refuses them at the
 * database regardless of what this component renders. Hiding the column is the
 * courtesy; RLS is the enforcement.
 *
 * THE EMPTY STATE IS TWO STATES. `resolveEmptyReason` is given the filtered
 * count *and* the unfiltered one, so "you have never made a booking" is never
 * shown to somebody whose filter merely matched nothing. Getting that backwards
 * tells a business with four hundred bookings that the system lost their data.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('booking.view'),
    shellContext(),
    searchParams,
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const filters = parseBookingFilters(params)
  const dateIssue = dateRangeIssue(filters)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const showTotals = can(actor, 'booking.view_price', {
    organizationId: actor.organizationId,
  })
  const mayCreate = can(actor, 'booking.create', {
    organizationId: actor.organizationId,
  })

  let bookings: readonly BookingListItem[] = []
  let total = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { db } = await bookingWiring()
    // A reversed window matches nothing by definition, so the query is not
    // run for it — the message below is the answer, and an empty list would
    // have looked like a business with no bookings.
    ;[bookings, total] = await Promise.all([
      dateIssue === null
        ? listBookings(db, {
            organizationId: actor.organizationId,
            propertyId,
            filters,
          })
        : Promise.resolve([]),
      countBookings(db, actor.organizationId, propertyId),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const emptyReason = resolveEmptyReason({
    visibleCount: bookings.length,
    totalCount: total,
    hasActiveFilters: hasActiveFilters(filters) || propertyId !== null,
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            הזמנות
          </h1>
          <p className="text-muted-foreground">
            {propertyName
              ? `כל השהיות ב״${propertyName}״.`
              : 'כל השהיות בארגון, בכל הנכסים שבטווח שלך.'}{' '}
            {total === 1 ? 'הזמנה אחת סה״כ' : `${total} הזמנות סה״כ`}.
          </p>
        </div>

        {/* The control is hidden without the grant, and the action refuses
            without it regardless — see `createBookingAction`. */}
        {mayCreate && <Button href="/bookings/new">הזמנה חדשה</Button>}
      </header>

      <BookingFiltersBar filters={filters} dateIssue={dateIssue} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <ModuleEmptyState
          module="bookings"
          reason={emptyReason}
          filterSummary={describeFilters(filters, propertyName)}
          renderAction={(label) =>
            emptyReason === 'no_results' ? (
              <Button href="/bookings" variant="secondary">
                {label}
              </Button>
            ) : mayCreate ? (
              <Button href="/bookings/new">{label}</Button>
            ) : null
          }
        />
      ) : (
        <>
          <BookingTable bookings={bookings} showTotals={showTotals} />

          {/* Said out loud rather than left for somebody to discover that the
              list quietly stops. Paging is the fix; a silent truncation is
              the bug it would otherwise be. */}
          {bookings.length === BOOKING_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגות {BOOKING_PAGE_SIZE} ההזמנות האחרונות. צמצם את הסינון כדי
              לראות הזמנות נוספות.
            </p>
          )}
        </>
      )}
    </div>
  )
}
