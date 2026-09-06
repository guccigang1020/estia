import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'

import { OwnerPlanLock } from './_components/plan-lock'
import { OwnersGap } from './_components/owners-gap'
import { requireOwnerGrant } from './_lib/gate'
import { ownerList, type OwnerListState } from './_lib/queries'

export const metadata: Metadata = { title: 'בעלי נכסים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The owner register.
 *
 * WHAT IS ON THIS SCREEN. Every owner this reader may see, the properties each
 * holds and at what share, what the business owes them as of their newest
 * statement, and how many decisions are waiting on them.
 *
 * ── The same query answers two very different readers ─────────────────────
 *
 * A finance manager opening this sees the whole register. A property owner
 * opening the identical route sees exactly one row: their own. That is not a
 * second code path — `ownerList` runs one query and hands every row through
 * `visibleOwnerships` and `ownerStatementViews`, which refuse what the reader
 * is not entitled to. One path cannot drift from the other, which is the
 * property that matters when the reader on the second path is an outside party
 * with a competing rental business.
 *
 * An owner with nothing this reader may see is not listed at all. Showing a
 * name and withholding the figures would still disclose *who else* the business
 * manages properties for, which is precisely what an owner may not learn.
 *
 * ── The gate says which of the two noes this is ───────────────────────────
 *
 * `requireOwnerGrant` renders rather than redirects for
 * `plan_does_not_include`, because every owner grant is mapped to the
 * `owner_portal` entitlement: on a package without it nobody in the business
 * holds any of them, including the organization owner, and "you lack a
 * permission" sends that person to an administrator who finds no toggle.
 *
 * ── And there is nothing to read yet ──────────────────────────────────────
 *
 * No migration creates `property_owners`. Rather than an empty state claiming
 * this business has no owners — over a database that could not hold one — the
 * screen names the five tables it is waiting for and what already exists and is
 * waiting for them.
 */
export default async function OwnersPage() {
  const access = await requireOwnerGrant('owner_statement.view')
  const { actor } = access
  const mayReachBilling = holdsGrant(actor, 'organization.billing.manage')

  let state: OwnerListState | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  if (access.kind === 'allow') {
    try {
      state = await ownerList(actor)
    } catch (cause) {
      // A read that failed must not render as a business with no owners. Zero
      // is a claim about the customer; a failure is a claim about ESTIA.
      failure = toSafeResponse(cause, crypto.randomUUID())
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          בעלי נכסים
        </h1>
        <p className="max-w-prose text-muted-foreground">
          נכס שמנוהל עבור בעלים חיצוני מייצר שני דברים שאין להם קיצור דרך: גישה
          שמראה לו את הנכס שלו בלבד, ודוח תקופתי שמסביר מאיפה הגיע הסכום שהועבר
          אליו — ומסתדר עם אותם מספרים שמסך הכספים מציג.
        </p>
      </header>

      {access.kind === 'locked' ? (
        <OwnerPlanLock
          entitlement={access.entitlement}
          mayReachBilling={mayReachBilling}
        />
      ) : failure ? (
        <ActionError error={failure.error} />
      ) : state?.kind === 'not_provisioned' ? (
        <OwnersGap context="הרשימה ריקה כי אין מאיפה לקרוא אותה." />
      ) : state?.kind === 'not_readable' ? (
        <EmptyState
          illustration="team"
          title="אין לך הרשאה לצפות בבעלי הנכסים"
          body="החבילה של הארגון כוללת את פורטל הבעלים, אבל התפקיד שלך אינו כולל את ההרשאה owner_statement.view. מנהל בארגון יכול להוסיף אותה."
        />
      ) : state?.kind === 'ready' && state.owners.length === 0 ? (
        <EmptyState
          illustration="team"
          title="אין בארגון בעלי נכסים חיצוניים"
          body="בעלים חיצוני הוא צד שלישי שהעסק מנהל עבורו נכס — לא בהכרח משתמש במערכת. כשיתווסף אחד, הוא יופיע כאן עם הנכסים שבבעלותו, היתרה מולו והדוחות שהופקו לו."
        />
      ) : state?.kind === 'ready' ? (
        <>
          <p
            role="status"
            className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
          >
            {state.owners.length === 1
              ? 'בעלים אחד'
              : `${state.owners.length} בעלים`}
            . הרשימה מוצגת לפי מה שמותר לך לראות: בעלים שאין לך גישה לשום נכס או
            דוח שלו אינו מופיע כאן כלל.
          </p>

          <ul className="flex flex-col gap-3">
            {state.owners.map((summary) => (
              <li key={summary.owner.id}>
                <Link
                  href={`/owners/${summary.owner.id}`}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-soft transition-colors hover:border-border-strong"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-display text-lg font-bold tracking-tight text-foreground">
                      {summary.owner.displayName}
                    </span>
                    <span
                      dir="ltr"
                      className="tabular-nums text-sm font-semibold text-foreground"
                    >
                      {formatAgorot(summary.balanceAgorot)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {summary.ownerships.map((link) => (
                      <Badge key={link.id} tone="neutral">
                        {state.propertyNames.get(link.propertyId) ?? 'נכס'} ·{' '}
                        {(link.shareBps / 100).toLocaleString('he-IL')}%
                      </Badge>
                    ))}
                    <span>
                      {summary.statementCount === 0
                        ? 'טרם הופק דוח'
                        : `${summary.statementCount} דוחות`}
                    </span>
                    {summary.pendingApprovals > 0 && (
                      <Badge tone="accent">
                        {summary.pendingApprovals} בקשות ממתינות
                      </Badge>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}
