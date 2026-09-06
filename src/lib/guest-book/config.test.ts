/**
 * The capability is off until somebody turns it on, and it applies only where
 * the operator said it applies.
 */

import { describe, expect, it } from 'vitest'

import {
  CONFIGURABLE_FIELDS,
  STRUCTURAL_FIELDS,
  defaultGuestBookConfig,
  effectiveRequiredFields,
  isGuestBookEnabledFor,
  rejectedFieldChoices,
  requiresField,
} from './config'

describe('defaultGuestBookConfig', () => {
  const config = defaultGuestBookConfig('org-1')

  it('is OFF', () => {
    expect(config.enabled).toBe(false)
  })

  it('requires nothing that was not established as necessary to the record', () => {
    // Address, financial document and notes are optional by default. The
    // module has not verified what any business must record, and the
    // conservative response to that is to collect less, not more.
    expect(config.requiredFields).not.toContain('guest_address')
    expect(config.requiredFields).not.toContain('financial_document')
    expect(config.requiredFields).not.toContain('notes')
  })

  it('has not been reviewed by anybody yet, and says so', () => {
    expect(config.fieldsReviewedAt).toBeNull()
    expect(config.fieldsReviewedByUserId).toBeNull()
  })
})

describe('isGuestBookEnabledFor', () => {
  const on = { ...defaultGuestBookConfig('org-1'), enabled: true }

  it('is false everywhere while the capability is off', () => {
    expect(isGuestBookEnabledFor(defaultGuestBookConfig('org-1'), 'p-1')).toBe(
      false,
    )
  })

  it('is true everywhere when no property list is set', () => {
    expect(isGuestBookEnabledFor(on, 'p-1')).toBe(true)
    expect(isGuestBookEnabledFor(on, 'p-2')).toBe(true)
  })

  it('is true only inside the property list when one is set', () => {
    const scoped = { ...on, propertyIds: ['p-1'] }
    expect(isGuestBookEnabledFor(scoped, 'p-1')).toBe(true)
    expect(isGuestBookEnabledFor(scoped, 'p-2')).toBe(false)
  })
})

describe('requiresField', () => {
  const config = { ...defaultGuestBookConfig('org-1'), requiredFields: [] }

  it('holds the structural fields in force whatever the configuration says', () => {
    for (const field of STRUCTURAL_FIELDS) {
      expect(requiresField(config, field)).toBe(true)
    }
  })

  it('lets an operator switch off everything else', () => {
    for (const field of CONFIGURABLE_FIELDS) {
      expect(requiresField(config, field)).toBe(false)
    }
  })

  it('reports the whole truth about what the register demands', () => {
    expect(effectiveRequiredFields(config)).toEqual(STRUCTURAL_FIELDS)
  })

  it('has no overlap between the structural and configurable sets', () => {
    for (const field of CONFIGURABLE_FIELDS) {
      expect(STRUCTURAL_FIELDS).not.toContain(field)
    }
  })
})

describe('rejectedFieldChoices', () => {
  it('names a field the vocabulary does not have', () => {
    expect(rejectedFieldChoices(['guest_address', 'passport_scan'])).toEqual([
      'passport_scan',
    ])
  })
})
