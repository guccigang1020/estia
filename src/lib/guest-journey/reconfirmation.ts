/**
 * What changed since the guest said yes.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * A guest confirms a four-night stay for two adults at ₪7,500. A week later
 * somebody moves the dates and the price goes to ₪8,000. The booking still
 * carries a confirmation, the journey tab still shows a green tick, and
 * everybody downstream — the arrival gate, the owner's statement, the argument
 * at the front door — behaves as though the guest agreed to ₪8,000.
 *
 * They did not. They agreed to ₪7,500, and the record of it is
 * `booking_guest_confirmations.snapshot`, frozen at the moment of approval by
 * the database rather than composed by any client. This file compares that
 * snapshot with the live terms and produces the sentence a person can actually
 * check: **מחיר קודם ₪7,500 / מחיר חדש ₪8,000**.
 *
 * ── Why the comparison is here and the refusal is in SQL ──────────────────
 *
 * Two halves, deliberately split.
 *
 * `guest_portal_confirm` refuses outright when the version it is handed is not
 * the live one — that is the hard guarantee, and it holds against a crafted
 * request, a stale tab and a resubmitted form alike. It is in the database
 * because it must be true regardless of which screen is asking.
 *
 * This file is the *explanation*. It never gates anything. It works out which
 * of the four kinds of change happened and words them, so the guest is asked
 * to reconfirm something specific instead of being told "the booking has
 * changed, please confirm again" — which is a sentence that teaches people to
 * press the button without reading.
 *
 * ── Why a version bump alone is not a reason to re-ask ────────────────────
 *
 * `bookings.version` moves when anybody touches the row: an internal note, a
 * status change, a corrected spelling of a surname. Treating every bump as a
 * material change would put a reconfirmation screen in front of a guest for
 * things that do not concern them, and the third time that happens they stop
 * reading it. So the trigger is the CONTENT — dates, heads, money, cancellation
 * terms — and which of those four count is the business's own setting.
 */

import { formatDayMonthYear } from '../booking/dates'
import { formatAgorot } from '../plans/plan'

import type {
  GuestConfirmation,
  GuestJourneySettings,
  GuestJourneyTerms,
  ReconfirmationTrigger,
} from './types'

/** One thing that moved, in words a guest can check against their own memory. */
export type GuestTermsChange = {
  trigger: ReconfirmationTrigger
  /** `מחיר`, `תאריכים`, `מספר אורחים`, `תנאי ביטול`. */
  label: string
  /** As the guest approved it. Null when the snapshot did not carry it. */
  before: string | null
  /** As it stands now. */
  after: string
}

export type ReconfirmationVerdict = {
  /** True when the guest has approved something and it no longer matches. */
  changed: boolean
  /**
   * True when at least one change is one this business treats as material.
   * The screen shows the dominant "אשר מחדש" action only when this is true.
   */
  required: boolean
  /** Every difference found, material or not. */
  changes: GuestTermsChange[]
  /**
   * Changes the business chose NOT to treat as requiring reconfirmation.
   * Still shown, quietly — a guest whose cancellation terms moved is entitled
   * to notice even where the business does not re-ask.
   */
  informational: GuestTermsChange[]
}

const LABEL: Record<ReconfirmationTrigger, string> = {
  dates: 'תאריכים',
  guests: 'מספר אורחים',
  price: 'מחיר',
  cancellation: 'תנאי ביטול',
}

/** `2 מבוגרים · 1 ילד · 1 תינוק`, skipping whatever is zero. */
export function describeParty(
  adults: number,
  children: number,
  infants: number,
): string {
  const parts: string[] = []
  if (adults > 0) parts.push(adults === 1 ? 'מבוגר אחד' : `${adults} מבוגרים`)
  if (children > 0) parts.push(children === 1 ? 'ילד אחד' : `${children} ילדים`)
  if (infants > 0) {
    parts.push(infants === 1 ? 'תינוק אחד' : `${infants} תינוקות`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'ללא אורחים'
}

function describeRange(checkIn: string, checkOut: string): string {
  return `${formatDayMonthYear(checkIn)} – ${formatDayMonthYear(checkOut)}`
}

/**
 * Whether two cancellation texts differ in a way worth telling somebody about.
 *
 * Whitespace-insensitive on purpose. A business that re-wraps a paragraph or
 * pastes it back with a trailing newline has not changed its terms, and a
 * reconfirmation screen raised by an invisible character is one nobody can
 * explain — least of all to the guest looking at two identical paragraphs.
 */
function cancellationDiffers(before: string | null, after: string | null) {
  const normalise = (value: string | null) =>
    (value ?? '').replace(/\s+/gu, ' ').trim()
  return normalise(before) !== normalise(after)
}

/**
 * Compare what was approved with what is true now.
 *
 * Returns `changed: false` when there is no confirmation at all — an
 * unconfirmed booking has not changed, it has simply never been agreed, and
 * conflating the two would put "ההזמנה עודכנה" in front of a guest opening
 * their link for the first time.
 */
export function compareTerms(
  confirmation: GuestConfirmation | null,
  current: GuestJourneyTerms,
  settings: GuestJourneySettings,
): ReconfirmationVerdict {
  if (!confirmation) {
    return { changed: false, required: false, changes: [], informational: [] }
  }

  const snapshot = confirmation.snapshot
  const found: GuestTermsChange[] = []

  // ── Dates ──────────────────────────────────────────────────────────────
  if (
    snapshot.checkIn !== current.checkIn ||
    snapshot.checkOut !== current.checkOut
  ) {
    found.push({
      trigger: 'dates',
      label: LABEL.dates,
      before:
        snapshot.checkIn && snapshot.checkOut
          ? describeRange(snapshot.checkIn, snapshot.checkOut)
          : null,
      after: describeRange(current.checkIn, current.checkOut),
    })
  }

  // ── Heads ──────────────────────────────────────────────────────────────
  // Compared as three numbers rather than as a total: two adults becoming one
  // adult and one child is the same total and a different stay, and a business
  // charging per adult would price it differently.
  if (
    snapshot.adults !== current.adults ||
    snapshot.children !== current.children ||
    snapshot.infants !== current.infants
  ) {
    found.push({
      trigger: 'guests',
      label: LABEL.guests,
      before:
        snapshot.adults === null
          ? null
          : describeParty(
              snapshot.adults,
              snapshot.children ?? 0,
              snapshot.infants ?? 0,
            ),
      after: describeParty(current.adults, current.children, current.infants),
    })
  }

  // ── Money ──────────────────────────────────────────────────────────────
  // A currency change counts as a price change. ₪7,500 becoming $7,500 is not
  // the same deal, and comparing only the number would miss it entirely.
  if (
    snapshot.totalAgorot !== current.totalAgorot ||
    (snapshot.currency !== null && snapshot.currency !== current.currency)
  ) {
    found.push({
      trigger: 'price',
      label: LABEL.price,
      before:
        snapshot.totalAgorot === null
          ? null
          : formatAgorot(snapshot.totalAgorot),
      after: formatAgorot(current.totalAgorot),
    })
  }

  // ── Cancellation terms ─────────────────────────────────────────────────
  if (
    cancellationDiffers(snapshot.cancellationTerms, current.cancellationTerms)
  ) {
    found.push({
      trigger: 'cancellation',
      label: LABEL.cancellation,
      before: snapshot.cancellationTerms,
      after: current.cancellationTerms ?? 'ללא תנאי ביטול',
    })
  }

  const triggers = new Set<string>(settings.reconfirmationTriggers)
  const changes = found.filter((change) => triggers.has(change.trigger))
  const informational = found.filter((change) => !triggers.has(change.trigger))

  return {
    changed: found.length > 0,
    required: changes.length > 0,
    changes,
    informational,
  }
}

/**
 * The heading a guest sees when something moved.
 *
 * One sentence, and it names what changed rather than saying "עודכנה" and
 * leaving them to find it. The detail lines carry the before and after.
 */
export function reconfirmationHeadline(verdict: ReconfirmationVerdict): string {
  if (!verdict.required) return 'ההזמנה שלך'
  const labels = verdict.changes.map((change) => change.label)
  if (labels.length === 1) return `ההזמנה עודכנה — ${labels[0]}`
  return `ההזמנה עודכנה — ${labels.slice(0, -1).join(', ')} ו${labels.at(-1)}`
}
