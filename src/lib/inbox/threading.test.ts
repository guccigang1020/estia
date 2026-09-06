import { describe, expect, it } from 'vitest'

import {
  findThread,
  normaliseEmail,
  normalisePhone,
  statusAfterMessage,
} from './threading'
import type { Conversation, ConversationParty } from './types'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-06T12:00:00.000Z')

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
  status: 'open',
  origin: 'staff',
  siteRequestId: null,
  guestRequestId: null,
  assignedToUserId: null,
  lastMessageAt: new Date('2026-09-05T12:00:00.000Z'),
  lastInboundAt: null,
  openedAt: new Date('2026-09-01T12:00:00.000Z'),
  closedAt: null,
  version: 1,
  ...over,
})

const party = (over: Partial<ConversationParty> = {}): ConversationParty => ({
  guestId: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  ...over,
})

describe('a guest matches a guest', () => {
  it('threads a guest onto their own conversation', () => {
    const mine = conversation({ id: 'mine', party: party({ guestId: 'g-1' }) })
    const other = conversation({
      id: 'other',
      party: party({ guestId: 'g-2' }),
    })

    const found = findThread(ORG, party({ guestId: 'g-1' }), [mine, other], NOW)
    expect(found?.id).toBe('mine')
  })

  it('is what makes one thread per guest across channels true', () => {
    // The product copy promises exactly this. A guest who wrote from the site
    // and then on WhatsApp is one conversation.
    const existing = conversation({
      id: 'from-site',
      party: party({ guestId: 'g-1', contactEmail: 'dana@example.com' }),
    })
    const onWhatsApp = party({ guestId: 'g-1', contactPhone: '0521234567' })
    expect(findThread(ORG, onWhatsApp, [existing], NOW)?.id).toBe('from-site')
  })
})

describe('an identity matches the same identity', () => {
  it('threads on a normalised email', () => {
    const existing = conversation({
      id: 'e',
      party: party({ contactEmail: 'Dana@Example.com ' }),
    })
    const found = findThread(
      ORG,
      party({ contactEmail: 'dana@example.com' }),
      [existing],
      NOW,
    )
    expect(found?.id).toBe('e')
  })

  it('threads an Israeli number written either way', () => {
    const existing = conversation({
      id: 'p',
      party: party({ contactPhone: '+972-52-123-4567' }),
    })
    const found = findThread(
      ORG,
      party({ contactPhone: '052 1234567' }),
      [existing],
      NOW,
    )
    expect(found?.id).toBe('p')
  })

  it('NEVER threads on a name', () => {
    // Half the guesthouses in this country have had two guests called
    // דוד כהן. Merging them shows one stranger what another wrote.
    const existing = conversation({
      id: 'n',
      party: party({ contactName: 'דוד כהן' }),
    })
    const found = findThread(
      ORG,
      party({ contactName: 'דוד כהן' }),
      [existing],
      NOW,
    )
    expect(found).toBeNull()
  })

  it('does not cross-match a phone against an email', () => {
    const existing = conversation({
      id: 'e',
      party: party({ contactEmail: 'dana@example.com' }),
    })
    expect(
      findThread(ORG, party({ contactPhone: '0521234567' }), [existing], NOW),
    ).toBeNull()
  })
})

describe('the tenant boundary', () => {
  it('never threads onto another organization conversation', () => {
    const foreign = conversation({
      id: 'foreign',
      organizationId: OTHER_ORG,
      party: party({ guestId: 'g-1' }),
    })
    expect(
      findThread(ORG, party({ guestId: 'g-1' }), [foreign], NOW),
    ).toBeNull()
  })
})

describe('closed threads', () => {
  const closed = conversation({
    id: 'closed',
    status: 'closed',
    closedAt: new Date('2026-09-05T12:00:00.000Z'),
    party: party({ guestId: 'g-1' }),
  })

  it('are not reopened by default', () => {
    // A guest writing in March about a January stay is starting a new
    // conversation, not continuing a resolved one.
    expect(findThread(ORG, party({ guestId: 'g-1' }), [closed], NOW)).toBeNull()
  })

  it('absorb a reply only inside an explicit window', () => {
    const found = findThread(ORG, party({ guestId: 'g-1' }), [closed], NOW, {
      reopenWithinHours: 48,
    })
    expect(found?.id).toBe('closed')
  })

  it('stay closed once the window has passed', () => {
    const found = findThread(ORG, party({ guestId: 'g-1' }), [closed], NOW, {
      reopenWithinHours: 12,
    })
    expect(found).toBeNull()
  })
})

describe('when several match', () => {
  it('takes the one most recently spoken in', () => {
    const older = conversation({
      id: 'older',
      party: party({ guestId: 'g-1' }),
      lastMessageAt: new Date('2026-08-01T12:00:00.000Z'),
    })
    const newer = conversation({
      id: 'newer',
      party: party({ guestId: 'g-1' }),
      lastMessageAt: new Date('2026-09-05T12:00:00.000Z'),
    })
    expect(
      findThread(ORG, party({ guestId: 'g-1' }), [older, newer], NOW)?.id,
    ).toBe('newer')
  })
})

describe('what a message does to the status', () => {
  it('an arrival puts the ball back with us', () => {
    expect(statusAfterMessage('waiting_on_guest', 'inbound')).toBe(
      'waiting_on_us',
    )
    expect(statusAfterMessage('open', 'inbound')).toBe('waiting_on_us')
  })

  it('a reply passes it back to them', () => {
    expect(statusAfterMessage('waiting_on_us', 'outbound')).toBe(
      'waiting_on_guest',
    )
  })

  it('never reopens a closed thread as a side effect of typing', () => {
    // Reopening is a decision somebody makes, not something that happens
    // because a message was recorded.
    expect(statusAfterMessage('closed', 'inbound')).toBe('closed')
    expect(statusAfterMessage('closed', 'outbound')).toBe('closed')
  })
})

describe('the normalisers, on their own', () => {
  it('lower-cases and trims an email and nothing else', () => {
    expect(normaliseEmail('  Dana@Example.COM ')).toBe('dana@example.com')
    // Deliberately NOT Gmail's dot and +tag rules: applying them elsewhere
    // merges two strangers.
    expect(normaliseEmail('a.b@example.com')).toBe('a.b@example.com')
    expect(normaliseEmail('a+x@example.com')).toBe('a+x@example.com')
    expect(normaliseEmail('   ')).toBeNull()
    expect(normaliseEmail(null)).toBeNull()
  })

  it('folds an Israeli leading zero into +972', () => {
    expect(normalisePhone('052-123-4567')).toBe('+972521234567')
    expect(normalisePhone('+972 52 123 4567')).toBe('+972521234567')
    expect(normalisePhone('972521234567')).toBe('+972521234567')
  })

  it('returns null rather than guessing', () => {
    // A wrong normalisation merges threads; null merely fails to merge them.
    expect(normalisePhone('123')).toBeNull()
    expect(normalisePhone('not a phone')).toBeNull()
    expect(normalisePhone(null)).toBeNull()
  })
})
