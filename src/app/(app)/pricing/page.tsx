import type { Metadata } from 'next'

import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import {
  formatHebrewDate,
  isPeakNight,
  specialDaysOn,
} from '@/lib/hebrew-calendar'
import { createClient } from '@/lib/supabase/server'
import {
  PRICING_NOTE,
  RATE_CALENDAR_SOURCE_LABEL,
  RATE_PLAN_KIND_LABEL,
  formatAgorotShort,
} from '@/lib/pricing'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { loadPricingScreen, monthBounds } from './_lib/queries'
import { BulkEditor, NightEditor } from './night-editor'

export const metadata: Metadata = { title: 'מחירון · ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The rate card.
 *
 * ══ WHY THIS IS A NEW ROUTE ═════════════════════════════════════════════════
 *
 * `/promotions` is about DISCOUNTS — money taken off a total — and says in its
 * own header that there is no promotions catalogue. `/quotes` is one stay's
 * answer. This is the machine that answers: what a night costs before anybody
 * discounts anything.
 *
 * The distinction is load-bearing rather than tidy. Spec §7.7: an agent rate
 * is a rate PLAN, chosen at step 1 before any night is priced, and a promotion
 * is a line at step 11. The reason a season, a weekend uplift, an agent rate
 * and a campaign combine into one number without arguing is that they act at
 * four different levels — and a screen that mixed two of them would teach the
 * opposite.
 *
 * ══ 🔒 WHAT THIS SCREEN CANNOT DO ═══════════════════════════════════════════
 *
 * It cannot change the price of a booking. Not by editing a night, not by
 * moving a season, not by raising a floor. A booking holds a snapshot of its
 * own price, and there is no code path from this screen to
 * `booking_price_lines`. That is stated on the screen, in Hebrew, because it
 * is the question a business actually asks before it touches a rate card in
 * October — "will this change what people already booked" — and the answer is
 * worth more than a tooltip.
 *
 * ══ NO NAVIGATION ENTRY ═════════════════════════════════════════════════════
 *
 * `src/components/nav/menu.ts` belongs to another agent in this repository and
 * is not edited here, so this route is reachable by URL and not yet from the
 * sidebar. That changes nothing about access: `requireGrant` refuses below,
 * `can()` refuses in every operation, and row level security refuses under
 * both — a menu entry is a hint about where to go, never a permission.
 *
 * GATING. `rate.view_public` to read; `pricing.manage` to change anything. The
 * editors are not rendered without the second, rather than rendered and
 * refused, and the server refuses regardless.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; unit?: string; plan?: string }>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('rate.view_public'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const canManage = context.actor.grants.has('pricing.manage')

  const propertyIds =
    context.selectedPropertyId === ALL_PROPERTIES
      ? context.properties.map((property) => property.id)
      : [context.selectedPropertyId]

  // The current month at the property, not at the server. A rate card opened
  // at 22:30 UTC in December must not show November.
  const month =
    params.month ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date())

  const lead =
    'מה עולה לילה, לפני כל הנחה. עונות, סופי שבוע וחגים, ומחיר ידני ללילה בודד. ' +
    'שינוי כאן אינו נוגע בהזמנה קיימת — כל הזמנה מחזיקה צילום של המחיר שלה.'

  const db = await createClient()
  const screen = await loadPricingScreen(db, actor, {
    propertyIds,
    month,
    unitId: params.unit,
    ratePlanId: params.plan,
  })

  if (screen.status === 'not_provisioned') {
    return (
      <ScreenFrame title="מחירון" lead={lead} width="prose">
        <Panel title="הנתונים אינם זמינים">
          <PanelNote>{PRICING_NOTE.notProvisioned}</PanelNote>
        </Panel>
      </ScreenFrame>
    )
  }

  const { plans, units, calendar, focus, suggestions, policy } = screen
  const focusUnit = units.find((unit) => unit.id === focus?.unitId)
  const bounds = monthBounds(month)
  const nights = nightsOf(bounds.from, bounds.to)
  const byDate = new Map(calendar.map((entry) => [entry.date, entry]))

  return (
    <ScreenFrame title="מחירון" lead={lead}>
      <Panel
        title="תוכניות תעריפים"
        count={plans.length}
        description="בדיוק תוכנית אחת נבחרת לכל ציטוט, לפני שלילה אחד מתומחר. תעריף סוכן אינו הנחה — הוא תוכנית אחרת, ולכן הוא לא מתחרה במבצע ולא מצטבר איתו."
      >
        {plans.length === 0 ? (
          <PanelNote>
            עוד לא הוגדרה תוכנית תעריפים. בלי תוכנית אי אפשר לצטט מחיר — ציטוט
            בלי תוכנית הוא מחיר שאיש לא אישר.
          </PanelNote>
        ) : (
          <RowList>
            {plans.map((plan) => (
              <Row key={plan.id} className="flex-col items-stretch gap-1.5">
                <FactRow label={plan.name}>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge>{RATE_PLAN_KIND_LABEL[plan.kind]}</Badge>
                    {!plan.isActive && <Badge>לא פעילה</Badge>}
                    <span className="font-mono text-xs text-muted-foreground">
                      {plan.code}
                    </span>
                  </span>
                </FactRow>
                <p className="text-xs text-muted-foreground">
                  {plan.floorAgorot === null && plan.ceilingAgorot === null
                    ? 'ללא רצפה ותקרה. מחיר לילה לא ייצבט לטווח.'
                    : `רצפה ${plan.floorAgorot === null ? '—' : formatAgorotShort(plan.floorAgorot)} · ` +
                      `תקרה ${plan.ceilingAgorot === null ? '—' : formatAgorotShort(plan.ceilingAgorot)}`}
                  {plan.requiresGrant !== null &&
                    ` · דורשת הרשאה ${plan.requiresGrant}`}
                </p>
              </Row>
            ))}
          </RowList>
        )}
      </Panel>

      <Panel
        title="לוח המחירים"
        description={
          focusUnit
            ? `${focusUnit.name} · ${month}. מחיר ידני ללילה גובר על כל חוק עונתי — מי שהקליד מספר ללילה מסוים התכוון אליו.`
            : 'בחר יחידה ותוכנית תעריפים כדי לראות חודש שלם.'
        }
        action={
          focus && focusUnit ? (
            <BulkEditor
              unitId={focus.unitId}
              propertyId={focusUnit.propertyId}
              ratePlanId={focus.ratePlanId}
              from={bounds.from}
              to={bounds.to}
              nightCount={nights.length}
              currentTotalAgorot={calendar.reduce(
                (total, entry) => total + entry.nightlyAgorot,
                0,
              )}
              canManage={canManage}
            />
          ) : undefined
        }
      >
        {focus === null || focusUnit === undefined ? (
          <PanelNote>{PRICING_NOTE.noRateCard}</PanelNote>
        ) : (
          <>
            {calendar.length === 0 && (
              <PanelNote>{PRICING_NOTE.noRateCard}</PanelNote>
            )}
            {/*
              A vertical list rather than a grid, at every width. Spec §5.1
              wants a month grid on the desktop and a list on a telephone; a
              list is what both collapse to correctly, and a grid that scrolls
              sideways is the one failure the mobile acceptance criterion names
              by name.
            */}
            <RowList>
              {nights.map((date) => {
                const entry = byDate.get(date)
                const special = specialDaysOn(date)[0]
                return (
                  <Row key={date} className="flex-col items-stretch gap-1.5">
                    <FactRow label={formatHebrewDate(date)}>
                      <span className="flex flex-wrap items-center gap-2">
                        {isPeakNight(date) && <Badge>שיא</Badge>}
                        {special && <Badge>{special.shortName}</Badge>}
                        <span className="font-mono text-sm">
                          {entry === undefined
                            ? '—'
                            : formatAgorotShort(entry.nightlyAgorot)}
                        </span>
                      </span>
                    </FactRow>
                    <p className="text-xs text-muted-foreground">
                      {entry === undefined
                        ? 'אין מחיר ידני ללילה הזה. המחיר ייקבע מחוקי התעריף, ואם אין — ממחיר הבסיס של היחידה.'
                        : RATE_CALENDAR_SOURCE_LABEL[entry.source]}
                    </p>
                    <NightEditor
                      unitId={focus.unitId}
                      propertyId={focusUnit.propertyId}
                      ratePlanId={focus.ratePlanId}
                      date={date}
                      currentAgorot={entry?.nightlyAgorot ?? null}
                      expectedVersion={entry?.version}
                      // Occupancy is not read on this screen, so no night is
                      // claimed to be sold here. The refusal that matters is
                      // enforced on approval, where a sold night is checked
                      // against the occupancy ledger — a claim made from a
                      // screen that has not looked would be a guess.
                      isSold={false}
                      canManage={canManage}
                    />
                  </Row>
                )
              })}
            </RowList>
          </>
        )}
      </Panel>

      <Panel
        title="המלצות תמחור"
        count={suggestions.length}
        description="המלצה לעולם אינה מחיר. היא הופכת למחיר רק כשאדם מאשר אותה, והמחיר שנכתב נושא את שמו."
      >
        {!canManage ? (
          <PanelNote>
            נדרשת הרשאת ניהול מחירון כדי לראות המלצות. ההמלצה מציגה את המחיר
            הדטרמיניסטי לצד ההצעה, ושניהם יחד הם מידע מסחרי.
          </PanelNote>
        ) : suggestions.length === 0 ? (
          <PanelNote>{PRICING_NOTE.noEngine}</PanelNote>
        ) : (
          <RowList>
            {suggestions.map((suggestion) => (
              <Row key={suggestion.id} className="flex-col items-stretch gap-1">
                <FactRow label={suggestion.date}>
                  <span className="font-mono text-sm">
                    {formatAgorotShort(suggestion.suggestedAgorot)}
                  </span>
                </FactRow>
                <p className="text-xs text-muted-foreground">
                  דטרמיניסטי {formatAgorotShort(suggestion.deterministicAgorot)}{' '}
                  · {suggestion.rationale}
                </p>
              </Row>
            ))}
          </RowList>
        )}
      </Panel>

      <Panel
        title="תמחור אוטומטי"
        description="כל שדה במדיניות הוא גבול, וכולם יחד נדרשים. אם אחד מהם לא מתקיים — ההמלצה ממתינה לאדם."
      >
        {!canManage ? (
          <PanelNote>נדרשת הרשאת ניהול מחירון.</PanelNote>
        ) : policy === null ? (
          <PanelNote>
            לא הוגדרה מדיניות תמחור אוטומטי. בלי מדיניות, שום מחיר לא זז בלי
            שאדם לחץ עליו.
          </PanelNote>
        ) : (
          <RowList>
            <Row>
              <FactRow label="אישור אוטומטי">
                <Badge>{policy.autoApply ? 'פעיל' : 'כבוי'}</Badge>
              </FactRow>
            </Row>
            <Row>
              <FactRow label="פער מרבי מהמחיר הדטרמיניסטי">
                <span className="font-mono text-sm">
                  {policy.maxDeltaBps / 100}%
                </span>
              </FactRow>
            </Row>
            <Row>
              <FactRow label="שינויים אוטומטיים ליחידה ליום">
                <span className="font-mono text-sm">
                  {policy.maxDailyChanges}
                </span>
              </FactRow>
            </Row>
          </RowList>
        )}
        <div className="mt-4">
          <PanelNote>{PRICING_NOTE.frozen}</PanelNote>
        </div>
      </Panel>
    </ScreenFrame>
  )
}

/** Every date in `[from, to)`. Half-open, like every range in the product. */
function nightsOf(from: string, to: string): string[] {
  const dates: string[] = []
  let cursor = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  while (cursor < end) {
    dates.push(new Date(cursor).toISOString().slice(0, 10))
    cursor += 86_400_000
  }
  return dates
}
