import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Not `ListSkeleton`: this screen is a stack of documents, not a table of
 * rows, and a placeholder that draws a table jumps into cards the moment the
 * data lands — which is the thing a skeleton exists to prevent. Three cards,
 * because that is roughly what fits above the fold.
 */
export default function InvoicesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        </div>
      </div>

      <div
        role="status"
        aria-label="טוען את רשימת החשבוניות"
        className="flex flex-col gap-5"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <CardSkeleton key={index} lines={4} label="" />
        ))}
      </div>
    </div>
  )
}
