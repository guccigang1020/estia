import { CardSkeleton, Skeleton } from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * Cards, because the screen is cards: one per agency, each holding its money,
 * its agreements and its people. Two of them, which is what a small business's
 * network looks like — a ten-card placeholder resolving into one card is a
 * screen that appears to lose data as it loads.
 */
export default function AgenciesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <div className="flex flex-col gap-5">
        <CardSkeleton lines={5} label="טוען את רשימת הסוכנויות" />
        <CardSkeleton lines={5} label="טוען את רשימת הסוכנויות" />
      </div>
    </div>
  )
}
