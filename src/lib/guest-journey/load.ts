/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * One reading of the journey, per request.
 *
 * The same argument `src/lib/guest-portal/load.ts` makes for the session, and
 * it applies twice over here. The portal's first screen reads the journey to
 * decide the dominant action; the arrival segment reads it to decide whether
 * the access code exists; the stay segment reads it for the wifi. Without
 * `cache` those are three round trips that can disagree — and the field they
 * would disagree about is whether a secret may be shown, on the millisecond a
 * deposit is recorded or a link is revoked.
 *
 * It lives in the library rather than in a route file so that a segment
 * importing it is importing from the module that owns the capability, not from
 * somebody else's page.
 */

import { cache } from 'react'

import { createClient } from '../supabase/server'

import { guestJourney } from './journey'
import type { GuestJourney } from './types'

export const loadGuestJourney = cache(
  async (token: string): Promise<GuestJourney> => {
    const db = await createClient()
    return guestJourney(db, token)
  },
)
