import { describe, expect, it } from 'vitest'

import { FakeSupabaseClient } from '../persistence/fake-client'
import { SupabaseMigrationRepository } from './repository'

type Responses = NonNullable<
  ConstructorParameters<typeof FakeSupabaseClient>[0]
>['responses']

function repositoryWith(responses: Responses) {
  const client = new FakeSupabaseClient({ responses })
  return { client, repository: new SupabaseMigrationRepository(client.asDb()) }
}

const SESSION_ROW = {
  id: 'session-1',
  organization_id: 'org-1',
  status: 'draft',
  entity: 'bookings',
  source_format: 'csv',
  file_name: 'bookings.csv',
  file_hash: 'abc',
  row_count: 1847,
  mappings: [{ column: 'Guest', field: 'guestName' }],
  created_at: '2026-09-06T09:00:00.000Z',
  created_by: 'user-1',
  updated_at: '2026-09-06T09:00:00.000Z',
  completed_at: null,
}

describe('every read is scoped by the tenant', () => {
  it('narrows the ledger by organization and by entity', async () => {
    const { client, repository } = repositoryWith({
      'import_records:select': { data: [] },
    })

    await repository.loadLedger('org-1', 'bookings')

    const filters = client.queriesFor('import_records')[0]?.filters ?? []
    expect(filters).toContainEqual({
      op: 'eq',
      column: 'organization_id',
      value: 'org-1',
    })
    // Scoped by entity too: a source that numbers guests and bookings from 1
    // would otherwise read booking 7 as guest 7 and silently skip it.
    expect(filters).toContainEqual({
      op: 'eq',
      column: 'entity',
      value: 'bookings',
    })
  })

  it('narrows a session read by organization as well as by id', async () => {
    const { client, repository } = repositoryWith({
      'import_sessions:select': { data: SESSION_ROW },
    })

    await repository.loadSession('org-1', 'session-1')

    const filters = client.queriesFor('import_sessions')[0]?.filters ?? []
    expect(filters).toContainEqual({
      op: 'eq',
      column: 'organization_id',
      value: 'org-1',
    })
  })
})

describe('mapping a session row', () => {
  it('reads the columns the schema actually holds', async () => {
    const { repository } = repositoryWith({
      'import_sessions:select': { data: SESSION_ROW },
    })

    const session = await repository.loadSession('org-1', 'session-1')

    expect(session).toEqual({
      id: 'session-1',
      organizationId: 'org-1',
      status: 'draft',
      entity: 'bookings',
      sourceFormat: 'csv',
      fileName: 'bookings.csv',
      fileHash: 'abc',
      rowCount: 1847,
      mappings: [{ column: 'Guest', field: 'guestName' }],
      createdAt: '2026-09-06T09:00:00.000Z',
      createdByUserId: 'user-1',
      updatedAt: '2026-09-06T09:00:00.000Z',
      completedAt: null,
    })
  })

  it('refuses a stored value this build does not know', async () => {
    // A migration ahead of the code. Failing loudly beats a string travelling
    // into a screen where every `switch` ignores it.
    const { repository } = repositoryWith({
      'import_sessions:select': {
        data: { ...SESSION_ROW, status: 'teleported' },
      },
    })

    await expect(repository.loadSession('org-1', 'session-1')).rejects.toThrow(
      /Unknown import session status/,
    )
  })

  it('drops a malformed saved mapping rather than locking the session', async () => {
    const { repository } = repositoryWith({
      'import_sessions:select': {
        data: {
          ...SESSION_ROW,
          mappings: [
            { column: 'Guest', field: 'guestName' },
            { column: 'X', field: 'not-a-field' },
            'rubbish',
          ],
        },
      },
    })

    const session = await repository.loadSession('org-1', 'session-1')
    expect(session?.mappings).toEqual([
      { column: 'Guest', field: 'guestName' },
      { column: 'X', field: null },
    ])
  })
})

describe('writing the ledger', () => {
  it('upserts on the identity, so a resumed run rewrites its own rows', async () => {
    const { client, repository } = repositoryWith({
      'import_records:upsert': { data: null },
    })

    await repository.recordImported('org-1', [
      {
        entity: 'bookings',
        recordKey: 'HM-1',
        contentHash: 'h1',
        estiaId: 'b-1',
        sessionId: 'session-1',
        rowNumber: 2,
        outcome: 'created',
        message: null,
      },
    ])

    const query = client.queriesFor('import_records')[0]
    expect(query?.verb).toBe('upsert')
    expect(query?.options).toEqual({
      onConflict: 'organization_id,entity,record_key',
    })
  })

  it('writes nothing at all for an empty batch', async () => {
    const { client, repository } = repositoryWith({})
    await repository.recordImported('org-1', [])
    expect(client.queriesFor('import_records')).toHaveLength(0)
  })
})

describe('decisions carry the person who made them', () => {
  it('writes decided_by and decided_at, never only the decision', async () => {
    const { client, repository } = repositoryWith({
      'import_conflicts:update': { data: null },
    })

    await repository.decideConflict('org-1', 'c-1', 'import_anyway', 'user-1')

    const payload = client.queriesFor('import_conflicts')[0]?.payload as Record<
      string,
      unknown
    >
    expect(payload.decision).toBe('import_anyway')
    expect(payload.decided_by).toBe('user-1')
    expect(typeof payload.decided_at).toBe('string')
  })
})
