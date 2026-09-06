/**
 * The read layer's three floors, checked one at a time.
 *
 * The claims that matter, in the order they would fail:
 *
 *   1. **The grant is checked before the query is issued.** A reader without
 *      `autopilot.activity_view` produces NO round trip to `autopilot_actions`
 *      — not an empty result. RLS would refuse it anyway; a query that cannot
 *      succeed is a round trip nobody should pay for, and the demo client has
 *      no policy engine to do the refusing.
 *   2. **The scope narrowing reaches the query.** Asserted by reading what the
 *      builder was asked, not by trusting a fake that filters — a filtering
 *      double proves its own correctness and hides the missing `.in()`.
 *   3. **Every row is checked again with `can()`.** The recorder returns rows
 *      the narrowing would have excluded, precisely so the second floor has
 *      something to catch.
 *
 * And two about honesty rather than security: a missing settings row means the
 * migration's defaults and says `configured: false`, and malformed evidence
 * costs a bullet point rather than the screen.
 */

import { describe, expect, it } from 'vitest'

import {
  ALL_AUTOPILOT_GRANTS,
  actionRow,
  exceptionRow,
  makeActor,
  ORGANIZATION,
  PROPERTY_A,
  PROPERTY_B,
  recordingDb,
} from './fixtures'
import {
  DEFAULT_SETTINGS,
  evidenceFrom,
  listActions,
  listExceptions,
  loadSettings,
  type AutopilotReadArgs,
} from './reads'

function args(
  overrides: Partial<AutopilotReadArgs> & { db: AutopilotReadArgs['db'] },
): AutopilotReadArgs {
  return {
    actor: makeActor(),
    organizationId: ORGANIZATION,
    propertyId: null,
    ...overrides,
  }
}

describe('the grant is checked before the query', () => {
  it('issues no read of autopilot_actions without activity_view', async () => {
    const recorder = recordingDb({ autopilot_actions: [actionRow()] })
    const actor = makeActor({
      grants: ALL_AUTOPILOT_GRANTS.filter(
        (grant) => grant !== 'autopilot.activity_view',
      ),
    })

    const rows = await listActions(args({ db: recorder.db, actor }))

    expect(rows).toEqual([])
    expect(recorder.on('autopilot_actions')).toHaveLength(0)
  })

  it('issues no read of autopilot_exceptions without autopilot.view', async () => {
    const recorder = recordingDb({ autopilot_exceptions: [exceptionRow()] })
    const actor = makeActor({
      grants: ALL_AUTOPILOT_GRANTS.filter(
        (grant) => grant !== 'autopilot.view',
      ),
    })

    expect(await listExceptions(args({ db: recorder.db, actor }))).toEqual([])
    expect(recorder.on('autopilot_exceptions')).toHaveLength(0)
  })

  it('reads the exceptions on autopilot.view alone, and the actions on neither', async () => {
    // The whole point of the separation: today's exceptions are not the same
    // authority as every message ESTIA has ever sent.
    const recorder = recordingDb({
      autopilot_exceptions: [exceptionRow()],
      autopilot_actions: [actionRow()],
    })
    const actor = makeActor({ grants: ['autopilot.view'] })

    expect(await listExceptions(args({ db: recorder.db, actor }))).toHaveLength(
      1,
    )
    expect(await listActions(args({ db: recorder.db, actor }))).toEqual([])
  })
})

describe('the scope narrowing reaches the query', () => {
  it('pushes the property list into the read for a property-scoped actor', async () => {
    const recorder = recordingDb({ autopilot_exceptions: [exceptionRow()] })
    const actor = makeActor({
      scope: { kind: 'properties', propertyIds: [PROPERTY_A] },
    })

    await listExceptions(args({ db: recorder.db, actor }))

    const call = recorder.on('autopilot_exceptions')[0]
    expect(call.filters).toContainEqual(['in:property_id', [PROPERTY_A]])
    expect(call.filters).toContainEqual(['eq:organization_id', ORGANIZATION])
  })

  it('issues nothing at all for a scope that reaches no property', async () => {
    const recorder = recordingDb({ autopilot_exceptions: [exceptionRow()] })
    const actor = makeActor({ scope: { kind: 'own_records' } })

    expect(await listExceptions(args({ db: recorder.db, actor }))).toEqual([])
    expect(recorder.on('autopilot_exceptions')).toHaveLength(0)
  })

  it('narrows to the selected property as well as the scope', async () => {
    const recorder = recordingDb({ autopilot_exceptions: [] })

    await listExceptions(args({ db: recorder.db, propertyId: PROPERTY_A }))

    expect(recorder.on('autopilot_exceptions')[0].filters).toContainEqual([
      'eq:property_id',
      PROPERTY_A,
    ])
  })
})

describe('every row is checked again with can()', () => {
  it('drops a row for a property outside the actor’s scope', async () => {
    // The recorder answers whatever it holds, which is what a query built
    // wrong would do. The second floor is what catches it.
    const recorder = recordingDb({
      autopilot_exceptions: [
        exceptionRow({ id: 'mine', property_id: PROPERTY_A }),
        exceptionRow({ id: 'theirs', property_id: PROPERTY_B }),
      ],
    })
    const actor = makeActor({
      scope: { kind: 'properties', propertyIds: [PROPERTY_A] },
    })

    const rows = await listExceptions(args({ db: recorder.db, actor }))

    expect(rows.map((row) => row.id)).toEqual(['mine'])
  })

  it('drops an organization-wide row for a property-scoped reader', async () => {
    // `can.ts`: a resource that carries no location is organization-wide and
    // is only reachable by an organization-wide scope. Narrower than RLS
    // allows, and narrow is the correct direction.
    const recorder = recordingDb({
      autopilot_exceptions: [exceptionRow({ id: 'org', property_id: null })],
    })
    const actor = makeActor({
      scope: { kind: 'properties', propertyIds: [PROPERTY_A] },
    })

    expect(await listExceptions(args({ db: recorder.db, actor }))).toEqual([])
  })

  it('keeps the organization-wide row for an organization-wide reader', async () => {
    const recorder = recordingDb({
      autopilot_exceptions: [exceptionRow({ id: 'org', property_id: null })],
    })

    const rows = await listExceptions(args({ db: recorder.db }))
    expect(rows).toHaveLength(1)
    expect(rows[0].propertyId).toBeNull()
  })
})

describe('names are not asked for without the grant', () => {
  it('reads no property names without property.view', async () => {
    const recorder = recordingDb({
      autopilot_exceptions: [exceptionRow()],
      properties: [{ id: PROPERTY_A, name: 'וילה א' }],
    })
    const actor = makeActor({
      grants: ALL_AUTOPILOT_GRANTS.filter((grant) => grant !== 'property.view'),
    })

    const rows = await listExceptions(args({ db: recorder.db, actor }))

    expect(recorder.on('properties')).toHaveLength(0)
    expect(rows[0].propertyName).toBeNull()
    // The id is not shown in its place — the view keeps them separate fields.
    expect(rows[0].propertyId).toBe(PROPERTY_A)
  })

  it('reads no owner names without user.view', async () => {
    const recorder = recordingDb({
      autopilot_exceptions: [exceptionRow({ owner_user_id: 'user-9' })],
      user_profiles: [{ id: 'user-9', full_name: 'דנה' }],
    })
    const actor = makeActor({
      grants: ALL_AUTOPILOT_GRANTS.filter((grant) => grant !== 'user.view'),
    })

    const rows = await listExceptions(args({ db: recorder.db, actor }))

    expect(recorder.on('user_profiles')).toHaveLength(0)
    expect(rows[0].ownerUserId).toBe('user-9')
    expect(rows[0].ownerName).toBeNull()
  })
})

describe('a stale action kind is a row, not a crash', () => {
  it('renders the raw kind and marks it out of the catalogue', async () => {
    const recorder = recordingDb({
      autopilot_actions: [actionRow({ action_kind: 'ghost.action' })],
    })

    const rows = await listActions(args({ db: recorder.db }))

    expect(rows[0].kind).toBe('ghost.action')
    expect(rows[0].kindLabel).toBe('ghost.action')
    expect(rows[0].inCatalogue).toBe(false)
  })

  it('uses the catalogue label for a kind that is in it', async () => {
    const recorder = recordingDb({ autopilot_actions: [actionRow()] })
    const rows = await listActions(args({ db: recorder.db }))
    expect(rows[0].kindLabel).toBe('תזכורת לאורח')
    expect(rows[0].inCatalogue).toBe(true)
  })
})

describe('a suppression always says something', () => {
  it('keeps the stored text even when it is not in the vocabulary', async () => {
    const recorder = recordingDb({
      autopilot_actions: [
        actionRow({
          outcome: 'suppressed',
          suppressed_reason: 'some_new_diagnostic',
        }),
      ],
    })

    const rows = await listActions(args({ db: recorder.db }))

    expect(rows[0].suppressedReason).toBeNull()
    expect(rows[0].suppressedText).toBe('some_new_diagnostic')
  })

  it('recognises a member of the vocabulary', async () => {
    const recorder = recordingDb({
      autopilot_actions: [
        actionRow({ outcome: 'suppressed', suppressed_reason: 'quiet_hours' }),
      ],
    })

    const rows = await listActions(args({ db: recorder.db }))
    expect(rows[0].suppressedReason).toBe('quiet_hours')
  })
})

describe('a missing settings row means the migration’s defaults', () => {
  it('returns off, simulation, and says it was never configured', async () => {
    const recorder = recordingDb({ autopilot_settings: [] })

    const settings = await loadSettings(args({ db: recorder.db }))

    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings.configured).toBe(false)
    expect(settings.level).toBe('off')
    expect(settings.runMode).toBe('simulation')
  })

  it('marks a real row as configured', async () => {
    const recorder = recordingDb({
      autopilot_settings: [
        {
          level: 'assisted',
          run_mode: 'live',
          simulation_started_at: null,
          enabled: true,
          paused_until: null,
          paused_reason: null,
          preset: 'safe',
          daily_brief_enabled: true,
          daily_brief_at: '07:30',
          evening_summary_enabled: false,
          evening_summary_at: '20:00',
          lookahead_hours: 72,
          updated_at: '2026-09-01T10:00:00Z',
        },
      ],
    })

    const settings = await loadSettings(args({ db: recorder.db }))
    expect(settings.configured).toBe(true)
    expect(settings.level).toBe('assisted')
    expect(settings.runMode).toBe('live')
  })
})

describe('evidence is parsed defensively', () => {
  it('drops an entry with no source rather than inventing one', () => {
    expect(
      evidenceFrom([
        { key: 'a', label: 'א', value: 1, source: 'inventory' },
        { key: 'b', label: 'ב', value: 2 },
      ]),
    ).toEqual([{ key: 'a', label: 'א', value: 1, source: 'inventory' }])
  })

  it('answers empty for anything that is not an array', () => {
    expect(evidenceFrom(null)).toEqual([])
    expect(evidenceFrom({ key: 'a' })).toEqual([])
    expect(evidenceFrom('[]')).toEqual([])
  })

  it('keeps an unusable value as null rather than dropping the fact', () => {
    const [fact] = evidenceFrom([
      { key: 'a', label: 'א', value: { nested: true }, source: 'x' },
    ])
    expect(fact.value).toBeNull()
  })

  it('carries the optional fields through when they are strings', () => {
    const [fact] = evidenceFrom([
      {
        key: 'a',
        label: 'א',
        value: true,
        source: 'payments',
        sourceId: 'payment-1',
        observedAt: '2026-09-06T08:00:00Z',
      },
    ])
    expect(fact.sourceId).toBe('payment-1')
    expect(fact.observedAt).toBe('2026-09-06T08:00:00Z')
  })
})
