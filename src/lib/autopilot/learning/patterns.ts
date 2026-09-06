/**
 * What the business keeps doing by hand, counted.
 *
 * ── An observed pattern is not a rule ─────────────────────────────────────
 *
 * Nothing in this file, and nothing anywhere in this directory, changes what
 * Autopilot does. A detector reads history that somebody else already fetched
 * and returns an `ObservedPattern`: a count, a window, a sample, and a
 * sentence saying what a rule *would* be. Whether that becomes a rule is a
 * decision a person with `autopilot.rules_manage` makes, and the database
 * refuses `adopted` without their name and the time they said so.
 *
 * That separation is the reason this module exists at all. A system that
 * quietly turns habits into standing instructions is a system whose behaviour
 * nobody can account for, and the first time it is wrong the business cannot
 * tell whether a person decided it or the software drifted into it.
 *
 * ── Heuristics are legitimate here, and only here ─────────────────────────
 *
 * `src/lib/autopilot/types.ts` draws the line: payments, availability,
 * inventory arithmetic and money are computed by the engines that own them,
 * and Autopilot never forms a second opinion about any of them. Pattern
 * noticing is the other side of that line — deciding that "the same laundry
 * provider, eleven times out of thirteen" is worth mentioning is a judgment,
 * and it is stated as one.
 *
 * What is NOT a heuristic is the counting. Every figure a detector emits is a
 * plain count over the supplied rows, and the rate a proposal quotes is
 * `occurrences / opportunities` with both numbers on the object. The judgment
 * lives in `propose.ts`, in named thresholds a manager can argue with; a
 * detector never decides that eleven is enough. Where a heuristic does appear
 * below — how occurrences are grouped, which streams are worth comparing
 * against an organization default — it is marked HEURISTIC in the comment
 * beside it.
 *
 * ── Pure, and deliberately so ─────────────────────────────────────────────
 *
 * No detector holds a database client. History arrives already fetched from
 * `repository.ts`, which is the only file here that knows PostgREST exists.
 * That is what makes every claim in this file testable against a fixture
 * instead of against a seeded database.
 */

/* ------------------------------------------------------------- subjects -- */

/**
 * What a pattern is allowed to be ABOUT.
 *
 * This closed list is the first of the two boundary mechanisms, and it is
 * structural rather than advisory: there is no member here that names a
 * characteristic of a person, so a detector cannot express "guests from
 * country X are given extra towels" no matter what the underlying rows
 * contain. `boundaries.ts` is the second mechanism and screens what the free
 * text and the parameters actually say.
 *
 * `cleaner_preference` names a member of staff by their identifier, which is a
 * work assignment and not a characteristic — "Dana cleans Villa A" is a fact
 * about a rota. The difference matters and is exactly what `boundaries.ts`
 * checks the wording for.
 */
export const PATTERN_SUBJECTS = [
  'preparation_quantity',
  'cleaner_preference',
  'staffing_level',
  'payment_exception_handling',
  'preparation_timing',
  'laundry_provider',
  'message_template',
] as const

export type PatternSubject = (typeof PATTERN_SUBJECTS)[number]

/** Which module would own the real rule, if a person created one. */
export const PATTERN_MODULES = [
  'preparation',
  'staff',
  'laundry',
  'messaging',
  'payments',
] as const

export type PatternModule = (typeof PATTERN_MODULES)[number]

/* ---------------------------------------------------------------- shape -- */

/** A row a manager can open and check for themselves. */
export interface PatternSample {
  /** The booking, task or order this happened on. */
  reference: string
  /** Hebrew, for the list. */
  label: string
  occurredOn: string
}

/**
 * The value a parameter can carry into whichever module owns the rule.
 *
 * Flat scalars only, for the same reason `AutomationFacts` is flat: a nested
 * object is a shape nobody reviewing the proposal can read at a glance, and a
 * proposal a person cannot read is one they should refuse.
 */
export type PatternParameter = string | number | boolean | null

export interface PatternSuggestion {
  module: PatternModule
  /** Hebrew: what the rule would do, in that module's words. */
  statement: string
  /** Hebrew: what it is expected to change. Never a money figure. */
  expectedImpact: string
  parameters: Readonly<Record<string, PatternParameter>>
  /**
   * The Autopilot action this would end up performing, when it maps onto one.
   *
   * Carried so `boundaries.ts` can refuse a pattern by the SAFETY LEVEL of
   * what it would cause rather than by reading its prose. `null` means the
   * rule is a default a person applies by hand — a preferred provider, a
   * standing quantity — and causes no Autopilot action at all.
   */
  actionKind: string | null
}

export interface ObservedPattern {
  /**
   * `<family>.<detail>`, matching the database's own
   * `autopilot_rule_candidates_code_shape`. Stable for the same behaviour
   * across runs, because the unique index on
   * (organization, property, pattern_code) is what stops one habit becoming
   * forty candidates.
   */
  patternCode: string
  subject: PatternSubject
  /** `null` when the behaviour is organization-wide. */
  propertyId: string | null
  /** How many times it happened. A plain count. */
  occurrences: number
  /**
   * How many times it COULD have happened.
   *
   * The denominator is on the object because "82%" without it is a number
   * nobody can check, and eleven out of thirteen and eighty-two out of a
   * hundred deserve different amounts of a manager's attention.
   */
  opportunities: number
  observedFrom: string
  observedTo: string
  sample: readonly PatternSample[]
  /** Hebrew: what was observed. */
  observation: string
  suggestion: PatternSuggestion
}

/* --------------------------------------------------------------- history -- */

/** The window the history covers. Both ends inclusive, ISO dates. */
export interface HistoryWindow {
  from: string
  to: string
}

/**
 * A quantity somebody changed on a preparation plan.
 *
 * `expectedQuantity` is what the plan said and `actualQuantity` is what went
 * out. Both are supplied; nothing here recomputes a requirement, because the
 * preparation engine owns that arithmetic and a second opinion about how many
 * towels a plan called for is exactly the kind of drift `types.ts` forbids.
 */
export interface QuantityOverrideRecord {
  bookingId: string
  propertyId: string
  itemCode: string
  itemLabel: string
  expectedQuantity: number
  actualQuantity: number
  occurredOn: string
  /** `summer`, `passover`, `weekend` — supplied, never inferred from a date. */
  context: string | null
}

/** Who actually did the clean, and who the rota said would. */
export interface CleanerAssignmentRecord {
  taskId: string
  propertyId: string
  assignedUserId: string
  assignedUserLabel: string
  /** The property's standing assignee, when one is configured. */
  defaultUserId: string | null
  occurredOn: string
}

/** A shift that went out with more people on it than were planned. */
export interface StaffingAdditionRecord {
  propertyId: string
  role: string
  roleLabel: string
  plannedStaff: number
  actualStaff: number
  occurredOn: string
  context: string | null
}

/** A payment somebody settled outside the normal path. */
export interface PaymentExceptionRecord {
  bookingId: string
  propertyId: string | null
  /** `manual_bank_transfer`, `deposit_waived_for_agency`. */
  exceptionCode: string
  exceptionLabel: string
  occurredOn: string
}

/** A preparation setting somebody moved by hand, again. */
export interface PreparationAdjustmentRecord {
  propertyId: string
  /** `lead_minutes`, `checklist_variant`. */
  field: string
  fieldLabel: string
  /** What the configuration said. */
  configuredValue: string
  /** What was used instead. */
  appliedValue: string
  occurredOn: string
  reference: string
}

/** Which laundry provider an order actually went to. */
export interface LaundryChoiceRecord {
  orderId: string
  propertyId: string | null
  providerId: string
  providerLabel: string
  /** From `laundry_settings.default_provider_id`, already narrowed. */
  defaultProviderId: string | null
  occurredOn: string
}

/** Which template was sent for a situation that has a configured default. */
export interface MessageTemplateChoiceRecord {
  messageId: string
  propertyId: string | null
  /** `pre_arrival`, `balance_due`. */
  situationCode: string
  situationLabel: string
  templateId: string
  templateLabel: string
  defaultTemplateId: string | null
  occurredOn: string
}

/**
 * Everything the detectors read, fetched once.
 *
 * A record of arrays rather than a set of callbacks: a detector that could ask
 * for more data mid-pass is a detector whose cost nobody can predict, and one
 * whose test needs a database.
 */
export interface OperationalHistory {
  window: HistoryWindow
  quantityOverrides: readonly QuantityOverrideRecord[]
  cleanerAssignments: readonly CleanerAssignmentRecord[]
  staffingAdditions: readonly StaffingAdditionRecord[]
  paymentExceptions: readonly PaymentExceptionRecord[]
  preparationAdjustments: readonly PreparationAdjustmentRecord[]
  laundryChoices: readonly LaundryChoiceRecord[]
  messageTemplateChoices: readonly MessageTemplateChoiceRecord[]
}

/** An empty history, so a caller with one stream need not restate the rest. */
export function emptyHistory(window: HistoryWindow): OperationalHistory {
  return {
    window,
    quantityOverrides: [],
    cleanerAssignments: [],
    staffingAdditions: [],
    paymentExceptions: [],
    preparationAdjustments: [],
    messageTemplateChoices: [],
    laundryChoices: [],
  }
}

/* -------------------------------------------------------------- grouping -- */

/**
 * One thing that happened, normalised.
 *
 * Every detector reduces its own record type to this before counting, so the
 * counting is written once. `scopeKey` is the denominator bucket — the set of
 * chances this choice had — and `defaultKey` is what the configuration says
 * should have happened, which is how a choice that merely agrees with the
 * standing setting is kept out of the numerator: proposing a rule that already
 * exists is how a business learns to stop reading these.
 */
interface Occurrence {
  propertyId: string | null
  scopeKey: string
  choiceKey: string
  choiceLabel: string
  defaultKey: string | null
  occurredOn: string
  reference: string
  referenceLabel: string
}

interface PatternGroup {
  propertyId: string | null
  scopeKey: string
  choiceKey: string
  choiceLabel: string
  occurrences: number
  opportunities: number
  observedFrom: string
  observedTo: string
  sample: readonly PatternSample[]
}

/** How many rows of evidence a proposal carries. More is not more checkable. */
export const SAMPLE_SIZE = 5

function bucket(propertyId: string | null, scopeKey: string): string {
  return `${propertyId ?? '-'} ${scopeKey}`
}

/**
 * Count occurrences into groups.
 *
 * HEURISTIC — the grouping itself. Deciding that "+5 pool towels in summer"
 * and "+5 pool towels in winter" are two behaviours rather than one is a
 * judgment about how the business thinks, and a different business would
 * disagree. It is a heuristic about SHAPE only: every number this function
 * produces is a count of rows it was handed.
 */
function groupOccurrences(
  occurrences: readonly Occurrence[],
): readonly PatternGroup[] {
  const opportunities = new Map<string, number>()
  for (const one of occurrences) {
    const key = bucket(one.propertyId, one.scopeKey)
    opportunities.set(key, (opportunities.get(key) ?? 0) + 1)
  }

  const groups = new Map<string, Occurrence[]>()
  for (const one of occurrences) {
    // A choice that agrees with the configured default is a chance, not a
    // behaviour worth proposing. It stays in the denominator above.
    if (one.defaultKey !== null && one.choiceKey === one.defaultKey) continue
    const key = `${bucket(one.propertyId, one.scopeKey)} ${one.choiceKey}`
    const existing = groups.get(key)
    if (existing) existing.push(one)
    else groups.set(key, [one])
  }

  const built: PatternGroup[] = []
  for (const rows of groups.values()) {
    const sorted = [...rows].sort(compareOccurrence)
    const first = sorted[0]
    const dates = sorted.map((row) => row.occurredOn).sort()

    built.push({
      propertyId: first.propertyId,
      scopeKey: first.scopeKey,
      choiceKey: first.choiceKey,
      choiceLabel: first.choiceLabel,
      occurrences: sorted.length,
      opportunities:
        opportunities.get(bucket(first.propertyId, first.scopeKey)) ??
        sorted.length,
      observedFrom: dates[0],
      observedTo: dates[dates.length - 1],
      // Newest first: a manager checking a claim opens the most recent case.
      sample: [...sorted]
        .reverse()
        .slice(0, SAMPLE_SIZE)
        .map((row) => ({
          reference: row.reference,
          label: row.referenceLabel,
          occurredOn: row.occurredOn,
        })),
    })
  }

  // Deterministic order, so two runs over the same history produce the same
  // list and a test can assert on an index without being flaky.
  return built.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      a.choiceKey.localeCompare(b.choiceKey) ||
      a.scopeKey.localeCompare(b.scopeKey),
  )
}

function compareOccurrence(a: Occurrence, b: Occurrence): number {
  return (
    a.occurredOn.localeCompare(b.occurredOn) ||
    a.reference.localeCompare(b.reference)
  )
}

/* ------------------------------------------------------------------ code -- */

/**
 * A pattern code segment the database will accept.
 *
 * `autopilot_rule_candidates_code_shape` requires each half to start with a
 * letter and hold only lowercase letters, digits and underscores. Item codes
 * and provider identifiers come from customer data and honour none of that, so
 * they are folded here rather than at the insert, where the failure would be a
 * constraint violation nobody can read.
 */
export function toCodeSegment(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '')

  // An identifier that folds to nothing becomes `unknown` rather than an
  // empty segment the database would refuse — and rather than `x_`, which
  // would appear on a screen as a code nobody could look up.
  if (folded.length === 0) return 'unknown'
  return /^[a-z]/.test(folded) ? folded : `x_${folded}`.slice(0, 42)
}

const CODE_SHAPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

/** The same test the database applies, so a draft can be refused before it. */
export function isPatternCode(value: string): boolean {
  return CODE_SHAPE.test(value)
}

/** The exact rate a proposal quotes. Arithmetic, never rounded here. */
export function occurrenceRate(pattern: {
  occurrences: number
  opportunities: number
}): number {
  return pattern.opportunities === 0
    ? 0
    : pattern.occurrences / pattern.opportunities
}

/** `82%` — rounded once, at the point a person reads it. */
export function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

/* ------------------------------------------------------------- detectors -- */

/**
 * Recurring quantity overrides.
 *
 * The classic case: "+5 pool towels added to 82% of summer bookings". The
 * choice key is the DELTA rather than the final quantity, because a business
 * that adds five to every plan is stating a policy about the extra, not about
 * the total — the total changes with the party size and the delta does not.
 */
export function detectQuantityOverrides(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const occurrences: Occurrence[] = history.quantityOverrides.map((row) => {
    const delta = row.actualQuantity - row.expectedQuantity
    return {
      propertyId: row.propertyId,
      scopeKey: `${row.itemCode}:${row.context ?? 'all'}`,
      // A zero delta is a choice that agreed with the plan; naming the default
      // `0` keeps it in the denominator and out of every numerator.
      choiceKey: String(delta),
      choiceLabel: `${delta > 0 ? '+' : ''}${delta} ${row.itemLabel}`,
      defaultKey: '0',
      occurredOn: row.occurredOn,
      reference: row.bookingId,
      referenceLabel: `הזמנה ${row.bookingId}`,
    }
  })

  return groupOccurrences(occurrences).map((group) => {
    const row = history.quantityOverrides.find(
      (entry) =>
        entry.propertyId === group.propertyId &&
        `${entry.itemCode}:${entry.context ?? 'all'}` === group.scopeKey,
    )
    const itemLabel = row?.itemLabel ?? group.scopeKey
    const context = row?.context ?? null
    const delta = Number(group.choiceKey)
    const rate = formatRate(occurrenceRate(group))
    const when = context === null ? '' : ` בתקופת ${context}`

    return {
      patternCode: `quantity_override.${toCodeSegment(
        `${row?.itemCode ?? group.scopeKey}_${group.choiceKey}`,
      )}`,
      subject: 'preparation_quantity' as const,
      propertyId: group.propertyId,
      occurrences: group.occurrences,
      opportunities: group.opportunities,
      observedFrom: group.observedFrom,
      observedTo: group.observedTo,
      sample: group.sample,
      observation:
        `נוספו ${delta} ${itemLabel} מעבר לתוכנית ההכנה ` +
        `ב-${group.occurrences} מתוך ${group.opportunities} הזמנות` +
        `${when} (${rate}).`,
      suggestion: {
        module: 'preparation' as const,
        statement:
          `להוסיף ${delta} ${itemLabel} כברירת מחדל לתוכנית ההכנה` + `${when}.`,
        expectedImpact:
          `חוסך תיקון ידני של תוכנית ההכנה בכ-${group.occurrences} ` +
          'מקרים בתקופה דומה, ומקטין את הסיכוי שהפריט יישכח.',
        parameters: {
          itemCode: row?.itemCode ?? null,
          deltaQuantity: delta,
          context,
        },
        actionKind: 'preparation.generate',
      },
    }
  })
}

/**
 * Recurring cleaner additions or reassignments.
 *
 * The scope is the property, so the denominator is every clean that property
 * had — which is what makes "eleven of thirteen" readable as a preference
 * rather than as a busy month.
 */
export function detectCleanerPreferences(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const occurrences: Occurrence[] = history.cleanerAssignments.map((row) => ({
    propertyId: row.propertyId,
    scopeKey: 'cleaning',
    choiceKey: row.assignedUserId,
    choiceLabel: row.assignedUserLabel,
    defaultKey: row.defaultUserId,
    occurredOn: row.occurredOn,
    reference: row.taskId,
    referenceLabel: `משימה ${row.taskId}`,
  }))

  return groupOccurrences(occurrences).map((group) => ({
    patternCode: `cleaner_choice.${toCodeSegment(group.choiceKey)}`,
    subject: 'cleaner_preference' as const,
    propertyId: group.propertyId,
    occurrences: group.occurrences,
    opportunities: group.opportunities,
    observedFrom: group.observedFrom,
    observedTo: group.observedTo,
    sample: group.sample,
    observation:
      `${group.choiceLabel} שובץ לניקיון הנכס ב-${group.occurrences} ` +
      `מתוך ${group.opportunities} משימות ` +
      `(${formatRate(occurrenceRate(group))}), שלא דרך שיבוץ ברירת המחדל.`,
    suggestion: {
      module: 'staff' as const,
      statement: `להגדיר את ${group.choiceLabel} כמשובץ ברירת המחדל לניקיון הנכס.`,
      expectedImpact:
        'מקצר את השיבוץ היומי ומקטין את מספר המשימות שנשארות ללא אחראי ' +
        'עד הבוקר.',
      parameters: { assigneeUserId: group.choiceKey, taskKind: 'cleaning' },
      actionKind: 'task.assign',
    },
  }))
}

/**
 * Recurring extra staffing.
 *
 * The choice key is the number of people ADDED, for the same reason the
 * quantity detector uses a delta: a business that always sends one more than
 * planned is stating something about the margin, not about the crew size.
 */
export function detectStaffingAdditions(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const occurrences: Occurrence[] = history.staffingAdditions.map((row) => ({
    propertyId: row.propertyId,
    scopeKey: `${row.role}:${row.context ?? 'all'}`,
    choiceKey: String(row.actualStaff - row.plannedStaff),
    choiceLabel: row.roleLabel,
    defaultKey: '0',
    occurredOn: row.occurredOn,
    reference: `${row.propertyId}:${row.occurredOn}:${row.role}`,
    referenceLabel: `משמרת ${row.occurredOn}`,
  }))

  return groupOccurrences(occurrences).map((group) => {
    const extra = Number(group.choiceKey)
    const row = history.staffingAdditions.find(
      (entry) =>
        entry.propertyId === group.propertyId &&
        `${entry.role}:${entry.context ?? 'all'}` === group.scopeKey,
    )

    return {
      patternCode: `staffing_addition.${toCodeSegment(
        `${row?.role ?? group.scopeKey}_${group.choiceKey}`,
      )}`,
      subject: 'staffing_level' as const,
      propertyId: group.propertyId,
      occurrences: group.occurrences,
      opportunities: group.opportunities,
      observedFrom: group.observedFrom,
      observedTo: group.observedTo,
      sample: group.sample,
      observation:
        `נוספו ${extra} אנשי ${group.choiceLabel} מעבר למתוכנן ` +
        `ב-${group.occurrences} מתוך ${group.opportunities} משמרות ` +
        `(${formatRate(occurrenceRate(group))}).`,
      suggestion: {
        module: 'staff' as const,
        statement:
          `לתכנן ${extra} אנשי ${group.choiceLabel} נוספים כברירת מחדל ` +
          'למשמרות מסוג זה.',
        expectedImpact:
          'מקטין את מספר ההשלמות של הרגע האחרון ומייצב את זמן ההכנה.',
        parameters: {
          role: row?.role ?? null,
          extraStaff: extra,
          context: row?.context ?? null,
        },
        actionKind: 'task.create',
      },
    }
  })
}

/**
 * Recurring payment exceptions.
 *
 * The proposal this produces is deliberately weak — it suggests recording the
 * exception as a known handling, never granting anybody a new financial
 * permission. `boundaries.ts` refuses the stronger version, and it refuses it
 * by the safety level of the action rather than by trusting this comment.
 */
export function detectPaymentExceptions(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const occurrences: Occurrence[] = history.paymentExceptions.map((row) => ({
    propertyId: row.propertyId,
    scopeKey: 'payment',
    choiceKey: row.exceptionCode,
    choiceLabel: row.exceptionLabel,
    defaultKey: null,
    occurredOn: row.occurredOn,
    reference: row.bookingId,
    referenceLabel: `הזמנה ${row.bookingId}`,
  }))

  return groupOccurrences(occurrences).map((group) => ({
    patternCode: `payment_exception.${toCodeSegment(group.choiceKey)}`,
    subject: 'payment_exception_handling' as const,
    propertyId: group.propertyId,
    occurrences: group.occurrences,
    opportunities: group.opportunities,
    observedFrom: group.observedFrom,
    observedTo: group.observedTo,
    sample: group.sample,
    observation:
      `הטיפול «${group.choiceLabel}» חזר ב-${group.occurrences} ` +
      `מתוך ${group.opportunities} מקרי תשלום חריגים ` +
      `(${formatRate(occurrenceRate(group))}).`,
    suggestion: {
      module: 'payments' as const,
      statement:
        `לתעד את «${group.choiceLabel}» כדרך טיפול מוכרת, כך שהמסך יציג ` +
        'אותה כאפשרות במקום שתירשם כחריגה בכל פעם מחדש.',
      expectedImpact:
        'מקצר את הטיפול בתשלום חריג ומפחית את מספר החריגות הפתוחות במסך. ' +
        'אינו משנה הרשאה כספית ואינו מבצע תשלום.',
      parameters: { exceptionCode: group.choiceKey, recordOnly: true },
      // Recording a handling changes nothing outside Autopilot; it is not a
      // payment action and must never be mapped onto one.
      actionKind: null,
    },
  }))
}

/**
 * Recurring preparation adjustments.
 *
 * Timing and checklist variants that the configuration says one thing about
 * and the day says another.
 */
export function detectPreparationAdjustments(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const occurrences: Occurrence[] = history.preparationAdjustments.map(
    (row) => ({
      propertyId: row.propertyId,
      scopeKey: row.field,
      choiceKey: row.appliedValue,
      choiceLabel: `${row.fieldLabel}: ${row.appliedValue}`,
      defaultKey: row.configuredValue,
      occurredOn: row.occurredOn,
      reference: row.reference,
      referenceLabel: `${row.fieldLabel} · ${row.occurredOn}`,
    }),
  )

  return groupOccurrences(occurrences).map((group) => {
    const row = history.preparationAdjustments.find(
      (entry) =>
        entry.propertyId === group.propertyId && entry.field === group.scopeKey,
    )

    return {
      patternCode: `preparation_adjustment.${toCodeSegment(
        `${group.scopeKey}_${group.choiceKey}`,
      )}`,
      subject: 'preparation_timing' as const,
      propertyId: group.propertyId,
      occurrences: group.occurrences,
      opportunities: group.opportunities,
      observedFrom: group.observedFrom,
      observedTo: group.observedTo,
      sample: group.sample,
      observation:
        `«${row?.fieldLabel ?? group.scopeKey}» שונה ל-${group.choiceKey} ` +
        `ב-${group.occurrences} מתוך ${group.opportunities} הכנות ` +
        `(${formatRate(occurrenceRate(group))}), במקום ההגדרה הקיימת.`,
      suggestion: {
        module: 'preparation' as const,
        statement:
          `לעדכן את «${row?.fieldLabel ?? group.scopeKey}» ל-${group.choiceKey} ` +
          'בהגדרות ההכנה של הנכס.',
        expectedImpact:
          'מבטל תיקון ידני חוזר ומקרב את התוכנית לזמן ההכנה האמיתי.',
        parameters: { field: group.scopeKey, value: group.choiceKey },
        actionKind: 'preparation.generate',
      },
    }
  })
}

/** Recurring laundry provider choices. */
export function detectLaundryProviderChoices(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const occurrences: Occurrence[] = history.laundryChoices.map((row) => ({
    propertyId: row.propertyId,
    scopeKey: 'laundry',
    choiceKey: row.providerId,
    choiceLabel: row.providerLabel,
    defaultKey: row.defaultProviderId,
    occurredOn: row.occurredOn,
    reference: row.orderId,
    referenceLabel: `הזמנת כביסה ${row.orderId}`,
  }))

  return groupOccurrences(occurrences).map((group) => ({
    patternCode: `laundry_provider.${toCodeSegment(group.choiceKey)}`,
    subject: 'laundry_provider' as const,
    propertyId: group.propertyId,
    occurrences: group.occurrences,
    opportunities: group.opportunities,
    observedFrom: group.observedFrom,
    observedTo: group.observedTo,
    sample: group.sample,
    observation:
      `ההזמנות נשלחו ל${group.choiceLabel} ב-${group.occurrences} ` +
      `מתוך ${group.opportunities} פעמים ` +
      `(${formatRate(occurrenceRate(group))}), ולא לספק ברירת המחדל.`,
    suggestion: {
      module: 'laundry' as const,
      statement: `להגדיר את ${group.choiceLabel} כספק ברירת המחדל.`,
      expectedImpact:
        'מקצר את פתיחת ההזמנה ומונע שליחה בטעות לספק שאינו משרת את הנכס.',
      parameters: { providerId: group.choiceKey },
      actionKind: 'laundry.draft_order',
    },
  }))
}

/** Recurring guest-message template choices. */
export function detectMessageTemplateChoices(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const occurrences: Occurrence[] = history.messageTemplateChoices.map(
    (row) => ({
      propertyId: row.propertyId,
      scopeKey: row.situationCode,
      choiceKey: row.templateId,
      choiceLabel: row.templateLabel,
      defaultKey: row.defaultTemplateId,
      occurredOn: row.occurredOn,
      reference: row.messageId,
      referenceLabel: `הודעה ${row.messageId}`,
    }),
  )

  return groupOccurrences(occurrences).map((group) => {
    const row = history.messageTemplateChoices.find(
      (entry) => entry.situationCode === group.scopeKey,
    )

    return {
      patternCode: `message_template.${toCodeSegment(
        `${group.scopeKey}_${group.choiceKey}`,
      )}`,
      subject: 'message_template' as const,
      propertyId: group.propertyId,
      occurrences: group.occurrences,
      opportunities: group.opportunities,
      observedFrom: group.observedFrom,
      observedTo: group.observedTo,
      sample: group.sample,
      observation:
        `בסיטואציית «${row?.situationLabel ?? group.scopeKey}» נבחרה התבנית ` +
        `«${group.choiceLabel}» ב-${group.occurrences} מתוך ` +
        `${group.opportunities} הודעות (${formatRate(occurrenceRate(group))}).`,
      suggestion: {
        module: 'messaging' as const,
        statement:
          `להגדיר את «${group.choiceLabel}» כתבנית ברירת המחדל ` +
          `ל«${row?.situationLabel ?? group.scopeKey}».`,
        expectedImpact: 'מקצר את שליחת ההודעה ומייצב את הנוסח שהאורחים מקבלים.',
        parameters: {
          situationCode: group.scopeKey,
          templateId: group.choiceKey,
        },
        // The template becomes a default a person still sends. Suggesting it
        // does not send anything, and the action kind names what a person
        // would eventually be doing so the safety screen can see it.
        actionKind: 'guest.send_reminder',
      },
    }
  })
}

/**
 * Property-specific behaviour that differs from the organization default.
 *
 * HEURISTIC — which streams this compares. Laundry providers, message
 * templates and preparation quantities have a meaningful organization-wide
 * default, so a property diverging from it is worth saying out loud. Cleaner
 * assignments do not: every property has a different rota by design, and
 * "Villa A uses a different cleaner from the organization" would be noise on
 * every property, every week.
 *
 * The comparison itself is arithmetic: this property's rate for a choice
 * against the same rate computed over every other property, with the margin
 * stated on the object rather than hidden in a threshold.
 */
export const DEVIATION_MARGIN = 0.3

export function detectPropertyDeviations(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  const comparable = [
    ...detectLaundryProviderChoices(history),
    ...detectMessageTemplateChoices(history),
    ...detectQuantityOverrides(history),
  ]

  // The organization-wide rate for the same behaviour, over every property
  // that is not this one.
  const byCode = new Map<string, ObservedPattern[]>()
  for (const pattern of comparable) {
    const existing = byCode.get(pattern.patternCode)
    if (existing) existing.push(pattern)
    else byCode.set(pattern.patternCode, [pattern])
  }

  const deviations: ObservedPattern[] = []
  for (const patterns of byCode.values()) {
    if (patterns.length < 2) continue

    for (const pattern of patterns) {
      if (pattern.propertyId === null) continue

      const others = patterns.filter((one) => one !== pattern)
      const otherOccurrences = others.reduce((sum, o) => sum + o.occurrences, 0)
      const otherOpportunities = others.reduce(
        (sum, o) => sum + o.opportunities,
        0,
      )
      const here = occurrenceRate(pattern)
      const elsewhere = occurrenceRate({
        occurrences: otherOccurrences,
        opportunities: otherOpportunities,
      })
      if (here - elsewhere < DEVIATION_MARGIN) continue

      deviations.push({
        ...pattern,
        patternCode: `property_deviation.${toCodeSegment(
          pattern.patternCode.replace('.', '_'),
        )}`,
        observation:
          `${pattern.observation} בשאר הנכסים אותה התנהגות מופיעה ב-` +
          `${formatRate(elsewhere)} מהמקרים, כאן ב-${formatRate(here)}.`,
        suggestion: {
          ...pattern.suggestion,
          statement:
            `${pattern.suggestion.statement} החלה על הנכס הזה בלבד, ולא על ` +
            'כלל הארגון.',
          parameters: { ...pattern.suggestion.parameters, propertyOnly: true },
        },
      })
    }
  }

  return deviations
}

/* ------------------------------------------------------------------- all -- */

/** Every detector, named, so a caller cannot silently omit one. */
export const DETECTORS: readonly {
  code: string
  subject: PatternSubject | 'property_deviation'
  run: (history: OperationalHistory) => readonly ObservedPattern[]
}[] = [
  {
    code: 'quantity_override',
    subject: 'preparation_quantity',
    run: detectQuantityOverrides,
  },
  {
    code: 'cleaner_choice',
    subject: 'cleaner_preference',
    run: detectCleanerPreferences,
  },
  {
    code: 'staffing_addition',
    subject: 'staffing_level',
    run: detectStaffingAdditions,
  },
  {
    code: 'payment_exception',
    subject: 'payment_exception_handling',
    run: detectPaymentExceptions,
  },
  {
    code: 'preparation_adjustment',
    subject: 'preparation_timing',
    run: detectPreparationAdjustments,
  },
  {
    code: 'laundry_provider',
    subject: 'laundry_provider',
    run: detectLaundryProviderChoices,
  },
  {
    code: 'message_template',
    subject: 'message_template',
    run: detectMessageTemplateChoices,
  },
  {
    code: 'property_deviation',
    subject: 'property_deviation',
    run: detectPropertyDeviations,
  },
]

/** Run every detector over one history. Order is the order of `DETECTORS`. */
export function detectPatterns(
  history: OperationalHistory,
): readonly ObservedPattern[] {
  return DETECTORS.flatMap((detector) => detector.run(history))
}
