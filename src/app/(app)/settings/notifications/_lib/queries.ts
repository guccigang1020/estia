/**
 * EXECUTION CONTEXT — SERVER ONLY. What the notifications screen reads.
 *
 * Four reads and one derivation. The derivation is `PreferenceSet.grid()`,
 * called here rather than reimplemented in the component: the screen shows a
 * person what they will actually receive, and it must be the same resolver the
 * routing engine consults or the grid is a lie.
 *
 * ── The demo carve-out, stated rather than hidden ─────────────────────────
 *
 * `src/lib/demo/**` belongs to the coordinator, so the five tables 0043
 * creates cannot be added to `DEMO_DATASET` from this module. The demo client
 * throws `MissingDemoTable` for a key it has never heard of — deliberately,
 * because "no rows" and "not thought about yet" must not look the same — and
 * that would turn this screen into an error page on the demo server.
 *
 * So the catch below is narrow on both axes: it fires only in demo mode, and
 * only for that one error by name. In production a missing relation is a
 * broken deployment and still surfaces. It is removed the moment the dataset
 * carries `notification_settings`, `notification_preferences`,
 * `notifications`, `notification_deliveries` and
 * `notification_escalation_rules`.
 */

import {
  InMemoryNotificationRepository,
  PreferenceSet,
  SupabaseNotificationRepository,
  defaultTransportRegistry,
  emptyTally,
  settingsOrDefaults,
  visibleTo,
  type DeliveryTally,
  type NotificationRecord,
  type NotificationRepository,
  type NotificationSettings,
  type ResolvedPreference,
} from '@/lib/notifications'
import type { Actor } from '@/lib/authz/can'
import { isDemoMode } from '@/lib/demo/flag'
import { createClient } from '@/lib/supabase/server'

/** How far back the unsent count looks. Stated once, printed on the screen. */
export const TALLY_WINDOW_DAYS = 30

export interface NotificationSettingsView {
  settings: NotificationSettings
  /** True when the organization has never saved a row. */
  usingDefaults: boolean
  grid: readonly ResolvedPreference[]
  inbox: readonly NotificationRecord[]
  tally: DeliveryTally
  configuredChannels: readonly string[]
  /** True when the tables are not in the demo dataset yet. See the header. */
  unseeded: boolean
}

function isMissingDemoTable(cause: unknown): boolean {
  return (
    isDemoMode() && cause instanceof Error && cause.name === 'MissingDemoTable'
  )
}

export async function loadNotificationSettings(
  actor: Actor,
): Promise<NotificationSettingsView> {
  const db = await createClient()
  const repository: NotificationRepository = new SupabaseNotificationRepository(
    db,
  )

  try {
    return await read(repository, actor, false)
  } catch (cause) {
    if (!isMissingDemoTable(cause)) throw cause
    // An empty repository, so the screen renders its real shape against the
    // documented defaults rather than an error page. `unseeded` is carried
    // through so the screen says which it is looking at.
    return read(new InMemoryNotificationRepository(), actor, true)
  }
}

async function read(
  repository: NotificationRepository,
  actor: Actor,
  unseeded: boolean,
): Promise<NotificationSettingsView> {
  const organizationId = actor.organizationId

  const [saved, preferences, inbox, tally] = await Promise.all([
    repository.loadSettings(organizationId),
    repository.listPreferences(organizationId, actor.userId),
    repository.listInbox(organizationId, actor.userId, { limit: 25 }),
    unseeded
      ? Promise.resolve(emptyTally())
      : repository.deliveryTally(organizationId, TALLY_WINDOW_DAYS),
  ])

  const settings = settingsOrDefaults(organizationId, saved)

  return {
    settings,
    usingDefaults: saved === null,
    grid: new PreferenceSet(preferences, settings).grid(),
    // Filtered again above row level security. The policy re-checks the
    // property; the grant is re-checked here against the real engine, which is
    // the half `has_permission` cannot answer. See `visibility.ts`.
    inbox: visibleTo(actor, inbox),
    tally,
    configuredChannels: defaultTransportRegistry().configuredChannels(),
    unseeded,
  }
}
