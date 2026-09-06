import { describe, expect, it } from 'vitest'

import { byLongestWait, countInbox, hoursWaiting, isUnreadFor } from './unread'
import type { Conversation } from './types'

const ORG = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-09-06T12:00:00.000Z')
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000)

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c-1',
  organizationId: ORG,
  propertyId: null,
  party: {
    guestId: null,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
  },
  subject: null,
  status: 'waiting_on_us',
  origin: 'staff',
  siteRequestId: null,
  guestRequestId: null,
  assignedToUserId: null,
  lastMessageAt: hoursAgo(2),
  lastInboundAt: hoursAgo(2),
  openedAt: hoursAgo(48),
  closedAt: null,
  version: 1,
  ...over,
})

describe('unread is per person', () => {
  it('is unread when this reader has never opened it', () => {
    expect(isUnreadFor(conversation(), new Map())).toBe(true)
  })

  it('is read once THIS reader has seen the latest arrival', () => {
    const marks = new Map([['c-1', hoursAgo(1)]])
    expect(isUnreadFor(conversation(), marks)).toBe(false)
  })

  it('goes unread again when something new arrives', () => {
    const marks = new Map([['c-1', hoursAgo(3)]])
    expect(
      isUnreadFor(conversation({ lastInboundAt: hoursAgo(2) }), marks),
    ).toBe(true)
  })

  it('is unaffected by what a colleague has read', () => {
    // The whole design. A manager opening a thread must not clear it for the
    // three people who never saw it — that is how a shared mailbox loses a
    // message while telling everybody it was handled.
    const managerHasRead = new Map([['c-1', hoursAgo(1)]])
    const colleagueHasNot = new Map<string, Date>()
    expect(isUnreadFor(conversation(), managerHasRead)).toBe(false)
    expect(isUnreadFor(conversation(), colleagueHasNot)).toBe(true)
  })

  it('is never unread when the last thing said was ours', () => {
    // Otherwise answering a guest makes your own inbox worse, which teaches
    // people not to answer.
    const ourReply = conversation({
      lastInboundAt: null,
      lastMessageAt: hoursAgo(1),
    })
    expect(isUnreadFor(ourReply, new Map())).toBe(false)
  })
})

describe('the four numbers', () => {
  const me = 'user-me'

  it('counts what it says it counts', () => {
    const counts = countInbox(
      [
        conversation({ id: 'a' }),
        conversation({ id: 'b', assignedToUserId: me }),
        conversation({ id: 'c', assignedToUserId: 'user-other' }),
        conversation({ id: 'd', status: 'waiting_on_guest' }),
        conversation({ id: 'e', status: 'closed' }),
      ],
      new Map(),
      me,
    )

    expect(counts).toEqual({
      unread: 4, // every open thread with an arrival; the closed one is skipped
      waitingOnUs: 3,
      mine: 1,
      unassigned: 1,
    })
  })

  it('does not show each person only their own share of the queue', () => {
    // "Eleven guests are waiting" is a fact about the business. Filtering it
    // per person is how a queue grows while everybody's screen looks calm.
    const counts = countInbox(
      [
        conversation({ id: 'a', assignedToUserId: 'user-other' }),
        conversation({ id: 'b', assignedToUserId: 'user-other' }),
      ],
      new Map(),
      me,
    )
    expect(counts.waitingOnUs).toBe(2)
    expect(counts.mine).toBe(0)
  })

  it('ignores closed threads entirely', () => {
    const counts = countInbox(
      [conversation({ status: 'closed' })],
      new Map(),
      me,
    )
    expect(counts).toEqual({
      unread: 0,
      waitingOnUs: 0,
      mine: 0,
      unassigned: 0,
    })
  })
})

describe('how long they have been waiting', () => {
  it('measures from the arrival, not from any later change', () => {
    // A thread reopened, reassigned or relabelled has not been answered.
    expect(
      hoursWaiting(conversation({ lastInboundAt: hoursAgo(30) }), NOW),
    ).toBe(30)
  })

  it('is null when nobody is waiting on us', () => {
    expect(
      hoursWaiting(conversation({ status: 'waiting_on_guest' }), NOW),
    ).toBeNull()
    expect(
      hoursWaiting(conversation({ status: 'closed', closedAt: NOW }), NOW),
    ).toBeNull()
  })
})

describe('the order', () => {
  it('puts the longest wait first, not the newest message', () => {
    // Newest-first is what every mailbox does, and it buries the guest who has
    // been waiting since Thursday under this morning's traffic.
    const thursday = conversation({
      id: 'thursday',
      lastInboundAt: hoursAgo(72),
    })
    const thisMorning = conversation({
      id: 'morning',
      lastInboundAt: hoursAgo(2),
    })

    const ordered = byLongestWait([thisMorning, thursday], NOW)
    expect(ordered.map((c) => c.id)).toEqual(['thursday', 'morning'])
  })

  it('sorts threads nobody is waiting on below those that are', () => {
    const waiting = conversation({ id: 'waiting', lastInboundAt: hoursAgo(1) })
    const answered = conversation({
      id: 'answered',
      status: 'waiting_on_guest',
      lastMessageAt: NOW,
    })
    expect(byLongestWait([answered, waiting], NOW).map((c) => c.id)).toEqual([
      'waiting',
      'answered',
    ])
  })
})
