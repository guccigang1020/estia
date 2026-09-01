/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Leaving, and afterwards.
 *
 * ── Rebooking never shows a date that is not free ─────────────────────────
 *
 * The specification is explicit about it, and the honest consequence is that
 * this page currently shows NO dates. Availability for a guest is a port —
 * `GuestRebookPort` in `ports.ts` — and its null implementation returns an
 * empty list, because the module that could answer truthfully is not written
 * against this database.
 *
 * A calendar with plausible-looking dates would be worse than no calendar: a
 * guest who picks one and is then told it is taken has been shown something
 * the product invented, and they cannot tell that from a system that is
 * merely slow. So the offer is real and the dates are not fabricated — the
 * card invites them to ask, which is what a guesthouse owner would want a
 * returning guest to do anyway.
 *
 * ── The review link is only rendered when there is somewhere to go ────────
 *
 * `guest_journey_settings_review_has_url` refuses a row that enables reviews
 * with no URL, so this cannot render a dead link — the constraint makes the
 * bad state unrepresentable rather than this file checking for it.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CheckoutDeclare } from '@/components/guest/checkout-declare'
import { Button } from '@/components/ui/button'
import { GuestLinkRefusedError } from '@/lib/guest-portal'

import { portalContext } from '../_lib/portal'

export default async function GuestCheckoutPage({
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

  const { session, journey } = context
  const { checkout, settings } = journey
  const left = checkout.declaredAt !== null

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
          {left ? 'תודה ששהיתם אצלנו' : 'עזיבה'}
        </h1>
        {checkout.checkOutTime && !left && (
          <p className="text-sm text-muted-foreground">
            שעת העזיבה: עד {checkout.checkOutTime.slice(0, 5)}
          </p>
        )}
      </header>

      {checkout.instructions && (
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="font-display text-base font-bold text-foreground">
            לפני שיוצאים
          </h2>
          <p className="text-sm whitespace-pre-line text-muted-foreground">
            {checkout.instructions}
          </p>
        </section>
      )}

      {checkout.enabled && (
        <CheckoutDeclare token={token} declaredAt={checkout.declaredAt} />
      )}

      {left && settings.reviewEnabled && settings.reviewUrl && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-base font-bold text-foreground">
              נשמח לחוות דעת
            </h2>
            <p className="text-sm text-muted-foreground">
              דקה אחת, והיא עוזרת מאוד לבית אירוח קטן.
            </p>
          </div>
          <Button
            href={settings.reviewUrl}
            target="_blank"
            rel="noreferrer noopener"
            variant="secondary"
            size="lg"
            className="w-full"
          >
            כתיבת חוות דעת
          </Button>
        </section>
      )}

      {left && settings.rebookEnabled && (
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-base font-bold text-foreground">
              שהות נוספת
            </h2>
            <p className="text-sm text-muted-foreground">
              נשמח לארח אתכם שוב ב
              {session.propertyName ?? session.organizationName}. פנו לבית
              האירוח לבדיקת תאריכים פנויים.
            </p>
          </div>
          {/* No dates. See the header: the availability the product could
              answer with truthfully is not wired to a guest yet, and an
              invented date is worse than an invitation to ask. */}
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
            בחירת תאריכים ישירות מהקישור תתווסף כשלוח הזמינות ייפתח לאורחים.
            בינתיים, פנייה ישירה לבית האירוח היא הדרך המהירה ביותר.
          </p>
        </section>
      )}
    </main>
  )
}
