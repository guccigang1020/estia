/**
 * Hebrew for every vocabulary in the module.
 *
 * One place, so a status that reads "פורסם" on the overview cannot read
 * "באוויר" on the versions screen. `Record<T, string>` rather than a lookup
 * with a fallback: adding a member to a tuple in `types.ts` breaks the build
 * here instead of rendering a raw enum value on somebody's screen.
 */

import type { SiteDesign } from './types'
import type {
  SiteBookingRequestStatus,
  SiteDomainStatus,
  SiteFactSource,
  SiteFindingSeverity,
  SiteFindingStatus,
  SiteGenerationStatus,
  SitePageKind,
  SiteQualityKind,
  SiteSectionKind,
  SiteStatus,
} from './types'

export const SITE_STATUS_LABEL: Readonly<Record<SiteStatus, string>> =
  Object.freeze({
    draft: 'טיוטה',
    published: 'באוויר',
    unpublished: 'הורד מהאוויר',
  })

/** What each status means for somebody who is not sure. */
export const SITE_STATUS_SUMMARY: Readonly<Record<SiteStatus, string>> =
  Object.freeze({
    draft: 'האתר קיים רק אצלכם. אף אחד מבחוץ לא ראה אותו.',
    published:
      'האתר באוויר ומבקרים רואים את הגרסה שפורסמה — לא את מה שאתם עורכים עכשיו.',
    unpublished:
      'האתר הורד מהאוויר. כל הגרסאות נשמרו ואפשר להעלות אותו שוב בכל רגע.',
  })

export const SITE_PAGE_KIND_LABEL: Readonly<Record<SitePageKind, string>> =
  Object.freeze({
    home: 'עמוד בית',
    property: 'הנכס',
    units: 'היחידות',
    amenities: 'מה יש במקום',
    gallery: 'גלריה',
    location: 'מיקום והגעה',
    booking: 'הזמנה',
    contact: 'יצירת קשר',
    policy: 'תנאים וביטולים',
    custom: 'עמוד חופשי',
  })

export const SITE_SECTION_KIND_LABEL: Readonly<
  Record<SiteSectionKind, string>
> = Object.freeze({
  hero: 'פתיחה',
  rich_text: 'טקסט',
  property_intro: 'הצגת הנכס',
  unit_grid: 'רשימת יחידות',
  amenity_list: 'שירותים ומתקנים',
  gallery: 'גלריית תמונות',
  location_map: 'מיקום',
  contact_details: 'פרטי קשר',
  booking_widget: 'טופס הזמנה',
  faq: 'שאלות נפוצות',
  cta: 'קריאה לפעולה',
})

/**
 * WHERE A SENTENCE CAME FROM, IN WORDS A PERSON READS.
 *
 * Shown beside every claim in the studio, which is the point of the whole
 * design being visible rather than internal: somebody editing a page can see
 * that "עד 6 אורחים" came from the unit record and "אחוזה שקטה בגליל" was
 * written by a person, and can tell at a glance which sentences the system
 * stands behind and which they do.
 */
export const FACT_SOURCE_LABEL: Readonly<Record<SiteFactSource, string>> =
  Object.freeze({
    organization: 'שם העסק',
    property: 'נתוני הנכס',
    unit: 'נתוני היחידה',
    amenity: 'רשימת המתקנים',
    pricing: 'מנוע התמחור',
    availability: 'מנוע הזמינות',
    media: 'ספריית המדיה',
    authored: 'נכתב על ידיכם',
  })

export const DOMAIN_STATUS_LABEL: Readonly<Record<SiteDomainStatus, string>> =
  Object.freeze({
    pending: 'ממתין לאימות',
    verifying: 'באימות',
    verified: 'מאומת',
    failed: 'האימות נכשל',
    released: 'שוחרר',
  })

export const QUALITY_KIND_LABEL: Readonly<Record<SiteQualityKind, string>> =
  Object.freeze({
    content: 'תוכן',
    conversion: 'המרה',
    technical: 'טכני',
    pre_publish: 'בדיקה לפני פרסום',
  })

export const FINDING_SEVERITY_LABEL: Readonly<
  Record<SiteFindingSeverity, string>
> = Object.freeze({
  blocker: 'חוסם פרסום',
  warning: 'שווה לתקן',
  advice: 'הצעה',
})

export const FINDING_STATUS_LABEL: Readonly<Record<SiteFindingStatus, string>> =
  Object.freeze({
    open: 'פתוח',
    accepted: 'אושר כפי שהוא',
    dismissed: 'נדחה',
    resolved: 'טופל',
    // The one that matters. Never "0" and never "לא ידוע" — the check ran and
    // declined to score, and the label says exactly that.
    not_assessed: 'לא נבדק',
  })

export const GENERATION_STATUS_LABEL: Readonly<
  Record<SiteGenerationStatus, string>
> = Object.freeze({
  requested: 'נשלח',
  refused: 'המנוע סירב',
  drafted: 'התקבלו טיוטות',
  accepted: 'אושר ונכתב',
  discarded: 'נזרק',
})

export const BOOKING_REQUEST_STATUS_LABEL: Readonly<
  Record<SiteBookingRequestStatus, string>
> = Object.freeze({
  new: 'חדשה',
  contacted: 'יצרנו קשר',
  converted: 'הפכה להזמנה',
  declined: 'נדחתה',
  expired: 'פג תוקף',
})

/* ---------------------------------------------------------------- design -- */

/**
 * The design vocabulary, in Hebrew.
 *
 * Here rather than beside the tokens in `design.ts`, for the reason the header
 * gives: one place for every user-visible word in the module. `design.ts` owns
 * the COLOURS, which are literals a stylesheet consumes; this owns the NAMES,
 * which a person reads.
 */
export const PALETTE_LABEL: Readonly<Record<SiteDesign['palette'], string>> =
  Object.freeze({
    sand: 'חול',
    olive: 'זית',
    sea: 'ים',
    stone: 'אבן',
    night: 'לילה',
  })

export const FONT_LABEL: Readonly<Record<SiteDesign['headingFont'], string>> =
  Object.freeze({
    system: 'ברירת מחדל',
    serif: 'מסורתי',
    display: 'תצוגה',
  })

export const RADIUS_LABEL: Readonly<Record<SiteDesign['radius'], string>> =
  Object.freeze({ sharp: 'פינות חדות', soft: 'פינות רכות', round: 'עגול' })

export const DENSITY_LABEL: Readonly<Record<SiteDesign['density'], string>> =
  Object.freeze({ comfortable: 'מרווח', compact: 'צפוף' })
