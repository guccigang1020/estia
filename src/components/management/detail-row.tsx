/**
 * A label and its value, inside a `<dl>`.
 *
 * The properties card already draws this shape and the management screens draw
 * it four more times. It is a `dt`/`dd` pair rather than two spans because
 * that is what it is: the label names the value, and a screen reader that is
 * told so can read the pair together.
 *
 * The caller supplies the surrounding `<dl>` — `DetailList` below — because a
 * component that renders its own list cannot be used twice inside one.
 */

import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

export function DetailList({ className, ...props }: ComponentProps<'dl'>) {
  return (
    <dl className={cn('flex flex-col gap-2 text-sm', className)} {...props} />
  )
}

export function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-medium text-foreground">
        {children}
      </dd>
    </div>
  )
}
