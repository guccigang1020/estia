/**
 * Is this the same person?
 *
 * ── Why this function refuses more than it decides ────────────────────────
 *
 * A wrong merge welds two families' stay histories together. One card now holds
 * both families' telephone numbers, both sets of notes, both marketing consents
 * and both sets of stays; the guest portal link one of them holds opens onto
 * the other's history; and the damage is close to unrecoverable, because
 * nothing in the merged record says which half came from where.
 *
 * A missed merge produces two cards for one person. Somebody notices, and
 * merging two cards later is a supported act with both sides visible.
 *
 * Those two outcomes are not symmetrical, and this file is written for the
 * asymmetry. It matches on identifiers that are *keys* and refuses everything
 * else, and where it does match it produces a **candidate for a person to
 * confirm** rather than a merge.
 *
 * ── Names are not identity, and this is not a judgement call ──────────────
 *
 * Israel has a few dozen extremely common surnames. A three-year import of a
 * guesthouse in the north will contain eleven unrelated families called כהן,
 * four called לוי and two genuinely different people called דוד כהן — one of
 * whom came in 2023 and one in 2025. Matching on a name, even a full name, even
 * a full name plus a city, merges them. So the name is used for exactly one
 * thing here: labelling a candidate that some *other* evidence produced, so the
 * person deciding can see who they are being asked about.
 *
 * ── The two keys, and why only these two ──────────────────────────────────
 *
 * **Normalised telephone.** `normalizePhone` from `src/lib/agents/phone.ts` —
 * the same function the agent network, the guest card and the database's own
 * `normalize_phone_il` generated column agree on. It is imported and not
 * rewritten: a second normaliser is a second definition of identity, and the
 * day the two disagree is the day `guests_organization_phone_idx` and this
 * module hold different opinions about who exists.
 *
 * **Email, and only where the incoming record's email is trusted.** An email
 * typed by a receptionist into a legacy system is not evidence of anything —
 * `info@` addresses shared by a family, a placeholder `noemail@x.com` used for
 * walk-ins, and one address serving a whole company are all normal. So an email
 * match is offered only when the caller says the source verified it, and
 * addresses on the shared-mailbox list are never a match at all.
 */

import { normalizePhone } from '../agents/phone'
import type { DuplicateCandidate, ImportEntity, ImportRecord } from './types'

/**
 * A guest already in ESTIA, as this module needs to see one.
 *
 * Deliberately small, and deliberately plain data. It is part of the dry run's
 * input, and the dry run proves at compile time that its whole input holds no
 * functions — see the note at the top of `dryrun.ts`.
 */
export type ExistingGuest = {
  id: string
  fullName: string
  /** Already E.164, as `guests.phone_e164` stores it. */
  phoneE164: string | null
  email: string | null
}

/**
 * Addresses that identify a mailbox rather than a person.
 *
 * Matching on one of these merges a family, a company and a walk-in into a
 * single guest card. The list is short and covers what actually appears in
 * Israeli legacy exports; anything not on it is still only a match when the
 * caller vouches for the address.
 */
const SHARED_MAILBOXES: ReadonlySet<string> = new Set([
  'info',
  'office',
  'contact',
  'admin',
  'booking',
  'bookings',
  'reservations',
  'noemail',
  'no-email',
  'none',
  'na',
  'test',
  'guest',
])

/** `Daniel.Cohen+air@Gmail.com ` → `daniel.cohen+air@gmail.com`. */
export function normalizeEmail(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0) return null
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return null
  return trimmed
}

/**
 * Would matching on this address merge a mailbox rather than a person?
 *
 * The local part is compared whole rather than by prefix. `information@` is a
 * shared mailbox and `info.cohen@` is a person, and a `startsWith` would refuse
 * the second along with the first.
 */
export function isSharedMailbox(email: string): boolean {
  const at = email.indexOf('@')
  if (at <= 0) return false
  const local = email.slice(0, at)
  const stem = local.split('+')[0] ?? local
  return SHARED_MAILBOXES.has(stem)
}

/**
 * The identity keys of one incoming record.
 *
 * `null` for either means "this record offers no evidence of that kind", which
 * is a different thing from "it does not match" and is why they are nullable
 * rather than empty strings.
 */
export interface IdentityKeys {
  phoneE164: string | null
  email: string | null
}

export function identityOf(
  values: { phone: string | null; email: string | null },
  options: { emailIsVerified?: boolean } = {},
): IdentityKeys {
  const phone = normalizePhone(values.phone)
  const email = normalizeEmail(values.email)

  const usableEmail =
    email !== null && options.emailIsVerified === true && !isSharedMailbox(email)

  return {
    phoneE164: phone.ok ? phone.e164 : null,
    email: usableEmail ? email : null,
  }
}

export interface DedupeOptions {
  /**
   * Does the source system verify the addresses it exports?
   *
   * Defaults to **false**, and that default is the safe direction. A caller who
   * has not thought about it gets telephone-only matching, which under-merges;
   * the opposite default would over-merge on the strength of an assumption
   * nobody made.
   */
  emailIsVerified?: boolean
}

/**
 * Guests this import believes already exist, as candidates for a person.
 *
 * Never merges. Never mutates. Produces at most one candidate per incoming row,
 * because being told "this row may be two different existing guests" is not a
 * decision anybody can make from a list — that situation means the existing
 * data is already ambiguous and belongs on the guests screen, not here.
 */
export function findDuplicateGuests(
  records: readonly ImportRecord[],
  existing: readonly ExistingGuest[],
  options: DedupeOptions = {},
): readonly DuplicateCandidate[] {
  const byPhone = new Map<string, ExistingGuest>()
  const byEmail = new Map<string, ExistingGuest>()

  for (const guest of existing) {
    if (guest.phoneE164 !== null && guest.phoneE164.length > 0) {
      // First wins. A second existing guest on the same number is a
      // pre-existing duplicate in ESTIA and not something an import created;
      // pointing at either one is equally correct and pointing at none would
      // hide the collision entirely.
      if (!byPhone.has(guest.phoneE164)) byPhone.set(guest.phoneE164, guest)
    }
    const email = normalizeEmail(guest.email)
    if (email !== null && !isSharedMailbox(email) && !byEmail.has(email)) {
      byEmail.set(email, guest)
    }
  }

  const candidates: DuplicateCandidate[] = []

  for (const record of records) {
    if (record.values.entity !== 'guests') continue
    const incoming = record.values.guest

    const keys = identityOf(incoming, options)

    // Telephone first, always. It is the stronger key in this market — it is
    // what an operator types to find somebody, what the invitation goes to and
    // what the database's own unique index is built on.
    if (keys.phoneE164 !== null) {
      const match = byPhone.get(keys.phoneE164)
      if (match) {
        candidates.push(
          candidate(record.rowNumber, 'phone', keys.phoneE164, match, incoming),
        )
        continue
      }
    }

    if (keys.email !== null) {
      const match = byEmail.get(keys.email)
      if (match) {
        candidates.push(
          candidate(record.rowNumber, 'email', keys.email, match, incoming),
        )
      }
    }
  }

  return candidates
}

function candidate(
  rowNumber: number,
  matchedOn: 'phone' | 'email',
  matchedValue: string,
  existing: ExistingGuest,
  incoming: { fullName: string },
): DuplicateCandidate {
  const entity: ImportEntity = 'guests'
  return {
    rowNumber,
    entity,
    matchedOn,
    matchedValue,
    existingId: existing.id,
    existingLabel: existing.fullName,
    incomingLabel: incoming.fullName,
  }
}

/**
 * Two records in the *same file* that are the same person.
 *
 * A three-year export routinely holds one guest once per stay. Left alone that
 * becomes six guest cards for one family, which is the failure this import
 * exists to avoid rather than to reproduce faithfully. Grouped on the same two
 * keys and by the same rules — never on a name.
 *
 * Returns the row numbers that should collapse onto the first occurrence.
 * Nothing is dropped; `apply.ts` writes the first and points the rest at it.
 */
export function groupDuplicatesInFile(
  records: readonly ImportRecord[],
  options: DedupeOptions = {},
): ReadonlyMap<number, number> {
  const firstByPhone = new Map<string, number>()
  const firstByEmail = new Map<string, number>()
  const collapse = new Map<number, number>()

  for (const record of records) {
    if (record.values.entity !== 'guests') continue

    const keys = identityOf(record.values.guest, options)

    if (keys.phoneE164 !== null) {
      const first = firstByPhone.get(keys.phoneE164)
      if (first !== undefined) {
        collapse.set(record.rowNumber, first)
        continue
      }
      firstByPhone.set(keys.phoneE164, record.rowNumber)
    }

    if (keys.email !== null) {
      const first = firstByEmail.get(keys.email)
      if (first !== undefined) {
        collapse.set(record.rowNumber, first)
        continue
      }
      firstByEmail.set(keys.email, record.rowNumber)
    }
  }

  return collapse
}
