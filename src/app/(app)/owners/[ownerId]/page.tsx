import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import {
  OWNER_APPROVAL_KIND_LABEL,
  OWNER_PAYOUT_DIRECTION_LABEL,
  OWNER_PAYOUT_METHOD_LABEL,
  OWNER_STATEMENT_STATUS_LABEL,
  isAwaitingOwner,
} from '@/lib/owners'
import { formatAgorot } from '@/lib/plans/plan'

import { OwnerPlanLock } from '../_components/plan-lock'
import { OwnersGap } from '../_components/owners-gap'
import { requireOwnerGrant } from '../_lib/gate'
import { ownerDetail, type OwnerDetailState } from '../_lib/queries'

export const metadata: Metadata = { title: 'בעלים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One owner's dashboard.
 *
 * WHAT IS ON THIS SCREEN. The properties this owner holds and at what share,
 * the statements issued to them, the movements on their account, and the
 * decisions waiting on them.
 *
 * ── `notFound()` and not "you may not" ────────────────────────────────────
 *
 * An owner id is in the URL, so the URL is the only thing that chose this
 * record. When the reader may see nothing about it — another owner's record, or
 * the same property's co-owner — `ownerDetail` answers `not_found` rather than
 * `not_readable`, and this renders Next's 404. "This exists and is not yours"
 * is more than the reader is owed: it confirms that the business manages a
 * property for somebody, which is exactly the fact an owner may not learn about
 * another owner.
 *
 * A missing *permission* is different and is said plainly — that reader is
 * inside the business and the answer to it is an administrator, not a 404.
 *
 * ── What is not here ──────────────────────────────────────────────────────
 *
 * No booking list, no guest, no channel. Occupancy is summarised on the
 * statement as a count of stays. An owner is entitled to know their villa was
 * occupied and what it earned; who slept in it is the business's relationship
 * with its guest, and `visibility.ts` is written so this page could not render
 * it even if somebody added the column.
 */
export default async function OwnerPage({
  params,
}: {
  params: Promise<{ ownerId: string }>
}) {
  const [{ ownerId }, access] = await Promise.all([
    params,
    requireOwnerGrant('owner_statement.view'),
  ])

  const { actor } = access
  const mayReachBilling = holdsGrant(actor, 'organization.billing.manage')

  let state: OwnerDetailState | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  if (access.kind === 'allow') {
    try {
      state = await ownerDetail(actor, ownerId)
    } catch (cause) {
      failure = toSafeResponse(cause, crypto.randomUUID())
    }
  }

  if (state?.kind === 'not_found') notFound()

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="ניווט" className="text-sm">
        <Link href="/owners" className="text-muted-foreground hover:underline">
          ← לכל בעלי הנכסים
        </Link>
      </nav>

      {access.kind === 'locked' ? (
        <OwnerPlanLock
          entitlement={access.entitlement}
          mayReachBilling={mayReachBilling}
        />
      ) : failure ? (
        <ActionError error={failure.error} />
      ) : state?.kind === 'not_provisioned' ? (
        <OwnersGap context="אין מה להציג כאן כי הרשומה עצמה אינה קיימת במסד." />
      ) : state?.kind === 'not_readable' ? (
        <EmptyState
          illustration="team"
          title="אין לך הרשאה לצפות בבעלי הנכסים"
          body="החבילה של הארגון כוללת את פורטל הבעלים, אבל התפקיד שלך אינו כולל את ההרשאה owner_statement.view."
        />
      ) : state?.kind === 'ready' ? (
        <>
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                {state.owner.displayName}
              </h1>
              {state.owner.status === 'inactive' && (
                <Badge tone="neutral">לא פעיל</Badge>
              )}
              {state.owner.userId === null && (
                <Badge tone="neutral">ללא חשבון במערכת</Badge>
              )}
            </div>

            <ul className="flex flex-wrap gap-2">
              {state.ownerships.map((link) => (
                <li key={link.id}>
                  <Badge tone="brand">
                    {state.propertyNames.get(link.propertyId) ?? 'נכס'} ·{' '}
                    {(link.shareBps / 100).toLocaleString('he-IL')}%
                    {link.effectiveTo !== null && ' · הסתיים'}
                  </Badge>
                </li>
              ))}
            </ul>
          </header>

          {state.tally.waiting > 0 && (
            <section
              aria-labelledby="owner-approvals"
              className="flex flex-col gap-3 rounded-xl border border-border-strong bg-accent-soft px-5 py-4 text-accent-foreground"
            >
              <h2 id="owner-approvals" className="font-display font-bold">
                {state.tally.waiting === 1
                  ? 'בקשה אחת ממתינה להכרעה'
                  : `${state.tally.waiting} בקשות ממתינות להכרעה`}{' '}
                · {formatAgorot(state.tally.waitingAgorot)}
              </h2>
              <ul className="flex flex-col gap-2 text-sm">
                {state.approvals
                  .filter((approval) => isAwaitingOwner(approval, new Date()))
                  .map((approval) => (
                    <li key={approval.id} className="flex flex-col gap-0.5">
                      <span className="font-semibold">
                        {OWNER_APPROVAL_KIND_LABEL[approval.kind]}
                        {approval.requestedAgorot !== null && (
                          <>
                            {' · '}
                            <span dir="ltr" className="tabular-nums">
                              {formatAgorot(approval.requestedAgorot)}
                            </span>
                          </>
                        )}
                      </span>
                      <span className="opacity-90">{approval.reason}</span>
                    </li>
                  ))}
              </ul>
              <p className="text-xs opacity-80">
                הכרעה נרשמת דרך מנגנון האישורים של המערכת, ומי שהגיש את הבקשה
                אינו יכול לאשר אותה בעצמו.
              </p>
            </section>
          )}

          <section
            aria-labelledby="owner-statements"
            className="flex flex-col gap-3"
          >
            <h2
              id="owner-statements"
              className="font-display text-xl font-bold tracking-tight text-foreground"
            >
              דוחות תקופתיים
            </h2>

            {state.statements.length === 0 ? (
              <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                טרם הופק דוח. דוח מופק לתקופה, נסגר כמסמך, ומרגע שהופק אינו
                משתנה — תיקון נעשה בהפקת דוח מתקן לאותה תקופה.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {state.statements.map((statement) => (
                  <li key={statement.id}>
                    <Link
                      href={`/owners/${state.owner.id}/statements/${statement.id}`}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-5 py-3.5 shadow-soft transition-colors hover:border-border-strong"
                    >
                      <span className="text-sm text-foreground">
                        {statement.periodStart} – {statement.periodEnd}
                        {' · '}
                        {state.propertyNames.get(statement.propertyId) ?? 'נכס'}
                      </span>
                      <span className="flex items-center gap-3">
                        <Badge
                          tone={
                            statement.status === 'issued' ? 'brand' : 'neutral'
                          }
                        >
                          {OWNER_STATEMENT_STATUS_LABEL[statement.status]}
                        </Badge>
                        <span
                          dir="ltr"
                          className="tabular-nums text-sm font-semibold text-foreground"
                        >
                          {formatAgorot(statement.ownerShareAgorot)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-labelledby="owner-payouts"
            className="flex flex-col gap-3"
          >
            <h2
              id="owner-payouts"
              className="font-display text-xl font-bold tracking-tight text-foreground"
            >
              תנועות בחשבון
            </h2>

            {state.payouts.length === 0 ? (
              <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                לא נרשמו תנועות. תשלום לבעלים ותקבול ממנו נרשמים באותו חשבון, כי
                זו יתרה אחת מול אותו אדם.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {state.payouts.map((payout) => (
                  <li
                    key={payout.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-5 py-3 text-sm shadow-soft"
                  >
                    <span className="text-muted-foreground">
                      {payout.paidOn} ·{' '}
                      {OWNER_PAYOUT_DIRECTION_LABEL[payout.direction]} ·{' '}
                      {OWNER_PAYOUT_METHOD_LABEL[payout.method]}
                      {payout.reference !== null && ` · ${payout.reference}`}
                    </span>
                    <span
                      dir="ltr"
                      className="tabular-nums font-semibold text-foreground"
                    >
                      {formatAgorot(payout.amountAgorot)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}
