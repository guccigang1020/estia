/**
 * The finance snapshot — how last month stops changing.
 *
 * A cost rule edited today must not alter a booking that closed in March. That
 * sentence is easy to agree with and almost never true in practice, because
 * the obvious implementation — store the rule id, look the rule up when you
 * report — silently rewrites history the moment anybody edits a percentage.
 * The owner statement issued in April then disagrees with the one reprinted in
 * June, and no one can say which was right.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────
 *
 * When a booking becomes financially real — the moment it is committed, and
 * again only on an explicit, audited decision — the finance domain **copies**
 * every rule that will decide its money into a `FinanceSnapshot`:
 *
 *   · the price lines themselves, as `booking/pricing.ts` produced them;
 *   · the commission rule, in full, not by reference;
 *   · the owner share rule, in full;
 *   · every expense rule in force for that property on that date, each with
 *     the `version` it had at the time;
 *   · the tax rate, the currency, the stay, the guest count.
 *
 * **The P&L reads the snapshot and nothing else.** `bookingPnl` takes a
 * `FinanceSnapshot` and has no access to a rule catalogue — not by convention,
 * but because there is no parameter through which one could be passed. That is
 * the whole guarantee: historical drift is not prevented by discipline, it is
 * unrepresentable.
 *
 * The live catalogue is used for exactly two things: producing a *new*
 * snapshot, and answering "has anything changed since?" — which is
 * `detectRuleDrift`, a report, never an application. A business that genuinely
 * wants a corrected rule applied to a past booking calls `resnapshot`, which
 * demands a reason, keeps the previous capture in a chain, and is audited like
 * any other change to money.
 *
 * ── Why a copy rather than a version pointer ──────────────────────────────
 *
 * A pointer to `expense_rules(id, version)` would be smaller and would survive
 * as long as nobody ever hard-deleted a rule or renumbered a version. Both
 * happen. A copy costs a few hundred bytes per booking and answers the
 * question — "on what basis was this figure produced?" — from the row itself,
 * years later, with no join and no assumption that the other table still tells
 * the truth. For money that is not a close call.
 */

import type { DateRange, PriceLine } from '../booking/types'
import { sumLines } from '../booking/pricing'
import { BusinessRuleError } from '../errors'
import { fingerprint } from '../service/idempotency'
import type { Currency } from './money'
import type {
  CommissionRule,
  ExpenseRule,
  ExpenseScope,
  ExpenseScopeKind,
  VariableFormula,
} from './types'

// ── Owner share ───────────────────────────────────────────────────────────

/**
 * What the property's owner receives.
 *
 * `basis` is the argument that actually happens: a percentage of revenue and a
 * percentage of profit are wildly different numbers, and which was agreed is
 * not something to be reconstructed from memory two years later.
 */
export interface OwnerShareRule {
  basis: 'gross_revenue' | 'net_revenue' | 'net_profit'
  kind: 'percent' | 'fixed'
  /** Percentage points for `percent`; agorot for `fixed`. */
  value: number
  label: string
}

// ── The frozen rule ───────────────────────────────────────────────────────

/**
 * An expense rule as it stood, copied whole.
 *
 * `ruleVersion` is kept alongside the copy so drift is *detectable* — the copy
 * alone would tell you what was used but not that the catalogue has moved on.
 */
export interface SnapshottedExpenseRule {
  ruleId: string
  ruleVersion: number
  label: string
  category: string
  kind: ExpenseRule['kind']
  scope: ExpenseScope
  frequency: ExpenseRule['frequency']
  amountAgorot: number
  formula: VariableFormula | null
  allocation: ExpenseRule['allocation']
}

export interface FinanceSnapshot {
  bookingId: string
  organizationId: string
  propertyId: string | null
  unitId: string
  /** ISO instant. Part of the snapshot's identity, and its sort order. */
  capturedAt: string
  capturedByUserId: string | null
  /** Why this capture exists. Mandatory on a re-snapshot. */
  reason: string
  /** 1 for the original; incremented by every deliberate re-capture. */
  revision: number
  /** The capture this one replaces, so the chain is readable. */
  supersedesCapturedAt: string | null

  range: DateRange
  nights: number
  guests: number

  /** Exactly as `priceStay` produced them. Never recomputed, never re-rounded. */
  lines: readonly PriceLine[]
  totalAgorot: number
  stayTotalAgorot: number
  depositAgorot: number
  taxAgorot: number
  taxRatePercent: number
  currency: Currency

  commissionRule: CommissionRule | null
  ownerShareRule: OwnerShareRule | null
  expenseRules: readonly SnapshottedExpenseRule[]
}

// ── Capture ───────────────────────────────────────────────────────────────

export interface CaptureSnapshotInput {
  bookingId: string
  organizationId: string
  propertyId: string | null
  unitId: string
  capturedAt: Date
  capturedByUserId: string | null
  reason: string
  range: DateRange
  nights: number
  guests: number
  /** From `priceStay`. The quote is the input; this module never prices. */
  lines: readonly PriceLine[]
  stayTotalAgorot: number
  depositAgorot: number
  taxAgorot: number
  taxRatePercent: number
  currency: Currency
  commissionRule: CommissionRule | null
  ownerShareRule: OwnerShareRule | null
  /** The live catalogue. Filtered to what applies, then copied. */
  expenseRules: readonly ExpenseRule[]
}

/**
 * Freeze the rules that will decide this booking's money.
 *
 * `totalAgorot` is `sumLines(lines)` and is not accepted from the caller. A
 * total handed in beside its own lines is a total that can disagree with them,
 * and the pricing engine's central promise — the total *is* the sum of the
 * lines — would survive exactly as long as the first careless call site.
 */
export function captureFinanceSnapshot(
  input: CaptureSnapshotInput,
): FinanceSnapshot {
  if (input.reason.trim().length === 0) {
    throw new BusinessRuleError({
      code: 'finance.snapshot_needs_reason',
      userMessage:
        'שמירת תמונת מצב פיננסית דורשת נימוק. הסבר בקצרה מדוע היא נלקחת.',
      message: 'captureFinanceSnapshot called without a reason',
    })
  }

  const applicable = applicableRules(input.expenseRules, {
    on: input.range.checkIn,
    propertyId: input.propertyId,
    unitId: input.unitId,
    bookingId: input.bookingId,
  })

  return {
    bookingId: input.bookingId,
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    unitId: input.unitId,
    capturedAt: input.capturedAt.toISOString(),
    capturedByUserId: input.capturedByUserId,
    reason: input.reason,
    revision: 1,
    supersedesCapturedAt: null,
    range: input.range,
    nights: input.nights,
    guests: input.guests,
    lines: [...input.lines],
    totalAgorot: sumLines(input.lines),
    stayTotalAgorot: input.stayTotalAgorot,
    depositAgorot: input.depositAgorot,
    taxAgorot: input.taxAgorot,
    taxRatePercent: input.taxRatePercent,
    currency: input.currency,
    commissionRule: input.commissionRule,
    ownerShareRule: input.ownerShareRule,
    expenseRules: applicable.map(freezeRule),
  }
}

function freezeRule(rule: ExpenseRule): SnapshottedExpenseRule {
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    label: rule.label,
    category: rule.category,
    kind: rule.kind,
    scope: { ...rule.scope },
    frequency: rule.frequency,
    amountAgorot: rule.amountAgorot,
    formula: rule.formula === null ? null : { ...rule.formula },
    allocation: rule.allocation,
  }
}

// ── Which rules apply ─────────────────────────────────────────────────────

export interface RuleTarget {
  /** The calendar date the rules are being resolved for — the arrival date. */
  on: string
  propertyId: string | null
  unitId: string
  bookingId: string
}

/**
 * The rules in force for one booking on one date.
 *
 * Two filters, and both are worth stating. **Effectivity is half-open**
 * (`effectiveFrom` inclusive, `effectiveTo` exclusive), the same convention as
 * a stay, so a rule replaced on the first of the month applies to neither day
 * twice nor neither day at all. **Scope is by containment**: an organization
 * rule reaches every booking, a property rule only its own property, a unit
 * rule only its own unit, and a booking rule only itself.
 */
export function applicableRules(
  catalogue: readonly ExpenseRule[],
  target: RuleTarget,
): readonly ExpenseRule[] {
  return catalogue.filter((rule) => {
    if (rule.effectiveFrom > target.on) return false
    if (rule.effectiveTo !== null && rule.effectiveTo <= target.on) return false
    return scopeReaches(rule.scope, target)
  })
}

function scopeReaches(scope: ExpenseScope, target: RuleTarget): boolean {
  const kind: ExpenseScopeKind = scope.kind
  switch (kind) {
    case 'organization':
      return true
    case 'property':
      return (
        scope.propertyId !== null &&
        scope.propertyId !== undefined &&
        scope.propertyId === target.propertyId
      )
    case 'unit':
      return scope.unitId === target.unitId
    case 'booking':
      return scope.bookingId === target.bookingId
    default:
      // Deny by default. An unrecognised scope allocates nothing rather than
      // everything, which is the failure mode that matters for a cost.
      return false
  }
}

// ── Drift ─────────────────────────────────────────────────────────────────

export type RuleDriftKind = 'edited' | 'withdrawn' | 'added'

export interface RuleDrift {
  kind: RuleDriftKind
  ruleId: string
  label: string
  snapshotVersion: number | null
  currentVersion: number | null
}

/**
 * What has changed in the catalogue since this snapshot was taken.
 *
 * A **report**, never an application. It exists so a finance manager can be
 * told "the cleaning contract was renegotiated after these twelve bookings
 * were snapshotted" and decide, deliberately, whether to re-snapshot any of
 * them. Nothing in this module calls it as part of computing a figure — a
 * function that quietly reconciled drift would be the very behaviour the
 * snapshot exists to prevent.
 */
export function detectRuleDrift(
  snapshot: FinanceSnapshot,
  catalogue: readonly ExpenseRule[],
): readonly RuleDrift[] {
  const current = applicableRules(catalogue, {
    on: snapshot.range.checkIn,
    propertyId: snapshot.propertyId,
    unitId: snapshot.unitId,
    bookingId: snapshot.bookingId,
  })

  const currentById = new Map(current.map((rule) => [rule.id, rule]))
  const drift: RuleDrift[] = []

  for (const frozen of snapshot.expenseRules) {
    const live = currentById.get(frozen.ruleId)
    if (!live) {
      drift.push({
        kind: 'withdrawn',
        ruleId: frozen.ruleId,
        label: frozen.label,
        snapshotVersion: frozen.ruleVersion,
        currentVersion: null,
      })
      continue
    }
    if (live.version !== frozen.ruleVersion) {
      drift.push({
        kind: 'edited',
        ruleId: frozen.ruleId,
        label: live.label,
        snapshotVersion: frozen.ruleVersion,
        currentVersion: live.version,
      })
    }
  }

  const frozenIds = new Set(snapshot.expenseRules.map((rule) => rule.ruleId))
  for (const rule of current) {
    if (frozenIds.has(rule.id)) continue
    drift.push({
      kind: 'added',
      ruleId: rule.id,
      label: rule.label,
      snapshotVersion: null,
      currentVersion: rule.version,
    })
  }

  return drift
}

// ── Re-snapshot ───────────────────────────────────────────────────────────

export interface ResnapshotInput extends CaptureSnapshotInput {
  previous: FinanceSnapshot
}

/**
 * Deliberately re-freeze a booking against today's rules.
 *
 * The only sanctioned way a past booking's basis changes. It demands a reason,
 * increments the revision, and records which capture it replaces, so the
 * question "why did March's profit change?" has an answer with a name and a
 * timestamp on it. The previous snapshot is not modified and must be retained
 * by the caller — a superseded snapshot is the evidence for the statement that
 * was already sent.
 */
export function resnapshot(input: ResnapshotInput): FinanceSnapshot {
  const captured = captureFinanceSnapshot(input)
  return {
    ...captured,
    revision: input.previous.revision + 1,
    supersedesCapturedAt: input.previous.capturedAt,
  }
}

/**
 * A stable digest of everything a snapshot decides.
 *
 * For an idempotency key and for a cheap "is this the same basis?" comparison
 * between two captures. Uses the service layer's fingerprint so there is one
 * hashing implementation in the product rather than two.
 */
export function snapshotFingerprint(snapshot: FinanceSnapshot): string {
  return fingerprint({
    bookingId: snapshot.bookingId,
    lines: snapshot.lines,
    totalAgorot: snapshot.totalAgorot,
    taxRatePercent: snapshot.taxRatePercent,
    commissionRule: snapshot.commissionRule,
    ownerShareRule: snapshot.ownerShareRule,
    expenseRules: snapshot.expenseRules,
  })
}
