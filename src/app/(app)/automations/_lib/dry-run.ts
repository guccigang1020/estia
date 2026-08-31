/**
 * What the automation library would do to this organization's real data, if it
 * were switched on right now.
 *
 * ── Why a dry run rather than a list of rules ─────────────────────────────
 *
 * A screen that renders fourteen rule cards proves nothing. Every one of them
 * could name an event the product never raises, or a condition no row in this
 * business would ever satisfy, and the page would look identical. So this
 * module reconstructs candidate events from rows that actually exist, hands
 * them to the **real engine**, and reports what came back.
 *
 * `runAutomations` is not re-implemented, approximated or bypassed here. The
 * same trigger match, the same condition evaluation, the same per-action
 * permission and plan checks and the same idempotency ledger run over these
 * candidates as would run over a live event. The only substitution is the
 * performer, which records instead of acting — which is precisely what makes
 * this a simulation rather than fourteen automations firing because somebody
 * opened a page.
 *
 * ── The events are reconstructed, and that is said out loud ───────────────
 *
 * ESTIA has no event store. `audit_events` records what people did, not the
 * domain events the product emitted, so a truthful "what fired last week" is
 * not available from this database and is not invented here. What *is*
 * available is the state those events left behind: a booking sitting in
 * `confirmed` was confirmed, a payment sitting in `failed` failed, a task past
 * its `due_at` is overdue. Each candidate below is derived from exactly such a
 * column, and a trigger with no derivable state — `booking.ready_for_check_in`
 * depends on a housekeeping sign-off this schema does not record — produces no
 * candidates at all rather than a guess. The screen reports zero for it, which
 * is the honest number.
 *
 * PURE. Rows in, candidates out. The reads live in `queries.ts`.
 */

import { nightsBetween } from '@/lib/booking/types'
import type { Actor } from '@/lib/authz/can'
import type { DomainEvent, DomainEventName } from '@/lib/contracts/events'
import { TASK_STATUSES, type TaskStatus } from '@/lib/contracts/states'
import {
  InMemoryAutomationLedger,
  runAutomations,
  type AutomationPerformer,
  type AutomationRule,
  type PerformInput,
} from '@/lib/automation'
import { InMemoryAuditWriter } from '@/lib/audit/pipeline'

/* ------------------------------------------------------------- the rows --- */

export interface BookingFact {
  id: string
  /** `null` when the reader may not see it. Never invented. */
  reference: string | null
  status: string
  checkIn: string
  checkOut: string
  propertyId: string | null
  /**
   * `null` when the reader may not see it — `booking.view_source` is a grant a
   * receptionist and a cleaner do not hold.
   *
   * Null means the fact is **omitted** from the candidate below, not filled
   * with a placeholder. That is this file's own rule applied to a privacy rule
   * rather than to a schema gap: a condition comparing `source`, read by
   * somebody who may not see `source`, must evaluate unmet and name the missing
   * fact — not match a fabricated `'unknown'` that no column contains.
   */
  source: string | null
}

export interface TaskFact {
  id: string
  title: string
  status: string
  dueAt: string | null
  propertyId: string | null
}

export interface PaymentFact {
  id: string
  status: string
  requiresAttention: boolean
  reference: string | null
  propertyId: string | null
}

export interface DryRunRows {
  bookings: readonly BookingFact[]
  tasks: readonly TaskFact[]
  payments: readonly PaymentFact[]
}

/* ------------------------------------------------------- the candidates --- */

export interface Candidate {
  event: DomainEvent
  facts: Readonly<Record<string, string | number | boolean | null>>
  /** What the reader is looking at, in Hebrew. Never a raw id. */
  label: string
}

/** Days before arrival that the pre-arrival event is raised. */
const PRE_ARRIVAL_DAYS = 3

const OCCUPYING_SOON = new Set(['confirmed', 'deposit_paid'])

/**
 * A job that has not finished, expressed as what it is *not*.
 *
 * This was written as an allow-list — `['pending', 'assigned', 'in_progress']`
 * — and it was wrong twice over, in the way an allow-list of enum members
 * written from memory always eventually is. `pending` is not a member of
 * `TASK_STATUSES` at all, so it matched nothing; and `new`, `accepted`,
 * `blocked` and `awaiting_approval` are every bit as unfinished as `assigned`
 * and were excluded. The effect was that `task.overdue` — the one simulated
 * trigger the operations rules hang off — produced zero candidates for every
 * reader on every dataset, and reported it as "your business has no late work".
 * A confident wrong zero, on the screen whose entire job is to be believed.
 *
 * Written as the complement of the three settled statuses instead, from the
 * frozen vocabulary itself, so a status added to `TASK_STATUSES` next year is
 * open by default rather than silently invisible — which is the safe direction:
 * an extra candidate is a number somebody questions, a missing one is a number
 * nobody sees. It is the same reading `summariseTasks` takes in
 * `tasks/_lib/queries.ts`, and it is derived rather than copied so the two
 * cannot drift.
 */
const SETTLED_TASK: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'completed',
  'verified',
  'cancelled',
])

const OPEN_TASK: ReadonlySet<string> = new Set<string>(
  TASK_STATUSES.filter((status) => !SETTLED_TASK.has(status)),
)

export function candidateEvents(
  organizationId: string,
  rows: DryRunRows,
  now: Date,
): readonly Candidate[] {
  const candidates: Candidate[] = []
  const today = now.toISOString().slice(0, 10)

  for (const booking of rows.bookings) {
    const nights = safeNights(booking.checkIn, booking.checkOut)
    const shared = {
      organizationId,
      resourceType: 'booking',
      resourceId: booking.id,
      propertyId: booking.propertyId,
      occurredAt: now.toISOString(),
    }
    const name = booking.reference ?? 'הזמנה'
    const facts: Record<string, string | number | boolean | null> = {
      status: booking.status,
      nights,
    }
    // Written only when it is known. See `BookingFact.source`.
    if (booking.source !== null) facts.source = booking.source

    if (booking.status === 'confirmed') {
      candidates.push({
        event: envelope('booking.confirmed', shared),
        facts,
        label: `${name} — אושרה`,
      })
    }

    if (
      OCCUPYING_SOON.has(booking.status) &&
      booking.checkIn >= today &&
      daysBetween(today, booking.checkIn) <= PRE_ARRIVAL_DAYS
    ) {
      candidates.push({
        event: envelope('booking.pre_arrival', shared),
        facts,
        label: `${name} — הגעה בתוך ${PRE_ARRIVAL_DAYS} ימים`,
      })
    }

    if (booking.status === 'checked_out') {
      candidates.push({
        event: envelope('booking.checked_out', shared),
        facts,
        label: `${name} — עזיבה`,
      })
    }

    if (booking.status === 'completed') {
      candidates.push({
        event: envelope('booking.completed', shared),
        facts,
        label: `${name} — שהייה הסתיימה`,
      })
    }

    if (booking.status === 'cancelled') {
      candidates.push({
        event: envelope('booking.cancelled', shared),
        facts,
        label: `${name} — בוטלה`,
      })
    }
  }

  for (const payment of rows.payments) {
    const shared = {
      organizationId,
      resourceType: 'payment',
      resourceId: payment.id,
      propertyId: payment.propertyId,
      occurredAt: now.toISOString(),
    }
    const name = payment.reference ?? 'תשלום'

    if (payment.status === 'failed') {
      candidates.push({
        event: envelope('payment.failed', shared),
        facts: { status: payment.status },
        label: `${name} — סליקה נכשלה`,
      })
    }

    // `unknown` and a standing `requires_attention` are the same sentence to
    // whoever reads this screen: nobody knows whether the card was charged.
    if (payment.status === 'unknown' || payment.requiresAttention) {
      candidates.push({
        event: envelope('payment.outcome_unknown', shared),
        facts: { status: payment.status },
        label: `${name} — תוצאת סליקה לא ידועה`,
      })
    }
  }

  const nowIso = now.toISOString()
  for (const task of rows.tasks) {
    if (!OPEN_TASK.has(task.status)) continue
    if (task.dueAt === null || task.dueAt >= nowIso) continue

    candidates.push({
      event: envelope('task.overdue', {
        organizationId,
        resourceType: 'task',
        resourceId: task.id,
        propertyId: task.propertyId,
        occurredAt: nowIso,
      }),
      facts: { status: task.status },
      label: `${task.title} — באיחור`,
    })
  }

  return candidates
}

function envelope(
  name: DomainEventName,
  shared: {
    organizationId: string
    resourceType: string
    resourceId: string
    propertyId: string | null
    occurredAt: string
  },
): DomainEvent {
  return {
    name,
    organizationId: shared.organizationId,
    resourceType: shared.resourceType,
    resourceId: shared.resourceId,
    propertyId: shared.propertyId,
    actorUserId: null,
    occurredAt: shared.occurredAt,
    correlationId: `dry-run::${shared.resourceId}`,
    // Deterministic, and distinct per trigger and per row, so the ledger
    // deduplicates a row that legitimately raises two different events exactly
    // as it would in production.
    idempotencyKey: `dry-run::${name}::${shared.resourceId}`,
    payload: {},
  }
}

/**
 * Nights, or zero.
 *
 * `nightsBetween` answers `NaN` for an unparseable range rather than throwing,
 * and `NaN` handed to a numeric condition would be compared rather than
 * refused. Zero is the honest substitute: a rule asking for two nights or more
 * does not match a stay whose length nobody could compute.
 */
function safeNights(checkIn: string, checkOut: string): number {
  const nights = nightsBetween({ checkIn, checkOut })
  return Number.isFinite(nights) ? nights : 0
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.POSITIVE_INFINITY
  return Math.round((end - start) / 86_400_000)
}

/* ----------------------------------------------------------- the dry run --- */

/** Records, never acts. The one substitution this simulation makes. */
class RecordingPerformer implements AutomationPerformer {
  readonly performed: PerformInput[] = []

  async perform(input: PerformInput): Promise<void> {
    this.performed.push(input)
  }
}

export interface RuleSimulation {
  rule: AutomationRule
  /** Candidates whose trigger matched this rule. */
  matched: number
  /** Of those, the ones whose IF clause held and whose actions would run. */
  wouldRun: number
  /** Matched, but the IF clause did not hold. */
  filtered: number
  /** Matched and would have run, but the role or the package refused. */
  refused: number
  /** Up to three, in Hebrew, so the number is checkable rather than trusted. */
  examples: readonly string[]
}

export interface DryRun {
  /** Every event the data implies, across all triggers. */
  candidates: number
  rules: readonly RuleSimulation[]
}

const EXAMPLE_LIMIT = 3

/**
 * Run the library over the candidates, through the real engine.
 *
 * One ledger for the whole simulation, so a row that would be deduplicated in
 * production is deduplicated here too — a dry run that double-counted would
 * overstate the work by exactly the amount the ledger exists to prevent.
 */
export async function simulate(
  actor: Actor,
  rules: readonly AutomationRule[],
  candidates: readonly Candidate[],
): Promise<DryRun> {
  const ledger = new InMemoryAutomationLedger()
  const audit = new InMemoryAuditWriter()

  const state = new Map<
    string,
    {
      matched: number
      wouldRun: number
      filtered: number
      refused: number
      examples: string[]
    }
  >()
  for (const rule of rules) {
    state.set(rule.id, {
      matched: 0,
      wouldRun: 0,
      filtered: 0,
      refused: 0,
      examples: [],
    })
  }

  for (const candidate of candidates) {
    const run = await runAutomations({
      event: candidate.event,
      facts: candidate.facts,
      rules,
      actor,
      performer: new RecordingPerformer(),
      ledger,
      audit,
      requestId: candidate.event.correlationId,
      now: new Date(candidate.event.occurredAt),
      retry: { maxAttempts: 1, backoffMs: 0 },
      sleep: async () => {},
    })

    if (run.outcome.status !== 'evaluated') continue

    for (const entry of run.outcome.rules) {
      const bucket = state.get(entry.rule.id)
      if (!bucket) continue

      switch (entry.outcome.status) {
        case 'skipped_trigger':
        case 'skipped_disabled':
          break
        case 'refused_plan':
          bucket.matched += 1
          bucket.refused += 1
          break
        case 'skipped_conditions':
          bucket.matched += 1
          bucket.filtered += 1
          break
        case 'ran': {
          bucket.matched += 1
          const ran = entry.outcome.actions.some(
            (result) =>
              result.outcome.status === 'executed' ||
              result.outcome.status === 'executed_unaudited',
          )
          const blocked = entry.outcome.actions.every(
            (result) =>
              result.outcome.status === 'refused_permission' ||
              result.outcome.status === 'refused_plan',
          )
          if (ran) {
            bucket.wouldRun += 1
            if (bucket.examples.length < EXAMPLE_LIMIT) {
              bucket.examples.push(candidate.label)
            }
          } else if (blocked) {
            bucket.refused += 1
          }
          break
        }
      }
    }
  }

  return {
    candidates: candidates.length,
    rules: rules.map((rule) => {
      const bucket = state.get(rule.id)
      return {
        rule,
        matched: bucket?.matched ?? 0,
        wouldRun: bucket?.wouldRun ?? 0,
        filtered: bucket?.filtered ?? 0,
        refused: bucket?.refused ?? 0,
        examples: bucket?.examples ?? [],
      }
    }),
  }
}
