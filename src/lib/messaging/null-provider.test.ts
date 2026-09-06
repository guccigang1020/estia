import { describe, expect, it } from 'vitest'

import {
  defaultMessageProviderRegistry,
  NULL_PROVIDER_NAME,
  NullMessageProvider,
  nullProviderFor,
} from './null-provider'
import type { MessageProvider, OutboundGuestMessage } from './provider'
import { GUEST_CHANNELS } from './types'

const MESSAGE: OutboundGuestMessage = {
  organizationId: 'org-1',
  messageId: 'booking-1:arrival_info:whatsapp:key-1',
  channel: 'whatsapp',
  kind: 'arrival_info',
  to: '+972501234567',
  subject: null,
  body: 'שלום דנה,',
  correlationId: 'corr-1',
}

describe('the null provider', () => {
  it('never reports success', async () => {
    // The one answer it must never give. A row saying `sent` for a message
    // that does not exist would put a false reassurance in the one table a
    // business consults to find out what its guests were not told.
    for (const channel of GUEST_CHANNELS) {
      const result = await nullProviderFor(channel).send(MESSAGE)
      expect(result.status).toBe('not_configured')
    }
  })

  it('does not throw', async () => {
    // A provider that threw would propagate into the operation trying to
    // record the gap, and the record is the whole value of the gap. Held as
    // the port type, because that is how every caller holds it.
    const provider: MessageProvider = new NullMessageProvider('sms')
    await expect(provider.send(MESSAGE)).resolves.toBeDefined()
  })

  it('names itself, so today’s rows are distinguishable from tomorrow’s', async () => {
    const result = await nullProviderFor('email').send(MESSAGE)
    expect(result.provider).toBe(NULL_PROVIDER_NAME)
    expect(NULL_PROVIDER_NAME).toBe('none')
  })

  it('says which purchase is missing, per channel', async () => {
    // Three different purchases — a WhatsApp Business number, an SMS gateway,
    // a mail domain — and whoever reads this column is deciding which to make.
    const whatsapp = await nullProviderFor('whatsapp').send(MESSAGE)
    const email = await nullProviderFor('email').send(MESSAGE)

    if (whatsapp.status !== 'not_configured') throw new Error('unreachable')
    if (email.status !== 'not_configured') throw new Error('unreachable')

    expect(whatsapp.reason).toContain('WhatsApp')
    expect(email.reason).toContain('email')
    expect(whatsapp.reason).not.toBe(email.reason)
  })

  it('reports itself unconfigured without being asked to send', () => {
    // Read by the settings screen, from configuration alone. A provider that
    // made a network call to answer this would make a settings page depend on
    // a third party being up.
    expect(new NullMessageProvider('sms').configured).toBe(false)
  })
})

describe('the registry this product ships', () => {
  it('has nothing configured', () => {
    const registry = defaultMessageProviderRegistry()
    expect(registry.configuredChannels()).toEqual([])

    for (const channel of GUEST_CHANNELS) {
      expect(registry.isConfigured(channel)).toBe(false)
    }
  })

  it('hands back a refusing provider rather than throwing', () => {
    // "Nothing is connected" is the ordinary state of this product and must
    // never be a crash.
    const registry = defaultMessageProviderRegistry()
    expect(registry.for('whatsapp').name).toBe(NULL_PROVIDER_NAME)
  })

  it('is a fresh object each time, so nothing can be added to it globally', () => {
    // A registry that can be mutated at runtime is a registry whose contents
    // depend on import order.
    expect(defaultMessageProviderRegistry()).not.toBe(
      defaultMessageProviderRegistry(),
    )
  })
})
