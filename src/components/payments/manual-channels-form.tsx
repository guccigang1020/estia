'use client'

/**
 * The ways this business is actually paid.
 *
 * Each channel saves on its own, rather than the whole list saving together.
 * That is a deliberate cost: a business turning on Bit at the desk should not
 * have to re-submit the bank details it typed last month, and an error on one
 * row must not discard the other six.
 *
 * The instruction text is the substance here, not a nicety — it is verbatim
 * what the guest reads, and the field says so.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { saveManualChannelAction } from '@/app/(app)/settings/payments/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Textarea, TextInput } from '@/components/ui/input'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
// Leaf modules, never the `@/lib/payments` barrel. The barrel re-exports the
// Supabase adapter, which imports `src/lib/persistence` and through it the
// `postgres` driver — Node-only, and a hard build failure the moment Next
// traces it into a client bundle. This was not a theory: the settings screen
// returned 500 until these two imports were narrowed. A client component takes
// the vocabulary and the types, and nothing that talks to a database.
import {
  MANUAL_CHANNEL_HINT,
  MANUAL_CHANNEL_LABEL,
  requiresInstructions,
} from '@/lib/payments/channels'
import type { ManualChannel } from '@/lib/payments/types'

export function ManualChannelsForm({
  channels,
}: {
  channels: readonly ManualChannel[]
}) {
  return (
    <div className="flex flex-col gap-4">
      {channels.map((channel) => (
        <ChannelRow key={channel.channel} channel={channel} />
      ))}
    </div>
  )
}

function ChannelRow({ channel }: { channel: ManualChannel }) {
  const router = useRouter()

  const [enabled, setEnabled] = useState(channel.enabled)
  const [displayName, setDisplayName] = useState(channel.displayName ?? '')
  const [instructions, setInstructions] = useState(channel.instructions ?? '')
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)

  const save = useAsyncAction<void>()

  const needsInstructions = requiresInstructions(channel.channel)
  const dirty =
    enabled !== channel.enabled ||
    displayName !== (channel.displayName ?? '') ||
    instructions !== (channel.instructions ?? '')

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault()
        setFailure(null)
        setSaved(false)
        if (save.pending) return

        void save.run(async () => {
          const result = await saveManualChannelAction({
            channel: channel.channel,
            enabled,
            displayName:
              displayName.trim().length > 0 ? displayName.trim() : null,
            instructions:
              instructions.trim().length > 0 ? instructions.trim() : null,
            sortOrder: channel.sortOrder,
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
      noValidate
    >
      {failure && <ActionError error={failure} />}

      <Checkbox
        label={MANUAL_CHANNEL_LABEL[channel.channel]}
        description={MANUAL_CHANNEL_HINT[channel.channel]}
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
        disabled={save.pending}
      />

      {enabled && (
        <>
          <Field label="שם לתצוגה" description="ריק פירושו השם הרגיל של הערוץ.">
            <TextInput
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={80}
              disabled={save.pending}
            />
          </Field>

          <Field
            label="הוראות לאורח"
            description="זה בדיוק מה שהאורח יראה. אפשר לכתוב בכמה שורות."
            required={needsInstructions}
          >
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={2000}
              disabled={save.pending}
            />
          </Field>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={save.pending || !dirty}
        >
          {save.pending ? 'שומר…' : 'שמור'}
        </Button>
        {saved && (
          <span role="status" className="text-sm text-muted-foreground">
            נשמר.
          </span>
        )}
      </div>
    </form>
  )
}
