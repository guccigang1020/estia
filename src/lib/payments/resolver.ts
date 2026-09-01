/**
 * THE resolver. One function, one answer to one question:
 *
 *     what must happen before THIS booking is confirmed?
 *
 * ── Why there is exactly one ──────────────────────────────────────────────
 *
 * The booking screen, the guest portal, the settings page and the
 * confirmation button each need this answer, and the moment two of them
 * compute it, they disagree — usually about the case nobody tested, which is
 * an override on a booking whose organization changed its default afterwards.
 * When that happens a guest is shown a deposit request the desk believes was
 * waived, and there is no record that can settle it.
 *
 * So: `resolveCollectionPolicy` is the only place in this product that turns
 * settings plus override plus what has been collected into a decision. It has
 * no I/O, no clock of its own beyond what it is handed, and no knowledge of
 * Supabase — which is what makes it testable and what makes it impossible to
 * "just inline this bit" somewhere else. The SQL function
 * `guest_collection_context()` deliberately returns facts and no decision, for
 * the same reason.
 *
 * ── Payment state and booking state stay separate ─────────────────────────
 *
 * `src/lib/finance/payment-state-machine.ts` opens by saying it, and it is the
 * rule this module could most easily break. Nothing here reads or writes a
 * booking status. `confirmable` means "the policy's requirements are all met",
 * not "the booking is now confirmed" — a business may confirm on the telephone
 * with the payment `unpaid`, and that is a legitimate configuration
 * (`policy: 'none'`), not a state to be repaired.
 *
 * ── Explainability is not a feature bolted on ─────────────────────────────
 *
 * The return value is not a boolean with a comment. Every requirement the
 * effective policy names comes back as a `RequirementCheck` carrying whether
 * it is met and a Hebrew sentence saying why. Wherever the product says a
 * booking is or is not confirmed, it renders these; nothing has to reconstruct
 * the reasoning from the answer.
 */

import type { Agorot } from '../booking/types'
import {
  CONFIRMATION_REQUIREMENTS,
  type ConfirmationRequirement,
  type PaymentCollectionPolicy,
} from '../contracts/states'
import { applyPercent } from '../finance/money'

import {
  DEFAULT_COLLECTION_SETTINGS,
  type CollectionFacts,
  type CollectionOverride,
  type CollectionSettings,
} from './types'

/* ------------------------------------------------------------- vocabulary */

export const COLLECTION_POLICY_LABEL: Record<PaymentCollectionPolicy, string> =
  {
    none: 'ללא תשלום מראש',
    manual: 'תשלום ידני מחוץ למערכת',
    deposit: 'מקדמה',
    full: 'תשלום מלא מראש',
    schedule: 'פריסה לתשלומים',
    after_approval: 'רק לאחר אישור',
    custom: 'מותאם אישית',
  }

export const COLLECTION_POLICY_DESCRIPTION: Record<
  PaymentCollectionPolicy,
  string
> = {
  none: 'ההזמנה מאושרת בלי לגבות כלום מראש. התשלום מתבצע בהגעה או בסיום השהות.',
  manual:
    'האורח מקבל הוראות תשלום — העברה בנקאית, ביט, מזומן — ואתם רושמים את הכסף כשהוא מגיע.',
  deposit: 'האורח משלם מקדמה כדי לאשר את ההזמנה, והיתרה נגבית מאוחר יותר.',
  full: 'ההזמנה מאושרת רק כשכל הסכום שולם.',
  schedule: 'הסכום נפרס לתשלומים, והתשלום הראשון הוא מה שמאשר את ההזמנה.',
  after_approval: 'ההזמנה ממתינה לאישור שלכם. רק אחריו האורח מתבקש לשלם.',
  custom: 'הדרישות נבחרות אחת-אחת ברשימה שלמטה, בלי כלל ברירת מחדל.',
}

export const REQUIREMENT_LABEL: Record<ConfirmationRequirement, string> = {
  manager_approval: 'אישור מנהל',
  guest_confirmation: 'אישור האורח',
  contract_signed: 'חתימה על החוזה',
  deposit_recorded: 'מקדמה שנרשמה',
  deposit_paid_live: 'מקדמה ששולמה בסליקה',
  full_payment: 'תשלום מלא',
}

export const REQUIREMENT_DESCRIPTION: Record<ConfirmationRequirement, string> =
  {
    manager_approval:
      'מישהו מהצוות צריך לאשר את ההזמנה. האורח אינו יכול לקדם את זה.',
    guest_confirmation: 'האורח צריך ללחוץ "אשר הזמנה" בקישור שנשלח אליו.',
    contract_signed: 'האורח צריך לחתום על החוזה לפני שההזמנה נסגרת.',
    deposit_recorded:
      'המקדמה צריכה להיכנס — בכל דרך, כולל העברה בנקאית שנרשמה ידנית.',
    deposit_paid_live:
      'המקדמה צריכה להיגבות בסליקה. העברה בנקאית לא מספיקה לדרישה הזו.',
    full_payment: 'כל סכום ההזמנה צריך להיכנס לפני האישור.',
  }

/**
 * The order a guest is asked to do things in.
 *
 * Not the order they are declared in, and not arbitrary. Confirming and
 * signing cost nothing and take a moment; money comes after, because asking
 * somebody to pay before they have agreed to the terms is how a deposit turns
 * into a dispute. `manager_approval` is last because it is not the guest's
 * work at all — it is the one requirement whose outstanding state means "wait",
 * and putting it anywhere else would show a guest a waiting screen while they
 * still had something to do.
 */
const REQUIREMENT_ORDER: readonly ConfirmationRequirement[] = [
  'guest_confirmation',
  'contract_signed',
  'deposit_paid_live',
  'deposit_recorded',
  'full_payment',
  'manager_approval',
]

/* ----------------------------------------------------------------- shapes */

export interface RequirementCheck {
  requirement: ConfirmationRequirement
  met: boolean
  /** Hebrew, and specific. "טרם נרשמה מקדמה — חסרים ₪2,500 מתוך ₪2,500." */
  detail: string
}

export type PolicySource = 'organization' | 'booking_override'

export interface CollectionDecision {
  /** Which row decided this. The override wins when there is one. */
  source: PolicySource
  policy: PaymentCollectionPolicy
  /** The override's stated reason, or `null` when the default applies. */
  overrideReason: string | null
  /**
   * What must be collected before confirmation. Zero when the policy asks for
   * nothing, which is a real answer and not a missing one.
   */
  dueNowAgorot: Agorot
  /** Still outstanding of `dueNowAgorot`, after what has been collected. */
  shortfallAgorot: Agorot
  balanceDueDaysBefore: number | null
  /** Every requirement the effective policy names, in the order to do them. */
  requirements: readonly ConfirmationRequirement[]
  checks: readonly RequirementCheck[]
  outstanding: readonly ConfirmationRequirement[]
  /** True when nothing is outstanding. NOT "the booking is confirmed". */
  confirmable: boolean
  /** Whether a live-payment call to action may be rendered at all. */
  liveAvailable: boolean
  guestInstructions: string | null
}

export interface ResolveInput {
  /** `null` is the same as the defaults. See `DEFAULT_COLLECTION_SETTINGS`. */
  settings: CollectionSettings | null
  override: CollectionOverride | null
  facts: CollectionFacts
}

/* -------------------------------------------------------------- the rules */

/**
 * What a policy implies on its own, before anybody lists a requirement.
 *
 * `custom` implies nothing — that is what it is for. Everything else has one
 * requirement it cannot sensibly be without, and stating them here rather than
 * demanding that every settings row spell them out is what keeps a business
 * from configuring `deposit` with an empty requirement list and wondering why
 * nothing is ever asked of anybody.
 */
function impliedRequirements(
  policy: PaymentCollectionPolicy,
): readonly ConfirmationRequirement[] {
  switch (policy) {
    case 'none':
      return []
    case 'manual':
      // The money moves outside the product, so what confirms the booking is
      // somebody writing down that it arrived.
      return ['deposit_recorded']
    case 'deposit':
      return ['deposit_recorded']
    case 'schedule':
      // The first instalment is what confirms. The rest is a schedule, not a
      // confirmation gate.
      return ['deposit_recorded']
    case 'full':
      return ['full_payment']
    case 'after_approval':
      return ['manager_approval']
    case 'custom':
      return []
  }
}

/**
 * The amount the policy asks for before confirmation.
 *
 * `full` is the booking's own total, not a stated deposit — a "pay everything"
 * policy that also carried a deposit figure would have two answers to one
 * question. Everything else takes the stated deposit, percentage or fixed,
 * and `applyPercent` is the product's single rounding rule rather than a
 * second one written here.
 */
function dueNow(
  policy: PaymentCollectionPolicy,
  depositPercentBps: number | null,
  depositFixedAgorot: Agorot | null,
  requirements: readonly ConfirmationRequirement[],
  bookingTotalAgorot: Agorot,
): Agorot {
  if (requirements.includes('full_payment')) return bookingTotalAgorot
  if (policy === 'full') return bookingTotalAgorot

  const wantsMoney =
    requirements.includes('deposit_recorded') ||
    requirements.includes('deposit_paid_live')

  if (!wantsMoney) return 0

  if (depositFixedAgorot !== null) {
    // Never more than the stay is worth. A ₪2,500 deposit on a ₪1,800 midweek
    // booking is a data-entry accident, and charging it is the expensive half.
    return Math.min(depositFixedAgorot, bookingTotalAgorot)
  }
  if (depositPercentBps !== null) {
    return applyPercent(bookingTotalAgorot, depositPercentBps / 100)
  }

  // A money requirement with no amount named. Zero rather than a guess: the
  // check below then reports it as unmet with an explicit sentence about the
  // missing configuration, which somebody can act on.
  return 0
}

function money(agorot: Agorot): string {
  return `₪${(agorot / 100).toLocaleString('he-IL', {
    minimumFractionDigits: agorot % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

function checkOf(
  requirement: ConfirmationRequirement,
  facts: CollectionFacts,
  dueNowAgorot: Agorot,
  amountNamed: boolean,
): RequirementCheck {
  switch (requirement) {
    case 'manager_approval':
      return {
        requirement,
        met: facts.managerApproved,
        detail: facts.managerApproved
          ? 'ההזמנה אושרה על ידי הצוות.'
          : 'ההזמנה ממתינה לאישור הצוות.',
      }
    case 'guest_confirmation':
      return {
        requirement,
        met: facts.guestConfirmed,
        detail: facts.guestConfirmed
          ? 'האורח אישר את ההזמנה.'
          : 'האורח טרם אישר את ההזמנה.',
      }
    case 'contract_signed':
      return {
        requirement,
        met: facts.contractSigned,
        detail: facts.contractSigned ? 'החוזה נחתם.' : 'החוזה טרם נחתם.',
      }
    case 'deposit_recorded': {
      if (!amountNamed) {
        return {
          requirement,
          met: false,
          detail:
            'המדיניות דורשת מקדמה אך לא הוגדר סכום. עדכנו את סכום המקדמה בהגדרות הגבייה.',
        }
      }
      const met = facts.settledAgorot >= dueNowAgorot
      return {
        requirement,
        met,
        detail: met
          ? `נרשמו ${money(facts.settledAgorot)} מתוך ${money(dueNowAgorot)}.`
          : `נרשמו ${money(facts.settledAgorot)} מתוך ${money(dueNowAgorot)} — חסרים ${money(dueNowAgorot - facts.settledAgorot)}.`,
      }
    }
    case 'deposit_paid_live': {
      if (!amountNamed) {
        return {
          requirement,
          met: false,
          detail:
            'המדיניות דורשת מקדמה בסליקה אך לא הוגדר סכום. עדכנו את סכום המקדמה בהגדרות הגבייה.',
        }
      }
      const met = facts.settledLiveAgorot >= dueNowAgorot
      return {
        requirement,
        met,
        detail: met
          ? `נגבו בסליקה ${money(facts.settledLiveAgorot)} מתוך ${money(dueNowAgorot)}.`
          : `נגבו בסליקה ${money(facts.settledLiveAgorot)} מתוך ${money(dueNowAgorot)} — העברה בנקאית אינה עונה על הדרישה הזו.`,
      }
    }
    case 'full_payment': {
      const met =
        facts.bookingTotalAgorot > 0 &&
        facts.settledAgorot >= facts.bookingTotalAgorot
      return {
        requirement,
        met,
        detail:
          facts.bookingTotalAgorot === 0
            ? 'לא נקבע סכום להזמנה, ולכן לא ניתן לקבוע שהיא שולמה במלואה.'
            : met
              ? `שולמו ${money(facts.settledAgorot)} מתוך ${money(facts.bookingTotalAgorot)}.`
              : `שולמו ${money(facts.settledAgorot)} מתוך ${money(facts.bookingTotalAgorot)} — חסרים ${money(facts.bookingTotalAgorot - facts.settledAgorot)}.`,
      }
    }
  }
}

/** Declared order, deduplicated, then sorted into the order a guest works. */
function orderRequirements(
  requirements: readonly ConfirmationRequirement[],
): readonly ConfirmationRequirement[] {
  const wanted = new Set(requirements)
  return REQUIREMENT_ORDER.filter((requirement) => wanted.has(requirement))
}

/* ------------------------------------------------------------ the answer -- */

/**
 * The organization default, then the per-booking override.
 *
 * The override replaces the default whole rather than merging field by field.
 * A merge sounds friendlier and is the trap: "no deposit, manual approval" set
 * against a 30% default would keep the 30% in whichever field the override
 * left null, and the desk would swear the deposit was waived while the guest
 * page asked for it. One row decides, and `source` says which.
 */
export function resolveCollectionPolicy(
  input: ResolveInput,
): CollectionDecision {
  const settings = input.settings ?? DEFAULT_COLLECTION_SETTINGS
  const { override, facts } = input

  const source: PolicySource = override ? 'booking_override' : 'organization'
  const chosen = override ?? settings

  const requirements = orderRequirements([
    ...impliedRequirements(chosen.policy),
    ...chosen.requirements,
  ])

  const amountNamed =
    chosen.depositFixedAgorot !== null || chosen.depositPercentBps !== null

  const dueNowAgorot = dueNow(
    chosen.policy,
    chosen.depositPercentBps,
    chosen.depositFixedAgorot,
    requirements,
    facts.bookingTotalAgorot,
  )

  const checks = requirements.map((requirement) =>
    checkOf(
      requirement,
      facts,
      dueNowAgorot,
      // `full_payment` names its own amount — the booking's total — so a
      // missing deposit figure is not its problem.
      requirement === 'full_payment' ? true : amountNamed,
    ),
  )

  const outstanding = checks
    .filter((check) => !check.met)
    .map((check) => check.requirement)

  const collectedTowardsDue = requirements.includes('deposit_paid_live')
    ? facts.settledLiveAgorot
    : facts.settledAgorot

  return {
    source,
    policy: chosen.policy,
    overrideReason: override ? override.reason : null,
    dueNowAgorot,
    shortfallAgorot: Math.max(0, dueNowAgorot - collectedTowardsDue),
    balanceDueDaysBefore: chosen.balanceDueDaysBefore,
    requirements,
    checks,
    outstanding,
    confirmable: outstanding.length === 0,
    // Read from the settings and never from the override: whether a processor
    // exists is a fact about the organization, and no per-booking exception
    // can conjure one.
    liveAvailable:
      settings.livePaymentsEnabled && settings.liveProvider !== null,
    guestInstructions: settings.guestInstructions,
  }
}

/** Every requirement, for a settings screen that has to offer all of them. */
export const ALL_CONFIRMATION_REQUIREMENTS = CONFIRMATION_REQUIREMENTS

export { money as formatAgorot }
