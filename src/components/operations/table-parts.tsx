/**
 * The cells the four operations tables share.
 *
 * Lifted out of the first table rather than copied into the fourth. They carry
 * one decision each and it is the same decision every time: `Th` and `Td` take
 * an `align` because a money or a quantity column is read at the inline end
 * while a name is read at the start, and `Cell` is the phone rendering's
 * `<dt>/<dd>` pair so the small screen keeps the label beside the value instead
 * of dropping it.
 *
 * No `"use client"`: text in, markup out.
 */

import type { ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

/**
 * What a screen prints where a value exists and this reader may not see it.
 *
 * The same sentence the bookings and finance tables use. A blank cell reads as
 * "there is nothing here", which is a different and false statement.
 */
export const WITHHELD = 'לא זמין לצפייה'

export function Th({
  children,
  align = 'start',
}: {
  children: ReactNode
  align?: 'start' | 'end'
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-3 font-semibold',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  align = 'start',
  className,
}: {
  children: ReactNode
  align?: 'start' | 'end'
  className?: string
}) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-top',
        align === 'end' ? 'text-end' : 'text-start',
        className,
      )}
    >
      {children}
    </td>
  )
}

/** One labelled value in the phone rendering. */
export function Cell({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}

/** An absence that is real — nothing was recorded — rather than withheld. */
export function Absent({ label = '–' }: { label?: string }) {
  return <span className="text-muted-foreground">{label}</span>
}
