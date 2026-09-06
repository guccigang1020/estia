'use client'

/**
 * Writing the wording a guest will read.
 *
 * ── The placeholder list is not decoration ────────────────────────────────
 *
 * It is the only way somebody knows `{{door_code}}` is not a thing. Every
 * token the product can fill is shown, insertable, and — where it can be
 * absent — carries the exact text that will appear instead. A business that
 * writes `{{amount}}` deserves to know beforehand that a guest may read
 * "יתרה לתשלום" rather than a number.
 *
 * ── Validation runs here as a courtesy and on the server as the rule ──────
 *
 * The red line appears while somebody is still typing, which is the whole
 * value of it. But `template-operations.ts` runs the same `validateTemplate`
 * in `rule()`, so this file being wrong or bypassed changes nothing about
 * what can be saved.
 *
 * ── The preview uses the real renderer ────────────────────────────────────
 *
 * `renderTemplate`, not a lookalike. A preview drawn by a second
 * implementation would eventually disagree with the sender, and the first
 * person to find out would be a guest.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { fromSafeError } from '@/components/states/error-copy'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import {
  PLACEHOLDERS_FOR,
  renderTemplate,
  validateTemplate,
} from '@/lib/messaging/templates'
import type { GuestChannel, GuestMessageKind } from '@/lib/messaging/types'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import { removeTemplateAction, saveTemplateAction } from './_lib/actions'

/** A stand-in booking, so the preview shows shape rather than lorem ipsum. */
const SAMPLE = {
  guest_first_name: 'דנה',
  organization_name: 'אחוזת הגליל',
  property_name: 'בית הכרם',
  reference: 'B-2026-0141',
  check_in: '12.08',
  check_out: '14.08',
  amount: '₪450',
  portal_url: 'https://estia.example/g/abc123',
}

const PROBLEM_TEXT: Record<string, (token?: string, n?: number) => string> = {
  unknown_placeholder: (token) =>
    `אין במוצר שדה בשם {{${token}}}. אורח יראה את הסוגריים כפי שהם.`,
  wrong_kind: (token) => `השדה {{${token}}} אינו זמין בסוג ההודעה הזה.`,
  too_long: (_t, n) => `ארוך מדי (${n} תווים). SMS מחויב לפי 70 תווים בעברית.`,
  empty: () => 'הנוסח ריק.',
}

export function TemplateEditor({
  kind,
  channel,
  existing,
}: {
  kind: GuestMessageKind
  channel: GuestChannel | null
  existing: { id: string; body: string; isActive: boolean } | null
}) {
  const router = useRouter()
  const [body, setBody] = useState(existing?.body ?? '')
  const [isActive, setIsActive] = useState(existing?.isActive ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  const problems = body.trim() === '' ? [] : validateTemplate(kind, body)
  const placeholders = PLACEHOLDERS_FOR[kind]

  async function save() {
    setBusy(true)
    setError(null)
    const outcome = await saveTemplateAction({
      kind,
      channel,
      subject: null,
      body,
      isActive,
      idempotencyKey: crypto.randomUUID(),
    })
    setBusy(false)
    if (outcome.ok) router.refresh()
    else setError(outcome.error)
  }

  async function remove() {
    if (!existing) return
    setBusy(true)
    setError(null)
    const outcome = await removeTemplateAction({
      templateId: existing.id,
      idempotencyKey: crypto.randomUUID(),
    })
    setBusy(false)
    if (outcome.ok) {
      setBody('')
      router.refresh()
    } else setError(outcome.error)
  }

  return (
    <div className="space-y-3">
      <Field
        label="הנוסח"
        description="השאירו ריק כדי להשתמש בנוסח ברירת המחדל של המערכת."
      >
        <Textarea
          value={body}
          rows={6}
          dir="rtl"
          onChange={(event) => setBody(event.target.value)}
        />
      </Field>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          שדות שאפשר לשלב. לחיצה מוסיפה לסוף:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {placeholders.map((placeholder) => (
            <button
              key={placeholder.name}
              type="button"
              onClick={() =>
                setBody((current) => `${current}{{${placeholder.name}}}`)
              }
              className="rounded-md border px-2 py-1 text-xs"
              title={
                placeholder.whenAbsent === null
                  ? 'תמיד קיים'
                  : `אם חסר, האורח יראה: "${placeholder.whenAbsent}"`
              }
            >
              {placeholder.label}
              {placeholder.whenAbsent !== null && ' ⚠'}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          ⚠ מסומן על שדה שעשוי להיות חסר. ריחוף מראה מה האורח יקבל במקומו.
        </p>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1 text-xs text-destructive">
          {problems.map((problem, index) => (
            <li key={index}>
              {PROBLEM_TEXT[problem.kind]?.(
                'token' in problem ? problem.token : undefined,
                'length' in problem ? problem.length : undefined,
              ) ?? 'הנוסח אינו תקין.'}
            </li>
          ))}
        </ul>
      )}

      {body.trim() !== '' && problems.length === 0 && (
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="mb-1 text-xs text-muted-foreground">
            כך זה ייראה לאורח:
          </p>
          <p className="whitespace-pre-wrap text-sm">
            {renderTemplate(body, SAMPLE)}
          </p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
        />
        פעיל — כשהוא כבוי, ההודעות חוזרות לנוסח ברירת המחדל
      </label>

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={busy || body.trim() === '' || problems.length > 0}
          onClick={save}
        >
          שמירה
        </Button>
        {existing && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={remove}
          >
            מחיקה
          </Button>
        )}
      </div>

      {error && (
        <p className="text-xs text-destructive">{fromSafeError(error).title}</p>
      )}
    </div>
  )
}
