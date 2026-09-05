import { describe, expect, it } from 'vitest'

import { isPermission, FIELD_PERMISSIONS } from '../authz/permissions'
import { ALERT_EVENTS, isDomainEvent } from '../contracts/events'

import {
  NOTIFICATION_CATALOGUE,
  notifiableEvents,
  unroutedAlertEvents,
} from './catalogue'
import { CATEGORY_LABEL, SEVERITY_LABEL } from './labels'

const entries = Object.entries(NOTIFICATION_CATALOGUE)
const FIELD_SET = new Set<string>(FIELD_PERMISSIONS)

describe('the catalogue only speaks the frozen vocabularies', () => {
  it('names no event outside DOMAIN_EVENTS', () => {
    // The type already refuses this at compile time. Asserted at runtime too,
    // because a cast in a future edit would slip past the type and produce an
    // event name no subscriber can hear.
    for (const [name] of entries) {
      expect(isDomainEvent(name), name).toBe(true)
    }
  })

  it('names no grant outside the permission catalogue', () => {
    for (const [name, spec] of entries) {
      if (spec.requiredGrant === null) continue
      const known =
        isPermission(spec.requiredGrant) || FIELD_SET.has(spec.requiredGrant)
      expect(known, `${name} → ${spec.requiredGrant}`).toBe(true)
    }
  })

  it('names no category or severity the labels cannot render', () => {
    for (const [name, spec] of entries) {
      expect(CATEGORY_LABEL[spec.category], name).toBeTruthy()
      expect(SEVERITY_LABEL[spec.severity], name).toBeTruthy()
    }
  })
})

describe('every alert event the contract promises reaches a person', () => {
  it('leaves none of ALERT_EVENTS unrouted', () => {
    // `contracts/events.ts` says these "must reach a person rather than only a
    // log". A gap between that promise and this table is the product not
    // keeping it, and it should fail here rather than during an incident.
    expect(unroutedAlertEvents()).toEqual([])
  })

  it('gives every alert event a severity worth interrupting somebody for', () => {
    for (const name of ALERT_EVENTS) {
      const spec = NOTIFICATION_CATALOGUE[name]
      expect(spec, name).toBeDefined()
      expect(spec!.severity, name).not.toBe('info')
    }
  })
})

describe('what a person actually receives', () => {
  it('has a Hebrew title and body on every entry', () => {
    for (const [name, spec] of entries) {
      expect(spec.title.trim().length, name).toBeGreaterThan(0)
      expect(spec.body.trim().length, name).toBeGreaterThan(0)
      // Hebrew, not a placeholder in English that nobody translated.
      expect(/[֐-׿]/.test(spec.title), name).toBe(true)
      expect(/[֐-׿]/.test(spec.body), name).toBe(true)
    }
  })

  it('produces only relative links, because 0043 refuses anything else', () => {
    for (const [name, spec] of entries) {
      if (!spec.href) continue
      for (const id of ['abc-123', null]) {
        const href = spec.href(id)
        if (href === null) continue
        expect(href.startsWith('/'), `${name} → ${href}`).toBe(true)
        expect(href.includes('://'), `${name} → ${href}`).toBe(false)
      }
    }
  })
})

describe('the audience rule', () => {
  it('lets only an actor-addressed event go without a grant', () => {
    for (const [name, spec] of entries) {
      if (spec.requiredGrant === null) {
        expect(spec.audience, name).toBe('actor')
      }
    }
  })

  it('has at least one event, and it is the security one', () => {
    const addressed = entries
      .filter(([, spec]) => spec.audience === 'actor')
      .map(([name]) => name)

    expect(addressed).toContain('security.new_device_login')
  })
})

describe('escalation', () => {
  it('marks nothing routine as escalating', () => {
    for (const [name, spec] of entries) {
      if (!spec.escalates) continue
      // Paging a second person about something at `info` is how a business
      // learns that the escalation is noise.
      expect(spec.severity, name).not.toBe('info')
    }
  })
})

describe('coverage', () => {
  it('routes a deliberate subset rather than everything', () => {
    // Most of the 130 events are for automations, dashboards and the audit
    // trail. This assertion exists so that "route everything" cannot happen by
    // accident during a future edit — silence is the default, and an entry is
    // a claim that a human needs to know.
    expect(notifiableEvents().length).toBeGreaterThan(30)
    expect(notifiableEvents().length).toBeLessThan(80)
  })
})
