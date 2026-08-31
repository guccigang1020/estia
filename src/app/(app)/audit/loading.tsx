import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the trail loads.
 *
 * Cards, not a table: an audit event resolves into a sentence with a row of
 * badges, and a table placeholder would promise a shape the screen never
 * takes. One announcement for the whole region.
 */
export default function AuditLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="flex flex-col gap-3">
        <CardSkeleton lines={1} label="טוען את יומן הביקורת" />
        <CardSkeleton lines={1} label="" />
        <CardSkeleton lines={1} label="" />
        <CardSkeleton lines={1} label="" />
        <CardSkeleton lines={1} label="" />
      </div>
    </div>
  )
}
