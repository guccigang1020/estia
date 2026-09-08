/**
 * EXECUTION CONTEXT — PURE. The one line above the eight panels.
 *
 * ══ WHY A SCREEN WITH EIGHT PANELS NEEDS A NINTH THING ══════════════════════
 *
 * Spec 6.0 §2: "אסור ש-ESTIA תרגיש מסובכת בגלל שהיא חזקה." §4 gives the screen
 * its question — *what needs my attention now?* — and §6 says every exception
 * gets ONE preferred action rather than ten buttons.
 *
 * Eight panels answer the question completely and answer it badly. A person
 * opening this at eight in the morning reads the first panel, and the row that
 * actually matters is in the sixth. Depth is not the problem; depth with no
 * top is.
 *
 * So this is not a summary and not a dashboard. It is one sentence and one
 * button: how many things need a person, and which one first.
 *
 * ══ THE RANKING, AND WHY IT IS THIS ORDER ═══════════════════════════════════
 *
 * The panels are heterogeneous — money, work, faults, integrations — and
 * "urgent" across them cannot come from a timestamp. It comes from who is hurt
 * and how soon:
 *
 *   1. **A guest arrives today and something is unresolved.** The only class
 *      where the deadline is a person standing at a door. Nothing outranks it.
 *   2. **A channel failure at `critical`.** Nobody feels it today, and by the
 *      time somebody does, a weekend has been sold at last season's price.
 *   3. **Laundry that will not make it.** §72's chain starts here, and it is
 *      the last point at which the chain can still be broken.
 *   4. **Money owed on a stay in the building.** Recoverable, and awkward
 *      later.
 *   5. **Work that is stuck**, then **faults nobody closed**, then
 *      **decisions waiting**. All real, none of them today's emergency.
 *
 * That order is a product opinion and it is written here rather than implied
 * by a sort, so it can be argued with.
 *
 * ══ A FAILED READ IS NOT ZERO ═══════════════════════════════════════════════
 *
 * The rule this whole product is built on, and the place it matters most: this
 * strip says "nothing needs you" when every panel came back empty, and it must
 * never say it because a query threw. `unknown` counts the panels that could
 * not be read and the strip reports them separately — a manager who is told
 * their morning is clear when the system could not look is a manager who stops
 * trusting the screen the day they find out.
 */

/** What one panel contributed. `null` means the reader may not see it. */
export type PanelState<T> =
  | { readonly ok: true; readonly value: readonly T[] | null }
  | { readonly ok: false }

export type TriageSource =
  | 'arrival_unresolved'
  | 'channel_critical'
  | 'laundry_missing'
  | 'money_owed'
  | 'work_stuck'
  | 'fault_open'
  | 'decision_waiting'

export interface TriageItem {
  readonly source: TriageSource
  /** Hebrew, and the whole sentence a person reads first. */
  readonly headline: string
  /** The one action §6 asks for. A route, never a menu. */
  readonly href: string
  readonly cta: string
}

export interface Triage {
  /** Everything across every panel that needs a person. */
  readonly total: number
  /** Panels that could not be read. Never folded into `total`. */
  readonly unreadable: number
  /** Panels this reader may not see. Not a problem, and not silence either. */
  readonly withheld: number
  /** The one thing to do first, or null when there is genuinely nothing. */
  readonly first: TriageItem | null
}

export interface TriageInput {
  /** Stays arriving today that are unpaid or unsigned. */
  readonly arrivalsUnresolved: PanelState<unknown>
  readonly channelCritical: PanelState<unknown>
  readonly laundryMissing: PanelState<unknown>
  readonly moneyOwed: PanelState<unknown>
  readonly workStuck: PanelState<unknown>
  readonly faultsOpen: PanelState<unknown>
  readonly decisionsWaiting: PanelState<unknown>
}

/** The order is the product opinion. See the header. */
const RANKED: readonly {
  key: keyof TriageInput
  source: TriageSource
  href: string
  cta: string
  one: (n: number) => string
  many: (n: number) => string
}[] = [
  {
    key: 'arrivalsUnresolved',
    source: 'arrival_unresolved',
    href: '/bookings',
    cta: 'פתח את ההזמנה',
    one: () => 'אורח מגיע היום ומשהו בהזמנה שלו לא סגור',
    many: (n) => `${n} אורחים מגיעים היום ומשהו בהזמנות שלהם לא סגור`,
  },
  {
    key: 'channelCritical',
    source: 'channel_critical',
    href: '/channels',
    cta: 'פתח את מסך הערוצים',
    one: () => 'תקלת ערוץ קריטית שאיש לא טיפל בה',
    many: (n) => `${n} תקלות ערוץ קריטיות שאיש לא טיפל בהן`,
  },
  {
    key: 'laundryMissing',
    source: 'laundry_missing',
    href: '/laundry',
    cta: 'פתח את מסך הכביסה',
    one: () => 'הזמנת כביסה לא תחזור בזמן',
    many: (n) => `${n} הזמנות כביסה לא יחזרו בזמן`,
  },
  {
    key: 'moneyOwed',
    source: 'money_owed',
    href: '/finance',
    cta: 'פתח את הכספים',
    one: () => 'שהייה על הלוח היום עם יתרה פתוחה',
    many: (n) => `${n} שהיות על הלוח היום עם יתרה פתוחה`,
  },
  {
    key: 'workStuck',
    source: 'work_stuck',
    href: '/preparation',
    cta: 'פתח את לוח ההכנה',
    one: () => 'משימה תקועה או שעבר זמנה',
    many: (n) => `${n} משימות תקועות או שעבר זמנן`,
  },
  {
    key: 'faultsOpen',
    source: 'fault_open',
    href: '/incidents',
    cta: 'פתח את תיקי האירוע',
    one: () => 'תיק נזק או תקלה שלא נסגר',
    many: (n) => `${n} תיקי נזק ותקלות שלא נסגרו`,
  },
  {
    key: 'decisionsWaiting',
    source: 'decision_waiting',
    href: '/action-center',
    cta: 'החלט עכשיו',
    one: () => 'בקשה שממתינה להחלטה שלך',
    many: (n) => `${n} בקשות שממתינות להחלטה שלך`,
  },
]

/**
 * Count what needs a person, and name the first thing to do.
 *
 * Pure and total: every panel is in one of four states — read with rows, read
 * and empty, withheld by permission, or failed — and each is counted into a
 * different number. Collapsing any two of them is how a screen ends up
 * confidently wrong.
 */
export function triage(input: TriageInput): Triage {
  let total = 0
  let unreadable = 0
  let withheld = 0
  let first: TriageItem | null = null

  for (const entry of RANKED) {
    const panel = input[entry.key]

    if (!panel.ok) {
      unreadable += 1
      continue
    }
    if (panel.value === null) {
      withheld += 1
      continue
    }

    const count = panel.value.length
    if (count === 0) continue

    total += count

    // The first non-empty panel in ranked order wins, and only the first.
    // A strip that offered three buttons would be the ten-button problem §6
    // names, one level up.
    if (first === null) {
      first = {
        source: entry.source,
        headline: count === 1 ? entry.one(count) : entry.many(count),
        href: entry.href,
        cta: entry.cta,
      }
    }
  }

  return { total, unreadable, withheld, first }
}

/**
 * The sentence for the state where nothing is wrong — which is a real state
 * and deserves better than an empty strip.
 *
 * Split by whether anything was unreadable, because "your morning is clear"
 * and "your morning is clear as far as I could see" are different promises and
 * only one of them is safe to make.
 */
export function calmLine(result: Triage): string {
  if (result.unreadable > 0) {
    return (
      'לא נמצא דבר שדורש טיפול — אבל חלק מהלוחות לא נקראו, ולכן זו אינה ' +
      'תשובה מלאה. ראה את הפאנלים שמסומנים בשגיאה.'
    )
  }
  return 'אין כרגע דבר שדורש אותך. כל הלוחות למטה נקראו והם ריקים.'
}
