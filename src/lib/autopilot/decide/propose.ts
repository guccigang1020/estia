/**
 * What would actually fix this, in the order somebody should try it.
 *
 * ── Ordered alternatives, not a single answer ─────────────────────────────
 *
 * A `Decision` carries a LIST of proposed actions. The first is what the
 * screen offers as the button; the rest are what the manager sees when they
 * disagree with it. That shape is the whole difference between a product that
 * helps and a product that argues: ESTIA has an opinion, states it first, and
 * never hides the fact that there were other options.
 *
 * ── Nothing is proposed that the customer cannot do ───────────────────────
 *
 * Every action in the catalogue declares the `Entitlement` it needs, and the
 * enabled entitlements arrive here as an explicit argument. A business with
 * inventory switched off is never told to "reserve six towels from stock",
 * because there is no stock — and it is never told to buy the module either,
 * in the middle of a shortage at 06:00. It is told the preparation needs six
 * more towels, which is true on every package.
 *
 * The floor of every ladder is `exception.raise`, which requires nothing. A
 * decision with no actions would be a red row with no button, and the honest
 * version of "ESTIA cannot do anything about this" is "a person needs to look
 * at this", not silence.
 *
 * ── Nothing here recomputes anything ──────────────────────────────────────
 *
 * The shortfall, the stock in the other property, whether a supplier exists —
 * all of it arrives as `ShortageFacts`, decided by the engines that own those
 * questions. A second opinion about whether the reserve holds six towels is
 * not a feature, and a ladder that guessed at availability would propose
 * transfers from properties that have nothing to give.
 */

import { AUTOPILOT_ACTIONS, type AutopilotActionKind } from '../actions'
import type { Entitlement } from '../../plans/entitlements'
import type { Decision, ProposedAction, Signal } from '../types'

import { confidenceFor } from './confidence'
import { dedupeSignals, type Occurrence } from './dedupe'
import { triage } from './triage'

/* -------------------------------------------------------------- context -- */

/**
 * What the inventory engine already worked out about one shortage.
 *
 * Every field is a fact somebody else established. `null` means "there is no
 * such option", which is different from "we did not look" — a caller that did
 * not look omits the whole record, and the ladder then honestly proposes only
 * manual intervention.
 */
export interface ShortageFacts {
  /** How many are missing. Arithmetic, from the inventory engine. */
  shortfall: number
  /** Hebrew, for the reason line — 'מגבות', 'סדינים זוגיים'. */
  itemLabel: string
  /** An outstanding laundry order that could plausibly arrive sooner. */
  pendingLaundryOrderId: string | null
  /** Another store at THIS property believed to hold some of them. */
  alternateStorageId: string | null
  /** A property with spare stock, found by the inventory engine's search. */
  transferFromPropertyId: string | null
  /** How many the internal reserve holds. 0 means the reserve cannot help. */
  reserveOnHand: number
  /** A supplier who could be asked. `null` means procurement is not an option. */
  supplierId: string | null
}

export interface ProposalContext {
  /** What this customer's package actually includes. Explicit, never read. */
  entitlements: readonly Entitlement[]
  /**
   * What triggered this pass: a domain event's id, or the identifier of the
   * scheduled sweep window. It goes into every `idempotencyKey`, which is what
   * makes a redelivered event produce the same key and a genuinely new pass
   * produce a new one. Not a clock reading — a clock would make every
   * redelivery unique, which is the exact failure the key exists to prevent.
   */
  trigger: string
  /** Shortage facts by the signal's `dedupeKey`. Absent is a valid answer. */
  shortages?: Readonly<Record<string, ShortageFacts>>
}

/* ------------------------------------------------------------ internals -- */

/**
 * A proposal before entitlement filtering and confidence.
 *
 * `restsOnEstimate` is the one judgment call the author of a rung makes, and
 * it is a claim about the REMEDY rather than about the facts: "asking the
 * laundry to come early" rests on the provider agreeing, which nobody has
 * recorded, whatever the evidence under the shortage says.
 */
export interface ProposalCandidate {
  kind: AutopilotActionKind
  reason: string
  input: Readonly<Record<string, unknown>>
  restsOnEstimate?: boolean
  scheduledFor?: string
}

function has(
  entitlements: readonly Entitlement[],
  kind: AutopilotActionKind,
): boolean {
  const required = AUTOPILOT_ACTIONS[kind].requires
  return required === null || entitlements.includes(required)
}

/**
 * The identity of one proposed action, stable across redeliveries.
 *
 * Three parts and no clock: the problem, the remedy, and the trigger. The same
 * event delivered three times produces one key and therefore one action; the
 * next sweep produces a different key, so a payment reminder that is genuinely
 * due again is not suppressed forever by yesterday's.
 */
export function idempotencyKeyFor(
  signal: Signal,
  kind: AutopilotActionKind,
  trigger: string,
): string {
  return `autopilot:${signal.dedupeKey}:${kind}:${trigger}`
}

function finalise(
  signal: Signal,
  candidates: readonly ProposalCandidate[],
  ctx: ProposalContext,
): readonly ProposedAction[] {
  const seen = new Set<AutopilotActionKind>()
  const actions: ProposedAction[] = []

  for (const candidate of candidates) {
    if (seen.has(candidate.kind)) continue
    if (!has(ctx.entitlements, candidate.kind)) continue
    seen.add(candidate.kind)
    actions.push(toAction(signal, candidate, ctx))
  }

  if (actions.length === 0) {
    // The floor. `exception.raise` requires no entitlement precisely so that
    // this branch always has something honest to say.
    actions.push(toAction(signal, manualIntervention(signal), ctx))
  }

  return actions
}

function toAction(
  signal: Signal,
  candidate: ProposalCandidate,
  ctx: ProposalContext,
): ProposedAction {
  return {
    kind: candidate.kind,
    reason: candidate.reason,
    confidence: confidenceFor({
      evidence: signal.evidence,
      remedyRestsOnEstimate: candidate.restsOnEstimate === true,
    }),
    input: candidate.input,
    idempotencyKey: idempotencyKeyFor(signal, candidate.kind, ctx.trigger),
    ...(candidate.scheduledFor === undefined
      ? {}
      : { scheduledFor: candidate.scheduledFor }),
  }
}

function manualIntervention(signal: Signal): ProposalCandidate {
  return {
    kind: 'exception.raise',
    reason: `לא נמצאה פעולה שאפשר להציע כאן במסגרת המודולים הפעילים. ${signal.title} דורש טיפול של אדם.`,
    input: { code: signal.code, dedupeKey: signal.dedupeKey },
  }
}

function subject(signal: Signal): Readonly<Record<string, unknown>> {
  return {
    resourceType: signal.resourceType,
    resourceId: signal.resourceId,
    propertyId: signal.propertyId,
  }
}

/* ------------------------------------------------- the shortage ladder --- */

/**
 * One rung of the shortage ladder.
 *
 * The ladder is ordered by what it costs the business, cheapest first — linen
 * that is already washed and paid for, then something already on site, then
 * something already owned elsewhere, then the reserve, then money, then a
 * person's morning. Proposing procurement before checking the van is the
 * classic way an automatic system spends money it did not need to spend.
 */
interface Rung {
  kind: AutopilotActionKind
  /** Whether this rung has anything to offer given the facts. */
  applies: (facts: ShortageFacts) => boolean
  build: (signal: Signal, facts: ShortageFacts) => ProposalCandidate
}

/**
 * The five sourced rungs, in order. The sixth — manual intervention — is
 * appended by `shortageLadder`, because it is unconditional and its wording
 * depends on what the five produced.
 *
 * 1. **laundry return** — the linen exists, it is clean, and it is in a van.
 *    Asking for it earlier costs nothing and moves nothing else.
 * 2. **alternate storage** — it may already be on site in the other cupboard.
 *    A count is what turns "may" into a number before anything is moved.
 * 3. **transfer from another property** — owned, counted, and an hour away.
 * 4. **internal reserve** — owned and on site, but spending the buffer that
 *    exists for the next surprise, which is why it is below a transfer.
 * 5. **procurement** — money. Below everything the business already owns.
 * 6. **manual intervention** — always available, and the only rung that
 *    requires no module at all.
 */
const SHORTAGE_LADDER: readonly Rung[] = [
  {
    kind: 'laundry.request_earlier',
    applies: (facts) => facts.pendingLaundryOrderId !== null,
    build: (signal, facts) => ({
      kind: 'laundry.request_earlier',
      reason: `יש הזמנת כביסה פתוחה שמכסה את החוסר של ${facts.shortfall} ${facts.itemLabel}. בקשת הקדמה מהמכבסה סוגרת אותו בלי להזיז מלאי ובלי הוצאה.`,
      // Rests on the provider agreeing to come earlier, which nobody recorded.
      restsOnEstimate: true,
      input: {
        ...subject(signal),
        laundryOrderId: facts.pendingLaundryOrderId,
        shortfall: facts.shortfall,
      },
    }),
  },
  {
    kind: 'stock_count.request',
    applies: (facts) => facts.alternateStorageId !== null,
    build: (signal, facts) => ({
      kind: 'stock_count.request',
      reason: `ייתכן שהפריטים כבר בנכס, במחסן אחר. ספירה מאמתת את הכמות לפני שמעבירים ${facts.shortfall} ${facts.itemLabel} מנכס אחר.`,
      // The belief that the other cupboard holds them is exactly what has not
      // been counted — that is why the proposal is to count it.
      restsOnEstimate: true,
      input: {
        ...subject(signal),
        storageId: facts.alternateStorageId,
        shortfall: facts.shortfall,
      },
    }),
  },
  {
    kind: 'inventory.suggest_transfer',
    applies: (facts) => facts.transferFromPropertyId !== null,
    build: (signal, facts) => ({
      kind: 'inventory.suggest_transfer',
      reason: `בנכס אחר יש עודף שמכסה את החוסר. העברה פנימית של ${facts.shortfall} ${facts.itemLabel} זמינה היום ואינה כרוכה בהוצאה.`,
      input: {
        ...subject(signal),
        fromPropertyId: facts.transferFromPropertyId,
        quantity: facts.shortfall,
      },
    }),
  },
  {
    kind: 'task.create',
    applies: (facts) => facts.reserveOnHand >= facts.shortfall,
    build: (signal, facts) => ({
      kind: 'task.create',
      reason: `הרזרבה הפנימית מחזיקה ${facts.reserveOnHand} ${facts.itemLabel} ומכסה את החוסר. משימה למשיכת ${facts.shortfall} מהרזרבה.`,
      input: {
        ...subject(signal),
        type: 'inventory',
        quantity: facts.shortfall,
        source: 'reserve',
      },
    }),
  },
  {
    kind: 'procurement.draft',
    applies: (facts) => facts.supplierId !== null,
    build: (signal, facts) => ({
      kind: 'procurement.draft',
      reason: `לא נמצא מקור פנימי לחוסר. טיוטת רכש של ${facts.shortfall} ${facts.itemLabel} מחכה לאישור לפני שנשלחת.`,
      // Quantity to buy rests on predicted usage beyond today's shortfall.
      restsOnEstimate: true,
      input: {
        ...subject(signal),
        supplierId: facts.supplierId,
        quantity: facts.shortfall,
      },
    }),
  },
]

/**
 * The last rung, which is always present and never needs a module.
 *
 * Its wording depends on whether anything above it survived, and that is not
 * cosmetic. "No source was found — not the laundry, not another store, not
 * another property" is a claim about the world, and it is false on a package
 * where the sources existed and the modules to reach them did not. Saying it
 * anyway is exactly how a customer learns that ESTIA's explanations are
 * boilerplate.
 */
function manualShortageRung(
  signal: Signal,
  facts: ShortageFacts,
  hadOptions: boolean,
): ProposalCandidate {
  return {
    kind: 'exception.raise',
    reason: hadOptions
      ? `חסרים ${facts.shortfall} ${facts.itemLabel}. אם אף אחת מהאפשרויות שהוצעו אינה מתאימה, נדרשת החלטה של אדם.`
      : `חסרים ${facts.shortfall} ${facts.itemLabel} ולא נמצאה דרך לסגור את החוסר במסגרת המודולים הפעילים. נדרשת החלטה של אדם.`,
    input: { ...subject(signal), shortfall: facts.shortfall },
  }
}

/**
 * The ladder, evaluated in order and filtered to what the package includes.
 *
 * The entitlement filter runs HERE as well as in `finalise` — idempotently,
 * since a rung that survives one survives the other — because the last rung's
 * wording depends on whether anything above it is actually offerable. A ladder
 * that decided its own closing sentence before the package was consulted would
 * tell a customer with laundry switched off that no laundry order exists.
 */
export function shortageLadder(
  signal: Signal,
  facts: ShortageFacts,
  entitlements: readonly Entitlement[],
): readonly ProposalCandidate[] {
  const sourced = SHORTAGE_LADDER.filter(
    (rung) => rung.applies(facts) && has(entitlements, rung.kind),
  ).map((rung) => rung.build(signal, facts))

  return [...sourced, manualShortageRung(signal, facts, sourced.length > 0)]
}

/* ------------------------------------------------------- per-domain ------ */

/**
 * What to propose for everything that is not an inventory shortage.
 *
 * One list per domain rather than one per signal code, deliberately. A
 * detector that invents a new code inside a known domain gets a sensible list
 * on the day it ships rather than an empty decision, and the code-specific
 * refinements are the exceptions inside these functions rather than the whole
 * structure.
 */
function candidatesFor(
  signal: Signal,
  ctx: ProposalContext,
): readonly ProposalCandidate[] {
  const where = subject(signal)

  switch (signal.domain) {
    case 'safety':
      return [
        {
          kind: 'exception.raise',
          reason: `${signal.detail} זהו נושא בטיחות ולכן הוא ראשון בתור, לפני כל דבר אחר.`,
          input: { ...where, code: signal.code },
        },
        {
          kind: 'team.notify',
          reason: 'הצוות מקבל התראה מיידית כדי שמישהו יאשר שהטיפול התחיל.',
          input: { ...where, urgency: 'critical' },
        },
      ]

    case 'arrival_risk':
      return [
        {
          kind: 'team.notify',
          reason: `${signal.detail} ההגעה בסיכון, והצוות צריך לדעת עכשיו ולא בעוד שעה.`,
          input: { ...where, urgency: 'high' },
        },
        {
          kind: 'readiness.explain',
          reason:
            'פירוט הדרישות שעדיין לא מולאו, כדי שאפשר יהיה לבחור במה לטפל קודם.',
          input: where,
        },
        {
          kind: 'task.create',
          reason: 'פתיחת משימה ייעודית לסגירת הפער לפני מועד ההגעה.',
          input: { ...where, type: 'preparation' },
        },
      ]

    case 'guest_access':
      return [
        {
          kind: 'guest.send_arrival_info',
          reason: 'האורח מקבל את פרטי ההגעה כדי שלא יעמוד בחוץ בלי מידע.',
          input: where,
        },
        {
          kind: 'access.issue_code',
          reason:
            'הנפקת קוד כניסה. פעולה שנוגעת בגישה לנכס ולכן לעולם אינה אוטומטית.',
          input: where,
        },
      ]

    case 'payment_risk':
      return [
        {
          kind: 'guest.send_reminder',
          reason: `${signal.detail} תזכורת ידידותית לאורח לפני שמסלימים לבקשת תשלום.`,
          input: where,
        },
        {
          kind: 'payment.request',
          reason: 'בקשת תשלום עם קישור. נוגעת בכסף ולכן דורשת אישור אדם.',
          input: where,
        },
      ]

    case 'preparation':
      return [
        {
          kind: 'preparation.generate',
          reason:
            'חישוב מחדש של דרישות ההכנה, כדי שהתמונה תהיה מעודכנת לפני שמזיזים אנשים.',
          input: where,
        },
        {
          kind: 'cleaner.escalate',
          reason:
            'ההכנה מפגרת אחרי הקצב הרגיל, והמנקה צריך לדעת שהמועד בסיכון.',
          // "Behind the usual pace" is a comparison against a typical duration.
          restsOnEstimate: true,
          input: where,
        },
        {
          kind: 'task.create',
          reason: 'פתיחת משימה נוספת לסגירת הפער בהכנה.',
          input: { ...where, type: 'preparation' },
        },
      ]

    case 'maintenance':
      return [
        {
          kind: 'maintenance.raise_priority',
          reason: `${signal.detail} העלאת הדחיפות של התקלה כדי שתטופל לפני ההגעה הבאה.`,
          input: where,
        },
        {
          kind: 'task.create',
          reason: 'פתיחת משימת תחזוקה ייעודית.',
          input: { ...where, type: 'maintenance' },
        },
      ]

    case 'inventory': {
      const facts = ctx.shortages?.[signal.dedupeKey]
      if (facts === undefined) {
        // No shortage record: the detector said something is wrong with stock
        // and nobody worked out what would fix it. Flagging it is honest;
        // proposing a transfer from a property nobody checked is not.
        return [
          {
            kind: 'inventory.flag_shortage',
            reason: `${signal.detail} סימון החוסר כדי שיופיע בתמונת המלאי, עד שתתקבל תמונה מלאה של המקורות האפשריים.`,
            input: where,
          },
        ]
      }
      return shortageLadder(signal, facts, ctx.entitlements)
    }

    case 'laundry':
      return [
        {
          kind: 'laundry.request_earlier',
          reason: `${signal.detail} בקשת הקדמה מהמכבסה היא הצעד הזול ביותר.`,
          restsOnEstimate: true,
          input: where,
        },
        {
          kind: 'laundry.draft_order',
          reason:
            'הכנת הזמנה חלופית כטיוטה, כדי שתהיה מוכנה אם ההקדמה לא תאושר.',
          input: where,
        },
        {
          kind: 'team.notify',
          reason: 'הצוות התפעולי צריך לדעת שהאספקה בסיכון לפני שהיום מתחיל.',
          input: { ...where, urgency: 'normal' },
        },
      ]

    case 'staff':
      return [
        {
          kind: 'task.assign',
          reason: 'שיוך המשימה לאיש צוות פנוי, כדי שלא תישאר בלי בעלים.',
          input: where,
        },
        {
          kind: 'cleaner.notify',
          reason: 'הודעה לאיש הצוות עם מה שהשתנה במשימה שלו.',
          input: where,
        },
        {
          kind: 'cleaner.escalate',
          reason: 'הסלמה למי שאחראי על המשמרת, אם אין תגובה.',
          restsOnEstimate: true,
          input: where,
        },
      ]

    case 'sales_opportunity':
      return [
        {
          kind: 'hold.release_expired',
          reason:
            'השריון פג לפי מדיניות התפוגה של העסק. שחרורו מחזיר את התאריך למלאי.',
          input: where,
        },
        {
          kind: 'agent.remind',
          reason: 'תזכורת לסוכן לפני שהתאריך משוחרר לכולם.',
          input: where,
        },
        {
          kind: 'opportunity.publish',
          reason:
            'פרסום התאריך הפנוי לרשת הסוכנים. משנה את מה שהעסק מציע ולכן דורש אישור.',
          // Whether publishing will fill the date is a prediction, not a fact.
          restsOnEstimate: true,
          input: where,
        },
      ]

    case 'optimization':
      return [
        {
          kind: 'brief.compose',
          reason: 'הכללת הנושא בסיכום היומי, בלי לעשות דבר נוסף.',
          input: where,
        },
        {
          kind: 'guest.request_review',
          reason: 'בקשת חוות דעת מהאורח בתזמון שבו הסיכוי לתשובה גבוה.',
          restsOnEstimate: true,
          input: where,
        },
        {
          kind: 'price.suggest',
          reason:
            'הצעת מחיר מעודכנת לתאריכים הפנויים. הצעה בלבד, לעולם לא שינוי אוטומטי.',
          restsOnEstimate: true,
          input: where,
        },
      ]
  }
}

/* ---------------------------------------------------------- the surface -- */

/**
 * The ordered proposals for one signal.
 *
 * Never empty: see `finalise`. The first element is the button.
 */
export function proposeActions(
  signal: Signal,
  ctx: ProposalContext,
): readonly ProposedAction[] {
  return finalise(signal, candidatesFor(signal, ctx), ctx)
}

export interface DecideResult {
  /** Triaged, collapsed, and each with its ordered proposals. */
  decisions: readonly Decision[]
  occurrences: readonly Occurrence[]
  /** Repeats folded away in this pass. */
  collapsed: number
}

/**
 * The whole stage: signals in, decisions out.
 *
 * Dedupe runs BEFORE proposing, so no Hebrew is composed for a row that is
 * about to be collapsed. Triage runs after, so `priority` is the row's
 * position in the final ordered list — which is what the screens and the plan
 * both read, and it stays contiguous because the collapse already happened.
 */
export function decide(
  signals: readonly Signal[],
  ctx: ProposalContext,
  options: { observedAt: string; known?: readonly Occurrence[] },
): DecideResult {
  const collapsed = dedupeSignals(signals, options)
  const ordered = triage(collapsed.kept)

  const decisions = ordered.map((signal, index) => ({
    signal,
    actions: proposeActions(signal, ctx),
    priority: index,
  }))

  return {
    decisions,
    occurrences: collapsed.occurrences,
    collapsed: collapsed.collapsed,
  }
}
