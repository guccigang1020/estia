/**
 * What the guest journey needs from modules it does not own.
 *
 * ── Why these are ports and not imports ───────────────────────────────────
 *
 * Four capabilities were being written in parallel with this one. **Payment
 * collection has since landed**, its migration is applied, and its port is
 * gone from this file: `collection.ts` imports the real resolver and this
 * module no longer carries a second opinion about what a guest owes. That is
 * the intended end state for every port here — a port is scaffolding with a
 * demolition date, not an abstraction layer worth keeping.
 *
 * The three that remain are still unbuilt against this database, and importing
 * them would be wrong for a reason that outlives today: a screen that imports a
 * reader which selects from a table no migration has created renders a 500 for
 * every guest of every organization. The portal is the one screen in the
 * product reachable by somebody with no account and no support channel, and it
 * must not be the thing that breaks first.
 *
 * ── The null implementations are the honest product, not a stub ───────────
 *
 * Each default below is the correct behaviour for a business that has not
 * configured that capability, which is most businesses on their first day:
 *
 *   store      → not available, so no store card and no dead link.
 *   rebook     → no known free dates, so the screen offers to ASK rather than
 *                inventing a date. The specification is explicit that rebooking
 *                must never present a date that is not actually free, and an
 *                empty answer honours that where a guess would not.
 *   messaging  → `copy` only, which is a complete and honest answer: a business
 *                with no WhatsApp integration pastes the message itself.
 *
 * None of them is a disabled button or a "coming soon". A guest never learns
 * that a capability exists somewhere and is missing here.
 */

import type { GuestLinkChannel } from './types'

/** Which booking a port is being asked about. Never a token — see `load.ts`. */
export type GuestPortScope = {
  organizationId: string
  propertyId: string | null
  bookingId: string
}

// ── PORT · the store ──────────────────────────────────────────────────────

/**
 * Whether there is a shop worth linking to.
 *
 * The `store` worker owns `src/app/g/[token]/store` and renders it. All this
 * module needs is whether to show the door, and a count so the card can say
 * something true rather than "לחץ כאן".
 */
export type GuestStoreSummary = {
  available: boolean
  itemCount: number
  /** Where the section lives. Null when there is nothing to link to. */
  href: string | null
}

export type GuestStorePort = {
  summary(scope: GuestPortScope): Promise<GuestStoreSummary>
}

export const NO_STORE_PORT: GuestStorePort = {
  async summary() {
    return { available: false, itemCount: 0, href: null }
  },
}

// ── PORT · availability, for rebooking ────────────────────────────────────

/**
 * Dates the property can actually be sold on.
 *
 * The specification is explicit that rebooking must use real availability and
 * never present a date that is not free. So this port returns ranges that ARE
 * free, and the absence of an answer is rendered as an invitation to ask —
 * never as a calendar the guest could pick a taken night from.
 *
 * Half-open, matching `bookings.stay` and the rest of the product: `end` is the
 * departure date and is itself free for the next guest.
 */
export type GuestOpenRange = {
  /** `YYYY-MM-DD`. */
  start: string
  /** `YYYY-MM-DD`, exclusive. */
  end: string
}

export type GuestRebookPort = {
  openRanges(
    scope: GuestPortScope & { from: string; to: string },
  ): Promise<GuestOpenRange[]>
}

/** Nothing known to be free. The screen offers to ask, and shows no dates. */
export const NO_REBOOK_PORT: GuestRebookPort = {
  async openRanges() {
    return []
  },
}

// ── PORT · messaging integrations ─────────────────────────────────────────

/**
 * Which channels this organization can actually send through.
 *
 * `copy` is always present and is not a fallback. A business with no WhatsApp
 * integration is not a business that cannot send a guest link; it is one whose
 * owner pastes the message into WhatsApp themselves, and the product's job is
 * to hand them a message worth pasting rather than a disabled button.
 */
export type GuestMessagingPort = {
  channels(organizationId: string): Promise<GuestLinkChannel[]>
}

export const COPY_ONLY_MESSAGING_PORT: GuestMessagingPort = {
  async channels() {
    return ['copy']
  },
}

// ── The set of them ───────────────────────────────────────────────────────

export type GuestJourneyPorts = {
  store: GuestStorePort
  rebook: GuestRebookPort
  messaging: GuestMessagingPort
}

/**
 * The shipped defaults.
 *
 * A caller that wires nothing gets a portal that works and offers only what
 * this module can honestly deliver on its own. Replacing one of these is a
 * one-line change at the call site, which is the point of the shape.
 */
export const NULL_GUEST_JOURNEY_PORTS: GuestJourneyPorts = {
  store: NO_STORE_PORT,
  rebook: NO_REBOOK_PORT,
  messaging: COPY_ONLY_MESSAGING_PORT,
}
