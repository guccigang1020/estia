/**
 * EXECUTION CONTEXT — SERVER ONLY. One resolution of everything, per request.
 *
 * Six segments render inside this portal and every one of them needs the same
 * three answers: whose booking is this, what happens next, and what does the
 * business want collected. Resolving those separately in each segment is how
 * two parts of one screen come to disagree — and the field they would disagree
 * about is whether a door code may be shown, on the millisecond a deposit is
 * recorded or a link is revoked.
 *
 * So it is resolved once. `loadGuestSession` and `loadGuestJourney` are already
 * React-cached in their own modules; `portalContext` composes them and is
 * cached itself, so a page and the component tree under it share one answer.
 *
 * ── Recording that the link was opened ────────────────────────────────────
 *
 * Stamped here rather than in the first screen, because a guest who follows a
 * link straight to `/arrival` has opened the link just as much as one who
 * landed on the root — and "sent and never opened" would quietly become wrong
 * for them. Cached, so six segments in one request produce one stamp, and it
 * swallows its own failure: telemetry must never be why a guest sees an error.
 */

import { cache } from 'react'

import {
  guestCollection,
  loadGuestJourney,
  type GuestCollection,
} from '@/lib/guest-journey'
import {
  loadGuestSession,
  markGuestPortalOpened,
  type GuestSession,
} from '@/lib/guest-portal'
import { createClient } from '@/lib/supabase/server'

export type PortalContext = {
  session: GuestSession
  journey: Awaited<ReturnType<typeof loadGuestJourney>>
  collection: GuestCollection
}

/** One stamp per request, however many segments ask. */
const stampOpened = cache(async (token: string): Promise<void> => {
  const db = await createClient()
  await markGuestPortalOpened(db, token)
})

export const portalContext = cache(
  async (token: string): Promise<PortalContext> => {
    const db = await createClient()

    // The session first: it is the one that refuses a bad link, and there is
    // no point asking the other two about a booking nobody may see. The layout
    // has already resolved it for this request, so this costs nothing.
    const session = await loadGuestSession(token)
    const journey = await loadGuestJourney(token)
    const collection = await guestCollection(db, token, journey)

    await stampOpened(token)

    return { session, journey, collection }
  },
)
