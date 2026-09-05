'use client'

/**
 * The organization's own answer: which channels are on, and when it stays
 * quiet.
 *
 * ── Two things this form refuses to let somebody do ───────────────────────
 *
 *   · **Turn off the in-app channel.** It needs no credential, it is where
 *     every notification is recorded, and without it the routing engine would
 *     be deciding who to tell with nowhere for the answer to land — which
 *     reads on screen as a broken product rather than as a choice. The
 *     checkbox for it is disabled and says why; the operation refuses it
 *     again, and so does a check constraint in 0043. Three refusals, because
 *     a disabled checkbox is not enforcement.
 *
 *   · **Set an empty quiet window.** Equal start and end is 24 hours of
 *     silence dressed as configuration. If that is genuinely the intent, the
 *     switch above it says so honestly.
 *
 * Saved as one form rather than field by field, because these settings are
 * read together by the routing engine and a half-applied window is a rule
 * nobody wrote.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { saveNotificationSettingsAction } from '@/app/(app)/settings/notifications/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import { CHANNEL_HINT, CHANNEL_LABEL } from '@/lib/notifications/labels'
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@/lib/notifications/types'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

export type QuietHoursFormProps = {
  initial: {
    enabledChannels: readonly NotificationChannel[]
    quietHoursEnabled: boolean
    quietHoursStart: string
    quietHoursEnd: string
    timezone: string
    urgentOverridesQuietHours: boolean
    defaultEscalationMinutes: number
    retainReadDays: number
  }
  /** Channels with a transport behind them. The rest cannot be switched on. */
  configured: readonly NotificationChannel[]
}

export function QuietHoursForm({ initial, configured }: QuietHoursFormProps) {
  const router = useRouter()
  const configuredSet = new Set(configured)

  const [channels, setChannels] = useState<NotificationChannel[]>([
    ...initial.enabledChannels,
  ])
  const [quietEnabled, setQuietEnabled] = useState(initial.quietHoursEnabled)
  const [start, setStart] = useState(initial.quietHoursStart)
  const [end, setEnd] = useState(initial.quietHoursEnd)
  const [urgentOverrides, setUrgentOverrides] = useState(
    initial.urgentOverridesQuietHours,
  )
  const [escalationMinutes, setEscalationMinutes] = useState(
    String(initial.defaultEscalationMinutes),
  )
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)
  const save = useAsyncAction<void>()

  const toggle = (channel: NotificationChannel, on: boolean) => {
    setChannels((current) =>
      on
        ? current.includes(channel)
          ? current
          : [...current, channel]
        : current.filter((entry) => entry !== channel),
    )
  }

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(formEvent) => {
        formEvent.preventDefault()
        setFailure(null)
        setSaved(false)
        if (save.pending) return

        void save.run(async () => {
          const result = await saveNotificationSettingsAction({
            enabledChannels: channels,
            quietHoursEnabled: quietEnabled,
            quietHoursStart: start,
            quietHoursEnd: end,
            timezone: initial.timezone,
            urgentOverridesQuietHours: urgentOverrides,
            defaultEscalationMinutes: Number(escalationMinutes),
            retainReadDays: initial.retainReadDays,
            idempotencyKey: crypto.randomUUID(),
          })

          if (!result.ok) {
            setFailure(result.error)
            return
          }
          setSaved(true)
          router.refresh()
        })
      }}
    >
      {failure && <ActionError error={failure} />}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold text-foreground">
          ערוצים פעילים
        </legend>

        {NOTIFICATION_CHANNELS.map((channel) => {
          const isConfigured = configuredSet.has(channel)
          const locked = channel === 'in_app'

          return (
            <Checkbox
              key={channel}
              label={CHANNEL_LABEL[channel]}
              description={
                locked
                  ? 'תמיד פעיל. זהו המקום שבו כל ההתראות נשמרות, והוא לא דורש חיבור חיצוני.'
                  : isConfigured
                    ? CHANNEL_HINT[channel]
                    : 'אין ספק מחובר לערוץ הזה, ולכן הפעלתו לא תשלח דבר — היא רק תרשום כמה הודעות היו יוצאות.'
              }
              checked={channels.includes(channel)}
              disabled={locked || save.pending}
              onChange={(inputEvent) =>
                toggle(channel, inputEvent.target.checked)
              }
            />
          )
        })}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold text-foreground">
          שעות שקט
        </legend>

        <Checkbox
          label="להחזיק הודעות בשעות מסוימות"
          description="ההתראה נרשמת תמיד ומופיעה בפעמון. שעות השקט קובעות רק מתי מותר להעיר מישהו בערוץ חיצוני."
          checked={quietEnabled}
          disabled={save.pending}
          onChange={(inputEvent) => setQuietEnabled(inputEvent.target.checked)}
        />

        {quietEnabled && (
          <div className="flex flex-col gap-3 sm:flex-row">
            <Field label="מתחילות" description={`לפי ${initial.timezone}`}>
              <TextInput
                type="time"
                value={start}
                dir="ltr"
                disabled={save.pending}
                onChange={(inputEvent) => setStart(inputEvent.target.value)}
              />
            </Field>
            <Field label="נגמרות">
              <TextInput
                type="time"
                value={end}
                dir="ltr"
                disabled={save.pending}
                onChange={(inputEvent) => setEnd(inputEvent.target.value)}
              />
            </Field>
          </div>
        )}

        {quietEnabled && (
          <Checkbox
            label="התראות דחופות עוברות גם בשעות שקט"
            description="תשלום שתוצאתו לא ידועה בחצות הוא בדיוק המקרה שבו עסק רוצה שיעירו אותו."
            checked={urgentOverrides}
            disabled={save.pending}
            onChange={(inputEvent) =>
              setUrgentOverrides(inputEvent.target.checked)
            }
          />
        )}
      </fieldset>

      <Field
        label="דקות עד הסלמה"
        description="כמה זמן התראה דחופה יכולה להישאר בלי שאף אחד יסמן אותה כטופלה, לפני שהיא עולה לדרג הבא."
      >
        <TextInput
          type="number"
          min={1}
          max={10080}
          value={escalationMinutes}
          dir="ltr"
          disabled={save.pending}
          onChange={(inputEvent) =>
            setEscalationMinutes(inputEvent.target.value)
          }
        />
      </Field>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.pending}>
          {save.pending ? 'שומר…' : 'שמירה'}
        </Button>
        {saved && !save.pending && (
          <span role="status" className="text-sm text-muted-foreground">
            נשמר.
          </span>
        )}
      </div>
    </form>
  )
}
