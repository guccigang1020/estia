'use client'

import { useActionState } from 'react'

import { AuthLink } from '@/components/auth/auth-card'
import { FormAlert } from '@/components/auth/form-alert'
import { PasswordField } from '@/components/auth/password-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { TextField } from '@/components/auth/text-field'

import { signInAction } from '../../actions'
import type { AuthFormState } from '../../_lib/form-state'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT.
 *
 * A client component only because `useActionState` needs one. The mutation
 * itself is the Server Action passed in — there is no `fetch` here, and the
 * form has a real `action`, so it submits and works before this JavaScript has
 * loaded.
 *
 * Duplicate submits are blocked by `SubmitButton`, which disables itself from
 * the form's own pending state.
 */
export function SignInForm({
  next,
  initialState,
}: {
  next: string
  initialState: AuthFormState
}) {
  const [state, formAction, isPending] = useActionState(
    signInAction,
    initialState,
  )

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.message ? (
        <FormAlert
          tone={state.status === 'success' ? 'success' : 'error'}
          message={state.message}
          attempt={state.attempt}
        />
      ) : null}

      {/* Validated server-side by `safeRedirectTarget` — never trusted here. */}
      <input type="hidden" name="next" value={next} />

      <TextField
        id="email"
        name="email"
        label="כתובת אימייל"
        type="email"
        autoComplete="username"
        required
        error={state.fieldErrors.email}
      />

      <div className="flex flex-col gap-1.5">
        <PasswordField
          id="password"
          name="password"
          label="סיסמה"
          autoComplete="current-password"
          required
          error={state.fieldErrors.password}
        />
        <div className="text-sm">
          <AuthLink href="/forgot-password">שכחתם את הסיסמה?</AuthLink>
        </div>
      </div>

      <SubmitButton label="כניסה" pendingLabel="מתחברים…" pending={isPending} />

      <p className="text-center text-sm text-muted-foreground">
        <AuthLink href="/magic-link">כניסה עם קישור למייל, בלי סיסמה</AuthLink>
      </p>
    </form>
  )
}
