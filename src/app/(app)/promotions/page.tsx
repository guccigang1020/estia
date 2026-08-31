import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { PlanLock } from '@/components/distribution/plan-lock'
import { Money } from '@/components/finance/money'
import { EmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { COMMISSION_BASE_LABEL } from '@/lib/contracts/states'
import { formatDayMonthYear } from '@/lib/booking'
import { COMMISSION_CONDITION_LABEL } from '@/lib/agents'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireDistributionGrant } from '../agents/_lib/gate'
import {
  giveawayTotalAgorot,
  groupGiveaways,
  listDiscountCeilings,
  listGiveaways,
  listRateRules,
  type DiscountCeiling,
  type GiveawayLine,
  type RateRule,
} from './_lib/queries'

export const metadata: Metadata = { title: 'מבצעים ותמחור' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The rules that decide what money moves,
 * and what has actually been given away.
 *
 * ══ THE HONEST STATEMENT THIS SCREEN LEADS WITH ══════════════════════════
 *
 * There is no promotions catalogue in ESTIA. `promotion` is a member of
 * `PRICE_LINE_KINDS` — a line on a booking — and no table stores a campaign, a
 * rate plan or a pricing calendar. `pricing.manage` is in the permission
 * catalogue and `dynamic_pricing` is an entitlement, and the engine behind them
 * is not built.
 *
 * Drawing campaign cards over that would be the worst kind of screen: a
 * business would plan a season around "last-minute · midweek · early bird" tiles
 * that apply to nothing, and would find out when the bookings came in at full
 * price. So the screen says what exists, and shows it.
 *
 * WHAT EXISTS, AND IS SHOWN.
 *
 *   1. **Commission rules** — `agent_commission_rules`, which is a real rate
 *      rule with versioning, scope, eligibility conditions and priority. It is
 *      what decides what a seller earns.
 *   2. **Discount ceilings** — what each seller may hand over before it becomes
 *      an approval rather than a refusal. The other half of the same question.
 *   3. **Reductions actually given** — the `discount` and `promotion` lines on
 *      real bookings, grouped by the label somebody typed. That is the nearest
 *      truthful answer to "which promotions are running": the ones people ran.
 *
 * A RULE WITH NO PROPERTY LIST APPLIES EVERYWHERE. `property_ids` is nullable
 * and 0015 is explicit that `NULL` and `'{}'` are opposites — no list means
 * every property, an emptied list means none. The query preserves the
 * distinction and this screen renders it in words, because an owner reading
 * "no properties" beside a rule that pays on the whole portfolio is reading the
 * exact opposite of the truth.
 *
 * GATING. `pricing.manage` is mapped to `dynamic_pricing`, which Basic and
 * Direct do not carry — so those organizations get the upgrade screen rather
 * than a permission refusal. The three panels below are each gated again on
 * their own grant: the rules on `commission.view` and the reductions on
 * `booking.view_price`, because a reduction is a price.
 */
export default async function PromotionsPage() {
  const [access, context] = await Promise.all([
    requireDistributionGrant('pricing.manage'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="תמחור ומבצעים אינם כלולים בחבילה שלך"
        body="כאן היו מוצגים כללי התמחור והעמלה של העסק, תקרות ההנחה של הסוכנים, וההנחות שכבר ניתנו בפועל."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let rules: readonly RateRule[] = []
  let ceilings: readonly DiscountCeiling[] = []
  let giveaways: readonly GiveawayLine[] | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[rules, ceilings, giveaways] = await Promise.all([
      listRateRules({ db, actor, organizationId: actor.organizationId }),
      listDiscountCeilings({ db, actor, organizationId: actor.organizationId }),
      listGiveaways({
        db,
        actor,
        organizationId: actor.organizationId,
        propertyId,
      }),
    ])
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const groups = giveaways === null ? [] : groupGiveaways(giveaways)
  const given = giveawayTotalAgorot(giveaways)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          מבצעים ותמחור
        </h1>
        <p className="text-muted-foreground">
          הכללים שקובעים כמה כסף זז, ומה כבר ניתן בפועל.
        </p>
      </header>

      {/* The honest statement, on the screen and not only in the code. */}
      <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">
          אין עדיין קטלוג מבצעים במערכת.
        </span>{' '}
        מבצע היום הוא שורת הנחה שמישהו רשם על הזמנה — לא קמפיין שהמערכת מפעילה
        לפי תאריכים או תפוסה. מה שכן קיים כמנוע כללים הוא כללי העמלה של הסוכנים
        ותקרות ההנחה שלהם, והם מוצגים כאן כפי שהם.
      </p>

      {failure ? (
        <ActionError error={failure.error} />
      ) : (
        <>
          {/* ------------------------------------------------- rules -- */}
          <Card>
            <CardHeader>
              <CardTitle as="h2">כללי עמלה</CardTitle>
            </CardHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              כלל אחד נבחר לכל הזמנה: העדיפות הגבוהה ביותר מנצחת, ובין כללים
              שווי־עדיפות מנצח המדויק יותר. הכלל נשמר על העמלה ברגע שהיא נוצרת,
              כדי שהמחיר לא ישתנה למפרע כשמשנים את הכלל.
            </p>

            {rules.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                לא נכתבו כללי עמלה, או שאינם גלויים לך. בלי כלל, עמלה נכתבת לפי
                ההסכם עם הסוכנות.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-border">
                {rules.map((rule) => (
                  <li key={rule.id} className="py-4">
                    <Rule rule={rule} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ---------------------------------------------- ceilings -- */}
          <Card>
            <CardHeader>
              <CardTitle as="h2">תקרות הנחה</CardTitle>
            </CardHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              כמה כל סוכן רשאי להוריד מהמחיר לפני שזה הופך לבקשת אישור. מעבר
              לתקרה המערכת לא מסרבת — היא שולחת את הבקשה למי שמחליט, כדי שהמשא
              ומתן יישאר בתוך המערכת.
            </p>

            {ceilings.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                אין סוכנים בטווח שלך, ולכן אין תקרות להציג.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {ceilings.map((ceiling) => (
                  <li
                    key={ceiling.agentUserId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm"
                  >
                    <span className="font-medium text-foreground">
                      {ceiling.agentName ?? 'סוכן ללא שם רשום'}
                    </span>
                    <span className="text-muted-foreground">
                      {ceiling.maxPercent === 0 ? (
                        'אינו רשאי לתת הנחה'
                      ) : (
                        <>
                          עד {ceiling.maxPercent}%
                          {ceiling.maxAgorot !== null && (
                            <>
                              {' '}
                              ולא יותר מ־
                              <Money agorot={ceiling.maxAgorot} />
                            </>
                          )}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* --------------------------------------------- giveaways -- */}
          <Card>
            <CardHeader>
              <CardTitle as="h2">מה כבר ניתן בפועל</CardTitle>
            </CardHeader>

            {giveaways === null ? (
              <p className="mt-3 text-sm text-muted-foreground">
                מחירים אינם גלויים לך, ולכן ההנחות אינן מוצגות. זו אינה טענה שלא
                ניתנו הנחות.
              </p>
            ) : groups.length === 0 ? (
              <EmptyState
                className="mt-4"
                illustration="invoice"
                title="עוד לא ניתנה הנחה"
                body="כשמישהו מוריד מהמחיר בהזמנה, זה נרשם כשורה נפרדת עם שם — וכל השורות עם אותו שם נאספות כאן. זו הדרך היחידה כרגע לראות ״איזה מבצע רץ״, כי אין קטלוג מבצעים שאפשר לשאול אותו."
              />
            ) : (
              <>
                <dl className="mt-3 flex flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">
                    סך ההנחות בשורות המוצגות
                  </dt>
                  <dd className="font-display text-xl font-bold tabular-nums text-foreground">
                    <Money agorot={given} emphasis />
                  </dd>
                </dl>

                <ul className="mt-4 flex flex-col divide-y divide-border">
                  {groups.map((group) => (
                    <li
                      key={`${group.kind}:${group.label}`}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <span className="flex items-center gap-3">
                        <Badge>
                          {group.kind === 'promotion' ? 'מבצע' : 'הנחה'}
                        </Badge>
                        <span className="text-sm text-foreground">
                          {group.label}
                        </span>
                      </span>
                      <span className="flex items-center gap-4">
                        <span className="text-xs text-muted-foreground">
                          {group.count === 1
                            ? 'הזמנה אחת'
                            : `${group.count} הזמנות`}
                        </span>
                        <Money agorot={group.totalAgorot} emphasis />
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- parts -- */

/**
 * One commission rule, with the scope stated in words.
 *
 * The `appliesEverywhere` case is spelled out rather than shown as an empty
 * list, because "no properties listed" reads as the opposite of what it means.
 */
function Rule({ rule }: { rule: RateRule }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-base font-bold text-foreground">
          {rule.name}
        </span>
        <Badge tone="brand">
          {rule.rulePercent !== null
            ? `${rule.rulePercent}%`
            : rule.ruleAgorot !== null
              ? 'סכום קבוע'
              : rule.ruleKind === 'none'
                ? 'ללא עמלה'
                : 'תנאים לא קריאים'}
        </Badge>
        <span className="text-sm text-muted-foreground">
          מתוך {COMMISSION_BASE_LABEL[rule.base]}
        </span>
        <Badge>עדיפות {rule.priority}</Badge>
      </div>

      <span className="text-sm text-muted-foreground">
        {rule.agentName !== null
          ? `לסוכן ${rule.agentName}`
          : rule.agentUserId !== null
            ? 'לסוכן שאינו גלוי לך'
            : rule.agencyName !== null
              ? `לסוכנות ${rule.agencyName}`
              : 'ללא סוכן או סוכנות מוגדרים'}
        {' · '}
        {rule.appliesEverywhere
          ? 'חל על כל הנכסים, כולל נכסים שייקנו בהמשך'
          : rule.propertyNames.length > 0
            ? `חל על ${rule.propertyNames.join(' · ')}`
            : rule.propertyIds !== null && rule.propertyIds.length === 0
              ? 'רשימת הנכסים ריקה — הכלל אינו חל על אף נכס'
              : `חל על ${rule.propertyIds?.length ?? 0} נכסים שאינם גלויים לך`}
      </span>

      {rule.eligibility.length > 0 && (
        <span className="text-xs text-muted-foreground">
          נעשית חוב רק כאשר:{' '}
          {rule.eligibility
            .map((condition) => conditionLabel(condition))
            .join(' · ')}
        </span>
      )}

      <span className="text-xs text-muted-foreground">
        {rule.effectiveFrom === null
          ? 'ללא תאריך תחילה'
          : `בתוקף מ־${formatDayMonthYear(rule.effectiveFrom)}`}
        {rule.effectiveUntil !== null &&
          ` עד ${formatDayMonthYear(rule.effectiveUntil)}`}
      </span>

      {rule.note !== null && (
        <span className="text-xs text-muted-foreground">{rule.note}</span>
      )}
    </div>
  )
}

/**
 * The Hebrew for an eligibility condition, from the domain's own table.
 *
 * Falls back to the raw value rather than inventing a name: the column is
 * constrained, so an unfamiliar value means the schema moved and the label
 * table did not, which a reader should see as a strange word rather than as a
 * confident mistranslation.
 */
function conditionLabel(condition: string): string {
  return condition in COMMISSION_CONDITION_LABEL
    ? COMMISSION_CONDITION_LABEL[
        condition as keyof typeof COMMISSION_CONDITION_LABEL
      ]
    : condition
}
