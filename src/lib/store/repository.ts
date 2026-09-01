/**
 * EXECUTION CONTEXT — SERVER ONLY. Rows in, domain objects out.
 *
 * ── Why the reads are separate queries and not embedded selects ───────────
 *
 * PostgREST will happily do `store_items(*, store_item_options(*))`, and this
 * adapter deliberately does not. Two reasons, and the second is the one that
 * would have cost a day:
 *
 *   1. An embedded select ties the shape of the response to the shape of the
 *      foreign keys, so a schema change silently reshapes every caller.
 *   2. The demo client resolves embeds through `DEMO_RELATIONS` in
 *      `src/lib/demo/client.ts`, which belongs to the coordinator. An adapter
 *      that needed six new relations there would be an adapter that cannot be
 *      landed by this worker without editing another worker's file.
 *
 * So the catalogue is read as five flat queries and stitched here, in one
 * place, in code a person can follow. The cost is a handful of round trips on
 * a screen that loads a catalogue; the benefit is that this module owns its
 * own reads end to end.
 *
 * ── Tenant scope ──────────────────────────────────────────────────────────
 *
 * Every query filters `organization_id` explicitly even though row level
 * security already does. That is not redundancy for its own sake: it is what
 * `repository.test.ts` asserts against the recorded filters, so a missing
 * scope is caught by a unit test rather than by a customer seeing another
 * customer's catalogue if a policy is ever loosened.
 */

import {
  asAgorot,
  asBoolean,
  asEnum,
  asIsoDateOrNull,
  asJsonRecord,
  asNumber,
  asNumberOrNull,
  asString,
  asStringArray,
  asStringOrNull,
  asTimestamp,
  asTimestampOrNull,
  toRows,
  type Db,
  type Row,
} from '../persistence'
import {
  STORE_FULFILMENT_KINDS,
  STORE_ITEM_STATUSES,
  STORE_ITEM_TYPES,
  STORE_MODES,
  STORE_ORDER_STATUSES,
  STORE_PAYMENT_MODES,
  STORE_PAYMENT_STATUSES,
  STORE_PRICING_MODELS,
  STORE_VISIBILITY_RULES,
} from '../contracts/states'
import type {
  CatalogueItem,
  OrderLineOptionSnapshot,
  OrderLineSnapshot,
  StoreAudience,
  StoreAvailabilityRule,
  StoreCancellationPolicy,
  StoreCategory,
  StoreFulfilmentRecipe,
  StoreItemAddon,
  StoreItemOption,
  StoreItemOptionValue,
  StoreItemPropertyOverride,
  StoreItemQuestion,
  StoreOrder,
  StoreOrderAmendment,
  StoreOrderPayment,
  StorePackage,
  StorePromoCode,
  StoreProvider,
  StoreProviderRequest,
  StoreSettings,
} from './types'

/* ------------------------------------------------------------- primitives -- */

const AVAILABILITY_KINDS = [
  'weekday',
  'date_range',
  'blackout',
  'season',
] as const
const PROVIDER_REQUEST_STATUSES = [
  'draft',
  'sent',
  'confirmed',
  'unconfirmed',
  'cancelled',
] as const
const AMENDMENT_STATUSES = [
  'proposed',
  'awaiting_consent',
  'applied',
  'rejected',
  'withdrawn',
] as const
const ORDER_SOURCES = ['guest_portal', 'staff', 'automation'] as const
const PRICE_SOURCES = ['catalogue', 'override', 'manual', 'quote'] as const

/** A jsonb array of plain strings — `media`, and nothing else so far. */
function asJsonStringArray(row: Row, column: string): string[] {
  const value = row[column]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The customization questions, validated rather than cast.
 *
 * A jsonb column is whatever was written into it, and a screen that trusted
 * its shape would render `undefined` as a question label. Anything that is not
 * a well-formed question is dropped, which is the same discipline
 * `snapshotLine` applies to the answers.
 */
function asQuestions(row: Row, column: string): StoreItemQuestion[] {
  const value = row[column]
  if (!Array.isArray(value)) return []

  const questions: StoreItemQuestion[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const key = record.key
    const label = record.label
    if (typeof key !== 'string' || typeof label !== 'string') continue

    const kind = record.kind
    questions.push({
      key,
      label,
      kind:
        kind === 'choice' || kind === 'number' || kind === 'text'
          ? kind
          : 'text',
      required: record.required === true,
      choices: Array.isArray(record.choices)
        ? record.choices.filter(
            (choice): choice is string => typeof choice === 'string',
          )
        : undefined,
    })
  }
  return questions
}

function asCancellationPolicy(
  row: Row,
  column: string,
): StoreCancellationPolicy {
  const record = asJsonRecord(row, column)
  const kind = record.kind
  if (
    kind === 'free_until_hours' ||
    kind === 'non_refundable' ||
    kind === 'percentage'
  ) {
    return {
      kind,
      hoursBefore:
        typeof record.hoursBefore === 'number' ? record.hoursBefore : undefined,
      refundPercent:
        typeof record.refundPercent === 'number'
          ? record.refundPercent
          : undefined,
    }
  }
  // An unset policy is `unspecified` and NOT a default of "free". §11 sends
  // an unspecified policy to a person rather than guessing with the
  // business's money.
  return { kind: 'unspecified' }
}

function asRecipe(row: Row, column: string): StoreFulfilmentRecipe {
  const record = asJsonRecord(row, column)
  return {
    taskType: typeof record.taskType === 'string' ? record.taskType : undefined,
    title: typeof record.title === 'string' ? record.title : undefined,
    description:
      typeof record.description === 'string' ? record.description : undefined,
    dueOffsetHours:
      typeof record.dueOffsetHours === 'number'
        ? record.dueOffsetHours
        : undefined,
    checklist: Array.isArray(record.checklist)
      ? record.checklist.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : undefined,
    teamId: typeof record.teamId === 'string' ? record.teamId : null,
  }
}

function asAudience(row: Row, column: string): StoreAudience {
  const record = asJsonRecord(row, column)
  return {
    occasions: Array.isArray(record.occasions)
      ? record.occasions.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : undefined,
    suitsCouple:
      typeof record.suitsCouple === 'boolean' ? record.suitsCouple : undefined,
    suitsFamily:
      typeof record.suitsFamily === 'boolean' ? record.suitsFamily : undefined,
    suitsGroup:
      typeof record.suitsGroup === 'boolean' ? record.suitsGroup : undefined,
  }
}

function asAnswers(row: Row, column: string): Record<string, string | number> {
  const record = asJsonRecord(row, column)
  const answers: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' || typeof value === 'number') {
      answers[key] = value
    }
  }
  return answers
}

/* ---------------------------------------------------------------- reading -- */

export class StoreRepository {
  constructor(private readonly db: Db) {}

  /**
   * The organization's store settings, with the property's own overriding it.
   *
   * Returns a value even when no row exists, and the value is `mode: 'off'` —
   * which is the correct reading of a business that has never opened this
   * screen. Returning `null` would make every caller decide what an absent
   * configuration means, and they would decide differently.
   */
  async settings(input: {
    organizationId: string
    propertyId?: string | null
  }): Promise<StoreSettings> {
    const { data, error } = await this.db
      .from('store_settings')
      .select('*')
      .eq('organization_id', input.organizationId)

    if (error) throw new Error(error.message)

    const rows = toRows(data)
    const organizationRow = rows.find((row) => row.property_id === null)
    const propertyRow = input.propertyId
      ? rows.find((row) => row.property_id === input.propertyId)
      : undefined

    const chosen = propertyRow ?? organizationRow

    if (!chosen) {
      return {
        organizationId: input.organizationId,
        propertyId: input.propertyId ?? null,
        mode: 'off',
        defaultPaymentMode: 'with_booking',
        paymentModesEnabled: [],
        approvalRequiredDefault: true,
        guestStoreEnabled: true,
        guestStoreHeading: null,
        guestStoreIntro: null,
        currency: 'ILS',
        orderReferencePrefix: 'S',
        cartTtlHours: 72,
      }
    }

    return {
      organizationId: asString(chosen, 'organization_id'),
      propertyId: asStringOrNull(chosen, 'property_id'),
      mode: asEnum(chosen, 'mode', STORE_MODES),
      defaultPaymentMode: asEnum(
        chosen,
        'default_payment_mode',
        STORE_PAYMENT_MODES,
      ),
      paymentModesEnabled: asStringArray(
        chosen,
        'payment_modes_enabled',
      ) as StoreSettings['paymentModesEnabled'],
      approvalRequiredDefault: asBoolean(chosen, 'approval_required_default'),
      guestStoreEnabled: asBoolean(chosen, 'guest_store_enabled'),
      guestStoreHeading: asStringOrNull(chosen, 'guest_store_heading'),
      guestStoreIntro: asStringOrNull(chosen, 'guest_store_intro'),
      currency: asString(chosen, 'currency'),
      orderReferencePrefix: asString(chosen, 'order_reference_prefix'),
      cartTtlHours: asNumber(chosen, 'cart_ttl_hours'),
    }
  }

  async categories(organizationId: string): Promise<StoreCategory[]> {
    const { data, error } = await this.db
      .from('store_categories')
      .select('*')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('sort_order')

    if (error) throw new Error(error.message)

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      slug: asString(row, 'slug'),
      description: asStringOrNull(row, 'description'),
      icon: asStringOrNull(row, 'icon'),
      sortOrder: asNumber(row, 'sort_order'),
      isActive: asBoolean(row, 'is_active'),
    }))
  }

  /**
   * The catalogue, stitched.
   *
   * Options, their values and the add-ons are three further queries scoped to
   * the same organization, joined in memory. See the header for why this is
   * not an embedded select.
   */
  async items(input: {
    organizationId: string
    /** Only what a guest may see. Staff screens pass `false`. */
    activeOnly?: boolean
  }): Promise<CatalogueItem[]> {
    let query = this.db
      .from('store_items')
      .select('*')
      .eq('organization_id', input.organizationId)
      .is('deleted_at', null)

    if (input.activeOnly) query = query.eq('status', 'active')

    const [itemsResult, optionsResult, valuesResult, addonsResult] =
      await Promise.all([
        query.order('sort_order'),
        this.db
          .from('store_item_options')
          .select('*')
          .eq('organization_id', input.organizationId)
          .order('sort_order'),
        this.db
          .from('store_item_option_values')
          .select('*')
          .eq('organization_id', input.organizationId)
          .order('sort_order'),
        this.db
          .from('store_item_addons')
          .select('*')
          .eq('organization_id', input.organizationId)
          .order('sort_order'),
      ])

    if (itemsResult.error) throw new Error(itemsResult.error.message)
    if (optionsResult.error) throw new Error(optionsResult.error.message)
    if (valuesResult.error) throw new Error(valuesResult.error.message)
    if (addonsResult.error) throw new Error(addonsResult.error.message)

    const valuesByOption = new Map<string, StoreItemOptionValue[]>()
    for (const row of toRows(valuesResult.data)) {
      const optionId = asString(row, 'option_id')
      const list = valuesByOption.get(optionId) ?? []
      list.push({
        id: asString(row, 'id'),
        label: asString(row, 'label'),
        priceDeltaAgorot: asAgorot(row, 'price_delta_agorot'),
        isDefault: asBoolean(row, 'is_default'),
        isAvailable: asBoolean(row, 'is_available'),
        sortOrder: asNumber(row, 'sort_order'),
      })
      valuesByOption.set(optionId, list)
    }

    const optionsByItem = new Map<string, StoreItemOption[]>()
    for (const row of toRows(optionsResult.data)) {
      const itemId = asString(row, 'item_id')
      const id = asString(row, 'id')
      const list = optionsByItem.get(itemId) ?? []
      list.push({
        id,
        name: asString(row, 'name'),
        selection: asString(row, 'selection') === 'multi' ? 'multi' : 'single',
        isRequired: asBoolean(row, 'is_required'),
        sortOrder: asNumber(row, 'sort_order'),
        values: valuesByOption.get(id) ?? [],
      })
      optionsByItem.set(itemId, list)
    }

    const addonsByItem = new Map<string, StoreItemAddon[]>()
    for (const row of toRows(addonsResult.data)) {
      const itemId = asString(row, 'item_id')
      const list = addonsByItem.get(itemId) ?? []
      list.push({
        id: asString(row, 'id'),
        name: asString(row, 'name'),
        description: asStringOrNull(row, 'description'),
        priceAgorot: asAgorot(row, 'price_agorot'),
        pricingModel: asEnum(row, 'pricing_model', STORE_PRICING_MODELS),
        maxQuantity: asNumberOrNull(row, 'max_quantity'),
        isActive: asBoolean(row, 'is_active'),
        sortOrder: asNumber(row, 'sort_order'),
      })
      addonsByItem.set(itemId, list)
    }

    return toRows(itemsResult.data).map((row) => {
      const id = asString(row, 'id')
      return {
        id,
        organizationId: asString(row, 'organization_id'),
        categoryId: asStringOrNull(row, 'category_id'),
        name: asString(row, 'name'),
        slug: asString(row, 'slug'),
        shortDescription: asStringOrNull(row, 'short_description'),
        description: asStringOrNull(row, 'description'),
        itemType: asEnum(row, 'item_type', STORE_ITEM_TYPES),
        status: asEnum(row, 'status', STORE_ITEM_STATUSES),
        pricingModel: asEnum(row, 'pricing_model', STORE_PRICING_MODELS),
        basePriceAgorot: asNumberOrNull(row, 'base_price_agorot'),
        costAgorot: asNumberOrNull(row, 'cost_agorot'),
        supplierReference: asStringOrNull(row, 'supplier_reference'),
        taxRateBps: asNumberOrNull(row, 'tax_rate_bps'),
        minQuantity: asNumber(row, 'min_quantity'),
        maxQuantity: asNumberOrNull(row, 'max_quantity'),
        maxPerBooking: asNumberOrNull(row, 'max_per_booking'),
        unitLabel: asStringOrNull(row, 'unit_label'),
        leadTimeHours: asNumber(row, 'lead_time_hours'),
        capacityPerDay: asNumberOrNull(row, 'capacity_per_day'),
        requiresCapability: asStringOrNull(row, 'requires_capability'),
        minGuests: asNumberOrNull(row, 'min_guests'),
        maxGuests: asNumberOrNull(row, 'max_guests'),
        visibilityRule: asEnum(row, 'visibility_rule', STORE_VISIBILITY_RULES),
        visibilityDaysBefore: asNumberOrNull(row, 'visibility_days_before'),
        requiresApproval:
          row.requires_approval === null || row.requires_approval === undefined
            ? null
            : asBoolean(row, 'requires_approval'),
        paymentMode:
          row.payment_mode === null || row.payment_mode === undefined
            ? null
            : asEnum(row, 'payment_mode', STORE_PAYMENT_MODES),
        fulfilmentKind: asEnum(row, 'fulfilment_kind', STORE_FULFILMENT_KINDS),
        fulfilmentRecipe: asRecipe(row, 'fulfilment_recipe'),
        providerId: asStringOrNull(row, 'provider_id'),
        customizationQuestions: asQuestions(row, 'customization_questions'),
        cancellationPolicy: asCancellationPolicy(row, 'cancellation_policy'),
        media: asJsonStringArray(row, 'media'),
        tags: asStringArray(row, 'tags'),
        audience: asAudience(row, 'audience'),
        isFeatured: asBoolean(row, 'is_featured'),
        sortOrder: asNumber(row, 'sort_order'),
        options: optionsByItem.get(id) ?? [],
        addons: addonsByItem.get(id) ?? [],
      }
    })
  }

  async packages(organizationId: string): Promise<StorePackage[]> {
    const [packagesResult, membersResult] = await Promise.all([
      this.db
        .from('store_packages')
        .select('*')
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .order('sort_order'),
      this.db
        .from('store_package_items')
        .select('*')
        .eq('organization_id', organizationId)
        .order('sort_order'),
    ])

    if (packagesResult.error) throw new Error(packagesResult.error.message)
    if (membersResult.error) throw new Error(membersResult.error.message)

    const membersByPackage = new Map<string, string[]>()
    for (const row of toRows(membersResult.data)) {
      const packageId = asString(row, 'package_id')
      const list = membersByPackage.get(packageId) ?? []
      list.push(asString(row, 'item_id'))
      membersByPackage.set(packageId, list)
    }

    return toRows(packagesResult.data).map((row) => {
      const id = asString(row, 'id')
      return {
        id,
        categoryId: asStringOrNull(row, 'category_id'),
        name: asString(row, 'name'),
        slug: asString(row, 'slug'),
        shortDescription: asStringOrNull(row, 'short_description'),
        description: asStringOrNull(row, 'description'),
        priceAgorot: asAgorot(row, 'price_agorot'),
        pricingModel: asEnum(row, 'pricing_model', STORE_PRICING_MODELS),
        status: asEnum(row, 'status', STORE_ITEM_STATUSES),
        media: asJsonStringArray(row, 'media'),
        audience: asAudience(row, 'audience'),
        cancellationPolicy: asCancellationPolicy(row, 'cancellation_policy'),
        visibilityRule: asEnum(row, 'visibility_rule', STORE_VISIBILITY_RULES),
        visibilityDaysBefore: asNumberOrNull(row, 'visibility_days_before'),
        isFeatured: asBoolean(row, 'is_featured'),
        sortOrder: asNumber(row, 'sort_order'),
        memberItemIds: membersByPackage.get(id) ?? [],
      }
    })
  }

  /**
   * The providers.
   *
   * Reached only by somebody holding `provider.manage`; RLS returns nothing to
   * anybody else and the screens are written to expect an empty list rather
   * than an error. A receptionist seeing "no providers" is the policy working.
   */
  async providers(organizationId: string): Promise<StoreProvider[]> {
    const { data, error } = await this.db
      .from('store_providers')
      .select('*')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name')

    if (error) throw new Error(error.message)

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      name: asString(row, 'name'),
      contactName: asStringOrNull(row, 'contact_name'),
      phone: asStringOrNull(row, 'phone'),
      email: asStringOrNull(row, 'email'),
      serviceTypes: asStringArray(row, 'service_types'),
      defaultChannel: asString(row, 'default_channel'),
      leadTimeHours: asNumber(row, 'lead_time_hours'),
      notes: asStringOrNull(row, 'notes'),
      isActive: asBoolean(row, 'is_active'),
    }))
  }

  async propertyOverrides(input: {
    organizationId: string
    propertyId: string
  }): Promise<Record<string, StoreItemPropertyOverride>> {
    const { data, error } = await this.db
      .from('store_item_property_overrides')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('property_id', input.propertyId)

    if (error) throw new Error(error.message)

    const map: Record<string, StoreItemPropertyOverride> = {}
    for (const row of toRows(data)) {
      const itemId = asString(row, 'item_id')
      map[itemId] = {
        itemId,
        propertyId: asString(row, 'property_id'),
        isAvailable: asBoolean(row, 'is_available'),
        priceOverrideAgorot: asNumberOrNull(row, 'price_override_agorot'),
        leadTimeHoursOverride: asNumberOrNull(row, 'lead_time_hours_override'),
        capacityPerDayOverride: asNumberOrNull(
          row,
          'capacity_per_day_override',
        ),
        providerOverrideId: asStringOrNull(row, 'provider_override_id'),
        notes: asStringOrNull(row, 'notes'),
      }
    }
    return map
  }

  async availabilityRules(
    organizationId: string,
  ): Promise<StoreAvailabilityRule[]> {
    const { data, error } = await this.db
      .from('store_availability_rules')
      .select('*')
      .eq('organization_id', organizationId)

    if (error) throw new Error(error.message)

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      itemId: asStringOrNull(row, 'item_id'),
      propertyId: asStringOrNull(row, 'property_id'),
      kind: asEnum(row, 'kind', AVAILABILITY_KINDS),
      weekdays: (Array.isArray(row.weekdays) ? row.weekdays : []).filter(
        (day): day is number => typeof day === 'number',
      ),
      fromDate: asIsoDateOrNull(row, 'from_date'),
      toDate: asIsoDateOrNull(row, 'to_date'),
      fromTime: asStringOrNull(row, 'from_time'),
      toTime: asStringOrNull(row, 'to_time'),
      maxPerDay: asNumberOrNull(row, 'max_per_day'),
      isBlocking: asBoolean(row, 'is_blocking'),
      note: asStringOrNull(row, 'note'),
      isActive: asBoolean(row, 'is_active'),
    }))
  }

  async promoCodes(organizationId: string): Promise<StorePromoCode[]> {
    const { data, error } = await this.db
      .from('store_promo_codes')
      .select('*')
      .eq('organization_id', organizationId)

    if (error) throw new Error(error.message)

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      code: asString(row, 'code'),
      description: asStringOrNull(row, 'description'),
      discountKind:
        asString(row, 'discount_kind') === 'amount' ? 'amount' : 'percent',
      percent: asNumberOrNull(row, 'percent'),
      amountAgorot: asNumberOrNull(row, 'amount_agorot'),
      minOrderAgorot: asAgorot(row, 'min_order_agorot'),
      maxUses: asNumberOrNull(row, 'max_uses'),
      uses: asNumber(row, 'uses'),
      maxUsesPerBooking: asNumberOrNull(row, 'max_uses_per_booking'),
      validFrom: asTimestampOrNull(row, 'valid_from'),
      validUntil: asTimestampOrNull(row, 'valid_until'),
      itemIds: asStringArray(row, 'item_ids'),
      isActive: asBoolean(row, 'is_active'),
    }))
  }

  /**
   * Orders, with their lines.
   *
   * The lines are a second query keyed on the returned order ids rather than
   * an embed, for the reason in the header — and because an order with no
   * lines is a real state (a draft cart) that an inner join would silently
   * drop from the list.
   */
  async orders(input: {
    organizationId: string
    propertyId?: string | null
    bookingId?: string | null
    statuses?: readonly string[]
    limit?: number
  }): Promise<StoreOrder[]> {
    let query = this.db
      .from('store_orders')
      .select('*')
      .eq('organization_id', input.organizationId)

    if (input.propertyId) query = query.eq('property_id', input.propertyId)
    if (input.bookingId) query = query.eq('booking_id', input.bookingId)
    if (input.statuses && input.statuses.length > 0) {
      query = query.in('status', [...input.statuses])
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(input.limit ?? 100)

    if (error) throw new Error(error.message)

    const orderRows = toRows(data)
    if (orderRows.length === 0) return []

    const ids = orderRows.map((row) => asString(row, 'id'))
    const linesByOrder = await this.linesFor(input.organizationId, ids)

    return orderRows.map((row) =>
      toOrder(row, linesByOrder.get(asString(row, 'id')) ?? []),
    )
  }

  async order(input: {
    organizationId: string
    orderId: string
  }): Promise<StoreOrder | null> {
    const { data, error } = await this.db
      .from('store_orders')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('id', input.orderId)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return null

    const lines = await this.linesFor(input.organizationId, [input.orderId])
    return toOrder(data as Row, lines.get(input.orderId) ?? [])
  }

  private async linesFor(
    organizationId: string,
    orderIds: readonly string[],
  ): Promise<Map<string, OrderLineSnapshot[]>> {
    const [linesResult, optionsResult] = await Promise.all([
      this.db
        .from('store_order_lines')
        .select('*')
        .eq('organization_id', organizationId)
        .in('order_id', [...orderIds])
        .order('sort_order'),
      this.db
        .from('store_order_line_options')
        .select('*')
        .eq('organization_id', organizationId)
        .order('sort_order'),
    ])

    if (linesResult.error) throw new Error(linesResult.error.message)
    if (optionsResult.error) throw new Error(optionsResult.error.message)

    const optionsByLine = new Map<string, OrderLineOptionSnapshot[]>()
    for (const row of toRows(optionsResult.data)) {
      const lineId = asString(row, 'order_line_id')
      const list = optionsByLine.get(lineId) ?? []
      list.push({
        id: asString(row, 'id'),
        optionId: asStringOrNull(row, 'option_id'),
        optionValueId: asStringOrNull(row, 'option_value_id'),
        optionNameSnapshot: asString(row, 'option_name_snapshot'),
        valueLabelSnapshot: asString(row, 'value_label_snapshot'),
        priceDeltaAgorot: asAgorot(row, 'price_delta_agorot'),
        sortOrder: asNumber(row, 'sort_order'),
      })
      optionsByLine.set(lineId, list)
    }

    const byOrder = new Map<string, OrderLineSnapshot[]>()
    for (const row of toRows(linesResult.data)) {
      const id = asString(row, 'id')
      const orderId = asString(row, 'order_id')
      const list = byOrder.get(orderId) ?? []
      list.push({
        id,
        orderId,
        itemId: asStringOrNull(row, 'item_id'),
        packageId: asStringOrNull(row, 'package_id'),
        itemNameSnapshot: asString(row, 'item_name_snapshot'),
        itemTypeSnapshot: asEnum(row, 'item_type_snapshot', STORE_ITEM_TYPES),
        pricingModelSnapshot: asEnum(
          row,
          'pricing_model_snapshot',
          STORE_PRICING_MODELS,
        ),
        unitPriceAgorot: asAgorot(row, 'unit_price_agorot'),
        optionsAgorot: asAgorot(row, 'options_agorot'),
        addonsAgorot: asAgorot(row, 'addons_agorot'),
        lineDiscountAgorot: asAgorot(row, 'line_discount_agorot'),
        quantity: asNumber(row, 'quantity'),
        lineTotalAgorot: asAgorot(row, 'line_total_agorot'),
        priceSnapshotAt: asTimestamp(row, 'price_snapshot_at'),
        priceSource: asEnum(row, 'price_source', PRICE_SOURCES),
        customizationAnswers: asAnswers(row, 'customization_answers'),
        fulfilmentKindSnapshot: asEnum(
          row,
          'fulfilment_kind_snapshot',
          STORE_FULFILMENT_KINDS,
        ),
        fulfilmentRecipeSnapshot: asRecipe(row, 'fulfilment_recipe_snapshot'),
        leadTimeHoursSnapshot: asNumber(row, 'lead_time_hours_snapshot'),
        cancellationPolicySnapshot: asCancellationPolicy(
          row,
          'cancellation_policy_snapshot',
        ),
        providerId: asStringOrNull(row, 'provider_id'),
        lineStatus: asEnum(row, 'line_status', STORE_ORDER_STATUSES),
        notes: asStringOrNull(row, 'notes'),
        sortOrder: asNumber(row, 'sort_order'),
        chosenOptions: optionsByLine.get(id) ?? [],
      })
      byOrder.set(orderId, list)
    }

    return byOrder
  }

  async payments(input: {
    organizationId: string
    orderId: string
  }): Promise<StoreOrderPayment[]> {
    const { data, error } = await this.db
      .from('store_order_payments')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('order_id', input.orderId)
      .order('recorded_at', { ascending: false })

    if (error) throw new Error(error.message)

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      orderId: asString(row, 'order_id'),
      mode: asEnum(row, 'mode', STORE_PAYMENT_MODES),
      method: asString(row, 'method'),
      amountAgorot: asNumber(row, 'amount_agorot'),
      status: asEnum(row, 'status', STORE_PAYMENT_STATUSES),
      reference: asStringOrNull(row, 'reference'),
      notes: asStringOrNull(row, 'notes'),
      recordedAt: asTimestamp(row, 'recorded_at'),
    }))
  }

  async amendments(input: {
    organizationId: string
    orderId: string
  }): Promise<StoreOrderAmendment[]> {
    const { data, error } = await this.db
      .from('store_order_amendments')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('order_id', input.orderId)
      .order('created_at', { ascending: false })

    if (error) throw new Error(error.message)

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      orderId: asString(row, 'order_id'),
      kind: asString(row, 'kind'),
      status: asEnum(row, 'status', AMENDMENT_STATUSES),
      beforeState: asJsonRecord(row, 'before_state'),
      afterState: asJsonRecord(row, 'after_state'),
      deltaAgorot: asNumber(row, 'delta_agorot'),
      reason: asString(row, 'reason'),
      consentRequired: asBoolean(row, 'consent_required'),
      consentGivenAt: asTimestampOrNull(row, 'consent_given_at'),
      appliedAt: asTimestampOrNull(row, 'applied_at'),
      createdAt: asTimestamp(row, 'created_at'),
    }))
  }

  async providerRequests(input: {
    organizationId: string
    orderId: string
  }): Promise<StoreProviderRequest[]> {
    const { data, error } = await this.db
      .from('store_provider_requests')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('order_id', input.orderId)

    if (error) throw new Error(error.message)

    return toRows(data).map((row) => ({
      id: asString(row, 'id'),
      orderId: asString(row, 'order_id'),
      orderLineId: asStringOrNull(row, 'order_line_id'),
      providerId: asString(row, 'provider_id'),
      propertyId: asString(row, 'property_id'),
      status: asEnum(row, 'status', PROVIDER_REQUEST_STATUSES),
      channel: asString(row, 'channel'),
      serviceName: asString(row, 'service_name'),
      serviceDate: asString(row, 'service_date'),
      serviceTime: asStringOrNull(row, 'service_time'),
      durationMinutes: asNumberOrNull(row, 'duration_minutes'),
      quantity: asNumber(row, 'quantity'),
      operationalNotes: asStringOrNull(row, 'operational_notes'),
      reference: asString(row, 'reference'),
      sentAt: asTimestampOrNull(row, 'sent_at'),
      confirmedAt: asTimestampOrNull(row, 'confirmed_at'),
    }))
  }

  /**
   * How many of each item are already committed for a given date.
   *
   * Counted from the ORDERS rather than from a counter column, because a
   * counter is a second copy of a fact and drifts the first time an order is
   * cancelled without one being decremented. Cancelled and refunded orders do
   * not consume capacity, which is the whole point of counting rather than
   * incrementing.
   */
  async usageByItem(input: {
    organizationId: string
    propertyId?: string | null
    date: string
  }): Promise<Record<string, number>> {
    let query = this.db
      .from('store_orders')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('requested_for_date', input.date)

    if (input.propertyId) query = query.eq('property_id', input.propertyId)

    const { data, error } = await query
    if (error) throw new Error(error.message)

    const live = toRows(data).filter((row) => {
      const status = asString(row, 'status')
      return status !== 'cancelled' && status !== 'refunded'
    })

    if (live.length === 0) return {}

    const lines = await this.linesFor(
      input.organizationId,
      live.map((row) => asString(row, 'id')),
    )

    const usage: Record<string, number> = {}
    for (const list of lines.values()) {
      for (const line of list) {
        if (!line.itemId) continue
        usage[line.itemId] = (usage[line.itemId] ?? 0) + line.quantity
      }
    }
    return usage
  }
}

/* --------------------------------------------------------------- mapping -- */

function toOrder(row: Row, lines: OrderLineSnapshot[]): StoreOrder {
  return {
    id: asString(row, 'id'),
    organizationId: asString(row, 'organization_id'),
    propertyId: asString(row, 'property_id'),
    bookingId: asStringOrNull(row, 'booking_id'),
    guestId: asStringOrNull(row, 'guest_id'),
    reference: asString(row, 'reference'),
    source: asEnum(row, 'source', ORDER_SOURCES),
    status: asEnum(row, 'status', STORE_ORDER_STATUSES),
    paymentStatus: asEnum(row, 'payment_status', STORE_PAYMENT_STATUSES),
    paymentMode: asEnum(row, 'payment_mode', STORE_PAYMENT_MODES),
    currency: asString(row, 'currency'),
    subtotalAgorot: asAgorot(row, 'subtotal_agorot'),
    discountAgorot: asAgorot(row, 'discount_agorot'),
    taxAgorot: asAgorot(row, 'tax_agorot'),
    totalAgorot: asAgorot(row, 'total_agorot'),
    promoCodeId: asStringOrNull(row, 'promo_code_id'),
    promoCodeSnapshot: asStringOrNull(row, 'promo_code_snapshot'),
    requestedForDate: asIsoDateOrNull(row, 'requested_for_date'),
    requestedForTime: asStringOrNull(row, 'requested_for_time'),
    guestNotes: asStringOrNull(row, 'guest_notes'),
    internalNotes: asStringOrNull(row, 'internal_notes'),
    approvedAt: asTimestampOrNull(row, 'approved_at'),
    confirmedAt: asTimestampOrNull(row, 'confirmed_at'),
    fulfilledAt: asTimestampOrNull(row, 'fulfilled_at'),
    cancelledAt: asTimestampOrNull(row, 'cancelled_at'),
    cancellationReason: asStringOrNull(row, 'cancellation_reason'),
    refundedAt: asTimestampOrNull(row, 'refunded_at'),
    amendmentCount: asNumber(row, 'amendment_count'),
    createdAt: asTimestamp(row, 'created_at'),
    lines,
  }
}
