import type { ComponentProps } from 'react'

import { cn } from '@/components/ui/cn'

/**
 * Loading states that keep their shape.
 *
 * A spinner says "wait"; a skeleton says "a table of six bookings is arriving,
 * and it will sit exactly here". The second one stops the layout jumping under
 * a thumb on a phone, which is the environment this product is actually used
 * in — an owner checking tonight's arrivals in a car park.
 *
 * Accessibility: the bars are `aria-hidden`, because a screen reader gains
 * nothing from a description of grey rectangles. Each composite instead
 * exposes one polite status with a real sentence, and marks itself `aria-busy`
 * so the loading is announced once rather than fifteen times.
 *
 * Motion: `motion-reduce:animate-none` on every animated element. `globals.css`
 * already neutralises durations under `prefers-reduced-motion`, but a pulse
 * flattened to 0.01ms is a flicker, and removing the animation outright is the
 * behaviour someone with vestibular sensitivity actually asked for.
 */

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-muted motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  )
}

/**
 * The one announcement a loading region makes.
 *
 * An empty label renders nothing at all. That is how a composite made of other
 * skeletons stays down to a single announcement instead of five overlapping
 * status regions all saying "loading" at once.
 */
function LoadingStatus({ label }: { label: string }) {
  if (label.length === 0) return null

  return (
    <span role="status" className="sr-only">
      {label}
    </span>
  )
}

/* --------------------------------------------------------------- pieces -- */

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          // The last line of a paragraph is short. Matching that is the
          // difference between a placeholder and a convincing one.
          className={cn('h-3.5', index === lines - 1 ? 'w-2/5' : 'w-full')}
        />
      ))}
    </div>
  )
}

/** Mirrors a `Field`: label, control, and room for the description line. */
export function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="h-11 w-full rounded-lg" />
      <Skeleton className="h-3 w-40" />
    </div>
  )
}

/** Mirrors `Card`: same radius, same padding, same internal rhythm. */
export function CardSkeleton({
  lines = 2,
  className,
  label = 'טוען כרטיס',
}: {
  lines?: number
  className?: string
  label?: string
}) {
  return (
    <div
      aria-busy="true"
      className={cn(
        'flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7',
        className,
      )}
    >
      <LoadingStatus label={label} />
      <Skeleton className="h-11 w-11 rounded-full" />
      <Skeleton className="h-5 w-1/2" />
      <SkeletonText lines={lines} />
    </div>
  )
}

/**
 * Mirrors a list or table. `columns` is what makes it a table skeleton rather
 * than a generic stack — a four-column bookings table must not resolve into a
 * layout the placeholder never suggested.
 */
export function ListSkeleton({
  rows = 5,
  columns = 3,
  withHeader = true,
  className,
  label = 'טוען רשימה',
}: {
  rows?: number
  columns?: number
  withHeader?: boolean
  className?: string
  label?: string
}) {
  return (
    <div
      aria-busy="true"
      className={cn(
        'w-full overflow-hidden rounded-xl border border-border bg-surface shadow-soft',
        className,
      )}
    >
      <LoadingStatus label={label} />

      {withHeader && (
        <div className="flex items-center gap-4 border-b border-border bg-muted px-5 py-3.5">
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton
              key={index}
              className={cn('h-3', index === 0 ? 'w-40' : 'w-24')}
            />
          ))}
        </div>
      )}

      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div key={rowIndex} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            {Array.from({ length: Math.max(columns - 1, 0) }, (_, cell) => (
              <Skeleton
                key={cell}
                className="hidden h-3.5 w-20 shrink-0 sm:block"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The route-level placeholder: page title, a row of summary cards, then the
 * main list. It is the shape of a module screen in this product, which is why
 * `src/app/loading.tsx` can use it directly.
 */
export function PageSkeleton({
  label = 'טוען את הדף',
  className,
}: {
  label?: string
  className?: string
}) {
  return (
    <div
      aria-busy="true"
      className={cn(
        'mx-auto flex w-full max-w-shell flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14 lg:px-10',
        className,
      )}
    >
      <LoadingStatus label={label} />

      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      {/* Silenced on purpose: the page-level status above already said it, and
          four more would be four more interruptions for the same fact. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <CardSkeleton lines={1} label="" />
        <CardSkeleton lines={1} label="" />
        <CardSkeleton lines={1} label="" />
      </div>

      <ListSkeleton rows={6} columns={4} label="" />
    </div>
  )
}
