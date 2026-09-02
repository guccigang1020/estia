/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The held screen.
 *
 * ── One action, and it is one that can succeed ────────────────────────────
 *
 * While the hold is live the screen asks for exactly one thing: confirm. That
 * control is `ConfirmButton` from the finished guest components rather than a
 * second implementation — it carries the synchronous double-tap lock and posts
 * against `booking_guest_confirmations`, which is unique on
 * `(booking_id, booking_version)`, so a guest on a bus with one bar of signal
 * who taps twice produces one confirmation. Rebuilding that here would have
 * been a second confirm path with none of it.
 *
 * Once the hold has lapsed the confirm disappears entirely. Not disabled —
 * gone. A greyed-out אישור on a screen that says the dates went back on sale
 * reads as a technicality somebody could argue past, and the guest telephones
 * to ask why the button is broken.
 *
 * ── Contact is an input, not an assumption ────────────────────────────────
 *
 * `guest_portal_journey` projects no telephone number for the property. So the
 * contact details are a prop, and when the caller has none the screen renders
 * the sentence and no button. A `tel:` link built from a number this component
 * guessed at would be worse than no link.
 */

import { ConfirmButton } from '@/components/guest/confirm-button'
import type { GuestHoldView } from '@/lib/guest-journey/stay'

import { ContactActions, type GuestContact } from './contact-actions'

export function HoldPanel({
  token,
  view,
  bookingVersion,
  contact,
  children,
}: {
  token: string
  view: GuestHoldView
  /** The version the guest is LOOKING at. The server refuses on a mismatch. */
  bookingVersion: number
  contact?: GuestContact
  /** The countdown. Passed in so this component stays a Server Component. */
  children?: React.ReactNode
}) {
  const lapsed = view.state === 'lapsed'

  return (
    <section
      className={
        'flex flex-col gap-4 rounded-xl border px-4 py-5 ' +
        (lapsed
          ? 'border-warning bg-warning/10'
          : 'border-primary bg-surface-raised ring-1 ring-primary/25')
      }
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold text-foreground">
          {view.headline}
        </h1>
        <p className="text-sm text-muted-foreground">{view.body}</p>
      </header>

      {children}

      <div className="flex flex-col gap-2">
        {view.action.id === 'confirm' ? (
          <ConfirmButton
            token={token}
            bookingVersion={bookingVersion}
            label={view.action.label}
          />
        ) : (
          <ContactActions contact={contact} label={view.action.label} />
        )}

        <p className="text-center text-xs text-muted-foreground">{view.note}</p>
      </div>
    </section>
  )
}

/**
 * The dates, as a line a guest can check against their own diary.
 *
 * Separate from the panel so a screen that already shows the stay elsewhere
 * does not print it twice — one screen, one statement of the dates.
 */
export function HoldDates({ view }: { view: GuestHoldView }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-lg bg-muted px-3 py-2">
      <span className="text-xs text-muted-foreground">התאריכים</span>
      <span className="text-sm font-semibold text-foreground">
        {view.stayLabel}
      </span>
    </div>
  )
}
