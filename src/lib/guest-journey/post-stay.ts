/**
 * After the guest has gone: thank you, review, receipt, summary, rebook.
 *
 * ── EXECUTION CONTEXT — pure, and client-safe ─────────────────────────────
 *
 * Same rule as `stay.ts` and for the same reason. No database, no clock, no
 * server import. A Client Component may import this leaf; it may not import
 * `@/lib/guest-journey`.
 *
 * ── The law this file exists to obey ──────────────────────────────────────
 *
 * **Review gating is not built here and will not be.**
 *
 * The pattern is common and it is what a business asks for: show the guest a
 * private feedback form, read the star rating, and send only the happy ones to
 * the public link. It manufactures a review score, it is against the terms of
 * every review platform that matters, and in several jurisdictions it is
 * unlawful. Asking for private feedback FIRST is fine and is what
 * `guestReviewOffer` does — the private prompt sits above the public link.
 * Deciding WHO reaches the public link by what they said is not.
 *
 * So the signature carries the enforcement: `guestReviewOffer` takes no
 * rating, no sentiment and no feedback argument of any kind. There is no
 * parameter a future caller could pass to suppress the external link, and
 * `post-stay.test.ts` asserts the link survives every configuration that
 * produces an offer at all.
 *
 * ── And the one about availability ────────────────────────────────────────
 *
 * Rebooking never shows a date it has not been told is free, and never shows a
 * price at all. `GuestRebookOffer` has no money member — not a nullable one, no
 * member — so "from ₪1,400 a night" cannot be added to this screen without
 * changing a type whose comment says why it is missing. With no known open
 * range the offer is an invitation to ask, worded so that nobody reads it as
 * an opening.
 */

import { nightsBetween } from '../booking/types'
import type { PaymentStatus } from '../contracts/states'
import { formatAgorot } from '../plans/plan'

import { describeParty } from './reconfirmation'
import { paymentNotice, type GuestPaymentNotice } from './stay'
import type { GuestOpenRange } from './ports'
import type { GuestJourney, GuestJourneySettings } from './types'

// ── §1 · The summary ──────────────────────────────────────────────────────

export type GuestStaySummary = {
  checkIn: string
  checkOut: string
  /** `4 לילות`. */
  nightsLabel: string
  nights: number
  /** `2 מבוגרים · ילד אחד`. */
  partyLabel: string
  /** `₪7,500`. Null when the booking carries no total. */
  totalLabel: string | null
}

export function guestStaySummary(journey: GuestJourney): GuestStaySummary {
  const { checkIn, checkOut, adults, children, infants, totalAgorot } =
    journey.current
  const nights = nightsBetween({ checkIn, checkOut })
  const counted = Number.isFinite(nights) ? nights : 0

  return {
    checkIn,
    checkOut,
    nights: counted,
    nightsLabel:
      counted === 1
        ? 'לילה אחד'
        : counted === 2
          ? 'שני לילות'
          : `${counted} לילות`,
    partyLabel: describeParty(adults, children, infants),
    // Zero is not "free", it is a booking whose price lines were never
    // entered, and printing ₪0 on a thank-you screen invites an argument.
    totalLabel: totalAgorot > 0 ? formatAgorot(totalAgorot) : null,
  }
}

// ── §2 · The review ───────────────────────────────────────────────────────

export type GuestReviewMode = 'internal' | 'external' | 'both'

export type GuestReviewOffer = {
  mode: GuestReviewMode
  headline: string
  body: string
  /** The private form's prompt. Null when the business has no way to store one. */
  internalPrompt: string | null
  /**
   * The public link, validated. Present whenever the business configured one
   * and reviews are on — under every mode, for every guest, whatever they said
   * privately. See the header.
   */
  externalUrl: string | null
  externalLabel: string | null
}

/**
 * Only `http` and `https`, and only an absolute URL.
 *
 * `review_url` is free text typed by an operator into a settings screen and
 * rendered on a page a stranger opens from a message. A `javascript:` URL in
 * that column would be script execution in the guest's browser on every
 * post-stay screen for that property. A relative URL would be worse in a
 * quieter way: it would point back into the portal, carrying the token.
 */
export function safeExternalUrl(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/**
 * What to offer, given what the business configured.
 *
 * ── The signature is the guarantee ────────────────────────────────────────
 *
 * Two arguments, and neither of them is a rating, a sentiment or a submitted
 * feedback row. There is no way to call this function such that a guest who
 * left one star gets a different answer from one who left five, because the
 * answer does not depend on anything a guest said.
 *
 * ── `canRecordFeedback` is a capability, not a preference ─────────────────
 *
 * Migration 0034 has no table for internal guest feedback and no RPC that
 * writes one. So the private form has nowhere to save, and the caller says
 * whether it does. It defaults to `false`, which is today's truth: a business
 * with a review URL gets the public link and no form, rather than a form that
 * silently discards what somebody took the trouble to write.
 */
export function guestReviewOffer(
  settings: GuestJourneySettings,
  options: { canRecordFeedback?: boolean } = {},
): GuestReviewOffer | null {
  if (!settings.reviewEnabled) return null

  const externalUrl = safeExternalUrl(settings.reviewUrl)
  const canRecordFeedback = options.canRecordFeedback === true

  // Reviews are on and there is neither a form that can save nor a link that
  // can be followed. Nothing to offer — not an empty section, and not a
  // "coming soon".
  if (!canRecordFeedback && externalUrl === null) return null

  const mode: GuestReviewMode =
    canRecordFeedback && externalUrl !== null
      ? 'both'
      : canRecordFeedback
        ? 'internal'
        : 'external'

  return {
    mode,
    headline: 'איך הייתה השהות?',
    body:
      mode === 'both'
        ? 'נשמח לשמוע ממך ישירות, וגם לקרוא ביקורת פומבית אם בא לך לכתוב אחת.'
        : mode === 'internal'
          ? 'נשמח לשמוע ממך ישירות — מה עבד, ומה היה יכול להיות טוב יותר.'
          : 'ביקורת שלך עוזרת לאורחים הבאים לבחור נכון.',
    internalPrompt:
      mode === 'internal' || mode === 'both'
        ? 'מה היה טוב, ומה היה יכול להיות טוב יותר?'
        : null,
    externalUrl,
    externalLabel: externalUrl === null ? null : 'כתיבת ביקורת',
  }
}

// ── §3 · The receipt ──────────────────────────────────────────────────────

export type GuestReceiptOffer = {
  /** The amount the receipt is for. */
  totalLabel: string
  /** Where the document is. Null when the business has not produced one. */
  href: string | null
  /** The payment's own state, in words. Null when nothing is known. */
  notice: GuestPaymentNotice | null
}

/**
 * The receipt, **where applicable** — and applicable means the money settled.
 *
 * Three cases where nothing is offered, and each is a sentence somebody would
 * otherwise have to argue with:
 *
 *   · the booking carries no total     → there is nothing to receipt
 *   · the payment status is unknown    → we do not know that money moved, and
 *                                        a receipt is an assertion that it did
 *   · the payment failed or is pending → likewise
 *
 * The unknown case returns the notice rather than nothing, so the screen still
 * says `אנחנו בודקים את סטטוס התשלום` instead of going quiet on a guest who is
 * wondering whether they were charged.
 */
export function guestReceiptOffer(
  journey: GuestJourney,
  input: {
    paymentStatus?: PaymentStatus | null
    receiptUrl?: string | null
  } = {},
): GuestReceiptOffer | null {
  const status = input.paymentStatus ?? null
  const notice = paymentNotice(status)

  if (journey.current.totalAgorot <= 0) return null

  const settled =
    status === 'paid' ||
    status === 'partially_paid' ||
    status === 'partially_refunded'

  if (!settled) {
    // Nothing to hand over. The notice still travels, because silence about
    // money is its own kind of answer.
    return notice === null
      ? null
      : {
          totalLabel: formatAgorot(journey.current.totalAgorot),
          href: null,
          notice,
        }
  }

  return {
    totalLabel: formatAgorot(journey.current.totalAgorot),
    href: safeExternalUrl(input.receiptUrl ?? null),
    notice,
  }
}

// ── §4 · Rebooking ────────────────────────────────────────────────────────

/**
 * What the next booking would start from.
 *
 * The guest and the property, and nothing else. No dates — the dates are the
 * thing being asked about — and no price, which is the member this type
 * deliberately does not have.
 */
export type GuestRebookPrefill = {
  guestName: string | null
  phone: string | null
  email: string | null
  adults: number
  children: number
  infants: number
}

export type GuestRebookOffer =
  /** The business does not offer it. No card, no dead link. */
  | { kind: 'off' }
  /**
   * Nothing is known to be free, so the screen asks rather than shows. This is
   * the shipped case: `NO_REBOOK_PORT` returns an empty list by design, and
   * the wording must not read as an opening.
   */
  | {
      kind: 'ask'
      headline: string
      body: string
      actionLabel: string
      prefill: GuestRebookPrefill
    }
  /** Ranges the availability port said are actually free. */
  | {
      kind: 'dates'
      headline: string
      body: string
      actionLabel: string
      ranges: GuestOpenRange[]
      prefill: GuestRebookPrefill
    }

/**
 * The rebook card.
 *
 * ── Ranges are passed through, never derived ──────────────────────────────
 *
 * `ranges` is exactly what the caller was handed by `GuestRebookPort`, filtered
 * only for well-formedness. This function invents no date, extends no range
 * and fills no gap between two of them. A range this function emitted that the
 * port did not return would be a date the product has not checked, offered to
 * somebody who would then try to book it.
 */
export function guestRebookOffer(
  journey: GuestJourney,
  input: { openRanges?: readonly GuestOpenRange[] } = {},
): GuestRebookOffer {
  if (!journey.settings.rebookEnabled) return { kind: 'off' }

  const prefill = rebookPrefill(journey)
  const ranges = (input.openRanges ?? []).filter(
    (range) => range.start < range.end,
  )

  if (ranges.length === 0) {
    return {
      kind: 'ask',
      headline: 'רוצים לחזור?',
      body:
        'נשמח לארח אתכם שוב. אנחנו לא יכולים להראות כאן תאריכים פנויים — ' +
        'כתבו לנו מתי נוח לכם ונחזור עם תשובה.',
      actionLabel: 'בדיקת תאריכים מול בית האירוח',
      prefill,
    }
  }

  return {
    kind: 'dates',
    headline: 'רוצים לחזור?',
    body: 'אלה התאריכים הפנויים אצלנו כרגע. המחיר ייקבע מול בית האירוח.',
    actionLabel: 'בקשת הזמנה',
    ranges: ranges.map((range) => ({ start: range.start, end: range.end })),
    prefill,
  }
}

function rebookPrefill(journey: GuestJourney): GuestRebookPrefill {
  const { fields } = journey.details
  const { adults, children, infants } = journey.current

  return {
    guestName: fields.full_name ?? null,
    phone: fields.phone ?? null,
    email: fields.email ?? null,
    adults,
    children,
    infants,
  }
}

// ── §5 · The whole screen ─────────────────────────────────────────────────

/** The one thing the post-stay screen asks. `none` is a real answer. */
export type GuestPostStayAction = {
  id: 'review' | 'rebook' | 'none'
  label: string | null
}

export type GuestPostStayView = {
  headline: string
  body: string
  summary: GuestStaySummary
  review: GuestReviewOffer | null
  receipt: GuestReceiptOffer | null
  rebook: GuestRebookOffer
  action: GuestPostStayAction
}

export type GuestPostStayInput = {
  canRecordFeedback?: boolean
  paymentStatus?: PaymentStatus | null
  receiptUrl?: string | null
  openRanges?: readonly GuestOpenRange[]
}

/**
 * Thank you, and then whatever is actually true.
 *
 * ── One primary action, and why the review wins it ────────────────────────
 *
 * A guest who has just left is at the one moment they will ever be most
 * willing to write a review, and least in need of a second booking. So the
 * review takes the primary action where there is one, rebooking takes it
 * otherwise, and `none` is returned rather than promoting something the
 * business did not configure. Four buttons of equal weight is not a screen
 * with four options, it is a screen with none.
 */
export function buildPostStayView(
  journey: GuestJourney,
  input: GuestPostStayInput = {},
): GuestPostStayView {
  const review = guestReviewOffer(journey.settings, {
    canRecordFeedback: input.canRecordFeedback,
  })
  const receipt = guestReceiptOffer(journey, {
    paymentStatus: input.paymentStatus,
    receiptUrl: input.receiptUrl,
  })
  const rebook = guestRebookOffer(journey, { openRanges: input.openRanges })

  const action: GuestPostStayAction =
    review !== null
      ? {
          id: 'review',
          label:
            review.mode === 'external' ? review.externalLabel : 'כתיבת משוב',
        }
      : rebook.kind === 'ask' || rebook.kind === 'dates'
        ? { id: 'rebook', label: rebook.actionLabel }
        : { id: 'none', label: null }

  return {
    headline: 'תודה שהתארחתם אצלנו',
    body: 'השהות הסתיימה. כל מה שנשאר כאן זמין לך גם מכאן ואילך.',
    summary: guestStaySummary(journey),
    review,
    receipt,
    rebook,
    action,
  }
}
