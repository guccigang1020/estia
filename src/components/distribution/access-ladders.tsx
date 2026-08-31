/**
 * The three ladders, as an owner has to be able to read them at a glance.
 *
 * ── Why it renders three rungs and not a preset name ──────────────────────
 *
 * There is no `agent.type` and there never will be — `types.ts` enforces that
 * in the type system, and `access.ts` explains why: the four presets are
 * *starting positions*, nothing records which one was chosen, and the moment an
 * owner edits one the preset it came from stops being true. So this component
 * cannot print "סוכן בכיר", because no such fact exists on the record. It prints
 * the three rungs the record actually holds.
 *
 * That is also the more useful rendering. "Senior agent" tells an owner nothing
 * about whether their seller can read a guest's telephone number; the rung does.
 *
 * ── The rungs are cumulative and the wording says so ──────────────────────
 *
 * `grantsForGuestDataLevel('phone')` grants the name as well, so a label
 * reading "טלפון" would understate what was handed over. `labels.ts` words each
 * rung by everything beneath it, and this component prints that wording rather
 * than composing its own.
 *
 * ── The booking rights are shown only where they exist ────────────────────
 *
 * Amendments, cancellation and the payment link are properties of
 * `AgentAccessBooking` alone — the union does not carry them on the lower
 * variants, and `canBook` is the type guard. So the section is absent rather
 * than empty for a referral agent, because "אין תיקונים" beside an agent who
 * cannot make a booking at all reads as a setting somebody could change.
 *
 * No `"use client"`: a record in, markup out.
 */

import {
  CALENDAR_LEVEL_LABEL,
  GUEST_DATA_LEVEL_LABEL,
  LADDER_LABEL,
  PRICE_LEVEL_LABEL,
  cancellationLabel,
} from '@/app/(app)/agents/_lib/labels'
import { Badge } from '@/components/ui/badge'
import { AGENT_AMENDMENT_LABEL, canBook, type AgentAccess } from '@/lib/agents'

export function AccessLadders({
  access,
  className,
}: {
  access: AgentAccess
  className?: string
}) {
  return (
    <dl className={className}>
      <Rung label={LADDER_LABEL.calendar}>
        {CALENDAR_LEVEL_LABEL[access.calendar]}
      </Rung>
      <Rung label={LADDER_LABEL.price}>{PRICE_LEVEL_LABEL[access.price]}</Rung>
      <Rung label={LADDER_LABEL.guestData}>
        {GUEST_DATA_LEVEL_LABEL[access.guestData]}
      </Rung>
    </dl>
  )
}

/**
 * The rights that exist only at the booking rung.
 *
 * Returns `null` below it. The caller renders nothing rather than a heading
 * with an empty list under it — see the header.
 */
export function BookingRights({ access }: { access: AgentAccess }) {
  if (!canBook(access)) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">
          תיקונים שהסוכן רשאי לבצע בהזמנה
        </span>
        {access.amendments.length === 0 ? (
          <span className="text-sm text-foreground">
            אינו רשאי לשנות דבר בהזמנה אחרי שנוצרה
          </span>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {access.amendments.map((amendment) => (
              <li key={amendment}>
                <Badge>{AGENT_AMENDMENT_LABEL[amendment]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">ביטול</span>
        <span className="text-sm text-foreground">
          {cancellationLabel(access.cancellation)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">קישור לתשלום</span>
        <span className="text-sm text-foreground">
          {access.paymentLink
            ? 'רשאי לשלוח לאורח קישור לתשלום'
            : 'אינו רשאי לשלוח קישור לתשלום'}
        </span>
      </div>
    </div>
  )
}

function Rung({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  )
}
