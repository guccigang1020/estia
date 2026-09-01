'use client'

/**
 * A correction, recorded as a movement.
 *
 * ── There is no "set the quantity to 32" here, and there never will be ────
 *
 * 0011 derives `inventory_items.quantity` from the ledger by trigger, because
 * a count somebody can overwrite is a count that silently disagrees with the
 * movements that produced it. So this form asks for a *delta* and a *reason*,
 * and "we thought we had forty and we have thirty-two" stays in the record as
 * a minus eight with a sentence attached rather than vanishing into a new
 * number.
 *
 * The kind matters as much as the delta. A count that came back low because a
 * guest took three towels (`loss`) and one that came back low because somebody
 * miscounted (`count`) are the same arithmetic and different facts, and a
 * report that merges them cannot show a property losing linen at a steady rate.
 *
 * ── The reason is required and the form says why ──────────────────────────
 *
 * Not validation theatre. A correction without a sentence is a number nobody
 * can explain two months later, which is precisely when somebody asks.
 */

import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

import { MOVEMENT_KIND_LABEL } from '@/components/operations/inventory-state'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import type { InventoryMovementKind } from '@/app/(app)/inventory/_lib/queries'

import { recordAdjustmentAction } from '../_lib/actions'

export interface AdjustableItem {
  itemId: string
  label: string
  propertyId: string
  onHandClean: number
  unitOfMeasure: string
}

/**
 * The kinds a person may choose here.
 *
 * `transfer` and `return` are absent on purpose: both are produced by other
 * paths — a transfer by the approval flow, a return by the laundry coming
 * back — and offering them on a free-form correction screen would let somebody
 * write a movement that no decision stands behind.
 */
const KINDS: readonly InventoryMovementKind[] = [
  'count',
  'adjustment',
  'receipt',
  'issue',
  'loss',
]

export function AdjustmentForm({
  items,
}: {
  items: readonly AdjustableItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [itemId, setItemId] = useState(items[0]?.itemId ?? '')

  const selected = items.find((item) => item.itemId === itemId) ?? items[0]

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (selected === undefined) return

    const form = new FormData(event.currentTarget)
    const delta = Number(String(form.get('quantityDelta') ?? '0'))
    const reason = String(form.get('reason') ?? '').trim()
    const kind = String(form.get('kind') ?? 'count') as InventoryMovementKind

    startTransition(async () => {
      const result = await recordAdjustmentAction({
        itemId: selected.itemId,
        propertyId: selected.propertyId,
        kind,
        quantityDelta: delta,
        // The state is left alone by a correction. A miscount does not move
        // linen from the cupboard to the laundry; it changes how many are in
        // the cupboard.
        toState: null,
        reason,
        idempotencyKey: crypto.randomUUID(),
      })

      if (result.ok) {
        setFailure(null)
        setMessage(
          `נרשמה תנועה של ${delta > 0 ? '+' : ''}${delta} עבור ״${selected.label}״.`,
        )
        router.refresh()
      } else {
        setMessage(null)
        setFailure(result.error.message)
      }
    })
  }

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        אין פריטים בטווח שלך לתקן.
      </p>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-2 sm:p-5"
      aria-label="רישום תנועת מלאי"
    >
      {message !== null && (
        <p
          role="status"
          className="rounded-lg border border-accent bg-surface px-4 py-3 text-sm text-foreground sm:col-span-2"
        >
          {message}
        </p>
      )}
      {failure !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground sm:col-span-2"
        >
          {failure}
        </p>
      )}

      <Field label="פריט" required>
        <Select
          name="itemId"
          value={itemId}
          onChange={(event) => setItemId(event.target.value)}
        >
          {items.map((item) => (
            <option key={item.itemId} value={item.itemId}>
              {item.label} ({item.onHandClean} {item.unitOfMeasure})
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="סוג התנועה"
        description="״ספירה״ ו״אובדן״ הן אותו חשבון ושתי עובדות שונות. דוח שממזג אותן אינו יכול להראות נכס שמאבד מצעים בקצב קבוע."
        required
      >
        <Select name="kind" defaultValue="count">
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {MOVEMENT_KIND_LABEL[kind]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="שינוי בכמות"
        description="חתום. מינוס מוריד מהמלאי. אין כאן ״קבע את הכמות ל־32״ ולא יהיה: כמות שאפשר לכתוב עליה היא כמות שמתווכחת עם היומן שיצר אותה."
        required
      >
        <TextInput
          name="quantityDelta"
          type="number"
          required
          placeholder="-8"
        />
      </Field>

      <Field
        label="נימוק"
        description="תיקון בלי נימוק הוא מספר שאיש לא יוכל להסביר בעוד חודשיים, וזה בדיוק המועד שבו שואלים."
        required
      >
        <Textarea name="reason" rows={2} required />
      </Field>

      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'רושם…' : 'רשום תנועה'}
        </Button>
      </div>
    </form>
  )
}
