/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Where the house is, and how to get in.
 *
 * ── This page does not decide anything ────────────────────────────────────
 *
 * That is the point, and it is worth stating before the code. The address, the
 * directions, the parking, the access instructions and the door code are
 * decided by `guest_arrival_released` in migration 0034 — organization policy,
 * the operator's manual override, and the fact that a checked-in guest is past
 * the argument. When the policy says no, those fields are **SQL NULL in the
 * payload**. They are not fetched and hidden; there is nothing here to hide.
 *
 * So there is no `if (released)` guarding a value in this file. There is one
 * check, on `released`, that decides between two whole layouts — the details,
 * or the sentence explaining when they will appear. If somebody deleted that
 * check tomorrow, the page would render a list of empty rows rather than
 * somebody's door code, because the code is not in the object.
 *
 * That is the difference between gating in SQL and gating in a template, and
 * it is why the access code is the one thing in this product whose disclosure
 * rule lives in the database.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { GUEST_ARRIVAL_RELEASE_LABEL } from '@/lib/guest-journey'
import { GuestLinkRefusedError } from '@/lib/guest-portal'

import { portalContext } from '../_lib/portal'

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-line text-sm text-foreground">
        {children}
      </dd>
    </div>
  )
}

/** What the guest is told about WHEN the address appears. Never why not. */
const WAITING_FOR: Record<string, string> = {
  after_confirmation: 'פרטי ההגעה יופיעו כאן מיד אחרי שתאשר את ההזמנה.',
  after_contract: 'פרטי ההגעה יופיעו כאן אחרי החתימה על החוזה.',
  after_deposit: 'פרטי ההגעה יופיעו כאן אחרי קליטת המקדמה.',
  after_full_payment: 'פרטי ההגעה יופיעו כאן אחרי השלמת התשלום.',
  hours_before: 'פרטי ההגעה יופיעו כאן בסמוך למועד ההגעה.',
  manual: 'בית האירוח ישחרר את פרטי ההגעה לקראת המועד.',
  immediate: 'פרטי ההגעה יופיעו כאן בקרוב.',
}

export default async function GuestArrivalPage({
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
  const { arrival, settings } = journey

  const address = [arrival.addressLine1, arrival.addressLine2, arrival.city]
    .filter((part): part is string => Boolean(part))
    .join(', ')

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
          פרטי הגעה
        </h1>
        {arrival.checkInTime && (
          <p className="text-sm text-muted-foreground">
            הכניסה משעה {arrival.checkInTime.slice(0, 5)}
          </p>
        )}
      </header>

      {arrival.released ? (
        <>
          <dl className="flex flex-col rounded-xl border border-border bg-surface px-4 py-1">
            {address && <Row label="כתובת">{address}</Row>}
            {arrival.addressNote && (
              <Row label="איך למצוא">{arrival.addressNote}</Row>
            )}
            {arrival.directions && (
              <Row label="הוראות הגעה">{arrival.directions}</Row>
            )}
            {arrival.parking && <Row label="חנייה">{arrival.parking}</Row>}
            {arrival.accessInstructions && (
              <Row label="כניסה לנכס">{arrival.accessInstructions}</Row>
            )}
          </dl>

          {/* The code gets its own card and a monospace, LTR run: it is copied
              out and typed into a keypad, often in the dark, and a digit lost
              to bidirectional reordering is a guest standing outside. */}
          {arrival.accessCode && (
            <div className="flex flex-col gap-1 rounded-xl border-2 border-primary bg-primary-soft px-4 py-4 text-center">
              <span className="text-xs font-medium text-primary">
                קוד כניסה
              </span>
              <span
                dir="ltr"
                className="font-mono text-3xl font-bold tracking-widest text-foreground"
              >
                {arrival.accessCode}
              </span>
            </div>
          )}

          {arrival.mapUrl && (
            <a
              href={arrival.mapUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-full border border-border-strong bg-surface px-4 py-3 text-center text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              פתיחה במפות
            </a>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p
            role="status"
            className="rounded-xl border border-border bg-muted/50 px-4 py-4 text-sm text-foreground"
          >
            {WAITING_FOR[settings.arrivalRelease] ??
              'פרטי ההגעה יופיעו כאן בהמשך.'}
          </p>

          {/* The city is not withheld: it is on the confirmation the guest
              already has and in the property's public listing, and hiding it
              would be theatre rather than protection. */}
          {arrival.city && (
            <p className="text-sm text-muted-foreground">
              הנכס נמצא באזור {arrival.city}.
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            מדיניות בית האירוח:{' '}
            {GUEST_ARRIVAL_RELEASE_LABEL[settings.arrivalRelease]}
          </p>
        </div>
      )}
    </main>
  )
}
