/**
 * EXECUTION CONTEXT — SERVER COMPONENT. During the stay.
 *
 * ── The wifi password is gated in SQL, like the door code ─────────────────
 *
 * `guest_portal_journey` returns `stay.wifiPassword` as SQL NULL until the
 * stay has actually begun — by the calendar or by the status, whichever comes
 * first, because an early check-in is ordinary and a guest sitting on the sofa
 * should not be told the wifi is not available yet. There is no `if (inStay)`
 * guarding a value in this file for the same reason as on the arrival page:
 * the value is not in the object.
 *
 * ── A request becomes a task, and the guest sees three words ──────────────
 *
 * The form posts to `guest_portal_submit_request`, which writes a row in
 * `public.tasks` — the canonical engine, using the `guest_request` task type
 * that has existed since 0011 — and a companion row carrying only what a guest
 * may be told. This page never reads `tasks`; it could not, having no
 * membership. התקבלה · בטיפול · הושלמה, and never a staff name.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CheckoutDeclare } from '@/components/guest/checkout-declare'
import { RequestForm } from '@/components/guest/request-form'
import { RequestList } from '@/components/guest/request-list'
import { GuestLinkRefusedError } from '@/lib/guest-portal'

import { portalContext } from '../_lib/portal'

function Panel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4">
      <h2 className="font-display text-base font-bold text-foreground">
        {title}
      </h2>
      <div className="text-sm whitespace-pre-line text-muted-foreground">
        {children}
      </div>
    </section>
  )
}

export default async function GuestStayPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let context
  try {
    context = await portalContext(token)
  } catch (cause) {
    if (cause instanceof GuestLinkRefusedError) notFound()
    throw cause
  }

  const { journey } = context
  const { stay, settings, requests, checkout } = journey
  const topics = new Set(settings.duringStayTopics)

  return (
    <main className="flex flex-col gap-5">
      <Link
        href={`/g/${token}`}
        className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        ← חזרה להזמנה
      </Link>

      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold text-foreground">
          המדריך לשהות
        </h1>
        {!stay.inStay && (
          <p className="text-sm text-muted-foreground">
            חלק מהפרטים יופיעו כאן עם תחילת השהות.
          </p>
        )}
      </header>

      {/* Wifi first. It is the single most requested piece of information in
          any short stay, and burying it under the house rules is how a guest
          ends up telephoning at eleven at night. */}
      {topics.has('wifi') && stay.wifiNetwork && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="font-display text-base font-bold text-foreground">
            רשת אלחוטית
          </h2>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs text-muted-foreground">שם הרשת</span>
              <span dir="ltr" className="font-mono text-sm text-foreground">
                {stay.wifiNetwork}
              </span>
            </div>
            {stay.wifiPassword && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-muted-foreground">סיסמה</span>
                {/* LTR and monospace: a password is typed character by
                    character, and bidirectional reordering loses one. */}
                <span
                  dir="ltr"
                  className="font-mono text-base font-semibold text-foreground"
                >
                  {stay.wifiPassword}
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {topics.has('guide') && stay.propertyGuide && (
        <Panel title="מדריך הנכס">{stay.propertyGuide}</Panel>
      )}

      {stay.houseRules && <Panel title="כללי הבית">{stay.houseRules}</Panel>}

      {stay.emergencyContact && (
        <Panel title="מקרה חירום">{stay.emergencyContact}</Panel>
      )}

      {settings.requestsEnabled && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-lg font-bold text-foreground">
              בקשה במהלך השהות
            </h2>
            <p className="text-sm text-muted-foreground">
              מגבות, מצעים, ניקיון או תקלה — נטפל בזה.
            </p>
          </div>

          <RequestForm token={token} categories={settings.requestCategories} />
          <RequestList requests={requests} />
        </section>
      )}

      {topics.has('checkout') && checkout.enabled && (
        <CheckoutDeclare token={token} declaredAt={checkout.declaredAt} />
      )}
    </main>
  )
}
