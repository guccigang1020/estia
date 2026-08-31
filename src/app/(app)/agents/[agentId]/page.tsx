import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import {
  AccessLadders,
  BookingRights,
} from '@/components/distribution/access-ladders'
import { AgentStatusControl } from '@/components/distribution/agent-status-control'
import { PlanLock } from '@/components/distribution/plan-lock'
import { Money } from '@/components/finance/money'
import { CommissionStatusBadge } from '@/components/finance/status-badges'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/components/ui/cn'
import { can } from '@/lib/authz/can'
import { formatDayMonthYear } from '@/lib/booking'
import { formatIsraeliPhone, reputationTierFor } from '@/lib/agents'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireDistributionGrant } from '../_lib/gate'
import {
  AGENT_STATUS_LABEL,
  agentStatusTone,
  inventoryReachLabel,
} from '../_lib/labels'
import {
  agentAuditTrail,
  agentBookings,
  agentCommissions,
  agentProduction,
  agentResource,
  loadAgent,
  propertyNames,
} from '../_lib/queries'

export const metadata: Metadata = { title: 'סוכן' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. One external seller, in full.
 *
 * WHAT IS ON THIS SCREEN. The commercial relationship as it is actually stored:
 * the three access ladders, the booking rights that exist only at the top rung,
 * the inventory reach, the two guardrails an owner sets independently of the
 * agreement — a discount cap and hold limits — the bookings this seller brought,
 * the commissions they are owed, and what has been done to their record.
 *
 * THE GUARDRAILS ARE NOT THE AGREEMENT, and the screen keeps them apart.
 * `agency_agreements` says what the commission is; `agent_organization_settings`
 * says how much this particular person may give away and how many dates they may
 * hold. A business renegotiating a rate is not thereby raising a discount cap,
 * and merging the two on screen would suggest it was.
 *
 * REPUTATION WIDENS LIMITS, IT DOES NOT GRANT ANYTHING. `effectiveHoldLimits`
 * in `holds.ts` is the domain's own rule and the screen names the tier rather
 * than recomputing the numbers: the stored limits are the floor, and the tier is
 * why the agent may currently be holding more than the row says.
 *
 * NOTHING IS RECOMPUTED. Every commission amount is the stored figure, written
 * from the snapshotted rule when the commission was created. Multiplying a base
 * by a rate here would produce a second answer that disagrees the moment an
 * agreement is renegotiated, which is exactly when somebody is on this page.
 *
 * WHO THIS SCREEN IS FOR, STATED BECAUSE THE ROUTE NAME INVITES THE OPPOSITE
 * ASSUMPTION. It is where a business reads its sellers, not where a seller
 * reads themselves: `AGENT_BASE` gives an external agent their leads and their
 * own pay and does **not** give them `agent.view`, so an agent is refused this
 * route entirely. `can()` with `family: 'team'` and `assignedToUserId` is still
 * asked per row — a role composed next year that pairs `agent.view` with an
 * `own_records` scope reaches its own record and no other, without this file
 * changing.
 *
 * The commissions below are narrowed a second time with `family: 'finance'` and
 * the payee on the resource, which is what makes a property-scoped reader see
 * four of the demo's seven and an `own_records` reader see their own — by the
 * engine, and not by a filter written for agents.
 *
 * THE AUDIT TRAIL IS EMPTY UNTIL SOMETHING HAPPENS, and says so. `audit_events`
 * is written by the product as it runs and is never seeded; a timeline of
 * invented events on the one screen whose subject is accountability would be the
 * worst possible place to fabricate.
 */
export default async function AgentPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const [access, context, { agentId }] = await Promise.all([
    requireDistributionGrant('agent.view'),
    shellContext(),
    params,
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="רשת הסוכנים אינה כלולה בחבילה שלך"
        body="כאן היו מופיעים התנאים של הסוכן, המגבלות שלו, ההזמנות שהביא והעמלות שמגיעות לו."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const organizationId = actor.organizationId

  let failure: ReturnType<typeof toSafeResponse> | null = null
  let agent: Awaited<ReturnType<typeof loadAgent>> = null
  let production: Awaited<ReturnType<typeof agentProduction>> | null = null
  let commissions: Awaited<ReturnType<typeof agentCommissions>> = null
  let bookings: Awaited<ReturnType<typeof agentBookings>> = null
  let trail: Awaited<ReturnType<typeof agentAuditTrail>> = null
  let reachNames: readonly string[] = []

  try {
    const db = await createClient()
    agent = await loadAgent(db, actor, organizationId, agentId)

    // `null` covers both "no such agent" and "an agent you may not read", and
    // they produce the same 404 on purpose: telling somebody that the record
    // exists and is closed to them is information they did not have.
    if (agent === null) notFound()

    ;[production, commissions, bookings, trail, reachNames] = await Promise.all(
      [
        agentProduction(db, actor, organizationId, agentId),
        agentCommissions(db, actor, organizationId, agentId),
        agentBookings(db, actor, organizationId, agentId),
        agentAuditTrail(db, actor, organizationId, agentId),
        propertyNames(db, organizationId, agent.inventoryPropertyIds).then(
          (names) =>
            agent!.inventoryPropertyIds
              .map((id) => names.get(id))
              .filter((name): name is string => name !== undefined),
        ),
      ],
    )
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  if (failure !== null || agent === null || production === null) {
    return (
      <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        {failure && <ActionError error={failure.error} />}
      </div>
    )
  }

  const tier = reputationTierFor(agent.reputationScore)
  const mayManage = can(
    actor,
    'agent.manage',
    agentResource(organizationId, agent.agentUserId),
  )

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-3">
        <Link
          href="/agents"
          className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← לרשימת הסוכנים
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {agent.displayName ??
              (agent.phoneE164
                ? formatIsraeliPhone(agent.phoneE164)
                : 'סוכן ללא שם רשום')}
          </h1>
          <Badge tone={agentStatusTone(agent.status)}>
            {AGENT_STATUS_LABEL[agent.status]}
          </Badge>
        </div>

        <p className="text-muted-foreground">
          {agent.phoneE164 !== null && (
            <>
              מספר מזוהה{' '}
              <span dir="ltr" className="font-mono text-sm">
                {formatIsraeliPhone(agent.phoneE164)}
              </span>
              {' · '}
            </>
          )}
          {agent.agencyId !== null ? (
            <>מוכר תחת {agent.agencyName ?? 'סוכנות שאינה גלויה לך'}</>
          ) : (
            <>מוכר עצמאי, ללא סוכנות</>
          )}
          {' · '}
          בקשר עם העסק מאז {formatDayMonthYear(agent.joinedOn.slice(0, 10))}
        </p>
      </header>

      {/* ------------------------------------------------------- terms -- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle as="h2">מה הסוכן רואה</CardTitle>
          </CardHeader>
          <p className="mt-2 text-sm text-muted-foreground">
            שלוש דרגות, לא ״סוג סוכן״. הדרגות מצטברות: מי שרואה טלפון רואה גם
            שם. כל שינוי כאן נכנס לתוקף בבקשה הבאה של הסוכן, בלי שהוא צריך
            להתחבר מחדש.
          </p>
          <AccessLadders access={agent.access} className="mt-4" />
          <div className="mt-4 border-t border-border pt-4">
            <BookingRights access={agent.access} />
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">מה הסוכן מוכר</CardTitle>
          </CardHeader>
          <p className="mt-2 text-sm text-muted-foreground">
            טווח המלאי הוא שאלה נפרדת מההרשאות: הוא מגדיר איזה מלאי בכלל קיים
            עבור הסוכן. נכס שלא הוקצה לו פשוט אינו קיים מבחינתו — הוא לא מקבל
            ״אין לך הרשאה״, כי זה היה מגלה לו שהנכס קיים.
          </p>

          <dl className="mt-4 flex flex-col gap-3 text-sm">
            <Row label="טווח">
              <span className="flex flex-col gap-0.5">
                <span>{inventoryReachLabel(agent.inventory)}</span>
                {reachNames.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {reachNames.join(' · ')}
                  </span>
                )}
              </span>
            </Row>
            <Row label="תקרת הנחה">
              {agent.discountCap.maxPercent === 0 ? (
                'אינו רשאי לתת הנחה'
              ) : (
                <>
                  עד {agent.discountCap.maxPercent}%
                  {agent.discountCap.maxAgorot !== null && (
                    <>
                      {' '}
                      ולא יותר מ־
                      <Money agorot={agent.discountCap.maxAgorot} />
                    </>
                  )}
                  . מעבר לזה — בקשת אישור, לא סירוב.
                </>
              )}
            </Row>
            <Row label="שריון תאריכים">
              עד {agent.holdLimits.maxConcurrent} שריונים במקביל,{' '}
              {agent.holdLimits.maxPerDay} ביום,{' '}
              {agent.holdLimits.defaultMinutes} דקות כברירת מחדל ועד{' '}
              {agent.holdLimits.maxMinutes} דקות.
            </Row>
            <Row label="מוניטין">
              {agent.reputationScore}/100 — {tier.label}. המוניטין מרחיב את
              מגבלות השריון בפועל; הוא אינו מוסיף הרשאות.
            </Row>
          </dl>
        </Card>
      </div>

      {/* -------------------------------------------------- production -- */}
      <section className="grid gap-4 sm:grid-cols-3">
        <Figure
          label="הזמנות שהביא"
          value={
            bookings === null
              ? 'לא זמין לצפייה'
              : String(production.bookingCount)
          }
        />
        <Figure
          label="סך העמלות"
          value={<Money agorot={production.owedAgorot} emphasis />}
        />
        <Figure
          label="עדיין לא שולם"
          value={<Money agorot={production.unpaidAgorot} emphasis />}
        />
      </section>

      {/* ------------------------------------------------- commissions -- */}
      <Card>
        <CardHeader>
          <CardTitle as="h2">עמלות</CardTitle>
        </CardHeader>
        {commissions === null ? (
          <p className="mt-3 text-sm text-muted-foreground">
            אין לך הרשאה לראות עמלות, ולכן הרשימה אינה מוצגת. זו אינה טענה שאין
            עמלות.
          </p>
        ) : commissions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            עוד לא נרשמה עמלה לסוכן הזה בטווח שלך. עמלה נוצרת עם ההזמנה כהערכה,
            והופכת לחוב רק אחרי שהתנאים שהעסק קבע התקיימו.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {commissions.map((line) => (
              <li
                key={line.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <span className="flex items-center gap-3">
                  <CommissionStatusBadge status={line.status} />
                  <span className="text-sm text-muted-foreground">
                    {line.rateBps === null
                      ? 'סכום קבוע'
                      : `${line.rateBps / 100}%`}
                    {line.paidOn !== null && (
                      <>
                        {' '}
                        · שולמה {formatDayMonthYear(line.paidOn.slice(0, 10))}
                      </>
                    )}
                  </span>
                </span>
                <Money agorot={line.amountAgorot} emphasis />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---------------------------------------------------- bookings -- */}
      <Card>
        <CardHeader>
          <CardTitle as="h2">הזמנות שהביא</CardTitle>
        </CardHeader>
        {bookings === null ? (
          <p className="mt-3 text-sm text-muted-foreground">
            אין לך הרשאה לראות הזמנות, ולכן הרשימה אינה מוצגת.
          </p>
        ) : bookings.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            עוד לא נרשמה הזמנה על שם הסוכן הזה בטווח שלך.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {bookings.map((booking) => (
              <li
                key={booking.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <Link
                  href={`/bookings/${booking.id}`}
                  dir="ltr"
                  className="font-mono text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {booking.reference}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {formatDayMonthYear(booking.checkIn)} –{' '}
                  {formatDayMonthYear(booking.checkOut)}
                </span>
                <Money agorot={booking.totalAgorot} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------------- audit -- */}
      <Card>
        <CardHeader>
          <CardTitle as="h2">יומן ביקורת</CardTitle>
        </CardHeader>
        {trail === null ? (
          <p className="mt-3 text-sm text-muted-foreground">
            אין לך הרשאה ליומן הביקורת של סוכנים.
          </p>
        ) : trail.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            עוד לא בוצעה פעולה על הרשומה הזו. יומן הביקורת נכתב על ידי המערכת
            כשמשהו קורה — הזמנה של סוכן, שינוי דרגות הרשאה, השעיה — ולא נזרע
            מראש.
          </p>
        ) : (
          <ol className="mt-3 flex flex-col divide-y divide-border">
            {trail.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 py-3">
                <span className="text-sm text-foreground">{entry.summary}</span>
                <span className="text-xs text-muted-foreground">
                  {entry.actorLabel} ·{' '}
                  {formatDayMonthYear(entry.occurredAt.slice(0, 10))}
                  {entry.reason !== null && <> · סיבה: {entry.reason}</>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {/* ------------------------------------------------------ manage -- */}
      {mayManage && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">שינוי מצב</CardTitle>
          </CardHeader>
          <p className="mt-2 text-sm text-muted-foreground">
            השעיה נכנסת לתוקף מיד. שום דבר לא נמחק.
          </p>
          <div className="mt-4">
            <AgentStatusControl
              agentUserId={agent.agentUserId}
              version={agent.version}
              status={agent.status}
              displayName={agent.displayName}
              phoneE164={agent.phoneE164}
            />
          </div>
        </Card>
      )}

      {/* The owner's own note, present only for a reader who holds
          `agent.manage` — `redact()` deleted the key for everybody else, and
          `'internalNote' in agent` is how the absence is told from a null. */}
      {'internalNote' in agent && agent.internalNote !== null && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">הערה פנימית</CardTitle>
          </CardHeader>
          <p className="mt-2 text-sm text-foreground">{agent.internalNote}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            ההערה הזו אינה גלויה לסוכן ואינה גלויה למי שאינו מנהל את רשת
            הסוכנים.
          </p>
        </Card>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- parts -- */

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}

function Figure({
  label,
  value,
  className,
}: {
  label: string
  value: React.ReactNode
  className?: string
}) {
  return (
    <dl
      className={cn(
        'flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-soft',
        className,
      )}
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-bold tabular-nums text-foreground">
        {value}
      </dd>
    </dl>
  )
}
