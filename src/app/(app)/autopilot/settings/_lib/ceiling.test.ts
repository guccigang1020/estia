/**
 * The ceiling the customer cannot raise, resolved for display.
 *
 * The claims:
 *
 *   1. The floor ESTIA actually ships — the two blanket rules seeded in 0046 —
 *      caps money, access, cancellation AND business impact at `ask_approval`,
 *      and leaves everything below them alone. Asserted against those exact
 *      two rows rather than against an invented pair, so a change to the
 *      migration's seed shows up here.
 *   2. Where several rules apply, the MOST RESTRICTIVE wins. A ceiling that
 *      took the highest of two caps would not be a ceiling.
 *   3. An unwritten policy row is not `off`. It renders as no selection at
 *      all, because 0046 says a missing row means the level's default — and
 *      drawing `off` would show a business a decision nobody made.
 */

import { describe, expect, it } from 'vitest'

import { AUTOPILOT_ACTIONS } from '@/lib/autopilot/actions'

import type { SafetyRuleView } from '../../_lib/reads'
import { buildMatrix, ceilingFor, cellState } from './ceiling'

/** The two rows 0046 seeds. Transcribed, not invented. */
const SHIPPED_FLOOR: readonly SafetyRuleView[] = [
  {
    id: 'rule-money',
    actionKind: null,
    maxSafetyLevel: 'money_access_cancellation',
    maxDisposition: 'ask_approval',
    reason:
      'Money, guest access and the loss of a booking are never automatic.',
  },
  {
    id: 'rule-business',
    actionKind: null,
    maxSafetyLevel: 'business_impact',
    maxDisposition: 'ask_approval',
    reason: 'Changing a price is a commercial decision.',
  },
]

describe('the shipped floor', () => {
  it('caps a refund at ask_approval and names the rule', () => {
    const resolved = ceilingFor(
      AUTOPILOT_ACTIONS['payment.refund'],
      SHIPPED_FLOOR,
    )
    expect(resolved.maxDisposition).toBe('ask_approval')
    expect(resolved.rule?.id).toBe('rule-money')
  })

  it('caps a price suggestion at ask_approval', () => {
    expect(
      ceilingFor(AUTOPILOT_ACTIONS['price.suggest'], SHIPPED_FLOOR)
        .maxDisposition,
    ).toBe('ask_approval')
  })

  it('leaves an internal task uncapped, and names no rule', () => {
    const resolved = ceilingFor(AUTOPILOT_ACTIONS['task.create'], SHIPPED_FLOOR)
    expect(resolved.maxDisposition).toBe('auto')
    expect(resolved.rule).toBeNull()
  })

  it('leaves an external message uncapped by the platform', () => {
    // External communication is NOT capped by the shipped floor. The customer
    // may set it to auto; the level and the matrix are what hold it back.
    expect(
      ceilingFor(AUTOPILOT_ACTIONS['guest.send_reminder'], SHIPPED_FLOOR)
        .maxDisposition,
    ).toBe('auto')
  })

  it('caps every money, access and business action in the catalogue', () => {
    for (const spec of Object.values(AUTOPILOT_ACTIONS)) {
      const capped =
        spec.safety === 'money_access_cancellation' ||
        spec.safety === 'business_impact'
      expect(ceilingFor(spec, SHIPPED_FLOOR).maxDisposition).toBe(
        capped ? 'ask_approval' : 'auto',
      )
    }
  })
})

describe('several rules', () => {
  it('takes the most restrictive, not the last one read', () => {
    const rules: readonly SafetyRuleView[] = [
      ...SHIPPED_FLOOR,
      {
        id: 'rule-specific',
        actionKind: 'payment.refund',
        maxSafetyLevel: 'money_access_cancellation',
        maxDisposition: 'off',
        reason: 'החזרים אינם מוצעים כלל אצל הלקוח הזה.',
      },
    ]

    const resolved = ceilingFor(AUTOPILOT_ACTIONS['payment.refund'], rules)
    expect(resolved.maxDisposition).toBe('off')
    expect(resolved.rule?.id).toBe('rule-specific')
  })

  it('ignores a kind-specific rule that names a different action', () => {
    const rules: readonly SafetyRuleView[] = [
      {
        id: 'other',
        actionKind: 'booking.cancel',
        maxSafetyLevel: 'money_access_cancellation',
        maxDisposition: 'off',
        reason: '',
      },
    ]
    expect(
      ceilingFor(AUTOPILOT_ACTIONS['task.create'], rules).maxDisposition,
    ).toBe('auto')
  })

  it('applies a blanket rule to every level at or above it', () => {
    const rules: readonly SafetyRuleView[] = [
      {
        id: 'blanket',
        actionKind: null,
        maxSafetyLevel: 'safe_internal',
        maxDisposition: 'suggest',
        reason: '',
      },
    ]
    expect(
      ceilingFor(AUTOPILOT_ACTIONS['task.create'], rules).maxDisposition,
    ).toBe('suggest')
    expect(
      ceilingFor(AUTOPILOT_ACTIONS['payment.refund'], rules).maxDisposition,
    ).toBe('suggest')
    // Below the rule's level, so untouched.
    expect(
      ceilingFor(AUTOPILOT_ACTIONS['brief.compose'], rules).maxDisposition,
    ).toBe('auto')
  })

  it('an empty rule set caps nothing', () => {
    expect(
      ceilingFor(AUTOPILOT_ACTIONS['payment.refund'], []).maxDisposition,
    ).toBe('auto')
  })
})

describe('cellState', () => {
  const capped = ceilingFor(AUTOPILOT_ACTIONS['payment.refund'], SHIPPED_FLOOR)

  it('blocks anything above the ceiling', () => {
    expect(cellState('auto', 'ask_approval', capped)).toBe('blocked')
  })

  it('selects the chosen cell', () => {
    expect(cellState('ask_approval', 'ask_approval', capped)).toBe('selected')
  })

  it('offers everything else at or below the ceiling', () => {
    expect(cellState('suggest', 'ask_approval', capped)).toBe('available')
    expect(cellState('off', 'ask_approval', capped)).toBe('available')
  })

  it('selects nothing when no policy row was written', () => {
    for (const option of ['off', 'suggest', 'ask_approval'] as const) {
      expect(cellState(option, null, capped)).toBe('available')
    }
    expect(cellState('auto', null, capped)).toBe('blocked')
  })
})

describe('buildMatrix', () => {
  const specs = [
    AUTOPILOT_ACTIONS['task.create'],
    AUTOPILOT_ACTIONS['payment.refund'],
  ]

  it('has a row per catalogue action, not per policy row', () => {
    expect(buildMatrix(specs, [], SHIPPED_FLOOR)).toHaveLength(2)
  })

  it('leaves an unwritten cell unchosen', () => {
    const [task] = buildMatrix(specs, [], SHIPPED_FLOOR)
    expect(task.chosen).toBeNull()
  })

  it('reads the organization-wide policy as the choice', () => {
    const matrix = buildMatrix(
      specs,
      [{ actionKind: 'task.create', propertyId: null, disposition: 'auto' }],
      SHIPPED_FLOOR,
    )
    expect(matrix[0].chosen).toBe('auto')
  })

  it('lists the properties that carry their own row, and does not let one hide', () => {
    const matrix = buildMatrix(
      specs,
      [
        { actionKind: 'task.create', propertyId: 'p1', disposition: 'off' },
        { actionKind: 'task.create', propertyId: 'p2', disposition: 'off' },
      ],
      SHIPPED_FLOOR,
    )
    expect(matrix[0].chosen).toBeNull()
    expect(matrix[0].overriddenAt).toEqual(['p1', 'p2'])
  })
})
