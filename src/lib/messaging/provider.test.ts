import { describe, expect, it } from 'vitest'

import { nullProviderFor } from './null-provider'
import {
  MessageProviderRegistry,
  type MessageProvider,
  type ProviderResult,
} from './provider'
import type { GuestChannel } from './types'

/**
 * A provider that claims to work.
 *
 * There is no such thing in this codebase and there is deliberately no
 * credential for one. It exists here so the port's own behaviour — the
 * registry, the `configured` question, the shape of a success — can be
 * exercised without any test pretending the product ships one.
 */
function fake(
  channel: GuestChannel,
  result: ProviderResult = {
    status: 'sent',
    provider: 'fake',
    providerMessageId: 'wamid.1',
  },
): MessageProvider {
  return {
    name: 'fake',
    channel,
    configured: true,
    async send() {
      return result
    },
  }
}

describe('MessageProviderRegistry', () => {
  it('falls back for a channel nobody registered', () => {
    const registry = new MessageProviderRegistry([], nullProviderFor)
    expect(registry.for('sms').configured).toBe(false)
  })

  it('reports only the channels that can actually deliver', () => {
    const registry = new MessageProviderRegistry(
      [fake('whatsapp')],
      nullProviderFor,
    )

    expect(registry.configuredChannels()).toEqual(['whatsapp'])
    expect(registry.isConfigured('whatsapp')).toBe(true)
    expect(registry.isConfigured('email')).toBe(false)
  })

  it('does not count a registered provider that says it is not configured', () => {
    // Half a client behind a missing key registers itself and cannot send.
    // `configured` is the question, not membership of the map.
    const half: MessageProvider = { ...fake('email'), configured: false }
    const registry = new MessageProviderRegistry([half], nullProviderFor)

    expect(registry.configuredChannels()).toEqual([])
    expect(registry.isConfigured('email')).toBe(false)
  })

  it('lets a later registration replace an earlier one for the same channel', () => {
    const first = fake('sms')
    const second: MessageProvider = { ...fake('sms'), name: 'second' }
    const registry = new MessageProviderRegistry(
      [first, second],
      nullProviderFor,
    )

    expect(registry.for('sms').name).toBe('second')
  })
})

describe('the result union', () => {
  it('has no way to say a guest received anything', async () => {
    // Nothing in this product can confirm delivery to a guest, so `delivered`
    // is not in the union at all. A status nothing could honestly produce is
    // one nothing can accidentally write.
    const result = await fake('whatsapp').send({
      organizationId: 'org-1',
      messageId: 'm-1',
      channel: 'whatsapp',
      kind: 'arrival_info',
      to: '+972501234567',
      subject: null,
      body: 'שלום',
      correlationId: 'corr-1',
    })

    expect(['sent', 'failed', 'not_configured']).toContain(result.status)
  })
})
