'use client'

/**
 * Creating a booking.
 *
 * ── The price is a field now, and that is the point ───────────────────────
 *
 * This form used to have no price input at all, on the reasoning that "a price
 * sent from a browser is a price a guest can edit with the developer tools".
 * That reasoning is right about an *untrusted* price and wrong as a total ban.
 * A villa or צימר owner is not running a hotel with a rate card: they quote a
 * number for this booking — a slow week, a returning guest, a friend of a
 * friend — and two identical stays selling for different amounts is the normal
 * case rather than a mistake. A desk that cannot sell at the price the owner
 * agreed is a desk that keeps a second set of numbers on paper.
 *
 * So the rate is editable, and it is *authorized* rather than accepted. The
 * server decides who may name a price — `booking.override_price`, asked per
 * unit because a grant can be scoped to one property — and this form is only
 * told the answer so it can offer the right control. Somebody without the
 * grant sees the unit's price as text and a sentence saying it is a permission,
 * not a broken field. Somebody with it sees an input that *starts* on the
 * unit's rate, so the common case is still one keystroke and nobody is ever
 * forced to define a fixed price or forced to depart from one.
 *
 * A price below the unit's rate is not an error and nothing here warns about
 * it. The stored rate is a default and a suggestion; it is not a floor.
 *
 * ── Why there is a total on the screen now ────────────────────────────────
 *
 * The old copy said, deliberately, that no estimate was shown: the server had
 * the rates and would do the arithmetic. That was defensible when the number
 * was not a choice. It is not defensible once a person is choosing it — asking
 * someone to name a price and then hiding what it comes to is how a stay gets
 * sold for the wrong figure. The breakdown below is `priceStay`, the *same*
 * pure function the operation runs, over the unit's stored charges. It is a
 * preview and it says so; the server recomputes it authoritatively and the
 * stored total is the sum of the lines it writes.
 *
 * ── The party, split three ways ───────────────────────────────────────────
 *
 * `public.bookings` has held `adults`, `children` and `infants` as separate
 * columns since 0009 and this form collected one number. The third is the one
 * that earns its place: an infant needs **no sleeping place** and **does** need
 * a cot, so a party of six adults-and-children plus a baby is three double beds
 * and one cot, while the same seven counted as one number is four beds — one of
 * them for nobody. `sleepingGuests` and `totalGuests` in `src/lib/booking/party`
 * hold that distinction; this file does not do the arithmetic itself.
 *
 * The counts, the couples and the cots are validated by `partyIssues` from the
 * same module the server calls, so the screen and the operation cannot disagree
 * about what is wrong. No rule is written twice.
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
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import {
  DEFAULT_EVENT_TYPE,
  EVENT_TYPE_LABEL,
  SPECIAL_REQUESTS_MAX,
  partyIssues,
  sleepingGuests,
  suggestedCouples,
  totalGuests,
  type BookingParty,
  type SleepingRequest,
} from '@/lib/booking/party'
import { priceStay, type StayQuote } from '@/lib/booking/pricing'
import { BOOKING_STATUS_LABEL } from '@/lib/booking/state-machine'
import { nightsBetween } from '@/lib/booking/types'
import type { BookingSource, BookingStatus } from '@/lib/booking/types'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { formatAgorot } from '@/lib/plans/plan'
import { EVENT_TYPES, type EventType } from '@/lib/preparation/types'

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
  mayPriceByUnit,
}: {
  units: readonly BookableUnit[]
  /**
   * `booking.override_price`, answered per unit by the server component. A unit
   * missing from the map is a unit this actor may not price, which is the safe
   * reading of an absent answer.
   */
  mayPriceByUnit: Readonly<Record<string, boolean>>
}) {
  const router = useRouter()

  const [unitId, setUnitId] = useState(units[0]?.id ?? '')
  const [guestName, setGuestName] = useState('')

  // The party, as three fields. The defaults are the ordinary booking — two
  // adults — so the common case is still "type a name and pick two dates".
  const [adults, setAdults] = useState('2')
  const [children, setChildren] = useState('0')
  const [infants, setInfants] = useState('0')

  /**
   * `null` means "whatever the adults suggest".
   *
   * Two adults are a couple far more often than not, and a form that defaulted
   * to zero would record "no couples" on most bookings without anyone deciding
   * it. The moment somebody types here the field stops following and keeps what
   * they said, including a deliberate zero.
   */
  const [couples, setCouples] = useState<string | null>(null)
  const [extraBeds, setExtraBeds] = useState('0')
  const [cots, setCots] = useState('0')
  const [eventType, setEventType] = useState<EventType>(DEFAULT_EVENT_TYPE)
  const [specialRequests, setSpecialRequests] = useState('')

  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [status, setStatus] = useState<BookingStatus>('option')
  const [source, setSource] = useState<BookingSource>('direct_manual')

  /** `null` means "the unit's stored rate", which is what most bookings use. */
  const [agreedShekels, setAgreedShekels] = useState<string | null>(null)

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
  const mayPrice = unit !== null && mayPriceByUnit[unit.id] === true

  const nights =
    checkIn.length > 0 && checkOut.length > 0
      ? nightsBetween({ checkIn, checkOut })
      : 0

  const party: BookingParty = {
    adults: countOf(adults),
    children: countOf(children),
    infants: countOf(infants),
  }
  const sleeping: SleepingRequest = {
    couples: couples === null ? suggestedCouples(party) : countOf(couples),
    extraBedsRequested: countOf(extraBeds),
    cotsRequested: countOf(cots),
  }
  const guests = totalGuests(party)

  // The unit's stored rate is where the field starts. It is a default and a
  // suggestion — never a floor, never a ceiling, and never mandatory.
  const nightlyAgorot =
    agreedShekels === null
      ? (unit?.baseNightlyAgorot ?? 0)
      : agorotOf(agreedShekels)

  /**
   * What the seller is actually sending as an agreed price.
   *
   * Null when the number is the unit's own, even if it was retyped: a booking
   * sold at the list price is not an override, and asserting
   * `booking.override_price` for somebody who changed their mind twice would
   * refuse a booking nobody meant to change.
   */
  const agreedNightlyAgorot =
    unit === null || nightlyAgorot === unit.baseNightlyAgorot
      ? null
      : nightlyAgorot

  // The same pure function the operation runs, over the unit's own charges. A
  // preview, and labelled as one; the server prices the booking again.
  const preview = previewQuote({
    unit,
    checkIn,
    checkOut,
    guests,
    nightlyAgorot,
    sellerPriced: agreedNightlyAgorot !== null,
  })

  const issues = validate({
    unit,
    guestName,
    party,
    sleeping,
    nights,
    nightlyAgorot,
    mayPrice,
  })
  const fieldIssues = new Map(
    partyIssues(party, sleeping, {
      ...(unit ? { maxGuests: unit.maxGuests } : {}),
    }).map((issue) => [issue.field, issue.message]),
  )
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
            adults: party.adults,
            children: party.children,
            infants: party.infants,
            couples: sleeping.couples,
            extraBedsRequested: sleeping.extraBedsRequested,
            cotsRequested: sleeping.cotsRequested,
            eventType,
            specialRequests:
              specialRequests.trim().length > 0 ? specialRequests.trim() : null,
            // Only sent when it is genuinely a price somebody chose, and only
            // ever accepted from an actor the server has checked.
            agreedNightlyAgorot: mayPrice ? agreedNightlyAgorot : null,
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
          description="רק יחידות פעילות. המחיר מתחיל במחיר השמור ביחידה."
          required
          className="sm:col-span-2"
        >
          <Select
            value={unitId}
            onChange={(event) => {
              setUnitId(event.target.value)
              setAvailability(null)
              // The price follows the unit. A rate typed for one cabin is not
              // an offer on another, and carrying it across would be the form
              // quietly repricing a different stay.
              setAgreedShekels(null)
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

        <Field label="סוג האירוח" description="קובע אילו הכנות נדרשות לשהות.">
          <Select
            value={eventType}
            onChange={(event) => setEventType(event.target.value as EventType)}
          >
            {EVENT_TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {EVENT_TYPE_LABEL[candidate]}
              </option>
            ))}
          </Select>
        </Field>

        {/* ------------------------------------------------------- the party */}
        <fieldset className="flex flex-col gap-3 sm:col-span-2">
          <legend className="text-sm font-medium text-foreground">
            אורחים
          </legend>
          <p className="text-xs text-muted-foreground">
            {unit
              ? `היחידה מכילה עד ${unit.maxGuests} אורחים, והמחיר כולל ${unit.standardGuests}.`
              : 'מבוגרים, ילדים ותינוקות נספרים בנפרד.'}{' '}
            תינוק אינו תופס מקום שינה, ולכן הוא נספר בנפרד מהמיטות.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="מבוגרים"
              required
              error={touched ? fieldIssues.get('adults') : undefined}
            >
              <TextInput
                type="number"
                inputMode="numeric"
                min={1}
                max={unit?.maxGuests ?? 50}
                value={adults}
                onChange={(event) => setAdults(event.target.value)}
              />
            </Field>

            <Field
              label="ילדים"
              error={touched ? fieldIssues.get('children') : undefined}
            >
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                max={unit?.maxGuests ?? 50}
                value={children}
                onChange={(event) => setChildren(event.target.value)}
              />
            </Field>

            <Field
              label="תינוקות"
              description="צריכים מיטת תינוק, לא מקום שינה."
              error={touched ? fieldIssues.get('infants') : undefined}
            >
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                max={20}
                value={infants}
                onChange={(event) => setInfants(event.target.value)}
              />
            </Field>
          </div>

          <p className="text-xs text-muted-foreground">
            סך הכול {guests} אורחים, מתוכם {sleepingGuests(party)} זקוקים למקום
            שינה.
          </p>
        </fieldset>

        <Field
          label="זוגות"
          description="כמה מהמבוגרים חולקים מיטה. קובע מיטה זוגית מול מיטות נפרדות."
          error={touched ? fieldIssues.get('couples') : undefined}
        >
          <TextInput
            type="number"
            inputMode="numeric"
            min={0}
            max={25}
            value={couples ?? String(suggestedCouples(party))}
            onChange={(event) => setCouples(event.target.value)}
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

      {/* ------------------------------------------- extras, folded away --- */}
      {/* Collapsed by default on purpose. Most bookings need none of it, and a
          form that asks more questions must not feel heavier than the one it
          replaced — the three fields below are one click away and nothing is
          lost by leaving them shut. */}
      <details className="rounded-lg border border-border bg-muted/40 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          מיטות ובקשות מיוחדות
        </summary>

        <div className="mt-4 flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="מיטות נוספות מבוקשות"
              description="מעבר למה שכבר מוצע בחדרים."
              error={
                touched ? fieldIssues.get('extraBedsRequested') : undefined
              }
            >
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                max={50}
                value={extraBeds}
                onChange={(event) => setExtraBeds(event.target.value)}
              />
            </Field>

            <Field
              label="מיטות תינוק"
              description="עריסה או לול לכל תינוק שזקוק לו."
              error={touched ? fieldIssues.get('cotsRequested') : undefined}
            >
              <TextInput
                type="number"
                inputMode="numeric"
                min={0}
                max={20}
                value={cots}
                onChange={(event) => setCots(event.target.value)}
              />
            </Field>
          </div>

          <Field
            label="בקשות מיוחדות"
            description="בלשון האורח. מגיע לתוכנית ההכנה ולא נשאר בשיחת טלפון."
          >
            <Textarea
              value={specialRequests}
              maxLength={SPECIAL_REQUESTS_MAX}
              placeholder="לדוגמה: שתי מיטות תינוק, חדר בקומה התחתונה"
              onChange={(event) => setSpecialRequests(event.target.value)}
            />
          </Field>
        </div>
      </details>

      {/* ------------------------------------------------------- the price */}
      {unit && (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/50 p-4 text-sm">
          <div>
            <p className="font-semibold text-foreground">מחיר ההזמנה</p>
            <p className="mt-1 text-xs text-muted-foreground">
              המחיר השמור ביחידה הוא {formatAgorot(unit.baseNightlyAgorot)}{' '}
              ללילה. זו נקודת הפתיחה, לא תקרה ולא רצפה.
            </p>
          </div>

          {mayPrice ? (
            <Field
              label="מחיר ללילה להזמנה הזו"
              description="אפשר להסכים על כל סכום. הוא נשמר כשורות המחיר של ההזמנה."
            >
              <TextInput
                type="number"
                inputMode="decimal"
                min={0}
                step={1}
                dir="ltr"
                value={
                  agreedShekels ?? shekelsOf(unit.baseNightlyAgorot).toString()
                }
                onChange={(event) => setAgreedShekels(event.target.value)}
              />
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">
              שינוי המחיר להזמנה בודדת דורש את ההרשאה ״שינוי מחיר״, שאינה
              בהרשאות שלך. ההזמנה תתומחר לפי המחיר השמור ביחידה.
            </p>
          )}

          <dl className="grid gap-x-6 gap-y-1 border-t border-border pt-3 sm:grid-cols-2">
            <PriceRow
              label="תוספת לאורח מעבר למחיר"
              value={
                agreedNightlyAgorot === null
                  ? formatAgorot(unit.extraGuestNightlyAgorot)
                  : 'כלולה במחיר המוסכם'
              }
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

          {preview ? (
            <div className="border-t border-border pt-3">
              <dl className="flex flex-col gap-1">
                {preview.lines.map((line, index) => (
                  <PriceRow
                    key={`${line.kind}-${index}`}
                    label={line.label}
                    value={formatAgorot(line.amount)}
                  />
                ))}
              </dl>
              <dl className="mt-2 border-t border-border pt-2">
                <PriceRow
                  label="סך הכול (כולל פיקדון מוחזר)"
                  value={formatAgorot(preview.totalAgorot)}
                />
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                תצוגה מקדימה, מחושבת באותו חישוב שהשרת מריץ. הסכום הנשמר הוא
                תמיד סכימת השורות שהשרת כותב.
              </p>
            </div>
          ) : (
            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              בחר תאריכים כדי לראות את הסכום.
            </p>
          )}

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
 * A count field's value, as a number.
 *
 * `NaN` for anything that is not one, which every rule in `partyIssues` treats
 * as invalid — an empty box and the letter "כ" are both "not a number of
 * people", and neither should be silently read as zero.
 */
function countOf(value: string): number {
  return value.trim().length === 0 ? NaN : Number(value)
}

/** Agorot from a shekel field. Money stays integer agorot everywhere else. */
function agorotOf(shekels: string): number {
  const parsed = Number(shekels)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN
}

/** Shekels for display in the price field. Never used for arithmetic. */
function shekelsOf(agorot: number): number {
  return agorot / 100
}

/**
 * The quote as this booking currently stands, or null when it cannot be one.
 *
 * `priceStay` throws a `ValidationError` on a range or a party it refuses, and
 * a half-filled form is exactly that for most of its life. Catching it and
 * showing nothing is the honest answer: an incomplete booking has no price, and
 * a zero would be a lie about a stay that has not been described yet.
 */
function previewQuote(args: {
  unit: BookableUnit | null
  checkIn: string
  checkOut: string
  guests: number
  nightlyAgorot: number
  sellerPriced: boolean
}): StayQuote | null {
  const { unit, checkIn, checkOut, guests, nightlyAgorot, sellerPriced } = args
  if (!unit || checkIn.length === 0 || checkOut.length === 0) return null
  if (!Number.isInteger(guests) || guests < 1) return null
  if (!Number.isInteger(nightlyAgorot) || nightlyAgorot < 0) return null

  try {
    return priceStay({
      range: { checkIn, checkOut },
      guests,
      baseNightlyAgorot: nightlyAgorot,
      // Mirrors `toPricingRequest` in the domain: a rate agreed for this party
      // covers this party, so no per-head supplement is added on top of it.
      ...(sellerPriced
        ? {}
        : {
            includedGuests: unit.standardGuests,
            extraGuestNightlyAgorot: unit.extraGuestNightlyAgorot,
          }),
      cleaningFeeAgorot: unit.cleaningFeeAgorot,
      depositAgorot: unit.depositAgorot,
    })
  } catch {
    return null
  }
}

/**
 * Every problem at once, not the first.
 *
 * A form that reveals its problems one at a time is a form somebody submits
 * five times. The party rules come from `partyIssues` in the booking domain —
 * the same function the operation calls — so the screen and the server cannot
 * disagree about what is wrong. Only the things the domain cannot see from a
 * party alone are checked here.
 */
function validate({
  unit,
  guestName,
  party,
  sleeping,
  nights,
  nightlyAgorot,
  mayPrice,
}: {
  unit: BookableUnit | null
  guestName: string
  party: BookingParty
  sleeping: SleepingRequest
  nights: number
  nightlyAgorot: number
  mayPrice: boolean
}): string[] {
  const issues: string[] = []

  if (!unit) issues.push('צריך לבחור יחידה.')
  if (guestName.trim().length < 2) {
    issues.push('שם האורח חייב להכיל לפחות שני תווים.')
  }

  // An emptied price box is not "free" and not "the unit's rate" — it is a
  // number nobody has typed yet, and submitting it would price a stay at NaN.
  // Only checked for somebody who can actually edit it; for everybody else the
  // value is the unit's own and cannot be wrong.
  if (mayPrice && (!Number.isInteger(nightlyAgorot) || nightlyAgorot < 0)) {
    issues.push('מחיר ללילה חייב להיות סכום תקין בשקלים, ולא שלילי.')
  }

  for (const issue of partyIssues(party, sleeping, {
    ...(unit ? { maxGuests: unit.maxGuests } : {}),
  })) {
    issues.push(issue.message)
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
