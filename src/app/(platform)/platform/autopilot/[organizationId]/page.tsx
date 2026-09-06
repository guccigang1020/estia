import type { Metadata } from 'next'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  ConsoleFacts,
  ConsoleNotice,
  ConsolePage,
  ConsoleTable,
} from '@/components/platform/console-chrome'
import { hebrewDate, hebrewMoment } from '@/components/platform/labels'
import { Badge } from '@/components/ui/badge'
import { toLogEntry } from '@/lib/errors'
import { loadPlatformOrganization, mayUse } from '@/lib/platform'
import type { OrganizationDetail } from '@/lib/platform'
import {
  autopilotEntitlementActive,
  daysOfTrialLeft,
  effectiveAutopilotCapability,
  listAutopilotActions,
  loadAutopilotCapability,
  SAFETY_INCIDENT_OUTCOMES,
  type AutopilotActionSummary,
} from '@/lib/platform/autopilot'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../../../_lib/guard'
import {
  CapabilityControl,
  CapabilityControlUnavailable,
} from '../_components/capability-control'
import { setAutopilotCapabilityAction } from '../_lib/actions'
import {
  ACTION_OUTCOME_LABEL,
  actionKindLabel,
  CAPABILITY_STATE_LABEL,
  CAPABILITY_STATE_MEANING,
  capabilityStateOptions,
  DISPOSITION_LABEL,
  DIVERGENCE_LABEL,
  RUN_MODE_LABEL,
  SAFETY_LEVEL_LABEL,
  suppressionReasonLabel,
} from '../_lib/labels'

export const metadata: Metadata = {
  title: 'טייס אוטומטי · ארגון · קונסולת ESTIA',
}

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One customer's Autopilot standing.
 *
 * ══ THE TWO FACTS AT THE TOP ARE THE POINT OF THE SCREEN ══════════════════
 *
 * "מצב רשום" is `autopilot_capability.state` — the platform's record of why.
 * "הרשאה בפועל" is the `autopilot` entitlement resolved exactly as the product
 * resolves it, through `capabilityStates()`. They are shown side by side, and
 * a disagreement between them is rendered as a warning rather than as two
 * numbers a reader has to compare, because a reader who has to compare them is
 * a reader who will not.
 *
 * The control below writes both, in one operation, and there is deliberately
 * no separate switch for the entitlement.
 *
 * ── The trial clock is computed here ──────────────────────────────────────
 *
 * `effectiveAutopilotCapability()` compares `trial_ends_at` to the clock on
 * every render. A trial that ended yesterday reads as ended on this screen
 * with no job having run — and, because nothing expires the entitlement
 * itself, says so beside a grant that is still in force.
 *
 * ── What is NOT on this screen ────────────────────────────────────────────
 *
 * The customer's own Autopilot configuration — level, run mode, the policy
 * matrix, quiet hours — is not read. `autopilot_settings` has a per-tenant
 * SELECT policy and no platform counterpart, and that is right: what a
 * business chose to let Autopilot do is theirs, and the platform's business is
 * whether they may have it at all and whether it is behaving. The action rows
 * are read without `reason`, `evidence`, `command_input` or `error_detail`,
 * which carry the guest's own words.
 *
 * GATING. `platform.organization.view` for the page,
 * `platform.organization.manage` for the control, re-checked by the action and
 * again by the database function under it.
 */
export default async function AutopilotOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>
  searchParams: Promise<{
    done?: string
    error?: string
    data?: string
    cid?: string
  }>
}) {
  const session = await requirePlatformGrant('platform.organization.view')
  const { organizationId } = await params
  const feedback = await searchParams

  const db = await createClient()
  const correlationId = crypto.randomUUID()
  const now = new Date()

  let organization: OrganizationDetail | null = null
  try {
    organization = await loadPlatformOrganization(db, organizationId)
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    // A read that failed is not a customer that does not exist. `notFound()`
    // here would tell an operator the account was deleted.
    return (
      <ConsolePage title="הארגון לא נטען">
        <ConsoleNotice title="הקריאה נכשלה" tone="warning">
          לא ניתן היה לקרוא את הארגון <code dir="ltr">{organizationId}</code>.
          זה אינו אומר שהוא אינו קיים. מזהה מעקב:{' '}
          <code dir="ltr">{correlationId}</code>
        </ConsoleNotice>
      </ConsolePage>
    )
  }

  if (!organization) notFound()

  const capability = await safely(() =>
    loadAutopilotCapability(db, organizationId),
  )
  const actions = await listAutopilotActions(db, organizationId)

  const effective = effectiveAutopilotCapability(
    capability ?? null,
    autopilotEntitlementActive(organization.subscription),
    now,
  )
  const failures = (actions ?? []).filter((action) =>
    SAFETY_INCIDENT_OUTCOMES.includes(action.outcome),
  )
  const mayManage = mayUse(session, 'platform.organization.manage')

  return (
    <ConsolePage
      title={`${organization.name} · טייס אוטומטי`}
      lede={organization.slug}
      actions={
        <Link
          href="/platform/autopilot"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          חזרה לכל הלקוחות
        </Link>
      }
    >
      {feedback.done && (
        <ConsoleNotice title="בוצע" tone="strong">
          {feedback.done}
        </ConsoleNotice>
      )}

      {feedback.error && (
        <ConsoleNotice title="הפעולה לא הושלמה" tone="warning">
          <p>{feedback.error}</p>
          {feedback.data && <p className="mt-1">{feedback.data}</p>}
          {feedback.cid && (
            <p className="mt-1 text-xs">
              מזהה מעקב: <code dir="ltr">{feedback.cid}</code>
            </p>
          )}
        </ConsoleNotice>
      )}

      <ConsoleFacts
        items={[
          {
            label: 'מצב רשום (autopilot_capability)',
            value: (
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
            ),
          },
          {
            label: 'הרשאה בפועל (מה שהמוצר קורא)',
            value: effective.entitled ? 'autopilot מוענקת' : 'אין הרשאה',
          },
          {
            label: 'סיום התנסות',
            value:
              effective.trialEndsAt === null
                ? '—'
                : `${hebrewDate(effective.trialEndsAt)}${
                    effective.trialExpired
                      ? ' (הסתיימה)'
                      : ` (עוד ${daysOfTrialLeft(effective.trialEndsAt, now)} ימים)`
                  }`,
          },
          {
            label: 'תקרת פעולות אוטומטיות ליום',
            value:
              effective.actionLimit === null
                ? 'ללא תקרה'
                : effective.actionLimit,
          },
          {
            label: 'הוחלט',
            value: hebrewMoment(capability?.decidedAt ?? null),
          },
          {
            label: 'חבילה',
            value: organization.subscription
              ? organization.subscription.planName
              : 'אין מנוי פעיל',
          },
        ]}
      />

      {effective.divergence !== 'aligned' && (
        <ConsoleNotice
          title={`הרישום וההרשאה אינם תואמים — ${DIVERGENCE_LABEL[effective.divergence]}`}
          tone="warning"
        >
          {effective.divergence === 'entitlement_lingering' ? (
            <p>
              הרישום אומר שהלקוח הזה לא אמור להריץ טייס אוטומטי
              {effective.trialExpired ? ' (ההתנסות הסתיימה)' : ''}, אבל ההרשאה{' '}
              <code dir="ltr">autopilot</code> עדיין בתוקף במנוי — וזו ההרשאה
              שהמוצר קורא. שמירת מצב מהטופס למטה כותבת את שניהם מחדש יחד.
            </p>
          ) : (
            <p>
              הרישום אומר שהלקוח אמור להריץ טייס אוטומטי, אבל ההרשאה{' '}
              <code dir="ltr">autopilot</code> אינה בתוקף — ייתכן שנשללה במסך
              היכולות, וייתכן שהמנוי בוטל. הלקוח אינו רואה את היכולת.
            </p>
          )}
        </ConsoleNotice>
      )}

      {effective.note && (
        <ConsoleNotice title="ההערה שנרשמה על ההחלטה">
          {effective.note}
        </ConsoleNotice>
      )}

      <ConsoleNotice>
        {CAPABILITY_STATE_MEANING[effective.recorded]}{' '}
        {organization.subscription === null &&
          'לארגון אין שורת מנוי פעילה, ולכן אי אפשר לכתוב הרשאה — הטופס יסרב, במקום לכתוב חצי מהשינוי.'}
      </ConsoleNotice>

      {mayManage ? (
        <CapabilityControl
          organizationId={organization.id}
          currentState={effective.recorded}
          currentTrialEndsAt={dateInputValue(effective.trialEndsAt)}
          currentActionLimit={effective.actionLimit}
          currentNote={effective.note}
          options={capabilityStateOptions()}
          action={setAutopilotCapabilityAction}
        />
      ) : (
        <CapabilityControlUnavailable />
      )}

      <FailuresSection failures={failures} readable={actions !== null} />

      <ActionsSection actions={actions} />
    </ConsolePage>
  )
}

/* ------------------------------------------------------------- fragments -- */

/** An ISO instant as `YYYY-MM-DD`, which is what a date input accepts. */
function dateInputValue(value: string | null): string | null {
  if (!value) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString().slice(0, 10)
}

function FailuresSection({
  failures,
  readable,
}: {
  failures: readonly AutopilotActionSummary[]
  readable: boolean
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-bold tracking-tight">
        כשלים ופעולות שדורשות בדיקה
      </h2>

      {!readable ? (
        <ConsoleNotice title="יומן הפעולות לא נקרא" tone="warning">
          לא ניתן היה לקרוא את <code dir="ltr">autopilot_actions</code>. ריק כאן
          אינו עדות לשקט.
        </ConsoleNotice>
      ) : failures.length === 0 ? (
        <ConsoleNotice>
          לא נראתה אף פעולה במצב <code dir="ltr">failed</code>,{' '}
          <code dir="ltr">needs_review</code> או{' '}
          <code dir="ltr">executed_unaudited</code> מבין השורות שנקראו.
        </ConsoleNotice>
      ) : (
        <ConsoleTable
          caption="פעולות שדורשות בדיקה אצל הלקוח הזה"
          head={['מתי', 'פעולה', 'רמת בטיחות', 'תוצאה', 'ניסיון', 'קוד שגיאה']}
        >
          {failures.map((action) => (
            <tr key={action.id}>
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                {hebrewMoment(action.createdAt)}
              </td>
              <td className="px-4 py-3">
                {actionKindLabel(action.actionKind)}
              </td>
              <td className="px-4 py-3">
                {SAFETY_LEVEL_LABEL[action.safetyLevel]}
              </td>
              <td className="px-4 py-3 font-semibold text-danger">
                {ACTION_OUTCOME_LABEL[action.outcome]}
              </td>
              <td className="px-4 py-3">{action.attempt}</td>
              <td className="px-4 py-3" dir="ltr">
                {action.errorCode ?? '—'}
              </td>
            </tr>
          ))}
        </ConsoleTable>
      )}
    </section>
  )
}

function ActionsSection({
  actions,
}: {
  actions: readonly AutopilotActionSummary[] | null
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-lg font-bold tracking-tight">
        פעולות אחרונות
      </h2>
      <p className="text-sm text-muted-foreground">
        מוצגים סוג הפעולה, רמת הבטיחות, ההכרעה והתוצאה. הנימוק שנכתב ללקוח,
        הראיות, גוף ההודעה ותוכן השגיאה אינם נקראים כאן במכוון — הם המילים של
        האורח, וקונסולת פלטפורמה עונה על &quot;כמה נכשלו&quot; בלי לקרוא את
        ההתכתבות.
      </p>

      {actions === null ? (
        <ConsoleNotice title="יומן הפעולות לא נקרא" tone="warning">
          המדיניות <code dir="ltr">autopilot_actions_select</code> מאשרת קריאה
          לחברי הארגון בלבד, ולאיש צוות פלטפורמה אין חברות בשום ארגון. ריק כאן
          אינו מדידה.
        </ConsoleNotice>
      ) : actions.length === 0 ? (
        <ConsoleNotice title="לא נראתה אף שורת פעולה">
          זה יכול להיות ארגון שהטייס האוטומטי שלו עוד לא עשה דבר, ויכול להיות
          שהרצפה של הפלטפורמה אינה מחזירה את השורות האלה כלל — שתי אפשרויות
          שקריאה מהקונסולה אינה מבחינה ביניהן, ולכן לא מוצג כאן אפס כמדידה.
        </ConsoleNotice>
      ) : (
        <ConsoleTable
          caption="פעולות אחרונות של הטייס האוטומטי"
          head={[
            'מתי',
            'פעולה',
            'רמת בטיחות',
            'הכרעה',
            'מצב הרצה',
            'תוצאה',
            'סיבת מניעה',
          ]}
        >
          {actions.map((action) => (
            <tr key={action.id}>
              <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                {hebrewMoment(action.createdAt)}
              </td>
              <td className="px-4 py-3">
                {actionKindLabel(action.actionKind)}
              </td>
              <td className="px-4 py-3">
                {SAFETY_LEVEL_LABEL[action.safetyLevel]}
              </td>
              <td className="px-4 py-3">
                {DISPOSITION_LABEL[action.disposition]}
              </td>
              <td className="px-4 py-3">{RUN_MODE_LABEL[action.runMode]}</td>
              <td className="px-4 py-3">
                {ACTION_OUTCOME_LABEL[action.outcome]}
              </td>
              <td className="px-4 py-3">
                {suppressionReasonLabel(action.suppressedReason)}
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
