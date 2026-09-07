'use client'

/**
 * Stop offering a campaign.
 *
 * `'use client'` because it holds one piece of state — whether the reason box
 * is open — and because the reason must be typed before the request is sent.
 * A pause with an empty reason is refused by the operation (`min: 8`), and
 * discovering that from a server round trip would be a worse form than one
 * that will not submit.
 *
 * ── Why a reason is required at all ────────────────────────────────────────
 *
 * The row survives. `deactivated_at`, `deactivated_by` and the reason are
 * stamped on it, and the audit event carries the sentence permanently. Six
 * weeks later somebody asks why the autumn campaign stopped on the 3rd, and
 * "somebody paused it" is not an answer. The reason field costs eight
 * characters now and answers the question forever.
 *
 * There is no resume control here, deliberately. A campaign that was stopped
 * because it exhausted its redemptions must not be restartable with a click —
 * the ceiling was a commitment, and raising it is a decision about money, not
 * a toggle. Running it again is a new campaign, which is also the only way the
 * old one's numbers stay meaningful.
 */

import { useState } from 'react'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import { ActionButton } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors'

import { pausePromotionAction } from '../_lib/actions'

/** The floor the operation enforces. Stated here so the form agrees with it. */
const MIN_REASON = 8

export function PauseCampaign({
  promotionId,
  promotionName,
}: {
  promotionId: string
  promotionName: string
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<SafeErrorBody | null>(null)

  if (!open) {
    return (
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          aria-label={`השהיית המבצע ${promotionName}`}
        >
          השהיית המבצע
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-3">
      <Field
        label="למה המבצע נעצר?"
        description="הנימוק נשמר על המבצע וגם ביומן הפעולות, ולא ניתן לשנות אותו אחר כך."
        required
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="לדוגמה: התפוסה בספטמבר מלאה ואין צורך בהנחה"
        />
      </Field>

      {error !== null && <ActionError error={error} />}

      <div className="flex flex-wrap gap-2">
        <ActionButton
          variant="danger"
          size="sm"
          disabled={reason.trim().length < MIN_REASON}
          pendingLabel="עוצר…"
          onAction={async () => {
            setError(null)
            const result = await pausePromotionAction({
              promotionId,
              reason: reason.trim(),
            })
            if (!result.ok) {
              setError(result.error)
              return
            }
            setOpen(false)
            setReason('')
          }}
        >
          עצירת המבצע
        </ActionButton>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
        >
          ביטול
        </Button>
      </div>
    </div>
  )
}
