import type { Metadata } from 'next'

import Link from 'next/link'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../_lib/guard'
import {
  PROPERTY_STATUS_LABEL,
  PROPERTY_TYPE_LABEL,
  labelOr,
  statusTone,
} from './_lib/labels'
import { loadProperties, type PropertyListRow } from './_lib/load'

export const metadata: Metadata = { title: 'נכסים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The property list.
 *
 * GATED ON `property.view`, AT THE ROUTE. `requireGrant` refuses before a row
 * is read, and `loadProperties` asks `can()` again per property with
 * `family: 'inventory'` so a per-family scope narrowing applies. Row level
 * security refuses regardless of both. The sidebar entry is a hint and is not
 * part of any of it — deleting `menu.ts` would change no answer here.
 *
 * NOTHING ON THIS PAGE IS DERIVED. Every field is a column, and the one
 * computed number — how many units a property has — is counted from the unit
 * rows this reader was actually admitted to, so it cannot disagree with the
 * list the detail page then shows them.
 */
export default async function PropertiesPage() {
  const actor = await requireGrant('property.view')

  let properties: PropertyListRow[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  try {
    const db = await createClient()
    properties = await loadProperties({
      db,
      actor,
      organizationId: actor.organizationId,
    })
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          נכסים
        </h1>
        <p className="text-muted-foreground">
          נכס הוא המיקום הפיזי, והוא מחזיק את היחידות שנמכרות. הרשימה מוגבלת
          לנכסים שבטווח שלך — לא בהסתרה, אלא בשאילתה עצמה.
        </p>
      </header>

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : properties.length === 0 ? (
        // No filter exists on this screen, so an empty list can only mean the
        // module is empty for this reader. `no_results` would be a lie.
        <ModuleEmptyState module="properties" reason="no_data" />
      ) : (
        <ul className="grid gap-5 md:grid-cols-2">
          {properties.map((property) => (
            <li key={property.id}>
              <PropertyCard property={property} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

function PropertyCard({ property }: { property: PropertyListRow }) {
  const place = [property.city, property.region].filter(Boolean).join(', ')

  return (
    <Card className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle as="h2">
            <Link
              href={`/properties/${property.id}`}
              className="underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {property.name}
            </Link>
          </CardTitle>
          <CardDescription>
            {labelOr(PROPERTY_TYPE_LABEL, property.propertyType)}
            {place ? ` · ${place}` : ''}
          </CardDescription>
        </div>

        {/* The word is the message; the tone is a second, weaker signal. */}
        <Badge tone={statusTone(property.status)}>
          {labelOr(PROPERTY_STATUS_LABEL, property.status)}
        </Badge>
      </div>

      <dl className="mt-5 flex flex-col gap-2 text-sm">
        <Row label="יחידות">
          {property.visibleUnitCount === 0
            ? 'אין יחידות'
            : `${property.visibleUnitCount}`}
        </Row>
        <Row label="מינימום לילות">{property.minNights}</Row>
        <Row label="צ׳ק-אין / צ׳ק-אאוט">
          <span dir="ltr" className="tabular-nums">
            {property.defaultCheckInTime.slice(0, 5)} /{' '}
            {property.defaultCheckOutTime.slice(0, 5)}
          </span>
        </Row>
        <Row label="מזהה באתר">
          <span dir="ltr" className="font-mono text-xs">
            {property.slug}
          </span>
        </Row>
      </dl>
    </Card>
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
