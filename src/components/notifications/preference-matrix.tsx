'use client'

/**
 * One person's grid: eight categories by the channels the business has on.
 *
 * ── Why the grid is categories and not events ─────────────────────────────
 *
 * There are roughly 130 domain events. A switch per event is a preferences
 * screen nobody finishes, and a screen nobody finishes is a person who never
 * turns anything off and eventually mutes the whole product in their mail
 * client — which is strictly worse than a coarse control they actually use.
 *
 * ── Each cell saves on its own ────────────────────────────────────────────
 *
 * A deliberate cost. Somebody turning off money alerts on SMS at the desk
 * should not have to re-submit the seven other rows, and a failure on one cell
 * must not discard the others. The same argument the manual payment channels
 * form makes, for the same reason.
 *
 * ── Only enabled channels are shown ───────────────────────────────────────
 *
 * A column for WhatsApp, which the business has not switched on and which has
 * no transport behind it, would be a control that changes nothing. The panel
 * above this one is where the missing channels are named and counted — that is
 * the honest place for them, because it says why they are missing rather than
 * offering a toggle that does not.
 *
 * Leaf imports only: `@/lib/notifications` re-exports the Supabase adapter and
 * would drag the Node-only `postgres` driver into this bundle.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { savePreferenceAction } from '@/app/(app)/settings/notifications/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { PanelNote } from '@/components/shell-screens/screen'
import { Checkbox, Select } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import {
  CATEGORY_HINT,
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  SEVERITY_LABEL,
} from '@/lib/notifications/labels'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_SEVERITIES,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationSeverity,
} from '@/lib/notifications/types'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

export type PreferenceCell = {
  category: NotificationCategory
  channel: NotificationChannel
  enabled: boolean
  minSeverity: NotificationSeverity
  /** False when this is the module default rather than a saved choice. */
  explicit: boolean
}

export type PreferenceMatrixProps = {
  channels: readonly NotificationChannel[]
  cells: readonly PreferenceCell[]
}

export function PreferenceMatrix({ channels, cells }: PreferenceMatrixProps) {
  const byKey = new Map(
    cells.map((cell) => [`${cell.category}/${cell.channel}`, cell]),
  )

  return (
    <div className="flex flex-col gap-6">
      {NOTIFICATION_CATEGORIES.map((category) => (
        <section
          key={category}
          className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-foreground">
              {CATEGORY_LABEL[category]}
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {CATEGORY_HINT[category]}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {channels.map((channel) => {
              const cell = byKey.get(`${category}/${channel}`)
              if (!cell) return null
              return (
                <PreferenceRow
                  key={channel}
                  cell={cell}
                  // A key that changes when the saved value does, so the
                  // optimistic local state is rebuilt from the server's answer
                  // after `router.refresh()` rather than fighting it.
                  cellKey={`${cell.enabled}/${cell.minSeverity}`}
                />
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function PreferenceRow({
  cell,
  cellKey,
}: {
  cell: PreferenceCell
  cellKey: string
}) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(cell.enabled)
  const [minSeverity, setMinSeverity] = useState(cell.minSeverity)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const save = useAsyncAction<void>()

  const persist = (next: {
    enabled: boolean
    minSeverity: NotificationSeverity
  }) => {
    setFailure(null)
    if (save.pending) return

    void save.run(async () => {
      const result = await savePreferenceAction({
        category: cell.category,
        channel: cell.channel,
        enabled: next.enabled,
        minSeverity: next.minSeverity,
      })

      if (!result.ok) {
        // Put the control back where the server still has it. A switch that
        // stays flipped after a refused save is a person who believes they
        // turned something off and did not.
        setEnabled(cell.enabled)
        setMinSeverity(cell.minSeverity)
        setFailure(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <div key={cellKey} className="flex flex-col gap-2">
      {failure && <ActionError error={failure} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Checkbox
          label={CHANNEL_LABEL[cell.channel]}
          checked={enabled}
          disabled={save.pending}
          onChange={(event) => {
            const next = event.target.checked
            setEnabled(next)
            persist({ enabled: next, minSeverity })
          }}
        />

        {enabled && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>מרמת</span>
            <Select
              className="h-9 w-40 text-sm"
              value={minSeverity}
              disabled={save.pending}
              onChange={(event) => {
                const next = event.target.value as NotificationSeverity
                setMinSeverity(next)
                persist({ enabled, minSeverity: next })
              }}
            >
              {NOTIFICATION_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {SEVERITY_LABEL[severity]}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>

      {!cell.explicit && (
        <p className="text-xs text-muted-foreground">
          זו ברירת המחדל. היא תשתנה אם נשנה אותה במערכת, עד שתבחרו כאן משהו אחר.
        </p>
      )}
    </div>
  )
}

/**
 * Shown instead of the grid when the business has only the in-app channel.
 *
 * Not an empty state and not an apology: one channel with one honest control
 * is a complete screen, and pretending otherwise would push somebody towards
 * an integration they may not want.
 */
export function SingleChannelNote() {
  return (
    <PanelNote>
      כרגע מחובר רק הערוץ במערכת, ולכן יש עמודה אחת. ברגע שיחובר דוא״ל או SMS,
      תופיע כאן עמודה נוספת לכל קטגוריה.
    </PanelNote>
  )
}
