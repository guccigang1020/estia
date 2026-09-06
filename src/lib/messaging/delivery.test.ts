import { describe, expect, it } from 'vitest'

import { settings } from '../notifications/testing'

import { planOutward, quietHoursHold } from './delivery'
import { defaultMessageProviderRegistry } from './null-provider'
import { MessageProviderRegistry, type MessageProvider } from './provider'
import type { GuestChannel } from './types'

/** Ten in the morning in Asia/Jerusalem. Outside the default quiet window. */
const DAYTIME = new Date('2026-03-11T08:00:00.000Z')
/** Half past midnight there. Inside it. */
const NIGHT = new Date('2026-03-10T22:40:00.000Z')

function working(channel: GuestChannel): MessageProvider {
  return {
    name: 'fake',
    channel,
    configured: true,
    async send() {
      return { status: 'sent', provider: 'fake', providerMessageId: null }
    },
  }
}

function withProvider(channel: GuestChannel): MessageProviderRegistry {
  return new MessageProviderRegistry([working(channel)], () => working(channel))
}

// ── Gate order ────────────────────────────────────────────────────────────

describe('the order of the two gates', () => {
  it('reports a missing provider even in the middle of the night', () => {
    // Checked BEFORE quiet hours, and this is the case that proves it.
    // Deferring to seven in the morning on a channel that does not exist would
    // produce a queue of things that will never be sent and a screen saying
    // "waiting" about them forever.
    const plan = planOutward({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      providers: defaultMessageProviderRegistry(),
      settings: settings(),
      now: NIGHT,
    })

    expect(plan).toMatchObject({
      action: 'record',
      outcome: 'not_configured',
      scheduledFor: null,
    })
  })

  it('never asks a provider that reported itself unconfigured', () => {
    const plan = planOutward({
      kind: 'arrival_info',
      channel: 'sms',
      providers: defaultMessageProviderRegistry(),
      settings: settings(),
      now: DAYTIME,
    })

    expect(plan.action).not.toBe('send')
  })
})

// ── Quiet hours ───────────────────────────────────────────────────────────

describe('quiet hours', () => {
  it('defer an outward message and give it a time it will go', () => {
    const plan = planOutward({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      providers: withProvider('whatsapp'),
      settings: settings(),
      now: NIGHT,
    })

    expect(plan.action).toBe('hold')
    expect(plan.outcome).toBe('deferred')
    // Held, never dropped. A deferral with no time is a message that never
    // goes, and 0043 has a check constraint refusing exactly that.
    expect(plan.scheduledFor).toBeInstanceOf(Date)
    expect(plan.scheduledFor?.getTime()).toBeGreaterThan(NIGHT.getTime())
  })

  it('never defer an internal message here', () => {
    // Emphatically NOT "internal messages ignore quiet hours". That decision
    // has already been made per recipient and per channel by
    // notifications/routing.ts, which knows this person's preferences, their
    // severity floor and that in_app is pull. Making it a second time here
    // would be a second opinion that can disagree with the first.
    const verdict = quietHoursHold({
      direction: 'internal',
      channel: 'sms',
      severity: 'info',
      settings: settings(),
      now: NIGHT,
    })

    expect(verdict.held).toBe(false)
  })

  it('hold the same message outward at the same instant', () => {
    // The pair. Same channel, same severity, same clock — only the direction
    // differs, which is the whole asymmetry stated as one assertion.
    const verdict = quietHoursHold({
      direction: 'outward',
      channel: 'sms',
      severity: 'info',
      settings: settings(),
      now: NIGHT,
    })

    expect(verdict.held).toBe(true)
  })

  it('let an outward message straight through in the daytime', () => {
    const plan = planOutward({
      kind: 'review_request',
      channel: 'email',
      providers: withProvider('email'),
      settings: settings(),
      now: DAYTIME,
    })

    expect(plan).toMatchObject({
      action: 'send',
      outcome: 'pending',
      scheduledFor: null,
    })
  })

  it('let it through at night when the business has quiet hours off', () => {
    const plan = planOutward({
      kind: 'arrival_info',
      channel: 'whatsapp',
      providers: withProvider('whatsapp'),
      settings: settings({ quietHoursEnabled: false }),
      now: NIGHT,
    })

    expect(plan.action).toBe('send')
  })

  it('does not let a guest message through on the urgent override', () => {
    // `urgentOverridesQuietHours` admits `urgent` and above, and no guest
    // message kind reaches that severity. A review request that woke somebody
    // at two in the morning would be the worst message this product could
    // send, so the override is unreachable from here by construction.
    for (const kind of [
      'payment_reminder',
      'arrival_info',
      'review_request',
    ] as const) {
      const plan = planOutward({
        kind,
        channel: 'sms',
        providers: withProvider('sms'),
        settings: settings({ urgentOverridesQuietHours: true }),
        now: NIGHT,
      })
      expect(plan.action).toBe('hold')
    }
  })
})
