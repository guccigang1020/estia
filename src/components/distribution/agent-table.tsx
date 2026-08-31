/**
 * The external sellers: who they are, what they may see, what they may sell,
 * and what they have produced.
 *
 * ── Four questions, one row ───────────────────────────────────────────────
 *
 * An owner scanning this list is answering one of four things: *who is this*,
 * *what can they see*, *what can they sell*, *are they earning*. The columns
 * are those four and nothing else — every additional column is one more thing
 * between the reader and the answer, and the detail screen exists for the rest.
 *
 * ── The reach is a count and a name, never a raw id ───────────────────────
 *
 * `inventory_property_ids` is a list of uuids. Printing eight characters of one
 * tells the reader nothing and looks like a bug; printing the property's name
 * requires reading `properties`, which the query does, and a property this
 * reader cannot see is left out of the names rather than shown as an id. So the
 * row says "אחוזת רימונים" where it can and "נכס אחד" where it cannot, and both
 * are true.
 *
 * ── Production is withheld, not zeroed ────────────────────────────────────
 *
 * `owedAgorot` is `null` for a reader without `commission.view`, and `Money`
 * renders `null` as an en dash rather than as ₪0. An owner reading "₪0" beside
 * an agent with four unpaid commissions has been told something false, which is
 * the exact failure `Money` was written to prevent.
 *
 * No `"use client"`: rows in, markup out. The one interactive thing on this
 * screen — the status control — is its own client component and is placed by
 * the page, not by this table.
 */

import Link from 'next/link'

import {
  AGENT_STATUS_LABEL,
  agentStatusTone,
  agentStatusVoided,
  inventoryReachLabel,
} from '@/app/(app)/agents/_lib/labels'
import type {
  AgentListItem,
  AgentProduction,
} from '@/app/(app)/agents/_lib/queries'
import { Money } from '@/components/finance/money'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import { formatIsraeliPhone } from '@/lib/agents'
import { formatDayMonthYear } from '@/lib/booking'

import { AccessLadders } from './access-ladders'

export type AgentRow = {
  agent: AgentListItem
  production: AgentProduction
  /** Names for the properties the reach points at, as far as they are readable. */
  reachNames: readonly string[]
}

export function AgentTable({ rows }: { rows: readonly AgentRow[] }) {
  return (
    <>
      {/* -------------------------------------------------------- phone -- */}
      <ul className="flex flex-col gap-3 lg:hidden">
        {rows.map((row) => (
          <li
            key={row.agent.agentUserId}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-soft"
          >
            <div className="flex items-start justify-between gap-3">
              <Identity row={row} />
              <StatusBadge row={row} />
            </div>

            <AccessLadders
              access={row.agent.access}
              className="rounded-lg bg-muted px-3 py-2"
            />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Cell label="מלאי למכירה">
                <Reach row={row} />
              </Cell>
              <Cell label="הזמנות שהביא">{row.production.bookingCount}</Cell>
              <Cell label="עמלות">
                <Money agorot={row.production.owedAgorot} emphasis />
              </Cell>
              <Cell label="ממתין לתשלום">
                <Money agorot={row.production.unpaidAgorot} />
              </Cell>
            </dl>
          </li>
        ))}
      </ul>

      {/* -------------------------------------------------------- desk --- */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-surface shadow-soft lg:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-240 border-collapse text-start text-sm">
            <caption className="sr-only">
              הסוכנים החיצוניים של הארגון, מהוותיק לחדש
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <Th>הסוכן</Th>
                <Th>מצב</Th>
                <Th>מה הוא רואה</Th>
                <Th>מה הוא מוכר</Th>
                <Th align="end">תפוקה</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr
                  key={row.agent.agentUserId}
                  className="transition-colors hover:bg-muted"
                >
                  <Td>
                    <Identity row={row} />
                  </Td>
                  <Td>
                    <StatusBadge row={row} />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      מאז {formatDayMonthYear(row.agent.joinedOn.slice(0, 10))}
                    </span>
                  </Td>
                  <Td>
                    <AccessLadders access={row.agent.access} />
                  </Td>
                  <Td>
                    <Reach row={row} />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      תקרת הנחה {row.agent.discountCap.maxPercent}%
                      {row.agent.discountCap.maxAgorot !== null && (
                        <>
                          {' '}
                          ועד <Money agorot={row.agent.discountCap.maxAgorot} />
                        </>
                      )}
                    </span>
                  </Td>
                  <Td align="end">
                    <span className="flex flex-col items-end gap-0.5">
                      <Money agorot={row.production.owedAgorot} emphasis />
                      <span className="text-xs text-muted-foreground">
                        {row.production.bookingCount} הזמנות ·{' '}
                        {row.production.commissionCount} עמלות
                      </span>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------ fragments -- */

/**
 * The person, their number and the agency behind them.
 *
 * The name links to their page. A missing name is not replaced with the uuid or
 * with "סוכן" — the telephone number *is* the identity in this module, so it is
 * what shows when the profile row could not be read.
 */
function Identity({ row }: { row: AgentRow }) {
  const { agent } = row
  const label =
    agent.displayName ??
    (agent.phoneE164 ? formatIsraeliPhone(agent.phoneE164) : null)

  return (
    <span className="flex flex-col gap-0.5">
      <Link
        href={`/agents/${agent.agentUserId}`}
        className="font-display text-base font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {label ?? 'סוכן ללא שם רשום'}
      </Link>
      {agent.displayName !== null && agent.phoneE164 !== null && (
        <span dir="ltr" className="text-xs text-muted-foreground">
          {formatIsraeliPhone(agent.phoneE164)}
        </span>
      )}
      {agent.agencyId !== null && (
        <span className="text-xs text-muted-foreground">
          {agent.agencyName ?? 'סוכנות שאינה גלויה לך'}
        </span>
      )}
    </span>
  )
}

function StatusBadge({ row }: { row: AgentRow }) {
  const { status } = row.agent
  return (
    <Badge
      tone={agentStatusTone(status)}
      className={cn(agentStatusVoided(status) && 'line-through opacity-70')}
    >
      {AGENT_STATUS_LABEL[status]}
    </Badge>
  )
}

/**
 * What this agent may sell.
 *
 * The names where they are readable, the count where they are not. Never an id.
 */
function Reach({ row }: { row: AgentRow }) {
  const summary = inventoryReachLabel(row.agent.inventory)

  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {row.reachNames.length > 0 ? row.reachNames.join(' · ') : summary}
      </span>
      {row.reachNames.length > 0 && (
        <span className="text-xs text-muted-foreground">{summary}</span>
      )}
    </span>
  )
}

function Cell({
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

function Th({
  children,
  align = 'start',
}: {
  children: React.ReactNode
  align?: 'start' | 'end'
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-3 font-semibold',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align = 'start',
}: {
  children: React.ReactNode
  align?: 'start' | 'end'
}) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-top text-foreground',
        align === 'end' ? 'text-end' : 'text-start',
      )}
    >
      {children}
    </td>
  )
}
