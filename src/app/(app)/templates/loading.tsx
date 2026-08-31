import { Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * This screen reads no table, so the only wait is the shell resolving who is
 * signed in — brief, and usually invisible. The placeholder exists anyway
 * because the alternative during that moment is the previous screen frozen
 * under a navigation that has already happened, and it draws the shape that
 * actually lands: two category headings above tall cards, not a table.
 */
export default function TemplatesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <span className="sr-only" role="status">
        טוען את ספריית התבניות
      </span>

      {Array.from({ length: 2 }, (_, section) => (
        <div key={section} aria-busy="true" className="flex flex-col gap-4">
          <Skeleton className="h-6 w-40" />
          {Array.from({ length: 2 }, (_, card) => (
            <div
              key={card}
              className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6"
            >
              <Skeleton className="h-6 w-64" />
              <Skeleton className="h-4 w-full max-w-prose" />
              <div className="flex flex-col gap-2 border-y border-border py-4">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-56" />
              </div>
              <Skeleton className="h-4 w-3/4" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
