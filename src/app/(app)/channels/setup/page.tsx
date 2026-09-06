import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import {
  SetupSteps,
  type SetupStepKey,
} from '@/components/channels/setup-steps'
import { PlanLock } from '@/components/distribution/plan-lock'
import { EmptyState } from '@/components/states/empty-state'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { validateMapping } from '@/lib/channels/mapping'
import { CHANNEL_LABEL } from '@/lib/channels/types'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireDistributionGrant } from '../../agents/_lib/gate'
import { setupState, type SetupState } from '../_lib/manager'

export const metadata: Metadata = { title: 'התאמת מודעות לערוצים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Connect → discover → match → validate
 * → preview → activate.
 *
 * ══ THE LAST THREE STEPS ARE THE ONES THAT MATTER ══════════════════════════
 *
 * Most channel managers collapse match, validate and activate into a save
 * button, and that is how a guesthouse ends up with Booking.com selling the
 * wrong cabin. This screen keeps them apart:
 *
 *   · **match** is a decision a person makes and is recorded with their name.
 *   · **validate** asks whether the unit exists, belongs to the property named,
 *     and is actually for sale — a mapping onto a unit the availability engine
 *     will always refuse produces an integration that looks configured and
 *     rejects every reservation that arrives through it.
 *   · **activate** is a separate act. `saveMapping` writes `draft`, and
 *     `resolveListing` will not route a reservation through anything but
 *     `active`, so nothing at all moves until somebody presses the button.
 *
 * ── Both directions are reported ──────────────────────────────────────────
 *
 * Listings with no unit, and units with no listing. The first is dangerous —
 * a reservation for it becomes a critical exception. The second is usually
 * deliberate, a cabin the owner keeps for family, and calling it an error
 * would train people to ignore this screen. So they are shown separately and
 * described differently.
 *
 * ── This screen writes nothing yet ────────────────────────────────────────
 *
 * There is no connector with credentials in this codebase — see
 * `null-connector.ts` — so discovery returns nothing to match, and the write
 * path has no channel to validate against. What is here is the read side and
 * the decision structure, both real, both driven by the domain's own pure
 * functions. That is stated on the page rather than mimed with a disabled
 * button whose tooltip nobody reads.
 */
export default async function ChannelSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ connector?: string }>
}) {
  const [access, context, params] = await Promise.all([
    requireDistributionGrant('channel.manage'),
    shellContext(),
    searchParams,
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="ערוצי הפצה אינם כלולים בחבילה שלך"
        body="התאמת מודעות לערוצים היא חלק ממנהל הערוצים, ומנהל הערוצים אינו כלול בחבילה הנוכחית."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let state: SetupState = { kind: 'not_provisioned' }
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    state = await setupState({
      db,
      actor,
      organizationId: actor.organizationId,
      propertyId,
      connectorId: params.connector,
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          התאמת מודעות ליחידות
        </h1>
        <p className="text-muted-foreground">
          מודעה בערוץ צריכה להצביע על יחידה אחת אצלך. מודעה שלא מופתה תיצור
          חריגה — לא ניחוש, ולא הזמנה שנעלמת.
        </p>
        <Link
          href="/channels"
          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
        >
          חזרה למצב הערוצים
        </Link>
      </header>

      {failure ? (
        <ActionError error={failure.error} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
          <aside>
            <SetupSteps current={currentStep(state)} />
          </aside>
          <div className="flex flex-col gap-6">
            <SetupBody state={state} />
          </div>
        </div>
      )}
    </div>
  )
}

/** Where this business has actually got to. Derived, never assumed. */
function currentStep(state: SetupState): SetupStepKey {
  if (state.kind !== 'ready') return 'connect'
  if (state.listings.length === 0) return 'discover'
  if (state.plan.unmatched.length > 0) return 'match'
  if (!state.plan.complete) return 'activate'
  return 'preview'
}

function SetupBody({ state }: { state: SetupState }) {
  if (state.kind === 'not_readable') {
    return (
      <div
        role="status"
        className="rounded-xl border border-border bg-surface px-4 py-4 text-sm text-muted-foreground"
      >
        אין לך הרשאה לנהל ערוצי הפצה.
      </div>
    )
  }

  if (state.kind === 'not_provisioned') {
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground"
      >
        <p className="font-display text-base font-bold">
          מנהל הערוצים אינו מותקן בהתקנה הזו.
        </p>
        <p>
          הטבלאות שמחזיקות חיבורים, מודעות והתאמות טרם נוצרו, ולכן אין מה למפות
          עדיין. השלבים משמאל הם הרצף שיתבצע ברגע שיהיו.
        </p>
      </div>
    )
  }

  if (state.kind === 'no_connectors') {
    return (
      <>
        <EmptyState
          illustration="calendar"
          title="לא חובר אף ערוץ"
          body="השלב הראשון הוא חיבור לחשבון שלך בערוץ. עד אז אין מודעות למפות."
        />
        <NoCredentialsNotice />
        <UnitsCard units={state.units} />
      </>
    )
  }

  return (
    <>
      {state.connectors.length > 1 && (
        <nav className="flex flex-wrap gap-2" aria-label="בחירת ערוץ">
          {state.connectors.map((connector) => (
            <Link
              key={connector.id}
              href={`/channels/setup?connector=${connector.id}`}
              aria-current={
                connector.id === state.selected.id ? 'page' : undefined
              }
              className={
                connector.id === state.selected.id
                  ? 'rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground'
                  : 'rounded-lg border border-border px-3 py-1.5 text-sm text-foreground'
              }
            >
              {CHANNEL_LABEL[connector.channelCode]}
            </Link>
          ))}
        </nav>
      )}

      {state.listings.length === 0 ? (
        <>
          <EmptyState
            illustration="calendar"
            title="לא נמצאו מודעות בערוץ"
            body="החיבור קיים, ואיתור המודעות עוד לא הוחזר עם תוצאות. עד שיוחזרו מודעות אין מה למפות."
          />
          <NoCredentialsNotice />
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2">מודעות בערוץ</CardTitle>
          </CardHeader>
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {state.plan.rows.map((row) => {
              const unit = state.units.find(
                (candidate) => candidate.unitId === row.mapping?.unitId,
              )
              const validation = row.mapping
                ? validateMapping({
                    draft: {
                      channelCode: row.mapping.channelCode,
                      externalListingId: row.mapping.externalListingId,
                      externalVariantId: row.mapping.externalVariantId,
                      propertyId: row.mapping.propertyId,
                      unitId: row.mapping.unitId,
                    },
                    units: state.units,
                    listings: state.listings,
                    existing: state.mappings.filter(
                      (mapping) => mapping.id !== row.mapping?.id,
                    ),
                  })
                : null

              return (
                <li
                  key={`${row.listing.externalListingId}:${row.listing.externalVariantId ?? '-'}`}
                  className="flex flex-col gap-2 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold text-foreground">
                        {row.listing.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.listing.externalListingId}
                        {row.listing.externalVariantId
                          ? ` · ${row.listing.externalVariantId}`
                          : ''}
                        {row.listing.active ? '' : ' · לא פעילה בערוץ'}
                      </span>
                    </span>
                    <span className="text-sm text-foreground">
                      {row.ambiguous
                        ? 'שתי התאמות — יש להשהות אחת'
                        : row.mapping
                          ? `${unit?.name ?? row.mapping.unitId} · ${row.mapping.state}`
                          : 'לא ממופה'}
                    </span>
                  </div>

                  {validation && validation.problems.length > 0 && (
                    <ul className="flex flex-col gap-1 text-xs">
                      {validation.problems.map((problem) => (
                        <li
                          key={problem.kind}
                          className={
                            problem.blocking ? 'text-danger' : 'text-warning'
                          }
                        >
                          {problem.blocking ? 'חוסם: ' : 'לתשומת לב: '}
                          {problem.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>

          {state.plan.unmatched.length > 0 && (
            <p className="mt-4 border-t border-border pt-4 text-sm text-danger">
              {state.plan.unmatched.length} מודעות ללא יחידה. כל הזמנה שתגיע מהן
              תיעצר כחריגה ולא תיצור הזמנה — והתאריכים לא ייחסמו אצלך.
            </p>
          )}
        </Card>
      )}

      <UnitsCard units={state.units} unlisted={state.plan.unlistedUnits} />
    </>
  )
}

/**
 * The sentence that keeps this screen honest.
 *
 * Rendered wherever the flow stalls for want of a channel, because "no
 * listings found" without it reads as a channel with no listings rather than
 * as a system with no credentials.
 */
function NoCredentialsNotice() {
  return (
    <div
      role="status"
      className="rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground"
    >
      <p className="font-display text-base font-bold">
        אין פרטי גישה לאף ערוץ במערכת הזו.
      </p>
      <p className="mt-1">
        לא Booking.com, לא Airbnb, לא Expedia. לכן איתור מודעות לא יחזיר דבר,
        ושום עדכון לא ייצא. מה שנבנה כאן הוא ההחלטה והבדיקה — הרגע שבו יתווסף
        חיבור אמיתי, המסך הזה כבר יודע מה לעשות איתו.
      </p>
    </div>
  )
}

function UnitsCard({
  units,
  unlisted,
}: {
  units: readonly { unitId: string; name: string; sellable: boolean }[]
  unlisted?: readonly { unitId: string; name: string }[]
}) {
  const notSellable = units.filter((unit) => !unit.sellable)

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">היחידות שלך</CardTitle>
      </CardHeader>
      <p className="mt-2 text-sm text-muted-foreground">
        {units.length} יחידות בטווח הנוכחי. יחידה שאינה פעילה אי אפשר למכור
        בערוץ — מנוע הזמינות יסרב לכל הזמנה שתגיע אליה.
      </p>

      {notSellable.length > 0 && (
        <p className="mt-3 text-sm text-warning">
          {notSellable.length} יחידות אינן פעילות:{' '}
          {notSellable.map((unit) => unit.name).join(', ')}.
        </p>
      )}

      {unlisted && unlisted.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {unlisted.length} יחידות אינן נמכרות בערוץ הזה. לרוב זו החלטה מכוונת —
          יחידה ששמורה למשפחה, למשל — ולכן זו הערה ולא שגיאה.
        </p>
      )}
    </Card>
  )
}
