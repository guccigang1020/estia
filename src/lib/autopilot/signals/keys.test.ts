/**
 * The dedupe key is the one thing in this directory that cannot be got wrong
 * quietly, so it is tested harder than anything else here.
 */

import { describe, expect, it } from 'vitest'

import { AUTOPILOT_DOMAINS, type AutopilotDomain } from '../../contracts/states'
import type { Signal } from '../types'

import { CAUSE_SOURCES, linkCauses, signalKey } from './keys'

const BOOKING = '9f2a4c7e-1b3d-4e5f-8a90-1234567890ab'

describe('signalKey stability', () => {
  it('gives the same problem the same key on every pass', () => {
    const parts = {
      code: 'inventory.shortage',
      resourceType: 'property',
      resourceId: 'villa-1',
      aspect: 'towel-large',
    }
    // The same shortage, noticed five minutes apart.
    expect(signalKey(parts)).toBe(signalKey({ ...parts }))
    expect(signalKey(parts)).toBe(
      'inventory.shortage:property:villa-1:towel-large',
    )
  })

  it('never collides two different problems', () => {
    const towels = signalKey({
      code: 'inventory.shortage',
      resourceType: 'property',
      resourceId: 'villa-1',
      aspect: 'towel-large',
    })
    const sheets = signalKey({
      code: 'inventory.shortage',
      resourceType: 'property',
      resourceId: 'villa-1',
      aspect: 'sheet-double',
    })
    const otherVilla = signalKey({
      code: 'inventory.shortage',
      resourceType: 'property',
      resourceId: 'villa-2',
      aspect: 'towel-large',
    })
    const otherCode = signalKey({
      code: 'inventory.projected_shortage',
      resourceType: 'property',
      resourceId: 'villa-1',
      aspect: 'towel-large',
    })
    expect(new Set([towels, sheets, otherVilla, otherCode]).size).toBe(4)
  })

  it('distinguishes a missing resource from an empty one', () => {
    expect(
      signalKey({
        code: 'laundry.not_started',
        resourceType: 'property',
        resourceId: null,
      }),
    ).toBe('laundry.not_started:property:-')
  })
})

describe('signalKey refuses the clock', () => {
  it('throws on an ISO instant in the aspect', () => {
    expect(() =>
      signalKey({
        code: 'inventory.shortage',
        resourceType: 'property',
        resourceId: 'villa-1',
        aspect: '2026-09-12T06:05:00.000Z',
      }),
    ).toThrow(RangeError)
  })

  it('throws on epoch milliseconds in the code', () => {
    expect(() =>
      signalKey({
        code: 'inventory.shortage.1757649900000',
        resourceType: 'property',
        resourceId: 'villa-1',
      }),
    ).toThrow(RangeError)
  })

  it('throws on an instant hiding in the resource id', () => {
    expect(() =>
      signalKey({
        code: 'arrival.not_ready',
        resourceType: 'booking',
        resourceId: 'booking 2026-09-12 15:00',
      }),
    ).toThrow(RangeError)
  })

  it('allows a calendar date, because the date is which night', () => {
    const key = signalKey({
      code: 'opportunity.empty_night',
      resourceType: 'property',
      resourceId: 'villa-1',
      aspect: '2026-09-12',
    })
    expect(key).toBe('opportunity.empty_night:property:villa-1:2026-09-12')
    // And the same night an hour later is the same opportunity.
    expect(
      signalKey({
        code: 'opportunity.empty_night',
        resourceType: 'property',
        resourceId: 'villa-1',
        aspect: '2026-09-12',
      }),
    ).toBe(key)
  })

  it('does not choke on a UUID that happens to hold a long digit run', () => {
    expect(() =>
      signalKey({
        code: 'arrival.not_ready',
        resourceType: 'booking',
        resourceId: '00000000-1234-5678-9012-345678901234',
      }),
    ).not.toThrow()
  })
})

/* ------------------------------------------------------------ causality -- */

function signal(
  domain: AutopilotDomain,
  code: string,
  propertyId: string | null = 'villa-1',
): Signal {
  return {
    code,
    domain,
    risk: 'at_risk',
    resourceType: 'property',
    resourceId: propertyId,
    propertyId,
    title: code,
    detail: code,
    evidence: [],
    dedupeKey: signalKey({
      code,
      resourceType: 'property',
      resourceId: propertyId,
    }),
  }
}

describe('CAUSE_SOURCES', () => {
  it('covers every domain, so a new one cannot be forgotten', () => {
    for (const domain of AUTOPILOT_DOMAINS) {
      expect(CAUSE_SOURCES[domain]).toBeDefined()
    }
  })

  it('is acyclic', () => {
    const seen = new Set<AutopilotDomain>()
    const stack = new Set<AutopilotDomain>()

    const walk = (domain: AutopilotDomain): void => {
      if (stack.has(domain)) {
        throw new Error(`cycle through ${domain}`)
      }
      if (seen.has(domain)) return
      stack.add(domain)
      for (const upstream of CAUSE_SOURCES[domain]) walk(upstream)
      stack.delete(domain)
      seen.add(domain)
    }

    expect(() => {
      for (const domain of AUTOPILOT_DOMAINS) walk(domain)
    }).not.toThrow()
  })
})

describe('linkCauses', () => {
  it('turns the four-signal chain into one incident', () => {
    const laundry = signal('laundry', 'laundry.delivery_late')
    const inventory = signal('inventory', 'inventory.shortage')
    const preparation = signal('preparation', 'preparation.behind_schedule')
    const arrival = signal('arrival_risk', 'arrival.not_ready')

    const linked = linkCauses([arrival, preparation, inventory, laundry])
    const byCode = new Map(linked.map((item) => [item.code, item]))

    expect(byCode.get('laundry.delivery_late')?.causedBy).toBeUndefined()
    expect(byCode.get('inventory.shortage')?.causedBy).toBe(laundry.dedupeKey)
    expect(byCode.get('preparation.behind_schedule')?.causedBy).toBe(
      inventory.dedupeKey,
    )
    // The arrival blames the maintenance-free root furthest upstream that it
    // declares, which is the shortage rather than the preparation risk.
    expect(byCode.get('arrival.not_ready')?.causedBy).toBe(inventory.dedupeKey)

    // Exactly one signal with no cause: one incident.
    expect(linked.filter((item) => item.causedBy === undefined)).toHaveLength(1)
  })

  it('never blames another property', () => {
    const shortageElsewhere = signal(
      'inventory',
      'inventory.shortage',
      'villa-2',
    )
    const preparation = signal('preparation', 'preparation.behind_schedule')

    const linked = linkCauses([preparation, shortageElsewhere])
    expect(linked[0]?.causedBy).toBeUndefined()
  })

  it('leaves an organization-wide signal unlinked', () => {
    const orgWide = signal('preparation', 'preparation.plan_missing', null)
    const shortage = signal('inventory', 'inventory.shortage')
    expect(linkCauses([orgWide, shortage])[0]?.causedBy).toBeUndefined()
  })

  it('never overwrites a cause a detector already knew', () => {
    const shortage = signal('inventory', 'inventory.shortage')
    const preparation: Signal = {
      ...signal('preparation', 'preparation.behind_schedule'),
      causedBy: 'something.specific:task:abc',
    }
    const linked = linkCauses([preparation, shortage])
    expect(linked[0]?.causedBy).toBe('something.specific:task:abc')
  })

  it('gives the same answer whatever order the detectors ran in', () => {
    const laundry = signal('laundry', 'laundry.delivery_late')
    const other = signal('laundry', 'laundry.unconfirmed')
    const preparation = signal('preparation', 'preparation.behind_schedule')

    const forwards = linkCauses([preparation, laundry, other])
    const backwards = linkCauses([other, laundry, preparation])

    const causeOf = (signals: readonly Signal[]): string | undefined =>
      signals.find((item) => item.domain === 'preparation')?.causedBy

    expect(causeOf(forwards)).toBe(causeOf(backwards))
  })

  it('does not make a signal its own cause', () => {
    const one = signal('inventory', 'inventory.shortage')
    const two = signal('inventory', 'inventory.projected_shortage')
    for (const linked of linkCauses([one, two])) {
      expect(linked.causedBy).not.toBe(linked.dedupeKey)
    }
  })

  it('keeps the booking id out of it entirely', () => {
    // A regression guard for the temptation to key on the booking: the same
    // problem must survive a booking being amended.
    expect(
      signalKey({
        code: 'inventory.shortage',
        resourceType: 'property',
        resourceId: 'villa-1',
        aspect: 'towel-large',
      }),
    ).not.toContain(BOOKING)
  })
})
