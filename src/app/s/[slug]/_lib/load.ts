/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * ONE RESOLUTION OF ONE PUBLISHED SITE, PER REQUEST.
 *
 * React's `cache` is what makes "resolve exactly once" true rather than merely
 * intended. The layout resolves the slug to render the frame; the page resolves
 * it again to render the body; the booking route resolves it a third time. All
 * three get one round trip and therefore the SAME snapshot — which matters on
 * the millisecond somebody publishes: without this, the header could come from
 * v4 and the body from v5, and a visitor would see a page assembled from two
 * different versions of the site.
 *
 * The same argument `src/lib/guest-portal/load.ts` makes about a guest token,
 * and it lives here rather than in the library because the SLUG is a route
 * concern — `publicSite(db, host)` in `src/lib/website/public.ts` is the
 * reusable half and takes its host from the caller.
 */

import { cache } from 'react'

import { createClient } from '@/lib/supabase/server'
import { publicSite, type PublicSite } from '@/lib/website'

export const loadPublicSite = cache(
  async (slug: string): Promise<PublicSite> => {
    // The anonymous client. A visitor has no session, and this is the ordinary
    // case rather than a fallback — `site_public_snapshot` is SECURITY DEFINER
    // and takes the host as its only argument.
    const db = await createClient()
    return publicSite(db, slug)
  },
)
