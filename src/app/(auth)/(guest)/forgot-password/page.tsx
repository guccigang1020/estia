import type { Metadata } from 'next'

import { AuthCard, AuthLink } from '@/components/auth/auth-card'
import { authErrorMessageForCode } from '@/lib/supabase/auth-errors'

import { initialStateWithMessage } from '../../_lib/form-state'
import { firstParam, type SearchParams } from '../../_lib/search-params'
import { ForgotPasswordForm } from './forgot-password-form'

export const metadata: Metadata = { title: 'איפוס סיסמה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT.
 *
 * `?error=` lands here when a RECOVERY link fails in `/auth/callback` — an
 * expired reset link being the usual reason. Sending that failure to this
 * screen rather than to sign-in matters: this is the page that can issue a new
 * link, so the error arrives next to its own remedy.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const errorMessage = authErrorMessageForCode(firstParam(params.error))

  return (
    <AuthCard
      title="שכחתם סיסמה?"
      description="הזינו את כתובת האימייל שלכם ונשלח אליה קישור לבחירת סיסמה חדשה."
      footer={
        <span>
          נזכרתם? <AuthLink href="/sign-in">חזרה לכניסה</AuthLink>
        </span>
      }
    >
      <ForgotPasswordForm
        initialState={initialStateWithMessage(errorMessage, 'error')}
      />
    </AuthCard>
  )
}
