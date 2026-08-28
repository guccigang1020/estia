/**
 * What an agent may hold, and for how long.
 *
 * A hold is the business's inventory taken off sale for nothing. An agent who
 * holds three villas for a fortnight while "waiting to hear back" has cost the
 * owner three fortnights of revenue and has been charged nothing for it, so the
 * numeric bounds in specification §6 are not configuration niceties — they are
 * the only thing standing between an agent network and an empty calendar.
 *
 * Four bounds, and a fifth thing that moves them:
 *
 *   1. **Concurrent** — live holds at one moment.
 *   2. **Daily** — holds started today, whatever happened to them since. This
 *      one catches the pattern the concurrent cap cannot: hold, release, hold,
 *      release, forty times, walking the calendar to read it.
 *   3. **Extensions** — how many times one hold may be renewed.
 *   4. **Expiry** — mandatory, and enforced by `booking/holds.ts`, which is
 *      where the contract makes an unbounded hold unrepresentable.
 *   5. **Reputation** — a score that widens the first three as an agent proves
 *      themselves. A new agent gets very little; one who converts what they
 *      hold gets more. This is what makes tight defaults acceptable rather than
 *      insulting.
 *
 * ── One hold engine, not two ──────────────────────────────────────────────
 *
 * Nothing here re-implements holds. Expiry, liveness, duration policy and the
 * draft are `booking/holds.ts`, which is also what the availability engine
 * consults; a second definition of "live" would mean an agent's dates were free
 * to one part of the system and taken by another. What this module adds is the
 * *agent-specific* ceilings, which the booking domain has no business knowing
 * about, and it adds them **before** delegating so a refusal never depends on
 * having reached the shared code.
 */

import { localDate } from '../booking/dates'
import { planHold, type HoldDraft, type HoldPolicy } from '../booking/holds'
import type { DateRange } from '../booking/types'
import { BusinessRuleError } from '../errors'

// ── The bounds ────────────────────────────────────────────────────────────

export interface AgentHoldLimits {
  /** Live holds at one moment. */
  maxConcurrent: number
  /** Holds started today, whatever became of them. */
  maxPerDay: number
  /** Renewals of a single hold. Zero means a hold gets its window and no more. */
  maxExtensions: number
  /** Minutes a hold gets when the agent does not choose. */
  defaultMinutes: number
  /** The ceiling on any one window, including a renewal. */
  maxMinutes: number
}

/**
 * The durations the interface offers, from §6.
 *
 * A custom value is still accepted — this is the list of buttons, not the set
 * of legal numbers, which is bounded by `maxMinutes`.
 */
export const HOLD_DURATION_PRESETS: readonly number[] = [5, 10, 15, 20, 30]

/**
 * What a brand-new agent gets before they have proved anything.
 *
 * Deliberately small. The specification does not state the numbers — §15 lists
 * them among what was not recovered — so these are defaults chosen to be safe
 * and are configurable per agent, not constants the product depends on.
 */
export const DEFAULT_AGENT_HOLD_LIMITS: AgentHoldLimits = {
  maxConcurrent: 3,
  maxPerDay: 10,
  maxExtensions: 1,
  defaultMinutes: 30,
  maxMinutes: 120,
}

// ── Reputation ────────────────────────────────────────────────────────────

/**
 * How an agent's record widens their allowance.
 *
 * Additive rather than multiplicative, so an owner reading the agent's screen
 * can do the arithmetic in their head: "three plus two, because he is proven".
 * A multiplier makes the same screen a puzzle.
 */
export interface ReputationTier {
  name: AgentReputationTier
  /** Lowest score that reaches this tier. */
  minScore: number
  label: string
  bonus: {
    maxConcurrent: number
    maxPerDay: number
    maxExtensions: number
  }
}

export type AgentReputationTier = 'new' | 'proven' | 'trusted' | 'preferred'

/** Ordered from the highest tier down, so the first match is the answer. */
export const REPUTATION_TIERS: readonly ReputationTier[] = [
  {
    name: 'preferred',
    minScore: 90,
    label: 'סוכן מועדף',
    bonus: { maxConcurrent: 10, maxPerDay: 30, maxExtensions: 3 },
  },
  {
    name: 'trusted',
    minScore: 75,
    label: 'סוכן מהימן',
    bonus: { maxConcurrent: 5, maxPerDay: 15, maxExtensions: 2 },
  },
  {
    name: 'proven',
    minScore: 50,
    label: 'סוכן מוכח',
    bonus: { maxConcurrent: 2, maxPerDay: 5, maxExtensions: 1 },
  },
  {
    name: 'new',
    minScore: 0,
    label: 'סוכן חדש',
    bonus: { maxConcurrent: 0, maxPerDay: 0, maxExtensions: 0 },
  },
]

export function reputationTierFor(score: number): ReputationTier {
  const clamped = clampScore(score)
  // The last entry has minScore 0, so this cannot fall through.
  return (
    REPUTATION_TIERS.find((tier) => clamped >= tier.minScore) ??
    REPUTATION_TIERS[REPUTATION_TIERS.length - 1]
  )
}

/** What the agent has done with the holds they were given. */
export interface AgentHoldPerformance {
  holdsCreated: number
  /** Became a booking. */
  holdsConverted: number
  /** Ran out of time with nobody looking at them. */
  holdsExpired: number
}

/**
 * Holds an agent must have taken before their record means anything.
 *
 * Without a floor, one hold converted once is a hundred per cent and buys the
 * top tier on the first afternoon.
 */
export const REPUTATION_MINIMUM_SAMPLE = 10

/**
 * Score an agent out of a hundred.
 *
 * Conversion is the numerator, and a lapsed hold costs half a conversion. The
 * asymmetry is deliberate: an agent who releases dates the moment a deal dies
 * has behaved well and is merely not rewarded, while one who lets them run out
 * has taken inventory off sale for the full window and is penalised for it.
 *
 * Below the sample floor the answer is zero, which means the base limits. That
 * is not a judgement about the agent; it is a refusal to guess.
 */
export function reputationScore(performance: AgentHoldPerformance): number {
  const { holdsCreated, holdsConverted, holdsExpired } = performance
  if (holdsCreated < REPUTATION_MINIMUM_SAMPLE) return 0

  const credited = holdsConverted - holdsExpired / 2
  return clampScore(Math.round((100 * credited) / holdsCreated))
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.min(100, Math.max(0, score))
}

/**
 * The bounds this agent actually works within.
 *
 * `overrides` is the manager override §6 asks for, and it wins outright rather
 * than adding: an owner who types "this one may hold twenty" means twenty, not
 * twenty plus whatever the tier had already granted.
 */
export function effectiveHoldLimits(
  base: AgentHoldLimits,
  reputation: number,
  overrides: Partial<AgentHoldLimits> = {},
): AgentHoldLimits {
  const { bonus } = reputationTierFor(reputation)
  return {
    maxConcurrent: base.maxConcurrent + bonus.maxConcurrent,
    maxPerDay: base.maxPerDay + bonus.maxPerDay,
    maxExtensions: base.maxExtensions + bonus.maxExtensions,
    defaultMinutes: base.defaultMinutes,
    maxMinutes: base.maxMinutes,
    ...overrides,
  }
}

// ── The ledger ────────────────────────────────────────────────────────────

/**
 * What the agent domain knows about a hold that the hold itself does not.
 *
 * `Hold` in `booking/types.ts` carries no creation timestamp and no extension
 * counter, and both are frozen contract. Two of the bounds §6 requires — the
 * daily maximum and the extension cap — cannot be computed without them, so
 * they live here, keyed by hold id, until those columns exist. See the note at
 * the foot of this file.
 */
export interface AgentHoldLedgerEntry {
  holdId: string
  organizationId: string
  agentUserId: string
  /** ISO instant. The clock the daily maximum is counted against. */
  createdAt: string
  extensionCount: number
}

/**
 * Holds this agent started today, in the property's day rather than UTC.
 *
 * A cap that rolls over at two in the morning local time is a cap that behaves
 * differently in summer, and an agent working a late evening would find their
 * allowance reset mid-conversation.
 */
export function holdsStartedOn(
  ledger: readonly AgentHoldLedgerEntry[],
  agentUserId: string,
  now: Date,
): number {
  const today = localDate(now)
  return ledger.filter((entry) => {
    if (entry.agentUserId !== agentUserId) return false
    const created = new Date(entry.createdAt)
    if (Number.isNaN(created.getTime())) return false
    return localDate(created) === today
  }).length
}

// ── The guards ────────────────────────────────────────────────────────────

export interface AgentHoldAllowance {
  limits: AgentHoldLimits
  /** Counted live, by the caller's clock, over everything the store returned. */
  liveHoldCount: number
  holdsStartedToday: number
}

/**
 * Refuse before anything is written.
 *
 * Both ceilings are checked, and the concurrent one first: it is the bound an
 * agent can act on immediately — release something — while the daily one can
 * only be waited out, and telling somebody to wait until tomorrow when they
 * could have freed a slot is a worse answer.
 */
export function assertAgentHoldWithinLimits(
  allowance: AgentHoldAllowance,
): void {
  const { limits, liveHoldCount, holdsStartedToday } = allowance

  if (liveHoldCount >= limits.maxConcurrent) {
    throw new BusinessRuleError({
      code: 'agent_hold.concurrent_limit',
      message:
        `Agent hold concurrency limit reached: ${liveHoldCount} live, ` +
        `limit ${limits.maxConcurrent}`,
      userMessage:
        `הגעת למספר ההחזקות המרבי שלך (${limits.maxConcurrent}). ` +
        'שחרר החזקה קיימת או המתן לפקיעתה כדי להחזיק תאריכים נוספים.',
      publicDetails: { limit: limits.maxConcurrent, current: liveHoldCount },
    })
  }

  if (holdsStartedToday >= limits.maxPerDay) {
    throw new BusinessRuleError({
      code: 'agent_hold.daily_limit',
      message:
        `Agent daily hold limit reached: ${holdsStartedToday} today, ` +
        `limit ${limits.maxPerDay}`,
      userMessage:
        `הגעת למספר ההחזקות המרבי להיום (${limits.maxPerDay}). ` +
        'המכסה מתחדשת מחר. לבקשה חריגה פנה למנהל הנכס.',
      publicDetails: { limit: limits.maxPerDay, current: holdsStartedToday },
    })
  }
}

/**
 * May this hold be renewed once more?
 *
 * Counted per hold rather than per agent: renewing one deal five times and
 * renewing five deals once are different behaviours, and only the first is the
 * one that keeps a single unit off sale all afternoon.
 */
export function assertAgentExtensionAllowed(
  entry: AgentHoldLedgerEntry,
  limits: AgentHoldLimits,
): void {
  if (entry.extensionCount < limits.maxExtensions) return

  throw new BusinessRuleError({
    code: 'agent_hold.extension_limit',
    message:
      `Hold ${entry.holdId} already extended ${entry.extensionCount} times, ` +
      `limit ${limits.maxExtensions}`,
    userMessage:
      limits.maxExtensions === 0
        ? 'לא ניתן להאריך את ההחזקה. סגור את העסקה או שחרר את התאריכים.'
        : `ניתן להאריך החזקה עד ${limits.maxExtensions} פעמים, וההחזקה הזו כבר הוארכה.`,
    publicDetails: { limit: limits.maxExtensions },
  })
}

/** A new ledger entry after a renewal. Never mutates the one it was given. */
export function recordExtension(
  entry: AgentHoldLedgerEntry,
): AgentHoldLedgerEntry {
  return { ...entry, extensionCount: entry.extensionCount + 1 }
}

// ── Planning one ──────────────────────────────────────────────────────────

export interface PlanAgentHoldInput {
  organizationId: string
  unitId: string
  range: DateRange
  agentUserId: string
  now: Date
  minutes?: number
  allowance: AgentHoldAllowance
}

/**
 * The hold that should be written, or a refusal.
 *
 * The agent ceilings are checked first and the shared planner second. Order
 * matters for the message rather than the outcome: an agent at their daily
 * limit should be told about their daily limit, not about the reason-level
 * concurrency policy they also happen to be within.
 *
 * Returns a draft. The write belongs to the operation, inside the transaction,
 * beside the exclusion constraint that is the real guarantee the dates are free.
 */
export function planAgentHold(input: PlanAgentHoldInput): HoldDraft {
  assertAgentHoldWithinLimits(input.allowance)

  const policy: Partial<HoldPolicy> = {
    maxConcurrent: input.allowance.limits.maxConcurrent,
    defaultMinutes: input.allowance.limits.defaultMinutes,
    maxMinutes: input.allowance.limits.maxMinutes,
  }

  return planHold({
    organizationId: input.organizationId,
    unitId: input.unitId,
    range: input.range,
    reason: 'agent_quote',
    heldByUserId: input.agentUserId,
    now: input.now,
    minutes: input.minutes,
    policy,
    liveHoldCount: input.allowance.liveHoldCount,
  })
}

/**
 * ── A note for whoever owns `src/lib/booking/types.ts` ────────────────────
 *
 * `Hold` has no `createdAt` and no `extensionCount`, and `holds.ts` already
 * says so at its own foot. This module works around it with a parallel ledger,
 * which is a second table holding facts about a row that should carry them
 * itself — every path that writes a hold now has to remember to write the
 * ledger too, and one that forgets silently restores an unlimited daily
 * allowance.
 *
 * Two columns close it: `holds.created_at timestamptz not null default now()`
 * and `holds.extension_count integer not null default 0`. With those,
 * `AgentHoldLedgerEntry` is deleted and both functions above read the hold.
 */
