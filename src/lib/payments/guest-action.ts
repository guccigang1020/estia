/**
 * The one thing the guest is asked to do.
 *
 * ── One action, never a menu ──────────────────────────────────────────────
 *
 * A guest page that renders every possibility — confirm, sign, pay, upload,
 * wait — and lets the person work out which applies is a page that gets a
 * telephone call. So this returns exactly one action: the first outstanding
 * requirement, in the order `resolver.ts` puts them in, expressed as something
 * a person can do right now.
 *
 * The corollary matters more. **An action the policy does not require is never
 * rendered.** A business whose policy is `none` gets a page that says the
 * booking is being handled and offers nothing, because nothing is wanted from
 * the guest — not a greyed-out pay button, not an upload box "in case".
 *
 * ── The live-payment call to action is gated on a fact, not on hope ───────
 *
 * `decision.liveAvailable` comes from `payment_collection_settings`, where it
 * is constrained to require a named provider. If it is false there is no
 * "pay now" here, whatever the policy asks for — and when the policy demands
 * a live payment that the organization cannot take, the guest is told the
 * business will be in touch rather than sent to a button that leads nowhere.
 * That combination is a misconfiguration and `blocked` names it as one, so a
 * staff screen can surface it instead of a guest discovering it.
 */

import type { Agorot } from '../booking/types'

import { MANUAL_CHANNEL_LABEL } from './channels'
import { formatAgorot, type CollectionDecision } from './resolver'
import type { GuestChannel, ManualChannel } from './types'

export const GUEST_ACTION_KINDS = [
  'confirm_booking',
  'sign_contract',
  'pay_live',
  'manual_transfer',
  'awaiting_staff',
  'nothing_required',
  'blocked',
] as const

export type GuestActionKind = (typeof GUEST_ACTION_KINDS)[number]

export interface GuestAction {
  kind: GuestActionKind
  /** The heading. Short, and in the imperative where there is something to do. */
  title: string
  /** One sentence under it. Always present — a bare button explains nothing. */
  body: string
  /** The button's own words, or `null` when there is no button. */
  cta: string | null
  /** Set for `pay_live` and `manual_transfer`. Never displayed elsewhere. */
  amountAgorot: Agorot | null
  /** Only for `manual_transfer`, and only the enabled ones. */
  channels: readonly GuestChannel[]
  /** Whether to offer the upload-proof control. Only where a proof helps. */
  offerProofUpload: boolean
}

export interface GuestActionInput {
  decision: CollectionDecision
  channels: readonly ManualChannel[]
  /**
   * The booking is cancelled or the stay is over. Nothing is asked of a guest
   * whose booking no longer exists, whatever the policy says.
   */
  bookingClosed?: boolean
  /** A receipt already arrived and nobody has looked at it yet. */
  awaitingProofReview?: boolean
}

/** The enabled channels, as the guest sees them. */
export function guestChannels(
  channels: readonly ManualChannel[],
): readonly GuestChannel[] {
  return channels
    .filter((channel) => channel.enabled)
    .slice()
    .sort(
      (a, b) => a.sortOrder - b.sortOrder || a.channel.localeCompare(b.channel),
    )
    .map((channel) => ({
      channel: channel.channel,
      label: channel.displayName ?? MANUAL_CHANNEL_LABEL[channel.channel],
      instructions: channel.instructions,
    }))
}

export function nextGuestAction(input: GuestActionInput): GuestAction {
  const { decision } = input

  if (input.bookingClosed === true) {
    return {
      kind: 'nothing_required',
      title: 'ההזמנה סגורה',
      body: 'אין כרגע פעולה שנדרשת ממך. לשאלות, פנה ישירות לבית האירוח.',
      cta: null,
      amountAgorot: null,
      channels: [],
      offerProofUpload: false,
    }
  }

  if (decision.confirmable) {
    return {
      kind: 'nothing_required',
      title: 'הכול בוצע',
      body:
        decision.requirements.length === 0
          ? 'בית האירוח אינו מבקש ממך דבר לפני האישור. ההזמנה מטופלת.'
          : 'כל מה שנדרש ממך הושלם. ההזמנה מטופלת מול בית האירוח.',
      cta: null,
      amountAgorot: null,
      channels: [],
      offerProofUpload: false,
    }
  }

  const next = decision.outstanding[0]
  const available = guestChannels(input.channels)

  switch (next) {
    case 'guest_confirmation':
      return {
        kind: 'confirm_booking',
        title: 'אשר את ההזמנה',
        body: 'בדוק את פרטי השהות ואשר. אחרי האישור בית האירוח ימשיך בטיפול.',
        cta: 'אשר הזמנה',
        amountAgorot: null,
        channels: [],
        offerProofUpload: false,
      }

    case 'contract_signed':
      return {
        kind: 'sign_contract',
        title: 'חתום על החוזה',
        body: 'ההזמנה נסגרת לאחר חתימה על תנאי השהות.',
        cta: 'חתום על החוזה',
        amountAgorot: null,
        channels: [],
        offerProofUpload: false,
      }

    case 'manager_approval':
      return {
        kind: 'awaiting_staff',
        title: 'הבקשה התקבלה — ממתינה לאישור',
        body: 'אין פעולה נוספת מצדך. בית האירוח יאשר את ההזמנה ויעדכן אותך.',
        cta: null,
        amountAgorot: null,
        channels: [],
        offerProofUpload: false,
      }

    case 'deposit_paid_live':
    case 'deposit_recorded':
    case 'full_payment': {
      const amount =
        next === 'full_payment'
          ? decision.shortfallAgorot > 0
            ? decision.shortfallAgorot
            : decision.dueNowAgorot
          : decision.shortfallAgorot

      // A receipt is in, and nobody has checked it. Asking again for money
      // that may already have arrived is how a guest pays twice.
      if (input.awaitingProofReview === true) {
        return {
          kind: 'awaiting_staff',
          title: 'האישור התקבל — ממתין לבדיקה',
          body: 'קיבלנו את אסמכתת התשלום. בית האירוח יבדוק ויעדכן אותך. אין צורך לשלוח שוב.',
          cta: null,
          amountAgorot: null,
          channels: [],
          offerProofUpload: false,
        }
      }

      if (decision.liveAvailable) {
        return {
          kind: 'pay_live',
          title:
            next === 'full_payment'
              ? `שלם ${formatAgorot(amount)}`
              : `שלם מקדמה ${formatAgorot(amount)}`,
          body: 'התשלום מתבצע בעמוד מאובטח של חברת הסליקה. פרטי הכרטיס אינם נשמרים אצלנו.',
          cta: `שלם ${formatAgorot(amount)}`,
          amountAgorot: amount,
          channels: [],
          offerProofUpload: false,
        }
      }

      // The policy demands the money be taken on a card and the organization
      // has no processor. Naming it is the honest move — the guest cannot fix
      // it and must not be handed a button that cannot work.
      if (next === 'deposit_paid_live') {
        return {
          kind: 'blocked',
          title: 'התשלום יתואם מול בית האירוח',
          body: 'לא ניתן כרגע לשלם דרך הקישור. בית האירוח יצור איתך קשר להסדרת התשלום.',
          cta: null,
          amountAgorot: amount,
          channels: [],
          offerProofUpload: false,
        }
      }

      if (available.length > 0) {
        return {
          kind: 'manual_transfer',
          title:
            next === 'full_payment'
              ? `להשלמת ההזמנה יש להעביר ${formatAgorot(amount)}`
              : `להשלמת ההזמנה יש להעביר מקדמה ${formatAgorot(amount)}`,
          body: 'העבר את הסכום באחת הדרכים שלמטה, וצרף אסמכתה כדי שנוכל לזהות את התשלום.',
          cta: null,
          amountAgorot: amount,
          channels: available,
          offerProofUpload: true,
        }
      }

      // Money is required and there is nowhere to send it. Same class of
      // problem as the one above, and the same refusal to invent a control.
      return {
        kind: 'blocked',
        title: 'פרטי התשלום יישלחו אליך',
        body: 'בית האירוח טרם פרסם דרך תשלום. הוא יצור איתך קשר עם ההוראות.',
        cta: null,
        amountAgorot: amount,
        channels: [],
        offerProofUpload: false,
      }
    }

    // `outstanding` is non-empty here — `confirmable` was false — so this is
    // unreachable. It is written rather than cast away so that adding a
    // requirement to the frozen contract fails the type check here, at the one
    // place that decides what a guest is shown.
    case undefined:
      return {
        kind: 'awaiting_staff',
        title: 'הבקשה התקבלה',
        body: 'בית האירוח יעדכן אותך בהמשך.',
        cta: null,
        amountAgorot: null,
        channels: [],
        offerProofUpload: false,
      }
  }
}
