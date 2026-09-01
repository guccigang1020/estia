/**
 * The link that goes to the guest, and the message it travels in.
 *
 * ── Why "copy the message" is a complete answer ───────────────────────────
 *
 * Most guesthouses in this market have no WhatsApp Business integration, no
 * SMS gateway and no transactional mail provider. The product has two possible
 * responses to that. It can show four buttons with three of them greyed out and
 * a tooltip explaining what the owner would need to buy — or it can compose the
 * message, hand it over, and let them paste it into the WhatsApp they already
 * have open on the same telephone.
 *
 * This module does the second, and `copy` is therefore a first-class channel
 * in `guest_link_channel` rather than a fallback. A send recorded as `copy` is
 * a real send: it is what makes "sent and never opened" true for a business
 * that will never configure an integration, and that question is the entire
 * point of `guest_link_first_opened_at`.
 *
 * ── The token is in the URL, so the message is a credential ───────────────
 *
 * Everything here composes text containing a bearer token for one booking.
 * Two consequences, both enforced below rather than remembered:
 *
 *   · `maskRecipient` runs before anything is stored. `guest_link_sends` would
 *     otherwise become the one table in the schema where every guest telephone
 *     number is listed together.
 *
 *   · Nothing here logs. The composed message is returned to the caller and
 *     never printed, because a console line carrying a guest link outlives the
 *     stay and is readable by anybody with the log.
 */

import { normalizePhone } from '../agents/phone'

import type { GuestLinkChannel } from './types'

/** Where the portal lives. One definition, so nothing composes `/g/` by hand. */
export const GUEST_PORTAL_PREFIX = '/g'

/**
 * The link.
 *
 * `origin` is passed rather than read from the environment, because the value
 * that has to appear in the message is the host the GUEST will open — which on
 * a self-hosted deployment, behind a proxy, or in a preview build is not the
 * same as whatever a server module happens to know about itself.
 */
export function guestLinkUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/u, '')
  return `${base}${GUEST_PORTAL_PREFIX}/${encodeURIComponent(token.trim())}`
}

/** Why the message is being sent. Changes the wording, never the link. */
export type GuestMessagePurpose = 'first' | 'reminder' | 'rotated'

export type GuestMessageInput = {
  purpose: GuestMessagePurpose
  /** First name only, matching what 0033's projection discloses. */
  guestFirstName: string | null
  organizationName: string
  propertyName: string | null
  /** `3.9.2026`, already formatted — this module does not own date wording. */
  checkIn: string
  checkOut: string
  url: string
}

export type GuestMessage = {
  /** Only used by email. The other channels have no subject line. */
  subject: string
  body: string
}

function greeting(name: string | null): string {
  const trimmed = (name ?? '').trim()
  return trimmed.length > 0 ? `שלום ${trimmed},` : 'שלום,'
}

function where(input: GuestMessageInput): string {
  return input.propertyName?.trim() || input.organizationName
}

/**
 * The message.
 *
 * Short, because it is read on a telephone. It says who it is from, which stay
 * it is about, and what the link does — in that order, because a link with no
 * context is a link people do not open, and a guest who cannot tell a real
 * booking message from a phishing attempt is right not to.
 */
export function composeGuestMessage(input: GuestMessageInput): GuestMessage {
  const place = where(input)
  const dates = `${input.checkIn} – ${input.checkOut}`

  const opening: Record<GuestMessagePurpose, string> = {
    first: `הזמנתכם ב${place} מוכנה.`,
    reminder: `תזכורת: ההזמנה שלכם ב${place} ממתינה להשלמה.`,
    // Says plainly that the old link stopped working. A guest who bookmarked
    // it and gets "לא מצאנו את ההזמנה" with no explanation assumes the booking
    // was cancelled, and telephones to ask.
    rotated: `נשלח לכם קישור חדש להזמנה ב${place}. הקישור הקודם אינו פעיל יותר.`,
  }

  const body = [
    greeting(input.guestFirstName),
    opening[input.purpose],
    `תאריכים: ${dates}`,
    '',
    'בקישור אפשר לראות את פרטי ההזמנה, לאשר אותם ולהשלים את מה שנדרש:',
    input.url,
    '',
    `${input.organizationName}`,
  ].join('\n')

  return {
    subject:
      input.purpose === 'rotated'
        ? `קישור חדש להזמנה ב${place}`
        : `ההזמנה שלכם ב${place}`,
    body,
  }
}

/**
 * The href that opens the channel's own app with the message ready to send.
 *
 * Returns null for `copy`, and for any channel whose recipient is unusable —
 * a `wa.me` link built from a malformed number opens WhatsApp on a chat with
 * nobody, which looks like the product working and is not. The caller falls
 * back to handing over the text.
 */
export function channelHref(
  channel: GuestLinkChannel,
  message: GuestMessage,
  recipient: string | null,
): string | null {
  if (channel === 'copy') return null

  if (channel === 'whatsapp') {
    const phone = normalizePhone(recipient)
    if (!phone.ok) return null
    // wa.me wants the E.164 digits with no plus.
    return `https://wa.me/${phone.e164.replace(/^\+/u, '')}?text=${encodeURIComponent(message.body)}`
  }

  if (channel === 'sms') {
    const phone = normalizePhone(recipient)
    if (!phone.ok) return null
    // `?body=` is the form both iOS and Android accept.
    return `sms:${phone.e164}?body=${encodeURIComponent(message.body)}`
  }

  const address = (recipient ?? '').trim()
  if (address.length === 0 || !address.includes('@')) return null
  return `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent(
    message.subject,
  )}&body=${encodeURIComponent(message.body)}`
}

/**
 * What is safe to write into `guest_link_sends.recipient_masked`.
 *
 * Enough to recognise the number or address you sent to, and not enough to be
 * a contact list. A telephone number keeps its last three digits; an address
 * keeps its first character and its domain.
 *
 * Returns null rather than a mask for something it cannot classify — writing
 * `***` for an unrecognised value implies a recipient was recorded when the
 * truth is that nothing usable was.
 */
export function maskRecipient(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) return null

  if (trimmed.includes('@')) {
    const [local, domain] = trimmed.split('@')
    if (!domain || local.length === 0) return null
    return `${local[0]}***@${domain}`
  }

  const phone = normalizePhone(trimmed)
  if (phone.ok) return `***${phone.national.slice(-3)}`

  const digits = trimmed.replace(/\D/gu, '')
  if (digits.length >= 3) return `***${digits.slice(-3)}`

  return null
}
