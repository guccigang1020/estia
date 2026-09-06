/**
 * Proposals, and the two promises they make.
 *
 *   · **the ladder is an order** — an inventory shortage is resolved cheapest
 *     first: linen already in a van, then a cupboard on site, then a property
 *     that already owns some, then the reserve, then money, then a person.
 *     A ladder that proposed procurement before checking the van is a system
 *     that spends money it did not need to spend, quietly, every morning.
 *
 *   · **nothing is proposed that the customer cannot do** — every action's
 *     `requires` is checked against the entitlements passed in, and the last
 *     rung requires nothing so the list is never empty.
 */

import { describe, expect, it } from 'vitest'

import { AUTOPILOT_DOMAINS } from '../../contracts/states'
import type { Entitlement } from '../../plans/entitlements'
import { AUTOPILOT_ACTIONS } from '../actions'
import type { Signal } from '../types'

import {
  decide,
  idempotencyKeyFor,
  proposeActions,
  shortageLadder,
  type ProposalContext,
  type ShortageFacts,
} from './propose'

/* ------------------------------------------------------------- fixtures -- */

function signal(over: Partial<Signal> & { dedupeKey: string }): Signal {
  return {
    code: 'test.signal',
    domain: 'preparation',
    risk: 'at_risk',
    resourceType: 'booking',
    resourceId: 'bk-1',
    propertyId: 'prop-1',
    title: 'כותרת',
    detail: 'פירוט',
    evidence: [
      {
        key: 'stock.on_hand',
        label: 'מלאי נוכחי',
        value: 4,
        source: 'inventory',
      },
    ],
    ...over,
  }
}

const SHORTAGE = signal({
  dedupeKey: 'inventory.shortage:towel:prop-1',
  code: 'inventory.shortage',
  domain: 'inventory',
  title: 'חוסר צפוי במגבות',
})

/** Every rung available. Trimmed per test to prove the order. */
const ALL_SOURCES: ShortageFacts = {
  shortfall: 6,
  itemLabel: 'מגבות',
  pendingLaundryOrderId: 'lo-88',
  alternateStorageId: 'st-2',
  transferFromPropertyId: 'prop-2',
  reserveOnHand: 10,
  supplierId: 'sup-1',
}

const FULL_PACKAGE: readonly Entitlement[] = [
  'core',
  'operations',
  'laundry',
  'payments',
  'commerce',
  'agent_network',
  'dynamic_pricing',
  'autopilot',
]

function context(over: Partial<ProposalContext> = {}): ProposalContext {
  return { entitlements: FULL_PACKAGE, trigger: 'evt-1', ...over }
}

function shortageContext(
  facts: Partial<ShortageFacts> = {},
  entitlements: readonly Entitlement[] = FULL_PACKAGE,
): ProposalContext {
  return context({
    entitlements,
    shortages: {
      [SHORTAGE.dedupeKey]: { ...ALL_SOURCES, ...facts },
    },
  })
}

/* ------------------------------------------------------ the ladder ------- */

describe('the shortage resolution ladder', () => {
  it('evaluates the six rungs in order when everything is available', () => {
    const actions = proposeActions(SHORTAGE, shortageContext())

    expect(actions.map((action) => action.kind)).toEqual([
      'laundry.request_earlier',
      'stock_count.request',
      'inventory.suggest_transfer',
      'task.create',
      'procurement.draft',
      'exception.raise',
    ])
  })

  it('skips a rung whose source does not exist', () => {
    const actions = proposeActions(
      SHORTAGE,
      shortageContext({
        pendingLaundryOrderId: null,
        alternateStorageId: null,
        reserveOnHand: 0,
      }),
    )

    expect(actions.map((action) => action.kind)).toEqual([
      'inventory.suggest_transfer',
      'procurement.draft',
      'exception.raise',
    ])
  })

  it('does not draw on a reserve that cannot cover the shortfall', () => {
    const covered = shortageLadder(
      SHORTAGE,
      { ...ALL_SOURCES, reserveOnHand: 6 },
      FULL_PACKAGE,
    )
    const short = shortageLadder(
      SHORTAGE,
      { ...ALL_SOURCES, reserveOnHand: 5 },
      FULL_PACKAGE,
    )

    expect(covered.map((rung) => rung.kind)).toContain('task.create')
    expect(short.map((rung) => rung.kind)).not.toContain('task.create')
  })

  it('tells the truth in the last rung about why nothing was offered', () => {
    // Sources exist; the modules to reach them do not. The closing sentence
    // must not claim no source was found.
    const blocked = shortageLadder(SHORTAGE, ALL_SOURCES, ['core'])
    expect(blocked).toHaveLength(1)
    expect(blocked[0].reason).toContain('המודולים הפעילים')

    const offered = shortageLadder(SHORTAGE, ALL_SOURCES, FULL_PACKAGE)
    expect(offered[offered.length - 1].reason).toContain('שהוצעו')
  })

  it('falls back to manual intervention when nothing else is possible', () => {
    const actions = proposeActions(
      SHORTAGE,
      shortageContext({
        pendingLaundryOrderId: null,
        alternateStorageId: null,
        transferFromPropertyId: null,
        reserveOnHand: 0,
        supplierId: null,
      }),
    )

    expect(actions.map((action) => action.kind)).toEqual(['exception.raise'])
    expect(actions[0].reason).toContain('נדרשת החלטה של אדם')
  })

  it('flags the shortage rather than guessing when no facts were gathered', () => {
    const actions = proposeActions(SHORTAGE, context())

    expect(actions.map((action) => action.kind)).toEqual([
      'inventory.flag_shortage',
    ])
  })

  it('proposes nothing that needs a module the customer lacks', () => {
    // No `laundry`: the van rung disappears and the cupboard becomes the
    // button, rather than the screen offering something that cannot happen.
    const actions = proposeActions(
      SHORTAGE,
      shortageContext({}, ['core', 'operations', 'autopilot']),
    )

    expect(actions.map((action) => action.kind)).toEqual([
      'stock_count.request',
      'inventory.suggest_transfer',
      'task.create',
      'procurement.draft',
      'exception.raise',
    ])
  })

  it('collapses to manual intervention on the barest package', () => {
    const actions = proposeActions(SHORTAGE, shortageContext({}, ['core']))

    expect(actions.map((action) => action.kind)).toEqual(['exception.raise'])
  })
})

/* --------------------------------------------------------- confidence ---- */

describe('confidence on a proposal', () => {
  it('caps a remedy that rests on somebody agreeing at medium', () => {
    const actions = proposeActions(SHORTAGE, shortageContext())
    const byKind = new Map(actions.map((a) => [a.kind, a]))

    expect(byKind.get('laundry.request_earlier')?.confidence).toBe('medium')
    expect(byKind.get('procurement.draft')?.confidence).toBe('medium')
  })

  it('leaves a remedy resting on recorded stock at high', () => {
    const actions = proposeActions(SHORTAGE, shortageContext())
    const byKind = new Map(actions.map((a) => [a.kind, a]))

    expect(byKind.get('inventory.suggest_transfer')?.confidence).toBe('high')
    expect(byKind.get('task.create')?.confidence).toBe('high')
  })

  it('drops every proposal to medium when the evidence is a projection', () => {
    const projected = signal({
      ...SHORTAGE,
      evidence: [
        {
          key: 'stock.projected',
          label: 'מלאי צפוי',
          value: 4,
          source: 'inventory',
        },
      ],
    })

    const actions = proposeActions(
      projected,
      context({ shortages: { [projected.dedupeKey]: ALL_SOURCES } }),
    )

    for (const action of actions) expect(action.confidence).toBe('medium')
  })
})

/* ----------------------------------------------------- idempotency ------- */

describe('idempotencyKey', () => {
  it('is identical across redeliveries of the same triggering event', () => {
    const first = proposeActions(SHORTAGE, shortageContext())
    const second = proposeActions(SHORTAGE, shortageContext())

    expect(first.map((a) => a.idempotencyKey)).toEqual(
      second.map((a) => a.idempotencyKey),
    )
  })

  it('differs for a different trigger, so a new sweep is not suppressed', () => {
    const morning = proposeActions(
      SHORTAGE,
      context({
        trigger: 'sweep-2026-09-06',
        shortages: { [SHORTAGE.dedupeKey]: ALL_SOURCES },
      }),
    )
    const evening = proposeActions(
      SHORTAGE,
      context({
        trigger: 'sweep-2026-09-07',
        shortages: { [SHORTAGE.dedupeKey]: ALL_SOURCES },
      }),
    )

    expect(morning[0].idempotencyKey).not.toBe(evening[0].idempotencyKey)
  })

  it('separates two actions on one problem', () => {
    expect(idempotencyKeyFor(SHORTAGE, 'task.create', 'evt-1')).not.toBe(
      idempotencyKeyFor(SHORTAGE, 'procurement.draft', 'evt-1'),
    )
  })

  it('separates two problems sharing one action kind', () => {
    const other = signal({ dedupeKey: 'inventory.shortage:sheet:prop-1' })

    expect(idempotencyKeyFor(SHORTAGE, 'task.create', 'evt-1')).not.toBe(
      idempotencyKeyFor(other, 'task.create', 'evt-1'),
    )
  })

  it('contains no clock reading', () => {
    expect(idempotencyKeyFor(SHORTAGE, 'task.create', 'evt-1')).toBe(
      `autopilot:${SHORTAGE.dedupeKey}:task.create:evt-1`,
    )
  })
})

/* -------------------------------------------------------- every domain --- */

describe('every domain', () => {
  it('always yields at least one action, on any package', () => {
    for (const domain of AUTOPILOT_DOMAINS) {
      const actions = proposeActions(
        signal({ dedupeKey: `k.${domain}`, domain }),
        context({ entitlements: ['core'] }),
      )
      expect(actions.length).toBeGreaterThan(0)
    }
  })

  it('never names an action the entitlements do not carry', () => {
    const packages: readonly (readonly Entitlement[])[] = [
      ['core'],
      ['core', 'operations'],
      ['core', 'operations', 'laundry'],
      FULL_PACKAGE,
    ]

    for (const entitlements of packages) {
      for (const domain of AUTOPILOT_DOMAINS) {
        const actions = proposeActions(
          signal({ dedupeKey: `k.${domain}`, domain }),
          context({ entitlements }),
        )
        for (const action of actions) {
          const required = AUTOPILOT_ACTIONS[action.kind].requires
          if (required !== null) expect(entitlements).toContain(required)
        }
      }
    }
  })

  it('composes a Hebrew reason for every proposal', () => {
    for (const domain of AUTOPILOT_DOMAINS) {
      const actions = proposeActions(
        signal({ dedupeKey: `k.${domain}`, domain }),
        context(),
      )
      for (const action of actions) {
        expect(action.reason.trim().length).toBeGreaterThan(0)
        expect(action.reason).toMatch(/[\u0590-\u05FF]/)
      }
    }
  })

  it('never repeats an action kind within one decision', () => {
    for (const domain of AUTOPILOT_DOMAINS) {
      const actions = proposeActions(
        signal({ dedupeKey: `k.${domain}`, domain }),
        context(),
      )
      const kinds = actions.map((a) => a.kind)
      expect(new Set(kinds).size).toBe(kinds.length)
    }
  })
})

/* --------------------------------------------------------- the pipeline -- */

describe('decide', () => {
  it('collapses, triages, and numbers the result contiguously', () => {
    const result = decide(
      [
        signal({ dedupeKey: 'opt', domain: 'optimization' }),
        signal({ dedupeKey: 'safety', domain: 'safety' }),
        signal({ dedupeKey: 'safety', domain: 'safety' }),
      ],
      context(),
      { observedAt: '2026-09-06T06:00:00Z' },
    )

    expect(result.collapsed).toBe(1)
    expect(result.decisions.map((d) => d.signal.dedupeKey)).toEqual([
      'safety',
      'opt',
    ])
    expect(result.decisions.map((d) => d.priority)).toEqual([0, 1])
    expect(result.occurrences).toHaveLength(2)
  })

  it('gives every decision at least one proposal', () => {
    const result = decide([SHORTAGE], shortageContext(), {
      observedAt: '2026-09-06T06:00:00Z',
    })

    expect(result.decisions[0].actions.length).toBeGreaterThan(0)
  })
})
