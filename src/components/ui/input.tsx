'use client'

/**
 * `"use client"` because every control here reads the surrounding `Field`
 * through context to pick up its id, its `aria-describedby` and its invalid
 * flag. Context is a client concern; the alternative — repeating those three
 * attributes at every call site — is the version that rots.
 *
 * RTL: no control below contains `left` or `right`. Padding, icon placement
 * and text alignment are all logical (`ps`/`pe`, `start`/`end`, `text-start`),
 * so a Latin-named unit typed into a Hebrew form still lands correctly.
 */

import { useId, type ComponentProps } from 'react'

import { cn } from './cn'
import { useFieldControlProps, useFieldInvalid } from './field'

const CONTROL =
  'w-full rounded-lg border bg-surface px-3.5 py-2.5 text-start text-[0.9375rem] text-foreground ' +
  'transition-colors duration-150 placeholder:text-muted-foreground ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70'

/** Border is the redundant signal; `aria-invalid` from `Field` is the message. */
function borderFor(invalid: boolean): string {
  return invalid ? 'border-danger' : 'border-border-strong'
}

export function TextInput({ className, ...props }: ComponentProps<'input'>) {
  const field = useFieldControlProps()
  const invalid = useFieldInvalid()

  return (
    <input
      type="text"
      {...field}
      className={cn(CONTROL, borderFor(invalid), 'h-11', className)}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  const field = useFieldControlProps()
  const invalid = useFieldInvalid()

  return (
    <textarea
      rows={4}
      {...field}
      className={cn(
        CONTROL,
        borderFor(invalid),
        'min-h-24 resize-y',
        className,
      )}
      {...props}
    />
  )
}

export function Select({
  className,
  children,
  ...props
}: ComponentProps<'select'>) {
  const field = useFieldControlProps()
  const invalid = useFieldInvalid()

  return (
    <div className="relative">
      <select
        {...field}
        className={cn(
          CONTROL,
          borderFor(invalid),
          // `pe-10` leaves room for the chevron at the inline end, which is the
          // left edge in Hebrew and the right edge if this product is ever run
          // in a LTR locale. `appearance-none` removes the platform arrow that
          // would otherwise sit at the wrong edge in RTL on some browsers.
          'h-11 appearance-none pe-10',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 end-3.5 flex items-center text-muted-foreground"
      >
        <ChevronIcon />
      </span>
    </div>
  )
}

export type CheckboxProps = {
  label: string
  description?: string
  error?: string
} & Omit<ComponentProps<'input'>, 'type'>

/**
 * A checkbox labels itself: the text belongs after the box, not above it, so it
 * does not sit inside `Field`. It still wires description and error by id, and
 * still announces its error rather than only colouring it.
 */
export function Checkbox({
  label,
  description,
  error,
  id,
  className,
  ...props
}: CheckboxProps) {
  // Both hooks run unconditionally; `??` only picks between their results.
  const fallbackId = useId()
  const fieldProps = useFieldControlProps()
  const controlId = id ?? fieldProps.id ?? fallbackId
  const descriptionId = description ? `${controlId}-description` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="flex w-full flex-col gap-1.5 text-start">
      <div className="flex items-start gap-2.5">
        <input
          id={controlId}
          type="checkbox"
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(
            'mt-0.5 size-5 shrink-0 rounded-xs border accent-primary',
            error ? 'border-danger' : 'border-border-strong',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            'disabled:cursor-not-allowed disabled:opacity-70',
            className,
          )}
          {...props}
        />
        <label
          htmlFor={controlId}
          className="text-[0.9375rem] leading-snug text-foreground"
        >
          {label}
        </label>
      </div>

      {description && (
        // Indented to the label, not the box, using a logical margin.
        <p id={descriptionId} className="ms-7.5 text-xs text-muted-foreground">
          {description}
        </p>
      )}

      {error && (
        <p
          id={errorId}
          role="alert"
          className="ms-7.5 text-xs font-medium text-danger"
        >
          {error}
        </p>
      )}
    </div>
  )
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="size-4"
    >
      <path d="m5.5 8 4.5 4.5L14.5 8" />
    </svg>
  )
}
