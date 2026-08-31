import { ListSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the two reads run.
 *
 * Three day-groups of five rows, which is the shape the feed takes. No summary
 * cards, because the screen has none — drawing them would promise a row of
 * figures that never arrives.
 */
export default function ActivityLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-20 w-full rounded-lg" />

      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-6 shadow-soft sm:p-7"
        >
          <Skeleton className="h-6 w-32" />
          <ListSkeleton
            rows={5}
            columns={2}
            label={index === 0 ? 'טוען את הפעילות האחרונה' : ''}
          />
        </div>
      ))}
    </div>
  )
}
