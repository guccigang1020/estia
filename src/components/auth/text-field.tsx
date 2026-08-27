import type { ComponentProps } from 'react'

import { cn } from '@/components/ui/cn'

/**
 * A labelled text input for the authentication forms.
 *
 * Accessibility is the whole point of the component, so none of it is
 * optional:
 *   - a real `<label htmlFor>`, never a placeholder standing in for one;
 *   - `aria-describedby` wired to the hint AND the error, so a screen reader
 *     announces the reason a field was rejected rather than just "invalid";
 *   - `aria-invalid` only when there is an error to point at;
 *   - the focus ring comes from `:focus-visible` in globals.css and is never
 *     removed here.
 *
 * Direction: the surrounding form is RTL, but an email address or a password
 * is LTR content. The input therefore carries `dir="ltr"` so the characters
 * order correctly, while staying block-aligned to the right so it still reads
 * as part of a Hebrew form.
 */

export const FIELD_BASE =
  'h-11 w-full rounded-md border bg-surface px-3.5 text-[0.9375rem] ' +
  'text-foreground transition-colors placeholder:text-muted-foreground/70 ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

export type TextFieldProps = {
  id: string
  label: string
  hint?: string
  error?: string
} & Omit<ComponentProps<'input'>, 'id' | 'className'>

export function TextField({
  id,
  label,
  hint,
  error,
  type = 'text',
  ...props
}: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>

      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}

      <input
        id={id}
        type={type}
        dir="ltr"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          FIELD_BASE,
          'text-right',
          error ? 'border-danger' : 'border-border-strong',
        )}
        {...props}
      />

      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
