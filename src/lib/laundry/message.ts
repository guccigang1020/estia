/**
 * The message that leaves the building.
 *
 * ══ THIS IS THE ONE ARTEFACT IN THE PRODUCT ADDRESSED TO A STRANGER ═══════
 *
 * Everything else ESTIA renders is read by somebody inside the organization,
 * behind a membership, a grant and a scope. This is not. This is a WhatsApp
 * message to a laundry company that has no contract with the guest, no
 * obligation to them, and no reason ever to learn their name.
 *
 * A laundry provider receives, and may receive, exactly this:
 *
 *   · which property                    · what quantities
 *   · when it has to be back            · notes meant for them
 *   · an internal reference             · who to call at the business
 *
 * A laundry provider must never receive:
 *
 *   · a guest's name                    · a guest's telephone or email
 *   · any price, total or amount        · any payment or deposit state
 *   · which agent or agency sold it     · a booking number
 *
 * ── How that is guaranteed, and how it is NOT ─────────────────────────────
 *
 * It is NOT guaranteed by this function remembering to leave things out. A
 * renderer that is handed a booking and omits six fields is a renderer that
 * includes the seventh the day somebody adds one.
 *
 * It is guaranteed in three independent places:
 *
 *   1. `0029_laundry.sql` gives the laundry tables no guest, price, payment or
 *      agent column at all, and its rehearsal block fails the migration if one
 *      ever appears. There is nothing in the row to leak.
 *   2. `OrderMessageView` below is a narrow structural type. It is not a
 *      booking, and it is not a `LaundryOrder` either — `toMessageView` copies
 *      field by field, so a field added to the order type does not silently
 *      appear in the message.
 *   3. `message.test.ts` drives the whole path from a booking carrying a name,
 *      a telephone number, a price, a payment state and an agent, and asserts
 *      that not one of those strings survives into the rendered body.
 *
 * Three, because each catches what the others cannot. The schema stops a
 * column; the type stops a field; the test stops a template literal.
 *
 * ── `internalNotes` versus `providerNotes` ────────────────────────────────
 *
 * Two note columns, and the split is the whole reason they are two. "האורחת
 * מגיעה מאוחר, אל תתקשרו אליה" is a note somebody genuinely needs to write and
 * genuinely must not send. A single `notes` column would be sent, because the
 * person writing it is thinking about the linen and not about data protection.
 */

import { isoDay } from './dates'
import type { LaundryChannel, LaundryOrder, RequirementUnit } from './types'

// ── What a message may be built from ──────────────────────────────────────

/**
 * The narrow view a message is rendered from.
 *
 * Deliberately not `LaundryOrder`. A field added to the order — and there will
 * be fields added to the order — does not reach this type without somebody
 * editing `toMessageView` and reading the header above while they do it.
 */
export interface OrderMessageView {
  reference: string
  /** ISO instant. */
  requiredBy: string
  /** Hebrew name of the business, so the provider knows who is writing. */
  organizationName: string
  /** Who at the business to call. Never a guest. */
  contactName: string | null
  contactPhone: string | null
  properties: readonly MessageProperty[]
  /** From `providerNotes` and the settings' standing notes. Reviewed. */
  notes: readonly string[]
}

export interface MessageProperty {
  /** The property's own name — a place, not a person. */
  name: string
  /** ISO instant this property's linen is needed. */
  requiredBy: string
  lines: readonly MessageLine[]
}

export interface MessageLine {
  label: string
  quantity: number
  unit: RequirementUnit
}

/** How the units read in a Hebrew sentence. */
const UNIT_LABEL: Readonly<Record<RequirementUnit, string>> = {
  piece: 'יח׳',
  set: 'מערכות',
  pack: 'חבילות',
  person: 'לאדם',
  hour: 'שעות',
}

// ── Building the view ─────────────────────────────────────────────────────

export interface MessageViewInput {
  order: LaundryOrder
  organizationName: string
  /** Property id → the property's name. Missing ids fall back to the id. */
  propertyNames: ReadonlyMap<string, string>
  contactName: string | null
  contactPhone: string | null
  /** The organization's standing note, if any. */
  standingNotes: string | null
}

/**
 * Copy an order into the narrow view, field by field.
 *
 * The per-property grouping happens here rather than in the renderer, because
 * the breakdown is the delivery instruction — see `consolidation.ts` — and a
 * renderer handed a flat list would have to choose whether to preserve it.
 *
 * `internalNotes` and `sourceBookingId` are the two fields this function
 * deliberately does not copy, and they are named here so that a reader
 * checking "what is left out" does not have to diff two type declarations.
 */
export function toMessageView(input: MessageViewInput): OrderMessageView {
  const { order, propertyNames } = input

  const byProperty = new Map<string, MessageProperty>()

  for (const line of order.lines) {
    const name = propertyNames.get(line.propertyId) ?? line.propertyId
    const existing = byProperty.get(line.propertyId)

    const rendered: MessageLine = {
      label: line.label,
      // The FINAL quantity: what is actually being asked for. The calculated
      // figure and the adjustment are internal evidence — a provider asked to
      // wash 30 sheets does not need to know that the engine said 28.
      quantity: line.quantity.final,
      unit: line.unit,
    }

    if (!existing) {
      byProperty.set(line.propertyId, {
        name,
        requiredBy: line.requiredBy,
        lines: [rendered],
      })
      continue
    }

    byProperty.set(line.propertyId, {
      ...existing,
      // The tightest deadline at this property. See `consolidation.ts`.
      requiredBy:
        new Date(line.requiredBy).getTime() <
        new Date(existing.requiredBy).getTime()
          ? line.requiredBy
          : existing.requiredBy,
      lines: [...existing.lines, rendered],
    })
  }

  const notes = [input.standingNotes, order.providerNotes].filter(
    (note): note is string => note !== null && note.trim().length > 0,
  )

  return {
    reference: order.reference,
    requiredBy: order.requiredBy,
    organizationName: input.organizationName,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    properties: [...byProperty.values()],
    notes,
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

/**
 * The order, as a Hebrew message body.
 *
 * Plain text with no markup, because it has to survive WhatsApp, SMS, an email
 * client and a printer without four renderers. The blank-line structure is the
 * formatting, and it reads correctly right-to-left because nothing in it
 * depends on horizontal alignment.
 *
 * `channel` changes the length and nothing else: an SMS is charged by the
 * segment and a provider reading one on a feature phone does not want a
 * preamble, so the SMS form drops the greeting and the sign-off and keeps
 * every number.
 */
export function renderOrderMessage(
  view: OrderMessageView,
  channel: LaundryChannel = 'whatsapp',
): string {
  const terse = channel === 'sms'
  const blocks: string[] = []

  if (!terse) {
    blocks.push(`שלום, כאן ${view.organizationName}.`)
  }

  blocks.push(`הזמנת כביסה ${view.reference}`)
  blocks.push(`נדרש עד: ${readable(view.requiredBy)}`)

  for (const property of view.properties) {
    const lines = property.lines
      .map(
        (line) => `· ${line.label}: ${line.quantity} ${UNIT_LABEL[line.unit]}`,
      )
      .join('\n')

    // The per-property heading, always, even for a single-property order. A
    // provider who sometimes gets a heading and sometimes does not has to read
    // the message to find out which — and the one time they misread it, the
    // linen goes to the wrong house.
    blocks.push(
      `${property.name} — עד ${readable(property.requiredBy)}\n${lines}`,
    )
  }

  if (view.notes.length > 0) {
    blocks.push(view.notes.map((note) => `הערה: ${note}`).join('\n'))
  }

  if (!terse) {
    const contact =
      view.contactName !== null && view.contactPhone !== null
        ? `לשאלות: ${view.contactName}, ${view.contactPhone}`
        : view.contactPhone !== null
          ? `לשאלות: ${view.contactPhone}`
          : null

    if (contact !== null) blocks.push(contact)
    blocks.push('תודה!')
  }

  return blocks.join('\n\n')
}

/** A date a person reads, without a formatter whose output moves by machine. */
function readable(instant: string): string {
  const day = isoDay(instant)
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return instant
  const time = (at.toISOString().split('T')[1] ?? '').split('.')[0] ?? ''
  return `${day} ${time}`.trim()
}

// ── The guarantee, as a checkable function ────────────────────────────────

/**
 * Field names that must never appear in a rendered provider message.
 *
 * Kept as data so `message.test.ts` and any future caller assert against one
 * list rather than two, in the same spirit as `containsFinancialField` in
 * `src/lib/preparation/cleaner-view.ts` — which made this argument first for
 * the cleaner's plan, and made it correctly.
 *
 * This is a *belt* over the braces. The schema has no such column and the view
 * has no such field, so a hit here means somebody built a view by hand from a
 * booking, and the test that calls it is what stops that reaching a customer.
 */
export const FORBIDDEN_IN_PROVIDER_MESSAGE: readonly string[] = [
  'guestName',
  'guestPhone',
  'guestEmail',
  'price',
  'total',
  'amount',
  'agorot',
  'paymentStatus',
  'deposit',
  'agentId',
  'agencyName',
  'bookingId',
]

/**
 * Does this object carry anything a provider must not see.
 *
 * Walks nested objects and arrays, because a view assembled by hand nests, and
 * returns the paths rather than a boolean so the failure names them.
 */
export function containsProviderForbiddenField(
  value: unknown,
  path = '',
): readonly string[] {
  if (value === null || typeof value !== 'object') return []

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      containsProviderForbiddenField(entry, `${path}[${index}]`),
    )
  }

  const found: string[] = []

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path.length === 0 ? key : `${path}.${key}`

    if (
      FORBIDDEN_IN_PROVIDER_MESSAGE.some((forbidden) =>
        key.toLowerCase().includes(forbidden.toLowerCase()),
      )
    ) {
      found.push(here)
    }

    found.push(...containsProviderForbiddenField(entry, here))
  }

  return found
}
