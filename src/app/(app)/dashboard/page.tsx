import type { Metadata } from 'next'

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { EmptyState } from '@/components/states/empty-state'
import {
  LockedTile,
  TileBandSection,
  TileCard,
  type TileTone,
} from '@/components/dashboard/tile'
import { MyJobsPanel } from '@/components/dashboard/my-jobs'
import {
  buildTiles,
  tileHref,
  tilesInBand,
  type ResolvedTile,
} from '@/components/dashboard/tiles'
import { buildMenu } from '@/components/nav/menu'
import { entitlementLabel, scopeLabel } from '@/components/nav/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { authorize, type Actor } from '@/lib/authz/can'
import { formatDayMonthYear } from '@/lib/booking/dates'
import {
  formatMetricValue,
  type MetricResult,
  type MetricState,
} from '@/lib/metrics'
import { ENTITLEMENTS } from '@/lib/plans/entitlements'
import { formatAgorot } from '@/lib/plans/plan'

import { requireContext } from '../_lib/guard'
import { ALL_PROPERTIES } from '../_lib/context'
import { refusalCopy } from './_lib/denied'
import {
  loadHome,
  MY_JOBS_LIMIT,
  type HomeData,
  type Settled,
  type TodayCounts,
} from './_lib/home'
import { homeWiring } from './_lib/wiring'

export const metadata: Metadata = { title: 'מסך הבית' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The place the day starts.
 *
 * ── What this screen used to be, and why it changed ───────────────────────
 *
 * It rendered the account: who you are, which organization, which features
 * your package includes, and a list of the menu items you can reach. Every
 * word of it was true and none of it was work. A customer opened the product
 * and said he could see nothing but the names of the packages he was sold, and
 * he was right — the screen was *about* the account rather than a place to
 * stand in the morning.
 *
 * The old file argued, at length, that numbers here would be fabricated
 * because there were no bookings, properties or payments in the schema. That
 * argument has expired: there are twenty-six migrations, a metric dictionary
 * that refuses each figure independently, and query modules behind five
 * screens. The honest empty frame was right in its week and is wrong now.
 *
 * ── The four principles taken, and where from ─────────────────────────────
 *
 *   · **Today first.** Mews and Cloudbeds both open on arrivals, departures
 *     and who is in house, because that is the question a hospitality business
 *     has at eight in the morning. Occupancy is a question it has on the first
 *     of the month.
 *   · **One number per card.** Stripe's home screen. A card carrying three
 *     figures is three questions typeset as one, and a number nobody acts on
 *     is decoration.
 *   · **Every tile is a door.** Linear. A count that cannot be opened makes
 *     the reader do the filtering again, differently. Every figure here links
 *     to the screen holding the rows it counted — and never to a screen that
 *     would refuse the reader, which is checked before the link is rendered
 *     rather than discovered after the click. See `tiles.ts`.
 *   · **Empty states teach.** "אין הגעות היום" is an answer. A blank card is
 *     a bug the reader has to diagnose.
 *
 * ── Role-shaped, and derived ──────────────────────────────────────────────
 *
 * There is no role name in this file. `buildTiles` asks the authorization
 * engine about each tile exactly as `buildMenu` asks it about each menu item,
 * so an owner's home and a cleaner's home differ because their grants differ.
 * A customer composing a role next year gets a coherent home screen with
 * nobody editing this file.
 *
 * ── The action centre is summarised, not absorbed ─────────────────────────
 *
 * `/action-center` keeps the rows and the per-row actions; this screen carries
 * one number per question and links into it. They share the same query
 * functions — `listStaysToday`, `listOpenBalances`, `listStuckTasks` — so
 * there is one definition of "stuck work" in the product rather than two
 * screens disagreeing about the same morning. Absorbing the action centre
 * would have meant either putting twenty-five-row lists on a glance screen or
 * deleting a screen somebody's morning already depends on.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 *
 * `requireContext()` and not `requireGrant()`: every active member reaches
 * this page, including a cleaner whose entire grant set is four task
 * permissions, and it is the one place in the product where membership is the
 * right requirement. Every figure below is refused independently — by the
 * metric dictionary, by the query modules' own `holdsGrant` checks, by `can()`
 * per row inside them, and by row level security under all of it.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [context, params] = await Promise.all([requireContext(), searchParams])

  /* ------------------------------------------------- states that are not
     errors: signed in, but with nothing to act inside yet. */

  if (context.status === 'no_workspace') {
    return (
      <Shell>
        <EmptyState
          as="h1"
          illustration="property"
          title="עוד אין לך מרחב עבודה"
          body="החשבון שלך נוצר, אבל הוא עדיין לא משויך לאף ארגון. אפשר להקים ארגון חדש עכשיו, או להמתין להזמנה ממנהל בארגון קיים."
          action={<Button href="/onboarding">הקמת ארגון</Button>}
        />
      </Shell>
    )
  }

  if (context.status === 'membership_not_active') {
    return (
      <Shell>
        <EmptyState
          as="h1"
          illustration="team"
          title="החברות שלך בארגון אינה פעילה"
          body={`הסטטוס שלך ב״${context.workspace.name}״ הוא ${MEMBERSHIP_STATUS_LABELS[context.membershipStatus]}. מנהל בארגון יכול להחזיר את הגישה. לא נמחק שום נתון שלך.`}
        />
      </Shell>
    )
  }

  if (context.status === 'no_subscription') {
    return (
      <Shell>
        <EmptyState
          as="h1"
          illustration="invoice"
          title="לארגון אין מנוי פעיל"
          body={`ל״${context.workspace.name}״ אין רשומת מנוי, ובלעדיה אי אפשר לדעת אילו יכולות כלולות. עד שהמנוי ייווצר, אף מסך במערכת לא ייפתח — זו החלטה מכוונת ולא תקלה.`}
        />
      </Shell>
    )
  }

  /* --------------------------------------------------------- the real thing */

  const { actor, workspace, roles, user } = context

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  // The wiring lives here and not in `_lib/home.ts`, so that module stays
  // importable by a suite with no Supabase project — the same reason
  // `action-center/_lib/queries.ts` keeps its grant tuple out of `access.ts`.
  const { db, source } = await homeWiring()

  const home = await loadHome({
    db,
    source,
    actor,
    organizationId: workspace.organizationId,
    propertyId,
  })

  const tiles = buildTiles(actor)

  const fullName =
    typeof user.user_metadata?.full_name === 'string'
      ? user.user_metadata.full_name
      : null

  const refusal = refusalCopy(
    firstParam(params.denied),
    firstParam(params.reason),
  )

  const personal = tilesInBand(tiles, 'personal')[0] ?? null
  const bands = BAND_ORDER.map((band) => ({
    band,
    tiles: tilesInBand(tiles, band),
  }))

  const nothingToShow =
    personal === null && bands.every((entry) => entry.tiles.length === 0)

  return (
    <Shell>
      {refusal ? (
        <div
          role="status"
          className="mb-6 rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
        >
          {refusal.message} {refusal.remedy}
        </div>
      ) : null}

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          {fullName ? `בוקר טוב, ${fullName}` : 'מסך הבית'}
        </h1>
        <p className="max-w-prose text-muted-foreground">
          זה מה שקורה היום,{' '}
          <span className="font-semibold text-foreground">
            {formatDayMonthYear(home.today)}
          </span>
          , ב
          {propertyName ? (
            <span className="font-semibold text-foreground">
              ״{propertyName}״
            </span>
          ) : (
            <>
              כל הנכסים של{' '}
              <span className="font-semibold text-foreground">
                {workspace.name}
              </span>
            </>
          )}
          . כל מספר כאן נפתח למסך שממנו הוא נספר.
        </p>
      </header>

      <div className="mt-8 flex flex-col gap-10">
        {nothingToShow ? (
          <EmptyState
            illustration="team"
            title="עוד אין לך מספרים במסך הבית"
            body="התפקיד שלך אינו כולל אף אחת מהיכולות שמסך הבית מסכם — הזמנות, משימות, תשלומים או דוחות. זו אינה תקלה: התפריט מציג את מה שכן פתוח לך, ומנהל בארגון יכול להרחיב את התפקיד."
          />
        ) : null}

        {bands.map(({ band, tiles: bandTiles }) => {
          if (bandTiles.length === 0) return null
          const copy = BAND_COPY[band]
          const action =
            copy.action && authorize(actor, copy.action.requires).allowed
              ? copy.action
              : null

          return (
            <TileBandSection
              key={band}
              title={copy.title}
              lead={copy.lead}
              action={
                action ? (
                  <Button href={action.href} variant="secondary" size="sm">
                    {action.label}
                  </Button>
                ) : null
              }
            >
              {bandTiles.map((tile) => (
                <Tile key={tile.id} tile={tile} home={home} />
              ))}
            </TileBandSection>
          )
        })}

        {personal ? (
          <MyJobsPanel
            jobs={home.myJobs.ok ? home.myJobs.value : []}
            href={
              personal.destination === null
                ? null
                : tileHref(personal.destination, home.today)
            }
            atCeiling={
              home.myJobs.ok && home.myJobs.value.length >= MY_JOBS_LIMIT
            }
          />
        ) : null}

        {/* --------------------------------------------- the account, demoted */}
        <details className="rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6">
          <summary className="cursor-pointer text-base font-semibold text-foreground">
            החשבון והגישה שלך
          </summary>

          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            זו אינה העבודה של היום — זה מה שמסביר למה המסכים שלמעלה נראים כך.
            הזהות הזו נבנית מחדש בכל בקשה מהמסד, ולא נשמרת בעוגייה.
          </p>

          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            <dl className="flex flex-col gap-3 text-sm">
              <Row label="אימייל">
                <span dir="ltr">{user.email}</span>
              </Row>
              <Row label="ארגון">
                {workspace.name}{' '}
                <span dir="ltr" className="text-xs text-muted-foreground">
                  ({workspace.slug})
                </span>
              </Row>
              <Row label="תפקידים">
                {roles.length > 0 ? (
                  <span className="flex flex-wrap justify-end gap-1">
                    {roles.map((role) => (
                      <Badge key={role.code} tone="brand">
                        {role.name}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    לא הוקצה תפקיד — ולכן אין הרשאות
                  </span>
                )}
              </Row>
              <Row label="טווח">{scopeLabel(actor.scope)}</Row>
              <Row label="מספר הרשאות">{actor.grants.size}</Row>
              <Row label="מסכים פתוחים לך">{openScreens(actor)}</Row>
            </dl>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                מה כלול בחבילה של הארגון
              </h3>
              <p className="text-sm text-muted-foreground">
                יכולת שאינה כלולה מוצגת בתפריט כנעולה ולא נעלמת — כדי שההבדל בין
                ״אין לך הרשאה״ ל״החבילה לא כוללת״ יישאר ברור.
              </p>
              <ul className="flex flex-wrap gap-2">
                {ENTITLEMENTS.map((entitlement) => {
                  const included = actor.entitlements.has(entitlement)
                  return (
                    <li key={entitlement}>
                      <Badge
                        tone={included ? 'brand' : 'neutral'}
                        className={included ? undefined : 'opacity-70'}
                      >
                        {entitlementLabel(entitlement)}
                      </Badge>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </details>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------- fragments -- */

const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  invited: 'הוזמן',
  pending: 'ממתין',
  active: 'פעיל',
  suspended: 'מושהה',
  removed: 'הוסר',
}

const BAND_ORDER = ['today', 'attention', 'period'] as const

type BandKey = (typeof BAND_ORDER)[number]

/**
 * What each band says it is for.
 *
 * The `action` is the band's one control and is itself gated: a button offered
 * to somebody the destination would refuse is the same defect as a tile
 * linking to a refusal, one size larger.
 */
const BAND_COPY: Record<
  BandKey,
  {
    title: string
    lead: string
    action?: { href: string; label: string; requires: 'booking.view' }
  }
> = {
  today: {
    title: 'היום',
    lead: 'מי עוזב, מי מגיע ומי כבר נמצא בשטח. הסדר הוא סדר של יום עבודה ולא של תאריך.',
    action: {
      href: '/action-center',
      label: 'למרכז הפעולות',
      requires: 'booking.view',
    },
  },
  attention: {
    title: 'דורש אדם',
    lead: 'דברים שלא ייסגרו מעצמם. אם כולם באפס — אין מה לעשות עכשיו, וזו תשובה אמיתית.',
  },
  period: {
    title: 'החודש הזה',
    lead: 'המספרים של החודש הנוכחי מול החודש שלפניו. כל מספר מוגדר במערכת פעם אחת בלבד.',
  },
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {children}
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-medium text-foreground">
        {children}
      </dd>
    </div>
  )
}

/** How many menu items this person can genuinely open. Reference, not work. */
function openScreens(actor: Actor): number {
  return buildMenu(actor)
    .flatMap((section) => section.items)
    .filter((item) => item.state === 'available').length
}

/* ---------------------------------------------------------------- tiles -- */

/**
 * One tile, paired with its figure by id.
 *
 * Everything this function does is choose between four presentations of an
 * already-decided value: locked, failed, zero, or a number. Currency goes
 * through `formatAgorot` and metrics through the string the domain already
 * produced. Nothing here computes.
 */
function Tile({ tile, home }: { tile: ResolvedTile; home: HomeData }) {
  if (tile.state === 'locked') {
    return (
      <LockedTile
        tile={tile}
        entitlementLabel={
          tile.entitlement === null ? null : entitlementLabel(tile.entitlement)
        }
      />
    )
  }

  const figure = figureFor(tile.id, home)

  return (
    <TileCard
      tile={tile}
      value={figure.value}
      note={figure.note}
      comparison={figure.comparison}
      flag={figure.flag}
      tone={figure.tone}
      // A figure that could not be read links nowhere. Sending somebody to a
      // filtered screen on the strength of a number that failed to load is an
      // invitation to trust the filter.
      href={
        figure.readable && tile.destination !== null
          ? tileHref(tile.destination, home.today)
          : null
      }
    />
  )
}

/** What a figure that could not be read shows instead of a number. */
const NO_FIGURE = '—'

type Figure = {
  value: string
  note?: string
  comparison?: string
  /** The word that carries what the colour is saying. See `TileCard`. */
  flag?: string
  tone: TileTone
  /** False when there is no figure, and therefore nothing honest to open. */
  readable: boolean
}

/**
 * What the domain's verdict on a figure is called, in Hebrew.
 *
 * The same two words `metric-tile.tsx` uses on the report, and deliberately
 * the same: one screen calling a figure "חריג" while another calls the same
 * figure something else is how a customer stops trusting both. `positive` and
 * `neutral` get no word — a badge on every tile is a badge nobody reads.
 */
const STATE_FLAG: Readonly<Record<MetricState, string | undefined>> = {
  positive: undefined,
  neutral: undefined,
  warning: 'דורש תשומת לב',
  critical: 'חריג',
}

const READ_FAILED: Figure = {
  value: NO_FIGURE,
  note: 'לא הצלחנו לקרוא את המספר הזה כרגע. זה אינו אפס — כדאי לרענן, ואם זה חוזר זו תקלה שכדאי לדווח עליה.',
  tone: 'quiet',
  readable: false,
}

/** A refusal that arrived as `null` from the query module, not as an error. */
const WITHHELD: Figure = {
  value: NO_FIGURE,
  note: 'הנתון הזה אינו פתוח לצפייה בתפקיד שלך.',
  tone: 'quiet',
  readable: false,
}

function figureFor(id: string, home: HomeData): Figure {
  switch (id) {
    case 'departures':
      return count(home.stays, 'departing', 'אין עזיבות היום.')
    case 'arrivals':
      return count(home.stays, 'arriving', 'אין הגעות היום.')
    case 'in-house':
      return count(
        home.stays,
        'in_house',
        'אין אורחים שנמצאים כאן ונשארים גם מחר.',
      )

    case 'stuck-work':
      return nullableCount(
        home.stuckTasks,
        'אין משימה תקועה ואין משימה שעבר זמנה.',
      )
    case 'payments-stalled':
      return nullableCount(
        home.stalledPayments,
        'כל תשלום שנרשם קיבל תשובה סופית מהסולק.',
      )
    case 'approvals':
      return nullableCount(home.approvals, 'אין בקשה שממתינה להחלטה.')

    case 'unpaid-stays':
      return unpaidStays(home)

    default:
      return metricFigure(id, home)
  }
}

function count(
  settled: Settled<TodayCounts>,
  role: keyof TodayCounts,
  whenEmpty: string,
): Figure {
  if (!settled.ok) return READ_FAILED
  const total = settled.value[role]
  return {
    value: String(total),
    note: total === 0 ? whenEmpty : undefined,
    tone: 'quiet',
    readable: true,
  }
}

/**
 * A count that the query module may refuse outright.
 *
 * Zero and `null` are printed differently and deliberately: "nobody owes
 * anything" and "you may not see what anybody owes" are different sentences,
 * and a screen that renders both as `0` tells a receptionist the business has
 * been paid.
 */
function nullableCount(
  settled: Settled<number | null>,
  whenEmpty: string,
): Figure {
  if (!settled.ok) return READ_FAILED
  if (settled.value === null) return WITHHELD
  return {
    value: String(settled.value),
    note: settled.value === 0 ? whenEmpty : undefined,
    tone: settled.value === 0 ? 'quiet' : 'attention',
    readable: true,
  }
}

function unpaidStays(home: HomeData): Figure {
  if (!home.balances.ok) return READ_FAILED
  const value = home.balances.value
  if (value === null) return WITHHELD

  if (value.count === 0) {
    return {
      value: '0',
      note: 'כל שהייה שעל הלוח היום שולמה במלואה.',
      tone: 'quiet',
      readable: true,
    }
  }

  return {
    value: String(value.count),
    note: `סך החוב בשורות האלה: ${formatAgorot(value.totalAgorot)}. זהו סיכום השהיות של היום בלבד, ולא מאזן הארגון.`,
    tone: 'attention',
    readable: true,
  }
}

/**
 * A figure from the metric dictionary.
 *
 * `metric.formatted` is used verbatim: `computeDashboard` called
 * `formatMetricValue` once, so this screen and `/reports` cannot render the
 * same value differently. `metric.value === null` is not a zero — a property
 * with no available nights has no occupancy — and the note says so rather than
 * letting a dash look like a failure.
 */
function metricFigure(id: string, home: HomeData): Figure {
  if (!home.metrics.ok) return READ_FAILED

  const metric = [...home.metrics.value.values()].find(
    (candidate) => candidate.id === id,
  )
  if (!metric) return WITHHELD

  return {
    value: metric.formatted,
    note:
      metric.value === null
        ? 'אין מספיק נתונים בחודש הזה כדי לחשב את המדד. זה אינו אפס.'
        : undefined,
    comparison: describeComparison(metric),
    flag: STATE_FLAG[metric.state],
    // The colour comes from the domain's `state`, which knows that a rise in
    // what is owed is bad news and a rise in revenue is not. No screen
    // re-decides it, and no screen paints a rise green on its own authority.
    tone:
      metric.state === 'critical' || metric.state === 'warning'
        ? 'attention'
        : 'quiet',
    readable: metric.value !== null,
  }
}

/** The comparison in one short phrase, and never a colour on its own. */
function describeComparison(metric: MetricResult): string | undefined {
  const { comparison } = metric
  if (comparison === null) return undefined
  if (comparison.empty) return 'אין נתונים בחודש הקודם להשוות אליהם'
  // Extensive figures over windows of different lengths. September has thirty
  // nights and August thirty-one, and a revenue comparison between them is not
  // a business result — so the number is shown and no conclusion is drawn.
  if (!comparison.comparable) return 'החודשים אינם באותו אורך, ולכן אין השוואה'
  if (comparison.delta === null) return undefined

  const size = formatMetricValue(metric.unit, Math.abs(comparison.delta))
  switch (comparison.direction) {
    case 'up':
      return `עלייה של ${size} מהחודש הקודם`
    case 'down':
      return `ירידה של ${size} מהחודש הקודם`
    case 'flat':
      return 'ללא שינוי מהחודש הקודם'
    default:
      return undefined
  }
}
