import type { Metadata } from 'next'

import Link from 'next/link'

import {
  ConsoleFacts,
  ConsoleNotice,
  ConsolePage,
  ConsoleTable,
} from '@/components/platform/console-chrome'
import { hebrewDate, hebrewMoment } from '@/components/platform/labels'
import { Badge } from '@/components/ui/badge'
import { toLogEntry } from '@/lib/errors'
import { listPlatformOrganizations } from '@/lib/platform'
import type { OrganizationSummary } from '@/lib/platform'
import {
  daysOfTrialLeft,
  fleetMetrics,
  fleetOrganizations,
  listAutopilotCapabilities,
  listAutopilotSafetyIncidents,
  listAutopilotSafetyRules,
  loadFleetActivity,
  TRIAL_EXPIRY_WARNING_DAYS,
  type AutopilotActionSummary,
  type AutopilotCapabilityRecord,
  type AutopilotSafetyRule,
  type FleetActivity,
  type FleetOrganization,
} from '@/lib/platform/autopilot'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../_lib/guard'
import {
  ACTION_OUTCOME_LABEL,
  actionKindLabel,
  CAPABILITY_STATE_LABEL,
  DISPOSITION_LABEL,
  DIVERGENCE_LABEL,
  percentage,
  SAFETY_LEVEL_LABEL,
} from './_lib/labels'

export const metadata: Metadata = { title: 'טייס אוטומטי · קונסולת ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The Autopilot fleet.
 *
 * ══ WHAT THIS SCREEN IS FOR ═══════════════════════════════════════════════
 *
 * Autopilot is the one capability ESTIA hands out one customer at a time. It
 * is on no plan — `ADD_ON_ONLY` in `catalog.test.ts`, and 0046's rehearsal
 * raises an exception if a plan ever carries it — so granting it per customer
 * IS the control mechanism, and this is where that control is exercised and
 * where its consequences are watched.
 *
 * ── The state is not the gate, and this screen shows both ─────────────────
 *
 * `autopilot_capability.state` says WHY. The `autopilot` entitlement is what
 * the product reads. `setAutopilotCapability` moves them together, and the
 * column headed "תואם" is the audit of that promise: any row that is not
 * `aligned` is a customer living in a state nobody can name, and it is listed
 * first rather than buried in a table.
 *
 * ── Trials expire here, not in a job ──────────────────────────────────────
 *
 * A trial past its end date is computed as expired every time this page
 * renders. Nothing sweeps them, deliberately: making the product consult
 * `trial_ends_at` would be a second answer to "does this customer have
 * Autopilot". So an expired trial that still holds the entitlement appears as
 * work for a person, with its own heading.
 *
 * ── An empty fleet is not an error, and neither is an unreadable one ──────
 *
 * The live database has no organizations. That renders as a stated emptiness.
 * Separately, the activity record is not readable from the platform floor at
 * all — 0046 gives `autopilot_actions` a per-tenant SELECT policy and no
 * platform counterpart — so `visibleRows` is reported rather than a count of
 * zero being printed as a measurement. Those are three different sentences and
 * this screen says whichever one is true.
 *
 * GATING. `platform.organization.view`. Every policy behind every read
 * requires the platform floor independently.
 */
export default async function AutopilotFleetPage() {
  await requirePlatformGrant('platform.organization.view')

  const db = await createClient()
  const correlationId = crypto.randomUUID()
  const now = new Date()

  let organizations: readonly OrganizationSummary[] = []
  let capabilities = new Map<string, AutopilotCapabilityRecord>()
  let failure: unknown = null

  try {
    organizations = await listPlatformOrganizations(db)
    capabilities = await listAutopilotCapabilities(
      db,
      organizations.map((organization) => organization.id),
    )
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  // Each secondary read stands alone. A failed incidents query must not blank
  // the fleet, and a fleet that failed to load must not be shown as empty.
  const activity = failure === null ? await loadFleetActivity(db) : null
  const incidents =
    failure === null ? await listAutopilotSafetyIncidents(db) : null
  const safetyRules = await safely(() => listAutopilotSafetyRules(db))

  const rows = fleetOrganizations({
    organizations,
    capabilities,
    activity,
    now,
  })
  const metrics = fleetMetrics(rows, activity, now)

  return (
    <ConsolePage
      title="טייס אוטומטי · מבט על כל הלקוחות"
      lede="הטייס האוטומטי אינו כלול באף חבילה. הוא ניתן ללקוח אחד בכל פעם, וזו כל שיטת הבקרה עליו."
    >
      {failure !== null && (
        <ConsoleNotice title="רשימת הלקוחות לא נטענה" tone="warning">
          לא ניתן היה לקרוא את הארגונים או את שורות היכולת. המסך שמתחת ריק בגלל
          התקלה ולא בגלל שאין לקוחות. מזהה מעקב:{' '}
          <code dir="ltr">{correlationId}</code>
        </ConsoleNotice>
      )}

      <ConsoleFacts
        items={[
          { label: 'ארגונים', value: metrics.organizations },
          { label: 'פעילים', value: metrics.enabled },
          { label: 'בהתנסות', value: metrics.onTrial },
          { label: 'מחזיקים בהרשאה', value: metrics.entitled },
          {
            label: 'אימוץ',
            // A ratio and not a bare number: "3" means nothing without the
            // denominator, and `null` means nobody measured it — which is not
            // the same claim as "nobody adopted it".
            value:
              metrics.adopted === null
                ? 'לא נמדד'
                : `${metrics.adopted} מתוך ${metrics.entitled} מורשים`,
          },
          {
            label: 'הצלחה בפעולות אוטומטיות',
            value: percentage(metrics.automaticSuccessRate),
          },
          {
            label: 'כשלים שנראו',
            value: metrics.failuresSeen === null ? '—' : metrics.failuresSeen,
          },
          {
            label: 'פעולות שנמנעו',
            value:
              metrics.suppressionsSeen === null
                ? '—'
                : metrics.suppressionsSeen,
          },
          {
            label: 'פעולות שנראו',
            value: metrics.actionsSeen === null ? '—' : metrics.actionsSeen,
          },
        ]}
      />

      <ActivityVisibilityNotice activity={activity} />

      {metrics.diverged.length > 0 && (
        <ConsoleNotice
          title={`${metrics.diverged.length} ארגונים שבהם הרישום וההרשאה אינם תואמים`}
          tone="warning"
        >
          <p className="mb-2">
            הרישום אומר דבר אחד וההרשאה שהמוצר קורא אומרת אחר. כל עוד זה המצב,
            אי אפשר לדעת באיזה מהשניים הלקוח חי בפועל. שינוי מצב מהמסך של הארגון
            כותב את שניהם מחדש יחד.
          </p>
          <ul className="flex flex-col gap-1">
            {metrics.diverged.map((row) => (
              <li key={row.organization.id}>
                <OrganizationLink organization={row.organization} /> —{' '}
                {DIVERGENCE_LABEL[row.effective.divergence]} (רישום:{' '}
                {CAPABILITY_STATE_LABEL[row.effective.recorded]}
                {row.effective.trialExpired ? ', ההתנסות הסתיימה' : ''})
              </li>
            ))}
          </ul>
        </ConsoleNotice>
      )}

      {metrics.trialsExpired.length > 0 && (
        <ConsoleNotice
          title={`${metrics.trialsExpired.length} התנסויות שהסתיימו`}
          tone="warning"
        >
          <p className="mb-2">
            תאריך הסיום עבר. שום תהליך אינו מכבה את ההרשאה בעצמו — במכוון, כי
            הרשאה שפגה מעצמה הייתה תשובה שנייה לשאלה &quot;האם ללקוח הזה יש טייס
            אוטומטי&quot;. צריך להחליט: להאריך, להפעיל, או לבטל.
          </p>
          <ul className="flex flex-col gap-1">
            {metrics.trialsExpired.map((row) => (
              <li key={row.organization.id}>
                <OrganizationLink organization={row.organization} /> — הסתיימה
                ב־{hebrewDate(row.effective.trialEndsAt)}
                {row.effective.entitled ? ', וההרשאה עדיין בתוקף' : ''}
              </li>
            ))}
          </ul>
        </ConsoleNotice>
      )}

      {metrics.trialsExpiringSoon.length > 0 && (
        <ConsoleNotice
          title={`${metrics.trialsExpiringSoon.length} התנסויות שמסתיימות בקרוב`}
        >
          <ul className="flex flex-col gap-1">
            {metrics.trialsExpiringSoon.map((row) => (
              <li key={row.organization.id}>
                <OrganizationLink organization={row.organization} /> — עוד{' '}
                {daysOfTrialLeft(row.effective.trialEndsAt, now)} ימים (
                {hebrewDate(row.effective.trialEndsAt)})
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            מוצגות התנסויות שמסתיימות בתוך {TRIAL_EXPIRY_WARNING_DAYS} ימים.
          </p>
        </ConsoleNotice>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-bold tracking-tight">
          לקוחות לפי מצב
        </h2>

        {failure === null && rows.length === 0 ? (
          <ConsoleNotice title="אין עדיין אף ארגון במערכת">
            המסך קורא את <code dir="ltr">organizations</code> ואת{' '}
            <code dir="ltr">autopilot_capability</code> דרך מדיניות שמאשרת צוות
            פלטפורמה. הוא ריק כי אין שורות, ולא כי משהו נכשל — קריאה שנכשלה
            מוצגת כהודעת שגיאה ולא כטבלה ריקה.
          </ConsoleNotice>
        ) : rows.length > 0 ? (
          <ConsoleTable
            caption="מצב הטייס האוטומטי אצל כל לקוח"
            head={[
              'ארגון',
              'מצב רשום',
              'הרשאה בפועל',
              'תואם',
              'סיום התנסות',
              'פעולות שנראו',
              'כשלים',
              'הצלחה אוטומטית',
            ]}
          >
            {rows.map((row) => (
              <FleetRow key={row.organization.id} row={row} now={now} />
            ))}
          </ConsoleTable>
        ) : null}
      </section>

      <SuspendedSection rows={metrics.suspended} />

      <IncidentsSection
        incidents={incidents}
        activityMissing={activity === null}
      />

      <SafetyRulesSection rules={safetyRules} />
    </ConsolePage>
  )
}

/* ------------------------------------------------------------- fragments -- */

function OrganizationLink({
  organization,
}: {
  organization: OrganizationSummary
}) {
  return (
    <Link
      href={`/autopilot/${organization.id}`}
      className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {organization.name}
    </Link>
  )
}

function FleetRow({ row, now }: { row: FleetOrganization; now: Date }) {
  const { effective, activity } = row
  const trialDays = daysOfTrialLeft(effective.trialEndsAt, now)

  return (
    <tr>
      <td className="px-4 py-3">
        <OrganizationLink organization={row.organization} />
        <span dir="ltr" className="block text-xs text-muted-foreground">
          {row.organization.slug}
        </span>
      </td>

      <td className="px-4 py-3">
        <Badge
          tone={
            effective.recorded === 'suspended' ||
            effective.recorded === 'disabled'
              ? 'accent'
              : 'neutral'
          }
        >
          {CAPABILITY_STATE_LABEL[effective.recorded]}
        </Badge>
      </td>

      <td className="px-4 py-3">{effective.entitled ? 'כן' : 'לא'}</td>

      <td className="px-4 py-3">
        {effective.divergence === 'aligned' ? (
          <span className="text-muted-foreground">תואם</span>
        ) : (
          <span className="font-semibold text-danger">
            {DIVERGENCE_LABEL[effective.divergence]}
          </span>
        )}
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        {effective.trialEndsAt === null ? (
          '—'
        ) : (
          <>
            {hebrewDate(effective.trialEndsAt)}
            <span
              className={
                effective.trialExpired
                  ? 'block text-xs font-semibold text-danger'
                  : 'block text-xs text-muted-foreground'
              }
            >
              {effective.trialExpired
                ? 'הסתיימה'
                : trialDays === null
                  ? ''
                  : `עוד ${trialDays} ימים`}
            </span>
          </>
        )}
      </td>

      {/*
        Three cells that must never print a fabricated zero. `activity` is null
        for a customer no action row was seen for, and that is not the same
        fact as "this customer's Autopilot did nothing".
      */}
      <td className="px-4 py-3">
        {activity ? activity.total : <span title="לא נראו שורות">—</span>}
      </td>
      <td className="px-4 py-3">
        {activity ? (
          activity.failures > 0 ? (
            <span className="font-semibold text-danger">
              {activity.failures}
            </span>
          ) : (
            activity.failures
          )
        ) : (
          '—'
        )}
      </td>
      <td className="px-4 py-3">
        {activity ? percentage(activity.automaticSuccessRate) : '—'}
      </td>
    </tr>
  )
}

/**
 * What the activity numbers on this page actually rest on.
 *
 * Stated rather than left to be inferred from a column of dashes. A console
 * that reports "0 actions" for a fleet it cannot see is a console somebody
 * makes a decision on.
 */
function ActivityVisibilityNotice({
  activity,
}: {
  activity: FleetActivity | null
}) {
  if (activity === null) {
    return (
      <ConsoleNotice title="יומן הפעולות לא נקרא" tone="warning">
        הקריאה מ־<code dir="ltr">autopilot_actions</code> נכשלה או נדחתה. עמודות
        הפעולות למטה מציגות מקף ולא אפס, כי אין מספר ידוע.
      </ConsoleNotice>
    )
  }

  if (activity.visibleRows === 0) {
    return (
      <ConsoleNotice title="לא נראתה אף שורת פעולה מהקונסולה">
        המדיניות <code dir="ltr">autopilot_actions_select</code> במיגרציה 0046
        מאשרת קריאה רק לחברי הארגון עצמו, ולאיש צוות פלטפורמה אין חברות בשום
        ארגון — ולכן אפס כאן אינו מבחין בין &quot;לא קרה כלום&quot; לבין
        &quot;לא נראה מכאן&quot;. המסך אינו מציג את זה כמדידה. נדרשת פונקציית
        <code dir="ltr"> security definer</code> שמחזירה מצרפים, בדיוק כמו{' '}
        <code dir="ltr">platform_organization_usage()</code> ב־0041.
      </ConsoleNotice>
    )
  }

  if (activity.truncated) {
    return (
      <ConsoleNotice title="הספירה חסומה בתקרה">
        נקראו {activity.visibleRows} שורות, שהיא התקרה של הקריאה. כל המספרים
        למטה הם רצפה ולא ספירה מלאה.
      </ConsoleNotice>
    )
  }

  return null
}

function SuspendedSection({ rows }: { rows: readonly FleetOrganization[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-bold tracking-tight">
        לקוחות מושהים, ולמה
      </h2>

      {rows.length === 0 ? (
        <ConsoleNotice>
          אף לקוח אינו מושהה כרגע. השהיה מחייבת הערה — גם בסכימה וגם בטופס —
          ולכן אין כאן שורה בלי סיבה.
        </ConsoleNotice>
      ) : (
        <ConsoleTable
          caption="לקוחות שהיכולת נשללה מהם"
          head={['ארגון', 'מצב', 'הערה', 'הוחלט']}
        >
          {rows.map((row) => (
            <tr key={row.organization.id}>
              <td className="px-4 py-3">
                <OrganizationLink organization={row.organization} />
              </td>
              <td className="px-4 py-3">
                {CAPABILITY_STATE_LABEL[row.effective.recorded]}
              </td>
              <td className="px-4 py-3">
                {/*
                  The note is `not null` by CHECK for this state, so an empty
                  cell here would mean the constraint was bypassed — worth
                  saying rather than rendering as blank.
                */}
                {row.effective.note ?? (
                  <span className="text-danger">
                    אין הערה, בניגוד לאילוץ בסכימה
                  </span>
                )}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                {hebrewMoment(row.capability?.decidedAt ?? null)}
              </td>
            </tr>
          ))}
        </ConsoleTable>
      )}
    </section>
  )
}

function IncidentsSection({
  incidents,
  activityMissing,
}: {
  incidents: readonly AutopilotActionSummary[] | null
  activityMissing: boolean
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-bold tracking-tight">
        אירועי בטיחות שדורשים טיפול
      </h2>
      <p className="text-sm text-muted-foreground">
        פעולות במצב <code dir="ltr">failed</code>,{' '}
        <code dir="ltr">needs_review</code> או{' '}
        <code dir="ltr">executed_unaudited</code>. השלישי הוא לא מצב מסודר
        ובכוונה: העבודה קרתה והרישום שלה לא, ושתי החלופות האחרות הן שקר.
      </p>

      {incidents === null ? (
        <ConsoleNotice title="הרשימה לא נקראה" tone="warning">
          {activityMissing
            ? 'יומן הפעולות אינו נגיש מהקונסולה כרגע, ולכן גם רשימת האירועים אינה. ריק כאן אינו עדות לשקט.'
            : 'הקריאה נכשלה. ריק כאן אינו עדות לשקט.'}
        </ConsoleNotice>
      ) : incidents.length === 0 ? (
        <ConsoleNotice>
          לא נראתה אף פעולה במצב שדורש בדיקה. שימו לב שהקריאה מוגבלת למה שהרצפה
          של הפלטפורמה מחזירה — ראו את ההודעה למעלה.
        </ConsoleNotice>
      ) : (
        <ConsoleTable
          caption="פעולות שדורשות בדיקה"
          head={[
            'מתי',
            'ארגון',
            'פעולה',
            'רמת בטיחות',
            'הכרעה',
            'תוצאה',
            'קוד שגיאה',
          ]}
        >
          {incidents.map((incident) => (
            <tr key={incident.id}>
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                {hebrewMoment(incident.createdAt)}
              </td>
              <td className="px-4 py-3">
                <Link
                  href={`/autopilot/${incident.organizationId}`}
                  dir="ltr"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {incident.organizationId.slice(0, 8)}
                </Link>
              </td>
              <td className="px-4 py-3">
                {actionKindLabel(incident.actionKind)}
              </td>
              <td className="px-4 py-3">
                {SAFETY_LEVEL_LABEL[incident.safetyLevel]}
              </td>
              <td className="px-4 py-3">
                {DISPOSITION_LABEL[incident.disposition]}
              </td>
              <td className="px-4 py-3 font-semibold text-danger">
                {ACTION_OUTCOME_LABEL[incident.outcome]}
              </td>
              <td className="px-4 py-3" dir="ltr">
                {incident.errorCode ?? '—'}
              </td>
            </tr>
          ))}
        </ConsoleTable>
      )}
    </section>
  )
}

/**
 * The platform safety floor, read-only and stated as such.
 *
 * No add button and no delete button, and that is not an omission to be filled
 * in later: 0046 revokes INSERT, DELETE and TRUNCATE on
 * `autopilot_safety_rules` from `authenticated` AND from `service_role`, and
 * grants only UPDATE to platform staff. A control that offered to add a rule
 * would be a control nothing could carry out.
 */
function SafetyRulesSection({
  rules,
}: {
  rules: readonly AutopilotSafetyRule[] | null
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-bold tracking-tight">
        רצפת הבטיחות של הפלטפורמה
      </h2>
      <ConsoleNotice tone="strong">
        אלה התקרות שאף לקוח אינו יכול להרים. הן נקראות לפני כל מה שהלקוח הגדיר,
        והן מוצגות כאן לקריאה בלבד: לטבלה{' '}
        <code dir="ltr">autopilot_safety_rules</code> אין הרשאת הוספה או מחיקה
        לאף תפקיד יישומי — גם לא ל־<code dir="ltr">service_role</code> — ורק
        עדכון פתוח לצוות הפלטפורמה. אין כאן כפתור הוספה כי אין מי שיבצע אותו.
      </ConsoleNotice>

      {rules === null ? (
        <ConsoleNotice title="רצפת הבטיחות לא נקראה" tone="warning">
          לא ניתן היה לקרוא את הכללים. אין להסיק מכך שאין תקרה — הכללים נאכפים
          במסד הנתונים ולא במסך הזה.
        </ConsoleNotice>
      ) : rules.length === 0 ? (
        <ConsoleNotice title="אין אף כלל בטיחות" tone="warning">
          הטבלה ריקה. המיגרציה 0046 זורעת שני כללים ומוודאת בסופה שהם קיימים,
          ולכן ריקנות כאן היא ממצא ולא מצב תקין.
        </ConsoleNotice>
      ) : (
        <ConsoleTable
          caption="כללי הבטיחות של הפלטפורמה"
          head={['חל על', 'מרמת בטיחות', 'תקרה', 'נימוק', 'עודכן']}
        >
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td className="px-4 py-3">
                {rule.actionKind === null ? (
                  'כל הפעולות ברמה הזו ומעלה'
                ) : (
                  <span dir="ltr">{rule.actionKind}</span>
                )}
              </td>
              <td className="px-4 py-3">
                {SAFETY_LEVEL_LABEL[rule.maxSafetyLevel]}
              </td>
              <td className="px-4 py-3 font-semibold">
                {DISPOSITION_LABEL[rule.maxDisposition]}
              </td>
              <td className="px-4 py-3 text-sm">{rule.reason}</td>
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                {hebrewMoment(rule.updatedAt)}
              </td>
            </tr>
          ))}
        </ConsoleTable>
      )}
    </section>
  )
}

/** One read, failing on its own. `null` is "not read", never "empty". */
async function safely<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}
