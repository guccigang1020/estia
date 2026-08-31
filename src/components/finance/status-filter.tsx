'use client'

/**
 * The one control the three finance lists share: filter by status.
 *
 * `"use client"` because it navigates. The filter is pushed into the URL and
 * the server component re-queries, so a filtered list is a link somebody can
 * send and the back button undoes a filter the way a person expects — the same
 * decision `BookingFiltersBar` made, for the same reason.
 *
 * It is a real `<form method="get">` with a real named control and a real
 * submit button, so it works before hydration and with JavaScript disabled:
 * the browser's own GET submission produces the same query string this handler
 * builds. The handler exists to make it a client-side navigation, not to make
 * it work at all.
 *
 * ── Why it is generic ─────────────────────────────────────────────────────
 *
 * The statuses and their Hebrew names are props, and they are always the
 * contract's own tuple and the domain's own label record. A list retyped in
 * this component would drift from the enum the moment one was added, and the
 * filter would quietly stop being able to find those rows — which on the
 * payments screen means being unable to select `unknown`, the one status
 * somebody is actually hunting for.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition, type FormEvent } from 'react'

import { FINANCE_STATUS_KEY } from '@/app/(app)/finance/_lib/filters'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'

export function StatusFilterBar<S extends string>({
  path,
  legend,
  statuses,
  labels,
  selected,
  anyLabel,
}: {
  /** Where the form submits. The screen's own route, e.g. `/finance/payments`. */
  path: string
  /** Names the form for a screen reader: "סינון תשלומים". */
  legend: string
  statuses: readonly S[]
  labels: Record<S, string>
  selected: S | null
  /** The wording of "no filter": "כל הסטטוסים", "כל המסמכים". */
  anyLabel: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const value = new FormData(event.currentTarget).get(FINANCE_STATUS_KEY)
    const next = new URLSearchParams()

    // An empty value is dropped rather than written as `?status=`, so a
    // cleared filter produces a clean URL and "is anything filtered" stays
    // readable from the address bar.
    if (typeof value === 'string' && value.trim().length > 0) {
      next.set(FINANCE_STATUS_KEY, value.trim())
    }

    const query = next.toString()
    startTransition(() => {
      router.push(query.length > 0 ? `${path}?${query}` : path)
    })
  }

  const isFiltered = searchParams.get(FINANCE_STATUS_KEY) !== null

  return (
    <form
      method="get"
      action={path}
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label={legend}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="סטטוס">
          <Select name={FINANCE_STATUS_KEY} defaultValue={selected ?? ''}>
            <option value="">{anyLabel}</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {labels[status]}
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
          <Button href={path} variant="ghost" size="sm">
            נקה סינון
          </Button>
        )}

        <span aria-live="polite" className="sr-only">
          {pending ? 'מסנן את הרשימה' : ''}
        </span>
      </div>
    </form>
  )
}
