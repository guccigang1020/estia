import type { Metadata } from 'next'

import { AuthCard, AuthLink } from '@/components/auth/auth-card'
import { getCurrentUser } from '@/lib/supabase/server'

import { ResetPasswordForm } from './reset-password-form'

export const metadata: Metadata = { title: 'בחירת סיסמה חדשה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT.
 *
 * Deliberately in NEITHER the `(guest)` nor the `(protected)` group, because
 * it does not fit either:
 *
 *   - `(guest)` would redirect the user away the moment they arrived, since
 *     opening a recovery link signs them in. The guard would break the flow it
 *     is supposed to protect.
 *   - `(protected)` would bounce a signed-out arrival to `/sign-in`, which is
 *     the least useful answer available to somebody holding a reset link that
 *     has expired. They need to be told the link is dead and offered another.
 *
 * So the session check lives here, and produces two different screens. The
 * write itself is checked again inside `resetPasswordAction` — a page that
 * renders a form is not an authorisation, and the action is reachable by
 * direct POST without ever loading this page.
 */
export default async function ResetPasswordPage() {
  const user = await getCurrentUser()

  if (!user) {
    return (
      <AuthCard
        title="הקישור אינו תקף"
        description="קישור לאיפוס סיסמה תקף לשעה אחת ולשימוש יחיד, ויש לפתוח אותו באותו דפדפן שממנו התבקש."
        footer={
          <span>
            נזכרתם בסיסמה? <AuthLink href="/sign-in">חזרה לכניסה</AuthLink>
          </span>
        }
      >
        <p className="text-sm text-muted-foreground">
          בקשו קישור חדש ופתחו אותו מיד כשההודעה מגיעה.
        </p>
        <p className="mt-4 text-sm">
          <AuthLink href="/forgot-password">שליחת קישור חדש</AuthLink>
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="בחירת סיסמה חדשה"
      description={`בחירת סיסמה חדשה לחשבון ${user.email ?? ''}`.trim()}
    >
      <ResetPasswordForm />
    </AuthCard>
  )
}
