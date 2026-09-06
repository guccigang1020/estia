/**
 * Forward and back, as links rather than as buttons.
 *
 * A step is a URL, so moving between them is navigation and not a state
 * transition dressed as one: middle-click opens the dry run in a second tab,
 * the browser's own back button does what it says, and a colleague can be sent
 * to the conflict review. A `<button onClick={setStep}>` would take all three
 * away in exchange for nothing.
 *
 * The forward link is rendered as a disabled span when the next step is not
 * open yet, with the reason beside it — never as a link that lands on a screen
 * saying "come back later".
 */

import Link from 'next/link'

import {
  STEP_PATH,
  STEP_TITLE,
  type MigrationStep,
} from '@/app/(app)/migration/_lib/steps'

export function StepNav({
  back,
  forward,
  forwardBlocked,
  children,
}: {
  back?: MigrationStep
  forward?: MigrationStep
  /** Hebrew reason the forward step is closed, or `null` when it is open. */
  forwardBlocked?: string | null
  /** An action that belongs on this step rather than the next one. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
      {children}

      {forward !== undefined &&
        (forwardBlocked === null || forwardBlocked === undefined ? (
          <Link
            href={STEP_PATH[forward]}
            className="inline-flex h-11 items-center justify-center rounded-full bg-primary px-5 text-[0.9375rem] font-medium text-primary-foreground shadow-soft hover:bg-primary/90"
          >
            המשך: {STEP_TITLE[forward]}
          </Link>
        ) : (
          <span className="flex flex-col gap-1">
            <span className="inline-flex h-11 cursor-not-allowed items-center justify-center rounded-full bg-muted px-5 text-[0.9375rem] font-medium text-muted-foreground">
              המשך: {STEP_TITLE[forward]}
            </span>
            <span className="text-xs text-muted-foreground">
              {forwardBlocked}
            </span>
          </span>
        ))}

      {back !== undefined && (
        <Link
          href={STEP_PATH[back]}
          className="inline-flex h-11 items-center justify-center rounded-full px-5 text-[0.9375rem] font-medium text-foreground hover:bg-muted"
        >
          חזרה: {STEP_TITLE[back]}
        </Link>
      )}
    </div>
  )
}
