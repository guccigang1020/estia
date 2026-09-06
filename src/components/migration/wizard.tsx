'use client'

/**
 * The migration wizard.
 *
 * ── Seven steps, and only two of them touch the server ────────────────────
 *
 * Upload, detect, map, validate, dry run, settle the conflicts, import. The
 * file is read in the browser and parsed there; the mapping is argued about
 * there; nothing leaves the machine until somebody asks for a dry run. That is
 * not an optimisation — a person spends twenty minutes on the mapping step of a
 * three-year migration, and a product that uploaded their entire customer list
 * before they had decided anything would deserve the hesitation it got.
 *
 * ── The dry run is the destination ────────────────────────────────────────
 *
 * Every step before it exists to reach it, and the button that actually writes
 * is deliberately behind it, disabled while a single conflict is unsettled. A
 * wizard that let somebody click through to "import" without reading what would
 * happen would make the dry run decorative.
 *
 * ── Nothing here writes ───────────────────────────────────────────────────
 *
 * `parseSource`, `suggestMappings` and the label tables are pure leaf modules —
 * never the `@/lib/migration` barrel, which reaches the `postgres` driver and
 * would take the whole application down from a Client Component. The two server
 * actions are the only things in this file that reach a database, and one of
 * them is explicitly read-only.
 */

import { useMemo, useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select, TextInput } from '@/components/ui/input'
import { fieldsFor, suggestMappings } from '@/lib/migration/mapping'
import { parseSource } from '@/lib/migration/parsers'
import {
  IMPORT_ENTITY_LABEL,
  SOURCE_FORMAT_LABEL,
  type CompletionReport,
  type Conflict,
  type DryRunReport,
  type FieldMapping,
  type ImportEntity,
  type ImportField,
  type ImportRecord,
  type ParsedFile,
} from '@/lib/migration/types'

import { CompletionReportView } from './completion-report'
import { DryRunReportView } from './dry-run-report'
import { FieldMappingTable } from './field-mapping'

/** The entities a person can choose to import today. */
const CHOOSABLE: readonly ImportEntity[] = [
  'bookings',
  'guests',
  'properties',
  'blocked_dates',
]

export type WizardServerActions = {
  dryRun(request: {
    entity: ImportEntity
    rows: ParsedFile['rows']
    mappings: readonly FieldMapping[]
    decisions: readonly Conflict[]
    parseIssues: ParsedFile['issues']
  }): Promise<
    | {
        ok: true
        data: {
          report: DryRunReport
          records: readonly ImportRecord[]
          provisioned: boolean
        }
      }
    | { ok: false; error: { message: string } }
  >
  apply(request: {
    entity: ImportEntity
    sessionId: string
    records: readonly ImportRecord[]
  }): Promise<
    | { ok: true; data: CompletionReport }
    | { ok: false; error: { message: string } }
  >
}

type Step = 'upload' | 'map' | 'preview' | 'done'

export function MigrationWizard({
  actions,
  mayApply,
  missingGrants,
}: {
  actions: WizardServerActions
  mayApply: boolean
  /** Hebrew labels for the write grants this person lacks. Shown up front. */
  missingGrants: readonly string[]
}) {
  const [pending, startTransition] = useTransition()
  const [step, setStep] = useState<Step>('upload')
  const [entity, setEntity] = useState<ImportEntity>('bookings')
  const [unitName, setUnitName] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [mappings, setMappings] = useState<readonly FieldMapping[]>([])
  const [report, setReport] = useState<DryRunReport | null>(null)
  const [records, setRecords] = useState<readonly ImportRecord[]>([])
  const [decisions, setDecisions] = useState<readonly Conflict[]>([])
  const [completion, setCompletion] = useState<CompletionReport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [provisioned, setProvisioned] = useState(true)

  const available = useMemo(() => fieldsFor(entity), [entity])

  async function chooseFile(file: File): Promise<void> {
    const text = await file.text()
    const result = parseSource(text, {
      entity,
      fileName: file.name,
      unitName: unitName.length > 0 ? unitName : undefined,
    })

    setFileName(file.name)
    setParsed(result)
    setMappings(suggestMappings(result.columns, entity))
    setReport(null)
    setRecords([])
    setDecisions([])
    setCompletion(null)
    setFailure(null)
    setStep(result.rows.length > 0 ? 'map' : 'upload')
  }

  function remap(column: string, field: ImportField | null): void {
    setMappings((current) =>
      current.map((mapping) =>
        mapping.column === column ? { column, field } : mapping,
      ),
    )
    // The preview is now about a mapping that no longer exists. Clearing it is
    // the honest response; leaving a stale report on screen while somebody
    // changes what it describes is how a wrong import gets approved.
    setReport(null)
    setRecords([])
  }

  function runDryRun(nextDecisions: readonly Conflict[] = decisions): void {
    if (parsed === null) return

    startTransition(async () => {
      const result = await actions.dryRun({
        entity,
        rows: parsed.rows,
        mappings,
        decisions: nextDecisions,
        parseIssues: parsed.issues,
      })

      if (!result.ok) {
        setFailure(result.error.message)
        return
      }

      setFailure(null)
      setReport(result.data.report)
      setRecords(result.data.records)
      setDecisions(result.data.report.conflicts)
      setProvisioned(result.data.provisioned)
      setStep('preview')
    })
  }

  function settle(conflictId: string, decision: Conflict['decision']): void {
    const next = decisions.map((conflict) =>
      conflict.id === conflictId ? { ...conflict, decision } : conflict,
    )
    setDecisions(next)
    runDryRun(next)
  }

  function apply(): void {
    if (report === null) return

    startTransition(async () => {
      const result = await actions.apply({
        entity,
        // Stable for this browser session, so a retry after a network failure
        // is the same session rather than a second one. The records carry their
        // own idempotency keys regardless — see `src/lib/migration/apply.ts`.
        sessionId: sessionIdFor(fileName ?? 'import'),
        records: report.writable,
      })

      if (!result.ok) {
        setFailure(result.error.message)
        return
      }

      setFailure(null)
      setCompletion(result.data)
      setStep('done')
    })
  }

  const undecided = decisions.filter(
    (conflict) => conflict.decision === 'undecided',
  ).length

  return (
    <div className="flex flex-col gap-6" dir="rtl">
      <StepBar step={step} />

      {missingGrants.length > 0 && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          חסרות לך הרשאות כתיבה: {missingGrants.join(', ')}. אפשר לקרוא את
          הקובץ ולהריץ הרצה יבשה, אבל השורות שדורשות את ההרשאות האלה יידחו
          בייבוא עצמו.
        </p>
      )}

      {!provisioned && (
        <p
          role="alert"
          className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
        >
          טבלאות הייבוא עדיין לא הוחלו על הסביבה הזו, ולכן לא נשמר רישום של מה
          שכבר יובא. אפשר להריץ הרצה יבשה; ייבוא בפועל ימתין להחלת המיגרציה.
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

      {step === 'upload' && (
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft">
          <Field
            label="מה מייבאים"
            description="קובץ אחד, גוף אחד. יומן iCal אחד הוא היומן של יחידה אחת."
          >
            <Select
              value={entity}
              onChange={(event) =>
                setEntity(event.target.value as ImportEntity)
              }
            >
              {CHOOSABLE.map((option) => (
                <option key={option} value={option}>
                  {IMPORT_ENTITY_LABEL[option]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="שם היחידה (ליומן iCal)"
            description="יומן של ערוץ אינו אומר איזו יחידה הוא מתאר — הכתובת שממנה הורד אמרה זאת."
          >
            <TextInput
              value={unitName}
              onChange={(event) => setUnitName(event.target.value)}
              placeholder="וילה הגלבוע"
            />
          </Field>

          <Field
            label="קובץ"
            description="CSV, טבלה מופרדת בטאבים, או יומן iCal. הקובץ נקרא בדפדפן ואינו נשלח לשרת בשלב הזה."
          >
            <input
              type="file"
              accept=".csv,.tsv,.txt,.ics,.ical,text/csv,text/calendar"
              className="text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void chooseFile(file)
              }}
            />
          </Field>

          {parsed !== null && parsed.rows.length === 0 && (
            <ul className="flex flex-col gap-2">
              {parsed.issues.map((issue, index) => (
                <li
                  key={index}
                  className="rounded-lg border border-danger bg-muted px-4 py-3 text-sm text-foreground"
                >
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {step === 'map' && parsed !== null && (
        <section className="flex flex-col gap-4">
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            זוהה: {SOURCE_FORMAT_LABEL[parsed.format]} · {parsed.rows.length}{' '}
            שורות · {fileName}
          </p>

          <FieldMappingTable
            columns={parsed.columns}
            mappings={mappings}
            available={available}
            rows={parsed.rows}
            onChange={remap}
          />

          <div className="flex flex-wrap gap-3">
            <Button onClick={() => runDryRun([])} disabled={pending}>
              {pending ? 'בודק…' : 'הרץ הרצה יבשה'}
            </Button>
            <Button variant="ghost" onClick={() => setStep('upload')}>
              קובץ אחר
            </Button>
          </div>
        </section>
      )}

      {step === 'preview' && report !== null && (
        <section className="flex flex-col gap-4">
          <DryRunReportView report={report} onDecide={settle} />

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-5">
            <Button
              onClick={apply}
              disabled={
                pending || !mayApply || undecided > 0 || report.writable.length === 0
              }
            >
              {pending
                ? 'מייבא…'
                : `ייבא ${report.writable.length} רשומות`}
            </Button>
            <Button variant="ghost" onClick={() => setStep('map')}>
              חזור למיפוי
            </Button>

            {undecided > 0 && (
              <span className="text-sm text-muted-foreground">
                {undecided} התנגשויות עדיין ממתינות להחלטה. הייבוא ייפתח אחרי
                שכולן יוכרעו.
              </span>
            )}
            {!mayApply && (
              <span className="text-sm text-muted-foreground">
                אין לך הרשאה לבצע את הייבוא עצמו.
              </span>
            )}
          </div>
        </section>
      )}

      {step === 'done' && completion !== null && (
        <section className="flex flex-col gap-4">
          <CompletionReportView report={completion} />
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setStep('upload')
                setParsed(null)
                setReport(null)
                setCompletion(null)
              }}
            >
              ייבוא נוסף
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}

const STEPS: readonly { key: Step; label: string }[] = [
  { key: 'upload', label: 'קובץ' },
  { key: 'map', label: 'מיפוי' },
  { key: 'preview', label: 'הרצה יבשה' },
  { key: 'done', label: 'דוח' },
]

function StepBar({ step }: { step: Step }) {
  const index = STEPS.findIndex((entry) => entry.key === step)

  return (
    <ol className="flex flex-wrap gap-2 text-sm" aria-label="שלבי הייבוא">
      {STEPS.map((entry, position) => (
        <li
          key={entry.key}
          aria-current={entry.key === step ? 'step' : undefined}
          className={
            position <= index
              ? 'rounded-full bg-primary-soft px-3 py-1 font-semibold text-primary'
              : 'rounded-full bg-muted px-3 py-1 text-muted-foreground'
          }
        >
          {position + 1}. {entry.label}
        </li>
      ))}
    </ol>
  )
}

/**
 * A session id that is stable for this file in this browser tab.
 *
 * Derived rather than random, so pressing "import" again after a dropped
 * connection continues the same session instead of opening a second one. The
 * records carry their own idempotency keys regardless, so a wrong answer here
 * costs a duplicated *report*, never a duplicated booking.
 */
function sessionIdFor(fileName: string): string {
  let hash = 0
  for (let index = 0; index < fileName.length; index += 1) {
    hash = (Math.imul(hash, 31) + fileName.charCodeAt(index)) >>> 0
  }
  return `import-${hash.toString(16)}`
}
