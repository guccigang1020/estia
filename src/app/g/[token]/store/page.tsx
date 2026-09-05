import type { Metadata } from 'next'

import { GuestStore } from '@/components/store/guest-store'
import { placeGuestOrderAction } from './_lib/actions'
import { toSafeResponse } from '@/lib/errors'
import { loadGuestSession } from '@/lib/guest-portal'
import {
  bookingFactsFrom,
  guestStoreView,
  propertyCapabilities,
  type GuestStoreView,
} from '@/lib/store'
import { createClient } from '@/lib/supabase/server'

/**
 * The token is a bearer credential for one booking.
 *
 * `robots` refuses indexing and following — the layout sets the same, and this
 * segment restates it because a segment's metadata replaces rather than
 * inherits a title, and a page that set one without restating `robots` would
 * quietly become crawlable.
 */
export const metadata: Metadata = {
  title: 'תוספות לשהות',
  robots: { index: false, follow: false },
}

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The store, inside the guest's portal.
 *
 * ── This segment does not resolve the token ─────────────────────────────
 *
 * `loadGuestSession` is React-cached and the portal's layout has already
 * called it, so this costs nothing and — more importantly — gets the SAME
 * booking. Two readings of one capability is how one section eventually shows
 * a guest somebody else's stay.
 *
 * The token is never logged, never put into a query string on a redirect, and
 * never written into an operation result. See `src/lib/guest-portal/session.ts`.
 *
 * ── Why an empty store renders nothing rather than an apology ───────────
 *
 * A business with the store `off`, or with the guest store switched off, has
 * made a deliberate choice, and the guest's portal has other sections. A
 * section that announced "there is no shop here" would be noise on a telephone
 * screen about a decision that has nothing to do with the guest.
 */
export default async function GuestStorePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let view: GuestStoreView | null = null
  let bookingId = ''
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const session = await loadGuestSession(token)
    bookingId = session.bookingId

    const db = await createClient()

    const booking = bookingFactsFrom(session, {
      propertyCapabilities: session.propertyId
        ? await propertyCapabilities(db, session.propertyId)
        : [],
    })

    view = await guestStoreView({ db, booking, now: new Date() })
  } catch (cause) {
    // The layout has already refused an invalid link, so anything reaching
    // here is a read that failed rather than a link that is wrong. Reported
    // quietly: the rest of the portal is still usable and the guest can do
    // nothing about a database that is slow.
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  if (failure) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-bold text-foreground">
          התוספות אינן זמינות כרגע
        </h2>
        <p className="text-sm text-muted-foreground">{failure.error.message}</p>
      </section>
    )
  }

  // Nothing to offer. See the header: silence rather than an apology.
  if (!view || view.sections.length === 0) return null

  return (
    <GuestStore
      bookingId={bookingId}
      settings={view.settings}
      sections={view.sections}
      cards={view.cards}
      onSubmit={async (lines) => {
        'use server'
        // The submission key is the booking and the basket, so two taps on the
        // same basket dedupe and a genuinely different basket does not. It is
        // minted here rather than in the browser because a client-held key
        // survives a reload and would silently swallow a real second order.
        const submissionKey = `${bookingId}:${lines
          .map((line) => `${line.itemId}x${line.quantity}`)
          .sort()
          .join('|')}`

        return placeGuestOrderAction({
          token,
          lines,
          requestedForDate: null,
          guestNotes: null,
          submissionKey,
        })
      }}
    />
  )
}
