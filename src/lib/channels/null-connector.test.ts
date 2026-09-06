import { describe, expect, it } from 'vitest'

import { guarded } from './connector'
import {
  NullConnector,
  anyChannelConfigured,
  connectorFor,
  noCredentialRefusal,
} from './null-connector'
import { CHANNEL_CODES } from './types'
import { aRequest } from './testing'

describe('the null connector', () => {
  it('declares no capabilities at all', () => {
    for (const code of CHANNEL_CODES) {
      expect(new NullConnector(code).capabilities).toEqual([])
    }
  })

  it('refuses every outward call with a stated reason', async () => {
    const connector = new NullConnector('booking_com')
    const request = aRequest()

    const results = await Promise.all([
      connector.authenticate(request),
      connector.discoverListings(request),
      connector.pushAvailability(),
      connector.pushRates(),
      connector.pushRestrictions(),
      connector.pullReservations(),
      connector.acknowledgeModification(),
      connector.acknowledgeCancellation(),
    ])

    for (const result of results) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.refusal.kind).toBe('not_configured')
      // Retrying will not conjure a credential.
      expect(result.refusal.retryable).toBe(false)
      expect(result.refusal.message.length).toBeGreaterThan(0)
    }
  })

  it('answers health rather than refusing it', async () => {
    // A refusal here would leave the health centre with nothing to draw, and
    // an empty row reads exactly like a healthy one.
    const result = await new NullConnector('airbnb').health(aRequest())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.reachable).toBe(false)
    expect(result.value.notes).toHaveLength(1)
  })

  it('is refused by the guard before it is even reached', async () => {
    const engine = guarded(connectorFor('expedia'))
    const result = await engine.pullReservations(aRequest(), {
      since: null,
      cursor: null,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.kind).toBe('capability_unsupported')
  })

  it('says plainly that nothing is connected', () => {
    expect(anyChannelConfigured()).toBe(false)
  })

  it('names the channel in the refusal', () => {
    expect(noCredentialRefusal('booking_com').message).toContain('booking_com')
  })
})
