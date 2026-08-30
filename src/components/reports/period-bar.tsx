'use client'

/**
 * The reporting window, chosen.
 *
 * `"use client"` because it navigates: submitting pushes the window into the
 * URL and lets the server component re-query. The period is never held in
 * component state, so a report is a link somebody can send and the back button
 * undoes a change of month the way a person expects.
 *
 * It is a real `<form method="get">` with real named controls, so it works
 * before hydration and with JavaScript disabled — the browser's own submission
 * produces the same query string this handler builds. The handler makes it a
 * client-side navigation, not a functioning control.
 *
 * ── The month buttons and the free range are one form, not two ────────────
 *
 * A month is the window that unlocks the honest comparison — see
 * `isWholeCalendarMonth` — so it is offered first and as whole months. The
 * free range underneath is the escape hatch, and choosing it is what makes an
 * extensive figure carry `comparable: false` against a period of a different
 * length. Both write the same two keys, so there is one thing to read out of
 * the URL and no third state where they disagree.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition, type FormEvent } from 'react'

import {
  COMPARISON_LABEL,
  COMPARISON_MODES,
  REPORT_PARAM_KEYS,
} from '@/app/(app)/reports/_lib/period'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import type { ComparisonMode, MetricRange } from '@/lib/metrics'

export type PeriodBarProps = {
  /** Where the form submits. The screen owns its own path. */
  action: string
  range: MetricRange
  comparison: ComparisonMode
  months: readonly { range: MetricRange; label: string }[]
  /** Set when the URL asked for a window that could not be used. */
  issue?: string | null
}

/** The value a month option carries, so one control writes both dates. */
function monthValue(range: MetricRange): string {
  return `${range.start}|${range.end}`
}

export function PeriodBar({
  action,
  range,
  comparison,
  months,
  issue,
}: PeriodBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const selectedMonth = months.find(
    (month) =>
      month.range.start === range.start && month.range.end === range.end,
  )

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const data = new FormData(event.currentTarget)
    const next = new URLSearchParams()

    // The explicit dates win when they are both filled in. A person who typed
    // a range and left the month select alone means the range — the select
    // still shows whatever month it showed, and silently preferring it would
    // discard what they typed.
    const from = String(data.get(REPORT_PARAM_KEYS.from) ?? '')
    const to = String(data.get(REPORT_PARAM_KEYS.to) ?? '')
    const month = String(data.get('month') ?? '')

    if (from.length > 0 && to.length > 0) {
      next.set(REPORT_PARAM_KEYS.from, from)
      next.set(REPORT_PARAM_KEYS.to, to)
    } else if (month.includes('|')) {
      const [start, end] = month.split('|')
      next.set(REPORT_PARAM_KEYS.from, start)
      next.set(REPORT_PARAM_KEYS.to, end)
    }

    const compare = String(data.get(REPORT_PARAM_KEYS.compare) ?? '')
    if (compare.length > 0) next.set(REPORT_PARAM_KEYS.compare, compare)

    const query = next.toString()
    startTransition(() => {
      router.push(query.length > 0 ? `${action}?${query}` : action)
    })
  }

  const isFiltered = searchParams.toString().length > 0

  return (
    <form
      method="get"
      action={action}
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label="בחירת תקופת הדוח"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="חודש" description="חודש מלא מאפשר השוואה מדויקת">
          <Select
            name="month"
            defaultValue={selectedMonth ? monthValue(selectedMonth.range) : ''}
          >
            <option value="">טווח מותאם</option>
            {months.map((month) => (
              <option
                key={monthValue(month.range)}
                value={monthValue(month.range)}
              >
                {month.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="מתאריך">
          <TextInput
            type="date"
            name={REPORT_PARAM_KEYS.from}
            defaultValue={selectedMonth ? '' : range.start}
          />
        </Field>

        <Field
          label="עד תאריך"
          description="לא כולל — היום הזה שייך לתקופה הבאה"
          error={issue ?? undefined}
        >
          <TextInput
            type="date"
            name={REPORT_PARAM_KEYS.to}
            defaultValue={selectedMonth ? '' : range.end}
          />
        </Field>

        <Field label="השוואה">
          <Select name={REPORT_PARAM_KEYS.compare} defaultValue={comparison}>
            {COMPARISON_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {COMPARISON_LABEL[mode]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'מחשב…' : 'הצג דוח'}
        </Button>

        {isFiltered && (
          <Button href={action} variant="ghost" size="sm">
            חזרה לחודש הנוכחי
          </Button>
        )}

        <span aria-live="polite" className="sr-only">
          {pending ? 'מחשב את הדוח לתקופה שנבחרה' : ''}
        </span>
      </div>
    </form>
  )
}
