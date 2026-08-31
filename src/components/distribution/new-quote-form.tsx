'use client'

/**
 * The quick-create quote: pick a unit, pick dates, get a price.
 *
 * ── What it produces, and what it does not ────────────────────────────────
 *
 * A price and, optionally, a hold. There is no quote document to create,
 * because there is no `quotes` table — the screen above this form says so, and
 * this form does not quietly imply otherwise by calling its button "שמור". The
 * button says "חשב הצעה", because that is what happens.
 *
 * ── Every number comes back from the server ───────────────────────────────
 *
 * Nothing here multiplies a rate by a night count. The action reads the unit's
 * stored rates, hands them to `priceStay`, and returns the lines; this renders
 * them through `QuoteBreakdown`, which is the same component the availability
 * screen uses and which adds nothing up either. A price computed in the browser
 * is a price a customer can change with the developer tools.
 *
 * ── The idempotency key is per form instance ──────────────────────────────
 *
 * Generated once with `useRef` rather than per submit, so a double click
 * replays the first answer instead of placing a second hold on the same nights.
 * It is regenerated only when the form is genuinely reset for a new quote —
 * otherwise the second quote of the day would replay the first one's hold.
 *
 * ── Availability is shown as of a moment ago ──────────────────────────────
 *
 * The answer is a courtesy and the copy says so. The authoritative check runs
 * inside the transaction that writes the hold, which is what turns a lost race
 * into a refusal rather than into two sellers holding the same night.
 */

import { useRef, useState, type FormEvent } from 'react'

import {
  createQuoteAction,
  type QuoteAnswer,
} from '@/app/(app)/quotes/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { QuoteBreakdown } from '@/components/calendar/quote-breakdown'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, TextInput } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

export type QuotableUnitOption = {
  id: string
  label: string
  propertyName: string
  maxGuests: number
}

export function NewQuoteForm({
  units,
  /** False at the `availability_price` rung: quoting without holding. */
  mayHold,
  /** The agent's own default, from their stored limits. Never invented. */
  defaultHoldMinutes,
}: {
  units: readonly QuotableUnitOption[]
  mayHold: boolean
  defaultHoldMinutes: number | null
}) {
  const idempotencyKey = useRef(crypto.randomUUID())
  const [pending, setPending] = useState(false)
  const [answer, setAnswer] = useState<QuoteAnswer | null>(null)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)

    setPending(true)
    setFailure(null)
    setAnswer(null)

    const result = await createQuoteAction({
      unitId: String(form.get('unitId') ?? ''),
      checkIn: String(form.get('checkIn') ?? ''),
      checkOut: String(form.get('checkOut') ?? ''),
      guests: Number(form.get('guests') ?? 2),
      hold: form.get('hold') === 'on',
      ...(defaultHoldMinutes !== null
        ? { holdMinutes: Number(form.get('holdMinutes') ?? defaultHoldMinutes) }
        : {}),
      idempotencyKey: idempotencyKey.current,
    })

    setPending(false)

    if (!result.ok) {
      setFailure(result.error)
      return
    }

    setAnswer(result.data)
    // A hold was written, so the key has been spent: a further submission of
    // this form is a new offer and must not replay the one just placed.
    if (result.data.holdId !== null)
      idempotencyKey.current = crypto.randomUUID()
  }

  if (units.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        אין יחידות בטווח שלך שאפשר להוציא עליהן הצעה. אם זו טעות, מנהל בארגון
        יכול להרחיב את טווח המלאי שלך.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="יחידה" required>
            <Select name="unitId" defaultValue={units[0].id} required>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.label} — {unit.propertyName} (עד {unit.maxGuests}{' '}
                  אורחים)
                </option>
              ))}
            </Select>
          </Field>

          <Field label="מספר אורחים" required>
            <TextInput
              name="guests"
              type="number"
              min={1}
              defaultValue={2}
              required
            />
          </Field>

          <Field label="תאריך הגעה" required>
            <TextInput name="checkIn" type="date" required />
          </Field>

          <Field label="תאריך עזיבה" required>
            <TextInput name="checkOut" type="date" required />
          </Field>
        </div>

        {mayHold ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-4">
            <Checkbox
              name="hold"
              defaultChecked
              label="תפוס את התאריכים בזמן שהלקוח מחליט"
              description="שריון מוריד את היחידה מהמכירה עד שהוא פג או משוחרר, כדי שהיא לא תימכר מתחת להצעה. הוא פג מעצמו — אין צורך לזכור לשחרר אותו."
            />
            {defaultHoldMinutes !== null && (
              <Field label="למשך (דקות)">
                <TextInput
                  name="holdMinutes"
                  type="number"
                  min={1}
                  defaultValue={defaultHoldMinutes}
                />
              </Field>
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-xs text-muted-foreground">
            אינך רשאי לתפוס תאריכים, ולכן ההצעה תחשב מחיר בלבד. התאריכים נשארים
            פתוחים למכירה.
          </p>
        )}

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'מחשב…' : 'חשב הצעה'}
          </Button>
        </div>
      </form>

      {failure && <ActionError error={failure} />}

      {answer && <Answer answer={answer} />}
    </div>
  )
}

/* -------------------------------------------------------------- answer -- */

function Answer({ answer }: { answer: QuoteAnswer }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-bold text-foreground">
          {answer.unitLabel}
        </h2>
        <p className="text-sm text-muted-foreground">
          {answer.nights === 1 ? 'לילה אחד' : `${answer.nights} לילות`}
        </p>
      </div>

      {/* Capacity is stated separately from availability, because they are two
          different facts: a unit can be free and too small, and reporting that
          as "unavailable" sends the seller looking for other dates instead of
          for a bigger unit. */}
      {!answer.fits && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          מספר האורחים גדול מהתפוסה של היחידה. המחיר מחושב, אבל היחידה לא מתאימה
          לקבוצה הזו.
        </p>
      )}

      {answer.available ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          התאריכים היו פנויים לפני רגע. זו בדיקה ולא הבטחה — היחידה יכולה להימכר
          בשנייה שאחריה, ולכן הבדיקה המחייבת רצה שוב ברגע שההזמנה או השריון
          נכתבים.
        </p>
      ) : (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-danger bg-surface px-4 py-3 text-sm"
        >
          <p className="font-semibold text-danger">
            התאריכים אינם פנויים ביחידה הזו.
          </p>
          <ul className="flex flex-col gap-1 text-foreground">
            {answer.blockers.map((blocker, index) => (
              <li key={`${blocker.kind}-${index}`}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      )}

      <QuoteBreakdown
        lines={answer.lines}
        totalAgorot={answer.totalAgorot}
        stayTotalAgorot={answer.stayTotalAgorot}
        depositAgorot={answer.depositAgorot}
        taxAgorot={answer.taxAgorot}
        taxIncludedAgorot={answer.taxIncludedAgorot}
      />

      {answer.holdId !== null && answer.holdExpiresAt !== null && (
        <p
          role="status"
          className="rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
        >
          התאריכים תפוסים עד{' '}
          {new Date(answer.holdExpiresAt).toLocaleString('he-IL', {
            timeZone: 'Asia/Jerusalem',
            dateStyle: 'short',
            timeStyle: 'short',
          })}
          . אחרי זה הם חוזרים למכירה מעצמם.
        </p>
      )}

      {answer.holdRefused && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          ביקשת לתפוס את התאריכים, ואין לך הרשאה לכך. המחיר מעל תקף; התאריכים
          נשארו פתוחים למכירה.
        </p>
      )}

      {answer.holdId === null && !answer.holdRefused && answer.available && (
        <p className="text-xs text-muted-foreground">
          לא נתפסו תאריכים. היחידה נשארת פתוחה למכירה, וההצעה עלולה להתייתר אם
          מישהו אחר יזמין אותה.
        </p>
      )}
    </section>
  )
}
