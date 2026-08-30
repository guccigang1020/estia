'use client'

/**
 * Step one: the business itself.
 *
 * ── The slug is the interesting control ───────────────────────────────────
 *
 * It is suggested from the name and stays editable, and it stops following the
 * name the moment somebody types in it — a field that keeps overwriting what
 * you just entered is worse than one that never helped. A Hebrew name
 * suggests nothing at all, which is the honest answer rather than a guessed
 * transliteration, and the description under the control says so instead of
 * leaving the person wondering why the field stayed empty.
 *
 * The availability check is a courtesy and is never treated as permission. It
 * runs on blur, it can be out of date the instant it returns, and
 * `createOrganizationAction` handles the unique-index violation regardless. A
 * green tick here does not let the submit skip anything.
 *
 * ── Two clicks, one organization ──────────────────────────────────────────
 *
 * `useAsyncAction` refuses a second run synchronously — the reducer behind it
 * is unit-tested for exactly that — so the double click never leaves the
 * browser. The server does not rely on that: the unique index on `slug`
 * arbitrates, and the loser is answered with the organization the winner
 * created rather than with an error.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  checkSlugAction,
  createOrganizationAction,
  type SlugAnswer,
} from '@/app/(app)/onboarding/_lib/actions'
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABEL,
  DEFAULT_TIMEZONE,
  FIXED_CURRENCY,
  FIXED_LOCALE,
  ORGANIZATION_FIELD_LABEL,
  TIMEZONES,
  slugify,
  validateOrganization,
  type OrganizationDraft,
} from '@/app/(app)/onboarding/_lib/schema'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { fieldErrorsFrom, fieldErrorsFromIssues } from './field-errors'

export function OrganizationStep() {
  const router = useRouter()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [businessType, setBusinessType] = useState<string>('zimmer')
  const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE)

  const [slugAnswer, setSlugAnswer] = useState<SlugAnswer | null>(null)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const create = useAsyncAction<void>()
  const slugCheck = useAsyncAction<void>()

  const draft: OrganizationDraft = { name, slug, businessType, timezone }
  const issues = validateOrganization(draft)

  // Client issues are shown only after a submit attempt; a form that turns red
  // while you are still typing the first character is a form people distrust.
  const clientErrors = submitted
    ? fieldErrorsFromIssues([...issues])
    : fieldErrorsFromIssues([])
  const serverErrors = fieldErrorsFrom(failure)
  const errorFor = (field: string) => serverErrors[field] ?? clientErrors[field]

  const slugUnavailable =
    slugAnswer !== null && slugAnswer.slug === slug && !slugAnswer.available

  function handleName(value: string) {
    setName(value)
    if (!slugTouched) {
      const suggestion = slugify(value)
      setSlug(suggestion)
      setSlugAnswer(null)
    }
  }

  function handleSlug(value: string) {
    setSlugTouched(true)
    setSlug(value.toLowerCase())
    setSlugAnswer(null)
  }

  async function verifySlug() {
    if (slug.length === 0) return
    if (slugAnswer?.slug === slug) return

    await slugCheck.run(async () => {
      const result = await checkSlugAction(slug)
      if (result.ok) setSlugAnswer(result.data)
    })
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setSubmitted(true)
        setFailure(null)

        if (issues.length > 0 || create.pending) return

        void create.run(async () => {
          const result = await createOrganizationAction(draft)
          if (!result.ok) {
            setFailure(result.error)
            return
          }
          // The step is re-derived on the server from the rows that now exist.
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
        description="השם שיופיע ללקוחות, על חשבוניות ובאישורי הזמנה."
      >
        <TextInput
          value={name}
          onChange={(event) => handleName(event.target.value)}
          autoComplete="organization"
          maxLength={120}
          disabled={create.pending}
        />
      </Field>

      <Field
        label={ORGANIZATION_FIELD_LABEL.slug}
        required
        error={
          errorFor('slug') ?? (slugUnavailable ? slugAnswer.reason! : undefined)
        }
        description="באותיות לטיניות קטנות, ספרות ומקפים. אנחנו מציעים כתובת לפי השם — אפשר לשנות אותה, ולשם בעברית אין הצעה אוטומטית."
      >
        <TextInput
          value={slug}
          onChange={(event) => handleSlug(event.target.value)}
          onBlur={() => void verifySlug()}
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={63}
          disabled={create.pending}
        />
      </Field>

      <p
        aria-live="polite"
        className="-mt-3 text-xs text-muted-foreground"
        dir="rtl"
      >
        {slugCheck.pending && 'בודק את הכתובת…'}
        {!slugCheck.pending &&
          slugAnswer !== null &&
          slugAnswer.slug === slug &&
          (slugAnswer.available
            ? 'הכתובת פנויה.'
            : (slugAnswer.reason ?? 'הכתובת אינה זמינה.'))}
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          label={ORGANIZATION_FIELD_LABEL.businessType}
          required
          error={errorFor('businessType')}
        >
          <Select
            value={businessType}
            onChange={(event) => setBusinessType(event.target.value)}
            disabled={create.pending}
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
          description="כל שעה במערכת — כניסה, יציאה, דוחות — נקראת לפי אזור הזמן הזה."
        >
          <Select
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            disabled={create.pending}
          >
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Stated, not offered. Every price in the schema is agorot and every
          screen is Hebrew; a chooser here would write a setting nothing
          downstream honours. */}
      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">מטבע</dt>
          <dd className="font-medium text-foreground" dir="ltr">
            {FIXED_CURRENCY}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs text-muted-foreground">שפה ואזור</dt>
          <dd className="font-medium text-foreground" dir="ltr">
            {FIXED_LOCALE}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          יצירת העסק כוללת גם את החברות שלך כבעלים ואת המנוי — הכול יחד.
        </p>
        <Button type="submit" disabled={create.pending}>
          {create.pending ? 'יוצר את העסק…' : 'צור את העסק והמשך'}
        </Button>
      </div>

      <span aria-live="polite" className="sr-only">
        {create.pending ? 'יוצר את העסק' : ''}
      </span>
    </form>
  )
}
