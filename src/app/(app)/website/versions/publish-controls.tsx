'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. The three acts, and who may do them.
 *
 * ── The publish button tells the truth before it is pressed ──────────────
 *
 * `blockers` comes from the SAME pre-publish pass the operation runs, so when
 * a claim cannot be sourced the button is disabled and the reason is on
 * screen. The alternative — an enabled button that fails — teaches people the
 * product is unreliable, when in fact it is refusing correctly.
 *
 * The disabled state is a convenience, not the enforcement. The action asserts
 * the grant, the operation asserts it again, the policy asserts it a third
 * time, and `buildSnapshot` refuses the unsourced claim regardless of what
 * this component rendered.
 *
 * ── Rolling back says what it does not do ────────────────────────────────
 *
 * "יוצר גרסה חדשה ולא מוחק את הגרסאות שאחריה" is written next to the control,
 * because the fear that stops somebody rolling back at 21:00 is that they will
 * lose the work they did at 18:00. They will not, and being told is what makes
 * the guarantee useful.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors'
import type { SiteStatus } from '@/lib/website/types'

import { publishAction, rollbackAction, unpublishAction } from '../_lib/actions'

type Target = {
  id: string
  versionNumber: number
  publishedAt: string
  label: string | null
}

export function PublishControls({
  siteId,
  status,
  canPublish,
  canRollback,
  blockers,
  rollbackTargets,
}: {
  siteId: string
  status: SiteStatus
  canPublish: boolean
  canRollback: boolean
  blockers: readonly string[]
  rollbackTargets: readonly Target[]
}) {
  const router = useRouter()

  const [label, setLabel] = useState('')
  const [target, setTarget] = useState(rollbackTargets[0]?.id ?? '')
  const [pending, setPending] = useState<
    null | 'publish' | 'rollback' | 'down'
  >(null)
  const [error, setError] = useState<SafeErrorBody | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function run(
    kind: 'publish' | 'rollback' | 'down',
    call: () => Promise<
      { ok: true; data: unknown } | { ok: false; error: SafeErrorBody }
    >,
  ) {
    setPending(kind)
    setError(null)
    setNote(null)

    const result = await call()
    setPending(null)

    if (result.ok) {
      setNote(
        kind === 'publish'
          ? 'האתר באוויר.'
          : kind === 'rollback'
            ? 'הוחזרה גרסה קודמת, כגרסה חדשה. שום גרסה לא נמחקה.'
            : 'האתר הורד מהאוויר. כל הגרסאות נשמרו.',
      )
      router.refresh()
    } else {
      setError(result.error)
    }
  }

  return (
    <Card tone="featured">
      <CardHeader>
        <CardTitle as="h2">פרסום</CardTitle>
        <CardDescription>
          פרסום הוא פעולה נפרדת מעריכה. מה שאתם עורכים אינו באוויר עד שמישהו עם
          הרשאת פרסום יעלה אותו.
        </CardDescription>
      </CardHeader>

      <div className="mt-5 flex flex-col gap-6">
        {blockers.length > 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4">
            <p className="text-sm font-medium text-foreground">
              הפרסום חסום — {blockers.length} דברים לתקן
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
              {blockers.map((blocker) => (
                <li key={blocker}>· {blocker}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {canPublish ? (
          <div className="flex flex-col gap-3">
            <Field
              label="שם לגרסה (לא חובה)"
              description="עוזר למצוא אותה אחר כך, למשל ״מחירי קיץ״."
            >
              <TextInput
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={60}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={pending !== null || blockers.length > 0}
                onClick={() =>
                  run('publish', () =>
                    publishAction({
                      siteId,
                      label: label.trim() || null,
                    }),
                  )
                }
              >
                {pending === 'publish' ? 'מפרסם…' : 'פרסום האתר'}
              </Button>

              {status === 'published' ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending !== null}
                  onClick={() => run('down', () => unpublishAction({ siteId }))}
                >
                  {pending === 'down' ? 'מוריד…' : 'הורדה מהאוויר'}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            אין לכם הרשאת פרסום. אפשר לערוך ולראות תצוגה מקדימה; מי שמעלה לאוויר
            הוא בעל הרשאת פרסום.
          </p>
        )}

        {canRollback && rollbackTargets.length > 0 ? (
          <div className="flex flex-col gap-3 border-t border-border pt-5">
            <Field
              label="חזרה לגרסה קודמת"
              // The sentence that removes the fear.
              description="יוצר גרסה חדשה עם התוכן הישן. הגרסאות שאחריה נשמרות, ואפשר לחזור אליהן בחזרה."
            >
              <Select
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                {rollbackTargets.map((option) => (
                  <option key={option.id} value={option.id}>
                    גרסה {option.versionNumber}
                    {option.label ? ` · ${option.label}` : ''} ·{' '}
                    {new Date(option.publishedAt).toLocaleDateString('he-IL')}
                  </option>
                ))}
              </Select>
            </Field>

            <Button
              type="button"
              variant="secondary"
              disabled={pending !== null || target === ''}
              className="self-start"
              onClick={() =>
                run('rollback', () =>
                  rollbackAction({ siteId, versionId: target }),
                )
              }
            >
              {pending === 'rollback' ? 'משחזר…' : 'חזרה לגרסה הזו'}
            </Button>
          </div>
        ) : null}

        {error ? <ActionError error={error} /> : null}
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </div>
    </Card>
  )
}
