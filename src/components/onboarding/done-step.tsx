'use client'

/**
 * Step four: the handover.
 *
 * This is where `organizations.status` moves from `onboarding` to `active`,
 * and it is the only place that does it. Setting it back in step one would
 * have made the column decorative — it becomes true here because there is now
 * an organization, a property and a unit that can be sold.
 *
 * Then the person leaves, and where they land matters. Somebody who arrived
 * from a deep link — a booking someone shared with them, an invoice — goes
 * back to it. Everybody else goes to the dashboard, which now has a real
 * workspace behind it instead of an empty state apologising for one.
 *
 * `next` was already validated on the server (`safeNextPath`) and is validated
 * again here before it is used. A `?next=` that accepts `//evil.example` turns
 * this screen into an open redirect that borrows the product's credibility.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { completeOnboardingAction } from '@/app/(app)/onboarding/_lib/actions'
import { safeNextPath } from '@/app/(app)/onboarding/_lib/schema'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

export function DoneStep({
  workspaceName,
  propertyName,
  next,
}: {
  workspaceName: string
  propertyName: string | null
  next: string | null
}) {
  const router = useRouter()
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const finish = useAsyncAction<void>()

  const destination = safeNextPath(next) ?? '/dashboard'
  const returning = destination !== '/dashboard'

  return (
    <div className="flex flex-col gap-6">
      {failure && <ActionError error={failure} />}

      <div className="flex flex-col gap-3">
        <p className="text-foreground">
          <span className="font-semibold">{workspaceName}</span> מוכן לעבודה.
          {propertyName && (
            <>
              {' '}
              הנכס <span className="font-semibold">{propertyName}</span> קיים,
              ויש בו יחידה אחת שאפשר להזמין.
            </>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          מכאן אפשר להוסיף עוד יחידות ונכסים, להזמין את הצוות, ולפתוח את ההזמנה
          הראשונה. שום דבר במסכים לא נוצר לדוגמה — כל מה שתראה הוא מה שהזנת.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {returning
            ? 'נחזיר אותך לדף שממנו הגעת.'
            : 'נעביר אותך למסך הבית של מרחב העבודה.'}
        </p>
        <Button
          type="button"
          disabled={finish.pending}
          onClick={() => {
            if (finish.pending) return
            setFailure(null)

            void finish.run(async () => {
              const result = await completeOnboardingAction()
              if (!result.ok) {
                setFailure(result.error)
                return
              }
              router.replace(destination)
              // The shell above this route renders from the workspace context,
              // which the completion just changed.
              router.refresh()
            })
          }}
        >
          {finish.pending
            ? 'פותח את מרחב העבודה…'
            : returning
              ? 'חזרה לדף שביקשת'
              : 'כניסה למסך הבית'}
        </Button>
      </div>

      <span aria-live="polite" className="sr-only">
        {finish.pending ? 'פותח את מרחב העבודה' : ''}
      </span>
    </div>
  )
}
