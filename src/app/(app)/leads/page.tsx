import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { BookingStatusBadge } from '@/components/booking/status-badge'
import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'
import {
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
  Withheld,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { formatDayMonth, localDate } from '@/lib/booking/dates'
import { BOOKING_STATUS_LABEL } from '@/lib/booking/state-machine'
import { toSafeResponse } from '@/lib/errors'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { BOOKING_SOURCE_LABEL, HOLD_REASON_LABEL } from './_lib/labels'
import {
  LEAD_PAGE_SIZE,
  PIPELINE_ORDER,
  attachHolds,
  byStage,
  listLeads,
  listLiveHolds,
  type Lead,
  type LeadArgs,
  type LiveHold,
} from './_lib/queries'

export const metadata: Metadata = { title: 'צנרת מכירות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The sales pipeline.
 *
 * WHAT IS ON THIS SCREEN, AND WHAT IT IS READ FROM. Bookings in the four
 * statuses before a sale is committed — `inquiry`, `quote`, `option`,
 * `awaiting_payment` — grouped by stage in the enum's own order, plus the holds
 * that are keeping inventory off sale while somebody closes.
 *
 * THERE IS NO `leads` TABLE. The grants exist and the storage does not, and
 * that is stated on the screen rather than mocked. `_lib/queries.ts` sets out
 * the argument in full: `BOOKING_STATUSES` is the life of a stay from enquiry
 * onward, so a lead here genuinely *is* a booking that has not been committed
 * to, and the honest screen is the one that says which statuses it is treating
 * as the pipeline. What that costs is written down too — an enquiry with no
 * dates and no unit cannot be recorded at all, and `lead.assign` has no column
 * to write.
 *
 * GATING. `requireGrant('lead.view')` refuses the route. The rows come from
 * `bookings` and `holds`, so each read asks `holdsGrant` for its own grant, and
 * every row is checked again with `can()` against its property. The guest's
 * name and their written request are withheld without `guest.view_name`, the
 * price without `booking.view_price`.
 *
 * NO CONVERSION RATE. `conversion_rate` is a metric with a definition in
 * `src/lib/metrics`, a grant of its own and a screen of its own at
 * `/reports/operations`. A second figure computed here would be a second
 * answer to the same question, which is the defect the metrics module opens by
 * describing. The numbers beside the stage headings are the lengths of the
 * lists underneath them.
 */
export default async function LeadsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('lead.view'),
    shellContext(),
  ])

  // `requireGrant` redirects when the context is not ready, so this is
  // narrowing for the type system rather than a second decision.
  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  const today = localDate(new Date())
  const db = await createClient()
  const args: LeadArgs = {
    db,
    actor,
    organizationId: actor.organizationId,
    propertyId,
    today,
  }

  const [leads, holds] = await Promise.all([
    settle(() => listLeads(args)),
    settle(() => listLiveHolds(args)),
  ])

  const rows =
    leads.ok && leads.value
      ? attachHolds(leads.value, holds.ok ? holds.value : null)
      : []
  const stages = byStage(rows)

  return (
    <ScreenFrame
      title="צנרת מכירות"
      lead={
        propertyName
          ? `כל מה שנמכר עכשיו ב״${propertyName}״ ועדיין לא נסגר.`
          : 'כל מה שנמכר עכשיו ועדיין לא נסגר, בכל הנכסים שבטווח שלך.'
      }
      banner={
        <DomainGap
          title="אין טבלת לידים נפרדת — והצנרת עצמה אמיתית"
          body={
            <>
              <p>
                בקטלוג ההרשאות יש <GrantCode>lead.view</GrantCode>,{' '}
                <GrantCode>lead.create</GrantCode>,{' '}
                <GrantCode>lead.update</GrantCode> ו־
                <GrantCode>lead.assign</GrantCode>, אבל אף מיגרציה אינה יוצרת
                טבלת לידים. זה לא חסם: מסלול החיים של הזמנה מתחיל ב״פנייה״ ועובר
                דרך ״הצעת מחיר״ ו״אופציה״, ולכן ליד כאן הוא הזמנה שעוד לא נסגרה
                — עם האורח, התאריכים, המחיר, המקור והסוכן שהביא אותה.
              </p>
              <p className="mt-2">
                מה שחסר בגלל זה, במדויק: אי אפשר לרשום פנייה בלי תאריכים ובלי
                יחידה, כי{' '}
                <span dir="ltr" className="font-mono text-xs">
                  bookings
                </span>{' '}
                דורשת את שלושתם; ואי אפשר להקצות ליד לאיש מכירות, כי אין עמודה
                לכתוב אליה. מה שמוצג במקום זה הוא מי מכר ומי הזין — שתי עובדות
                אמיתיות ושונות זו מזו.
              </p>
            </>
          }
          missingTables={['leads', 'lead_activities', 'quotes']}
          alreadyBuilt={[
            <>
              ההרשאות <GrantCode>lead.view</GrantCode> ·{' '}
              <GrantCode>lead.create</GrantCode> ·{' '}
              <GrantCode>lead.update</GrantCode> ·{' '}
              <GrantCode>lead.assign</GrantCode>
            </>,
            <>
              ארבעת מצבי ההזמנה שלפני הסגירה, בסדר שהם נעבדים בו:{' '}
              {PIPELINE_ORDER.map(
                (status) => BOOKING_STATUS_LABEL[status],
              ).join(' · ')}
            </>,
            <>
              שיוך מלא על ההזמנה:{' '}
              <span dir="ltr" className="font-mono text-xs">
                source
              </span>
              ,{' '}
              <span dir="ltr" className="font-mono text-xs">
                source_channel
              </span>
              ,{' '}
              <span dir="ltr" className="font-mono text-xs">
                agent_user_id
              </span>
              ,{' '}
              <span dir="ltr" className="font-mono text-xs">
                agency_id
              </span>
            </>,
            <>
              טבלת{' '}
              <span dir="ltr" className="font-mono text-xs">
                holds
              </span>
              , שמחזיקה תאריכים בזמן שסוגרים מכירה
            </>,
          ]}
        />
      }
    >
      {!leads.ok && <ActionError error={leads.error} />}

      {leads.ok && leads.value === null && (
        <PanelNote tone="attention">
          יש לך הרשאת לידים אך לא הרשאת צפייה בהזמנות. הצנרת מאוחסנת כהזמנות,
          ולכן אין מה להציג לך כאן — זו הרשאה חסרה ולא צנרת ריקה. נדרשת{' '}
          <GrantCode>booking.view</GrantCode>.
        </PanelNote>
      )}

      {leads.ok && leads.value !== null && rows.length === 0 && (
        <PanelNote>
          אין כרגע אף פנייה, הצעת מחיר, אופציה או הזמנה שממתינה לתשלום בטווח
          שלך. זו תשובה אמיתית ולא סינון שהסתיר משהו.
        </PanelNote>
      )}

      {stages
        .filter((stage) => stage.leads.length > 0)
        .map((stage) => (
          <Panel
            key={stage.status}
            title={BOOKING_STATUS_LABEL[stage.status]}
            count={stage.leads.length}
            description={STAGE_DESCRIPTION[stage.status]}
          >
            <RowList>
              {stage.leads.map((lead) => (
                <LeadRow key={lead.id} lead={lead} />
              ))}
            </RowList>
          </Panel>
        ))}

      {rows.length === LEAD_PAGE_SIZE && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          מוצגות {LEAD_PAGE_SIZE} הפניות הוותיקות ביותר. יש נוספות.
        </p>
      )}

      {/* --------------------------------------------------------- holds -- */}
      <Panel
        title="תאריכים שמוחזקים כרגע"
        description="החזקה מורידה יחידה מהמדף בלי שיש הזמנה מאחוריה. החזקה שנשכחה עולה כסף אמיתי, ולכן היא מוצגת כאן ולא רק ביומן."
        count={holds.ok && holds.value ? holds.value.length : undefined}
      >
        {!holds.ok ? (
          <ActionError error={holds.error} />
        ) : holds.value === null ? (
          <PanelNote>
            החזקות אינן פתוחות לך — נדרשת <GrantCode>hold.view</GrantCode>.
          </PanelNote>
        ) : holds.value.length === 0 ? (
          <PanelNote>
            אף יחידה אינה מוחזקת כרגע. כל התאריכים שאינם מוזמנים פתוחים למכירה.
          </PanelNote>
        ) : (
          <RowList>
            {holds.value.map((hold) => (
              <HoldRow key={hold.id} hold={hold} />
            ))}
          </RowList>
        )}
      </Panel>

      {!holdsGrant(actor, 'guest.view_name') && (
        <PanelNote>
          שמות האורחים ובקשותיהם מוסתרים ממך לפי ההרשאות שלך. מספר ההזמנה מוצג
          במקום, והוא מזהה אמיתי שאפשר לעבוד לפיו.
        </PanelNote>
      )}
    </ScreenFrame>
  )
}

/* ------------------------------------------------------------- plumbing -- */

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReturnType<typeof toSafeResponse>['error'] }

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (cause) {
    return {
      ok: false,
      error: toSafeResponse(cause, crypto.randomUUID()).error,
    }
  }
}

/**
 * What each stage means, in the words the workflow uses.
 *
 * Only the four in the pipeline. A `Partial` rather than a total record,
 * because the other fifteen statuses are not stages of a sale and inventing a
 * sentence for `deposit_release` would be describing something this screen
 * never shows.
 */
const STAGE_DESCRIPTION: Partial<Record<Lead['status'], string>> = {
  inquiry: 'נרשמה פנייה. אף תאריך אינו מוחזק ואף מחיר לא נשלח.',
  quote: 'נשלח מחיר. התאריכים עדיין פתוחים למכירה לאחרים אלא אם יש החזקה.',
  option: 'התאריכים מוחזקים ביומן לטובת הלקוח הזה, ואינם ניתנים למכירה כפולה.',
  awaiting_payment: 'סוכם — וממתין לכסף. זה השלב שנופל הכי הרבה.',
}

/* ----------------------------------------------------------------- rows -- */

function LeadRow({ lead }: { lead: Lead }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold text-foreground">
            {'guestName' in lead ? (
              (lead.guestName ?? lead.reference)
            ) : (
              <Withheld />
            )}
          </span>
          <BookingStatusBadge status={lead.status} />
          <Badge tone="neutral">{BOOKING_SOURCE_LABEL[lead.source]}</Badge>
          {lead.heldUntil && (
            <Badge tone="brand">
              מוחזק עד {formatDayMonth(lead.heldUntil)}
            </Badge>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {lead.unitName ?? 'יחידה שאינה פתוחה לצפייה'} ·{' '}
          {formatDayMonth(lead.checkIn)}–{formatDayMonth(lead.checkOut)} ·{' '}
          {lead.guestCount} אורחים
          {lead.sourceChannel ? ` · ${lead.sourceChannel}` : ''}
        </p>

        <p className="text-sm text-muted-foreground">
          נפתחה לפני {lead.ageDays === 1 ? 'יום' : `${lead.ageDays} ימים`}
          {' · '}
          {lead.agentUserId
            ? `מכר: ${lead.agentName ?? 'סוכן שאינו פתוח לצפייה'}`
            : 'ללא סוכן — פנייה ישירה'}
          {lead.agencyName ? ` (${lead.agencyName})` : ''}
          {lead.createdByUserId
            ? ` · הזין: ${lead.createdByName ?? 'משתמש שאינו פתוח לצפייה'}`
            : ''}
        </p>

        {'guestNotes' in lead && lead.guestNotes && (
          <p className="text-sm text-foreground">
            בקשת האורח: {lead.guestNotes}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-baseline gap-3">
        {'totalAgorot' in lead && lead.totalAgorot !== undefined && (
          <span className="tabular-nums text-sm font-semibold text-foreground">
            {formatAgorot(lead.totalAgorot)}
          </span>
        )}
        <Button href={`/bookings/${lead.id}`} variant="ghost" size="sm">
          {lead.reference}
        </Button>
      </div>
    </Row>
  )
}

function HoldRow({ hold }: { hold: LiveHold }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold text-foreground">
            {hold.unitName ?? 'יחידה שאינה פתוחה לצפייה'}
          </span>
          <Badge tone={hold.lapsed ? 'neutral' : 'brand'}>
            {HOLD_REASON_LABEL[hold.reason]}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          {formatDayMonth(hold.checkIn)}–{formatDayMonth(hold.checkOut)} ·{' '}
          {hold.heldByName ?? 'משתמש שאינו פתוח לצפייה'}
        </p>

        {hold.note && (
          <p className="text-sm text-foreground">הערה: {hold.note}</p>
        )}
      </div>

      <div className="shrink-0 text-end text-sm">
        {hold.lapsed ? (
          // The case this panel exists for. An expired hold does not block the
          // exclusion constraint — 0009 says so — so the dates are back on sale
          // while the person who placed it still believes they have them.
          <span className="font-semibold text-danger">
            פג ב־{formatDayMonth(hold.expiresOn)} — התאריכים כבר חזרו למכירה
          </span>
        ) : (
          <span className="text-muted-foreground">
            תקף עד {formatDayMonth(hold.expiresOn)}
          </span>
        )}
      </div>
    </Row>
  )
}
