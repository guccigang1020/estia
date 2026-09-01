import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while one plan loads.
 *
 * A header card and a run of section cards, which is the shape the page
 * actually resolves into. A generic list skeleton would promise rows and then
 * produce cards, which is precisely the jump a skeleton exists to prevent.
 *
 * One announcement for the whole region, so a screen reader hears "טוען את
 * תוכנית ההכנה" once rather than once per card.
 */
export default function BookingPreparationLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-shell flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10 lg:px-8"
    >
      <p role="status" className="sr-only">
        טוען את תוכנית ההכנה
      </p>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft">
        <Skeleton className="h-5 w-2/5" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, cell) => (
            <Skeleton key={cell} className="h-10 w-full" />
          ))}
        </div>
      </div>

      {Array.from({ length: 3 }, (_, card) => (
        <div
          key={card}
          className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft"
        >
          <Skeleton className="h-5 w-1/3" />
          {Array.from({ length: 3 }, (_, row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </div>
      ))}
    </div>
  )
}
