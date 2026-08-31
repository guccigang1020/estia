import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the board loads.
 *
 * Not `PageSkeleton` and not `ListSkeleton`: this screen is two sections of
 * cards, not a table, and a placeholder that suggests rows would resolve into
 * a layout it never promised — which is the jump a skeleton exists to prevent.
 *
 * One announcement for the whole region, so a screen reader hears "טוען את לוח
 * ההכנות" once rather than six times.
 */
export default function PreparationLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-shell flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10 lg:px-8"
    >
      <p role="status" className="sr-only">
        טוען את לוח ההכנות
      </p>

      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>

      {Array.from({ length: 2 }, (_, section) => (
        <div key={section} className="flex flex-col gap-3">
          <Skeleton className="h-6 w-40" />
          {Array.from({ length: 3 }, (_, card) => (
            <div
              key={card}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft"
            >
              <Skeleton className="h-5 w-2/5" />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }, (_, cell) => (
                  <Skeleton key={cell} className="h-8 w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
