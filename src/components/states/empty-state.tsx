import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/components/ui/cn'

import { EmptyIllustrationArt } from './empty-illustration'
import {
  emptyStateCopy,
  type EmptyIllustration,
  type EmptyModule,
  type EmptyReason,
} from './empty-presets'

/**
 * The composable empty state, and the preset that keeps callers honest.
 *
 * `EmptyState` is the shell: illustration, heading, explanation, one action.
 * `ModuleEmptyState` is what list screens should actually reach for, because
 * it takes the module and the reason and cannot then produce the wrong copy —
 * the "you have never created a booking" screen shown to someone whose filter
 * simply matched nothing is a data-loss scare, and it is the mistake this
 * component exists to prevent.
 *
 * No `"use client"`: nothing here holds state. Actions arrive as nodes.
 */

export type EmptyStateProps = {
  illustration: EmptyIllustration
  title: string
  body: string
  /** The primary action. One is the target; two is already a menu. */
  action?: ReactNode
  secondaryAction?: ReactNode
  /** `h1` when the empty state is the whole page. */
  as?: 'h1' | 'h2' | 'h3'
} & Omit<ComponentProps<'div'>, 'children' | 'title'>

export function EmptyState({
  illustration,
  title,
  body,
  action,
  secondaryAction,
  as: Heading = 'h2',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-prose flex-col items-center gap-5 rounded-xl border border-border bg-surface px-6 py-12 text-center shadow-soft sm:px-10 sm:py-16',
        className,
      )}
      {...props}
    >
      <EmptyIllustrationArt name={illustration} />

      <div className="flex flex-col gap-2.5">
        <Heading className="font-display text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {title}
        </Heading>
        <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>

      {(action || secondaryAction) && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  )
}

export type ModuleEmptyStateProps = {
  module: EmptyModule
  reason: EmptyReason
  /** Shown back to the user when `reason` is `no_results`: "ספטמבר · וילה הגליל". */
  filterSummary?: string
  /**
   * Built from `copy.actionLabel`, which differs by reason: creating a record
   * for a first run, clearing the filter for a filtered list. The render prop
   * makes it impossible to hard-code a "create" button onto a filtered screen.
   */
  renderAction?: (label: string) => ReactNode
  renderSecondaryAction?: (label: string) => ReactNode
  as?: 'h1' | 'h2' | 'h3'
  className?: string
}

export function ModuleEmptyState({
  module,
  reason,
  filterSummary,
  renderAction,
  renderSecondaryAction,
  as,
  className,
}: ModuleEmptyStateProps) {
  const copy = emptyStateCopy({ module, reason, filterSummary })

  return (
    <EmptyState
      illustration={copy.illustration}
      title={copy.title}
      body={copy.body}
      as={as}
      className={className}
      action={renderAction?.(copy.actionLabel)}
      secondaryAction={
        copy.secondaryActionLabel && renderSecondaryAction
          ? renderSecondaryAction(copy.secondaryActionLabel)
          : undefined
      }
    />
  )
}
