import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the dry run runs.
 *
 * Not `PageSkeleton` and not `ListSkeleton`: this screen is a four-figure panel
 * above a stack of tall cards, and a table placeholder resolving into cards
 * makes the layout jump exactly where the reader's eye already is. Four figures
 * and three cards, because that is what lands.
 *
 * One announcement for the whole region, so a screen reader hears "מריץ את
 * ההדמיה על הנתונים" once rather than once per card.
 */
export default function AutomationsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div
        aria-busy="true"
        className="flex flex-col gap-5 rounded-xl border border-border-strong bg-surface p-5 shadow-soft sm:p-6"
      >
        <span className="sr-only" role="status">
          מריץ את ההדמיה על הנתונים
        </span>
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full max-w-prose" />
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-muted p-4 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-7 w-12" />
            </div>
          ))}
        </div>
      </div>

      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6"
        >
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-full max-w-prose" />
          <div className="flex flex-col gap-2 border-y border-border py-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, figure) => (
              <div key={figure} className="flex flex-col gap-2">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-6 w-10" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
