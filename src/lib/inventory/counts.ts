/**
 * EXECUTION CONTEXT — SERVER ONLY. The physical stock count, as a session.
 *
 * ══ What was missing, and why a task was not enough ═══════════════════════
 *
 * `commands.ts` opens a `tasks` row when somebody asks for a count, and it
 * says plainly why: there was no count session to open. A task is an errand —
 * "go to the linen cupboard on Thursday" — and it is the right shape for the
 * *ask*. It is the wrong shape for the *act*. A stocktake has a middle: a
 * sheet of items handed to a person, a set of numbers coming back one at a
 * time over an hour, a comparison against what the ledger believed, and a
 * conversation about each difference. A task has two states and no room for
 * any of that.
 *
 * So this file adds the session and keeps the task: `taskId` on the session
 * points back at the errand that caused it, and `requestCount` needs no
 * change to benefit.
 *
 * ══ Blind counting, and why it is structural rather than a hidden field ═══
 *
 * A stocktake that shows the counter the expected quantity gets that quantity
 * back. People write down the number they were shown and stop looking; it is
 * the single best documented failure of physical inventory, and `commands.ts`
 * already argued it for the task description. Here it has to be built rather
 * than argued, because a component that "does not render" a field is one
 * careless edit away from rendering it.
 *
 * Three things carry it, and none of them is a component:
 *
 *   1. **The type.** `CountSheetLine` has no expected quantity, and declares
 *      `expected?: never` so a caller cannot widen it into one. A blind sheet
 *      is not an open sheet with a field omitted — it is a different type,
 *      and `buildCountSheet` is discriminated on `blind` at the top level so
 *      the open branch is the only one that even accepts an expectation map.
 *   2. **The table.** `inventory_count_lines` — what the counter reads and
 *      writes — has no expected column at all. There is nowhere in it to put
 *      the number. The snapshot lives in `inventory_count_expectations`, a
 *      separate table that the counting screens never read.
 *   3. **The port.** `snapshotExpected` returns a count of items, never the
 *      figures. The operation that starts a blind count therefore *cannot*
 *      return the expected quantities, because nothing hands them to it.
 *
 * An operator with direct database access can of course read the snapshot
 * table. That is not what blindness defends against: it defends against the
 * product showing the answer to the person holding the clipboard.
 *
 * ══ The expected figure is consumed, never recomputed ═════════════════════
 *
 * `expectedFromLedger` takes a `ForecastItem` — the record the existing
 * repository already produces from `inventory_items`, whose `quantity` 0011
 * derives from `inventory_movements` by trigger. It re-projects that record;
 * it does not add up movements, and there is no second answer to "how many
 * towels does this villa have" anywhere in this file.
 *
 * ══ Reusable and consumable do not share accounting ═══════════════════════
 *
 * This is the difference that makes a linen stocktake different from a soap
 * stocktake, and it comes out of the ledger's own states rather than a new
 * column.
 *
 *   A consumable lives entirely in `available`. Everything owned is on the
 *   shelf, so `expected on shelf = owned` and every unit missing is missing.
 *
 *   A reusable item circulates. `dirty`, `laundry`, `returning` and `in_use`
 *   are units the business owns and the counter will not find, because they
 *   are in a machine or on a bed. `expected on shelf` is the allocatable part
 *   only — `ForecastItem.onHandClean`, the same figure the forecast walks —
 *   and `circulating` is carried beside it as the first explanation any
 *   reconciler should consider.
 *
 * Counting a reusable item against everything owned reports a loss on every
 * single stocktake, and that is how a business learns to ignore the screen.
 * `loss.ts` enforces the other half: `in_laundry` is not offered at all for
 * an item with nothing in circulation, and never beyond the number the ledger
 * says is circulating.
 *
 * ══ An uncounted line is not a variance of zero ═══════════════════════════
 *
 * The counter got through forty of sixty items. The remaining twenty were not
 * counted, and treating them as "counted zero" would report the whole
 * cupboard as lost. `reconcile` reports them as `uncounted`, they produce no
 * variance row, and they contribute nothing to exposure. There is a test.
 */

import { assertCan } from '../authz/can'
import type { InventoryState } from '../contracts/states'
import { ALLOCATABLE_INVENTORY_STATES } from '../contracts/states'
import { BusinessRuleError } from '../errors'
import {
  defineOperation,
  s,
  type LoadArgs,
  type LoadedResource,
  type Operation,
} from '../service'

import {
  LOSS_CLASSES,
  classificationsFor,
  isUnexplained,
  lossEffect,
} from './loss'
import type { LossClass } from './loss'
import { capabilitiesFor } from './settings'
import type {
  ForecastItem,
  InventoryCapabilities,
  InventorySettings,
} from './types'

/* ----------------------------------------------------------- vocabulary -- */

/**
 * The life of one stocktake.
 *
 * `open` is a session that exists and has a sheet; `counting` is a session
 * whose expectations have been snapshotted and whose sheet is in somebody's
 * hands; `reconciling` is the comparison; `closed` is done. `cancelled` is
 * kept apart from `closed` because a stocktake abandoned half way is a fact
 * about an operation, and a report that merged the two could not show it.
 */
export const COUNT_SESSION_STATUSES = [
  'open',
  'counting',
  'reconciling',
  'closed',
  'cancelled',
] as const

export type CountSessionStatus = (typeof COUNT_SESSION_STATUSES)[number]

export const COUNT_SESSION_STATUS_LABEL: Readonly<
  Record<CountSessionStatus, string>
> = {
  open: 'נפתחה',
  counting: 'בספירה',
  reconciling: 'בהתאמה',
  closed: 'נסגרה',
  cancelled: 'בוטלה',
}

export const COUNT_SESSION_STATUS_HELP: Readonly<
  Record<CountSessionStatus, string>
> = {
  open: 'הספירה הוגדרה ועדיין לא התחילה. אפשר להוסיף או להסיר פריטים.',
  counting:
    'הכמויות שהמערכת מכירה צולמו, והגיליון בידי הסופר. בספירה עיוורת ' +
    'הגיליון אינו כולל את הכמות הצפויה.',
  reconciling: 'הספירה הסתיימה וההפרשים מוצגים מול הצילום.',
  closed: 'ההפרשים סווגו והספירה נסגרה.',
  cancelled: 'הספירה הופסקה באמצע. לא נרשמה שום תנועת מלאי.',
}

/**
 * Where a session may go from where it is.
 *
 * Declared as data rather than as a switch, so a screen can grey out a button
 * using the same table the operation refuses by.
 */
export const COUNT_SESSION_TRANSITIONS: Readonly<
  Record<CountSessionStatus, readonly CountSessionStatus[]>
> = {
  open: ['counting', 'cancelled'],
  counting: ['reconciling', 'cancelled'],
  reconciling: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
}

export function canAdvance(
  from: CountSessionStatus,
  to: CountSessionStatus,
): boolean {
  return COUNT_SESSION_TRANSITIONS[from].includes(to)
}

export function assertTransition(
  from: CountSessionStatus,
  to: CountSessionStatus,
): void {
  if (canAdvance(from, to)) return

  throw new BusinessRuleError({
    code: 'inventory.count_transition_invalid',
    message: `count session cannot move from '${from}' to '${to}'`,
    userMessage:
      `לא ניתן להעביר ספירה ממצב ״${COUNT_SESSION_STATUS_LABEL[from]}״ ` +
      `למצב ״${COUNT_SESSION_STATUS_LABEL[to]}״. רענן את המסך — ייתכן ` +
      'שמישהו אחר כבר קידם את הספירה הזו.',
  })
}

/* ---------------------------------------------------------------- shapes -- */

export interface CountSession {
  id: string
  organizationId: string
  propertyId: string
  /** What the business called it: ״ספירת סוף ספטמבר״. */
  label: string | null
  status: CountSessionStatus
  /** True by default, and the default worth defending. See the header. */
  blind: boolean
  /** The day it is meant to happen, ISO `YYYY-MM-DD`. */
  scheduledFor: string | null
  /** The `tasks` row `commands.requestCount` opened, when there was one. */
  taskId: string | null
  countingStartedAt: string | null
  reconcilingStartedAt: string | null
  closedAt: string | null
  note: string | null
}

/** The session as stored, with the column optimistic locking reads. */
export interface CountSessionRecord extends CountSession {
  version: number
}

/**
 * One item on the sheet, as the counter's own record.
 *
 * Note what is not here and cannot be added: an expected quantity. This is
 * the shape of `inventory_count_lines`, and that table has no such column.
 */
export interface CountLine {
  id: string
  sessionId: string
  itemId: string
  label: string
  unitOfMeasure: string
  location: string | null
  /** Null until somebody counts. Not zero — see the header. */
  countedQuantity: number | null
  countedAt: string | null
  note: string | null
}

/**
 * What the ledger believed, frozen at the moment counting started.
 *
 * Taken then rather than at reconciliation on purpose: the honest comparison
 * is against what the system believed when the person began walking the
 * shelves, and a movement recorded during the hour they were counting would
 * otherwise turn into a variance nobody created.
 */
export interface ExpectedStock {
  itemId: string
  /**
   * Units the ledger says are on the shelf — the allocatable states, which is
   * `ForecastItem.onHandClean` unchanged. This is what a counter can find.
   */
  onShelf: number
  /** Everything owned of this item, every state. */
  owned: number
  /** Owned and legitimately not on the shelf, per state. */
  elsewhere: Readonly<Partial<Record<InventoryState, number>>>
  /**
   * Owned, not on the shelf, and expected back: dirty, in the wash, on its
   * way, or on a bed. The first explanation for a reusable item's shortfall.
   */
  circulating: number
  /**
   * What one unit costs to replace, in integer agorot.
   *
   * Read from `inventory_items.unit_cost_agorot`, which is what the business
   * recorded paying. Null when nobody recorded one, and null is carried
   * rather than zeroed: zero would read as "these cost nothing".
   */
  replacementCostAgorot: number | null
  /** ISO timestamp of the snapshot. */
  capturedAt: string
}

/**
 * Turn one ledger record into one expectation.
 *
 * The whole of the "never recompute stock" rule lives in this function's
 * signature: it takes a `ForecastItem`, which the existing repository built
 * from `inventory_items`, and re-projects it. Nothing here sums a movement.
 */
export function expectedFromLedger(args: {
  item: ForecastItem
  replacementCostAgorot: number | null
  capturedAt: string
}): ExpectedStock {
  const { item } = args

  const allocatable = new Set<string>(ALLOCATABLE_INVENTORY_STATES)
  const elsewhere: Partial<Record<InventoryState, number>> = {}
  let owned = 0
  let circulating = 0

  for (const [state, quantity] of Object.entries(item.byState)) {
    const units = quantity ?? 0
    owned += units
    if (allocatable.has(state)) continue

    const named = state as InventoryState
    elsewhere[named] = units
    if (CIRCULATING_STATES.includes(named)) circulating += units
  }

  return {
    itemId: item.itemId,
    onShelf: item.onHandClean,
    owned,
    elsewhere,
    circulating,
    replacementCostAgorot: args.replacementCostAgorot,
    capturedAt: args.capturedAt,
  }
}

/**
 * States that mean "owned, off the shelf, and coming back".
 *
 * `damaged`, `out_of_service` and `lost` are deliberately absent: those units
 * are not returning, and offering `in_laundry` against them would let a
 * reconciler explain a shortfall with stock that is already written off.
 */
export const CIRCULATING_STATES: readonly InventoryState[] = [
  'reserved',
  'in_use',
  'dirty',
  'laundry',
  'returning',
]

/* ----------------------------------------------------------- the sheet --- */

/**
 * One line of a blind sheet.
 *
 * `expected?: never` is the load-bearing declaration. It is not decoration:
 * it makes `{ ...line, expected: 40 }` a type error rather than a widening,
 * so a screen cannot quietly assemble an open sheet out of blind lines.
 */
export interface CountSheetLine {
  itemId: string
  label: string
  unitOfMeasure: string
  location: string | null
  /** What the counter has written so far. Null means "not counted yet". */
  counted: number | null
  note: string | null
  expected?: never
}

/** A line of a sheet the business chose to run open-book. */
export interface OpenCountSheetLine extends Omit<CountSheetLine, 'expected'> {
  /** Present only here. A blind sheet has no such field to omit. */
  expected: number
}

export type CountSheet =
  | {
      blind: true
      sessionId: string
      propertyId: string
      status: CountSessionStatus
      lines: readonly CountSheetLine[]
    }
  | {
      blind: false
      sessionId: string
      propertyId: string
      status: CountSessionStatus
      lines: readonly OpenCountSheetLine[]
    }

/**
 * The sheet handed to whoever is counting.
 *
 * Discriminated at the top level rather than on `session.blind`, because
 * TypeScript narrows a union by its own discriminant and not by a nested
 * one — and the point of this shape is that the blind branch has no
 * `expected` parameter to pass at all. An open sheet must supply the map; a
 * blind sheet cannot.
 */
export type CountSheetInput =
  | {
      blind: true
      session: CountSession
      lines: readonly CountLine[]
    }
  | {
      blind: false
      session: CountSession
      lines: readonly CountLine[]
      expected: ReadonlyMap<string, ExpectedStock>
    }

export function buildCountSheet(input: CountSheetInput): CountSheet {
  // The caller's claim and the session's own flag have to agree. They can
  // disagree only through a bug, and the bug that matters is the one that
  // builds an open sheet for a session the business asked to run blind.
  if (input.blind !== input.session.blind) {
    throw new BusinessRuleError({
      code: 'inventory.count_blindness_mismatch',
      message: 'sheet blindness does not match the session',
      userMessage:
        'הגיליון שנבנה אינו תואם להגדרת הספירה. רענן את המסך ונסה שוב.',
    })
  }

  const base = {
    sessionId: input.session.id,
    propertyId: input.session.propertyId,
    status: input.session.status,
  }

  if (input.blind) {
    return {
      ...base,
      blind: true,
      lines: input.lines.map((line) => ({
        itemId: line.itemId,
        label: line.label,
        unitOfMeasure: line.unitOfMeasure,
        location: line.location,
        counted: line.countedQuantity,
        note: line.note,
      })),
    }
  }

  const expected = input.expected
  return {
    ...base,
    blind: false,
    lines: input.lines.map((line) => ({
      itemId: line.itemId,
      label: line.label,
      unitOfMeasure: line.unitOfMeasure,
      location: line.location,
      counted: line.countedQuantity,
      note: line.note,
      // An open sheet for an item with no snapshot shows zero rather than
      // refusing: the session is already running and the person is already at
      // the shelf. The reconciliation is where a missing snapshot is caught.
      expected: expected.get(line.itemId)?.onShelf ?? 0,
    })),
  }
}

/* --------------------------------------------------------- reconciliation -- */

export type ReconciledState = 'matched' | 'variance' | 'uncounted'

export interface ReconciledLine {
  itemId: string
  label: string
  expected: number
  /** Null when nobody counted this one. Never coerced to zero. */
  counted: number | null
  /** Null for an uncounted line, for the same reason. */
  variance: number | null
  state: ReconciledState
}

/**
 * One difference worth a conversation.
 *
 * `variance = expected − counted`, so a positive number is missing stock and
 * a negative one is surplus. That is the opposite sign from
 * `inventory_discrepancies.difference`, which is `collected − expected`, and
 * the difference is deliberate: a checkout asks "how many came back" and a
 * stocktake asks "how many are missing". Both conventions are stated in the
 * field comment of the column that carries them, in both places.
 */
export interface CountVariance {
  itemId: string
  label: string
  expected: number
  counted: number
  variance: number
  /** From the snapshot, so the reconciler sees why expected is 18 and not 60. */
  elsewhere: Readonly<Partial<Record<InventoryState, number>>>
  circulating: number
  replacementCostAgorot: number | null
}

export interface Reconciliation {
  sessionId: string
  /** Every item on the sheet, whatever happened to it. */
  lines: readonly ReconciledLine[]
  /** The non-zero differences. Only these become stored rows. */
  variances: readonly CountVariance[]
  matched: number
  /** Items nobody counted. Not a loss, not a variance, not exposure. */
  uncounted: readonly string[]
  /** On the sheet with no snapshot behind it. A wiring fault, reported. */
  unsnapshotted: readonly string[]
}

/**
 * Expected against counted, one item at a time.
 *
 * A line with no snapshot is not reconciled at all rather than compared
 * against an assumed zero, and it is named in `unsnapshotted` so the screen
 * can say which items were skipped instead of silently shortening the list.
 */
export function reconcile(args: {
  sessionId: string
  lines: readonly CountLine[]
  expected: ReadonlyMap<string, ExpectedStock>
}): Reconciliation {
  const reconciled: ReconciledLine[] = []
  const variances: CountVariance[] = []
  const uncounted: string[] = []
  const unsnapshotted: string[] = []
  let matched = 0

  for (const line of args.lines) {
    const snapshot = args.expected.get(line.itemId)
    if (snapshot === undefined) {
      unsnapshotted.push(line.itemId)
      continue
    }

    if (line.countedQuantity === null) {
      uncounted.push(line.itemId)
      reconciled.push({
        itemId: line.itemId,
        label: line.label,
        expected: snapshot.onShelf,
        counted: null,
        variance: null,
        state: 'uncounted',
      })
      continue
    }

    const variance = snapshot.onShelf - line.countedQuantity

    reconciled.push({
      itemId: line.itemId,
      label: line.label,
      expected: snapshot.onShelf,
      counted: line.countedQuantity,
      variance,
      state: variance === 0 ? 'matched' : 'variance',
    })

    if (variance === 0) {
      matched += 1
      continue
    }

    variances.push({
      itemId: line.itemId,
      label: line.label,
      expected: snapshot.onShelf,
      counted: line.countedQuantity,
      variance,
      elsewhere: snapshot.elsewhere,
      circulating: snapshot.circulating,
      replacementCostAgorot: snapshot.replacementCostAgorot,
    })
  }

  return {
    sessionId: args.sessionId,
    lines: reconciled,
    variances,
    matched,
    uncounted,
    unsnapshotted,
  }
}

/** The arithmetic, said out loud, the way a shortage alert says its own. */
export function explainVariance(variance: CountVariance): string {
  const missing = Math.abs(variance.variance)
  const head =
    `${variance.label}: המערכת ציפתה ל-${variance.expected} על המדף, ` +
    `נספרו ${variance.counted}.`

  const tail =
    variance.variance > 0
      ? ` חסרים ${missing}.`
      : ` נמצאו ${missing} מעבר לצפוי.`

  const circulation =
    variance.circulating > 0
      ? ` ${variance.circulating} יחידות רשומות כמחוץ למדף (כביסה, שימוש, ` +
        'בדרך חזרה) ואינן אמורות להימצא בספירה.'
      : ''

  return head + tail + circulation
}

/* ---------------------------------------------------------------- ports -- */

/** A variance as stored, enough of it for a classification to be decided. */
export interface CountVarianceRecord {
  id: string
  sessionId: string
  organizationId: string
  propertyId: string
  itemId: string
  label: string
  expected: number
  counted: number
  variance: number
  circulating: number
  replacementCostAgorot: number | null
  classification: LossClass | null
}

export interface NewCountSession {
  organizationId: string
  propertyId: string
  label: string | null
  blind: boolean
  scheduledFor: string | null
  taskId: string | null
  note: string | null
  /** The items the sheet covers. Empty means "everything at this property". */
  itemIds: readonly string[]
}

/**
 * What a count needs from the world.
 *
 * `loadSettings` carries the same signature as the one on `InventoryPorts` in
 * `operations.ts` and on `InventoryCommandPorts` in `commands.ts`, on purpose:
 * one repository satisfies all three rather than growing a third, subtly
 * different, settings read.
 */
export interface CountPorts {
  loadSettings(organizationId: string): Promise<{
    settings: InventorySettings
    provisioned: boolean
  }>
  loadSession(args: {
    organizationId: string
    sessionId: string
  }): Promise<CountSessionRecord | null>
  /**
   * A session already running at this property, if there is one.
   *
   * Two open stocktakes of one cupboard produce two answers for it, which is
   * the defect this whole module exists not to introduce. The database
   * refuses it with a partial unique index; this is the readable refusal.
   */
  liveSessionFor(args: {
    organizationId: string
    propertyId: string
  }): Promise<{ id: string; status: CountSessionStatus } | null>
  createSession(draft: NewCountSession): Promise<{ id: string; lines: number }>
  advanceSession(args: {
    organizationId: string
    sessionId: string
    to: CountSessionStatus
    at: string
    reason: string | null
  }): Promise<void>
  /**
   * Freeze what the ledger believes, and hand back only how many items were
   * frozen.
   *
   * The return type is the third pillar of blind counting: an operation that
   * starts a count cannot leak the expected quantities, because nothing in
   * this interface gives them to it. `loadExpected` is the only reader, and
   * it is called from reconciliation alone.
   */
  snapshotExpected(args: {
    organizationId: string
    sessionId: string
  }): Promise<{ items: number }>
  loadExpected(args: {
    organizationId: string
    sessionId: string
  }): Promise<readonly ExpectedStock[]>
  loadLines(args: {
    organizationId: string
    sessionId: string
  }): Promise<readonly CountLine[]>
  saveCount(args: {
    organizationId: string
    sessionId: string
    itemId: string
    countedQuantity: number
    countedAt: string
    note: string | null
  }): Promise<void>
  saveVariances(args: {
    organizationId: string
    sessionId: string
    variances: readonly CountVariance[]
  }): Promise<{ written: number }>
  loadVariance(args: {
    organizationId: string
    varianceId: string
  }): Promise<CountVarianceRecord | null>
  saveClassification(args: {
    organizationId: string
    varianceId: string
    classification: LossClass
    note: string | null
    movementId: string | null
    classifiedAt: string
  }): Promise<void>
  /** The ledger. The same port shape `operations.ts` already writes through. */
  recordMovement(args: {
    organizationId: string
    movement: {
      itemId: string
      propertyId: string
      kind: 'receipt' | 'issue' | 'adjustment' | 'loss' | 'count'
      quantityDelta: number
      toState: string | null
      reason: string
    }
  }): Promise<{ id: string }>
  /** `inventory_items.last_counted_at`. Stamped when a session closes. */
  stampLastCounted(args: {
    organizationId: string
    sessionId: string
    at: string
  }): Promise<{ items: number }>
  /** How many variances are still unexplained. Read at close. */
  unexplainedCount(args: {
    organizationId: string
    sessionId: string
  }): Promise<number>
}

/* -------------------------------------------------------------- refusals -- */

/**
 * Counting is off for this organization.
 *
 * A configuration answer and not a cupboard one, the same distinction
 * `assertCapability` in `commands.ts` makes. `counting` is true from `basic`
 * upward, so this refuses only an organization whose stock module is `off`.
 */
function assertCounting(capabilities: InventoryCapabilities): void {
  if (capabilities.counting) return

  throw new BusinessRuleError({
    code: 'inventory_counting_disabled',
    message: "inventory capability 'counting' is off for this organization",
    userMessage:
      'ניהול המלאי אינו פעיל בארגון הזה, ולכן אין מה לספור. אפשר להפעיל ' +
      'אותו בהגדרות המלאי.',
  })
}

/**
 * The grant `inventory_movements_insert` demands, asserted before the write.
 *
 * 0011 gates an insert into the ledger on `inventory.edit`, while the count
 * operations declare `inventory.adjust` — the grant 0012 keeps for moving a
 * quantity. An actor holding only `inventory.adjust` would therefore pass
 * every application check and be refused by row level security with a
 * SQLSTATE at the end of the write. A refusal is fine; a refusal nobody can
 * read is a defect. This is the same double-grant argument `commands.ts`
 * makes for `task.create` and `approval.request`.
 */
function assertMayWriteLedger(
  actor: Parameters<typeof assertCan>[0],
  scope: { organizationId: string; propertyId: string },
): void {
  assertCan(actor, 'inventory.edit', {
    organizationId: scope.organizationId,
    propertyId: scope.propertyId,
    family: 'operations',
  })
}

/* --------------------------------------------------------------- schemas -- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const OPEN_SESSION_INPUT = s.object({
  propertyId: s.uuid({ label: 'נכס' }),
  label: s.nullable(s.string({ label: 'שם הספירה', max: 120 })),
  /**
   * Blind by default at every layer that can carry a default: here, in the
   * column, and in the form. A caller has to say `false` out loud.
   */
  blind: s.boolean({ label: 'ספירה עיוורת' }),
  scheduledFor: s.nullable(
    s.string({
      label: 'מועד הספירה',
      pattern: ISO_DATE,
      patternMessage: 'תאריך אינו בתבנית YYYY-MM-DD.',
    }),
  ),
  taskId: s.nullable(s.uuid({ label: 'משימה מקושרת' })),
  note: s.nullable(s.string({ label: 'הערה', max: 1000 })),
  itemIds: s.arrayOf(s.uuid({ label: 'פריט' }), {
    label: 'פריטים',
    max: 2000,
  }),
})

const SESSION_INPUT = s.object({
  sessionId: s.uuid({ label: 'ספירה' }),
})

const RECORD_COUNT_INPUT = s.object({
  sessionId: s.uuid({ label: 'ספירה' }),
  itemId: s.uuid({ label: 'פריט' }),
  /**
   * The whole input of a blind count, and there is nothing else in it.
   *
   * No expected quantity, no variance, no confirmation that the number
   * "looks right". The comparison happens afterwards, against a snapshot the
   * counter never received.
   */
  countedQuantity: s.number({ label: 'כמות שנספרה', integer: true, min: 0 }),
  note: s.nullable(s.string({ label: 'הערה', max: 500 })),
})

const CLASSIFY_INPUT = s.object({
  varianceId: s.uuid({ label: 'הפרש' }),
  // The vocabulary itself, not a copy of it. A second list would drift, and
  // the drift would be a classification the screen offers and the write path
  // refuses.
  classification: s.enumOf(LOSS_CLASSES, { label: 'סיווג' }),
  note: s.nullable(s.string({ label: 'נימוק', max: 1000 })),
})

const CANCEL_INPUT = s.object({
  sessionId: s.uuid({ label: 'ספירה' }),
})

/* ----------------------------------------------------------- operations -- */

export interface OpenCountSessionInput {
  propertyId: string
  label: string | null
  blind: boolean
  scheduledFor: string | null
  taskId: string | null
  note: string | null
  itemIds: readonly string[]
}

export interface RecordCountInput {
  sessionId: string
  itemId: string
  countedQuantity: number
  note: string | null
}

export interface ClassifyVarianceInput {
  varianceId: string
  classification: LossClass
  note: string | null
}

export interface CountOperations {
  openSession: Operation<
    OpenCountSessionInput,
    null,
    { sessionId: string; lines: number; blind: boolean }
  >
  startCounting: Operation<
    { sessionId: string },
    CountSessionRecord,
    { itemsSnapshotted: number }
  >
  recordCount: Operation<RecordCountInput, CountSessionRecord, { saved: true }>
  reconcileSession: Operation<
    { sessionId: string },
    CountSessionRecord,
    {
      variances: number
      matched: number
      uncounted: number
      unsnapshotted: number
    }
  >
  classifyVariance: Operation<
    ClassifyVarianceInput,
    CountVarianceRecord,
    { movementId: string | null }
  >
  closeSession: Operation<
    { sessionId: string },
    CountSessionRecord,
    { unexplained: number; itemsStamped: number }
  >
  cancelSession: Operation<{ sessionId: string }, CountSessionRecord, null>
}

export function defineCountOperations(ports: CountPorts): CountOperations {
  /**
   * The session, as the pipeline's resource.
   *
   * Loaded through `loadResource` rather than inside `rule` so the second
   * `assertCan` — the one that settles tenant and property scope — actually
   * runs. A member scoped to one villa touching another villa's stocktake is
   * refused by the pipeline before any of these operations has an opinion.
   */
  const loadSession = async (
    args: LoadArgs<{ sessionId: string }>,
  ): Promise<LoadedResource<CountSessionRecord> | null> => {
    const session = await ports.loadSession({
      organizationId: args.context.actor.organizationId,
      sessionId: args.input.sessionId,
    })
    if (session === null) return null

    return {
      resource: {
        organizationId: session.organizationId,
        propertyId: session.propertyId,
        family: 'operations',
      },
      entity: session,
      version: session.version,
    }
  }

  const requireCounting = async (organizationId: string): Promise<void> => {
    const { settings } = await ports.loadSettings(organizationId)
    assertCounting(capabilitiesFor(settings))
  }

  return {
    /**
     * Open a stocktake. Nothing is counted and no quantity moves.
     *
     * `itemIds` empty means "every item at this property", resolved by the
     * repository rather than here: which rows exist is a storage question,
     * and answering it in the domain would mean a second list of what the
     * cupboard contains.
     */
    openSession: defineOperation<
      OpenCountSessionInput,
      null,
      { sessionId: string; lines: number; blind: boolean }
    >({
      name: 'inventory.count.session.open',
      permission: 'inventory.adjust',
      resourceType: 'inventory_count_session',
      input: OPEN_SESSION_INPUT,

      async rule({ input, context }) {
        await requireCounting(context.actor.organizationId)

        assertCan(context.actor, 'inventory.adjust', {
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
          family: 'operations',
        })

        const live = await ports.liveSessionFor({
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
        })
        if (live !== null) {
          throw new BusinessRuleError({
            code: 'inventory.count_session_already_open',
            message: `session ${live.id} is already ${live.status}`,
            userMessage:
              'כבר יש ספירה פעילה בנכס הזה. שתי ספירות במקביל מייצרות שתי ' +
              'תשובות לאותו מחסן — סיים או בטל את הקיימת קודם.',
          })
        }
      },

      async execute({ input, context }) {
        const created = await ports.createSession({
          organizationId: context.actor.organizationId,
          propertyId: input.propertyId,
          label: input.label,
          blind: input.blind,
          scheduledFor: input.scheduledFor,
          taskId: input.taskId,
          note: input.note,
          itemIds: input.itemIds,
        })

        return {
          sessionId: created.id,
          lines: created.lines,
          blind: input.blind,
        }
      },

      audit({ input, result, context }) {
        return {
          resourceId: result.sessionId,
          propertyId: input.propertyId,
          summary:
            `${context.auditActor.label} פתח ספירת מלאי` +
            (input.label === null ? '' : ` ״${input.label}״`) +
            ` על ${result.lines} פריטים. ` +
            (result.blind
              ? 'הספירה עיוורת — הסופר לא יראה את הכמות הצפויה.'
              : 'הספירה גלויה — הכמות הצפויה תוצג לסופר.') +
            ' לא בוצע שינוי בכמות.',
          after: {
            sessionId: result.sessionId,
            propertyId: input.propertyId,
            blind: result.blind,
            lines: result.lines,
            taskId: input.taskId,
          },
        }
      },
    }),

    /**
     * Hand the sheet over, and freeze what the ledger believes.
     *
     * The snapshot is taken here and not at reconciliation, because the
     * honest comparison is against what the system believed when the person
     * started walking the shelves. A movement recorded during the hour they
     * were counting would otherwise become a variance nobody created.
     *
     * The result says how many items were frozen and never which quantities.
     * See the file header.
     */
    startCounting: defineOperation<
      { sessionId: string },
      CountSessionRecord,
      { itemsSnapshotted: number }
    >({
      name: 'inventory.count.session.start',
      permission: 'inventory.adjust',
      resourceType: 'inventory_count_session',
      requiresVersion: false,
      input: SESSION_INPUT,
      loadResource: loadSession,

      async rule({ entity, context }) {
        await requireCounting(context.actor.organizationId)
        assertTransition(entity.status, 'counting')
      },

      async execute({ entity, now }) {
        const at = now.toISOString()
        const snapshot = await ports.snapshotExpected({
          organizationId: entity.organizationId,
          sessionId: entity.id,
        })

        await ports.advanceSession({
          organizationId: entity.organizationId,
          sessionId: entity.id,
          to: 'counting',
          at,
          reason: null,
        })

        return { itemsSnapshotted: snapshot.items }
      },

      audit({ entity, result, context }) {
        return {
          resourceId: entity.id,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} התחיל את הספירה. ` +
            `הכמויות שהמערכת מכירה צולמו עבור ${result.itemsSnapshotted} ` +
            'פריטים. ' +
            (entity.blind
              ? 'הצילום אינו נגלה לסופר.'
              : 'הצילום מוצג לסופר לפי בחירת הארגון.'),
          after: {
            sessionId: entity.id,
            status: 'counting',
            itemsSnapshotted: result.itemsSnapshotted,
          },
        }
      },
    }),

    /**
     * One number, off one shelf.
     *
     * The input carries the counted quantity and nothing else. There is no
     * expected figure to echo back and no "confirm this looks right" step,
     * which is what makes the count independent evidence rather than a
     * signature on the ledger's own opinion.
     */
    recordCount: defineOperation<
      RecordCountInput,
      CountSessionRecord,
      { saved: true }
    >({
      name: 'inventory.count.record',
      permission: 'inventory.adjust',
      resourceType: 'inventory_count_line',
      requiresVersion: false,
      input: RECORD_COUNT_INPUT,
      loadResource: loadSession,

      async rule({ entity }) {
        if (entity.status === 'counting') return

        throw new BusinessRuleError({
          code: 'inventory.count_not_counting',
          message: `cannot record a count while the session is '${entity.status}'`,
          userMessage:
            `לא ניתן לרשום ספירה כשהמצב הוא ` +
            `״${COUNT_SESSION_STATUS_LABEL[entity.status]}״. ` +
            'רק ספירה שהתחילה מקבלת מספרים.',
        })
      },

      async execute({ input, entity, now }) {
        await ports.saveCount({
          organizationId: entity.organizationId,
          sessionId: entity.id,
          itemId: input.itemId,
          countedQuantity: input.countedQuantity,
          countedAt: now.toISOString(),
          note: input.note,
        })
        return { saved: true }
      },

      audit({ input, entity, context }) {
        return {
          resourceId: entity.id,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} רשם ספירה של ` +
            `${input.countedQuantity} יחידות. לא בוצע שינוי בכמות — ` +
            'ההשוואה נעשית בשלב ההתאמה.',
          after: {
            sessionId: entity.id,
            itemId: input.itemId,
            countedQuantity: input.countedQuantity,
          },
        }
      },
    }),

    /**
     * Compare, and write down every difference.
     *
     * This is the first moment the expected figures are read, and the only
     * operation that reads them at all. `reconcile` is where the arithmetic
     * lives; this carries it to storage and says what happened.
     */
    reconcileSession: defineOperation<
      { sessionId: string },
      CountSessionRecord,
      {
        variances: number
        matched: number
        uncounted: number
        unsnapshotted: number
      }
    >({
      name: 'inventory.count.session.reconcile',
      permission: 'inventory.adjust',
      resourceType: 'inventory_count_session',
      requiresVersion: false,
      input: SESSION_INPUT,
      loadResource: loadSession,

      async rule({ entity, context }) {
        await requireCounting(context.actor.organizationId)
        assertTransition(entity.status, 'reconciling')
      },

      async execute({ entity, now }) {
        const [lines, expected] = await Promise.all([
          ports.loadLines({
            organizationId: entity.organizationId,
            sessionId: entity.id,
          }),
          ports.loadExpected({
            organizationId: entity.organizationId,
            sessionId: entity.id,
          }),
        ])

        const result = reconcile({
          sessionId: entity.id,
          lines,
          expected: new Map(expected.map((one) => [one.itemId, one])),
        })

        await ports.saveVariances({
          organizationId: entity.organizationId,
          sessionId: entity.id,
          variances: result.variances,
        })

        await ports.advanceSession({
          organizationId: entity.organizationId,
          sessionId: entity.id,
          to: 'reconciling',
          at: now.toISOString(),
          reason: null,
        })

        return {
          variances: result.variances.length,
          matched: result.matched,
          uncounted: result.uncounted.length,
          unsnapshotted: result.unsnapshotted.length,
        }
      },

      audit({ entity, result, context }) {
        return {
          resourceId: entity.id,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} ביצע התאמה לספירה: ` +
            `${result.matched} פריטים תאמו, ${result.variances} בהפרש, ` +
            `${result.uncounted} לא נספרו כלל. ` +
            'פריט שלא נספר אינו הפרש ואינו חוסר.',
          after: { sessionId: entity.id, status: 'reconciling', ...result },
        }
      },

      events({ entity, result }) {
        if (result.variances === 0) return []

        // The closest name the frozen contract carries. A stocktake variance
        // is not a checkout discrepancy — see the report — but it is the
        // event subscribers already listen to for "the count did not match".
        // No money in the payload: an exposure figure without its method is
        // exactly what `loss.ts` refuses to produce.
        return [
          {
            name: 'inventory.discrepancy_detected' as const,
            propertyId: entity.propertyId,
            payload: {
              source: 'stock_count',
              sessionId: entity.id,
              variances: result.variances,
              matched: result.matched,
              uncounted: result.uncounted,
            },
          },
        ]
      },
    }),

    /**
     * Say what one difference means, and write the movement it implies.
     *
     * `lossEffect` decides what the ledger gets and this performs it, exactly
     * the way `resolveDiscrepancy` uses `resolutionEffect` — so the screen can
     * say what the button will do before it is pressed, using the same
     * function the write path obeys.
     *
     * `unknown` writes nothing. An unexplained variance stays unexplained and
     * stays visible; writing it off would be deciding it.
     */
    classifyVariance: defineOperation<
      ClassifyVarianceInput,
      CountVarianceRecord,
      { movementId: string | null }
    >({
      name: 'inventory.count.variance.classify',
      permission: 'inventory.adjust',
      resourceType: 'inventory_count_variance',
      requiresVersion: false,
      input: CLASSIFY_INPUT,

      async loadResource(args) {
        const variance = await ports.loadVariance({
          organizationId: args.context.actor.organizationId,
          varianceId: args.input.varianceId,
        })
        if (variance === null) return null

        return {
          resource: {
            organizationId: variance.organizationId,
            propertyId: variance.propertyId,
            family: 'operations',
          },
          entity: variance,
        }
      },

      async rule({ input, entity, context }) {
        await requireCounting(context.actor.organizationId)

        // Throws when the classification does not fit this variance: a
        // surplus explained as damage, laundry claimed for an item the ledger
        // shows no circulation for, or a write-off with no stated reason.
        const effect = lossEffect({
          label: entity.label,
          variance: entity.variance,
          circulating: entity.circulating,
          classification: input.classification,
          note: input.note,
        })

        // Asserted only when a movement is actually coming. A classification
        // that writes nothing must not demand a grant it will never use.
        if (effect.movementKind !== null) {
          assertMayWriteLedger(context.actor, {
            organizationId: entity.organizationId,
            propertyId: entity.propertyId,
          })
        }
      },

      async execute({ input, entity, now }) {
        const effect = lossEffect({
          label: entity.label,
          variance: entity.variance,
          circulating: entity.circulating,
          classification: input.classification,
          note: input.note,
        })

        let movementId: string | null = null
        if (effect.movementKind !== null && effect.quantityDelta !== 0) {
          const movement = await ports.recordMovement({
            organizationId: entity.organizationId,
            movement: {
              itemId: entity.itemId,
              propertyId: entity.propertyId,
              kind: effect.movementKind,
              quantityDelta: effect.quantityDelta,
              toState: effect.toState,
              reason: effect.reason,
            },
          })
          movementId = movement.id
        }

        await ports.saveClassification({
          organizationId: entity.organizationId,
          varianceId: entity.id,
          classification: input.classification,
          note: input.note,
          movementId,
          classifiedAt: now.toISOString(),
        })

        return { movementId }
      },

      audit({ input, entity, result, context }) {
        return {
          resourceId: entity.id,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} סיווג הפרש של ` +
            `${Math.abs(entity.variance)} ב״${entity.label}״ כ` +
            `״${input.classification}״` +
            (result.movementId === null
              ? '. לא נרשמה תנועת מלאי.'
              : '. נרשמה תנועת מלאי מתקנת.'),
          after: {
            varianceId: entity.id,
            classification: input.classification,
            movementId: result.movementId,
            note: input.note,
          },
        }
      },
    }),

    /**
     * Close the stocktake.
     *
     * Unexplained variances do not block the close — a business is allowed to
     * finish a count with three towels it cannot account for — but they do
     * demand a stated reason, because "we closed the count with eleven
     * unexplained units" is a decision somebody made and it should carry a
     * sentence. `requiresReason` is static and this rule is conditional, so
     * the demand is made here rather than declared.
     *
     * Closing also stamps `inventory_items.last_counted_at`, which is the
     * column 0011 provided for exactly this and which nothing had been
     * writing.
     */
    closeSession: defineOperation<
      { sessionId: string },
      CountSessionRecord,
      { unexplained: number; itemsStamped: number }
    >({
      name: 'inventory.count.session.close',
      permission: 'inventory.adjust',
      resourceType: 'inventory_count_session',
      requiresVersion: false,
      input: SESSION_INPUT,
      loadResource: loadSession,

      async rule({ entity, context }) {
        await requireCounting(context.actor.organizationId)
        assertTransition(entity.status, 'closed')

        const unexplained = await ports.unexplainedCount({
          organizationId: entity.organizationId,
          sessionId: entity.id,
        })

        if (unexplained > 0 && (context.reason ?? '').trim().length === 0) {
          throw new BusinessRuleError({
            code: 'inventory.count_unexplained_needs_reason',
            message: `${unexplained} variances are still unexplained`,
            userMessage:
              `נותרו ${unexplained} הפרשים ללא הסבר. אפשר לסגור את הספירה ` +
              'כך, אבל צריך לכתוב מה הוחלט — הפרש בלי הסבר נשאר בלי הסבר, ' +
              'ומי שיקרא את הדוח בעוד חודשיים צריך לדעת מה נבדק.',
          })
        }
      },

      async execute({ entity, now }) {
        const at = now.toISOString()

        const unexplained = await ports.unexplainedCount({
          organizationId: entity.organizationId,
          sessionId: entity.id,
        })

        await ports.advanceSession({
          organizationId: entity.organizationId,
          sessionId: entity.id,
          to: 'closed',
          at,
          reason: null,
        })

        const stamped = await ports.stampLastCounted({
          organizationId: entity.organizationId,
          sessionId: entity.id,
          at,
        })

        return { unexplained, itemsStamped: stamped.items }
      },

      audit({ entity, result, context }) {
        return {
          resourceId: entity.id,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} סגר את הספירה. ` +
            (result.unexplained === 0
              ? 'כל ההפרשים סווגו.'
              : `${result.unexplained} הפרשים נותרו ללא הסבר.`) +
            ` מועד הספירה עודכן על ${result.itemsStamped} פריטים.`,
          after: { sessionId: entity.id, status: 'closed', ...result },
        }
      },
    }),

    /**
     * Abandon a stocktake half way.
     *
     * A real outcome and not an error: somebody is called away, the cupboard
     * is locked, the sheet is lost. Kept apart from `closed` so a report can
     * show how often counts do not finish, and it writes no movement at all —
     * a partial count is not evidence of anything.
     */
    cancelSession: defineOperation<
      { sessionId: string },
      CountSessionRecord,
      null
    >({
      name: 'inventory.count.session.cancel',
      permission: 'inventory.adjust',
      resourceType: 'inventory_count_session',
      requiresVersion: false,
      requiresReason: true,
      input: CANCEL_INPUT,
      loadResource: loadSession,

      async rule({ entity }) {
        assertTransition(entity.status, 'cancelled')
      },

      async execute({ entity, context, now }) {
        await ports.advanceSession({
          organizationId: entity.organizationId,
          sessionId: entity.id,
          to: 'cancelled',
          at: now.toISOString(),
          reason: context.reason ?? '',
        })
        return null
      },

      audit({ entity, context }) {
        return {
          resourceId: entity.id,
          propertyId: entity.propertyId,
          summary:
            `${context.auditActor.label} ביטל את הספירה. ` +
            'לא נרשמה שום תנועת מלאי, והמספרים שנספרו נשמרים כרשומה בלבד.',
          after: { sessionId: entity.id, status: 'cancelled' },
        }
      },
    }),
  }
}

/**
 * The classifications this variance may legitimately be given.
 *
 * Re-exported from `loss.ts` through the counting module so a screen that
 * already holds a variance does not have to reach into two modules to render
 * one dropdown.
 */
export function classificationsForVariance(
  variance: Pick<CountVariance, 'variance' | 'circulating'>,
): readonly LossClass[] {
  return classificationsFor(variance)
}

/** True when this variance still has no explanation. */
export function varianceIsUnexplained(
  variance: Pick<CountVarianceRecord, 'classification'>,
): boolean {
  return isUnexplained(variance.classification)
}
