'use client'

/**
 * The counting sheet.
 *
 * ── There is no expected column, and it is not hidden ─────────────────────
 *
 * A blind `CountSheet` has no expected quantity on any line — the type has no
 * such field and the query never read one. So this component is not
 * suppressing anything: there is nothing here to suppress. That distinction
 * is the whole point. A component that received the number and chose not to
 * render it would show it the first time somebody added a debugging line, and
 * a stocktake that shows the answer gets the answer back.
 *
 * ── One row at a time, submitted as it is counted ─────────────────────────
 *
 * Not one form for sixty items. A person counting a linen cupboard is
 * interrupted, and a sheet that loses fifty entries because the sixtieth
 * failed is a sheet nobody trusts twice. Each row is its own submit, each one
 * says whether it saved, and a saved row stays saved.
 *
 * ── A recount overwrites, and says so ─────────────────────────────────────
 *
 * Counting the same shelf twice is the ordinary case, not the exotic one, and
 * the second number is the one that stands. The row shows what was recorded
 * before, so a person can see that they are changing it rather than adding to
 * it.
 */

import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { TextInput } from '@/components/ui/input'
import { Td, Th } from '@/components/operations/table-parts'
import type { CountSheet } from '@/lib/inventory/counts'

import { recordCountAction } from '../_lib/actions'

export interface CountSheetProps {
  sessionId: string
  sheet: CountSheet
  /** False for a reader. The sheet is then a list, not a form. */
  mayCount: boolean
  /** False once the session has left `counting`. */
  open: boolean
}

export function CountSheetTable({
  sessionId,
  sheet,
  mayCount,
  open,
}: CountSheetProps) {
  const blind = sheet.blind

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-soft">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <Th>פריט</Th>
            <Th>מיקום</Th>
            {!blind && <Th>צפוי במערכת</Th>}
            <Th>נספר</Th>
            {mayCount && open && <Th>רישום</Th>}
          </tr>
        </thead>
        <tbody>
          {sheet.lines.map((line) => (
            <SheetRow
              key={line.itemId}
              sessionId={sessionId}
              itemId={line.itemId}
              label={line.label}
              unitOfMeasure={line.unitOfMeasure}
              location={line.location}
              counted={line.counted}
              // Present only on an open-book sheet. On a blind one the object
              // itself has no such property, and the type declares it `never`
              // — which is why this coalesces rather than asserts.
              expected={line.expected ?? null}
              showExpected={!blind}
              mayCount={mayCount}
              open={open}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SheetRow(props: {
  sessionId: string
  itemId: string
  label: string
  unitOfMeasure: string
  location: string | null
  counted: number | null
  expected: number | null
  showExpected: boolean
  mayCount: boolean
  open: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [saved, setSaved] = useState<number | null>(props.counted)
  const [failure, setFailure] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const raw = String(form.get('countedQuantity') ?? '').trim()

    if (raw.length === 0) {
      setFailure('יש להזין כמות. שדה ריק אינו ספירה של אפס.')
      return
    }

    const quantity = Number(raw)
    if (!Number.isInteger(quantity) || quantity < 0) {
      setFailure('הכמות חייבת להיות מספר שלם שאינו שלילי.')
      return
    }

    startTransition(async () => {
      const result = await recordCountAction({
        sessionId: props.sessionId,
        itemId: props.itemId,
        countedQuantity: quantity,
        note: null,
      })

      if (result.ok) {
        setSaved(quantity)
        setFailure(null)
        router.refresh()
        return
      }

      setFailure(result.error.message)
    })
  }

  return (
    <tr className="border-b border-border last:border-b-0">
      <Td>
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{props.label}</span>
          <span className="text-xs text-muted-foreground">
            {props.unitOfMeasure}
          </span>
        </div>
      </Td>
      <Td>{props.location ?? '–'}</Td>
      {props.showExpected && <Td>{props.expected ?? '–'}</Td>}
      <Td>
        {saved === null ? (
          <span className="text-muted-foreground">טרם נספר</span>
        ) : (
          <span className="font-semibold text-foreground">{saved}</span>
        )}
      </Td>
      {props.mayCount && props.open && (
        <Td>
          <form onSubmit={submit} className="flex items-start gap-2">
            <Field
              label="כמות שנספרה"
              error={failure ?? undefined}
              description={
                saved === null ? undefined : 'רישום חוזר מחליף את המספר הקודם.'
              }
            >
              <TextInput
                name="countedQuantity"
                inputMode="numeric"
                defaultValue={saved === null ? '' : String(saved)}
                className="w-24"
              />
            </Field>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'שומר…' : 'רשום'}
            </Button>
          </form>
        </Td>
      )}
    </tr>
  )
}
