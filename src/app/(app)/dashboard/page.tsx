import type { Metadata } from 'next'

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { EmptyState } from '@/components/states/empty-state'
import { buildMenu } from '@/components/nav/menu'
import { entitlementLabel, scopeLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ENTITLEMENTS } from '@/lib/plans/entitlements'

import { requireContext } from '../_lib/guard'
import { ALL_PROPERTIES } from '../_lib/context'

export const metadata: Metadata = { title: 'מסך הבית' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The first real screen under the shell.
 *
 * WHAT IT SHOWS, AND WHY THERE ARE NO NUMBERS ON IT. Everything here is read
 * from the resolved actor and the organization row: who is signed in, which
 * business they are acting in, which roles they hold, how far their scope
 * reaches, what their plan includes, and which parts of the product they can
 * therefore open. All of it is true right now.
 *
 * What is deliberately absent is the thing a dashboard usually opens with —
 * occupancy, revenue, arrivals today. There are no bookings, no properties and
 * no payments in the schema yet, so any figure here would be invented. An
 * honest empty frame is a worse demo and a better product: a fabricated "72%
 * תפוסה" is a number somebody will eventually repeat to their accountant.
 *
 * GATING. This page is reachable by every ACTIVE MEMBER, including a cleaner,
 * whose entire grant set is four task permissions. It is therefore gated on
 * membership rather than on a grant — `requireContext()` — and that is the one
 * place in the product where that is the right requirement. Feature routes
 * call `requireGrant()` instead.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [context, params] = await Promise.all([requireContext(), searchParams])

  /* ------------------------------------------------- states that are not
     errors: signed in, but with nothing to act inside yet. */

  if (context.status === 'no_workspace') {
    return (
      <Shell>
        <EmptyState
          as="h1"
          illustration="property"
          title="עוד אין לך מרחב עבודה"
          body="החשבון שלך נוצר, אבל הוא עדיין לא משויך לאף ארגון. ארגון נוצר בתהליך ההצטרפות, או על ידי הזמנה ממנהל קיים — שני המסלולים עוד לא נבנו, ולכן אין כאן מה להציג."
        />
      </Shell>
    )
  }

  if (context.status === 'membership_not_active') {
    return (
      <Shell>
        <EmptyState
          as="h1"
          illustration="team"
          title="החברות שלך בארגון אינה פעילה"
          body={`הסטטוס שלך ב״${context.workspace.name}״ הוא ${MEMBERSHIP_STATUS_LABELS[context.membershipStatus]}. מנהל בארגון יכול להחזיר את הגישה. לא נמחק שום נתון שלך.`}
        />
      </Shell>
    )
  }

  if (context.status === 'no_subscription') {
    return (
      <Shell>
        <EmptyState
          as="h1"
          illustration="invoice"
          title="לארגון אין מנוי פעיל"
          body={`ל״${context.workspace.name}״ אין רשומת מנוי, ובלעדיה אי אפשר לדעת אילו יכולות כלולות. עד שהמנוי ייווצר, אף מסך במערכת לא ייפתח — זו החלטה מכוונת ולא תקלה.`}
        />
      </Shell>
    )
  }

  /* --------------------------------------------------------- the real thing */

  const { actor, workspace, roles, user } = context

  const sections = buildMenu(actor)
  const reachable = sections.flatMap((section) =>
    section.items.filter((item) => item.state !== 'locked'),
  )
  const locked = sections.flatMap((section) =>
    section.items.filter((item) => item.state === 'locked'),
  )

  const included = ENTITLEMENTS.filter((entitlement) =>
    actor.entitlements.has(entitlement),
  )

  const fullName =
    typeof user.user_metadata?.full_name === 'string'
      ? user.user_metadata.full_name
      : null

  const denied = firstParam(params.denied)

  const propertyLabel =
    context.selectedPropertyId === ALL_PROPERTIES
      ? 'כל הנכסים'
      : `נכס ${context.selectedPropertyId.slice(0, 8)}`

  return (
    <Shell>
      {denied ? (
        <div
          role="status"
          className="mb-6 rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
        >
          המסך שביקשת דורש הרשאה שאין לך:{' '}
          <span dir="ltr" className="font-mono text-xs">
            {denied}
          </span>
          . אם זו טעות, מנהל בארגון יכול לעדכן את התפקיד שלך.
        </div>
      ) : null}

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {fullName ? `שלום, ${fullName}` : 'מסך הבית'}
        </h1>
        <p className="text-muted-foreground">
          אתה עובד עכשיו בארגון{' '}
          <span className="font-semibold text-foreground">
            {workspace.name}
          </span>
          , בתצוגת <span className="font-semibold">{propertyLabel}</span>.
        </p>
      </header>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------------- identity */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">מי אתה כאן</CardTitle>
            <CardDescription>
              הזהות הזו נבנית מחדש בכל בקשה מהמסד, ולא נשמרת בעוגייה.
            </CardDescription>
          </CardHeader>

          <dl className="mt-5 flex flex-col gap-3 text-sm">
            <Row label="אימייל">
              <span dir="ltr">{user.email}</span>
            </Row>
            <Row label="ארגון">
              {workspace.name}{' '}
              <span dir="ltr" className="text-xs text-muted-foreground">
                ({workspace.slug})
              </span>
            </Row>
            <Row label="תפקידים">
              {roles.length > 0 ? (
                <span className="flex flex-wrap justify-end gap-1">
                  {roles.map((role) => (
                    <Badge key={role.code} tone="brand">
                      {role.name}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  לא הוקצה תפקיד — ולכן אין הרשאות
                </span>
              )}
            </Row>
            <Row label="טווח">{scopeLabel(actor.scope)}</Row>
            <Row label="מספר הרשאות">{actor.grants.size}</Row>
          </dl>
        </Card>

        {/* ------------------------------------------------------ what you may do */}
        <Card>
          <CardHeader>
            <CardTitle as="h2">מה אתה יכול לעשות</CardTitle>
            <CardDescription>
              התפריט מימין נגזר מהרשימה הזו. הסתרת פריט אינה אבטחה — כל מסלול
              בודק את ההרשאה בעצמו.
            </CardDescription>
          </CardHeader>

          <ul className="mt-5 flex flex-col gap-3">
            {sections.map((section) => (
              <li
                key={section.id}
                className="flex flex-wrap items-baseline gap-2"
              >
                <span className="text-sm font-semibold text-foreground">
                  {section.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {section.items.map((item) => item.label).join(' · ')}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
            {reachable.length} פריטים פתוחים לך
            {locked.length > 0
              ? `, ועוד ${locked.length} שדורשים שדרוג חבילה`
              : ''}
            .
          </p>
        </Card>

        {/* ---------------------------------------------------------- plan */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle as="h2">מה כלול בחבילה של הארגון</CardTitle>
            <CardDescription>
              יכולת שאינה כלולה מוצגת בתפריט כנעולה ולא נעלמת — כדי שההבדל בין
              ״אין לך הרשאה״ ל״החבילה לא כוללת״ יישאר ברור.
            </CardDescription>
          </CardHeader>

          <ul className="mt-5 flex flex-wrap gap-2">
            {included.map((entitlement) => (
              <li key={entitlement}>
                <Badge tone="brand">{entitlementLabel(entitlement)}</Badge>
              </li>
            ))}
            {ENTITLEMENTS.filter(
              (entitlement) => !actor.entitlements.has(entitlement),
            ).map((entitlement) => (
              <li key={entitlement}>
                <Badge tone="neutral" className="opacity-70">
                  {entitlementLabel(entitlement)}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------- fragments -- */

const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  invited: 'הוזמן',
  pending: 'ממתין',
  active: 'פעיל',
  suspended: 'מושהה',
  removed: 'הוסר',
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
