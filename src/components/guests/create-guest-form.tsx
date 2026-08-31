'use client'

/**
 * The quick-create guest card.
 *
 * ── Quick means the name, and nothing else is required ────────────────────
 *
 * `guests` has thirty columns and this form offers eight. That is the design,
 * not an unfinished screen: the person filling it in is usually on the
 * telephone, and every extra required field is a field they will invent a
 * value for. The name is the only thing the table itself insists on
 * (`guests_full_name_not_blank`), and everything else is written only where a
 * value was actually given — see `createGuestAction`, which turns an empty
 * string into `null` rather than storing "we hold an address for this person"
 * when we hold nothing.
 *
 * ── The telephone is the deduplication key, and the form says so ──────────
 *
 * `guests_organization_phone_idx` is a unique index over the generated
 * `phone_e164`, so a second card for the same number is refused by the
 * database. That refusal is a good outcome and it is spelled out here in
 * advance, because "כבר קיים אורח עם המספר הזה" after twenty seconds of typing
 * is a worse experience than being told what the number is for.
 *
 * ── Validation runs twice, on purpose ─────────────────────────────────────
 *
 * `validateGuest` from `_lib/schema.ts` is imported by this component and by
 * the action. The client copy saves a round trip; the server copy is the rule,
 * and the constraints under it are the authority. Every problem is shown at
 * once rather than one at a time — a form that reveals its problems in
 * sequence is a form somebody submits five times.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { createGuestAction } from '@/app/(app)/guests/_lib/actions'
import {
  EMPTY_GUEST_INPUT,
  normalizeTags,
  validateGuest,
  type CreateGuestInput,
} from '@/app/(app)/guests/_lib/schema'
import { ActionError } from '@/components/booking/action-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

/**
 * The languages the desk actually picks from.
 *
 * `guests.language` is free text with no check constraint, so this list is a
 * convenience and not a vocabulary — the column will accept anything, and a
 * guest created by an import may carry a code that is not here. That is why
 * the guest list names a language through `Intl.DisplayNames` rather than
 * through this map: a value off this list must still render.
 */
const LANGUAGES: readonly { code: string; label: string }[] = [
  { code: 'he', label: 'עברית' },
  { code: 'en', label: 'אנגלית' },
  { code: 'ar', label: 'ערבית' },
  { code: 'ru', label: 'רוסית' },
  { code: 'fr', label: 'צרפתית' },
]

export function CreateGuestForm({
  /** Tags already in use, offered so the vocabulary does not fork by typo. */
  knownTags,
}: {
  knownTags: readonly string[]
}) {
  const router = useRouter()

  const [input, setInput] = useState<CreateGuestInput>(EMPTY_GUEST_INPUT)
  const [tagText, setTagText] = useState('')
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [created, setCreated] = useState<{ fullName: string } | null>(null)

  const create = useAsyncAction<void>()

  const tags = normalizeTags(tagText.split(','))
  const draft: CreateGuestInput = { ...input, tags }
  const issues = validateGuest(draft)
  const issueFor = (field: string) =>
    touched ? issues.find((issue) => issue.field === field)?.message : undefined

  const set = <K extends keyof CreateGuestInput>(
    key: K,
    value: CreateGuestInput[K],
  ) => setInput((current) => ({ ...current, [key]: value }))

  // The one success path that does not navigate: `guest.create` and
  // `guest.view` are separate grants, and an external seller holds the first
  // without the second. Sending them to the guest's page would bounce them to
  // the dashboard with a refusal, which is not a success screen.
  if (created) {
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-lg border border-success bg-surface px-4 py-4 text-sm"
      >
        <p className="font-semibold text-success">
          כרטיס האורח ״{created.fullName}״ נוצר.
        </p>
        <p className="text-muted-foreground">
          אין לך הרשאה לצפות בכרטיסי אורח, ולכן אי אפשר לפתוח אותו מכאן. הוא
          קיים במערכת וזמין למי שכן רשאי.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            onClick={() => {
              setCreated(null)
              setInput(EMPTY_GUEST_INPUT)
              setTagText('')
              setTouched(false)
            }}
          >
            צור אורח נוסף
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (issues.length > 0 || create.pending) return

        setFailure(null)
        void create.run(async () => {
          const result = await createGuestAction(draft)

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          if (result.data.mayView) {
            // Straight to the card that was just made. A "saved" toast on the
            // form leaves the person wondering where it went.
            router.push(`/guests/${result.data.id}`)
            return
          }

          setCreated({ fullName: result.data.fullName })
        })
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="שם מלא"
          description="שני תווים לפחות. זה השדה היחיד שחובה למלא."
          required
          error={issueFor('fullName')}
          className="sm:col-span-2"
        >
          <TextInput
            value={input.fullName}
            onChange={(event) => set('fullName', event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field
          label="טלפון"
          description="מספר הטלפון הוא מפתח הזיהוי: לא ייווצרו שני כרטיסים לאותו מספר."
          error={issueFor('phone')}
        >
          <TextInput
            type="tel"
            dir="ltr"
            value={input.phone}
            onChange={(event) => set('phone', event.target.value)}
            placeholder="+972 54-000-0000"
            autoComplete="off"
          />
        </Field>

        <Field label="אימייל" error={issueFor('email')}>
          <TextInput
            type="email"
            dir="ltr"
            value={input.email}
            onChange={(event) => set('email', event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field label="שפה" description="שפת הפנייה לאורח." required>
          <Select
            value={input.language}
            onChange={(event) => set('language', event.target.value)}
          >
            {LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="אזרחות"
          description="קוד מדינה בן שתי אותיות, למשל IL או FR."
          error={issueFor('nationality')}
        >
          <TextInput
            dir="ltr"
            maxLength={2}
            value={input.nationality}
            onChange={(event) =>
              set('nationality', event.target.value.toUpperCase())
            }
            placeholder="IL"
            autoComplete="off"
          />
        </Field>

        <Field label="עיר" className="sm:col-span-2">
          <TextInput
            value={input.city}
            onChange={(event) => set('city', event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field
          label="תגיות"
          description="מופרדות בפסיק. תגית היא מילון עבודה של העסק, לא רשימה סגורה."
          className="sm:col-span-2"
        >
          <TextInput
            value={tagText}
            onChange={(event) => setTagText(event.target.value)}
            placeholder="חוזרת, ירח דבש"
            autoComplete="off"
          />
        </Field>

        {knownTags.length > 0 && (
          <div className="flex flex-col gap-2 sm:col-span-2">
            <p className="text-xs text-muted-foreground">תגיות שכבר בשימוש:</p>
            <div className="flex flex-wrap gap-2">
              {knownTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() =>
                    setTagText((current) =>
                      normalizeTags([...current.split(','), tag]).join(', '),
                    )
                  }
                  className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Badge tone={tags.includes(tag) ? 'brand' : 'neutral'}>
                    {tag}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        )}

        <Field
          label="הערות"
          description="גלויות לכל מי שרשאי לראות את כרטיס האורח."
          className="sm:col-span-2"
        >
          <Textarea
            rows={3}
            value={input.notes}
            onChange={(event) => set('notes', event.target.value)}
          />
        </Field>
      </div>

      {/* ------------------------------------------------------- consent -- */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 p-4 text-sm">
        <Checkbox
          checked={input.marketingConsent}
          onChange={(event) => set('marketingConsent', event.target.checked)}
          label="האורח אישר לקבל פניות שיווקיות"
        />
        <p className="text-xs text-muted-foreground">
          סימון כאן שומר גם את תאריך ההסכמה. הסכמה בלי תאריך היא טענה שאי אפשר
          להגן עליה, ולכן השניים נשמרים יחד או בכלל לא.
        </p>
      </div>

      {failure && <ActionError error={failure} />}

      {touched && issues.length > 0 && (
        <ul
          role="alert"
          className="flex list-inside list-disc flex-col gap-1 rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-danger"
        >
          {issues.map((issue) => (
            <li key={`${issue.field}-${issue.code}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={create.pending}>
          {create.pending ? 'שומר…' : 'צור כרטיס אורח'}
        </Button>
        <Button href="/guests" variant="ghost">
          ביטול
        </Button>

        <span aria-live="polite" className="sr-only">
          {create.pending ? 'שומר את כרטיס האורח' : ''}
        </span>
      </div>
    </form>
  )
}
