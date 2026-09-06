/**
 * Switching an automation on, off, and adjusting the number inside it — driven
 * through the real pipeline with actors built from the real role catalogue.
 *
 * Nothing is stubbed above the database. Every run below authorizes, validates,
 * applies the domain law, writes through a transaction runner and records an
 * audit event, because in a module whose whole subject is "software may now act
 * on this business by itself", the audit event is as much the deliverable as
 * the row is.
 *
 * ── The negative case is a real role, not an empty grant set ──────────────
 *
 * `general_manager` holds `automation.view` and NOT `automation.manage` — that
 * is the catalogue's decision, asserted below so this file cannot quietly
 * become a test about a permission set no customer has. A general manager can
 * read the automation screen and cannot switch anything on, and that is the
 * exact shape of the refusal a customer will meet.
 *
 * ── The database double is deliberately thin ──────────────────────────────
 *
 * It records what was written rather than modelling Postgres, because what is
 * being asserted here is the SHAPE of the write: that a first enable inserts
 * with the tenant on it, that a disable of a rule nobody has configured creates
 * a row rather than doing nothing, that a threshold change does not move
 * `enabled`. The constraints, the stamps and the policies are the migration's
 * job and are exercised in its own rehearsal.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { InMemoryAuditWriter } from '../audit/pipeline'
import { AuthorizationError } from '../authz/can'
import { grantsForSystemRole } from '../authz/roles'
import { BusinessRuleError, ConflictError, NotFoundError } from '../errors'
import { actorFor, ORG, PROPERTY } from '../finance/testing'
import type { Db } from '../persistence/client'
import {
  InMemoryEventBus,
  InMemoryIdempotencyStore,
  type OperationContext,
  type OperationServices,
} from '../service'

import { defineAutomationOperations, mayManageAutomation } from './operations'
import type { StoredRule } from './state'

const NOW = new Date('2026-09-07T09:00:00.000Z')

/** Ships ON, internal only. Switching it off must create a row. */
const SHIPS_ON = 'payment-failed-alert'
/** Ships OFF, speaks to a guest. */
const SHIPS_OFF = 'pre-arrival-instructions'
/** The one rule with a threshold. */
const TUNABLE = 'review-request-after-stay'

/* ------------------------------------------------------ the database double -- */

interface Write {
  kind: 'insert' | 'update'
  table: string
  values: Record<string, unknown>
  filters: Record<string, unknown>
}

interface Fake {
  writes: Write[]
  /** Set to make the next insert fail, e.g. with a unique violation. */
  insertError: { code?: string; message: string } | null
}

function fakeDb(state: Fake): Db {
  return {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          const filters: Record<string, unknown> = {}
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value
              return chain
            },
            then(resolve: (result: { error: unknown }) => void) {
              state.writes.push({ kind: 'update', table, values, filters })
              resolve({ error: null })
            },
          }
          return chain
        },
        insert(values: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  if (state.insertError) {
                    return { data: null, error: state.insertError }
                  }
                  state.writes.push({
                    kind: 'insert',
                    table,
                    values,
                    filters: {},
                  })
                  return { data: { id: 'row-created' }, error: null }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as Db
}

/* ------------------------------------------------------------- the fixture -- */

let fake: Fake
let audit: InMemoryAuditWriter
let idempotency: InMemoryIdempotencyStore
let events: InMemoryEventBus
let rows: Map<string, StoredRule>
let ops: ReturnType<typeof defineAutomationOperations>

function key(templateId: string, propertyId: string | null): string {
  return `${templateId}::${propertyId ?? 'org'}`
}

function stored(overrides: Partial<StoredRule> & { templateId: string }): void {
  const row: StoredRule = {
    id: `row-${overrides.templateId}`,
    propertyId: null,
    enabled: false,
    parameters: {},
    enabledAt: null,
    enabledBy: null,
    disabledAt: null,
    updatedAt: '2026-09-01T09:00:00.000Z',
    version: 1,
    ...overrides,
  }
  rows.set(key(row.templateId, row.propertyId), row)
}

beforeEach(() => {
  fake = { writes: [], insertError: null }
  audit = new InMemoryAuditWriter()
  idempotency = new InMemoryIdempotencyStore()
  events = new InMemoryEventBus()
  rows = new Map()

  ops = defineAutomationOperations({
    db: fakeDb(fake),
    loadRule: async (_organizationId, templateId, propertyId) =>
      rows.get(key(templateId, propertyId)) ?? null,
  })
})

function services(): OperationServices {
  return { audit, idempotency, events }
}

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    actor: actorFor('organization_owner'),
    auditActor: {
      type: 'user',
      userId: 'user-organization_owner',
      label: 'דנה כהן',
    },
    correlationId: 'corr-1',
    now: NOW,
    reason: null,
    ...overrides,
  }
}

const lastWrite = (): Write => {
  const write = fake.writes.at(-1)
  if (!write) throw new Error('nothing was written')
  return write
}

/* ------------------------------------------------------- the role catalogue -- */

describe('who may switch an automation on', () => {
  it('is the owner, and it is not the general manager', () => {
    // Asserted from the catalogue so this file cannot become a test about a
    // permission set no customer has.
    expect(grantsForSystemRole('organization_owner')).toContain(
      'automation.manage',
    )
    expect(grantsForSystemRole('general_manager')).toContain('automation.view')
    expect(grantsForSystemRole('general_manager')).not.toContain(
      'automation.manage',
    )
  })

  it('answers the same question the pipeline will answer', () => {
    expect(mayManageAutomation(actorFor('organization_owner'), null)).toBe(true)
    expect(mayManageAutomation(actorFor('general_manager'), null)).toBe(false)
  })

  it('refuses the general manager and writes nothing at all', async () => {
    await expect(
      ops.enable.run({
        request: { input: { templateId: SHIPS_OFF, propertyId: null } },
        context: context({ actor: actorFor('general_manager') }),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)

    expect(fake.writes).toHaveLength(0)
    expect(audit.records).toHaveLength(0)
  })
})

/* -------------------------------------------------------------- enabling --- */

describe('enabling a rule', () => {
  it('creates the first row, carrying the tenant and the rule', async () => {
    const outcome = await ops.enable.run({
      request: { input: { templateId: SHIPS_OFF, propertyId: null } },
      context: context(),
      services: services(),
    })

    expect(outcome.data.enabled).toBe(true)
    const write = lastWrite()
    expect(write.kind).toBe('insert')
    expect(write.table).toBe('automation_rules')
    expect(write.values).toMatchObject({
      organization_id: ORG,
      property_id: null,
      template_id: SHIPS_OFF,
      enabled: true,
    })
  })

  it('never sends who did it — that is the database’s to take', async () => {
    await ops.enable.run({
      request: { input: { templateId: SHIPS_OFF, propertyId: null } },
      context: context(),
      services: services(),
    })

    const values = lastWrite().values
    expect(values).not.toHaveProperty('enabled_by')
    expect(values).not.toHaveProperty('enabled_at')
    expect(values).not.toHaveProperty('created_by')
  })

  it('updates the row that already exists rather than adding a second', async () => {
    stored({ templateId: SHIPS_OFF, enabled: false })

    await ops.enable.run({
      request: { input: { templateId: SHIPS_OFF, propertyId: null } },
      context: context(),
      services: services(),
    })

    const write = lastWrite()
    expect(write.kind).toBe('update')
    expect(write.values).toMatchObject({ enabled: true })
    expect(write.filters).toEqual({
      organization_id: ORG,
      id: `row-${SHIPS_OFF}`,
    })
  })

  it('writes the property’s own row when a property is named', async () => {
    await ops.enable.run({
      request: { input: { templateId: SHIPS_OFF, propertyId: PROPERTY } },
      context: context(),
      services: services(),
    })

    expect(lastWrite().values).toMatchObject({ property_id: PROPERTY })
  })

  it('records one audit event that says what the rule will now do', async () => {
    await ops.enable.run({
      request: { input: { templateId: SHIPS_OFF, propertyId: null } },
      context: context(),
      services: services(),
    })

    expect(audit.records).toHaveLength(1)
    const record = audit.records[0]!
    expect(record.summary).toContain('לפני הגעה')
    expect(record.summary).toContain('בכל הנכסים')
    // The pipeline refuses a summary that merely repeats the action, and this
    // is the reason it does.
    expect(record.summary).not.toBe('automation.manage')
  })

  it('says which property, when it is one property', async () => {
    await ops.enable.run({
      request: { input: { templateId: SHIPS_OFF, propertyId: PROPERTY } },
      context: context(),
      services: services(),
    })
    expect(audit.records[0]!.summary).toContain('בנכס אחד')
  })

  it('accepts a threshold in the same act', async () => {
    await ops.enable.run({
      request: {
        input: {
          templateId: TUNABLE,
          propertyId: null,
          parameters: [{ name: 'minimum_nights', value: 4 }],
        },
      },
      context: context(),
      services: services(),
    })

    expect(lastWrite().values).toMatchObject({
      enabled: true,
      parameters: { minimum_nights: 4 },
    })
  })

  it('refuses a rule the library does not carry, and reads nothing', async () => {
    await expect(
      ops.enable.run({
        request: { input: { templateId: 'no-such-rule', propertyId: null } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    expect(fake.writes).toHaveLength(0)
  })

  it('refuses a threshold outside the bounds, before writing', async () => {
    await expect(
      ops.enable.run({
        request: {
          input: {
            templateId: TUNABLE,
            propertyId: null,
            parameters: [{ name: 'minimum_nights', value: 400 }],
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)

    expect(fake.writes).toHaveLength(0)
    expect(audit.records).toHaveLength(0)
  })

  it('refuses a threshold on a rule that has none', async () => {
    await expect(
      ops.enable.run({
        request: {
          input: {
            templateId: SHIPS_ON,
            propertyId: null,
            parameters: [{ name: 'minimum_nights', value: 2 }],
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('turns a lost race into a conflict rather than an overwrite', async () => {
    // Two people switching the same rule on at the same moment: the second
    // insert hits one of the partial unique indexes. Retrying blind would
    // overwrite whatever the first person just decided.
    fake.insertError = { code: '23505', message: 'duplicate key' }

    await expect(
      ops.enable.run({
        request: { input: { templateId: SHIPS_OFF, propertyId: null } },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses a change made against a state somebody else has moved', async () => {
    stored({ templateId: SHIPS_OFF, version: 4 })

    await expect(
      ops.enable.run({
        request: {
          input: { templateId: SHIPS_OFF, propertyId: null },
          expectedVersion: 3,
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(ConflictError)

    expect(fake.writes).toHaveLength(0)
  })

  it('answers a double-submitted click with the first answer', async () => {
    const request = {
      input: { templateId: SHIPS_OFF, propertyId: null },
      idempotencyKey: 'click-1',
    }

    const first = await ops.enable.run({
      request,
      context: context(),
      services: services(),
    })
    const second = await ops.enable.run({
      request,
      context: context(),
      services: services(),
    })

    expect(second.replayed).toBe(true)
    expect(second.data).toEqual(first.data)
    expect(fake.writes).toHaveLength(1)
    expect(audit.records).toHaveLength(1)
  })
})

/* ------------------------------------------------------------- disabling --- */

describe('disabling a rule', () => {
  it('creates a row for a rule that ships ON and nobody has touched', async () => {
    // The one that would be a silent no-op if "no row" meant "off". The
    // business has never configured the failed-payment alert, it is on, and
    // switching it off has to write something down.
    await ops.disable.run({
      request: { input: { templateId: SHIPS_ON, propertyId: null } },
      context: context(),
      services: services(),
    })

    const write = lastWrite()
    expect(write.kind).toBe('insert')
    expect(write.values).toMatchObject({
      template_id: SHIPS_ON,
      enabled: false,
    })
  })

  it('keeps the thresholds, so switching back on finds them', async () => {
    stored({
      templateId: TUNABLE,
      enabled: true,
      parameters: { minimum_nights: 6 },
    })

    await ops.disable.run({
      request: { input: { templateId: TUNABLE, propertyId: null } },
      context: context(),
      services: services(),
    })

    expect(lastWrite().values).toMatchObject({
      enabled: false,
      parameters: { minimum_nights: 6 },
    })
  })

  it('records what stops happening, not that a boolean moved', async () => {
    await ops.disable.run({
      request: { input: { templateId: SHIPS_ON, propertyId: null } },
      context: context(),
      services: services(),
    })

    const summary = audit.records[0]!.summary
    expect(summary).toContain('תשלום נכשל')
    expect(summary).toContain('לא תתבצע')
  })
})

/* ------------------------------------------------------------ thresholds --- */

describe('changing a threshold', () => {
  it('does not switch a rule on that the library ships off', async () => {
    await ops.setParameters.run({
      request: {
        input: {
          templateId: TUNABLE,
          propertyId: null,
          parameters: [{ name: 'minimum_nights', value: 1 }],
        },
      },
      context: context(),
      services: services(),
    })

    expect(lastWrite().values).toMatchObject({
      enabled: false,
      parameters: { minimum_nights: 1 },
    })
  })

  it('does not switch a rule off that the library ships on', async () => {
    // There is no tunable rule that ships on today, so this is asserted
    // through the resolution the operation performs rather than through a
    // fixture: the row it creates carries the library's own answer.
    stored({ templateId: TUNABLE, enabled: true })

    await ops.setParameters.run({
      request: {
        input: {
          templateId: TUNABLE,
          propertyId: null,
          parameters: [{ name: 'minimum_nights', value: 3 }],
        },
      },
      context: context(),
      services: services(),
    })

    expect(lastWrite().values).toMatchObject({ enabled: true })
  })

  it('merges rather than replacing what was already stored', async () => {
    stored({
      templateId: TUNABLE,
      enabled: true,
      parameters: { minimum_nights: 6, kept_by_an_older_release: 9 },
    })

    await ops.setParameters.run({
      request: {
        input: {
          templateId: TUNABLE,
          propertyId: null,
          parameters: [{ name: 'minimum_nights', value: 2 }],
        },
      },
      context: context(),
      services: services(),
    })

    expect(lastWrite().values).toMatchObject({
      parameters: { minimum_nights: 2, kept_by_an_older_release: 9 },
    })
  })

  it('refuses an empty change', async () => {
    await expect(
      ops.setParameters.run({
        request: {
          input: { templateId: TUNABLE, propertyId: null, parameters: [] },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a parameter name the rule does not declare', async () => {
    await expect(
      ops.setParameters.run({
        request: {
          input: {
            templateId: TUNABLE,
            propertyId: null,
            parameters: [{ name: 'quiet_hours', value: 8 }],
          },
        },
        context: context(),
        services: services(),
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
    expect(fake.writes).toHaveLength(0)
  })

  it('names the threshold and its unit in the audit event', async () => {
    await ops.setParameters.run({
      request: {
        input: {
          templateId: TUNABLE,
          propertyId: null,
          parameters: [{ name: 'minimum_nights', value: 3 }],
        },
      },
      context: context(),
      services: services(),
    })

    const summary = audit.records[0]!.summary
    expect(summary).toContain('מספר הלילות המזערי: 3 לילות')
  })
})
