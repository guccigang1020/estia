import type { Metadata } from 'next'

import { notFound } from 'next/navigation'

import {
  ConsoleFacts,
  ConsoleNotice,
  ConsolePage,
  ConsoleTable,
} from '@/components/platform/console-chrome'
import { CapabilityEditor } from '@/components/platform/capability-editor'
import { LifecycleControls } from '@/components/platform/lifecycle-controls'
import { SupportViewPanel } from '@/components/platform/support-view-panel'
import {
  hebrewDate,
  hebrewMoment,
  ORGANIZATION_STATUS_LABEL,
  QUOTA_LABEL,
  SUBSCRIPTION_STATUS_LABEL,
} from '@/components/platform/labels'
import { Badge } from '@/components/ui/badge'
import { toLogEntry } from '@/lib/errors'
import {
  capabilityStates,
  isOverridden,
  limitStates,
  listOrganizationMembers,
  listPlatformAuditEvents,
  listSupportViews,
  loadOrganizationUsage,
  loadPlatformOrganization,
  mayUse,
  type LimitState,
  type OrganizationDetail,
  type Person,
  type PlatformAuditEvent,
} from '@/lib/platform'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../../../_lib/guard'
import {
  closeSupportViewAction,
  openSupportViewAction,
  restoreOrganizationAction,
  setCapabilitiesAction,
  suspendOrganizationAction,
} from './_lib/actions'

export const metadata: Metadata = { title: 'חשבון · קונסולת ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One customer account.
 *
 * ══ WHAT THIS SCREEN CAN AND CANNOT SHOW ══════════════════════════════════
 *
 * It shows the account, its package, its capability overrides, how much of the
 * package is in use, who its members are and what ESTIA has done to it. It
 * does not show a booking, a guest, a payment or a task, and could not: no
 * policy in this database returns any of those to a caller who is not a member
 * of this organization.
 *
 * The usage figures come from `platform_organization_usage()`, a definer
 * function that returns three integers, rather than from reading `properties`
 * and `units` — so answering "how much of the package are they using" does not
 * hand ESTIA staff every address and unit name.
 *
 * ══ THE "VIEW AS" PANEL IS NOT IMPERSONATION AND SAYS SO ══════════════════
 *
 * A support view is a time-boxed, reason-stated, recorded READ-ONLY record.
 * It mints no session, it changes nobody's `auth.uid()`, and it grants nothing
 * — every read on this page is authorised by the platform role whether a view
 * is open or not. Full impersonation is deliberately not built: its fourth
 * condition is that the impersonated session is visibly marked inside the
 * CUSTOMER'S OWN application at all times, that marking lives in the customer
 * shell, and a session a customer cannot tell from their own is the weak
 * version of the feature. The panel states this rather than leaving a reader
 * to infer it from an absent button.
 *
 * ── Nothing is fabricated when a read fails ───────────────────────────────
 *
 * Each secondary read is wrapped on its own. A failed members list renders as
 * a failed members list, not as an account with no staff — and the account
 * itself still renders, because one broken query must not blank the screen a
 * support call is being answered from.
 *
 * GATING. `platform.organization.view` for the page. Each control below is
 * additionally gated on its own grant, and each action re-checks it before
 * reading anything.
 */
export default async function PlatformOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    done?: string
    error?: string
    data?: string
    cid?: string
  }>
}) {
  const session = await requirePlatformGrant('platform.organization.view')
  const { id } = await params
  const feedback = await searchParams

  const db = await createClient()
  const correlationId = crypto.randomUUID()

  let organization: OrganizationDetail | null = null
  try {
    organization = await loadPlatformOrganization(db, id)
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    // A read that failed is not a customer that does not exist. Rendering
    // `notFound()` here would tell a support operator that the account they
    // are looking for was deleted.
    return (
      <ConsolePage title="החשבון לא נטען">
        <ConsoleNotice title="הקריאה נכשלה" tone="warning">
          לא ניתן היה לקרוא את הארגון <code dir="ltr">{id}</code>. זה אינו אומר
          שהוא אינו קיים. מזהה מעקב: <code dir="ltr">{correlationId}</code>
        </ConsoleNotice>
      </ConsolePage>
    )
  }

  if (!organization) notFound()

  const usage = await loadOrganizationUsage(db, id)
  const members = await safely(() => listOrganizationMembers(db, id))
  const supportViews = await safely(() => listSupportViews(db, id))
  const events = await safely(() =>
    listPlatformAuditEvents(db, { organizationId: id }),
  )

  const subscription = organization.subscription
  const capabilities = subscription ? capabilityStates(subscription) : []
  const limits = subscription ? limitStates(subscription, usage) : []

  const mayManage = mayUse(session, 'platform.organization.manage')
  const mayFlag = mayUse(session, 'platform.feature_flag.manage')
  const mayView = mayUse(session, 'platform.impersonate')

  return (
    <ConsolePage
      title={organization.name}
      lede={`${organization.slug} · ${ORGANIZATION_STATUS_LABEL[organization.status]}`}
    >
      {feedback.done && (
        <ConsoleNotice title="בוצע" tone="strong">
          {feedback.done}
        </ConsoleNotice>
      )}

      {feedback.error && (
        <ConsoleNotice title="הפעולה לא הושלמה" tone="warning">
          <p>{feedback.error}</p>
          {feedback.data && <p className="mt-1">{feedback.data}</p>}
          {feedback.cid && (
            <p className="mt-1 text-xs">
              מזהה מעקב: <code dir="ltr">{feedback.cid}</code>
            </p>
          )}
        </ConsoleNotice>
      )}

      {organization.status === 'suspended' && (
        <ConsoleNotice title="החשבון מושהה" tone="warning">
          הצוות של הלקוח אינו יכול לעבוד. שום נתון לא נמחק — השהיה משנה עמודה
          אחת בלבד, <code dir="ltr">organizations.status</code>, והחזרה לפעילות
          מחזירה את הכול כפי שהיה.
        </ConsoleNotice>
      )}

      {/* ── The account ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
        <h2 className="font-display text-lg font-bold tracking-tight">
          פרטי החשבון
        </h2>
        <ConsoleFacts
          items={[
            { label: 'שם', value: organization.name },
            { label: 'שם משפטי', value: organization.legalName ?? '—' },
            {
              label: 'מזהה',
              value: (
                <code dir="ltr" className="text-xs">
                  {organization.id}
                </code>
              ),
            },
            { label: 'סוג עסק', value: organization.businessType },
            {
              label: 'מדינה · אזור זמן',
              value: `${organization.country} · ${organization.timezone}`,
            },
            { label: 'מטבע', value: organization.currency },
            { label: 'נפתח', value: hebrewDate(organization.createdAt) },
            {
              label: 'חברי צוות פעילים',
              value: String(organization.activeMembers),
            },
            {
              label: 'בעלים',
              value:
                organization.owners.length === 0 ? (
                  /*
                    A real and reportable state. An organization whose owner was
                    removed still exists, and the console is where that is
                    noticed — so it is named rather than rendered as a dash.
                  */
                  <span className="text-danger">
                    אין חבר צוות שמחזיק בתפקיד הבעלים
                  </span>
                ) : (
                  organization.owners
                    .map((owner) => owner.displayName ?? owner.userId)
                    .join(', ')
                ),
            },
          ]}
        />
      </section>

      {/* ── Package and subscription ────────────────────────────────────── */}
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
        <h2 className="font-display text-lg font-bold tracking-tight">
          חבילה ומנוי
        </h2>

        {!subscription ? (
          <ConsoleNotice title="אין שורת מנוי פעילה" tone="warning">
            הבעלים של החשבון נתקל במסך &quot;אין מנוי&quot; ואינו מגיע ללוח
            הבקרה. אין כאן חבילת ברירת מחדל להציג — היעדר המנוי הוא העובדה.
          </ConsoleNotice>
        ) : (
          <>
            <ConsoleFacts
              items={[
                {
                  label: 'חבילה',
                  value: `${subscription.planName} (${subscription.planCode})`,
                },
                {
                  label: 'מצב',
                  value: SUBSCRIPTION_STATUS_LABEL[subscription.status],
                },
                {
                  label: 'מחיר מוסכם',
                  value: `${formatAgorot(
                    subscription.interval === 'yearly'
                      ? subscription.agreedYearlyAgorot
                      : subscription.agreedMonthlyAgorot,
                  )} ${subscription.interval === 'yearly' ? 'לשנה' : 'לחודש'}`,
                },
                {
                  label: 'סוף התנסות',
                  value: hebrewDate(subscription.trialEndsAt),
                },
                {
                  label: 'סוף תקופה נוכחית',
                  value: hebrewDate(subscription.currentPeriodEnd),
                },
                {
                  label: 'בוטל בתאריך',
                  value: hebrewDate(subscription.cancelledAt),
                },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              המחיר שמוצג הוא מה שסוכם עם הלקוח הזה ונשמר במנוי, ולא מחיר הקטלוג
              הנוכחי. שינוי מחיר בחבילה אינו מגיע ללקוח קיים — זו כל הסיבה
              שהעמודה קיימת.
            </p>

            <LimitsTable limits={limits} subscriptionOverrides={subscription} />
          </>
        )}
      </section>

      {/* ── Capabilities ────────────────────────────────────────────────── */}
      {subscription && (
        <CapabilityEditor
          organizationId={organization.id}
          capabilities={capabilities}
          subscription={subscription}
          editable={mayFlag}
          action={setCapabilitiesAction}
        />
      )}

      {/* ── Lifecycle ───────────────────────────────────────────────────── */}
      <LifecycleControls
        organizationId={organization.id}
        status={organization.status}
        editable={mayManage}
        suspendAction={suspendOrganizationAction}
        restoreAction={restoreOrganizationAction}
      />

      {/* ── Support views ───────────────────────────────────────────────── */}
      <SupportViewPanel
        organizationId={organization.id}
        views={supportViews.ok ? supportViews.value : []}
        failure={supportViews.ok ? null : supportViews.correlationId}
        editable={mayView}
        openAction={openSupportViewAction}
        closeAction={closeSupportViewAction}
        currentStaffUserId={session.userId}
      />

      {/* ── The people ──────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight">
            חברי הצוות
          </h2>
          <p className="text-sm text-muted-foreground">
            מי חבר בארגון, באיזה מצב ובאילו תפקידים. זו הצפייה בקריאה בלבד:
            רואים מה כל אדם מחזיק, ולא מה הוא עשה — פעולות של צוות הלקוח הן יומן
            הביקורת שלו, וקונסולת הפלטפורמה אינה קוראת אותו.
          </p>
        </div>

        {!members.ok ? (
          <ConsoleNotice title="רשימת החברים לא נטענה" tone="warning">
            מזהה מעקב: <code dir="ltr">{members.correlationId}</code>
          </ConsoleNotice>
        ) : members.value.length === 0 ? (
          <ConsoleNotice title="אין חברים בארגון">
            לארגון אין אף שורת חברות. זה מצב אמיתי — בדרך כלל אחרי הרשמה שלא
            הושלמה — ולא כשל בטעינה.
          </ConsoleNotice>
        ) : (
          <ConsoleTable
            caption="חברי הארגון"
            head={['אדם', 'טלפון', 'מצב', 'תפקידים', 'הצטרף']}
          >
            {members.value.map((person) => (
              <MemberRow key={person.userId} person={person} />
            ))}
          </ConsoleTable>
        )}
      </section>

      {/* ── What ESTIA did ──────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-lg font-bold tracking-tight">
            מה ESTIA עשתה בחשבון הזה
          </h2>
          <p className="text-sm text-muted-foreground">
            אותן שורות בדיוק מופיעות ביומן הביקורת של הלקוח, חתומות{' '}
            <code dir="ltr">platform_staff</code>. אין כאן טבלה נפרדת — יומן
            נפרד היה הגרסה שבה מישהו ב-ESTIA משהה חשבון והלקוח לא רואה דבר.
          </p>
        </div>

        {!events.ok ? (
          <ConsoleNotice title="היומן לא נטען" tone="warning">
            מזהה מעקב: <code dir="ltr">{events.correlationId}</code>
          </ConsoleNotice>
        ) : events.value.length === 0 ? (
          <ConsoleNotice title="ESTIA לא ביצעה פעולה בחשבון הזה">
            השורות כאן נכתבות על ידי הקונסולה תוך כדי עבודה. אין כאן שורה כי לא
            בוצעה פעולה — לא כי משהו לא נטען.
          </ConsoleNotice>
        ) : (
          <ol className="flex flex-col gap-3">
            {events.value.map((event) => (
              <li key={event.id}>
                <AuditRow event={event} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </ConsolePage>
  )
}

/* ------------------------------------------------------------- fragments -- */

function LimitsTable({
  limits,
  subscriptionOverrides,
}: {
  limits: readonly LimitState[]
  subscriptionOverrides: Parameters<typeof isOverridden>[0]
}) {
  return (
    <ConsoleTable
      caption="מכסות מול שימוש בפועל"
      head={['מכסה', 'תקרה', 'בשימוש', 'מצב']}
    >
      {limits.map((limit) => (
        <tr key={limit.key}>
          <th scope="row" className="px-4 py-3 text-start font-medium">
            {QUOTA_LABEL[limit.key]}
            {isOverridden(subscriptionOverrides, limit.key) && (
              <Badge tone="brand" className="ms-2">
                חריגה מהחבילה
              </Badge>
            )}
          </th>
          <td className="px-4 py-3">
            {limit.limit === null ? 'ללא הגבלה' : limit.limit}
          </td>
          <td className="px-4 py-3">
            {/*
              Never a zero standing in for an unknown. `usage === null` means
              nothing measured it, and an account rendered as 0 / 5 properties
              when it has four is a number somebody downgrades on.
            */}
            {limit.usage === null ? (
              <span className="text-muted-foreground">לא נמדד</span>
            ) : (
              limit.usage
            )}
          </td>
          <td className="px-4 py-3 text-sm">
            {limit.unmeasuredReason ? (
              <span className="text-muted-foreground">
                {limit.unmeasuredReason}
              </span>
            ) : limit.quota?.inOverage ? (
              <span className="font-medium text-danger">
                מעל התקרה. המוצר מתריע ואינו חוסם — עסק לעולם לא ייתקע בלי יכולת
                לקלוט אורח.
              </span>
            ) : limit.quota?.approaching ? (
              <span className="font-medium text-foreground">מתקרב לתקרה</span>
            ) : (
              <span className="text-muted-foreground">בתוך המכסה</span>
            )}
          </td>
        </tr>
      ))}
    </ConsoleTable>
  )
}

function MemberRow({ person }: { person: Person }) {
  const membership = person.memberships[0]

  return (
    <tr>
      <td className="px-4 py-3">
        {person.displayName ?? (
          <code dir="ltr" className="text-xs">
            {person.userId}
          </code>
        )}
      </td>
      <td className="px-4 py-3" dir="ltr">
        {person.phone ?? '—'}
      </td>
      <td className="px-4 py-3">
        <Badge tone={membership?.status === 'active' ? 'neutral' : 'accent'}>
          {membership?.status ?? '—'}
        </Badge>
      </td>
      <td className="px-4 py-3">
        {membership && membership.roles.length > 0
          ? membership.roles.join(', ')
          : '—'}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
        {hebrewDate(membership?.joinedAt ?? null)}
      </td>
    </tr>
  )
}

function AuditRow({ event }: { event: PlatformAuditEvent }) {
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-soft">
      <p className="font-medium text-foreground">{event.summary}</p>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{event.actorLabel}</span>
        {' · '}
        {hebrewMoment(event.occurredAt)}
        {' · '}
        <code dir="ltr">{event.action}</code>
      </p>
      {event.reason && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">נימוק שנמסר:</span>{' '}
          {event.reason}
        </p>
      )}
    </article>
  )
}

/* -------------------------------------------------------------- plumbing -- */

type Attempt<T> = { ok: true; value: T } | { ok: false; correlationId: string }

/**
 * Run one secondary read without letting it take the page down.
 *
 * A failure is reported AS a failure — never as an empty list. The two are
 * opposite statements about a customer, and on a support console the
 * difference is between "this account has no staff" and "we could not read
 * who its staff are".
 */
async function safely<T>(read: () => Promise<T>): Promise<Attempt<T>> {
  const correlationId = crypto.randomUUID()
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    return { ok: false, correlationId }
  }
}
