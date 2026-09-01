/**
 * Builders for the shapes the guest journey reasons about.
 *
 * Test support living in `src`, on the precedent of
 * `src/lib/persistence/fake-client.ts` — and for the same reason it gives: a
 * double that several suites share has to live somewhere both can import, and
 * hiding it under a test directory only moves the question.
 *
 * Every builder starts from **the quietest possible journey** — no contract, no
 * details, no payment policy, confirmation only — because that is what a
 * business that has never opened the settings screen actually gets, and a
 * fixture that started fully configured would let a test pass while the
 * shipped default was broken. Each test then turns on exactly the one thing it
 * is about.
 */

import type { GuestAction } from '../payments/guest-action'
import type { CollectionDecision } from '../payments/resolver'

import type { GuestCollection } from './collection'
import type {
  GuestJourney,
  GuestJourneySettings,
  GuestJourneyTerms,
} from './types'

export const QUIET_SETTINGS: GuestJourneySettings = {
  contractMode: 'disabled',
  requireGuestConfirmation: true,
  requiredDetailFields: [],
  optionalDetailFields: [],
  arrivalRelease: 'after_confirmation',
  arrivalReleaseHours: 24,
  duringStayTopics: ['wifi', 'guide', 'access', 'checkout'],
  requestsEnabled: true,
  requestCategories: [
    'towels',
    'linen',
    'cleaning',
    'maintenance',
    'equipment',
    'other',
  ],
  checkoutDeclarationEnabled: true,
  reviewEnabled: false,
  reviewUrl: null,
  rebookEnabled: false,
  reconfirmationTriggers: ['dates', 'guests', 'price', 'cancellation'],
}

export const BASE_TERMS: GuestJourneyTerms = {
  bookingVersion: 4,
  status: 'confirmed',
  checkIn: '2026-09-03',
  checkOut: '2026-09-07',
  adults: 2,
  children: 0,
  infants: 0,
  totalAgorot: 750_000,
  currency: 'ILS',
  cancellationTerms: 'ביטול עד 14 יום לפני ההגעה ללא חיוב.',
  inStay: false,
}

export function journeyFixture(
  overrides: {
    settings?: Partial<GuestJourneySettings>
    current?: Partial<GuestJourneyTerms>
  } & Partial<Omit<GuestJourney, 'settings' | 'current'>> = {},
): GuestJourney {
  const { settings, current, ...rest } = overrides

  return {
    settings: { ...QUIET_SETTINGS, ...settings },
    current: { ...BASE_TERMS, ...current },
    confirmation: null,
    contract: {
      mode: settings?.contractMode ?? 'disabled',
      template: null,
      signature: null,
    },
    details: { submittedAt: null, fields: {} },
    arrival: {
      released: false,
      checkInTime: '15:00:00',
      addressNote: null,
      addressLine1: null,
      addressLine2: null,
      city: 'רמת הגולן',
      directions: null,
      mapUrl: null,
      parking: null,
      accessInstructions: null,
      accessCode: null,
    },
    stay: {
      inStay: false,
      wifiNetwork: null,
      wifiPassword: null,
      propertyGuide: null,
      houseRules: null,
      emergencyContact: null,
    },
    requests: [],
    checkout: {
      checkOutTime: '11:00:00',
      instructions: null,
      declaredAt: null,
      enabled: true,
    },
    ...rest,
  }
}

/**
 * A decision that asks for nothing.
 *
 * `policy: 'none'` with no requirements is not an empty fixture — it is the
 * single most common real configuration in this market, and the one the
 * "never an empty step" rule is mostly about.
 */
export const NOTHING_REQUIRED_DECISION: CollectionDecision = {
  source: 'organization',
  policy: 'none',
  overrideReason: null,
  dueNowAgorot: 0,
  shortfallAgorot: 0,
  balanceDueDaysBefore: null,
  requirements: [],
  checks: [],
  outstanding: [],
  confirmable: true,
  liveAvailable: false,
  guestInstructions: null,
}

export const NOTHING_REQUIRED_ACTION: GuestAction = {
  kind: 'nothing_required',
  title: 'הכול בוצע',
  body: 'בית האירוח אינו מבקש ממך דבר לפני האישור. ההזמנה מטופלת.',
  cta: null,
  amountAgorot: null,
  channels: [],
  offerProofUpload: false,
}

export function collectionFixture(
  decision: Partial<CollectionDecision> = {},
  action: Partial<GuestAction> = {},
): GuestCollection {
  const resolved: CollectionDecision = {
    ...NOTHING_REQUIRED_DECISION,
    ...decision,
  }

  return {
    decision: resolved,
    action: { ...NOTHING_REQUIRED_ACTION, ...action },
    guestInstructions: resolved.guestInstructions,
    proofUploadUnavailable: action.offerProofUpload === true,
  }
}
