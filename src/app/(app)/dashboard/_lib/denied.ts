/**
 * What a refused person is told when a route sends them back here.
 *
 * ── The defect this file exists to close ──────────────────────────────────
 *
 * `requireGrant` redirects to `/dashboard?denied=<grant>&reason=<reason>`, and
 * the home screen printed the grant verbatim: a receptionist who clicked
 * "אורחים" was met with `guest.view` set in a monospace face. That is a code
 * identifier shown to somebody who does not write code, on the one screen
 * whose whole job is to be self-evident, and it is the product speaking a
 * language it does not otherwise speak anywhere.
 *
 * So the grant is translated here into a Hebrew capability, and the reason
 * into a Hebrew consequence. Nothing latin reaches the screen.
 *
 * ── Two refusals that are not the same sentence ───────────────────────────
 *
 * `missing_permission` means "your role does not include this, and a manager
 * can add it". `plan_does_not_include` means "your role does include it and
 * your business has not bought the feature" — a different person fixes that,
 * by upgrading rather than by editing a role. The menu already keeps the two
 * apart (`menu.ts` renders the second as `locked` rather than hiding it) and
 * this banner must not merge them again. `out_of_scope` is a third: the right
 * is held, and the property or the team it was attempted against is outside
 * this membership's reach.
 *
 * ── Why the map is explicit and not composed ──────────────────────────────
 *
 * Splitting `guest.view` at the dot and stitching "צפייה" onto "אורח" produces
 * grammar no Hebrew speaker writes, and it would produce it silently for every
 * grant added later. Every grant that a route gate can actually name is
 * therefore written out, and `denied.test.ts` reads the gate call sites out of
 * the source tree and fails when one appears here without a sentence. A grant
 * that reaches this file without an entry falls back to a general sentence
 * that still names no code — the fallback is a worse message, never a leak.
 */

import type { Grant } from '@/lib/authz/permissions'
import { FIELD_PERMISSIONS, isPermission } from '@/lib/authz/permissions'
import type { DenialReason } from '@/lib/authz/can'

/* --------------------------------------------------------- capabilities -- */

/**
 * The Hebrew name of the capability a route asked for.
 *
 * Written as a noun phrase that completes "המסך שביקשת דורש ...", so it reads
 * as one sentence rather than as a label glued to a stem.
 */
export const GRANT_CAPABILITY: Partial<Record<Grant, string>> = {
  'agency.manage': 'ניהול סוכנויות',
  'agent.view': 'צפייה ברשת הסוכנים',
  'audit.view': 'צפייה ביומן הביקורת',
  'availability.view': 'צפייה בזמינות היחידות',
  'booking.create': 'פתיחת הזמנה חדשה',
  'booking.view': 'צפייה בהזמנות',
  'channel.manage': 'ניהול ערוצי ההפצה',
  'commission.view': 'צפייה בעמלות',
  'expense.create': 'רישום הוצאה',
  'expense.view': 'צפייה בהוצאות',
  'finance.view': 'צפייה בנתונים הכספיים',
  'guest.create': 'הוספת אורח',
  'guest.view': 'צפייה בכרטיסי האורחים',
  'incident.create': 'דיווח על תקלה',
  'incident.view': 'צפייה בתקלות',
  'integration.manage': 'ניהול החיבורים למערכות חיצוניות',
  'inventory.view': 'צפייה במלאי',
  'invoice.view': 'צפייה בחשבוניות',
  'lead.view': 'צפייה בלידים',
  'message.view': 'צפייה בתיבת ההודעות',
  'organization.billing.manage': 'ניהול החבילה והחיוב',
  'organization.settings.edit': 'עריכת הגדרות הארגון',
  'owner_statement.view': 'צפייה בדוחות בעלי הנכסים',
  'payment.view': 'צפייה בתשלומים',
  'pricing.manage': 'ניהול מחירים ומבצעים',
  'property.create': 'הוספת נכס',
  'property.view': 'צפייה בנכסים',
  'quote.create': 'כתיבת הצעת מחיר',
  'quote.view': 'צפייה בהצעות המחיר',
  'report.financial.view': 'צפייה בדוח הכספי',
  'role.assign': 'ניהול תפקידים והרשאות',
  'task.create': 'פתיחת משימה',
  'task.view': 'צפייה במשימות',
  'user.invite': 'הזמנת חבר צוות',
  'user.view': 'צפייה ברשימת הצוות',
  // Reached through the approvals queue rather than through a route gate, and
  // listed because the dashboard's own approvals tile names it when the
  // package refuses it.
  'approval.decide': 'הכרעה בבקשות אישור',
}

/**
 * Is this string a grant the engine knows at all?
 *
 * The value arrives in a query string, so it is whatever somebody typed. An
 * unknown value is not echoed back — that is how a reflected string reaches a
 * screen — it simply produces the general sentence.
 */
const FIELD_GRANTS: ReadonlySet<string> = new Set(FIELD_PERMISSIONS)

function asGrant(value: string): Grant | null {
  if (isPermission(value)) return value
  if (FIELD_GRANTS.has(value)) return value as Grant
  return null
}

/* ------------------------------------------------------------ the copy -- */

export type RefusalCopy = {
  /** The whole sentence, ready to render. Hebrew, always. */
  message: string
  /** What the reader should do next, in one clause. */
  remedy: string
  /** Whether upgrading the package is the fix, rather than a role change. */
  isPlanRefusal: boolean
}

const GENERAL_CAPABILITY = 'הרשאה שאין בתפקיד שלך'

/**
 * The banner, from the two query parameters the guard set.
 *
 * Both are optional and both are untrusted. A missing or unrecognised reason
 * is treated as a permission refusal, which is the common case and the one
 * whose remedy — ask a manager — is safe to offer when the cause is unclear.
 */
export function refusalCopy(
  denied: string | null,
  reason: string | null,
): RefusalCopy | null {
  if (denied === null || denied.length === 0) return null

  const grant = asGrant(denied)
  const capability = grant ? GRANT_CAPABILITY[grant] : undefined

  switch (reason as DenialReason | null) {
    case 'plan_does_not_include':
      return {
        message: capability
          ? `המסך שביקשת שייך ליכולת שאינה כלולה בחבילה של הארגון: ${capability}.`
          : 'המסך שביקשת שייך ליכולת שאינה כלולה בחבילה של הארגון.',
        remedy:
          'ההרשאה עצמה קיימת לך — מה שחסר הוא החבילה. שדרוג יפתח את המסך הזה.',
        isPlanRefusal: true,
      }

    case 'out_of_scope':
      return {
        message: capability
          ? `המסך שביקשת נמצא מחוץ לטווח שלך: ${capability}.`
          : 'המסך שביקשת נמצא מחוץ לטווח שלך.',
        remedy:
          'ההרשאה קיימת לך, אבל לא בנכס או בצוות הזה. מנהל בארגון יכול להרחיב את הטווח.',
        isPlanRefusal: false,
      }

    case 'membership_not_active':
      return {
        message: 'החברות שלך בארגון אינה פעילה, ולכן אף מסך אינו נפתח.',
        remedy: 'מנהל בארגון יכול להחזיר את הגישה. לא נמחק שום נתון שלך.',
        isPlanRefusal: false,
      }

    default:
      return {
        message: `המסך שביקשת דורש ${capability ?? GENERAL_CAPABILITY}.`,
        remedy: 'אם זו טעות, מנהל בארגון יכול לעדכן את התפקיד שלך.',
        isPlanRefusal: false,
      }
  }
}
