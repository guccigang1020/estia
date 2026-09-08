import { describe, expect, it } from 'vitest'

import { calmLine, triage, type PanelState, type TriageInput } from './triage'

/** `n` rows. The contents never matter — only how many and whether readable. */
const rows = (n: number): PanelState<unknown> => ({
  ok: true,
  value: Array.from({ length: n }, (_, i) => i),
})

const empty: PanelState<unknown> = { ok: true, value: [] }
const withheld: PanelState<unknown> = { ok: true, value: null }
const failed: PanelState<unknown> = { ok: false }

function input(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    arrivalsUnresolved: empty,
    channelCritical: empty,
    laundryMissing: empty,
    moneyOwed: empty,
    workStuck: empty,
    faultsOpen: empty,
    decisionsWaiting: empty,
    ...overrides,
  }
}

describe('triage — what needs a person', () => {
  it('is silent when every panel was read and is empty', () => {
    const result = triage(input())

    expect(result.total).toBe(0)
    expect(result.first).toBeNull()
    expect(result.unreadable).toBe(0)
  })

  it('counts across every panel, not just the first', () => {
    const result = triage(
      input({ workStuck: rows(3), faultsOpen: rows(2), moneyOwed: rows(1) }),
    )

    expect(result.total).toBe(6)
  })
})

describe('triage — which one first', () => {
  it('puts a guest arriving today above everything else', () => {
    // The only class where the deadline is a person standing at a door.
    const result = triage(
      input({
        arrivalsUnresolved: rows(1),
        channelCritical: rows(9),
        workStuck: rows(40),
      }),
    )

    expect(result.first?.source).toBe('arrival_unresolved')
  })

  it('puts a critical channel failure above money and work', () => {
    // Nobody feels it today, and by the time they do a weekend has been sold
    // at last season's price.
    const result = triage(
      input({
        channelCritical: rows(1),
        moneyOwed: rows(5),
        workStuck: rows(5),
      }),
    )

    expect(result.first?.source).toBe('channel_critical')
  })

  it('puts laundry above money, because the chain can still be broken', () => {
    const result = triage(
      input({ laundryMissing: rows(1), moneyOwed: rows(8) }),
    )

    expect(result.first?.source).toBe('laundry_missing')
  })

  it('offers exactly one action, however many panels have rows', () => {
    // §6, one level up: a strip with three buttons is the ten-button problem
    // it exists to prevent.
    const result = triage(
      input({
        arrivalsUnresolved: rows(2),
        channelCritical: rows(2),
        laundryMissing: rows(2),
        moneyOwed: rows(2),
      }),
    )

    expect(result.first).not.toBeNull()
    expect(result.first?.href).toBe('/bookings')
  })

  it('reads singular and plural as different sentences', () => {
    expect(triage(input({ workStuck: rows(1) })).first?.headline).toBe(
      'משימה תקועה או שעבר זמנה',
    )
    expect(triage(input({ workStuck: rows(4) })).first?.headline).toContain('4')
  })
})

describe('triage — a failed read is never zero', () => {
  it('counts an unreadable panel apart from the total', () => {
    // The rule the whole product is built on, at the place it matters most.
    const result = triage(input({ moneyOwed: failed }))

    expect(result.total).toBe(0)
    expect(result.unreadable).toBe(1)
  })

  it('never lets a failed panel become the first action', () => {
    const result = triage(
      input({ arrivalsUnresolved: failed, workStuck: rows(2) }),
    )

    expect(result.first?.source).toBe('work_stuck')
    expect(result.unreadable).toBe(1)
  })

  it('counts a withheld panel apart from both', () => {
    // "You may not see this" is not "there is nothing here" and is not a
    // failure either. Three states, three numbers.
    const result = triage(input({ moneyOwed: withheld, workStuck: failed }))

    expect(result.total).toBe(0)
    expect(result.withheld).toBe(1)
    expect(result.unreadable).toBe(1)
  })
})

describe('calmLine', () => {
  it('promises a clear morning only when everything was actually read', () => {
    const line = calmLine(triage(input()))

    expect(line).toContain('אין כרגע דבר שדורש אותך')
  })

  it('qualifies the promise when a panel could not be read', () => {
    // "Your morning is clear" and "clear as far as I could see" are different
    // promises, and only one of them is safe to make.
    const line = calmLine(triage(input({ moneyOwed: failed })))

    expect(line).toContain('אינה')
    expect(line).not.toContain('כל הלוחות למטה נקראו')
  })
})
