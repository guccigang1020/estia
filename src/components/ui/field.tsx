'use client'

/**
 * `"use client"` for one specific reason: `useId`. The label, the description
 * and the error message have to be wired to the control by id, and generating
 * an id that is stable across server render and hydration is exactly what
 * `useId` is for. Asking every caller to invent unique ids by hand is how
 * `aria-describedby` ends up pointing at nothing.
 */

import { createContext, useContext, useId, type ReactNode } from 'react'

import { cn } from './cn'

type FieldContextValue = {
  controlId: string
  describedBy?: string
  invalid: boolean
  required: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

/** The props a control must spread onto itself to be part of its field. */
export type FieldControlProps = {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: true
  required?: boolean
}

/**
 * Read by every control in `input.tsx`. Returns empty props outside a `Field`,
 * so a bare input still works — it simply carries no wiring, which is the
 * honest outcome rather than a crash.
 */
export function useFieldControlProps(): FieldControlProps {
  const field = useContext(FieldContext)
  if (!field) return {}

  return {
    id: field.controlId,
    'aria-describedby': field.describedBy,
    // `aria-invalid` is what turns a red border into an actual error for a
    // screen reader. The colour is the redundant half, not the primary one.
    'aria-invalid': field.invalid ? true : undefined,
    required: field.required || undefined,
  }
}

/** True when the surrounding field is in an error state, for styling only. */
export function useFieldInvalid(): boolean {
  return useContext(FieldContext)?.invalid ?? false
}

export type FieldProps = {
  label: string
  /** Guidance shown before the control, where it can still prevent the error. */
  description?: string
  /**
   * The validation message. Its presence is what puts the field in an error
   * state — there is no separate `invalid` flag to fall out of sync with it.
   */
  error?: string
  required?: boolean
  children: ReactNode
  className?: string
}

export function Field({
  label,
  description,
  error,
  required = false,
  children,
  className,
}: FieldProps) {
  const controlId = useId()
  const descriptionId = `${controlId}-description`
  const errorId = `${controlId}-error`

  const describedBy =
    [description ? descriptionId : null, error ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined

  return (
    <FieldContext.Provider
      value={{ controlId, describedBy, invalid: Boolean(error), required }}
    >
      <div className={cn('flex w-full flex-col gap-1.5 text-start', className)}>
        <label
          htmlFor={controlId}
          className="flex items-baseline gap-2 text-sm font-medium text-foreground"
        >
          {label}
          {/* Required-ness is a word, not a red asterisk whose meaning the user
              is expected to already know. */}
          {required && (
            <span className="text-xs font-normal text-muted-foreground">
              חובה
            </span>
          )}
        </label>

        {description && (
          <p id={descriptionId} className="text-xs text-muted-foreground">
            {description}
          </p>
        )}

        {children}

        {error && (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-1.5 text-xs font-medium text-danger"
          >
            <ErrorIcon />
            <span>{error}</span>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  )
}

function ErrorIcon() {
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
      className="mt-px size-3.5 shrink-0"
    >
      <path d="M10 2.8a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z" />
      <path d="M10 6.6v4.2" />
      <path d="M10 13.6h.01" />
    </svg>
  )
}
