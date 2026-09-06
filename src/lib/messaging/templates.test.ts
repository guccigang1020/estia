import { describe, expect, it } from 'vitest'

import {
  MAX_TEMPLATE_CHARS,
  PLACEHOLDERS_FOR,
  renderTemplate,
  tokensIn,
  validateTemplate,
} from './templates'

describe('a template that names a fact the product cannot supply', () => {
  it('is refused at save time, not at send time', () => {
    // The failure this prevents: somebody writes {{door_code}} because their
    // previous system had one, it saves, and three weeks later a guest is
    // standing at a locked door holding a message that says {{door_code}}.
    const problems = validateTemplate(
      'arrival_info',
      'שלום {{guest_first_name}}, הקוד הוא {{door_code}}',
    )
    expect(problems).toEqual([
      { kind: 'unknown_placeholder', token: 'door_code' },
    ])
  })

  it('catches a real placeholder used in the wrong template', () => {
    // {{amount}} in a review request is not a typo to render as empty — it is
    // somebody editing the wrong template.
    const problems = validateTemplate('review_request', 'תודה! {{amount}}')
    expect(problems).toEqual([{ kind: 'wrong_kind', token: 'amount' }])
  })

  it('accepts the same placeholder where it belongs', () => {
    expect(
      validateTemplate('payment_reminder', 'נותרה יתרה בסך {{amount}}'),
    ).toEqual([])
  })

  it('refuses an empty template rather than sending a blank message', () => {
    expect(validateTemplate('arrival_info', '   ')).toEqual([{ kind: 'empty' }])
  })

  it('refuses a brochure, because an SMS is billed per 70 characters', () => {
    const problems = validateTemplate(
      'arrival_info',
      'א'.repeat(MAX_TEMPLATE_CHARS + 1),
    )
    expect(problems).toContainEqual({
      kind: 'too_long',
      length: MAX_TEMPLATE_CHARS + 1,
    })
  })
})

describe('the token syntax is deliberately narrow', () => {
  it('reads a token with or without inner spaces', () => {
    expect(tokensIn('{{reference}} and {{ check_in }}')).toEqual([
      'reference',
      'check_in',
    ])
  })

  it('leaves a single brace alone, because it is text', () => {
    expect(tokensIn('עלות {amount} שקלים')).toEqual([])
    expect(validateTemplate('payment_reminder', 'עלות {amount}')).toEqual([])
  })

  it('has no expression syntax at all', () => {
    // A template language a business can write logic in is one that can loop
    // forever on the send path.
    expect(tokensIn('{{#if amount}}x{{/if}}')).toEqual([])
  })
})

describe('rendering never leaves a raw token in front of a guest', () => {
  it('substitutes what it has', () => {
    expect(
      renderTemplate('שלום {{guest_first_name}}, הזמנה {{reference}}', {
        guest_first_name: 'דנה',
        reference: 'B-1042',
      }),
    ).toBe('שלום דנה, הזמנה B-1042')
  })

  it('uses the declared fallback when the amount is not known', () => {
    // compose.ts already makes this choice with an `if`: a number that is
    // wrong generates a worse telephone call than a sentence with no number.
    expect(
      renderTemplate('נותרה {{amount}} להשלמת ההזמנה.', { amount: null }),
    ).toBe('נותרה יתרה לתשלום להשלמת ההזמנה.')
  })

  it('drops the hole an absent portal link leaves behind', () => {
    // Without this the guest reads a dangling colon and a blank line.
    const body = 'ההגעה מתקרבת.\n\nכל הפרטים כאן:\n{{portal_url}}'
    expect(renderTemplate(body, { portal_url: null })).toBe(
      'ההגעה מתקרבת.\n\nכל הפרטים כאן:',
    )
  })

  it('keeps a deliberate blank line between paragraphs', () => {
    const body = 'שורה ראשונה\n\nשורה שנייה'
    expect(renderTemplate(body, {})).toBe('שורה ראשונה\n\nשורה שנייה')
  })

  it('renders an absent name as nothing rather than as the word null', () => {
    expect(
      renderTemplate('שלום {{guest_first_name}}', { guest_first_name: null }),
    ).toBe('שלום')
  })

  it('treats a blank string as absent', () => {
    expect(renderTemplate('{{property_name}}!', { property_name: '   ' })).toBe(
      '!',
    )
  })
})

describe('every placeholder a kind offers is one it can actually fill', () => {
  it('and every offered placeholder declares what happens when it is absent', () => {
    for (const [kind, placeholders] of Object.entries(PLACEHOLDERS_FOR)) {
      for (const placeholder of placeholders) {
        // `whenAbsent: null` is a promise that it can never be missing. Any
        // other value is a promise about the exact text a guest will read.
        expect(
          placeholder.whenAbsent === null ||
            typeof placeholder.whenAbsent === 'string',
          `${kind}.${placeholder.name}`,
        ).toBe(true)
        expect(
          placeholder.label.trim(),
          `${kind}.${placeholder.name}`,
        ).not.toBe('')
      }
    }
  })

  it('accepts every placeholder it advertises', () => {
    for (const [kind, placeholders] of Object.entries(PLACEHOLDERS_FOR)) {
      const body = placeholders.map((p) => `{{${p.name}}}`).join(' ')
      expect(
        validateTemplate(kind as keyof typeof PLACEHOLDERS_FOR, body),
        kind,
      ).toEqual([])
    }
  })
})

describe('compose uses the business wording, and falls back safely', () => {
  const subject = {
    bookingId: 'b-1',
    propertyId: 'p-1',
    reference: 'B-2026-0141',
    organizationName: 'אחוזת הגליל',
    propertyName: 'בית הכרם',
    checkIn: '12.08',
    checkOut: '14.08',
    portalUrl: 'https://example.com/g/abc',
    outstandingAgorot: 45_000,
  }
  const recipient = {
    guestId: 'g-1',
    firstName: 'דנה',
    email: 'd@example.com',
    phone: null,
    marketingConsent: true,
    language: 'he',
  }

  it('renders the template when the business wrote one', async () => {
    const { compose } = await import('./compose')
    const message = compose({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      recipient,
      subject,
      template: {
        subject: null,
        body: 'היי {{guest_first_name}}! נותרו {{amount}} ל{{property_name}}.',
      },
    })
    expect(message.body).toBe('היי דנה! נותרו ₪450 לבית הכרם.')
  })

  it('falls back to the built-in Hebrew with no template', async () => {
    // The reason deleting a template is safe: a business that removes one goes
    // back to working Hebrew rather than to silence.
    const { compose } = await import('./compose')
    const withNone = compose({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      recipient,
      subject,
    })
    expect(withNone.body).toContain('אחוזת הגליל')
    expect(withNone.body).toContain('₪450')
    expect(withNone.body).not.toContain('{{')
  })

  it('never leaves a token in front of a guest, even for an absent value', async () => {
    const { compose } = await import('./compose')
    const message = compose({
      kind: 'payment_reminder',
      channel: 'whatsapp',
      recipient: { ...recipient, firstName: null, email: null },
      subject: { ...subject, outstandingAgorot: null, portalUrl: null },
      template: {
        subject: null,
        body: 'שלום {{guest_first_name}}\nנותרה {{amount}}.\n\nכאן:\n{{portal_url}}',
      },
    })
    expect(message.body).not.toContain('{{')
    expect(message.body).toContain('נותרה יתרה לתשלום.')
  })
})
