/**
 * What an owner may see. The file the rest of this module exists to protect.
 *
 * ══ THE SITUATION ══════════════════════════════════════════════════════════
 *
 * A property owner is an **outside party who can sign in**. They are not an
 * employee with a narrow role; they are a third party with their own lawyer,
 * their own accountant, and — this is the part that bites — frequently their
 * own competing rental business two streets away. What leaks to them does not
 * leak to somebody who is on the same side.
 *
 * Two things must hold, and they are different in kind:
 *
 *   1. **They see their property and nothing else.** Not another owner's
 *      villa, and not the same villa's statement addressed to a co-owner. This
 *      is a tenant-isolation-class concern with a human on the other end.
 *   2. **Within their property they see money and occupancy, and never the
 *      guest.** No name, no telephone, no email; and not the agent who sold the
 *      night or what that agent earned, which is the business's commercial
 *      relationship and not the owner's.
 *
 * ── Three mechanisms, because one is not enough ───────────────────────────
 *
 * **The type system.** `OwnerBookingView` declares every forbidden key as
 * `?: never`. That is not decoration — TypeScript's excess-property check tests
 * an object literal against the whole type, so a key merely *omitted* would be
 * tolerated on a literal that carried it. `?: never` refuses the value. A
 * screen cannot construct an owner-facing booking row holding a guest name,
 * anywhere, including in a test that tries on purpose.
 *
 * **A runtime sweep.** `assertNoGuestIdentity` walks the whole object graph of
 * anything about to be handed to an owner and throws on a forbidden key. The
 * type system cannot see a value that arrived from PostgREST as `unknown`, or
 * one widened through a `Record<string, unknown>`; this can. It is an
 * `InternalError` — a 500 — because a guest name reaching this point is a
 * defect in ESTIA and never something a user did, and failing loudly is
 * strictly better than rendering it.
 *
 * **One door.** `ownerStatementView` is the only function that returns a
 * statement shaped for a reader, and it performs the isolation check, the
 * redaction and the sweep in that order. A screen that wants a statement has
 * no other way to obtain one, so "the screens cannot bypass the redaction" is
 * a fact about the module surface rather than a rule in a document.
 *
 * ── Why the default is the tightest, for everyone ─────────────────────────
 *
 * A tempting design asks "is this reader an external owner?" and redacts only
 * then. It fails the first time the answer is computed wrongly — and the
 * failure direction is a leak. So the question is never asked. **Every** reader
 * gets the redacted statement unless they hold `owner.view_commission`, which
 * is the grant the catalogue already defines for exactly this and which the
 * `property_owner` role deliberately does not carry. Getting the widening wrong
 * hides a number from a finance manager; getting the narrowing wrong would show
 * an outsider what the business pays its agents.
 */

import { can, holdsGrant, type Actor, type Resource } from '../authz/can'
import type { Agorot } from '../booking/types'
import { InternalError } from '../errors'
import type {
  OwnerStatement,
  OwnerStatementLine,
  PropertyOwner,
  PropertyOwnership,
} from './types'

// ── The forbidden surface ─────────────────────────────────────────────────

/**
 * Key prefixes that may never appear in anything handed to an owner.
 *
 * Prefixes rather than exact names, so `guestName`, `guest_phone`,
 * `guestBookEntryId` and next year's `guestDocumentNumber` are all refused
 * without anybody remembering to add them. The cost is that a legitimate field
 * may not begin with one of these words, which is a cost worth paying: an
 * owner-facing payload has no business carrying a field called `agentAnything`.
 */
const FORBIDDEN_KEY_PREFIXES: readonly string[] = [
  'guest',
  'agent',
  'agency',
  'commission',
  'contact',
  'customer',
]

/**
 * Exact keys that do not start with a forbidden word and are still identity.
 *
 * `email` and `phone` are the two that matter. An owner statement carrying a
 * bare `email` is carrying somebody's email, and which somebody is not a
 * question the sweep should have to answer correctly to be safe.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'email',
  'phone',
  'phoneE164',
  'telephone',
  'mobile',
  'fullName',
  'firstName',
  'lastName',
  'documentId',
  'passportNumber',
  'nationalId',
  'soldBy',
  'bookedBy',
])

/**
 * The one field this module carries that is *about* commission and is allowed.
 *
 * `salesCommissionAgorot` does not begin with `commission`, so it passes the
 * prefix rule, and that is deliberate rather than lucky: it is a period
 * aggregate for one property which names no agent and identifies nobody, and it
 * is separately withheld from a reader without `owner.view_commission` by
 * `redactStatement` below. A field named `commissionAgorot` would be refused
 * here, which is the right answer — a bare commission figure on an owner-facing
 * payload has not been through that check.
 */
function isForbiddenKey(key: string): boolean {
  if (FORBIDDEN_KEYS.has(key)) return true

  const normalised = key.toLowerCase()
  return FORBIDDEN_KEY_PREFIXES.some((prefix) => normalised.startsWith(prefix))
}

/** Anything that reads as an address rather than a reference. */
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Refuse to hand an owner anything carrying identity.
 *
 * Walks the graph and collects **every** offending path before throwing, for
 * the same reason the schema validator collects every field issue: an engineer
 * who fixes one leak, reruns, and finds a second has been told the truth
 * slowly.
 *
 * Value inspection is deliberately limited to the email shape. A phone-number
 * heuristic would refuse a legitimate bank reference or an invoice number, and
 * a sweep that fails on correct data is a sweep somebody disables.
 */
export function assertNoGuestIdentity(value: unknown, label: string): void {
  const offences: string[] = []
  visit(value, label, offences, new WeakSet())

  if (offences.length === 0) return

  throw new InternalError({
    message:
      `Owner-facing payload '${label}' carries identity that an outside ` +
      `property owner must never receive: ${offences.join(', ')}`,
  })
}

function visit(
  value: unknown,
  path: string,
  offences: string[],
  seen: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    if (EMAIL_SHAPED.test(value)) offences.push(`${path} (email address)`)
    return
  }

  if (typeof value !== 'object' || value === null) return

  // A cycle is not a leak, and following one forever would turn this guard
  // into a hang — which is a worse failure than the one it prevents.
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visit(entry, `${path}[${index}]`, offences, seen)
    })
    return
  }

  for (const [key, entry] of Object.entries(value)) {
    const child = `${path}.${key}`
    if (isForbiddenKey(key)) {
      offences.push(child)
      continue
    }
    visit(entry, child, offences, seen)
  }
}

// ── Occupancy without the guest ───────────────────────────────────────────

/**
 * Fields an owner-facing row may never declare.
 *
 * `?: never` and not omission. See the header: omitting the keys would let an
 * object literal carrying `guestName` be assigned here, because the excess
 * property check is satisfied by any member of the type. Declaring them as
 * `never` refuses the value, which is the difference between a rule and a hope.
 */
interface WithoutIdentity {
  readonly guestId?: never
  readonly guestName?: never
  readonly guestPhone?: never
  readonly guestEmail?: never
  readonly guestCount?: never
  readonly agentUserId?: never
  readonly agentName?: never
  readonly agencyId?: never
  readonly agentCommissionAgorot?: never
  readonly bookedBy?: never
  readonly soldBy?: never
}

/**
 * One stay, as an owner is shown it: when the unit was occupied and what it
 * earned.
 *
 * There is no guest here and there is no channel here. Which platform sold the
 * night is the business's distribution strategy — an owner who learns that 70%
 * of their nights come from one channel is one telephone call away from listing
 * the villa there themselves.
 */
export interface OwnerBookingView extends WithoutIdentity {
  bookingId: string
  unitId: string
  /** Property-local ISO dates. */
  arrival: string
  departure: string
  nights: number
  grossRevenueAgorot: Agorot
}

/**
 * A row the owner view is projected from.
 *
 * The index signature is the point: a caller may hand this the widest row they
 * have, guest and all, and nothing but the six named fields can come out the
 * other side. That makes the projection itself the redaction, rather than a
 * step somebody performs beforehand and can forget.
 */
export interface OwnerOccupancySource {
  bookingId: string
  unitId: string
  arrival: string
  departure: string
  nights: number
  grossRevenueAgorot: Agorot
  [key: string]: unknown
}

export function ownerBookingView(
  source: OwnerOccupancySource,
): OwnerBookingView {
  return {
    bookingId: source.bookingId,
    unitId: source.unitId,
    arrival: source.arrival,
    departure: source.departure,
    nights: source.nights,
    grossRevenueAgorot: source.grossRevenueAgorot,
  }
}

// ── Isolation ─────────────────────────────────────────────────────────────

function ownerResource(organizationId: string, propertyId: string): Resource {
  // `finance`, so a membership that narrows its financial reach separately from
  // its operational one is honoured. `scopeFor` falls back to the default scope
  // for anybody who has set no override, which is almost everybody.
  return { organizationId, propertyId, family: 'finance' }
}

/**
 * Is this reader an insider, or the outside party themselves?
 *
 * `owner.view` is the right question and not `property_owner`-the-role. The
 * role is a seed a customer may copy and edit, and asking for it by name would
 * be answered wrongly the first time somebody composed their own; `owner.view`
 * is "may read the register of owners", which is an internal capability by
 * construction and which the `property_owner` role deliberately does not hold.
 */
export function isExternalOwner(actor: Actor): boolean {
  return !holdsGrant(actor, 'owner.view')
}

/**
 * May this actor read this statement at all?
 *
 * Three questions, and none of them is skippable:
 *
 *   1. The grant, which also settles the plan — `owner_statement.view` is gated
 *      on `owner_portal`, so a package without it answers no here.
 *   2. Tenant and scope, asked of the engine against the property the statement
 *      names. A `property_owner` membership scoped to one villa fails this for
 *      every other villa without this module knowing how scope works.
 *   3. **Whose statement it is.** This is the one that scope alone cannot
 *      answer. Two people may each own half of the same villa and each be
 *      scoped to it; without this check the first could read the second's
 *      statement, learn their share and their balance, and the isolation would
 *      have held perfectly at the property level while leaking at the level
 *      that matters.
 *
 * An insider — anybody holding `owner.view` — is exempt from (3) and from
 * nothing else. A finance manager whose job is issuing these documents must be
 * able to read the ones they issued.
 */
export function canReadOwnerStatement(
  actor: Actor,
  owner: PropertyOwner,
  statement: OwnerStatement,
): boolean {
  if (!holdsGrant(actor, 'owner_statement.view')) return false

  if (
    !can(
      actor,
      'owner_statement.view',
      ownerResource(statement.organizationId, statement.propertyId),
    )
  ) {
    return false
  }

  if (!isExternalOwner(actor)) return true

  // The outside party may read their own and only their own. An owner record
  // with no account cannot be read by anybody external, which is correct:
  // there is nobody to be them.
  return owner.id === statement.ownerId && owner.userId === actor.userId
}

/** The properties this actor may be shown, out of an owner's portfolio. */
export function visibleOwnerships(
  actor: Actor,
  owner: PropertyOwner,
  ownerships: readonly PropertyOwnership[],
): readonly PropertyOwnership[] {
  if (!holdsGrant(actor, 'owner_statement.view')) return []

  const external = isExternalOwner(actor)
  if (external && owner.userId !== actor.userId) return []

  return ownerships.filter(
    (ownership) =>
      ownership.ownerId === owner.id &&
      can(
        actor,
        'owner_statement.view',
        ownerResource(ownership.organizationId, ownership.propertyId),
      ),
  )
}

// ── Redaction ─────────────────────────────────────────────────────────────

/**
 * Fold the commission away for a reader who may not see it.
 *
 * A **merge**, never a subtraction. The commission's amount moves into the fees
 * line rather than disappearing, so the section still adds to the same owner
 * share and the owner is not shown a column that does not tie out. The line
 * that absorbs it is given its own key and its own Hebrew label — `deductions`,
 * not `fees` — because presenting two different amounts under one label to two
 * readers is how a support call becomes an accusation.
 *
 * `withheld` names what was folded, so the screen can say a figure has been
 * combined instead of leaving the reader to discover it.
 */
function redactStatement(
  actor: Actor,
  statement: OwnerStatement,
): OwnerStatement {
  if (holdsGrant(actor, 'owner.view_commission')) return statement

  const deductionsAgorot =
    statement.feesAgorot + (statement.salesCommissionAgorot ?? 0)

  const resultLines: OwnerStatementLine[] = statement.resultLines
    .filter((line) => line.key !== 'sales_commission')
    .map((line) =>
      line.key === 'fees'
        ? {
            key: 'deductions',
            label: 'ניכויים ועמלות',
            amountAgorot: -deductionsAgorot,
            kind: line.kind,
          }
        : line,
    )

  return {
    ...statement,
    feesAgorot: deductionsAgorot,
    salesCommissionAgorot: null,
    resultLines,
    withheld: [...statement.withheld, 'sales_commission'],
  }
}

/**
 * The one door. A statement shaped for this reader, or `null`.
 *
 * `null` and not a throw: a list of statements is filtered through this, and a
 * reader who may see two of five should be shown two rather than an error. A
 * route that expected one and got `null` renders its own refusal, which is the
 * page's decision and not this function's.
 */
export function ownerStatementView(
  actor: Actor,
  owner: PropertyOwner,
  statement: OwnerStatement,
): OwnerStatement | null {
  if (!canReadOwnerStatement(actor, owner, statement)) return null

  const view = redactStatement(actor, statement)

  // Last line of defence, and it runs for every reader including insiders. A
  // field added to `OwnerStatement` next year that happens to carry identity
  // fails here rather than on a document that has already been posted.
  assertNoGuestIdentity(view, `owner statement ${statement.id}`)

  return view
}

/** The same door, for a list. Rows this reader may not see simply are not in it. */
export function ownerStatementViews(
  actor: Actor,
  owner: PropertyOwner,
  statements: readonly OwnerStatement[],
): readonly OwnerStatement[] {
  const views: OwnerStatement[] = []
  for (const statement of statements) {
    const view = ownerStatementView(actor, owner, statement)
    if (view !== null) views.push(view)
  }
  return views
}
