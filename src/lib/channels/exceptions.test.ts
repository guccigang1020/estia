import { describe, expect, it } from 'vitest'

import { PERMISSIONS, FIELD_PERMISSIONS } from '../authz/permissions'

import {
  EXCEPTION_PLAYBOOK,
  bySeverityThenAge,
  draftException,
  exceptionDedupeKey,
  playbookFor,
  tallyExceptions,
} from './exceptions'
import {
  CHANNEL_EXCEPTION_KINDS,
  EXCEPTION_SEVERITIES,
  type ChannelException,
} from './types'

const NOW = new Date('2026-02-01T10:00:00Z')

describe('the playbook', () => {
  it('gives every exception kind a resolution path', () => {
    // An exception with no resolution path is a notification with extra steps.
    for (const kind of CHANNEL_EXCEPTION_KINDS) {
      const playbook = playbookFor(kind)
      expect(playbook.steps.length, kind).toBeGreaterThan(0)
      expect(playbook.label.length, kind).toBeGreaterThan(0)
      expect(EXCEPTION_SEVERITIES).toContain(playbook.severity)
    }
  })

  it('names a grant that exists in the catalogue', () => {
    const known = new Set<string>([...PERMISSIONS, ...FIELD_PERMISSIONS])
    for (const playbook of Object.values(EXCEPTION_PLAYBOOK)) {
      expect(known.has(playbook.requires), playbook.requires).toBe(true)
    }
  })

  it('reserves critical for the kinds that cost a bed or a booking', () => {
    const critical = CHANNEL_EXCEPTION_KINDS.filter(
      (kind) => EXCEPTION_PLAYBOOK[kind].severity === 'critical',
    )

    expect([...critical].sort()).toEqual([
      'cancellation_conflict',
      'invalid_reservation',
      'mapping_missing',
      'modification_conflict',
    ])
  })

  it('offers a retry only where re-running can actually work', () => {
    expect(EXCEPTION_PLAYBOOK.mapping_missing.retryable).toBe(true)
    // Nothing about re-running resolves a disagreement between two humans.
    expect(EXCEPTION_PLAYBOOK.modification_conflict.retryable).toBe(false)
  })
})

describe('dedupe keys', () => {
  it('collapse one problem into one row', () => {
    expect(exceptionDedupeKey('mapping_missing', 'airbnb', 'AB-1')).toBe(
      'mapping_missing:airbnb:AB-1',
    )
  })

  it('separate the same subject on two channels', () => {
    expect(exceptionDedupeKey('mapping_missing', 'airbnb', 'X')).not.toBe(
      exceptionDedupeKey('mapping_missing', 'expedia', 'X'),
    )
  })

  it('separate two kinds about the same subject', () => {
    expect(exceptionDedupeKey('stale_webhook', 'airbnb', 'X')).not.toBe(
      exceptionDedupeKey('unknown_booking', 'airbnb', 'X'),
    )
  })
})

describe('drafting', () => {
  it('takes the title and severity from the playbook, not the caller', () => {
    // Two call sites raising one kind under two headings is two rows a person
    // reads as two problems.
    const draft = draftException('rate_push_failed', {
      organizationId: 'org-1',
      connectorId: 'conn-1',
      channelCode: 'booking_com',
      occurredAt: NOW,
      subject: 'BC-1',
      detail: 'שני תאריכים נדחו.',
    })

    expect(draft.title).toBe('Booking.com — עדכון מחירים לא התקבל בערוץ')
    expect(draft.severity).toBe('warning')
    expect(draft.bookingId).toBeNull()
  })
})

describe('the queue', () => {
  const at = (iso: string): Date => new Date(iso)

  const make = (
    id: string,
    severity: ChannelException['severity'],
    occurredAt: string,
    state: ChannelException['state'] = 'open',
  ): ChannelException => ({
    id,
    organizationId: 'org-1',
    connectorId: 'conn-1',
    channelCode: 'booking_com',
    kind: 'mapping_missing',
    severity,
    state,
    title: 't',
    detail: 'd',
    externalReservationId: null,
    externalListingId: null,
    bookingId: null,
    unitId: null,
    propertyId: null,
    dedupeKey: id,
    occurredAt: at(occurredAt),
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNote: null,
  })

  it('sorts by severity, then oldest first inside it', () => {
    const sorted = [
      make('a', 'warning', '2026-02-01T00:00:00Z'),
      make('b', 'critical', '2026-02-02T00:00:00Z'),
      make('c', 'critical', '2026-02-01T00:00:00Z'),
    ].sort(bySeverityThenAge)

    // The Tuesday unmapped reservation is more dangerous than the identical
    // one from ten minutes ago: its dates are that much closer.
    expect(sorted.map((exception) => exception.id)).toEqual(['c', 'b', 'a'])
  })

  it('counts acknowledged as still open', () => {
    // Somebody having seen a double booking does not un-double it.
    const tally = tallyExceptions([
      make('a', 'critical', '2026-02-01T00:00:00Z'),
      make('b', 'urgent', '2026-02-01T00:00:00Z', 'acknowledged'),
      make('c', 'warning', '2026-02-01T00:00:00Z', 'resolved'),
      make('d', 'warning', '2026-02-01T00:00:00Z', 'dismissed'),
    ])

    expect(tally).toEqual({ open: 2, critical: 1, urgent: 1, warning: 0 })
  })
})
