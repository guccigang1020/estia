import { describe, expect, it } from 'vitest'

import { guestRecord } from './fixtures'
import {
  classify,
  hasStableIdentity,
  indexLedger,
  ledgerEntryFor,
  operationIdempotencyKey,
  planAgainstLedger,
  recordKey,
} from './idempotency'

describe('the identity of a source record', () => {
  it('prefers the identifier the source gave', () => {
    const record = guestRecord(2, { fullName: 'דנה' }, 'HM-ABC123')
    expect(recordKey(record)).toBe('hm-abc123')
    expect(hasStableIdentity(record)).toBe(true)
  })

  it('reads a re-cased identifier as the same record', () => {
    const first = guestRecord(2, { fullName: 'דנה' }, 'HM-ABC')
    const second = guestRecord(2, { fullName: 'דנה' }, 'hm-abc')
    expect(recordKey(first)).toBe(recordKey(second))
  })

  it('falls back to the content digest and says so', () => {
    const record = guestRecord(2, { fullName: 'דנה' })
    expect(recordKey(record)).toBe(record.contentHash)
    expect(hasStableIdentity(record)).toBe(false)
  })
})

describe('classify', () => {
  const original = guestRecord(2, { fullName: 'דנה כהן' }, 'src-1')
  const ledger = indexLedger([
    ledgerEntryFor(original, { estiaId: 'guest-1', sessionId: 'session-0' }),
  ])

  it('calls an identical re-run unchanged', () => {
    expect(classify(original, ledger).state).toBe('unchanged')
  })

  it('calls a changed body corrected rather than new', () => {
    const corrected = guestRecord(2, { fullName: 'דנה כהן-לוי' }, 'src-1')
    const result = classify(corrected, ledger)
    expect(result.state).toBe('corrected')
    expect(result.existing?.estiaId).toBe('guest-1')
  })

  it('calls an unseen record new', () => {
    expect(
      classify(guestRecord(3, { fullName: 'רון' }, 'src-2'), ledger).state,
    ).toBe('new')
  })
})

describe('the key carried into the service pipeline', () => {
  it('is the same across sessions for the same record', () => {
    // Scoped to the record and never to the session, which is what makes the
    // *second import of the same file* replay rather than write.
    const record = guestRecord(2, { fullName: 'דנה' }, 'src-1')
    expect(operationIdempotencyKey(record, 'org-1')).toBe(
      operationIdempotencyKey(record, 'org-1'),
    )
  })

  it('differs when the record was corrected, so the fix is not replayed away', () => {
    const before = guestRecord(2, { fullName: 'דנה כהן' }, 'src-1')
    const after = guestRecord(2, { fullName: 'דנה כהן-לוי' }, 'src-1')
    expect(operationIdempotencyKey(before, 'org-1')).not.toBe(
      operationIdempotencyKey(after, 'org-1'),
    )
  })

  it('differs between organizations holding the same source id', () => {
    const record = guestRecord(2, { fullName: 'דנה' }, 'src-1')
    expect(operationIdempotencyKey(record, 'org-1')).not.toBe(
      operationIdempotencyKey(record, 'org-2'),
    )
  })
})

describe('planAgainstLedger', () => {
  it('splits a file into new, corrected and already imported', () => {
    const kept = guestRecord(2, { fullName: 'דנה' }, 'a')
    const changed = guestRecord(3, { fullName: 'רון לוי' }, 'b')
    const fresh = guestRecord(4, { fullName: 'נועה' }, 'c')

    const plan = planAgainstLedger(
      [kept, changed, fresh],
      [
        ledgerEntryFor(kept, { estiaId: 'g-1', sessionId: 's' }),
        {
          ...ledgerEntryFor(changed, { estiaId: 'g-2', sessionId: 's' }),
          contentHash: 'something-else',
        },
      ],
    )

    expect(plan.unchanged.map((row) => row.rowNumber)).toEqual([2])
    expect(plan.correct.map((row) => row.rowNumber)).toEqual([3])
    expect(plan.create.map((row) => row.rowNumber)).toEqual([4])
  })

  it('counts how many rows have no identifier of their own', () => {
    const plan = planAgainstLedger(
      [
        guestRecord(2, { fullName: 'א' }),
        guestRecord(3, { fullName: 'ב' }, 'src-1'),
      ],
      [],
    )
    expect(plan.withoutStableIdentity).toBe(1)
  })

  it('treats a row the file repeats as already handled', () => {
    const plan = planAgainstLedger(
      [
        guestRecord(2, { fullName: 'דנה' }, 'src-1'),
        guestRecord(9, { fullName: 'דנה' }, 'src-1'),
      ],
      [],
    )
    expect(plan.create).toHaveLength(1)
    expect(plan.unchanged).toHaveLength(1)
  })
})
