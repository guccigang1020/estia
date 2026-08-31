/**
 * The new-property form.
 *
 * A server component, deliberately. Nothing on it changes in response to
 * anything else on it — unlike the invitation form, where the choice of role
 * has to change what the screen says about that role before it is granted — so
 * there is no state to hold and no reason to ship this to the browser. The
 * controls underneath are `'use client'` because `Field` needs `useId` to wire
 * a label to its input; that is their concern, not this file's.
 *
 * ── Every default here is a real default, from somewhere ──────────────────
 *
 * The check-in and check-out times, the minimum stay and the VAT rate are the
 * columns' own defaults in `0008_accommodation.sql`, and the tax rate is the
 * Israeli rate the migration seeds in basis points. Filling a form with
 * plausible-looking numbers that the database would not have chosen is how a
 * business ends up with a property configured differently from every other one
 * it created through the API.
 *
 * ── The submit was disabled, and now is not ───────────────────────────────
 *
 * This form shipped complete with its button switched off and the reason
 * stated on screen: there was no `defineOperation` for creating a property, so
 * the only way to make it work would have been an `insert` from a route
 * handler — identical to a person, and skipping authorization, validation, the
 * domain rule, the transaction, the audit event and idempotency. The audit
 * event was the one that decided it: a property created with no row in
 * `audit_events` is a change nobody can trace, on the very record the audit
 * screen next door presents as evidence.
 *
 * `definePropertyOperations` exists now, so the button works and none of that
 * was traded away.
 *
 * ── Why this became a client component ────────────────────────────────────
 *
 * It was a server component, correctly, while it could not submit: nothing on
 * it changes in response to anything else on it. Submitting needs three things
 * a server component cannot hold — the pending state, the failure to render,
 * and an idempotency key that survives a retry — so it moved. The inputs stay
 * uncontrolled, because mirroring nine fields into React state would buy
 * nothing but a second place for them to disagree with the DOM.
 */

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { createPropertyAction } from '@/app/(app)/properties/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'

export type PropertyTypeChoice = {
  value: string
  label: string
}

export function NewPropertyForm({
  types,
}: {
  types: readonly PropertyTypeChoice[]
}) {
  const router = useRouter()
  const create = useAsyncAction<void>()
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)

  /**
   * One key for this form, kept across retries.
   *
   * The retry after a dropped connection is the case that matters: the person
   * cannot know whether the first attempt reached the database, and pressing
   * again must not create a second property. So it survives a failure on
   * purpose, and is replaced only once something was actually created.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  )

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (create.pending) return

        // Read straight off the form. These inputs are uncontrolled and always
        // were — nothing here changes in response to anything else here, so
        // mirroring nine fields into React state would buy nothing except a
        // second place for them to disagree.
        const data = new FormData(event.currentTarget)
        const text = (field: string) => String(data.get(field) ?? '')

        setFailure(null)
        void create.run(async () => {
          const result = await createPropertyAction({
            name: text('name'),
            slug: text('slug'),
            propertyType: text('propertyType'),
            city: text('city'),
            description: text('description'),
            defaultCheckInTime: text('checkIn'),
            defaultCheckOutTime: text('checkOut'),
            minNights: text('minNights'),
            taxRateBps: text('taxRateBps'),
            idempotencyKey,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          setIdempotencyKey(crypto.randomUUID())
          router.push(`/properties/${result.data.id}`)
        })
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="שם הנכס"
          description="השם שיופיע לאורחים, לצוות ובדוחות."
          required
        >
          <TextInput name="name" autoComplete="off" />
        </Field>

        <Field
          label="מזהה באתר"
          description="אותיות לטיניות ומקפים. משמש בכתובת של עמוד הנכס, וייחודי בארגון."
          required
        >
          <TextInput
            name="slug"
            dir="ltr"
            autoComplete="off"
            placeholder="ahuzat-rimonim"
          />
        </Field>

        <Field label="סוג הנכס" required>
          <Select name="propertyType" defaultValue="zimmer">
            {types.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="עיר" description="הכתובת המלאה נערכת אחר כך, בעמוד הנכס.">
          <TextInput name="city" autoComplete="off" />
        </Field>

        <Field
          label="שעת כניסה"
          description="ברירת המחדל של העמודה במסד הנתונים היא 15:00."
        >
          <TextInput
            name="checkIn"
            type="time"
            dir="ltr"
            defaultValue="15:00"
          />
        </Field>

        <Field label="שעת יציאה" description="ברירת המחדל של העמודה היא 11:00.">
          <TextInput
            name="checkOut"
            type="time"
            dir="ltr"
            defaultValue="11:00"
          />
        </Field>

        <Field label="מינימום לילות" description="אפשר לדרוס אותו ברמת היחידה.">
          <TextInput
            name="minNights"
            type="number"
            min={1}
            defaultValue={1}
            dir="ltr"
          />
        </Field>

        <Field
          label="שיעור מע״מ"
          description="נשמר כנקודות בסיס — 1700 הוא 17%, ולא 17. כך אין עיגול."
        >
          <TextInput
            name="taxRateBps"
            type="number"
            min={0}
            defaultValue={1700}
            dir="ltr"
          />
        </Field>
      </div>

      <Field
        label="תיאור"
        description="נשמר על הנכס. אינו משפיע על תמחור או על זמינות."
      >
        <Textarea name="description" rows={3} />
      </Field>

      {failure ? <ActionError error={failure} /> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={create.pending}>
          {create.pending ? 'יוצר…' : 'יצירת הנכס'}
        </Button>
        <span aria-live="polite" className="sr-only">
          {create.pending ? 'יוצר את הנכס' : ''}
        </span>
      </div>
    </form>
  )
}
