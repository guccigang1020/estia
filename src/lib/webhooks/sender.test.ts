import { describe, expect, it } from 'vitest'

import { attemptDelivery, type WebhookTransport } from './sender'
import { verifySignature, SIGNATURE_HEADER } from './signature'
import type { WebhookEnvelope } from './subscription'

const NOW = new Date('2026-09-06T12:00:00.000Z')
const SECRET = 'a'.repeat(64)

const envelope: WebhookEnvelope = {
  id: 'del-1',
  type: 'booking.created',
  createdAt: NOW.toISOString(),
  organizationId: '11111111-1111-4111-8111-111111111111',
  propertyId: null,
  data: { bookingId: 'b-1' },
}

interface Sent {
  url: string
  body: string
  headers: Record<string, string>
}

function transport(
  addresses: readonly string[],
  reply: Awaited<ReturnType<WebhookTransport['post']>> = {
    kind: 'responded',
    statusCode: 200,
  },
): { port: WebhookTransport; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    port: {
      async resolve() {
        return addresses
      },
      async post(request) {
        sent.push({
          url: request.url,
          body: request.body,
          headers: { ...request.headers },
        })
        return reply
      },
    },
  }
}

describe('the happy path', () => {
  it('posts the signed envelope and reports the status', async () => {
    const { port, sent } = transport(['93.184.216.34'])
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/estia',
      [SECRET],
      port,
      NOW,
    )

    expect(outcome).toEqual({ kind: 'responded', statusCode: 200 })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://hooks.example.com/estia')
    expect(JSON.parse(sent[0].body)).toEqual(envelope)
  })

  it('signs the exact bytes it sends', async () => {
    const { port, sent } = transport(['93.184.216.34'])
    await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )

    const { body, headers } = sent[0]
    expect(
      verifySignature(body, headers[SIGNATURE_HEADER], [SECRET], NOW),
    ).toEqual({ ok: true })
  })

  it('names the event and the delivery in headers, so routing needs no parse', async () => {
    const { port, sent } = transport(['93.184.216.34'])
    await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )

    expect(sent[0].headers['estia-event']).toBe('booking.created')
    expect(sent[0].headers['estia-delivery']).toBe('del-1')
    expect(sent[0].headers['content-type']).toBe('application/json')
  })

  it('signs with every live secret during a rotation', async () => {
    const OTHER = 'b'.repeat(64)
    const { port, sent } = transport(['93.184.216.34'])
    await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [OTHER, SECRET],
      port,
      NOW,
    )

    const { body, headers } = sent[0]
    expect(
      verifySignature(body, headers[SIGNATURE_HEADER], [SECRET], NOW).ok,
    ).toBe(true)
    expect(
      verifySignature(body, headers[SIGNATURE_HEADER], [OTHER], NOW).ok,
    ).toBe(true)
  })
})

describe('the second gate', () => {
  it('refuses when the hostname resolves somewhere private', async () => {
    // This is DNS rebinding: the URL passed registration, and the record
    // changed afterwards. Registration-time checking alone is theatre.
    const { port, sent } = transport(['10.0.0.5'])
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )

    expect(outcome).toEqual({
      kind: 'unsafe_address',
      detail: 'hooks.example.com resolved to 10.0.0.5',
    })
    expect(sent).toHaveLength(0)
  })

  it('refuses the metadata address however it is reached', async () => {
    const { port, sent } = transport(['169.254.169.254'])
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )
    expect(outcome.kind).toBe('unsafe_address')
    expect(sent).toHaveLength(0)
  })

  it('checks EVERY address, not just the first', async () => {
    // One public A record and one private one is the cheapest bypass there
    // is, and taking whichever the resolver ordered first makes the check a
    // coin toss.
    const { port, sent } = transport(['93.184.216.34', '127.0.0.1'])
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )
    expect(outcome.kind).toBe('unsafe_address')
    expect(sent).toHaveLength(0)
  })

  it('sends when every address is public', async () => {
    const { port, sent } = transport(['93.184.216.34', '2606:4700::1111'])
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )
    expect(outcome).toEqual({ kind: 'responded', statusCode: 200 })
    expect(sent).toHaveLength(1)
  })

  it('treats "resolved to nothing" as a network problem, not a pass', async () => {
    const { port, sent } = transport([])
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )
    expect(outcome).toEqual({
      kind: 'network_error',
      detail: 'the host resolved to no address',
    })
    expect(sent).toHaveLength(0)
  })

  it('treats a resolver failure as retryable, not as a refusal', async () => {
    // A receiver's DNS can be down without their service being gone.
    const port: WebhookTransport = {
      async resolve() {
        throw new Error('EAI_AGAIN')
      },
      async post() {
        throw new Error('must not be reached')
      },
    }
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [SECRET],
      port,
      NOW,
    )
    expect(outcome).toEqual({ kind: 'network_error', detail: 'EAI_AGAIN' })
  })
})

describe('refusals that never open a socket', () => {
  it('will not send unsigned', async () => {
    // The receiver would reject it, and every retry would burn an attempt on
    // a delivery that could never succeed.
    const { port, sent } = transport(['93.184.216.34'])
    const outcome = await attemptDelivery(
      envelope,
      'https://hooks.example.com/x',
      [],
      port,
      NOW,
    )
    expect(outcome.kind).toBe('unsafe_address')
    expect(sent).toHaveLength(0)
  })

  it('refuses a stored URL that is not a URL', async () => {
    const { port, sent } = transport(['93.184.216.34'])
    const outcome = await attemptDelivery(
      envelope,
      'not-a-url',
      [SECRET],
      port,
      NOW,
    )
    expect(outcome).toEqual({
      kind: 'unsafe_address',
      detail: 'the stored URL is not a URL',
    })
    expect(sent).toHaveLength(0)
  })
})

describe('what comes back', () => {
  it('reports a failure status without interpreting it', async () => {
    const { port } = transport(['93.184.216.34'], {
      kind: 'responded',
      statusCode: 503,
    })
    expect(
      await attemptDelivery(
        envelope,
        'https://h.example.com/x',
        [SECRET],
        port,
        NOW,
      ),
    ).toEqual({ kind: 'responded', statusCode: 503 })
  })

  it('passes a timeout through as a timeout', async () => {
    const { port } = transport(['93.184.216.34'], { kind: 'timed_out' })
    expect(
      await attemptDelivery(
        envelope,
        'https://h.example.com/x',
        [SECRET],
        port,
        NOW,
      ),
    ).toEqual({ kind: 'timed_out' })
  })

  it('reports a redirect as the status it is, so retry.ts can refuse it', async () => {
    // A checked, public host answering 302 to 169.254.169.254 walks through
    // every gate above — the gates ran on the URL requested, not the one
    // finally fetched. So 3xx is a failure and is never followed.
    const { port } = transport(['93.184.216.34'], {
      kind: 'responded',
      statusCode: 302,
    })
    expect(
      await attemptDelivery(
        envelope,
        'https://h.example.com/x',
        [SECRET],
        port,
        NOW,
      ),
    ).toEqual({ kind: 'responded', statusCode: 302 })
  })
})
