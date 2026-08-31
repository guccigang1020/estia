import {
  CardSkeleton,
  ListSkeleton,
  Skeleton,
} from '@/components/states/skeleton'

/**
 * EXECUTION CONTEXT — ROUTE SEGMENT.
 *
 * The honest-statement banner is a fixed height and is sketched; the four
 * outcome tiles are the shape the page always renders above the list. The
 * discount panel is a card at the bottom whether or not it has rows, so it is
 * sketched too — unlike the agent screens, nothing here appears or disappears
 * on a grant the server has not answered yet.
 */
export default function QuotesLoading() {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full max-w-prose" />
      </div>

      <Skeleton className="h-16 w-full rounded-lg" />

      <div className="rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>

      <ListSkeleton rows={3} columns={3} label="טוען את ההצעות" />

      <CardSkeleton lines={3} label="טוען את בקשות ההנחה" />
    </div>
  )
}
