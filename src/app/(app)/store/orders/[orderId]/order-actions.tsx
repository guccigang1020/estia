'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. The three things a person does to an
 * order.
 *
 * ── Why approval is an `ActionButton` and not a form ─────────────────────
 *
 * `ActionButton` holds a synchronous ref lock as well as a disabled attribute,
 * because a fast double-click delivers both events before React re-renders and
 * `disabled` alone lets the second through. Approving twice is not merely
 * untidy — it is the path that would create two operational tasks and two
 * requests to the same provider.
 *
 * The idempotency key beneath it is derived from the order, not generated per
 * click, so even a genuine second request replays the first result rather than
 * acting again. Two locks and a key, for one button.
 *
 * ── Why cancelling asks for a reason before it will submit ───────────────
 *
 * `store_orders_cancelled_pair` refuses a cancelled row with no reason, the
 * operation declares `requiresReason`, and this form will not send an empty
 * one. Three statements of the same rule, and the reason they are worth three
 * is that "cancelled by somebody, at some point, for no recorded reason" is
 * the row a refund argument cannot be settled from.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { ActionButton } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'
import type {
  StoreOrderStatus,
  StorePaymentStatus,
} from '@/lib/contracts/states'

import {
  approveOrderAction,
  cancelOrderAction,
  recordPaymentAction,
} from '../../_lib/actions'

const METHODS = [
  { value: 'bank_transfer', label: 'העברה בנקאית' },
  { value: 'bit', label: 'ביט' },
  { value: 'paybox', label: 'פייבוקס' },
  { value: 'cash', label: 'מזומן' },
  { value: 'card', label: 'כרטיס (מסוף חיצוני)' },
  { value: 'other', label: 'אחר' },
] as const

export function OrderActions({
  orderId,
  status,
  paymentStatus,
  totalShekels,
  mayApprove,
  mayRecordPayment,
}: {
  orderId: string
  status: StoreOrderStatus
  paymentStatus: StorePaymentStatus
  /** Pre-filled into the amount box, because it is what usually arrives. */
  totalShekels: string
  mayApprove: boolean
  mayRecordPayment: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<SafeErrorBody | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [amount, setAmount] = useState(totalShekels)
  const [method, setMethod] =
    useState<(typeof METHODS)[number]['value']>('bank_transfer')
  const [reference, setReference] = useState('')
  const [paying, setPaying] = useState(false)

  const [reason, setReason] = useState('')
  const [cancelling, setCancelling] = useState(false)

  const canApprove =
    mayApprove &&
    (status === 'pending' ||
      status === 'awaiting_approval' ||
      status === 'awaiting_payment')

  const canCancel =
    status !== 'cancelled' && status !== 'refunded' && status !== 'completed'

  const canPay = mayRecordPayment && paymentStatus !== 'paid'

  return (
    <div className="flex flex-col gap-6">
      {error && <ActionError error={error} />}
      {note && (
        <p role="status" className="text-sm text-foreground">
          {note}
        </p>
      )}

      {canApprove && (
        <div className="flex flex-col gap-2">
          <ActionButton
            onAction={async () => {
              setError(null)
              setNote(null)
              const result = await approveOrderAction({ orderId })
              if (!result.ok) {
                setError(result.error)
                return
              }
              setNote('ההזמנה אושרה.')
              router.refresh()
            }}
            pendingLabel="מאשר…"
          >
            אישור ההזמנה
          </ActionButton>
          <p className="text-xs text-muted-foreground">
            אחרי האישור המחירים והכמויות נעולים. שינוי נעשה כתיקון עם תיעוד,
            ושינוי שמייקר דורש את הסכמת האורח.
          </p>
        </div>
      )}

      {canPay && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (paying) return
            setPaying(true)
            setError(null)
            setNote(null)

            const result = await recordPaymentAction({
              orderId,
              amountShekels: amount,
              method,
              reference,
            })

            setPaying(false)
            if (!result.ok) {
              setError(result.error)
              return
            }
            setNote('התשלום נרשם.')
            setReference('')
            router.refresh()
          }}
        >
          <p className="text-sm font-semibold text-foreground">רישום תשלום</p>
          <p className="text-xs text-muted-foreground">
            כסף שהגיע מחוץ למערכת — העברה, ביט, פייבוקס, מזומן או מסוף חיצוני.
            רושמים אותו כאן אחרי שראיתם אותו.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="סכום בשקלים">
              <TextInput
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value)
                }}
                inputMode="decimal"
                dir="ltr"
                required
              />
            </Field>

            <Field label="אמצעי">
              <Select
                value={method}
                onChange={(event) => {
                  setMethod(
                    event.target.value as (typeof METHODS)[number]['value'],
                  )
                }}
              >
                {METHODS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="אסמכתה"
              description="מספר העברה או צ׳ק. לא פרטי כרטיס."
            >
              <TextInput
                value={reference}
                onChange={(event) => {
                  setReference(event.target.value)
                }}
                dir="ltr"
                maxLength={120}
              />
            </Field>
          </div>

          <Button
            type="submit"
            variant="secondary"
            disabled={paying}
            className="self-start"
          >
            {paying ? 'רושם…' : 'רישום התשלום'}
          </Button>
        </form>
      )}

      {canCancel && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border p-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (cancelling) return
            if (reason.trim().length < 3) return

            setCancelling(true)
            setError(null)
            setNote(null)

            const result = await cancelOrderAction({
              orderId,
              cancellationReason: reason,
            })

            setCancelling(false)
            if (!result.ok) {
              setError(result.error)
              return
            }
            setNote('ההזמנה בוטלה.')
            router.refresh()
          }}
        >
          <p className="text-sm font-semibold text-foreground">ביטול ההזמנה</p>
          <Field
            label="סיבה"
            description="נרשמת ביומן הפעולות ונשארת על ההזמנה. בלעדיה אי אפשר לבטל."
            required
          >
            <TextInput
              value={reason}
              onChange={(event) => {
                setReason(event.target.value)
              }}
              minLength={3}
              maxLength={500}
              required
            />
          </Field>

          <Button
            type="submit"
            variant="danger"
            disabled={cancelling || reason.trim().length < 3}
            className="self-start"
          >
            {cancelling ? 'מבטל…' : 'ביטול ההזמנה'}
          </Button>
        </form>
      )}
    </div>
  )
}
