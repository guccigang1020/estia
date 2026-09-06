'use client'

/**
 * The moves this case can make, and the closure that may be refused.
 *
 * ── Why the buttons are handed in rather than derived here ────────────────
 *
 * `availableTransitions` is a pure function over the case's facts and it runs
 * on the server, where the same function the operation uses is already
 * evaluated. Recomputing it in the browser would be a second copy of the state
 * machine, and the first time they disagree the reader gets a button that
 * fails on press.
 *
 * ── Closing is a separate control, deliberately ───────────────────────────
 *
 * It is not one of the transition buttons. Closing carries `incident.resolve`
 * rather than `incident.update`, it is the last point at which a deposit can
 * still be argued about, and the two refusals it can hit — an unanswered
 * question, money nobody decided — are ones the reader has to be able to read
 * and act on. So it gets its own button, its own confirmation and the server's
 * own sentence when it is refused.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  advanceCaseAction,
  closeCaseAction,
} from '@/app/(app)/incidents/cases/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import type { SafeErrorBody } from '@/lib/errors'
import {
  INCIDENT_CASE_STATUS_LABEL,
  type IncidentCaseStatus,
} from '@/lib/incidents'

export function CaseWorkflowControls({
  caseId,
  status,
  available,
  mayWork,
  mayClose,
  /** Why closing is refused right now, or null when it is not. */
  closeRefusal,
}: {
  caseId: string
  status: IncidentCaseStatus
  available: readonly IncidentCaseStatus[]
  mayWork: boolean
  mayClose: boolean
  closeRefusal: string | null
}) {
  const router = useRouter()
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const advance = useAsyncAction<void>()
  const close = useAsyncAction<void>()

  const moves = available.filter((target) => target !== 'closed')

  if (!mayWork && !mayClose) {
    return (
      <p className="text-sm text-muted-foreground">
        ההרשאה שלך כוללת צפייה בתיק ולא עדכון שלו.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {failure && <ActionError error={failure} />}

      {mayWork && moves.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {moves.map((target) => (
            <Button
              key={target}
              variant="secondary"
              disabled={advance.pending || close.pending}
              onClick={() =>
                advance.run(async () => {
                  setFailure(null)
                  const result = await advanceCaseAction({
                    caseId,
                    status: target,
                  })
                  if (!result.ok) {
                    setFailure(result.error)
                    return
                  }
                  router.refresh()
                })
              }
            >
              {INCIDENT_CASE_STATUS_LABEL[target]}
            </Button>
          ))}
        </div>
      )}

      {mayWork && moves.length === 0 && status !== 'closed' && (
        <p className="text-sm text-muted-foreground">
          אין מצב שאפשר להעביר אליו את התיק כרגע.
        </p>
      )}

      {mayClose && status !== 'closed' && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {closeRefusal === null ? (
            <Button
              disabled={advance.pending || close.pending}
              onClick={() =>
                close.run(async () => {
                  setFailure(null)
                  const result = await closeCaseAction({ caseId })
                  if (!result.ok) {
                    setFailure(result.error)
                    return
                  }
                  router.refresh()
                })
              }
            >
              סגור את התיק
            </Button>
          ) : (
            <>
              {/*
                Disabled with the reason beside it, never disabled silently. The
                sentence is the server's own refusal, so pressing it anyway
                through a crafted request produces exactly this text.
              */}
              <Button disabled>סגור את התיק</Button>
              <p
                role="status"
                className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground"
              >
                {closeRefusal}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
