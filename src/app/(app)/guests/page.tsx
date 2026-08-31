import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { GuestFiltersBar } from '@/components/guests/guest-filters'
import { GuestTable } from '@/components/guests/guest-table'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { can, holdsGrant, scopeFor, type Actor } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  GUEST_PAGE_SIZE,
  GUEST_TAG_SCAN_SIZE,
  countGuests,
  listGuestTags,
  listGuests,
  type GuestListPage,
} from './_lib/queries'
import {
  describeGuestFilters,
  hasActiveGuestFilters,
  parseGuestFilters,
} from './_lib/filters'

export const metadata: Metadata = { title: 'אורחים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The guest list.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.guests` for the organization the
 * shell resolved, read through the request-scoped Supabase client under row
 * level security, joined in memory to the stays those guests have in
 * `public.bookings`. Every value shown is a column or a count of rows; the
 * money is `sum(bookings.total_agorot)` over stays that happened, formatted by
 * `formatAgorot`. There is no lifetime-value model, no segment score and no
 * placeholder total, because none of those is a number this screen was given.
 *
 * GATING, IN FOUR INDEPENDENT PLACES.
 *
 *   1. `requireGrant('guest.view')` refuses the route.
 *   2. `can()` is asked per row inside `listGuests`, with the properties that
 *      guest has stayed at, so a property-scoped membership sees their own
 *      guests and not the business's whole customer list.
 *   3. `redact()` removes the name, the telephone and the e-mail
 *      *independently* — three grants, three answers, and a role may hold any
 *      one of them without the others. The table says which field is withheld
 *      rather than dropping a column, because dropping the column would claim
 *      that nobody has a telephone number.
 *   4. `guests_select` refuses at the database regardless of all three.
 *
 * THE EMPTY STATE IS THREE STATES, NOT TWO. `resolveEmptyReason` tells "you
 * have no guests" from "your filter matched nothing". There is a third here
 * that the other list screens do not have: a reader whose scope reaches no
 * guest at all sees an empty list for a reason no filter can clear, and
 * showing them the onboarding copy would tell a business with twenty-seven
 * guests that it has none. That case is answered separately and in its own
 * words.
 */
export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('guest.view'),
    shellContext(),
    searchParams,
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const filters = parseGuestFilters(params)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const showValue = can(actor, 'booking.view_price', {
    organizationId: actor.organizationId,
    family: 'booking',
  })
  const mayCreate = can(actor, 'guest.create', {
    organizationId: actor.organizationId,
    family: 'guest',
  })

  let page: GuestListPage = { items: [], tagScanTruncated: false }
  let total = 0
  let tags: readonly string[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[page, total, tags] = await Promise.all([
      listGuests({
        db,
        actor,
        organizationId: actor.organizationId,
        propertyId,
        filters,
      }),
      countGuests(db, actor.organizationId),
      listGuestTags(db, actor.organizationId),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const guests = page.items

  // The third empty state. `scopeFor` is the engine's own answer to "which
  // scope governs a guest for this actor", so this asks the question rather
  // than re-deriving it from the membership.
  const organizationWide =
    scopeFor(actor, {
      organizationId: actor.organizationId,
      family: 'guest',
    }).kind === 'all_organization'

  const emptyByScope =
    failure === null &&
    guests.length === 0 &&
    total > 0 &&
    !organizationWide &&
    !hasActiveGuestFilters(filters)

  const emptyReason = emptyByScope
    ? null
    : resolveEmptyReason({
        visibleCount: guests.length,
        totalCount: total,
        hasActiveFilters: hasActiveGuestFilters(filters) || propertyId !== null,
      })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            אורחים
          </h1>
          <p className="max-w-prose text-muted-foreground">
            {propertyName
              ? `אורחים ששהו ב״${propertyName}״.`
              : 'כל מי שהזמין אצלכם, פעם אחת או עשר.'}{' '}
            {total === 1 ? 'אורח אחד בארגון' : `${total} אורחים בארגון`}.
          </p>
        </div>

        {/* The control is hidden without the grant, and the action refuses
            without it regardless — see `createGuestAction`. */}
        {mayCreate && <Button href="/guests/new">אורח חדש</Button>}
      </header>

      <GuestFiltersBar
        filters={filters}
        tags={tags}
        searchDescription={searchDescription(actor)}
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyByScope ? (
        <p
          role="status"
          className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-sm text-muted-foreground shadow-soft"
        >
          אין אורחים בטווח ההרשאה שלך. הארגון מנהל {total} כרטיסי אורח, אבל
          החברות שלך מוגבלת לנכסים מסוימים — ואורח נכנס לרשימה הזו רק אם שהה
          באחד מהם. זו אינה תקלה ואי אפשר לפתוח אותה בעזרת סינון.
        </p>
      ) : emptyReason ? (
        <ModuleEmptyState
          module="guests"
          reason={emptyReason}
          filterSummary={describeGuestFilters(filters, propertyName)}
          renderAction={(label) =>
            emptyReason === 'no_results' ? (
              <Button href="/guests" variant="secondary">
                {label}
              </Button>
            ) : mayCreate ? (
              <Button href="/guests/new">{label}</Button>
            ) : null
          }
        />
      ) : (
        <>
          <GuestTable guests={guests} showValue={showValue} />

          {/* Said out loud rather than left for somebody to discover that the
              list quietly stops. */}
          {guests.length === GUEST_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגים {GUEST_PAGE_SIZE} אורחים. צמצם את הסינון כדי לראות אורחים
              נוספים.
            </p>
          )}

          {/* A different truncation, and a more serious one: the tag filter is
              applied in memory over a bounded scan, so a business past the
              ceiling would be shown a partial answer that looks complete. */}
          {page.tagScanTruncated && (
            <p
              role="status"
              className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm text-warning"
            >
              סינון לפי תגית נבדק על {GUEST_TAG_SCAN_SIZE} האורחים הראשונים
              בלבד. ייתכן שיש אורחים נוספים עם התגית הזו שאינם מוצגים כאן.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * What this particular reader's search will actually match.
 *
 * The e-mail and the telephone are searchable only for somebody who may read
 * them — a redacted column that is still searchable is not redacted. Saying so
 * under the field is the difference between a search that "does not work" and
 * one whose limits are visible.
 */
function searchDescription(actor: Actor): string {
  const fields = ['שם']
  if (holdsGrant(actor, 'guest.view_phone')) fields.push('טלפון')
  if (holdsGrant(actor, 'guest.view_email')) fields.push('אימייל')

  return fields.length === 1
    ? 'לפי שם האורח'
    : `לפי ${fields.slice(0, -1).join(', ')} או ${fields[fields.length - 1]}`
}
