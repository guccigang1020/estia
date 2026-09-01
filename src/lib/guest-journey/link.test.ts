/**
 * The link, the message, and what is safe to write down about who got it.
 *
 * Two things are asserted here that are easy to lose in a refactor and
 * expensive to lose in production: the recipient is masked before it is
 * stored, and a channel whose recipient is unusable produces no href at all
 * rather than one that opens an empty chat.
 */

import { describe, expect, it } from 'vitest'

import {
  channelHref,
  composeGuestMessage,
  guestLinkUrl,
  maskRecipient,
  type GuestMessageInput,
} from './link'

const TOKEN = 'a'.repeat(64)

const MESSAGE: GuestMessageInput = {
  purpose: 'first',
  guestFirstName: 'דנה',
  organizationName: 'אחוזת רימונים',
  propertyName: 'הבית בגליל',
  checkIn: '3.9.2026',
  checkOut: '7.9.2026',
  url: `https://estia.example/g/${TOKEN}`,
}

describe('guestLinkUrl', () => {
  it('builds the portal path under /g', () => {
    expect(guestLinkUrl('https://estia.example', TOKEN)).toBe(
      `https://estia.example/g/${TOKEN}`,
    )
  })

  it('tolerates a trailing slash on the origin', () => {
    expect(guestLinkUrl('https://estia.example/', TOKEN)).toBe(
      `https://estia.example/g/${TOKEN}`,
    )
  })
})

describe('composeGuestMessage', () => {
  it('greets by first name and names the stay and the link', () => {
    const message = composeGuestMessage(MESSAGE)

    expect(message.body).toContain('שלום דנה,')
    expect(message.body).toContain('הבית בגליל')
    expect(message.body).toContain('3.9.2026 – 7.9.2026')
    expect(message.body).toContain(MESSAGE.url)
    expect(message.subject).toBe('ההזמנה שלכם בהבית בגליל')
  })

  it('greets without a name rather than leaving a gap', () => {
    const message = composeGuestMessage({ ...MESSAGE, guestFirstName: null })
    expect(message.body).toContain('שלום,')
    expect(message.body).not.toContain('undefined')
    expect(message.body).not.toContain('null')
  })

  it('falls back to the organization when there is no property name', () => {
    const message = composeGuestMessage({ ...MESSAGE, propertyName: null })
    expect(message.body).toContain('אחוזת רימונים')
  })

  it('says plainly that the previous link stopped working', () => {
    // A guest who bookmarked the old link and gets "לא מצאנו את ההזמנה" with no
    // explanation assumes the booking was cancelled, and telephones to ask.
    const message = composeGuestMessage({ ...MESSAGE, purpose: 'rotated' })
    expect(message.body).toContain('הקישור הקודם אינו פעיל יותר')
    expect(message.subject).toContain('קישור חדש')
  })
})

describe('channelHref', () => {
  const message = composeGuestMessage(MESSAGE)

  it('builds a wa.me link from an Israeli mobile number', () => {
    const href = channelHref('whatsapp', message, '050-123-4567')
    expect(href).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/u)
    expect(decodeURIComponent(href ?? '')).toContain(MESSAGE.url)
  })

  it('builds an sms link in the form both platforms accept', () => {
    const href = channelHref('sms', message, '0501234567')
    expect(href).toMatch(/^sms:\+972501234567\?body=/u)
  })

  it('builds a mailto with a subject', () => {
    const href = channelHref('email', message, 'dana@example.com')
    expect(href).toMatch(/^mailto:/u)
    expect(decodeURIComponent(href ?? '')).toContain('ההזמנה שלכם')
  })

  it('returns nothing for copy, which has no app to open', () => {
    expect(channelHref('copy', message, null)).toBeNull()
  })

  it('refuses to build a link from an unusable recipient', () => {
    // A wa.me link built from a malformed number opens WhatsApp on a chat with
    // nobody, which looks like the product working and is not.
    expect(channelHref('whatsapp', message, 'לא מספר')).toBeNull()
    expect(channelHref('whatsapp', message, null)).toBeNull()
    expect(channelHref('sms', message, '03-1234567')).toBeNull()
    expect(channelHref('email', message, 'not-an-address')).toBeNull()
    expect(channelHref('email', message, '')).toBeNull()
  })
})

describe('maskRecipient', () => {
  it('keeps the last three digits of a telephone number', () => {
    expect(maskRecipient('050-123-4567')).toBe('***567')
    expect(maskRecipient('+972501234567')).toBe('***567')
  })

  it('keeps the first character and the domain of an address', () => {
    expect(maskRecipient('dana@example.com')).toBe('d***@example.com')
  })

  it('returns null rather than implying a recipient was recorded', () => {
    // `***` written for an unrecognised value would claim a recipient exists
    // when the truth is that nothing usable was captured.
    expect(maskRecipient(null)).toBeNull()
    expect(maskRecipient('')).toBeNull()
    expect(maskRecipient('   ')).toBeNull()
    expect(maskRecipient('@example.com')).toBeNull()
  })

  it('never returns anything a number could be reconstructed from', () => {
    const masked = maskRecipient('050-123-4567')
    expect(masked).not.toContain('0501234')
    expect(masked).toHaveLength(6)
  })
})
