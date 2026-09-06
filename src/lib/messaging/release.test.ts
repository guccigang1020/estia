import { describe, expect, it } from 'vitest'

import { ORG, settings } from '../notifications/testing'
import type { NotificationSettings } from '../notifications/types'

import { defaultMessageProviderRegistry } from './null-provider'
import type { GuestMessageSource } from './operations'
import {
  MessageProviderRegistry,
  type MessageProvider,
  type ProviderResult,
} from './provider'
import {
  planMessageRelease,
  releaseDueMessages,
  type DueGuestMessage,
  type GuestMessagePatch,
  type GuestMessageReleaseStore,
} from './release'
import type {
  GuestChannel,
  GuestMessageSubject,
  GuestRecipient,
  MessageOutcome,
} from './types'

/** 07:00 in Asia/Jerusalem — when the default quiet window opens. */
const DUE = new Date('2026-03-11T05:00:00.000Z')
/** 10:00 there. Three hours after the row became sendable. */
const NOW = new Date('2026-03-11T08:00:00.000Z')

/** Twelve hours. Every test states its own bound; none of them inherits one. */
const TWELVE_HOURS = 720

function message(overrides: Partial<DueGuestMessage> = {}): DueGuestMessage {
  return {
    id: 'msg-1',
    organizationId: ORG,
    propertyId: null,
    bookingId: 'booking-1',
    guestId: 'guest-1',
    // `payment_reminder` is `attention`, so it is held by quiet hours rather
    // than walking through on the urgent override — which is what makes every
    // gate test below prove something.
    kind: 'payment_reminder',
    channel: 'whatsapp',
    subject: null,
    body: 'שלום דנה, נותרו 400 ₪ לתשלום עבור השהות ב־B-2026-0141.',
    recipientMasked: '***456',
    outcome: 'deferred',
    outcomeDetail: 'held by quiet hours',
    provider: null,
    providerMessageId: null,
    scheduledFor: DUE,
    correlationId: 'corr-1',
    dedupeKey: 'booking-1:payment_reminder:whatsapp:key-1',
    createdBy: null,
    createdAt: new Date('2026-03-10T20:10:00.000Z'),
    settledAt: null,
    ...overrides,
  }
}

function recipient(overrides: Partial<GuestRecipient> = {}): GuestRecipient {
  return {
    guestId: 'guest-1',
    firstName: 'דנה',
    phone: '+972501234456',
    email: 'dana@example.com',
    marketingConsent: true,
    language: 'he',
    ...overrides,
  }
}

const SUBJECT: GuestMessageSubject = {
  bookingId: 'booking-1',
  propertyId: null,
  reference: 'B-2026-0141',
  organizationName: 'אכסניית הגליל',
  propertyName: null,
  checkIn: '11.03.2026',
  checkOut: '13.03.2026',
  portalUrl: null,
  outstandingAgorot: 40000,
}

/** Reads the guest as they are NOW. `null` when the booking is unreadable. */
function guestSource(value: GuestRecipient | null): GuestMessageSource {
  return {
    async load() {
      // A real source is a database read. Yielding here is what lets a second
      // concurrent sweep interleave, which is the only way the race test can
      // fail if the claim is wrong.
      await Promise.resolve()
      return value === null ? null : { recipient: value, subject: SUBJECT }
    },
  }
}

/* -------------------------------------------------------------- providers -- */

/** Counts what it was asked, so "never sent" is an assertion and not a hope. */
class CountingProvider implements MessageProvider {
  readonly name = 'fake_whatsapp'
  readonly configured = true
  sends = 0

  constructor(
    readonly channel: GuestChannel,
    private readonly answer: ProviderResult,
  ) {}

  async send(): Promise<ProviderResult> {
    this.sends += 1
    await Promise.resolve()
    return this.answer
  }
}

function working(): CountingProvider {
  return new CountingProvider('whatsapp', {
    status: 'sent',
    provider: 'fake_whatsapp',
    providerMessageId: 'p-1',
  })
}

function registryFor(provider: MessageProvider): MessageProviderRegistry {
  return new MessageProviderRegistry([provider], () => provider)
}

/* ------------------------------------------------------------------ store -- */

interface Held {
  row: DueGuestMessage
  outcome: MessageOutcome
  patch: GuestMessagePatch | null
}

/**
 * The double every runner test drives.
 *
 * It enforces the conditional predicate faithfully — a transition whose `from`
 * does not match the row's current outcome changes nothing and reports
 * `false`. A double that updated unconditionally would let the race test pass
 * while the real `update … where outcome = 'deferred'` was missing, and
 * passing for the wrong reason is the same as not testing it.
 */
class FakeStore implements GuestMessageReleaseStore {
  readonly held = new Map<string, Held>()

  constructor(rows: readonly DueGuestMessage[]) {
    for (const row of rows) {
      this.held.set(row.id, { row, outcome: 'deferred', patch: null })
    }
  }

  async listDueMessages(args: {
    organizationId: string
    dueBefore: Date
    limit: number
  }): Promise<readonly DueGuestMessage[]> {
    return [...this.held.values()]
      .filter(
        (entry) =>
          entry.outcome === 'deferred' &&
          entry.row.organizationId === args.organizationId &&
          entry.row.scheduledFor.getTime() <= args.dueBefore.getTime(),
      )
      .sort(
        (a, b) => a.row.scheduledFor.getTime() - b.row.scheduledFor.getTime(),
      )
      .slice(0, args.limit)
      .map((entry) => entry.row)
  }

  async transitionGuestMessage(args: {
    organizationId: string
    messageId: string
    from: MessageOutcome
    patch: GuestMessagePatch
  }): Promise<boolean> {
    const entry = this.held.get(args.messageId)
    if (!entry) return false
    if (entry.row.organizationId !== args.organizationId) return false
    if (entry.outcome !== args.from) return false

    entry.outcome = args.patch.outcome
    entry.patch = args.patch
    return true
  }

  outcomeOf(id: string): MessageOutcome | undefined {
    return this.held.get(id)?.outcome
  }

  patchOf(id: string): GuestMessagePatch | null {
    return this.held.get(id)?.patch ?? null
  }
}

function run(args: {
  store: FakeStore
  providers: MessageProviderRegistry
  guests?: GuestMessageSource
  organization?: NotificationSettings
  now?: Date
  limit?: number
  staleAfterMinutes?: number
}) {
  return releaseDueMessages({
    organizationId: ORG,
    store: args.store,
    providers: args.providers,
    guests: args.guests ?? guestSource(recipient()),
    settings: args.organization ?? settings(),
    now: args.now ?? NOW,
    limit: args.limit ?? 100,
    staleAfterMinutes: args.staleAfterMinutes ?? TWELVE_HOURS,
  })
}

/* ─────────────────────────────────────────────────────────── the gate again */

describe('the gate is re-checked, never assumed', () => {
  it('does not send a message whose quiet window has re-closed', async () => {
    // The guesthouse widened its quiet hours to 09:00–12:00 while this row
    // waited. Releasing on the strength of a timestamp written at 22:10 is how
    // a business that turned messaging off gets a batch at dawn.
    const provider = working()
    const store = new FakeStore([message()])

    const summary = await run({
      store,
      providers: registryFor(provider),
      organization: settings({
        quietHoursStart: '09:00',
        quietHoursEnd: '12:00',
      }),
    })

    expect(provider.sends).toBe(0)
    expect(store.outcomeOf('msg-1')).toBe('suppressed')
    expect(store.patchOf('msg-1')?.outcomeDetail).toContain(
      'the quiet window had closed again',
    )
    expect(summary.released).toBe(1)
  })

  it('does not send to a guest who has withdrawn marketing consent', async () => {
    // The one gate whose answer belongs to the guest rather than the business,
    // and it is read as it is NOW rather than as it was at 22:10.
    const provider = working()
    const store = new FakeStore([message({ kind: 'review_request' })])

    await run({
      store,
      providers: registryFor(provider),
      guests: guestSource(recipient({ marketingConsent: false })),
    })

    expect(provider.sends).toBe(0)
    expect(store.outcomeOf('msg-1')).toBe('suppressed')
    expect(store.patchOf('msg-1')?.outcomeDetail).toContain('consented')
  })

  it('still sends an arrival instruction to a guest who refused marketing', async () => {
    // The pair. A guest who switched off marketing has not asked to stop being
    // told the door code of the room they arrive at tonight.
    const provider = working()
    const store = new FakeStore([message({ kind: 'arrival_info' })])

    await run({
      store,
      providers: registryFor(provider),
      guests: guestSource(recipient({ marketingConsent: false })),
    })

    expect(provider.sends).toBe(1)
    expect(store.outcomeOf('msg-1')).toBe('sent')
  })

  it('does not send when the booking or guest is no longer readable', async () => {
    const provider = working()
    const store = new FakeStore([message()])

    await run({
      store,
      providers: registryFor(provider),
      guests: guestSource(null),
    })

    expect(provider.sends).toBe(0)
    expect(store.patchOf('msg-1')?.outcomeDetail).toContain(
      'no longer readable',
    )
  })

  it('does not send when the address has since gone from the card', async () => {
    const provider = working()
    const store = new FakeStore([message()])

    await run({
      store,
      providers: registryFor(provider),
      guests: guestSource(recipient({ phone: null })),
    })

    expect(provider.sends).toBe(0)
    expect(store.patchOf('msg-1')?.outcomeDetail).toContain('no usable')
  })

  it('sends when every gate is genuinely open', async () => {
    const provider = working()
    const store = new FakeStore([message()])

    await run({ store, providers: registryFor(provider) })

    expect(provider.sends).toBe(1)
    expect(store.outcomeOf('msg-1')).toBe('sent')

    const patch = store.patchOf('msg-1')
    expect(patch?.provider).toBe('fake_whatsapp')
    expect(patch?.providerMessageId).toBe('p-1')
    // The table refuses a non-deferred row that still carries a time.
    expect(patch?.scheduledFor).toBeNull()
    // Left open: a provider that accepted a message may still report a bounce.
    expect(patch?.settledAt).toBeNull()
    // The instant the row carried is not lost when the column is cleared.
    expect(patch?.outcomeDetail).toContain(DUE.toISOString())
  })

  it('leaves a message whose time has not come', () => {
    const plans = planMessageRelease({
      rows: [
        {
          message: message({
            scheduledFor: new Date(NOW.getTime() + 60_000),
          }),
          recipient: recipient(),
        },
      ],
      providers: registryFor(working()),
      settings: settings(),
      now: NOW,
      staleAfterMinutes: TWELVE_HOURS,
    })

    expect(plans[0]?.decision.action).toBe('leave')
  })
})

/* ───────────────────────────────────────────────────────────────── staleness */

describe('a stale deferral is abandoned, not sent', () => {
  it('records it suppressed with a stated reason and asks nobody', async () => {
    // A payment reminder arriving after checkout reads as a bill for a stay
    // that is over, which is worse than never sending it.
    const provider = working()
    const store = new FakeStore([
      message({ scheduledFor: new Date(NOW.getTime() - 4 * 86_400_000) }),
    ])

    const summary = await run({
      store,
      providers: registryFor(provider),
      staleAfterMinutes: TWELVE_HOURS,
    })

    expect(provider.sends).toBe(0)
    expect(store.outcomeOf('msg-1')).toBe('suppressed')

    const patch = store.patchOf('msg-1')
    expect(patch?.outcomeDetail).toContain('past the 720-minute bound')
    expect(patch?.provider).toBeNull()
    expect(patch?.scheduledFor).toBeNull()
    expect(summary.tally.suppressed).toBe(1)
  })

  it('asks staleness before the provider question', () => {
    // A four-day-old reminder is not made appropriate by a channel being
    // missing, and recording `not_configured` for it would tell a guesthouse
    // to buy an SMS gateway to fix a message it should not send.
    const plans = planMessageRelease({
      rows: [
        {
          message: message({
            scheduledFor: new Date(NOW.getTime() - 4 * 86_400_000),
          }),
          recipient: recipient(),
        },
      ],
      providers: defaultMessageProviderRegistry(),
      settings: settings(),
      now: NOW,
      staleAfterMinutes: TWELVE_HOURS,
    })

    const decision = plans[0]?.decision
    if (decision?.action !== 'settle') throw new Error('expected a settle')
    expect(decision.patch.outcome).toBe('suppressed')
  })
})

/* ──────────────────────────────────────────────────────────────────── races */

describe('two sweeps running at once', () => {
  it('sends exactly once, and the loser writes nothing', async () => {
    const provider = working()
    const store = new FakeStore([message()])
    const providers = registryFor(provider)

    const [first, second] = await Promise.all([
      run({ store, providers }),
      run({ store, providers }),
    ])

    // The claim is the row's own outcome, decided by one conditional update.
    // The loser matches zero rows and moves on having sent nothing.
    expect(provider.sends).toBe(1)
    expect(first.released + second.released).toBe(1)
    expect(first.lost + second.lost).toBe(1)
    expect(store.outcomeOf('msg-1')).toBe('sent')
  })

  it('does not re-release a message a previous sweep already settled', async () => {
    const provider = working()
    const store = new FakeStore([message()])
    const providers = registryFor(provider)

    await run({ store, providers })
    const second = await run({ store, providers })

    expect(provider.sends).toBe(1)
    expect(second.scanned).toBe(0)
  })
})

/* ─────────────────────────────────────────────────────────── no transport */

describe('with nothing behind the channel', () => {
  it('records not_configured and claims no delivery', async () => {
    const store = new FakeStore([message()])

    // The registry this product actually ships: empty, so every channel falls
    // through to the null provider.
    const summary = await run({
      store,
      providers: defaultMessageProviderRegistry(),
    })

    expect(store.outcomeOf('msg-1')).toBe('not_configured')

    const patch = store.patchOf('msg-1')
    expect(patch?.provider).toBeNull()
    // `guest_messages_not_configured_has_no_id` refuses an id here, and there
    // is nothing that could honestly have produced one.
    expect(patch?.providerMessageId).toBeNull()
    // `planOutward`'s own gate-1 sentence, so a released row and a row that
    // was never deferred say the same thing about the same missing channel.
    expect(patch?.outcomeDetail).toContain(
      'no provider is configured for whatsapp',
    )
    expect(summary.tally.not_configured).toBe(1)
    expect(summary.tally.sent).toBeUndefined()
  })

  it('never defers it a second time onto a channel that does not exist', async () => {
    const store = new FakeStore([message()])

    await run({ store, providers: defaultMessageProviderRegistry() })

    expect(store.outcomeOf('msg-1')).not.toBe('deferred')
  })
})

/* ────────────────────────────────────────────────────────────────── bounds */

describe('the sweep is bounded and resumable', () => {
  it('honours the limit', async () => {
    const provider = working()
    const rows = [1, 2, 3, 4, 5].map((n) =>
      message({
        id: `msg-${n}`,
        scheduledFor: new Date(DUE.getTime() + n * 1000),
      }),
    )
    const store = new FakeStore(rows)

    const first = await run({
      store,
      providers: registryFor(provider),
      limit: 2,
    })

    expect(first.scanned).toBe(2)
    expect(first.released).toBe(2)
    expect(provider.sends).toBe(2)
    expect(store.outcomeOf('msg-3')).toBe('deferred')
  })

  it('drains the rest on the next pass', async () => {
    const provider = working()
    const rows = [1, 2, 3].map((n) =>
      message({
        id: `msg-${n}`,
        scheduledFor: new Date(DUE.getTime() + n * 1000),
      }),
    )
    const store = new FakeStore(rows)
    const providers = registryFor(provider)

    await run({ store, providers, limit: 2 })
    const second = await run({ store, providers, limit: 2 })

    expect(second.scanned).toBe(1)
    expect(provider.sends).toBe(3)
  })
})

/* ─────────────────────────────────────────────────────── every outcome kept */

describe('nothing is dropped silently', () => {
  it('records a provider that threw as failed rather than losing the pass', async () => {
    const rows = [
      message({ id: 'msg-1' }),
      message({
        id: 'msg-2',
        bookingId: 'booking-2',
        scheduledFor: new Date(DUE.getTime() + 1000),
      }),
    ]
    const store = new FakeStore(rows)

    let asked = 0
    const throwing: MessageProvider = {
      name: 'flaky',
      channel: 'whatsapp',
      configured: true,
      async send() {
        asked += 1
        if (asked === 1) throw new Error('socket closed')
        return { status: 'sent', provider: 'flaky', providerMessageId: null }
      },
    }

    const summary = await run({ store, providers: registryFor(throwing) })

    // The first row failed; the second still went. One broken provider must
    // not stop the queue draining — that is this file's own defect returning.
    expect(store.outcomeOf('msg-1')).toBe('failed')
    expect(store.patchOf('msg-1')?.outcomeDetail).toContain('provider_threw')
    expect(store.outcomeOf('msg-2')).toBe('sent')
    expect(summary.released).toBe(2)
    expect(summary.unsettled).toBe(0)
  })
})
