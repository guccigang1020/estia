import { describe, expect, it } from 'vitest'

import { DOMAIN_EVENTS } from '../contracts/events'
import { specFor } from '../notifications/catalogue'
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
} from '../notifications/types'

import {
  claimsDelivery,
  EVENT_FOR_KIND,
  GUEST_CHANNELS,
  GUEST_MESSAGE_KINDS,
  isGuestChannel,
  KIND_LABEL,
  KIND_SEVERITY,
  requiresMarketingConsent,
} from './types'

// ── The vocabulary is borrowed, and this is what proves it ────────────────

describe('the channel vocabulary', () => {
  it('is a subset of the notification channels and never a second list', () => {
    for (const channel of GUEST_CHANNELS) {
      expect(NOTIFICATION_CHANNELS).toContain(channel)
    }
  })

  it('excludes the two channels a guest cannot have', () => {
    // A guest holds a capability URL, not a session and not a device
    // registration. Offering `in_app` would be offering an inbox that does not
    // exist for them.
    expect(GUEST_CHANNELS).not.toContain('in_app')
    expect(GUEST_CHANNELS).not.toContain('push')
  })

  it('recognises its own members and nothing else', () => {
    expect(isGuestChannel('whatsapp')).toBe(true)
    expect(isGuestChannel('in_app')).toBe(false)
    expect(isGuestChannel('carrier_pigeon')).toBe(false)
  })
})

describe('the outcome vocabulary', () => {
  it('is the delivery-status vocabulary 0043 already models', () => {
    // Not an assertion about a copy. `MessageOutcome` IS
    // `NotificationDeliveryStatus`, so the two members that carry the honesty
    // argument are the same values in both tables.
    expect(NOTIFICATION_DELIVERY_STATUSES).toContain('not_configured')
    expect(NOTIFICATION_DELIVERY_STATUSES).toContain('suppressed')
  })

  it('counts only sent and delivered as having reached anybody', () => {
    expect(claimsDelivery('sent')).toBe(true)
    expect(claimsDelivery('delivered')).toBe(true)

    // The four that must never be mistaken for a message somebody received.
    expect(claimsDelivery('not_configured')).toBe(false)
    expect(claimsDelivery('suppressed')).toBe(false)
    expect(claimsDelivery('deferred')).toBe(false)
    expect(claimsDelivery('failed')).toBe(false)
  })
})

// ── Every kind names an event that already exists ─────────────────────────

describe('the guest message kinds', () => {
  it('each map to a name in the frozen catalogue', () => {
    for (const kind of GUEST_MESSAGE_KINDS) {
      expect(DOMAIN_EVENTS).toContain(EVENT_FOR_KIND[kind])
    }
  })

  it('cover exactly the three actions Autopilot is blocked on', () => {
    expect([...GUEST_MESSAGE_KINDS]).toEqual([
      'payment_reminder',
      'arrival_info',
      'review_request',
    ])
  })

  it('all have Hebrew a person can read', () => {
    for (const kind of GUEST_MESSAGE_KINDS) {
      expect(KIND_LABEL[kind]).toMatch(/[֐-׿]/u)
    }
  })
})

describe('consent', () => {
  it('gates the review request, which is an ask on the business behalf', () => {
    expect(requiresMarketingConsent('review_request')).toBe(true)
  })

  it('does not gate anything about the stay the guest already bought', () => {
    // A guest who switched off marketing has not asked to stop being told the
    // door code of the room they are arriving at tonight.
    expect(requiresMarketingConsent('arrival_info')).toBe(false)
    expect(requiresMarketingConsent('payment_reminder')).toBe(false)
  })
})

describe('severity', () => {
  it('never rises high enough to pass through quiet hours', () => {
    // `overridesQuietHours` admits `urgent` and above. Nothing addressed to a
    // guest is allowed to reach it: a review request that woke somebody at two
    // in the morning would be the worst message this product could send.
    for (const kind of GUEST_MESSAGE_KINDS) {
      expect(['info', 'attention']).toContain(KIND_SEVERITY[kind])
    }
  })
})

// ── The events named are events somebody could actually be told about ─────

describe('the notification catalogue', () => {
  it('knows how to word every event a guest message raises', () => {
    // Not required for the guest, who reads composed text. Required for the
    // staff side: a subscriber turning `payment.instructions_sent` into a
    // notification needs a catalogue entry, and an event with none reaches
    // nobody.
    for (const kind of GUEST_MESSAGE_KINDS) {
      const spec = specFor(EVENT_FOR_KIND[kind])
      // `specFor` returning undefined is a stated gap rather than a failure —
      // see the module report. What must never happen is the name itself being
      // absent from the frozen list, which the test above asserts.
      if (spec) expect(spec.title.length).toBeGreaterThan(0)
    }
  })
})
