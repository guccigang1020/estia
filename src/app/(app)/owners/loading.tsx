import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the register loads.
 *
 * A stack of short rows, because that is what lands: one line per owner with a
 * name, a property badge and an amount. A table placeholder resolving into rows
 * makes the layout jump exactly where the reader's eye already is.
 *
 * One announcement for the whole region, so a screen reader hears "טוען את
 * רשימת בעלי הנכסים" once rather than once per row.
 */
export default function OwnersLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only" role="status">
          טוען את רשימת בעלי הנכסים
        </span>
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-4 shadow-soft"
          >
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-24" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-6 w-28 rounded-full" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
