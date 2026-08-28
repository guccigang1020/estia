'use client'

/**
 * The bookings filter bar.
 *
 * `"use client"` because it navigates: submitting pushes the filter into the
 * URL and lets the server component re-query. The filter is never held in
 * component state, so a filtered list is a link somebody can send, and the
 * back button undoes a filter the way a person expects.
 *
 * It is a real `<form>` with real named controls and a real submit button, so
 * it works before hydration and with JavaScript disabled — the browser's own
 * GET submission produces the same query string this handler builds. The
 * handler exists to make it a client-side navigation rather than a full
 * document load, not to make it work at all.
 *
 * The statuses offered are `BOOKING_STATUSES`, imported from the contract. A
 * list retyped here would drift from the enum the moment one is added, and the
 * filter would quietly stop being able to find those bookings.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition, type FormEvent } from 'react'

import {
  BOOKING_FILTER_KEYS,
  type BookingFilters,
} from '@/app/(app)/bookings/_lib/filters'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { BOOKING_STATUSES } from '@/lib/booking/types'
import { BOOKING_STATUS_LABEL } from '@/lib/booking/state-machine'

export function BookingFiltersBar({
  filters,
  dateIssue,
}: {
  filters: BookingFilters
  /** Set when the window is reversed. Shown on the field that caused it. */
  dateIssue?: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const data = new FormData(event.currentTarget)
    const next = new URLSearchParams()

    for (const key of Object.values(BOOKING_FILTER_KEYS)) {
      const value = data.get(key)
      // Empty values are dropped rather than written as `?q=`, so a cleared
      // filter produces a clean URL and "is anything filtered" stays readable
      // from the address bar.
      if (typeof value === 'string' && value.trim().length > 0) {
        next.set(key, value.trim())
      }
    }

    const query = next.toString()
    startTransition(() => {
      router.push(query.length > 0 ? `/bookings?${query}` : '/bookings')
    })
  }

  const isFiltered = searchParams.toString().length > 0

  return (
    <form
      // `method="get"` and named controls: without JavaScript the browser
      // submits this to the same URL with the same keys.
      method="get"
      action="/bookings"
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label="סינון הזמנות"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="חיפוש"
          description="שם האורח או מספר ההזמנה"
          className="lg:col-span-1"
        >
          <TextInput
            name={BOOKING_FILTER_KEYS.search}
            defaultValue={filters.search}
            placeholder="דנה לוי, 8892"
            autoComplete="off"
            enterKeyHint="search"
          />
        </Field>

        <Field label="סטטוס">
          <Select
            name={BOOKING_FILTER_KEYS.status}
            defaultValue={filters.status ?? ''}
          >
            <option value="">כל הסטטוסים</option>
            {BOOKING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {BOOKING_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="שהיות מתאריך" description="כולל שהיות שהתחילו קודם">
          <TextInput
            type="date"
            name={BOOKING_FILTER_KEYS.from}
            defaultValue={filters.from ?? ''}
          />
        </Field>

        <Field label="ועד תאריך" error={dateIssue ?? undefined}>
          <TextInput
            type="date"
            name={BOOKING_FILTER_KEYS.to}
            defaultValue={filters.to ?? ''}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'מסנן…' : 'סנן'}
        </Button>

        {/* A link, not a reset button: clearing the filter is a navigation to
            the unfiltered list, which is exactly what the URL says. */}
        {isFiltered && (
          <Button href="/bookings" variant="ghost" size="sm">
            נקה סינון
          </Button>
        )}

        <span aria-live="polite" className="sr-only">
          {pending ? 'מסנן את רשימת ההזמנות' : ''}
        </span>
      </div>
    </form>
  )
}
