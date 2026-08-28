import type { Metadata } from 'next'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { can, holdsGrant } from '@/lib/authz/can'
import { toLogEntry } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../../_lib/guard'
import {
  PROPERTY_STATUS_LABEL,
  PROPERTY_TYPE_LABEL,
  UNIT_SELLABILITY_NOTE,
  UNIT_STATUS_LABEL,
  UNIT_TYPE_LABEL,
  labelOr,
  statusTone,
  type UnitStatus,
} from '../_lib/labels'
import {
  loadProperty,
  loadUnits,
  type PropertyRecord,
  type UnitRecord,
} from '../_lib/load'

export const metadata: Metadata = { title: 'נכס' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One property, and its units.
 *
 * THREE SEPARATE QUESTIONS, THREE SEPARATE CHECKS.
 *
 *   1. May this person open a property at all? `requireGrant('property.view')`,
 *      before a row is read.
 *   2. May they open *this* property? `loadProperty` asks `can()` with the
 *      property named, and an out-of-scope one comes back as `null` — which
 *      becomes a 404, not a refusal. Saying "you may not see וילה הגליל"
 *      confirms that וילה הגליל is on this business's books, which is the
 *      reasoning `assertAgentReach` already settled for inventory.
 *   3. May they see the units? `unit.manage` — its own grant, asked with the
 *      property named. A reader with `property.view` alone gets the property
 *      and is told plainly that the unit list needs a different right, rather
 *      than being shown an empty section that reads like a business with no
 *      rooms.
 *
 * RATES ARE A FOURTH QUESTION. `rate.view_public` — the price a guest is
 * quoted. A housekeeping supervisor manages units and has no business seeing
 * what they sell for.
 */
export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ propertyId: string }>
}) {
  const [actor, { propertyId }] = await Promise.all([
    requireGrant('property.view'),
    params,
  ])

  const canManageUnits = can(actor, 'unit.manage', {
    organizationId: actor.organizationId,
    propertyId,
    family: 'inventory',
  })
  const showRates = holdsGrant(actor, 'rate.view_public')

  let property: PropertyRecord | null = null
  let units: UnitRecord[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  try {
    const db = await createClient()
    property = await loadProperty({
      db,
      actor,
      organizationId: actor.organizationId,
      propertyId,
    })

    if (property && canManageUnits) {
      units = await loadUnits({
        db,
        organizationId: actor.organizationId,
        propertyId,
      })
    }
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  if (failure) {
    return (
      <Shell>
        <DomainErrorPanel
          error={failure}
          correlationId={correlationId}
          as="h1"
        />
      </Shell>
    )
  }

  if (!property) notFound()

  return (
    <Shell>
      <header className="flex flex-col gap-3">
        <Link
          href="/properties"
          className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          חזרה לרשימת הנכסים
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              {property.name}
            </h1>
            <p className="text-muted-foreground">
              {labelOr(PROPERTY_TYPE_LABEL, property.propertyType)}
              {property.city ? ` · ${property.city}` : ''}
            </p>
          </div>
          <Badge tone={statusTone(property.status)}>
            {labelOr(PROPERTY_STATUS_LABEL, property.status)}
          </Badge>
        </div>

        {property.description && (
          <p className="max-w-prose text-sm text-muted-foreground">
            {property.description}
          </p>
        )}
      </header>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle as="h2">פרטי הנכס</CardTitle>
            <CardDescription>
              כל שדה כאן הוא עמודה בטבלה, ולא חישוב של המסך.
            </CardDescription>
          </CardHeader>
          <dl className="mt-5 flex flex-col gap-2.5 text-sm">
            <Row label="כתובת">
              {[property.addressLine1, property.city, property.region]
                .filter(Boolean)
                .join(', ') || '—'}
            </Row>
            <Row label="מדינה">
              <span dir="ltr">{property.country}</span>
            </Row>
            <Row label="אזור זמן">
              <span dir="ltr" className="font-mono text-xs">
                {property.timezone}
              </span>
            </Row>
            <Row label="מטבע">
              <span dir="ltr">{property.currency}</span>
            </Row>
            <Row label="מזהה באתר">
              <span dir="ltr" className="font-mono text-xs">
                {property.slug}
              </span>
            </Row>
          </dl>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">כללי בית ומיסוי</CardTitle>
            <CardDescription>
              המע״מ נשמר בנקודות בסיס כמספר שלם — 1700 הוא 17% — כדי שחשבונית לא
              תסתדר בגלל עיגול.
            </CardDescription>
          </CardHeader>
          <dl className="mt-5 flex flex-col gap-2.5 text-sm">
            <Row label="צ׳ק-אין">
              <span dir="ltr" className="tabular-nums">
                {property.defaultCheckInTime.slice(0, 5)}
              </span>
            </Row>
            <Row label="צ׳ק-אאוט">
              <span dir="ltr" className="tabular-nums">
                {property.defaultCheckOutTime.slice(0, 5)}
              </span>
            </Row>
            <Row label="מינימום לילות">{property.minNights}</Row>
            <Row label="שיעור מע״מ">
              <span className="tabular-nums">{property.taxRateBps / 100}%</span>
            </Row>
            <Row label="המחירים כוללים מע״מ">
              {property.taxIncludedInPrice ? 'כן' : 'לא'}
            </Row>
            <Row label="פטור מע״מ לתייר">
              {property.touristVatExempt ? 'כן' : 'לא'}
            </Row>
          </dl>

          {property.houseRules && (
            <p className="mt-5 border-t border-border pt-4 text-sm whitespace-pre-line text-muted-foreground">
              {property.houseRules}
            </p>
          )}
        </Card>
      </div>

      <section className="mt-8 flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
            יחידות
          </h2>
          <Link
            href="/calendar"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            לראות את הזמינות שלהן ביומן
          </Link>
        </div>

        {!canManageUnits ? (
          <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
            רשימת היחידות דורשת הרשאה נפרדת (
            <span dir="ltr" className="font-mono text-xs">
              unit.manage
            </span>
            ). היא לא הוסתרה כי אין יחידות — היא לא נקראה כלל.
          </p>
        ) : units.length === 0 ? (
          <ModuleEmptyState module="units" reason="no_data" />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {units.map((unit) => (
              <li key={unit.id}>
                <UnitCard unit={unit} showRates={showRates} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  )
}

/* ------------------------------------------------------------- fragments -- */

function UnitCard({
  unit,
  showRates,
}: {
  unit: UnitRecord
  showRates: boolean
}) {
  const note = UNIT_SELLABILITY_NOTE[unit.status as UnitStatus] ?? null

  return (
    <Card className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle as="h3">{unit.name}</CardTitle>
          <CardDescription>
            <span dir="ltr">{unit.code}</span> ·{' '}
            {labelOr(UNIT_TYPE_LABEL, unit.unitType)}
          </CardDescription>
        </div>
        <Badge tone={statusTone(unit.status)}>
          {labelOr(UNIT_STATUS_LABEL, unit.status)}
        </Badge>
      </div>

      {note && (
        <p className="mt-3 flex items-start gap-2 text-sm text-warning">
          <span aria-hidden="true">!</span>
          <span>{note}</span>
        </p>
      )}

      <dl className="mt-4 flex flex-col gap-2 text-sm">
        <Row label="תפוסה">
          {unit.standardGuests} רגילה · עד {unit.maxGuests}
        </Row>
        <Row label="חדרי שינה / מיטות">
          {unit.bedrooms} · {unit.beds}
        </Row>
        <Row label="חדרי רחצה">{unit.bathrooms}</Row>
        {unit.sizeSqm !== null && <Row label="שטח">{unit.sizeSqm} מ״ר</Row>}
        <Row label="מינימום לילות">
          {unit.minNights}
          {unit.maxNights !== null ? ` · מקסימום ${unit.maxNights}` : ''}
        </Row>
        <Row label="צ׳ק-אין / צ׳ק-אאוט">
          <span dir="ltr" className="tabular-nums">
            {unit.checkInTime.slice(0, 5)} / {unit.checkOutTime.slice(0, 5)}
          </span>
        </Row>
      </dl>

      <div className="mt-4 border-t border-border pt-4">
        {!showRates ? (
          <p className="text-sm text-muted-foreground">
            תעריפי היחידה דורשים הרשאה נפרדת (
            <span dir="ltr" className="font-mono text-xs">
              rate.view_public
            </span>
            ).
          </p>
        ) : unit.basePriceAgorot === 0 ? (
          <p className="text-sm text-muted-foreground">
            ליחידה עוד לא נקבע מחיר ללילה.
          </p>
        ) : (
          <dl className="flex flex-col gap-2 text-sm">
            <Row label="מחיר ללילה">
              <Money value={unit.basePriceAgorot} />
            </Row>
            {unit.extraGuestPriceAgorot > 0 && (
              <Row label="אורח נוסף ללילה">
                <Money value={unit.extraGuestPriceAgorot} />
              </Row>
            )}
            {unit.cleaningFeeAgorot > 0 && (
              <Row label="דמי ניקיון">
                <Money value={unit.cleaningFeeAgorot} />
              </Row>
            )}
            {unit.depositAgorot > 0 && (
              <Row label="פיקדון">
                <Money value={unit.depositAgorot} />
              </Row>
            )}
          </dl>
        )}
      </div>
    </Card>
  )
}

/** `formatAgorot` is the product's one money formatter. There is no second. */
function Money({ value }: { value: number }) {
  return (
    <span dir="ltr" className="tabular-nums">
      {formatAgorot(value)}
    </span>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {children}
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-medium text-foreground">
        {children}
      </dd>
    </div>
  )
}
