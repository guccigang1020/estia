/**
 * What one person has actually asked to receive.
 *
 * Three layers, and the order between them is the whole design:
 *
 *   1. **The module default** (`defaultPreference` in `types.ts`). In-app
 *      takes everything; every channel that interrupts starts at `attention`.
 *   2. **The organization.** A channel absent from
 *      `NotificationSettings.enabledChannels` is off for everybody, full stop.
 *   3. **The person**, for a category on a channel.
 *
 * ── A missing row means the default, not "off" ────────────────────────────
 *
 * This is the reason there is a resolver at all rather than a `select` with a
 * `coalesce`. If sign-up wrote a row for all forty (category, channel) pairs,
 * today's default would be frozen into every account that ever existed, and
 * changing it centrally would reach precisely nobody. A missing row is an
 * opinion nobody has expressed yet, and it must stay expressible.
 *
 * ── The organization can only ever narrow ─────────────────────────────────
 *
 * `enabledChannels` removes a channel from everybody. It cannot add one back
 * for a person who switched it off — `resolvePreference` returns disabled the
 * moment either layer says so. That asymmetry is deliberate and matches the
 * policies in 0043, where there is no administrator override on
 * `notification_preferences`: an administrator turning somebody's SMS back on
 * without their knowing is not an administrative act.
 */

import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  defaultPreference,
  severityAtLeast,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationSettings,
  type NotificationSeverity,
  type PreferenceRecord,
  type SuppressionReason,
} from './types'

/** One resolved cell of the grid. */
export interface ResolvedPreference {
  category: NotificationCategory
  channel: NotificationChannel
  enabled: boolean
  minSeverity: NotificationSeverity
  /** True when a stored row decided this, false when the default did. */
  explicit: boolean
  /** True when the organization has the channel off. Overrides everything. */
  channelDisabled: boolean
}

/** A lookup that answers in constant time, built once per routing pass. */
export class PreferenceSet {
  private readonly rows: ReadonlyMap<string, PreferenceRecord>
  private readonly enabledChannels: ReadonlySet<NotificationChannel>

  constructor(
    preferences: readonly PreferenceRecord[],
    settings: Pick<NotificationSettings, 'enabledChannels'>,
  ) {
    this.rows = new Map(
      preferences.map((row) => [cellKey(row.category, row.channel), row]),
    )
    this.enabledChannels = new Set(settings.enabledChannels)
  }

  resolve(
    category: NotificationCategory,
    channel: NotificationChannel,
  ): ResolvedPreference {
    const stored = this.rows.get(cellKey(category, channel))
    const fallback = defaultPreference(channel)
    const channelDisabled = !this.enabledChannels.has(channel)

    return {
      category,
      channel,
      enabled: (stored?.enabled ?? fallback.enabled) && !channelDisabled,
      minSeverity: stored?.minSeverity ?? fallback.minSeverity,
      explicit: stored !== undefined,
      channelDisabled,
    }
  }

  /** The whole grid, for the preferences screen. Categories × channels. */
  grid(): readonly ResolvedPreference[] {
    const cells: ResolvedPreference[] = []
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        cells.push(this.resolve(category, channel))
      }
    }
    return cells
  }
}

function cellKey(
  category: NotificationCategory,
  channel: NotificationChannel,
): string {
  return `${category}/${channel}`
}

/**
 * Does this preference admit this severity, and if not, why not?
 *
 * `null` means yes. Anything else is the reason, in the vocabulary
 * `notification_deliveries.suppressed_reason` stores and
 * `labels.ts` renders — so the sentence a person reads on the screen and the
 * value in the column can never say different things.
 *
 * The order is not arbitrary. "The business has this channel off" is a
 * different sentence from "you switched this off", and a screen that reported
 * the second when the first was true would send somebody to their own
 * preferences to fix a setting they do not own.
 */
export function suppressionFor(
  preference: ResolvedPreference,
  severity: NotificationSeverity,
): SuppressionReason | null {
  if (preference.channelDisabled) return 'channel_disabled'
  if (!preference.enabled) return 'preference_off'
  if (!severityAtLeast(severity, preference.minSeverity)) {
    return 'below_min_severity'
  }
  return null
}
