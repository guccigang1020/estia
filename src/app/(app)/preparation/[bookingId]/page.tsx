import type { Metadata } from 'next'

import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { BuildPlanPanel, PlanBoard } from '@/components/preparation/plan-board'
import { toSafeResponse } from '@/lib/errors'

import { requireGrant } from '../../_lib/guard'
import { loadPlanScreen } from '../_lib/plan'
import { preparationWiring } from '../_lib/wiring'

export const metadata: Metadata = { title: 'תוכנית הכנה לשהייה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One stay's preparation plan.
 *
 * THE SCREEN THE ENGINE NEVER HAD. `src/lib/preparation` computes a sectioned
 * work plan from a frozen ruleset, and until this page existed nothing called
 * `buildPlan` — so `work_plans` was empty in every deployment and
 * `/preparation` said "no plan has been built" to every business, for ever.
 * This is the other end of the chain: a booking goes in, a plan comes out, and
 * a person can see it, argue with the numbers and tick the work off.
 *
 * WHAT IS ON IT, AND WHAT DELIBERATELY IS NOT. Property, unit, the booking's
 * own reference, the arrival that is the deadline, the party size, the kind of
 * stay, the guest's special request, then the sections in dependency order
 * with every item's count, its unit, its instructions, whether it needs a
 * photograph, and how the quantity was arrived at.
 *
 * There is **no guest name and no money of any kind**, for any reader, and
 * that is structural rather than conditional: the whole page renders from
 * `CleanerPlanView`, an explicit projection that has no field for either. No
 * query on this route reads `booking_price_lines` — `loadPlanScreen` does not
 * ask for them — and no branch here reveals more to a manager than to a
 * cleaner. A manager gets *actions* a cleaner does not, which is a different
 * thing from getting facts a cleaner does not.
 *
 * GATING. `requireGrant('task.view')` refuses the route, which is the grant a
 * cleaner holds. Everything that writes is checked separately by `planGrants`
 * before its control is rendered, again by the operation's pipeline against
 * the loaded booking's own property and unit, and again by row level security.
 * A control that leads to a refusal is worse than no control.
 *
 * THE READ FAILS AS ITSELF. "No plan has been built" and "the plan could not
 * be read" are opposite messages and only the second carries a correlation id.
 * A screen that renders the same blank for both teaches people to distrust the
 * empty state, which is the state this product is in most of the time.
 */
export default async function BookingPreparationPage({
  params,
}: {
  params: Promise<{ bookingId: string }>
}) {
  const [actor, { bookingId }] = await Promise.all([
    requireGrant('task.view'),
    params,
  ])

  const { ports } = await preparationWiring()

  let screen: Awaited<ReturnType<typeof loadPlanScreen>> | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    screen = await loadPlanScreen({ ports, actor, bookingId })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/preparation"
          className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          → חזרה ללוח ההכנה
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          תוכנית הכנה לשהייה
        </h1>
        <p className="text-muted-foreground">
          מה הבית צריך לשהייה הזו, לפי מקטעים, עם החשבון שמאחורי כל כמות.
        </p>
      </header>

      {failure ? (
        <ActionError error={failure.error} />
      ) : screen === null ? null : screen.view === null ? (
        <BuildPlanPanel bookingId={bookingId} mayBuild={screen.grants.build} />
      ) : (
        <>
          {/* A plan whose frozen ruleset is missing cannot explain itself, and
              saying so is better than rendering counts with no derivation and
              letting somebody conclude the engine has none. */}
          {screen.snapshotMissing && (
            <p
              role="status"
              className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm text-foreground"
            >
              לתוכנית הזו לא נמצא צילום החוקים שממנו חושבה, ולכן אי אפשר להציג
              את החשבון מאחורי הכמויות. הכמויות עצמן הן מה שנשמר.
            </p>
          )}

          <PlanBoard
            bookingId={bookingId}
            view={screen.view}
            version={screen.version ?? screen.view.version}
            explanations={screen.explanations}
            grants={screen.grants}
            bookingReadable={screen.bookingReadable}
          />
        </>
      )}
    </div>
  )
}
