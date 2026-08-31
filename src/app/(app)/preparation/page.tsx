import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { HorizonBar } from '@/components/preparation/horizon-bar'
import { TaskBoard } from '@/components/preparation/task-board'
import { WorkPlanPanel } from '@/components/preparation/work-plan-panel'
import { EmptyState } from '@/components/states/empty-state'
import { can } from '@/lib/authz/can'
import { localDate } from '@/lib/booking/dates'
import { toSafeResponse } from '@/lib/errors'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import {
  describeHorizon,
  horizonIssue,
  isCustomHorizon,
  parseHorizon,
} from './_lib/horizon'
import {
  PLAN_LOOKUP_LIMIT,
  PREPARATION_PAGE_SIZE,
  countUndatedTasks,
  listPreparationTasks,
  loadPlansForTasks,
  type PlannedStay,
  type PreparationTask,
} from './_lib/queries'
import { preparationWiring } from './_lib/wiring'

export const metadata: Metadata = { title: 'הכנת יחידות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The preparation and housekeeping board.
 *
 * WHAT IS ON THIS SCREEN. Two things over one window of days.
 *
 *   1. The **work plans** the preparation domain computed for the stays in the
 *      window, read through `SupabasePreparationPorts` — the real adapter over
 *      `work_plans` and `preparation_snapshots`. Sections, their state, who
 *      holds each one, and the day whose rules the plan was frozen against.
 *      Nothing on this page recomputes a quantity or a duration:
 *      `criticalPathMinutes` and `outstandingItems` are the domain's own
 *      functions called on the stored plan.
 *
 *   2. The **jobs** themselves, from `public.tasks`: cleaning, preparation,
 *      inspection and the maintenance that stops a unit being lettable, with a
 *      due time, a unit, a status and the people on them.
 *
 * THE EMPTY PLAN IS A FACT, NOT A FAILURE. `buildPlan` is a write and no
 * screen calls it yet, so a business can have a full board of real cleaning
 * jobs and no computed plan behind any of them. That is said in words — see
 * `WorkPlanPanel` — and is rendered *only* on the success path. A read that
 * threw renders `ActionError` with a correlation id instead, because "nothing
 * is scheduled" and "we could not find out" must never look alike.
 *
 * THE TWO READS FAIL SEPARATELY, ON PURPOSE. The plans and the jobs are
 * independent queries over independent tables, and one `try` around both would
 * mean a cleaner's whole morning disappearing behind an error because
 * `work_plans` could not be read. A person standing in a doorway with a mop
 * needs the list of rooms; the plan panel above it can say it is unavailable
 * on its own. Two states, two messages, neither pretending to be the other.
 *
 * GATING, AND THE SHARPEST PRIVACY CASE IN THE PRODUCT.
 * `requireGrant('task.view')` refuses the route. That is the grant a cleaner
 * holds — and the *only* relevant one they hold: no `booking.view`, no
 * `guest.view`, no `booking.view_price`, no `availability.view`. So the same
 * route that gives them their morning refuses them `/reports` and
 * `/reports/operations` outright, and the stay behind a job is offered as a
 * link only to a reader holding `booking.view`.
 *
 * The narrowing underneath that is the membership's scope, applied in SQL and
 * checked again per row — see `_lib/queries.ts`. A cleaner is scoped to her
 * team, so the maintenance jobs on the same property are not merely hidden
 * from her screen; they are not in her result set. No money figure of any kind
 * is fetched by any query on this page, for any reader.
 */
export default async function PreparationPage({
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

  const horizon = parseHorizon(params)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const mayOpenBooking = can(actor, 'booking.view', {
    organizationId: actor.organizationId,
  })

  let tasks: readonly PreparationTask[] = []
  let stays: readonly PlannedStay[] = []
  let undated = 0
  let taskFailure: ReturnType<typeof toSafeResponse> | null = null
  let planFailure: ReturnType<typeof toSafeResponse> | null = null

  const { db, ports } = await preparationWiring()
  const args = { actor, propertyId, horizon }

  try {
    ;[tasks, undated] = await Promise.all([
      listPreparationTasks(db, args),
      countUndatedTasks(db, args),
    ])
  } catch (cause) {
    taskFailure = toSafeResponse(cause, crypto.randomUUID())
  }

  // Second, not in parallel: the stays worth looking a plan up for are the
  // ones this reader's own jobs point at. Asking `bookings` instead would show
  // a cleaner nothing at all, because she may not read that table. And in its
  // own `try`, so a deployment whose preparation tables are missing still
  // hands the person their list of rooms.
  try {
    stays = await loadPlansForTasks(ports, tasks)
  } catch (cause) {
    planFailure = toSafeResponse(cause, crypto.randomUUID())
  }

  const period = describeHorizon(horizon)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          הכנת יחידות
        </h1>
        <p className="text-muted-foreground">
          {propertyName
            ? `מה צריך להיות מוכן ב״${propertyName}״, ביחידה, ועד מתי.`
            : 'מה צריך להיות מוכן, באיזו יחידה, ועד מתי — בכל הנכסים שבטווח שלך.'}{' '}
          הטווח המוצג: {period}.
        </p>

        {/* Undated work exists and a dated board cannot show it. Said out loud
            rather than left to vanish. */}
        {undated > 0 && (
          <p className="text-sm text-muted-foreground">
            בנוסף,{' '}
            {undated === 1
              ? 'משימת הכנה אחת ללא מועד יעד'
              : `${undated} משימות הכנה ללא מועד יעד`}{' '}
            אינן מופיעות בלוח מבוסס-הימים הזה.
          </p>
        )}
      </header>

      <HorizonBar horizon={horizon} issue={horizonIssue(params)} />

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
          תוכניות הכנה
        </h2>

        {/* "No plan has been built" and "the plan table could not be read"
            are opposite messages, and this is the branch that keeps them
            apart. Only the second carries a correlation id. */}
        {planFailure ? (
          <ActionError error={planFailure.error} />
        ) : (
          <>
            <WorkPlanPanel stays={stays} lookedUp={stays.length} />

            {/* An N+1 with a ceiling on it. Said here rather than discovered
                by somebody wondering why the twenty-sixth stay has no plan. */}
            {stays.length === PLAN_LOOKUP_LIMIT && (
              <p
                role="status"
                className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
              >
                נבדקו {PLAN_LOOKUP_LIMIT} השהיות הראשונות בטווח. צמצם את הטווח
                כדי לבדוק את השאר.
              </p>
            )}
          </>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
          משימות בטווח
        </h2>

        {taskFailure ? (
          <ActionError error={taskFailure.error} />
        ) : tasks.length === 0 ? (
          <EmptyState
            illustration={isCustomHorizon(horizon) ? 'search' : 'task'}
            as="h3"
            title={
              isCustomHorizon(horizon)
                ? 'אין משימות הכנה בטווח שבחרת'
                : 'אין משימות הכנה בשבוע הקרוב'
            }
            body={
              isCustomHorizon(horizon)
                ? `בטווח ${period} אין משימות ניקיון, הכנה, ביקורת או תחזוקה שבטווח שלך. טווח אחר עשוי להחזיר משימות.`
                : 'משימות ניקיון והכנה נפתחות לפי מועדי היציאה וההגעה של האורחים. אין כרגע אף אחת בטווח שלך — זה מצב אמיתי, לא תקלה בטעינה.'
            }
          />
        ) : (
          <>
            <TaskBoard
              tasks={tasks}
              today={localDate(new Date())}
              mayOpenBooking={mayOpenBooking}
            />

            {tasks.length === PREPARATION_PAGE_SIZE && (
              <p
                role="status"
                className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
              >
                מוצגות {PREPARATION_PAGE_SIZE} המשימות הראשונות בטווח. צמצם את
                הטווח כדי לראות את השאר.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  )
}
