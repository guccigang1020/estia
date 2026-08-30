'use client'

/**
 * Editing the organization the wizard created.
 *
 * The form holds the `version` it was rendered from and sends it back with the
 * save. That is what turns "two tabs open" from a silent lost update into a
 * refusal somebody can act on — and the refusal, when it comes, is the
 * server's own Hebrew sentence about a record that changed underneath, not a
 * second wording invented here.
 *
 * The slug is shown and cannot be edited. The reason is stated on screen
 * rather than left as a disabled control people wonder about.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { updateOrganizationAction } from '@/app/(app)/settings/organization/_lib/actions'
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABEL,
  ORGANIZATION_FIELD_LABEL,
  TIMEZONES,
  validateOrganization,
} from '@/app/(app)/onboarding/_lib/schema'
import { ActionError } from '@/components/booking/action-error'
import {
  fieldErrorsFrom,
  fieldErrorsFromIssues,
} from '@/components/onboarding/field-errors'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

export function OrganizationSettingsForm({
  slug,
  initialName,
  initialBusinessType,
  initialTimezone,
  initialVersion,
}: {
  slug: string
  initialName: string
  initialBusinessType: string
  initialTimezone: string
  initialVersion: number
}) {
  const router = useRouter()

  const [name, setName] = useState(initialName)
  const [businessType, setBusinessType] = useState(initialBusinessType)
  const [timezone, setTimezone] = useState(initialTimezone)
  const [version, setVersion] = useState(initialVersion)

  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const save = useAsyncAction<void>()

  const issues = validateOrganization({
    name,
    slug,
    businessType,
    timezone,
  }).filter((issue) => issue.field !== 'slug')

  const clientErrors = fieldErrorsFromIssues(submitted ? [...issues] : [])
  const serverErrors = fieldErrorsFrom(failure)
  const errorFor = (field: string) => serverErrors[field] ?? clientErrors[field]

  const dirty =
    name !== initialName ||
    businessType !== initialBusinessType ||
    timezone !== initialTimezone

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setSubmitted(true)
        setFailure(null)
        setSaved(false)

        if (issues.length > 0 || save.pending) return

        void save.run(async () => {
          const result = await updateOrganizationAction({
            name,
            businessType,
            timezone,
            version,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          setVersion(result.data.version)
          setSaved(true)
          router.refresh()
        })
      }}
      noValidate
    >
      {failure && <ActionError error={failure} />}

      <Field
        label={ORGANIZATION_FIELD_LABEL.name}
        required
        error={errorFor('name')}
      >
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          disabled={save.pending}
        />
      </Field>

      <Field
        label={ORGANIZATION_FIELD_LABEL.slug}
        description="הכתובת אינה ניתנת לשינוי. היא מופיעה בקישורים שכבר נשלחו, ושינוי שלה היה שובר אותם."
      >
        <TextInput value={slug} dir="ltr" readOnly disabled />
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          label={ORGANIZATION_FIELD_LABEL.businessType}
          required
          error={errorFor('businessType')}
        >
          <Select
            value={businessType}
            onChange={(event) => setBusinessType(event.target.value)}
            disabled={save.pending}
          >
            {BUSINESS_TYPES.map((type) => (
              <option key={type} value={type}>
                {BUSINESS_TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={ORGANIZATION_FIELD_LABEL.timezone}
          required
          error={errorFor('timezone')}
        >
          <Select
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            disabled={save.pending}
          >
            {/* The stored value first, so a zone outside the offered list is
                still selectable and is not silently changed by opening this
                form. */}
            {[...new Set<string>([timezone, ...TIMEZONES])].map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {save.pending
            ? 'שומר…'
            : saved
              ? 'הפרטים נשמרו.'
              : dirty
                ? 'יש שינויים שלא נשמרו.'
                : 'אין שינויים לשמירה.'}
        </p>
        <Button type="submit" disabled={save.pending || !dirty}>
          {save.pending ? 'שומר…' : 'שמור שינויים'}
        </Button>
      </div>
    </form>
  )
}
