import { describe, expect, it } from 'vitest'

import { ENTITLEMENTS } from '../plans/entitlements'

import { route, unsentCount, type NotificationCandidate } from './routing'
import {
  MIDNIGHT,
  NOW,
  PROPERTY,
  PROPERTY_B,
  PROPERTY_C,
  actor,
  event,
  propertyManager,
  settings,
} from './testing'
import {
  NullTransport,
  TransportRegistry,
  type NotificationTransport,
  type TransportResult,
} from './transport'
import type { PreferenceRecord } from './types'

const inAppOnly = () => new TransportRegistry()

/** A transport that works, so quiet hours have something to hold back. */
class WorkingTransport implements NotificationTransport {
  readonly configured = true
  constructor(readonly channel: NotificationTransport['channel']) {}
  async send(): Promise<TransportResult> {
    return { status: 'sent', provider: 'test', providerMessageId: 'm-1' }
  }
}

function candidate(
  who: NotificationCandidate['actor'],
  preferences: readonly PreferenceRecord[] = [],
): NotificationCandidate {
  return { actor: who, preferences }
}

describe('scope — a property manager is not told about a property they do not hold', () => {
  // This is the module's central claim, and it is asserted against the real
  // role catalogue and the real authorization engine rather than against a
  // rule written in this module. `property_manager` holds `task.view`; the
  // only difference between the two people below is which properties their
  // membership scope names.
  const holdsAandB = propertyManager([PROPERTY, PROPERTY_B])
  const holdsAandC = propertyManager([PROPERTY, PROPERTY_C])

  it('routes to the manager who holds the property and skips the one who does not', () => {
    const plan = route({
      event: event('task.overdue', {
        propertyId: PROPERTY_C,
        resourceType: 'task',
        resourceId: 'task-9',
      }),
      settings: settings(),
      candidates: [candidate(holdsAandB), candidate(holdsAandC)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications).toHaveLength(1)
    expect(plan.notifications[0].recipientUserId).toBe(holdsAandC.userId)

    expect(plan.skipped).toEqual([
      { userId: holdsAandB.userId, reason: 'out_of_scope', grant: 'task.view' },
    ])
  })

  it('tells both when the event is on a property they share', () => {
    const plan = route({
      event: event('task.overdue', { propertyId: PROPERTY }),
      settings: settings(),
      candidates: [candidate(holdsAandB), candidate(holdsAandC)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications.map((n) => n.recipientUserId).sort()).toEqual(
      [holdsAandB.userId, holdsAandC.userId].sort(),
    )
    expect(plan.skipped).toEqual([])
  })

  it('does not reach a property-scoped manager with an organization-wide event', () => {
    // No property on the event, so `isWithinScope` cannot place it inside a
    // properties scope — and should not: somebody who manages one villa has no
    // business being paged about the organization's payment configuration.
    const plan = route({
      event: event('security.payment_config_changed', {
        propertyId: null,
        resourceType: 'organization',
      }),
      settings: settings(),
      candidates: [candidate(holdsAandB)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications).toHaveLength(0)
    expect(plan.skipped[0].reason).not.toBe('is_actor')
  })
})

describe('permission — a person who cannot see payments is never told about one', () => {
  it('skips a cleaner and routes to the finance desk', () => {
    const cleaner = actor('cleaner')
    const finance = actor('finance_manager')

    const plan = route({
      event: event('payment.received', {
        resourceType: 'payment',
        resourceId: 'pay-1',
      }),
      settings: settings(),
      candidates: [candidate(cleaner), candidate(finance)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications.map((n) => n.recipientUserId)).toEqual([
      finance.userId,
    ])
    expect(plan.skipped).toEqual([
      {
        userId: cleaner.userId,
        reason: 'missing_permission',
        grant: 'payment.view',
      },
    ])
  })

  it('still tells a cleaner about the tasks they can see', () => {
    const cleaner = actor('cleaner')

    const plan = route({
      event: event('task.overdue', { resourceType: 'task' }),
      settings: settings(),
      candidates: [candidate(cleaner)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications).toHaveLength(1)
    expect(plan.notifications[0].requiredGrant).toBe('task.view')
  })
})

describe('capability — a module that is off produces no notifications about itself', () => {
  it('tells nobody about laundry when the plan does not include it', () => {
    const withoutLaundry = actor('operations_manager', {
      entitlements: ENTITLEMENTS.filter(
        (entitlement) => entitlement !== 'laundry',
      ),
    })

    const plan = route({
      event: event('laundry.deadline_risk', { resourceType: 'laundry_order' }),
      settings: settings(),
      candidates: [candidate(withoutLaundry)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications).toHaveLength(0)
    expect(plan.skipped[0]).toMatchObject({
      reason: 'plan_does_not_include',
      grant: 'laundry.view',
    })
  })

  it('tells the same person once the plan includes it', () => {
    const plan = route({
      event: event('laundry.deadline_risk', { resourceType: 'laundry_order' }),
      settings: settings(),
      candidates: [candidate(actor('operations_manager'))],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications).toHaveLength(1)
  })
})

describe('the actor', () => {
  it('is not told about their own doing', () => {
    const manager = actor('reservation_manager')

    const plan = route({
      event: event('booking.cancelled', { actorUserId: manager.userId }),
      settings: settings(),
      candidates: [candidate(manager)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications).toHaveLength(0)
    expect(plan.skipped).toEqual([
      { userId: manager.userId, reason: 'is_actor' },
    ])
  })

  it('is the only recipient of an event addressed to them', () => {
    // `security.new_device_login` is about the person who signed in. Routing it
    // to everybody holding an audit grant would turn a security feature into a
    // colleague's travel schedule.
    const owner = actor('organization_owner')
    const someoneElse = actor('general_manager')

    const plan = route({
      event: event('security.new_device_login', {
        propertyId: null,
        resourceType: 'session',
        actorUserId: owner.userId,
      }),
      settings: settings(),
      candidates: [candidate(owner), candidate(someoneElse)],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifications.map((n) => n.recipientUserId)).toEqual([
      owner.userId,
    ])
    expect(plan.skipped).toEqual([
      { userId: someoneElse.userId, reason: 'not_the_actor' },
    ])
  })
})

describe('channels', () => {
  const finance = actor('finance_manager')
  const paymentEvent = event('payment.failed', {
    resourceType: 'payment',
    resourceId: 'pay-2',
  })

  it('records a channel with no transport as not_configured rather than dropping it', () => {
    const plan = route({
      event: paymentEvent,
      settings: settings({ enabledChannels: ['in_app', 'email', 'sms'] }),
      candidates: [candidate(finance)],
      // In-app works; the other two are null transports.
      transports: new TransportRegistry([
        new NullTransport('email'),
        new NullTransport('sms'),
      ]),
      now: NOW,
    })

    const byChannel = Object.fromEntries(
      plan.notifications[0].deliveries.map((d) => [d.channel, d.status]),
    )

    expect(byChannel).toEqual({
      in_app: 'pending',
      email: 'not_configured',
      sms: 'not_configured',
    })
    expect(unsentCount(plan)).toBe(2)
  })

  it('counts only the unsent, never the deliberately silenced', () => {
    // The business enabled e-mail; this person switched money off there. That
    // is not an argument for buying an e-mail provider.
    const plan = route({
      event: paymentEvent,
      settings: settings({ enabledChannels: ['in_app', 'email'] }),
      candidates: [
        candidate(finance, [
          {
            id: 'p1',
            organizationId: finance.organizationId,
            userId: finance.userId,
            category: 'money',
            channel: 'email',
            enabled: false,
            minSeverity: 'info',
          },
        ]),
      ],
      transports: new TransportRegistry([new NullTransport('email')]),
      now: NOW,
    })

    const email = plan.notifications[0].deliveries.find(
      (d) => d.channel === 'email',
    )
    expect(email).toMatchObject({
      status: 'suppressed',
      suppressedReason: 'preference_off',
    })
    expect(unsentCount(plan)).toBe(0)
  })

  it('suppresses below a severity floor with the reason stated', () => {
    const plan = route({
      event: event('booking.created', { resourceType: 'booking' }),
      settings: settings({ enabledChannels: ['in_app', 'email'] }),
      candidates: [
        candidate(actor('reservation_manager'), [
          {
            id: 'p2',
            organizationId: 'org',
            userId: 'user-reservation_manager',
            category: 'booking',
            channel: 'email',
            enabled: true,
            minSeverity: 'urgent',
          },
        ]),
      ],
      transports: new TransportRegistry([new WorkingTransport('email')]),
      now: NOW,
    })

    expect(
      plan.notifications[0].deliveries.find((d) => d.channel === 'email'),
    ).toMatchObject({
      status: 'suppressed',
      suppressedReason: 'below_min_severity',
    })
  })
})

describe('quiet hours', () => {
  const finance = actor('finance_manager')

  it('defers a push channel and never the in-app record', () => {
    const plan = route({
      // `payment.proof_uploaded` is `attention`, so it does not override the
      // quiet window the way an urgent alert would.
      event: event('payment.proof_uploaded', { resourceType: 'payment' }),
      settings: settings({ enabledChannels: ['in_app', 'email'] }),
      candidates: [candidate(finance)],
      transports: new TransportRegistry([new WorkingTransport('email')]),
      now: MIDNIGHT,
    })

    const deliveries = plan.notifications[0].deliveries
    expect(deliveries.find((d) => d.channel === 'in_app')?.status).toBe(
      'pending',
    )

    const email = deliveries.find((d) => d.channel === 'email')
    expect(email?.status).toBe('deferred')
    expect(email?.suppressedReason).toBe('quiet_hours')
    // Held, never dropped: 0043 refuses a deferral with no time.
    expect(email?.scheduledFor).toBeInstanceOf(Date)
  })

  it('lets an urgent alert through the window', () => {
    const plan = route({
      event: event('payment.outcome_unknown', { resourceType: 'payment' }),
      settings: settings({ enabledChannels: ['in_app', 'email'] }),
      candidates: [candidate(finance)],
      transports: new TransportRegistry([new WorkingTransport('email')]),
      now: MIDNIGHT,
    })

    expect(
      plan.notifications[0].deliveries.find((d) => d.channel === 'email')
        ?.status,
    ).toBe('pending')
  })

  it('holds an urgent alert when the business asked for silence', () => {
    const plan = route({
      event: event('payment.outcome_unknown', { resourceType: 'payment' }),
      settings: settings({
        enabledChannels: ['in_app', 'email'],
        urgentOverridesQuietHours: false,
      }),
      candidates: [candidate(finance)],
      transports: new TransportRegistry([new WorkingTransport('email')]),
      now: MIDNIGHT,
    })

    expect(
      plan.notifications[0].deliveries.find((d) => d.channel === 'email')
        ?.status,
    ).toBe('deferred')
  })
})

describe('an event nobody asked to be told about', () => {
  it('is not an error and produces nothing', () => {
    const plan = route({
      event: event('booking.in_house', { resourceType: 'booking' }),
      settings: settings(),
      candidates: [candidate(actor('organization_owner'))],
      transports: inAppOnly(),
      now: NOW,
    })

    expect(plan.notifiable).toBe(false)
    expect(plan.notifications).toEqual([])
    expect(plan.skipped).toEqual([])
  })
})
