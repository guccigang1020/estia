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
 * ── Why the submit is disabled ────────────────────────────────────────────
 *
 * There is no `defineOperation` for creating a property. Every write in this
 * product goes through that pipeline — authorization, validation, optimistic
 * locking, the domain rule, the transaction, the audit event, idempotency, in
 * that order — and an `insert` issued from a route handler would skip all
 * seven while looking identical on screen. The one that matters most here is
 * the audit event: a property created with no row in `audit_events` is a
 * change nobody can trace, on the record that the audit screen next door
 * presents as evidence.
 *
 * So the form is complete and honest about what it cannot yet do. The gap is
 * named on screen and in the report accompanying this work.
 */

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'

import { Notice } from './notice'

export type PropertyTypeChoice = {
  value: string
  label: string
}

export function NewPropertyForm({
  types,
}: {
  types: readonly PropertyTypeChoice[]
}) {
  return (
    <form className="flex flex-col gap-6">
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

      <Notice title="הפעולה הזאת אינה קיימת עדיין במוצר" tone="strong">
        אין ב-<code dir="ltr">src/lib</code> פעולה שיוצרת נכס. כל כתיבה במוצר
        עוברת דרך <code dir="ltr">defineOperation</code> — הרשאה, ולידציה, נעילה
        אופטימית, כלל תחומי, טרנזקציה, רישום ביומן הביקורת ומניעת כפילות, בסדר
        הזה. שאילתת <code dir="ltr">insert</code> ישירה מהמסך הזה הייתה נראית
        זהה ומדלגת על כל השבעה, והחמור שבהם הוא הרישום: נכס שנוצר בלי שורה ב-
        <code dir="ltr">audit_events</code> הוא שינוי שאי אפשר להתחקות אחריו, על
        אותה רשומה שהמסך שלידו מציג כראיה.
      </Notice>

      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled
          aria-describedby="property-disabled-reason"
        >
          יצירת הנכס
        </Button>
        <p
          id="property-disabled-reason"
          className="text-sm text-muted-foreground"
        >
          מושבת עד שתיווצר פעולת יצירת נכס בשכבת השירות.
        </p>
      </div>
    </form>
  )
}
