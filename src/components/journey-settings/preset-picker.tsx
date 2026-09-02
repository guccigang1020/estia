'use client'

/**
 * Three named starting points, and what each of them would change.
 *
 * ── Nothing is applied before it has been shown ───────────────────────────
 *
 * Choosing a preset opens `resolvePreset` — the same pure function the
 * operation calls on the server — and renders its two outputs: the field-by-
 * field difference, and the notes saying where the preset could not have its
 * way. Only then is there a button, and the button says what it will do.
 *
 * That the screen and the write share one resolver is the point. If the
 * difference on screen came from anywhere else, the button could save
 * something other than what the reader agreed to.
 *
 * ── A preset is not a mode ────────────────────────────────────────────────
 *
 * After it is applied every field is editable in the form below, and nothing
 * anywhere records that a preset was ever chosen. A business that applies
 * "ניהול מקצועי" and then switches the contract off is not in a broken state;
 * it has a configuration, which is the only thing this product stores.
 *
 * ── Leaf imports only ─────────────────────────────────────────────────────
 *
 * `@/lib/guest-journey/presets` is pure. `@/lib/guest-journey/settings` is not
 * — it reaches the Postgres driver — and importing it here would take every
 * route in the application down with `Can't resolve 'fs'`.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  applyJourneyPresetAction,
  type ApplyPresetActionInput,
} from '@/app/(app)/settings/guest-journey/_lib/actions'
import { ActionError } from '@/components/booking/action-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAsyncAction } from '@/components/ui/async-action'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import {
  JOURNEY_PRESETS,
  JOURNEY_SECTION_LABEL,
  resolvePreset,
  type JourneyPresetId,
} from '@/lib/guest-journey/presets'
import type { GuestJourneySettings } from '@/lib/guest-journey/types'

export function PresetPicker({
  current,
  expectedVersion,
}: {
  /** What is in force now — the saved row, or the shipped defaults. */
  current: GuestJourneySettings
  /** `null` when no row exists yet, so applying will create one. */
  expectedVersion: number | null
}) {
  const router = useRouter()
  const [openId, setOpenId] = useState<JourneyPresetId | null>(null)
  const [failure, setFailure] = useState<SafeErrorBody | null>(null)
  const [applied, setApplied] = useState<string | null>(null)

  const apply = useAsyncAction<void>()

  return (
    <div className="flex flex-col gap-4">
      {failure && <ActionError error={failure} />}

      <p className="text-sm text-muted-foreground">
        תבנית היא נקודת פתיחה, לא מצב. היא ממלאת את אותן הגדרות שאפשר לשנות
        ידנית, ואחרי שהוחלה אין שום דבר שנעול — כל סעיף בטופס שלמטה ניתן לשינוי.
      </p>

      <ul className="flex flex-col gap-3">
        {JOURNEY_PRESETS.map((preset) => {
          const resolution = resolvePreset(current, preset)
          const isCurrent = resolution.changes.length === 0
          const isOpen = openId === preset.id

          return (
            <li
              key={preset.id}
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-base font-bold text-foreground">
                    {preset.label}
                  </h3>
                  {isCurrent && <Badge tone="brand">ההגדרות הנוכחיות</Badge>}
                </div>

                {!isCurrent && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={apply.pending}
                    onClick={() => setOpenId(isOpen ? null : preset.id)}
                  >
                    {isOpen
                      ? 'סגור'
                      : `הצג מה ישתנה (${resolution.changes.length})`}
                  </Button>
                )}
              </div>

              <p className="text-sm text-muted-foreground">{preset.audience}</p>

              <p className="text-xs text-muted-foreground">
                גבייה: {preset.paymentGuidance.sentence}
              </p>

              {isOpen && !isCurrent && (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4">
                  <p className="text-sm text-foreground">
                    {resolution.changes.length} הגדרות ישתנו. שום דבר אחר לא
                    ייגע.
                  </p>

                  <ul className="flex flex-col">
                    {resolution.changes.map((change) => (
                      <li
                        key={change.field}
                        className="flex flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {change.label}
                          </span>
                          <Badge>{JOURNEY_SECTION_LABEL[change.section]}</Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {change.from} ← {change.to}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* Where the preset could not have its way. Said before the
                      button, never discovered afterwards. */}
                  <ul className="flex flex-col gap-1">
                    {resolution.notes.map((note) => (
                      <li key={note} className="text-sm text-muted-foreground">
                        · {note}
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      disabled={apply.pending}
                      onClick={() => {
                        setFailure(null)
                        setApplied(null)
                        if (apply.pending) return

                        const input: ApplyPresetActionInput = {
                          presetId: preset.id,
                          expectedVersion,
                          idempotencyKey: crypto.randomUUID(),
                        }

                        void apply.run(async () => {
                          const result = await applyJourneyPresetAction(input)
                          if (!result.ok) {
                            setFailure(result.error)
                            return
                          }
                          setOpenId(null)
                          setApplied(preset.label)
                          router.refresh()
                        })
                      }}
                    >
                      {apply.pending ? 'מחיל…' : `החל את "${preset.label}"`}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {applied && (
        <p role="status" className="text-sm text-muted-foreground">
          התבנית &quot;{applied}&quot; הוחלה. כל הגדרה בטופס שלמטה ניתנת לשינוי
          מכאן והלאה.
        </p>
      )}
    </div>
  )
}
