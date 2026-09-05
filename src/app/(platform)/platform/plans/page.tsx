import type { Metadata } from 'next'

import Link from 'next/link'

import {
  ConsoleNotice,
  ConsolePage,
  ConsoleTable,
} from '@/components/platform/console-chrome'
import {
  daysUntil,
  hebrewDate,
  SUBSCRIPTION_STATUS_LABEL,
} from '@/components/platform/labels'
import { Badge } from '@/components/ui/badge'
import { toLogEntry } from '@/lib/errors'
import {
  listPlatformOrganizations,
  type OrganizationSummary,
} from '@/lib/platform'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../../_lib/guard'

export const metadata: Metadata = { title: 'חבילות ומנויים · קונסולת ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Who is on what, and what expires when.
 *
 * ══ READ ONLY, AND THAT IS STATED RATHER THAN IMPLIED ═════════════════════
 *
 * There is no control on this screen for moving a customer to a different
 * package, changing a price, or extending a trial, and there is no write path
 * behind it. `platform.plan.manage` exists in the catalogue and is held by
 * `platform_super_admin`; nothing in 0041 opens a write for it, because moving
 * a customer between packages is a billing act — it changes what they are
 * charged, and the agreed-price snapshot is the column that decides that — and
 * a billing act with no billing integration behind it would be a screen that
 * changes a number and charges nobody.
 *
 * An absent button is a missing feature. A stated refusal is a decision. This
 * says which one it is.
 *
 * ── The prices shown are the agreed ones ──────────────────────────────────
 *
 * Not the catalogue's. A customer who signed up before a price change pays
 * what they agreed, forever, and that is a property of
 * `organization_subscriptions` rather than a promise somebody remembers to
 * honour. Showing the list price here would be showing a number nobody is
 * charged, on the one screen where somebody is deciding what to charge.
 *
 * GATING. `platform.organization.view` — the same reads the accounts list
 * makes, grouped by package instead of listed by customer.
 */
export default async function PlatformPlansPage() {
  await requirePlatformGrant('platform.organization.view')

  const correlationId = crypto.randomUUID()
  let organizations: readonly OrganizationSummary[] = []
  let failure: unknown = null

  try {
    organizations = await listPlatformOrganizations(await createClient())
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const byPlan = groupByPlan(organizations)
  const trials = organizations
    .filter((organization) => organization.subscription?.trialEndsAt)
    .sort(
      (a, b) =>
        new Date(a.subscription!.trialEndsAt!).getTime() -
        new Date(b.subscription!.trialEndsAt!).getTime(),
    )
  const attention = organizations.filter(
    (organization) =>
      organization.subscription === null ||
      organization.subscription.status === 'past_due' ||
      organization.subscription.status === 'cancelled',
  )

  return (
    <ConsolePage
      title="חבילות ומנויים"
      lede="מי נמצא על מה, מה נגמר מתי, ומי דורש טיפול. המסך קורא בלבד — ראה ההסבר למטה."
    >
      <ConsoleNotice title="אין כאן שינוי חבילה, וזו החלטה">
        המעבר בין חבילות הוא פעולה חשבונאית: הוא משנה את מה שהלקוח מחויב בו,
        והמחיר המוסכם שנשמר במנוי הוא העמודה שקובעת אותו. אין במוצר אינטגרציית
        חיוב, ומסך שהיה משנה חבילה בלי לחייב איש היה משנה מספר ולא כסף. ההרשאה{' '}
        <code dir="ltr">platform.plan.manage</code> קיימת בקטלוג ואין מאחוריה
        נתיב כתיבה — היעדר הכפתור כאן הוא הצהרה, לא פיצ׳ר שנשכח.
      </ConsoleNotice>

      {failure !== null ? (
        <ConsoleNotice title="הנתונים לא נטענו" tone="warning">
          מזהה מעקב: <code dir="ltr">{correlationId}</code>. הרשימות הריקות
          שמתחת אינן אומרות שאין מנויים.
        </ConsoleNotice>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-display text-lg font-bold tracking-tight">
              פילוח לפי חבילה
            </h2>
            {byPlan.length === 0 ? (
              <ConsoleNotice title="אין מנויים">
                אין אף שורת מנוי פעילה במערכת.
              </ConsoleNotice>
            ) : (
              <ConsoleTable
                caption="מספר הלקוחות בכל חבילה והמחיר המוסכם הממוצע"
                head={['חבילה', 'לקוחות', 'טווח מחיר מוסכם (חודשי)']}
              >
                {byPlan.map((group) => (
                  <tr key={group.planCode}>
                    <th
                      scope="row"
                      className="px-4 py-3 text-start font-medium"
                    >
                      {group.planName}
                      <code
                        dir="ltr"
                        className="ms-2 text-xs text-muted-foreground"
                      >
                        {group.planCode}
                      </code>
                    </th>
                    <td className="px-4 py-3">{group.count}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {group.minAgorot === group.maxAgorot
                        ? formatAgorot(group.minAgorot)
                        : `${formatAgorot(group.minAgorot)} – ${formatAgorot(group.maxAgorot)}`}
                      {group.minAgorot !== group.maxAgorot && (
                        <span className="block text-xs text-muted-foreground">
                          לקוחות ותיקים שומרים על המחיר שסוכם איתם
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </ConsoleTable>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-lg font-bold tracking-tight">
              התנסויות
            </h2>
            {trials.length === 0 ? (
              <ConsoleNotice title="אין התנסויות פתוחות">
                אין מנוי שנושא תאריך סיום התנסות.
              </ConsoleNotice>
            ) : (
              <ConsoleTable
                caption="התנסויות לפי מועד סיום"
                head={['ארגון', 'חבילה', 'מצב', 'נגמרת', 'ימים']}
              >
                {trials.map((organization) => {
                  const days = daysUntil(organization.subscription!.trialEndsAt)
                  return (
                    <tr key={organization.id}>
                      <th
                        scope="row"
                        className="px-4 py-3 text-start font-medium"
                      >
                        <Link
                          href={`/platform/organizations/${organization.id}`}
                          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {organization.name}
                        </Link>
                      </th>
                      <td className="px-4 py-3">
                        {organization.subscription!.planName}
                      </td>
                      <td className="px-4 py-3">
                        {
                          SUBSCRIPTION_STATUS_LABEL[
                            organization.subscription!.status
                          ]
                        }
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {hebrewDate(organization.subscription!.trialEndsAt)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {days === null ? (
                          '—'
                        ) : days < 0 ? (
                          <span className="font-semibold text-danger">
                            פגה לפני {Math.abs(days)}
                          </span>
                        ) : (
                          `עוד ${days}`
                        )}
                      </td>
                    </tr>
                  )
                })}
              </ConsoleTable>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-lg font-bold tracking-tight">
              דורש טיפול
            </h2>
            {attention.length === 0 ? (
              <ConsoleNotice title="אין חשבון שדורש טיפול">
                לכל ארגון יש שורת מנוי, ואף אחת מהן אינה בפיגור תשלום ואינה
                מבוטלת.
              </ConsoleNotice>
            ) : (
              <ConsoleTable
                caption="חשבונות ללא מנוי, בפיגור או מבוטלים"
                head={['ארגון', 'הבעיה']}
              >
                {attention.map((organization) => (
                  <tr key={organization.id}>
                    <th
                      scope="row"
                      className="px-4 py-3 text-start font-medium"
                    >
                      <Link
                        href={`/platform/organizations/${organization.id}`}
                        className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {organization.name}
                      </Link>
                    </th>
                    <td className="px-4 py-3 text-sm">
                      {organization.subscription === null ? (
                        <>
                          <Badge tone="accent">אין מנוי</Badge> הבעלים נתקל במסך
                          &quot;אין מנוי&quot; ואינו מגיע ללוח הבקרה.
                        </>
                      ) : organization.subscription.status === 'past_due' ? (
                        <>
                          <Badge tone="accent">פיגור תשלום</Badge> החשבון עדיין
                          עובד. הפיצ׳רים בתשלום נשארים פתוחים עד ביטול.
                        </>
                      ) : (
                        <>
                          <Badge tone="accent">מבוטל</Badge> כל היכולות מלבד
                          הליבה כבויות. העסק עדיין רואה את ההזמנות שלו ואינו
                          נעול מחוץ לנתונים שלו.
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </ConsoleTable>
            )}
          </section>
        </>
      )}
    </ConsolePage>
  )
}

interface PlanGroup {
  planCode: string
  planName: string
  count: number
  minAgorot: number
  maxAgorot: number
}

/**
 * Customers per package, with the spread of what they actually pay.
 *
 * The spread is the interesting column and is the reason this is not a count:
 * a package whose agreed prices range from ₪449 to ₪649 is a package with
 * grandfathered customers on it, and whoever is about to change its price
 * needs to see that before they do.
 */
function groupByPlan(
  organizations: readonly OrganizationSummary[],
): readonly PlanGroup[] {
  const groups = new Map<string, PlanGroup>()

  for (const organization of organizations) {
    const subscription = organization.subscription
    if (!subscription) continue

    const price =
      subscription.interval === 'yearly'
        ? Math.round(subscription.agreedYearlyAgorot / 12)
        : subscription.agreedMonthlyAgorot

    const existing = groups.get(subscription.planCode)
    if (existing) {
      existing.count += 1
      existing.minAgorot = Math.min(existing.minAgorot, price)
      existing.maxAgorot = Math.max(existing.maxAgorot, price)
    } else {
      groups.set(subscription.planCode, {
        planCode: subscription.planCode,
        planName: subscription.planName,
        count: 1,
        minAgorot: price,
        maxAgorot: price,
      })
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count)
}
