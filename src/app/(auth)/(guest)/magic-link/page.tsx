import type { Metadata } from 'next'

import { AuthCard, AuthLink } from '@/components/auth/auth-card'
import { authErrorMessageForCode } from '@/lib/supabase/auth-errors'

import { initialStateWithMessage } from '../../_lib/form-state'
import { safeRedirectTarget } from '../../_lib/redirect-target'
import { firstParam, type SearchParams } from '../../_lib/search-params'
import { MagicLinkForm } from './magic-link-form'

export const metadata: Metadata = { title: 'כניסה עם קישור' }

/** EXECUTION CONTEXT — SERVER COMPONENT. */
export default async function MagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  const next = safeRedirectTarget(firstParam(params.next))
  const errorMessage = authErrorMessageForCode(firstParam(params.error))

  return (
    <AuthCard
      title="כניסה בלי סיסמה"
      description="נשלח לכם קישור חד-פעמי למייל. לחיצה עליו מכניסה אתכם למערכת."
      footer={
        <span>
          מעדיפים סיסמה? <AuthLink href="/sign-in">כניסה רגילה</AuthLink>
        </span>
      }
    >
      <MagicLinkForm
        next={next}
        initialState={initialStateWithMessage(errorMessage, 'error')}
      />
    </AuthCard>
  )
}
