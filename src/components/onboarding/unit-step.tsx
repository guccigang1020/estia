'use client'

/**
 * Step three: the first thing that can actually be sold.
 *
 * ── Money is typed in shekels and stored in agorot ────────────────────────
 *
 * The two inputs here are the only place in the wizard where a person types
 * money, and the conversion happens in `shekelsToAgorot` — on the string, by
 * splitting on the decimal point, never as `value * 100`. `139.90 * 100` is
 * 13989.999999999998 in IEEE 754, and a product that rounds that once has a
 * price nobody can reconcile. The preview under each field shows exactly what
 * will be stored, so the conversion is visible rather than trusted.
 *
 * ── The unit is created ACTIVE ────────────────────────────────────────────
 *
 * `units.status` defaults to `draft`, and a draft unit cannot be sold: the
 * availability engine refuses any unit whose status is not `active`, by
 * design. A wizard whose last step produced something unbookable would have
 * ended with the same empty calendar it set out to fix.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { createFirstUnitAction } from '@/app/(app)/onboarding/_lib/actions'
import {
  UNIT_FIELD_LABEL,
  UNIT_TYPES,
  UNIT_TYPE_LABEL,
  shekelsToAgorot,
  validateUnit,
  type UnitDraft,
} from '@/app/(app)/onboarding/_lib/schema'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { fieldErrorsFrom, fieldErrorsFromIssues } from './field-errors'

export function UnitStep({
  propertyId,
  propertyName,
}: {
  propertyId: string
  propertyName: string | null
}) {
  const router = useRouter()

  const [name, setName] = useState('')
  const [unitType, setUnitType] = useState<string>('cabin')
  const [capacity, setCapacity] = useState('2')
  const [bedrooms, setBedrooms] = useState('1')
  const [bathrooms, setBathrooms] = useState('1')
  const [basePrice, setBasePrice] = useState('')
  const [deposit, setDeposit] = useState('0')

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const create = useAsyncAction<void>()

  const draft: UnitDraft = {
    name,
    unitType,
    capacity,
    bedrooms,
    bathrooms,
    basePrice,
    deposit,
  }
  const issues = validateUnit(draft)

  const clientErrors = fieldErrorsFromIssues(submitted ? [...issues] : [])
  const serverErrors = fieldErrorsFrom(failure)
  const errorFor = (field: string) => serverErrors[field] ?? clientErrors[field]

  const basePriceAgorot = shekelsToAgorot(basePrice)
  const depositAgorot = shekelsToAgorot(deposit)

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setSubmitted(true)
        setFailure(null)

        if (issues.length > 0 || create.pending) return

        void create.run(async () => {
          const result = await createFirstUnitAction(propertyId, draft)
          if (!result.ok) {
            setFailure(result.error)
            return
          }
          router.refresh()
        })
      }}
      noValidate
    >
      {failure && <ActionError error={failure} />}

      {propertyName && (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          היחידה תיווצר בתוך הנכס{' '}
          <span className="font-medium text-foreground">{propertyName}</span>,
          ותירש ממנו את שעות הכניסה והיציאה.
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label={UNIT_FIELD_LABEL.name} required error={errorFor('name')}>
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            disabled={create.pending}
          />
        </Field>

        <Field
          label={UNIT_FIELD_LABEL.unitType}
          required
          error={errorFor('unitType')}
        >
          <Select
            value={unitType}
            onChange={(event) => setUnitType(event.target.value)}
            disabled={create.pending}
          >
            {UNIT_TYPES.map((type) => (
              <option key={type} value={type}>
                {UNIT_TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <Field
          label={UNIT_FIELD_LABEL.capacity}
          required
          error={errorFor('capacity')}
          description="מספר האורחים המרבי."
        >
          <TextInput
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
            inputMode="numeric"
            dir="ltr"
            disabled={create.pending}
          />
        </Field>

        <Field
          label={UNIT_FIELD_LABEL.bedrooms}
          required
          error={errorFor('bedrooms')}
          description="סטודיו הוא 0."
        >
          <TextInput
            value={bedrooms}
            onChange={(event) => setBedrooms(event.target.value)}
            inputMode="numeric"
            dir="ltr"
            disabled={create.pending}
          />
        </Field>

        <Field
          label={UNIT_FIELD_LABEL.bathrooms}
          required
          error={errorFor('bathrooms')}
          description="אפשר חצי, למשל 1.5."
        >
          <TextInput
            value={bathrooms}
            onChange={(event) => setBathrooms(event.target.value)}
            inputMode="decimal"
            dir="ltr"
            disabled={create.pending}
          />
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          label={UNIT_FIELD_LABEL.basePrice}
          required
          error={errorFor('basePrice')}
          description="בשקלים, לפני מע״מ. זו נקודת המוצא להצעת מחיר, לא מחיר סופי של שהות."
        >
          <TextInput
            value={basePrice}
            onChange={(event) => setBasePrice(event.target.value)}
            inputMode="decimal"
            dir="ltr"
            placeholder="0.00"
            disabled={create.pending}
          />
        </Field>

        <Field
          label={UNIT_FIELD_LABEL.deposit}
          required
          error={errorFor('deposit')}
          description="פיקדון מוחזק ומוחזר, ואינו הכנסה. אם אינך גובה — 0."
        >
          <TextInput
            value={deposit}
            onChange={(event) => setDeposit(event.target.value)}
            inputMode="decimal"
            dir="ltr"
            disabled={create.pending}
          />
        </Field>
      </div>

      {/* The conversion, shown rather than trusted. */}
      <p className="text-xs text-muted-foreground">
        ייחסך במסד הנתונים באגורות:{' '}
        <span dir="ltr" className="font-mono">
          {basePriceAgorot === null ? '—' : basePriceAgorot}
        </span>{' '}
        ללילה, פיקדון{' '}
        <span dir="ltr" className="font-mono">
          {depositAgorot === null ? '—' : depositAgorot}
        </span>
        .
      </p>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          היחידה נוצרת במצב ״פעילה״, כדי שאפשר יהיה להזמין אותה מיד.
        </p>
        <Button type="submit" disabled={create.pending}>
          {create.pending ? 'שומר את היחידה…' : 'שמור את היחידה וסיים'}
        </Button>
      </div>

      <span aria-live="polite" className="sr-only">
        {create.pending ? 'שומר את היחידה' : ''}
      </span>
    </form>
  )
}
