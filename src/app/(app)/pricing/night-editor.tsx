'use client'

/**
 * Editing one night, and a range of nights.
 *
 * ══ THE FIELD IS IN SHEKELS AND THE WIRE IS IN AGOROT ═══════════════════════
 *
 * Spec §17, the first row of the human-error table: a manager typing 1450 into
 * a field that stores agorot has just set a night to ₪14.50, and every screen
 * afterwards will show that confidently. So the input takes SHEKELS, shows the
 * ₪ beside it, and the conversion happens here at the edge and nowhere else.
 * Everything on the server, in the database and in the resolver is integer
 * agorot without exception.
 *
 * The second guard is the confirmation: a price fifty times smaller than the
 * one it replaces is almost always this mistake, and the dialogue names both
 * amounts rather than asking "are you sure".
 *
 * ══ A SOLD NIGHT IS NOT EDITABLE ════════════════════════════════════════════
 *
 * Not disabled-with-a-tooltip — absent. The price of a night that was sold is
 * a historical fact rather than a setting, and a greyed-out control implies the
 * capability exists and is merely withheld.
 *
 * ══ THE VERSION TRAVELS WITH THE EDIT ═══════════════════════════════════════
 *
 * `expectedVersion` is whatever the row carried when the page was rendered. If
 * somebody else changed the night in between, the server answers 409 and this
 * shows their edit is stale — it does NOT retry, because retrying is exactly
 * the lost update the version exists to prevent (spec §10).
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { fromSafeError } from '@/components/states/error-copy'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'
import type { SafeErrorBody } from '@/lib/errors/safe-response'
import { formatAgorotShort } from '@/lib/pricing/labels'

import { bulkEditAction, setNightAction } from './_lib/actions'

/**
 * How much smaller a new price may be before it is questioned.
 *
 * Fifty, because ₪1,450 mistyped as agorot is ₪14.50 — a factor of a hundred —
 * and half of that is comfortably below any real price cut a business makes on
 * purpose. A threshold of ten would fire on a genuine off-season correction.
 */
const SUSPICIOUS_SHRINK_FACTOR = 50

function agorotFromShekels(text: string): number | null {
  const value = Number(text.replace(/[^\d.]/g, ''))
  if (!Number.isFinite(value) || value < 0) return null
  // `Math.round` and not a cast: 14.5 shekels is 1450 agorot, and floating
  // point makes `14.5 * 100` something ending in .0000000002 often enough.
  return Math.round(value * 100)
}

export function NightEditor({
  unitId,
  propertyId,
  ratePlanId,
  date,
  currentAgorot,
  expectedVersion,
  isSold,
  canManage,
}: {
  unitId: string
  propertyId: string
  ratePlanId: string
  date: string
  currentAgorot: number | null
  expectedVersion?: number
  isSold: boolean
  canManage: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [shekels, setShekels] = useState(
    currentAgorot === null ? '' : String(currentAgorot / 100),
  )
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  // Absent, not disabled. See the header.
  if (!canManage || isSold) return null

  const proposed = agorotFromShekels(shekels)
  const shrank =
    proposed !== null &&
    currentAgorot !== null &&
    proposed > 0 &&
    currentAgorot / proposed >= SUSPICIOUS_SHRINK_FACTOR

  async function save() {
    if (proposed === null) return
    setBusy(true)
    setError(null)
    const outcome = await setNightAction({
      unitId,
      propertyId,
      ratePlanId,
      date,
      nightlyAgorot: proposed,
      expectedVersion,
      idempotencyKey: crypto.randomUUID(),
    })
    setBusy(false)

    if (outcome.ok) {
      setOpen(false)
      setConfirming(false)
      router.refresh()
      return
    }
    setError(outcome.error)
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" onClick={() => setOpen(!open)}>
        {currentAgorot === null ? 'קביעת מחיר' : 'שינוי מחיר'}
      </Button>

      {open && (
        <Field
          label="מחיר ללילה"
          description="בשקלים. הסכום נשמר באגורות, וההמרה נעשית כאן בלבד."
        >
          <TextInput
            inputMode="decimal"
            value={shekels}
            onChange={(event) => {
              setShekels(event.target.value)
              setConfirming(false)
            }}
          />

          {shrank && !confirming ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-foreground">
                המחיר החדש נמוך פי {SUSPICIOUS_SHRINK_FACTOR} ומעלה מהמחיר
                הנוכחי: מ־{formatAgorotShort(currentAgorot ?? 0)} ל־
                {formatAgorotShort(proposed ?? 0)}. זה בדרך כלל סימן שהוזן סכום
                באגורות במקום בשקלים.
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConfirming(true)}
              >
                המחיר נכון, המשך
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              disabled={busy || proposed === null}
              onClick={save}
            >
              שמירה
            </Button>
          )}
        </Field>
      )}

      {error && (
        <p className="text-xs text-destructive">{fromSafeError(error).title}</p>
      )}
    </div>
  )
}

/**
 * The bulk edit.
 *
 * Names the number of nights and the cumulative difference BEFORE the button,
 * per spec §17: "23 לילות · הפרש ₪4,600" is what stops a range that is one
 * month too wide, and "are you sure" is not.
 *
 * The idempotency key is generated when the panel opens and kept for the life
 * of it, so a double click is one edit. Regenerating it per attempt would make
 * it not a key at all.
 */
export function BulkEditor({
  unitId,
  propertyId,
  ratePlanId,
  from,
  to,
  currentTotalAgorot,
  nightCount,
  canManage,
}: {
  unitId: string
  propertyId: string
  ratePlanId: string
  from: string
  to: string
  /** What the visible nights cost today, for the difference below. */
  currentTotalAgorot: number
  nightCount: number
  canManage: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [shekels, setShekels] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SafeErrorBody | null>(null)

  if (!canManage) return null

  const proposed = agorotFromShekels(shekels)
  const difference =
    proposed === null ? null : proposed * nightCount - currentTotalAgorot

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setOpen(!open)
          if (!open) setKey(crypto.randomUUID())
        }}
      >
        עריכה קבוצתית
      </Button>

      {open && (
        <Field
          label="מחיר ללילה לכל הטווח"
          description={`${from} עד ${to}, לא כולל. ${nightCount} לילות.`}
        >
          <TextInput
            inputMode="decimal"
            value={shekels}
            onChange={(event) => setShekels(event.target.value)}
          />

          {difference !== null && (
            <p className="text-xs text-muted-foreground">
              {nightCount} לילות · הפרש מצטבר{' '}
              {formatAgorotShort(Math.abs(difference))}
              {difference >= 0 ? ' תוספת' : ' הפחתה'}
            </p>
          )}

          <Button
            type="button"
            disabled={busy || proposed === null}
            onClick={async () => {
              if (proposed === null) return
              setBusy(true)
              setError(null)
              const outcome = await bulkEditAction({
                unitId,
                propertyId,
                ratePlanId,
                from,
                to,
                nightlyAgorot: proposed,
                idempotencyKey: key,
              })
              setBusy(false)
              if (outcome.ok) {
                setOpen(false)
                router.refresh()
                return
              }
              setError(outcome.error)
            }}
          >
            עדכון {nightCount} לילות
          </Button>
        </Field>
      )}

      {error && (
        <p className="text-xs text-destructive">{fromSafeError(error).title}</p>
      )}
    </div>
  )
}
