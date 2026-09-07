'use client'

/**
 * Writing down an enquiry.
 *
 * ── Everything except the source and one way to reply is optional ─────────
 *
 * That is the point of the table. `bookings` needs a unit and two dates, which
 * is why "somebody rang about August, no dates fixed" could not be recorded at
 * all before `0074`. A form here that demanded dates would put the gap back.
 *
 * ── The telephone is not validated into shape ─────────────────────────────
 *
 * What is typed is stored as typed. `leads.phone_e164` is generated from it by
 * the database, and `raw_phone` beside it is the evidence of what the person
 * actually wrote — which is the only way to explain, months later, why two
 * enquiries were treated as one person. So this form does not reformat, and it
 * checks only the one thing ח40-20 asks: is there any way to reply at all.
 *
 * ⚠️ It does say, out loud, that a foreign number needs a `+`. `normalize_phone_il`
 * reads a number beginning `972` with no `+` as Israeli (ח40-03) — a documented
 * limitation, not a bug — and the interface is where that has to be said.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { recordEnquiryAction } from '@/app/(app)/leads/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput, Textarea } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
// The leaf module, not the barrel — see `scripts/client-bundle.mjs`.
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABEL,
  type LeadSource,
} from '@/lib/leads/types'

export function RecordEnquiryForm({
  properties,
}: {
  /**
   * `name` is nullable because `PropertyOption` says so — a property whose row
   * the reader may not read comes back without one. Such an option is dropped
   * rather than labelled with an id: an option nobody can identify is worse
   * than an option that is not offered.
   */
  properties: readonly { id: string; name: string | null }[]
}) {
  const namedProperties = properties.filter(
    (property): property is { id: string; name: string } =>
      property.name !== null,
  )

  const router = useRouter()
  const save = useAsyncAction<void>()

  const [source, setSource] = useState<LeadSource>('phone')
  const [sourceDetail, setSourceDetail] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const [rawName, setRawName] = useState('')
  const [rawPhone, setRawPhone] = useState('')
  const [rawEmail, setRawEmail] = useState('')
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [adults, setAdults] = useState('2')
  const [children, setChildren] = useState('0')
  const [infants, setInfants] = useState('0')
  const [message, setMessage] = useState('')
  const [touched, setTouched] = useState(false)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [attached, setAttached] = useState<boolean | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  )

  const problems: Record<string, string> = {}
  if (rawPhone.trim() === '' && rawEmail.trim() === '') {
    problems.contact = 'צריך טלפון או מייל כדי לחזור לפונה.'
  }
  if (checkIn !== '' && checkOut !== '' && checkOut <= checkIn) {
    problems.checkOut = 'תאריך היציאה חייב להיות אחרי תאריך הכניסה.'
  }
  if (Number(adults) < 1) {
    problems.adults = 'חייב להיות לפחות מבוגר אחד.'
  }

  const problemFor = (field: string) => (touched ? problems[field] : undefined)

  if (attached !== null) {
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-lg border border-success bg-surface px-4 py-4 text-sm"
      >
        <p className="font-semibold text-success">הפנייה נרשמה.</p>
        <p className="text-muted-foreground">
          {attached
            ? 'מספר הטלפון תואם לאורח קיים, ולכן הפנייה הוצמדה לפרופיל שלו — לא נפתח כרטיס שני לאותו אדם.'
            : 'לא נמצאה התאמה לאורח קיים לפי מספר הטלפון, ולכן הפנייה נשמרה בלי פרופיל. זו תשובה אמיתית ולא כשל: כרטיס אורח ייפתח כשתיווצר הזמנה.'}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button href="/leads" variant="secondary">
            חזרה לצנרת
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setAttached(null)
              setRawName('')
              setRawPhone('')
              setRawEmail('')
              setMessage('')
              setTouched(false)
              // A different enquiry gets a different key. Reusing the last one
              // would return the previous lead instead of creating this one.
              setIdempotencyKey(crypto.randomUUID())
            }}
          >
            רשום פנייה נוספת
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
        if (Object.keys(problems).length > 0 || save.pending) return

        setFailure(null)
        void save.run(async () => {
          const result = await recordEnquiryAction({
            source,
            sourceDetail: sourceDetail || null,
            propertyId: propertyId === '' ? null : propertyId,
            rawName: rawName || null,
            rawPhone: rawPhone || null,
            rawEmail: rawEmail || null,
            requestedCheckIn: checkIn === '' ? null : checkIn,
            requestedCheckOut: checkOut === '' ? null : checkOut,
            partyAdults: Number(adults),
            partyChildren: Number(children),
            partyInfants: Number(infants),
            budgetAgorot: null,
            message: message || null,
            idempotencyKey,
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }
          setAttached(result.data.attachedToGuest)
          router.refresh()
        })
      }}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="מקור הפנייה" required>
          <Select
            value={source}
            onChange={(event) => setSource(event.target.value as LeadSource)}
          >
            {LEAD_SOURCES.map((option) => (
              <option key={option} value={option}>
                {LEAD_SOURCE_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="פירוט המקור"
          description="״סטורי באינסטגרם״, ״פנייה מ-Booking״ — מה שיעזור להבין מאיפה הגיעה."
        >
          <TextInput
            value={sourceDetail}
            onChange={(event) => setSourceDetail(event.target.value)}
          />
        </Field>

        <Field
          label="נכס"
          description="אפשר להשאיר ריק. פנייה שלא נוקבת בנכס מוצגת רק למי שהטווח שלו הוא כל הארגון — לכן אם ידוע, עדיף לבחור."
          className="sm:col-span-2"
        >
          <Select
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
          >
            <option value="">עוד לא ידוע</option>
            {namedProperties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="שם" description="כפי שנמסר. לא מתוקן ולא מנורמל.">
          <TextInput
            value={rawName}
            onChange={(event) => setRawName(event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field
          label="טלפון"
          description="מספר בחו״ל? התחילו ב-+. מספר שמתחיל ב-972 בלי + ייקרא כישראלי."
          error={problemFor('contact')}
        >
          <TextInput
            type="tel"
            dir="ltr"
            value={rawPhone}
            onChange={(event) => setRawPhone(event.target.value)}
            placeholder="050-123-4567"
            autoComplete="off"
          />
        </Field>

        <Field label="אימייל" error={problemFor('contact')}>
          <TextInput
            type="email"
            dir="ltr"
            value={rawEmail}
            onChange={(event) => setRawEmail(event.target.value)}
            autoComplete="off"
          />
        </Field>

        <Field label="תאריך כניסה מבוקש">
          <TextInput
            type="date"
            dir="ltr"
            value={checkIn}
            onChange={(event) => setCheckIn(event.target.value)}
          />
        </Field>

        <Field label="תאריך יציאה מבוקש" error={problemFor('checkOut')}>
          <TextInput
            type="date"
            dir="ltr"
            value={checkOut}
            onChange={(event) => setCheckOut(event.target.value)}
          />
        </Field>

        <Field label="מבוגרים" required error={problemFor('adults')}>
          <TextInput
            type="number"
            dir="ltr"
            min={1}
            value={adults}
            onChange={(event) => setAdults(event.target.value)}
          />
        </Field>

        <Field label="ילדים">
          <TextInput
            type="number"
            dir="ltr"
            min={0}
            value={children}
            onChange={(event) => setChildren(event.target.value)}
          />
        </Field>

        <Field label="תינוקות" description="לא נספרים במספר האורחים.">
          <TextInput
            type="number"
            dir="ltr"
            min={0}
            value={infants}
            onChange={(event) => setInfants(event.target.value)}
          />
        </Field>

        <Field
          label="מה נכתב"
          description="הטקסט של הפונה, כלשונו."
          className="sm:col-span-2"
        >
          <Textarea
            rows={4}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </Field>
      </div>

      {failure && <ActionError error={failure} />}

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={save.pending}>
          {save.pending ? 'שומר…' : 'שמור פנייה'}
        </Button>
        <Button href="/leads" variant="ghost">
          ביטול
        </Button>
      </div>
    </form>
  )
}
