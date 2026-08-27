import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

import type { ErrorPresentation } from './error-copy'

/**
 * The one way this product shows a failure.
 *
 * It renders an already-resolved `ErrorPresentation` and adds nothing of its
 * own: the decision about what may be said lives in `error-copy.ts`, which is
 * tested. That split is deliberate — a component that also decided the wording
 * would let a caller pass a bare string and quietly reintroduce the "משהו
 * השתבש" screen the charter forbids.
 *
 * No `"use client"`: there are no hooks and no handlers here. The retry control
 * arrives as a node, so this renders from a Server Component, and equally from
 * inside the client-only error boundary in `src/app/error.tsx`.
 */

export type ErrorStateProps = {
  presentation: ErrorPresentation
  /**
   * Sanitised technical text from `technicalDetail()`. Collapsed by default and
   * never a stack trace — see the note in `error-copy.ts`.
   */
  detail?: string
  /** Usually a `<RetryButton>`; omit it when `presentation.canRetry` is false. */
  action?: ReactNode
  secondaryAction?: ReactNode
  /** `h1` when the error replaces the whole page, `h2` when it fills a panel. */
  as?: 'h1' | 'h2' | 'h3'
} & Omit<ComponentProps<'div'>, 'children'>

export function ErrorState({
  presentation,
  detail,
  action,
  secondaryAction,
  as: Heading = 'h2',
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      // `alert` is right here rather than a polite region: an error boundary
      // swaps this in without a navigation, so nothing else would announce it.
      role="alert"
      className={cn(
        'mx-auto flex w-full max-w-prose flex-col items-start gap-5 rounded-xl border border-border bg-surface p-6 text-start shadow-soft sm:p-8',
        className,
      )}
      {...props}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-danger/12 text-danger">
        <AlertIcon />
      </span>

      <div className="flex flex-col gap-2">
        <Heading className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {presentation.title}
        </Heading>
        <p className="text-[0.9375rem] text-muted-foreground">
          {presentation.description}
        </p>
      </div>

      {/* The two questions a user actually has. They are always answered, and
          they are answered in words — the icon is decoration, not the message,
          so nothing here depends on seeing a colour. */}
      <dl className="flex w-full flex-col gap-3 rounded-lg bg-muted px-4 py-3.5">
        <Fact
          label="הנתונים שלך"
          value={presentation.dataOutcomeText}
          tone={presentation.dataOutcome === 'not_saved' ? 'calm' : 'attention'}
        />
        <Fact
          label="ניסיון חוזר"
          value={presentation.retryText}
          tone={presentation.retry === 'safe' ? 'calm' : 'attention'}
        />
      </dl>

      {(action || secondaryAction) && (
        <div className="flex flex-wrap items-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}

      {detail && (
        // `details` gives collapse-by-default, keyboard operation and the right
        // expanded/collapsed announcement without a line of JavaScript.
        <details className="w-full">
          <summary className="w-fit cursor-pointer text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            פרטים טכניים
          </summary>
          <pre
            dir="ltr"
            className="mt-3 max-h-48 overflow-auto rounded-lg bg-muted px-4 py-3 text-start font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
          >
            {detail}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            הפרטים המלאים נשמרו ביומן השרת. אם פנית לתמיכה, מסירת המזהה תקצר את
            הבירור.
          </p>
        </details>
      )}
    </div>
  )
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'calm' | 'attention'
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 shrink-0',
          tone === 'calm' ? 'text-success' : 'text-warning',
        )}
      >
        {tone === 'calm' ? <CheckIcon /> : <AttentionIcon />}
      </span>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-semibold text-foreground">{label}</dt>
        <dd className="text-sm text-muted-foreground">{value}</dd>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- icons -- */
/* Same convention as the marketing page: 24-unit box, stroked with
   currentColor, hidden from assistive technology because every one of them
   sits beside text that already says the same thing. */

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="size-6"
    >
      <path d="M12 8.5v4.5" />
      <path d="M12 16.5h.01" />
      <path d="M10.3 3.9 2.7 17.2A2 2 0 0 0 4.4 20.2h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="size-4"
    >
      <path d="m4 10.5 4 4 8-9" />
    </svg>
  )
}

function AttentionIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="size-4"
    >
      <path d="M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z" />
      <path d="M10 6.6v4.2" />
      <path d="M10 13.6h.01" />
    </svg>
  )
}
