'use client'

import { useId, useState, type ComponentProps } from 'react'

import { cn } from '@/components/ui/cn'

import { FIELD_BASE } from './text-field'

/**
 * A password input with a show/hide toggle.
 *
 * The toggle is not decoration: a Hebrew-speaking user typing a Latin password
 * on a Hebrew keyboard layout has no way to notice the layout is wrong until
 * the form rejects them, and "wrong password" is then a lie. Being able to see
 * the value is the difference between fixing it and being locked out.
 *
 * The toggle button is `tabIndex={-1}` on purpose — keyboard users tab from
 * the password straight to submit, and the button is still reachable by
 * clicking or by screen-reader navigation, where its `aria-pressed` state and
 * Hebrew label describe exactly what it does.
 */

export type PasswordFieldProps = {
  id: string
  label: string
  hint?: string
  error?: string
} & Omit<ComponentProps<'input'>, 'id' | 'className' | 'type'>

export function PasswordField({
  id,
  label,
  hint,
  error,
  ...props
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  const toggleId = useId()

  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy =
    [hintId, errorId, toggleId].filter(Boolean).join(' ') || undefined

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

      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          dir="ltr"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            FIELD_BASE,
            'text-right ps-11',
            error ? 'border-danger' : 'border-border-strong',
          )}
          {...props}
        />

        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-controls={id}
          className={
            'absolute inset-y-0 start-0 flex w-11 items-center justify-center ' +
            'rounded-md text-muted-foreground transition-colors hover:text-foreground'
          }
        >
          <span className="sr-only">
            {visible ? 'הסתרת הסיסמה' : 'הצגת הסיסמה'}
          </span>
          <EyeIcon crossed={visible} />
        </button>

        <span id={toggleId} className="sr-only">
          יש כפתור להצגת הסיסמה בתחילת השדה.
        </span>
      </div>

      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
      aria-hidden="true"
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
      {crossed ? <path d="m4 20 16-16" /> : null}
    </svg>
  )
}
