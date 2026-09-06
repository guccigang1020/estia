'use client'

/**
 * The agency's own details: who they are and how to reach them.
 *
 * One component for both jobs, because they are the same eight fields and a
 * second copy would drift. `mode: 'create'` also collects the opening
 * commercial terms, since an agency and the first agreement with it are created
 * together — see `0070_agencies_write_path.sql` for why that is not optional.
 *
 * ── THIS FORM HOLDS PERSONAL DATA, AND IT SAYS SO ─────────────────────────
 *
 * `docs/PERSONAL_DATA_INVENTORY.md` lists `agencies` as holding
 * כתובת · דוא״ל · טלפון. This form adds no field that is not already in that
 * inventory, and it asks for none of them: the four contact fields are optional
 * and the note beneath them says what they are for, because an address typed in
 * "just in case" is personal data the business will one day have to answer for.
 * The only required field is the name.
 *
 * ── Editing belongs to the agency once the agency turns up ────────────────
 *
 * `agencies_update` passes for a manager of the agency, or — while nobody from
 * the agency manages the record — for a business holding `agency.manage` that
 * has signed with it. So this form is shown only for an unclaimed record, and
 * when it is hidden the screen says why rather than leaving a reader to wonder
 * where the button went.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { COMMISSION_BASE_LABEL } from '@/lib/contracts/states'
import type { CommissionBase } from '@/lib/contracts/states'

import { createAgencyAction, editAgencyContactAction } from '../_lib/actions'
import { DEFAULT_ELIGIBILITY, TERMS_BASES } from './terms-vocabulary'

export type ContactValues = {
  name: string
  taxId: string
  contactPhone: string
  contactEmail: string
  addressLine1: string
  city: string
  country: string
  note: string
}

const EMPTY: ContactValues = {
  name: '',
  taxId: '',
  contactPhone: '',
  contactEmail: '',
  addressLine1: '',
  city: '',
  country: 'IL',
  note: '',
}

/** A blank field clears the column. The form always submits the whole block. */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

export function AgencyContactForm(
  props:
    | { mode: 'create' }
    | {
        mode: 'edit'
        agencyId: string
        version: number
        initial: ContactValues
      },
) {
  const router = useRouter()
  const [values, setValues] = useState<ContactValues>(
    props.mode === 'edit' ? props.initial : EMPTY,
  )
  // Create-only: the opening agreement. An agency cannot exist without one.
  const [percent, setPercent] = useState('10')
  const [base, setBase] = useState<CommissionBase>('stay_total')
  const [paymentTermsDays, setPaymentTermsDays] = useState('30')

  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const set = (key: keyof ContactValues) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }))

  const nameMissing = values.name.trim().length < 2

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (nameMissing || busy) return

    setBusy(true)
    setFailure(null)
    setDone(null)

    const contact = {
      name: values.name.trim(),
      taxId: orNull(values.taxId),
      contactPhone: orNull(values.contactPhone),
      contactEmail: orNull(values.contactEmail),
      addressLine1: orNull(values.addressLine1),
      city: orNull(values.city),
      country: (orNull(values.country) ?? 'IL').toUpperCase(),
      note: orNull(values.note),
    }

    const result =
      props.mode === 'create'
        ? await createAgencyAction({
            ...contact,
            rule:
              Number(percent) > 0
                ? { kind: 'percentage', percent: Number(percent) }
                : { kind: 'none' },
            base,
            eligibility: [...DEFAULT_ELIGIBILITY],
            activeFrom: today(),
            activeUntil: null,
            paymentTermsDays: Number(paymentTermsDays),
            note: null,
            // A double-submitted form must be one agency, not two rows for one
            // legal entity. The key is per attempt, not per keystroke.
            idempotencyKey: `agency.create:${contact.name}:${contact.taxId ?? ''}`,
          })
        : await editAgencyContactAction({
            agencyId: props.agencyId,
            version: props.version,
            ...contact,
          })

    setBusy(false)

    if (!result.ok) {
      setFailure(result.error)
      return
    }

    setDone(
      props.mode === 'create'
        ? `הסוכנות ${contact.name} נוצרה, ונחתם איתה הסכם בתוקף מהיום. אפשר לדייק את התנאים בכרטיס שלה.`
        : 'פרטי הסוכנות עודכנו.',
    )
    if (props.mode === 'create') setValues(EMPTY)
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="שם הסוכנות"
          required
          error={nameMissing && values.name !== '' ? 'שם קצר מדי.' : undefined}
        >
          <TextInput
            value={values.name}
            onChange={(event) => set('name')(event.target.value)}
            autoComplete="organization"
          />
        </Field>

        <Field
          label="ח.פ. / ע.מ."
          description="מזהה הישות המשפטית. סוכנות אחת עם שני מספרים היא שתי רשומות שההיסטוריה שלהן מתפצלת, ולכן הוא ייחודי."
        >
          <TextInput
            value={values.taxId}
            onChange={(event) => set('taxId')(event.target.value)}
            inputMode="numeric"
            dir="ltr"
          />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium text-foreground">
          פרטי קשר
        </legend>
        <p className="text-xs text-muted-foreground">
          כל השדות כאן אינם חובה, וכולם מידע אישי שנשמר עליך במסד. מלא רק את מה
          שאתה באמת צריך כדי לעבוד מול הסוכנות — כתובת שנרשמה &quot;ליתר
          ביטחון&quot; היא מידע שתצטרך לתת עליו דין וחשבון.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="טלפון">
            <TextInput
              value={values.contactPhone}
              onChange={(event) => set('contactPhone')(event.target.value)}
              inputMode="tel"
              dir="ltr"
            />
          </Field>

          <Field label="דוא״ל">
            <TextInput
              value={values.contactEmail}
              onChange={(event) => set('contactEmail')(event.target.value)}
              inputMode="email"
              dir="ltr"
            />
          </Field>

          <Field label="כתובת">
            <TextInput
              value={values.addressLine1}
              onChange={(event) => set('addressLine1')(event.target.value)}
            />
          </Field>

          <Field label="עיר">
            <TextInput
              value={values.city}
              onChange={(event) => set('city')(event.target.value)}
            />
          </Field>

          <Field label="מדינה" description="קוד בן שתי אותיות, למשל IL.">
            <TextInput
              value={values.country}
              onChange={(event) => set('country')(event.target.value)}
              maxLength={2}
              dir="ltr"
            />
          </Field>
        </div>
      </fieldset>

      <Field label="הערה">
        <Textarea
          value={values.note}
          onChange={(event) => set('note')(event.target.value)}
          rows={2}
        />
      </Field>

      {props.mode === 'create' && (
        <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium text-foreground">
            ההסכם הפותח
          </legend>
          <p className="text-xs text-muted-foreground">
            סוכנות נוצרת יחד עם הסכם, כי ההסכם הוא מה שמקשר אותה אליך — בלעדיו
            היא רשומה שאף אחד לא יכול לראות. ההסכם נכנס לתוקף היום ואפשר לדייק
            את תנאיו מיד אחר כך. עמלה של 0% נשמרת כ&quot;ללא עמלה&quot;, שזה
            הסדר אמיתי ולא אפס אחוזים.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="אחוז עמלה">
              <TextInput
                value={percent}
                onChange={(event) => setPercent(event.target.value)}
                inputMode="decimal"
                dir="ltr"
              />
            </Field>

            <Field label="בסיס חישוב">
              <Select
                value={base}
                onChange={(event) =>
                  setBase(event.target.value as CommissionBase)
                }
              >
                {TERMS_BASES.map((value) => (
                  <option key={value} value={value}>
                    {COMMISSION_BASE_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="ימי תשלום">
              <TextInput
                value={paymentTermsDays}
                onChange={(event) => setPaymentTermsDays(event.target.value)}
                inputMode="numeric"
                dir="ltr"
              />
            </Field>
          </div>
        </fieldset>
      )}

      {failure && <ActionError error={failure} />}

      {done && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          {done}
        </p>
      )}

      <div className="flex gap-3">
        <Button type="submit" disabled={nameMissing || busy}>
          {busy
            ? 'שומר…'
            : props.mode === 'create'
              ? 'הוסף סוכנות'
              : 'שמור פרטים'}
        </Button>
      </div>
    </form>
  )
}

/**
 * Today, in Israel.
 *
 * Not `new Date().toISOString().slice(0, 10)`: an agreement signed at 22:00 in
 * Israel would be dated tomorrow by the UTC slice, and an agreement whose start
 * is in the future is not live today.
 */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}
