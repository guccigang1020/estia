import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { entitlementLabel } from '@/components/nav/labels'
import {
  FactRow,
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { toSafeResponse } from '@/lib/errors'
import { isDemoMode } from '@/lib/demo/flag'
import { effectiveLimits, formatAgorot } from '@/lib/plans/plan'
import { QUOTA_BLOCKS_ACTION } from '@/lib/plans/quota'
import { SupabaseActorSource } from '@/lib/persistence/actor'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  QUOTA_LABEL,
  QUOTA_MEANING,
  QUOTA_OVERAGE_CONSEQUENCE,
  QUOTA_UNIT,
  quotaPolicyLine,
} from './_lib/labels'
import {
  approachingQuotas,
  blockedQuotas,
  comparePlans,
  excludedEntitlements,
  includedEntitlements,
  listOfferedPlans,
  loadEffectivePlan,
  loadUsage,
  priceSummary,
  quotaLines,
  warningQuotas,
  type PlanDifference,
  type QuotaLine,
} from './_lib/queries'

export const metadata: Metadata = { title: 'חבילה וחיוב' }

const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  trialing: 'בתקופת ניסיון',
  active: 'פעיל',
  past_due: 'בפיגור תשלום',
  paused: 'מושהה',
  cancelled: 'בוטל',
}

const INTERVAL_LABEL: Record<string, string> = {
  monthly: 'חודשי',
  yearly: 'שנתי',
}

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The organization's package.
 *
 * WHAT IS ON THIS SCREEN. The live subscription, the package behind it, what
 * that package includes and what it does not, the four quotas with what the
 * business is actually using against each, and what every other package on
 * offer would change — in both directions.
 *
 * A QUOTA THAT BLOCKS AND A QUOTA THAT WARNS ARE DIFFERENT THINGS, and this
 * screen is where that has to be legible. `QUOTA_BLOCKS_ACTION` is the source:
 * properties and units warn, because a business that cannot check a guest in
 * over a fifteenth unit cancels that afternoon; members and storage refuse,
 * because inviting a colleague can wait. They get different tone, different
 * position and — the part that matters — different sentences, naming the action
 * that stops rather than announcing that a policy fired.
 *
 * WHERE THE FIGURES COME FROM. The plan is loaded through `ActorSource`, not
 * read off `organization_subscriptions` directly, so the demo's package
 * switcher and this screen cannot disagree — see `_lib/queries.ts`. The
 * entitlement set and the limits are `effectiveEntitlements` and
 * `effectiveLimits`, which apply the customer's own grants, revocations and
 * overrides; the quota states are `checkQuota`; the price is `agreedPrice` and
 * `isGrandfathered`. Nothing here computes a limit, and nothing divides by 100
 * except `formatAgorot` at the very edge.
 *
 * THE PACKAGES ON OFFER ARE READ FROM `plans` AT RUNTIME, not from
 * `SEED_PLANS` — that file says in its own header that nothing reads it at
 * runtime, because a platform administrator edits prices in the back office.
 *
 * WHAT THIS SCREEN DOES NOT OFFER. There is no upgrade button, no payment
 * method on file and no invoice for the subscription itself, because the
 * product has none of those: no billing provider is wired, `plans` is edited in
 * a back office this application does not contain, and changing `plan_id` is
 * not an action any route here performs. Offering a control that does nothing
 * is worse than not offering it.
 *
 * GATING. `requireGrant('organization.billing.manage')` — an owner-only grant
 * by `OWNER_ONLY`, so an administrator is refused here and correctly so: the
 * package is a commercial commitment, not a setting.
 */
export default async function BillingSettingsPage() {
  const [, context] = await Promise.all([
    requireGrant('organization.billing.manage'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  const db = await createClient()

  let failure: ReturnType<typeof toSafeResponse>['error'] | null = null
  let plan: Awaited<ReturnType<typeof loadEffectivePlan>> = null
  let usage: Awaited<ReturnType<typeof loadUsage>> | null = null
  let offered: Awaited<ReturnType<typeof listOfferedPlans>> = []

  try {
    // The same source `_lib/context.ts` builds, for the same reason: in demo
    // mode the package comes from the switcher, and a screen that read the
    // subscription row directly would contradict the caption above it.
    const source = isDemoMode()
      ? await (async () => {
          const { DemoActorSource, currentDemoPlan } =
            await import('@/lib/demo')
          return new DemoActorSource(
            new SupabaseActorSource(db),
            await currentDemoPlan(),
          )
        })()
      : new SupabaseActorSource(db)

    ;[plan, usage, offered] = await Promise.all([
      loadEffectivePlan(source, context.workspace.organizationId),
      loadUsage(db, context.workspace.organizationId),
      listOfferedPlans(db),
    ])
  } catch (cause) {
    // A screen that renders nothing because a query failed must not look like
    // an organization with no package.
    failure = toSafeResponse(cause, crypto.randomUUID()).error
  }

  if (failure) {
    return (
      <ScreenFrame
        title="חבילה וחיוב"
        lead="מה הארגון משלם עליו, ומה זה כולל."
        width="prose"
      >
        <ActionError error={failure} />
      </ScreenFrame>
    )
  }

  if (!plan || !usage) {
    return (
      <ScreenFrame
        title="חבילה וחיוב"
        lead="מה הארגון משלם עליו, ומה זה כולל."
        width="prose"
      >
        <PanelNote tone="attention">
          לארגון אין רשומת מנוי פעילה. בלעדיה אי אפשר לדעת אילו יכולות כלולות
          ומהן המכסות — וזה מצב אמיתי שהמערכת מכירה, לא תקלה בטעינה.
        </PanelNote>
      </ScreenFrame>
    )
  }

  const limits = effectiveLimits(plan)
  const lines = quotaLines(usage, limits)
  const blocked = blockedQuotas(lines)
  const warning = warningQuotas(lines)
  const approaching = approachingQuotas(lines)
  const price = priceSummary(plan)
  const differences = comparePlans(offered, plan, usage)

  const included = includedEntitlements(plan)
  const excluded = excludedEntitlements(plan)

  return (
    <ScreenFrame
      title="חבילה וחיוב"
      lead="מה הארגון משלם עליו, מה זה כולל, כמה מהמכסות כבר בשימוש — ומה קורה כשחורגים."
      width="prose"
      banner={
        blocked.length > 0 ? (
          <div
            // `alert`: this is a quota that is refusing an action right now,
            // and the owner will otherwise discover it when somebody cannot
            // invite a colleague.
            role="alert"
            className="flex flex-col gap-2 rounded-lg border border-danger bg-surface px-4 py-3 text-sm"
          >
            <p className="font-semibold text-danger">
              {blocked.length === 1
                ? 'מכסה אחת כבר חוסמת פעולה'
                : `${blocked.length} מכסות כבר חוסמות פעולה`}
            </p>
            <ul className="flex flex-col gap-1 text-foreground">
              {blocked.map((line) => (
                <li key={line.key}>
                  {QUOTA_LABEL[line.key]}:{' '}
                  {QUOTA_OVERAGE_CONSEQUENCE[line.key].blocking}
                </li>
              ))}
            </ul>
          </div>
        ) : warning.length > 0 ? (
          <div
            // `status`, not `alert`, and the wording says so: nothing is
            // stopping. This is the distinction the whole screen is about.
            role="status"
            className="flex flex-col gap-2 rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
          >
            <p className="font-semibold">
              {warning.length === 1
                ? 'מכסה אחת חורגת — ושום דבר לא נחסם'
                : `${warning.length} מכסות חורגות — ושום דבר לא נחסם`}
            </p>
            <ul className="flex flex-col gap-1">
              {warning.map((line) => (
                <li key={line.key}>
                  {QUOTA_LABEL[line.key]}:{' '}
                  {QUOTA_OVERAGE_CONSEQUENCE[line.key].warning}
                </li>
              ))}
            </ul>
          </div>
        ) : approaching.length > 0 ? (
          <PanelNote tone="attention">
            {approaching.map((line) => QUOTA_LABEL[line.key]).join(' · ')} —
            מתקרבים לתקרה. עדיף לדעת עכשיו מאשר בפעם הראשונה שמישהו ינסה להוסיף.
          </PanelNote>
        ) : undefined
      }
    >
      {/* --------------------------------------------------- the package -- */}
      <Panel
        title={plan.plan.name}
        description={plan.plan.description}
        action={
          <Badge
            tone={plan.subscription.status === 'active' ? 'brand' : 'accent'}
          >
            {SUBSCRIPTION_STATUS_LABEL[plan.subscription.status] ??
              plan.subscription.status}
          </Badge>
        }
      >
        <dl className="flex flex-col">
          <FactRow label="מחיר מוסכם">
            <span className="tabular-nums">
              {formatAgorot(price.agreedAgorot)} ·{' '}
              {INTERVAL_LABEL[price.interval] ?? price.interval}
            </span>
          </FactRow>
          <FactRow label="מחיר מחירון היום">
            <span className="tabular-nums">
              {formatAgorot(price.listAgorot)}
            </span>
          </FactRow>
          {price.grandfathered && (
            <FactRow label="מחיר משומר">
              {/* `isGrandfathered` is the domain's answer, not a comparison
                  made here. A subscription stores the price agreed at signup
                  and editing the catalogue does not reach it — an owner should
                  read that here rather than in a support call. */}
              אתם משלמים פחות ממחיר המחירון הנוכחי. עריכת מחירון אינה משנה מנוי
              קיים.
            </FactRow>
          )}
          <FactRow label="סוף תקופת החיוב הנוכחית">
            {plan.subscription.currentPeriodEnd
              ? plan.subscription.currentPeriodEnd.toLocaleDateString('he-IL')
              : 'לא נרשם תאריך'}
          </FactRow>
          {plan.subscription.trialEndsAt && (
            <FactRow label="סיום ניסיון">
              {plan.subscription.trialEndsAt.toLocaleDateString('he-IL')}
            </FactRow>
          )}
        </dl>

        {(plan.subscription.entitlementGrants.length > 0 ||
          plan.subscription.entitlementRevocations.length > 0 ||
          Object.keys(plan.subscription.limitOverrides).length > 0) && (
          <div className="mt-5 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">
              לארגון הזה יש התאמות אישיות מעבר לחבילה
            </p>
            <p className="mt-1">
              היכולות והמכסות שמוצגות למטה כבר כוללות אותן, ולכן הן עשויות
              להיראות שונה ממה שכתוב בדף המחירים.
            </p>
          </div>
        )}
      </Panel>

      {/* ---------------------------------------------------- what is in -- */}
      <Panel
        title="מה כלול"
        description="יכולת שאינה כלולה מוצגת ולא נעלמת — כדי שההבדל בין ״אין לך הרשאה״ ל״החבילה לא כוללת״ יישאר ברור, בדיוק כפי שהוא מוצג בתפריט."
      >
        <ul className="flex flex-wrap gap-2">
          {included.map((entitlement) => (
            <li key={entitlement}>
              <Badge tone="brand">{entitlementLabel(entitlement)}</Badge>
            </li>
          ))}
          {excluded.map((entitlement) => (
            <li key={entitlement}>
              <Badge tone="neutral" className="opacity-70">
                {entitlementLabel(entitlement)}
              </Badge>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ------------------------------------------------------- quotas -- */}
      <Panel
        title="מכסות"
        description="כמה מכל מכסה כבר בשימוש, ומה קורה כשעוברים אותה. שתי השורות האחרונות חוסמות פעולה; שתי הראשונות לא."
      >
        <dl className="flex flex-col gap-5">
          {lines.map((line) => (
            <QuotaRow key={line.key} line={line} />
          ))}
        </dl>
      </Panel>

      {/* ---------------------------------------------------- the offer -- */}
      <Panel
        title="חבילות אחרות"
        description="נקרא מטבלת החבילות בזמן אמת ולא מרשימה בקוד, כי מנהל הפלטפורמה עורך מחירים ויכולות מחוץ למסך הזה."
      >
        {differences.length === 0 ? (
          <PanelNote>אין חבילה נוספת שמוצעת כרגע.</PanelNote>
        ) : (
          <div className="flex flex-col gap-6">
            {differences.map((difference) => (
              <PlanComparison
                key={difference.plan.id}
                difference={difference}
                interval={price.interval}
              />
            ))}
          </div>
        )}

        <p className="mt-6 border-t border-border pt-4 text-sm text-muted-foreground">
          אין כאן כפתור שדרוג, ובכוונה: המוצר לא מחובר לספק סליקה למנויים, אין
          אמצעי תשלום שמור, ואף מסלול בקוד אינו משנה את החבילה. כפתור שלא עושה
          דבר גרוע מהיעדר כפתור. לשינוי חבילה — פנייה לצוות ESTIA.
        </p>
      </Panel>
    </ScreenFrame>
  )
}

/* ----------------------------------------------------------------- rows -- */

function QuotaRow({ line }: { line: QuotaLine }) {
  const label = QUOTA_LABEL[line.key]

  if (line.state === null) {
    return (
      <div className="flex flex-col gap-1 border-b border-border pb-4 last:border-b-0 last:pb-0">
        <dt className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-semibold text-foreground">{label}</span>
          <span className="text-sm text-muted-foreground">לא נמדד</span>
        </dt>
        <dd className="text-sm text-muted-foreground">
          {line.unmeasuredReason}
        </dd>
        <dd className="text-sm text-muted-foreground">
          {quotaPolicyLine(line.key, line.blocks)}
        </dd>
      </div>
    )
  }

  const { current, limit, inOverage, approaching } = line.state
  const unit = QUOTA_UNIT[line.key]

  return (
    <div className="flex flex-col gap-1.5 border-b border-border pb-4 last:border-b-0 last:pb-0">
      <dt className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold text-foreground">{label}</span>
        <span className="tabular-nums text-sm text-foreground">
          {current}
          {unit && ` ${unit}`}
          {' / '}
          {limit === null ? 'ללא הגבלה' : `${limit}${unit ? ` ${unit}` : ''}`}
        </span>
      </dt>

      {limit !== null && (
        <dd>
          <Meter current={current} limit={limit} blocked={line.blocked} />
        </dd>
      )}

      <dd className="text-sm text-muted-foreground">
        {QUOTA_MEANING[line.key]}
      </dd>

      <dd className="text-sm text-muted-foreground">
        {quotaPolicyLine(line.key, line.blocks)}
      </dd>

      {inOverage && (
        <dd
          className={
            line.blocked
              ? 'text-sm font-semibold text-danger'
              : 'text-sm text-foreground'
          }
        >
          {line.blocked
            ? QUOTA_OVERAGE_CONSEQUENCE[line.key].blocking
            : QUOTA_OVERAGE_CONSEQUENCE[line.key].warning}
        </dd>
      )}

      {!inOverage && approaching && (
        <dd className="text-sm text-foreground">
          מתקרבים לתקרה. עדיין לא נחסם דבר.
        </dd>
      )}
    </div>
  )
}

/**
 * A bar, with the figure always beside it.
 *
 * Colour is never the only signal in this product: the numbers are printed
 * above and the consequence is printed below, so a reader who cannot
 * distinguish the fill from the track loses nothing. `aria-hidden` because the
 * `dt` above already announces both figures — a progressbar role would make a
 * screen reader read the same ratio twice.
 */
function Meter({
  current,
  limit,
  blocked,
}: {
  current: number
  limit: number
  blocked: boolean
}) {
  const ratio = limit === 0 ? 1 : Math.min(current / limit, 1)
  const over = current > limit

  return (
    <div
      aria-hidden="true"
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={
          blocked
            ? 'h-full bg-danger'
            : over
              ? 'h-full bg-warning'
              : 'h-full bg-primary'
        }
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  )
}

function PlanComparison({
  difference,
  interval,
}: {
  difference: PlanDifference
  interval: 'monthly' | 'yearly'
}) {
  const { plan, gains, losses, limitChanges, isUpgrade } = difference
  const priceAgorot =
    interval === 'yearly' ? plan.yearlyPriceAgorot : plan.monthlyPriceAgorot

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-base font-bold text-foreground">
          {plan.name}
        </span>
        <span className="flex items-baseline gap-2">
          <Badge tone={isUpgrade ? 'brand' : 'neutral'}>
            {isUpgrade ? 'שדרוג' : 'חבילה נמוכה יותר'}
          </Badge>
          <span className="tabular-nums text-sm font-semibold text-foreground">
            {formatAgorot(priceAgorot)}
          </span>
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{plan.description}</p>

      {gains.length > 0 && (
        <p className="text-sm text-foreground">
          <span className="font-semibold">נוסף: </span>
          {gains
            .map((entitlement) => entitlementLabel(entitlement))
            .join(' · ')}
        </p>
      )}

      {/* Both directions. A comparison table that only ever adds is a sales
          page; an owner considering a cheaper package has to see what goes. */}
      {losses.length > 0 && (
        <p className="text-sm text-foreground">
          <span className="font-semibold">נגרע: </span>
          {losses
            .map((entitlement) => entitlementLabel(entitlement))
            .join(' · ')}
        </p>
      )}

      {limitChanges.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {limitChanges.map((change) => (
            <li
              key={change.key}
              className={
                change.alreadyExceeded
                  ? 'font-semibold text-danger'
                  : 'text-muted-foreground'
              }
            >
              {QUOTA_LABEL[change.key]}:{' '}
              {change.from === null ? 'ללא הגבלה' : change.from} →{' '}
              {change.to === null ? 'ללא הגבלה' : change.to}
              {/* The figure alone does not say what it costs. A business
                  already past a ceiling that *blocks* would lose an action by
                  moving here; one past a ceiling that only warns would not,
                  and telling them otherwise would sell them a package on a
                  fear the product does not actually impose. */}
              {change.alreadyExceeded &&
                ` — כבר עכשיו אתם מעל התקרה הזו. ${
                  QUOTA_BLOCKS_ACTION[change.key]
                    ? QUOTA_OVERAGE_CONSEQUENCE[change.key].blocking
                    : QUOTA_OVERAGE_CONSEQUENCE[change.key].warning
                }`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
