/**
 * EXECUTION CONTEXT — SERVER ONLY. The two store acts Autopilot names.
 *
 * `AUTOPILOT_ACTIONS` names `store.chaseProvider` and `store.offerUpsell`, and
 * `execute/registry.ts` has resolved both to `command_not_implemented` since
 * the catalogue landed. These are those two, and they are `defineOperation`
 * like everything else in `operations.ts` — authorization, validation, the
 * domain rule, the transaction, the audit event, idempotency — so "Autopilot
 * chased the DJ" and "דנה chased the DJ" are the same kind of record with a
 * different actor.
 *
 * ── The line both of these are written on ─────────────────────────────────
 *
 * **Neither one sends anything, and neither one pretends to.**
 *
 * There is no messaging transport in this product with credentials behind it.
 * `src/lib/notifications/transport.ts` says so out loud and ships a null
 * implementation that records `not_configured`; `messaging.sendGuestMessage`
 * is unbound in the command registry for the same reason. So a store command
 * that returned `{ sent: true }` would be inventing a delivery receipt, and
 * the whole value of the audit trail is that it does not contain sentences
 * nobody can stand behind.
 *
 * What each one therefore does is the honest half, and the honest half is not
 * nothing:
 *
 *   · `chaseProvider` moves a request that was sent and never answered into
 *     `unconfirmed` — a real column value, from 0032's own enum, meaning
 *     exactly "we asked and nobody replied" — and raises
 *     `store.provider_unconfirmed`, which the notification catalogue routes to
 *     every holder of `order.view` as URGENT with escalation. That is the
 *     chase reaching a person who can pick up a telephone. The result says
 *     `contactMade: false` in as many words.
 *
 *   · `offerUpsell` proves the offer is one the business can actually honour —
 *     against the catalogue, the property override, the availability rules,
 *     the day's capacity and the party — and hands back the offer for a person
 *     to make. It writes no business row on purpose: an offer is not an order,
 *     and its safety level (`business_impact`, capped at `ask_approval` for
 *     every customer by `autopilot_safety_rules`) means a person is in the loop
 *     by construction.
 *
 * ── The events ───────────────────────────────────────────────────────────
 *
 * `store.provider_unconfirmed` already existed for the chase and is used.
 * There is NO event for an upsell being offered, and none is invented — see
 * the comment on `offerUpsell.events`. `store.product.create` in
 * `operations.ts` set the precedent: where the frozen catalogue has no name
 * for what happened, the audit row is the record and nothing is fabricated.
 */

import { assertCan, type Resource } from '../authz/can'
import { BusinessRuleError } from '../errors'
import {
  asEnum,
  asNumber,
  asNumberOrNull,
  asString,
  asStringOrNull,
  asTimestampOrNull,
  clientFor,
  recordWrite,
  toRow,
  type Db,
} from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import {
  defaultServiceAt,
  evaluateEligibility,
  nullOccupancy,
} from './eligibility'
import { priceSourceFor, quantityFor, unitPriceFor } from './pricing'
import { canReach } from './provider-request'
import { StoreRepository } from './repository'
import type {
  BookingFacts,
  CatalogueItem,
  StoreAvailabilityRule,
  StoreItemPropertyOverride,
  StoreProvider,
  StoreProviderRequest,
  StoreSettings,
} from './types'

/* ------------------------------------------------------------- the deps -- */

/**
 * What the store cannot answer about the stay it is selling into.
 *
 * `BookingFacts` is the narrow view `types.ts` defines precisely so that this
 * module never holds a guest's name or telephone number. It is a port rather
 * than a table read here for the same reason `OccupancyPort` is one: the
 * booking calendar belongs to another module, and reaching into its tables
 * from here would couple the store to every future change in them.
 *
 * `portal.ts` builds the same shape from a guest's capability session;
 * this is the staff-side equivalent and the composition root supplies it.
 */
export interface StoreCommandDeps {
  db: Db
  bookingFacts: (
    organizationId: string,
    bookingId: string,
  ) => Promise<BookingFacts | null>
}

/* ------------------------------------------------------------ the shapes -- */

const CHASE_INPUT = s.object({
  requestId: s.uuid({ label: 'בקשת ספק' }),
})

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const UPSELL_INPUT = s.object({
  bookingId: s.uuid({ label: 'הזמנה' }),
  itemId: s.uuid({ label: 'מוצר' }),
  quantity: s.nullable(
    s.number({ label: 'כמות', integer: true, min: 1, max: 999 }),
  ),
  /** `null` means "whenever the product says", which is `defaultServiceAt`. */
  serviceDate: s.nullable(
    s.string({
      label: 'תאריך השירות',
      min: 10,
      max: 10,
      pattern: ISO_DATE,
      patternMessage: 'תאריך חייב להיות בפורמט YYYY-MM-DD.',
    }),
  ),
})

export type ChaseProviderInput = { requestId: string }

export type ChasedProvider = {
  requestId: string
  orderId: string
  providerId: string
  providerName: string
  channel: string
  serviceDate: string
  /** Where the request now stands. Always `unconfirmed` on success. */
  status: 'unconfirmed'
  /**
   * Whether the provider could be reached on their own channel at all — a
   * WhatsApp provider whose telephone number was deleted cannot be. Reported
   * rather than thrown, because the team still needs to be told nobody has
   * answered, and refusing here would swallow exactly that.
   */
  reachable: boolean
  /** ALWAYS false. Nothing in this product sends a message. */
  contactMade: false
  /** Who finishes the job. A person, on a telephone. */
  handoff: 'manual'
}

export type UpsellOfferInput = {
  bookingId: string
  itemId: string
  quantity: number | null
  serviceDate: string | null
}

export type PreparedUpsell = {
  bookingId: string
  itemId: string
  itemName: string
  quantity: number
  /** ISO date the service would happen on. */
  serviceDate: string
  /**
   * What one unit costs in the catalogue today, at this property. `null` for a
   * quote-priced product, which has no number and must not be given a zero.
   *
   * NOT a snapshot. `snapshotLine` is the one function that turns a catalogue
   * price into an order figure and it runs once, at purchase; this is the
   * pre-purchase read `unitPriceFor` documents itself as. An offer that froze
   * a price here would be a second answer to what the guest owes.
   */
  unitPriceAgorot: number | null
  priceSource: 'catalogue' | 'override' | 'quote'
  /** Things the guest must be told with the offer. From the eligibility check. */
  caveats: readonly string[]
  /** ALWAYS false. This prepares an offer; a person makes it. */
  sent: false
}

/** Everything `offerUpsell` needs, loaded once, before the rule. */
type UpsellContext = {
  booking: BookingFacts
  item: CatalogueItem
  settings: StoreSettings
  override: StoreItemPropertyOverride | null
  rules: readonly StoreAvailabilityRule[]
  serviceAt: Date
  usage: { onDate: number; onBooking: number }
}

export type StoreCommands = {
  chaseProvider: Operation<
    ChaseProviderInput,
    { request: StoreProviderRequest; provider: StoreProvider | null },
    ChasedProvider
  >
  offerUpsell: Operation<UpsellOfferInput, UpsellContext, PreparedUpsell>
}

/* -------------------------------------------------------------- helpers -- */

const PROVIDER_REQUEST_STATUSES = [
  'draft',
  'sent',
  'confirmed',
  'unconfirmed',
  'cancelled',
] as const

/**
 * The provider request, mapped by hand.
 *
 * `StoreRepository.providerRequests` reads by ORDER and this needs one row by
 * its own id, so the read is here. The mapping is the repository's, field for
 * field, and it is deliberately a copy rather than a call into a private
 * method: a widened repository method would be a widened read for every
 * caller, and this is the only one that wants a single request.
 */
function toProviderRequest(row: Record<string, unknown>): StoreProviderRequest {
  return {
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
  }
}

function operationsResource(
  organizationId: string,
  propertyId: string,
): Resource {
  return { organizationId, propertyId, family: 'operations' }
}

/** `YYYY-MM-DD` for a date, in UTC, which is what the columns hold. */
function isoDateOf(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/* ------------------------------------------------------------- the build -- */

export function defineStoreCommands(deps: StoreCommandDeps): StoreCommands {
  const repository = new StoreRepository(deps.db)

  /* ----------------------------------------------------- chase provider -- */

  const chaseProvider = defineOperation<
    ChaseProviderInput,
    { request: StoreProviderRequest; provider: StoreProvider | null },
    ChasedProvider
  >({
    name: 'store.provider.chase',
    permission: 'provider.manage',
    resourceType: 'store_provider_request',
    input: CHASE_INPUT,

    async loadResource({ input, context }) {
      const organizationId = context.actor.organizationId

      const { data, error } = await deps.db
        .from('store_provider_requests')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('id', input.requestId)
        .maybeSingle()

      if (error) throw new Error(error.message)
      if (!data) return null

      const request = toProviderRequest(toRow(data))
      const providers = await repository.providers(organizationId)

      return {
        resource: operationsResource(organizationId, request.propertyId),
        entity: {
          request,
          // `null` is a real answer: 0032 policies `store_providers` behind
          // `provider.manage`, and a directory this actor cannot read is not a
          // provider that does not exist. The chase still proceeds — what is
          // lost is the reachability check, and that is reported, not guessed.
          provider:
            providers.find((row) => row.id === request.providerId) ?? null,
        },
      }
    },

    /**
     * Only a request that went out and was never answered may be chased.
     *
     * A `draft` is the interesting refusal: chasing something that was never
     * sent would tell the team "the DJ has not replied" about a message that
     * is still sitting in the product. The right act there is to send it, and
     * saying so is more use than a generic refusal.
     */
    rule({ entity }) {
      const { request } = entity

      if (request.status === 'confirmed') {
        throw new BusinessRuleError({
          code: 'store.provider_already_confirmed',
          message: `Provider request ${request.id} is already confirmed`,
          userMessage: `${request.serviceName}: הספק כבר אישר, ואין למה להזכיר.`,
        })
      }
      if (request.status === 'cancelled') {
        throw new BusinessRuleError({
          code: 'store.provider_request_cancelled',
          message: `Provider request ${request.id} was cancelled`,
          userMessage: `${request.serviceName}: הבקשה בוטלה, ולכן אין מה לתזכר.`,
        })
      }
      if (request.status === 'draft') {
        throw new BusinessRuleError({
          code: 'store.provider_request_never_sent',
          message: `Provider request ${request.id} is still a draft`,
          userMessage:
            `${request.serviceName}: הבקשה מעולם לא נשלחה לספק, ולכן אי אפשר ` +
            'לתזכר עליה. שלחו אותה קודם.',
        })
      }
    },

    async execute({ entity, context, tx }) {
      const db = clientFor(tx, deps.db)
      const { request, provider } = entity

      // A compare-and-set, not a blind write. `.in('status', …)` is the whole
      // guard: a provider who confirmed by telephone thirty seconds ago has a
      // row in `confirmed`, and overwriting that with `unconfirmed` would tell
      // the team nobody is coming to a party the DJ has committed to.
      const { data, error } = await db
        .from('store_provider_requests')
        .update({
          status: 'unconfirmed',
          updated_by: context.actor.userId,
        })
        .eq('organization_id', context.actor.organizationId)
        .eq('id', request.id)
        .in('status', ['sent', 'unconfirmed'])
        .select('id, status')
        .maybeSingle()

      if (error) throw error
      if (!data) {
        throw new BusinessRuleError({
          code: 'store.provider_request_moved',
          message:
            `Provider request ${request.id} was no longer in sent/unconfirmed ` +
            'when the update ran',
          userMessage:
            'מצב הבקשה השתנה בזמן הפעולה — כנראה שמישהו עדכן אותה. ' +
            'רעננו את הדף ובדקו שוב.',
        })
      }

      recordWrite(tx, 'store_provider_requests.update')

      return {
        requestId: request.id,
        orderId: request.orderId,
        providerId: request.providerId,
        providerName: provider?.name ?? request.providerId,
        channel: request.channel,
        serviceDate: request.serviceDate,
        status: 'unconfirmed',
        // Unknown reads as unreachable. The team is then told to check the
        // provider's details, which is cheap; the opposite default produces a
        // silence nobody investigates.
        reachable: provider ? canReach(provider, request.channel) : false,
        contactMade: false,
        handoff: 'manual',
      }
    },

    audit({ entity, result, context }) {
      const { request } = entity
      return {
        resourceId: result.requestId,
        propertyId: request.propertyId,
        before: { status: request.status },
        after: { status: 'unconfirmed', contactMade: false },
        summary:
          `${context.auditActor.label} סימנה שהספק ${result.providerName} ` +
          `טרם אישר את ${request.serviceName} לתאריך ${request.serviceDate}. ` +
          'לא נשלחה הודעה — צריך ליצור קשר.',
      }
    },

    /**
     * The event that actually does the chasing.
     *
     * `store.provider_unconfirmed` is `urgent` in the notification catalogue,
     * routed to every holder of `order.view`, and it escalates. So the effect
     * of this command is that a person who can telephone the DJ is told, which
     * is the only mechanism this product has for reaching one.
     */
    events({ entity, result }) {
      const { request } = entity
      return [
        {
          name: 'store.provider_unconfirmed',
          propertyId: request.propertyId,
          payload: {
            requestId: result.requestId,
            orderId: result.orderId,
            providerId: result.providerId,
            serviceName: request.serviceName,
            serviceDate: request.serviceDate,
            channel: result.channel,
            reachable: result.reachable,
            contactMade: false,
          },
        },
      ]
    },
  })

  /* ------------------------------------------------------- offer upsell -- */

  const offerUpsell = defineOperation<
    UpsellOfferInput,
    UpsellContext,
    PreparedUpsell
  >({
    name: 'store.upsell.offer',
    permission: 'order.manage',
    resourceType: 'store_item',
    input: UPSELL_INPUT,

    /**
     * Everything the decision needs, read once.
     *
     * `loadResource` rather than `rule` because the pipeline re-asserts tenant
     * and scope against whatever this returns — so a manager narrowed to the
     * Carmel flat cannot prepare an offer against the Galilee villa, and that
     * check happens on the property the BOOKING names rather than on one the
     * caller claimed.
     */
    async loadResource({ input, context, now }) {
      const organizationId = context.actor.organizationId

      const booking = await deps.bookingFacts(organizationId, input.bookingId)
      if (!booking) return null

      const catalogue = await repository.items({ organizationId })
      const item = catalogue.find((candidate) => candidate.id === input.itemId)
      if (!item) return null

      const propertyId = booking.propertyId
      const settings = await repository.settings({ organizationId, propertyId })
      const overrides = await repository.propertyOverrides({
        organizationId,
        propertyId,
      })
      const rules = await repository.availabilityRules(organizationId)

      const serviceAt = input.serviceDate
        ? new Date(`${input.serviceDate}T12:00:00.000Z`)
        : defaultServiceAt(item, booking, now)

      const usageOnDate = await repository.usageByItem({
        organizationId,
        propertyId,
        date: isoDateOf(serviceAt),
      })

      // How many this stay has already bought, counted from the orders rather
      // than from a column — the same reason `usageByItem` counts.
      const orders = await repository.orders({
        organizationId,
        bookingId: booking.id,
      })
      const onBooking = orders
        .filter(
          (order) =>
            order.status !== 'cancelled' && order.status !== 'refunded',
        )
        .flatMap((order) => order.lines)
        .filter((line) => line.itemId === item.id)
        .reduce((sum, line) => sum + line.quantity, 0)

      return {
        resource: operationsResource(organizationId, propertyId),
        entity: {
          booking,
          item,
          settings,
          override: overrides[item.id] ?? null,
          rules,
          serviceAt,
          usage: { onDate: usageOnDate[item.id] ?? 0, onBooking },
        },
      }
    },

    /**
     * The refusals, and why they are refusals rather than caveats.
     *
     * An upsell offer is a promise made in the business's name. Offering pool
     * heating at a house with no pool, or a chef for last Tuesday, costs the
     * owner the telephone call in which they take it back — which is exactly
     * what `eligibility.ts` exists to prevent, and reusing it here is what
     * stops this file growing a second opinion about what is sellable.
     *
     * `audience: 'staff'` and not `'guest'`. The visibility rules answer "what
     * does the guest see in their own portal"; a business ringing a guest to
     * offer a late checkout is not bound by them, and a store whose guest
     * portal is switched off still sells over the telephone.
     */
    async rule({ input, entity, context, now }) {
      const { booking, item, settings, override, rules, serviceAt, usage } =
        entity

      assertCan(
        context.actor,
        'order.manage',
        operationsResource(context.actor.organizationId, booking.propertyId),
      )

      // A date already gone. Checked before the engine, because "צריך להזמין
      // 48 שעות מראש" is the wrong sentence about last Tuesday.
      if (serviceAt.getTime() < now.getTime()) {
        throw new BusinessRuleError({
          code: 'store.upsell_date_past',
          message:
            `Upsell for ${item.id} asked for ${isoDateOf(serviceAt)}, which is ` +
            `before ${now.toISOString()}`,
          userMessage:
            `אי אפשר להציע ${item.name} לתאריך ${isoDateOf(serviceAt)} — ` +
            'התאריך כבר עבר. בחרו מועד עתידי.',
          publicDetails: { serviceDate: isoDateOf(serviceAt) },
        })
      }

      const verdict = evaluateEligibility({
        item,
        settings,
        booking,
        override,
        rules,
        // The port is not wired, and answers "unknown" to everything. That is
        // a caveat on the offer, never a promise and never a silent refusal —
        // see `eligibility.ts`.
        occupancy: await nullOccupancy({
          organizationId: context.actor.organizationId,
          propertyId: booking.propertyId,
          bookingId: booking.id,
          from: serviceAt,
          to: serviceAt,
        }),
        usage,
        serviceAt,
        now,
        audience: 'staff',
      })

      if (!verdict.eligible) {
        throw new BusinessRuleError({
          code: 'store.upsell_not_available',
          message: `Upsell refused for item ${item.id}: ${verdict.reason ?? 'unknown'}`,
          userMessage: `אי אפשר להציע את ${item.name}: ${verdict.message ?? 'המוצר אינו זמין.'}`,
          publicDetails: { reason: verdict.reason },
        })
      }

      const quantity = quantityFor(item, booking, {
        requested: input.quantity ?? undefined,
      })
      if (verdict.remaining !== null && quantity > verdict.remaining) {
        throw new BusinessRuleError({
          code: 'store.upsell_over_remaining',
          message:
            `Upsell asked for ${quantity} of ${item.id}, only ` +
            `${verdict.remaining} remain`,
          userMessage:
            `נשארו ${verdict.remaining} יחידות של ${item.name} לתאריך הזה, ` +
            `ולכן אי אפשר להציע ${quantity}.`,
          publicDetails: { remaining: verdict.remaining },
        })
      }
    },

    /**
     * Nothing is written, and that is the point.
     *
     * An offer is not an order: there is no `store_orders` row, no line, no
     * held capacity and nothing for a guest to owe. The audit event this
     * operation produces is the whole durable record, which is correct — the
     * business decided to offer something, and that decision is traceable.
     * When the guest says yes, `store.order.create` runs and prices it once.
     */
    async execute({ input, entity }) {
      const { booking, item, override, serviceAt } = entity

      const quantity = quantityFor(item, booking, {
        requested: input.quantity ?? undefined,
      })

      return {
        bookingId: booking.id,
        itemId: item.id,
        itemName: item.name,
        quantity,
        serviceDate: isoDateOf(serviceAt),
        unitPriceAgorot: unitPriceFor(item, override),
        priceSource: priceSourceFor(item, override),
        caveats: caveatsOf(entity),
        sent: false,
      }
    },

    audit({ entity, result, context }) {
      const price =
        result.unitPriceAgorot === null
          ? 'לפי הצעת מחיר'
          : `₪${(result.unitPriceAgorot / 100).toLocaleString('he-IL')} ליחידה`

      return {
        resourceId: result.itemId,
        propertyId: entity.booking.propertyId,
        after: {
          bookingId: result.bookingId,
          itemId: result.itemId,
          quantity: result.quantity,
          serviceDate: result.serviceDate,
          unitPriceAgorot: result.unitPriceAgorot,
          sent: false,
        },
        summary:
          `${context.auditActor.label} הכינה הצעת שדרוג: ${result.itemName} ` +
          `× ${result.quantity} לתאריך ${result.serviceDate} (${price}) ` +
          `עבור הזמנה ${entity.booking.reference}. ההצעה טרם נשלחה.`,
      }
    },

    /**
     * No event, deliberately.
     *
     * The frozen catalogue has `store.order_created` and nothing for an offer,
     * because nothing was ordered. The nearest names — `quote.sent`,
     * `store.order_created` — would each announce a thing that did not happen,
     * and a subscriber acting on either is the exact harm a frozen catalogue
     * exists to prevent. `store.product.create` in `operations.ts` made the
     * same call for the same reason.
     *
     * Reported rather than invented: `store.upsell_offered` is the name this
     * wants, and it is not this module's to add.
     */
  })

  return { chaseProvider, offerUpsell }
}

/**
 * The caveats, as sentences rather than codes.
 *
 * `EligibilityCaveat` is a machine vocabulary and this offer is read by a
 * person before they make it, so the caveat becomes the sentence they have to
 * say out loud. Recomputed here rather than carried out of `rule`, because the
 * definition object is shared by every concurrent run and a stashed value is
 * one request's answer used for another's.
 */
function caveatsOf(entity: UpsellContext): readonly string[] {
  const caveats: string[] = []

  if (entity.item.itemType === 'property_addon') {
    caveats.push(
      'לוח ההגעות והניקיון אינו מחובר עדיין, ולכן יש לוודא מול הצוות שהתאריך אפשרי.',
    )
  }
  if (entity.item.fulfilmentKind === 'inventory') {
    caveats.push('יש לוודא מלאי לפני שמבטיחים לאורח.')
  }

  return caveats
}
