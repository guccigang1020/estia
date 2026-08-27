'use client'

import { useActionState } from 'react'

import { FormAlert } from '@/components/auth/form-alert'
import { SubmitButton } from '@/components/auth/submit-button'
import { TextField } from '@/components/auth/text-field'

import { magicLinkAction } from '../../actions'
import type { AuthFormState } from '../../_lib/form-state'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT.
 *
 * The success message is the same sentence whether or not an account exists,
 * so the form STAYS on screen underneath it. Re-sending is a legitimate thing
 * to want — mail is slow and spam folders are real — and because the response
 * never varies, submitting repeatedly reveals nothing that one submission did
 * not. Supabase's own send limits cap the abuse. Sign-up is the opposite case
 * and does replace its form: creating an account twice is not the same as
 * asking for a second copy of an email.
 */
export function MagicLinkForm({
  next,
  initialState,
}: {
  next: string
  initialState: AuthFormState
}) {
  const [state, formAction, isPending] = useActionState(
    magicLinkAction,
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

      <SubmitButton
        label={sent ? 'שליחה חוזרת' : 'שליחת קישור כניסה'}
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
