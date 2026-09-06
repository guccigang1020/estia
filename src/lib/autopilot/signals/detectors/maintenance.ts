/**
 * Something broken, and whether anybody can safely walk in.
 *
 * ── Safety is a domain of its own, and it is first for a reason ───────────
 *
 * `AUTOPILOT_DOMAINS` puts `safety` above everything including the arrival and
 * the money, and the comment there is explicit: a business that could put
 * revenue above a guest being locked out is a business ESTIA should not help
 * build. A gas smell and a broken kettle are both maintenance rows in the same
 * table, and routing them to the same domain would let the kettle sit above
 * the gas because it happened to be older.
 *
 * So an issue the business has marked safety-critical is emitted into
 * `safety`, always at `critical`, and never suppressed by a deadline
 * calculation. There is no arithmetic under which a safety issue is on track.
 */

import type { TaskStatus } from '../../../contracts/states'
import type { Signal } from '../../types'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { isModuleEnabled } from '../modules'

export interface MaintenanceFacts {
  issueId: string
  propertyId: string | null
  label: string
  /** Hebrew, as the person who reported it wrote it. */
  title: string
  status: TaskStatus
  /** The business's own flag. Never inferred from the wording. */
  safetyCritical: boolean
  /** Whether this stops the unit being used at all. */
  blocksUse: boolean
  dueAt: string | null
  /** The next time somebody is due to walk in. */
  nextArrivalAt: string | null
}

const CLOSED: readonly TaskStatus[] = ['completed', 'verified', 'cancelled']

export function detectMaintenance(
  issues: readonly MaintenanceFacts[],
  context: DetectorContext,
): Signal[] {
  if (!isModuleEnabled(context.modules, 'maintenance')) return []

  const signals: Signal[] = []

  for (const issue of issues) {
    if (CLOSED.includes(issue.status)) continue

    if (issue.safetyCritical) {
      signals.push(
        emit(
          issue,
          'maintenance.safety_issue_open',
          'safety',
          'critical',
          'תקלת בטיחות פתוחה',
          `${issue.title} — התקלה סומנה כבטיחותית והיא עדיין פתוחה.`,
        ),
      )
      // A safety issue is not also reported as a blocker or as overdue. One
      // fault, one row, at the highest severity the product has.
      continue
    }

    if (issue.blocksUse) {
      signals.push(
        emit(
          issue,
          'maintenance.blocks_use',
          'maintenance',
          issue.nextArrivalAt === null ? 'at_risk' : 'critical',
          'תקלה שמונעת שימוש בנכס',
          `${issue.title} — הנכס אינו שמיש עד לתיקון.`,
        ),
      )
      continue
    }

    const overdue =
      issue.dueAt !== null &&
      new Date(issue.dueAt).getTime() < context.now.getTime()

    if (overdue) {
      signals.push(
        emit(
          issue,
          'maintenance.overdue',
          'maintenance',
          'at_risk',
          'תקלה שחרג מועד הטיפול בה',
          `${issue.title} — מועד הטיפול חלף והתקלה פתוחה.`,
        ),
      )
    }
  }

  return signals
}

function emit(
  issue: MaintenanceFacts,
  code: string,
  domain: Signal['domain'],
  risk: Signal['risk'],
  headline: string,
  detail: string,
): Signal {
  return {
    code,
    domain,
    risk,
    resourceType: 'maintenance_issue',
    resourceId: issue.issueId,
    propertyId: issue.propertyId,
    title: `${issue.label} — ${headline}`,
    detail,
    evidence: [
      fact('maintenance.status', 'סטטוס', issue.status, 'maintenance'),
      fact(
        'maintenance.safety_critical',
        'סומן כבטיחותי',
        issue.safetyCritical,
        'maintenance',
      ),
      fact(
        'maintenance.blocks_use',
        'מונע שימוש',
        issue.blocksUse,
        'maintenance',
      ),
      ...(issue.dueAt === null
        ? []
        : [
            fact(
              'maintenance.due_at',
              'מועד טיפול',
              issue.dueAt,
              'maintenance',
              issue.dueAt,
            ),
          ]),
      ...(issue.nextArrivalAt === null
        ? []
        : [
            fact(
              'maintenance.next_arrival_at',
              'ההגעה הבאה',
              issue.nextArrivalAt,
              'booking',
              issue.nextArrivalAt,
            ),
          ]),
    ],
    dedupeKey: signalKey({
      code,
      resourceType: 'maintenance_issue',
      resourceId: issue.issueId,
    }),
    ...(issue.dueAt === null ? {} : { dueAt: issue.dueAt }),
  }
}
