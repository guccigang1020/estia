import type { Metadata } from 'next'

import Link from 'next/link'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import {
  DataTable,
  Cell,
  Row,
  RowHeader,
  Withheld,
} from '@/components/management/data-table'
import { Notice } from '@/components/management/notice'
import { PageHeader } from '@/components/management/page-header'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { holdsGrant } from '@/lib/authz/can'
import { toLogEntry } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  UNIT_SELLABILITY_NOTE,
  UNIT_STATUS_LABEL,
  UNIT_TYPE_LABEL,
  labelOr,
  statusTone,
  type UnitStatus,
} from '../properties/_lib/labels'
import {
  listUnits,
  sellableUnits,
  unsellableUnits,
  type UnitListItem,
} from './_lib/queries'

export const metadata: Metadata = { title: 'יחידות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The inventory across every property.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.units` for the organization the
 * shell resolved, narrowed to the selected property, read through the
 * request-scoped Supabase client under row level security. Every value shown
 * is a column or a Hebrew name for one. Nothing is derived except the split
 * between what can be sold and what cannot, and that split is
 * `status === 'active'` — the same rule `loadRules` applies before the booking
 * engine will quote a unit at all.
 *
 * GATING, IN FOUR PLACES, AND NONE OF THEM IS THE MENU.
 * `requireGrant('property.view')` refuses the route before a query is built.
 * `can()` per row narrows to the properties this membership reaches, with
 * `family: 'inventory'`. `redact()` removes the three rates without
 * `rate.view_public` and the deposit without `booking.view_deposit`. And
 * `units_select` narrows by membership and `property_in_scope()` regardless of
 * all three.
 *
 * ── Why a draft unit gets a paragraph and not a grey badge ────────────────
 *
 * A unit whose status is not `active` has no rules row as far as
 * `loadRules` is concerned, so `checkAvailability` refuses it and the calendar
 * renders it blocked for every night of the year. From the outside that looks
 * like a bug — the unit exists, it has a price, and the system will not sell
 * it. The count is therefore stated above the table, in a sentence, before
 * anybody has to scroll to find the badge that explains it.
 *
 * NO PRICE IS ADDED UP HERE. A total across units of different capacities is
 * not a number that means anything, so none is offered. Every figure on screen
 * is one unit's own column, formatted for display and never recomputed.
 */
export default async function UnitsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('property.view'),
    shellContext(),
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  let units: readonly UnitListItem[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  // `/roles` is gated on `role.assign`, which reception and an accountant do
  // not hold — and they are exactly the readers who see a hidden column here.
  // Sending them to a screen that refuses them explains nothing, so the
  // sentence keeps its meaning and loses its link.
  const maySeeRoles = holdsGrant(actor, 'role.assign')

  try {
    const db = await createClient()
    units = await listUnits({
      db,
      actor,
      organizationId: actor.organizationId,
      propertyId,
    })
  } catch (error) {
    // A screen that renders nothing because a query failed must not look like
    // a business with no inventory. The failure is stated instead.
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const sellable = sellableUnits(units)
  const blocked = unsellableUnits(units)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        title="יחידות"
        lede={
          <>
            יחידה היא מה שאורח מזמין. הרשימה מוגבלת ליחידות שבטווח שלך — לא
            בהסתרה, אלא בשאילתה עצמה
            {propertyName ? `, ומצומצמת ל״${propertyName}״` : ''}.
          </>
        }
      />

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : units.length === 0 ? (
        // No filter exists on this screen beyond the property switcher, and an
        // empty result for a property in scope can only mean the property has
        // no units. `no_results` would be a lie.
        <ModuleEmptyState module="units" reason="no_data" />
      ) : (
        <>
          {blocked.length > 0 && (
            <Notice title="לא כל היחידות ניתנות למכירה" tone="strong">
              {blocked.length === 1
                ? 'יחידה אחת ברשימה אינה במצב פעיל'
                : `${blocked.length} יחידות ברשימה אינן במצב פעיל`}
              , ולכן מנוע ההזמנות מסרב להן: הן מופיעות ביומן כחסומות בכל
              התאריכים, וניסיון לפתוח עליהן הזמנה נדחה. זו אינה תקלה — זה מה
              שמצב היחידה אומר. {sellable.length} מתוך {units.length} ניתנות
              למכירה כרגע.
            </Notice>
          )}

          <DataTable
            caption="יחידות האירוח בארגון, לפי נכס"
            columns={[
              'יחידה',
              'נכס',
              'סוג',
              'מצב',
              'תפוסה',
              'חדרים',
              'מחיר בסיס ללילה',
              'פיקדון',
            ]}
          >
            {units.map((unit) => (
              <UnitRow key={unit.id} unit={unit} />
            ))}
          </DataTable>

          <p className="text-sm text-muted-foreground">
            מחירים ופיקדונות מוצגים למי שרשאי לראותם. אם עמודה מסומנת כמוסתרת,
            הערך קיים ואינו מוצג לך.
            {maySeeRoles ? (
              <>
                {' '}
                <Link
                  href="/roles"
                  className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  מסך התפקידים
                </Link>{' '}
                מראה אילו הרשאות פותחות אותה.
              </>
            ) : null}
          </p>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

function UnitRow({ unit }: { unit: UnitListItem }) {
  const note = UNIT_SELLABILITY_NOTE[unit.status as UnitStatus] ?? null

  return (
    <Row>
      <RowHeader>
        <span className="block">{unit.name}</span>
        <span
          dir="ltr"
          className="block font-mono text-xs text-muted-foreground"
        >
          {unit.code}
        </span>
      </RowHeader>

      {/* A property this reader cannot read is null, and stays null. A
          truncated uuid in a name column is worse than an admitted gap. */}
      <Cell className="text-muted-foreground">
        {unit.propertyName ?? 'נכס שאינו קריא לך'}
      </Cell>

      <Cell>{labelOr(UNIT_TYPE_LABEL, unit.unitType)}</Cell>

      <Cell>
        {/* The word is the message; the tone is a second, weaker signal. */}
        <Badge tone={statusTone(unit.status)}>
          {labelOr(UNIT_STATUS_LABEL, unit.status)}
        </Badge>
        {note && (
          <span className="mt-1 block max-w-56 text-xs text-muted-foreground">
            {note}
          </span>
        )}
      </Cell>

      <Cell className="tabular-nums">
        {unit.standardGuests} · עד {unit.maxGuests}
      </Cell>

      <Cell className="tabular-nums">
        {unit.bedrooms} חדרי שינה · {unit.bathrooms} מקלחות
        <span className="block text-xs text-muted-foreground">
          {unit.beds} מיטות
          {unit.sizeSqm === null ? '' : ` · ${unit.sizeSqm} מ״ר`}
        </span>
      </Cell>

      <Cell className="tabular-nums">
        {unit.basePriceAgorot === undefined ? (
          <Withheld />
        ) : (
          <>
            <span className="font-medium">
              {formatAgorot(unit.basePriceAgorot)}
            </span>
            <span className="block text-xs text-muted-foreground">
              ניקיון{' '}
              {unit.cleaningFeeAgorot === undefined
                ? '—'
                : formatAgorot(unit.cleaningFeeAgorot)}
              {unit.extraGuestPriceAgorot
                ? ` · אורח נוסף ${formatAgorot(unit.extraGuestPriceAgorot)}`
                : ''}
            </span>
          </>
        )}
      </Cell>

      <Cell className="tabular-nums">
        {unit.depositAgorot === undefined ? (
          <Withheld />
        ) : (
          formatAgorot(unit.depositAgorot)
        )}
      </Cell>
    </Row>
  )
}
