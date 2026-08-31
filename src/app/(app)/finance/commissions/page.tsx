import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { CommissionTable } from '@/components/finance/commission-table'
import { StatusFilterBar } from '@/components/finance/status-filter'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { COMMISSION_STATUSES } from '@/lib/contracts/states'
import { toSafeResponse } from '@/lib/errors'
import { COMMISSION_STATUS_LABEL } from '@/lib/finance'
import { formatAgorot } from '@/lib/plans/plan'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  describeStatusFilter,
  hasActiveStatusFilter,
  parseStatusFilter,
} from '../_lib/filters'
import {
  FINANCE_PAGE_SIZE,
  commissionTotalAgorot,
  countCommissions,
  listCommissions,
  type CommissionListItem,
} from '../_lib/queries'
import { financeRepository } from '../_lib/wiring'

export const metadata: Metadata = { title: 'עמלות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the business owes its sellers.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.commissions`, each with the rung of
 * the ladder it has reached — ESTIMATED → PENDING → ELIGIBLE → APPROVED → PAID
 * / CANCELLED — the payee it is owed to, and the base it was computed on. The
 * ladder is enforced by CHECK constraints in 0011, not remembered by a screen:
 * `paid` requires an approval and an approval requires eligibility, because
 * paying on `estimated` means paying for stays that never happened.
 *
 * THE PAYEE MAY BE AN AGENCY. `agent_user_id` is nullable and so is
 * `agency_id`; `commissions_has_a_payee` requires one of the two, because an
 * agency keeps the commercial relationship when the individual leaves. The
 * table renders which of the two answered rather than inferring it, and the
 * third case — neither, which `on delete set null` on the person makes
 * reachable — is shown as a row somebody must look at.
 *
 * GATING, AND THE ONE THAT IS EASY TO GET WRONG.
 * `requireGrant('commission.view')` refuses the route and `commissions_select`
 * carries the same grant at the database. `can()` per row is doing real work
 * here rather than belt-and-braces: an external seller's membership is scoped
 * to their own records, so the same `commission.view` serves a finance manager
 * looking across the whole network and an agent looking at one line, and the
 * scope answers "whose".
 *
 * `redact()` withholds `basisAgorot` from a reader without
 * `booking.view_price` — the seller sees what they are owed and not what the
 * stay earned — and the rule's free-text label is withheld with it, because
 * `commissions.explanation` routinely spells the base out in words. That
 * second half is not tidiness: without it the redaction redacts nothing.
 *
 * NOTHING IS RECOMPUTED. The amount is the stored figure, computed from the
 * snapshotted rule when the commission was created. Multiplying the base by
 * the rate on screen would produce a second answer that disagrees the moment
 * an agreement is renegotiated — which is exactly when somebody is looking.
 */
export default async function CommissionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('commission.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const filter = parseStatusFilter(params, COMMISSION_STATUSES)
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const linkBookings = holdsGrant(actor, 'booking.view')

  let commissions: readonly CommissionListItem[] = []
  let total = 0
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { repo } = await financeRepository()
    ;[commissions, total] = await Promise.all([
      listCommissions({
        repo,
        actor,
        organizationId: actor.organizationId,
        propertyId,
        filter,
      }),
      countCommissions(repo, actor.organizationId, propertyId),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const owed = commissionTotalAgorot(commissions)
  const clawbacks = commissions.filter(
    (commission) => commission.clawbackRequired,
  )
  const emptyReason = resolveEmptyReason({
    visibleCount: commissions.length,
    totalCount: total,
    hasActiveFilters: hasActiveStatusFilter(filter, propertyId),
  })

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          עמלות סוכנים
        </h1>
        <p className="text-muted-foreground">
          {propertyName
            ? `העמלות על מכירות ב״${propertyName}״.`
            : 'העמלות על המכירות שבטווח שלך.'}{' '}
          {total === 1 ? 'עמלה אחת סה״כ' : `${total} עמלות סה״כ`}. עמלה נעשית
          חוב רק אחרי שהתנאים שהעסק קבע התקיימו — עד אז היא הערכה.
        </p>
      </header>

      <StatusFilterBar
        path="/finance/commissions"
        legend="סינון עמלות"
        statuses={COMMISSION_STATUSES}
        labels={COMMISSION_STATUS_LABEL}
        selected={filter.status}
        anyLabel="כל השלבים"
      />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'invoice'}
          title={
            emptyReason === 'no_results'
              ? 'אין עמלות שתואמות לסינון'
              : 'עוד לא נרשמו עמלות'
          }
          body={
            emptyReason === 'no_results'
              ? `הסינון הפעיל (${describeStatusFilter(
                  filter,
                  COMMISSION_STATUS_LABEL,
                  propertyName,
                )}) לא מחזיר תוצאות. עמלות אחרות קיימות במערכת — שינוי או ניקוי הסינון יחזיר אותן.`
              : 'כאן תופיע כל עמלה שהעסק חייב לסוכן או לסוכנות: על איזו הזמנה, לפי איזה בסיס ובאיזה שיעור, ובאיזה שלב היא נמצאת בדרך לתשלום.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/finance/commissions" variant="secondary">
                נקה סינון
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {clawbacks.length > 0 && (
            <p
              role="alert"
              className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-danger">
                {clawbacks.length === 1
                  ? 'עמלה אחת דורשת השבה'
                  : `${clawbacks.length} עמלות דורשות השבה`}
              </span>{' '}
              — ההזמנה זוכתה אחרי שהעמלה כבר שולמה. הכסף יצא מהעסק, ולכן זה לא
              שינוי סטטוס אלא חוב שיש לגבות בחזרה.
            </p>
          )}

          <dl className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
            <dt className="text-xs text-muted-foreground">
              סך העמלות בשורות המוצגות
            </dt>
            <dd className="font-display text-xl font-bold tabular-nums text-foreground">
              {formatAgorot(owed)}
            </dd>
            <p className="text-xs text-muted-foreground">
              סיכום השורות שעל המסך בלבד, על פני כל השלבים — לא הסכום שממתין
              לתשלום. סנן לפי שלב כדי לראות אותו.
            </p>
          </dl>

          <CommissionTable
            commissions={commissions}
            linkBookings={linkBookings}
          />

          {commissions.length === FINANCE_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגות {FINANCE_PAGE_SIZE} העמלות האחרונות. צמצם את הסינון כדי
              לראות עמלות נוספות.
            </p>
          )}
        </>
      )}
    </div>
  )
}
