'use client'

import { useActionState } from 'react'

import { FormAlert } from '@/components/auth/form-alert'
import { PasswordField } from '@/components/auth/password-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { TextField } from '@/components/auth/text-field'

import { signUpAction } from '../../actions'
import { INITIAL_STATE, MIN_PASSWORD_LENGTH } from '../../_lib/form-state'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT.
 *
 * On success the form is REPLACED by the confirmation, rather than left on
 * screen underneath it. Leaving a filled-in sign-up form below a "check your
 * email" message invites the user to press the button again, which burns
 * another send against a small hourly quota and invalidates the first link.
 */
export function SignUpForm() {
  const [state, formAction, isPending] = useActionState(
    signUpAction,
    INITIAL_STATE,
  )

  if (state.status === 'success' && state.message) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert
          tone="success"
          message={state.message}
          attempt={state.attempt}
        />
        <p className="text-sm text-muted-foreground">
          לאחר אימות הכתובת תוכלו להיכנס עם האימייל והסיסמה שבחרתם.
        </p>
      </div>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.message ? (
        <FormAlert
          tone="error"
          message={state.message}
          attempt={state.attempt}
        />
      ) : null}

      <TextField
        id="fullName"
        name="fullName"
        label="שם מלא"
        autoComplete="name"
        required
        error={state.fieldErrors.fullName}
      />

      <TextField
        id="email"
        name="email"
        label="כתובת אימייל"
        type="email"
        autoComplete="username"
        required
        error={state.fieldErrors.email}
      />

      <PasswordField
        id="password"
        name="password"
        label="סיסמה"
        hint={`לפחות ${MIN_PASSWORD_LENGTH} תווים.`}
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        error={state.fieldErrors.password}
      />

      <PasswordField
        id="confirmPassword"
        name="confirmPassword"
        label="אימות סיסמה"
        autoComplete="new-password"
        required
        error={state.fieldErrors.confirmPassword}
      />

      <SubmitButton
        label="יצירת חשבון"
        pendingLabel="יוצרים חשבון…"
        pending={isPending}
      />
    </form>
  )
}
