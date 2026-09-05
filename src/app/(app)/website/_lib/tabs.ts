/**
 * Which studio tabs a person may actually open.
 *
 * ── Why this is not in `gate.ts` ─────────────────────────────────────────
 *
 * It was, and it could not be tested. `gate.ts` imports `shellContext`, which
 * reaches `@/lib/supabase/server` and then `@/lib/env`, which throws at import
 * time without a configured Supabase project. A pure function about grants was
 * therefore untestable because of a transitive dependency it had no use for.
 *
 * So the decision lives here, importing nothing but the authorization engine,
 * and `gate.ts` re-exports it. `tabs.test.ts` exercises it without a database,
 * a session or a single environment variable.
 *
 * ── This is not security ─────────────────────────────────────────────────
 *
 * `holdsGrant` only. This decides what to LINK; every route refuses
 * independently through `requireSiteGrant`. If this file were deleted the
 * studio would be exactly as protected as it is now — what would change is
 * that a copywriter would see a design tab that bounces them.
 */

import { holdsGrant, type Actor } from '@/lib/authz/can'

export type StudioTab = {
  href: string
  label: string
  /** False renders the label without a link, greyed, rather than hiding it. */
  available: boolean
}

export function studioTabs(actor: Actor): readonly StudioTab[] {
  return [
    { href: '/website', label: 'סקירה', available: true },
    {
      href: '/website/content',
      label: 'תוכן',
      available: holdsGrant(actor, 'site.edit_content'),
    },
    {
      href: '/website/design',
      label: 'עיצוב',
      available: holdsGrant(actor, 'site.edit_design'),
    },
    {
      href: '/website/seo',
      label: 'חיפוש',
      available: holdsGrant(actor, 'site.manage_seo'),
    },
    {
      href: '/website/quality',
      label: 'בדיקות',
      available: holdsGrant(actor, 'site.view'),
    },
    {
      href: '/website/preview',
      label: 'תצוגה מקדימה',
      available: holdsGrant(actor, 'site.view'),
    },
    {
      href: '/website/versions',
      label: 'גרסאות',
      available: holdsGrant(actor, 'site.view'),
    },
    {
      href: '/website/domain',
      label: 'דומיין',
      available: holdsGrant(actor, 'site.manage_domain'),
    },
    {
      href: '/website/requests',
      label: 'פניות',
      // NOT a site grant. An enquiry carries a name and a telephone number and
      // is guest data that arrived through a website — the policy in 0042
      // gates it on `booking.view` and this matches, so the tab is not offered
      // to somebody the database would hand an empty list.
      available: holdsGrant(actor, 'booking.view'),
    },
  ]
}
