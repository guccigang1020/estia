'use client'

/**
 * EXECUTION CONTEXT — CLIENT COMPONENT. How much of a shop this business runs.
 *
 * ══ THE TWO THINGS THIS SCREEN MUST NOT DO ═════════════════════════════════
 *
 *   1. **Offer live payment to a business on `simple`.** `pay_now` is removed
 *      from the list entirely — not disabled — when the mode does not carry
 *      it, and the schema's `store_settings_no_live_payment_in_simple` refuses
 *      the row if this were ever wrong. A disabled option still advertises a
 *      thing the owner would then go looking for.
 *
 *   2. **Nag about `off`.** `off` is the default and a first-class answer. It
 *      sits first in the list, its description says bookings carry on exactly
 *      as before, and nothing on this screen colours it as a problem.
 *
 * ── Why the payment list narrows as you change the mode ──────────────────
 *
 * `offerablePaymentModes` is the same function the checkout uses to decide
 * what a guest may be offered. One function, so what an owner configures here
 * and what a guest sees there cannot disagree.
 */

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox, Select, TextInput, Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/field'
import { STORE_MODES, STORE_PAYMENT_MODES } from '@/lib/contracts/states'
import type { SafeErrorBody } from '@/lib/errors'
// ── Leaf modules, never the `@/lib/store` barrel ────────────────────────
//
// The barrel re-exports `StoreRepository` and `defineStoreOperations`, which
// reach `src/lib/persistence` and from there the `postgres` driver. A CLIENT
// component importing it makes the bundler try to resolve `node:fs` for the
// browser — which is a build failure, not a warning, and it takes down every
// route that renders this form. Server components may use the barrel freely;
// anything under `"use client"` imports the leaf it actually needs.
import {
  STORE_PAYMENT_MODE_LABEL,
  STORE_PAYMENT_MODE_SUMMARY,
} from '@/lib/store/labels'
import {
  STORE_MODE_LABEL,
  STORE_MODE_SUMMARY,
  offerablePaymentModes,
  storeCapabilities,
} from '@/lib/store/mode'
import type { StoreSettings } from '@/lib/store/types'

import { updateStoreSettingsAction } from '../_lib/actions'

export function StoreSettingsForm({ settings }: { settings: StoreSettings }) {
  const router = useRouter()
  const idempotencyKey = useRef(crypto.randomUUID())

  const [mode, setMode] = useState<string>(settings.mode)
  const [defaultPaymentMode, setDefaultPaymentMode] = useState<string>(
    settings.defaultPaymentMode,
  )
  const [approvalRequiredDefault, setApprovalRequiredDefault] = useState(
    settings.approvalRequiredDefault,
  )
  const [guestStoreEnabled, setGuestStoreEnabled] = useState(
    settings.guestStoreEnabled,
  )
  const [heading, setHeading] = useState(settings.guestStoreHeading ?? '')
  const [intro, setIntro] = useState(settings.guestStoreIntro ?? '')

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)
  const [saved, setSaved] = useState(false)

  const capabilities = storeCapabilities(mode as StoreSettings['mode'])

  // Every mode the frozen contract carries, narrowed to what THIS mode
  // permits. `pay_now` disappears on `simple`.
  const payable = offerablePaymentModes({
    mode: mode as StoreSettings['mode'],
    defaultPaymentMode:
      defaultPaymentMode as StoreSettings['defaultPaymentMode'],
    enabled: STORE_PAYMENT_MODES,
  })

  /**
   * Changing the mode down to `simple` while `pay_now` is selected would leave
   * a value the schema refuses.
   *
   * Resolved as a DERIVED value rather than by setting state during render:
   * the select then shows `with_booking` the moment the mode changes, and the
   * submit sends what the select shows. Writing it back into state instead
   * would make the rendered value and the stored value disagree for one frame,
   * which is exactly long enough for somebody to press save.
   */
  const effectivePaymentMode = payable.includes(
    defaultPaymentMode as StoreSettings['defaultPaymentMode'],
  )
    ? defaultPaymentMode
    : 'with_booking'

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    setPending(true)
    setError(null)
    setSaved(false)

    const result = await updateStoreSettingsAction({
      mode,
      defaultPaymentMode: effectivePaymentMode,
      approvalRequiredDefault,
      guestStoreEnabled,
      guestStoreHeading: heading,
      guestStoreIntro: intro,
      idempotencyKey: idempotencyKey.current,
    })

    setPending(false)

    if (!result.ok) {
      setError(result.error)
      return
    }

    setSaved(true)
    // A fresh key: the next save is a different act, not a replay of this one.
    idempotencyKey.current = crypto.randomUUID()
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2">מצב החנות</CardTitle>
        </CardHeader>

        <div className="mt-4 flex flex-col gap-3">
          {STORE_MODES.map((candidate) => (
            <label
              key={candidate}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted px-4 py-3"
            >
              <input
                type="radio"
                name="mode"
                value={candidate}
                checked={mode === candidate}
                onChange={() => {
                  setMode(candidate)
                }}
                className="mt-1"
              />
              <span className="flex flex-col gap-1">
                <span className="font-semibold text-foreground">
                  {STORE_MODE_LABEL[candidate]}
                </span>
                <span className="text-sm text-muted-foreground">
                  {STORE_MODE_SUMMARY[candidate]}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Card>

      {capabilities.visible && (
        <>
          <Card>
            <CardHeader>
              <CardTitle as="h2">תשלום</CardTitle>
            </CardHeader>

            <p className="mt-2 text-sm text-muted-foreground">
              איך אתם רוצים שהאורח ישלם על תוספות. אפשר לנהל חנות שלמה בלי סליקה
              מקוונת, וזו ברירת המחדל.
            </p>

            <Field
              className="mt-4"
              label="ברירת מחדל"
              description="אפשר לקבוע אחרת לכל מוצר בנפרד."
            >
              <Select
                value={effectivePaymentMode}
                onChange={(event) => {
                  setDefaultPaymentMode(event.target.value)
                }}
              >
                {payable.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {STORE_PAYMENT_MODE_LABEL[candidate]}
                  </option>
                ))}
              </Select>
            </Field>

            <p className="mt-2 text-sm text-muted-foreground">
              {
                STORE_PAYMENT_MODE_SUMMARY[
                  effectivePaymentMode as StoreSettings['defaultPaymentMode']
                ]
              }
            </p>

            {!capabilities.livePayment && (
              <p className="mt-4 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                תשלום מקוון אינו חלק מהמצב שנבחר, ולכן הוא אינו מופיע ברשימה.
                אפשר לעבור למצב ״עם תשלום״ אם תרצו לגבות אונליין.
              </p>
            )}

            {/* `Checkbox` labels itself — the text belongs after the box, not
                above it — so there is no wrapping `label` here. */}
            <div className="mt-4">
              <Checkbox
                label="כל הזמנה ממתינה לאישור שלכם לפני שהיא נסגרת"
                description="אפשר לקבוע אחרת לכל מוצר בנפרד."
                checked={approvalRequiredDefault}
                onChange={(event) => {
                  setApprovalRequiredDefault(event.target.checked)
                }}
              />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">החנות של האורח</CardTitle>
            </CardHeader>

            <div className="mt-4">
              <Checkbox
                label="האורחים רואים את החנות בתוך ההזמנה שלהם"
                description="כשזה כבוי, הקטלוג נשאר שלכם ואתם מוסיפים הזמנות מהמסך — למשל כשאורח מתקשר ומבקש."
                checked={guestStoreEnabled}
                onChange={(event) => {
                  setGuestStoreEnabled(event.target.checked)
                }}
              />
            </div>

            {guestStoreEnabled && (
              <div className="mt-4 flex flex-col gap-4">
                <Field label="כותרת" description="מה שהאורח רואה בראש החנות.">
                  <TextInput
                    value={heading}
                    onChange={(event) => {
                      setHeading(event.target.value)
                    }}
                    placeholder="מה עוד אפשר להוסיף לשהות"
                    maxLength={120}
                  />
                </Field>

                <Field label="טקסט פתיחה">
                  <Textarea
                    value={intro}
                    onChange={(event) => {
                      setIntro(event.target.value)
                    }}
                    rows={3}
                    maxLength={600}
                    placeholder="כמה דברים שאנחנו מסדרים לאורחים שלנו."
                  />
                </Field>
              </div>
            )}
          </Card>
        </>
      )}

      {error && <ActionError error={error} />}

      {saved && (
        <p role="status" className="text-sm text-foreground">
          ההגדרות נשמרו.
        </p>
      )}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? 'שומר…' : 'שמירת ההגדרות'}
      </Button>
    </form>
  )
}
