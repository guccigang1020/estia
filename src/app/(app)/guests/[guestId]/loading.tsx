import {
  CardSkeleton,
  ListSkeleton,
  Skeleton,
} from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT. What is on screen while the guest loads.
 *
 * Four cards over a stay table, because that is the page underneath. A
 * skeleton that draws a different shape from the page it precedes is a layout
 * that jumps the moment the data lands, which is the thing it exists to
 * prevent.
 *
 * One announcement for the whole region: every piece but the first carries an
 * empty label, so a screen reader hears "טוען את כרטיס האורח" once rather than
 * five times.
 */
export default function GuestDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <Skeleton className="h-4 w-40" />

      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <CardSkeleton lines={6} label="טוען את כרטיס האורח" />
        <CardSkeleton lines={5} label="" />
        <CardSkeleton lines={2} label="" />
        <CardSkeleton lines={2} label="" />
      </div>

      <ListSkeleton rows={4} columns={5} label="" />
    </div>
  )
}
