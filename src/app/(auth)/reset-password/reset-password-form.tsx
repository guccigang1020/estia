'use client'

import { useActionState } from 'react'

import { FormAlert } from '@/components/auth/form-alert'
import { PasswordField } from '@/components/auth/password-field'
import { SubmitButton } from '@/components/auth/submit-button'

import { resetPasswordAction } from '../actions'
import { INITIAL_STATE, MIN_PASSWORD_LENGTH } from '../_lib/form-state'

/** EXECUTION CONTEXT — CLIENT COMPONENT. */
export function ResetPasswordForm() {
  const [state, formAction, isPending] = useActionState(
    resetPasswordAction,
    INITIAL_STATE,
  )

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.message ? (
        <FormAlert
          tone="error"
          message={state.message}
          attempt={state.attempt}
        />
      ) : null}

      <PasswordField
        id="password"
        name="password"
        label="סיסמה חדשה"
        hint={`לפחות ${MIN_PASSWORD_LENGTH} תווים.`}
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        error={state.fieldErrors.password}
      />

      <PasswordField
        id="confirmPassword"
        name="confirmPassword"
        label="אימות הסיסמה החדשה"
        autoComplete="new-password"
        required
        error={state.fieldErrors.confirmPassword}
      />

      <SubmitButton
        label="שמירת הסיסמה"
        pendingLabel="שומרים…"
        pending={isPending}
      />

      <p className="text-xs text-muted-foreground">
        לאחר השמירה תנותקו מכל שאר המכשירים שבהם החשבון פתוח.
      </p>
    </form>
  )
}
