/**
 * One incident: the root cause, and everything it caused underneath it.
 *
 * ── Four alarms for one laundry van ──────────────────────────────────────
 *
 * The delivery is late, so the linen is short, so the preparation will not
 * finish, so the 15:00 arrival is at risk. Four rows in
 * `autopilot_exceptions`, each true, each with its own deadline — and a screen
 * that lists them flat sends the manager to the arrival risk, which is the one
 * link in the chain they can do nothing about. The van is the answer.
 *
 * `caused_by` in 0046 points at the ROOT rather than at the previous alert,
 * and this card is the reason that column exists. The root gets the heading,
 * the deadline and the evidence; its consequences are listed beneath it as
 * what will follow, in one collapsed block. The count is on the summary so a
 * person can see the blast radius without opening it.
 *
 * ── The card asserts nothing the row did not say ─────────────────────────
 *
 * `title`, `detail`, `risk`, the deadlines and the evidence are columns. There
 * is no severity computed here from the deadline, no "critical because it is
 * within the hour" — `warn_at` and `critical_at` are stored precisely so that
 * the threshold is the detector's and not the renderer's. What this file
 * decides is which of two colours a stored risk state gets.
 *
 * ── The owner is a name or it is nobody ──────────────────────────────────
 *
 * `ownerName` null with `ownerUserId` set means the row names somebody whose
 * profile this reader could not read. That prints as "משויך" without a name
 * rather than as an id, which is not something a person can act on, and never
 * as "לא משויך", which would be false.
 *
 * No `'use client'`: `<details>` opens without JavaScript, so grouping needs
 * no client boundary at all.
 */

import type { ReactNode } from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { cn } from '@/components/ui/cn'
import type { AutopilotRiskState } from '@/lib/contracts/states'

import { EvidenceList } from './evidence-list'
import { DOMAIN_LABEL, EXCEPTION_STATE_LABEL, RISK_LABEL } from './labels'
import { formatMoment } from './time'
import type { ExceptionView, IncidentView } from './views'

const RISK_TONE: Record<AutopilotRiskState, BadgeTone> = {
  ready: 'neutral',
  on_track: 'neutral',
  at_risk: 'accent',
  critical: 'accent',
}

const RISK_EDGE: Record<AutopilotRiskState, string> = {
  ready: 'border-border',
  on_track: 'border-border',
  at_risk: 'border-border-strong',
  critical: 'border-danger',
}

export type ExceptionCardProps = {
  incident: IncidentView
  /** Rendered under the evidence — the prepared action, when there is one. */
  children?: ReactNode
}

export function ExceptionCard({ incident, children }: ExceptionCardProps) {
  const { root, consequences } = incident
  const due = formatMoment(root.dueAt)
  const lastSeen = formatMoment(root.lastSeenAt)

  return (
    <article
      className={cn(
        'flex flex-col gap-4 rounded-xl border bg-surface p-5 shadow-soft',
        RISK_EDGE[root.risk],
      )}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={RISK_TONE[root.risk]}>{RISK_LABEL[root.risk]}</Badge>
          <Badge tone="neutral">{DOMAIN_LABEL[root.domain]}</Badge>
          <span className="text-xs text-muted-foreground">
            {EXCEPTION_STATE_LABEL[root.state]}
          </span>
          {root.propertyName !== null && (
            <span className="text-xs text-muted-foreground">
              · {root.propertyName}
            </span>
          )}
        </div>

        <h3 className="font-display text-base font-bold text-foreground">
          {root.title}
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {root.detail}
        </p>
      </header>

      <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <Fact label="מועד אחרון">
          {due ?? <span className="text-muted-foreground">לא נקבע</span>}
        </Fact>
        <Fact label="אחראי">
          {root.ownerUserId === null ? (
            <span className="text-muted-foreground">לא משויך</span>
          ) : (
            (root.ownerName ?? 'משויך')
          )}
        </Fact>
        <Fact label="נוגע ל־">
          <span dir="ltr">
            {root.resourceType}
            {root.resourceId !== null && `:${root.resourceId}`}
          </span>
        </Fact>
        <Fact label="נצפה לאחרונה">
          {lastSeen ?? '—'}
          {root.seenCount > 1 && (
            <span className="text-muted-foreground">
              {' '}
              · {root.seenCount} זיהויים לאותה תקלה
            </span>
          )}
        </Fact>
      </dl>

      <EvidenceList
        items={root.evidence}
        title="על מה זה מבוסס"
        emptyNote="לא נשמרו עובדות תומכות לחריגה הזו."
      />

      {consequences.length > 0 && (
        <details className="rounded-lg bg-muted px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            מה זה גורר — {consequences.length} תוצאות של אותה תקלה
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {consequences.map((consequence) => (
              <li key={consequence.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm text-foreground">
                    {consequence.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {RISK_LABEL[consequence.risk]} ·{' '}
                    {DOMAIN_LABEL[consequence.domain]}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {consequence.detail}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            אלה אינן תקלות נפרדות. טיפול בסיבה למעלה סוגר את כולן.
          </p>
        </details>
      )}

      {children}
    </article>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium text-foreground">{children}</dd>
    </div>
  )
}

/** The flat form, for a consequence rendered on its own. */
export function ExceptionSummary({ exception }: { exception: ExceptionView }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <Badge tone={RISK_TONE[exception.risk]}>
        {RISK_LABEL[exception.risk]}
      </Badge>
      <span className="text-sm text-foreground">{exception.title}</span>
      <span className="text-xs text-muted-foreground">
        {DOMAIN_LABEL[exception.domain]}
      </span>
    </div>
  )
}
