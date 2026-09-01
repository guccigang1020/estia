/**
 * EXECUTION CONTEXT — SERVER ONLY. What the payments settings screen reads.
 *
 * Two reads and one derivation. The derivation is `resolveCollectionPolicy`,
 * called here against a worked example rather than reimplemented — the screen
 * shows the reader what their own configuration will do to a real booking, and
 * it must be the same function the guest portal calls or the preview is a lie.
 */

import {
  MANUAL_PAYMENT_CHANNELS,
  SupabasePaymentPolicyRepository,
  resolveCollectionPolicy,
  type CollectionDecision,
  type CollectionSettings,
  type ManualChannel,
  type ManualPaymentChannel,
} from '@/lib/payments'
import { createClient } from '@/lib/supabase/server'

export interface PaymentSettingsView {
  /** `null` when the organization has never saved a row. Not an error. */
  settings: CollectionSettings | null
  /** Every channel in the frozen order, saved or not. */
  channels: readonly ManualChannel[]
  /** What the current configuration does to a ₪10,000 booking, unpaid. */
  preview: CollectionDecision
}

/** The worked example the screen previews against. Stated once. */
export const PREVIEW_BOOKING_TOTAL_AGOROT = 1_000_000

/**
 * A row for every channel, whether or not one was saved.
 *
 * The screen is a list of switches, and a switch with no row behind it still
 * has to render. Building the missing ones here rather than in the component
 * keeps the component from inventing an id or a default it would then try to
 * save.
 */
function withUnsavedChannels(
  saved: readonly ManualChannel[],
): readonly ManualChannel[] {
  const bySlug = new Map<ManualPaymentChannel, ManualChannel>(
    saved.map((channel) => [channel.channel, channel]),
  )

  return MANUAL_PAYMENT_CHANNELS.map(
    (channel, index) =>
      bySlug.get(channel) ?? {
        id: `unsaved:${channel}`,
        channel,
        enabled: false,
        displayName: null,
        instructions: null,
        sortOrder: index,
      },
  )
}

export async function loadPaymentSettings(
  organizationId: string,
): Promise<PaymentSettingsView> {
  const db = await createClient()
  const repository = new SupabasePaymentPolicyRepository(db)

  const [settings, saved] = await Promise.all([
    repository.loadSettings(organizationId),
    repository.listChannels(organizationId),
  ])

  const preview = resolveCollectionPolicy({
    settings,
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

  return { settings, channels: withUnsavedChannels(saved), preview }
}
