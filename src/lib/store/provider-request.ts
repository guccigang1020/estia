/**
 * What leaves the organization, addressed to a company that has no
 * relationship with the guest.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  A PROVIDER LEARNS THE PROPERTY, THE DATE, THE TIME, THE SERVICE AND THE
 *  OPERATIONAL NOTES.
 *
 *  A PROVIDER NEVER LEARNS THE GUEST'S NAME, THEIR TELEPHONE NUMBER, THE
 *  PRICE, THE PAYMENT STATE, OR WHICH AGENT SOLD THE STAY.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This is a privacy boundary, and it is enforced three times over rather than
 * once, because a renderer is exactly the kind of code somebody extends at
 * four in the afternoon:
 *
 *   1. **The schema.** `store_provider_requests` in 0032 has no column for any
 *      of the five. The migration's rehearsal block queries `pg_attribute` and
 *      raises if a column matching `%guest%`, `%phone%`, `%email%`, `%price%`,
 *      `%agorot%`, `%payment%` or `%agent%` ever appears on that table.
 *
 *   2. **The types.** `renderProviderRequest` is handed a `ProviderBrief`,
 *      which is assembled by `providerBriefFor` below. The brief does not
 *      carry a guest, so the renderer cannot leak one — the compiler will not
 *      let it name a field that is not there.
 *
 *   3. **`provider-request.test.ts`**, which builds a booking carrying all
 *      five facts, drives a real order through to a rendered request, and
 *      asserts the output string contains none of them.
 *
 * ── The reference is not the order reference ──────────────────────────────
 *
 * A provider holding `S-4471` could guess `S-4472`. The request carries its
 * own opaque reference, unique per organization, and the join a manager needs
 * is `order_id`, which is internal and is not part of the brief.
 *
 * ── Why the whole message is built here and not in a component ────────────
 *
 * Because it is the artefact, not the view of it. The same string goes into
 * WhatsApp, into an e-mail, onto a printed sheet and into the clipboard, and
 * four renderers would be four chances for one of them to add a helpful
 * "for Mr Cohen".
 */

import type { StoreOrder, StoreProvider } from './types'

/**
 * Everything a provider is told. Note what this type does not have.
 *
 * There is no guest, no telephone, no money and no agent — not as `null`, not
 * as `undefined`, not at all. A field that exists as `null` is a field
 * somebody fills in later.
 */
export type ProviderBrief = {
  /** The business sending the request. The provider needs to know who asks. */
  organizationName: string
  /** The house. A name and, where it exists, an address — the van has to go. */
  propertyName: string
  propertyAddress: string | null
  /** Who at the business to ring. NOT the guest. */
  contactName: string | null
  contactPhone: string | null

  serviceName: string
  /** ISO date, `YYYY-MM-DD`. */
  serviceDate: string
  /** `HH:MM`, or null where the day is the whole answer. */
  serviceTime: string | null
  durationMinutes: number | null
  quantity: number
  operationalNotes: string | null
  /** Opaque, per organization, and deliberately not the order reference. */
  reference: string
}

/**
 * Assemble the brief from an order.
 *
 * This function is the boundary. It takes the order — which does carry a
 * `guestId` and money — and returns a value that carries neither. Everything
 * downstream of here is safe by construction, and everything upstream is
 * ordinary domain code.
 */
export function providerBriefFor(input: {
  order: Pick<StoreOrder, 'requestedForDate' | 'requestedForTime'>
  /** The line being sent out. Its snapshot names the service. */
  line: { itemNameSnapshot: string; quantity: number; notes: string | null }
  organizationName: string
  propertyName: string
  propertyAddress: string | null
  /** The business's own contact, from the property or the organization. */
  contactName: string | null
  contactPhone: string | null
  durationMinutes: number | null
  reference: string
  /** The date the service happens, when the order did not state one. */
  fallbackDate: string
}): ProviderBrief {
  return {
    organizationName: input.organizationName,
    propertyName: input.propertyName,
    propertyAddress: input.propertyAddress,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    serviceName: input.line.itemNameSnapshot,
    serviceDate: input.order.requestedForDate ?? input.fallbackDate,
    serviceTime: input.order.requestedForTime,
    durationMinutes: input.durationMinutes,
    quantity: input.line.quantity,
    // The line's own operational note. A person writing a guest's name into
    // this box is the one hole the type system cannot close, so the screen
    // that offers it says out loud that the provider reads it — see
    // `components/store/provider-request-panel.tsx`.
    operationalNotes: input.line.notes,
    reference: input.reference,
  }
}

/** ISO `YYYY-MM-DD` to `DD/MM/YYYY`, which is what an Israeli supplier reads. */
function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-')
  return year && month && day ? `${day}/${month}/${year}` : iso
}

/**
 * The message itself. Hebrew, plain text, and the same in every channel.
 *
 * Short on purpose. A provider reading this on a telephone needs the house,
 * the day, the time and the job, and everything else is noise they will skim
 * past — including, on a bad day, the line that mattered.
 */
export function renderProviderRequest(brief: ProviderBrief): string {
  const lines: string[] = []

  lines.push(`בקשת שירות · ${brief.organizationName}`)
  lines.push(`אסמכתה: ${brief.reference}`)
  lines.push('')
  lines.push(`שירות: ${brief.serviceName}`)

  if (brief.quantity > 1) lines.push(`כמות: ${brief.quantity}`)

  lines.push(`תאריך: ${formatDate(brief.serviceDate)}`)
  if (brief.serviceTime) lines.push(`שעה: ${brief.serviceTime.slice(0, 5)}`)
  if (brief.durationMinutes) lines.push(`משך: ${brief.durationMinutes} דקות`)

  lines.push('')
  lines.push(`נכס: ${brief.propertyName}`)
  if (brief.propertyAddress) lines.push(`כתובת: ${brief.propertyAddress}`)

  if (brief.operationalNotes && brief.operationalNotes.trim().length > 0) {
    lines.push('')
    lines.push(`הערות: ${brief.operationalNotes.trim()}`)
  }

  if (brief.contactName || brief.contactPhone) {
    lines.push('')
    lines.push(
      `איש קשר אצלנו: ${[brief.contactName, brief.contactPhone]
        .filter(Boolean)
        .join(' · ')}`,
    )
  }

  lines.push('')
  lines.push('אנא אשרו קבלה.')

  return lines.join('\n')
}

/**
 * A reference a provider cannot use to guess another.
 *
 * Eight characters from the system CSPRNG, upper-cased, with the digits and
 * letters that look alike removed — a provider reads this over the telephone
 * and `0`/`O` and `1`/`I` are how a confirmation gets attached to the wrong
 * job.
 */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function mintProviderReference(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)

  let out = ''
  for (const byte of bytes) {
    out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]
  }
  return `P-${out}`
}

/**
 * Which channel a request may go out on, given the provider's own setting.
 *
 * A provider set to WhatsApp with no telephone number cannot be reached that
 * way, and 0032's `store_providers_reachable` refuses to store the
 * combination — but a provider edited to remove a number while a request is
 * pending is a real sequence, so this is checked again at send time.
 */
export function canReach(
  provider: Pick<StoreProvider, 'defaultChannel' | 'phone' | 'email'>,
  channel: string,
): boolean {
  switch (channel) {
    case 'whatsapp':
    case 'sms':
    case 'phone':
      return Boolean(provider.phone && provider.phone.trim().length > 0)
    case 'email':
      return Boolean(provider.email && provider.email.trim().length > 0)
    case 'print':
    case 'copy':
      return true
    default:
      return false
  }
}
