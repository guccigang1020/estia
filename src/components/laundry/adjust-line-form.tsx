'use client'

/**
 * Changing a quantity, with the reason that makes it an override.
 *
 * ── What this file may import ─────────────────────────────────────────────
 *
 * The Server Action, the UI primitives, and nothing else. In particular NOT
 * `@/lib/laundry`: that barrel re-exports the operations module, which imports
 * `@/lib/persistence`, which imports the `postgres` driver, which imports
 * `fs`. Pulled into a browser bundle that is not a broken form — it is every
 * page in the application returning 500. It happened on this dev server from
 * exactly that chain in another module.
 *
 * `SafeErrorBody` is imported, and safely, because `import type` is erased
 * before bundling and can pull nothing in. That one keyword is the whole
 * difference between a shared type and an outage, which is exactly why
 * `src/lib/laundry/client-safety.test.ts` follows the graph rather than
 * trusting anybody to notice it in review.
 *
 * ── Why the calculated figure is on screen while you edit ─────────────────
 *
 * The field asks for a DIFFERENCE, not a replacement, and the engine's figure
 * sits above it unchanged. That is the three-column model made visible: a
 * person typing "+4" can see they are adding four to twenty-eight, and the
 * record afterwards can still answer "did we send the wrong number, or did the
 * engine get it wrong".
 */

import { useActionState } from 'react'

import { ActionError } from '@/components/booking/action-error'
import { SubmitButton } from '@/components/ui/async-action'
import { Field } from '@/components/ui/field'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { TextInput } from '@/components/ui/input'

type Result =
  | { ok: true; data: { lineId: string; final: number } }
  | { ok: false; error: SafeErrorBody }

export type AdjustLineFormProps = {
  orderId: string
  lineId: string
  label: string
  /** The engine's figure. Shown, never edited. */
  calculated: number
  /** What the difference currently is, so the field opens on the truth. */
  adjustment: number
  reason: string | null
  version: number
  /** Bound by the page. Takes the order id and the form. */
  action: (orderId: string, formData: FormData) => Promise<Result>
}

export function AdjustLineForm({
  orderId,
  lineId,
  label,
  calculated,
  adjustment,
  reason,
  version,
  action,
}: AdjustLineFormProps) {
  const [state, formAction] = useActionState(
    async (_previous: Result | null, formData: FormData) =>
      action(orderId, formData),
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="lineId" value={lineId} />
      <input type="hidden" name="version" value={version} />

      <p className="text-xs text-muted-foreground">
        חישוב המערכת עבור {label}:{' '}
        <span className="font-semibold tabular-nums text-foreground">
          {calculated}
        </span>
        . השדה הבא הוא ההפרש, לא הכמות הסופית.
      </p>

      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <Field label="שינוי כמות" required>
          <TextInput
            name="adjustment"
            type="number"
            inputMode="numeric"
            defaultValue={adjustment}
            required
          />
        </Field>

        <Field
          label="נימוק"
          description="מה שנכתב כאן הוא מה שיוסבר בעוד שלושה שבועות."
          required
        >
          <TextInput
            name="reason"
            defaultValue={reason ?? ''}
            minLength={3}
            maxLength={500}
            required
          />
        </Field>
      </div>

      {state !== null && !state.ok && <ActionError error={state.error} />}

      {state !== null && state.ok && (
        <p role="status" className="text-xs font-semibold text-success">
          הכמות עודכנה ל-{state.data.final}. חישוב המערכת ({calculated}) נשמר.
        </p>
      )}

      <div>
        <SubmitButton pendingLabel="שומר…" variant="secondary" size="sm">
          שמירת שינוי
        </SubmitButton>
      </div>
    </form>
  )
}
