/**
 * The five tables `0029_laundry.sql` creates, read and written for real.
 *
 * `npm run reality` reported this module PARTIAL with "no persistence
 * adapter", and the sentence was exact: the migration is applied, the demo
 * dataset has rows for all five tables, the domain is complete and tested —
 * and nothing implemented it against Postgres. Every laundry screen therefore
 * worked in the demo and would have found nothing in production, which is the
 * definition of a fake production path.
 *
 * A port and one implementation, beside the domain rather than in
 * `src/lib/persistence/**`, for the same reason `src/lib/payments/repository.ts`
 * is: that directory belongs to another owner, and the adapter for a module's
 * own tables lives next to the module that reads them.
 *
 * ── Every read is filtered by `organization_id`, and RLS is not the plan ──
 *
 * All five tables have row level security ENABLED and FORCED, `anon` holds
 * nothing, and 19 policies decide who sees what. That is the floor. Every
 * query below still names `organization_id` itself, for the reason
 * `src/lib/persistence/finance.ts` states at length: the policy is the
 * enforcement, and the filter is what stops a mistake in this file from
 * becoming a cross-tenant read the first time somebody runs it as
 * `service_role` — which carries BYPASSRLS and is exactly the caller policies
 * cannot stop. `repository.test.ts` asserts the filter on every read, because
 * a tenant-isolation claim is worth making without a database.
 *
 * ── Four things the schema does that a caller must not fight ──────────────
 *
 * **1. `laundry_order_lines.final_quantity` is `GENERATED ALWAYS`.** Postgres
 * refuses an explicit write of it, and that refusal is what makes an adjusted
 * quantity unfakeable — no writer anywhere can store a third number that
 * disagrees with `calculated + adjustment`. It is never sent from here. The
 * domain's `OrderLineQuantity.final` is re-derived from the same two inputs in
 * `lineFromRow` rather than read back, so a row that somehow disagreed would
 * show the arithmetic instead of the disagreement.
 *
 * **2. `laundry_orders_requirement_key` is the module's idempotency.** Unique
 * on `(organization_id, requirement_key)`, and the key is derived from the
 * provider, the required-by day and the sorted content of the lines — see
 * `orderRequirementKey` in `orders.ts`. A retried creation must therefore
 * return the order that already exists, not a second one and not a constraint
 * name shown to a person. `createOrder` reads the existing row back and
 * reports `created: false`; the caller decides whether that is worth saying
 * out loud. The pipeline's idempotency store protects a double-clicked form;
 * this is the half that survives the store being pruned.
 *
 * **3. Two triggers guard the lines, and neither is worked around.**
 * `laundry_order_lines_agree` refuses a line whose organization differs from
 * its order's, or whose property differs from an order that names one.
 * `laundry_order_lines_frozen` refuses a rewrite of `calculated_quantity`, or
 * a line repointed at another item or property. Both raise `23514`, and both
 * are translated here into a typed `BusinessRuleError` carrying a Hebrew
 * sentence a screen can render — because a refusal that reaches a person as
 * `tg_laundry_order_lines_frozen` has told them nothing.
 *
 * **4. An order is cancelled, never deleted.** `DELETE` and `TRUNCATE` on
 * `laundry_orders` are revoked from `service_role` as well as from
 * `authenticated`, deliberately: a run that went to a provider and was called
 * off is a thing that happened, and a business that cannot show the record of
 * a cancelled order cannot argue with the invoice for it. There is no
 * `deleteOrder` on this port and there must not be one — cancelling is
 * `advanceOrder` with a status of `cancelled`, which is the same act every
 * other status change is and leaves the same record behind.
 *
 * ── Money and quantities are integers ─────────────────────────────────────
 *
 * Nothing here recomputes a total from a rate. An order's total is the sum of
 * its lines, and the lines carry the engine's own figure plus a signed
 * adjustment. `laundry_providers.price_list` is not even selected: `LaundryProvider`
 * has no field for it, and an order priced from a rate that changed last month
 * would be a second set of numbers for the same debt — what is owed to a
 * supplier is an expense, in 0016's territory.
 *
 * ── What this file deliberately does not do ───────────────────────────────
 *
 * It does not construct a Supabase client — the caller hands one in, so the
 * session and the key choice stay with `src/lib/supabase/server.ts` and a unit
 * test can hand over a fake. It does not authorize anything: the grants are
 * checked in `operations.ts`, where the pipeline runs them before the
 * transaction opens. And it holds no business rule — `applyAdjustment`,
 * `assessOne` and `consolidate` decide, and this file stores what they decided.
 */

import { BusinessRuleError } from '../errors'
import {
  PG_ERROR,
  asBoolean,
  asEnum,
  asEnumOrNull,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  clientFor,
  recordWrite,
  toRow,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import {
  LAUNDRY_CHANNELS,
  LAUNDRY_DISPATCH_MODES,
  LAUNDRY_MODES,
  LAUNDRY_STATUSES,
} from '../contracts/states'
import { REQUIREMENT_UNITS } from '../preparation/types'
import type { TransactionHandle } from '../service'

import type { MessageViewInput } from './message'
import type { LaundryOperationPorts } from './operations'
import { resolveSettings, type ResolvedSettings } from './settings'
import { LAUNDRY_ROUTES } from './types'
import type {
  ExplanationStep,
  LaundryChannel,
  LaundryItemProfile,
  LaundryMode,
  LaundryOrder,
  LaundryOrderLine,
  LaundryProvider,
  LaundrySettings,
  LaundryStatus,
} from './types'

/* --------------------------------------------------------------- refusals -- */

/**
 * `laundry_order_lines_agree` refused the line.
 *
 * Either the line's organization is not its order's — which is the tenant
 * boundary, enforced by a trigger precisely because it has to survive
 * BYPASSRLS — or the order names one property and the line names another,
 * which is the consolidation invariant: a consolidated order carries
 * `property_id` NULL and the breakdown lives on the lines.
 *
 * A `BusinessRuleError` rather than a rethrow, because the person who sees it
 * is looking at a screen and `23514` is not a sentence.
 */
export class LaundryLineDoesNotBelongError extends BusinessRuleError {
  constructor(cause: unknown) {
    super({
      code: 'laundry.line_does_not_belong',
      message: 'laundry_order_lines_agree refused a line',
      userMessage:
        'השורה הזאת שייכת לנכס אחר או לעסק אחר מזה של ההזמנה, ולכן לא ניתן ' +
        'לשמור אותה. הזמנה שמאחדת כמה נכסים אינה נושאת נכס יחיד — הפירוט לפי ' +
        'נכס נמצא בשורות. רענן את המסך ונסה שוב.',
      cause,
    })
  }
}

/**
 * `laundry_order_lines_frozen` refused the change.
 *
 * The engine's own figure is evidence and is never rewritten. What a person
 * changed is an `adjustment_quantity` with a stated reason beside it, and that
 * stays permitted even on a committed order — the van arriving and finding
 * four fewer sheets than the note said is exactly when somebody must be able
 * to write down what really went.
 */
export class LaundryLineFrozenError extends BusinessRuleError {
  constructor(cause: unknown) {
    super({
      code: 'laundry.line_frozen',
      message: 'laundry_order_lines_frozen refused an edit',
      userMessage:
        'לא ניתן לשנות את הכמות שהמערכת חישבה, ולא להעביר שורה לפריט או לנכס ' +
        'אחר. אם הכמות בפועל שונה — רשום את ההפרש כשינוי כמות עם נימוק, ' +
        'והחישוב המקורי יישמר לצד השינוי.',
      cause,
    })
  }
}

/** The shape PostgREST hands back, narrowed enough to read a code off it. */
interface RefusalLike {
  code?: unknown
  message?: unknown
  details?: unknown
  hint?: unknown
}

function textOf(error: unknown): { code: string; haystack: string } {
  if (typeof error !== 'object' || error === null) {
    return { code: '', haystack: '' }
  }
  const record = error as RefusalLike
  return {
    code: String(record.code ?? ''),
    haystack: [record.message, record.details, record.hint]
      .map((part) => String(part ?? ''))
      .join(' '),
  }
}

/**
 * Was this the requirement-key conflict, and not some other unique index?
 *
 * `laundry_orders` also carries `laundry_orders_reference_key`, and the two
 * mean opposite things: a duplicate requirement key is the same wash arriving
 * twice and is handled, while a duplicate reference on a *different* wash is a
 * generator collision and must not be silently swallowed as "already exists".
 * So the constraint is named rather than the code matched alone.
 */
function isDuplicateRequirementKey(error: unknown): boolean {
  const { code, haystack } = textOf(error)
  if (code !== PG_ERROR.UNIQUE_VIOLATION) return false
  return haystack.includes('laundry_orders_requirement_key')
}

/** Translate the two line triggers; leave everything else alone. */
function refusalFor(error: unknown): BusinessRuleError | null {
  const { code, haystack } = textOf(error)

  if (code === PG_ERROR.FOREIGN_KEY_VIOLATION) {
    if (haystack.includes('laundry order') && haystack.includes('not exist')) {
      return new LaundryLineDoesNotBelongError(error)
    }
    return null
  }

  if (code !== PG_ERROR.CHECK_VIOLATION) return null

  if (
    haystack.includes('calculated quantity rewritten') ||
    haystack.includes('repointed at another')
  ) {
    return new LaundryLineFrozenError(error)
  }

  if (
    haystack.includes("does not match its order's") ||
    haystack.includes('cannot carry a line for')
  ) {
    return new LaundryLineDoesNotBelongError(error)
  }

  return null
}

/** Raise the typed refusal when there is one, and the original otherwise. */
function raise(error: unknown): never {
  throw refusalFor(error) ?? error
}

/* ---------------------------------------------------------------- columns -- */

const SETTINGS_COLUMNS =
  'id, organization_id, property_id, mode, dispatch_mode, default_channel, ' +
  'default_provider_id, turnaround_hours, pickup_days, delivery_days, ' +
  'forecast_horizon_days, standing_notes, version'

const PROVIDER_COLUMNS =
  'id, organization_id, name, contact_name, phone, email, default_channel, ' +
  'turnaround_hours, pickup_days, delivery_days, minimum_order_units, ' +
  'notes, is_active, version'

const PROFILE_COLUMNS =
  'organization_id, item_id, label, laundry_managed, washable, ' +
  'external_laundry_allowed, route, default_provider_id, turnaround_hours, ' +
  'unit, bundle_size, minimum_buffer, version'

const ORDER_COLUMNS =
  'id, organization_id, property_id, provider_id, status, mode, ' +
  'dispatch_mode, channel, reference, requirement_key, required_by, ' +
  'pickup_at, expected_return_at, returned_at, sent_at, sent_body, ' +
  'internal_notes, provider_notes, version'

const LINE_COLUMNS =
  'id, organization_id, order_id, property_id, item_id, label, unit, ' +
  'calculated_quantity, adjustment_quantity, adjustment_reason, adjusted_by, ' +
  'adjusted_at, explanation, source_booking_id, required_by, notes'

/* ---------------------------------------------------------------- mapping -- */

/** A `smallint[]` column, as PostgREST renders it. */
function isoWeekdays(row: Row, column: string): readonly number[] {
  const value = row[column]
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
}

export function settingsFromRow(row: Row): LaundrySettings {
  return {
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    mode: asEnum(row, 'mode', LAUNDRY_MODES),
    dispatchMode: asEnum(row, 'dispatch_mode', LAUNDRY_DISPATCH_MODES),
    defaultChannel: asEnum(row, 'default_channel', LAUNDRY_CHANNELS),
    defaultProviderId: asStringOrNull(row, 'default_provider_id'),
    turnaroundHours: asNumber(row, 'turnaround_hours'),
    pickupDays: isoWeekdays(row, 'pickup_days'),
    deliveryDays: isoWeekdays(row, 'delivery_days'),
    forecastHorizonDays: asNumber(row, 'forecast_horizon_days'),
    standingNotes: asStringOrNull(row, 'standing_notes'),
  }
}

export function providerFromRow(row: Row): LaundryProvider {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    name: asString(row, 'name'),
    contactName: asStringOrNull(row, 'contact_name'),
    phone: asStringOrNull(row, 'phone'),
    email: asStringOrNull(row, 'email'),
    defaultChannel: asEnum(row, 'default_channel', LAUNDRY_CHANNELS),
    turnaroundHours: asNumber(row, 'turnaround_hours'),
    pickupDays: isoWeekdays(row, 'pickup_days'),
    deliveryDays: isoWeekdays(row, 'delivery_days'),
    minimumOrderUnits: asNumber(row, 'minimum_order_units'),
    notes: asStringOrNull(row, 'notes'),
    isActive: asBoolean(row, 'is_active'),
  }
}

export function profileFromRow(row: Row): LaundryItemProfile {
  return {
    organizationId: asString(row, 'organization_id'),
    itemId: asString(row, 'item_id'),
    label: asString(row, 'label'),
    laundryManaged: asBoolean(row, 'laundry_managed'),
    washable: asBoolean(row, 'washable'),
    externalLaundryAllowed: asBoolean(row, 'external_laundry_allowed'),
    route: asEnumOrNull(row, 'route', LAUNDRY_ROUTES),
    defaultProviderId: asStringOrNull(row, 'default_provider_id'),
    turnaroundHours: asNumberOrNull(row, 'turnaround_hours'),
    unit: asEnum(row, 'unit', REQUIREMENT_UNITS),
    bundleSize: asNumber(row, 'bundle_size'),
    minimumBuffer: asNumber(row, 'minimum_buffer'),
  }
}

/**
 * The explanation column: the arithmetic in the organization's own words.
 *
 * Written as `jsonb` by the engine that did the multiplying, so an entry that
 * does not carry both a sentence and a number is dropped rather than rendered
 * as a step nobody can read. Dropping is the safe direction — a screen shows
 * one fewer line of reasoning, never an empty bullet.
 */
function explanationFromRow(row: Row): readonly ExplanationStep[] {
  const value = row.explanation
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const step = entry as Record<string, unknown>
    if (typeof step.text !== 'string' || typeof step.value !== 'number') {
      return []
    }
    return [
      {
        kind: String(step.kind ?? 'preparation') as ExplanationStep['kind'],
        text: step.text,
        value: step.value,
      },
    ]
  })
}

export function lineFromRow(row: Row): LaundryOrderLine {
  const calculated = asNumber(row, 'calculated_quantity')
  const adjustment = asNumber(row, 'adjustment_quantity')

  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    orderId: asString(row, 'order_id'),
    propertyId: asString(row, 'property_id'),
    itemId: asString(row, 'item_id'),
    label: asString(row, 'label'),
    unit: asEnum(row, 'unit', REQUIREMENT_UNITS),
    quantity: {
      calculated,
      adjustment,
      // `final_quantity` is GENERATED ALWAYS and is neither selected nor sent.
      // Re-derived from the two inputs the database adds, so a row that
      // somehow disagreed would show the arithmetic rather than the
      // disagreement — and so this mapping cannot depend on a column no
      // writer is allowed to set.
      final: calculated + adjustment,
      reason: asStringOrNull(row, 'adjustment_reason'),
      adjustedByUserId: asStringOrNull(row, 'adjusted_by'),
      adjustedAt: asTimestampOrNull(row, 'adjusted_at'),
    },
    requiredBy: asTimestamp(row, 'required_by'),
    sourceBookingId: asStringOrNull(row, 'source_booking_id'),
    explanation: explanationFromRow(row),
    notes: asStringOrNull(row, 'notes'),
  }
}

export function orderFromRow(
  row: Row,
  lines: readonly LaundryOrderLine[],
): LaundryOrder {
  const id = asString(row, 'id')

  return {
    id,
    organizationId: asString(row, 'organization_id'),
    propertyId: asStringOrNull(row, 'property_id'),
    providerId: asStringOrNull(row, 'provider_id'),
    status: asEnum(row, 'status', LAUNDRY_STATUSES),
    mode: asEnum(row, 'mode', LAUNDRY_MODES),
    dispatchMode: asEnum(row, 'dispatch_mode', LAUNDRY_DISPATCH_MODES),
    channel: asEnum(row, 'channel', LAUNDRY_CHANNELS),
    reference: asString(row, 'reference'),
    requirementKey: asString(row, 'requirement_key'),
    requiredBy: asTimestamp(row, 'required_by'),
    pickupAt: asTimestampOrNull(row, 'pickup_at'),
    expectedReturnAt: asTimestampOrNull(row, 'expected_return_at'),
    returnedAt: asTimestampOrNull(row, 'returned_at'),
    sentAt: asTimestampOrNull(row, 'sent_at'),
    sentBody: asStringOrNull(row, 'sent_body'),
    internalNotes: asStringOrNull(row, 'internal_notes'),
    providerNotes: asStringOrNull(row, 'provider_notes'),
    // Filtered rather than assumed: one line read serves a page of orders, and
    // a line whose property is out of this reader's scope simply did not come
    // back. The order still renders, with the breakdown they may see.
    lines: lines.filter((line) => line.orderId === id),
    version: asNumber(row, 'version'),
  }
}

/* ------------------------------------------------------------------- port -- */

/** One line of a run, as the engine produced it. */
export interface LaundryOrderLineDraft {
  propertyId: string
  itemId: string
  label: string
  unit: LaundryOrderLine['unit']
  /** What the engine derived. Frozen by trigger the moment it is stored. */
  calculatedQuantity: number
  explanation: readonly ExplanationStep[]
  sourceBookingId: string | null
  /** ISO instant. Per line, because a run can carry two arrival times. */
  requiredBy: string
  notes: string | null
}

/**
 * A run about to become an order.
 *
 * `requirementKey` is supplied rather than computed here — `orderRequirementKey`
 * in `orders.ts` derives it from the run, and a repository that derived its own
 * would be a second opinion about what "the same wash" means.
 */
export interface LaundryOrderDraft {
  /** NULL means consolidated. The breakdown lives on the lines. */
  propertyId: string | null
  providerId: string | null
  mode: LaundryMode
  dispatchMode: LaundrySettings['dispatchMode']
  channel: LaundryChannel
  reference: string
  requirementKey: string
  requiredBy: string
  pickupAt: string | null
  expectedReturnAt: string | null
  internalNotes: string | null
  providerNotes: string | null
  lines: readonly LaundryOrderLineDraft[]
}

/**
 * What creating an order produced.
 *
 * `created` of `false` is the idempotent answer: the unique constraint already
 * held this wash and the order in `order` is the one that exists. Not an
 * error, because reloading will not help and creating a second run would put
 * two vans on the road.
 */
export interface CreatedLaundryOrder {
  order: LaundryOrder
  created: boolean
}

export interface AdjustLineWrite {
  orderId: string
  lineId: string
  /** Signed, and replacing any previous adjustment rather than adding to it. */
  adjustment: number
  /** Mandatory whenever the adjustment is non-zero; the schema agrees. */
  reason: string | null
  adjustedByUserId: string
  /** ISO instant. */
  at: string
}

export interface SendOrderWrite {
  orderId: string
  channel: LaundryChannel
  /** Verbatim, as reviewed. What was actually said is the record. */
  body: string
  sentByUserId: string
  at: string
}

export interface AdvanceOrderWrite {
  orderId: string
  status: LaundryStatus
  actorUserId: string
  at: string
}

export interface ListOrdersOptions {
  /**
   * How many orders a page is.
   *
   * REQUIRED, and with no default here on purpose. How much a screen shows is
   * a product decision made by the screen showing it — a dashboard's four and
   * a history page's two hundred are different questions — and a number
   * invented in this file would be a business figure inside a module whose one
   * law is that it holds none. `no-hardcoded-numbers.test.ts` scans this
   * directory and would say so.
   */
  limit: number
  /**
   * Narrow to one property.
   *
   * A consolidated order carries `property_id` NULL and must not vanish when
   * somebody narrows to one of the properties in it — see `listOrders`.
   */
  propertyId?: string | null
}

/**
 * Everything the laundry module needs from storage.
 *
 * Note what is absent: there is no `deleteOrder`, and adding one would not
 * work — `DELETE` on `laundry_orders` is revoked from `authenticated` and from
 * `service_role` alike. An order is cancelled.
 */
export interface LaundryRepository {
  listSettings(organizationId: string): Promise<readonly LaundrySettings[]>
  /** The one configuration in force, and which row it came from. */
  resolveSettingsFor(
    organizationId: string,
    propertyId: string | null,
  ): Promise<ResolvedSettings>

  listProviders(
    organizationId: string,
    options?: { includeInactive?: boolean },
  ): Promise<readonly LaundryProvider[]>
  loadProvider(
    organizationId: string,
    providerId: string,
  ): Promise<LaundryProvider | null>

  listItemProfiles(
    organizationId: string,
  ): Promise<readonly LaundryItemProfile[]>

  /**
   * Property id → name, for every property this reader may see.
   *
   * On the port rather than private to the adapter because the screens need
   * exactly this map too — every laundry list renders a property name beside a
   * quantity — and a second copy of the query in a route file is a second
   * place for the tenant filter to be forgotten. It was, in the version of
   * `_lib/queries.ts` this replaced.
   */
  listPropertyNames(
    organizationId: string,
  ): Promise<ReadonlyMap<string, string>>

  listOrders(
    organizationId: string,
    options: ListOrdersOptions,
  ): Promise<readonly LaundryOrder[]>
  loadOrder(
    organizationId: string,
    orderId: string,
  ): Promise<LaundryOrder | null>
  loadOrderByRequirementKey(
    organizationId: string,
    requirementKey: string,
  ): Promise<LaundryOrder | null>

  createOrder(
    organizationId: string,
    draft: LaundryOrderDraft,
    actorUserId: string,
    tx?: TransactionHandle,
  ): Promise<CreatedLaundryOrder>
  adjustLine(
    organizationId: string,
    write: AdjustLineWrite,
    tx?: TransactionHandle,
  ): Promise<LaundryOrder>
  markSent(
    organizationId: string,
    write: SendOrderWrite,
    tx?: TransactionHandle,
  ): Promise<LaundryOrder>
  advanceOrder(
    organizationId: string,
    write: AdvanceOrderWrite,
    tx?: TransactionHandle,
  ): Promise<LaundryOrder>

  /** Everything the message renderer needs that is not on the order. */
  messageContext(order: LaundryOrder): Promise<Omit<MessageViewInput, 'order'>>
}

/* ---------------------------------------------------------------- adapter -- */

export class SupabaseLaundryRepository implements LaundryRepository {
  constructor(private readonly db: Db) {}

  /* ------------------------------------------------------------ settings -- */

  async listSettings(
    organizationId: string,
  ): Promise<readonly LaundrySettings[]> {
    const { data, error } = await this.db
      .from('laundry_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)

    if (error) throw error
    return toRows(data ?? []).map(settingsFromRow)
  }

  /**
   * The configuration in force, resolved by the domain rather than by a query.
   *
   * `resolveSettings` picks a whole row — property override, else the
   * organization row, else the inert defaults — and says which. Doing that
   * here with an `.eq('property_id', …)` would answer the property question
   * and leave the fallback to whoever called, which is how two screens end up
   * disagreeing about which mode a business is in.
   */
  async resolveSettingsFor(
    organizationId: string,
    propertyId: string | null,
  ): Promise<ResolvedSettings> {
    const rows = await this.listSettings(organizationId)
    return resolveSettings(organizationId, rows, propertyId)
  }

  /* ----------------------------------------------------------- providers -- */

  async listProviders(
    organizationId: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<readonly LaundryProvider[]> {
    let query = this.db
      .from('laundry_providers')
      .select(PROVIDER_COLUMNS)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)

    // Inactive is not deleted. A provider switched off keeps its history and
    // its price list, and a manager comparing last winter's costs still needs
    // to see them — so the default hides them from a picker and the flag is
    // how a settings screen asks for all of them.
    if (options.includeInactive !== true) {
      query = query.eq('is_active', true)
    }

    const { data, error } = await query.order('name')

    if (error) throw error
    return toRows(data ?? []).map(providerFromRow)
  }

  async loadProvider(
    organizationId: string,
    providerId: string,
  ): Promise<LaundryProvider | null> {
    const { data, error } = await this.db
      .from('laundry_providers')
      .select(PROVIDER_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', providerId)
      .maybeSingle()

    if (error) throw error
    return data ? providerFromRow(toRow(data)) : null
  }

  /* ------------------------------------------------------------ profiles -- */

  async listItemProfiles(
    organizationId: string,
  ): Promise<readonly LaundryItemProfile[]> {
    const { data, error } = await this.db
      .from('laundry_item_profiles')
      .select(PROFILE_COLUMNS)
      .eq('organization_id', organizationId)
      .order('label')

    if (error) throw error
    return toRows(data ?? []).map(profileFromRow)
  }

  /* -------------------------------------------------------------- orders -- */

  /**
   * Orders with their lines, tightest deadline last.
   *
   * TWO QUERIES WHEN A PROPERTY IS NAMED, not one `or(...)`. A consolidated run
   * carries `property_id` NULL, so narrowing with a plain `eq` would hide the
   * very order that includes the property somebody selected. PostgREST's `or`
   * would express it in one round trip — at the cost of interpolating the
   * property id into a filter string, where every other filter in this file is
   * a bound value. Two scoped reads merged in memory keep that property, and
   * the merge is provably the same page: each read returns its own newest
   * `limit`, and the newest `limit` of the union is a subset of their union.
   *
   * The lines come back in a second read rather than as an embed, for the
   * reason `_lib/queries.ts` gives: an embed evaluates the child policy too —
   * which is right — but returns a partial line list with no sign that it is
   * partial. Read separately, the order's own `property_id` still says NULL and
   * the lines that arrived are the ones this reader may see.
   */
  async listOrders(
    organizationId: string,
    options: ListOrdersOptions,
  ): Promise<readonly LaundryOrder[]> {
    const { limit } = options
    const propertyId = options.propertyId ?? null

    const rows =
      propertyId === null
        ? await this.orderPage(organizationId, limit, 'any')
        : mergeNewest(
            await Promise.all([
              this.orderPage(organizationId, limit, { id: propertyId }),
              this.orderPage(organizationId, limit, 'consolidated'),
            ]),
            limit,
          )

    if (rows.length === 0) return []

    const lines = await this.linesFor(
      organizationId,
      rows.map((row) => asString(row, 'id')),
    )

    return rows.map((row) => orderFromRow(row, lines))
  }

  async loadOrder(
    organizationId: string,
    orderId: string,
  ): Promise<LaundryOrder | null> {
    const { data, error } = await this.db
      .from('laundry_orders')
      .select(ORDER_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('id', orderId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    const lines = await this.linesFor(organizationId, [asString(row, 'id')])
    return orderFromRow(row, lines)
  }

  /**
   * The order this requirement key already names, if any.
   *
   * The read half of idempotency. Scoped by organization because the unique
   * constraint is `(organization_id, requirement_key)` and the key alone is not
   * unique across tenants — two businesses washing the same items for the same
   * Friday would collide on it, and only the filter keeps them apart.
   */
  async loadOrderByRequirementKey(
    organizationId: string,
    requirementKey: string,
  ): Promise<LaundryOrder | null> {
    const { data, error } = await this.db
      .from('laundry_orders')
      .select(ORDER_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('requirement_key', requirementKey)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = toRow(data)
    const lines = await this.linesFor(organizationId, [asString(row, 'id')])
    return orderFromRow(row, lines)
  }

  /* --------------------------------------------------------------- write -- */

  /**
   * Create the run, or hand back the one that already exists.
   *
   * The conflict is not an error path bolted on: it is the expected outcome of
   * a retry, and every way a retry reaches here — a re-submitted form after a
   * timeout, a second session that consolidated the same wash, a job re-run
   * after a deploy — produces the same `requirement_key` and must produce the
   * same single order. So the insert is attempted, the named constraint is
   * recognised, and the existing row is read back and returned with
   * `created: false`.
   *
   * `final_quantity` is absent from the line payload and must stay absent:
   * Postgres refuses an explicit write to a `GENERATED ALWAYS` column, and that
   * refusal is what makes the adjusted quantity unfakeable.
   */
  async createOrder(
    organizationId: string,
    draft: LaundryOrderDraft,
    actorUserId: string,
    tx?: TransactionHandle,
  ): Promise<CreatedLaundryOrder> {
    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('laundry_orders')
      .insert({
        organization_id: organizationId,
        property_id: draft.propertyId,
        provider_id: draft.providerId,
        status: 'draft',
        mode: draft.mode,
        dispatch_mode: draft.dispatchMode,
        channel: draft.channel,
        reference: draft.reference,
        requirement_key: draft.requirementKey,
        required_by: draft.requiredBy,
        pickup_at: draft.pickupAt,
        expected_return_at: draft.expectedReturnAt,
        internal_notes: draft.internalNotes,
        provider_notes: draft.providerNotes,
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select(ORDER_COLUMNS)
      .single()

    if (error) {
      if (isDuplicateRequirementKey(error)) {
        const existing = await this.loadOrderByRequirementKey(
          organizationId,
          draft.requirementKey,
        )
        // A row the constraint says exists and a read cannot see is a policy
        // answer, not an absence — the caller may create orders and not read
        // this one. Reporting "already exists" without the order would be a
        // dead end, so the original refusal is raised instead.
        if (existing) return { order: existing, created: false }
      }
      raise(error)
    }

    recordWrite(tx, 'laundry_orders.insert')

    const row = toRow(data)
    const orderId = asString(row, 'id')

    const lines = await this.insertLines(
      organizationId,
      orderId,
      draft.lines,
      actorUserId,
      tx,
    )

    return { order: orderFromRow(row, lines), created: true }
  }

  /**
   * Record what a person changed a quantity to, and why.
   *
   * `calculated_quantity` is deliberately not in the payload. The trigger would
   * refuse a rewrite of it and this is the application agreeing rather than
   * discovering; `final_quantity` is likewise never sent, because the database
   * computes the sum and no writer may store a third number.
   */
  async adjustLine(
    organizationId: string,
    write: AdjustLineWrite,
    tx?: TransactionHandle,
  ): Promise<LaundryOrder> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('laundry_order_lines')
      .update({
        adjustment_quantity: write.adjustment,
        // The schema refuses a non-zero adjustment with no reason beside it.
        // Clearing an adjustment back to zero clears the reason with it, so a
        // stale sentence cannot outlive the change it explained.
        adjustment_reason: write.adjustment === 0 ? null : write.reason,
        adjusted_by: write.adjustment === 0 ? null : write.adjustedByUserId,
        adjusted_at: write.adjustment === 0 ? null : write.at,
        updated_by: write.adjustedByUserId,
      })
      .eq('organization_id', organizationId)
      .eq('order_id', write.orderId)
      .eq('id', write.lineId)

    if (error) raise(error)
    recordWrite(tx, 'laundry_order_lines.update')

    return this.reread(organizationId, write.orderId)
  }

  /**
   * The order has left the organization.
   *
   * `sent_body` is stored verbatim as reviewed and never re-rendered: what was
   * actually said is the record, and a renderer that changed next month would
   * otherwise rewrite history. The status moves off `draft` in the same
   * statement because `laundry_orders_sent_has_left_draft` refuses the pair
   * apart.
   */
  async markSent(
    organizationId: string,
    write: SendOrderWrite,
    tx?: TransactionHandle,
  ): Promise<LaundryOrder> {
    const db = clientFor(tx, this.db)

    const { error } = await db
      .from('laundry_orders')
      .update({
        status: 'to_collect',
        channel: write.channel,
        sent_at: write.at,
        sent_by: write.sentByUserId,
        sent_body: write.body,
        updated_by: write.sentByUserId,
      })
      .eq('organization_id', organizationId)
      .eq('id', write.orderId)

    if (error) raise(error)
    recordWrite(tx, 'laundry_orders.update')

    return this.reread(organizationId, write.orderId)
  }

  /**
   * Move the order along, including to `cancelled`.
   *
   * Cancelling IS an advance and not a deletion, and there is no method here
   * that deletes one: 0029 revokes `DELETE` and `TRUNCATE` on `laundry_orders`
   * from `service_role` as well as `authenticated`, so a run that was called
   * off stays readable — which is what a business needs in order to argue with
   * the invoice for it.
   */
  async advanceOrder(
    organizationId: string,
    write: AdvanceOrderWrite,
    tx?: TransactionHandle,
  ): Promise<LaundryOrder> {
    const db = clientFor(tx, this.db)

    const patch: Record<string, unknown> = {
      status: write.status,
      updated_by: write.actorUserId,
    }

    // The linen is physically back. Stamped here rather than by whoever is
    // watching the screen, because the moment it is recorded is the moment it
    // happened as far as every later report is concerned.
    if (write.status === 'delivered_to_property') {
      patch.returned_at = write.at
    }

    const { error } = await db
      .from('laundry_orders')
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', write.orderId)

    if (error) raise(error)
    recordWrite(tx, 'laundry_orders.update')

    return this.reread(organizationId, write.orderId)
  }

  /* -------------------------------------------------------------- render -- */

  /**
   * The context the provider message needs and the order does not carry.
   *
   * Nothing about a guest is here, and that is not an omission waiting to be
   * corrected: `LaundryOrder` carries no guest either, so the privacy
   * guarantee is that there is nothing to leak rather than that the renderer
   * remembers to leave it out.
   */
  async messageContext(
    order: LaundryOrder,
  ): Promise<Omit<MessageViewInput, 'order'>> {
    const organizationId = order.organizationId

    const [organizationName, propertyNames, provider, settings] =
      await Promise.all([
        this.organizationName(organizationId),
        this.listPropertyNames(organizationId),
        order.providerId === null
          ? Promise.resolve(null)
          : this.loadProvider(organizationId, order.providerId),
        this.resolveSettingsFor(organizationId, order.propertyId),
      ])

    return {
      organizationName,
      propertyNames,
      // The named contact when there is one, and the company otherwise. Never
      // an invented name: an unaddressed message is better than one addressed
      // to somebody who does not work there.
      contactName: provider?.contactName ?? provider?.name ?? null,
      contactPhone: provider?.phone ?? null,
      standingNotes: settings.settings.standingNotes,
    }
  }

  /* ------------------------------------------------------------- private -- */

  private async orderPage(
    organizationId: string,
    limit: number,
    property: 'any' | 'consolidated' | { id: string },
  ): Promise<Row[]> {
    let query = this.db
      .from('laundry_orders')
      .select(ORDER_COLUMNS)
      .eq('organization_id', organizationId)

    if (property === 'consolidated') {
      query = query.is('property_id', null)
    } else if (property !== 'any') {
      query = query.eq('property_id', property.id)
    }

    const { data, error } = await query
      .order('required_by', { ascending: false })
      .limit(limit)

    if (error) throw error
    return toRows(data ?? [])
  }

  private async linesFor(
    organizationId: string,
    orderIds: readonly string[],
  ): Promise<readonly LaundryOrderLine[]> {
    if (orderIds.length === 0) return []

    const { data, error } = await this.db
      .from('laundry_order_lines')
      .select(LINE_COLUMNS)
      .eq('organization_id', organizationId)
      .in('order_id', [...orderIds])

    if (error) throw error
    return toRows(data ?? []).map(lineFromRow)
  }

  private async insertLines(
    organizationId: string,
    orderId: string,
    drafts: readonly LaundryOrderLineDraft[],
    actorUserId: string,
    tx?: TransactionHandle,
  ): Promise<readonly LaundryOrderLine[]> {
    if (drafts.length === 0) return []

    const db = clientFor(tx, this.db)

    const { data, error } = await db
      .from('laundry_order_lines')
      .insert(
        drafts.map((line) => ({
          organization_id: organizationId,
          order_id: orderId,
          property_id: line.propertyId,
          item_id: line.itemId,
          label: line.label,
          unit: line.unit,
          calculated_quantity: line.calculatedQuantity,
          // Zero, always, on creation. An order is born saying exactly what
          // the engine said, and every departure from it is a recorded act
          // with a reason attached.
          adjustment_quantity: 0,
          explanation: [...line.explanation],
          source_booking_id: line.sourceBookingId,
          required_by: line.requiredBy,
          notes: line.notes,
          created_by: actorUserId,
          updated_by: actorUserId,
        })),
      )
      .select(LINE_COLUMNS)

    if (error) raise(error)
    recordWrite(tx, 'laundry_order_lines.insert')

    return toRows(data ?? []).map(lineFromRow)
  }

  /**
   * Read the order back after writing it.
   *
   * Deliberately a fresh read rather than the update's own `RETURNING`: a write
   * to `laundry_orders` does not return the lines, `tg_touch_row` has bumped
   * `version` by the time it lands, and the caller's next act is usually an
   * optimistic-locked one. Handing back a stale version would make that fail
   * for a reason nobody could see.
   */
  private async reread(
    organizationId: string,
    orderId: string,
  ): Promise<LaundryOrder> {
    const order = await this.loadOrder(organizationId, orderId)
    if (order) return order

    // The write succeeded and the row cannot be read. That is a policy answer
    // — an update `laundry_orders_update` admits whose result `laundry_orders_select`
    // does not — and it is a defect rather than an empty state, so it is loud.
    throw new Error(
      `laundry order ${orderId} was written and cannot be read back; ` +
        'the update and select policies disagree.',
    )
  }

  private async organizationName(organizationId: string): Promise<string> {
    const { data, error } = await this.db
      .from('organizations')
      .select('id, name')
      .eq('id', organizationId)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      throw new Error(
        `organization ${organizationId} is unreadable; a provider message ` +
          'cannot be rendered without the name it is sent from.',
      )
    }

    return asString(toRow(data), 'name')
  }

  /**
   * Property id → name, for every property this reader may see.
   *
   * A missing id is not filled in with a guess anywhere: callers fall back to
   * the id itself, which is ugly and true, rather than to a blank that reads
   * as a property with no name.
   */
  async listPropertyNames(
    organizationId: string,
  ): Promise<ReadonlyMap<string, string>> {
    const { data, error } = await this.db
      .from('properties')
      .select('id, name')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)

    if (error) throw error

    return new Map(
      toRows(data ?? []).map((row) => [
        asString(row, 'id'),
        asString(row, 'name'),
      ]),
    )
  }
}

/* ------------------------------------------------------------------ ports -- */

/**
 * The repository, in the shape `operations.ts` declares.
 *
 * `LaundryOperationPorts.loadOrder` takes an id and no organization, because
 * the pipeline hands an operation a resource id and nothing else. The
 * organization is therefore closed over here, at the composition root, where
 * the actor is known — which is the only place it can be closed over honestly.
 * An adapter that read the tenant off the row it was about to return would be
 * asking the row to vouch for itself.
 */
export function laundryOperationPorts(
  repository: LaundryRepository,
  organizationId: string,
): LaundryOperationPorts {
  return {
    loadOrder(orderId) {
      return repository.loadOrder(organizationId, orderId)
    },
    messageContext(order) {
      return repository.messageContext(order)
    },
  }
}

/* ------------------------------------------------------------------ merge -- */

/** The newest `limit` rows across pages that are each already newest-first. */
function mergeNewest(pages: readonly Row[][], limit: number): Row[] {
  const seen = new Set<string>()
  const merged: Row[] = []

  for (const page of pages) {
    for (const row of page) {
      const id = asString(row, 'id')
      if (seen.has(id)) continue
      seen.add(id)
      merged.push(row)
    }
  }

  return merged
    .sort(
      (a, b) =>
        Date.parse(asString(b, 'required_by')) -
        Date.parse(asString(a, 'required_by')),
    )
    .slice(0, limit)
}
