import { beforeEach, describe, expect, it } from 'vitest'

import {
  emptyTally,
  InMemoryMessagingRepository,
  isMissingSchema,
  MessagingNotProvisionedError,
} from './repository'
import type { GuestMessageDraft } from './types'

const NOW = new Date('2026-03-11T10:00:00.000Z')
const ORG = 'org-1'

let repository: InMemoryMessagingRepository

beforeEach(() => {
  repository = new InMemoryMessagingRepository(NOW)
})

function draft(overrides: Partial<GuestMessageDraft> = {}): GuestMessageDraft {
  return {
    organizationId: ORG,
    propertyId: 'property-1',
    bookingId: 'booking-1',
    guestId: 'guest-1',
    kind: 'arrival_info',
    channel: 'whatsapp',
    subject: null,
    body: 'שלום דנה,',
    recipientMasked: '***567',
    outcome: 'not_configured',
    outcomeDetail: 'no provider is configured for whatsapp',
    provider: 'none',
    providerMessageId: null,
    scheduledFor: null,
    correlationId: 'corr-1',
    dedupeKey: 'booking-1:arrival_info:whatsapp:key-1',
    createdBy: 'user-1',
    settledAt: NOW,
    ...overrides,
  }
}

// ── The two codes that mean "never installed" ─────────────────────────────

describe('isMissingSchema', () => {
  it('recognises both layers reporting the same fact', () => {
    // Postgres raises 42P01 for an unknown relation; PostgREST answers
    // PGRST205 when the table is not in its schema cache at all.
    expect(isMissingSchema({ code: '42P01' })).toBe(true)
    expect(isMissingSchema({ code: 'PGRST205' })).toBe(true)
  })

  it('does not swallow anything else', () => {
    // A broken policy reported as "not installed" is the most misleading
    // sentence this module could produce.
    expect(isMissingSchema({ code: '42501' })).toBe(false)
    expect(isMissingSchema({ code: '23505' })).toBe(false)
    expect(isMissingSchema(new Error('boom'))).toBe(false)
    expect(isMissingSchema(null)).toBe(false)
  })
})

// ── A missing table fails a write and softens a read ──────────────────────

describe('a deployment where the migration has not run', () => {
  beforeEach(() => {
    repository.provisioned = false
  })

  it('refuses a write rather than losing it quietly', async () => {
    // The message was NOT recorded. Returning quietly would leave the
    // operation free to report a guest as written to when no trace of it
    // exists anywhere.
    await expect(repository.recordGuestMessage(draft())).rejects.toBeInstanceOf(
      MessagingNotProvisionedError,
    )
  })

  it('says nothing was saved, so every surface above reports the same thing', async () => {
    const error = await repository
      .recordGuestMessage(draft())
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MessagingNotProvisionedError)
    expect((error as MessagingNotProvisionedError).dataOutcome).toBe(
      'not_saved',
    )
    expect((error as MessagingNotProvisionedError).retryable).toBe(false)
  })

  it('answers a read with a state a screen can print', async () => {
    await expect(repository.listGuestMessages(ORG)).resolves.toEqual({
      kind: 'not_provisioned',
    })
    await expect(repository.tallyOutcomes(ORG, 30)).resolves.toEqual({
      kind: 'not_provisioned',
    })
  })
})

// ── One intent, one row ───────────────────────────────────────────────────

describe('the dedupe key', () => {
  it('turns a retried send into the row that was already there', async () => {
    const first = await repository.recordGuestMessage(draft())
    const second = await repository.recordGuestMessage(draft())

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(repository.messages).toHaveLength(1)
  })

  it('does not collide across organizations', async () => {
    await repository.recordGuestMessage(draft())
    const other = await repository.recordGuestMessage(
      draft({ organizationId: 'org-2' }),
    )

    expect(other.created).toBe(true)
  })

  it('treats a different channel as a different intent', async () => {
    await repository.recordGuestMessage(draft())
    const bySms = await repository.recordGuestMessage(
      draft({
        channel: 'sms',
        dedupeKey: 'booking-1:arrival_info:sms:key-1',
      }),
    )

    expect(bySms.created).toBe(true)
    expect(repository.messages).toHaveLength(2)
  })
})

// ── Reading it back ───────────────────────────────────────────────────────

describe('listGuestMessages', () => {
  beforeEach(async () => {
    await repository.recordGuestMessage(draft())
    await repository.recordGuestMessage(
      draft({
        bookingId: 'booking-2',
        guestId: 'guest-2',
        dedupeKey: 'booking-2:arrival_info:whatsapp:key-1',
      }),
    )
  })

  it('narrows by booking and by guest', async () => {
    const byBooking = await repository.listGuestMessages(ORG, {
      bookingId: 'booking-2',
    })
    if (byBooking.kind !== 'ready') throw new Error('unreachable')
    expect(byBooking.value).toHaveLength(1)

    const byGuest = await repository.listGuestMessages(ORG, {
      guestId: 'guest-1',
    })
    if (byGuest.kind !== 'ready') throw new Error('unreachable')
    expect(byGuest.value[0].bookingId).toBe('booking-1')
  })

  it('never crosses an organization', async () => {
    const other = await repository.listGuestMessages('org-2')
    if (other.kind !== 'ready') throw new Error('unreachable')
    expect(other.value).toEqual([])
  })
})

describe('tallyOutcomes', () => {
  it('counts what never left the building, which is the whole point', async () => {
    // A tally that recorded successes only would show an empty screen to the
    // business with the biggest problem.
    await repository.recordGuestMessage(draft())
    await repository.recordGuestMessage(
      draft({ dedupeKey: 'b:arrival_info:sms:k', channel: 'sms' }),
    )
    await repository.recordGuestMessage(
      draft({ dedupeKey: 'b:arrival_info:email:k', outcome: 'sent' }),
    )

    const tally = await repository.tallyOutcomes(ORG, 30)
    if (tally.kind !== 'ready') throw new Error('unreachable')

    expect(tally.value.not_configured).toBe(2)
    expect(tally.value.sent).toBe(1)
    expect(tally.value.suppressed).toBe(0)
  })

  it('starts from a complete grid, so no status is missing from a screen', () => {
    const tally = emptyTally()
    expect(tally.not_configured).toBe(0)
    // The two that must always be countable separately.
    expect(tally.suppressed).toBe(0)
    expect(Object.keys(tally)).toHaveLength(7)
  })
})
