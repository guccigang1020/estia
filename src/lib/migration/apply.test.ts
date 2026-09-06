import { describe, expect, it } from 'vitest'

import { applyImport, type ApplyProgress } from './apply'
import type { CommandContext, ImportCommands, ResolvedUnit } from './commands'
import type { ExistingCalendar } from './conflicts'
import { actorWith, auditActor, bookingRecord, guestRecord } from './fixtures'
import { ledgerEntryFor, type LedgerEntry } from './idempotency'
import { EventQuarantine } from './quarantine'
import type { ImportRecord } from './types'

const UNIT = {
  id: 'unit-1',
  name: 'וילה הגלבוע',
  propertyId: 'prop-1',
  propertyName: 'הגלבוע',
}

const CALENDAR: ExistingCalendar = {
  units: [UNIT],
  bookings: [],
  blocks: [],
}

const CONTEXT: Omit<CommandContext, 'historic'> = {
  actor: actorWith(['booking.create', 'guest.create', 'property.create']),
  auditActor,
  correlationId: 'req-1',
  now: new Date('2026-09-06T09:00:00.000Z'),
}

/**
 * Commands that count what they were asked to do.
 *
 * The keys the real commands derive are exercised in `commands.test.ts`; here
 * the question is what the apply loop *asks for*, which is a different one and
 * is the one idempotency is decided by.
 */
class CountingCommands implements ImportCommands {
  readonly guests: ImportRecord[] = []
  readonly bookings: ImportRecord[] = []
  readonly properties: ImportRecord[] = []
  /** Rows that should blow up, to prove one failure does not stop the run. */
  failOn = new Set<number>()
  private sequence = 0

  async createGuest(record: ImportRecord, _context?: CommandContext) {
    if (this.failOn.has(record.rowNumber)) throw new Error('insert refused')
    this.guests.push(record)
    this.sequence += 1
    return { id: `guest-${this.sequence}`, replayed: false }
  }
  async createBooking(
    record: ImportRecord,
    _context: CommandContext,
    _unit: ResolvedUnit,
  ) {
    if (this.failOn.has(record.rowNumber)) throw new Error('insert refused')
    this.bookings.push(record)
    this.sequence += 1
    return { id: `booking-${this.sequence}`, replayed: false }
  }
  async createProperty(record: ImportRecord, _context?: CommandContext) {
    this.properties.push(record)
    this.sequence += 1
    return { id: `property-${this.sequence}`, replayed: false }
  }
}

function run(args: {
  records: readonly ImportRecord[]
  commands: ImportCommands
  ledger?: readonly LedgerEntry[]
  resumeFrom?: ApplyProgress
  today?: string
  batchSize?: number
  onProgress?: (progress: ApplyProgress) => Promise<void>
  shouldStop?: () => boolean
}) {
  return applyImport({
    sessionId: 'session-1',
    records: args.records,
    commands: args.commands,
    quarantine: new EventQuarantine(),
    calendar: CALENDAR,
    ledger: args.ledger ?? [],
    resumeFrom: args.resumeFrom,
    context: CONTEXT,
    today: args.today ?? '2026-09-06',
    startedAt: '2026-09-06T09:00:00.000Z',
    batchSize: args.batchSize,
    onProgress: args.onProgress,
    shouldStop: args.shouldStop,
  })
}

describe('the same file imported twice', () => {
  it('creates nothing the second time', async () => {
    const records = [
      guestRecord(2, { fullName: 'דנה כהן' }, 'src-1'),
      guestRecord(3, { fullName: 'רון לוי' }, 'src-2'),
    ]
    const commands = new CountingCommands()

    const first = await run({ records, commands })
    expect(commands.guests).toHaveLength(2)
    expect(first.results.every((result) => result.outcome === 'created')).toBe(
      true,
    )

    // The ledger the first run produced, exactly as `repository.ts` would have
    // stored it.
    const ledger = records.map((record, index) =>
      ledgerEntryFor(record, {
        estiaId: `guest-${index + 1}`,
        sessionId: 'session-1',
      }),
    )

    const second = await run({ records, commands, ledger })

    expect(commands.guests).toHaveLength(2)
    expect(
      second.results.every((result) => result.outcome === 'skipped_unchanged'),
    ).toBe(true)
  })

  it('creates nothing the second time even with no source identifiers', async () => {
    // The digest is then the identity. A file with no id column is the common
    // case for a villa owner's spreadsheet and must still be safe to re-run.
    const records = [guestRecord(2, { fullName: 'דנה כהן', city: 'חיפה' })]
    const commands = new CountingCommands()

    await run({ records, commands })
    const ledger = [
      ledgerEntryFor(records[0] ?? guestRecord(2, { fullName: 'x' }), {
        estiaId: 'guest-1',
        sessionId: 'session-1',
      }),
    ]
    await run({ records, commands, ledger })

    expect(commands.guests).toHaveLength(1)
  })

  it('does not duplicate a row the file itself repeats', async () => {
    const commands = new CountingCommands()
    const once = guestRecord(2, { fullName: 'דנה כהן' }, 'src-1')
    const again = guestRecord(9, { fullName: 'דנה כהן' }, 'src-1')

    const report = await run({ records: [once, again], commands })

    expect(commands.guests).toHaveLength(1)
    expect(report.results[1]?.outcome).toBe('skipped_unchanged')
  })
})

describe('a corrected file updates rather than duplicating', () => {
  it('refuses to create a second record and says a person must update it', async () => {
    const original = guestRecord(2, { fullName: 'דנה כהן' }, 'src-1')
    const corrected = guestRecord(2, { fullName: 'דנה כהן-לוי' }, 'src-1')
    const commands = new CountingCommands()

    const report = await run({
      records: [corrected],
      commands,
      ledger: [
        ledgerEntryFor(original, {
          estiaId: 'guest-1',
          sessionId: 'session-0',
        }),
      ],
    })

    // The one thing that must never happen: a second guest card.
    expect(commands.guests).toHaveLength(0)
    expect(report.results[0]?.outcome).toBe('needs_manual_update')
    expect(report.results[0]?.createdId).toBe('guest-1')
  })

  it('uses the update command when one is wired', async () => {
    const original = guestRecord(2, { fullName: 'דנה כהן' }, 'src-1')
    const corrected = guestRecord(2, { fullName: 'דנה כהן-לוי' }, 'src-1')

    const updated: string[] = []
    const base = new CountingCommands()
    const commands: ImportCommands = {
      createGuest: (record, context) => base.createGuest(record, context),
      createBooking: (record, context, unit) =>
        base.createBooking(record, context, unit),
      createProperty: (record, context) => base.createProperty(record, context),
      async updateGuest(_record, estiaId) {
        updated.push(estiaId)
        return { id: estiaId, replayed: false }
      },
    }

    const report = await run({
      records: [corrected],
      commands,
      ledger: [
        ledgerEntryFor(original, {
          estiaId: 'guest-1',
          sessionId: 'session-0',
        }),
      ],
    })

    expect(updated).toEqual(['guest-1'])
    expect(report.results[0]?.outcome).toBe('updated')
  })
})

describe('one bad row does not stop the run', () => {
  it('records the failure and keeps going', async () => {
    const commands = new CountingCommands()
    commands.failOn.add(3)

    const report = await run({
      records: [
        guestRecord(2, { fullName: 'א' }, 'a'),
        guestRecord(3, { fullName: 'ב' }, 'b'),
        guestRecord(4, { fullName: 'ג' }, 'c'),
      ],
      commands,
    })

    expect(commands.guests).toHaveLength(2)
    expect(report.results.map((result) => result.outcome)).toEqual([
      'created',
      'failed',
      'created',
    ])
    expect(report.results[1]?.message).toBe('insert refused')
  })

  it('fails a booking whose unit cannot be resolved rather than guessing', async () => {
    const commands = new CountingCommands()

    const report = await run({
      records: [
        bookingRecord(2, {
          guestName: 'דנה',
          unitName: 'וילה שלא קיימת',
          checkIn: '2023-01-01',
          checkOut: '2023-01-04',
        }),
      ],
      commands,
    })

    expect(commands.bookings).toHaveLength(0)
    expect(report.results[0]?.outcome).toBe('failed')
    expect(report.results[0]?.message).toContain('וילה שלא קיימת')
  })
})

describe('interrupted is not lost', () => {
  it('reports progress after each batch', async () => {
    const commands = new CountingCommands()
    const snapshots: number[] = []

    await run({
      records: [2, 3, 4, 5, 6].map((row) =>
        guestRecord(row, { fullName: `אורח ${row}` }, `src-${row}`),
      ),
      commands,
      batchSize: 2,
      onProgress: async (progress) => {
        snapshots.push(progress.results.length)
      },
    })

    expect(snapshots).toEqual([2, 4, 5])
  })

  it('resumes from the row after the last one confirmed', async () => {
    const records = [2, 3, 4].map((row) =>
      guestRecord(row, { fullName: `אורח ${row}` }, `src-${row}`),
    )
    const commands = new CountingCommands()

    const stopAfterFirst = await run({
      records,
      commands,
      batchSize: 1,
      shouldStop: () => commands.guests.length >= 1,
    })

    expect(stopAfterFirst.interrupted).toBe(true)
    expect(commands.guests).toHaveLength(1)

    const finished = await run({
      records,
      commands,
      resumeFrom: {
        results: stopAfterFirst.results,
        ledger: [
          ledgerEntryFor(records[0] ?? guestRecord(2, { fullName: 'x' }), {
            estiaId: 'guest-1',
            sessionId: 'session-1',
          }),
        ],
      },
    })

    expect(commands.guests).toHaveLength(3)
    expect(finished.interrupted).toBe(false)
    expect(finished.results).toHaveLength(3)
  })
})

describe('the completion report', () => {
  it('traces every outcome back to its source row', async () => {
    const commands = new CountingCommands()
    commands.failOn.add(3)

    const report = await run({
      records: [
        guestRecord(2, { fullName: 'א' }, 'a'),
        guestRecord(3, { fullName: 'ב' }, 'b'),
      ],
      commands,
    })

    expect(report.results.map((result) => result.rowNumber)).toEqual([2, 3])
    expect(report.byEntity[0]?.entity).toBe('guests')
    expect(report.byEntity[0]?.valid).toBe(1)
    expect(report.byEntity[0]?.invalid).toBe(1)
  })
})
