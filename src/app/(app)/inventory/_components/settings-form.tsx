'use client'

/**
 * The one screen that decides whether the rest of this module exists.
 *
 * ── `off` is offered first and framed as an answer ────────────────────────
 *
 * The mode select opens with "כבוי", the summary beside it says in as many
 * words that bookings, preparation, the cleaner's plan, the laundry list and
 * finance all keep working, and nothing on this form implies that a business
 * ought to move up the ladder. A settings screen that shames its default is a
 * settings screen that pushes people into a module they will abandon.
 *
 * ── Every field says what it costs to get wrong ───────────────────────────
 *
 * The turnaround is the clearest case. Leaving it empty is a real choice — the
 * forecast then projects no returns at all, which over-reports shortages — and
 * setting it too low promises towels that are still in the machine. Both
 * sentences are on the field, because that is where somebody is standing when
 * they decide.
 *
 * ── The flags below the mode are not redundant with it ────────────────────
 *
 * The mode sets what is *available*; the flags set what is *on*. A business
 * inside `advanced` whose cleaners do not count linen back in turns discrepancy
 * tracking off, and `capabilitiesFor` is the one place the two are combined.
 * The form shows the flags a mode cannot support as disabled rather than
 * hiding them, so the ladder is legible.
 */

import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Checkbox, Select, TextInput } from '@/components/ui/input'
import type { InventoryMode } from '@/lib/contracts/states'
import {
  INVENTORY_MODE_LABEL,
  INVENTORY_MODE_OPTIONS,
  INVENTORY_MODE_SUMMARY,
  capabilitiesFor,
  type InventorySettings,
} from '@/lib/inventory'

import { saveInventorySettingsAction } from '../_lib/actions'

export function InventorySettingsForm({
  settings,
}: {
  settings: InventorySettings
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [mode, setMode] = useState<InventoryMode>(settings.mode)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // What the *chosen* mode could support, before the flags narrow it. Computed
  // with every flag on, so the checkbox below is disabled exactly when the mode
  // is what forbids it rather than when the current setting happens to be off.
  const possible = capabilitiesFor({
    ...settings,
    mode,
    reservationsEnabled: true,
    transfersEnabled: true,
    discrepancyTracking: true,
    linenTurnaroundDays: settings.linenTurnaroundDays ?? 2,
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const number = (key: string, fallback: number) => {
      const raw = String(form.get(key) ?? '').trim()
      return raw.length === 0 ? fallback : Number(raw)
    }
    const turnaroundRaw = String(form.get('linenTurnaroundDays') ?? '').trim()

    startTransition(async () => {
      const result = await saveInventorySettingsAction({
        ...settings,
        mode,
        safetyBufferUnits: number('safetyBufferUnits', 0),
        safetyBufferPercent: number('safetyBufferPercent', 0),
        shortageWarningHorizonDays: number('shortageWarningHorizonDays', 7),
        forecastHorizonDays: number('forecastHorizonDays', 30),
        // Empty stays null. "We have not said" must not be written down as a
        // guess the forecast then treats as a fact.
        linenTurnaroundDays:
          turnaroundRaw.length === 0 ? null : Number(turnaroundRaw),
        sharedStock: form.get('sharedStock') === 'on',
        reservationsEnabled: form.get('reservationsEnabled') === 'on',
        warehouseEnabled: form.get('warehouseEnabled') === 'on',
        discrepancyTracking: form.get('discrepancyTracking') === 'on',
        transfersEnabled: form.get('transfersEnabled') === 'on',
      })

      if (result.ok) {
        setFailure(null)
        setMessage('ההגדרות נשמרו.')
        router.refresh()
      } else {
        setMessage(null)
        setFailure(result.error.message)
      }
    })
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-6"
      aria-label="הגדרות מלאי"
    >
      {message !== null && (
        <p
          role="status"
          className="rounded-lg border border-accent bg-surface px-4 py-3 text-sm text-foreground"
        >
          {message}
        </p>
      )}
      {failure !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          {failure}
        </p>
      )}

      <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
        <Field label="רמת המודול">
          <Select
            value={mode}
            onChange={(event) => setMode(event.target.value as InventoryMode)}
          >
            {INVENTORY_MODE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {INVENTORY_MODE_LABEL[option]}
              </option>
            ))}
          </Select>
        </Field>
        <p className="max-w-prose text-sm text-muted-foreground">
          {INVENTORY_MODE_SUMMARY[mode]}
        </p>
      </section>

      {mode !== 'off' && (
        <>
          <section className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-2 sm:p-5">
            <Field
              label="מלאי ביטחון ביחידות"
              description="הרצפה שנשמרת להזמנה שעדיין לא התקבלה. ירידה מתחתיה אינה חוסמת דבר — היא מדווחת."
            >
              <TextInput
                name="safetyBufferUnits"
                type="number"
                min={0}
                defaultValue={settings.safetyBufferUnits}
              />
            </Field>

            <Field
              label="מלאי ביטחון באחוזים מרמת היעד"
              description="הגדול מבין השניים הוא שקובע, כי ״תמיד עשרה סטים״ ו״תמיד עשרים אחוז״ הן שתי אמירות אמיתיות."
            >
              <TextInput
                name="safetyBufferPercent"
                type="number"
                min={0}
                max={100}
                defaultValue={settings.safetyBufferPercent}
              />
            </Field>

            <Field
              label="זמן מחזור כביסה בימים"
              description="מהרגע שאורח השתמש ועד שזה נקי על המדף. זה המספר שמונע ממגבות של יום שישי להיות זמינות בשבת. השאירו ריק אם לא ידוע — התחזית אז לא תספור שום חזרה, וזה הכיוון הבטוח לטעות בו."
            >
              <TextInput
                name="linenTurnaroundDays"
                type="number"
                min={0}
                max={60}
                defaultValue={settings.linenTurnaroundDays ?? ''}
              />
            </Field>

            <Field
              label="טווח התראה בימים"
              description="מעבר לו התחזית עדיין מחשבת ומציגה, אבל אינה מרימה התראה. רשימת אזהרות לתשעים יום היא קיר שאיש אינו קורא."
            >
              <TextInput
                name="shortageWarningHorizonDays"
                type="number"
                min={1}
                max={365}
                defaultValue={settings.shortageWarningHorizonDays}
              />
            </Field>

            <Field label="טווח התחזית בימים">
              <TextInput
                name="forecastHorizonDays"
                type="number"
                min={1}
                max={365}
                defaultValue={settings.forecastHorizonDays}
              />
            </Field>
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
            <h2 className="font-display text-base font-bold text-foreground">
              יכולות
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              הרמה קובעת מה אפשרי; הסימונים קובעים מה פעיל. יכולת שהרמה הנוכחית
              אינה תומכת בה מוצגת מנוטרלת ולא מוסתרת, כדי שהסולם יהיה קריא.
            </p>

            <Toggle
              name="reservationsEnabled"
              label="שריון מלאי להזמנות"
              help="בלי שריון אין ביקוש עתידי, ולכן אין תחזית — ציר זמן מעל אפס תביעות הוא קו ישר שמתחזה לתשובה."
              defaultChecked={settings.reservationsEnabled}
              disabled={!possible.reservations}
            />
            <Toggle
              name="transfersEnabled"
              label="העברות בין נכסים"
              help="הצעות בלבד. שום פריט לא זז בלי אישור של מי שרשאי לרוקן את המחסן שממנו הוא יוצא."
              defaultChecked={settings.transfersEnabled}
              disabled={!possible.transfers}
            />
            <Toggle
              name="discrepancyTracking"
              label="מעקב פערי ספירה"
              help="ספירה חוזרת אחרי צ׳ק־אאוט היא רבע שעה בכל החלפה. עסק שלא ביקש את זה לא אמור לקבל מסך עם תג עליו."
              defaultChecked={settings.discrepancyTracking}
              disabled={!possible.discrepancies}
            />
            <Toggle
              name="sharedStock"
              label="מלאי משותף בין נכסים"
              help="כבוי אצל רוב העסקים: שתי וילות במרחק שעה אינן חולקות ארון, ותחזית שמתיימרת אחרת לא תדווח על מחסור בבוקר של אחת מהן."
              defaultChecked={settings.sharedStock}
              disabled={false}
            />
            <Toggle
              name="warehouseEnabled"
              label="מחסן מרכזי"
              help="מקום שאינו נכס. נשאבים ממנו לפני שנוגעים במלאי העבודה של נכס אחר."
              defaultChecked={settings.warehouseEnabled}
              disabled={false}
            />
          </section>
        </>
      )}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'שומר…' : 'שמור הגדרות'}
        </Button>
      </div>
    </form>
  )
}

function Toggle({
  name,
  label,
  help,
  defaultChecked,
  disabled,
}: {
  name: string
  label: string
  help: string
  defaultChecked: boolean
  disabled: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <Checkbox
        name={name}
        label={label}
        defaultChecked={defaultChecked && !disabled}
        disabled={disabled}
      />
      <p className="ps-6 text-xs text-muted-foreground">
        {disabled ? 'הרמה הנוכחית אינה תומכת ביכולת הזו. ' : ''}
        {help}
      </p>
    </div>
  )
}
