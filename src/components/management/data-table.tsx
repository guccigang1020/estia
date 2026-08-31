/**
 * The table the management screens are made of.
 *
 * Four screens here are genuinely tabular — a roster, an inventory list, a
 * role catalogue, an audit trail — and a tabular thing rendered as a stack of
 * cards is harder to scan, not friendlier. So it is a real `<table>`, with a
 * real `<caption>`, so a screen reader announces what it is about to read.
 *
 * TWO THINGS THAT ARE NOT DECORATION.
 *
 *   · The caption is required and visually hidden. A table with six columns
 *     and no accessible name is a wall of cells to anybody not looking at it.
 *   · The horizontal scroll lives on the wrapper, never on the page. This
 *     product is used one-handed on a phone in a car park; a body that scrolls
 *     sideways loses the reader their place in the whole screen rather than in
 *     one table.
 *
 * RTL: no `left`/`right` anywhere. `text-start`, `ps`/`pe`, and the browser
 * mirrors the column order from the document direction.
 */

import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

export type DataTableProps = {
  /** Announced instead of shown. Says what the rows are, not "table". */
  caption: string
  /** Column headings, in document order. */
  columns: readonly string[]
  children: ReactNode
  className?: string
}

export function DataTable({
  caption,
  columns,
  children,
  className,
}: DataTableProps) {
  return (
    <div
      className={cn(
        'w-full overflow-x-auto rounded-xl border border-border bg-surface shadow-soft',
        className,
      )}
    >
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border bg-muted">
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="px-4 py-3 text-start text-xs font-semibold tracking-wide text-muted-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  )
}

/** One body row. */
export function Row({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('align-top', className)} {...props} />
}

/**
 * The first cell of a row, which names the row.
 *
 * `scope="row"` is what lets a screen reader say "סוויטת הזית · מחיר בסיס ·
 * ₪1,150" instead of reading a bare number out of the fifth column.
 */
export function RowHeader({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="row"
      className={cn(
        'px-4 py-3.5 text-start font-semibold text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function Cell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td className={cn('px-4 py-3.5 text-foreground', className)} {...props} />
  )
}

/**
 * A value this reader is not entitled to.
 *
 * Never a zero, never a dash that could be mistaken for "none recorded". The
 * distinction is the whole reason `redact()` deletes keys rather than blanking
 * them: "there is no deposit on this unit" and "you may not see the deposit"
 * are different facts, and a screen that renders both as `—` has thrown away
 * the one the reader needs.
 */
export function Withheld({ label = 'מוסתר' }: { label?: string }) {
  return (
    <span className="text-xs font-medium text-muted-foreground" dir="rtl">
      {label}
    </span>
  )
}
