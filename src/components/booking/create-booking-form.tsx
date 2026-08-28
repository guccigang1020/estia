'use client'

/**
 * Creating a booking.
 *
 * ── The price is not a field ──────────────────────────────────────────────
 *
 * There is no "nightly rate" input here, and its absence is the design. The
 * rate, the extra-guest supplement, the cleaning fee and the deposit are
 * columns on the unit; `createBookingAction` reads them from `units` server-
 * side and hands them to `priceStay`. A price sent from a browser is a price a
 * guest can edit with the developer tools, and a price typed by staff into a
 * form is a number nobody can reconcile against the unit's own list. What this
 * form does show is the unit's stored rate, as read-only text, so the person
 * booking knows what the stay will cost before they commit.
 *
 * ── The availability check, and what it does not promise ──────────────────
 *
 * Pressing "בדוק זמינות" asks the server, which runs the same
 * `checkAvailability` the create operation runs. It is a courtesy: the dates
 * can be taken in the second between the answer and the submit. That is why
 * the create operation checks again inside the transaction that writes the
 * row, and why a lost race arrives here as a `ConflictError` whose Hebrew
 * `userMessage` names the dates rather than as a stack trace. The form never
 * treats a green answer as permission to skip anything.
 *
 * ── Duplicate submission, both halves ─────────────────────────────────────
 *
 * `useAsyncAction` refuses a second run synchronously, which covers the double
 * click. The idempotency key — generated once per form instance — covers what
 * a disabled button cannot: a retry after a timeout, a resubmitted request, a
 * flaky connection. The second request replays the first answer instead of
 * creating a second booking.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  checkAvailabilityAction,
  createBookingAction,
  type AvailabilityAnswer,
} from '@/app/(app)/bookings/_lib/actions'
import type { BookableUnit } from '@/app/(app)/bookings/_lib/queries'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import { BOOKING_STATUS_LABEL } from '@/lib/booking/state-machine'
import { nightsBetween } from '@/lib/booking/types'
import type { BookingSource, BookingStatus } from '@/lib/booking/types'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { formatAgorot } from '@/lib/plans/plan'

import { ActionError } from './action-error'

/**
 * The statuses a booking may be born in, mirroring `INITIAL_STATUSES` in
 * `operations.ts`. Everything else is a transition, and offering one here
 * would offer a choice the server refuses.
 */
const INITIAL_STATUSES: readonly BookingStatus[] = [
  'inquiry',
  'quote',
  'option',
  'awaiting_payment',
  'confirmed',
]

/**
 * The sources a person at a desk actually books from. The channels
 * (`airbnb`, `booking_com`, `vrbo`) are omitted deliberately: a booking
 * entered by hand and labelled as an Airbnb booking is attribution nobody can
 * reconcile against Airbnb's own report, and attribution is what commission
 * disputes are settled with.
 */
const MANUAL_SOURCES: readonly BookingSource[] = [
  'direct_manual',
  'direct_website',
  'agent',
  'agency',
  'other_channel',
]

const SOURCE_LABEL: Record<BookingSource, string> = {
  direct_website: 'אתר ישיר',
  direct_manual: 'ידני — טלפון, וואטסאפ או מקום',
  agent: 'סוכן',
  agency: 'סוכנות',
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  other_channel: 'ערוץ אחר',
}

export function CreateBookingForm({
  units,
}: {
  units: readonly BookableUnit[]
}) {
  const router = useRouter()

  const [unitId, setUnitId] = useState(units[0]?.id ?? '')
  const [guestName, setGuestName] = useState('')
  const [guestCount, setGuestCount] = useState('2')
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [status, setStatus] = useState<BookingStatus>('option')
  const [source, setSource] = useState<BookingSource>('direct_manual')

  const [availability, setAvailability] = useState<AvailabilityAnswer | null>(
    null,
  )
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [touched, setTouched] = useState(false)

  const create = useAsyncAction<void>()
  const check = useAsyncAction<void>()

  /**
   * One key for the life of this form instance. Regenerated only when the
   * component remounts — which is what makes a resubmission of *this* booking
   * a replay, while a genuinely new booking gets a new key.
   */
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [])

  const unit = units.find((candidate) => candidate.id === unitId) ?? null
  const nights =
    checkIn.length > 0 && checkOut.length > 0
      ? nightsBetween({ checkIn, checkOut })
      : 0
  const guests = Number.parseInt(guestCount, 10)

  const issues = validate({ unit, guestName, guests, nights })
  const ready = issues.length === 0

  if (units.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        אין יחידות פעילות שאפשר להזמין. יחידה חייבת להיות במצב ״פעילה״ כדי שמנוע
        הזמינות יסכים למכור אותה — הוסף או הפעל יחידה, וחזור לכאן.
      </p>
    )
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        setTouched(true)
        if (!ready || create.pending) return

        setFailure(null)
        void create.run(async () => {
          const result = await createBookingAction({
            unitId,
            unitLabel: unit?.name ?? '',
            propertyId: unit?.propertyId ?? null,
            guestName: guestName.trim(),
            guestCount: guests,
            checkIn,
            checkOut,
            status,
            source,
            idempotencyKey,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }

          // Straight to the booking that was just made. A "saved" toast on the
          // form is a screen that leaves the person wondering where it went.
          router.push(`/bookings/${result.data.id}`)
        })
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="יחידה"
          description="רק יחידות פעילות. המחיר נלקח מהיחידה עצמה."
          required
          className="sm:col-span-2"
        >
          <Select
            value={unitId}
            onChange={(event) => {
              setUnitId(event.target.value)
              setAvailability(null)
            }}
          >
            {units.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.propertyName
                  ? `${candidate.propertyName} · ${candidate.name}`
                  : candidate.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="שם האורח"
          description="שני תווים לפחות. נוצר ממנו כרטיס אורח חדש."
          required
          error={
            touched && guestName.trim().length < 2
              ? 'שם האורח חייב להכיל לפחות שני תווים.'
              : undefined
          }
        >
          <TextInput
            value={guestName}
            onChange={(event) => setGuestName(event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field
          label="מספר אורחים"
          description={
            unit
              ? `היחידה מכילה עד ${unit.maxGuests}. המחיר כולל ${unit.standardGuests}.`
              : undefined
          }
          required
          error={
            touched && unit && (guests < 1 || guests > unit.maxGuests)
              ? `מספר האורחים חייב להיות בין 1 ל-${unit.maxGuests}.`
              : undefined
          }
        >
          <TextInput
            type="number"
            inputMode="numeric"
            min={1}
            max={unit?.maxGuests ?? 50}
            value={guestCount}
            onChange={(event) => setGuestCount(event.target.value)}
          />
        </Field>

        <Field
          label="תאריך הגעה"
          required
          error={
            touched && checkIn.length === 0
              ? 'צריך לבחור תאריך הגעה.'
              : undefined
          }
        >
          <TextInput
            type="date"
            value={checkIn}
            onChange={(event) => {
              setCheckIn(event.target.value)
              setAvailability(null)
            }}
          />
        </Field>

        <Field
          label="תאריך עזיבה"
          description="יום העזיבה אינו נספר כלילה, והוא פנוי לאורח הבא."
          required
          error={
            touched && nights <= 0
              ? 'תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.'
              : undefined
          }
        >
          <TextInput
            type="date"
            value={checkOut}
            onChange={(event) => {
              setCheckOut(event.target.value)
              setAvailability(null)
            }}
          />
        </Field>

        <Field label="סטטוס פתיחה" description="אופציה ומעלה תופסות את היומן.">
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as BookingStatus)}
          >
            {INITIAL_STATUSES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {BOOKING_STATUS_LABEL[candidate]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="מקור ההזמנה" description="נשמר לצורך עמלות ודוחות.">
          <Select
            value={source}
            onChange={(event) => setSource(event.target.value as BookingSource)}
          >
            {MANUAL_SOURCES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {SOURCE_LABEL[candidate]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* ------------------------------------------------------- the price */}
      {unit && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 p-4 text-sm">
          <p className="font-semibold text-foreground">מחיר היחידה</p>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <PriceRow
              label="מחיר ללילה"
              value={formatAgorot(unit.baseNightlyAgorot)}
            />
            <PriceRow
              label="תוספת לאורח מעבר למחיר"
              value={formatAgorot(unit.extraGuestNightlyAgorot)}
            />
            <PriceRow
              label="דמי ניקיון"
              value={formatAgorot(unit.cleaningFeeAgorot)}
            />
            <PriceRow
              label="פיקדון ביטחון"
              value={formatAgorot(unit.depositAgorot)}
            />
          </dl>
          <p className="text-xs text-muted-foreground">
            הסכום הסופי מחושב בשרת מהשורות האלה ומספר הלילות, ומוצג בהזמנה עצמה.
            אין כאן סכום משוער.
          </p>
          {unit.minNights > 1 && (
            <p className="text-xs text-muted-foreground">
              מינימום לילות ביחידה הזו: {unit.minNights}.
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------ availability check */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={check.pending || nights <= 0 || unitId.length === 0}
            onClick={() => {
              if (check.pending) return
              setFailure(null)
              void check.run(async () => {
                const result = await checkAvailabilityAction({
                  unitId,
                  checkIn,
                  checkOut,
                })
                if (!result.ok) {
                  setFailure(result.error)
                  setAvailability(null)
                  return
                }
                setAvailability(result.data)
              })
            }}
          >
            {check.pending ? 'בודק…' : 'בדוק זמינות'}
          </Button>

          {nights > 0 && (
            <span className="text-sm text-muted-foreground">
              {nights === 1 ? 'לילה אחד' : `${nights} לילות`}
            </span>
          )}
        </div>

        {availability && (
          <div
            role="status"
            className={
              availability.available
                ? 'rounded-lg border border-success bg-surface px-4 py-3 text-sm text-success'
                : 'rounded-lg border border-warning bg-surface px-4 py-3 text-sm'
            }
          >
            {availability.available ? (
              <p>
                התאריכים פנויים כרגע. הזמינות נבדקת שוב בשרת ברגע השמירה, ולכן
                עדיין ייתכן שמישהו יקדים אותך.
              </p>
            ) : (
              <div className="flex flex-col gap-1 text-warning">
                <p className="font-semibold">התאריכים אינם פנויים:</p>
                <ul className="flex list-inside list-disc flex-col gap-1">
                  {availability.blockers.map((blocker, index) => (
                    <li key={`${blocker.kind}-${index}`}>{blocker.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {failure && <ActionError error={failure} />}

      {touched && issues.length > 0 && (
        <ul
          role="alert"
          className="flex list-inside list-disc flex-col gap-1 rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-danger"
        >
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={create.pending}>
          {create.pending ? 'יוצר הזמנה…' : 'צור הזמנה'}
        </Button>
        <Button href="/bookings" variant="ghost">
          ביטול
        </Button>

        <span aria-live="polite" className="sr-only">
          {create.pending ? 'יוצר את ההזמנה' : ''}
        </span>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------- helpers -- */

/**
 * Every problem at once, not the first.
 *
 * A form that reveals its problems one at a time is a form somebody submits
 * five times. The server validates all of this again — this is what stops a
 * round trip, not what enforces anything.
 */
function validate({
  unit,
  guestName,
  guests,
  nights,
}: {
  unit: BookableUnit | null
  guestName: string
  guests: number
  nights: number
}): string[] {
  const issues: string[] = []

  if (!unit) issues.push('צריך לבחור יחידה.')
  if (guestName.trim().length < 2) {
    issues.push('שם האורח חייב להכיל לפחות שני תווים.')
  }
  if (!Number.isInteger(guests) || guests < 1) {
    issues.push('מספר האורחים חייב להיות מספר שלם, אחד לפחות.')
  } else if (unit && guests > unit.maxGuests) {
    issues.push(`היחידה מכילה עד ${unit.maxGuests} אורחים.`)
  }
  if (!Number.isFinite(nights) || nights <= 0) {
    issues.push('תאריך העזיבה חייב להיות מאוחר מתאריך ההגעה.')
  } else if (unit && nights < unit.minNights) {
    issues.push(`השהות המינימלית ביחידה הזו היא ${unit.minNights} לילות.`)
  }

  return issues
}

function PriceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  )
}
