'use client'

/**
 * Step two: the place that is let out.
 *
 * The check-in and check-out times are pre-filled with the column defaults
 * from 0008 — 15:00 and 11:00 — which is not fabrication: they are the
 * database's own stated defaults, they are visible, and they are editable
 * before anything is written. The cancellation policy is deliberately NOT
 * pre-filled. It is the text a guest agrees to, and a paragraph nobody wrote
 * is a term nobody can defend.
 *
 * The policy is stored as prose in `cancellation_policy_text`; the structured
 * `cancellation_policy` jsonb stays empty. Something will eventually compute a
 * refund from that column, and inventing percentages here to fill it would put
 * money on a rule nobody chose.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { createPropertyAction } from '@/app/(app)/onboarding/_lib/actions'
import {
  PROPERTY_FIELD_LABEL,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABEL,
  validateProperty,
  type PropertyDraft,
} from '@/app/(app)/onboarding/_lib/schema'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, Textarea, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { fieldErrorsFrom, fieldErrorsFromIssues } from './field-errors'

export function PropertyStep({
  suggestedType,
}: {
  /** The business type chosen in step one, where it names a kind of place. */
  suggestedType: string
}) {
  const router = useRouter()

  const [name, setName] = useState('')
  const [propertyType, setPropertyType] = useState(suggestedType)
  const [addressLine1, setAddressLine1] = useState('')
  const [city, setCity] = useState('')
  const [checkInTime, setCheckInTime] = useState('15:00')
  const [checkOutTime, setCheckOutTime] = useState('11:00')
  const [cancellationPolicyText, setCancellationPolicyText] = useState('')

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const create = useAsyncAction<void>()

  const draft: PropertyDraft = {
    name,
    propertyType,
    addressLine1,
    city,
    checkInTime,
    checkOutTime,
    cancellationPolicyText,
  }
  const issues = validateProperty(draft)

  const clientErrors = fieldErrorsFromIssues(submitted ? [...issues] : [])
  const serverErrors = fieldErrorsFrom(failure)
  const errorFor = (field: string) => serverErrors[field] ?? clientErrors[field]

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setSubmitted(true)
        setFailure(null)

        if (issues.length > 0 || create.pending) return

        void create.run(async () => {
          const result = await createPropertyAction(draft)
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

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          label={PROPERTY_FIELD_LABEL.name}
          required
          error={errorFor('name')}
        >
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            disabled={create.pending}
          />
        </Field>

        <Field
          label={PROPERTY_FIELD_LABEL.propertyType}
          required
          error={errorFor('propertyType')}
        >
          <Select
            value={propertyType}
            onChange={(event) => setPropertyType(event.target.value)}
            disabled={create.pending}
          >
            {PROPERTY_TYPES.map((type) => (
              <option key={type} value={type}>
                {PROPERTY_TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label={PROPERTY_FIELD_LABEL.addressLine1}
        required
        error={errorFor('addressLine1')}
        description="רחוב ומספר. הכתובת מופיעה על חשבונית ובאישור ההזמנה."
      >
        <TextInput
          value={addressLine1}
          onChange={(event) => setAddressLine1(event.target.value)}
          autoComplete="street-address"
          disabled={create.pending}
        />
      </Field>

      <div className="grid gap-6 sm:grid-cols-3">
        <Field
          label={PROPERTY_FIELD_LABEL.city}
          required
          error={errorFor('city')}
        >
          <TextInput
            value={city}
            onChange={(event) => setCity(event.target.value)}
            autoComplete="address-level2"
            disabled={create.pending}
          />
        </Field>

        <Field
          label={PROPERTY_FIELD_LABEL.checkInTime}
          required
          error={errorFor('checkInTime')}
        >
          <TextInput
            type="time"
            value={checkInTime}
            onChange={(event) => setCheckInTime(event.target.value)}
            dir="ltr"
            disabled={create.pending}
          />
        </Field>

        <Field
          label={PROPERTY_FIELD_LABEL.checkOutTime}
          required
          error={errorFor('checkOutTime')}
        >
          <TextInput
            type="time"
            value={checkOutTime}
            onChange={(event) => setCheckOutTime(event.target.value)}
            dir="ltr"
            disabled={create.pending}
          />
        </Field>
      </div>

      <Field
        label={PROPERTY_FIELD_LABEL.cancellationPolicyText}
        required
        error={errorFor('cancellationPolicyText')}
        description="נסח במילים שלך — זה הטקסט שהאורח מאשר. לדוגמה: כמה ימים לפני ההגעה אפשר לבטל, ומה מוחזר. אנחנו לא ממלאים את זה במקומך."
      >
        <Textarea
          value={cancellationPolicyText}
          onChange={(event) => setCancellationPolicyText(event.target.value)}
          maxLength={2000}
          rows={5}
          disabled={create.pending}
        />
      </Field>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          אפשר לערוך את כל אלה מאוחר יותר במסך הנכס.
        </p>
        <Button type="submit" disabled={create.pending}>
          {create.pending ? 'שומר את הנכס…' : 'שמור את הנכס והמשך'}
        </Button>
      </div>

      <span aria-live="polite" className="sr-only">
        {create.pending ? 'שומר את הנכס' : ''}
      </span>
    </form>
  )
}
