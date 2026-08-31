import type { Metadata } from 'next'

import Link from 'next/link'

import { NewPropertyForm } from '@/components/management/new-property-form'
import { PageHeader } from '@/components/management/page-header'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

import { requireGrant } from '../../_lib/guard'
import { PROPERTY_TYPES, PROPERTY_TYPE_LABEL } from '../_lib/labels'

export const metadata: Metadata = { title: 'נכס חדש' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Adding a property.
 *
 * GATING. `requireGrant('property.create')` refuses the route.
 * `properties_insert` in the database requires the same grant independently,
 * and `properties_select` — which admits the list next door — requires none of
 * it, only scope. The two are separate on purpose and neither is redundant.
 *
 * THE TYPE LIST IS THE ENUM'S, NOT THIS FILE'S. `PROPERTY_TYPES` and its
 * Hebrew labels are the ones the properties list already renders, read from
 * `properties/_lib/labels.ts`. A second copy here would eventually offer a
 * type the list could not name, and the test beside that file — which asserts
 * every member of the tuple has a label — would not catch it.
 *
 * THE WRITE PATH DOES NOT EXIST. No module in `src/lib` defines an operation
 * that creates a property, and this route deliberately does not add one from
 * the outside: a direct `insert` would skip `defineOperation` and would commit
 * a change with no audit row. The form states that, and there is no server
 * action in this route — an action that always refuses is still an endpoint,
 * and there is nothing for it to do.
 */
export default async function NewPropertyPage() {
  await requireGrant('property.create')

  const types = PROPERTY_TYPES.map((value) => ({
    value,
    label: PROPERTY_TYPE_LABEL[value],
  }))

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/properties"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה לרשימת הנכסים
        </Link>
      </nav>

      <PageHeader
        title="נכס חדש"
        lede="נכס הוא המיקום הפיזי — כתובת אחת. הוא מחזיק את היחידות שנמכרות, את הצוות שמטפל בהן ואת הדוחות לבעלים. יחידות נוספות אחריו."
      />

      <Card>
        <CardHeader>
          <CardTitle as="h2">פרטי הנכס</CardTitle>
          <CardDescription>
            השעות, מינימום הלילות ושיעור המע״מ הם ברירות המחדל של העמודות עצמן
            במיגרציה, ולא מספרים שנבחרו כאן. כך נכס שנוצר במסך הזה מוגדר בדיוק
            כמו נכס שנוצר בכל דרך אחרת.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          <NewPropertyForm types={types} />
        </div>
      </Card>
    </div>
  )
}
