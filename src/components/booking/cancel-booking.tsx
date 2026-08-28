'use client'

/**
 * Cancelling a booking.
 *
 * Its own control and its own operation rather than one more entry in the
 * status list, because `booking.change_status` explicitly refuses
 * `cancelled` — cancellation demands a stated reason, and letting it through
 * the generic door would be a way to cancel a stay without ever saying why.
 * `booking.cancel` declares `requiresReason: true`, so the server refuses a
 * blank one regardless of what this form does; the field here is so the person
 * is asked before the round trip rather than after it.
 *
 * The reason is collected in a plain field above the dialog rather than
 * through `ConfirmDialog`'s `requiredPhrase`, which asks the user to *retype a
 * name*. That mechanism is for proving intent on a destructive action; this
 * needs a sentence somebody will read six months later in a dispute, and the
 * two are not the same demand.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { cancelBookingAction } from '@/app/(app)/bookings/_lib/actions'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import { fromSafeError } from '@/components/states/error-copy'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { ActionError } from './action-error'

export function CancelBooking({
  bookingId,
  version,
  guestName,
  reference,
}: {
  bookingId: string
  version: number
  guestName: string
  reference: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [touched, setTouched] = useState(false)

  const reasonMissing = reason.trim().length === 0

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="סיבת הביטול"
        description="נשמרת ביומן הביקורת ומופיעה בכל בירור עתידי על ההזמנה הזו. אי אפשר לבטל בלעדיה."
        required
        error={
          touched && reasonMissing ? 'ביטול הזמנה מחייב ציון סיבה.' : undefined
        }
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
          rows={3}
          placeholder="למשל: האורח ביטל טלפונית, הוצע מועד חלופי"
        />
      </Field>

      <div>
        <Button
          variant="danger"
          disabled={reasonMissing}
          onClick={() => {
            setTouched(true)
            if (reasonMissing) return
            setFailure(null)
            setOpen(true)
          }}
        >
          בטל את ההזמנה
        </Button>
      </div>

      {failure && <ActionError error={failure} />}

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="ביטול הזמנה"
        description={
          <>
            הזמנה{' '}
            <span dir="ltr" className="font-mono">
              {reference}
            </span>{' '}
            של {guestName} תעבור למצב ״בוטלה״. המצב הזה סופי — אי אפשר להחזיר את
            ההזמנה ממנו, והתאריכים ישתחררו למכירה מיד.
          </>
        }
        confirmLabel="בטל את ההזמנה"
        cancelLabel="השאר את ההזמנה"
        pendingLabel="מבטל…"
        // `ConfirmDialog` already refuses a second confirm while the first is
        // running; this is the failure path, not the concurrency one.
        onConfirm={async () => {
          const result = await cancelBookingAction({
            bookingId,
            version,
            reason: reason.trim(),
          })

          if (!result.ok) {
            setFailure(result.error)
            // Rethrown so the dialog stays open and reports it, rather than
            // closing on a failure and looking like it worked.
            throw result.error
          }

          router.refresh()
        }}
        toError={(cause) =>
          // The server already decided the Hebrew wording; adopt it rather
          // than classifying the same failure a second time here.
          isSafeErrorBody(cause)
            ? fromSafeError(cause)
            : fromSafeError({
                code: 'internal_error',
                message: 'הביטול לא הושלם ואנחנו לא יודעים לסווג את הסיבה.',
                dataMessage:
                  'לא ידוע אם הביטול נשמר. פתח את ההזמנה ובדוק לפני ניסיון נוסף.',
                retryMessage: 'ניסיון חוזר לא יעזור עד שהסיבה תתברר.',
                dataOutcome: 'unknown',
                retryable: false,
                correlationId: '',
              })
        }
      />
    </div>
  )
}

function isSafeErrorBody(value: unknown): value is SafeErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'dataOutcome' in value
  )
}
