/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The invitation acceptance screen.
 *
 * ── Where this route lives, and why it is not in `(app)` ──────────────────
 *
 * `(app)` is the signed-in shell, and every page under it resolves a
 * `shellContext()` — a membership, an organization, an actor. The person
 * opening an invitation has none of those in the organization that invited
 * them; that is the definition of an invitee. Putting this route inside the
 * shell would mean the layout refusing the page before it could explain
 * itself.
 *
 * It is not public either. `PUBLIC_PREFIXES` in `src/lib/supabase/proxy.ts`
 * does not list `/invite`, so a signed-out visitor is redirected to
 * `/sign-in?next=/invite/…` and arrives back here after signing in, with no
 * code in this file. That is the correct order: the token says which
 * organization, the session says which person, and a membership needs both.
 *
 * ── This page writes nothing ──────────────────────────────────────────────
 *
 * An invitation is single-use. A link in an email is opened by mail-client
 * link checkers, corporate scanners and browser prefetches, and any of them
 * would consume the token if merely rendering this page redeemed it — leaving
 * the real invitee at "this invitation has already been used". So the page
 * reads through `invitation_preview`, and only the button next door writes.
 *
 * ── The demo ──────────────────────────────────────────────────────────────
 *
 * Demo mode replaces identity with a cookie-selected persona and the database
 * with an in-memory copy. Neither can honestly redeem an invitation: there is
 * no account whose email could match, and admitting a persona to an
 * organization it is already inside would demonstrate nothing. The screen says
 * so, rather than fabricating an acceptance the real product would refuse.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { isDemoMode } from '@/lib/demo/flag'
import { toSafeResponse } from '@/lib/errors'
import { PREVIEW_MESSAGE, previewInvitation } from '@/lib/invitations'
import { createClient, getCurrentUser } from '@/lib/supabase/server'

import { AcceptForm } from './accept-form'

export const metadata: Metadata = {
  title: 'הזמנה להצטרפות',
  // An invitation link must never be indexed, summarised or archived by
  // anything that follows links.
  robots: { index: false, follow: false },
}

/** Matches `SIGN_IN_PATH` in `src/lib/supabase/proxy.ts`. */
const SIGN_IN = '/sign-in'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      dir="rtl"
      className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-6 px-4 py-12"
    >
      {children}
    </main>
  )
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return null
  return new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Jerusalem',
  }).format(when)
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  if (isDemoMode()) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle as="h1">קבלת הזמנה אינה חלק מהדמו</CardTitle>
            <CardDescription>
              מסלול הקבלה יוצר חברות אמיתית בארגון אמיתי, ולכן הוא דורש חשבון
              אמיתי — כתובת הדוא״ל של המתחבר חייבת להיות זו שאליה נשלחה ההזמנה.
              בדמו הזהות היא דמות שנבחרה בעוגייה, ואין כתובת שתוכל להתאים.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              יצירת ההזמנה עצמה — התפקיד, הטווח והתפוגה — נראית במסך{' '}
              <Link href="/team" className="text-primary underline">
                הצוות
              </Link>
              , והיא כן חלק מהדמו.
            </p>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  // The proxy has already redirected a signed-out visitor here, carrying
  // `next`. Checked again anyway: the proxy runs on prefetches and is
  // explicitly not the gate.
  const user = await getCurrentUser()
  if (!user) {
    redirect(`${SIGN_IN}?next=${encodeURIComponent(`/invite/${token}`)}`)
  }

  const db = await createClient()

  let preview
  try {
    preview = await previewInvitation(db, token)
  } catch (cause) {
    const { error } = toSafeResponse(cause, crypto.randomUUID())
    return (
      <Shell>
        <Card className="border-danger">
          <CardHeader>
            <CardTitle as="h1">לא הצלחנו לפתוח את ההזמנה</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>{error.dataMessage}</p>
            <p className="text-xs">מספר הפנייה לתמיכה: {error.correlationId}</p>
          </CardContent>
        </Card>
      </Shell>
    )
  }

  const wording = PREVIEW_MESSAGE[preview.status]
  const expiry = formatExpiry(preview.expiresAt)

  return (
    <Shell>
      <Card tone={preview.status === 'ready' ? 'featured' : 'default'}>
        <CardHeader>
          <CardTitle as="h1">{wording.title}</CardTitle>
          <CardDescription>{wording.body}</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5 pt-4">
          <dl className="flex flex-col gap-3 text-sm">
            {preview.organizationName ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">ארגון</dt>
                <dd className="font-semibold text-foreground">
                  {preview.organizationName}
                </dd>
              </div>
            ) : null}

            {preview.roleName ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">תפקיד</dt>
                <dd className="text-foreground">{preview.roleName}</dd>
              </div>
            ) : null}

            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">נשלחה אל</dt>
              {/* Masked by the database. Enough to recognise an address you
                  own, and not enough to learn one you do not. */}
              <dd dir="ltr" className="text-foreground">
                {preview.invitedEmail}
              </dd>
            </div>

            {preview.signedInEmail ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">מחובר כעת</dt>
                <dd dir="ltr" className="text-foreground">
                  {preview.signedInEmail}
                </dd>
              </div>
            ) : null}

            {expiry ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">בתוקף עד</dt>
                <dd className="text-foreground">{expiry}</dd>
              </div>
            ) : null}
          </dl>

          {preview.status === 'ready' ? (
            <AcceptForm
              token={token}
              organizationName={preview.organizationName}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {preview.status === 'already_accepted_by_you' ||
              preview.status === 'already_member' ? (
                <Link
                  href="/dashboard"
                  className="text-primary underline underline-offset-4"
                >
                  כניסה למערכת
                </Link>
              ) : null}

              {preview.status === 'email_mismatch' ? (
                <Link
                  href={`${SIGN_IN}?next=${encodeURIComponent(`/invite/${token}`)}`}
                  className="text-primary underline underline-offset-4"
                >
                  התחברות בכתובת אחרת
                </Link>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </Shell>
  )
}
