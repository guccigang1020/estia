/**
 * The rate resolver: inputs in, a `StayPricingRequest` out.
 *
 * ══ 🔒 THIS FILE PRODUCES NO PRICE ══════════════════════════════════════════
 *
 * `resolveStay` returns a `StayPricingRequest` — one integer per night in
 * `nightlyOverrides`, plus the fees and the tax rate. `priceStay` in
 * `src/lib/booking/pricing.ts` turns that into lines and a total, and it
 * remains the only place in the product that does. Nothing here imports
 * `sumLines`, and nothing here adds two amounts that a guest will see as
 * separate lines.
 *
 * The payoff is that "the total is the sum of the lines" is true by
 * construction. Two files that both produce money are two files that can
 * disagree about it, and the disagreement always surfaces on an invoice.
 *
 * ══ THE ORDER, AND WHY IT IS THIS ORDER (spec §7.7) ═════════════════════════
 *
 *   1  choose exactly one rate plan          ← an agent rate is a PLAN
 *   2  one base rule per night               ← the specificity ladder
 *   3  the calendar addition                 ← max(weekend, holiday), not sum
 *   4  demand · event · guest count
 *   6  clamp into [floor, ceiling]
 *   7  round, once
 *   8  refuse if the stay is under the minimum — refuse, do not re-price
 *
 * Step 1 is the answer to the question the whole specification is built
 * around. An agent rate is not a discount competing with a promotion: it is a
 * different rule table, chosen before any night is priced, so it changed which
 * rules step 2 ever read. Four things — season, weekend, promotion, agent rate
 * — operate at four different levels, and that is why they combine into one
 * number without any of them having to know about the others.
 *
 * ══ ROUNDING HAPPENS ONCE ═══════════════════════════════════════════════════
 *
 * 🔒 Every addition accumulates as a fraction and the night is rounded once,
 * at the end, by `roundAgorot` from `booking/pricing.ts`. Rounding each
 * addition separately produces a drift that grows with the number of
 * additions, and a three-night stay with a weekend uplift and a demand tier
 * would then disagree with the same stay priced a different way round.
 *
 * The second and last rounding in the system is inside `priceStay`, on the
 * percentage lines. `rounding.test.ts` proves there is no third.
 */

import { roundAgorot, type StayPricingRequest } from '../booking/pricing'
import { eachNight } from '../booking/dates'
import { nightsBetween, type Agorot } from '../booking/types'
import { dayOfWeek, isPeakNight, specialDaysOn } from '../hebrew-calendar'
import { unknown, type Measure } from '../revenue/types'
import {
  BPS_PER_UNIT,
  MAX_DERIVATION_DEPTH,
  SPECIFICITY,
  type ModifierTrigger,
  type NightResolution,
  type PricingContext,
  type PricingRefusal,
  type PricingResolution,
  type RateCalendarEntry,
  type RateModifier,
  type RatePlan,
  type RateRule,
} from './types'

// ── The specificity ladder ────────────────────────────────────────────────

/**
 * The rung a rule sits on, from what it actually says.
 *
 * Mirrors `public.rate_rule_specificity` in `0072_pricing.sql`. The database
 * stores the value so it can be sorted and indexed; this function exists
 * because the resolver has to rank a `rate_calendar` entry — which has no
 * stored specificity, being always 100 — against a rule that does.
 * `specificity.test.ts` proves the two ladders agree on all six rungs.
 */
export function computeSpecificity(
  scopeKind: RateRule['scopeKind'],
  weekdays: readonly number[],
): number {
  const weekdayScoped = weekdays.length > 0
  switch (scopeKind) {
    case 'unit':
      return weekdayScoped ? SPECIFICITY.unitWeekday : SPECIFICITY.unit
    case 'unit_group':
      return weekdayScoped
        ? SPECIFICITY.unitGroupWeekday
        : SPECIFICITY.unitGroup
    case 'property':
      return weekdayScoped ? SPECIFICITY.propertyWeekday : SPECIFICITY.property
  }
}

// ── Step 1 · which rate plan ──────────────────────────────────────────────

/** Half-open `[from, to)`, the only date convention in the product. */
function withinHalfOpen(
  date: string,
  from: string,
  to: string | null,
): boolean {
  if (date < from) return false
  return to === null || date < to
}

/** Whole days from `effectiveOn` to check-in. The basis of early/last minute. */
export function advanceDays(context: PricingContext): number {
  const from = Date.parse(`${context.effectiveOn}T00:00:00Z`)
  const to = Date.parse(`${context.range.checkIn}T00:00:00Z`)
  return Math.round((to - from) / 86_400_000)
}

function planIsEligible(
  plan: RatePlan,
  context: PricingContext,
  nights: number,
  advance: number,
): boolean {
  if (!plan.isActive) return false
  if (
    !withinHalfOpen(context.effectiveOn, plan.effectiveFrom, plan.effectiveTo)
  ) {
    return false
  }
  if (plan.propertyId !== null && plan.propertyId !== context.propertyId) {
    return false
  }
  if (
    plan.channelScope.length > 0 &&
    !plan.channelScope.includes(context.source)
  ) {
    return false
  }
  // Deny by default: an unheld grant removes the plan from the candidate list
  // entirely, so an agent without `rate.view_agent` is not quoted an agent
  // rate and is not told one exists. Row level security refuses underneath.
  if (plan.requiresGrant !== null && !context.grants.has(plan.requiresGrant)) {
    return false
  }
  if (plan.minNights !== null && nights < plan.minNights) return false
  if (plan.maxNights !== null && nights > plan.maxNights) return false
  if (plan.advanceDaysMin !== null && advance < plan.advanceDaysMin) {
    return false
  }
  if (plan.advanceDaysMax !== null && advance > plan.advanceDaysMax) {
    return false
  }
  return true
}

/**
 * Exactly one plan, or a refusal.
 *
 * `priority desc`, then `code asc`. The second is arbitrary and that is the
 * point: it is STABLE, so the same inputs choose the same plan on every run,
 * in every process, a year from now. Falling back to a base price when no plan
 * is eligible was considered and rejected by spec §7.8 — a quote sold from no
 * rate plan is a quote nobody approved.
 */
export function selectRatePlan(
  context: PricingContext,
): { ok: true; plan: RatePlan } | { ok: false; refusal: PricingRefusal } {
  const nights = nightsBetween(context.range)
  if (!Number.isFinite(nights) || nights <= 0) {
    return { ok: false, refusal: { code: 'invalid_range' } }
  }

  const advance = advanceDays(context)
  const eligible = context.plans.filter((plan) =>
    planIsEligible(plan, context, nights, advance),
  )

  if (eligible.length === 0) {
    return { ok: false, refusal: { code: 'no_rate_plan' } }
  }

  const chosen = [...eligible].sort(
    (a, b) => b.priority - a.priority || (a.code < b.code ? -1 : 1),
  )[0]

  return { ok: true, plan: chosen }
}

/**
 * Follow a `derivation` chain and fold its adjustments into the plan's bounds.
 *
 * The chain is walked to `MAX_DERIVATION_DEPTH` and no further, and a repeated
 * id is a cycle. Both are refusals rather than best-effort answers: a rate card
 * that quietly stops resolving at depth four prices some stays from a parent
 * plan and some from a child, and nobody would be able to say which.
 *
 * A derived plan takes its PARENT's rules — that is what derivation means —
 * and applies the adjustment to every night the parent produced. The child's
 * own floor and ceiling still win, because a business that set a floor on the
 * child meant the floor to apply to what the child sells.
 */
export function resolveDerivation(
  plan: RatePlan,
  plans: readonly RatePlan[],
):
  | {
      ok: true
      /** The plan whose rules are read. Equal to `plan` when undivided. */
      source: RatePlan
      chain: readonly string[]
      /** Applied to every night the source produced, in order. */
      adjustments: readonly RateDerivationStep[]
    }
  | { ok: false; refusal: PricingRefusal } {
  const chain: string[] = [plan.id]
  const adjustments: RateDerivationStep[] = []
  let current = plan

  while (current.derivation !== null) {
    if (adjustments.length >= MAX_DERIVATION_DEPTH) {
      return {
        ok: false,
        refusal: { code: 'derivation_too_deep', ratePlanId: plan.id },
      }
    }

    const parentId = current.derivation.fromRatePlanId
    if (chain.includes(parentId)) {
      return {
        ok: false,
        refusal: { code: 'derivation_cycle', ratePlanId: plan.id },
      }
    }

    const parent = plans.find((candidate) => candidate.id === parentId)
    if (parent === undefined) {
      // A plan pointing at one that is not in scope is not a cycle and not a
      // depth problem: it is a rate card with a hole. Refused with the same
      // code as a missing plan, because the effect on the caller is the same.
      return { ok: false, refusal: { code: 'no_rate_plan' } }
    }

    adjustments.push(current.derivation.adjust)
    chain.push(parentId)
    current = parent
  }

  return { ok: true, source: current, chain, adjustments }
}

type RateDerivationStep = { kind: 'percent' | 'fixed'; value: number }

/**
 * Apply the derivation adjustments to one night, innermost first.
 *
 * Fractional on purpose. The result feeds the additions and the clamp, and is
 * rounded once at the end of the night — see the header.
 */
function applyDerivation(
  base: number,
  adjustments: readonly RateDerivationStep[],
): number {
  let value = base
  // Reversed: `adjustments` was collected child-first while walking up to the
  // parent, and the parent's price is what the innermost adjustment adjusts.
  for (let index = adjustments.length - 1; index >= 0; index -= 1) {
    const step = adjustments[index]
    value =
      step.kind === 'percent'
        ? value + (value * step.value) / BPS_PER_UNIT
        : value + step.value
  }
  return value
}

// ── Step 2 · the base rule for one night ──────────────────────────────────

function ruleAppliesToNight(
  rule: RateRule,
  night: string,
  effectiveOn: string,
  scopeIds: { unitId: string; unitGroupId: string | null; propertyId: string },
): boolean {
  if (!withinHalfOpen(night, rule.dateFrom, rule.dateTo)) return false
  if (!withinHalfOpen(effectiveOn, rule.effectiveFrom, rule.effectiveTo)) {
    return false
  }
  if (rule.weekdays.length > 0 && !rule.weekdays.includes(dayOfWeek(night))) {
    return false
  }
  switch (rule.scopeKind) {
    case 'unit':
      return rule.scopeId === scopeIds.unitId
    case 'unit_group':
      return (
        scopeIds.unitGroupId !== null && rule.scopeId === scopeIds.unitGroupId
      )
    case 'property':
      return rule.scopeId === scopeIds.propertyId
  }
}

/**
 * The four tie-breakers of spec §7.2, exhaustive and in this order.
 *
 * `specificity desc → priority desc → effectiveFrom desc → id asc`.
 *
 * The last one is not decoration. Two rules written in the same millisecond
 * with everything else equal have to resolve to the same winner on every run
 * of every process, or the same guest gets two different quotes. The database
 * forbids that tie outright (`rate_rules_no_ambiguous_overlap` in 0072), and
 * this exists because "must not happen" and "will not happen" are different
 * statements.
 */
function betterRule(a: RateRule, b: RateRule): number {
  if (a.specificity !== b.specificity) return b.specificity - a.specificity
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.effectiveFrom !== b.effectiveFrom) {
    return a.effectiveFrom < b.effectiveFrom ? 1 : -1
  }
  return a.id < b.id ? -1 : 1
}

interface NightBase {
  amount: Agorot
  origin: NightResolution['baseOrigin']
  sourceId: string | null
  label: string | null
  specificity: number
}

function baseForNight(
  night: string,
  ratePlanId: string,
  context: PricingContext,
  rules: readonly RateRule[],
  calendar: readonly RateCalendarEntry[],
): NightBase {
  // The calendar first, unconditionally. A person who typed a number against
  // one unit on one night meant it, and no seasonal rule outranks that.
  const entry = calendar.find(
    (row) =>
      row.date === night &&
      row.unitId === context.unitId &&
      row.ratePlanId === ratePlanId,
  )
  if (entry !== undefined) {
    return {
      amount: entry.nightlyAgorot,
      origin: 'rate_calendar',
      sourceId: entry.id,
      label: entry.source === 'ai_approved' ? 'מחיר שאושר' : 'מחיר ידני',
      specificity: SPECIFICITY.rateCalendar,
    }
  }

  const candidates = rules
    .filter(
      (rule) =>
        rule.ratePlanId === ratePlanId &&
        ruleAppliesToNight(rule, night, context.effectiveOn, {
          unitId: context.unitId,
          unitGroupId: context.unitGroupId,
          propertyId: context.propertyId,
        }),
    )
    .sort(betterRule)

  if (candidates.length > 0) {
    const winner = candidates[0]
    return {
      amount: winner.nightlyAgorot,
      origin: 'rate_rule',
      sourceId: winner.id,
      label: winner.label,
      specificity: winner.specificity,
    }
  }

  // Spec §6 rule 8: the last floor, and it is never null. A unit whose base
  // price is zero IS representable — the settings screen warns about it — but
  // the resolution says `unit_base_price` so a report can find every stay that
  // was priced from nothing.
  return {
    amount: context.baseUnitNightlyAgorot,
    origin: 'unit_base_price',
    sourceId: null,
    label: 'מחיר בסיס של היחידה',
    specificity: SPECIFICITY.unitBasePrice,
  }
}

// ── Steps 3 and 4 · the additions ─────────────────────────────────────────

function modifierApplies(
  modifier: RateModifier,
  ratePlanId: string,
  context: PricingContext,
): boolean {
  if (!modifier.isActive) return false
  if (modifier.ratePlanId !== null && modifier.ratePlanId !== ratePlanId) {
    return false
  }
  switch (modifier.scopeKind) {
    case 'unit':
      return modifier.scopeId === context.unitId
    case 'unit_group':
      return (
        context.unitGroupId !== null && modifier.scopeId === context.unitGroupId
      )
    case 'property':
      return modifier.scopeId === context.propertyId
  }
}

/** Fractional by design: the single rounding is at the end of the night. */
function adjustmentOn(base: number, modifier: RateModifier): number {
  return modifier.adjustKind === 'percent'
    ? (base * modifier.adjustValue) / BPS_PER_UNIT
    : modifier.adjustValue
}

function highestPriority(modifiers: readonly RateModifier[]): RateModifier[] {
  // Sorted rather than reduced, so that two modifiers of the same kind and
  // priority resolve by id and not by array order — the array comes from a
  // query, and a query without an ORDER BY has no order.
  return [...modifiers].sort(
    (a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1),
  )
}

function triggerMatchesWeekend(
  trigger: ModifierTrigger,
  night: string,
): boolean {
  return (
    trigger.kind === 'weekend' && trigger.weekdays.includes(dayOfWeek(night))
  )
}

function triggerMatchesHoliday(
  trigger: ModifierTrigger,
  night: string,
): boolean {
  if (trigger.kind !== 'holiday') return false
  // `isPeakNight` is Shabbat, yom tov or chol hamoed, and it is taken from
  // `src/lib/hebrew-calendar` rather than recomputed. `bein_hazmanim` is
  // deliberately NOT a peak night there: it is a demand signal covering most
  // of Nisan and Tishrei, and turning it into a nightly uplift would mark half
  // the spring as a festival.
  if (!isPeakNight(night)) return false
  if (trigger.specialDayKinds.length === 0) return true
  const kinds = specialDaysOn(night).map((day) => day.kind)
  return trigger.specialDayKinds.some((kind) => kinds.includes(kind))
}

/**
 * Occupancy for a night, as a `Measure`.
 *
 * Spec §6 rule 13: no available unit-nights means occupancy is UNKNOWN, not
 * 0%. Zero would fire the cheapest demand tier on a property that sold nothing
 * because it had nothing to sell, which is the opposite of what the tier is
 * for. Absent input is `no_source`; a present-but-unknown input keeps whatever
 * reason the caller gave.
 */
function occupancyFor(context: PricingContext, night: string): Measure {
  const table = context.occupancyByNight
  if (table === undefined) return unknown('no_source')
  const value = table[night]
  if (value === undefined) return unknown('no_source')
  return value
}

// ── The whole resolution ──────────────────────────────────────────────────

export interface ResolvedStay {
  request: StayPricingRequest
  resolution: PricingResolution
}

/**
 * Price every night of a stay, and say why each one costs what it does.
 *
 * Returns a request and a resolution, or a refusal. It never returns a
 * best-effort number: spec §7.8 and §6 rule 5 both refuse rather than price,
 * because a quote produced despite a failed check is a quote somebody will
 * honour.
 */
export function resolveStay(
  context: PricingContext,
):
  | { ok: true; resolved: ResolvedStay }
  | { ok: false; refusal: PricingRefusal } {
  const selected = selectRatePlan(context)
  if (!selected.ok) return selected

  const derived = resolveDerivation(selected.plan, context.plans)
  if (!derived.ok) return derived

  const plan = selected.plan
  const sourcePlanId = derived.source.id
  const nights = eachNight(context.range)

  const modifiers = context.modifiers.filter((modifier) =>
    modifierApplies(modifier, plan.id, context),
  )
  const weekendModifiers = highestPriority(
    modifiers.filter((modifier) => modifier.kind === 'weekend'),
  )
  const holidayModifiers = highestPriority(
    modifiers.filter((modifier) => modifier.kind === 'holiday'),
  )
  const occupancyModifiers = highestPriority(
    modifiers.filter((modifier) => modifier.kind === 'occupancy'),
  )
  const eventModifiers = highestPriority(
    modifiers.filter((modifier) => modifier.kind === 'event_type'),
  )
  const guestModifiers = highestPriority(
    modifiers.filter((modifier) => modifier.kind === 'guest_count'),
  )

  const resolvedNights: NightResolution[] = []
  const overrides: Record<string, Agorot> = {}

  // Spec §6 rule 5: the strictest of the unit, the property, the plan and
  // every rule that touched the stay. Collected while pricing rather than in a
  // second pass, so a rule that only covers one night of three still counts.
  let minimumNights = Math.max(
    context.unitMinNights,
    context.propertyMinNights,
    plan.minNights ?? 1,
  )

  for (const night of nights) {
    const base = baseForNight(
      night,
      sourcePlanId,
      context,
      context.rules,
      context.calendar,
    )

    if (base.origin === 'rate_rule') {
      const winner = context.rules.find((rule) => rule.id === base.sourceId)
      if (winner?.minNights != null) {
        minimumNights = Math.max(minimumNights, winner.minNights)
      }
    }

    const derivedBase = applyDerivation(base.amount, derived.adjustments)

    const weekend = weekendModifiers.find((modifier) =>
      triggerMatchesWeekend(modifier.trigger, night),
    )
    const holiday = holidayModifiers.find((modifier) =>
      triggerMatchesHoliday(modifier.trigger, night),
    )

    const weekendAdd =
      weekend === undefined ? 0 : adjustmentOn(derivedBase, weekend)
    const holidayAdd =
      holiday === undefined ? 0 : adjustmentOn(derivedBase, holiday)

    // 🔒 Spec §6 rule 9. The MAXIMUM, never the sum. A Saturday that is also
    // chol hamoed is one expensive night to the guest, not two stacked
    // uplifts — and Shabbat satisfies both tests, so the sum would double it
    // every single week.
    const calendarAdd = Math.max(weekendAdd, holidayAdd)

    const occupancy = occupancyFor(context, night)
    let demandAdd = 0
    if (occupancy.known) {
      const tier = occupancyModifiers.find(
        (modifier) =>
          modifier.trigger.kind === 'occupancy' &&
          occupancy.value >= modifier.trigger.fromPercent &&
          occupancy.value < modifier.trigger.toPercent,
      )
      if (tier !== undefined) demandAdd = adjustmentOn(derivedBase, tier)
    }

    const event =
      context.eventType === null
        ? undefined
        : eventModifiers.find(
            (modifier) =>
              modifier.trigger.kind === 'event_type' &&
              modifier.trigger.anyOf.includes(context.eventType!),
          )
    const eventAdd = event === undefined ? 0 : adjustmentOn(derivedBase, event)

    const guestTier = guestModifiers.find(
      (modifier) =>
        modifier.trigger.kind === 'guest_count' &&
        context.guests >= modifier.trigger.from &&
        context.guests <= modifier.trigger.to,
    )
    const guestAdd =
      guestTier === undefined ? 0 : adjustmentOn(derivedBase, guestTier)

    const raw = derivedBase + calendarAdd + demandAdd + eventAdd + guestAdd

    // Steps 6 and 7, in that order and nowhere else. The clamp is recorded
    // rather than applied silently: a rate card that keeps producing prices
    // below its own floor is telling the business something, and a silent
    // clamp is how nobody ever hears it.
    let clamped = raw
    let clampedTo: NightResolution['clampedTo'] = null
    if (plan.floorAgorot !== null && clamped < plan.floorAgorot) {
      clamped = plan.floorAgorot
      clampedTo = 'floor'
    }
    if (plan.ceilingAgorot !== null && clamped > plan.ceilingAgorot) {
      clamped = plan.ceilingAgorot
      clampedTo = 'ceiling'
    }

    const nightlyAgorot = roundAgorot(clamped)
    overrides[night] = nightlyAgorot

    resolvedNights.push({
      date: night,
      baseAgorot: base.amount,
      baseOrigin: base.origin,
      baseSourceId: base.sourceId,
      baseLabel: base.label,
      specificity: base.specificity,
      weekendAdd,
      holidayAdd,
      calendarAdd,
      demandAdd,
      eventAdd,
      guestAdd,
      rawAgorot: raw,
      clamped: clampedTo !== null,
      clampedTo,
      occupancy,
      nightlyAgorot,
    })
  }

  // Refuse, do not re-price. Spec §6 rule 5: a stay under the minimum is a
  // booking the business does not want, and quoting it anyway at some other
  // number is answering a question nobody asked.
  if (nights.length < minimumNights) {
    return {
      ok: false,
      refusal: {
        code: 'below_minimum_nights',
        required: minimumNights,
        requested: nights.length,
      },
    }
  }

  const request: StayPricingRequest = {
    range: context.range,
    // Every night has an override, so this is only ever the fallback for a
    // date `eachNight` did not produce — which is none of them. It carries the
    // unit's base price rather than zero so that a future caller who adds a
    // night to the range gets a price rather than a free stay.
    baseNightlyAgorot: context.baseUnitNightlyAgorot,
    nightlyOverrides: overrides,
    guests: context.guests,
    includedGuests: context.unitStandardGuests,
    extraGuestNightlyAgorot: context.extraGuestNightlyAgorot,
    cleaningFeeAgorot: context.cleaningFeeAgorot,
    taxRatePercent: context.taxRatePercent,
    depositAgorot: context.depositAgorot,
  }

  return {
    ok: true,
    resolved: {
      request,
      resolution: {
        ratePlan: plan,
        derivedFromPlanIds: derived.chain.slice(1),
        nights: resolvedNights,
        minimumNights,
        floorAgorot: plan.floorAgorot,
        ceilingAgorot: plan.ceilingAgorot,
      },
    },
  }
}
