import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { EmptyState } from '@/components/states/empty-state'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'

import { OwnerPlanLock } from '../../../_components/plan-lock'
import { OwnersGap } from '../../../_components/owners-gap'
import { StatementView } from '../../../_components/statement-view'
import { requireOwnerGrant } from '../../../_lib/gate'
import { ownerStatement, type StatementState } from '../../../_lib/queries'

export const metadata: Metadata = { title: 'דוח בעלים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One period statement.
 *
 * WHAT IS ON THIS SCREEN. The document as it was issued: the chain from gross
 * revenue down to the property's owner share, this owner's part of it, and the
 * account it lands on. Nothing on this page is computed — every figure was
 * frozen when the statement was issued, and the component that renders it adds
 * nothing up.
 *
 * ── Two ids in the URL, and both are checked ──────────────────────────────
 *
 * `ownerStatement` loads by id and then asks the domain whether this reader may
 * have it: the grant, the property's scope, and — the one scope cannot answer —
 * whether the statement is addressed to them. Two people may each own half of
 * the same villa and each legitimately reach it; only one of them may read this
 * document, with the other's share and balance on it. A refusal is `notFound()`
 * rather than a message, because confirming the document exists is itself the
 * disclosure.
 *
 * The owner id in the path is checked against the statement's own, so a URL
 * that pairs one owner with another's statement cannot render either.
 *
 * ── Redaction happens before the component sees anything ──────────────────
 *
 * The statement reaching `StatementView` has already been through
 * `ownerStatementView`, which folds the sales commission away for a reader
 * without `owner.view_commission` and sweeps the whole object for anything
 * carrying identity. The component has no branch on the reader at all — it
 * renders what it was handed — which is what makes "the screens cannot bypass
 * the redaction" a fact about the shape rather than a rule to remember.
 */
export default async function OwnerStatementPage({
  params,
}: {
  params: Promise<{ ownerId: string; statementId: string }>
}) {
  const [{ ownerId, statementId }, access] = await Promise.all([
    params,
    requireOwnerGrant('owner_statement.view'),
  ])

  const { actor } = access
  const mayReachBilling = holdsGrant(actor, 'organization.billing.manage')

  let state: StatementState | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  if (access.kind === 'allow') {
    try {
      state = await ownerStatement(actor, ownerId, statementId)
    } catch (cause) {
      failure = toSafeResponse(cause, crypto.randomUUID())
    }
  }

  if (state?.kind === 'not_found') notFound()

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="ניווט" className="text-sm">
        <Link
          href={`/owners/${ownerId}`}
          className="text-muted-foreground hover:underline"
        >
          ← לעמוד הבעלים
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
        <OwnersGap context="אין דוח להציג כי אין טבלה שמחזיקה אותו." />
      ) : state?.kind === 'not_readable' ? (
        <EmptyState
          illustration="team"
          title="אין לך הרשאה לצפות בדוח"
          body="החבילה של הארגון כוללת את פורטל הבעלים, אבל התפקיד שלך אינו כולל את ההרשאה owner_statement.view."
        />
      ) : state?.kind === 'ready' ? (
        <StatementView
          statement={state.statement}
          propertyName={state.propertyName}
          ownerName={state.owner.displayName}
        />
      ) : null}
    </div>
  )
}
