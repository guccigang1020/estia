/**
 * The bus an import runs on, and the single most damaging bug this feature
 * could have.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT GOES WRONG WITHOUT THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An operator imports three years of history on a Tuesday afternoon. Eighteen
 * hundred `booking.created` events reach the bus. Every subscriber does exactly
 * what it was built to do:
 *
 *   · the notification router sends eighteen hundred confirmation messages, to
 *     real telephone numbers, for stays that ended in 2023;
 *   · the preparation engine calculates eighteen hundred work plans and the
 *     linen forecast reports a catastrophic shortage for last March;
 *   · the task engine opens cleaning tasks with due dates in the past, and the
 *     action centre — the screen a manager opens at 8am — fills with four
 *     thousand overdue items;
 *   · `guest.created` starts eighteen hundred guest-journey timers;
 *   · Autopilot observes a pattern that never happened and offers to automate
 *     it.
 *
 * The messages cannot be recalled. That is the part that makes this different
 * from every other bug in the module: a wrong date is corrected, a duplicate
 * guest is merged, and a message sent to a guest at 3am about a stay from 2023
 * is permanent, and it is sent from the operator's own business, on the first
 * day they trusted the product with their history.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW IT IS PREVENTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not by remembering to pass `nullEventBus`. By making a live bus unreachable:
 *
 *   1. This file's bus **has no subscribers and cannot be given any.** It
 *      implements `EventBus` — the one method the service pipeline calls — and
 *      the implementation records and returns. There is no `subscribe`.
 *
 *   2. `commands.ts` is the only thing that builds the import's
 *      `OperationServices`, and its options type is
 *      `Omit<OperationServices, 'events' | 'onEventError'>`. A caller cannot
 *      pass a bus at all: `events` is not a field on the argument, so a live
 *      bus is a type error at the call site rather than a mistake discovered
 *      in a customer's message log.
 *
 *   3. Nothing is silently dropped. Every suppressed event is kept and appears
 *      on the completion report. "No messages were sent to your guests" is a
 *      promise, and a promise with an itemised list under it is the only kind
 *      an operator can actually check.
 *
 * ── Why the whole import and not only the historic part ──────────────────
 *
 * A tempting refinement is to suppress events for stays in the past and let
 * future ones through, so an imported arrival next Thursday still gets its
 * confirmation. It is refused, and the reason is that the rule has to be
 * checkable in one line. "Events never leave an import" is a property anybody
 * can verify from the constructor's type. "Events leave an import when the
 * check-out date is in the future relative to the property's local day, unless
 * the status is …" is a rule with edge cases, and the cost of getting one of
 * those edge cases wrong is a message that cannot be unsent.
 *
 * A future arrival that genuinely needs its confirmation is an ordinary act on
 * an ordinary booking screen afterwards, performed deliberately by a person who
 * can see what they are sending.
 */

import type { DomainEvent, EventBus } from '../service'
import type { SuppressedEvent } from './types'

/**
 * A bus that records and never delivers.
 *
 * Deliberately not `nullEventBus`. That one discards, which would be correct
 * behaviour and an unauditable one: the report could then only claim that
 * nothing was sent. This keeps the evidence.
 */
export class EventQuarantine implements EventBus {
  private readonly captured: {
    event: DomainEvent
    rowNumber: number
    reason: string
  }[] = []

  /** The source row whatever runs next belongs to. */
  private currentRow = 0
  private currentReason = 'ייבוא נתונים ממערכת קודמת'

  /**
   * Say which source row the next operation belongs to.
   *
   * Called by `apply.ts` immediately before each record's write, so a
   * suppressed event on the report points at a row in the operator's own file
   * rather than at "the import" as a whole. Attribution is recorded at capture
   * time and not read back later: the import is sequential, and reading the
   * field afterwards would attribute every event to the last row written.
   */
  attributeTo(rowNumber: number, reason?: string): void {
    this.currentRow = rowNumber
    if (reason !== undefined) this.currentReason = reason
  }

  /** The `EventBus` contract, and the whole of it. No dispatch, ever. */
  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.captured.push({
        event,
        rowNumber: this.currentRow,
        reason: this.currentReason,
      })
    }
  }

  /** What was withheld, for the completion report. */
  get suppressed(): readonly SuppressedEvent[] {
    return this.captured.map((entry) => ({
      name: entry.event.name,
      rowNumber: entry.rowNumber,
      reason: entry.reason,
    }))
  }

  /** How many events never left. The headline number on the report. */
  get count(): number {
    return this.captured.length
  }

  /** The raw events, for a test that asserts exactly what was withheld. */
  get events(): readonly DomainEvent[] {
    return this.captured.map((entry) => entry.event)
  }
}
