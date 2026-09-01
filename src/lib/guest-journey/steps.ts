/**
 * What this guest still has to do, and the one thing to do first.
 *
 * ── Where the answers come from, and why they come from there ─────────────
 *
 * This file composes two authorities and is itself neither of them.
 *
 * **The payment-collection module decides what is REQUIRED.** Confirmation, a
 * signature, a deposit, the whole amount — `resolveCollectionPolicy` is the one
 * implementation of that, organization default then per-booking override, and
 * `nextGuestAction` turns its verdict into the single thing to ask. Nothing
 * below re-derives any of it: there is no `switch` on a policy here, and
 * `decision.requirements` and `decision.outstanding` are read rather than
 * recomputed. A second opinion about what a guest owes is precisely the drift
 * the one-resolver rule exists to stop.
 *
 * **The journey settings decide what the portal can OFFER.** Whether a contract
 * exists to be signed at all, which details are collected, when the address is
 * released, what may be asked for during a stay. That is 0034's
 * `guest_journey_settings`, and it is a different question from what a booking
 * needs before it is confirmable.
 *
 * Where the two disagree — the policy requires a signature and the business has
 * no contract configured — that is a misconfiguration rather than a state to
 * resolve silently, and §`contractStep` names it. `nextGuestAction` already
 * takes the same position for the money case with its `blocked` kind.
 *
 * ── Two rules everything else follows from ────────────────────────────────
 *
 * **Never an empty step.** The progress list contains only steps that apply.
 * Contract disabled and not required means there is no contract line — not a
 * greyed-out one, not one marked "לא נדרש". A guesthouse that confirms by
 * telephone and takes cash on arrival gets a list with one item on it, and a
 * guest who sees four ticked boxes they never filled in learns to ignore the
 * list. `buildSteps` therefore *omits* rather than *disables*.
 *
 * **One dominant action.** A screen with four equally weighted buttons has no
 * next action, it has a menu — and a person on a telephone, on a bus, three
 * days before their holiday, does not want a menu.
 *
 * ── Why this file is pure ─────────────────────────────────────────────────
 *
 * No database, no clock of its own. Given a journey and a resolved collection,
 * it returns the same list every time — which is what makes the combinations
 * testable as a table instead of as twenty seeded bookings. The gating that
 * MATTERS is not here: the address and the access code are withheld by
 * `guest_arrival_released` in SQL, and nothing this file decides can disclose
 * them.
 */

import type { ConfirmationRequirement } from '../contracts/states'

import type { GuestCollection } from './collection'
import { compareTerms, type ReconfirmationVerdict } from './reconfirmation'
import type { GuestJourney } from './types'

// ── Steps ─────────────────────────────────────────────────────────────────

export const GUEST_STEP_IDS = [
  'confirm',
  'contract',
  'payment',
  'details',
] as const

export type GuestStepId = (typeof GUEST_STEP_IDS)[number]

export type GuestStepStatus = 'done' | 'current' | 'upcoming' | 'blocked'

export type GuestStep = {
  id: GuestStepId
  label: string
  /** One line, in Hebrew, saying what this actually asks of them. */
  description: string
  status: GuestStepStatus
  /**
   * False for a step the business offers but does not insist on — an optional
   * contract. Shown, never counted against them, and never the dominant action
   * while a required step is outstanding.
   */
  required: boolean
  /** Where the step is done. Relative to the portal root; null when elsewhere. */
  path: string | null
}

/** The requirements that are about money rather than about consent. */
const MONEY_REQUIREMENTS: ReadonlySet<ConfirmationRequirement> = new Set([
  'deposit_recorded',
  'deposit_paid_live',
  'full_payment',
])

// ── The one next thing ────────────────────────────────────────────────────

export const GUEST_ACTION_IDS = [
  'reconfirm',
  /**
   * The collection panel owns it. Returned rather than duplicated, because
   * `nextGuestAction` has already chosen between confirm, sign, pay, transfer,
   * wait and blocked — and a second choice made here could disagree with the
   * panel rendered directly underneath it.
   */
  'collection',
  'details',
  'arrival',
  'stay',
  'checkout',
  'review',
  'rebook',
  'none',
] as const

export type GuestActionId = (typeof GUEST_ACTION_IDS)[number]

export type GuestNextAction = {
  id: GuestActionId
  /** The button. A verb, never "המשך". Empty for `collection` — the panel says it. */
  label: string
  /** The sentence above it, saying why. */
  description: string
  path: string | null
  /**
   * `urgent` when the business is waiting on the guest, `calm` when the guest
   * is waiting on the day. The difference is why a confirmed guest three weeks
   * out does not get a red button.
   */
  tone: 'urgent' | 'calm'
}

export type GuestJourneyView = {
  steps: GuestStep[]
  next: GuestNextAction
  reconfirmation: ReconfirmationVerdict
  /** True when every required step is done. */
  complete: boolean
}

/* ---------------------------------------------------------------- steps -- */

function confirmStep(
  journey: GuestJourney,
  collection: GuestCollection,
  reconfirmation: ReconfirmationVerdict,
): GuestStep | null {
  const requiredByPolicy =
    collection.decision.requirements.includes('guest_confirmation')
  const offeredByJourney = journey.settings.requireGuestConfirmation

  // Neither the policy nor the business wants the guest to confirm. Some do
  // not: a booking made by telephone with the guest on the line has already
  // been agreed, and asking again on a web page is theatre.
  if (!requiredByPolicy && !offeredByJourney) return null

  // A confirmation overtaken by a change is not done. This is the whole
  // reconfirmation law as it appears on the progress list.
  const done = journey.confirmation !== null && !reconfirmation.required

  return {
    id: 'confirm',
    label: 'אישור ההזמנה',
    description: reconfirmation.required
      ? 'ההזמנה עודכנה ויש לאשר את הפרטים החדשים'
      : 'אישור התאריכים, מספר האורחים והמחיר',
    status: done ? 'done' : 'current',
    required: true,
    path: '',
  }
}

function contractStep(
  journey: GuestJourney,
  collection: GuestCollection,
): GuestStep | null {
  const { contractMode } = journey.settings
  const requiredByPolicy =
    collection.decision.requirements.includes('contract_signed')
  const signed = journey.contract.signature !== null

  if (contractMode === 'disabled') {
    // The business switched the contract off and the collection policy still
    // demands one. Nothing the guest can do resolves that, so it is named as a
    // block rather than left as a step that can never be completed — the same
    // position `nextGuestAction` takes when a policy wants a card payment from
    // an organization with no processor.
    if (requiredByPolicy && !signed) {
      return {
        id: 'contract',
        label: 'חתימה על החוזה',
        description: 'בית האירוח טרם פרסם נוסח לחתימה. הוא ייצור איתך קשר.',
        status: 'blocked',
        required: true,
        path: null,
      }
    }
    return null
  }

  return {
    id: 'contract',
    label: 'חתימה על החוזה',
    description:
      contractMode === 'mandatory' || requiredByPolicy
        ? 'חתימה על תנאי השהות'
        : 'חתימה על תנאי השהות — לא חובה',
    status: signed ? 'done' : 'current',
    required: contractMode === 'mandatory' || requiredByPolicy,
    path: 'contract',
  }
}

/**
 * The money step, read entirely from the decision.
 *
 * Not computed: `decision.requirements` says whether money is wanted and
 * `decision.outstanding` says whether it has arrived. This function chooses
 * wording and nothing else.
 */
function paymentStep(collection: GuestCollection): GuestStep | null {
  const { decision } = collection
  const wanted = decision.requirements.filter((requirement) =>
    MONEY_REQUIREMENTS.has(requirement),
  )

  // `none` is a legitimate and common answer — the frozen contract says so —
  // and it is the difference between "no payment step" and "a payment step
  // showing ₪0".
  if (wanted.length === 0) return null

  const outstanding = decision.outstanding.some((requirement) =>
    MONEY_REQUIREMENTS.has(requirement),
  )

  const deposit =
    wanted.includes('deposit_recorded') || wanted.includes('deposit_paid_live')

  return {
    id: 'payment',
    label:
      deposit && !wanted.includes('full_payment') ? 'תשלום מקדמה' : 'תשלום',
    description: outstanding ? collection.action.body : 'התשלום התקבל',
    status: outstanding ? 'current' : 'done',
    required: true,
    // The payment control is the collection panel on the first screen, not a
    // separate route. Null rather than a guessed path: a link to a page nobody
    // built is worse than no link, because the guest cannot tell which of the
    // two happened.
    path: null,
  }
}

function detailsStep(journey: GuestJourney): GuestStep | null {
  if (journey.settings.requiredDetailFields.length === 0) return null

  return {
    id: 'details',
    label: 'פרטי האורחים',
    description: 'השלמת הפרטים שבית האירוח ביקש',
    status: journey.details.submittedAt !== null ? 'done' : 'current',
    required: true,
    path: 'details',
  }
}

/**
 * The steps, in the order a guest meets them.
 *
 * The order is the journey's own and not configurable: a contract signed
 * before the guest has agreed to the dates is a signature on the wrong thing,
 * and money taken before either is money to give back.
 */
export function buildSteps(
  journey: GuestJourney,
  collection: GuestCollection,
  reconfirmation: ReconfirmationVerdict,
): GuestStep[] {
  const steps = [
    confirmStep(journey, collection, reconfirmation),
    contractStep(journey, collection),
    paymentStep(collection),
    detailsStep(journey),
  ].filter((step): step is GuestStep => step !== null)

  // Exactly one step is `current` — the first outstanding one. The rest become
  // `upcoming`, so the list reads as a sequence rather than as four alarms.
  // `blocked` is left alone: it is not somebody's next action.
  let seenCurrent = false
  return steps.map((step) => {
    if (step.status !== 'current') return step
    if (!seenCurrent) {
      seenCurrent = true
      return step
    }
    return { ...step, status: 'upcoming' as const }
  })
}

/* --------------------------------------------------------- next action -- */

/**
 * The single thing to put in front of them.
 *
 * Read the order top to bottom: it is the priority, and it is deliberate.
 * Reconfirmation outranks everything, because every later step was agreed
 * against terms that have moved — and it is the one thing the collection
 * module cannot know, since a stale confirmation is still a confirmation as
 * far as `CollectionFacts` is concerned. Everything the policy governs then
 * defers to the panel. Only once that is settled does the journey's own tail
 * — details, arrival, the stay, leaving — get a turn.
 */
export function nextAction(
  journey: GuestJourney,
  collection: GuestCollection,
  steps: GuestStep[],
  reconfirmation: ReconfirmationVerdict,
): GuestNextAction {
  const { settings, checkout, arrival, current } = journey

  if (reconfirmation.required) {
    return {
      id: 'reconfirm',
      label: 'אישור הפרטים המעודכנים',
      description: 'ההזמנה עודכנה מאז שאישרת. בדוק את השינוי ואשר מחדש.',
      path: '',
      tone: 'urgent',
    }
  }

  // The policy still wants something. The panel renders it — this returns the
  // fact that it does, and no words of its own, so the two cannot disagree.
  if (collection.action.kind !== 'nothing_required') {
    return {
      id: 'collection',
      label: '',
      description: '',
      path: '',
      tone:
        collection.action.kind === 'awaiting_staff' ||
        collection.action.kind === 'blocked'
          ? 'calm'
          : 'urgent',
    }
  }

  const details = steps.find(
    (step) => step.id === 'details' && step.status !== 'done',
  )
  if (details) {
    return {
      id: 'details',
      label: 'מילוי פרטי האורחים',
      description: 'עוד כמה פרטים ובית האירוח מוכן לקראתכם.',
      path: 'details',
      tone: 'urgent',
    }
  }

  // Everything required is done. From here the portal stops asking and starts
  // telling — and what it tells depends on where in the stay they are.

  if (checkout.declaredAt !== null) {
    if (settings.reviewEnabled && settings.reviewUrl) {
      return {
        id: 'review',
        label: 'נשמח לחוות דעת',
        description: 'תודה ששהיתם אצלנו. חוות דעת קצרה עוזרת מאוד.',
        path: 'checkout',
        tone: 'calm',
      }
    }
    if (settings.rebookEnabled) {
      return {
        id: 'rebook',
        label: 'הזמנת שהות נוספת',
        description: 'תודה ששהיתם אצלנו. נשמח לארח אתכם שוב.',
        path: 'checkout',
        tone: 'calm',
      }
    }
    return {
      id: 'none',
      label: 'תודה ששהיתם אצלנו',
      description: 'ההזמנה הושלמה. אין דבר נוסף שנדרש ממך.',
      path: null,
      tone: 'calm',
    }
  }

  if (current.inStay) {
    return {
      id: 'stay',
      label: 'המדריך לשהות',
      description: 'רשת אלחוטית, הנחיות הבית ובקשות במהלך השהות.',
      path: 'stay',
      tone: 'calm',
    }
  }

  if (
    current.status === 'checkout_pending' ||
    current.status === 'checked_out'
  ) {
    return {
      id: 'checkout',
      label: 'הנחיות עזיבה',
      description: 'מה צריך לעשות לפני שיוצאים.',
      path: 'checkout',
      tone: 'calm',
    }
  }

  if (arrival.released) {
    return {
      id: 'arrival',
      label: 'פרטי ההגעה',
      description: 'הכתובת, הוראות ההגעה והכניסה לנכס.',
      path: 'arrival',
      tone: 'calm',
    }
  }

  // Confirmed, nothing outstanding, and the address is not released yet. The
  // honest answer is that there is nothing to do — said plainly, rather than
  // dressed up as a button.
  return {
    id: 'none',
    label: 'הכול מוכן',
    description:
      'אין דבר נוסף שנדרש ממך כרגע. פרטי ההגעה יופיעו כאן כשיהיו זמינים.',
    path: null,
    tone: 'calm',
  }
}

/** The whole view, in one call. What every screen in the portal reads. */
export function buildJourneyView(
  journey: GuestJourney,
  collection: GuestCollection,
): GuestJourneyView {
  const reconfirmation = compareTerms(
    journey.confirmation,
    journey.current,
    journey.settings,
  )
  const steps = buildSteps(journey, collection, reconfirmation)
  const next = nextAction(journey, collection, steps, reconfirmation)

  return {
    steps,
    next,
    reconfirmation,
    complete: steps.every((step) => !step.required || step.status === 'done'),
  }
}
