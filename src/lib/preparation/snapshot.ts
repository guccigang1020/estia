/**
 * The mechanism that makes a booking immune to a rule change.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * In March the business raises the cleaning base rate from ₪350 to ₪400 and
 * adds a pool towel per guest. In April the accountant opens January's report
 * and every booking in it has moved: costs are higher, margins are lower,
 * agent commissions computed on a net basis have changed, and the preparation
 * plans that were actually worked no longer match what the system says was
 * required. Nothing was edited. The reports simply recomputed against today's
 * rules, and every historical number in the product became a lie.
 *
 * This is not a hypothetical failure mode; it is the default one. Any system
 * that stores rules in one table and reads them live when a report is opened
 * behaves this way, and the bug is invisible until somebody remembers what
 * last quarter looked like.
 *
 * ── The design ────────────────────────────────────────────────────────────
 *
 * Two independent defences, because either one alone fails in a way the other
 * covers.
 *
 * **1. Effective dating.** Every rule, cost and commission agreement carries
 * `effectiveFrom` / `effectiveTo`. Editing a rule closes the old row and opens
 * a new one rather than overwriting; `resolveCatalogue` asks "what was in force
 * on this date". This alone would be enough if the catalogue were append-only
 * and nothing else could change — but it is not: a property gains a bedroom, a
 * bed type's linen list is corrected, an event template is renamed. None of
 * those are effective-dated, and none of them should have to be.
 *
 * **2. The snapshot.** At the moment a booking's plan is first built, the
 * *resolved* configuration is copied onto the booking and frozen: bed types,
 * rules, templates, the property's layout, cost rules, the commission
 * agreement, the complexity weights and the price the guest was quoted. Every
 * later computation reads the snapshot.
 *
 * ── What makes it hold ────────────────────────────────────────────────────
 *
 * The guarantee is in the function signatures, not in a convention anyone has
 * to remember. `computeRequirements(booking, snapshot)` and
 * `computeEventPnL({ booking, snapshot, ... })` take **no catalogue argument
 * at all**. There is no parameter through which live configuration could reach
 * them, so the mistake is not available to make. `PreparationCatalogue` is
 * accepted by exactly one function in this module — `captureSnapshot` — and
 * that function's whole job is to stop being live.
 *
 * The snapshot is deep-frozen on capture, so a caller that tries to "just fix
 * one rule" on a stored booking gets a `TypeError` rather than a silently
 * rewritten history. And it carries a content hash: two bookings configured
 * identically share one, storage can be deduplicated on it, the work plan
 * records which snapshot it was built from, and `verifySnapshot` will say so
 * if the contents were ever changed underneath.
 *
 * ── Re-snapshotting ───────────────────────────────────────────────────────
 *
 * Occasionally legitimate: a rule was genuinely wrong and the booking has not
 * happened yet. It is therefore possible, but never automatic and never a side
 * effect of viewing anything — `resnapshot` is called by an operation that
 * demands a stated reason and writes an audit event naming both hashes.
 */

import { fingerprint } from '../service'
import { effectiveOn } from './rules'
import type {
  CommissionRule,
  EventTemplate,
  PreparationBooking,
  PreparationCatalogue,
  PreparationSnapshot,
} from './types'

/**
 * The catalogue as it stood on one date.
 *
 * Templates are resolved recursively: a template is a bag of ordinary rules,
 * and a rule inside one that was retired last month must not come back because
 * it happened to be nested.
 */
export interface ResolvedCatalogue {
  rules: PreparationCatalogue['rules']
  eventTemplates: readonly EventTemplate[]
  variableCosts: PreparationCatalogue['variableCosts']
  fixedCosts: PreparationCatalogue['fixedCosts']
  commissionRule: CommissionRule | null
}

export function resolveCatalogue(
  catalogue: PreparationCatalogue,
  date: string,
): ResolvedCatalogue {
  const commissionRules = effectiveOn(catalogue.commissionRules, date)

  return {
    rules: effectiveOn(catalogue.rules, date),
    eventTemplates: catalogue.eventTemplates.map((template) => ({
      ...template,
      rules: effectiveOn(template.rules, date),
    })),
    variableCosts: effectiveOn(catalogue.variableCosts, date),
    fixedCosts: effectiveOn(catalogue.fixedCosts, date),
    // The most recently opened agreement wins when two overlap. Overlapping
    // commission agreements are a data error; picking the newest is the
    // reading that matches what the business most recently decided.
    commissionRule:
      [...commissionRules].sort((a, b) =>
        a.effectiveFrom < b.effectiveFrom
          ? -1
          : a.effectiveFrom > b.effectiveFrom
            ? 1
            : 0,
      )[commissionRules.length - 1] ?? null,
  }
}

export interface CaptureInput {
  catalogue: PreparationCatalogue
  booking: PreparationBooking
  /** The date whose rules apply. Defaults to the day the guest arrives. */
  effectiveOn?: string
  capturedAt: string
}

export function captureSnapshot(input: CaptureInput): PreparationSnapshot {
  const { catalogue, booking } = input
  const date = input.effectiveOn ?? booking.stay.checkIn
  const resolved = resolveCatalogue(catalogue, date)

  const content = {
    organizationId: catalogue.organizationId,
    effectiveOn: date,
    bedTypes: catalogue.bedTypes,
    rules: resolved.rules,
    eventTemplates: resolved.eventTemplates,
    propertyConfiguration: catalogue.propertyConfiguration,
    variableCosts: resolved.variableCosts,
    fixedCosts: resolved.fixedCosts,
    commissionRule: resolved.commissionRule,
    complexity: catalogue.complexity,
    readinessPolicy: catalogue.readinessPolicy,
    sectionLabels: catalogue.sectionLabels,
    priceLines: booking.priceLines,
  }

  return deepFreeze({
    ...content,
    hash: contentHash(content),
    capturedAt: input.capturedAt,
  })
}

/**
 * The hash of what a snapshot says, not of when it was taken.
 *
 * `capturedAt` is deliberately outside the digest. Two bookings taken a week
 * apart against an unchanged configuration have the same content and should
 * share a hash — that is what makes deduplication possible and what makes
 * "did the rules change between these two bookings" a single comparison.
 */
function contentHash(
  content: Omit<PreparationSnapshot, 'hash' | 'capturedAt'>,
): string {
  return fingerprint(content)
}

/**
 * Does the snapshot still say what it said when it was hashed?
 *
 * The digest is not cryptographic and is not a defence against a determined
 * attacker with database access — it is a defence against a migration, a
 * background job or a well-meaning fix that rewrote history without noticing.
 * That is the failure that actually happens.
 */
export function verifySnapshot(snapshot: PreparationSnapshot): boolean {
  const { hash, capturedAt, ...content } = snapshot
  void capturedAt
  return contentHash(content) === hash
}

/**
 * Take a fresh snapshot for a booking that has not happened yet.
 *
 * Returns both hashes so the caller's audit event can name what moved. It
 * refuses nothing on its own: whether re-snapshotting is allowed at this point
 * in the booking's life is a question for the operation that calls it, which
 * is where the permission and the stated reason live.
 */
export function resnapshot(
  input: CaptureInput & {
    previous: PreparationSnapshot
  },
): { snapshot: PreparationSnapshot; changed: boolean; previousHash: string } {
  const snapshot = captureSnapshot(input)
  return {
    snapshot,
    changed: snapshot.hash !== input.previous.hash,
    previousHash: input.previous.hash,
  }
}

/**
 * Freeze an object and everything reachable from it.
 *
 * Shallow `Object.freeze` would leave `snapshot.rules[0].quantity.factor`
 * writable, which is exactly the depth at which somebody "just fixes" a
 * historical booking.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value

  Object.freeze(value)
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry)
  }

  return value
}
