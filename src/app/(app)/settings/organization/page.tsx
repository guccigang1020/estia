import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  BUSINESS_TYPE_LABEL,
  isBusinessType,
} from '../../onboarding/_lib/schema'
import { OrganizationSettingsForm } from './organization-settings-form'

export const metadata: Metadata = { title: 'פרטי הארגון' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The organization, after onboarding.
 *
 * GATING. `requireGrant('organization.settings.edit')` refuses the route, and
 * `updateOrganizationAction` refuses again with `assertCan` before it writes.
 * Under both sits `organizations_update`, whose policy demands the same grant
 * — three independent refusals, which is what "hiding a menu item is not
 * enforcement" means in practice.
 *
 * WHAT IS SHOWN AND WHAT IS NOT. The fields onboarding collected, plus the
 * facts a person needs to recognise the workspace they are editing: the slug,
 * the lifecycle status, the currency and the locale. The last two are read
 * from the row rather than assumed, because a value that is fixed in the
 * wizard today is not necessarily fixed in the database forever.
 *
 * Nothing here is invented. If the read fails, the failure is what is
 * rendered — an empty form pre-filled with defaults would invite somebody to
 * save over their real settings with fabricated ones.
 */
export default async function OrganizationSettingsPage() {
  const [, context] = await Promise.all([
    requireGrant('organization.settings.edit'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('organizations')
    .select(
      'id, name, slug, business_type, timezone, currency, locale, status, version',
    )
    .eq('id', context.actor.organizationId)
    .maybeSingle()

  if (error || !data) {
    const safe = toSafeResponse(
      error ?? new Error('organization row not readable'),
      crypto.randomUUID(),
    )
    return (
      <Frame>
        <ActionError error={safe.error} />
      </Frame>
    )
  }

  const businessType = data.business_type as string
  const status = data.status as string

  return (
    <Frame>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle as="h2">{data.name as string}</CardTitle>
            <Badge tone={status === 'active' ? 'brand' : 'neutral'}>
              {STATUS_LABEL[status] ?? status}
            </Badge>
          </div>
          <CardDescription>
            השינויים כאן משפיעים על כל מי שעובד בארגון, ועל מה שמופיע ללקוחות
            בחשבוניות ובאישורי הזמנה.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          <OrganizationSettingsForm
            slug={data.slug as string}
            initialName={data.name as string}
            initialBusinessType={
              isBusinessType(businessType) ? businessType : 'other'
            }
            initialTimezone={data.timezone as string}
            initialVersion={data.version as number}
          />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">מה שלא נערך כאן</CardTitle>
          <CardDescription>
            שני הערכים האלה נקראים מהרשומה עצמה, ולא מהקוד. אין להם עדיין מסך
            עריכה, ולכן הם מוצגים ולא ניתנים לשינוי — עדיף להראות את האמת מאשר
            שדה שנראה עריך ואינו נשמר.
          </CardDescription>
        </CardHeader>

        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">מטבע</dt>
            <dd dir="ltr" className="font-medium text-foreground">
              {data.currency as string}
            </dd>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">שפה ואזור</dt>
            <dd dir="ltr" className="font-medium text-foreground">
              {data.locale as string}
            </dd>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">סוג העסק שנשמר</dt>
            <dd className="font-medium text-foreground">
              {isBusinessType(businessType)
                ? BUSINESS_TYPE_LABEL[businessType]
                : businessType}
            </dd>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">גרסת הרשומה</dt>
            <dd dir="ltr" className="font-medium text-foreground">
              {data.version as number}
            </dd>
          </div>
        </dl>
      </Card>
    </Frame>
  )
}

const STATUS_LABEL: Record<string, string> = {
  onboarding: 'בהצטרפות',
  active: 'פעיל',
  suspended: 'מושהה',
  closed: 'סגור',
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          פרטי הארגון
        </h1>
        <p className="max-w-prose text-muted-foreground">
          מה שהוזן בהצטרפות, וכל מה שאפשר לתקן אחריה.
        </p>
      </header>
      {children}
    </div>
  )
}
