import { describe, expect, it } from 'vitest'

import { PreferenceSet } from './preferences'
import {
  planDeliveryRelease,
  releaseDueDeliveries,
  STALE_DEFERRAL,
  type DeliveryPatch,
  type DeliveryReleaseStore,
  type DueDelivery,
} from './release'
import { ORG, settings } from './testing'
import {
  NullTransport,
  TransportRegistry,
  type NotificationTransport,
  type TransportResult,
} from './transport'
import type { NotificationDeliveryStatus, NotificationSettings } from './types'

/** 07:00 in Asia/Jerusalem — when the default quiet window opens. */
const DUE = new Date('2026-03-11T05:00:00.000Z')
/** 10:00 there. Three hours after the row became sendable. */
const NOW = new Date('2026-03-11T08:00:00.000Z')

/** Twelve hours. Every test states its own bound; none of them inherits one. */
const TWELVE_HOURS = 720

/**
 * The organization must have the channel on, or `channel_disabled` fires
 * before anything this file is about — see `DEFAULT_SETTINGS`, which is
 * `in_app` alone on the day a business signs up.
 */
function orgSettings(
  overrides: Partial<NotificationSettings> = {},
): NotificationSettings {
  return settings({ enabledChannels: ['in_app', 'email'], ...overrides })
}

function due(overrides: Partial<DueDelivery> = {}): DueDelivery {
  return {
    id: 'delivery-1',
    organizationId: ORG,
    notificationId: 'notification-1',
    channel: 'email',
    scheduledFor: DUE,
    recipientUserId: 'user-1',
    // `attention` and not `urgent`: the urgent override would walk straight
    // through quiet hours and every gate test below would prove nothing.
    category: 'money',
    severity: 'attention',
    title: 'תשלום נכשל',
    body: 'הכרטיס נדחה.',
    actionHref: '/payments',
    correlationId: 'corr-1',
    ...overrides,
  }
}

function noPreferences(organization: NotificationSettings): PreferenceSet {
  return new PreferenceSet([], organization)
}

/* ------------------------------------------------------------- transports -- */

/** Counts what it was asked, so "never sent" is an assertion and not a hope. */
class CountingTransport implements NotificationTransport {
  readonly channel = 'email' as const
  readonly configured = true
  sends = 0

  constructor(private readonly answer: TransportResult) {}

  async send(): Promise<TransportResult> {
    this.sends += 1
    // A real transport is a network call. Yielding here is what lets a second
    // concurrent sweep interleave, which is the only way the race test can
    // fail if the claim is wrong.
    await Promise.resolve()
    return this.answer
  }
}

function working(): CountingTransport {
  return new CountingTransport({
    status: 'sent',
    provider: 'fake_mail',
    providerMessageId: 'p-1',
  })
}

/* ------------------------------------------------------------------ store -- */

interface Held {
  row: DueDelivery
  status: NotificationDeliveryStatus
  patch: DeliveryPatch | null
}

/**
 * The double every runner test drives.
 *
 * It enforces the conditional predicate faithfully — a transition whose `from`
 * does not match the row's current status changes nothing and reports `false`.
 * A double that updated unconditionally would let the race test pass while the
 * real `update … where status = 'deferred'` was missing, and passing for the
 * wrong reason is the same as not testing it.
 */
class FakeStore implements DeliveryReleaseStore {
  readonly held = new Map<string, Held>()

  constructor(rows: readonly DueDelivery[]) {
    for (const row of rows) {
      this.held.set(row.id, { row, status: 'deferred', patch: null })
    }
  }

  async listDueDeliveries(args: {
    organizationId: string
    dueBefore: Date
    limit: number
  }): Promise<readonly DueDelivery[]> {
    return [...this.held.values()]
      .filter(
        (entry) =>
          entry.status === 'deferred' &&
          entry.row.organizationId === args.organizationId &&
          entry.row.scheduledFor.getTime() <= args.dueBefore.getTime(),
      )
      .sort(
        (a, b) => a.row.scheduledFor.getTime() - b.row.scheduledFor.getTime(),
      )
      .slice(0, args.limit)
      .map((entry) => entry.row)
  }

  async transitionDelivery(args: {
    organizationId: string
    deliveryId: string
    from: NotificationDeliveryStatus
    patch: DeliveryPatch
  }): Promise<boolean> {
    const entry = this.held.get(args.deliveryId)
    if (!entry) return false
    if (entry.row.organizationId !== args.organizationId) return false
    if (entry.status !== args.from) return false

    entry.status = args.patch.status
    entry.patch = args.patch
    return true
  }

  statusOf(id: string): NotificationDeliveryStatus | undefined {
    return this.held.get(id)?.status
  }

  patchOf(id: string): DeliveryPatch | null {
    return this.held.get(id)?.patch ?? null
  }
}

function run(args: {
  store: FakeStore
  transports: TransportRegistry
  organization?: NotificationSettings
  now?: Date
  limit?: number
  staleAfterMinutes?: number
}) {
  const organization = args.organization ?? orgSettings()
  return releaseDueDeliveries({
    organizationId: ORG,
    store: args.store,
    transports: args.transports,
    settings: organization,
    async loadPreferences() {
      return noPreferences(organization)
    },
    now: args.now ?? NOW,
    limit: args.limit ?? 100,
    staleAfterMinutes: args.staleAfterMinutes ?? TWELVE_HOURS,
  })
}

/* ─────────────────────────────────────────────────────────── the gate again */

describe('the gate is re-checked, never assumed', () => {
  it('does not send a row whose quiet window has re-closed', async () => {
    // The business widened its quiet hours to 09:00–12:00 while this row
    // waited. Releasing on the strength of a timestamp written at 22:10 is how
    // a business that turned messaging off gets a batch at dawn.
    const transport = working()
    const store = new FakeStore([due()])

    const summary = await run({
      store,
      transports: new TransportRegistry([transport]),
      organization: orgSettings({
        quietHoursStart: '09:00',
        quietHoursEnd: '12:00',
      }),
    })

    expect(transport.sends).toBe(0)
    expect(store.statusOf('delivery-1')).toBe('suppressed')
    expect(store.patchOf('delivery-1')?.suppressedReason).toBe('quiet_hours')
    expect(summary.released).toBe(1)
  })

  it('does not send a row on a channel switched off since it was deferred', async () => {
    const transport = working()
    const store = new FakeStore([due()])

    await run({
      store,
      transports: new TransportRegistry([transport]),
      // `email` gone from the organization's channels.
      organization: orgSettings({ enabledChannels: ['in_app'] }),
    })

    expect(transport.sends).toBe(0)
    expect(store.patchOf('delivery-1')?.suppressedReason).toBe(
      'channel_disabled',
    )
  })

  it('sends when every gate is genuinely open', async () => {
    const transport = working()
    const store = new FakeStore([due()])

    await run({ store, transports: new TransportRegistry([transport]) })

    expect(transport.sends).toBe(1)
    expect(store.statusOf('delivery-1')).toBe('sent')
    expect(store.patchOf('delivery-1')?.provider).toBe('fake_mail')
    // Left open: a provider that accepted a message may still report a bounce.
    expect(store.patchOf('delivery-1')?.settledAt).toBeNull()
  })

  it('leaves a row whose time has not come', () => {
    const organization = orgSettings()
    const plans = planDeliveryRelease({
      rows: [due({ scheduledFor: new Date(NOW.getTime() + 60_000) })],
      settings: organization,
      preferenceFor: () => noPreferences(organization),
      transports: new TransportRegistry([working()]),
      now: NOW,
      staleAfterMinutes: TWELVE_HOURS,
    })

    expect(plans[0]?.decision.action).toBe('leave')
  })
})

/* ───────────────────────────────────────────────────────────────── staleness */

describe('a stale deferral is abandoned, not sent', () => {
  it('records it suppressed with a stated reason and asks nobody', async () => {
    const transport = working()
    // Four days past its window. The stay it was about has ended.
    const store = new FakeStore([
      due({ scheduledFor: new Date(NOW.getTime() - 4 * 86_400_000) }),
    ])

    const summary = await run({
      store,
      transports: new TransportRegistry([transport]),
      staleAfterMinutes: TWELVE_HOURS,
    })

    expect(transport.sends).toBe(0)
    expect(store.statusOf('delivery-1')).toBe('suppressed')

    const patch = store.patchOf('delivery-1')
    expect(patch?.suppressedReason).toBe(STALE_DEFERRAL)
    // A suppression with no stated reason is a silence nobody can explain, and
    // 0043 has a check constraint refusing exactly that.
    expect(patch?.errorDetail).toContain('past the 720-minute bound')
    expect(patch?.attemptedAt).toBeNull()
    expect(summary.tally.suppressed).toBe(1)
  })

  it('asks staleness before every other gate', () => {
    // A four-day-old alert is not made appropriate by the channel being off,
    // and reporting `channel_disabled` for it would send somebody to fix a
    // setting that was never the reason.
    const organization = orgSettings({ enabledChannels: ['in_app'] })
    const plans = planDeliveryRelease({
      rows: [due({ scheduledFor: new Date(NOW.getTime() - 4 * 86_400_000) })],
      settings: organization,
      preferenceFor: () => noPreferences(organization),
      transports: new TransportRegistry([working()]),
      now: NOW,
      staleAfterMinutes: TWELVE_HOURS,
    })

    const decision = plans[0]?.decision
    expect(decision?.action).toBe('settle')
    if (decision?.action !== 'settle') throw new Error('expected a settle')
    expect(decision.patch.suppressedReason).toBe(STALE_DEFERRAL)
  })
})

/* ──────────────────────────────────────────────────────────────────── races */

describe('two sweeps running at once', () => {
  it('sends exactly once, and the loser writes nothing', async () => {
    const transport = working()
    const store = new FakeStore([due()])
    const transports = new TransportRegistry([transport])

    const [first, second] = await Promise.all([
      run({ store, transports }),
      run({ store, transports }),
    ])

    // The claim is the row's own status, decided by one conditional update.
    // The loser matches zero rows and moves on having sent nothing.
    expect(transport.sends).toBe(1)
    expect(first.released + second.released).toBe(1)
    expect(first.lost + second.lost).toBe(1)
    expect(store.statusOf('delivery-1')).toBe('sent')
  })

  it('does not re-release a row a previous sweep already settled', async () => {
    const transport = working()
    const store = new FakeStore([due()])
    const transports = new TransportRegistry([transport])

    await run({ store, transports })
    const second = await run({ store, transports })

    // The query itself no longer returns it — it is not `deferred` any more.
    expect(transport.sends).toBe(1)
    expect(second.scanned).toBe(0)
  })
})

/* ─────────────────────────────────────────────────────────── no transport */

describe('with nothing behind the channel', () => {
  it('records not_configured and claims no delivery', async () => {
    const store = new FakeStore([due()])

    // The registry this product actually ships: `in_app` and nothing else.
    const summary = await run({
      store,
      transports: new TransportRegistry([new NullTransport('email')]),
    })

    expect(store.statusOf('delivery-1')).toBe('not_configured')

    const patch = store.patchOf('delivery-1')
    expect(patch?.provider).toBeNull()
    expect(patch?.providerMessageId).toBeNull()
    // Nothing was attempted, so no timestamp says one was.
    expect(patch?.attemptedAt).toBeNull()
    expect(summary.tally.not_configured).toBe(1)
    expect(summary.tally.sent).toBeUndefined()
  })

  it('never deferred it a second time onto a channel that does not exist', async () => {
    const store = new FakeStore([due()])

    await run({
      store,
      transports: new TransportRegistry([new NullTransport('email')]),
    })

    expect(store.statusOf('delivery-1')).not.toBe('deferred')
  })
})

/* ────────────────────────────────────────────────────────────────── bounds */

describe('the sweep is bounded and resumable', () => {
  it('honours the limit', async () => {
    const transport = working()
    const rows = [1, 2, 3, 4, 5].map((n) =>
      due({
        id: `delivery-${n}`,
        scheduledFor: new Date(DUE.getTime() + n * 1000),
      }),
    )
    const store = new FakeStore(rows)

    const first = await run({
      store,
      transports: new TransportRegistry([transport]),
      limit: 2,
    })

    expect(first.scanned).toBe(2)
    expect(first.released).toBe(2)
    expect(transport.sends).toBe(2)
    expect(store.statusOf('delivery-3')).toBe('deferred')
  })

  it('drains the rest on the next pass', async () => {
    const transport = working()
    const rows = [1, 2, 3].map((n) =>
      due({
        id: `delivery-${n}`,
        scheduledFor: new Date(DUE.getTime() + n * 1000),
      }),
    )
    const store = new FakeStore(rows)
    const transports = new TransportRegistry([transport])

    await run({ store, transports, limit: 2 })
    const second = await run({ store, transports, limit: 2 })

    expect(second.scanned).toBe(1)
    expect(transport.sends).toBe(3)
  })
})

/* ─────────────────────────────────────────────────────── every outcome kept */

describe('nothing is dropped silently', () => {
  it('records a transport that threw as failed rather than losing the pass', async () => {
    const rows = [
      due({ id: 'delivery-1' }),
      due({ id: 'delivery-2', scheduledFor: new Date(DUE.getTime() + 1000) }),
    ]
    const store = new FakeStore(rows)

    let asked = 0
    const throwing: NotificationTransport = {
      channel: 'email',
      configured: true,
      async send() {
        asked += 1
        if (asked === 1) throw new Error('socket closed')
        return {
          status: 'sent',
          provider: 'fake_mail',
          providerMessageId: null,
        }
      },
    }

    const summary = await run({
      store,
      transports: new TransportRegistry([throwing]),
    })

    // The first row failed; the second still went. One broken transport must
    // not stop the queue draining — that is this file's own defect returning.
    expect(store.statusOf('delivery-1')).toBe('failed')
    expect(store.patchOf('delivery-1')?.errorCode).toBe('transport_threw')
    expect(store.statusOf('delivery-2')).toBe('sent')
    expect(summary.released).toBe(2)
    expect(summary.unsettled).toBe(0)
  })
})
