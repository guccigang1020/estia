/**
 * What an agent may reach, expressed so that nonsense cannot be written down.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 *
 * `roles.ts` already models the three ordered questions as ladders, and that
 * settles the *within-ladder* incoherence: choosing `net` grants `agent` and
 * `public` beneath it, so "holds the net rate but not the public rate" — which
 * is nobody's intention and one misclick away from a checkbox grid — cannot be
 * produced.
 *
 * It does not settle the *between-ladder* incoherence, and that is the one that
 * leaks. Three combinations are not opinions, they are mistakes:
 *
 *   · a calendar level of `none` with any visible price. A referral agent who
 *     brings a name and never sees the diary has no screen a price could
 *     appear on, so a price level on that record is a grant waiting for
 *     somebody to build the screen that honours it;
 *   · free/busy with a price. The price rung sits *above* the availability
 *     rung on the same ladder — a business that wants prices chooses the rung
 *     that has them, and a record saying otherwise disagrees with itself;
 *   · guest data for a seller who cannot make a booking. There is no guest to
 *     see until this agent's own booking exists.
 *
 * ── What is done about it ─────────────────────────────────────────────────
 *
 * `AgentAccess` is a **discriminated union keyed on the calendar rung**, and
 * each variant admits only the price and guest-data levels that are coherent
 * with that rung. The incoherent combinations are therefore not values this
 * program can hold — `{ calendar: 'none', price: 'net' }` does not typecheck,
 * anywhere, including in the tests that try it on purpose.
 *
 * That is a stronger claim than validation. A validator is a function somebody
 * has to remember to call, on a path somebody has to remember exists; the
 * seeding script, the import, the admin repair query and the migration all
 * bypass it. A union that cannot be instantiated is enforced by the compiler on
 * every path at once.
 *
 * The one path a compiler cannot reach is the database, which hands back
 * `unknown`. `parseAgentAccess` is the single door from there into this type,
 * and it rebuilds the value through the same union rather than casting into it.
 *
 * ── And still no `agent.type` ─────────────────────────────────────────────
 *
 * The four presets in the specification are *seed values* of this type and
 * nothing else. Nothing is stored saying which preset was chosen and no code
 * asks. `AGENT_PRESETS` below is a table of starting positions; the moment an
 * owner edits one, the preset it came from stops being true, and there is no
 * field left holding the stale answer.
 */

import type { Grant } from '../authz/permissions'
import {
  AGENT_BASE,
  AMENDMENT_GRANTS,
  CALENDAR_LEVELS,
  GUEST_DATA_LEVELS,
  PRICE_LEVELS,
  grantsForCalendarLevel,
  grantsForGuestDataLevel,
  grantsForPriceLevel,
  grantsForSystemRole,
  type CalendarLevel,
  type GuestDataLevel,
  type PriceLevel,
  type SystemRole,
} from '../authz/roles'

// ── The rungs, as this module constrains them ─────────────────────────────

/**
 * Every price rung except "none".
 *
 * Named because the whole cross-ladder rule is expressible as: from the price
 * rung of the calendar ladder upward, a price level is required and cannot be
 * `none`; below it, `none` is the only one permitted.
 */
export type VisiblePriceLevel = Exclude<PriceLevel, 'none'>

/**
 * The booking amendments, which are deliberately not a ladder.
 *
 * No ordering between them is true: a business may let an agent move dates and
 * never touch money, or exactly the reverse. They are therefore a set, and each
 * is granted on its own. `roles.ts` says the same thing about the same rights,
 * and this is the agent-facing name for choosing among them.
 */
export const AGENT_AMENDMENTS = [
  'guest_details',
  'guest_count',
  'extras',
  'dates',
  'price',
] as const

export type AgentAmendment = (typeof AGENT_AMENDMENTS)[number]

const AMENDMENT_GRANT: Record<AgentAmendment, Grant> = {
  guest_details: 'guest.update',
  guest_count: 'booking.amend_guest_count',
  extras: 'booking.amend_extras',
  dates: 'booking.amend_dates',
  price: 'booking.amend_price',
}

export const AGENT_AMENDMENT_LABEL: Record<AgentAmendment, string> = {
  guest_details: 'עריכת פרטי אורח',
  guest_count: 'שינוי מספר אורחים',
  extras: 'הוספת תוספות',
  dates: 'שינוי תאריכים',
  price: 'שינוי מחיר',
}

/**
 * When this agent may cancel their own booking.
 *
 * Four states rather than a boolean, because "never" and "until the money
 * arrives" and "up to N hours before arrival" and "ask a manager" are four
 * different commercial postures and a business picks one deliberately. The
 * conservative default is `never`.
 */
export type AgentCancellationPolicy =
  | { kind: 'never' }
  | { kind: 'until_paid' }
  | { kind: 'hours_before_arrival'; hours: number }
  | { kind: 'requires_approval' }

export const AGENT_CANCELLATION_KINDS = [
  'never',
  'until_paid',
  'hours_before_arrival',
  'requires_approval',
] as const

// ── The union ─────────────────────────────────────────────────────────────

/**
 * Rights that exist only once an agent can make a booking, stated as absent
 * below that rung.
 *
 * `?: never` rather than simple omission. Omission would let an object literal
 * carrying `amendments` be assigned to a lower variant — TypeScript's excess
 * property check tests a literal against the *union*, so a key belonging to any
 * one member is tolerated on all of them. Declaring the key as `never` refuses
 * the value instead of ignoring it, which is the difference between a rule and
 * a hope.
 */
interface WithoutBookingRights {
  readonly amendments?: never
  readonly cancellation?: never
  readonly paymentLink?: never
}

/** Leads only. No diary, no price, no guest. */
export interface AgentAccessNone extends WithoutBookingRights {
  readonly calendar: 'none'
  readonly price: 'none'
  readonly guestData: 'none'
}

/** Free/busy, and nothing else at all. */
export interface AgentAccessAvailability extends WithoutBookingRights {
  readonly calendar: 'availability'
  readonly price: 'none'
  readonly guestData: 'none'
}

/** Free/busy and a price to quote. Which price is the price ladder's answer. */
export interface AgentAccessPricing extends WithoutBookingRights {
  readonly calendar: 'availability_price'
  readonly price: VisiblePriceLevel
  readonly guestData: 'none'
}

/** The above, plus holding dates while a deal closes. */
export interface AgentAccessHolding extends WithoutBookingRights {
  readonly calendar: 'availability_hold'
  readonly price: VisiblePriceLevel
  readonly guestData: 'none'
}

/**
 * The full seller.
 *
 * The only rung where guest data is a question at all, and the only one where
 * amendments, cancellation and payment links exist — a business that grants
 * this rung has to decide all three rather than inherit a default, which is why
 * they are required properties and not optional ones.
 */
export interface AgentAccessBooking {
  readonly calendar: 'availability_booking'
  readonly price: VisiblePriceLevel
  readonly guestData: GuestDataLevel
  readonly amendments: readonly AgentAmendment[]
  readonly cancellation: AgentCancellationPolicy
  readonly paymentLink: boolean
}

export type AgentAccess =
  | AgentAccessNone
  | AgentAccessAvailability
  | AgentAccessPricing
  | AgentAccessHolding
  | AgentAccessBooking

/** True when this agent can be asked about a booking at all. */
export function canBook(access: AgentAccess): access is AgentAccessBooking {
  return access.calendar === 'availability_booking'
}

export function canHold(access: AgentAccess): boolean {
  return (
    access.calendar === 'availability_hold' ||
    access.calendar === 'availability_booking'
  )
}

export function canSeeAvailability(access: AgentAccess): boolean {
  return access.calendar !== 'none'
}

// ── Resolving to grants ───────────────────────────────────────────────────

/**
 * What every external seller holds whatever their rung: the leads they bring
 * and their own pay.
 *
 * Confined to their own records by the membership's scope rather than by a
 * different permission — the same `commission.view` serves a finance manager
 * reading the whole network and an agent reading one line, because the scope
 * answers "whose".
 *
 * This used to be a hand-copied second list beside `AGENT_BASE` in `roles.ts`,
 * and the two had already drifted: `approval.request` was added there and not
 * here, so an agent resolving through this module could not raise the discount
 * approval the whole flow depends on. The copy is gone — it is the same
 * constant now, re-exported under the name this module's callers use.
 */
export const AGENT_BASELINE_GRANTS: readonly Grant[] = AGENT_BASE

/**
 * The flat grant set for a position on the ladders.
 *
 * The three ladders are resolved by `roles.ts`, not re-implemented here: a
 * second definition of what `net` includes would disagree with the first within
 * a month, and the disagreement would be a rate visible to somebody who was
 * never given it.
 *
 * The engine never learns any of this. What comes out is a set of grants, and
 * `can()` sees exactly what it always sees.
 */
export function grantsForAgentAccess(access: AgentAccess): Set<Grant> {
  const grants = new Set<Grant>(AGENT_BASELINE_GRANTS)

  for (const grant of grantsForCalendarLevel(access.calendar)) grants.add(grant)
  for (const grant of grantsForPriceLevel(access.price)) grants.add(grant)
  for (const grant of grantsForGuestDataLevel(access.guestData)) {
    grants.add(grant)
  }

  if (canBook(access)) {
    for (const amendment of access.amendments) {
      grants.add(AMENDMENT_GRANT[amendment])
    }
    // `requires_approval` still grants the right: the request is made through
    // the cancellation itself, which is then held rather than applied. A grant
    // withheld here would make the approval path unreachable.
    if (access.cancellation.kind !== 'never') grants.add('booking.cancel')
    if (access.paymentLink) grants.add('payment.request_link')
  }

  return grants
}

/**
 * Every grant an `AgentAccess` is capable of deciding, at any position.
 *
 * The top of each ladder, plus the three booking-rung switches. Read it as the
 * *surface of the settings screen*: `agent.access.update` writes exactly this
 * union and nothing else, so these are the grants an owner is entitled to
 * expect a narrowing to actually remove.
 *
 * Computed from the ladders rather than listed, so a rung added to `roles.ts`
 * next year joins this set without anybody remembering to.
 */
export const AGENT_LADDER_CONTROLLED_GRANTS: ReadonlySet<Grant> =
  new Set<Grant>([
    ...grantsForCalendarLevel(CALENDAR_LEVELS[CALENDAR_LEVELS.length - 1]),
    ...grantsForPriceLevel(PRICE_LEVELS[PRICE_LEVELS.length - 1]),
    ...grantsForGuestDataLevel(GUEST_DATA_LEVELS[GUEST_DATA_LEVELS.length - 1]),
    ...AMENDMENT_GRANTS,
    'booking.cancel',
    'payment.request_link',
  ])

/**
 * The agent's membership, as the actor resolver consumes it.
 *
 * A **custom** role assignment, deliberately, and not one of the four system
 * roles. A system role would be re-resolved from the catalogue on every
 * request, which would silently undo every edit the owner made to the ladders —
 * and the specification's central promise is that a preset stays editable after
 * it is chosen. Carrying the resolved grants makes the stored ladders
 * authoritative, which is what "there is no `agent.type`" means in practice.
 *
 * ── `seededRoles`, and why the projection is not the whole answer ─────────
 *
 * An agent's membership was given one of the four preset system roles when
 * they were admitted, and those roles carry more than the ladders can express:
 * `lead.update` for a sales agent, `booking.view_payment_status` for a senior
 * one, and for an agency manager the running of the agents underneath it —
 * `agent.view`, `agent.invite`, `agent_agreement.view`, `report.agent.view`,
 * `lead.assign`. None of those has a field on `AgentAccess`, no screen edits
 * them, and a projection that dropped them would silently uninstall the agency
 * feature the day this wiring landed.
 *
 * So the seeded role is **replaced in the part the owner controls and kept in
 * the part they do not**:
 *
 *     (what the role grants, minus everything the ladders can decide)
 *   ∪ (what the stored ladders decide right now)
 *
 * Everything on the settings screen is therefore live, and everything that is
 * not on the settings screen is unchanged. Pass no roles and this is the pure
 * ladder projection, which is what a caller with no membership in hand wants.
 *
 * Shaped as `RoleAssignment` from `actor/source.ts` without importing it: this
 * module has no business depending on the actor layer to describe its own
 * output, and the shape is checked structurally where the two meet.
 */
export function agentRoleAssignment(
  access: AgentAccess,
  seededRoles: readonly SystemRole[] = [],
): {
  code: string
  kind: 'custom'
  grants: readonly Grant[]
} {
  const grants = grantsForAgentAccess(access)

  for (const role of seededRoles) {
    for (const grant of grantsForSystemRole(role)) {
      if (!AGENT_LADDER_CONTROLLED_GRANTS.has(grant)) grants.add(grant)
    }
  }

  return { code: 'agent', kind: 'custom', grants: [...grants] }
}

// ── The four presets ──────────────────────────────────────────────────────

/**
 * Starting positions, not types.
 *
 * An owner picks one instead of facing forty toggles, and then edits it. What
 * is stored afterwards is an `AgentAccess`, never the name of the preset — so
 * no code can ask "is this a senior agent?" and no manual edit can be
 * contradicted by an `if` somewhere downstream.
 */
export const AGENT_PRESET_NAMES = [
  'referral',
  'sales',
  'senior',
  'agency',
] as const

export type AgentPresetName = (typeof AGENT_PRESET_NAMES)[number]

export const AGENT_PRESET_LABEL: Record<AgentPresetName, string> = {
  referral: 'סוכן הפניות',
  sales: 'סוכן מכירות',
  senior: 'סוכן בכיר',
  agency: 'סוכנות מורשית',
}

export const AGENT_PRESETS = {
  /** Brings a lead and is paid if it closes. Never sees the diary. */
  referral: { calendar: 'none', price: 'none', guestData: 'none' },

  /**
   * The main model. Sees what is free, quotes it, holds it, books it — and
   * still no guest, because none of that is needed to sell a night that is
   * free.
   */
  sales: {
    calendar: 'availability_booking',
    price: 'agent',
    guestData: 'none',
    amendments: [],
    cancellation: { kind: 'never' },
    paymentLink: false,
  },

  /** Trusted with the booking after it exists, and with a payment link. */
  senior: {
    calendar: 'availability_booking',
    price: 'agent',
    guestData: 'none',
    amendments: ['guest_details', 'guest_count', 'extras', 'price'],
    cancellation: { kind: 'hours_before_arrival', hours: 48 },
    paymentLink: true,
  },

  /** The broadest preset, and still narrow. The net rate, and the guest's phone. */
  agency: {
    calendar: 'availability_booking',
    price: 'net',
    guestData: 'phone',
    amendments: ['guest_details', 'guest_count', 'extras', 'dates', 'price'],
    cancellation: { kind: 'hours_before_arrival', hours: 24 },
    paymentLink: true,
  },
} as const satisfies Record<AgentPresetName, AgentAccess>

/**
 * The role a preset seeds the *membership* with.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * Everything above describes what an agent may see. None of it reaches the
 * authorization engine on its own: an actor is built from `membership_roles`,
 * so a membership created with no role in that table resolves with no grants
 * whatsoever. The agent signs in, every screen is empty, and nothing in the
 * record says why. Choosing a preset therefore has to assign a role in the
 * same act as creating the membership, and this table is the mapping used to
 * do it.
 *
 * ── Why a system role and not a role built from the ladders ───────────────
 *
 * The four codes below are the ones `roles.ts` composes from the same three
 * ladders as `AGENT_PRESETS`, seeded globally by `0012`, so the grants a new
 * agent starts with are the grants the chosen preset describes.
 *
 * The alternative — minting a custom role per agent whose `role_permissions`
 * are `grantsForAgentAccess(access)` — would be closer to this module's
 * intent, because the stored ladders would then stay authoritative after an
 * owner edits them. It is not what is written here, for one blunt reason:
 * `role_permissions_insert` requires `permission.edit`, which is owner-only,
 * so a general manager adding an agent could not create the role and the
 * feature would be unusable by the role that owns it. Assigning an existing
 * system role needs only `role.assign`.
 *
 * ── What the row means now that resolution projects it ───────────────────
 *
 * It used to mean everything: a system role is re-resolved from the catalogue
 * on every request, so an owner who narrowed `access` afterwards narrowed what
 * the agent *screens* showed and did not narrow the membership's grants. The
 * settings screen said one thing and the engine did another, and the
 * disagreement pointed the wrong way — an intended narrowing that never took
 * effect.
 *
 * `SupabaseActorSource.loadRoles` now replaces one of these four codes with
 * `agentActorRoleAssignments(access, [code])` whenever the membership has
 * stored terms. What the row still decides is the part of the preset the
 * ladders cannot express — `lead.update`, `booking.view_payment_status`, the
 * agency manager's own network rights — and what it no longer decides is
 * anything the settings screen can edit. Deleting the row instead would take
 * those with it; see `agentRoleAssignment` above for the split.
 */
export const AGENT_PRESET_ROLE: Record<AgentPresetName, SystemRole> = {
  referral: 'referral_agent',
  sales: 'sales_agent',
  senior: 'senior_agent',
  agency: 'agency_manager',
}

/**
 * The four codes as a set, for the one question actor resolution asks:
 * *is this assignment a seeded agent preset, and therefore the thing the
 * stored ladders are entitled to speak for?*
 *
 * Derived from the table above so a fifth preset cannot be added without the
 * resolver learning about it — which would otherwise produce an agent whose
 * screen edits silently did nothing, i.e. this gap again.
 */
export const AGENT_PRESET_ROLE_CODES: ReadonlySet<SystemRole> =
  new Set<SystemRole>(Object.values(AGENT_PRESET_ROLE))

/** Narrow a `roles.code` to one of the four, or `null`. */
export function asAgentPresetRole(code: string): SystemRole | null {
  return AGENT_PRESET_ROLE_CODES.has(code as SystemRole)
    ? (code as SystemRole)
    : null
}

// ── The one door from untyped data ────────────────────────────────────────

/**
 * Rebuild an `AgentAccess` from a row, or refuse.
 *
 * The compiler guards every path inside the program; this guards the one path
 * it cannot see. It **reconstructs** rather than casts — each variant is built
 * field by field from validated pieces — so a row written before this rule
 * existed, or repaired by hand in a console, cannot smuggle an incoherent
 * combination back in behind an assertion.
 *
 * Deny by default: anything unrecognised produces `null`, and a caller reading
 * `null` refuses the agent rather than falling back to a permissive default.
 */
export function parseAgentAccess(value: unknown): AgentAccess | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>

  const calendar = row.calendar
  const price = row.price
  const guestData = row.guestData

  if (!isCalendarLevel(calendar)) return null
  if (!isPriceLevel(price)) return null
  if (!isGuestDataLevel(guestData)) return null

  switch (calendar) {
    case 'none':
      if (price !== 'none' || guestData !== 'none') return null
      return { calendar: 'none', price: 'none', guestData: 'none' }

    case 'availability':
      if (price !== 'none' || guestData !== 'none') return null
      return { calendar: 'availability', price: 'none', guestData: 'none' }

    case 'availability_price':
      if (price === 'none' || guestData !== 'none') return null
      return { calendar: 'availability_price', price, guestData: 'none' }

    case 'availability_hold':
      if (price === 'none' || guestData !== 'none') return null
      return { calendar: 'availability_hold', price, guestData: 'none' }

    case 'availability_booking': {
      if (price === 'none') return null
      const amendments = parseAmendments(row.amendments)
      const cancellation = parseCancellation(row.cancellation)
      if (amendments === null || cancellation === null) return null
      if (typeof row.paymentLink !== 'boolean') return null
      return {
        calendar: 'availability_booking',
        price,
        guestData,
        amendments,
        cancellation,
        paymentLink: row.paymentLink,
      }
    }

    default:
      return null
  }
}

const CALENDAR_SET: ReadonlySet<string> = new Set<CalendarLevel>([
  'none',
  'availability',
  'availability_price',
  'availability_hold',
  'availability_booking',
])

const PRICE_SET: ReadonlySet<string> = new Set<PriceLevel>([
  'none',
  'public',
  'agent',
  'net',
  'net_commission',
])

const GUEST_DATA_SET: ReadonlySet<string> = new Set<GuestDataLevel>([
  'none',
  'name',
  'phone',
  'email',
])

function isCalendarLevel(value: unknown): value is CalendarLevel {
  return typeof value === 'string' && CALENDAR_SET.has(value)
}

function isPriceLevel(value: unknown): value is PriceLevel {
  return typeof value === 'string' && PRICE_SET.has(value)
}

function isGuestDataLevel(value: unknown): value is GuestDataLevel {
  return typeof value === 'string' && GUEST_DATA_SET.has(value)
}

const AMENDMENT_SET: ReadonlySet<string> = new Set<string>(AGENT_AMENDMENTS)

function parseAmendments(value: unknown): readonly AgentAmendment[] | null {
  if (!Array.isArray(value)) return null
  const amendments: AgentAmendment[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !AMENDMENT_SET.has(entry)) return null
    // Duplicates are dropped rather than refused: a repeated grant is the same
    // grant, and refusing the row would lock an agent out over a cosmetic flaw.
    if (!amendments.includes(entry as AgentAmendment)) {
      amendments.push(entry as AgentAmendment)
    }
  }
  return amendments
}

function parseCancellation(value: unknown): AgentCancellationPolicy | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>

  switch (row.kind) {
    case 'never':
      return { kind: 'never' }
    case 'until_paid':
      return { kind: 'until_paid' }
    case 'requires_approval':
      return { kind: 'requires_approval' }
    case 'hours_before_arrival': {
      const hours = row.hours
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
        return null
      }
      return { kind: 'hours_before_arrival', hours }
    }
    default:
      return null
  }
}

/**
 * ── The note that used to be here, and what became of it ──────────────────
 *
 * It asked `roles.ts` to export `AGENT_BASE` so this module could delete its
 * hand-copied second list, and warned that two lists of what every external
 * seller holds would drift. They had already: `approval.request` was in one
 * and not the other, so an agent resolving through this module could not raise
 * the discount approval that keeps a negotiation inside the product.
 *
 * `AGENT_BASE` is exported now and `AGENT_BASELINE_GRANTS` is that constant
 * rather than a copy of it, which is why the drift is not a bug that has to be
 * found again — there is one list.
 */
