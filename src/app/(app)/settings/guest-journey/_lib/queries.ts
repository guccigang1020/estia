/**
 * EXECUTION CONTEXT — SERVER ONLY. What the guest-journey settings screen reads.
 *
 * Three reads and one derivation, and neither the reads nor the derivation
 * belong to this file:
 *
 *   · `SupabaseJourneySettingsRepository` and `effectiveSettings` come from
 *     `src/lib/guest-journey/settings.ts`, which owns those two tables. The
 *     precedence — property row, else organization default, else the shipped
 *     defaults — is resolved there and mirrors 0034's own
 *     `guest_journey_effective_settings`. A screen that re-derived it would be
 *     a second answer to "what is this business actually running".
 *
 *   · `resolveCollectionPolicy` and `nextGuestAction` come from
 *     `src/lib/payments`, which owns what a guest must pay. The preview at the
 *     bottom of the screen is computed with the same two functions the guest
 *     portal calls, over a worked example. A preview computed any other way
 *     would be a second opinion, and a second opinion people trust is worse
 *     than none.
 *
 * The organization-wide row is what this screen edits. `listSettings` returns
 * the property rows too so the screen can say how many properties override the
 * default rather than letting somebody change it and wonder why one house
 * ignored them.
 */

import type { GuestCollection } from '@/lib/guest-journey/collection'
import {
  SupabaseJourneySettingsRepository,
  effectiveSettings,
  type EffectiveJourneySettings,
  type JourneySettingsRecord,
} from '@/lib/guest-journey/settings'
import { nextGuestAction } from '@/lib/payments/guest-action'
import { resolveCollectionPolicy } from '@/lib/payments/resolver'
import { SupabasePaymentPolicyRepository } from '@/lib/payments/repository'
import type { CollectionSettings, ManualChannel } from '@/lib/payments/types'
import { createClient } from '@/lib/supabase/server'

/** The worked example every preview on this screen is computed against. */
export const PREVIEW_BOOKING_TOTAL_AGOROT = 1_000_000

export interface GuestJourneySettingsView {
  /**
   * What is in force for the organization default, and whether anybody chose
   * it. `source: 'shipped'` is a state the screen renders differently and
   * deliberately: it says out loud that 0034's column defaults are running,
   * rather than presenting an empty form that implies a skipped setup step.
   */
  effective: EffectiveJourneySettings
  /** Property rows that override the default. Named, so nobody is surprised. */
  overrides: readonly JourneySettingsRecord[]
  /** The collection policy, read through the module that owns it. */
  paymentSettings: CollectionSettings | null
  channels: readonly ManualChannel[]
  /** The same resolver the guest portal calls, over the worked example. */
  collection: GuestCollection
}

/**
 * A collection decision for a fresh, unpaid booking.
 *
 * Every fact is the honest starting point of a booking nobody has touched, so
 * the preview shows every step a guest will meet rather than the tail of one.
 * Nothing here decides anything: `resolveCollectionPolicy` is handed the
 * organization's settings and returns the verdict, and `nextGuestAction` turns
 * it into the one thing to ask.
 */
function previewCollection(
  paymentSettings: CollectionSettings | null,
  channels: readonly ManualChannel[],
): GuestCollection {
  const decision = resolveCollectionPolicy({
    settings: paymentSettings,
    override: null,
    facts: {
      bookingTotalAgorot: PREVIEW_BOOKING_TOTAL_AGOROT,
      settledAgorot: 0,
      settledLiveAgorot: 0,
      managerApproved: false,
      guestConfirmed: false,
      contractSigned: false,
      proofSubmitted: false,
    },
  })

  const action = nextGuestAction({ decision, channels })

  return {
    decision,
    action,
    guestInstructions: decision.guestInstructions,
    proofUploadUnavailable: action.offerProofUpload,
  }
}

export async function loadGuestJourneySettingsView(
  organizationId: string,
): Promise<GuestJourneySettingsView> {
  const db = await createClient()
  const journey = new SupabaseJourneySettingsRepository(db)
  const payments = new SupabasePaymentPolicyRepository(db)

  const [rows, paymentSettings, channels] = await Promise.all([
    journey.listSettings(organizationId),
    payments.loadSettings(organizationId),
    payments.listChannels(organizationId),
  ])

  return {
    effective: effectiveSettings(rows, null),
    overrides: rows.filter((row) => row.propertyId !== null),
    paymentSettings,
    channels,
    collection: previewCollection(paymentSettings, channels),
  }
}
