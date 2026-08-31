import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the query runs.
 *
 * Three figures over a six-column table, and a second, shorter list beneath it
 * for the movements — because that is the shape of this screen, and a
 * placeholder that draws one list where the page has two makes the page jump
 * twice.
 */
export default function InventoryLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-24" />
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

      <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-3 sm:p-5">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>

      <ListSkeleton rows={6} columns={6} label="טוען את רשימת המלאי" />

      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-32" />
        <ListSkeleton
          rows={4}
          columns={2}
          withHeader={false}
          label="טוען את תנועות המלאי"
        />
      </div>
    </div>
  )
}
