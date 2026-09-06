/**
 * Which domain events reach a person, and which person.
 *
 * This is the routing table, and it is DATA rather than a switch statement —
 * `contracts/events.ts` says so in its own comment about `ALERT_EVENTS`
 * ("kept as data so notification routing does not become a growing switch
 * statement that somebody forgets to extend"). Everything here is keyed by a
 * `DomainEventName`, so a name that is not in the frozen catalogue does not
 * compile.
 *
 * ── An event with no entry is not a bug ───────────────────────────────────
 *
 * Most of the 130 events are for automations, dashboards and the audit trail.
 * `booking.in_house` is a state a screen reads; it is not a message. Routing
 * an event nobody asked for is how a product teaches its users to ignore it,
 * so the default is silence and an entry here is a deliberate claim that a
 * human needs to know.
 *
 * ── Every entry names a GRANT, and the grant is the whole audience rule ───
 *
 * There is no role list anywhere in this file. `requiredGrant` is fed to
 * `can(actor, grant, resource)`, which settles, in one call and in this order:
 * membership status, tenant, permission, plan entitlement, and scope. That is
 * why a property manager holding two properties is never told about the third
 * — not because this table says so, but because `isWithinScope` says so, and
 * it is the same function every screen in the product already asks.
 *
 * It is also how "a module that is off produces no notifications about
 * itself" is achieved without a second capability check: `laundry.view` is
 * mapped to the `laundry` entitlement in `plans/entitlements.ts`, so an
 * organization without the module has nobody who holds the grant, and the
 * routing plan comes back with zero recipients and a stated reason.
 *
 * And "a person who cannot see payments is never told about one" is the same
 * sentence read the other way: `payment.received` requires `payment.view`, and
 * a cleaner does not hold it.
 */

import type { Grant } from '../authz/permissions'
import type { ResourceFamily } from '../authz/can'
import { ALERT_EVENTS, type DomainEventName } from '../contracts/events'

import type { NotificationCategory, NotificationSeverity } from './types'

/* ------------------------------------------------------------------ shape -- */

/**
 * Whom an event is addressed to.
 *
 * Almost everything is `grant_holders`. `actor` exists for the small family of
 * events that are about the person who caused them — a sign-in from a new
 * device is a message to whoever signed in, and routing it to everybody
 * holding `audit.view` would be a security feature that leaks a colleague's
 * travel schedule.
 */
export type NotificationAudience = 'grant_holders' | 'actor'

export interface NotificationSpec {
  category: NotificationCategory
  severity: NotificationSeverity
  /**
   * The grant a person must hold to be told. Fed to `can()` with the event's
   * property, so it decides permission, plan and scope in one question.
   *
   * `null` only for `audience: 'actor'`, and it is not a hole. "Somebody
   * signed in to YOUR account from a new device" is not gated by an
   * organizational right — a general manager holds no `organization.view`, a
   * cleaner holds four grants in total, and requiring one would mean the
   * people least able to notice an account takeover are the ones never told
   * about it. The gate for those events is identity: it is your account, and
   * `routing.ts` still checks membership and tenant before writing anything.
   */
  requiredGrant: Grant | null
  /**
   * Which family the resource belongs to, so a membership with a per-family
   * scope override is narrowed correctly. Omitted where the resource is the
   * organization itself.
   */
  family?: ResourceFamily
  audience: NotificationAudience
  /**
   * Tell the person who caused it.
   *
   * `false` almost everywhere, and it is not a nicety: a manager who confirms
   * a booking and is immediately told that a booking was confirmed learns to
   * dismiss the bell without reading it, and the next thing they dismiss
   * without reading is the payment that failed.
   */
  notifyActor?: boolean
  /** Eligible for escalation when nobody acts. See `escalation.ts`. */
  escalates?: boolean
  /** Hebrew. One line, in the past tense, naming the thing that happened. */
  title: string
  /** Hebrew. One or two lines saying what it means and what to do about it. */
  body: string
  /**
   * Where the person goes to act, as a relative path. Relative always: an
   * absolute URL in a stored message is how a staging host ends up in
   * somebody's inbox, and 0043 has a check constraint that refuses one.
   */
  href?: (resourceId: string | null) => string | null
}

/* ------------------------------------------------------------------ paths -- */

const bookingHref = (id: string | null) =>
  id ? `/bookings/${id}` : '/bookings'
const guestHref = (id: string | null) => (id ? `/guests/${id}` : '/guests')
const taskHref = (id: string | null) => (id ? `/tasks/${id}` : '/tasks')
const incidentHref = (id: string | null) =>
  id ? `/incidents/${id}` : '/incidents'
const financeHref = () => '/finance'
const inventoryHref = () => '/inventory'
const laundryHref = () => '/laundry'
const storeHref = (id: string | null) => (id ? `/store/orders/${id}` : '/store')
const actionCentreHref = () => '/action-center'

/* -------------------------------------------------------------- the table -- */

export const NOTIFICATION_CATALOGUE: Partial<
  Record<DomainEventName, NotificationSpec>
> = {
  /* ── Money. The family with the shortest fuse. ─────────────────────────── */

  'payment.received': {
    category: 'money',
    severity: 'info',
    requiredGrant: 'payment.view',
    family: 'finance',
    audience: 'grant_holders',
    title: 'התקבל תשלום',
    body: 'תשלום נקלט והזמנה עודכנה. אין צורך בפעולה — הפרטים בכרטיס ההזמנה.',
    href: financeHref,
  },
  'payment.failed': {
    category: 'money',
    severity: 'urgent',
    requiredGrant: 'payment.view',
    family: 'finance',
    audience: 'grant_holders',
    escalates: true,
    title: 'תשלום נכשל',
    body: 'חיוב לא עבר. ההזמנה עדיין לא מכוסה — צרו קשר עם האורח או שלחו קישור תשלום חדש.',
    href: financeHref,
  },
  /**
   * The one `contracts/events.ts` calls "a queue a person works, not a log
   * line". `critical`, and it escalates, because the alternative to somebody
   * reconciling it is a guest who paid and has no booking.
   */
  'payment.outcome_unknown': {
    category: 'money',
    severity: 'critical',
    requiredGrant: 'payment.view',
    family: 'finance',
    audience: 'grant_holders',
    escalates: true,
    title: 'תוצאת תשלום לא ידועה',
    body: 'הסולק לא ענה ולא ידוע אם הכרטיס חויב. יש לבדוק מול הסולק לפני שההזמנה מטופלת — אחרת אורח ששילם עלול להישאר בלי הזמנה, או להפך.',
    href: financeHref,
  },
  'payment.proof_uploaded': {
    category: 'money',
    severity: 'attention',
    requiredGrant: 'payment.view',
    family: 'finance',
    audience: 'grant_holders',
    title: 'אורח העלה אסמכתת תשלום',
    body: 'הועלה צילום העברה שממתין לאישור. עד שמישהו יאשר אותו, ההזמנה נחשבת לא משולמת.',
    href: financeHref,
  },
  'payment.refunded': {
    category: 'money',
    severity: 'attention',
    requiredGrant: 'payment.view',
    family: 'finance',
    audience: 'grant_holders',
    title: 'בוצע החזר כספי',
    body: 'כסף הוחזר לאורח. הרישום מופיע ביומן הכספי ובהיסטוריית ההזמנה.',
    href: financeHref,
  },
  'invoice.failed': {
    category: 'money',
    severity: 'urgent',
    requiredGrant: 'invoice.view',
    family: 'finance',
    audience: 'grant_holders',
    escalates: true,
    title: 'הפקת חשבונית נכשלה',
    body: 'הכסף התקבל והחשבונית לא יצאה. זו חשיפה מול רשות המסים ולא תקלה טכנית בלבד.',
    href: financeHref,
  },
  // The vendor never answered. This is deliberately `critical` while
  // `invoice.failed` is `urgent`, and the gap is the whole point: a failure is
  // a document that did not go out, and this is a document that MAY have gone
  // out under a number ESTIA cannot see. Retrying it produces a duplicate tax
  // invoice, which cannot be un-issued — so a person has to look before
  // anybody touches it.
  'fiscal.document_outcome_unknown': {
    category: 'money',
    severity: 'critical',
    requiredGrant: 'fiscal.resolve',
    family: 'finance',
    audience: 'grant_holders',
    escalates: true,
    title: 'מסמך חשבונאי — תוצאה לא ידועה',
    body: 'הספק לא ענה. ייתכן שהופק מסמך ממוספר שאיננו רואים, ולכן ניסיון חוזר עלול ליצור כפילות. צריך לבדוק מול הספק לפני כל פעולה.',
    href: financeHref,
  },
  // Money arrived and the paperwork did not. Separate from invoice.failed
  // because nothing failed here — ESTIA may simply not have been asked to
  // issue anything, which is a gap somebody has to close rather than a bug.
  'fiscal.payment_undocumented': {
    category: 'money',
    severity: 'urgent',
    requiredGrant: 'fiscal.resolve',
    family: 'finance',
    audience: 'grant_holders',
    escalates: true,
    title: 'תשלום ללא מסמך חשבונאי',
    body: 'הכסף נרשם והמסמך החשבונאי עדיין ממתין. שני הדברים נכונים בו זמנית, וזה מה שצריך לסגור.',
    href: financeHref,
  },
  'fiscal.reconciliation_difference_found': {
    category: 'money',
    severity: 'urgent',
    requiredGrant: 'fiscal.resolve',
    family: 'finance',
    audience: 'grant_holders',
    escalates: true,
    title: 'פער מול ספק החשבוניות',
    body: 'ההשוואה מצאה הפרש בין מה שרשום כאן לבין מה שרשום אצל הספק. ההשוואה מדווחת ואינה מתקנת.',
    href: financeHref,
  },
  'commission.became_eligible': {
    category: 'money',
    severity: 'info',
    requiredGrant: 'commission.view',
    family: 'finance',
    audience: 'grant_holders',
    title: 'עמלה הבשילה לתשלום',
    body: 'השהות הסתיימה והעמלה ניתנת לאישור ולתשלום.',
    href: financeHref,
  },
  'owner_payout.approved': {
    category: 'money',
    severity: 'info',
    requiredGrant: 'owner.view',
    family: 'finance',
    audience: 'grant_holders',
    title: 'תשלום לבעלים אושר',
    body: 'ההעברה אושרה וממתינה לביצוע.',
    href: financeHref,
  },

  /* ── Booking. ─────────────────────────────────────────────────────────── */

  'booking.created': {
    category: 'booking',
    severity: 'info',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'נקלטה הזמנה חדשה',
    body: 'הזמנה נוספה ליומן. ודאו שהיחידה פנויה ושפרטי האורח מלאים.',
    href: bookingHref,
  },
  'booking.confirmed': {
    category: 'booking',
    severity: 'info',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'הזמנה אושרה',
    body: 'כל התנאים לאישור התקיימו וההזמנה סופית.',
    href: bookingHref,
  },
  'booking.cancelled': {
    category: 'booking',
    severity: 'attention',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'הזמנה בוטלה',
    body: 'התאריכים השתחררו. בדקו אם נדרש החזר כספי ואם יש הכנות שכבר הוזמנו.',
    href: bookingHref,
  },
  'booking.no_show': {
    category: 'booking',
    severity: 'attention',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'האורח לא הגיע',
    body: 'ההזמנה סומנה כאי-הגעה. יש להחליט על חיוב לפי מדיניות הביטול.',
    href: bookingHref,
  },
  'booking.dates_changed': {
    category: 'booking',
    severity: 'attention',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'תאריכי הזמנה השתנו',
    body: 'שינוי תאריכים משפיע על הניקיון, על הכביסה ועל המחיר. בדקו שהתוכניות עודכנו.',
    href: bookingHref,
  },
  'booking.ready_for_check_in': {
    category: 'operations',
    severity: 'info',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'היחידה מוכנה לצ׳ק-אין',
    body: 'משק הבית אישר את היחידה. אפשר לשחרר קוד כניסה או מפתח.',
    href: bookingHref,
  },
  'booking.pre_arrival': {
    category: 'booking',
    severity: 'info',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'הגעה מתקרבת',
    body: 'האורח מגיע בקרוב. ודאו שההכנות הושלמו ושהתשלום סגור.',
    href: bookingHref,
  },
  'channel.reservation_received': {
    category: 'booking',
    severity: 'attention',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'התקבלה הזמנה מערוץ חיצוני',
    body: 'הזמנה הגיעה מערוץ מכירה ונקלטה ביומן. בדקו התנגשויות לפני שאתם מסתמכים עליה.',
    href: bookingHref,
  },

  /* ── Guest. ───────────────────────────────────────────────────────────── */

  'guest.request_submitted': {
    category: 'guest',
    severity: 'attention',
    requiredGrant: 'guest.view',
    family: 'guest',
    audience: 'grant_holders',
    title: 'אורח שלח בקשה',
    body: 'התקבלה בקשה מהאורח דרך עמוד השהות. בקשה שלא נענית היא ביקורת של שני כוכבים.',
    href: guestHref,
  },
  'guest.details_submitted': {
    category: 'guest',
    severity: 'info',
    requiredGrant: 'guest.view',
    family: 'guest',
    audience: 'grant_holders',
    title: 'האורח מילא את פרטיו',
    body: 'הפרטים שהאורח מסר נשמרו בכרטיס ההזמנה.',
    href: guestHref,
  },
  'guest.reconfirmation_required': {
    category: 'guest',
    severity: 'urgent',
    requiredGrant: 'booking.view',
    family: 'booking',
    audience: 'grant_holders',
    escalates: true,
    title: 'נדרש אישור מחדש מהאורח',
    body: 'התנאים השתנו אחרי שהאורח אישר. האישור הקודם אינו חל על התנאים החדשים, וההזמנה אינה סגורה עד שהאורח יאשר שוב.',
    href: bookingHref,
  },
  'quote.accepted': {
    category: 'booking',
    severity: 'attention',
    requiredGrant: 'quote.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'הצעת מחיר התקבלה',
    body: 'הלקוח אישר את ההצעה. יש להפוך אותה להזמנה לפני שהתאריכים נתפסים.',
    href: bookingHref,
  },
  'lead.created': {
    category: 'booking',
    severity: 'info',
    requiredGrant: 'lead.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'התקבלה פנייה חדשה',
    body: 'ליד חדש ממתין לטיפול.',
    href: () => '/leads',
  },
  'hold.expired': {
    category: 'booking',
    severity: 'attention',
    requiredGrant: 'hold.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'שריון תאריכים פג',
    body: 'התאריכים חזרו למכירה. אם הלקוח עדיין מעוניין, יש לשריין מחדש.',
    href: () => '/calendar',
  },

  /* ── Operations. ──────────────────────────────────────────────────────── */

  'task.overdue': {
    category: 'operations',
    severity: 'urgent',
    requiredGrant: 'task.view',
    family: 'operations',
    audience: 'grant_holders',
    escalates: true,
    title: 'משימה באיחור',
    body: 'משימה עברה את מועד היעד שלה. אם היא קשורה להגעה של היום, זו יחידה שלא תהיה מוכנה.',
    href: taskHref,
  },
  'task.assigned': {
    category: 'operations',
    severity: 'info',
    requiredGrant: 'task.view',
    family: 'operations',
    audience: 'grant_holders',
    title: 'הוקצתה לך משימה',
    body: 'משימה חדשה שויכה אליך.',
    href: taskHref,
  },
  'incident.opened': {
    category: 'operations',
    severity: 'urgent',
    requiredGrant: 'incident.view',
    family: 'operations',
    audience: 'grant_holders',
    escalates: true,
    title: 'נפתח אירוע',
    body: 'דווח אירוע בנכס. אירוע פתוח בזמן שהות הוא אורח שממתין לתשובה.',
    href: incidentHref,
  },
  'incident.resolved': {
    category: 'operations',
    severity: 'info',
    requiredGrant: 'incident.view',
    family: 'operations',
    audience: 'grant_holders',
    title: 'אירוע נסגר',
    body: 'האירוע טופל ונסגר.',
    href: incidentHref,
  },
  'preparation.changed': {
    category: 'operations',
    severity: 'attention',
    requiredGrant: 'task.view',
    family: 'operations',
    audience: 'grant_holders',
    title: 'תוכנית ההכנה השתנתה',
    body: 'שינוי בהזמנה שינה את מה שצריך להכין. מי שכבר קיבל את התוכנית הקודמת עובד לפי מספרים ישנים.',
    href: () => '/preparation',
  },
  'inventory.shortage_detected': {
    category: 'inventory',
    severity: 'urgent',
    requiredGrant: 'inventory.view',
    family: 'operations',
    audience: 'grant_holders',
    escalates: true,
    title: 'חוסר במלאי',
    body: 'פריט חסר עכשיו, לא בעתיד. מישהו עומד מול המחסן וזה לא שם.',
    href: inventoryHref,
  },
  'inventory.projected_shortage': {
    category: 'inventory',
    severity: 'attention',
    requiredGrant: 'inventory.view',
    family: 'operations',
    audience: 'grant_holders',
    title: 'צפוי חוסר במלאי',
    body: 'התחזית מראה שהמלאי לא יספיק לתאריך קרוב. יש עוד זמן להזמין — אבל לא הרבה.',
    href: inventoryHref,
  },
  'laundry.deadline_risk': {
    category: 'operations',
    severity: 'urgent',
    requiredGrant: 'laundry.view',
    family: 'operations',
    audience: 'grant_holders',
    escalates: true,
    title: 'זמן ההחזרה של הכביסה לא מספיק',
    body: 'הכביסה לא תחזור לפני ההגעה. עדיף לדעת עכשיו מאשר לעמוד בחדר שינה לא מוצע.',
    href: laundryHref,
  },
  'laundry.overdue': {
    category: 'operations',
    severity: 'attention',
    requiredGrant: 'laundry.view',
    family: 'operations',
    audience: 'grant_holders',
    title: 'הזמנת כביסה באיחור',
    body: 'הספק לא החזיר בזמן שנקבע.',
    href: laundryHref,
  },
  'store.provider_unconfirmed': {
    category: 'operations',
    severity: 'urgent',
    requiredGrant: 'order.view',
    family: 'booking',
    audience: 'grant_holders',
    escalates: true,
    title: 'ספק חיצוני לא אישר',
    body: 'הבקשה נשלחה ואף אחד לא ענה, והמועד מתקרב. עדיף לברר עכשיו מאשר לגלות ביום עצמו שאף אחד לא מגיע.',
    href: storeHref,
  },
  'store.order_overdue': {
    category: 'operations',
    severity: 'attention',
    requiredGrant: 'order.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'הזמנה מהחנות באיחור',
    body: 'הזמנה עברה את מועד האספקה שהובטח לאורח.',
    href: storeHref,
  },
  'store.order_created': {
    category: 'booking',
    severity: 'info',
    requiredGrant: 'order.view',
    family: 'booking',
    audience: 'grant_holders',
    title: 'אורח ביצע הזמנה בחנות',
    body: 'התקבלה הזמנה חדשה מהחנות.',
    href: storeHref,
  },

  /* ── Approvals. ───────────────────────────────────────────────────────── */

  /**
   * Addressed to whoever can DECIDE, not to whoever may request. An approval
   * routed to the requester is a queue with nobody at the other end.
   */
  'approval.requested': {
    category: 'approval',
    severity: 'attention',
    requiredGrant: 'approval.decide',
    audience: 'grant_holders',
    escalates: true,
    title: 'ממתין לאישורך',
    body: 'בקשה חדשה ממתינה להחלטה. עד שתוכרע, הפעולה שמאחוריה עצורה.',
    href: actionCentreHref,
  },
  'approval.decided': {
    category: 'approval',
    severity: 'info',
    requiredGrant: 'approval.request',
    audience: 'grant_holders',
    notifyActor: false,
    title: 'התקבלה החלטה בבקשה',
    body: 'הבקשה הוכרעה. הפרטים במרכז הפעולות.',
    href: actionCentreHref,
  },
  'approval.expired': {
    category: 'approval',
    severity: 'attention',
    requiredGrant: 'approval.decide',
    audience: 'grant_holders',
    title: 'בקשת אישור פגה',
    body: 'אף אחד לא הכריע בזמן והבקשה פגה. הפעולה שמאחוריה לא בוצעה.',
    href: actionCentreHref,
  },

  /* ── Security. ────────────────────────────────────────────────────────── */

  /**
   * The only `actor` entry in this file, and the reason the audience field
   * exists. "Somebody signed in from a new device" is a message to the person
   * who signed in. Sending it to everyone holding `audit.view` would turn a
   * security feature into a colleague's travel schedule.
   */
  'security.new_device_login': {
    category: 'security',
    severity: 'attention',
    requiredGrant: null,
    audience: 'actor',
    notifyActor: true,
    title: 'כניסה ממכשיר חדש',
    body: 'זוהתה כניסה לחשבון שלך ממכשיר שלא ראינו קודם. אם זה לא אתה — החליפו סיסמה עכשיו.',
    href: () => '/settings/security',
  },
  'security.permission_escalated': {
    category: 'security',
    severity: 'critical',
    requiredGrant: 'audit.view',
    audience: 'grant_holders',
    escalates: true,
    notifyActor: true,
    title: 'הרשאות הורחבו',
    body: 'מישהו קיבל סמכות רחבה יותר. זו הפעולה שהכי חשוב לוודא שנעשתה בכוונה — גם כשהיא נעשתה בכוונה.',
    href: () => '/audit',
  },
  'security.bulk_export': {
    category: 'security',
    severity: 'urgent',
    requiredGrant: 'audit.view',
    audience: 'grant_holders',
    escalates: true,
    notifyActor: true,
    title: 'יוצא מידע בכמות גדולה',
    body: 'בוצע ייצוא נרחב של נתוני לקוחות. ודאו מי ביצע אותו ולשם מה.',
    href: () => '/audit',
  },
  'security.payment_config_changed': {
    category: 'security',
    severity: 'critical',
    requiredGrant: 'audit.view',
    audience: 'grant_holders',
    escalates: true,
    notifyActor: true,
    title: 'הגדרות הגבייה שונו',
    body: 'מישהו שינה את האופן שבו הכסף מגיע לעסק. שינוי כזה שלא אתם עשיתם הוא הדבר הראשון שבודקים בהונאה.',
    href: () => '/settings/payments',
  },

  /* ── System. ──────────────────────────────────────────────────────────── */

  'channel.sync_failed': {
    category: 'system',
    severity: 'urgent',
    requiredGrant: 'channel.manage',
    family: 'settings',
    audience: 'grant_holders',
    escalates: true,
    title: 'סנכרון ערוץ נכשל',
    body: 'היומן מול הערוץ החיצוני לא מסונכרן. כל דקה כזו היא סיכון להזמנה כפולה על אותה יחידה.',
    href: () => '/channels',
  },
  'site.published': {
    category: 'system',
    severity: 'info',
    requiredGrant: 'site.view',
    family: 'website',
    audience: 'grant_holders',
    title: 'האתר פורסם',
    body: 'הגרסה החדשה של האתר עלתה לאוויר.',
    href: () => '/website',
  },
}

/* ------------------------------------------------------------------ reads -- */

export function specFor(event: DomainEventName): NotificationSpec | null {
  return NOTIFICATION_CATALOGUE[event] ?? null
}

/** The events this product will actually tell somebody about. */
export function notifiableEvents(): readonly DomainEventName[] {
  return Object.keys(NOTIFICATION_CATALOGUE) as DomainEventName[]
}

/**
 * Every event in `ALERT_EVENTS` that this table does not route.
 *
 * `contracts/events.ts` says those twelve "must reach a person rather than
 * only a log". A gap between that list and this one is a promise the product
 * is not keeping, and it is worth being able to name at any moment rather than
 * discovering it during an incident. `catalogue.test.ts` asserts it is empty.
 */
export function unroutedAlertEvents(): readonly DomainEventName[] {
  return ALERT_EVENTS.filter((event) => !(event in NOTIFICATION_CATALOGUE))
}
