'use client'

/**
 * Starting a stocktake.
 *
 * ── Blind is checked, and the checkbox says why ───────────────────────────
 *
 * The default is the argument. A person who unticks it is choosing to show
 * the counter the answer, and the sentence under the box is what they read
 * before doing it — not a warning after the fact and not a policy buried in
 * settings.
 *
 * ── The sheet is the whole property, and that is deliberate ───────────────
 *
 * A partial sheet is a partial count, and the reconciliation cannot tell a
 * cupboard nobody looked at from a cupboard that was empty. Choosing items
 * belongs on a later screen once there is a reason to want it; until then
 * this opens the session over everything the property stocks.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, TextInput } from '@/components/ui/input'

import { openCountSessionAction } from '../_lib/actions'

export interface PropertyChoice {
  id: string
  name: string
}

export function OpenSessionForm({
  properties,
  today,
}: {
  properties: readonly PropertyChoice[]
  today: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '')
  const [label, setLabel] = useState('')
  const [scheduledFor, setScheduledFor] = useState(today)
  const [blind, setBlind] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)

  if (properties.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        אין נכס שאפשר לספור בו. ספירה נפתחת על נכס אחד בכל פעם.
      </p>
    )
  }

  function submit() {
    startTransition(async () => {
      const result = await openCountSessionAction({
        propertyId,
        label: label.trim().length === 0 ? null : label.trim(),
        blind,
        scheduledFor: scheduledFor.length === 0 ? null : scheduledFor,
        taskId: null,
        note: null,
        itemIds: [],
      })

      if (result.ok) {
        setFailure(null)
        router.push(`/inventory/counts/${result.data.sessionId}`)
        return
      }
      setFailure(result.error.message)
    })
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface px-4 py-4 shadow-soft">
      <h2 className="font-display text-lg font-bold text-foreground">
        פתיחת ספירה
      </h2>

      {failure !== null && (
        <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {failure}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="נכס" required>
          <Select
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
          >
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="שם הספירה"
          description="לא חובה. עוזר למצוא אותה בדוח בעוד חצי שנה."
        >
          <TextInput
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="ספירת סוף ספטמבר"
          />
        </Field>

        <Field label="מועד הספירה">
          <TextInput
            type="date"
            value={scheduledFor}
            onChange={(event) => setScheduledFor(event.target.value)}
          />
        </Field>
      </div>

      <Checkbox
        label="ספירה עיוורת"
        description="הסופר לא יראה את הכמות שהמערכת מכירה. זו ברירת המחדל: גיליון שמציג את התשובה מקבל בחזרה את אותה תשובה — אנשים רושמים את המספר שהוצג להם ומפסיקים לספור."
        checked={blind}
        onChange={(event) => setBlind(event.target.checked)}
      />

      <div>
        <Button disabled={pending || propertyId.length === 0} onClick={submit}>
          {pending ? 'פותח…' : 'פתח ספירה'}
        </Button>
      </div>
    </section>
  )
}
