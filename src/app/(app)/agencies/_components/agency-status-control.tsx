'use client'

/**
 * Ending the relationship with an agency, and undoing it.
 *
 * ── NOTHING IS DELETED, AND THE DIALOG SAYS SO ────────────────────────────
 *
 * The commissions written under the agreement are still owed, the bookings it
 * produced are still attributed to it, and a report comparing direct against
 * agency sales must still be able to read it. Ending the agreement leaves it
 * `terminated` — which is still *non-draft*, which is what keeps the agency
 * visible to this business under `agencies_my_organizations_work_with()` and
 * keeps the payee of every unpaid commission resolving. 0015 chose non-draft
 * over active for exactly that sentence, and 0070 seals `deleted_at` shut so
 * this can never become a deletion by another route.
 *
 * An owner hesitating over the button because they think it erases money they
 * still owe is an owner who leaves a bad arrangement running. So the dialog
 * says what survives before it asks.
 *
 * ── The global flag is not always this business's to write ────────────────
 *
 * `agencies.status` is global; `agency_agreements.status` is per-business.
 * `deactivate_agency` marks the entity inactive only when this business is its
 * last non-draft counterparty and no agency manager has claimed the record. The
 * server returns which of the two happened and the confirmation repeats it,
 * because the difference matters: one is "we stopped working with them" and the
 * other is "this agency is closed".
 *
 * ── Reactivation exists so this is not a one-way door ─────────────────────
 *
 * Deactivation ends the agreement and nothing else in this screen signs one.
 * Without a way back, a mis-click would permanently prevent this business from
 * working with that agency again.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { fromSafeError } from '@/components/states/error-copy'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { deactivateAgencyAction, reactivateAgencyAction } from '../_lib/actions'

/** What deactivating an agency leaves exactly as it was. */
const PRESERVED = [
  'ההזמנות שהיא הביאה',
  'העמלות שנרשמו לה, כולל אלו שטרם שולמו',
  'הייחוס בדוחות',
  'יומן הביקורת',
] as const

/**
 * Eight characters, matching `agencies_deactivation_reason_meaningful` in 0070
 * and the operation's own floor. Enforced here so the person is asked before
 * the round trip, never instead of it.
 */
const MIN_REASON = 8

export function AgencyStatusControl({
  agencyId,
  agencyName,
  hasLiveAgreement,
  isInactive,
  canReactivate,
}: {
  agencyId: string
  agencyName: string
  hasLiveAgreement: boolean
  isInactive: boolean
  /** A terminated agreement exists to reopen, and no live one is in the way. */
  canReactivate: boolean
}) {
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const [pending, setPending] = useState<'deactivate' | 'reactivate' | null>(
    null,
  )
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const reasonTooShort = reason.trim().length < MIN_REASON

  // Nothing to end and nothing to reopen. A control with no move is not
  // rendered disabled — it is not rendered.
  if (!hasLiveAgreement && !canReactivate) return null

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="נימוק"
        required
        description="נשמר על הרשומה וגם ביומן הביקורת. השני הוא זה שאי אפשר לשנות אחר כך."
        error={
          touched && reasonTooShort
            ? 'נדרש נימוק של שמונה תווים לפחות.'
            : undefined
        }
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
          rows={2}
          placeholder="למשל: הסוכנות הפסיקה למכור אצלנו והחליטה לעבור למתחרה"
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        {hasLiveAgreement && (
          <Button
            size="sm"
            variant="danger"
            disabled={reasonTooShort}
            onClick={() => {
              setTouched(true)
              if (reasonTooShort) return
              setFailure(null)
              setDone(null)
              setPending('deactivate')
            }}
          >
            סיים את ההתקשרות
          </Button>
        )}

        {canReactivate && (
          <Button
            size="sm"
            variant="secondary"
            disabled={reasonTooShort}
            onClick={() => {
              setTouched(true)
              if (reasonTooShort) return
              setFailure(null)
              setDone(null)
              setPending('reactivate')
            }}
          >
            החזר את ההסכם לתוקף
          </Button>
        )}
      </div>

      {failure && <ActionError error={failure} />}

      {done && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          {done}
        </p>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        title={
          pending === 'reactivate'
            ? `החזרת ההסכם עם ${agencyName} לתוקף`
            : `סיום ההתקשרות עם ${agencyName}`
        }
        description={
          pending === 'reactivate' ? (
            <>
              ההסכם האחרון שהסתיים ייפתח מחדש, ללא תאריך סיום. תנאי העמלה חוזרים
              כפי שהיו — אם הם השתנו בינתיים, עדכן אותם אחרי הפתיחה.
            </>
          ) : (
            <>
              ההסכם מסתיים היום והסוכנות מפסיקה למכור עבורך.{' '}
              <strong>לא נמחק דבר:</strong> {PRESERVED.join(', ')} — הכול נשאר
              במלואו, והסוכנות תמשיך להופיע בשמה על כל עמלה שעדיין חייבת לה.
              <br />
              <br />
              אם אף עסק אחר לא עובד איתה ואין לה מנהל משלה, גם הרשומה עצמה תסומן
              כלא פעילה. אם כן — רק ההתקשרות שלך מסתיימת, כי הסטטוס של הסוכנות
              אינו שלך לקבוע עבור אחרים.
            </>
          )
        }
        confirmLabel={
          pending === 'reactivate' ? 'החזר לתוקף' : 'סיים את ההתקשרות'
        }
        cancelLabel="בטל"
        pendingLabel="מעדכן…"
        onConfirm={async () => {
          if (pending === null) return

          const result =
            pending === 'reactivate'
              ? await reactivateAgencyAction({
                  agencyId,
                  reason: reason.trim(),
                })
              : await deactivateAgencyAction({
                  agencyId,
                  reason: reason.trim(),
                })

          if (!result.ok) {
            setFailure(result.error)
            // Rethrown so the dialog stays open and reports it, rather than
            // closing on a failure and looking like it worked.
            throw result.error
          }

          setDone(
            pending === 'reactivate'
              ? 'ההסכם חזר לתוקף.'
              : 'entityMarkedInactive' in result.data &&
                  result.data.entityMarkedInactive
                ? `ההתקשרות הסתיימה והסוכנות סומנה כלא פעילה. העמלות שנרשמו לה עדיין חייבות והיא עדיין מופיעה בשמה עליהן.`
                : `ההתקשרות שלך הסתיימה. הסוכנות עצמה נשארה פעילה — עסק אחר עדיין עובד איתה, או שיש לה מנהל משלה.`,
          )
          setReason('')
          setTouched(false)
          setPending(null)
          router.refresh()
        }}
        toError={(cause) =>
          isSafeErrorBody(cause)
            ? fromSafeError(cause)
            : fromSafeError({
                code: 'internal_error',
                message: 'הפעולה לא הושלמה ואנחנו לא יודעים לסווג את הסיבה.',
                dataMessage:
                  'לא ידוע אם השינוי נשמר. רענן את המסך ובדוק את מצב ההסכם לפני ניסיון נוסף.',
                retryMessage: 'ניסיון חוזר לא יעזור עד שהסיבה תתברר.',
                dataOutcome: 'unknown',
                retryable: false,
                correlationId: '',
              })
        }
      />

      {isInactive && (
        <p className="text-xs text-muted-foreground">
          הסוכנות מסומנת כלא פעילה. זה סטטוס מסחרי ולא מחיקה — הרשומה קיימת,
          העמלות שלה נקראות, ואי אפשר למחוק אותה גם ידנית: מסד הנתונים מסרב
          לכתוב לה מחיקה רכה.
        </p>
      )}
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
