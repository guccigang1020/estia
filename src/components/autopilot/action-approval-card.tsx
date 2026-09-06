/**
 * One prepared action, and everything a person needs to say yes or no to it.
 *
 * ── What "prepared" means, and why the card is this long ─────────────────
 *
 * At `ask_approval` Autopilot has already decided WHAT it would do and WHY,
 * and has written both down. What is left is a human choice, and the whole
 * value of the level depends on that choice being informed: an approval screen
 * that says "שליחת תזכורת לאורח — אישור?" trains people to press yes, and a
 * business that presses yes without reading has automation with extra steps
 * and no safety.
 *
 * So the card carries six things, and each is a stored column rather than a
 * sentence composed now:
 *
 *   · what the action is         `action_kind`, through the catalogue's label
 *   · why                        `reason`, prose, written at decision time
 *   · what it is based on        `evidence`, each fact with its source
 *   · how sure                   `confidence`, about the judgment only
 *   · what it would touch        `command` — the same operation a click calls
 *   · what it costs if wrong     `safety_level`
 *
 * ── `reason` is read, never re-derived ───────────────────────────────────
 *
 * 0046 says it plainly: an action taken about a booking that has since been
 * cancelled must still say what it said at the time. This component therefore
 * has no access to the booking at all — it gets the row, and the row is the
 * record.
 *
 * ── The approve control ──────────────────────────────────────────────────
 *
 * `onApprovePath` is a link to wherever the approval is performed, and it is
 * rendered ONLY when the caller says this reader holds `autopilot.approve`.
 * When there is no such path the card says so in one line rather than showing
 * a button that does nothing — the same choice `automations/page.tsx` made
 * about its missing toggle, and for the same reason: a control that silently
 * fails is worse than a stated absence.
 *
 * No `'use client'`: the card holds no state and performs nothing.
 */

import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { AutopilotActionOutcome } from '@/lib/contracts/states'

import { ConfidenceBadge } from './confidence-badge'
import { EvidenceList } from './evidence-list'
import {
  DISPOSITION_MEANING,
  OUTCOME_LABEL,
  RUN_MODE_LABEL,
  SAFETY_LEVEL_LABEL,
  SUPPRESSION_LABEL,
} from './labels'
import { formatMoment } from './time'
import type { ActionView } from './views'

/** Outcomes that still have a person's decision in front of them. */
const PENDING: readonly AutopilotActionOutcome[] = [
  'planned',
  'awaiting_approval',
  'approved',
  'retrying',
]

export type ActionApprovalCardProps = {
  action: ActionView
  /**
   * Whether this reader holds `autopilot.approve`.
   *
   * Passed in rather than derived: the card has no actor, and a component that
   * asked the authorization engine itself would be a second gate disagreeing
   * with the route's.
   */
  mayApprove: boolean
  /** Where approval happens, when a write path exists. See the header. */
  approvePath?: string
  /** Extra context the screen wants under the reason — a link to the booking. */
  children?: ReactNode
}

export function ActionApprovalCard({
  action,
  mayApprove,
  approvePath,
  children,
}: ActionApprovalCardProps) {
  const scheduled = formatMoment(action.scheduledFor)
  const pending = PENDING.includes(action.outcome)

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{action.kindLabel}</span>
        <Badge tone="neutral">{SAFETY_LEVEL_LABEL[action.safetyLevel]}</Badge>
        <ConfidenceBadge confidence={action.confidence} />
        {action.runMode === 'simulation' && (
          <Badge tone="accent">{RUN_MODE_LABEL.simulation}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {OUTCOME_LABEL[action.outcome]}
        </span>
      </header>

      {!action.inCatalogue && (
        <p className="text-xs text-muted-foreground">
          סוג הפעולה הזה אינו מופיע יותר בקטלוג הפעולות. השורה נשמרת כפי שהיא,
          ולא ניתן לבצע אותה.
        </p>
      )}

      <p className="text-sm leading-relaxed text-foreground">{action.reason}</p>

      <EvidenceList
        items={action.evidence}
        title="על מה זה מבוסס"
        emptyNote="לא נשמרו עובדות תומכות לפעולה הזו."
      />

      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <Fact label="מה יבוצע בפועל">
          {action.command === null ? (
            <span className="text-muted-foreground">
              נשארת בתוך ESTIA — לא נוגעת בשום רשומה עסקית
            </span>
          ) : (
            <span dir="ltr">{action.command}</span>
          )}
        </Fact>
        <Fact label="מה המשמעות של הרמה">
          {DISPOSITION_MEANING[action.disposition]}
        </Fact>
        {scheduled !== null && <Fact label="מתוזמן ל־">{scheduled}</Fact>}
        {action.propertyName !== null && (
          <Fact label="נכס">{action.propertyName}</Fact>
        )}
      </dl>

      {action.outcome === 'suppressed' && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          לא בוצעה:{' '}
          {action.suppressedReason === null
            ? (action.suppressedText ?? 'לא נרשמה סיבה')
            : SUPPRESSION_LABEL[action.suppressedReason]}
        </p>
      )}

      {children}

      {pending &&
        (mayApprove ? (
          approvePath === undefined ? (
            <p className="text-xs text-muted-foreground">
              יש לך הרשאת אישור. מסך האישור עצמו עדיין אינו מחובר, ולכן אין כאן
              כפתור שלא יעשה דבר.
            </p>
          ) : (
            <Button href={approvePath} size="sm" className="w-fit">
              לאישור הפעולה
            </Button>
          )
        ) : (
          <p className="text-xs text-muted-foreground">
            אישור פעולות דורש הרשאת <span dir="ltr">autopilot.approve</span>,
            שאינה ברשותך. הפעולה תמתין עד שמישהו שמחזיק בה יאשר.
          </p>
        ))}
    </article>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  )
}
