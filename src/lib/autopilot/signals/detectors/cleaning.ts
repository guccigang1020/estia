/**
 * The cleaning job: who is holding it, and where it has stopped.
 *
 * ── Two domains, because they are two conversations ───────────────────────
 *
 * A job nobody has taken on goes to `staff`. A job somebody has taken on and
 * has not progressed goes to `preparation`. That is not a taxonomy exercise:
 * the first is answered by whoever does the rota and the second by whoever is
 * on site, and sending both to the same screen sends one of them to a person
 * who cannot help. `AUTOPILOT_DOMAINS` orders the triage, so the split is also
 * what puts an unassigned Friday changeover above a slow one.
 *
 * ── `blocked` is not `in_progress`, and the vocabulary already knows ──────
 *
 * `TASK_STATUSES` separates them deliberately — `contracts/states.ts` says a
 * cleaner waiting for linen that has not arrived is not making progress. This
 * detector reads that distinction rather than inferring one from timestamps,
 * and a blocked job carries the reason the cleaner gave, because "תקוע" with
 * no reason is a signal a supervisor cannot act on without a phone call.
 */

import type { AutopilotDomain, TaskStatus } from '../../../contracts/states'
import type { Signal } from '../../types'
import { localTime } from '../deadlines'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { isModuleEnabled } from '../modules'

export interface CleaningFacts {
  taskId: string
  bookingId: string | null
  propertyId: string | null
  label: string
  status: TaskStatus
  assigneeId: string | null
  acceptedAt: string | null
  startedAt: string | null
  completedAt: string | null
  verifiedAt: string | null
  /** Whether this business requires a unit to be inspected before it counts. */
  inspectionRequired: boolean
  /** When the job should be finished. */
  dueAt: string | null
  /** The reason the cleaner gave, when the job is `blocked`. */
  blockedReason: string | null
}

/** Statuses where the work is finished as far as the cleaner is concerned. */
const DONE: readonly TaskStatus[] = ['completed', 'verified']

export function detectCleaning(
  jobs: readonly CleaningFacts[],
  context: DetectorContext,
): Signal[] {
  if (!isModuleEnabled(context.modules, 'cleaning')) return []

  const signals: Signal[] = []

  for (const job of jobs) {
    if (job.status === 'cancelled') continue

    if (job.assigneeId === null) {
      signals.push(
        emit(
          job,
          'cleaning.unassigned',
          'staff',
          'העבודה לא שובצה',
          'אין מי שיבצע את הניקיון.',
          'at_risk',
          [fact('cleaning.assignee', 'משובץ', false, 'tasks')],
        ),
      )
      // An unassigned job cannot also have failed to be accepted or started.
      // One absence, one signal.
      continue
    }

    if (job.acceptedAt === null && !DONE.includes(job.status)) {
      signals.push(
        emit(
          job,
          'cleaning.not_accepted',
          'staff',
          'המנקה טרם אישר',
          'העבודה שובצה ואיש לא אישר אותה.',
          'at_risk',
          [
            fact('cleaning.assignee', 'משובץ', true, 'tasks', undefined),
            fact('cleaning.accepted', 'אושר', false, 'tasks'),
          ],
        ),
      )
    }

    if (job.status === 'blocked') {
      signals.push(
        emit(
          job,
          'cleaning.blocked',
          'preparation',
          'העבודה תקועה',
          job.blockedReason ?? 'העבודה סומנה כתקועה ללא סיבה שנרשמה.',
          'critical',
          [
            fact('cleaning.status', 'סטטוס', job.status, 'tasks'),
            fact(
              'cleaning.blocked_reason',
              'סיבת התקיעה',
              job.blockedReason,
              'tasks',
            ),
          ],
        ),
      )
    }

    if (
      job.startedAt === null &&
      job.acceptedAt !== null &&
      !DONE.includes(job.status) &&
      job.status !== 'blocked'
    ) {
      signals.push(
        emit(
          job,
          'cleaning.not_started',
          'preparation',
          'העבודה טרם החלה',
          'העבודה אושרה ועדיין לא התחילה.',
          'at_risk',
          [
            fact(
              'cleaning.accepted',
              'אושר',
              true,
              'tasks',
              job.acceptedAt ?? undefined,
            ),
            fact('cleaning.started', 'התחיל', false, 'tasks'),
            fact(
              'cleaning.now',
              'השעה כעת',
              localTime(context.now, context.timeZone),
              'deadlines',
              context.now.toISOString(),
            ),
          ],
        ),
      )
    }

    // The inspection is asked for only where the business requires one AND has
    // the module. A business that inspects nothing must never be told its
    // inspection is missing.
    if (
      job.inspectionRequired &&
      isModuleEnabled(context.modules, 'inspection') &&
      job.completedAt !== null &&
      job.verifiedAt === null
    ) {
      signals.push(
        emit(
          job,
          'cleaning.inspection_missing',
          'preparation',
          'בדיקת המוכנות טרם בוצעה',
          'הניקיון הסתיים והנכס טרם נבדק.',
          'at_risk',
          [
            fact(
              'cleaning.completed',
              'הניקיון הסתיים',
              true,
              'tasks',
              job.completedAt ?? undefined,
            ),
            fact('cleaning.verified', 'נבדק', false, 'tasks'),
          ],
        ),
      )
    }
  }

  return signals
}

function emit(
  job: CleaningFacts,
  code: string,
  domain: AutopilotDomain,
  headline: string,
  detail: string,
  risk: Signal['risk'],
  evidence: Signal['evidence'],
): Signal {
  return {
    code,
    domain,
    risk,
    // Keyed on the TASK and not on the booking. One changeover can carry two
    // cleaning jobs — the villa and the annexe — and keying on the booking
    // would let the second job silently overwrite the first.
    resourceType: 'task',
    resourceId: job.taskId,
    propertyId: job.propertyId,
    title: `${job.label} — ${headline}`,
    detail,
    evidence,
    dedupeKey: signalKey({
      code,
      resourceType: 'task',
      resourceId: job.taskId,
    }),
    ...(job.dueAt === null ? {} : { dueAt: job.dueAt }),
  }
}
