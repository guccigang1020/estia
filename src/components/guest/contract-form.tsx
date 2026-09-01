'use client'

/**
 * Signing the contract.
 *
 * ── A typed name, not a drawn squiggle ────────────────────────────────────
 *
 * The product does not draw signatures. A canvas scribble stored as a PNG
 * looks more official and is worth less: it proves nothing about who held the
 * finger, and storing it would suggest an evidentiary weight this flow does
 * not have. What is recorded is a typed full name, the moment, the request's
 * fingerprint, the booking version, and — the part that actually matters — a
 * frozen copy of the terms as they read at that moment.
 *
 * ── The confirmation before the button ────────────────────────────────────
 *
 * A checkbox that says what signing means, in words, above a button that says
 * "חתום". Not because a checkbox is legally magic, but because a guest who
 * scrolled past a wall of Hebrew and tapped the only button on screen has not
 * read anything, and the checkbox is the smallest honest speed bump.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * The same two locks as the confirm control: a synchronous ref here, and a
 * partial unique index on `booking_contract_signatures (booking_id) where
 * superseded_at is null` in the database. The second tap finds the first
 * signature and is told it is already signed, including when it races the read.
 */

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { signContractAction } from '@/app/g/[token]/_lib/actions'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'

export function ContractForm({
  token,
  contractTitle,
  requireIdNumber = false,
}: {
  token: string
  contractTitle: string
  requireIdNumber?: boolean
}) {
  const router = useRouter()
  const { pending, run } = useAsyncAction()

  const [name, setName] = useState('')
  const [idNumber, setIdNumber] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [nameProblem, setNameProblem] = useState<string | null>(null)

  const canSubmit = agreed && name.trim().length > 1 && !pending

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return

        const signerName = name.trim()
        if (signerName.length < 2) {
          setNameProblem('יש להזין שם מלא.')
          return
        }

        setNameProblem(null)
        setProblem(null)

        void run(async () => {
          const result = await signContractAction(token, {
            signerName,
            // The typed name IS the signature. Kept as its own field rather
            // than reusing `signerName` so the record shows what was typed into
            // the signature box, which is the thing being attested.
            signatureText: signerName,
            idNumber: idNumber.trim() || null,
          })

          if (result.ok) {
            router.refresh()
            return
          }
          setProblem(result.error.message)
        })
      }}
    >
      <Field
        label="שם מלא"
        description="כפי שהוא מופיע בתעודת הזהות"
        required
        error={nameProblem ?? undefined}
      >
        <TextInput
          value={name}
          autoComplete="name"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      {requireIdNumber && (
        <Field label="מספר תעודת זהות" description="נשמר עם החתימה בלבד">
          <TextInput
            value={idNumber}
            inputMode="numeric"
            onChange={(event) => setIdNumber(event.target.value)}
          />
        </Field>
      )}

      <label className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
          className="mt-0.5 size-5 shrink-0 rounded border-border-strong text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <span className="text-sm text-foreground">
          קראתי את {contractTitle} ואני מסכים לתנאים המופיעים בו.
        </span>
      </label>

      <Button type="submit" size="lg" className="w-full" disabled={!canSubmit}>
        {pending ? 'חותם…' : 'חתימה על החוזה'}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        נוסח החוזה נשמר כפי שהוא כעת, ולא ישתנה גם אם בית האירוח יעדכן אותו
        בהמשך.
      </p>

      {problem && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
        >
          {problem}
        </p>
      )}
    </form>
  )
}
