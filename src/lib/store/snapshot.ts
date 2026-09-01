/**
 * ══════════════════════════════════════════════════════════════════════════
 *  THE PRICE SNAPSHOT
 *
 *  Changing a product's price must never change an existing order.
 *
 *  שולחן שוק is ₪1,500 today. A guest buys it. Tomorrow the owner raises it
 *  to ₪1,800. That order is ₪1,500 forever, and the next guest sees ₪1,800.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This is the module that makes that true, and it is the only one that may.
 *
 * ── How it is guaranteed, in three places ─────────────────────────────────
 *
 *   1. **The type system.** `CatalogueItem` and `OrderLineSnapshot` are
 *      different types. `snapshotLine` below is the one function that turns
 *      the first into the second, and there is no function anywhere in this
 *      module that goes the other way. A screen holding an order cannot
 *      accidentally reach a catalogue price, because it does not have one.
 *
 *   2. **The schema.** `store_order_lines.unit_price_agorot` is NOT NULL and
 *      there is no view, join or generated column in 0032 that reads
 *      `store_items.base_price_agorot` to produce an order figure.
 *      `line_total_agorot` is GENERATED ALWAYS from the columns beside it, so
 *      no writer can store a total that is not its own parts — and the
 *      migration's rehearsal block asserts, against `pg_attribute`, that it is
 *      still generated.
 *
 *   3. **`snapshot.test.ts`**, which is the loudest test in this module. It
 *      places an order, moves the catalogue price underneath it, and asserts
 *      the order did not move.
 *
 * ── What else is frozen, and why each one costs money if it is not ────────
 *
 *   `itemNameSnapshot`            an archived product still has to read back
 *                                 as what it was called when it was sold
 *   `pricingModelSnapshot`        "per guest" becoming "fixed" must not
 *                                 re-price a stay that already happened
 *   `optionsAgorot` and the       deleting an option group must not orphan an
 *   per-option labels             order into unreadability
 *   `fulfilmentRecipeSnapshot`    the tasks promised are the tasks owed
 *   `leadTimeHoursSnapshot`       what the guest was told
 *   `cancellationPolicySnapshot`  §11 judges a cancelled booking order by
 *                                 order against the policy each order was
 *                                 SOLD under, never against today's
 *
 * ── What this module deliberately does NOT do ─────────────────────────────
 *
 * It does not write. `snapshotLine` returns a plain value, and persisting it
 * is `operations.ts`'s job through the service pipeline. A pure function is
 * what lets the loudest test in the module run with no database at all.
 */

import { BusinessRuleError } from '../errors'
import type { Agorot } from '../booking/types'
import {
  addonsTotalAgorot,
  optionsTotalAgorot,
  priceSourceFor,
  quantityFor,
  resolveAddons,
  resolveOptions,
  unitPriceFor,
  type ChosenAddon,
  type ChosenOption,
  type ResolvedAddon,
  type ResolvedOption,
  type QuantityRequest,
} from './pricing'
import type {
  BookingFacts,
  CatalogueItem,
  OrderLineOptionSnapshot,
  OrderLineSnapshot,
  StoreCancellationPolicy,
  StoreItemPropertyOverride,
  StorePriceSource,
} from './types'

/**
 * A line as it is about to be written, before the database gives it an id.
 *
 * Deliberately not `OrderLineSnapshot`: that type carries `id`, `orderId` and
 * the database-generated `lineTotalAgorot`, and pretending to know any of them
 * here would let a caller believe a draft was a stored row.
 */
export type LineSnapshotDraft = {
  itemId: string | null
  packageId: string | null
  itemNameSnapshot: string
  itemTypeSnapshot: OrderLineSnapshot['itemTypeSnapshot']
  pricingModelSnapshot: OrderLineSnapshot['pricingModelSnapshot']
  unitPriceAgorot: Agorot
  optionsAgorot: Agorot
  addonsAgorot: Agorot
  lineDiscountAgorot: Agorot
  quantity: number
  /** What the database will generate. Computed here so a caller can show it. */
  lineTotalAgorot: Agorot
  priceSnapshotAt: string
  priceSource: StorePriceSource
  customizationAnswers: Record<string, string | number>
  fulfilmentKindSnapshot: OrderLineSnapshot['fulfilmentKindSnapshot']
  fulfilmentRecipeSnapshot: OrderLineSnapshot['fulfilmentRecipeSnapshot']
  leadTimeHoursSnapshot: number
  cancellationPolicySnapshot: StoreCancellationPolicy
  providerId: string | null
  chosenOptions: readonly Omit<OrderLineOptionSnapshot, 'id'>[]
  chosenAddons: readonly ResolvedAddon[]
}

export type SnapshotRequest = {
  item: CatalogueItem
  booking: BookingFacts | null
  override?: StoreItemPropertyOverride | null
  options?: readonly ChosenOption[]
  addons?: readonly ChosenAddon[]
  answers?: Readonly<Record<string, string | number>>
  quantity?: QuantityRequest
  /**
   * For `quote` products only: the figure a person agreed with the guest.
   * Supplying it for any other model is refused, because a typed price beside
   * a catalogue price is two answers to one question.
   */
  agreedUnitPriceAgorot?: Agorot
  /** A line-level reduction, in agorot. Requires `order.discount_manage`. */
  lineDiscountAgorot?: Agorot
  now: Date
}

/**
 * Freeze a catalogue row into a line.
 *
 * Everything this function reads from `item` it copies. Nothing it returns
 * points back at `item`, and callers must not keep the two together: the
 * whole discipline is that after this call the catalogue is irrelevant to
 * this purchase.
 */
export function snapshotLine(request: SnapshotRequest): LineSnapshotDraft {
  const { item, booking, override, now } = request

  const quantity = quantityFor(item, booking, request.quantity ?? {})

  const unitPrice = resolveUnitPrice(request)

  const resolvedOptions: readonly ResolvedOption[] = resolveOptions(
    item.options,
    request.options ?? [],
  )
  const optionsAgorot = optionsTotalAgorot(resolvedOptions)

  // A negative option delta may reduce a unit price; it may not invert it. A
  // line whose unit price plus options is below zero would be a payment TO the
  // guest dressed as a purchase, and the correct handling of that is a refund
  // with its own grant, not a cheerful negative line.
  if (unitPrice + optionsAgorot < 0) {
    throw new BusinessRuleError({
      code: 'store_line_price_negative',
      userMessage:
        'הצירוף שנבחר מוריד את המחיר מתחת לאפס, ולכן אי אפשר להזמין אותו. בחר אפשרות אחרת או פנה אלינו.',
      message:
        `snapshotLine: unit price ${unitPrice} plus option deltas ` +
        `${optionsAgorot} is negative for item ${item.id}`,
    })
  }

  const resolvedAddons = resolveAddons(item.addons, request.addons ?? [])
  const addonsAgorot = addonsTotalAgorot(resolvedAddons)

  const lineDiscount = Math.max(0, Math.trunc(request.lineDiscountAgorot ?? 0))

  // The same arithmetic the database's generated column performs. Duplicated
  // here on purpose and for one reason: the guest has to be shown the figure
  // before the row exists. `snapshot.test.ts` asserts the two agree.
  const lineTotal =
    (unitPrice + optionsAgorot + addonsAgorot) * quantity - lineDiscount

  if (lineTotal < 0) {
    throw new BusinessRuleError({
      code: 'store_line_discount_exceeds_line',
      userMessage: 'ההנחה גדולה מסכום השורה. תקן את ההנחה ונסה שוב.',
      message:
        `snapshotLine: discount ${lineDiscount} exceeds line value for ` +
        `item ${item.id}`,
    })
  }

  return {
    itemId: item.id,
    packageId: null,
    itemNameSnapshot: item.name,
    itemTypeSnapshot: item.itemType,
    pricingModelSnapshot: item.pricingModel,
    unitPriceAgorot: unitPrice,
    optionsAgorot,
    addonsAgorot,
    lineDiscountAgorot: lineDiscount,
    quantity,
    lineTotalAgorot: lineTotal,
    priceSnapshotAt: now.toISOString(),
    priceSource:
      request.agreedUnitPriceAgorot !== undefined &&
      item.pricingModel === 'quote'
        ? 'quote'
        : priceSourceFor(item, override),
    customizationAnswers: answersFor(item, request.answers ?? {}),
    fulfilmentKindSnapshot: item.fulfilmentKind,
    // Structured-cloned rather than referenced. A snapshot that shares an
    // object with the catalogue is not a snapshot; the next editor of the
    // recipe would change what an order promised.
    fulfilmentRecipeSnapshot: { ...item.fulfilmentRecipe },
    leadTimeHoursSnapshot:
      override?.leadTimeHoursOverride ?? item.leadTimeHours,
    cancellationPolicySnapshot: { ...item.cancellationPolicy },
    providerId: override?.providerOverrideId ?? item.providerId,
    chosenOptions: resolvedOptions.map((option, index) => ({
      optionId: option.optionId,
      optionValueId: option.optionValueId,
      optionNameSnapshot: option.optionName,
      valueLabelSnapshot: option.valueLabel,
      priceDeltaAgorot: option.priceDeltaAgorot,
      sortOrder: index,
    })),
    chosenAddons: resolvedAddons,
  }
}

/**
 * The unit price, and the two ways of getting it wrong that are refused here.
 *
 * A `quote` product with no agreed figure cannot be turned into a line: there
 * is nothing to charge and substituting a zero would sell a caterer for
 * nothing. A non-`quote` product with an agreed figure is two prices for one
 * thing, and the resolution of that argument must be a deliberate override
 * rather than whichever branch happened to run.
 */
function resolveUnitPrice(request: SnapshotRequest): Agorot {
  const { item, override, agreedUnitPriceAgorot } = request

  if (item.pricingModel === 'quote') {
    if (agreedUnitPriceAgorot === undefined) {
      throw new BusinessRuleError({
        code: 'store_quote_price_required',
        userMessage:
          'המוצר הזה נמכר לפי הצעת מחיר, ולכן צריך לרשום את הסכום שסוכם לפני שאפשר להזמין אותו.',
        message: `snapshotLine: item ${item.id} is quote-priced and no agreed price was given`,
      })
    }
    if (!Number.isInteger(agreedUnitPriceAgorot) || agreedUnitPriceAgorot < 0) {
      throw new BusinessRuleError({
        code: 'store_quote_price_invalid',
        userMessage: 'סכום ההצעה חייב להיות מספר שלם באגורות, ולא שלילי.',
        message: `snapshotLine: agreed price ${agreedUnitPriceAgorot} is not whole agorot`,
      })
    }
    return agreedUnitPriceAgorot
  }

  if (agreedUnitPriceAgorot !== undefined) {
    throw new BusinessRuleError({
      code: 'store_agreed_price_not_allowed',
      userMessage:
        'למוצר הזה יש מחיר בקטלוג, ולכן אי אפשר לרשום עליו סכום אחר. לשינוי מחיר יש לערוך את המוצר או להגדיר מחיר לנכס.',
      message: `snapshotLine: item ${item.id} has a catalogue price and an agreed price was also supplied`,
    })
  }

  const price = unitPriceFor(item, override)
  if (price === null) {
    throw new BusinessRuleError({
      code: 'store_price_missing',
      userMessage: 'למוצר הזה אין מחיר, ולכן אי אפשר להזמין אותו כרגע.',
      message: `snapshotLine: item ${item.id} has no resolvable price`,
    })
  }
  return price
}

/**
 * The answers, keyed by the questions the product actually asks.
 *
 * Answers to questions the product does not ask are dropped rather than
 * stored. An order carrying arbitrary key/value pairs a guest's browser sent
 * is a mass-assignment surface in a jsonb column, and the schema's
 * `store_order_lines_answers_is_object` only checks that it is an object.
 *
 * A missing REQUIRED answer is refused. A product that asks "which flavour"
 * and receives an order with no flavour has produced a task nobody can do.
 */
function answersFor(
  item: CatalogueItem,
  supplied: Readonly<Record<string, string | number>>,
): Record<string, string | number> {
  const kept: Record<string, string | number> = {}

  for (const question of item.customizationQuestions) {
    const answer = supplied[question.key]

    if (answer === undefined || answer === '') {
      if (question.required) {
        throw new BusinessRuleError({
          code: 'store_answer_required',
          userMessage: `כדי להזמין את ${item.name} צריך למלא: ${question.label}.`,
          message: `snapshotLine: required answer '${question.key}' missing for item ${item.id}`,
          publicDetails: { field: question.key },
        })
      }
      continue
    }

    // A choice question accepts only what it offered. Anything else is either
    // a stale page or somebody editing the request.
    if (
      question.kind === 'choice' &&
      question.choices &&
      !question.choices.includes(String(answer))
    ) {
      throw new BusinessRuleError({
        code: 'store_answer_not_offered',
        userMessage: `הערך שנבחר עבור ״${question.label}״ אינו אחת מהאפשרויות. רענן את הדף ובחר שוב.`,
        message: `snapshotLine: answer to '${question.key}' is not among the offered choices`,
        publicDetails: { field: question.key },
      })
    }

    kept[question.key] = answer
  }

  return kept
}

/**
 * The total of a set of drafted lines.
 *
 * The sum of the lines and nothing else — never a quantity multiplied by a
 * catalogue rate. This is the figure a guest is shown at checkout, and the
 * database recomputes the same thing from the stored lines a moment later; if
 * the two ever disagree, the stored one is right and this one is the bug.
 */
export function draftSubtotalAgorot(
  lines: readonly LineSnapshotDraft[],
): Agorot {
  return lines.reduce((sum, line) => sum + line.lineTotalAgorot, 0)
}
