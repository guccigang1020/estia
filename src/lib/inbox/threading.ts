/**
 * Which thread does an arrival belong to?
 *
 * Pure, and the single most consequential decision in the module. Get it wrong
 * in one direction and a guest's four messages become four threads nobody can
 * follow. Get it wrong in the other and two different people's enquiries are
 * merged into one conversation — which is worse, because it shows one
 * stranger what another stranger wrote.
 *
 * ══ THE RULE, IN ORDER ══════════════════════════════════════════════════════
 *
 *   1. **A guest matches a guest.** If the arrival names a `guestId` and an
 *      open thread has the same one, that is the thread. This is the case the
 *      product copy promises: one thread per guest, whatever channel they used.
 *   2. **Otherwise an identity matches an identity.** A normalised email, or a
 *      normalised phone. Two contacts match only when the SAME field matches —
 *      never "same name", which is not an identity. Half the guesthouses in
 *      this country have had two guests called דוד כהן.
 *   3. **Otherwise it is a new thread.** Cheap to merge later, impossible to
 *      unsee once merged.
 *
 * ══ CLOSED THREADS ARE NOT REOPENED BY DEFAULT ══════════════════════════════
 *
 * Only `open`, `waiting_on_guest` and `waiting_on_us` threads are candidates.
 * A guest who writes in March about a stay settled in January is starting a
 * new conversation, and appending to the closed one buries their new question
 * under a resolved history. `reopenWithin` exists for the narrow case where
 * that is wrong — a reply within a few days — and defaults to zero, because a
 * default that silently reopens is a default that hides messages.
 */

import type { Conversation, ConversationParty } from './types'

/**
 * Comparable form of an email address.
 *
 * Case and surrounding space only. Deliberately NOT stripping dots or
 * `+tags`: those are Gmail's rules and not the internet's, and treating
 * `a.b@example.com` and `ab@example.com` as one person is a guess that merges
 * two strangers' threads at some other provider.
 */
export function normaliseEmail(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim().toLowerCase()
  return trimmed === '' ? null : trimmed
}

/**
 * Comparable form of a phone number: digits, with an Israeli leading zero
 * folded into +972 so `0521234567` and `+972521234567` are one person.
 *
 * Anything that does not look like a phone number comes back null rather than
 * being coerced — a wrong normalisation merges threads, and null merely fails
 * to merge them.
 */
export function normalisePhone(value: string | null): string | null {
  if (value === null) return null
  const digits = value.replace(/[^\d+]/g, '')
  if (digits.length < 7) return null

  if (digits.startsWith('+972'))
    return `+972${digits.slice(4).replace(/^0/, '')}`
  if (digits.startsWith('972'))
    return `+972${digits.slice(3).replace(/^0/, '')}`
  if (digits.startsWith('0')) return `+972${digits.slice(1)}`
  if (digits.startsWith('+')) return digits
  return null
}

/** The statuses a new arrival may be appended to. */
const APPENDABLE = new Set(['open', 'waiting_on_guest', 'waiting_on_us'])

export interface ThreadingOptions {
  /**
   * How long after closing a thread still absorbs a reply, in hours.
   *
   * Zero by default: a closed thread stays closed. See the header.
   */
  readonly reopenWithinHours?: number
}

/**
 * The thread this arrival belongs to, or null for a new one.
 *
 * `candidates` must already be scoped to one organization by the caller; this
 * asserts it anyway, because being wrong here shows one tenant's conversation
 * to another.
 */
export function findThread(
  organizationId: string,
  party: ConversationParty,
  candidates: readonly Conversation[],
  now: Date,
  options: ThreadingOptions = {},
): Conversation | null {
  const reopenWithinHours = options.reopenWithinHours ?? 0

  const eligible = candidates.filter((conversation) => {
    if (conversation.organizationId !== organizationId) return false
    if (APPENDABLE.has(conversation.status)) return true
    if (reopenWithinHours <= 0) return false
    if (conversation.closedAt === null) return false
    const hours =
      (now.getTime() - conversation.closedAt.getTime()) / (60 * 60 * 1000)
    return hours <= reopenWithinHours
  })

  // 1 · A guest matches a guest.
  if (party.guestId !== null) {
    const byGuest = eligible.filter(
      (conversation) => conversation.party.guestId === party.guestId,
    )
    if (byGuest.length > 0) return mostRecent(byGuest)
  }

  // 2 · An identity matches the SAME identity.
  const email = normaliseEmail(party.contactEmail)
  const phone = normalisePhone(party.contactPhone)

  if (email !== null) {
    const byEmail = eligible.filter(
      (conversation) =>
        normaliseEmail(conversation.party.contactEmail) === email,
    )
    if (byEmail.length > 0) return mostRecent(byEmail)
  }

  if (phone !== null) {
    const byPhone = eligible.filter(
      (conversation) =>
        normalisePhone(conversation.party.contactPhone) === phone,
    )
    if (byPhone.length > 0) return mostRecent(byPhone)
  }

  // 3 · A name is not an identity. New thread.
  return null
}

/** When several match, the one most recently spoken in. */
function mostRecent(conversations: readonly Conversation[]): Conversation {
  return [...conversations].sort((a, b) => {
    const left = a.lastMessageAt?.getTime() ?? a.openedAt.getTime()
    const right = b.lastMessageAt?.getTime() ?? b.openedAt.getTime()
    return right - left
  })[0]
}

/**
 * The status a thread should hold after a message.
 *
 * Inbound moves it to `waiting_on_us` even from `waiting_on_guest`: the guest
 * has answered and the ball is back. Outbound moves it to `waiting_on_guest`.
 * A closed thread is not moved by this function — reopening is a decision, not
 * a side effect of somebody typing.
 */
export function statusAfterMessage(
  current: Conversation['status'],
  direction: 'inbound' | 'outbound',
): Conversation['status'] {
  if (current === 'closed') return 'closed'
  return direction === 'inbound' ? 'waiting_on_us' : 'waiting_on_guest'
}
