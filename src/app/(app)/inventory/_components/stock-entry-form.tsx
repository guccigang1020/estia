'use client'

/**
 * Two ways to get a cupboard into the product, on one screen.
 *
 * ── Why two, and why the second is a textarea ─────────────────────────────
 *
 * A single villa owner with forty-one things in a spreadsheet will not fill in
 * a form forty-one times, and a product that requires it is a product whose
 * stock module is never switched on. So: one at a time for the item somebody
 * just bought, and a spreadsheet-shaped paste for the initial load. The file
 * upload lives on `/inventory/import`, with the template beside it.
 *
 * The paste is deliberately a plain `<textarea>` rather than an editable grid.
 * A grid is a week of work and a pile of accessibility problems; a textarea
 * accepts a paste straight out of Excel — which arrives tab-separated, which
 * is exactly why `parseImport` reads tabs.
 *
 * ── Nothing is written until the plan has been seen ───────────────────────
 *
 * The paste is parsed in the browser and shown as counts and refusals before
 * any request is made. "This adds forty-one items" and "three rows were
 * refused, here is why and on which line" are sentences a person has to be
 * able to read *before* they are true.
 */

import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { parseImport, type ImportRow, type ParseResult } from '@/lib/inventory'

import {
  addInventoryItemAction,
  applyInventoryImportAction,
} from '../_lib/actions'

export interface PropertyChoice {
  id: string
  name: string
}

export function StockEntryForm({
  properties,
  mayImport,
}: {
  properties: readonly PropertyChoice[]
  mayImport: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [plan, setPlan] = useState<ParseResult | null>(null)
  const [target, setTarget] = useState(properties[0]?.id ?? '')

  function report(
    result: { ok: boolean; error?: { message: string } },
    success: string,
  ) {
    if (result.ok) {
      setFailure(null)
      setMessage(success)
      router.refresh()
    } else {
      setMessage(null)
      setFailure(result.error?.message ?? 'הפעולה נכשלה.')
    }
  }

  function submitOne(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const value = (key: string) => String(form.get(key) ?? '').trim()
    const orNull = (key: string) => (value(key).length > 0 ? value(key) : null)
    const numberOrNull = (key: string) =>
      value(key).length > 0 ? Number(value(key)) : null

    // A fresh key per submission, so a double click is one item while a
    // genuine second addition of the same thing stays possible.
    const idempotencyKey = crypto.randomUUID()
    const name = value('name')

    startTransition(async () => {
      const result = await addInventoryItemAction({
        propertyId: value('propertyId'),
        name,
        sku: orNull('sku'),
        category: orNull('category'),
        location: orNull('location'),
        unitOfMeasure: value('unitOfMeasure') || 'יח׳',
        quantity: Number(value('quantity') || '0'),
        minQuantity: numberOrNull('minQuantity'),
        parLevel: numberOrNull('parLevel'),
        unitCostAgorot: numberOrNull('unitCostAgorot'),
        idempotencyKey,
      })
      report(result, `״${name}״ נוסף למלאי.`)
    })
  }

  function preview() {
    setPlan(parseImport(pasted))
    setMessage(null)
    setFailure(null)
  }

  function applyPaste(rows: readonly ImportRow[]) {
    const idempotencyKey = crypto.randomUUID()
    startTransition(async () => {
      const result = await applyInventoryImportAction({
        propertyId: target,
        rows,
        idempotencyKey,
      })
      report(result, `${rows.length} פריטים נוספו.`)
      if (result.ok) {
        setPasted('')
        setPlan(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-8">
      {message !== null && (
        <p
          role="status"
          className="rounded-lg border border-accent bg-surface px-4 py-3 text-sm text-foreground"
        >
          {message}
        </p>
      )}
      {failure !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          {failure}
        </p>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-bold text-foreground">
          פריט אחד
        </h2>
        <form
          onSubmit={submitOne}
          className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-2 sm:p-5"
          aria-label="הוספת פריט מלאי"
        >
          <Field label="נכס" required>
            <Select name="propertyId" defaultValue={target}>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="שם הפריט" required>
            <TextInput name="name" required placeholder="מגבת גוף" />
          </Field>

          <Field label="מק״ט">
            <TextInput name="sku" placeholder="TWL-L" />
          </Field>

          <Field label="קטגוריה">
            <TextInput name="category" placeholder="מגבות" />
          </Field>

          <Field label="מיקום">
            <TextInput name="location" placeholder="מחסן ראשי" />
          </Field>

          <Field
            label="יחידת מידה"
            description="״יח׳״, ״סט״, ״גליל״. המוצר לעולם אינו מניח שהתשובה היא יחידות — מצעים נספרים בסטים ונייר בגלילים."
            required
          >
            <TextInput name="unitOfMeasure" defaultValue="יח׳" required />
          </Field>

          <Field
            label="כמות פתיחה"
            description="נרשמת כתנועת קליטה ביומן ולא כמספר שנכתב לעמודה, כך שגם למספר הראשון יש שורה שמסבירה מאיפה הוא."
          >
            <TextInput name="quantity" type="number" min={0} defaultValue={0} />
          </Field>

          <Field
            label="נקודת הזמנה"
            description="מתחת לזה מזמינים עוד. פריט בלי נקודת הזמנה לעולם לא ידווח כחסר, כי איש לא אמר מה זה מספיק."
          >
            <TextInput name="minQuantity" type="number" min={0} />
          </Field>

          <Field label="רמת יעד">
            <TextInput name="parLevel" type="number" min={0} />
          </Field>

          <Field label="עלות ליחידה באגורות">
            <TextInput name="unitCostAgorot" type="number" min={0} />
          </Field>

          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'מוסיף…' : 'הוסף פריט'}
            </Button>
          </div>
        </form>
      </section>

      {mayImport && (
        <section className="flex flex-col gap-4">
          <h2 className="font-display text-lg font-bold text-foreground">
            הדבקה מגיליון
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            העתק שורות מ־Excel והדבק כאן. השורה הראשונה היא הכותרת, וטאבים
            ופסיקים שניהם עובדים. שום דבר אינו נכתב עד שרואים בדיוק מה ייכנס, מה
            נדחה, ובאיזו שורה.
          </p>

          <Field label="נכס היעד">
            <Select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="שורות">
            <Textarea
              rows={8}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder={'שם\tכמות\tמינימום\nמגבת גוף\t50\t20'}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={preview}
              disabled={pasted.trim().length === 0}
            >
              בדוק מה ייכנס
            </Button>
            {plan !== null && plan.rows.length > 0 && (
              <Button
                type="button"
                onClick={() => applyPaste(plan.rows)}
                disabled={pending}
              >
                {pending ? 'מייבא…' : `הוסף ${plan.rows.length} פריטים`}
              </Button>
            )}
          </div>

          {plan !== null && <ImportPlanSummary plan={plan} />}
        </section>
      )}
    </div>
  )
}

/**
 * What the rows will do, and what was refused.
 *
 * The refusals carry the line number the person's own editor shows and the
 * value as they typed it. A count alone — "38 of 41 imported" — is not an
 * answer to "why did only thirty-eight appear", and it is the answer that
 * makes somebody give up on the import and type it by hand.
 */
export function ImportPlanSummary({ plan }: { plan: ParseResult }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">שורות תקינות</dt>
          <dd className="tabular-nums text-foreground">{plan.rows.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">נדחו</dt>
          <dd className="tabular-nums text-foreground">
            {plan.refused.length}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">עמודות לא מוכרות</dt>
          <dd className="text-foreground">
            {plan.unknownColumns.length === 0
              ? '—'
              : plan.unknownColumns.join(', ')}
          </dd>
        </div>
      </dl>

      {plan.refused.length > 0 && (
        <ul className="flex flex-col gap-2">
          {plan.refused.map((refusal) => (
            <li
              key={`${refusal.lineNumber}:${refusal.code}`}
              className="rounded-lg border border-warning bg-surface px-3 py-2 text-sm"
            >
              <span className="font-semibold text-foreground">
                שורה {refusal.lineNumber}
              </span>
              {refusal.value !== null && (
                <span className="text-muted-foreground">
                  {' '}
                  · ״{refusal.value}״
                </span>
              )}
              <span className="text-muted-foreground">
                {' '}
                — {refusal.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
