'use client'

/**
 * Filter the stock list by the state an item is in.
 *
 * `"use client"` because it navigates, and a real `<form method="get">` so it
 * works before hydration and with JavaScript disabled — the browser's own GET
 * submission produces the same query string the handler builds. The same
 * decision every other filter in this product made, for the same reason: a
 * filtered list is a link somebody sends, and a filter held in component state
 * produces a link that opens on somebody else's screen showing something else.
 *
 * The key is `state` and not `status`, because that is the column's name in
 * 0011 and an inventory item does not have a status. The states are the frozen
 * tuple from `@/lib/contracts/states` and the labels are the ones
 * `inventory-state.tsx` owns — a list retyped here would drift from the enum
 * the moment one was added, and the filter would quietly stop being able to
 * find `laundry`, which is where half the towels are.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition, type FormEvent } from 'react'

import { INVENTORY_STATE_KEY } from '@/app/(app)/inventory/_lib/filters'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import type { InventoryState } from '@/lib/contracts/states'

import { INVENTORY_STATE_LABEL } from './inventory-state'

export function InventoryFilterBar({
  path,
  states,
  selected,
}: {
  path: string
  states: readonly InventoryState[]
  selected: InventoryState | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const value = new FormData(event.currentTarget).get(INVENTORY_STATE_KEY)
    const next = new URLSearchParams()

    // An empty value is dropped rather than written as `?state=`, so a cleared
    // filter produces a clean URL and "is anything filtered" stays readable
    // from the address bar.
    if (typeof value === 'string' && value.trim().length > 0) {
      next.set(INVENTORY_STATE_KEY, value.trim())
    }

    const query = next.toString()
    startTransition(() => {
      router.push(query.length > 0 ? `${path}?${query}` : path)
    })
  }

  const isFiltered = searchParams.get(INVENTORY_STATE_KEY) !== null

  return (
    <form
      method="get"
      action={path}
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label="סינון מלאי"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="מצב הפריט">
          <Select name={INVENTORY_STATE_KEY} defaultValue={selected ?? ''}>
            <option value="">כל המצבים</option>
            {states.map((state) => (
              <option key={state} value={state}>
                {INVENTORY_STATE_LABEL[state]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'מסנן…' : 'סנן'}
        </Button>

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
