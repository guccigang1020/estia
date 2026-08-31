/**
 * A statement about the screen itself, rather than about the data on it.
 *
 * Three of the management screens have something true and awkward to say. The
 * audit trail is evidence and cannot be edited from here. The integrations
 * screen has no registry of connections behind it and is reading traffic
 * instead. The roles screen is derived from the catalogue in code, so what it
 * shows is what the engine will actually answer — which is the only reason to
 * trust it.
 *
 * Each of those is a sentence a buyer's technical reviewer will look for, and
 * burying it in a paragraph of body copy is how it stops being read. It gets a
 * box, and the box is deliberately plain: this is not a warning and not an
 * error, it is a caveat that travels with the screen.
 *
 * `tone` has two values and no third. `neutral` states a limit; `strong` marks
 * the one claim on a screen that would be a lie if it were wrong — the audit
 * trail being append-only, above all.
 */

import type { ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

export type NoticeTone = 'neutral' | 'strong'

const TONE: Record<NoticeTone, string> = {
  neutral: 'border-border bg-muted',
  // A brand outline rather than a different fill, so the emphasis survives a
  // brand swap — the same decision `Card`'s `featured` tone makes.
  strong: 'border-primary bg-primary-soft',
}

export type NoticeProps = {
  title: string
  children: ReactNode
  tone?: NoticeTone
}

export function Notice({ title, children, tone = 'neutral' }: NoticeProps) {
  return (
    <section
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border p-4 sm:p-5',
        TONE[tone],
      )}
    >
      <h2
        className={cn(
          'text-sm font-semibold',
          tone === 'strong' ? 'text-primary' : 'text-foreground',
        )}
      >
        {title}
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {children}
      </p>
    </section>
  )
}
