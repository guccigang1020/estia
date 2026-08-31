/**
 * Hebrew wording for the distribution vocabularies, and nothing that already
 * has a Hebrew name somewhere else.
 *
 * WHAT IS NOT HERE. `AGENT_PRESET_LABEL`, `AGENT_AMENDMENT_LABEL`,
 * `COMMISSION_BASE_LABEL`, `COMMISSION_STATUS_LABEL`, `HOLD_REASON_LABEL` and
 * the membership-status wording inside `lifecycle.ts` all exist in the domain
 * and are imported from there by the screens in this module. A second Hebrew
 * name for a state that already has one is two names that disagree the first
 * time somebody edits one.
 *
 * WHAT IS HERE is the wording the domain has never needed to print: the rungs
 * of the three access ladders, the shape of an inventory reach, the status of
 * an agency and of an agreement, and the outcome of a quote.
 *
 * THE TEST BESIDE THIS FILE IS THE POINT, exactly as it is for
 * `finance/_lib/labels.ts`: every record below is total over its tuple, so a
 * rung added to `roles.ts` without wording here fails the suite rather than
 * shipping `net_commission` into a Hebrew screen.
 *
 * ── The one judgement this file makes ─────────────────────────────────────
 *
 * The ladder rungs are worded as *what the agent can see*, never as a level
 * name. "רמה 3" tells an owner nothing about whether their seller can read a
 * guest's telephone number, and the whole subject of this screen is that they
 * should be able to answer that question at a glance. So `phone` reads "שם
 * וטלפון של האורח" and not "טלפון", because the ladder is cumulative and a
 * label that named only the top rung would understate what was granted.
 */

import type { BadgeTone } from '@/components/ui/badge'
import type { MembershipStatus } from '@/lib/authz/can'
import type {
  CalendarLevel,
  GuestDataLevel,
  PriceLevel,
} from '@/lib/authz/roles'
import type { AgentCancellationPolicy } from '@/lib/agents'
import type { AgentInventoryScope } from '@/lib/agents'

/**
 * What a screen prints where a value exists and this reader may not see it.
 *
 * The same sentence the finance screens use, restated rather than imported so
 * that this module does not depend on a sibling route's `_lib` for a string —
 * `components/finance/money.tsx` already imports across that boundary and it is
 * the wrong direction to add a second one in.
 */
export const WITHHELD = 'לא זמין לצפייה'

/* --------------------------------------------------------- the ladders -- */

/** `CALENDAR_LEVELS` — how much of the diary exists for this seller. */
export const CALENDAR_LEVEL_LABEL: Record<CalendarLevel, string> = {
  none: 'אין גישה ליומן',
  availability: 'רואה מה פנוי ומה תפוס',
  availability_price: 'רואה מה פנוי, ומחיר להצעה',
  availability_hold: 'רואה, מתמחר, ותופס תאריכים',
  availability_booking: 'רואה, מתמחר, תופס ומזמין',
}

/** `PRICE_LEVELS` — which of the business's prices this seller is shown. */
export const PRICE_LEVEL_LABEL: Record<PriceLevel, string> = {
  none: 'אין מחירים',
  public: 'המחיר לציבור',
  agent: 'מחיר סוכן',
  net: 'מחיר נטו',
  net_commission: 'מחיר נטו והעמלה עליו',
}

/**
 * `GUEST_DATA_LEVELS` — cumulative, and worded that way.
 *
 * `phone` grants the name as well, so a label reading "טלפון" would understate
 * what an owner just handed over. The rung is named by everything below it.
 */
export const GUEST_DATA_LEVEL_LABEL: Record<GuestDataLevel, string> = {
  none: 'אין פרטי אורח',
  name: 'שם האורח',
  phone: 'שם וטלפון של האורח',
  email: 'שם, טלפון ואימייל של האורח',
}

/** The three ladders, named for the column heading above each of them. */
export const LADDER_LABEL = {
  calendar: 'יומן',
  price: 'מחירים',
  guestData: 'פרטי אורח',
} as const

/* ---------------------------------------------------------- the reach --- */

/**
 * What an inventory reach means, said in words rather than as a kind.
 *
 * `all_properties` is spelled as "every property, including ones bought later"
 * because that is what `inventoryScopeToScope` actually produces — it becomes
 * `all_organization` rather than a snapshot of today's list, and an owner
 * choosing it should know they are granting the future as well.
 */
export function inventoryReachLabel(scope: AgentInventoryScope): string {
  switch (scope.kind) {
    case 'all_properties':
      return 'כל הנכסים בארגון, כולל נכסים שייקנו בהמשך'
    case 'properties':
      return scope.propertyIds.length === 1
        ? 'נכס אחד'
        : `${scope.propertyIds.length} נכסים`
    case 'units':
      return scope.unitIds.length === 1
        ? 'יחידה אחת'
        : `${scope.unitIds.length} יחידות`
  }
}

/* --------------------------------------------------------- the status --- */

/**
 * `MEMBERSHIP_STATUSES`, as the agent screen says them.
 *
 * `lifecycle.ts` has an identical private table, and it is private — the
 * sentences it builds are audit summaries, not column values, and exporting a
 * record out of a domain module so a screen could reuse five words would couple
 * the two for no gain. This is the display copy; that is the audit copy.
 */
export const AGENT_STATUS_LABEL: Record<MembershipStatus, string> = {
  invited: 'הוזמן, טרם הצטרף',
  pending: 'ממתין לאימות',
  active: 'פעיל',
  suspended: 'מושעה',
  removed: 'הוסר',
}

/**
 * `suspended` and `removed` are the two an owner scans for, so they are the two
 * that leave the neutral palette. `active` is `brand`; the rest are neutral,
 * and the word carries the meaning in every case.
 */
export function agentStatusTone(status: MembershipStatus): BadgeTone {
  if (status === 'active') return 'brand'
  if (status === 'suspended' || status === 'removed') return 'accent'
  return 'neutral'
}

/** Struck through once the relationship is over, never merely paused. */
export function agentStatusVoided(status: MembershipStatus): boolean {
  return status === 'removed'
}

/* --------------------------------------------------- the cancellation --- */

/** `AgentCancellationPolicy` — four commercial postures, not a boolean. */
export function cancellationLabel(policy: AgentCancellationPolicy): string {
  switch (policy.kind) {
    case 'never':
      return 'לא רשאי לבטל'
    case 'until_paid':
      return 'רשאי לבטל עד שהתקבל תשלום'
    case 'hours_before_arrival':
      return `רשאי לבטל עד ${policy.hours} שעות לפני ההגעה`
    case 'requires_approval':
      return 'ביטול דורש אישור מנהל'
  }
}

/* -------------------------------------------------------- the agency ---- */

export const AGENCY_STATUSES = ['active', 'inactive'] as const
export type AgencyStatus = (typeof AGENCY_STATUSES)[number]

export const AGENCY_STATUS_LABEL: Record<AgencyStatus, string> = {
  active: 'פעילה',
  inactive: 'לא פעילה',
}

export const AGENCY_MEMBER_ROLES = ['manager', 'agent'] as const
export type AgencyMemberRole = (typeof AGENCY_MEMBER_ROLES)[number]

/**
 * The agency's own internal structure, and not a permission.
 *
 * Worded so nobody reads it as one: a manager here runs the agency's people,
 * and what they may do inside *this* business still comes from their own
 * membership ladders. `agency.ts` is explicit about the split.
 */
export const AGENCY_MEMBER_ROLE_LABEL: Record<AgencyMemberRole, string> = {
  manager: 'מנהל בסוכנות',
  agent: 'סוכן',
}

export const AGENCY_MEMBER_STATUSES = [
  'active',
  'suspended',
  'removed',
] as const
export type AgencyMemberStatus = (typeof AGENCY_MEMBER_STATUSES)[number]

export const AGENCY_MEMBER_STATUS_LABEL: Record<AgencyMemberStatus, string> = {
  active: 'פעיל',
  suspended: 'מושעה',
  removed: 'עזב',
}

export const AGREEMENT_STATUSES = ['draft', 'active', 'terminated'] as const
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]

export const AGREEMENT_STATUS_LABEL: Record<AgreementStatus, string> = {
  draft: 'טיוטה',
  active: 'בתוקף',
  terminated: 'הסתיים',
}

/**
 * The status column, and why the screen never reads it alone.
 *
 * `isAgreementActive` decides liveness against the date every time it is asked,
 * because an agreement whose end date passed last night is over whether or not
 * a job has run to say so. The tone here follows the *computed* answer, which
 * is why it takes a boolean rather than the status.
 */
export function agreementTone(live: boolean): BadgeTone {
  return live ? 'brand' : 'neutral'
}

/* --------------------------------------------------------- the quote ---- */

/**
 * What became of a quote.
 *
 * These are derived, not stored: `holds` carries `converted_to_booking_id`,
 * `released_at` and `expires_at`, and the outcome is which of the three
 * happened first. Deriving it in one place means the list and the count cannot
 * disagree — see `quoteOutcome` in `quotes/_lib/queries.ts`.
 */
export const QUOTE_OUTCOMES = ['open', 'won', 'released', 'expired'] as const
export type QuoteOutcome = (typeof QUOTE_OUTCOMES)[number]

export const QUOTE_OUTCOME_LABEL: Record<QuoteOutcome, string> = {
  open: 'פתוחה — התאריכים מוחזקים',
  won: 'הפכה להזמנה',
  released: 'שוחררה',
  expired: 'פגה',
}

export function quoteOutcomeTone(outcome: QuoteOutcome): BadgeTone {
  if (outcome === 'won') return 'brand'
  if (outcome === 'open') return 'accent'
  return 'neutral'
}
