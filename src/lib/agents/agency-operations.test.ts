/**
 * The agency write path, through the real service pipeline.
 *
 * Authorization, then validation, then the rule, then the transaction, then the
 * audit event — so what these prove is that the *operation* refuses, not that a
 * function called on its own would have. A domain guard nothing calls is not a
 * guard.
 *
 * The store double models the contract the Supabase implementation is held to,
 * including the parts that are easy to fake away: `deactivate` moves an
 * agreement to `terminated` and touches no commission, `saveTerms` writes the
 * resolver's rule as well as the document, and `loadAgency` refuses an agency
 * this organization has no agreement with. A double that skipped any of the
 * three would let the defects below pass.
 */

import { describe, expect, it } from 'vitest'

import { defineAgencyOperations, toCommissionRule } from './agency-operations'
import type {
  AgencyContactDraft,
  AgencyRecord,
  AgencyStore,
  AgencyTermsTarget,
} from './agency-store'
import { AuthorizationError, type Actor } from '../authz/can'
import type { Grant } from '../authz/permissions'
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../errors'
import { ENTITLEMENTS, type Entitlement } from '../plans/entitlements'
import { InMemoryEventBus, RecordingTransactionRunner } from '../service'
import type { AuditRecord, AuditWriter } from '../audit/pipeline'

const NOW = new Date('2026-09-07T09:00:00.000Z')
const ORG = 'org-a'
const RIVAL = 'org-b'
const OWNER = 'owner-1'
const AGENCY = '11111111-1111-4111-8111-111111111111'
const TODAY = '2026-09-07'

/* ------------------------------------------------------------- the store -- */

type Agreement = {
  id: string
  agencyId: string
  organizationId: string
  status: 'draft' | 'active' | 'terminated'
  rule: unknown
  base: string
  activeFrom: string
  activeUntil: string | null
  paymentTermsDays: number
  note: string | null
  version: number
}

type Rule = {
  id: string
  organizationId: string
  agencyId: string
  rule: unknown
  base: string
  eligibility: readonly string[]
}

type StoreState = {
  agencies: Map<string, AgencyRecord & { deleted: boolean }>
  agreements: Agreement[]
  rules: Rule[]
  /** Untouched by every operation here. Their survival is the point. */
  commissions: { id: string; agencyId: string; amountAgorot: number }[]
}

function contact(over: Partial<AgencyContactDraft> = {}): AgencyContactDraft {
  return {
    name: 'סוכנות הצפון',
    taxId: '515151515',
    contactPhone: '04-8000000',
    contactEmail: 'office@north.example',
    addressLine1: 'הגליל 1',
    city: 'צפת',
    country: 'IL',
    note: null,
    ...over,
  }
}

function agencyRow(over: Partial<AgencyRecord> = {}): AgencyRecord {
  return {
    id: AGENCY,
    ...contact(),
    contactPhoneE164: '+9724800000',
    status: 'active',
    deactivationReason: null,
    version: 3,
    unclaimed: true,
    liveAgreements: 1,
    terminatedAgreements: 0,
    ...over,
  }
}

function agreementRow(over: Partial<Agreement> = {}): Agreement {
  return {
    id: 'agreement-1',
    agencyId: AGENCY,
    organizationId: ORG,
    status: 'active',
    rule: { kind: 'percentage', percent: 10 },
    base: 'stay_total',
    activeFrom: '2026-01-01',
    activeUntil: null,
    paymentTermsDays: 30,
    note: null,
    version: 5,
    ...over,
  }
}

function makeStore(seed: Partial<StoreState> = {}) {
  const state: StoreState = {
    agencies: seed.agencies ?? new Map(),
    agreements: seed.agreements ?? [],
    rules: seed.rules ?? [],
    commissions: seed.commissions ?? [],
  }

  const agreementsFor = (organizationId: string, agencyId: string) =>
    state.agreements.filter(
      (row) =>
        row.organizationId === organizationId && row.agencyId === agencyId,
    )

  const store: AgencyStore = {
    async createAgency(request) {
      const id = `agency-${state.agencies.size + 1}`
      state.agencies.set(id, {
        ...agencyRow({ id, ...request.contact }),
        version: 1,
        liveAgreements: 1,
        terminatedAgreements: 0,
        deleted: false,
      })
      // The agreement, in the same act. Without it `agencies_select` shows the
      // creator nothing — which is the whole reason `create_agency` is one
      // database function and not two writes.
      state.agreements.push(
        agreementRow({
          id: `agreement-for-${id}`,
          agencyId: id,
          organizationId: request.organizationId,
          rule: request.terms.rule,
          base: request.terms.base,
          activeFrom: request.terms.activeFrom,
          paymentTermsDays: request.terms.paymentTermsDays,
          version: 1,
        }),
      )
      return { id }
    },

    async loadAgency(organizationId, agencyId) {
      // The tenant confinement: no agreement, no agency. Same answer as an id
      // that does not exist.
      if (agreementsFor(organizationId, agencyId).length === 0) return null
      const found = state.agencies.get(agencyId)
      if (found === undefined || found.deleted) return null

      const mine = agreementsFor(organizationId, agencyId)
      return {
        ...found,
        liveAgreements: mine.filter((row) => row.status === 'active').length,
        terminatedAgreements: mine.filter((row) => row.status === 'terminated')
          .length,
      }
    },

    async loadTermsTarget(organizationId, agencyId) {
      const agency = await store.loadAgency(organizationId, agencyId)
      if (agency === null) return null
      const mine = agreementsFor(organizationId, agencyId)
      const chosen = mine.find((row) => row.status === 'active') ?? mine[0]
      if (chosen === undefined) return null

      const target: AgencyTermsTarget = {
        agency,
        agreement: {
          id: chosen.id,
          status: chosen.status,
          rule: chosen.rule,
          base: chosen.base as AgencyTermsTarget['agreement']['base'],
          activeFrom: chosen.activeFrom,
          activeUntil: chosen.activeUntil,
          paymentTermsDays: chosen.paymentTermsDays,
          version: chosen.version,
        },
        defaultRuleId:
          state.rules.find(
            (rule) =>
              rule.organizationId === organizationId &&
              rule.agencyId === agencyId,
          )?.id ?? null,
      }
      return target
    },

    async saveContact(request, expectedVersion) {
      const found = state.agencies.get(request.agencyId)
      if (found === undefined || found.version !== expectedVersion) {
        throw new Error('write reached no row')
      }
      const next = {
        ...found,
        ...request.contact,
        version: found.version + 1,
      }
      state.agencies.set(request.agencyId, next)
      return { id: next.id, version: next.version }
    },

    async saveTerms(request, expectedVersion) {
      const agreement = state.agreements.find(
        (row) => row.id === request.agreementId,
      )
      if (agreement === undefined || agreement.version !== expectedVersion) {
        throw new Error('write reached no row')
      }
      agreement.rule = request.rule
      agreement.base = request.base
      agreement.activeFrom = request.activeFrom
      agreement.activeUntil = request.activeUntil
      agreement.paymentTermsDays = request.paymentTermsDays
      agreement.note = request.note
      agreement.version += 1

      // And the row the resolver reads. Writing only the agreement would show
      // a rate beside an agency that earns nothing.
      const existing = state.rules.find(
        (rule) => rule.id === request.existingRuleId,
      )
      if (existing) {
        existing.rule = request.rule
        existing.base = request.base
        existing.eligibility = [...request.eligibility]
        return { agreementId: agreement.id, ruleId: existing.id }
      }

      const id = `rule-${state.rules.length + 1}`
      state.rules.push({
        id,
        organizationId: request.organizationId,
        agencyId: request.agencyId,
        rule: request.rule,
        base: request.base,
        eligibility: [...request.eligibility],
      })
      return { agreementId: agreement.id, ruleId: id }
    },

    async deactivate(request) {
      const mine = agreementsFor(request.organizationId, request.agencyId)
      let ended = 0
      for (const agreement of mine) {
        if (agreement.status !== 'active') continue
        agreement.status = 'terminated'
        agreement.activeUntil = TODAY
        ended += 1
      }

      const othersWork = state.agreements.some(
        (row) =>
          row.agencyId === request.agencyId &&
          row.organizationId !== request.organizationId &&
          row.status !== 'draft',
      )
      const found = state.agencies.get(request.agencyId)
      const unclaimed = found?.unclaimed ?? false
      const marked = !othersWork && unclaimed

      if (marked && found) {
        state.agencies.set(request.agencyId, {
          ...found,
          status: 'inactive',
          deactivationReason: request.reason,
        })
      }

      return { agreementsEnded: ended, entityMarkedInactive: marked }
    },

    async reactivate(request) {
      const ended = agreementsFor(request.organizationId, request.agencyId)
        .filter((row) => row.status === 'terminated')
        .at(-1)
      if (ended === undefined) throw new Error('write reached no row')

      ended.status = 'active'
      ended.activeUntil = null

      const found = state.agencies.get(request.agencyId)
      if (found && found.status === 'inactive') {
        state.agencies.set(request.agencyId, {
          ...found,
          status: 'active',
          deactivationReason: null,
        })
      }

      return { agreementId: ended.id }
    },
  }

  return { store, state }
}

/** One agency with one live agreement, which is the ordinary starting point. */
function seeded(over: { agency?: Partial<AgencyRecord> } = {}) {
  return makeStore({
    agencies: new Map([
      [AGENCY, { ...agencyRow(over.agency), deleted: false }],
    ]),
    agreements: [agreementRow()],
    rules: [
      {
        id: 'rule-existing',
        organizationId: ORG,
        agencyId: AGENCY,
        rule: { kind: 'percentage', percent: 10 },
        base: 'stay_total',
        eligibility: ['stay_completed'],
      },
    ],
    commissions: [
      { id: 'commission-1', agencyId: AGENCY, amountAgorot: 42_000 },
    ],
  })
}

/* ------------------------------------------------------ actors & services -- */

const EVERY_ENTITLEMENT: ReadonlySet<Entitlement> = new Set(ENTITLEMENTS)

function actorWith(grants: Iterable<Grant>, over: Partial<Actor> = {}): Actor {
  return {
    userId: OWNER,
    organizationId: ORG,
    membershipStatus: 'active',
    grants: new Set<Grant>(grants),
    scope: { kind: 'all_organization' },
    entitlements: EVERY_ENTITLEMENT,
    ...over,
  }
}

/** Holds both grants an agency write needs. The happy path's actor. */
const ownerActor = () =>
  actorWith(['agency.manage', 'agent_agreement.manage', 'agent_agreement.view'])

function makeServices() {
  const audit: AuditRecord[] = []
  const writer: AuditWriter = {
    async write(record) {
      audit.push(record)
    },
  }
  return {
    audit,
    services: {
      audit: writer,
      events: new InMemoryEventBus(),
      transactions: new RecordingTransactionRunner(),
    },
  }
}

function context(actor: Actor, reason?: string) {
  return {
    actor,
    auditActor: {
      type: 'user' as const,
      userId: actor.userId,
      label: 'הבעלים',
    },
    correlationId: 'correlation-1',
    now: NOW,
    ...(reason === undefined ? {} : { reason }),
  }
}

const TERMS = {
  rule: { kind: 'percentage' as const, percent: 12 },
  base: 'stay_total' as const,
  eligibility: ['stay_completed'] as const,
  activeFrom: TODAY,
  activeUntil: null,
  paymentTermsDays: 30,
  note: null,
}

/* ---------------------------------------------------------------- create -- */

describe('agency.create', () => {
  it('writes the agency and the agreement that makes it visible', async () => {
    const { store, state } = makeStore()
    const ops = defineAgencyOperations(store)
    const { services, audit } = makeServices()

    const outcome = await ops.create.run({
      request: { input: { ...contact(), ...TERMS } },
      context: context(ownerActor()),
      services,
    })

    expect(state.agencies.size).toBe(1)
    // The agreement, in the same act. An agency without one is a row no policy
    // will show and no role can delete.
    expect(state.agreements).toHaveLength(1)
    expect(state.agreements[0].agencyId).toBe(outcome.data.id)
    expect(state.agreements[0].status).toBe('active')
    expect(audit[0].summary).toContain('12% עמלה')
  })

  it('refuses a caller who may not manage agencies', async () => {
    const { store } = makeStore()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.create.run({
        request: { input: { ...contact(), ...TERMS } },
        context: context(actorWith(['agent_agreement.manage'])),
        services,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError)
  })

  it('refuses agency.manage without the grant that writes the agreement', async () => {
    const { store, state } = makeStore()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    // The refusal names `agent_agreement.manage`, which is the grant somebody
    // running the agency screen should be given — "you cannot create an agency"
    // is not an answer anybody can act on.
    await expect(
      ops.create.run({
        request: { input: { ...contact(), ...TERMS } },
        context: context(actorWith(['agency.manage'])),
        services,
      }),
    ).rejects.toThrow(/agent_agreement\.manage/)
    expect(state.agencies.size).toBe(0)
  })

  it('refuses a percentage rule with no percentage', async () => {
    const { store, state } = makeStore()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.create.run({
        request: {
          input: { ...contact(), ...TERMS, rule: { kind: 'percentage' } },
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
    expect(state.agencies.size).toBe(0)
  })

  it('refuses a rate above the whole booking', async () => {
    const { store } = makeStore()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.create.run({
        request: {
          input: {
            ...contact(),
            ...TERMS,
            rule: { kind: 'percentage', percent: 140 },
          },
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses an agreement that ends before it starts', async () => {
    const { store } = makeStore()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.create.run({
        request: {
          input: {
            ...contact(),
            ...TERMS,
            activeFrom: '2026-09-01',
            activeUntil: '2026-08-01',
          },
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

/* ---------------------------------------------------------- edit contact -- */

describe('agency.edit_contact', () => {
  it('saves the block and moves the version on', async () => {
    const { store, state } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await ops.editContact.run({
      request: {
        input: {
          agencyId: AGENCY,
          ...contact({ name: 'סוכנות הצפון בע״מ', city: 'כרמיאל' }),
        },
        resourceId: AGENCY,
        expectedVersion: 3,
      },
      context: context(ownerActor()),
      services,
    })

    expect(state.agencies.get(AGENCY)?.name).toBe('סוכנות הצפון בע״מ')
    expect(state.agencies.get(AGENCY)?.version).toBe(4)
  })

  it('refuses an agency that has a manager of its own', async () => {
    // `agencies_update` would match zero rows here — and an UPDATE matching
    // zero rows succeeds. Refusing in the domain is what turns the worst
    // failure mode into a sentence the reader can act on.
    const { store, state } = seeded({ agency: { unclaimed: false } })
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.editContact.run({
        request: {
          input: { agencyId: AGENCY, ...contact({ name: 'שם אחר' }) },
          resourceId: AGENCY,
          expectedVersion: 3,
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
    expect(state.agencies.get(AGENCY)?.name).toBe('סוכנות הצפון')
  })

  it('refuses a version somebody else has already moved', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.editContact.run({
        request: {
          input: { agencyId: AGENCY, ...contact() },
          resourceId: AGENCY,
          expectedVersion: 2,
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses an agency this business has no agreement with', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.editContact.run({
        request: {
          input: { agencyId: AGENCY, ...contact() },
          resourceId: AGENCY,
          expectedVersion: 3,
        },
        context: context(
          actorWith(['agency.manage', 'agent_agreement.manage'], {
            organizationId: RIVAL,
          }),
        ),
        services,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('keeps the personal fields out of the append-only audit trail', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services, audit } = makeServices()

    await ops.editContact.run({
      request: {
        input: {
          agencyId: AGENCY,
          ...contact({
            contactEmail: 'new@north.example',
            // Cleared, so the trail has something real to record without
            // recording the address itself.
            addressLine1: null,
          }),
        },
        resourceId: AGENCY,
        expectedVersion: 3,
      },
      context: context(ownerActor()),
      services,
    })

    // `audit_events` is append-only by trigger, so a value written there cannot
    // be erased for a deletion request. The trail records *that* the block
    // changed; the values stay on the row, where they can still be corrected
    // or cleared.
    const written = JSON.stringify(audit[0])
    expect(written).not.toContain('new@north.example')
    expect(written).not.toContain('office@north.example')
    expect(written).not.toContain('הגליל 1')
    expect(written).not.toContain('04-8000000')
    expect(audit[0].after).toMatchObject({ hasAddress: false })
  })
})

/* ------------------------------------------------------------- set terms -- */

describe('agency.set_terms', () => {
  it('writes the document and the rule the resolver reads', async () => {
    const { store, state } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await ops.setTerms.run({
      request: {
        input: {
          agencyId: AGENCY,
          ...TERMS,
          rule: { kind: 'percentage', percent: 8 },
        },
        resourceId: AGENCY,
        expectedVersion: 5,
      },
      context: context(ownerActor(), 'סוכם בשיחה עם מנהל הסוכנות'),
      services,
    })

    expect(state.agreements[0].rule).toEqual({ kind: 'percentage', percent: 8 })
    // Nothing in the product computes money from the agreement's rule. A screen
    // showing 8% beside an agency still earning 10% is worse than showing
    // nothing, so both rows move together or neither does.
    expect(state.rules[0].rule).toEqual({ kind: 'percentage', percent: 8 })
  })

  it('demands a stated reason, because the grant is a sensitive action', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.setTerms.run({
        request: {
          input: { agencyId: AGENCY, ...TERMS },
          resourceId: AGENCY,
          expectedVersion: 5,
        },
        context: context(ownerActor()),
        services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('locks against the agreement version and not the agency version', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    // 3 is the agency's version and 5 is the agreement's. Passing the agency's
    // must not silently succeed — it would let two people overwrite each
    // other's commission rates while the check passed.
    await expect(
      ops.setTerms.run({
        request: {
          input: { agencyId: AGENCY, ...TERMS },
          resourceId: AGENCY,
          expectedVersion: 3,
        },
        context: context(ownerActor(), 'עדכון תנאים'),
        services,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('refuses to rewrite the terms of an agreement that is over', async () => {
    const { store } = makeStore({
      agencies: new Map([[AGENCY, { ...agencyRow(), deleted: false }]]),
      agreements: [agreementRow({ status: 'terminated', version: 6 })],
    })
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.setTerms.run({
        request: {
          input: { agencyId: AGENCY, ...TERMS },
          resourceId: AGENCY,
          expectedVersion: 6,
        },
        context: context(ownerActor(), 'ניסיון לעדכן הסכם שהסתיים'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('refuses a tiered ladder with a hole at the bottom', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.setTerms.run({
        request: {
          input: {
            agencyId: AGENCY,
            ...TERMS,
            rule: {
              kind: 'tiered',
              mode: 'marginal',
              tiers: [{ fromAgorot: 100_000, percent: 10 }],
            },
          },
          resourceId: AGENCY,
          expectedVersion: 5,
        },
        context: context(ownerActor(), 'מדרגות חדשות'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })

  it('stores an empty eligibility list as itself, not as a default', async () => {
    const { store, state } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    // "Eligible as soon as it is created" is a real arrangement — the column
    // defaults to it — and it must be storable. What the *screen* defaults to
    // is a different question, answered in `terms-vocabulary.ts`.
    await ops.setTerms.run({
      request: {
        input: { agencyId: AGENCY, ...TERMS, eligibility: [] },
        resourceId: AGENCY,
        expectedVersion: 5,
      },
      context: context(ownerActor(), 'תשלום מיידי, סוכם בכתב'),
      services,
    })

    expect(state.rules[0].eligibility).toEqual([])
  })
})

/* ------------------------------------------------------------ deactivate -- */

describe('agency.deactivate', () => {
  it('ends the agreement and deletes nothing', async () => {
    const { store, state } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    const outcome = await ops.deactivate.run({
      request: {
        input: { agencyId: AGENCY, reason: 'עברו לעבוד עם מתחרה' },
        resourceId: AGENCY,
      },
      context: context(ownerActor(), 'עברו לעבוד עם מתחרה'),
      services,
    })

    expect(outcome.data.agreementsEnded).toBe(1)
    expect(outcome.data.entityMarkedInactive).toBe(true)
    // Terminated, never removed: the row is still there and still non-draft,
    // which is what keeps the agency visible to this business.
    expect(state.agreements[0].status).toBe('terminated')
    expect(state.agencies.get(AGENCY)?.deleted).toBe(false)
    // And the money it is still owed is untouched.
    expect(state.commissions).toHaveLength(1)
  })

  it("leaves a deactivated agency's commissions able to name their payee", async () => {
    const { store, state } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await ops.deactivate.run({
      request: {
        input: { agencyId: AGENCY, reason: 'הסתיימה ההתקשרות' },
        resourceId: AGENCY,
      },
      context: context(ownerActor(), 'הסתיימה ההתקשרות'),
      services,
    })

    // The read that a statement performs. 0015 wrote
    // `agencies_my_organizations_work_with()` against *non-draft* agreements
    // rather than active ones for exactly this: an agency that stopped selling
    // in March is still owed money on stays happening in August.
    const stillReadable = await store.loadAgency(ORG, AGENCY)
    expect(stillReadable).not.toBeNull()
    expect(stillReadable?.name).toBe('סוכנות הצפון')
    expect(state.commissions[0].amountAgorot).toBe(42_000)
  })

  it('does not mark the entity inactive while another business works with it', async () => {
    const { store, state } = seeded()
    state.agreements.push(
      agreementRow({ id: 'agreement-rival', organizationId: RIVAL }),
    )
    const ops = defineAgencyOperations(store)
    const { services, audit } = makeServices()

    const outcome = await ops.deactivate.run({
      request: {
        input: { agencyId: AGENCY, reason: 'אנחנו מפסיקים, הם ממשיכים' },
        resourceId: AGENCY,
      },
      context: context(ownerActor(), 'אנחנו מפסיקים, הם ממשיכים'),
      services,
    })

    // `agencies.status` is global. One business must not be able to write "this
    // agency is closed" on behalf of a rival that still sells through it.
    expect(outcome.data.entityMarkedInactive).toBe(false)
    expect(state.agencies.get(AGENCY)?.status).toBe('active')
    expect(state.agreements[1].status).toBe('active')
    expect(audit[0].summary).toContain('נותרה פעילה')
  })

  it('refuses a reason too short to be read as one', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await expect(
      ops.deactivate.run({
        request: {
          input: { agencyId: AGENCY, reason: 'סתם' },
          resourceId: AGENCY,
        },
        context: context(ownerActor(), 'סתם'),
        services,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses when there is nothing left to end', async () => {
    const { store } = makeStore({
      agencies: new Map([
        [
          AGENCY,
          {
            ...agencyRow({ status: 'inactive', deactivationReason: 'הראשון' }),
            deleted: false,
          },
        ],
      ]),
      agreements: [agreementRow({ status: 'terminated' })],
    })
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    // The original reason is the record. A second deactivation must not
    // overwrite it with a newer, vaguer one.
    await expect(
      ops.deactivate.run({
        request: {
          input: { agencyId: AGENCY, reason: 'עוד פעם, למה לא' },
          resourceId: AGENCY,
        },
        context: context(ownerActor(), 'עוד פעם, למה לא'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

/* ------------------------------------------------------------ reactivate -- */

describe('agency.reactivate', () => {
  it('reopens the agreement this business ended', async () => {
    const { store, state } = makeStore({
      agencies: new Map([
        [
          AGENCY,
          {
            ...agencyRow({ status: 'inactive', deactivationReason: 'טעות' }),
            deleted: false,
          },
        ],
      ]),
      agreements: [agreementRow({ status: 'terminated', activeUntil: TODAY })],
    })
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    await ops.reactivate.run({
      request: {
        input: { agencyId: AGENCY, reason: 'סומן בטעות על השורה הלא נכונה' },
        resourceId: AGENCY,
      },
      context: context(ownerActor(), 'סומן בטעות על השורה הלא נכונה'),
      services,
    })

    expect(state.agreements[0].status).toBe('active')
    expect(state.agreements[0].activeUntil).toBeNull()
    expect(state.agencies.get(AGENCY)?.status).toBe('active')
    expect(state.agencies.get(AGENCY)?.deactivationReason).toBeNull()
  })

  it('refuses while a live agreement is already in the way', async () => {
    const { store } = seeded()
    const ops = defineAgencyOperations(store)
    const { services } = makeServices()

    // `agency_agreements_live_idx` is unique per (agency, organization) where
    // the status is active. Two would be two commission rules for one sale.
    await expect(
      ops.reactivate.run({
        request: {
          input: { agencyId: AGENCY, reason: 'החזרה מיותרת לתוקף' },
          resourceId: AGENCY,
        },
        context: context(ownerActor(), 'החזרה מיותרת לתוקף'),
        services,
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError)
  })
})

/* ------------------------------------------------------- the rule builder -- */

describe('toCommissionRule', () => {
  it('keeps `none` distinct from zero per cent', () => {
    // A real arrangement — an agency that brings business under some other
    // consideration — and `commission.ts` treats the two differently.
    expect(toCommissionRule({ kind: 'none' })).toEqual({ kind: 'none' })
    expect(toCommissionRule({ kind: 'percentage', percent: 0 })).toEqual({
      kind: 'percentage',
      percent: 0,
    })
  })

  it('refuses a fixed rule whose amount is not whole agorot', () => {
    expect(() =>
      toCommissionRule({ kind: 'fixed', amountAgorot: 52.005 }),
    ).toThrow(BusinessRuleError)
  })

  it('sorts a tiered ladder so the brackets read in order', () => {
    const rule = toCommissionRule({
      kind: 'tiered',
      mode: 'whole',
      tiers: [
        { fromAgorot: 500_000, percent: 12 },
        { fromAgorot: 0, percent: 8 },
      ],
    })

    expect(rule).toEqual({
      kind: 'tiered',
      mode: 'whole',
      tiers: [
        { fromAgorot: 0, percent: 8 },
        { fromAgorot: 500_000, percent: 12 },
      ],
    })
  })
})
