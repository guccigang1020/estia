import type { Metadata } from 'next'

import { LaundryOrderCard } from '@/components/laundry/order-card'
import { LaundrySectionNav } from '@/components/laundry/section-nav'
import { LaundryShell as Shell } from '@/components/laundry/shell'
import {
  LaundryDatasetGap,
  LaundryModeOff,
  LaundryPlanLock,
} from '@/components/laundry/states'
import { Badge } from '@/components/ui/badge'
import { TERMINAL_LAUNDRY_STATUSES } from '@/lib/contracts/states'
import { isLaundryActive, isoDay } from '@/lib/laundry'

import {
  MODE_LABEL,
  SOURCE_LABEL,
  dateAndTime,
  relativeDay,
  statusLabel,
  weekdays,
} from './_lib/labels'
import { loadOrders, loadProviders } from './_lib/queries'
import { laundryView } from './_lib/view'

export const metadata: Metadata = { title: 'כביסה' }

/** Enough to fill every column of the dashboard without paging. */
const DASHBOARD_LIMIT = 60

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The laundry dashboard.
 *
 * WHAT IS ON THIS SCREEN, in the order somebody standing in a guest house
 * actually asks: what has to be clean today, what is out and coming back, what
 * is late, and what is coming this week.
 *
 * ── The mode decides whether this screen exists ───────────────────────────
 *
 * `off` renders `LaundryModeOff` and nothing else — no empty columns, no
 * forecast of zero, no orders list with a friendly illustration. Every one of
 * those would say "you have no laundry" when the truth is "this business does
 * not use this module", and the difference matters to a villa owner deciding
 * whether ESTIA is for somebody bigger.
 *
 * ── What a housekeeping supervisor sees here ──────────────────────────────
 *
 * The same runs, the same deadlines, and no provider names. 0035 gives them
 * `laundry.view`, `laundry.manage` and `laundry.order_create` and withholds
 * `laundry.order_send` and `laundry.provider_manage`, so `loadProviders`
 * returns `null` rather than `[]` and the card omits the row entirely rather
 * than printing a placeholder — they see "12 סדינים, נדרש מחר" and do not learn
 * who washes them or what it costs. The policy in `0029_laundry.sql` refuses
 * the rows independently; this is the half that also holds in the demo, which
 * has no row level security at all.
 *
 * A cleaner holds none of the five grants and never reaches this page:
 * `requireLaundryGrant` refuses them at `laundry.view` before anything is read.
 */
export default async function LaundryPage() {
  const view = await laundryView('laundry.view', null)
  if (!view) return null

  const { context, vocabulary } = view
  const { settings, source } = context.settings
  const mode = settings.mode

  if (view.locked) {
    return (
      <Shell heading="כביסה" tagline={vocabulary.tagline}>
        <LaundryPlanLock
          entitlement={view.entitlement}
          mayReachBilling={view.mayReachBilling}
        />
      </Shell>
    )
  }

  if (context.gap !== null) {
    return (
      <Shell heading="כביסה" tagline={vocabulary.tagline}>
        <LaundryDatasetGap
          table={context.gap.table}
          detail={context.gap.detail}
        />
      </Shell>
    )
  }

  if (!isLaundryActive(mode)) {
    return (
      <Shell heading="כביסה" tagline={vocabulary.tagline}>
        <LaundryModeOff mayConfigure={view.mayManage} />
      </Shell>
    )
  }

  const [{ orders, gap }, { providers }] = await Promise.all([
    loadOrders(view.repo, view.actor, view.propertyId, DASHBOARD_LIMIT),
    loadProviders(view.repo, view.actor),
  ])

  if (gap !== null) {
    return (
      <Shell heading="כביסה" tagline={vocabulary.tagline}>
        <LaundryDatasetGap table={gap.table} detail={gap.detail} />
      </Shell>
    )
  }

  const now = new Date()
  const today = isoDay(now)

  const providerNames = new Map(
    (providers ?? []).map((provider) => [provider.id, provider.name]),
  )

  const live = orders.filter(
    (order) => !TERMINAL_LAUNDRY_STATUSES.includes(order.status),
  )

  // Four questions, four filters, each computed from the rows rather than
  // from a stored counter — a dashboard number that disagrees with the list
  // below it is worse than no dashboard.
  const neededToday = live.filter((order) => isoDay(order.requiredBy) === today)
  const sent = live.filter((order) => order.sentAt !== null)
  const returningToday = live.filter(
    (order) =>
      order.expectedReturnAt !== null &&
      isoDay(order.expectedReturnAt) === today,
  )
  const overdue = live.filter(
    (order) => new Date(order.requiredBy).getTime() < now.getTime(),
  )
  const overdueIds = new Set(overdue.map((order) => order.id))

  const upcoming = [...live].sort(
    (a, b) =>
      new Date(a.requiredBy).getTime() - new Date(b.requiredBy).getTime(),
  )

  return (
    <Shell heading="כביסה" tagline={vocabulary.tagline}>
      <LaundrySectionNav mode={mode} current="dashboard" />

      {/* The configuration in force, and where it came from. A manager who
          cannot tell whether they are looking at the organization default or a
          property override cannot debug anything. */}
      <section
        aria-label="ההגדרה שבתוקף"
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-surface px-5 py-4 text-sm shadow-soft"
      >
        <span className="flex items-center gap-2">
          <Badge tone="brand">{MODE_LABEL[mode]}</Badge>
          <span className="text-xs text-muted-foreground">
            {SOURCE_LABEL[source]}
          </span>
        </span>
        <span className="text-muted-foreground">
          זמן טיפול: {settings.turnaroundHours} שעות
        </span>
        <span className="text-muted-foreground">
          איסוף: {weekdays(settings.pickupDays)}
        </span>
        <span className="text-muted-foreground">
          החזרה: {weekdays(settings.deliveryDays)}
        </span>
        {view.propertyName !== null && (
          <span className="text-muted-foreground">
            מסונן לנכס ״{view.propertyName}״
          </span>
        )}
      </section>

      <section
        aria-label="מצב היום"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Tile
          label="נדרש היום"
          value={neededToday.length}
          detail={`${units(neededToday)} יחידות`}
        />
        <Tile
          label={vocabulary.batches + ' בחוץ'}
          value={sent.length}
          detail={`${units(sent)} יחידות`}
        />
        <Tile
          label="חוזר היום"
          value={returningToday.length}
          detail={`${units(returningToday)} יחידות`}
        />
        <Tile
          label="באיחור"
          value={overdue.length}
          detail={
            overdue.length === 0
              ? 'שום דבר לא עבר את המועד'
              : `${units(overdue)} יחידות שעברו את המועד`
          }
          alarming={overdue.length > 0}
        />
      </section>

      <section aria-labelledby="upcoming-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2
            id="upcoming-title"
            className="font-display text-xl font-bold tracking-tight text-foreground"
          >
            {upcoming.length === 0
              ? `אין ${vocabulary.batches} פתוחים`
              : `${upcoming.length} ${vocabulary.batches} פתוחים`}
          </h2>
          <p className="text-sm text-muted-foreground">
            לפי המועד שבו הפריטים צריכים להיות נקיים. הפירוט לכל נכס מוצג על
            הכרטיס עצמו ואינו מאוחד לסכום אחד.
          </p>
        </div>

        {upcoming.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface px-5 py-8 text-center text-sm text-muted-foreground">
            אין כרגע כביסה פתוחה. כשתיווצר דרישה מהזמנה מאושרת היא תופיע כאן.
          </p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {upcoming.map((order) => (
              <li key={order.id}>
                <LaundryOrderCard
                  order={order}
                  statusLabel={statusLabel(order.status, mode)}
                  providerName={
                    order.providerId === null
                      ? null
                      : (providerNames.get(order.providerId) ?? null)
                  }
                  properties={view.properties}
                  overdue={overdueIds.has(order.id)}
                  requiredByLabel={dateAndTime(order.requiredBy)}
                  relativeLabel={relativeDay(order.requiredBy, now)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  )
}

/* ------------------------------------------------------------- pieces --- */

function units(
  orders: readonly { lines: readonly { quantity: { final: number } }[] }[],
): number {
  return orders.reduce(
    (sum, order) =>
      sum + order.lines.reduce((inner, line) => inner + line.quantity.final, 0),
    0,
  )
}

function Tile({
  label,
  value,
  detail,
  alarming = false,
}: {
  label: string
  value: number
  detail: string
  alarming?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-5 py-4 shadow-soft">
      <span className="text-xs font-semibold text-muted-foreground">
        {label}
      </span>
      <span
        className={
          alarming
            ? 'font-display text-3xl font-bold tabular-nums text-danger'
            : 'font-display text-3xl font-bold tabular-nums text-foreground'
        }
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}
