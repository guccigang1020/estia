'use client'

/**
 * The days the board covers, chosen.
 *
 * `"use client"` because it navigates: submitting pushes the window into the
 * URL and lets the server component re-query. The window is never held in
 * component state, so a board is a link somebody can send and the back button
 * undoes a change of week the way a person expects.
 *
 * A real `<form method="get">` with real named controls, so it works before
 * hydration and with JavaScript disabled. The handler makes it a client-side
 * navigation, not a functioning control.
 *
 * The "עד" field is labelled as exclusive, because it is: the window is
 * `[from, to)` like every other range in the product, and a board whose last
 * day silently vanished would be a rota somebody turned up for on the wrong
 * morning.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition, type FormEvent } from 'react'

import { HORIZON_PARAM_KEYS } from '@/app/(app)/preparation/_lib/horizon'
import type { Horizon } from '@/app/(app)/preparation/_lib/horizon'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'

const ACTION = '/preparation'

export function HorizonBar({
  horizon,
  issue,
}: {
  horizon: Horizon
  issue?: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const data = new FormData(event.currentTarget)
    const next = new URLSearchParams()

    for (const key of Object.values(HORIZON_PARAM_KEYS)) {
      const value = data.get(key)
      if (typeof value === 'string' && value.trim().length > 0) {
        next.set(key, value.trim())
      }
    }

    const query = next.toString()
    startTransition(() => {
      router.push(query.length > 0 ? `${ACTION}?${query}` : ACTION)
    })
  }

  const isFiltered = searchParams.toString().length > 0

  return (
    <form
      method="get"
      action={ACTION}
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label="בחירת טווח הימים"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="מתאריך" description="כולל">
          <TextInput
            type="date"
            name={HORIZON_PARAM_KEYS.from}
            defaultValue={horizon.from}
          />
        </Field>

        <Field
          label="עד תאריך"
          description="לא כולל — היום הזה כבר שייך לטווח הבא"
          error={issue ?? undefined}
        >
          <TextInput
            type="date"
            name={HORIZON_PARAM_KEYS.to}
            defaultValue={horizon.to}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'טוען…' : 'הצג טווח'}
        </Button>

        {isFiltered && (
          <Button href={ACTION} variant="ghost" size="sm">
            חזרה לשבוע הקרוב
          </Button>
        )}

        <span aria-live="polite" className="sr-only">
          {pending ? 'טוען את לוח ההכנות לטווח שנבחר' : ''}
        </span>
      </div>
    </form>
  )
}
