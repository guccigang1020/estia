import type { Metadata } from 'next'
import Link from 'next/link'

import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import {
  Dial,
  Figure as SharedFigure,
  Instrument,
  InstrumentBar,
} from '@/components/ui/metric'
import {
  METRIC_LABEL,
  METRIC_NOTE,
  SOURCE_LABEL,
  UNMEASURABLE_LABEL,
  WINDOW_LABEL,
  isWindowName,
  shekels,
  windowFor,
  type Measure,
  type WindowName,
} from '@/lib/revenue'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { loadRevenueScreen } from './_lib/queries'

export const metadata: Metadata = { title: 'הכנסות · ESTIA' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What the business earned, from the
 * rows it already has.
 *
 * THIS SCREEN WRITES NOTHING AND STORES NOTHING. Every figure is computed on
 * read, for the reason `listing-quality` gives: a stored number drifts from
 * the rows it describes, and a revenue figure that is quietly a week old is
 * the one a season gets priced against.
 *
 * WHAT IT REFUSES TO ANSWER. Market position — how this business compares to
 * its competitors — is `not_in_product` on every input, because there is no
 * source of competitor prices here or behind here. That is the same refusal
 * `unit.market_position` makes in `listing-quality`, and it is the honest end
 * of the "revenue intelligence / market data" module: everything that can be
 * built from internal data is built, and the half that needs a market feed is
 * named rather than invented.
 *
 * WHY ADR IS NOT THE BOOKING TOTAL. `metrics.ts` argues it at length. In one
 * line: a ₪350 cabin with a ₪150 cleaning fee reports ₪425 a night if the
 * total is used, and next summer gets priced a fifth too high.
 *
 * GATING. `report.financial.view` — this is the money. Row level security
 * refuses underneath regardless.
 */
export default async function RevenuePage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('report.financial.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const requested = params.window
  const windowName: WindowName = isWindowName(requested) ? requested : '30d'
  const window = windowFor(windowName, new Date())

  const propertyIds =
    context.selectedPropertyId === ALL_PROPERTIES
      ? context.properties.map((property) => property.id)
      : [context.selectedPropertyId]

  const db = await createClient()
  const screen = await loadRevenueScreen(
    db,
    actor.organizationId,
    propertyIds,
    window,
  )

  const lead =
    'מה שהעסק הרוויח בפועל, מחושב בכל טעינה מההזמנות עצמן. מספר שאין לו מקור ' +
    'נתונים אמיתי מוצג כחסר עם הסיבה, ולא מוערך.'

  if (screen.status === 'not_provisioned') {
    return (
      <ScreenFrame title="הכנסות" lead={lead} width="prose">
        <Panel title="הנתונים אינם זמינים">
          <PanelNote>
            אחת מהטבלאות שהמסך קורא אינה קיימת בבסיס הנתונים הזה.
          </PanelNote>
        </Panel>
      </ScreenFrame>
    )
  }

  const { report, bookableUnits, unitsInMaintenance, demand } = screen

  return (
    <ScreenFrame title="הכנסות" lead={lead} width="prose">
      <Panel
        title="טווח"
        description={`${window.from} עד ${window.to} — הלילה של היום עדיין לא נספר.`}
      >
        <div className="flex flex-wrap gap-2">
          {(['30d', '90d', '365d'] as const).map((name) => (
            <Link
              key={name}
              href={`/revenue?window=${name}`}
              className={
                name === windowName
                  ? 'rounded-md border border-foreground px-3 py-1 text-sm'
                  : 'rounded-md border px-3 py-1 text-sm text-muted-foreground'
              }
            >
              {WINDOW_LABEL[name]}
            </Link>
          ))}
        </div>
      </Panel>

      {/*
        The instrument row. Two dials and the money between them — and the
        dials are here rather than on the dashboard because these are the two
        figures in the product that HAVE a real denominator: occupancy divides
        by bookable unit-nights, and the cancellation rate divides by the
        bookings that were actually decided. A dial without a denominator is a
        decoration shaped like a measurement.

        `null` when the measure is unknown, never 0. `Dial` draws the track
        and no value for null, so "nobody counted the units" cannot be read as
        "nothing was sold" — which is the distinction `metrics.ts` spends its
        whole `no_denominator` branch protecting.
      */}
      <InstrumentBar>
        <Instrument>
          <Dial
            fraction={
              report.occupancy.known ? report.occupancy.value / 100 : null
            }
            label={METRIC_LABEL.occupancy}
            value={
              report.occupancy.known ? (
                <>
                  {report.occupancy.value}
                  <span className="text-sm font-light text-muted-foreground">
                    %
                  </span>
                </>
              ) : (
                <span className="text-sm font-normal text-muted-foreground">
                  —
                </span>
              )
            }
          />
        </Instrument>

        <Instrument className="flex-col items-stretch gap-1 sm:items-stretch">
          <Figure label={METRIC_LABEL.adr} measure={report.adrAgorot} money />
          <Figure
            label={METRIC_LABEL.revpar}
            measure={report.revparAgorot}
            money
          />
        </Instrument>

        <Instrument>
          <Dial
            tone="accent"
            sweep={0.75}
            fraction={
              report.cancellationRate.known
                ? report.cancellationRate.value / 100
                : null
            }
            label={METRIC_LABEL.cancellation}
            value={
              report.cancellationRate.known ? (
                <>
                  {report.cancellationRate.value}
                  <span className="text-sm font-light text-muted-foreground">
                    %
                  </span>
                </>
              ) : (
                <span className="text-sm font-normal text-muted-foreground">
                  —
                </span>
              )
            }
          />
        </Instrument>
      </InstrumentBar>

      <Panel title="השורה התחתונה">
        <RowList>
          <Figure
            label={METRIC_LABEL.occupancy}
            measure={report.occupancy}
            unit="%"
          />
          <Figure label={METRIC_LABEL.adr} measure={report.adrAgorot} money />
          <Figure
            label={METRIC_LABEL.revpar}
            measure={report.revparAgorot}
            money
          />
          <Figure
            label={METRIC_LABEL.roomRevenue}
            measure={report.roomRevenueAgorot}
            money
          />
          <Figure
            label={METRIC_LABEL.totalRevenue}
            measure={report.totalRevenueAgorot}
            money
          />
        </RowList>
        <PanelNote>{METRIC_NOTE.adr}</PanelNote>
      </Panel>

      <Panel title="תפוסה">
        <RowList>
          <Figure label={METRIC_LABEL.nightsSold} measure={report.nightsSold} />
          <Figure
            label={METRIC_LABEL.nightsAvailable}
            measure={report.nightsAvailable}
          />
          <Figure
            label={METRIC_LABEL.averageStay}
            measure={report.averageStayNights}
            unit=" לילות"
          />
        </RowList>
        <PanelNote>{METRIC_NOTE.occupancy}</PanelNote>
        {bookableUnits === null ? (
          <PanelNote>
            אין יחידות פעילות בהיקף שנבחר, ולכן אין במה לחלק. זו לא תפוסה של אפס
            אחוז — זה עסק שטרם הגדיר מלאי.
          </PanelNote>
        ) : (
          <PanelNote>
            המכנה נבנה מ־{bookableUnits} יחידות פעילות.
            {unitsInMaintenance > 0 &&
              ` ${unitsInMaintenance} יחידות בתחזוקה אינן נספרות — הן לא היו זמינות למכירה, וספירתן הייתה מדווחת כישלון תפוסה על תקופה שלא היה בה מה למכור.`}
          </PanelNote>
        )}
      </Panel>

      <Panel title="קצב וביטולים">
        <RowList>
          <Figure
            label={METRIC_LABEL.leadTime}
            measure={report.leadTimeDays}
            unit=" ימים"
          />
          <Figure
            label={METRIC_LABEL.cancellation}
            measure={report.cancellationRate}
            unit="%"
          />
        </RowList>
        <PanelNote>{METRIC_NOTE.cancellation}</PanelNote>
        {report.backdated > 0 && <PanelNote>{METRIC_NOTE.leadTime}</PanelNote>}
        {demand > 0 && (
          <PanelNote>
            {demand} פניות והצעות מחיר בטווח הזה אינן נספרות באף מספר למעלה. הן
            ביקוש, לא תפוסה ולא ביטול.
          </PanelNote>
        )}
      </Panel>

      <Panel
        title="מאיפה הגיעו הלילות"
        count={report.channelMix.length}
        description="החלוקה היא לפי לילות ולא לפי הזמנות — ארבע הזמנות של לילה אחד אינן פי שניים מהזמנה של שבוע."
      >
        {report.channelMix.length === 0 ? (
          <PanelNote>אין לילות שנמכרו בטווח הזה.</PanelNote>
        ) : (
          <RowList>
            {report.channelMix.map((share) => (
              <Row key={share.source}>
                <FactRow label={SOURCE_LABEL[share.source]}>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-sm">
                      {share.nightsShare}%
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {share.nights} לילות · {share.bookings} הזמנות ·{' '}
                      {shekels(share.revenueAgorot)}
                    </span>
                  </span>
                </FactRow>
              </Row>
            ))}
          </RowList>
        )}
      </Panel>

      <Panel title="מה המסך הזה לא יודע לבדוק">
        <PanelNote>
          <strong>{METRIC_LABEL.marketPosition}</strong> —{' '}
          {METRIC_NOTE.marketPosition}
        </PanelNote>
        {report.withoutAccommodationLines > 0 && (
          <PanelNote>
            {report.withoutAccommodationLines} הזמנות אינן נכללות במחיר הממוצע
            ללילה כי אין להן שורות מחיר של לינה. הן נספרות בתפוסה ובהכנסות הכולל
            — רק לא במחיר, כי אין ממה לגזור אותו.
          </PanelNote>
        )}
      </Panel>
    </ScreenFrame>
  )
}

/**
 * A revenue  rendered by the shared kit.
 *
 * The wrapper survives rather than being inlined at twelve call sites, because
 * it is the one place that knows a `Measure` is agorot when `money` is set and
 * a plain number otherwise. `Figure` in the kit deliberately formats nothing —
 * a component that guessed at units would eventually print a percentage as
 * shekels, and it would look right.
 */
function Figure({
  label,
  measure,
  money = false,
  unit = '',
}: {
  label: string
  measure: Measure
  money?: boolean
  unit?: string
}) {
  return (
    <SharedFigure
      label={label}
      value={
        measure.known
          ? {
              known: true,
              display: money
                ? shekels(measure.value)
                : `${measure.value}${unit}`,
            }
          : { known: false, why: UNMEASURABLE_LABEL[measure.reason] }
      }
    />
  )
}
