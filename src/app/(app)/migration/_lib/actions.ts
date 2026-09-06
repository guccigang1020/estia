'use server'

/**
 * EXECUTION CONTEXT — SERVER ACTIONS. The migration's two server round trips.
 *
 * ── Two, and only two ─────────────────────────────────────────────────────
 *
 * `dryRunMigrationAction` writes nothing and says what would happen.
 * `applyMigrationAction` performs it. Everything between them — parsing,
 * detecting the format, proposing a mapping, arguing about a column, settling a
 * conflict — happens in the browser against pure functions, so a person can
 * take twenty minutes over the mapping without a single request leaving their
 * machine.
 *
 * ── The dry run is on the server for a reason, and it is not writing ──────
 *
 * It compares the file against everything already in ESTIA, and that snapshot —
 * every unit, the guests' identity keys, the bookings that overlap the file's
 * window — is not something to ship to a browser. So the *comparison* runs
 * here, over data loaded here, and `dryRun` itself remains the writer-free
 * synchronous function it is: this action loads, calls it, and returns.
 *
 * ── `assertCan` is called here as well ────────────────────────────────────
 *
 * The route gate already refused, the domain operations check again, and row
 * level security refuses regardless. This is the independent third check: a
 * Server Action is reachable by a crafted POST whatever the screen rendered.
 *
 * ── Nothing throws ────────────────────────────────────────────────────────
 *
 * A throw inside a Server Action reaches the browser as a digest and an empty
 * screen — which, on the screen where somebody has just spent twenty minutes
 * mapping columns, would lose the twenty minutes as well as the answer.
 */

import { assertCan } from '@/lib/authz/can'
import { toSafeResponse, type SafeErrorBody } from '@/lib/errors'
import {
  applyImport,
  defineImportCommands,
  dryRun,
  validateRows,
  type Conflict,
  type CompletionReport,
  type DryRunReport,
  type FieldMapping,
  type ImportEntity,
  type ImportRecord,
  type SourceRow,
  type ValidationIssue,
} from '@/lib/migration'
import type { DateOrder } from '@/lib/migration'
import {
  SupabaseAuditWriter,
  SupabaseIdempotencyStore,
} from '@/lib/persistence'
import { SupabaseBookingRepository } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { auditActorFor, transactionRunner } from '../../_lib/wiring'
import { MIGRATION_APPLY, MIGRATION_VIEW } from './access'
import { loadMigrationWorld } from './queries'

export type ActionResult<TData> =
  { ok: true; data: TData } | { ok: false; error: SafeErrorBody }

export type DryRunRequest = {
  entity: ImportEntity
  rows: readonly SourceRow[]
  mappings: readonly FieldMapping[]
  decisions: readonly Conflict[]
  parseIssues: readonly ValidationIssue[]
  dateOrder?: DateOrder
  emailIsVerified?: boolean
}

export type DryRunResponse = {
  report: DryRunReport
  /** Handed back so the apply writes exactly what the preview described. */
  records: readonly ImportRecord[]
  dateOrder: DateOrder
  dateOrderInferred: boolean
  provisioned: boolean
}

async function ready() {
  const context = await shellContext()

  if (!context || context.status !== 'ready') {
    return {
      ok: false as const,
      error: {
        code: context ? 'membership_not_active' : 'unauthenticated',
        message: context
          ? 'אין לך מרחב עבודה פעיל, ולכן לא ניתן להריץ ייבוא.'
          : 'החיבור למערכת פג. התחבר מחדש כדי להמשיך.',
        dataMessage: 'הנתונים לא נשמרו. שום דבר במערכת לא השתנה.',
        retryMessage: 'ניסיון חוזר לא יעזור עד שהמצב הזה ישתנה.',
        dataOutcome: 'not_saved' as const,
        retryable: false,
        correlationId: crypto.randomUUID(),
      },
    }
  }

  return { ok: true as const, context }
}

/**
 * The earliest and latest date this file touches.
 *
 * Used to bound the booking read. `null` when the file carries no dates at all,
 * which means nothing in it can collide with a stay and the read is skipped
 * entirely.
 */
function windowOf(
  records: readonly ImportRecord[],
): { from: string; to: string } | null {
  let from: string | null = null
  let to: string | null = null

  for (const record of records) {
    const range =
      record.values.entity === 'bookings'
        ? {
            start: record.values.booking.checkIn,
            end: record.values.booking.checkOut,
          }
        : record.values.entity === 'blocked_dates'
          ? {
              start: record.values.block.fromDate,
              end: record.values.block.toDate,
            }
          : null
    if (range === null) continue

    if (from === null || range.start < from) from = range.start
    if (to === null || range.end > to) to = range.end
  }

  return from !== null && to !== null ? { from, to } : null
}

export async function dryRunMigrationAction(
  request: DryRunRequest,
): Promise<ActionResult<DryRunResponse>> {
  const gate = await ready()
  if (!gate.ok) return gate

  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, MIGRATION_VIEW)

    const validated = validateRows(request.rows, {
      entity: request.entity,
      mappings: request.mappings,
      dateOrder: request.dateOrder,
    })

    const db = await createClient()
    const { world, provisioned } = await loadMigrationWorld({
      db,
      organizationId: gate.context.actor.organizationId,
      entity: request.entity,
      window: windowOf(validated.records),
    })

    const report = dryRun({
      records: validated.records,
      world,
      // The property-local day. A stay that ended yesterday and one that ends
      // tonight are treated differently, and an ISO slice of UTC would file a
      // Friday checkout in Israel under Thursday.
      computedOn: new Date().toISOString().slice(0, 10),
      decisions: request.decisions,
      issues: [...request.parseIssues, ...validated.issues],
      emailIsVerified: request.emailIsVerified,
    })

    return {
      ok: true,
      data: {
        report,
        records: validated.records,
        dateOrder: validated.dateOrder,
        dateOrderInferred: validated.dateOrderInferred,
        provisioned,
      },
    }
  } catch (error) {
    return { ok: false, error: toSafeResponse(error, correlationId).error }
  }
}

export type ApplyRequest = {
  entity: ImportEntity
  sessionId: string
  /** The dry run's `writable`, unchanged. */
  records: readonly ImportRecord[]
}

export async function applyMigrationAction(
  request: ApplyRequest,
): Promise<ActionResult<CompletionReport>> {
  const gate = await ready()
  if (!gate.ok) return gate

  const correlationId = crypto.randomUUID()

  try {
    assertCan(gate.context.actor, MIGRATION_APPLY)

    const db = await createClient()
    const { transactions } = transactionRunner(db)

    const { world } = await loadMigrationWorld({
      db,
      organizationId: gate.context.actor.organizationId,
      entity: request.entity,
      window: windowOf(request.records),
    })

    // The one place the import's services are assembled, and `events` is not a
    // field on the argument — see `src/lib/migration/commands.ts`. A live bus
    // cannot be passed in, so no imported stay can reach a subscriber.
    const { commands, quarantine } = defineImportCommands({
      db,
      bookings: new SupabaseBookingRepository(db),
      services: {
        audit: new SupabaseAuditWriter(db),
        idempotency: new SupabaseIdempotencyStore(db),
        transactions,
      },
    })

    const now = new Date()
    const report = await applyImport({
      sessionId: request.sessionId,
      records: request.records,
      commands,
      quarantine,
      calendar: world.calendar,
      ledger: world.ledger,
      context: {
        actor: gate.context.actor,
        auditActor: auditActorFor(gate.context.user),
        correlationId,
        now,
      },
      today: now.toISOString().slice(0, 10),
      startedAt: now.toISOString(),
    })

    return { ok: true, data: report }
  } catch (error) {
    return { ok: false, error: toSafeResponse(error, correlationId).error }
  }
}
