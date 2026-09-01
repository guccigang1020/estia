/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * One resolution of one capability, per request.
 *
 * React`s `cache` is what makes "resolve exactly once" true rather than
 * merely intended. The portal`s layout resolves the token to refuse a bad
 * link before any segment renders; the page and every nested segment then ask
 * again and get the same round trip, and therefore the same booking. Without
 * it, two segments could each resolve the token and — on the millisecond a
 * link is revoked — disagree about whether the guest may be there.
 *
 * It lives in the library rather than in the layout file so that a segment
 * importing it is importing from the module that owns the capability, not
 * from somebody else`s route file.
 */

import { cache } from 'react'

import { createClient } from '../supabase/server'

import { guestSession, type GuestSession } from './session'

export const loadGuestSession = cache(
  async (token: string): Promise<GuestSession> => {
    const db = await createClient()
    return guestSession(db, token)
  },
)
