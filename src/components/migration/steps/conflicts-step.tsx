'use client'

/**
 * Step six: the decisions only the operator can make.
 *
 * ══ THE MODULE'S RULE, AND THE SCREEN THAT MUST NOT BREAK IT ══════════════
 *
 * Nothing in this feature discards a record because it collided. Three years of
 * bookings contain genuine double-entries, cancelled-then-rebooked stays and one
 * villa sold twice on a Friday in 2023, and every one of those is a fact about
 * the operator's business that they — not this code — have to settle. A silent
 * drop makes the import look cleaner and makes the migration wrong in a way
 * nobody discovers until a guest arrives at a full house.
 *
 * So: no default decision, no "resolve all", no dismiss, and no way to leave a
 * conflict undecided and still reach the import. The unsettled ones are listed
 * first and the settled ones stay on the page, changeable, because a decision
 * taken at speed is one somebody comes back to.
 *
 * ── Every change re-runs the dry run ──────────────────────────────────────
 *
 * Deciding to skip a row changes what will be written, and the number on the
 * next screen has to be the number the import will use. Recomputing it here
 * would be a second implementation of `applicableRows`, and the two would
 * eventually disagree — with the operator having no way to tell which was
 * lying.
 */

import { StepBlocked, StepHeader } from '@/components/migration/step-header'
import { StepNav } from '@/components/migration/step-nav'
import { ConflictCard } from '@/components/migration/conflict-card'
import { useMigration } from '@/components/migration/wizard-state'
import { blockedReason } from '@/app/(app)/migration/_lib/steps'

export function ConflictsStep() {
  const { decisions, settle, pending, progress } = useMigration()
  const blocked = blockedReason('conflicts', progress)

  if (blocked !== null) {
    return <StepBlocked step="conflicts" reason={blocked} />
  }

  const undecided = decisions.filter(
    (conflict) => conflict.decision === 'undecided',
  )
  const settled = decisions.filter(
    (conflict) => conflict.decision !== 'undecided',
  )

  return (
    <section className="flex flex-col gap-5">
      <StepHeader step="conflicts">
        <p className="text-sm text-foreground">
          {decisions.length === 0
            ? 'ההרצה היבשה לא מצאה אף התנגשות.'
            : `${undecided.length} ממתינות להכרעה, ${settled.length} הוכרעו.`}
        </p>
      </StepHeader>

      {decisions.length === 0 && (
        <div className="rounded-xl border border-border bg-surface p-5 text-sm text-muted-foreground">
          אין כאן כלום, וזו תשובה טובה: אף שורה בקובץ לא מתנגשת עם מה שכבר קיים
          אצלכם, ולא עם שורה אחרת בקובץ עצמו. אפשר להמשיך לייבוא.
        </div>
      )}

      {undecided.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="font-display text-base font-bold text-foreground">
            ממתינות לכם ({undecided.length})
          </h3>
          <p className="text-sm text-muted-foreground">
            כל כרטיס מציג את שני הצדדים באותה מידה, כי למסך הזה אין דעה. שורה
            שלא הוכרעה לא תיובא — ולא תימחק.
          </p>
          <ul className="flex flex-col gap-3">
            {undecided.map((conflict) => (
              <li key={conflict.id}>
                <ConflictCard
                  conflict={conflict}
                  onDecide={settle}
                  disabled={pending}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="font-display text-base font-bold text-foreground">
            הוכרעו ({settled.length})
          </h3>
          <p className="text-sm text-muted-foreground">
            נשארות כאן ואפשר לשנות אותן עד לרגע הייבוא. כל שינוי מריץ את ההרצה
            היבשה מחדש.
          </p>
          <ul className="flex flex-col gap-3">
            {settled.map((conflict) => (
              <li key={conflict.id}>
                <ConflictCard
                  conflict={conflict}
                  onDecide={settle}
                  disabled={pending}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <StepNav
        back="dry_run"
        forward="import"
        forwardBlocked={blockedReason('import', progress)}
      />
    </section>
  )
}
