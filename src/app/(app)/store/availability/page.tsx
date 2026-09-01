import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { StoreLock } from '@/components/store/store-lock'
import { StoreHeader, StoreNav } from '@/components/store/store-chrome'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { StoreRepository, type StoreAvailabilityRule } from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireStoreGrant } from '../_lib/gate'

export const metadata: Metadata = { title: 'זמינות · חנות' }

/** ISO weekday, 1 = Monday … 7 = Sunday. Matches 0029's `pickup_days`. */
const WEEKDAY_NAME: Readonly<Record<number, string>> = {
  1: 'שני',
  2: 'שלישי',
  3: 'רביעי',
  4: 'חמישי',
  5: 'שישי',
  6: 'שבת',
  7: 'ראשון',
}

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. When things can actually be had.
 *
 * ── The distinction this screen has to make visible ──────────────────────
 *
 * A rule either FORBIDS or PERMITS, and the two behave completely differently:
 * a forbidding rule blocks the days it matches, while a permitting rule is a
 * WHITELIST — where any permitting rule exists for an item, the service must
 * satisfy at least one of them, and every other day is refused.
 *
 * That is what makes "the DJ works Thursday to Saturday" one row instead of
 * four blackouts, and it is also the rule an owner is most likely to get
 * backwards. So each row is rendered as a sentence about consequences rather
 * than as a set of fields.
 */
export default async function StoreAvailabilityPage() {
  const [access, context] = await Promise.all([
    requireStoreGrant('product.view'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <StoreLock
        entitlement={access.entitlement}
        title="החנות אינה כלולה בחבילה שלכם"
        body="כאן היו הכללים שקובעים מתי אפשר להזמין כל דבר."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  let rules: readonly StoreAvailabilityRule[] = []
  let names: Record<string, string> = {}
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    const repository = new StoreRepository(db)
    const organizationId = access.actor.organizationId

    const [loaded, items] = await Promise.all([
      repository.availabilityRules(organizationId),
      repository.items({ organizationId }),
    ])

    rules = loaded
    names = Object.fromEntries(items.map((item) => [item.id, item.name]))
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <StoreHeader
        title="זמינות"
        lead="מתי אפשר להזמין, ומתי לא. כלל בלי פריט חל על הכול."
      />
      <StoreNav current="/store/availability" />

      {failure ? (
        <ActionError error={failure.error} />
      ) : rules.length === 0 ? (
        <EmptyState
          illustration="calendar"
          as="h2"
          title="אין כללי זמינות"
          body="בלי כללים, כל פריט זמין בכל יום — בכפוף לזמן ההתראה ולכמות היומית שהגדרתם עליו. כללים נחוצים כשמשהו ניתן רק בימים מסוימים, או כשאתם סוגרים לתקופה."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2">
              {rules.length === 1 ? 'כלל אחד' : `${rules.length} כללים`}
            </CardTitle>
          </CardHeader>

          <ul className="mt-4 flex flex-col divide-y divide-border">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-col gap-1.5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={rule.isBlocking ? 'neutral' : 'brand'}>
                    {rule.isBlocking ? 'חוסם' : 'מתיר'}
                  </Badge>
                  <span className="font-medium text-foreground">
                    {rule.itemId === null
                      ? 'כל הפריטים'
                      : (names[rule.itemId] ?? 'פריט שאינו גלוי לך')}
                  </span>
                  {!rule.isActive && <Badge>לא פעיל</Badge>}
                </div>

                <p className="text-sm text-muted-foreground">
                  {describe(rule)}
                </p>

                {/* The consequence, spelled out. A permitting rule read as a
                    forbidding one is the mistake that closes a shop. */}
                <p className="text-xs text-muted-foreground">
                  {rule.isBlocking
                    ? 'בתאריכים האלה לא ניתן להזמין.'
                    : 'רק בתאריכים האלה ניתן להזמין — בכל מועד אחר הפריט יסורב.'}
                </p>

                {rule.maxPerDay !== null && (
                  <p className="text-xs text-muted-foreground">
                    מגביל ל־{rule.maxPerDay} ביום, גם אם הפריט עצמו מרשה יותר.
                  </p>
                )}

                {rule.note && (
                  <p className="text-xs text-muted-foreground">
                    מה שהאורח יראה: ״{rule.note}״
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function describe(rule: StoreAvailabilityRule): string {
  const parts: string[] = []

  if (rule.weekdays.length > 0) {
    parts.push(
      `ימי ${rule.weekdays.map((day) => WEEKDAY_NAME[day] ?? day).join(', ')}`,
    )
  }

  if (rule.fromDate && rule.toDate) {
    parts.push(`מ־${rule.fromDate} עד ${rule.toDate}`)
  } else if (rule.fromDate) {
    parts.push(`מ־${rule.fromDate}`)
  } else if (rule.toDate) {
    parts.push(`עד ${rule.toDate}`)
  }

  if (rule.fromTime || rule.toTime) {
    parts.push(
      `בין ${rule.fromTime?.slice(0, 5) ?? '00:00'} ל־${rule.toTime?.slice(0, 5) ?? '23:59'}`,
    )
  }

  if (rule.propertyId !== null) parts.push('בנכס אחד בלבד')

  return parts.length > 0 ? parts.join(' · ') : 'כל התאריכים'
}
