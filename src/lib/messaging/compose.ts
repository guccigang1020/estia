/**
 * The Hebrew a guest actually reads, and the address it is sent to.
 *
 * ── Composed once, stored, never re-rendered ──────────────────────────────
 *
 * The same argument 0043 makes about `notifications.title`: a message about a
 * booking that has since been cancelled must still say what it said when it
 * was sent. So `compose` is a pure function of a snapshot, the operation calls
 * it once, and what goes in the row is the text — not a template name and a
 * set of ids that a screen would re-render from rows that have since moved.
 *
 * ── Short, because it is read on a telephone ──────────────────────────────
 *
 * Every message says who it is from, which stay it is about, and what is being
 * asked — in that order. A guest who cannot tell a real booking message from a
 * phishing attempt is right not to open the link, and a message that opens
 * with the link is exactly that message.
 *
 * ── Nothing here logs ─────────────────────────────────────────────────────
 *
 * A payment reminder carries an amount and a portal URL. A console line
 * carrying either outlives the stay and is readable by anybody with the log.
 */

import type { Agorot } from '../booking/types'

import { renderTemplate, type PlaceholderValues } from './templates'

import type {
  GuestChannel,
  GuestMessageKind,
  GuestMessageSubject,
  GuestRecipient,
} from './types'

/* --------------------------------------------------------------- the text -- */

export interface ComposedMessage {
  /** Only email carries one. `null` for the channels that have no subject line. */
  subject: string | null
  body: string
}

function greeting(firstName: string | null): string {
  const trimmed = (firstName ?? '').trim()
  return trimmed.length > 0 ? `שלום ${trimmed},` : 'שלום,'
}

function where(subject: GuestMessageSubject): string {
  return subject.propertyName?.trim() || subject.organizationName
}

/**
 * Shekels, as a person writes them.
 *
 * Local to this file and deliberately minimal: the money formatting the
 * product uses on screens belongs to the finance surface, and pulling it in
 * here would make a text composer depend on a rendering layer. What a guest
 * needs is the number and the sign.
 */
function shekels(agorot: Agorot): string {
  const whole = Math.round(agorot) / 100
  const rendered = Number.isInteger(whole) ? String(whole) : whole.toFixed(2)
  return `₪${rendered}`
}

/**
 * The message.
 *
 * `portalUrl` is optional throughout. A business with no portal link
 * configured still gets a message that says something true and complete —
 * dropping the whole message because one line is missing would turn a missing
 * setting into a guest who was never told their check-in time.
 */
export function compose(args: {
  kind: GuestMessageKind
  channel: GuestChannel
  recipient: GuestRecipient
  subject: GuestMessageSubject
  /**
   * The business's own wording, when it has written one.
   *
   * Absent means the built-in text below, unchanged. That fallback is the
   * reason a business can delete a template safely: it goes back to working
   * Hebrew rather than to silence. See `templates.ts`.
   */
  template?: { subject: string | null; body: string } | null
}): ComposedMessage {
  const { kind, subject, recipient } = args
  const place = where(subject)
  const dates = `${subject.checkIn} – ${subject.checkOut}`

  if (args.template) {
    // The values are resolved HERE rather than in `templates.ts`, so that the
    // fallbacks a guest actually reads — `where()` for a missing property,
    // the shekel formatting — stay in the one file that owns the wording.
    const values: PlaceholderValues = {
      guest_first_name: recipient.firstName,
      organization_name: subject.organizationName,
      property_name: place,
      reference: subject.reference,
      check_in: subject.checkIn,
      check_out: subject.checkOut,
      amount:
        subject.outstandingAgorot === null
          ? null
          : shekels(subject.outstandingAgorot),
      portal_url: subject.portalUrl,
    }

    return {
      subject:
        args.channel === 'email' && args.template.subject !== null
          ? renderTemplate(args.template.subject, values)
          : null,
      body: renderTemplate(args.template.body, values),
    }
  }

  const lines: string[] = [greeting(recipient.firstName)]

  if (kind === 'payment_reminder') {
    lines.push(`תזכורת לגבי ההזמנה שלכם ב${place} בתאריכים ${dates}.`)
    // The amount is stated when it is known and the sentence stands without
    // it. "יש יתרה לתשלום" with no number is a message that generates a
    // telephone call; a wrong number would generate a worse one.
    lines.push(
      subject.outstandingAgorot === null
        ? 'נותרה יתרה לתשלום להשלמת ההזמנה.'
        : `נותרה יתרה לתשלום בסך ${shekels(subject.outstandingAgorot)}.`,
    )
    if (subject.portalUrl !== null) {
      lines.push('', 'פרטי התשלום והאפשרויות לתשלום נמצאים כאן:')
      lines.push(subject.portalUrl)
    }
  }

  if (kind === 'arrival_info') {
    lines.push(`ההגעה שלכם ל${place} מתקרבת. תאריכים: ${dates}.`)
    lines.push('מצורפים פרטי ההגעה, הכתובת והוראות הכניסה.')
    if (subject.portalUrl !== null) {
      lines.push('', 'כל הפרטים כאן:')
      lines.push(subject.portalUrl)
    }
  }

  if (kind === 'review_request') {
    lines.push(`תודה שהתארחתם ב${place}.`)
    lines.push('נשמח מאוד אם תוכלו לשתף אותנו איך היה — זה לוקח דקה.')
    if (subject.portalUrl !== null) {
      lines.push('', 'כאן אפשר לכתוב:')
      lines.push(subject.portalUrl)
    }
  }

  lines.push('', subject.organizationName)

  const titles: Record<GuestMessageKind, string> = {
    payment_reminder: `יתרה לתשלום בהזמנה ${subject.reference}`,
    arrival_info: `פרטי ההגעה ל${place}`,
    review_request: `איך היה ב${place}?`,
  }

  return {
    // Only email uses it. Composed for every channel anyway so that the stored
    // row does not change shape when a business connects a mail provider.
    subject: args.channel === 'email' ? titles[kind] : null,
    body: lines.join('\n'),
  }
}

/* ------------------------------------------------------------- the address -- */

/** Which field of the guest a channel reads. */
export function recipientAddress(
  channel: GuestChannel,
  recipient: GuestRecipient,
): string | null {
  const raw = channel === 'email' ? recipient.email : recipient.phone
  const trimmed = (raw ?? '').trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Is this address usable at all?
 *
 * Deliberately loose, and deliberately NOT `agents/phone.normalizePhone`,
 * which accepts Israeli mobile numbers only. That is exactly right for
 * inviting an agent to sign in by SMS and exactly wrong here: a guesthouse in
 * the Galilee hosts French and American guests, and refusing to record a
 * message to a foreign number would be this module deciding who may be a
 * guest. Seven digits is the shortest national number in use anywhere.
 *
 * What this cannot do is tell a working number from a mistyped one. Nothing
 * can, without sending — and the point of the whole module is that nothing is
 * sent while no provider exists.
 */
export function isUsableAddress(
  channel: GuestChannel,
  address: string,
): boolean {
  if (channel === 'email') {
    const at = address.indexOf('@')
    if (at <= 0) return false
    const domain = address.slice(at + 1)
    return (
      domain.includes('.') && !domain.startsWith('.') && !/\s/u.test(address)
    )
  }

  return address.replace(/\D/gu, '').length >= 7
}

/**
 * What is safe to store.
 *
 * Enough to recognise where a message went, never enough to be a contact list.
 * `guest_messages` would otherwise become the one table in the schema where
 * every guest telephone number is listed together, and it is a table an
 * operations screen reads freely.
 *
 * Returns `null` for anything it cannot classify, rather than a row of stars:
 * `***` implies a recipient was recorded when the truth is that nothing usable
 * was.
 */
export function maskRecipient(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) return null

  if (trimmed.includes('@')) {
    const at = trimmed.indexOf('@')
    const local = trimmed.slice(0, at)
    const domain = trimmed.slice(at + 1)
    if (local.length === 0 || domain.length === 0) return null
    return `${local[0]}***@${domain}`
  }

  const digits = trimmed.replace(/\D/gu, '')
  return digits.length >= 3 ? `***${digits.slice(-3)}` : null
}
