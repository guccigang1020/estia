'use client'

/**
 * Where this migration has got to, and what is not open yet.
 *
 * ── Why it is a Client Component ──────────────────────────────────────────
 *
 * Reachability is a fact about the file held in this tab — whether it parsed,
 * whether a column is mapped, whether a dry run has been computed against the
 * mapping as it stands now. The server cannot know any of that, because the
 * file was deliberately never sent to it. So the rail reads the wizard's state
 * and the current path, and both live in the browser.
 *
 * ── An unreachable step is a sentence, not a grey box ─────────────────────
 *
 * Each item that cannot be opened carries the reason underneath it. A greyed
 * item with no explanation is the thing that makes somebody close the tab: they
 * cannot tell whether they did something wrong or the product is broken.
 *
 * Rendered as an ordered list so a screen reader reads it as the sequence it is,
 * with `aria-current="step"` on the one being looked at.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import {
  MIGRATION_STEPS,
  STEP_PATH,
  STEP_TITLE,
  blockedReason,
  stepFromPath,
  stepIndex,
} from '@/app/(app)/migration/_lib/steps'
import { cn } from '@/components/ui/cn'

import { useMigration } from './wizard-state'

export function StepRail() {
  const pathname = usePathname()
  const current = stepFromPath(pathname)
  const { progress } = useMigration()
  const currentIndex = current === null ? -1 : stepIndex(current)

  return (
    <nav aria-label="שלבי הייבוא">
      <ol className="flex flex-col gap-2">
        {MIGRATION_STEPS.map((step, index) => {
          const blocked = blockedReason(step, progress)
          const active = step === current
          const done = index < currentIndex && blocked === null

          const body = (
            <span className="flex gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  done
                    ? 'bg-success/10 text-success'
                    : active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {index + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">
                  {STEP_TITLE[step]}
                  {/* Stated in words, not only in colour. */}
                  {done && (
                    <span className="text-muted-foreground"> — הושלם</span>
                  )}
                </span>
                {blocked !== null && (
                  <span className="text-xs text-muted-foreground">
                    {blocked}
                  </span>
                )}
              </span>
            </span>
          )

          const className = cn(
            'block rounded-lg border px-3 py-3',
            active
              ? 'border-primary bg-primary-soft'
              : blocked === null
                ? 'border-border bg-surface'
                : 'border-border bg-muted',
          )

          return (
            <li key={step} aria-current={active ? 'step' : undefined}>
              {blocked === null ? (
                <Link href={STEP_PATH[step]} className={className}>
                  {body}
                </Link>
              ) : (
                <div className={className}>{body}</div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
