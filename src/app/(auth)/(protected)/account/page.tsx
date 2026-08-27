import type { Metadata } from 'next'

import { AuthCard } from '@/components/auth/auth-card'
import { FormAlert } from '@/components/auth/form-alert'
import { SignOutButton } from '@/components/auth/sign-out-button'
import { getCurrentUser } from '@/lib/supabase/server'

import { signOutAction } from '../../actions'
import { firstParam, type SearchParams } from '../../_lib/search-params'

export const metadata: Metadata = { title: 'החשבון שלי' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT.
 *
 * A PLACEHOLDER, and intentionally a thin one. Its job is to prove that the
 * route protection works in both directions — reaching it signed out
 * redirects to sign-in, and reaching sign-in while signed in redirects here —
 * and to give sign-out somewhere to live.
 *
 * IT IS NOT THE DASHBOARD and must not grow into one. The dashboard belongs to
 * another engineer. Everything below is identity: what authentication actually
 * established. Nothing here reads a role, a permission or an organization,
 * because none of that is authentication's to answer.
 *
 * `user` is re-read rather than passed down from the layout guard. The React
 * `cache` around `getCurrentUser` makes that one request, not two, and it
 * keeps the page honest on its own terms instead of trusting a parent.
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [user, params] = await Promise.all([getCurrentUser(), searchParams])

  // The protected layout has already redirected if this is null; the check
  // exists so the type is honest rather than asserted away with `!`.
  if (!user) return null

  const notice = firstParam(params.notice)
  const fullName =
    typeof user.user_metadata?.full_name === 'string'
      ? user.user_metadata.full_name
      : null

  return (
    <AuthCard
      title="החשבון שלי"
      description="אזור מחובר זמני, שנועד להוכיח שהגנת המסלולים עובדת."
    >
      <div className="flex flex-col gap-5">
        {notice === 'password-updated' ? (
          <FormAlert
            tone="success"
            message="הסיסמה עודכנה. שאר המכשירים נותקו מהחשבון."
            attempt={0}
          />
        ) : null}

        <dl className="flex flex-col gap-3 text-sm">
          {fullName ? (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">שם</dt>
              <dd className="font-medium text-foreground">{fullName}</dd>
            </div>
          ) : null}

          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">אימייל</dt>
            <dd dir="ltr" className="font-medium text-foreground">
              {user.email}
            </dd>
          </div>

          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">מזהה משתמש</dt>
            <dd dir="ltr" className="font-mono text-xs text-muted-foreground">
              {user.id}
            </dd>
          </div>
        </dl>

        <SignOutButton action={signOutAction} />
      </div>
    </AuthCard>
  )
}
