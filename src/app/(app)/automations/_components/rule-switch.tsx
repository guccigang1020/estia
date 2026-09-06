'use client'

/**
 * The control that finally exists: switching one rule on, off, and adjusting
 * the number inside it.
 *
 * ── It says what it will do before it does it ─────────────────────────────
 *
 * Switching an automation on is not like saving a filter. It is a business
 * deciding that software may act on its behalf — message a guest, issue a
 * document, block a date — so the button is preceded by the sentence that
 * describes the consequence, in Hebrew, and the rules that speak to guests or
 * spend money say so a second time before the click.
 *
 * ── And it says what it will NOT do ───────────────────────────────────────
 *
 * Nothing runs these rules yet. There is no dispatcher feeding live events to
 * the engine and no performer behind any of the eight action kinds, so the
 * switch records a decision rather than starting a machine. That is stated
 * here, next to the control, and not only in a banner somewhere above — the
 * belief a person forms is formed at the moment they press the button. Hiding
 * it would make this the exact screen the rest of the module refuses to be:
 * one that looks like it is working.
 *
 * ── Scope is shown, never inferred silently ───────────────────────────────
 *
 * The button writes the state for whatever the shell's property switcher is
 * pointing at — the whole organization, or one property — and says which
 * before it is pressed. A manager who believes they are switching a rule off
 * everywhere and is switching it off at one property is the failure this line
 * of text exists to prevent.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { fromSafeError } from '@/components/states/error-copy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'
import type { RuleParameter } from '@/lib/automation/parameters'
import { RULE_SOURCE_LABEL, type RuleSource } from '@/lib/automation/state'
import type { SafeErrorBody } from '@/lib/errors/safe-response'

import {
  disableAutomationAction,
  enableAutomationAction,
  setAutomationParametersAction,
} from '../_lib/actions'

export interface RuleSwitchProps {
  templateId: string
  ruleName: string
  enabled: boolean
  source: RuleSource
  /** The stored row's version, or null when no row exists yet. */
  storedVersion: number | null
  /** Null is the organization, for every property. */
  propertyId: string | null
  propertyName: string | null
  parameters: readonly RuleParameter[]
  values: Readonly<Record<string, number>>
  /** How many properties have overridden this rule for themselves. */
  overrideCount: number
  canManage: boolean
  /**
   * True when a rule speaks to a guest, spends money or issues a document.
   *
   * Not a colour: it changes the sentence above the button, because the cost
   * of being wrong about these is a message in somebody's customer's telephone
   * rather than a redundant line in a staff feed.
   */
  reachesGuest: boolean
}

export function RuleSwitch(props: RuleSwitchProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      props.parameters.map((parameter) => [
        parameter.key,
        String(props.values[parameter.key] ?? parameter.shipped),
      ]),
    ),
  )

  const scope =
    props.propertyId === null
      ? 'בכל הנכסים בארגון'
      : `בנכס ״${props.propertyName ?? 'הנבחר'}״ בלבד`

  async function run(
    work: () => Promise<{ ok: boolean; error?: SafeErrorBody }>,
  ) {
    setBusy(true)
    setError(null)
    const outcome = await work()
    setBusy(false)

    if (outcome.ok) {
      router.refresh()
      return
    }
    setError(outcome.error ?? null)
  }

  // The version travels with every write, so a change made against a state
  // somebody else has already moved is refused rather than applied on top of
  // theirs. Absent for a rule nobody has configured, which has no version.
  const versionOf = () =>
    props.storedVersion === null ? {} : { expectedVersion: props.storedVersion }

  function toggle() {
    const base = {
      templateId: props.templateId,
      propertyId: props.propertyId,
      idempotencyKey: crypto.randomUUID(),
      ...versionOf(),
    }
    return run(() =>
      props.enabled
        ? disableAutomationAction(base)
        : enableAutomationAction(base),
    )
  }

  function saveParameters() {
    const pairs = props.parameters
      .map((parameter) => ({
        name: parameter.key,
        value: Number(draft[parameter.key]),
      }))
      .filter((pair) => Number.isFinite(pair.value))

    return run(() =>
      setAutomationParametersAction({
        templateId: props.templateId,
        propertyId: props.propertyId,
        parameters: pairs,
        idempotencyKey: crypto.randomUUID(),
        ...versionOf(),
      }),
    )
  }

  const outOfRange = props.parameters.filter((parameter) => {
    const value = Number(draft[parameter.key])
    return (
      !Number.isFinite(value) || value < parameter.min || value > parameter.max
    )
  })

  const changed = props.parameters.some(
    (parameter) =>
      Number(draft[parameter.key]) !==
      (props.values[parameter.key] ?? parameter.shipped),
  )

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-strong bg-muted px-4 py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge tone={props.enabled ? 'brand' : 'neutral'}>
          {props.enabled ? 'דולק' : 'כבוי'}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {RULE_SOURCE_LABEL[props.source]}
        </span>
      </div>

      {/* What the switch is about to change, and where. Before the button. */}
      <p className="text-sm text-foreground">
        {props.enabled
          ? `הכלל דולק ${scope}. כיבוי יעצור אותו שם, ולא בנכסים אחרים.`
          : `הפעלה תדליק את הכלל ${scope}.`}
        {props.reachesGuest && !props.enabled && (
          <span className="font-semibold">
            {' '}
            הכלל הזה פונה לאורח או מוציא מסמך — כדאי לאשר את הנוסח לפני
            שמדליקים.
          </span>
        )}
      </p>

      {props.overrideCount > 0 && (
        <p className="text-xs text-muted-foreground">
          ל-{props.overrideCount} נכסים יש הגדרה משלהם לכלל הזה, והיא גוברת על
          הגדרת הארגון. שינוי כאן לא ישנה אותם.
        </p>
      )}

      {/* The absence, stated where the belief is formed. */}
      <p className="rounded border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        ההחלטה נשמרת, אבל שום דבר עדיין לא מריץ אותה: אין במוצר רכיב שמזין את
        מנוע האוטומציות באירועים חיים, ואין מבצע לאף אחת מהפעולות. כלל שדולק כאן
        הוא הכוונה שתירשם, ולא פעולה שמתחילה עכשיו.
      </p>

      {props.canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={props.enabled ? 'secondary' : 'primary'}
            disabled={busy}
            onClick={toggle}
          >
            {props.enabled ? 'כיבוי הכלל' : 'הפעלת הכלל'}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          התפקיד שלך אינו כולל ניהול אוטומציות, ולכן אין כאן מתג. מנהל בארגון
          יכול להוסיף את ההרשאה.
        </p>
      )}

      {props.parameters.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          לכלל הזה אין ערכים להתאמה — הוא פועל בכל פעם שהאירוע קורה, בלי סף.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {props.parameters.map((parameter) => (
            <Field
              key={parameter.key}
              label={`${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ''}`}
              description={parameter.help}
              error={
                outOfRange.some((entry) => entry.key === parameter.key)
                  ? `הערך חייב להיות בין ${parameter.min} ל-${parameter.max}.`
                  : undefined
              }
            >
              <TextInput
                type="number"
                inputMode="numeric"
                min={parameter.min}
                max={parameter.max}
                value={draft[parameter.key] ?? ''}
                disabled={!props.canManage || busy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [parameter.key]: event.target.value,
                  }))
                }
              />
            </Field>
          ))}

          {props.canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy || outOfRange.length > 0 || !changed}
                onClick={saveParameters}
              >
                שמירת הסף
              </Button>
              <span className="text-xs text-muted-foreground">
                שינוי הסף אינו מדליק ואינו מכבה את הכלל.
              </span>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-danger" role="alert">
          {fromSafeError(error).title}
        </p>
      )}
    </section>
  )
}
