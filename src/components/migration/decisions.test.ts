import { describe, expect, it } from 'vitest'

import { CONFLICT_KINDS, CONFLICT_DECISIONS } from '@/lib/migration/types'

import { DECISION_LABEL, OFFERABLE_DECISIONS, optionsFor } from './decisions'

describe('every kind of collision is answerable', () => {
  it('offers at least two options for each one', () => {
    for (const kind of CONFLICT_KINDS) {
      expect(optionsFor(kind).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('never offers the same decision twice on one card', () => {
    for (const kind of CONFLICT_KINDS) {
      const decisions = optionsFor(kind).map((option) => option.decision)
      expect(new Set(decisions).size).toBe(decisions.length)
    }
  })

  it('says what each option will do, not only what it is called', () => {
    for (const kind of CONFLICT_KINDS) {
      for (const option of optionsFor(kind)) {
        expect(option.label.length).toBeGreaterThan(0)
        expect(option.consequence.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('the options are members of the domain vocabulary', () => {
  it('offers nothing outside CONFLICT_DECISIONS', () => {
    for (const kind of CONFLICT_KINDS) {
      for (const option of optionsFor(kind)) {
        expect(CONFLICT_DECISIONS).toContain(option.decision)
      }
    }
  })

  it('never offers "undecided" as a choice a person can make', () => {
    // It is the state every conflict starts in. An option reading "leave it
    // undecided" would let somebody clear the screen without deciding, and the
    // rows would silently not be imported.
    for (const kind of CONFLICT_KINDS) {
      const decisions = optionsFor(kind).map((option) => option.decision)
      expect(decisions).not.toContain('undecided')
    }
    expect(OFFERABLE_DECISIONS).not.toContain('undecided')
  })

  it('labels every decision, including the starting state', () => {
    for (const decision of CONFLICT_DECISIONS) {
      expect(DECISION_LABEL[decision].length).toBeGreaterThan(0)
    }
  })
})

describe('merge is offered where it means something and nowhere else', () => {
  it('offers it for a possible duplicate guest', () => {
    const decisions = optionsFor('guest_merge_candidate').map(
      (option) => option.decision,
    )
    expect(decisions).toContain('merge')
  })

  it('never offers it for an overlapping stay', () => {
    for (const kind of CONFLICT_KINDS) {
      if (kind === 'guest_merge_candidate') continue
      const decisions = optionsFor(kind).map((option) => option.decision)
      expect(decisions).not.toContain('merge')
    }
  })
})

describe('an unknown unit has nothing existing to keep', () => {
  it('does not offer "keep the existing one" when there is none', () => {
    const decisions = optionsFor('unit_mismatch').map(
      (option) => option.decision,
    )
    expect(decisions).not.toContain('keep_existing')
  })
})

describe('every card can refuse the row', () => {
  it('always offers a way to skip it', () => {
    for (const kind of CONFLICT_KINDS) {
      const decisions = optionsFor(kind).map((option) => option.decision)
      expect(decisions).toContain('skip_record')
    }
  })
})
