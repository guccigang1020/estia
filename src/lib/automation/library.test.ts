/**
 * The template library.
 *
 * The assertion that matters most is the one against the frozen event
 * catalogue. The type system already refuses a `when` outside `DomainEventName`
 * at compile time; this repeats it at run time because the failure it guards
 * against — a rule that is configured, shown as active, and silently never
 * fires — is invisible on screen and expensive in the field.
 *
 * The second assertion is about defaults. Anything that speaks to a guest,
 * spends money or issues a document must ship off, and that is a claim about
 * the data rather than about the code, so it is checked as one.
 */

import { describe, expect, it } from 'vitest'

import { DOMAIN_EVENTS, isDomainEvent } from '../contracts/events'
import { PERMISSIONS } from '../authz/permissions'

import {
  AUTOMATION_TEMPLATES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABEL,
  libraryTriggers,
  requiredFacts,
  templateById,
  templatesFor,
} from './library'
import { AUTOMATION_ACTIONS, reachesOutsideTheBusiness } from './types'

describe('every trigger is a member of the frozen catalogue', () => {
  it('names no event the product does not raise', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      expect(
        isDomainEvent(entry.rule.when),
        `${entry.rule.id} listens to '${entry.rule.when}'`,
      ).toBe(true)
    }
  })

  it('uses the lifecycle events rather than one generic status change', () => {
    // The catalogue enumerates the booking lifecycle on purpose. A library
    // that hung everything off a single event and filtered on an inner field
    // would be the shape the catalogue's own header argues against.
    const triggers = libraryTriggers()
    expect(triggers).toContain('booking.confirmed')
    expect(triggers).toContain('booking.ready_for_check_in')
    expect(triggers).toContain('booking.checked_out')
    expect(triggers).not.toContain('booking.status_changed' as never)
  })

  it('does not exceed the catalogue', () => {
    const known = new Set<string>(DOMAIN_EVENTS)
    for (const trigger of libraryTriggers())
      expect(known.has(trigger)).toBe(true)
  })
})

describe('every action is a permission the catalogue defines', () => {
  it('maps each action kind to a real grant', () => {
    const known = new Set<string>(PERMISSIONS)
    for (const meta of Object.values(AUTOMATION_ACTIONS)) {
      expect(known.has(meta.requires), meta.kind).toBe(true)
    }
  })
})

describe('the defaults are a decision, not an accident', () => {
  // The set this used to keep for itself now lives in `types.ts` as
  // `EXTERNALLY_VISIBLE_ACTIONS`, because the screens ask the same question
  // before offering a switch — "is this one a business should read the wording
  // of first" — and two copies of that list would answer it differently within
  // a release.
  it('ships every rule that reaches outside the business off', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      if (reachesOutsideTheBusiness(entry.rule)) {
        expect(
          entry.rule.enabled,
          `${entry.rule.id} is enabled by default`,
        ).toBe(false)
      }
    }
  })

  /**
   * The other direction, which is the half that actually catches something.
   *
   * "Guest-facing rules ship off" passes trivially for a library where
   * everything ships off. What must also hold is that a rule shipping ON has
   * no action anybody outside the business would notice — so a template that
   * grows a `message_guest` action next year and keeps its `enabled: true`
   * fails here rather than messaging somebody's customers on upgrade day.
   */
  it('ships nothing on that somebody outside the business would notice', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      if (entry.rule.enabled) {
        expect(
          reachesOutsideTheBusiness(entry.rule),
          `${entry.rule.id} ships on and reaches outside the business`,
        ).toBe(false)
      }
    }
  })

  it('ships at least one internal rule on, so the library is not inert', () => {
    expect(AUTOMATION_TEMPLATES.some((entry) => entry.rule.enabled)).toBe(true)
  })
})

describe('the shape of a template', () => {
  it('gives every rule a unique id', () => {
    const ids = AUTOMATION_TEMPLATES.map((entry) => entry.rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every action a Hebrew note that is not the action name', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      for (const action of entry.rule.actions) {
        expect(action.note.trim().length).toBeGreaterThan(0)
        expect(action.note).not.toBe(action.kind)
      }
    }
  })

  it('gives every rule at least one action', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      expect(entry.rule.actions.length).toBeGreaterThan(0)
    }
  })

  it('labels every category it uses', () => {
    for (const entry of AUTOMATION_TEMPLATES) {
      expect(TEMPLATE_CATEGORY_LABEL[entry.category]).toBeTruthy()
    }
  })

  it('places every template in exactly one category listing', () => {
    const counted = TEMPLATE_CATEGORIES.reduce(
      (total, category) => total + templatesFor(category).length,
      0,
    )
    expect(counted).toBe(AUTOMATION_TEMPLATES.length)
  })
})

describe('requiredFacts', () => {
  it('names the fields the IF clause compares, deduplicated', () => {
    const review = templateById('review-request-after-stay')
    expect(review).not.toBeNull()
    expect(requiredFacts(review!)).toEqual(['nights'])
  })

  it('is empty for a rule that runs on every occurrence', () => {
    const confirmed = templateById('confirmed-notify-and-prepare')
    expect(requiredFacts(confirmed!)).toEqual([])
  })

  it('returns null for an id nobody defined', () => {
    expect(templateById('no-such-template')).toBeNull()
  })
})
