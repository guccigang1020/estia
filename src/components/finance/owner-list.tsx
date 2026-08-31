/**
 * External property owners, and the properties each of them owns.
 *
 * ── There is no `owners` table, and this list does not invent one ─────────
 *
 * The schema models an external owner as what they are to the system: a
 * membership holding the `property_owner` role, scoped to the properties they
 * own. That is a real row, with a real status and a real scope, and it is what
 * `listOwners` reads. A table of made-up owner records would look better and
 * would be describing a database that does not exist.
 *
 * The same is true of the statement. `owner_statement.view` and
 * `owner_statement.issue` are in the catalogue and no `owner_statements` table
 * has been migrated, so this screen says the statement has not been issued
 * rather than rendering a document nobody produced.
 *
 * ── The name is a field, not the row ──────────────────────────────────────
 *
 * A reader without `user.view` sees that the business has three external
 * owners and which properties they hold, and does not see who they are. The
 * key is deleted by `redact()` rather than replaced with "בעלים", because a
 * placeholder makes two different people indistinguishable.
 *
 * No `"use client"`: rows in, markup out.
 */

import { WITHHELD } from '@/app/(app)/finance/_lib/labels'
import type { OwnerListItem } from '@/app/(app)/finance/_lib/queries'
import { Badge } from '@/components/ui/badge'

export type OwnerListProps = {
  owners: readonly OwnerListItem[]
}

/** `memberships.status`, worded. The vocabulary is `MEMBERSHIP_STATUSES`. */
const STATUS_LABEL: Readonly<Record<string, string>> = {
  invited: 'הוזמן ולא הצטרף',
  pending: 'ממתין לאישור',
  active: 'פעיל',
  suspended: 'מושהה',
  removed: 'הוסר',
}

export function OwnerList({ owners }: OwnerListProps) {
  return (
    <ul className="flex flex-col gap-4">
      {owners.map((owner) => (
        <li
          key={owner.membershipId}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="font-display text-base font-bold text-foreground">
                {'name' in owner ? (owner.name ?? WITHHELD) : WITHHELD}
              </h3>
              {'email' in owner && owner.email !== null && (
                <span dir="ltr" className="text-xs text-muted-foreground">
                  {owner.email}
                </span>
              )}
            </div>

            <Badge
              tone={owner.membershipStatus === 'active' ? 'brand' : 'neutral'}
            >
              {STATUS_LABEL[owner.membershipStatus] ?? owner.membershipStatus}
            </Badge>
          </div>

          <dl className="flex flex-col gap-1.5 text-sm">
            <dt className="text-xs text-muted-foreground">הנכסים שבבעלותו</dt>
            <dd className="text-foreground">
              {owner.properties.length === 0 ? (
                // A membership scoped to the whole organization, or to nothing.
                // Either way it names no property, and saying "all properties"
                // would be a guess about a commercial arrangement.
                <span className="text-muted-foreground">
                  ההרשאה שלו אינה מוגבלת לנכס מסוים
                </span>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {owner.properties.map((property) => (
                    <li key={property.id}>
                      <Badge tone="neutral">{property.name ?? WITHHELD}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>

          <p className="rounded-lg border border-border bg-muted px-4 py-2.5 text-xs text-muted-foreground">
            עוד לא הופק דוח בעלים. הדוח נבנה מרווח והפסד של הנכס לתקופה — הכנסה,
            הוצאות שיוחסו, ואז חלק הבעלים לפי המפתח שהוקפא על ההזמנה.
          </p>
        </li>
      ))}
    </ul>
  )
}
