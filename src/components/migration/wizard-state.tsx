'use client'

/**
 * EXECUTION CONTEXT — CLIENT. The migration that is in progress in this tab.
 *
 * ══ WHY THE FILE LIVES HERE AND NOWHERE ELSE ══════════════════════════════
 *
 * The other wizard in this codebase — `autopilot/settings/activate` — puts its
 * whole state in the URL, argues well for it, and is right. This one cannot,
 * and the reason is the difference between the two features rather than a
 * difference of opinion.
 *
 * What is being carried here is a spreadsheet of somebody else's customers:
 * eighteen hundred names, telephone numbers and home cities belonging to people
 * who have not heard of ESTIA. It is not going in a query parameter, it is not
 * going in `localStorage`, and it is not being uploaded so that a wizard can
 * have a nicer back button. It is read in this tab, held in memory, and it dies
 * with the tab. The first sentence on the upload step says so, because that
 * promise is worth more to a person evaluating us than a resumable session is.
 *
 * The consequence is that a reload starts again, and the consequence is stated
 * rather than hidden: `StepBlocked` explains it on every step that cannot open.
 *
 * ── Why it is a layout-level provider and not a page's `useState` ─────────
 *
 * Because there is a route per step, and Next.js keeps a layout's Client
 * Component state across navigation between the children under it. So the file
 * survives moving from `/migration/map` to `/migration/dry-run` and does not
 * survive a reload — which is exactly the pair of properties wanted.
 *
 * ── The one rule this file obeys absolutely ───────────────────────────────
 *
 * IT DECIDES NOTHING. Every count, every issue, every conflict and every record
 * on these screens comes out of `src/lib/migration`. This file holds what came
 * back, hands it to the next screen, and clears what a change invalidated. The
 * three domain calls it makes — `parseSource`, `suggestMappings`,
 * `validateRows` — are pure leaf modules, imported as leaves and never through
 * the `@/lib/migration` barrel, which reaches `repository.ts` and through it the
 * `postgres` driver: a Client Component that touches the barrel takes the whole
 * application down with `Can't resolve 'fs'`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from 'react'

import { fieldsFor, suggestMappings } from '@/lib/migration/mapping'
import { parseSource } from '@/lib/migration/parsers'
import { validateRows, type DateOrder } from '@/lib/migration/validate'
import type { ValidationResult } from '@/lib/migration/validate'
import {
  type CompletionReport,
  type Conflict,
  type ConflictDecision,
  type DryRunReport,
  type FieldMapping,
  type ImportEntity,
  type ImportField,
  type ImportRecord,
  type ParsedFile,
} from '@/lib/migration/types'

import type { MigrationProgress } from '@/app/(app)/migration/_lib/steps'

/* ------------------------------------------------------- the server side -- */

/**
 * The two server round trips, structurally.
 *
 * Declared as a shape rather than imported from `_lib/actions.ts` so that this
 * component depends on what it uses and not on a module marked `'use server'`.
 * The real actions satisfy it; a test double can too.
 */
export type WizardActions = {
  dryRun(request: {
    entity: ImportEntity
    rows: ParsedFile['rows']
    mappings: readonly FieldMapping[]
    decisions: readonly Conflict[]
    parseIssues: ParsedFile['issues']
    dateOrder?: DateOrder
  }): Promise<
    | {
        ok: true
        data: {
          report: DryRunReport
          records: readonly ImportRecord[]
          dateOrder: DateOrder
          dateOrderInferred: boolean
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

/* --------------------------------------------------------------- the state -- */

export type MigrationValue = {
  /* what was chosen */
  entity: ImportEntity
  unitName: string
  fileName: string | null

  /* what was read */
  parsed: ParsedFile | null
  mappings: readonly FieldMapping[]
  availableFields: readonly ImportField[]
  dateOrder: DateOrder | null
  validation: ValidationResult | null

  /* what the server said */
  report: DryRunReport | null
  records: readonly ImportRecord[]
  decisions: readonly Conflict[]
  completion: CompletionReport | null
  provisioned: boolean
  failure: string | null
  pending: boolean

  /* who this person is */
  mayApply: boolean
  missingGrants: readonly string[]

  /* what they can do */
  chooseEntity(entity: ImportEntity): void
  chooseUnitName(name: string): void
  readFile(file: File): Promise<void>
  remap(column: string, field: ImportField | null): void
  chooseDateOrder(order: DateOrder): void
  runDryRun(): void
  settle(conflictId: string, decision: ConflictDecision): void
  runImport(): void
  startOver(): void

  /* where they have got to */
  progress: MigrationProgress
}

const MigrationContext = createContext<MigrationValue | null>(null)

export function useMigration(): MigrationValue {
  const value = useContext(MigrationContext)
  if (value === null) {
    throw new Error('useMigration must be used inside <MigrationProvider>')
  }
  return value
}

/* ------------------------------------------------------------- the provider -- */

export function MigrationProvider({
  actions,
  mayApply,
  missingGrants,
  children,
}: {
  actions: WizardActions
  mayApply: boolean
  missingGrants: readonly string[]
  children: ReactNode
}) {
  const [pending, startTransition] = useTransition()

  const [entity, setEntity] = useState<ImportEntity>('bookings')
  const [unitName, setUnitName] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [mappings, setMappings] = useState<readonly FieldMapping[]>([])
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null)
  const [report, setReport] = useState<DryRunReport | null>(null)
  const [records, setRecords] = useState<readonly ImportRecord[]>([])
  const [decisions, setDecisions] = useState<readonly Conflict[]>([])
  const [completion, setCompletion] = useState<CompletionReport | null>(null)
  const [provisioned, setProvisioned] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)

  const availableFields = useMemo(() => fieldsFor(entity), [entity])

  /**
   * Everything downstream of the mapping, forgotten.
   *
   * Called whenever the mapping or the file changes. A dry run left on screen
   * while somebody edits what it describes is how a wrong import gets approved
   * — the numbers still look authoritative and no longer mean anything.
   */
  const invalidate = useCallback(() => {
    setReport(null)
    setRecords([])
    setDecisions([])
    setCompletion(null)
    setFailure(null)
  }, [])

  const chooseEntity = useCallback(
    (next: ImportEntity) => {
      setEntity(next)
      // The mapping was made against the previous entity's field list and
      // cannot survive the change; a stale one would quietly map a guest's
      // phone onto an agent's.
      setMappings([])
      setParsed(null)
      setFileName(null)
      invalidate()
    },
    [invalidate],
  )

  const readFile = useCallback(
    async (file: File) => {
      const text = await file.text()
      const result = parseSource(text, {
        entity,
        fileName: file.name,
        unitName: unitName.length > 0 ? unitName : undefined,
      })

      setFileName(file.name)
      setParsed(result)
      setMappings(suggestMappings(result.columns, entity))
      setDateOrder(null)
      invalidate()
    },
    [entity, unitName, invalidate],
  )

  const remap = useCallback(
    (column: string, field: ImportField | null) => {
      setMappings((current) =>
        current.map((mapping) =>
          mapping.column === column ? { column, field } : mapping,
        ),
      )
      invalidate()
    },
    [invalidate],
  )

  const chooseDateOrder = useCallback(
    (order: DateOrder) => {
      setDateOrder(order)
      invalidate()
    },
    [invalidate],
  )

  /**
   * The validation, run here in the browser.
   *
   * `validateRows` is pure — no clock, no client, no randomness — so the same
   * file and the same mapping produce the same records on this machine as on
   * the server. Running it here is what lets a person see what ESTIA made of
   * their file before a single row has left the tab.
   */
  const validation = useMemo<ValidationResult | null>(() => {
    if (parsed === null || parsed.rows.length === 0) return null
    if (!mappings.some((mapping) => mapping.field !== null)) return null

    return validateRows(parsed.rows, {
      entity,
      mappings,
      ...(dateOrder === null ? {} : { dateOrder }),
    })
  }, [parsed, mappings, entity, dateOrder])

  const request = useCallback(
    (nextDecisions: readonly Conflict[]) => {
      if (parsed === null) return

      startTransition(async () => {
        const result = await actions.dryRun({
          entity,
          rows: parsed.rows,
          mappings,
          decisions: nextDecisions,
          parseIssues: parsed.issues,
          ...(dateOrder === null ? {} : { dateOrder }),
        })

        if (!result.ok) {
          setFailure(result.error.message)
          return
        }

        setFailure(null)
        setReport(result.data.report)
        setRecords(result.data.records)
        // The server's list, not the one sent: it carries any conflict the file
        // gained since the last run, and dropping one would let a row through
        // that nobody has settled.
        setDecisions(result.data.report.conflicts)
        setProvisioned(result.data.provisioned)
      })
    },
    [actions, entity, parsed, mappings, dateOrder],
  )

  const runDryRun = useCallback(() => {
    request(decisions)
  }, [request, decisions])

  const settle = useCallback(
    (conflictId: string, decision: ConflictDecision) => {
      const next = decisions.map((conflict) =>
        conflict.id === conflictId ? { ...conflict, decision } : conflict,
      )
      setDecisions(next)
      // Re-run rather than adjust the counts here. What "38 will be written"
      // means after a decision is a domain question, and a screen that answered
      // it locally would eventually disagree with the import.
      request(next)
    },
    [decisions, request],
  )

  const runImport = useCallback(() => {
    if (report === null) return

    startTransition(async () => {
      const result = await actions.apply({
        entity,
        sessionId: sessionIdFor(fileName ?? 'import'),
        records: report.writable,
      })

      if (!result.ok) {
        setFailure(result.error.message)
        return
      }

      setFailure(null)
      setCompletion(result.data)
    })
  }, [actions, entity, fileName, report])

  const startOver = useCallback(() => {
    setParsed(null)
    setFileName(null)
    setMappings([])
    setDateOrder(null)
    invalidate()
  }, [invalidate])

  const progress = useMemo<MigrationProgress>(
    () => ({
      hasFile: parsed !== null,
      rowCount: parsed?.rows.length ?? 0,
      mappedFields: mappings.filter((mapping) => mapping.field !== null).length,
      validRecords: validation?.records.length ?? 0,
      hasDryRun: report !== null,
      undecided: decisions.filter(
        (conflict) => conflict.decision === 'undecided',
      ).length,
      writable: report?.writable.length ?? 0,
      hasCompletion: completion !== null,
    }),
    [parsed, mappings, validation, report, decisions, completion],
  )

  const value: MigrationValue = {
    entity,
    unitName,
    fileName,
    parsed,
    mappings,
    availableFields,
    dateOrder,
    validation,
    report,
    records,
    decisions,
    completion,
    provisioned,
    failure,
    pending,
    mayApply,
    missingGrants,
    chooseEntity,
    chooseUnitName: setUnitName,
    readFile,
    remap,
    chooseDateOrder,
    runDryRun,
    settle,
    runImport,
    startOver,
    progress,
  }

  return (
    <MigrationContext.Provider value={value}>
      {children}
    </MigrationContext.Provider>
  )
}

/**
 * A session id that is stable for this file in this tab.
 *
 * Derived rather than random, so pressing "import" again after a dropped
 * connection continues the same session instead of opening a second one. The
 * records carry their own idempotency keys regardless — see
 * `src/lib/migration/idempotency.ts` — so a wrong answer here costs a
 * duplicated *report*, never a duplicated booking.
 */
function sessionIdFor(fileName: string): string {
  let hash = 0
  for (let index = 0; index < fileName.length; index += 1) {
    hash = (Math.imul(hash, 31) + fileName.charCodeAt(index)) >>> 0
  }
  return `import-${hash.toString(16)}`
}
