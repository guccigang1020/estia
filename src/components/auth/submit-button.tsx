'use client'

import { useFormStatus } from 'react-dom'

import { Button } from '@/components/ui/button'

/**
 * The submit control for an authentication form.
 *
 * DUPLICATE-SUBMIT PROTECTION. While a submit is in flight the button is
 * genuinely `disabled`, so a second click cannot reach the server. That
 * matters more than it looks on these particular forms: a double-submitted
 * magic link or password reset burns two of a very small hourly email quota
 * and invalidates the first link with the second.
 *
 * TWO SOURCES OF PENDING, on purpose.
 *
 * `useFormStatus` reads the enclosing `<form>`'s state and needs no
 * cooperation from the parent, which is why it is the default. But the forms
 * driven by `useActionState` already hold an authoritative `isPending`, and
 * passing it explicitly makes the button's state a prop rather than an
 * ambient context lookup — testable in isolation, and immune to a component
 * accidentally being hoisted out of its form during a refactor. Where `pending`
 * is supplied it wins; where it is not (the sign-out form, which has no action
 * state), `useFormStatus` still covers it.
 *
 * The label changes as well as the state, because a spinner alone tells
 * somebody using a screen reader nothing. The spinner is `aria-hidden` and the
 * text carries the meaning.
 */
export function SubmitButton({
  label,
  pendingLabel,
  pending: pendingProp,
}: {
  label: string
  pendingLabel: string
  pending?: boolean
}) {
  const { pending: formPending } = useFormStatus()
  const pending = pendingProp ?? formPending

  return (
    <Button
      type="submit"
      size="lg"
      disabled={pending}
      className="w-full"
      // Announced to assistive technology the moment the form is submitted,
      // rather than only when the response eventually arrives.
      aria-busy={pending}
    >
      {pending ? <Spinner /> : null}
      {pending ? pendingLabel : label}
    </Button>
  )
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-4 animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
