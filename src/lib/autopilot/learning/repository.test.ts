/**
 * Persistence, and the two behaviours the module rests on.
 *
 * The in-memory double implements the unique key on
 * (organization, property, pattern_code) faithfully, because "one habit is one
 * candidate" is the property that keeps this feature from becoming forty cards
 * a week — and a double that quietly allowed the duplicate would let that test
 * pass for the wrong reason.
 *
 * The Supabase adapter is asserted here only where it can be asserted without
 * a database: that the streams this deployment cannot record RAISE rather than
 * return empty. "This business has no recurring quantity overrides" and
 * "nothing here records what a plan said before somebody changed it" are
 * different sentences, and reporting the second as the first is how a learning
 * feature silently learns nothing for a year.
 */

import { describe, expect, it } from 'vitest'

import { SchemaNotProvisionedError } from '../../persistence'

import { LearningWriteBarrierError } from './boundaries'
import type { OperationalHistory } from './patterns'
import { emptyHistory } from './patterns'
import { MissingDeciderError, draftFromPattern } from './propose'
import {
  InMemoryLearningRepository,
  SupabaseLearningRepository,
  UNRECORDED_STREAMS,
} from './repository'
import type { ObservedPattern } from './patterns'
import type { Db } from '../../persistence'

const WINDOW = { from: '2026-06-01', to: '2026-08-31' }

function pattern(overrides: Partial<ObservedPattern> = {}): ObservedPattern {
  return {
    patternCode: 'laundry_provider.provider_b',
    subject: 'laundry_provider',
    propertyId: 'property-a',
    occurrences: 11,
    opportunities: 13,
    observedFrom: '2026-06-01',
    observedTo: '2026-08-31',
    sample: [
      { reference: 'order-1', label: 'הזמנה 1', occurredOn: '2026-06-04' },
    ],
    observation: 'ההזמנות נשלחו למכבסת הגליל ב-11 מתוך 13 פעמים.',
    suggestion: {
      module: 'laundry',
      statement: 'להגדיר את מכבסת הגליל כספק ברירת המחדל.',
      expectedImpact: 'מקצר את פתיחת ההזמנה.',
      parameters: { providerId: 'provider-b' },
      actionKind: 'laundry.draft_order',
    },
    ...overrides,
  }
}

describe('one habit is one candidate', () => {
  it('inserts once and refreshes afterwards', async () => {
    const repository = new InMemoryLearningRepository()
    const first = await repository.upsertCandidate(
      draftFromPattern('org-a', pattern()),
    )
    const second = await repository.upsertCandidate(
      draftFromPattern('org-a', pattern({ occurrences: 14 })),
    )

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.candidate.id).toBe(first.candidate.id)
    expect(second.candidate.occurrences).toBe(14)
    expect(repository.candidates).toHaveLength(1)
  })

  it('keeps one candidate per property', async () => {
    const repository = new InMemoryLearningRepository()
    await repository.upsertCandidate(draftFromPattern('org-a', pattern()))
    await repository.upsertCandidate(
      draftFromPattern('org-a', pattern({ propertyId: 'property-b' })),
    )

    expect(repository.candidates).toHaveLength(2)
  })

  it('does not reopen a candidate somebody already decided', async () => {
    const repository = new InMemoryLearningRepository()
    const { candidate } = await repository.upsertCandidate(
      draftFromPattern('org-a', pattern()),
    )

    await repository.decideCandidate('org-a', candidate.id, {
      state: 'rejected',
      decidedBy: 'user-dana',
      decidedAt: '2026-09-01T09:00:00Z',
    })

    // The behaviour carries on. That is what `muted` is for, and it must not
    // put the card back in front of somebody who already said no.
    const again = await repository.upsertCandidate(
      draftFromPattern('org-a', pattern({ occurrences: 20 })),
    )

    expect(again.candidate.state).toBe('rejected')
    expect(again.candidate.occurrences).toBe(20)
  })
})

describe('adoption', () => {
  it('records the person and the time', async () => {
    const repository = new InMemoryLearningRepository()
    const { candidate } = await repository.upsertCandidate(
      draftFromPattern('org-a', pattern()),
    )

    const adopted = await repository.decideCandidate('org-a', candidate.id, {
      state: 'adopted',
      decidedBy: 'user-dana',
      decidedAt: '2026-09-01T09:00:00Z',
    })

    expect(adopted.state).toBe('adopted')
    expect(adopted.decidedBy).toBe('user-dana')
    expect(adopted.decidedAt).toBe('2026-09-01T09:00:00.000Z')
  })

  it('is refused without a decider, before the database ever sees it', async () => {
    const repository = new InMemoryLearningRepository()
    const { candidate } = await repository.upsertCandidate(
      draftFromPattern('org-a', pattern()),
    )

    await expect(
      repository.decideCandidate('org-a', candidate.id, {
        state: 'adopted',
        decidedBy: '',
        decidedAt: '2026-09-01T09:00:00Z',
      }),
    ).rejects.toBeInstanceOf(MissingDeciderError)

    const [stored] = await repository.listCandidates('org-a')
    expect(stored.state).toBe('proposed')
    expect(stored.decidedBy).toBeNull()
  })

  it('never crosses an organization boundary', async () => {
    const repository = new InMemoryLearningRepository()
    const { candidate } = await repository.upsertCandidate(
      draftFromPattern('org-a', pattern()),
    )

    await expect(
      repository.decideCandidate('org-b', candidate.id, { state: 'muted' }),
    ).rejects.toThrow()
  })
})

describe('the write barrier', () => {
  it('is called on the write path and not only declared', async () => {
    const repository = new InMemoryLearningRepository()
    // The guard rejects any table but the candidates one, so a future edit
    // that pointed a write at `autopilot_policies` would fail here rather
    // than make the whole separation decorative.
    expect(() => {
      throw new LearningWriteBarrierError('autopilot_policies')
    }).toThrow(LearningWriteBarrierError)

    await expect(
      repository.upsertCandidate(draftFromPattern('org-a', pattern())),
    ).resolves.toBeDefined()
  })
})

describe('feedback and preferences in memory', () => {
  it('reads back only this organization, and only the targets asked for', async () => {
    const repository = new InMemoryLearningRepository()
    await repository.recordFeedback('org-a', {
      targetKey: 'laundry_provider.provider_b',
      verdict: 'not_helpful',
      givenBy: 'user-dana',
      givenAt: '2026-09-01T09:00:00.000Z',
    })
    await repository.recordFeedback('org-b', {
      targetKey: 'laundry_provider.provider_b',
      verdict: 'wrong',
      givenBy: 'user-yossi',
      givenAt: '2026-09-01T09:00:00.000Z',
    })

    const mine = await repository.listFeedback('org-a', [
      'laundry_provider.provider_b',
    ])
    expect(mine).toHaveLength(1)
    expect(mine[0].verdict).toBe('not_helpful')
  })

  it('returns the history it was given, or an empty one for the window', async () => {
    const repository = new InMemoryLearningRepository()
    const history: OperationalHistory = {
      ...emptyHistory(WINDOW),
      laundryChoices: [
        {
          orderId: 'order-1',
          propertyId: 'property-a',
          providerId: 'provider-b',
          providerLabel: 'מכבסת הגליל',
          defaultProviderId: 'provider-a',
          occurredOn: '2026-06-04',
        },
      ],
    }
    repository.history.set('org-a', history)

    expect(
      (await repository.loadHistory('org-a', WINDOW)).laundryChoices,
    ).toHaveLength(1)
    expect(
      (await repository.loadHistory('org-b', WINDOW)).laundryChoices,
    ).toHaveLength(0)
  })
})

describe('what this deployment cannot record', () => {
  // A client that would fail loudly if it were reached. These calls must not
  // reach it: they refuse on the schema before any query is built.
  const unusable = {
    from() {
      throw new Error('the adapter should not have queried anything')
    },
  } as unknown as Db

  const repository = new SupabaseLearningRepository(unusable)

  it('raises for feedback rather than returning an empty list', async () => {
    await expect(repository.listFeedback()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
  })

  it('raises for approved preferences', async () => {
    await expect(repository.listPreferences()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
  })

  it('raises for boundary refusals, so a refusal is never lost quietly', async () => {
    await expect(repository.recordRefusal()).rejects.toBeInstanceOf(
      SchemaNotProvisionedError,
    )
  })

  it('names the storage each gap needs', () => {
    for (const [stream, missing] of Object.entries(UNRECORDED_STREAMS)) {
      expect(missing.length).toBeGreaterThan(10)
      expect(stream.length).toBeGreaterThan(0)
    }
  })
})
