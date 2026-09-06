import { describe, expect, it } from 'vitest'

import { resolveTemplate, type MessageTemplate } from './template-repository'

const template = (over: Partial<MessageTemplate> = {}): MessageTemplate => ({
  id: 't-1',
  kind: 'arrival_info',
  channel: null,
  subject: null,
  body: 'ברירת מחדל של העסק',
  isActive: true,
  ...over,
})

describe('which template a send uses', () => {
  it('prefers the channel-specific row over the all-channels one', () => {
    const templates = [
      template({ id: 'all', channel: null }),
      template({ id: 'sms', channel: 'sms' }),
    ]
    expect(resolveTemplate(templates, 'arrival_info', 'sms')?.id).toBe('sms')
  })

  it('falls back to the all-channels row for a channel with no override', () => {
    const templates = [
      template({ id: 'all', channel: null }),
      template({ id: 'sms', channel: 'sms' }),
    ]
    expect(resolveTemplate(templates, 'arrival_info', 'whatsapp')?.id).toBe(
      'all',
    )
  })

  it('never crosses kinds', () => {
    // A payment reminder must not be sent using the arrival wording, which is
    // the single most embarrassing failure this function could have.
    const templates = [template({ id: 'arrival', kind: 'arrival_info' })]
    expect(resolveTemplate(templates, 'payment_reminder', 'sms')).toBeNull()
  })

  it('returns null when there is nothing, so compose writes the built-in text', () => {
    expect(resolveTemplate([], 'arrival_info', 'email')).toBeNull()
  })
})

describe('an inactive template is not a template', () => {
  it('resolves as though it were absent', () => {
    // The whole point of the flag: a business switches its own wording off and
    // gets working Hebrew back without losing what it wrote.
    const templates = [template({ id: 'off', isActive: false })]
    expect(resolveTemplate(templates, 'arrival_info', 'email')).toBeNull()
  })

  it('and does not shadow an active row that should win', () => {
    // Without the `isActive` filter running FIRST, the inactive channel row
    // would be found by the channel lookup and the active fallback never
    // reached — the business would get silence instead of its own wording.
    const templates = [
      template({ id: 'sms-off', channel: 'sms', isActive: false }),
      template({ id: 'all-on', channel: null, isActive: true }),
    ]
    expect(resolveTemplate(templates, 'arrival_info', 'sms')?.id).toBe('all-on')
  })
})
