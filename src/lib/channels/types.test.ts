import { describe, expect, it } from 'vitest'

import { BOOKING_SOURCES } from '../booking/types'

import {
  BOOKING_SOURCE_FOR_CHANNEL,
  CAPABILITY_LABEL,
  CHANNEL_CODES,
  CHANNEL_LABEL,
  CONNECTOR_CAPABILITIES,
  DOWNSTREAM_LABEL,
  DOWNSTREAM_SYSTEMS,
  SYNC_STATES,
  SYNC_STATE_LABEL,
  refuse,
  succeed,
} from './types'

describe('the channel vocabulary', () => {
  it('maps every channel onto the frozen booking source contract', () => {
    // A channel added without an attribution is a booking from nowhere, and a
    // value outside BOOKING_SOURCES is a value the database enum will refuse.
    for (const code of CHANNEL_CODES) {
      expect(BOOKING_SOURCES).toContain(BOOKING_SOURCE_FOR_CHANNEL[code])
    }
  })

  it('gives every channel a name a person recognises', () => {
    for (const code of CHANNEL_CODES) {
      expect(CHANNEL_LABEL[code].length).toBeGreaterThan(0)
    }
  })

  it('keeps Expedia under other_channel without losing the name', () => {
    // The booking enum does not name Expedia, and widening it is a migration
    // rather than this module's decision.
    expect(BOOKING_SOURCE_FOR_CHANNEL.expedia).toBe('other_channel')
    expect(CHANNEL_LABEL.expedia).toBe('Expedia')
  })

  it('labels every capability, sync state and downstream system', () => {
    for (const capability of CONNECTOR_CAPABILITIES) {
      expect(CAPABILITY_LABEL[capability].length).toBeGreaterThan(0)
    }
    for (const state of SYNC_STATES) {
      expect(SYNC_STATE_LABEL[state].length).toBeGreaterThan(0)
    }
    for (const system of DOWNSTREAM_SYSTEMS) {
      expect(DOWNSTREAM_LABEL[system].length).toBeGreaterThan(0)
    }
  })
})

describe('results', () => {
  it('distinguishes a push that did not happen from one that changed nothing', () => {
    const nothing = succeed({ accepted: 0 })
    const refused = refuse<{ accepted: number }>({
      kind: 'rate_limited',
      message: 'הערוץ ביקש להאט.',
      retryable: true,
      retryAfterSeconds: 30,
    })

    expect(nothing.ok).toBe(true)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.refusal.retryAfterSeconds).toBe(30)
  })
})
