/**
 * The template library: reusable automation definitions ESTIA ships with.
 *
 * A blank rule builder is a feature nobody uses. What a hotelier wants on the
 * first day is the eleven rules every hospitality business ends up writing by
 * hand, already worded, already pointed at the right event, and already off
 * where being on would be presumptuous.
 *
 * ── Every trigger here is a member of the frozen catalogue ────────────────
 *
 * `when` is typed `DomainEventName`, so a template naming an event that does
 * not exist does not compile. That is not a formality: the reason the booking
 * lifecycle is enumerated in `contracts/events.ts` rather than collapsed into
 * `booking.status_changed` is precisely so that "the door code goes out when
 * housekeeping signs the unit off" is one trigger and not a filter over every
 * transition — and a library that invented its own names would throw that away.
 *
 * ── `enabled` is a real decision, made per template ───────────────────────
 *
 * Anything that speaks to a guest, spends money or issues a document ships
 * **off**. Anything that tells the business's own staff something they would
 * want to know ships **on**. The dividing line is whether being wrong is
 * embarrassing in front of a customer: a redundant internal notification costs
 * nothing, and an unwanted WhatsApp to somebody's guest on their first day
 * with ESTIA costs the account.
 *
 * ── What a template is not ────────────────────────────────────────────────
 *
 * It is not an installed rule, and `enabled` here is not this organization's
 * answer. This file is a catalogue of definitions, in the spirit of
 * `plans/catalog.ts` — the state ESTIA ships, which stands until a business
 * decides otherwise.
 *
 * Where that decision lives is `automation_rules` (0067) and how it is laid
 * over this file is `state.ts`, whose one rule is worth repeating here: **an
 * absent row is not a disabled rule**. A business that has never opened the
 * automation screen has no rows, and the five internal alerts below are on for
 * it — which is the whole reason they ship on.
 *
 * Editing a rule's shape is still not offered and is not an oversight: a
 * customer chooses among these and tunes the numbers `parameters.ts` declares.
 * Authoring conditions over arbitrary facts is a scripting language nobody can
 * audit, which `types.ts` opens by refusing.
 */

import type { DomainEventName } from '../contracts/events'

import type { AutomationRule } from './types'

/** How the library is grouped on screen. Hebrew labels live in `LIBRARY_CATEGORY_LABEL`. */
export const TEMPLATE_CATEGORIES = [
  'stay',
  'money',
  'operations',
  'governance',
] as const

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

export const TEMPLATE_CATEGORY_LABEL: Record<TemplateCategory, string> = {
  stay: 'מסלול השהייה',
  money: 'כסף',
  operations: 'תפעול',
  governance: 'בקרה ואבטחה',
}

export interface AutomationTemplate {
  category: TemplateCategory
  /** Why a business would want this, in one sentence of business language. */
  rationale: string
  /**
   * The facts the event must carry for the IF clause to be answerable.
   *
   * Derived from the conditions rather than typed twice — see `requiredFacts`
   * below — and surfaced because a rule whose event never carries `nights` is
   * a rule that will never fire, which is worth knowing before enabling it.
   */
  rule: AutomationRule
}

const TEMPLATES: readonly AutomationTemplate[] = [
  {
    category: 'stay',
    rationale:
      'הזמנה שאושרה היא הרגע שבו התפעול צריך לדעת עליה, ולפני זה אין מה להכין.',
    rule: {
      id: 'confirmed-notify-and-prepare',
      name: 'הזמנה אושרה — עדכון הצוות ופתיחת הכנה',
      description:
        'ברגע שההזמנה מאושרת נשלחת התראה לצוות ונפתחת משימת הכנה ליחידה.',
      when: 'booking.confirmed',
      conditions: [],
      actions: [
        { kind: 'notify_team', note: 'הצוות עודכן על הזמנה חדשה שאושרה' },
        { kind: 'create_task', note: 'נפתחה משימת הכנה ליחידה' },
      ],
      enabled: true,
    },
  },
  {
    category: 'stay',
    rationale:
      'רוב שאלות האורח לפני ההגעה הן אותן שאלות. הודעה אחת בזמן הנכון מונעת אותן.',
    rule: {
      id: 'pre-arrival-instructions',
      name: 'לפני הגעה — הוראות הגעה לאורח',
      description:
        'הודעה לאורח עם הוראות הגעה, שעת הכניסה ופרטי יצירת קשר. כבויה עד שמאשרים את הנוסח.',
      when: 'booking.pre_arrival',
      conditions: [],
      actions: [
        { kind: 'message_guest', note: 'נשלחו לאורח הוראות הגעה לקראת השהייה' },
      ],
      enabled: false,
    },
  },
  {
    category: 'stay',
    rationale:
      'קוד הדלת יוצא רק אחרי שמשק הבית סגר את היחידה — לא לפי שעה קבועה שאיש לא בדק.',
    rule: {
      id: 'door-code-after-signoff',
      name: 'היחידה מוכנה — שליחת קוד כניסה',
      description: 'משק הבית סימן שהיחידה מוכנה, ורק אז נשלח לאורח קוד הכניסה.',
      when: 'booking.ready_for_check_in',
      conditions: [],
      actions: [
        { kind: 'message_guest', note: 'נשלח לאורח קוד הכניסה ליחידה' },
      ],
      enabled: false,
    },
  },
  {
    category: 'stay',
    rationale: 'בדיקת יחידה אחרי עזיבה היא מה שמונע ויכוח על פיקדון שבוע אחרי.',
    rule: {
      id: 'checkout-inspection',
      name: 'עזיבה — פתיחת בדיקת יחידה',
      description: 'עם העזיבה נפתחת משימת בדיקה ליחידה לפני האורח הבא.',
      when: 'booking.checked_out',
      conditions: [],
      actions: [{ kind: 'create_task', note: 'נפתחה משימת בדיקה אחרי עזיבה' }],
      enabled: true,
    },
  },
  {
    category: 'stay',
    rationale:
      'חוות דעת נאספות אחרי שהייה שהסתיימה כמו שצריך, ולא אחרי כל הזמנה שנסגרה.',
    rule: {
      id: 'review-request-after-stay',
      name: 'שהייה הסתיימה — בקשת חוות דעת',
      description:
        'בקשה לחוות דעת נשלחת רק לשהייה של שני לילות ומעלה, כדי לא לבקש על לילה בודד.',
      when: 'booking.completed',
      conditions: [{ kind: 'at_least', field: 'nights', value: 2 }],
      actions: [{ kind: 'request_review', note: 'נשלחה לאורח בקשה לחוות דעת' }],
      enabled: false,
    },
  },
  {
    category: 'money',
    rationale: 'תשלום שנכשל שאיש לא ראה הופך להזמנה בלי כיסוי ביום ההגעה.',
    rule: {
      id: 'payment-failed-alert',
      name: 'תשלום נכשל — התראה לצוות',
      description: 'כל כישלון סליקה מגיע לצוות מיד, ולא מחכה לדוח בסוף החודש.',
      when: 'payment.failed',
      conditions: [],
      actions: [{ kind: 'notify_team', note: 'הצוות עודכן על כישלון בסליקה' }],
      enabled: true,
    },
  },
  {
    category: 'money',
    rationale:
      'סולק שלא השיב הוא לא תשלום שנכשל. מישהו חייב לברר האם הכרטיס חויב.',
    rule: {
      id: 'payment-unknown-alert',
      name: 'תוצאת סליקה לא ידועה — בירור ידני',
      description:
        'לא ידוע אם החיוב בוצע. נפתחת בקשת אישור כדי שהבירור לא יישכח.',
      when: 'payment.outcome_unknown',
      conditions: [],
      actions: [
        { kind: 'notify_team', note: 'הצוות עודכן על סליקה בלי תשובה מהסולק' },
        { kind: 'request_approval', note: 'נפתחה בקשת בירור לתוצאת הסליקה' },
      ],
      enabled: true,
    },
  },
  {
    category: 'money',
    rationale: 'מקדמה שהתקבלה היא מסמך שצריך לצאת, ולא פתק לעצמך.',
    rule: {
      id: 'deposit-paid-invoice',
      name: 'מקדמה שולמה — הפקת חשבונית',
      description:
        'עם קליטת המקדמה מופקת חשבונית. כבויה עד שמוודאים שהסדרה והמספור נכונים.',
      when: 'booking.deposit_paid',
      conditions: [],
      actions: [{ kind: 'issue_invoice', note: 'הופקה חשבונית עבור המקדמה' }],
      enabled: false,
    },
  },
  {
    category: 'money',
    rationale:
      'הצעת מחיר שהתקבלה מתקררת תוך שעות. קישור לתשלום באותו רגע הוא ההפרש.',
    rule: {
      id: 'quote-accepted-payment-link',
      name: 'הצעת מחיר התקבלה — שליחת קישור לתשלום',
      description:
        'מיד עם קבלת ההצעה נשלח קישור לתשלום. כבויה עד שמאשרים את הנוסח והסכום.',
      when: 'quote.accepted',
      conditions: [],
      actions: [
        { kind: 'send_payment_link', note: 'נשלח לאורח קישור לתשלום ההצעה' },
      ],
      enabled: false,
    },
  },
  {
    category: 'operations',
    rationale: 'משימה שאיחרה היא ניקיון שלא קרה, ואת זה מגלים כשהאורח בדלת.',
    rule: {
      id: 'task-overdue-alert',
      name: 'משימה באיחור — התראה לצוות',
      description: 'משימה שעברה את מועדה מדווחת לצוות מיד.',
      when: 'task.overdue',
      conditions: [],
      actions: [{ kind: 'notify_team', note: 'הצוות עודכן על משימה שאיחרה' }],
      enabled: true,
    },
  },
  {
    category: 'operations',
    rationale: 'תקלה שנפתחה בלי משימה מאחוריה נשארת פתוחה עד שמישהו נזכר בה.',
    rule: {
      id: 'incident-opened-task',
      name: 'תקלה נפתחה — פתיחת משימת טיפול',
      description: 'כל תקלה מייצרת משימה עם אחראי, ולא רק רשומה ברשימה.',
      when: 'incident.opened',
      conditions: [],
      actions: [
        { kind: 'create_task', note: 'נפתחה משימת טיפול לתקלה' },
        { kind: 'notify_team', note: 'הצוות עודכן על פתיחת תקלה' },
      ],
      enabled: true,
    },
  },
  {
    category: 'operations',
    rationale:
      'ערוץ שהפסיק להסתנכרן ימכור תאריך שכבר נמכר. זו התראה דחופה ולא שורת לוג.',
    rule: {
      id: 'channel-sync-failed-alert',
      name: 'סנכרון ערוץ נכשל — התראה מיידית',
      description:
        'כישלון סנכרון מול ערוץ הפצה מגיע לצוות מיד, לפני שנוצרת הזמנה כפולה.',
      when: 'channel.sync_failed',
      conditions: [],
      actions: [
        { kind: 'notify_team', note: 'הצוות עודכן על כישלון סנכרון ערוץ' },
      ],
      enabled: true,
    },
  },
  {
    category: 'governance',
    rationale: 'הרחבת הרשאות היא הפעולה שהכי כדאי שמישהו נוסף יראה, ובזמן אמת.',
    rule: {
      id: 'permission-escalation-alert',
      name: 'הרשאות הורחבו — התראה לבעלים',
      description: 'כל הרחבת הרשאות מדווחת מיד, גם כשהיא לגיטימית.',
      when: 'security.permission_escalated',
      conditions: [],
      actions: [{ kind: 'notify_team', note: 'דווח על הרחבת הרשאות בארגון' }],
      enabled: true,
    },
  },
  {
    category: 'governance',
    rationale:
      'ייצוא המוני של נתוני אורחים הוא או גיבוי מתוכנן או אירוע אבטחה. ההבדל הוא מי ידע עליו.',
    rule: {
      id: 'bulk-export-alert',
      name: 'ייצוא המוני — התראה לבעלים',
      description: 'ייצוא נתונים בהיקף חריג מדווח לבעלים באותו רגע.',
      when: 'security.bulk_export',
      conditions: [],
      actions: [
        { kind: 'notify_team', note: 'דווח על ייצוא נתונים בהיקף חריג' },
      ],
      enabled: true,
    },
  },
]

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = TEMPLATES

/** The facts a template's IF clause needs the event to carry. */
export function requiredFacts(template: AutomationTemplate): readonly string[] {
  return [
    ...new Set(template.rule.conditions.map((condition) => condition.field)),
  ]
}

/** Every trigger the library listens to, deduplicated, in catalogue terms. */
export function libraryTriggers(): readonly DomainEventName[] {
  return [...new Set(AUTOMATION_TEMPLATES.map((entry) => entry.rule.when))]
}

export function templatesFor(
  category: TemplateCategory,
): readonly AutomationTemplate[] {
  return AUTOMATION_TEMPLATES.filter((entry) => entry.category === category)
}

export function templateById(id: string): AutomationTemplate | null {
  return AUTOMATION_TEMPLATES.find((entry) => entry.rule.id === id) ?? null
}
