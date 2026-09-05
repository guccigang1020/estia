'use client'

/**
 * The public booking form.
 *
 * The one client component on the public path, and it holds only what a form
 * must: the fields somebody is typing and whether the enquiry has been sent.
 *
 * ── It computes nothing ──────────────────────────────────────────────────
 *
 * Availability and the quote arrive as props, already decided by the canonical
 * engines on the server. This component renders them. There is no date
 * arithmetic here, no price arithmetic, and no "is it free?" — a client that
 * decided any of those would be a second answer to a question the product has
 * exactly one answer to, and the one on the phone would be the stale one.
 *
 * ── Checking dates is a navigation, not a fetch ──────────────────────────
 *
 * Picking a unit and dates sets the query string, the server re-renders, and
 * the engines answer. That keeps the answer server-side, makes the result a
 * shareable URL, and means the page works with JavaScript disabled up to the
 * point of actually sending — which for a booking form is most of it.
 */

import { useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import type { AvailabilityResult, StayQuote } from '@/lib/booking'

import type { EnquiryInput, EnquiryResult } from '@/app/s/[slug]/_lib/actions'

type UnitOption = { id: string; name: string }

export function BookingEnquiry({
  slug,
  units,
  selectedUnitId,
  checkIn,
  checkOut,
  guests,
  availability,
  quote,
  maxGuests,
  failure,
  action,
}: {
  slug: string
  units: readonly UnitOption[]
  selectedUnitId: string | null
  checkIn: string | null
  checkOut: string | null
  guests: number
  availability: AvailabilityResult | null
  quote: StayQuote | null
  maxGuests: number | null
  failure: string | null
  action: (input: EnquiryInput) => Promise<EnquiryResult>
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [unit, setUnit] = useState(selectedUnitId ?? '')
  const [from, setFrom] = useState(checkIn ?? '')
  const [to, setTo] = useState(checkOut ?? '')
  const [party, setParty] = useState(guests)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')

  const [result, setResult] = useState<EnquiryResult | null>(null)
  const [sending, setSending] = useState(false)

  function check() {
    const next = new URLSearchParams(searchParams?.toString() ?? '')
    next.set('unit', unit)
    next.set('from', from)
    next.set('to', to)
    next.set('guests', String(party))
    startTransition(() => {
      router.replace(`/s/${encodeURIComponent(slug)}/book?${next.toString()}`)
    })
  }

  async function send() {
    setSending(true)
    try {
      const answer = await action({
        slug,
        unitId: unit,
        checkIn: from,
        checkOut: to,
        adults: party,
        children: 0,
        infants: 0,
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        message: note,
        // What was on screen. Stored as a snapshot so the business can honour
        // it, rather than re-derived from a rate that may have moved.
        quotedTotalAgorot: quote?.totalAgorot ?? null,
      })
      setResult(answer)
    } finally {
      setSending(false)
    }
  }

  if (result?.ok) {
    return (
      <section className="flex flex-col gap-3">
        <h1
          style={{ fontFamily: 'var(--site-heading-font)' }}
          className="text-2xl font-bold"
        >
          הבקשה נשלחה
        </h1>
        {/* A repeated submission gets the same confirmation. From the
            visitor's side both are "we have your enquiry", and telling them
            their second tap did nothing is telling them about our plumbing. */}
        <p style={{ color: 'var(--site-muted)' }}>
          קיבלנו את הפרטים ונחזור אליכם בהקדם לאישור סופי. זו בקשה — ההזמנה
          תיסגר רק אחרי שנדבר.
        </p>
      </section>
    )
  }

  const fieldStyle = {
    background: 'var(--site-surface)',
    borderColor: 'var(--site-line)',
    borderRadius: 'var(--site-radius)',
    color: 'var(--site-ink)',
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h1
          style={{ fontFamily: 'var(--site-heading-font)' }}
          className="text-2xl font-bold"
        >
          בדיקת זמינות
        </h1>

        {units.length === 0 ? (
          <p style={{ color: 'var(--site-muted)' }}>
            אין כרגע יחידות פתוחות להזמנה דרך האתר.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                יחידה
                <select
                  value={unit}
                  onChange={(event) => setUnit(event.target.value)}
                  style={fieldStyle}
                  className="border px-3 py-2"
                >
                  <option value="">בחרו יחידה</option>
                  {units.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                אורחים
                <input
                  type="number"
                  min={1}
                  max={maxGuests ?? 20}
                  value={party}
                  onChange={(event) => setParty(Number(event.target.value))}
                  style={fieldStyle}
                  className="border px-3 py-2"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                תאריך הגעה
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                  style={fieldStyle}
                  className="border px-3 py-2"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                תאריך עזיבה
                <input
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  style={fieldStyle}
                  className="border px-3 py-2"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={check}
              disabled={pending || !unit || !from || !to}
              style={{
                background: 'var(--site-accent)',
                color: 'var(--site-accent-ink)',
                borderRadius: 'var(--site-radius)',
              }}
              className="self-start px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {pending ? 'בודק…' : 'בדיקת זמינות ומחיר'}
            </button>
          </>
        )}
      </section>

      {failure ? (
        <p style={{ color: 'var(--site-muted)' }} className="text-sm">
          {failure}
        </p>
      ) : null}

      {availability && !availability.available ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">התאריכים האלה תפוסים</h2>
          {/* Every sentence here is the availability engine's own. The page
              lists them; it does not decide what a blocker is. */}
          <ul style={{ color: 'var(--site-muted)' }} className="text-sm">
            {availability.blockers.map((blocker, index) => (
              <li key={`${blocker.kind}-${index}`}>· {blocker.message}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {availability?.available && quote ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">
            פנוי · {availability.nights} לילות
          </h2>

          <ul
            style={{
              borderColor: 'var(--site-line)',
              borderRadius: 'var(--site-radius)',
            }}
            className="flex flex-col divide-y border"
          >
            {quote.lines.map((line, index) => (
              <li
                key={`${line.kind}-${index}`}
                className="flex items-baseline justify-between gap-4 px-4 py-2 text-sm"
                style={{ borderColor: 'var(--site-line)' }}
              >
                <span>{line.label}</span>
                <span className="tabular-nums">{shekels(line.amount)}</span>
              </li>
            ))}
            <li
              className="flex items-baseline justify-between gap-4 px-4 py-3 font-semibold"
              style={{ borderColor: 'var(--site-line)' }}
            >
              <span>סה״כ</span>
              <span className="tabular-nums">{shekels(quote.totalAgorot)}</span>
            </li>
          </ul>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              שם מלא
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                style={fieldStyle}
                className="border px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              טלפון
              <input
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                style={fieldStyle}
                className="border px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              דוא״ל (לא חובה)
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                style={fieldStyle}
                className="border px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              משהו שכדאי שנדע?
              <textarea
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                style={fieldStyle}
                className="border px-3 py-2"
              />
            </label>
          </div>

          {result && !result.ok ? (
            <p className="text-sm" style={{ color: 'var(--site-accent)' }}>
              {result.message}
            </p>
          ) : null}

          <button
            type="button"
            onClick={send}
            disabled={sending}
            style={{
              background: 'var(--site-accent)',
              color: 'var(--site-accent-ink)',
              borderRadius: 'var(--site-radius)',
            }}
            className="self-start px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {sending ? 'שולח…' : 'שליחת בקשת הזמנה'}
          </button>

          {/* Said plainly, because a form that looks like a checkout and is
              not one is how somebody arrives believing they have a room. */}
          <p style={{ color: 'var(--site-muted)' }} className="text-xs">
            שליחת הטופס אינה סוגרת את ההזמנה. נחזור אליכם לאישור, והתאריכים
            נשמרים רק אחרי שנדבר.
          </p>
        </section>
      ) : null}
    </div>
  )
}

/**
 * Agorot to shekels, for display only.
 *
 * Formatting, never arithmetic on money — the totals arrive already computed
 * by `priceStay` and this divides by 100 to print them.
 */
function shekels(agorot: number): string {
  return `₪${(agorot / 100).toLocaleString('he-IL', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`
}
