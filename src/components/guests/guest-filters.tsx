'use client'

/**
 * The guest filter bar.
 *
 * `"use client"` because it navigates: submitting pushes the filter into the
 * URL and lets the server component re-query. The filter is never held in
 * component state, so a filtered list is a link somebody can send and the back
 * button undoes a filter the way a person expects.
 *
 * It is a real `<form method="get">` with real named controls and a real
 * submit button, so it works before hydration and with JavaScript disabled —
 * the browser's own GET submission produces the same query string this handler
 * builds. The handler makes it a client-side navigation, not a working form.
 *
 * ── The search placeholder is not decoration ──────────────────────────────
 *
 * What the search actually matches depends on the reader: the name always, the
 * e-mail and the telephone only for somebody holding those grants — see
 * `listGuests`. So the description under the field is passed in rather than
 * written here, and it states what *this* reader can find. Promising a phone
 * search to somebody whose phone search is refused is a worse lie than
 * offering none.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition, type FormEvent } from 'react'

import {
  GUEST_CONSENTS,
  GUEST_CONSENT_LABEL,
  GUEST_FILTER_KEYS,
  GUEST_STATUSES,
  GUEST_STATUS_LABEL,
  type GuestFilters,
} from '@/app/(app)/guests/_lib/filters'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'

export function GuestFiltersBar({
  filters,
  tags,
  searchDescription,
}: {
  filters: GuestFilters
  /** Every tag in use, derived from the rows themselves. See `listGuestTags`. */
  tags: readonly string[]
  searchDescription: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const data = new FormData(event.currentTarget)
    const next = new URLSearchParams()

    for (const key of Object.values(GUEST_FILTER_KEYS)) {
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
      router.push(query.length > 0 ? `/guests?${query}` : '/guests')
    })
  }

  const isFiltered = searchParams.toString().length > 0

  return (
    <form
      method="get"
      action="/guests"
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label="סינון אורחים"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="חיפוש" description={searchDescription}>
          <TextInput
            name={GUEST_FILTER_KEYS.search}
            defaultValue={filters.search}
            placeholder="תמר גולדשטיין"
            autoComplete="off"
            enterKeyHint="search"
          />
        </Field>

        <Field
          label="תגית"
          description={
            tags.length === 0 ? 'עוד לא הוגדרו תגיות' : 'התגיות שבשימוש בפועל'
          }
        >
          <Select
            name={GUEST_FILTER_KEYS.tag}
            defaultValue={filters.tag ?? ''}
            disabled={tags.length === 0}
          >
            <option value="">כל התגיות</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="מצב">
          <Select
            name={GUEST_FILTER_KEYS.status}
            defaultValue={filters.status ?? ''}
          >
            <option value="">הכל</option>
            {GUEST_STATUSES.map((status) => (
              <option key={status} value={status}>
                {GUEST_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="דיוור" description="מי אישר לקבל פנייה שיווקית">
          <Select
            name={GUEST_FILTER_KEYS.consent}
            defaultValue={filters.consent ?? ''}
          >
            <option value="">הכל</option>
            {GUEST_CONSENTS.map((consent) => (
              <option key={consent} value={consent}>
                {GUEST_CONSENT_LABEL[consent]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'מסנן…' : 'סנן'}
        </Button>

        {/* A link, not a reset button: clearing the filter is a navigation to
            the unfiltered list, which is exactly what the URL says. */}
        {isFiltered && (
          <Button href="/guests" variant="ghost" size="sm">
            נקה סינון
          </Button>
        )}

        <span aria-live="polite" className="sr-only">
          {pending ? 'מסנן את רשימת האורחים' : ''}
        </span>
      </div>
    </form>
  )
}
