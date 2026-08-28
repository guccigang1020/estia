/**
 * Pick dates and a party size, and see what is free.
 *
 * A plain `<form method="get">`, so no `"use client"` and no JavaScript: the
 * search lands in the URL, which means a result can be bookmarked, reloaded and
 * sent to a colleague. A GET is the right verb precisely because this changes
 * nothing — the moment a screen here *writes* (placing a hold, opening a
 * booking) it becomes a Server Action with an origin check, for the reason
 * spelled out on `selectPropertyAction`.
 *
 * Validation is the domain's. `checkAvailability` refuses a reversed range with
 * its own Hebrew sentence and `priceStay` refuses a party of zero with another;
 * `required` and `min` here only spare the user a round trip.
 */

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'

export type AvailabilityFormProps = {
  action: string
  /** Prefilled values, echoed back after a search. ISO dates. */
  checkIn: string
  checkOut: string
  guests: number
  /** Carried through so a search does not silently jump the month grid. */
  month?: string
}

export function AvailabilityForm({
  action,
  checkIn,
  checkOut,
  guests,
  month,
}: AvailabilityFormProps) {
  return (
    <form
      method="get"
      action={action}
      className="flex flex-col gap-4 sm:flex-row sm:items-end"
    >
      {month && <input type="hidden" name="month" value={month} />}

      <Field
        label="תאריך הגעה"
        required
        className="sm:max-w-52"
        description="הלילה הראשון של השהות."
      >
        <TextInput
          type="date"
          name="checkIn"
          defaultValue={checkIn}
          dir="ltr"
          required
        />
      </Field>

      <Field
        label="תאריך עזיבה"
        required
        className="sm:max-w-52"
        description="לילה זה אינו נספר — האורח עוזב בבוקר."
      >
        <TextInput
          type="date"
          name="checkOut"
          defaultValue={checkOut}
          dir="ltr"
          required
        />
      </Field>

      <Field label="מספר אורחים" required className="sm:max-w-36">
        <TextInput
          type="number"
          name="guests"
          defaultValue={String(guests)}
          min={1}
          step={1}
          inputMode="numeric"
          dir="ltr"
          required
        />
      </Field>

      <Button type="submit" className="sm:mb-0.5">
        בדוק זמינות
      </Button>
    </form>
  )
}
