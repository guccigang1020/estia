import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the three reads
 * run.
 *
 * Three figures above three short tables, which is the shape the screen
 * resolves into. `PageSkeleton` would draw one long list and the layout would
 * jump twice.
 */
export default function IntegrationsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-soft"
          >
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-12" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>

      <ListSkeleton rows={3} columns={5} label="טוען את רשימת החיבורים" />
      <ListSkeleton rows={2} columns={5} label="" />
    </div>
  )
}
