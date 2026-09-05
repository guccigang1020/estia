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
  ORGANIZATION_STATUS_LABEL,
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

export const metadata: Metadata = { title: 'חשבונות · קונסולת ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Every customer account.
 *
 * ── Why the price shown is not the plan's price ───────────────────────────
 *
 * `agreedMonthlyAgorot` is what this customer actually pays, snapshotted at
 * signup and never refreshed when the catalogue changes — that is the whole
 * reason the column exists (see the header of 0003). Showing the plan's
 * current price beside a customer's name would be showing a number nobody is
 * charged, which on a support console is the number somebody quotes back to
 * them on the telephone.
 *
 * ── A missing subscription is a state, not a loading failure ──────────────
 *
 * An organization with no live subscription row is exactly what the customer
 * experiences as `no_subscription` in `shellContext()` — they sign in and get
 * a frame with an explanation instead of their dashboard. It is one of the
 * things a support console exists to notice, so it is rendered as its own
 * thing and never filled in with a default package.
 *
 * GATING. `platform.organization.view`. The policy
 * `organizations_platform_select` requires the same grant independently.
 */
export default async function PlatformOrganizationsPage() {
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

  return (
    <ConsolePage
      title="חשבונות לקוח"
      lede="כל ארגון במערכת, החבילה שהוא נמצא עליה, והמחיר שסוכם איתו בפועל — לא מחיר הקטלוג הנוכחי."
    >
      {failure !== null ? (
        <ConsoleNotice title="רשימת החשבונות לא נטענה" tone="warning">
          לא ניתן היה לקרוא את הטבלה. הרשימה הריקה שמתחת אינה אומרת שאין לקוחות.
          מזהה מעקב: <code dir="ltr">{correlationId}</code>
        </ConsoleNotice>
      ) : organizations.length === 0 ? (
        <ConsoleNotice title="אין עדיין אף חשבון">
          המסך קורא את <code dir="ltr">organizations</code> דרך המדיניות
          <code dir="ltr"> organizations_platform_select</code>. הוא ריק כי אין
          שורות, ולא כי משהו נכשל — קריאה שנכשלה מוצגת כהודעת שגיאה ולא כרשימה
          ריקה.
        </ConsoleNotice>
      ) : (
        <ConsoleTable
          caption="חשבונות הלקוח של ESTIA"
          head={[
            'ארגון',
            'מצב',
            'חבילה',
            'מצב מנוי',
            'מחיר מוסכם',
            'התנסות',
            'נפתח',
          ]}
        >
          {organizations.map((organization) => (
            <OrganizationRow
              key={organization.id}
              organization={organization}
            />
          ))}
        </ConsoleTable>
      )}
    </ConsolePage>
  )
}

function OrganizationRow({
  organization,
}: {
  organization: OrganizationSummary
}) {
  const subscription = organization.subscription
  const trialDays = daysUntil(subscription?.trialEndsAt ?? null)

  return (
    <tr>
      <td className="px-4 py-3">
        <Link
          href={`/platform/organizations/${organization.id}`}
          className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {organization.name}
        </Link>
        <span dir="ltr" className="block text-xs text-muted-foreground">
          {organization.slug}
        </span>
      </td>

      <td className="px-4 py-3">
        <Badge
          tone={organization.status === 'suspended' ? 'accent' : 'neutral'}
        >
          {ORGANIZATION_STATUS_LABEL[organization.status]}
        </Badge>
      </td>

      {subscription ? (
        <>
          <td className="px-4 py-3">
            {subscription.planName}
            <span dir="ltr" className="block text-xs text-muted-foreground">
              {subscription.planCode}
            </span>
          </td>
          <td className="px-4 py-3">
            {SUBSCRIPTION_STATUS_LABEL[subscription.status]}
          </td>
          <td className="px-4 py-3 whitespace-nowrap">
            {formatAgorot(
              subscription.interval === 'yearly'
                ? subscription.agreedYearlyAgorot
                : subscription.agreedMonthlyAgorot,
            )}
            <span className="block text-xs text-muted-foreground">
              {subscription.interval === 'yearly' ? 'לשנה' : 'לחודש'}
            </span>
          </td>
          <td className="px-4 py-3 whitespace-nowrap">
            {subscription.trialEndsAt === null ? (
              '—'
            ) : (
              <>
                {hebrewDate(subscription.trialEndsAt)}
                <span
                  className={
                    trialDays !== null && trialDays < 0
                      ? 'block text-xs font-semibold text-danger'
                      : 'block text-xs text-muted-foreground'
                  }
                >
                  {trialDays === null
                    ? ''
                    : trialDays < 0
                      ? `פגה לפני ${Math.abs(trialDays)} ימים`
                      : `עוד ${trialDays} ימים`}
                </span>
              </>
            )}
          </td>
        </>
      ) : (
        /*
          Four cells, one sentence. Not a row of dashes: "no subscription" is a
          single fact about this account and it is the reason its owner cannot
          sign in past the landing page.
        */
        <td className="px-4 py-3 text-sm text-danger" colSpan={4}>
          אין שורת מנוי פעילה. הבעלים נתקל במסך &quot;אין מנוי&quot; ואינו מגיע
          ללוח הבקרה.
        </td>
      )}

      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
        {hebrewDate(organization.createdAt)}
      </td>
    </tr>
  )
}
