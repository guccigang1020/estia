import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { BookingStatusBadge } from '@/components/booking/status-badge'
import {
  TaskPriorityBadge,
  TaskStatusBadge,
  TASK_TYPE_LABEL,
} from '@/components/preparation/task-status'
import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
  Withheld,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { authorize, holdsGrant } from '@/lib/authz/can'
import { formatDayMonth } from '@/lib/booking/dates'
import { PAYMENT_ATTENTION_LABEL } from '@/app/(app)/finance/_lib/labels'
import { PAYMENT_STATUS_LABEL } from '@/lib/finance'
import { toSafeResponse } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { requireActionCenterAccess } from './_lib/access'
import { APPROVAL_TYPE_LABEL } from './_lib/labels'
import {
  ACTION_PANEL_SIZE,
  listOpenBalances,
  listPaymentsNeedingAttention,
  listStaysToday,
  listStuckTasks,
  listWaitingApprovals,
  outstandingTotalAgorot,
  propertyToday,
  type ActionCenterArgs,
  type DayStay,
  type OpenBalance,
  type PaymentNeedingAttention,
  type StayRole,
  type StuckTask,
  type WaitingApproval,
} from './_lib/queries'

export const metadata: Metadata = { title: 'מרכז הפעולות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What needs a person today.
 *
 * WHAT IS ON THIS SCREEN. Five lists, each read from a table and each made of
 * records somebody can open: who is in the building today and in which role,
 * which of those stays still owes money, which work is blocked or late, which
 * payments the provider stopped answering about, and which decision is
 * waiting. Every figure is a column or the domain's own sum over columns.
 *
 * WHAT IS DELIBERATELY NOT ON IT. Occupancy, revenue, a conversion rate, a
 * count of anything that is not a list of rows underneath it.
 * `dashboard/page.tsx` refuses to open with numbers and explains why; this
 * screen does not contradict it. A percentage on the one page a manager opens
 * at 8am is a number they will repeat to somebody, and none of the five
 * questions above is answered by one. The counts beside the headings are the
 * length of the list below them and nothing else.
 *
 * GATING, IN FOUR PLACES, AND NONE OF THEM IS THE MENU.
 * `requireActionCenterAccess` refuses the route without any of four grants —
 * see `_lib/access.ts` for why it is not `requireGrant`. Each panel asks
 * `holdsGrant` for its own grant before it queries, so a receptionist gets no
 * approvals panel rather than an empty one. Each row is checked again with
 * `can()` against the property it names. And row level security refuses
 * regardless of all three.
 *
 * ONE FAILURE DOES NOT BLANK THE SCREEN. The five reads are settled
 * independently and a failure is rendered inside its own panel. A morning
 * board that disappears because the approvals table was briefly unreachable is
 * worse than a board with four working panels and one that says what went
 * wrong — and a panel that rendered nothing because a query failed must never
 * look like a panel with nothing to do.
 */
export default async function ActionCenterPage() {
  const access = await requireActionCenterAccess()
  const { actor, organizationId, propertyId, propertyName } = access

  const today = propertyToday()
  const db = await createClient()
  const args: ActionCenterArgs = {
    db,
    actor,
    organizationId,
    propertyId,
    today,
  }

  const stays = await settle(() => listStaysToday(args))

  const [balances, tasks, payments, approvals] = await Promise.all([
    settle(() => listOpenBalances(args, stays.ok ? stays.value : [])),
    settle(() => listStuckTasks(args)),
    settle(() => listPaymentsNeedingAttention(args)),
    settle(() => listWaitingApprovals(args)),
  ])

  const approvalRefusal = authorize(actor, 'approval.decide')

  return (
    <ScreenFrame
      title="מרכז הפעולות"
      lead={
        propertyName
          ? `מה שדורש אדם היום ב״${propertyName}״, לפי מה שכתוב ברשומות עצמן.`
          : 'מה שדורש אדם היום, בכל הנכסים שבטווח שלך, לפי מה שכתוב ברשומות עצמן.'
      }
      banner={
        <p className="text-sm text-muted-foreground">
          התאריך הקובע הוא{' '}
          <span dir="ltr" className="font-medium text-foreground">
            {today}
          </span>{' '}
          לפי שעון הנכס. אין כאן אחוזי תפוסה ואין סכומי הכנסה — כל שורה כאן היא
          רשומה שאפשר לפתוח ולטפל בה.
        </p>
      }
    >
      {/* ------------------------------------------------------- stays -- */}
      <Panel
        title="מי בבניין היום"
        description="עזיבות קודם, אחר כך הגעות, ואחר כך מי שכבר נמצא. סדר של יום עבודה ולא של תאריך."
        count={stays.ok ? stays.value.length : undefined}
        action={
          holdsGrant(actor, 'booking.view') ? (
            <Button href="/bookings" variant="secondary" size="sm">
              כל ההזמנות
            </Button>
          ) : null
        }
      >
        {!stays.ok ? (
          <ActionError error={stays.error} />
        ) : !holdsGrant(actor, 'booking.view') ? (
          <PanelNote>
            אין לך הרשאת צפייה בהזמנות, ולכן לוח ההגעות והעזיבות סגור. זו הרשאה
            שמנהל בארגון יכול להוסיף.
          </PanelNote>
        ) : stays.value.length === 0 ? (
          <PanelNote>
            אף שהייה לא מתחילה, מסתיימת או נמשכת היום בטווח שלך. זו תשובה אמיתית
            — לא סינון שהסתיר משהו.
          </PanelNote>
        ) : (
          <>
            <RowList>
              {stays.value.map((stay) => (
                <StayRow key={stay.id} stay={stay} />
              ))}
            </RowList>
            {stays.value.length === ACTION_PANEL_SIZE && <AtCeiling />}
          </>
        )}
      </Panel>

      {/* ---------------------------------------------------- balances -- */}
      <Panel
        title="שהיות שעדיין לא שולמו במלואן"
        description="החיוב הוא הסכום שהמסד מחשב מהשורות של ההזמנה. הנגבה הוא סכום התשלומים בפועל, פחות החזרים."
        count={
          balances.ok && balances.value ? balances.value.length : undefined
        }
      >
        {!balances.ok ? (
          <ActionError error={balances.error} />
        ) : balances.value === null ? (
          <PanelNote>
            הסכומים שאורח חייב אינם פתוחים לך. זו אינה קביעה שכולם שילמו — זו
            הרשאה שאין לך: נדרשות{' '}
            <span dir="ltr" className="font-mono text-xs">
              payment.view
            </span>{' '}
            ו־
            <span dir="ltr" className="font-mono text-xs">
              booking.view_price
            </span>
            .
          </PanelNote>
        ) : balances.value.length === 0 ? (
          <PanelNote>
            כל שהייה שעל הלוח היום שולמה במלואה, ואין תשלום שהסולק לא סגר.
          </PanelNote>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted-foreground">
              סך החוב הפתוח בשורות שלמטה:{' '}
              <span className="font-semibold tabular-nums text-foreground">
                {formatAgorot(outstandingTotalAgorot(balances.value))}
              </span>
              . זהו סיכום השורות המוצגות בלבד, ולא מאזן הארגון.
            </p>
            <RowList>
              {balances.value.map((balance) => (
                <BalanceRow key={balance.bookingId} balance={balance} />
              ))}
            </RowList>
          </>
        )}
      </Panel>

      {/* ------------------------------------------------------- tasks -- */}
      <Panel
        title="עבודה שלא תיסגר מעצמה"
        description="משימה תקועה בכל תאריך, ומשימה שעבר זמנה ולא נסגרה. תקועה קודם — היא זו שאי אפשר לפתור בעבודה קשה יותר."
        count={tasks.ok && tasks.value ? tasks.value.length : undefined}
        action={
          holdsGrant(actor, 'task.view') ? (
            <Button href="/preparation" variant="secondary" size="sm">
              לוח ההכנה
            </Button>
          ) : null
        }
      >
        {!tasks.ok ? (
          <ActionError error={tasks.error} />
        ) : tasks.value === null ? (
          <PanelNote>
            {authorize(actor, 'task.view').allowed === false &&
            refusalReason(actor, 'task.view') === 'plan_does_not_include'
              ? 'ניהול משימות אינו כלול בחבילה של הארגון. זו אינה חסימת הרשאה — שדרוג חבילה יפתח את הלוח הזה.'
              : 'אין לך הרשאת צפייה במשימות, ולכן הלוח הזה סגור.'}
          </PanelNote>
        ) : tasks.value.length === 0 ? (
          <PanelNote>אין משימה תקועה ואין משימה שעבר זמנה בטווח שלך.</PanelNote>
        ) : (
          <>
            <RowList>
              {tasks.value.map((task) => (
                <TaskRow key={task.id} task={task} today={today} />
              ))}
            </RowList>
            {tasks.value.length === ACTION_PANEL_SIZE && <AtCeiling />}
          </>
        )}
      </Panel>

      {/* ---------------------------------------------------- payments -- */}
      <Panel
        title="תשלומים שהאוטומציה עצרה עליהם"
        description="״לא ידוע״ אינו ״נכשל״: הסולק לא השיב, ולכן לא ידוע אם החיוב בוצע. המערכת לא תסגור את השורות האלה בעצמה."
        count={
          payments.ok && payments.value ? payments.value.length : undefined
        }
        action={
          holdsGrant(actor, 'payment.view') ? (
            <Button href="/finance/payments" variant="secondary" size="sm">
              כל התשלומים
            </Button>
          ) : null
        }
      >
        {!payments.ok ? (
          <ActionError error={payments.error} />
        ) : payments.value === null ? (
          <PanelNote>
            אין לך הרשאת צפייה בתשלומים, ולכן הרשימה הזו סגורה.
          </PanelNote>
        ) : payments.value.length === 0 ? (
          <PanelNote>
            כל תשלום שנרשם קיבל תשובה סופית מהסולק, ואין שורה שממתינה לבירור
            ידני.
          </PanelNote>
        ) : (
          <>
            <p
              // `alert`, not a polite status: this is money nobody can account
              // for, and it is the reason somebody opened this screen.
              role="alert"
              className="mb-4 rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-danger">
                {payments.value.length === 1
                  ? 'תשלום אחד דורש בירור ידני'
                  : `${payments.value.length} תשלומים דורשים בירור ידני`}
              </span>{' '}
              — כל עוד לא נסגרו, אין לחייב שוב את האורח ואין להניח שהכסף הגיע.
            </p>
            <RowList>
              {payments.value.map((payment) => (
                <PaymentRow key={payment.id} payment={payment} />
              ))}
            </RowList>
          </>
        )}
      </Panel>

      {/* --------------------------------------------------- approvals -- */}
      <Panel
        title="החלטות שממתינות לאדם"
        description="בקשה שמישהו העלה מפני שהיא חורגת מתקרה. כל עוד לא הוכרעה, היא מחזיקה מכירה או הוצאה פתוחה."
        count={
          approvals.ok && approvals.value ? approvals.value.length : undefined
        }
      >
        {!approvals.ok ? (
          <ActionError error={approvals.error} />
        ) : approvals.value === null ? (
          <PanelNote tone="attention">
            {approvalRefusal.allowed === false &&
            approvalRefusal.reason === 'plan_does_not_include'
              ? 'מנגנון האישורים אינו כלול בחבילה של הארגון. ההרשאה עצמה קיימת לך — מה שחסר הוא החבילה, ושדרוג יפתח את התור הזה. זו הבחנה מכוונת: ״אין לך הרשאה״ ו״החבילה לא כוללת״ אינם אותו דבר.'
              : 'אתה רשאי להגיש בקשות אך לא להכריע בהן, ולכן תור ההחלטות אינו מוצג לך. מצב הבקשות שהגשת מופיע על הרשומה שהן שייכות לה.'}
          </PanelNote>
        ) : approvals.value.length === 0 ? (
          <PanelNote>אין בקשה שממתינה להחלטה.</PanelNote>
        ) : (
          <RowList>
            {approvals.value.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} />
            ))}
          </RowList>
        )}
      </Panel>
    </ScreenFrame>
  )
}

/* ------------------------------------------------------------- plumbing -- */

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReturnType<typeof toSafeResponse>['error'] }

/**
 * Run one panel's read, and keep its failure inside that panel.
 *
 * `toSafeResponse` produces a correlation id and Hebrew wording the server
 * already chose; nothing here invents a sentence. A stack trace or a SQL
 * string cannot reach the browser through it.
 */
async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (cause) {
    return {
      ok: false,
      error: toSafeResponse(cause, crypto.randomUUID()).error,
    }
  }
}

function refusalReason(
  actor: Parameters<typeof authorize>[0],
  grant: Parameters<typeof authorize>[1],
): string | null {
  const decision = authorize(actor, grant)
  return decision.allowed ? null : decision.reason
}

function AtCeiling() {
  return (
    <p
      role="status"
      className="mt-4 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
    >
      מוצגות {ACTION_PANEL_SIZE} שורות ראשונות. יש עוד — המסך המלא של המודול
      יציג את כולן.
    </p>
  )
}

/* ----------------------------------------------------------------- rows -- */

const ROLE_LABEL: Record<StayRole, string> = {
  arriving: 'מגיע היום',
  departing: 'עוזב היום',
  in_house: 'נמצא בשטח',
}

function StayRow({ stay }: { stay: DayStay }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge tone={stay.role === 'in_house' ? 'neutral' : 'brand'}>
            {ROLE_LABEL[stay.role]}
          </Badge>
          <span className="font-semibold text-foreground">
            {/* `guestName` is absent, not empty, when it was redacted — the
                type says so, and the two render differently. */}
            {'guestName' in stay ? (
              (stay.guestName ?? (
                <span className="text-muted-foreground">אורח ללא שם רשום</span>
              ))
            ) : (
              <Withheld />
            )}
          </span>
          <BookingStatusBadge status={stay.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {stay.unitName ?? 'יחידה שאינה פתוחה לצפייה'} ·{' '}
          {formatDayMonth(stay.checkIn)}–{formatDayMonth(stay.checkOut)} ·{' '}
          {stay.guestCount} אורחים
          {stay.arrivalTime
            ? ` · שעת הגעה ${stay.arrivalTime.slice(0, 5)}`
            : ''}
        </p>
        {stay.guestNotes && (
          <p className="text-sm text-foreground">
            בקשת האורח: {stay.guestNotes}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-baseline gap-3">
        {'totalAgorot' in stay && stay.totalAgorot !== undefined && (
          <span className="tabular-nums text-sm font-semibold text-foreground">
            {formatAgorot(stay.totalAgorot)}
          </span>
        )}
        <Button href={`/bookings/${stay.id}`} variant="ghost" size="sm">
          {stay.reference}
        </Button>
      </div>
    </Row>
  )
}

function BalanceRow({ balance }: { balance: OpenBalance }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-semibold text-foreground">
          {balance.guestName ?? balance.reference}
        </span>
        <dl className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
          <span>
            <dt className="inline">חויב: </dt>
            <dd className="inline tabular-nums">
              {formatAgorot(balance.billedAgorot)}
            </dd>
          </span>
          <span>
            <dt className="inline">נגבה: </dt>
            <dd className="inline tabular-nums">
              {formatAgorot(balance.settledAgorot)}
            </dd>
          </span>
        </dl>
        {balance.unknownAgorot > 0 && (
          <p className="text-sm text-danger">
            {formatAgorot(balance.unknownAgorot)} תקועים אצל הסולק — לא נספרו לא
            כשולם ולא כחוב.
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-baseline gap-3">
        <span className="tabular-nums text-base font-bold text-foreground">
          {formatAgorot(balance.outstandingAgorot)}
        </span>
        <Button
          href={`/bookings/${balance.bookingId}`}
          variant="ghost"
          size="sm"
        >
          {balance.reference}
        </Button>
      </div>
    </Row>
  )
}

function TaskRow({ task, today }: { task: StuckTask; today: string }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <TaskStatusBadge status={task.status} />
          <TaskPriorityBadge priority={task.priority} />
          <span className="font-semibold text-foreground">{task.title}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {TASK_TYPE_LABEL[task.type]}
          {task.dueOn
            ? ` · תאריך יעד ${formatDayMonth(task.dueOn)}`
            : ' · בלי תאריך יעד'}
          {task.overdue && task.dueOn
            ? ` · עבר ${daysLate(task.dueOn, today)}`
            : ''}
        </p>
        {task.blockedReason && (
          <p className="text-sm text-danger">תקועה כי: {task.blockedReason}</p>
        )}
      </div>
      <Button href="/preparation" variant="ghost" size="sm">
        לוח ההכנה
      </Button>
    </Row>
  )
}

/** Whole days between two `YYYY-MM-DD` dates, said in words rather than a colour. */
function daysLate(dueOn: string, today: string): string {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueOn}T00:00:00Z`)) /
      86_400_000,
  )
  return days === 1 ? 'יום אחד' : `${days} ימים`
}

function PaymentRow({ payment }: { payment: PaymentNeedingAttention }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge tone={payment.status === 'unknown' ? 'accent' : 'neutral'}>
            {PAYMENT_STATUS_LABEL[payment.status]}
          </Badge>
          <span className="font-semibold tabular-nums text-foreground">
            {payment.amountAgorot === undefined ? (
              <Withheld />
            ) : (
              formatAgorot(payment.amountAgorot)
            )}
          </span>
        </div>
        {payment.requiresAttention && (
          <p className="text-sm text-foreground">
            {PAYMENT_ATTENTION_LABEL[payment.requiresAttention]}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          נרשם ב־{formatDayMonth(payment.recordedOn)}
          {payment.unknownSince
            ? ` · הסולק שותק מאז ${formatDayMonth(payment.unknownSince)}`
            : ''}
        </p>
      </div>
      <Button href="/finance/payments" variant="ghost" size="sm">
        לתשלומים
      </Button>
    </Row>
  )
}

function ApprovalRow({ approval }: { approval: WaitingApproval }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge tone="accent">{APPROVAL_TYPE_LABEL[approval.type]}</Badge>
          {approval.lapsed && (
            <span className="text-sm font-semibold text-danger">
              פג התוקף — אינה מחזיקה עוד דבר פתוח
            </span>
          )}
        </div>
        <p className="text-sm text-foreground">{approval.reason}</p>
        <p className="text-sm text-muted-foreground">
          ביקש: {approval.requestedByName ?? 'משתמש שאינו פתוח לצפייה'} ·{' '}
          {formatDayMonth(approval.requestedOn)}
          {approval.expiresOn
            ? ` · תוקף עד ${formatDayMonth(approval.expiresOn)}`
            : ''}
        </p>
      </div>

      <dl className="shrink-0 text-end text-sm">
        <ExceptionSize approval={approval} />
      </dl>
    </Row>
  )
}

/**
 * How big the exception is, in the units it was requested in.
 *
 * Both figures are withheld together without `booking.view_price` — a discount
 * request is a percentage of a stay's price and an expense request is a shekel
 * amount, so showing the ask while hiding the ceiling would disclose the one by
 * implying the other. That a decision is *waiting* is not money and is still
 * shown.
 */
function ExceptionSize({ approval }: { approval: WaitingApproval }) {
  if (
    approval.requestedAgorot === undefined &&
    approval.requestedValueBps === undefined
  ) {
    return (
      <FactRow label="גודל החריגה">
        <Withheld />
      </FactRow>
    )
  }

  if (approval.requestedAgorot != null) {
    return (
      <>
        <FactRow label="התבקש">
          <span className="tabular-nums">
            {formatAgorot(approval.requestedAgorot)}
          </span>
        </FactRow>
        {approval.limitAgorot != null && (
          <FactRow label="התקרה">
            <span className="tabular-nums">
              {formatAgorot(approval.limitAgorot)}
            </span>
          </FactRow>
        )}
      </>
    )
  }

  if (approval.requestedValueBps != null) {
    return (
      <>
        <FactRow label="התבקש">
          <span className="tabular-nums">
            {approval.requestedValueBps / 100}%
          </span>
        </FactRow>
        {approval.limitValueBps != null && (
          <FactRow label="התקרה">
            <span className="tabular-nums">
              {approval.limitValueBps / 100}%
            </span>
          </FactRow>
        )}
      </>
    )
  }

  return null
}
