/**
 * The audit pipeline.
 *
 * Two promises are made about the trail: it stores what changed rather than
 * the whole record, and it never stores a secret. Both are only real because
 * every event goes through one function. These tests are what makes that
 * claim checkable.
 */

import { describe, expect, it } from 'vitest'
import type { AuditEventInput } from './events'
import {
  AuditEventInvalidError,
  FailingAuditWriter,
  InMemoryAuditWriter,
  deepScrub,
  recordAuditEvent,
  type AuditRecord,
} from './pipeline'

const OCCURRED = new Date('2026-03-14T09:30:00.000Z')

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor: { type: 'user', userId: 'user-1', label: 'דנה כהן' },
    context: {
      organizationId: 'org-a',
      requestId: 'req-7f2a9c',
      propertyId: 'prop-1',
      ip: '81.218.4.9',
      userAgent: 'Mozilla/5.0',
    },
    action: 'booking.update',
    resourceType: 'booking',
    resourceId: 'bk-1',
    summary: 'דנה שינתה את סכום ההזמנה מ-₪5,200 ל-₪4,700',
    ...overrides,
  }
}

async function record(
  overrides: Partial<AuditEventInput> = {},
): Promise<{ writer: InMemoryAuditWriter; written: AuditRecord }> {
  const writer = new InMemoryAuditWriter()
  const written = await recordAuditEvent(input(overrides), writer, {
    occurredAt: OCCURRED,
  })
  return { writer, written }
}

// ── What lands ────────────────────────────────────────────────────────────

describe('recording an event', () => {
  it('writes one row carrying actor, action, resource, time and correlation id', async () => {
    const { writer, written } = await record()

    expect(writer.records).toHaveLength(1)
    expect(written).toMatchObject({
      organizationId: 'org-a',
      actorUserId: 'user-1',
      actorType: 'user',
      actorLabel: 'דנה כהן',
      action: 'booking.update',
      resourceType: 'booking',
      resourceId: 'bk-1',
      propertyId: 'prop-1',
      requestId: 'req-7f2a9c',
      ip: '81.218.4.9',
      occurredAt: OCCURRED,
    })
  })

  it('keeps the human sentence, not a restatement of the action', async () => {
    const { written } = await record()
    expect(written.summary).toBe('דנה שינתה את סכום ההזמנה מ-₪5,200 ל-₪4,700')
  })

  it('records an AI agent as itself, with the person who approved it', async () => {
    // "The system did it" stops being an acceptable answer as soon as an agent
    // writes copy that customers read.
    const { written } = await record({
      actor: {
        type: 'ai_agent',
        userId: null,
        label: 'Website Studio · Copywriter',
        onBehalfOfUserId: 'user-9',
      },
      action: 'site.ai_generate',
      resourceType: 'site_page',
      summary: 'סוכן הכתיבה יצר כותרת חדשה לעמוד הבית, ושי אישר אותה',
    })

    expect(written.actorType).toBe('ai_agent')
    expect(written.actorUserId).toBeNull()
    expect(written.onBehalfOfUserId).toBe('user-9')
  })
})

// ── Diffing ───────────────────────────────────────────────────────────────

describe('storing the difference', () => {
  it('reduces whole records to the fields that actually changed', async () => {
    const { written } = await record({
      before: {
        totalAgorot: 520000,
        status: 'confirmed',
        guestName: 'רוני לוי',
        unitId: 'u-1',
      },
      after: {
        totalAgorot: 470000,
        status: 'confirmed',
        guestName: 'רוני לוי',
        unitId: 'u-1',
      },
    })

    expect(written.before).toEqual({ totalAgorot: 520000 })
    expect(written.after).toEqual({ totalAgorot: 470000 })
  })

  it('records the whole thing on a creation, where everything is new', async () => {
    const { written } = await record({
      action: 'booking.create',
      before: null,
      after: { totalAgorot: 470000, status: 'confirmed' },
      summary: 'שי יצר הזמנה חדשה בסך ₪4,700',
    })

    expect(written.before).toBeNull()
    expect(written.after).toEqual({ totalAgorot: 470000, status: 'confirmed' })
  })

  it('stores nulls rather than empty objects when nothing changed', async () => {
    const { written } = await record({
      before: { status: 'confirmed' },
      after: { status: 'confirmed' },
    })

    expect(written.before).toBeNull()
    expect(written.after).toBeNull()
  })
})

// ── Scrubbing ─────────────────────────────────────────────────────────────

describe('never storing a secret', () => {
  it('replaces a sensitive value while keeping the fact that it changed', async () => {
    const { written } = await record({
      before: { card_token: 'tok_old', last4: '1234' },
      after: { card_token: 'tok_new', last4: '9876' },
    })

    expect(written.before).toEqual({ card_token: '[redacted]', last4: '1234' })
    expect(written.after).toEqual({ card_token: '[redacted]', last4: '9876' })
    expect(JSON.stringify(written)).not.toContain('tok_new')
  })

  it('reaches a secret nested inside a provider payload', async () => {
    // The log is widely readable inside an organization and is kept for years.
    // A token three levels down outlives every rotation just as surely.
    const { written } = await record({
      before: null,
      after: {
        provider: {
          name: 'tranzila',
          credentials: { api_key: 'sk_live_9912', endpoint: '/x' },
        },
        attempts: [{ token: 'tok_1' }, { token: 'tok_2' }],
      },
      summary: 'שי חיבר ספק סליקה חדש',
    })

    const serialised = JSON.stringify(written)
    expect(serialised).not.toContain('sk_live_9912')
    expect(serialised).not.toContain('tok_1')
    expect(serialised).toContain('tranzila')
  })

  it.each([
    'password',
    'password_hash',
    'token',
    'access_token',
    'refresh_token',
    'secret',
    'api_key',
    'card_token',
    'cvv',
    'signature_data',
  ])('never lets %s through', async (key) => {
    const { written } = await record({
      before: null,
      after: { [key]: 'the-actual-secret-value' },
    })

    expect(JSON.stringify(written)).not.toContain('the-actual-secret-value')
  })

  it('matches the key case-insensitively', () => {
    expect(deepScrub({ API_KEY: 'x', Password: 'y' })).toEqual({
      API_KEY: '[redacted]',
      Password: '[redacted]',
    })
  })

  it('leaves values that are not objects alone', () => {
    const when = new Date('2026-01-01')
    expect(deepScrub(when)).toBe(when)
    expect(deepScrub('plain')).toBe('plain')
    expect(deepScrub(7)).toBe(7)
    expect(deepScrub(null)).toBeNull()
  })
})

// ── Refusals ──────────────────────────────────────────────────────────────

describe('refusing an unusable event', () => {
  const writer = new InMemoryAuditWriter()

  it.each([
    [
      'a blank actor label',
      { actor: { type: 'user' as const, userId: 'u', label: '  ' } },
    ],
    ['a blank action', { action: '   ' }],
    ['a blank resource type', { resourceType: '' }],
    ['a blank summary', { summary: ' ' }],
  ])('refuses %s', async (_name, overrides) => {
    await expect(
      recordAuditEvent(input(overrides as Partial<AuditEventInput>), writer),
    ).rejects.toBeInstanceOf(AuditEventInvalidError)
  })

  it('refuses a summary that only repeats the action', async () => {
    // "booking.update" is not a sentence. The summary column exists precisely
    // to say what the action string does not.
    await expect(
      recordAuditEvent(
        input({ action: 'booking.update', summary: 'booking.update' }),
        writer,
      ),
    ).rejects.toBeInstanceOf(AuditEventInvalidError)
  })

  it('refuses an event with no correlation id', async () => {
    await expect(
      recordAuditEvent(
        input({
          context: { organizationId: 'org-a', requestId: '' },
        }),
        writer,
      ),
    ).rejects.toBeInstanceOf(AuditEventInvalidError)
  })

  it('writes nothing when it refuses', async () => {
    const fresh = new InMemoryAuditWriter()
    await expect(
      recordAuditEvent(input({ summary: '' }), fresh),
    ).rejects.toThrow()
    expect(fresh.records).toHaveLength(0)
  })

  it('reports a refusal as an internal failure, not as the user’s fault', async () => {
    // An event with no summary is a defect in the operation that produced it,
    // not something a person did wrong.
    const error = await recordAuditEvent(input({ summary: '' }), writer).then(
      () => {
        throw new Error('expected the pipeline to refuse this event')
      },
      (thrown: unknown) => thrown as AuditEventInvalidError,
    )

    expect(error.status).toBe(500)
    expect(error.userMessage).not.toContain('summary')
  })
})

describe('a writer that fails', () => {
  it('propagates, so a change cannot commit without its audit row', async () => {
    await expect(
      recordAuditEvent(input(), new FailingAuditWriter()),
    ).rejects.toThrow('audit write failed')
  })
})
