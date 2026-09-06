/**
 * The leak tests.
 *
 * Written the way `agents/isolation.test.ts` is written, and for the same
 * reason: what a module *permits* is interesting and what it *refuses* is what
 * a customer is buying. An owner is an outside party with their own accountant
 * and frequently their own competing rental two streets away, so every failure
 * asserted here is a failure with a named human on the other end.
 *
 * Each test goes through the real engine — an actor composed from the real
 * `property_owner` role, `can()` deciding — rather than asserting on a grant
 * set. A grant set proves what was intended; the engine proves what happens.
 */

import { describe, expect, it } from 'vitest'

import {
  assertNoGuestIdentity,
  canReadOwnerStatement,
  isExternalOwner,
  ownerBookingView,
  ownerStatementView,
  ownerStatementViews,
  visibleOwnerships,
} from './visibility'
import { buildOwnerStatement } from './statement'
import {
  ORG,
  OTHER_PROPERTY,
  OWNER_A,
  OWNER_A_USER,
  OWNER_B,
  OWNER_B_USER,
  PROPERTY,
  financeActor,
  ownerActor,
  ownerFor,
  ownershipFor,
  pnlFor,
} from './testing'

function statementFor(
  ownerId: string = OWNER_A,
  propertyId: string = PROPERTY,
  ownerships = [ownershipFor()],
) {
  return buildOwnerStatement({
    id: `statement-${ownerId}-${propertyId}`,
    organizationId: ORG,
    ownerId,
    propertyId,
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    pnl: pnlFor({ propertyId }),
    ownerships,
  })
}

// ── Isolation ─────────────────────────────────────────────────────────────

describe('an owner sees their property and nothing else', () => {
  it('refuses a statement for a property outside their scope', () => {
    const actor = ownerActor(OWNER_A_USER, [PROPERTY])
    const owner = ownerFor()
    const other = statementFor(OWNER_A, OTHER_PROPERTY, [
      ownershipFor({ propertyId: OTHER_PROPERTY }),
    ])

    expect(canReadOwnerStatement(actor, owner, other)).toBe(false)
    expect(ownerStatementView(actor, owner, other)).toBeNull()
  })

  it('refuses a co-owner’s statement for the SAME property', () => {
    // The failure scope alone cannot catch. Both owners are scoped to the same
    // villa and each is entitled to read a statement about it; only one of them
    // is entitled to read *this* one, with its share and its balance on it.
    const ownerships = [
      ownershipFor({ ownerId: OWNER_A, shareBps: 5_000 }),
      ownershipFor({ ownerId: OWNER_B, shareBps: 5_000 }),
    ]
    const actorA = ownerActor(OWNER_A_USER, [PROPERTY])
    const ownerB = ownerFor({ id: OWNER_B, userId: OWNER_B_USER })
    const statementB = statementFor(OWNER_B, PROPERTY, ownerships)

    expect(canReadOwnerStatement(actorA, ownerB, statementB)).toBe(false)
    expect(ownerStatementView(actorA, ownerB, statementB)).toBeNull()
  })

  it('lets an owner read their own', () => {
    const actor = ownerActor(OWNER_A_USER, [PROPERTY])
    const owner = ownerFor()
    const view = ownerStatementView(actor, owner, statementFor())

    expect(view).not.toBeNull()
    expect(view?.ownerId).toBe(OWNER_A)
  })

  it('refuses somebody holding no owner grant at all', () => {
    const cleaner = ownerActor(OWNER_A_USER, [PROPERTY])
    const stripped = { ...cleaner, grants: new Set<never>() }
    expect(canReadOwnerStatement(stripped, ownerFor(), statementFor())).toBe(
      false,
    )
  })

  it('refuses an owner record that has no account behind it', () => {
    // Nobody external can be that owner, so nobody external may read it. The
    // finance manager who issued it still can — see the insider test below.
    const actor = ownerActor(OWNER_A_USER, [PROPERTY])
    const detached = ownerFor({ userId: null })
    expect(canReadOwnerStatement(actor, detached, statementFor())).toBe(false)
  })

  it('lets the insider who issues the documents read them', () => {
    const finance = financeActor()
    expect(isExternalOwner(finance)).toBe(false)
    expect(
      canReadOwnerStatement(
        finance,
        ownerFor({ id: OWNER_B, userId: OWNER_B_USER }),
        statementFor(OWNER_B, PROPERTY, [ownershipFor({ ownerId: OWNER_B })]),
      ),
    ).toBe(true)
  })

  it('filters a list down to the rows the reader may see', () => {
    const ownerships = [
      ownershipFor({ ownerId: OWNER_A, shareBps: 5_000 }),
      ownershipFor({ ownerId: OWNER_B, shareBps: 5_000 }),
    ]
    const actorA = ownerActor(OWNER_A_USER, [PROPERTY])

    const mine = ownerStatementViews(actorA, ownerFor(), [
      statementFor(OWNER_A, PROPERTY, ownerships),
    ])
    const theirs = ownerStatementViews(
      actorA,
      ownerFor({ id: OWNER_B, userId: OWNER_B_USER }),
      [statementFor(OWNER_B, PROPERTY, ownerships)],
    )

    expect(mine).toHaveLength(1)
    expect(theirs).toHaveLength(0)
  })

  it('shows an owner only the properties they hold and reach', () => {
    const actor = ownerActor(OWNER_A_USER, [PROPERTY])
    const visible = visibleOwnerships(actor, ownerFor(), [
      ownershipFor({ propertyId: PROPERTY }),
      ownershipFor({ propertyId: OTHER_PROPERTY }),
      ownershipFor({ ownerId: OWNER_B, propertyId: PROPERTY }),
    ])

    expect(visible.map((link) => link.propertyId)).toEqual([PROPERTY])
  })
})

// ── The guest ─────────────────────────────────────────────────────────────

describe('an owner never sees the guest', () => {
  it('refuses a payload carrying a guest name', () => {
    expect(() =>
      assertNoGuestIdentity(
        { total: 1, stays: [{ nights: 3, guestName: 'דנה כהן' }] },
        'test',
      ),
    ).toThrow(/stays\[0\]\.guestName/)
  })

  it('refuses a telephone number and an email under any key', () => {
    expect(() => assertNoGuestIdentity({ phone: '050-1234567' }, 't')).toThrow(
      /\.phone/,
    )
    expect(() =>
      assertNoGuestIdentity({ note: 'dana@example.com' }, 't'),
    ).toThrow(/email address/)
  })

  it('refuses the agent who sold the night and what they earned', () => {
    expect(() =>
      assertNoGuestIdentity({ agentName: 'רן', agencyId: 'a-1' }, 't'),
    ).toThrow(/agentName/)
    expect(() =>
      assertNoGuestIdentity({ commissionAgorot: 4_200 }, 't'),
    ).toThrow(/commissionAgorot/)
  })

  it('reports every offence at once rather than one per run', () => {
    let message = ''
    try {
      assertNoGuestIdentity({ guestName: 'x', agentName: 'y' }, 't')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('guestName')
    expect(message).toContain('agentName')
  })

  it('survives a cycle instead of hanging on one', () => {
    const node: Record<string, unknown> = { nights: 3 }
    node.self = node
    expect(() => assertNoGuestIdentity(node, 't')).not.toThrow()
  })

  it('passes a real statement, for an owner and for an insider alike', () => {
    const owner = ownerFor()
    const statement = statementFor()

    expect(
      ownerStatementView(
        ownerActor(OWNER_A_USER, [PROPERTY]),
        owner,
        statement,
      ),
    ).not.toBeNull()
    expect(ownerStatementView(financeActor(), owner, statement)).not.toBeNull()
  })

  it('cannot be handed a guest through the occupancy projection', () => {
    const view = ownerBookingView({
      bookingId: 'b-1',
      unitId: 'u-1',
      arrival: '2026-03-10',
      departure: '2026-03-13',
      nights: 3,
      grossRevenueAgorot: 325_000,
      // A caller may hand the widest row they have. None of this survives.
      guestName: 'דנה כהן',
      guestPhone: '050-1234567',
      agentUserId: 'agent-1',
      channel: 'airbnb',
    })

    expect(Object.keys(view).sort()).toEqual([
      'arrival',
      'bookingId',
      'departure',
      'grossRevenueAgorot',
      'nights',
      'unitId',
    ])
    expect(() => assertNoGuestIdentity(view, 'occupancy')).not.toThrow()
  })
})

// ── Commission ────────────────────────────────────────────────────────────

describe('the commission is withheld by default, not by inference', () => {
  it('folds it into the deductions line for a property owner', () => {
    const statement = statementFor()
    const view = ownerStatementView(
      ownerActor(OWNER_A_USER, [PROPERTY]),
      ownerFor(),
      statement,
    )

    expect(view?.salesCommissionAgorot).toBeNull()
    expect(view?.withheld).toContain('sales_commission')
    expect(view?.resultLines.map((line) => line.key)).not.toContain(
      'sales_commission',
    )
    expect(view?.resultLines.map((line) => line.key)).toContain('deductions')
  })

  it('folds rather than subtracts, so the section still adds up', () => {
    const statement = statementFor()
    const view = ownerStatementView(
      ownerActor(OWNER_A_USER, [PROPERTY]),
      ownerFor(),
      statement,
    )!

    const sum = view.resultLines
      .filter((line) => line.kind !== 'result')
      .reduce((total, line) => total + line.amountAgorot, 0)

    expect(sum).toBe(view.propertyOwnerShareAgorot)
    // And the owner is owed exactly what the unredacted document says.
    expect(view.ownerShareAgorot).toBe(statement.ownerShareAgorot)
    expect(view.feesAgorot).toBe(
      statement.feesAgorot + (statement.salesCommissionAgorot ?? 0),
    )
  })

  it('shows it to a reader holding owner.view_commission', () => {
    const statement = statementFor()
    const view = ownerStatementView(financeActor(), ownerFor(), statement)

    expect(view?.salesCommissionAgorot).toBe(statement.salesCommissionAgorot)
    expect(view?.withheld).toHaveLength(0)
    expect(view?.resultLines.map((line) => line.key)).toContain(
      'sales_commission',
    )
  })
})
