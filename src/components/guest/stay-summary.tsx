/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The stay, at a glance.
 *
 * The first thing a guest has to be able to do on this page is recognise their
 * own booking — where, when, how many, what it costs them. Everything else on
 * the screen asks something of them; this only tells them, and it is first for
 * that reason.
 *
 * ── What is not here ──────────────────────────────────────────────────────
 *
 * The margin, the owner's payout, the agent's commission, the operating cost,
 * the internal notes, the source channel and the tax treatment. Not hidden —
 * absent. `guest_portal_session` never returns any of them, and §2 of
 * migration 0033 lists each one and why. The safety of that does not depend on
 * this component being careful; it depends on there being nothing to be
 * careful with.
 *
 * ── Mobile first ──────────────────────────────────────────────────────────
 *
 * A guest reads this on a telephone, usually one-handed, often outdoors. The
 * layout is a single column that only becomes two on `sm`, the type does not
 * drop below 14px, and nothing is conveyed by colour alone.
 */

import { Badge } from '@/components/ui/badge'
import { formatDayMonthYear } from '@/lib/booking/dates'
import {
  nightsBetween,
  totalGuests,
  type GuestSession,
} from '@/lib/guest-portal'
import { formatAgorot } from '@/lib/plans/plan'

/**
 * What a guest is told about where their booking stands.
 *
 * Deliberately coarser than `BOOKING_STATUS_LABEL`, which has nineteen members
 * including `inspection` and `deposit_release`. Those are facts about the
 * business's own workflow: a guest told their booking is "בבדיקה" learns
 * something they cannot act on and will telephone about.
 */
const GUEST_STATUS_LABEL: Record<string, string> = {
  inquiry: 'פנייה',
  quote: 'הצעת מחיר',
  option: 'שמורה עבורך',
  awaiting_payment: 'ממתינה לתשלום',
  deposit_paid: 'מקדמה התקבלה',
  contract_pending: 'ממתינה לחתימה',
  confirmed: 'מאושרת',
  pre_arrival: 'לקראת הגעה',
  ready_for_check_in: 'מוכנה לכניסה',
  checked_in: 'בשהות',
  in_house: 'בשהות',
  checkout_pending: 'לקראת עזיבה',
  checked_out: 'הסתיימה',
  inspection: 'הסתיימה',
  deposit_release: 'הסתיימה',
  completed: 'הסתיימה',
  review_requested: 'הסתיימה',
  cancelled: 'בוטלה',
  no_show: 'בוטלה',
}

function nightsLabel(nights: number): string {
  if (nights === 1) return 'לילה אחד'
  if (nights === 2) return 'שני לילות'
  return `${nights} לילות`
}

function guestsLabel(count: number): string {
  if (count === 1) return 'אורח אחד'
  if (count === 2) return 'שני אורחים'
  return `${count} אורחים`
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="text-end text-sm font-medium text-foreground">
        {children}
      </dd>
    </div>
  )
}

export function StaySummary({
  session,
  arrivalTime,
  checkOutTime,
}: {
  session: GuestSession
  /** From the journey, which knows the property's default. */
  arrivalTime?: string | null
  checkOutTime?: string | null
}) {
  const nights = nightsBetween(session.checkIn, session.checkOut)
  const guests = totalGuests(session)
  const status = GUEST_STATUS_LABEL[session.status] ?? 'בטיפול'

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
            {session.propertyName ?? session.organizationName}
          </h1>
          <Badge tone="brand">{status}</Badge>
        </div>
        {session.propertyCity && (
          <p className="text-sm text-muted-foreground">
            {session.propertyCity}
          </p>
        )}
      </header>

      <dl className="flex flex-col rounded-xl border border-border bg-surface px-4 py-1">
        <Row label="הגעה">
          {formatDayMonthYear(session.checkIn)}
          {/* The time is shown beside the date rather than on its own row: on a
              telephone every extra row costs a scroll, and neither half is
              useful without the other. */}
          {arrivalTime && (
            <span className="ms-2 font-normal text-muted-foreground">
              משעה {arrivalTime.slice(0, 5)}
            </span>
          )}
        </Row>
        <Row label="עזיבה">
          {formatDayMonthYear(session.checkOut)}
          {checkOutTime && (
            <span className="ms-2 font-normal text-muted-foreground">
              עד שעה {checkOutTime.slice(0, 5)}
            </span>
          )}
        </Row>
        <Row label="לילות">{nightsLabel(nights)}</Row>
        <Row label="אורחים">{guestsLabel(guests)}</Row>
        {session.unitName && <Row label="יחידה">{session.unitName}</Row>}
        <Row label="סה״כ">{formatAgorot(session.totalAgorot)}</Row>
        <Row label="מספר הזמנה">
          <span dir="ltr" className="font-mono text-xs">
            {session.reference}
          </span>
        </Row>
      </dl>

      {/* The guest's own words, returned to them — which is the point of
          `special_requests` being in the projection at all. Never
          `internal_notes`, which is where staff write ABOUT them. */}
      {session.specialRequests && (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            הבקשות שציינת
          </h2>
          <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
            {session.specialRequests}
          </p>
        </div>
      )}
    </section>
  )
}
