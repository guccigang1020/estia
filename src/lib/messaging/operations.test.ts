import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError } from '../authz/can'
import { BusinessRuleError } from '../errors'
import { InMemoryNotificationRepository } from '../notifications/repository'
import type { NotificationCandidate } from '../notifications/routing'
import { actor, settings } from '../notifications/testing'
import { TransportRegistry } from '../notifications/transport'
import type { NotificationChannel } from '../notifications/types'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'

import { defaultMessageProviderRegistry } from './null-provider'
import {
  defineMessagingOperations,
  type GuestMessageSource,
  type StaffRecipientSource,
} from './operations'
import {
  MessageProviderRegistry,
  type MessageProvider,
  type ProviderResult,
} from './provider'
import { InMemoryMessagingRepository } from './repository'
import type { GuestChannel, GuestMessageSubject, GuestRecipient } from './types'

/* -------------------------------------------------------------- fixtures -- */

const ORG = '11111111-1111-4111-8111-111111111111'
const PROPERTY = '33333333-3333-4333-8333-333333333333'
const BOOKING = '55555555-5555-4555-8555-555555555555'
const TASK = '66666666-6666-4666-8666-666666666666'
const CLEANER_ID = '77777777-7777-4777-8777-777777777777'

/** Ten in the morning in Asia/Jerusalem. Outside the default quiet window. */
const DAY = new Date('2026-03-11T08:00:00.000Z')
/** Half past midnight there. Inside it. */
const NIGHT = new Date('2026-03-10T22:40:00.000Z')

const RECIPIENT: GuestRecipient = {
  guestId: 'guest-1',
  firstName: 'דנה',
  phone: '050-123-4567',
  email: 'dana@example.com',
  marketingConsent: true,
  language: 'he',
}

const SUBJECT: GuestMessageSubject = {
  bookingId: BOOKING,
  propertyId: PROPERTY,
  reference: 'B-2026-0141',
  organizationName: 'אחוזת רימונים',
  propertyName: 'הבית בגליל',
  checkIn: '3.9.2026',
  checkOut: '7.9.2026',
  portalUrl: 'https://estia.example/g/abc',
  outstandingAgorot: 120050,
}

let messages: InMemoryMessagingRepository
let notifications: InMemoryNotificationRepository
let audit: InMemoryAuditWriter
let events: InMemoryEventBus
let idempotency: InMemoryIdempotencyStore
let guest: GuestRecipient
let enabledChannels: NotificationChannel[] | null

/** The cleaner the work is assigned to. Real grants, from the real catalogue. */
function cleanerCandidate(): NotificationCandidate {
  return { actor: actor('cleaner', { userId: CLEANER_ID }), preferences: [] }
}

const guests: GuestMessageSource = {
  async load(organizationId, bookingId) {
    if (organizationId !== ORG || bookingId !== BOOKING) return null
    return { recipient: guest, subject: SUBJECT }
  },
}

const staff: StaffRecipientSource = {
  async forUser(_organizationId, userId) {
    return userId === CLEANER_ID ? cleanerCandidate() : null
  },
  async team() {
    return [cleanerCandidate()]
  },
}

/**
 * A provider that claims to work.
 *
 * There is none in this codebase and no credential for one. It exists so the
 * paths BEYOND the gap — a real send, a quiet-hours deferral, a provider that
 * throws — can be exercised without any test pretending the product ships one.
 */
function fakeProviders(
  result: ProviderResult = {
    status: 'sent',
    provider: 'fake',
    providerMessageId: 'wamid.1',
  },
): MessageProviderRegistry {
  const make = (channel: GuestChannel): MessageProvider => ({
    name: 'fake',
    channel,
    configured: true,
    async send() {
      if (result instanceof Error) throw result
      return result
    },
  })
  return new MessageProviderRegistry(
    [make('whatsapp'), make('sms'), make('email')],
    make,
  )
}

function throwingProviders(): MessageProviderRegistry {
  const make = (channel: GuestChannel): MessageProvider => ({
    name: 'fake',
    channel,
    configured: true,
    async send() {
      throw new Error('socket hang up')
    },
  })
  return new MessageProviderRegistry([make('whatsapp')], make)
}

function build(providers = defaultMessageProviderRegistry()) {
  return defineMessagingOperations({
    messages,
    providers,
    guests,
    staff,
    notifications,
    transports: new TransportRegistry(),
    async settings() {
      return settings(
        enabledChannels === null
          ? {}
          : { enabledChannels: [...enabledChannels] },
      )
    },
  })
}

function services(): OperationServices {
  return { audit, idempotency, events }
}

function context(
  role: Parameters<typeof actor>[0],
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    actor: actor(role),
    auditActor: { type: 'user', userId: 'user-1', label: 'דנה כהן' },
    correlationId: 'corr-1',
    now: DAY,
    reason: null,
    ...overrides,
  }
}

beforeEach(() => {
  messages = new InMemoryMessagingRepository(DAY)
  notifications = new InMemoryNotificationRepository()
  audit = new InMemoryAuditWriter()
  events = new InMemoryEventBus()
  idempotency = new InMemoryIdempotencyStore()
  guest = RECIPIENT
  enabledChannels = null
})

/* ══ the names Autopilot's registry has to bind ═══════════════════════════ */

describe('the operation names', () => {
  it('are the three the command registry is waiting for', () => {
    const ops = build()
    expect(ops.sendGuestMessage.definition.name).toBe(
      'messaging.guest_message.send',
    )
    expect(ops.notifyAssignee.definition.name).toBe('messaging.assignee.notify')
    expect(ops.notifyTeam.definition.name).toBe('messaging.team.notify')
  })

  it('declare the grants the action catalogue already declares', () => {
    const ops = build()
    expect(ops.sendGuestMessage.definition.permission).toBe('message.send')
    expect(ops.notifyAssignee.definition.permission).toBe('task.assign')
    expect(ops.notifyTeam.definition.permission).toBe(
      'notification.preferences.manage',
    )
  })
})

/* ══ THE ONE RULE: nothing is reported as sent that was not ═══════════════ */

describe('a guest message with no transport configured', () => {
  it('records the intent as not_configured and never claims delivery', async () => {
    const ops = build()

    const outcome = await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'arrival_info',
          channel: 'whatsapp',
        },
      },
      context: context('reception'),
      services: services(),
    })

    expect(outcome.data.outcome).toBe('not_configured')
    // No provider name, because no provider was asked — the registry answered
    // from configuration alone. `notifications/dispatch.ts` records the same
    // null for the same reason: naming one would make an empty channel look
    // like a channel that tried.
    expect(outcome.data.message.provider).toBeNull()
    expect(outcome.data.message.providerMessageId).toBeNull()
    // The two statuses that would mean somebody was reached.
    expect(outcome.data.message.outcome).not.toBe('sent')
    expect(outcome.data.message.outcome).not.toBe('delivered')
  })

  it('composes and stores the Hebrew anyway, so it can still be used', async () => {
    // The text is useful with no provider at all: most guesthouses in this
    // market have WhatsApp open on the same telephone. The module's job is to
    // make sure the message EXISTS and that the record never lies about it.
    const ops = build()

    await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'arrival_info',
          channel: 'whatsapp',
        },
      },
      context: context('reception'),
      services: services(),
    })

    expect(messages.messages).toHaveLength(1)
    expect(messages.messages[0].body).toContain('שלום דנה,')
    expect(messages.messages[0].body).toContain('הבית בגליל')
  })

  it('publishes no domain event, because nothing was sent', async () => {
    // `payment.instructions_sent` raised here would tell every subscriber that
    // a guest has been told how to pay when nobody has told them anything.
    // A silence can be noticed; a false confirmation cannot.
    const ops = build()

    const outcome = await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'payment_reminder',
          channel: 'whatsapp',
        },
      },
      context: context('reception'),
      services: services(),
    })

    expect(outcome.events).toEqual([])
    expect(events.published).toEqual([])
  })

  it('says so in the audit trail, permanently and in Hebrew', async () => {
    const ops = build()

    await ops.sendGuestMessage.run({
      request: {
        input: { bookingId: BOOKING, kind: 'arrival_info', channel: 'sms' },
      },
      context: context('reception'),
      services: services(),
    })

    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].summary).toContain('אין ערוץ מחובר')
    expect(audit.records[0].summary).toContain('B-2026-0141')
  })

  it('stores the recipient masked and never in full', async () => {
    const ops = build()

    await ops.sendGuestMessage.run({
      request: {
        input: { bookingId: BOOKING, kind: 'arrival_info', channel: 'sms' },
      },
      context: context('reception'),
      services: services(),
    })

    expect(messages.messages[0].recipientMasked).toBe('***567')
    expect(JSON.stringify(messages.messages[0])).not.toContain('050-123-4567')
  })

  it('settles the row immediately, because nothing is in flight', async () => {
    const ops = build()

    await ops.sendGuestMessage.run({
      request: {
        input: { bookingId: BOOKING, kind: 'arrival_info', channel: 'email' },
      },
      context: context('reception'),
      services: services(),
    })

    expect(messages.messages[0].settledAt).toEqual(DAY)
  })
})

/* ══ refusals, with a stated reason ══════════════════════════════════════ */

describe('a guest who cannot be written to', () => {
  it('is refused when there is no contact detail on the channel', async () => {
    // Not silently skipped, and not recorded as "we tried". The CALLER asked
    // for something that cannot be done, and Autopilot must not show
    // `executed` beside a guest who was never going to be written to.
    guest = { ...RECIPIENT, phone: null }
    const ops = build()

    await expect(
      ops.sendGuestMessage.run({
        request: {
          input: {
            bookingId: BOOKING,
            kind: 'arrival_info',
            channel: 'whatsapp',
          },
        },
        context: context('reception'),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(messages.messages).toEqual([])
    expect(audit.records).toEqual([])
  })

  it('names the fix, because the person reading it can make it', async () => {
    guest = { ...RECIPIENT, email: 'not-an-address' }
    const ops = build()

    const error = await ops.sendGuestMessage
      .run({
        request: {
          input: { bookingId: BOOKING, kind: 'arrival_info', channel: 'email' },
        },
        context: context('reception'),
        services: services(),
      })
      .catch((caught: unknown) => caught)

    expect((error as BusinessRuleError).code).toBe(
      'messaging.no_contact_detail',
    )
    expect((error as BusinessRuleError).userMessage).toContain('כרטיס האורח')
  })

  it('is refused a review request when they have not consented', async () => {
    guest = { ...RECIPIENT, marketingConsent: false }
    const ops = build()

    const error = await ops.sendGuestMessage
      .run({
        request: {
          input: {
            bookingId: BOOKING,
            kind: 'review_request',
            channel: 'whatsapp',
          },
        },
        context: context('reception'),
        services: services(),
      })
      .catch((caught: unknown) => caught)

    expect((error as BusinessRuleError).code).toBe(
      'messaging.no_marketing_consent',
    )
  })

  it('still receives the arrival information they need', async () => {
    // A guest who switched off marketing has not asked to be locked out of the
    // room they are arriving at tonight.
    guest = { ...RECIPIENT, marketingConsent: false }
    const ops = build()

    const outcome = await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'arrival_info',
          channel: 'whatsapp',
        },
      },
      context: context('reception'),
      services: services(),
    })

    expect(outcome.data.message.kind).toBe('arrival_info')
  })
})

describe('authorization', () => {
  it('refuses a cleaner before a single row is read', async () => {
    const ops = build()

    await expect(
      ops.sendGuestMessage.run({
        request: {
          input: {
            bookingId: BOOKING,
            kind: 'arrival_info',
            channel: 'whatsapp',
          },
        },
        context: context('cleaner'),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })
})

/* ══ the paths beyond the gap ════════════════════════════════════════════ */

describe('a guest message with a provider behind it', () => {
  it('records sent, keeps the row open, and raises the frozen event', async () => {
    const ops = build(fakeProviders())

    const outcome = await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'payment_reminder',
          channel: 'whatsapp',
        },
      },
      context: context('reception'),
      services: services(),
    })

    expect(outcome.data.outcome).toBe('sent')
    expect(outcome.data.message.providerMessageId).toBe('wamid.1')
    // Not settled: a provider that accepted a message may still report a
    // bounce, and a settled_at written now would close a row that has not
    // finished happening.
    expect(outcome.data.message.settledAt).toBeNull()

    expect(outcome.events).toHaveLength(1)
    expect(outcome.events[0].name).toBe('payment.instructions_sent')
  })

  it('raises the event each kind actually maps to', async () => {
    const ops = build(fakeProviders())

    for (const [kind, expected] of [
      ['arrival_info', 'arrival.instructions_released'],
      ['review_request', 'booking.review_requested'],
    ] as const) {
      const outcome = await ops.sendGuestMessage.run({
        request: { input: { bookingId: BOOKING, kind, channel: 'sms' } },
        context: context('reception'),
        services: services(),
      })
      expect(outcome.events[0].name).toBe(expected)
    }
  })

  it('defers at night rather than waking a guest, and raises nothing yet', async () => {
    const ops = build(fakeProviders())

    const outcome = await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'payment_reminder',
          channel: 'whatsapp',
        },
      },
      context: context('reception', { now: NIGHT }),
      services: services(),
    })

    expect(outcome.data.outcome).toBe('deferred')
    expect(outcome.data.message.scheduledFor).toBeInstanceOf(Date)
    // Held, not sent — so nothing may claim it was.
    expect(outcome.events).toEqual([])
  })

  it('survives a provider that throws, and records it as failed', async () => {
    // `service/events.ts` is explicit: a failed WhatsApp message must not undo
    // the business act that caused it. The port forbids a throw; this is the
    // proof the promise is kept for a provider that breaks it.
    const ops = build(throwingProviders())

    const outcome = await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'arrival_info',
          channel: 'whatsapp',
        },
      },
      context: context('reception'),
      services: services(),
    })

    expect(outcome.data.outcome).toBe('failed')
    expect(outcome.data.message.outcomeDetail).toContain('provider_threw')
    expect(outcome.events).toEqual([])
  })

  it('records a provider that refuses as not_configured, not as failed', async () => {
    // A registered client with no credential is the business missing a
    // purchase, not a broken integration. Two different things to buy.
    const ops = build(
      fakeProviders({
        status: 'not_configured',
        provider: 'twilio',
        reason: 'account sid is not set',
      }),
    )

    const outcome = await ops.sendGuestMessage.run({
      request: {
        input: { bookingId: BOOKING, kind: 'arrival_info', channel: 'sms' },
      },
      context: context('reception'),
      services: services(),
    })

    expect(outcome.data.outcome).toBe('not_configured')
    expect(outcome.data.message.provider).toBe('twilio')
  })
})

/* ══ notifying a member of staff ═════════════════════════════════════════ */

describe('notifyAssignee', () => {
  it('tells the person the task is assigned to', async () => {
    const ops = build()

    const outcome = await ops.notifyAssignee.run({
      request: {
        input: {
          taskId: TASK,
          assigneeUserId: CLEANER_ID,
          reason: 'assigned',
          summary: 'חדר 4, משפחת לוי',
          propertyId: PROPERTY,
        },
      },
      context: context('operations_manager'),
      services: services(),
    })

    expect(outcome.data.notified).toBe(1)
    expect(notifications.notifications).toHaveLength(1)
    expect(notifications.notifications[0].recipientUserId).toBe(CLEANER_ID)
    expect(notifications.notifications[0].eventName).toBe('task.assigned')
    // The caller's own detail, appended to the catalogue's Hebrew by
    // `eventDetail` — not composed here.
    expect(notifications.notifications[0].body).toContain('משפחת לוי')
  })

  it('routes the overdue escalation as the event it really is', async () => {
    const ops = build()

    await ops.notifyAssignee.run({
      request: {
        input: {
          taskId: TASK,
          assigneeUserId: CLEANER_ID,
          reason: 'overdue',
          propertyId: PROPERTY,
        },
      },
      context: context('operations_manager'),
      services: services(),
    })

    expect(notifications.notifications[0].eventName).toBe('task.overdue')
    expect(notifications.notifications[0].severity).toBe('urgent')
  })

  it('publishes no domain event, because it is a fan-out and not a fact', async () => {
    // Republishing the name it just routed would have any event→notification
    // bridge route it a second time, leaving a dedupe-key collision as the
    // only thing between a cleaner and two identical messages.
    const ops = build()

    const outcome = await ops.notifyAssignee.run({
      request: {
        input: { taskId: TASK, assigneeUserId: CLEANER_ID, reason: 'assigned' },
      },
      context: context('operations_manager'),
      services: services(),
    })

    expect(outcome.events).toEqual([])
    // The record is not missing: the pipeline wrote an audit event and the
    // notifications module wrote a row per recipient.
    expect(audit.records).toHaveLength(1)
  })

  it('refuses a person who is not a member, rather than telling nobody', async () => {
    const ops = build()

    await expect(
      ops.notifyAssignee.run({
        request: {
          input: {
            taskId: TASK,
            assigneeUserId: '88888888-8888-4888-8888-888888888888',
            reason: 'assigned',
          },
        },
        context: context('operations_manager'),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('records the honest gap on a channel with no transport', async () => {
    // The notifications module's own answer, reached through it rather than
    // reimplemented: the in-app row is delivered and the SMS is recorded as
    // having nowhere to go. `overdue` rather than `assigned` because the
    // default SMS preference floor is `attention` — an `info` notification is
    // suppressed by the person's own settings before the transport gap is ever
    // reached, and those two are the pair that must never be confused.
    enabledChannels = ['in_app', 'sms']
    const ops = build()

    const outcome = await ops.notifyAssignee.run({
      request: {
        input: { taskId: TASK, assigneeUserId: CLEANER_ID, reason: 'overdue' },
      },
      context: context('operations_manager'),
      services: services(),
    })

    expect(outcome.data.tally.delivered).toBe(1)
    expect(outcome.data.tally.not_configured).toBe(1)
    expect(outcome.data.tally.suppressed).toBeUndefined()
  })

  it('records a person’s own preference as suppressed and not as a gap', async () => {
    // The other half of the pair. Same channel, same missing transport — but
    // the message never reaches the transport question, because the person's
    // severity floor answered first. Merging these two would tell a business
    // to buy an SMS gateway that its own staff had switched off.
    enabledChannels = ['in_app', 'sms']
    const ops = build()

    const outcome = await ops.notifyAssignee.run({
      request: {
        input: { taskId: TASK, assigneeUserId: CLEANER_ID, reason: 'assigned' },
      },
      context: context('operations_manager'),
      services: services(),
    })

    expect(outcome.data.tally.suppressed).toBe(1)
    expect(outcome.data.tally.not_configured).toBeUndefined()
  })

  it('says in the audit trail when nobody was actually told', async () => {
    // A cleaner who has been suspended holds no grants. "נשלחה הודעה" beside
    // zero recipients is the same lie in a different table.
    const ops = defineMessagingOperations({
      messages,
      providers: defaultMessageProviderRegistry(),
      guests,
      staff: {
        async forUser() {
          return {
            actor: {
              ...actor('cleaner', { userId: CLEANER_ID }),
              membershipStatus: 'suspended' as const,
            },
            preferences: [],
          }
        },
        async team() {
          return []
        },
      },
      notifications,
      transports: new TransportRegistry(),
      async settings() {
        return settings()
      },
    })

    const outcome = await ops.notifyAssignee.run({
      request: {
        input: { taskId: TASK, assigneeUserId: CLEANER_ID, reason: 'assigned' },
      },
      context: context('operations_manager'),
      services: services(),
    })

    expect(outcome.data.notified).toBe(0)
    expect(outcome.data.skipped[0].reason).toBe('membership_not_active')
    expect(audit.records[0].summary).toContain('לא הגיעה לאף אחד')
  })
})

/* ══ notifying the team ══════════════════════════════════════════════════ */

describe('notifyTeam', () => {
  it('fans one frozen event out to everybody the engine allows', async () => {
    const ops = build()

    const outcome = await ops.notifyTeam.run({
      request: {
        input: {
          eventName: 'task.overdue',
          resourceType: 'task',
          resourceId: TASK,
          summary: 'ניקיון חדר 4 באיחור',
          propertyId: PROPERTY,
        },
      },
      context: context('cleaner', {
        actor: actor('cleaner', { userId: 'user-raiser' }),
      }),
      services: services(),
    })

    expect(outcome.data.notified).toBe(1)
    expect(notifications.notifications[0].recipientUserId).toBe(CLEANER_ID)
  })

  it('refuses an event name the frozen catalogue does not have', async () => {
    // Reported rather than invented. `contracts/events.ts` is not editable
    // from here and is not edited.
    const ops = build()

    const error = await ops.notifyTeam
      .run({
        request: {
          input: {
            eventName: 'team.pep_talk',
            resourceType: 'task',
            resourceId: TASK,
          },
        },
        context: context('cleaner'),
        services: services(),
      })
      .catch((caught: unknown) => caught)

    expect((error as BusinessRuleError).code).toBe('messaging.unknown_event')
  })

  it('refuses a real event nobody has written Hebrew for', async () => {
    // `route()` would answer `notifiable: false` and hand back an empty plan,
    // leaving a successful operation that told nobody anything. Refusing turns
    // that into a stated reason.
    const ops = build()

    const error = await ops.notifyTeam
      .run({
        request: {
          input: {
            eventName: 'booking.in_house',
            resourceType: 'booking',
            resourceId: BOOKING,
          },
        },
        context: context('cleaner'),
        services: services(),
      })
      .catch((caught: unknown) => caught)

    expect((error as BusinessRuleError).code).toBe(
      'messaging.event_not_notifiable',
    )
  })

  it('does not tell the person who raised it', async () => {
    // Somebody who alerts the team does not need to be told about their own
    // alert — the engine's third gate, reached rather than reimplemented.
    const ops = build()

    const outcome = await ops.notifyTeam.run({
      request: {
        input: {
          eventName: 'task.overdue',
          resourceType: 'task',
          resourceId: TASK,
          propertyId: PROPERTY,
        },
      },
      context: context('cleaner', {
        actor: actor('cleaner', { userId: CLEANER_ID }),
      }),
      services: services(),
    })

    expect(outcome.data.notified).toBe(0)
    expect(outcome.data.skipped[0].reason).toBe('is_actor')
  })

  it('publishes no domain event of its own', async () => {
    const ops = build()

    const outcome = await ops.notifyTeam.run({
      request: {
        input: {
          eventName: 'task.overdue',
          resourceType: 'task',
          resourceId: TASK,
          propertyId: PROPERTY,
        },
      },
      context: context('cleaner', {
        actor: actor('cleaner', { userId: 'user-raiser' }),
      }),
      services: services(),
    })

    expect(outcome.events).toEqual([])
  })
})

/* ══ a retried Autopilot action ══════════════════════════════════════════ */

describe('idempotency', () => {
  it('replays rather than writing a second message to the same guest', async () => {
    const ops = build()
    const request = {
      input: {
        bookingId: BOOKING,
        kind: 'arrival_info' as const,
        channel: 'whatsapp' as const,
      },
      idempotencyKey: 'autopilot-action-77',
    }

    const first = await ops.sendGuestMessage.run({
      request,
      context: context('reception'),
      services: services(),
    })
    const second = await ops.sendGuestMessage.run({
      request,
      context: context('reception'),
      services: services(),
    })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(messages.messages).toHaveLength(1)
    // One act, one audit row. A replay records nothing new.
    expect(audit.records).toHaveLength(1)
  })

  it('derives a dedupe key that survives a different request id', async () => {
    // The second floor, under the idempotency store: the unique index is what
    // makes a redelivered action a failed insert rather than a second message.
    const ops = build()

    await ops.sendGuestMessage.run({
      request: {
        input: {
          bookingId: BOOKING,
          kind: 'arrival_info',
          channel: 'whatsapp',
        },
        idempotencyKey: 'autopilot-action-77',
      },
      context: context('reception'),
      services: services(),
    })

    expect(messages.messages[0].dedupeKey).toBe(
      `${BOOKING}:arrival_info:whatsapp:autopilot-action-77`,
    )
  })
})
