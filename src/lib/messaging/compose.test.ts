import { describe, expect, it } from 'vitest'

import {
  compose,
  isUsableAddress,
  maskRecipient,
  recipientAddress,
} from './compose'
import type { GuestMessageSubject, GuestRecipient } from './types'

const RECIPIENT: GuestRecipient = {
  guestId: 'guest-1',
  firstName: 'דנה',
  phone: '050-123-4567',
  email: 'dana@example.com',
  marketingConsent: true,
  language: 'he',
}

const SUBJECT: GuestMessageSubject = {
  bookingId: 'booking-1',
  propertyId: 'property-1',
  reference: 'B-2026-0141',
  organizationName: 'אחוזת רימונים',
  propertyName: 'הבית בגליל',
  checkIn: '3.9.2026',
  checkOut: '7.9.2026',
  portalUrl: 'https://estia.example/g/abc',
  outstandingAgorot: 120050,
}

// ── The text ──────────────────────────────────────────────────────────────

describe('compose', () => {
  it('greets the guest by name and names the place and the dates', () => {
    const message = compose({
      kind: 'arrival_info',
      channel: 'whatsapp',
      recipient: RECIPIENT,
      subject: SUBJECT,
    })

    expect(message.body).toContain('שלום דנה,')
    expect(message.body).toContain('הבית בגליל')
    expect(message.body).toContain('3.9.2026 – 7.9.2026')
    // Signed, because a link with no sender is a link people do not open.
    expect(message.body.trimEnd().endsWith('אחוזת רימונים')).toBe(true)
  })

  it('falls back to a bare greeting when there is no first name', () => {
    const message = compose({
      kind: 'arrival_info',
      channel: 'sms',
      recipient: { ...RECIPIENT, firstName: null },
      subject: SUBJECT,
    })

    expect(message.body.startsWith('שלום,')).toBe(true)
  })

  it('falls back to the organization when the property has no name', () => {
    const message = compose({
      kind: 'review_request',
      channel: 'sms',
      recipient: RECIPIENT,
      subject: { ...SUBJECT, propertyName: null },
    })

    expect(message.body).toContain('אחוזת רימונים')
  })

  it('states the outstanding amount in shekels on a payment reminder', () => {
    const message = compose({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      recipient: RECIPIENT,
      subject: SUBJECT,
    })

    expect(message.body).toContain('₪1200.5')
  })

  it('still says something true when the amount is not known', () => {
    // Dropping the whole message because one line is missing would turn an
    // unresolved balance into a guest who was never reminded at all.
    const message = compose({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      recipient: RECIPIENT,
      subject: { ...SUBJECT, outstandingAgorot: null },
    })

    expect(message.body).toContain('נותרה יתרה לתשלום')
    expect(message.body).not.toContain('₪')
  })

  it('omits the link line entirely when there is no portal url', () => {
    const message = compose({
      kind: 'arrival_info',
      channel: 'email',
      recipient: RECIPIENT,
      subject: { ...SUBJECT, portalUrl: null },
    })

    expect(message.body).not.toContain('http')
    expect(message.body).toContain('פרטי ההגעה')
  })

  it('gives a subject line to email and to nothing else', () => {
    const email = compose({
      kind: 'payment_reminder',
      channel: 'email',
      recipient: RECIPIENT,
      subject: SUBJECT,
    })
    const whatsapp = compose({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      recipient: RECIPIENT,
      subject: SUBJECT,
    })

    expect(email.subject).toContain('B-2026-0141')
    expect(whatsapp.subject).toBeNull()
  })
})

// ── The address ───────────────────────────────────────────────────────────

describe('recipientAddress', () => {
  it('reads the email for email and the phone for the two that are not', () => {
    expect(recipientAddress('email', RECIPIENT)).toBe('dana@example.com')
    expect(recipientAddress('sms', RECIPIENT)).toBe('050-123-4567')
    expect(recipientAddress('whatsapp', RECIPIENT)).toBe('050-123-4567')
  })

  it('treats blank as absent rather than as an address', () => {
    expect(recipientAddress('email', { ...RECIPIENT, email: '   ' })).toBeNull()
    expect(recipientAddress('sms', { ...RECIPIENT, phone: null })).toBeNull()
  })
})

describe('isUsableAddress', () => {
  it('accepts a foreign telephone number', () => {
    // Deliberately not `agents/phone.normalizePhone`, which is Israeli-mobile
    // only. Refusing a French guest's number would be this module deciding who
    // may be a guest.
    expect(isUsableAddress('whatsapp', '+33 6 12 34 56 78')).toBe(true)
    expect(isUsableAddress('sms', '050-123-4567')).toBe(true)
  })

  it('refuses something too short to be any national number', () => {
    expect(isUsableAddress('sms', '1234')).toBe(false)
  })

  it('refuses a malformed email and accepts an ordinary one', () => {
    expect(isUsableAddress('email', 'dana@example.com')).toBe(true)
    expect(isUsableAddress('email', 'dana@example')).toBe(false)
    expect(isUsableAddress('email', '@example.com')).toBe(false)
    expect(isUsableAddress('email', 'dana example.com')).toBe(false)
  })
})

// ── What is safe to store ─────────────────────────────────────────────────

describe('maskRecipient', () => {
  it('keeps enough to recognise a number and not enough to dial it', () => {
    expect(maskRecipient('050-123-4567')).toBe('***567')
  })

  it('keeps the domain of an address and one character of the local part', () => {
    expect(maskRecipient('dana@example.com')).toBe('d***@example.com')
  })

  it('returns null rather than stars for something it cannot classify', () => {
    // `***` would imply a recipient was recorded when nothing usable was.
    expect(maskRecipient('  ')).toBeNull()
    expect(maskRecipient(null)).toBeNull()
    expect(maskRecipient('ab')).toBeNull()
    expect(maskRecipient('@example.com')).toBeNull()
  })
})
