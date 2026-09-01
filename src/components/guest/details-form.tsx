'use client'

/**
 * The details the operator asked for, and only those.
 *
 * ── Collect only what was asked for ───────────────────────────────────────
 *
 * The fields rendered here are `requiredDetailFields` and
 * `optionalDetailFields` from the business's own settings. There is no default
 * set, no "while we have you" extras, and no field this component adds on its
 * own — a form that asks a guest for a passport number the business never
 * wanted is a form that collects a passport number nobody is accountable for.
 *
 * ── The closed list is a security boundary, not tidiness ──────────────────
 *
 * `GUEST_DETAIL_FIELDS` is the only set of keys that will render or be sent,
 * and `saveDetails` filters against it again before the RPC. The form is filled
 * in by somebody with no account; an open key space would let a crafted
 * submission write an arbitrary name into a jsonb column that a staff screen
 * later renders. The database caps the payload's size, this caps its shape,
 * and both halves are needed.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * `booking_guest_details` is keyed on the booking, so the write is an upsert
 * and a double submission is one row. `submitted_at` is coalesced rather than
 * overwritten: a guest correcting a telephone number after completing the form
 * has not withdrawn the form.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { saveDetailsAction } from '@/app/g/[token]/_lib/actions'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput, Textarea } from '@/components/ui/input'
import {
  GUEST_DETAIL_FIELD_KIND,
  GUEST_DETAIL_FIELD_LABEL,
  type GuestDetailField,
} from '@/lib/guest-journey/types'

/** `type` on the control, so a telephone shows the right keyboard. */
const INPUT_TYPE: Record<string, string> = {
  text: 'text',
  tel: 'tel',
  email: 'email',
  time: 'time',
}

export function DetailsForm({
  token,
  required,
  optional,
  initial,
}: {
  token: string
  required: readonly GuestDetailField[]
  optional: readonly GuestDetailField[]
  initial: Partial<Record<GuestDetailField, string>>
}) {
  const router = useRouter()
  const { pending, run } = useAsyncAction()
  const [values, setValues] = useState<Record<string, string>>({ ...initial })
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [problem, setProblem] = useState<string | null>(null)

  const set = (field: GuestDetailField, value: string) =>
    setValues((current) => ({ ...current, [field]: value }))

  function renderField(field: GuestDetailField, isRequired: boolean) {
    const kind = GUEST_DETAIL_FIELD_KIND[field]
    const value = values[field] ?? ''

    return (
      <Field
        key={field}
        label={GUEST_DETAIL_FIELD_LABEL[field]}
        required={isRequired}
        error={missing.has(field) ? 'שדה חובה.' : undefined}
      >
        {kind === 'multiline' ? (
          <Textarea
            value={value}
            rows={3}
            onChange={(event) => set(field, event.target.value)}
          />
        ) : (
          <TextInput
            type={INPUT_TYPE[kind] ?? 'text'}
            value={value}
            // A telephone that opens the numeric pad for an id number saves a
            // guest three taps and a mistake.
            inputMode={
              field === 'id_number' || field === 'phone' ? 'numeric' : undefined
            }
            onChange={(event) => set(field, event.target.value)}
          />
        )}
      </Field>
    )
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return

        const blank = new Set(
          required.filter((field) => (values[field] ?? '').trim().length === 0),
        )
        setMissing(blank)
        // Every missing field is reported at once. A form that reveals its
        // problems one at a time is a form somebody submits four times.
        if (blank.size > 0) return

        setProblem(null)

        void run(async () => {
          const payload: Partial<Record<GuestDetailField, string>> = {}
          for (const field of [...required, ...optional]) {
            const value = (values[field] ?? '').trim()
            if (value.length > 0) payload[field] = value
          }

          const result = await saveDetailsAction(token, payload)
          if (result.ok) {
            router.refresh()
            return
          }
          setProblem(result.error.message)
        })
      }}
    >
      {required.map((field) => renderField(field, true))}

      {optional.length > 0 && (
        <>
          <p className="text-sm font-medium text-muted-foreground">
            לא חובה, אבל עוזר לנו להתכונן
          </p>
          {optional.map((field) => renderField(field, false))}
        </>
      )}

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? 'שומר…' : 'שמירת הפרטים'}
      </Button>

      {problem && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
        >
          {problem}
        </p>
      )}
    </form>
  )
}
