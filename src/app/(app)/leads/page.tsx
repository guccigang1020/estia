import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { BookingStatusBadge } from '@/components/booking/status-badge'
import { EnquiryStatusControl } from '@/components/leads/enquiry-status'
import { GrantCode } from '@/components/shell-screens/domain-gap'
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
import {
  LEAD_LOST_REASON_LABEL,
  LEAD_SOURCE_LABEL,
  LEAD_STATUS_LABEL,
} from '@/lib/leads'
import { formatAgorot } from '@/lib/plans/plan'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { BOOKING_SOURCE_LABEL, HOLD_REASON_LABEL } from './_lib/labels'
import {
  ENQUIRY_PAGE_SIZE,
  byLeadStage,
  convertedBookingIds,
  listEnquiries,
  seesUnassignedEnquiries,
  type Enquiry,
} from './_lib/enquiries'
import {
  LEAD_PAGE_SIZE,
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
 * ══ THERE ARE TWO LISTS HERE AND THEY COUNT TWO DIFFERENT THINGS ════════════
 *
 * **פניות** are rows in `public.leads` — an enquiry, with no stay behind it.
 * Nothing is held, nothing is priced, and the unit may not have been chosen.
 * That is the table `0074_leads_and_guest_merges.sql` created, and the reason
 * it had to exist is that `bookings` requires a unit and two dates, so
 * "somebody rang about August" could not be written down at all.
 *
 * **הזמנות שנפתחו** are bookings in `inquiry`/`quote`/`option`/`awaiting_payment`
 * — a stay being opened. A unit and dates exist; the money has not settled.
 * `_lib/queries.ts` has read these since before `leads` existed and still does.
 *
 * 🔒 **Nothing appears in both.** A booking named by any `leads.booking_id` is
 * removed from the second list: it is shown as that enquiry's outcome, once.
 * The old rows were deliberately NOT migrated into `leads` — inventing an
 * enquiry nobody recorded, and then counting the stay twice, is exactly the
 * failure this de-duplication exists to prevent. `src/lib/revenue/stays.ts`
 * keeps the same three statuses out of occupancy for the same reason, and
 * nothing here restates its list.
 *
 * GATING. `requireGrant('lead.view')` refuses the route. The enquiries come
 * from `leads`, which has its own policies; the second list comes from
 * `bookings` and `holds`, which have theirs, so each read asks `holdsGrant` for
 * its own grant first and every row is checked again with `can()`. The
 * enquirer's name and their words are withheld without `guest.view_name`, the
 * telephone without `guest.view_phone`, the address without `guest.view_email`.
 *
 * NO CONVERSION RATE. `lead_conversion` is a metric with a definition, a grant
 * and a screen of its own. A second figure computed here would be a second
 * answer to the same question. The numbers beside the headings are the lengths
 * of the lists underneath them.
 */
export default async function LeadsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('lead.view'),
    shellContext(),
  ])

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

  const [enquiries, converted, leads, holds] = await Promise.all([
    settle(() => listEnquiries({ ...args })),
    settle(() => convertedBookingIds(db, actor.organizationId)),
    settle(() => listLeads(args)),
    settle(() => listLiveHolds(args)),
  ])

  const stages = byLeadStage(enquiries.ok ? enquiries.value : [])

  const bookingRows =
    leads.ok && leads.value
      ? attachHolds(
          // The de-duplication. A booking that is an enquiry's outcome belongs
          // to that enquiry, and showing it again here would put one person's
          // business in the pipeline twice.
          leads.value.filter(
            (lead) =>
              !(converted.ok ? converted.value : new Set()).has(lead.id),
          ),
          holds.ok ? holds.value : null,
        )
      : []
  const bookingStages = byStage(bookingRows)

  const mayCreate = holdsGrant(actor, 'lead.create')
  const mayUpdate = holdsGrant(actor, 'lead.update')

  return (
    <ScreenFrame
      title="צנרת מכירות"
      lead={
        propertyName
          ? `כל מה שנמכר עכשיו ב״${propertyName}״ ועדיין לא נסגר.`
          : 'כל מה שנמכר עכשיו ועדיין לא נסגר, בכל הנכסים שבטווח שלך.'
      }
    >
      {/* ------------------------------------------------------ enquiries -- */}
      <Panel
        title="פניות"
        count={enquiries.ok ? enquiries.value.length : undefined}
        description="מישהו שאל ועדיין אין הזמנה. פנייה יכולה להיות בלי תאריכים, בלי יחידה ובלי מחיר — זה בדיוק המקרה שנופל בין הכיסאות."
        action={
          mayCreate ? (
            <Button href="/leads/new" size="sm">
              פנייה חדשה
            </Button>
          ) : undefined
        }
      >
        {!enquiries.ok ? (
          <ActionError error={enquiries.error} />
        ) : enquiries.value.length === 0 ? (
          <PanelNote>
            אין פניות פתוחות. כל מי שפנה — טופל. זו תשובה אמיתית ולא סינון
            שהסתיר משהו.
          </PanelNote>
        ) : (
          <div className="flex flex-col gap-6">
            {stages
              .filter((stage) => stage.enquiries.length > 0)
              .map((stage) => (
                <section key={stage.status} className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-foreground">
                    {LEAD_STATUS_LABEL[stage.status]}{' '}
                    <span className="tabular-nums font-normal text-muted-foreground">
                      {stage.enquiries.length}
                    </span>
                  </h3>
                  <RowList>
                    {stage.enquiries.map((enquiry) => (
                      <EnquiryRow
                        key={enquiry.id}
                        enquiry={enquiry}
                        mayUpdate={mayUpdate}
                      />
                    ))}
                  </RowList>
                </section>
              ))}
          </div>
        )}

        {enquiries.ok && enquiries.value.length === ENQUIRY_PAGE_SIZE && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            מוצגות {ENQUIRY_PAGE_SIZE} הפניות הוותיקות ביותר. יש נוספות.
          </p>
        )}

        {!seesUnassignedEnquiries(actor, actor.organizationId) && (
          // Said out loud rather than left as an empty column. A manager
          // narrowed to properties does not see an enquiry that names none —
          // `can()` treats an absent property as out of reach, deliberately —
          // and somebody missing a whole queue should know to ask rather than
          // conclude it is empty. `_lib/enquiries.ts` sets out the full
          // reconciliation with `leads_select`.
          <PanelNote tone="attention">
            הטווח שלך מוגבל לנכסים מסוימים, ולכן פניות שלא שויכו לנכס אינן
            מוצגות לך. אם נראה לך שחסרות פניות — זו הסיבה, וההשלמה היא לשייך
            אותן לנכס.
          </PanelNote>
        )}
      </Panel>

      {/* -------------------------------------------------------- bookings -- */}
      <Panel
        title="הזמנות שנפתחו ועדיין לא נסגרו"
        count={bookingRows.length}
        description="הזמנה בשלב שלפני הסגירה — יש יחידה, יש תאריכים, והכסף עוד לא סגור. הזמנה שנוצרה מתוך פנייה אינה מופיעה כאן שוב: היא מוצגת כתוצאה של אותה פנייה, פעם אחת."
      >
        {!leads.ok ? (
          <ActionError error={leads.error} />
        ) : leads.value === null ? (
          <PanelNote tone="attention">
            יש לך הרשאת לידים אך לא הרשאת צפייה בהזמנות, ולכן החלק הזה סגור
            בפניך. זו הרשאה חסרה ולא צנרת ריקה. נדרשת{' '}
            <GrantCode>booking.view</GrantCode>.
          </PanelNote>
        ) : bookingRows.length === 0 ? (
          <PanelNote>אין הזמנה פתוחה שממתינה לסגירה בטווח שלך.</PanelNote>
        ) : (
          <div className="flex flex-col gap-6">
            {bookingStages
              .filter((stage) => stage.leads.length > 0)
              .map((stage) => (
                <section key={stage.status} className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold text-foreground">
                    {BOOKING_STATUS_LABEL[stage.status]}{' '}
                    <span className="tabular-nums font-normal text-muted-foreground">
                      {stage.leads.length}
                    </span>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {STAGE_DESCRIPTION[stage.status]}
                  </p>
                  <RowList>
                    {stage.leads.map((lead) => (
                      <BookingRow key={lead.id} lead={lead} />
                    ))}
                  </RowList>
                </section>
              ))}
          </div>
        )}

        {bookingRows.length === LEAD_PAGE_SIZE && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            מוצגות {LEAD_PAGE_SIZE} ההזמנות הוותיקות ביותר. יש נוספות.
          </p>
        )}
      </Panel>

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
          שמות הפונים ובקשותיהם מוסתרים ממך לפי ההרשאות שלך. מספר ההזמנה מוצג
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
 * What each booking stage means, in the words the workflow uses.
 *
 * Only the four in the pipeline. A `Partial` rather than a total record,
 * because the other fifteen statuses are not stages of a sale and inventing a
 * sentence for `deposit_release` would be describing something this screen
 * never shows.
 */
const STAGE_DESCRIPTION: Partial<Record<Lead['status'], string>> = {
  inquiry: 'נרשמה פנייה על ההזמנה. אף תאריך אינו מוחזק ואף מחיר לא נשלח.',
  quote: 'נשלח מחיר. התאריכים עדיין פתוחים למכירה לאחרים אלא אם יש החזקה.',
  option: 'התאריכים מוחזקים ביומן לטובת הלקוח הזה, ואינם ניתנים למכירה כפולה.',
  awaiting_payment: 'סוכם — וממתין לכסף. זה השלב שנופל הכי הרבה.',
}

/* ----------------------------------------------------------------- rows -- */

function EnquiryRow({
  enquiry,
  mayUpdate,
}: {
  enquiry: Enquiry
  mayUpdate: boolean
}) {
  const dates =
    enquiry.requestedCheckIn && enquiry.requestedCheckOut
      ? `${formatDayMonth(enquiry.requestedCheckIn)}–${formatDayMonth(enquiry.requestedCheckOut)}`
      : // The case this table exists for. Named rather than left blank, so
        // nobody reads an empty cell as missing data.
        'בלי תאריכים'

  return (
    <Row className="flex-col items-stretch gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-foreground">
          {'rawName' in enquiry ? (
            (enquiry.rawName ?? 'פנייה ללא שם')
          ) : (
            <Withheld />
          )}
        </span>
        <Badge tone="neutral">{LEAD_SOURCE_LABEL[enquiry.source]}</Badge>
        {enquiry.guestId === null ? (
          <Badge tone="neutral">לא מקושרת לאורח</Badge>
        ) : (
          <Badge tone="brand">מקושרת לפרופיל אורח</Badge>
        )}
        {enquiry.firstResponseAt === null && (
          // The one badge on this row that is about the business rather than
          // about the enquiry: an unanswered enquiry is money that has not
          // come in yet, and §1 of the specification opens by saying a business
          // that does not track them discovers at the end of the month that it
          // answered half.
          <Badge tone="accent">טרם נענתה</Badge>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        {dates} · {enquiry.partySize} אורחים
        {enquiry.sourceDetail ? ` · ${enquiry.sourceDetail}` : ''}
        {enquiry.budgetAgorot !== null
          ? ` · תקציב ${formatAgorot(enquiry.budgetAgorot)}`
          : ''}
      </p>

      <p className="text-sm text-muted-foreground">
        נפתחה לפני {enquiry.ageDays === 1 ? 'יום' : `${enquiry.ageDays} ימים`}
        {' · '}
        {enquiry.assignedToUserId
          ? `אחראי: ${enquiry.assignedToName ?? 'משתמש שאינו פתוח לצפייה'}`
          : 'ללא אחראי'}
        {'rawPhone' in enquiry && enquiry.rawPhone ? (
          <>
            {' · '}
            <span dir="ltr">{enquiry.rawPhone}</span>
          </>
        ) : null}
        {enquiry.lostReason !== null
          ? ` · סיבת סגירה: ${LEAD_LOST_REASON_LABEL[enquiry.lostReason]}`
          : ''}
      </p>

      {'message' in enquiry && enquiry.message && (
        <p className="text-sm text-foreground">״{enquiry.message}״</p>
      )}

      {mayUpdate && (
        <EnquiryStatusControl
          leadId={enquiry.id}
          status={enquiry.status}
          version={enquiry.version}
          displayName={
            'rawName' in enquiry
              ? (enquiry.rawName ?? 'פנייה ללא שם')
              : 'הפנייה'
          }
        />
      )}
    </Row>
  )
}

function BookingRow({ lead }: { lead: Lead }) {
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
