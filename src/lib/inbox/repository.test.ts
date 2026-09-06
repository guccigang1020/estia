import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient, hasFilter } from '../persistence/fake-client'
import { InboxRepository, isMissingSchema } from './repository'
import { isOutbound } from './types'

const ORG = '11111111-1111-4111-8111-111111111111'

const conversationRow = (over: Record<string, unknown> = {}) => ({
  id: 'c-1',
  organization_id: ORG,
  property_id: null,
  guest_id: null,
  contact_name: 'דנה',
  contact_phone: null,
  contact_email: 'dana@example.com',
  subject: 'פנייה מהאתר',
  status: 'waiting_on_us',
  origin: 'site_request',
  site_request_id: 'sr-1',
  guest_request_id: null,
  assigned_to_user_id: null,
  last_message_at: '2026-09-06T10:00:00.000Z',
  last_inbound_at: '2026-09-06T10:00:00.000Z',
  opened_at: '2026-09-06T09:00:00.000Z',
  closed_at: null,
  version: 3,
  ...over,
})

describe('reading a thread', () => {
  it('maps a row into a conversation', async () => {
    const fake = new FakeSupabaseClient({
      responses: { conversations: { data: [conversationRow()] } },
    })

    const [conversation] = await new InboxRepository(fake.asDb()).conversations(
      ORG,
    )

    expect(conversation.id).toBe('c-1')
    expect(conversation.party).toEqual({
      guestId: null,
      contactName: 'דנה',
      contactPhone: null,
      contactEmail: 'dana@example.com',
    })
    expect(conversation.status).toBe('waiting_on_us')
    expect(conversation.lastInboundAt).toEqual(
      new Date('2026-09-06T10:00:00.000Z'),
    )
    expect(conversation.version).toBe(3)
  })

  it('scopes every read by organization', async () => {
    // A tenant isolation claim, made without a database.
    const fake = new FakeSupabaseClient({
      responses: { conversations: { data: [] } },
    })
    await new InboxRepository(fake.asDb()).conversations(ORG)

    expect(hasFilter(fake.queries[0], 'eq', 'organization_id', ORG)).toBe(true)
  })

  it('hides closed threads unless asked', async () => {
    const fake = new FakeSupabaseClient({
      responses: { conversations: [{ data: [] }, { data: [] }] },
    })
    const repository = new InboxRepository(fake.asDb())

    await repository.conversations(ORG)
    expect(hasFilter(fake.queries[0], 'neq', 'status', 'closed')).toBe(true)

    await repository.conversations(ORG, { includeClosed: true })
    expect(hasFilter(fake.queries[1], 'neq', 'status', 'closed')).toBe(false)
  })
})

describe('reading the messages', () => {
  it('reads an outbound message as a reference with no body', async () => {
    // The module's central rule, at the mapping layer. `OutboundMessage` has
    // no `body` field at all, so there is nowhere for the text to land even if
    // a row somehow carried one.
    const fake = new FakeSupabaseClient({
      responses: {
        conversation_messages: {
          data: [
            {
              id: 'm-1',
              organization_id: ORG,
              conversation_id: 'c-1',
              direction: 'outbound',
              channel: 'email',
              body: null,
              guest_message_id: 'gm-1',
              author_user_id: 'user-1',
              occurred_at: '2026-09-06T11:00:00.000Z',
            },
          ],
        },
      },
    })

    const [message] = await new InboxRepository(fake.asDb()).messages(
      ORG,
      'c-1',
    )

    expect(isOutbound(message)).toBe(true)
    if (!isOutbound(message)) return
    expect(message.guestMessageId).toBe('gm-1')
    expect(Object.keys(message)).not.toContain('body')
  })

  it('reads an inbound message as its own words', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        conversation_messages: {
          data: [
            {
              id: 'm-2',
              organization_id: ORG,
              conversation_id: 'c-1',
              direction: 'inbound',
              channel: 'site_form',
              body: 'יש חניה?',
              guest_message_id: null,
              author_user_id: null,
              occurred_at: '2026-09-06T10:00:00.000Z',
            },
          ],
        },
      },
    })

    const [message] = await new InboxRepository(fake.asDb()).messages(
      ORG,
      'c-1',
    )

    expect(isOutbound(message)).toBe(false)
    if (isOutbound(message)) return
    expect(message.body).toBe('יש חניה?')
  })
})

describe('read marks', () => {
  it('takes no user id, because the policy decides whose they are', async () => {
    // A parameter here would imply a colleague's marks could be asked for.
    // `conversation_reads` pins `user_id = auth.uid()`.
    const fake = new FakeSupabaseClient({
      responses: {
        conversation_reads: {
          data: [
            {
              conversation_id: 'c-1',
              last_read_at: '2026-09-06T12:00:00.000Z',
            },
          ],
        },
      },
    })

    const marks = await new InboxRepository(fake.asDb()).readMarks(ORG)

    expect(marks.get('c-1')).toEqual(new Date('2026-09-06T12:00:00.000Z'))
    expect(hasFilter(fake.queries[0], 'eq', 'organization_id', ORG)).toBe(true)
  })
})

describe('what has already been adopted', () => {
  it('reports both origin sets so nothing is threaded twice', async () => {
    const fake = new FakeSupabaseClient({
      responses: {
        conversations: {
          data: [
            { site_request_id: 'sr-1', guest_request_id: null },
            { site_request_id: null, guest_request_id: 'gr-1' },
            { site_request_id: null, guest_request_id: null },
          ],
        },
      },
    })

    const adopted = await new InboxRepository(fake.asDb()).adoptedOrigins(ORG)

    expect([...adopted.site]).toEqual(['sr-1'])
    expect([...adopted.guest]).toEqual(['gr-1'])
  })
})

describe('a schema that is not there yet', () => {
  it('names the two codes that mean not provisioned, and nothing else', () => {
    expect(isMissingSchema({ code: '42P01' })).toBe(true)
    expect(isMissingSchema({ code: 'PGRST205' })).toBe(true)
    // A row-level-security refusal must never read as "this feature is not
    // built", which is the most misleading sentence a screen can produce.
    expect(isMissingSchema({ code: '42501' })).toBe(false)
    expect(isMissingSchema(null)).toBe(false)
  })
})
