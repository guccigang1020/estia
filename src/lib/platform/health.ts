/**
 * EXECUTION CONTEXT — SERVER ONLY. Platform health.
 *
 * ══ THE RULE THIS FILE EXISTS TO ENFORCE ══════════════════════════════════
 *
 * A panel with no source says so. It does not show a zero, it does not show a
 * dash that could be read as a zero, and it does not show a green tick meaning
 * "nothing wrong reported". A console that displays an invented number is
 * worse than one that displays nothing, because somebody makes a decision on
 * it — and "0 failed payments today" is exactly the number a person acts on by
 * doing nothing.
 *
 * So a panel is a discriminated union. `connected` carries figures that were
 * read from rows. `not_connected` carries a sentence saying what is missing
 * and why, and it has no place to put a number at all. The screen cannot get
 * this wrong by accident because the type will not let it.
 *
 * ── What is connected, and what is not, as of 0041 ────────────────────────
 *
 *   Connected — accounts, subscriptions and trials, ESTIA's own recent
 *   actions, open support views. All four are counted from tables 0041 opens
 *   to platform staff.
 *
 *   Not connected — integrations, payment-provider health, the job queue, AI
 *   usage, security events. Each for its own stated reason, and two of those
 *   reasons are worth knowing apart:
 *
 *     · There is no integrations table, no queue table and no AI usage table
 *       in this database at all. Nothing is being withheld; the thing does not
 *       exist yet.
 *
 *     · `payment_provider_events` and `payment_attempts` DO exist, per tenant,
 *       and 0041 deliberately does not open them to platform staff. Those rows
 *       carry provider payloads about a customer's guests paying a customer's
 *       bills. Opening every tenant's payment traffic to answer "is the
 *       provider up" is the wrong trade, and the panel says that rather than
 *       pretending the data is absent.
 */

import type { Db } from '@/lib/persistence'
import { asString, toRows } from '@/lib/persistence'

/* ----------------------------------------------------------------- types -- */

export interface HealthMetric {
  label: string
  value: string
  /** A one-line note under the figure, when the figure needs one. */
  note?: string
  /** Draws attention. Never used for a figure that was not read from a row. */
  attention?: boolean
}

export type HealthSource =
  | { kind: 'connected'; metrics: readonly HealthMetric[] }
  /**
   * There is no source for this panel.
   *
   * `reason` is printed verbatim. It is written in the same register as the
   * rest of the product — a sentence explaining what is missing, not the word
   * "N/A" — because the reader is deciding whether to go and look somewhere
   * else, and needs to know whether there is a somewhere else.
   */
  | { kind: 'not_connected'; reason: string }

export interface HealthPanel {
  key: string
  title: string
  source: HealthSource
}

/* ------------------------------------------------------- the honest gaps -- */

/**
 * The five panels the brief asks for that have no source in this database.
 *
 * Declared as data rather than built in the reader, so that adding a source
 * later is deleting an entry from this list and adding a query — and so that
 * this file can be read as the answer to "what does the console not know".
 */
export const UNCONNECTED_PANELS: readonly HealthPanel[] = [
  {
    key: 'integrations',
    title: 'תקינות אינטגרציות',
    source: {
      kind: 'not_connected',
      reason:
        'אין במסד הנתונים טבלת אינטגרציות. ההרשאה integration.manage קיימת בקטלוג, ואין מאחוריה טבלה, ערוץ או בדיקת תקינות — כך שאין כאן מה למדוד. זה חוסר, לא תקלה.',
    },
  },
  {
    key: 'payment_provider',
    title: 'תקינות ספק הסליקה',
    source: {
      kind: 'not_connected',
      reason:
        'הטבלאות payment_provider_events ו-payment_attempts קיימות — אבל הן של כל לקוח בנפרד, ומיגרציה 0041 בכוונה אינה פותחת אותן לצוות ESTIA. השורות נושאות תשלומים של אורחים של לקוחות, ופתיחת כל תנועת הסליקה של כל הדיירים כדי לענות על "האם הספק עובד" היא עסקה גרועה. אין כאן מספר כי לא ניתנה כאן הרשאה, ולא כי אין נתונים.',
    },
  },
  {
    key: 'jobs',
    title: 'תורים ומשימות רקע',
    source: {
      kind: 'not_connected',
      reason:
        'אין במסד הנתונים תור עבודות ואין טבלת ריצות. אין תהליך רקע שמדווח על עצמו, ולכן אין כאן מצב להציג.',
    },
  },
  {
    key: 'ai_usage',
    title: 'שימוש ב-AI',
    source: {
      kind: 'not_connected',
      reason:
        'אין טבלת שימוש ב-AI. audit_events יודע לרשום פעולה של ai_agent — וזו רשומת ביקורת, לא מדידת צריכה: אין בה טוקנים, אין עלות ואין ספק. ספירה של שורות ביקורת שהוצגה כ"שימוש" הייתה מספר שנראה אמיתי ואינו.',
    },
  },
  {
    key: 'security_events',
    title: 'אירועי אבטחה',
    source: {
      kind: 'not_connected',
      reason:
        'התחברויות, כשלי התחברות ואיפוסי סיסמה נשמרים בסכימת auth של Supabase, שאינה חשופה לתפקיד authenticated ואינה נקראת מכאן. audit_events מתעד פעולות עסקיות ולא אירועי הזדהות, ולכן ספירה משם הייתה עונה על שאלה אחרת.',
    },
  },
]

/* ---------------------------------------------------------------- reader -- */

export interface PlatformHealth {
  panels: readonly HealthPanel[]
  /** Set when a connected panel could not be read. Never silently empty. */
  failures: readonly string[]
}

/** Trials closer than this are worth naming on the console's front page. */
const TRIAL_HORIZON_DAYS = 14

/**
 * Everything the console knows about its own installation.
 *
 * Each connected panel is read independently and each failure is collected
 * rather than thrown: one unreadable table must not blank the other three, and
 * a panel that failed to load must not render as a panel with nothing in it.
 */
export async function loadPlatformHealth(
  db: Db,
  now: Date = new Date(),
): Promise<PlatformHealth> {
  const panels: HealthPanel[] = []
  const failures: string[] = []

  const accounts = await accountsPanel(db)
  if (accounts.ok) panels.push(accounts.panel)
  else failures.push(accounts.failure)

  const subscriptions = await subscriptionsPanel(db, now)
  if (subscriptions.ok) panels.push(subscriptions.panel)
  else failures.push(subscriptions.failure)

  const actions = await platformActionsPanel(db, now)
  if (actions.ok) panels.push(actions.panel)
  else failures.push(actions.failure)

  const support = await supportPanel(db, now)
  if (support.ok) panels.push(support.panel)
  else failures.push(support.failure)

  return { panels: [...panels, ...UNCONNECTED_PANELS], failures }
}

type PanelResult =
  { ok: true; panel: HealthPanel } | { ok: false; failure: string }

async function accountsPanel(db: Db): Promise<PanelResult> {
  const { data, error } = await db
    .from('organizations')
    .select('status')
    .is('deleted_at', null)
    .limit(2000)

  if (error) {
    return { ok: false, failure: `לא ניתן לספור ארגונים: ${error.message}` }
  }

  const rows = toRows(data)
  const byStatus = new Map<string, number>()
  for (const row of rows) {
    const status = asString(row, 'status')
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
  }

  const suspended = byStatus.get('suspended') ?? 0

  return {
    ok: true,
    panel: {
      key: 'accounts',
      title: 'חשבונות לקוח',
      source: {
        kind: 'connected',
        metrics: [
          { label: 'סה״כ', value: String(rows.length) },
          { label: 'פעילים', value: String(byStatus.get('active') ?? 0) },
          { label: 'בהקמה', value: String(byStatus.get('onboarding') ?? 0) },
          {
            label: 'מושהים',
            value: String(suspended),
            attention: suspended > 0,
          },
          { label: 'סגורים', value: String(byStatus.get('closed') ?? 0) },
        ],
      },
    },
  }
}

async function subscriptionsPanel(db: Db, now: Date): Promise<PanelResult> {
  const { data, error } = await db
    .from('organization_subscriptions')
    .select('status, trial_ends_at')
    .is('deleted_at', null)
    .limit(2000)

  if (error) {
    return { ok: false, failure: `לא ניתן לקרוא מנויים: ${error.message}` }
  }

  const rows = toRows(data)
  const byStatus = new Map<string, number>()
  let trialsClosing = 0
  let trialsLapsed = 0

  const horizon = new Date(
    now.getTime() + TRIAL_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  )

  for (const row of rows) {
    const status = asString(row, 'status')
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1)

    const trialEndsAt = row['trial_ends_at']
    if (status !== 'trialing' || typeof trialEndsAt !== 'string') continue

    const ends = new Date(trialEndsAt)
    if (Number.isNaN(ends.getTime())) continue
    if (ends < now) trialsLapsed += 1
    else if (ends <= horizon) trialsClosing += 1
  }

  const pastDue = byStatus.get('past_due') ?? 0

  return {
    ok: true,
    panel: {
      key: 'subscriptions',
      title: 'מנויים והתנסויות',
      source: {
        kind: 'connected',
        metrics: [
          { label: 'פעילים', value: String(byStatus.get('active') ?? 0) },
          { label: 'בהתנסות', value: String(byStatus.get('trialing') ?? 0) },
          {
            label: `התנסות שנגמרת תוך ${TRIAL_HORIZON_DAYS} ימים`,
            value: String(trialsClosing),
            attention: trialsClosing > 0,
          },
          {
            label: 'התנסות שפגה ולא הומרה',
            value: String(trialsLapsed),
            attention: trialsLapsed > 0,
          },
          {
            label: 'בפיגור תשלום',
            value: String(pastDue),
            attention: pastDue > 0,
          },
          { label: 'מבוטלים', value: String(byStatus.get('cancelled') ?? 0) },
        ],
      },
    },
  }
}

/**
 * What ESTIA itself did, counted from the trail it writes.
 *
 * This is the only "activity" figure on the page, and it counts the console's
 * own rows — never a customer's. The policy underneath it says the same thing:
 * platform staff read `audit_events` where `actor_type = 'platform_staff'` and
 * nothing else.
 */
async function platformActionsPanel(db: Db, now: Date): Promise<PanelResult> {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const { data, error } = await db
    .from('audit_events')
    .select('occurred_at')
    .eq('actor_type', 'platform_staff')
    .gte('occurred_at', since.toISOString())
    .order('occurred_at', { ascending: false })
    .limit(500)

  if (error) {
    return {
      ok: false,
      failure: `לא ניתן לקרוא את יומן הפעולות של הפלטפורמה: ${error.message}`,
    }
  }

  const rows = toRows(data)
  const latest = rows[0]?.['occurred_at']

  return {
    ok: true,
    panel: {
      key: 'platform_actions',
      title: 'פעולות ESTIA (30 יום)',
      source: {
        kind: 'connected',
        metrics: [
          {
            label: 'פעולות',
            value: String(rows.length),
            note:
              rows.length === 500 ? 'התקרה נגמרה ב-500. היו יותר.' : undefined,
          },
          {
            label: 'האחרונה',
            value:
              typeof latest === 'string'
                ? new Date(latest).toLocaleString('he-IL')
                : 'לא בוצעה אף פעולה',
          },
        ],
      },
    },
  }
}

async function supportPanel(db: Db, now: Date): Promise<PanelResult> {
  const { data, error } = await db
    .from('platform_support_sessions')
    .select('id, expires_at, ended_at')
    .is('ended_at', null)
    .gt('expires_at', now.toISOString())
    .limit(200)

  if (error) {
    return {
      ok: false,
      failure: `לא ניתן לקרוא צפיות תמיכה פתוחות: ${error.message}`,
    }
  }

  const open = toRows(data).length

  return {
    ok: true,
    panel: {
      key: 'support_sessions',
      title: 'צפיות תמיכה פתוחות',
      source: {
        kind: 'connected',
        metrics: [
          {
            label: 'פתוחות כרגע',
            value: String(open),
            attention: open > 0,
            note: 'צפייה בלבד. התחזות מלאה אינה קיימת במוצר.',
          },
        ],
      },
    },
  }
}
