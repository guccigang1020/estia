'use client'

import { useActionState } from 'react'

import { FormAlert } from '@/components/auth/form-alert'
import { SubmitButton } from '@/components/auth/submit-button'
import { TextField } from '@/components/auth/text-field'

import { forgotPasswordAction } from '../../actions'
import type { AuthFormState } from '../../_lib/form-state'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT.
 *
 * The form stays on screen after a send, for the same reason as the magic-link
 * form: the response is identical whether or not the address has an account,
 * so allowing a re-send costs no information and saves the user who is waiting
 * on a mail that never arrived.
 */
export function ForgotPasswordForm({
  initialState,
}: {
  initialState: AuthFormState
}) {
  const [state, formAction, isPending] = useActionState(
    forgotPasswordAction,
    initialState,
  )
  const sent = state.status === 'success'

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.message ? (
        <FormAlert
          tone={sent ? 'success' : 'error'}
          message={state.message}
          attempt={state.attempt}
        />
      ) : null}

      <TextField
        id="email"
        name="email"
        label="כתובת אימייל"
        type="email"
        autoComplete="username"
        required
        error={state.fieldErrors.email}
      />

      <SubmitButton
        label={sent ? 'שליחה חוזרת' : 'שליחת קישור לאיפוס'}
        pendingLabel="שולחים…"
        pending={isPending}
      />

      {sent ? (
        <p className="text-sm text-muted-foreground">
          לא הגיעה הודעה? בדקו בתיקיית דואר הזבל ואז שלחו שוב.
        </p>
      ) : null}
    </form>
  )
}
