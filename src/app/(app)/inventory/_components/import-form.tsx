'use client'

/**
 * CSV import, with the template beside it.
 *
 * ── The template is generated, never a static asset ───────────────────────
 *
 * `importTemplateCsv()` builds it from `IMPORT_TEMPLATE_HEADER`, which is the
 * same tuple `parseImport` matches against. A file checked into `public/` would
 * drift from the parser the first time a column was added, and the failure —
 * "I used your own template and it refused my column" — is the one that makes
 * somebody stop trusting the product.
 *
 * It carries a UTF-8 BOM, because Excel on Windows opens a Hebrew CSV without
 * one as mojibake, and it carries two example rows, because "what goes in
 * רמת יעד" is the question that stops an import.
 *
 * ── Parsed here, applied there ────────────────────────────────────────────
 *
 * The file is read in the browser and the plan is rendered before a request is
 * made. What is created, what changes, what is already identical, and every
 * refusal with its line number and the value as typed. Then a button.
 *
 * ── Idempotent by identity, not by ceremony ───────────────────────────────
 *
 * `planImport` matches on `(sku)` where there is one and `(name)` where there
 * is not, against what is already stored. Running the same file twice
 * classifies every row as `unchanged` and the summary says so — which is the
 * behaviour, and the sentence, a person needs before they dare press it again.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import {
  importTemplateCsv,
  parseImport,
  planImport,
  type ExistingItem,
  type ImportPlan,
} from '@/lib/inventory'

import { applyInventoryImportAction } from '../_lib/actions'
import type { PropertyChoice } from './stock-entry-form'

export function ImportForm({
  properties,
  existing,
}: {
  properties: readonly PropertyChoice[]
  existing: readonly ExistingItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [target, setTarget] = useState(properties[0]?.id ?? '')

  async function chooseFile(file: File) {
    const text = await file.text()
    setFileName(file.name)
    setPlan(planImport(parseImport(text), existing))
    setMessage(null)
    setFailure(null)
  }

  function download() {
    const blob = new Blob([importTemplateCsv()], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'estia-inventory-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  function apply() {
    if (plan === null) return
    // Only the rows that would actually change something. Re-sending the
    // `unchanged` rows would be forty pointless writes and forty audit events.
    const rows = [...plan.create, ...plan.update]
    const idempotencyKey = crypto.randomUUID()

    startTransition(async () => {
      const result = await applyInventoryImportAction({
        propertyId: target,
        rows,
        idempotencyKey,
      })
      if (result.ok) {
        setFailure(null)
        setMessage(`${result.data.created} פריטים נוספו.`)
        setPlan(null)
        setFileName(null)
        router.refresh()
      } else {
        setMessage(null)
        setFailure(result.error.message)
      }
    })
  }

  const changing = plan === null ? 0 : plan.create.length + plan.update.length

  return (
    <div className="flex flex-col gap-6">
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

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft">
        <Field label="נכס היעד">
          <Select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="קובץ CSV"
          description="השורה הראשונה היא הכותרת. עמודה שהמוצר אינו מכיר נשמטת ומדווחת, ואינה מפילה את הקובץ."
        >
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="text-sm text-foreground"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void chooseFile(file)
            }}
          />
        </Field>

        <Button type="button" variant="secondary" onClick={download}>
          הורד תבנית
        </Button>
      </div>

      {fileName !== null && (
        <p className="text-sm text-muted-foreground">נבחר: {fileName}</p>
      )}

      {plan !== null && (
        <>
          <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:grid-cols-4">
            <Count label="ייווצרו" value={plan.create.length} />
            <Count label="יעודכנו" value={plan.update.length} />
            <Count label="זהים כבר" value={plan.unchanged.length} />
            <Count label="נדחו" value={plan.refused.length} />
          </div>

          {plan.unknownColumns.length > 0 && (
            <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              עמודות שהמוצר אינו מכיר ולכן נשמטו:{' '}
              {plan.unknownColumns.join(', ')}. שאר הקובץ נקלט כרגיל.
            </p>
          )}

          {plan.unchanged.length > 0 && plan.create.length === 0 && (
            <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              כל השורות זהות למה שכבר קיים. הרצה חוזרת של אותו קובץ אינה מכפילה
              את המחסן — זו בדיוק ההתנהגות שמאפשרת לנסות שוב בלי חשש.
            </p>
          )}

          {plan.refused.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="font-display text-base font-bold text-foreground">
                שורות שנדחו, ולמה
              </h2>
              <ul className="flex flex-col gap-2">
                {plan.refused.map((refusal) => (
                  <li
                    key={`${refusal.lineNumber}:${refusal.code}`}
                    className="rounded-lg border border-warning bg-surface px-3 py-2 text-sm"
                  >
                    <span className="font-semibold text-foreground">
                      שורה {refusal.lineNumber}
                    </span>
                    {refusal.value !== null && (
                      <span className="text-muted-foreground">
                        {' '}
                        · ״{refusal.value}״
                      </span>
                    )}
                    <span className="text-muted-foreground">
                      {' '}
                      — {refusal.message}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                השורות התקינות ייקלטו בכל מקרה. ייבוא שנופל כולו על שורה
                תשע־עשרה הוא ייבוא שאיש אינו משלים.
              </p>
            </section>
          )}

          <div>
            <Button
              type="button"
              onClick={apply}
              disabled={pending || changing === 0}
            >
              {pending
                ? 'מייבא…'
                : changing === 0
                  ? 'אין מה לייבא'
                  : `ייבא ${changing} שורות`}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-display text-xl font-bold tabular-nums text-foreground">
        {value}
      </span>
    </div>
  )
}
