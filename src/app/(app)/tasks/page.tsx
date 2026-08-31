import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { TaskFilterBar } from '@/components/operations/task-filter'
import { TaskTable } from '@/components/operations/task-table'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import {
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  TASK_TYPE_LABEL,
} from '@/components/preparation/task-status'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '@/lib/contracts/states'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  describeTaskFilter,
  hasActiveTaskFilter,
  parseTaskFilter,
} from './_lib/filters'
import {
  OPERATIONS_PAGE_SIZE,
  countTasks,
  listTasks,
  summariseTasks,
  type TaskListItem,
} from './_lib/queries'

export const metadata: Metadata = { title: 'משימות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The task board.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.tasks` for the organization the
 * shell resolved, narrowed to the selected property and to the membership's
 * scope, read through the request-scoped Supabase client under row level
 * security. Every value shown is a column or a Hebrew name for one. There is no
 * money on this screen because `public.tasks` has no amount column — what
 * maintenance costs is on `/maintenance`, where it is read from the approvals
 * and the stock it consumed.
 *
 * GATING, IN FOUR PLACES, AND NONE OF THEM IS THE MENU.
 * `requireGrant('task.view')` refuses the route. The membership's scope is
 * pushed into the query, so an out-of-scope row is never read. `can()` per row
 * narrows again — a query built wrong must come out short rather than wide.
 * And `redact()` removes the link to the stay without `booking.view` and the
 * reporter's name without `user.view`.
 *
 * THE CLEANER IS THE TEST. ורד holds `task.view`, `task.update`,
 * `task.complete` and `incident.create`, and her membership is scoped to the
 * housekeeping team. So she reaches this route, sees her team's jobs and no
 * others, and cannot follow any of them back to the stay — which is where the
 * guest's name and the price of the night are. She is not told a price is being
 * hidden; the column is simply not on her screen.
 *
 * `blocked` IS THE POINT OF THE BOARD. `TASK_STATUSES` separates `blocked` from
 * `in_progress` because a cleaner waiting for linen is not making progress, and
 * a board that cannot show the difference cannot show a supervisor where the
 * day is stuck. The count is stated above the table, the row is outlined, and
 * the reason is printed in words.
 *
 * THE EMPTY STATE IS TWO STATES. `resolveEmptyReason` is given the filtered
 * count *and* the count this membership reaches unfiltered, so "you have no
 * tasks" is never shown to somebody whose filter merely matched nothing.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('task.view'),
    shellContext(),
    searchParams,
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const filter = parseTaskFilter(params)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  // The control is offered only when the route behind it would admit them.
  const linkBookings = holdsGrant(actor, 'booking.view')
  const canCreate = holdsGrant(actor, 'task.create')

  let tasks: readonly TaskListItem[] = []
  let reachable = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[tasks, reachable] = await Promise.all([
      listTasks({ db, actor, propertyId, filter, grant: 'task.view' }),
      countTasks({ db, actor, propertyId, grant: 'task.view' }),
    ])
  } catch (cause) {
    // A screen that renders nothing because a query failed must not look like
    // a business with no work to do. The failure is stated instead.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const summary = summariseTasks(tasks)
  const emptyReason = resolveEmptyReason({
    visibleCount: tasks.length,
    totalCount: reachable,
    hasActiveFilters: hasActiveTaskFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          משימות
        </h1>
        <p className="text-muted-foreground">
          {propertyName
            ? `העבודה שבטווח שלך ב״${propertyName}״.`
            : 'העבודה שבטווח שלך, בכל הנכסים והצוותים שאתה מגיע אליהם.'}{' '}
          {reachable === 1 ? 'משימה אחת סה״כ' : `${reachable} משימות סה״כ`}.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        {canCreate && <Button href="/tasks/new">משימה חדשה</Button>}
      </div>

      <TaskFilterBar
        path="/tasks"
        legend="סינון משימות"
        axes={['status', 'type', 'priority']}
        statuses={TASK_STATUSES}
        types={TASK_TYPES}
        priorities={TASK_PRIORITIES}
        selected={filter}
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'task'}
          title={
            emptyReason === 'no_results'
              ? 'אין משימות שתואמות לסינון'
              : 'אין משימות בטווח שלך'
          }
          body={
            emptyReason === 'no_results'
              ? `הסינון הפעיל (${describeTaskFilter(
                  filter,
                  {
                    status: TASK_STATUS_LABEL,
                    type: TASK_TYPE_LABEL,
                    priority: TASK_PRIORITY_LABEL,
                  },
                  propertyName,
                )}) לא מחזיר תוצאות. משימות אחרות קיימות במערכת — שינוי או ניקוי הסינון יחזיר אותן.`
              : 'כאן תופיע כל עבודה שמישהו אחראי עליה — ניקיון, הכנה, ביקורת, תחזוקה ובקשות אורח — עם היחידה שהיא שייכת לה, מי מחזיק אותה ומתי היא אמורה להסתיים. משימות ניקיון והכנה נפתחות מעצמן לפי היציאות וההגעות.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/tasks" variant="secondary">
                נקה סינון
              </Button>
            ) : canCreate ? (
              <Button href="/tasks/new">צור משימה</Button>
            ) : null
          }
        />
      ) : (
        <>
          {summary.blocked > 0 && (
            <p
              // `alert`, not a polite status: a blocked job is work that has
              // stopped and will not restart on its own, and it is the reason
              // somebody opened this screen.
              role="alert"
              className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-danger">
                {summary.blocked === 1
                  ? 'משימה אחת תקועה'
                  : `${summary.blocked} משימות תקועות`}
              </span>{' '}
              — מישהו ממתין למשהו מחוץ למשימה עצמה. אלה אינן משימות שנמצאות
              בביצוע, והן לא יתקדמו מעצמן. הסיבה מופיעה על כל שורה.
            </p>
          )}

          <dl className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-4 sm:p-5">
            <Figure label="על המסך" value={summary.total} />
            <Figure label="פתוחות" value={summary.open} />
            <Figure label="באיחור" value={summary.overdue} tone="warning" />
            <Figure
              label="לא מוקצות"
              value={summary.unassigned}
              tone="warning"
            />
            <p className="text-xs text-muted-foreground sm:col-span-4">
              המספרים מתייחסים לשורות המוצגות בלבד.
            </p>
          </dl>

          <TaskTable
            tasks={tasks}
            linkBookings={linkBookings}
            caption="רשימת המשימות שבטווח שלך, ממוינת לפי מועד היעד"
          />

          {/* Said out loud rather than left for somebody to discover that the
              list quietly stops. */}
          {tasks.length === OPERATIONS_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגות {OPERATIONS_PAGE_SIZE} המשימות הקרובות ביותר. צמצם את
              הסינון כדי לראות משימות נוספות.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Figure({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'warning'
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          tone === 'warning' && value > 0
            ? 'font-display text-xl font-bold tabular-nums text-warning'
            : 'font-display text-xl font-bold tabular-nums text-foreground'
        }
      >
        {value}
      </dd>
    </div>
  )
}
