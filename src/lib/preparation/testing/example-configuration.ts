/**
 * A worked example organization, for the tests.
 *
 * **This file is fixture data, not product code.** It is the one place in this
 * directory allowed to contain business numbers, because every number in it is
 * something a customer types into a settings screen: a bed's capacity, a
 * towel's divisor, a buffer percentage, a cleaning base rate. Nothing here is
 * imported by any module under `src/lib/preparation/*.ts` — the guard test
 * checks that too, so this cannot quietly become a default configuration
 * shipped in the engine.
 *
 * The property it describes is the one from the specification: five
 * double-width "Jewish" beds, a pool, and a Shabbat template. Feeding it a
 * twenty-five guest booking is what produces the famous figures — 25 sleeping
 * places, 25 linen sets, 25 pillows, 15 mattresses, 25/25/13/25 towels — none
 * of which appear anywhere in this file either. They are what the arithmetic
 * does to these inputs.
 */

import type {
  BedType,
  CommissionRule,
  ComplexityConfiguration,
  EventTemplate,
  FixedCost,
  PlanSectionKey,
  PreparationBooking,
  PreparationCatalogue,
  PreparationRule,
  PropertyConfiguration,
  ReadinessPolicy,
  StockLevel,
  VariableCostRule,
} from '../types'

export const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111'
export const PROPERTY_ID = '22222222-2222-4222-8222-222222222222'
export const OTHER_PROPERTY_ID = '33333333-3333-4333-8333-333333333333'
export const UNIT_ID = '44444444-4444-4444-8444-444444444444'
export const BOOKING_ID = '55555555-5555-4555-8555-555555555555'

const FOREVER = { effectiveFrom: '2020-01-01', effectiveTo: null }

// ── Bed types ─────────────────────────────────────────────────────────────

export const BED_TYPES: readonly BedType[] = [
  {
    id: 'double_bed',
    label: 'מיטה זוגית',
    capacity: 2,
    positions: 1,
    setupMinutes: 10,
    usableAsExtra: false,
    linen: [
      {
        itemId: 'double_fitted_sheet',
        label: 'סדין זוגי',
        quantity: 1,
        unit: 'piece',
      },
      {
        itemId: 'double_duvet_cover',
        label: 'ציפת שמיכה זוגית',
        quantity: 1,
        unit: 'piece',
      },
      { itemId: 'pillow', label: 'כרית', quantity: 2, unit: 'piece' },
    ],
  },
  {
    // Two singles side by side: sleeps two, made up as two.
    id: 'jewish_bed',
    label: 'מיטה יהודית',
    capacity: 2,
    positions: 2,
    setupMinutes: 12,
    usableAsExtra: false,
    linen: [
      {
        itemId: 'single_fitted_sheet',
        label: 'סדין יחיד',
        quantity: 2,
        unit: 'piece',
      },
      {
        itemId: 'single_duvet_cover',
        label: 'ציפת שמיכה יחיד',
        quantity: 2,
        unit: 'piece',
      },
      { itemId: 'pillow', label: 'כרית', quantity: 2, unit: 'piece' },
    ],
  },
  {
    id: 'single_bed',
    label: 'מיטת יחיד',
    capacity: 1,
    positions: 1,
    setupMinutes: 6,
    usableAsExtra: false,
    linen: [
      {
        itemId: 'single_fitted_sheet',
        label: 'סדין יחיד',
        quantity: 1,
        unit: 'piece',
      },
      {
        itemId: 'single_duvet_cover',
        label: 'ציפת שמיכה יחיד',
        quantity: 1,
        unit: 'piece',
      },
      { itemId: 'pillow', label: 'כרית', quantity: 1, unit: 'piece' },
    ],
  },
  {
    id: 'sofa_bed',
    label: 'ספה נפתחת',
    capacity: 2,
    positions: 1,
    setupMinutes: 15,
    usableAsExtra: true,
    linen: [
      {
        itemId: 'single_fitted_sheet',
        label: 'סדין יחיד',
        quantity: 2,
        unit: 'piece',
      },
      {
        itemId: 'single_duvet_cover',
        label: 'ציפת שמיכה יחיד',
        quantity: 2,
        unit: 'piece',
      },
      { itemId: 'pillow', label: 'כרית', quantity: 2, unit: 'piece' },
    ],
  },
  {
    id: 'folding_bed',
    label: 'מיטה מתקפלת',
    capacity: 1,
    positions: 1,
    setupMinutes: 8,
    usableAsExtra: true,
    linen: [
      {
        itemId: 'single_fitted_sheet',
        label: 'סדין יחיד',
        quantity: 1,
        unit: 'piece',
      },
      {
        itemId: 'single_duvet_cover',
        label: 'ציפת שמיכה יחיד',
        quantity: 1,
        unit: 'piece',
      },
      { itemId: 'pillow', label: 'כרית', quantity: 1, unit: 'piece' },
    ],
  },
  {
    id: 'floor_mattress',
    label: 'מזרן רצפה',
    capacity: 1,
    positions: 1,
    setupMinutes: 5,
    usableAsExtra: true,
    linen: [
      {
        itemId: 'single_fitted_sheet',
        label: 'סדין יחיד',
        quantity: 1,
        unit: 'piece',
      },
      {
        itemId: 'single_duvet_cover',
        label: 'ציפת שמיכה יחיד',
        quantity: 1,
        unit: 'piece',
      },
      { itemId: 'pillow', label: 'כרית', quantity: 1, unit: 'piece' },
    ],
  },
  {
    id: 'crib',
    label: 'לול',
    capacity: 1,
    positions: 1,
    setupMinutes: 5,
    usableAsExtra: false,
    linen: [
      { itemId: 'crib_sheet', label: 'סדין ללול', quantity: 1, unit: 'piece' },
    ],
  },
]

// ── The property ──────────────────────────────────────────────────────────

export const PROPERTY: PropertyConfiguration = {
  organizationId: ORGANIZATION_ID,
  propertyId: PROPERTY_ID,
  unitId: UNIT_ID,
  label: 'בית הזית',
  bedrooms: 5,
  bathrooms: 3,
  flags: { pool: true, outdoor: true, kosher_kitchen: true },
  beds: [{ bedTypeId: 'jewish_bed', permanent: 5, storage: 0, missing: 0 }],
  extraSleepingBedTypeId: 'floor_mattress',
  maximumSleepingPlaces: null,
}

// ── Requirement rules ─────────────────────────────────────────────────────

function rule(overrides: Partial<PreparationRule>): PreparationRule {
  return {
    id: 'rule',
    organizationId: ORGANIZATION_ID,
    category: 'consumables',
    itemId: 'item',
    label: 'פריט',
    unit: 'piece',
    quantity: { basis: 'guests' },
    condition: null,
    buffer: null,
    section: 'kitchen',
    requiresPhoto: false,
    instructions: null,
    minutesPerUnit: 0,
    ...FOREVER,
    ...overrides,
  }
}

export const RULES: readonly PreparationRule[] = [
  rule({
    id: 'towel_bath',
    category: 'towels',
    itemId: 'bath_towel',
    label: 'מגבת רחצה',
    section: 'towels',
    quantity: { basis: 'guests' },
    minutesPerUnit: 1,
  }),
  rule({
    id: 'towel_face',
    category: 'towels',
    itemId: 'face_towel',
    label: 'מגבת פנים',
    section: 'towels',
    quantity: { basis: 'guests' },
    minutesPerUnit: 1,
  }),
  rule({
    // One per couple. The divisor is the whole of "per couple".
    id: 'towel_hand',
    category: 'towels',
    itemId: 'hand_towel',
    label: 'מגבת ידיים',
    section: 'towels',
    quantity: { basis: 'guests', divisor: 2 },
    minutesPerUnit: 1,
  }),
  rule({
    id: 'towel_pool',
    category: 'towels',
    itemId: 'pool_towel',
    label: 'מגבת בריכה',
    section: 'pool',
    quantity: { basis: 'guests' },
    condition: { kind: 'flag', flag: 'pool', equals: true },
    minutesPerUnit: 1,
  }),
  rule({
    id: 'toilet_paper_large',
    category: 'consumables',
    itemId: 'toilet_paper',
    label: 'נייר טואלט',
    unit: 'pack',
    section: 'bathrooms',
    quantity: { basis: 'booking', factor: 4 },
    condition: {
      kind: 'compare',
      basis: 'guests',
      comparator: 'gte',
      value: 20,
    },
  }),
  rule({
    id: 'cleaning_staff_large',
    category: 'cleaning',
    itemId: 'cleaning_staff',
    label: 'איש צוות ניקיון',
    unit: 'person',
    section: 'cleaning',
    quantity: { basis: 'booking', factor: 2 },
    condition: {
      kind: 'compare',
      basis: 'guests',
      comparator: 'gte',
      value: 25,
    },
  }),
  rule({
    // Plates plus twenty percent, because plates break and guests take two.
    id: 'plates',
    category: 'kitchen',
    itemId: 'plate',
    label: 'צלחת',
    section: 'kitchen',
    quantity: { basis: 'guests' },
    buffer: { kind: 'percent', percent: 20 },
    minutesPerUnit: 1,
  }),
  rule({
    id: 'deep_clean',
    category: 'cleaning',
    itemId: 'deep_clean',
    label: 'ניקיון יסודי',
    unit: 'hour',
    section: 'cleaning',
    quantity: { basis: 'bedrooms' },
    minutesPerUnit: 30,
  }),
  rule({
    id: 'bathroom_kit',
    category: 'bathrooms',
    itemId: 'bathroom_kit',
    label: 'ערכת אמבטיה',
    section: 'bathrooms',
    quantity: { basis: 'bathrooms' },
    requiresPhoto: true,
    instructions: 'לצלם כל חדר רחצה לאחר הסידור',
    minutesPerUnit: 10,
  }),
  rule({
    id: 'final_check',
    category: 'special_setup',
    itemId: 'final_check',
    label: 'בדיקה סופית',
    section: 'final_inspection',
    quantity: { basis: 'booking' },
    requiresPhoto: true,
    minutesPerUnit: 20,
  }),
]

// ── The Shabbat template ──────────────────────────────────────────────────

export const SHABBAT_TEMPLATE: EventTemplate = {
  id: 'template_shabbat',
  organizationId: ORGANIZATION_ID,
  eventType: 'shabbat',
  label: 'שבת',
  sections: ['event_setup'],
  rules: [
    rule({
      id: 'shabbat_urn',
      category: 'event',
      itemId: 'urn',
      label: 'מיחם',
      section: 'event_setup',
      quantity: { basis: 'booking' },
      minutesPerUnit: 10,
    }),
    rule({
      // The second urn. An ordinary conditional rule that merges with the
      // first, not a special case anywhere in the engine.
      id: 'shabbat_urn_second',
      category: 'event',
      itemId: 'urn',
      label: 'מיחם',
      section: 'event_setup',
      quantity: { basis: 'booking' },
      condition: {
        kind: 'compare',
        basis: 'guests',
        comparator: 'gte',
        value: 20,
      },
      minutesPerUnit: 10,
    }),
    rule({
      id: 'shabbat_hotplate',
      category: 'event',
      itemId: 'hotplate',
      label: 'פלטת שבת',
      section: 'event_setup',
      quantity: { basis: 'guests', divisor: 15 },
      minutesPerUnit: 5,
    }),
    rule({
      id: 'shabbat_candles',
      category: 'event',
      itemId: 'candle',
      label: 'נר שבת',
      section: 'event_setup',
      quantity: { basis: 'booking', factor: 2 },
    }),
    rule({
      id: 'shabbat_tables',
      category: 'event',
      itemId: 'table',
      label: 'שולחן',
      section: 'event_setup',
      quantity: { basis: 'guests', divisor: 8 },
      minutesPerUnit: 5,
    }),
    rule({
      id: 'shabbat_chairs',
      category: 'event',
      itemId: 'chair',
      label: 'כיסא',
      section: 'event_setup',
      quantity: { basis: 'guests' },
      minutesPerUnit: 1,
    }),
    rule({
      id: 'shabbat_kiddush_cup',
      category: 'event',
      itemId: 'kiddush_cup',
      label: 'גביע קידוש',
      section: 'event_setup',
      quantity: { basis: 'booking' },
    }),
    rule({
      id: 'shabbat_tablecloth',
      category: 'event',
      itemId: 'tablecloth',
      label: 'מפת שולחן',
      section: 'event_setup',
      quantity: { basis: 'guests', divisor: 8 },
    }),
  ],
}

// ── Costs ─────────────────────────────────────────────────────────────────

export const VARIABLE_COSTS: readonly VariableCostRule[] = [
  {
    id: 'vc_cleaning',
    organizationId: ORGANIZATION_ID,
    key: 'cleaning',
    label: 'ניקיון',
    condition: null,
    ...FOREVER,
    // 350 + 15 per guest above ten + 20 per extra mattress.
    formula: {
      kind: 'sum',
      of: [
        { kind: 'fixed', amount: 35_000 },
        {
          kind: 'above_threshold',
          basis: 'guests',
          threshold: 10,
          unitAmount: 1_500,
        },
        { kind: 'per_unit', basis: 'extra_beds', unitAmount: 2_000 },
      ],
    },
  },
  {
    id: 'vc_laundry',
    organizationId: ORGANIZATION_ID,
    key: 'laundry',
    label: 'כביסה',
    condition: null,
    ...FOREVER,
    formula: {
      kind: 'per_requirement',
      itemId: 'single_fitted_sheet',
      unitAmount: 1_200,
    },
  },
  {
    id: 'vc_towels',
    organizationId: ORGANIZATION_ID,
    key: 'towels',
    label: 'מגבות',
    condition: null,
    ...FOREVER,
    formula: { kind: 'per_requirement', category: 'towels', unitAmount: 400 },
  },
  {
    id: 'vc_consumables',
    organizationId: ORGANIZATION_ID,
    key: 'consumables',
    label: 'מתכלים',
    condition: null,
    ...FOREVER,
    formula: { kind: 'per_unit', basis: 'guests', unitAmount: 800 },
  },
  {
    id: 'vc_pool_heating',
    organizationId: ORGANIZATION_ID,
    key: 'pool_heating',
    label: 'חימום בריכה',
    condition: { kind: 'flag', flag: 'pool', equals: true },
    ...FOREVER,
    formula: { kind: 'per_unit', basis: 'booking', unitAmount: 35_000 },
  },
]

export const FIXED_COSTS: readonly FixedCost[] = [
  {
    id: 'fc_rent',
    organizationId: ORGANIZATION_ID,
    key: 'rent',
    label: 'שכר דירה',
    scope: { kind: 'property', propertyId: PROPERTY_ID },
    amount: 1_200_000,
    frequency: 'monthly',
    allocation: 'per_calendar_day',
    sharing: null,
    ...FOREVER,
  },
  {
    id: 'fc_municipal',
    organizationId: ORGANIZATION_ID,
    key: 'municipal_tax',
    label: 'ארנונה',
    scope: { kind: 'property', propertyId: PROPERTY_ID },
    amount: 180_000,
    frequency: 'monthly',
    allocation: 'per_occupied_night',
    sharing: null,
    ...FOREVER,
  },
  {
    id: 'fc_water',
    organizationId: ORGANIZATION_ID,
    key: 'water',
    label: 'מים',
    scope: { kind: 'property', propertyId: PROPERTY_ID },
    amount: 90_000,
    frequency: 'monthly',
    allocation: 'per_guest',
    sharing: null,
    ...FOREVER,
  },
  {
    id: 'fc_insurance',
    organizationId: ORGANIZATION_ID,
    key: 'insurance',
    label: 'ביטוח',
    scope: { kind: 'organization' },
    amount: 600_000,
    frequency: 'annual',
    allocation: 'per_booking',
    sharing: {
      method: 'equal',
      shares: [
        { propertyId: PROPERTY_ID, weight: 0 },
        { propertyId: OTHER_PROPERTY_ID, weight: 0 },
      ],
    },
    ...FOREVER,
  },
  {
    id: 'fc_software',
    organizationId: ORGANIZATION_ID,
    key: 'software',
    label: 'תוכנה',
    scope: { kind: 'organization' },
    amount: 45_000,
    frequency: 'monthly',
    allocation: 'per_property_share',
    sharing: {
      method: 'by_revenue',
      shares: [
        { propertyId: PROPERTY_ID, weight: 3 },
        { propertyId: OTHER_PROPERTY_ID, weight: 1 },
      ],
    },
    ...FOREVER,
  },
]

export const COMMISSION_RULES: readonly CommissionRule[] = [
  {
    id: 'commission_standard',
    organizationId: ORGANIZATION_ID,
    basis: 'gross_revenue',
    rateBasisPoints: 1_000,
    ...FOREVER,
  },
]

export const COMPLEXITY: ComplexityConfiguration = {
  perGuest: 2,
  perBedroom: 3,
  perBathroom: 4,
  perExtraBed: 1,
  perEventType: { shabbat: 20, wedding: 40 },
  perFlag: { pool: 10, outdoor: 5, kosher_kitchen: 0 },
  perExtraItem: 2,
  scorePerStaff: 50,
  minimumStaff: 1,
  minutesPerPoint: 3,
  minimumMinutes: 120,
  hourlyRate: 5_500,
}

export const READINESS_POLICY: ReadinessPolicy = {
  criticalPercent: 70,
  criticalHours: 4,
  warningPercent: 50,
}

export const SECTION_LABELS: Readonly<Record<PlanSectionKey, string>> = {
  cleaning: 'ניקיון',
  bedrooms: 'חדרי שינה',
  extra_sleeping: 'מקומות שינה נוספים',
  bathrooms: 'חדרי רחצה',
  towels: 'מגבות',
  kitchen: 'מטבח',
  event_setup: 'הקמת אירוע',
  outdoor: 'חוץ',
  pool: 'בריכה',
  final_inspection: 'בדיקה סופית',
}

// ── Assembled ─────────────────────────────────────────────────────────────

export function exampleCatalogue(
  overrides: Partial<PreparationCatalogue> = {},
): PreparationCatalogue {
  return {
    organizationId: ORGANIZATION_ID,
    bedTypes: BED_TYPES,
    rules: RULES,
    eventTemplates: [SHABBAT_TEMPLATE],
    propertyConfiguration: PROPERTY,
    variableCosts: VARIABLE_COSTS,
    fixedCosts: FIXED_COSTS,
    commissionRules: COMMISSION_RULES,
    complexity: COMPLEXITY,
    readinessPolicy: READINESS_POLICY,
    sectionLabels: SECTION_LABELS,
    ...overrides,
  }
}

export function exampleBooking(
  overrides: Partial<PreparationBooking> = {},
): PreparationBooking {
  return {
    id: BOOKING_ID,
    organizationId: ORGANIZATION_ID,
    propertyId: PROPERTY_ID,
    unitId: UNIT_ID,
    stay: { checkIn: '2026-09-04', checkOut: '2026-09-06' },
    guests: 25,
    adults: 20,
    children: 5,
    eventType: 'shabbat',
    extras: [],
    arrivalAt: '2026-09-04T14:00:00.000Z',
    priceLines: [
      {
        kind: 'accommodation',
        label: 'לינה',
        amount: 600_000,
        quantity: 2,
        date: null,
      },
      {
        kind: 'cleaning_fee',
        label: 'דמי ניקיון',
        amount: 40_000,
        quantity: 1,
        date: null,
      },
    ],
    ...overrides,
  }
}

export function exampleStock(
  overrides: readonly Partial<StockLevel>[] = [],
): readonly StockLevel[] {
  const base: readonly StockLevel[] = [
    {
      itemId: 'pillow',
      label: 'כרית',
      location: { kind: 'property', propertyId: PROPERTY_ID },
      onHand: 22,
      reserved: 0,
      safetyStock: 4,
    },
    {
      itemId: 'single_fitted_sheet',
      label: 'סדין יחיד',
      location: { kind: 'property', propertyId: PROPERTY_ID },
      onHand: 40,
      reserved: 0,
      safetyStock: 6,
    },
    {
      itemId: 'bath_towel',
      label: 'מגבת רחצה',
      location: { kind: 'property', propertyId: PROPERTY_ID },
      onHand: 30,
      reserved: 0,
      safetyStock: 4,
    },
  ]

  return [...base, ...(overrides as readonly StockLevel[])]
}
