import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_FOR_METHOD,
  guarded,
  supports,
  type GatedMethod,
} from './connector'
import { CONNECTOR_CAPABILITIES } from './types'
import { SpyConnector, aRequest } from './testing'

describe('capability guard', () => {
  it('refuses an undeclared capability WITHOUT calling the connector', async () => {
    // The whole point. A connector that has no rate endpoint would otherwise
    // be called and would answer "accepted: 0", which reads as success.
    const connector = new SpyConnector('booking_com', ['push_availability'])
    const engine = guarded(connector)

    const result = await engine.pushRates(aRequest(), [])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal.kind).toBe('capability_unsupported')
    expect(result.refusal.capability).toBe('push_rates')
    // Retrying cannot conjure an endpoint. A scheduler must not loop on this.
    expect(result.refusal.retryable).toBe(false)

    expect(connector.calls).toEqual([])
  })

  it('calls through when the capability is declared', async () => {
    const connector = new SpyConnector('airbnb', ['push_rates'])
    const engine = guarded(connector)

    const result = await engine.pushRates(aRequest(), [])

    expect(result.ok).toBe(true)
    expect(connector.calls).toEqual(['pushRates'])
  })

  it('never gates authenticate or health', async () => {
    // A connector that can do nothing must still be able to say so, or the
    // health centre renders nothing and silence reads as fine.
    const connector = new SpyConnector('expedia', [])
    const engine = guarded(connector)

    expect((await engine.authenticate(aRequest())).ok).toBe(true)
    expect((await engine.health(aRequest())).ok).toBe(true)
    expect(connector.calls).toEqual(['authenticate', 'health'])
  })

  it('gates every method that touches the channel', async () => {
    const connector = new SpyConnector('booking_com', [])
    const engine = guarded(connector)
    const request = aRequest()

    const methods = Object.keys(CAPABILITY_FOR_METHOD) as GatedMethod[]

    for (const method of methods) {
      const result = await callGated(engine, method, request)
      expect(result.ok, `${method} should have been refused`).toBe(false)
    }

    // Not one of them reached the connector.
    expect(connector.calls).toEqual([])
  })

  it('maps every gated method to a real capability', () => {
    for (const capability of Object.values(CAPABILITY_FOR_METHOD)) {
      expect(CONNECTOR_CAPABILITIES).toContain(capability)
    }
  })

  it('reports support from the declared list', () => {
    const connector = new SpyConnector('airbnb', ['pull_reservations'])
    expect(supports(connector, 'pull_reservations')).toBe(true)
    expect(supports(connector, 'push_restrictions')).toBe(false)
  })
})

async function callGated(
  engine: ReturnType<typeof guarded>,
  method: GatedMethod,
  request: ReturnType<typeof aRequest>,
) {
  switch (method) {
    case 'discoverListings':
      return engine.discoverListings(request)
    case 'pushAvailability':
      return engine.pushAvailability(request, [])
    case 'pushRates':
      return engine.pushRates(request, [])
    case 'pushRestrictions':
      return engine.pushRestrictions(request, [])
    case 'pullReservations':
      return engine.pullReservations(request, { since: null, cursor: null })
    case 'acknowledgeModification':
      return engine.acknowledgeModification(request, 'R-1')
    case 'acknowledgeCancellation':
      return engine.acknowledgeCancellation(request, 'R-1')
  }
}
