import type { Metadata } from 'next'

import { AuthCard, AuthLink } from '@/components/auth/auth-card'
import { authErrorMessageForCode } from '@/lib/supabase/auth-errors'

import { initialStateWithMessage } from '../../_lib/form-state'
import { safeRedirectTarget } from '../../_lib/redirect-target'
import { firstParam, type SearchParams } from '../../_lib/search-params'
import { SignInForm } from './sign-in-form'

export const metadata: Metadata = { title: 'כניסה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT.
 *
 * Reads the query string, turns it into an opening message, and hands the form
 * a validated `next`. The translation happens here rather than in the client
 * component so the error-code table stays on the server, where a code with no
 * Hebrew sentence yet can be logged instead of silently shrugged at.
 *
 * `?error=` arrives from `/auth/callback` when an emailed link fails — an
 * expired magic link being the common case. `?notice=` is our own message
 * after a sign-out.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  const next = safeRedirectTarget(firstParam(params.next))
  const errorMessage = authErrorMessageForCode(firstParam(params.error))
  const notice = firstParam(params.notice)

  const noticeMessage =
    notice === 'signed-out' ? 'התנתקתם מהמערכת. נתראה בפעם הבאה.' : null

  const initialState = errorMessage
    ? initialStateWithMessage(errorMessage, 'error')
    : initialStateWithMessage(noticeMessage, 'success')

  return (
    <AuthCard
      title="כניסה למערכת"
      description="הזינו את פרטי החשבון שלכם כדי להמשיך."
      footer={
        <span>
          אין לכם עדיין חשבון? <AuthLink href="/sign-up">הרשמה</AuthLink>
        </span>
      }
    >
      <SignInForm next={next} initialState={initialState} />
    </AuthCard>
  )
}
