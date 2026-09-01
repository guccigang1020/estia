'use client'

/**
 * One stay's preparation plan, as the person who has to do it receives it.
 *
 * ── The privacy promise is in the data, not in this file ──────────────────
 *
 * Everything rendered below comes off a `CleanerPlanView`, which is an
 * explicit field-by-field projection of `WorkPlan` with no guest name, no
 * price, no total and no rate on it. That is deliberate and it is the whole
 * defence: if the promise lived here, a field added to `WorkPlan` next month
 * would ship to every cleaner in the product the moment somebody wrote
 * `{...plan}` into a component, and nobody reviewing that change would think
 * to come back to a markup file. `cleaner-view.ts` makes the promise; this
 * renders what it hands over.
 *
 * So there is no permission check in this component that hides money. There is
 * no money here to hide.
 *
 * ── Three numbers per item, and the reason they are all on screen ─────────
 *
 * A quantity somebody overruled shows what the rules computed, what the person
 * changed it by, and the reason they gave. Showing only the final figure is
 * the shape that loses the argument three weeks later — nobody can then tell
 * whether the house needed thirty towels because the engine said so or because
 * a supervisor typed it.
 *
 * ── The arithmetic is offered, not forced ─────────────────────────────────
 *
 * The derivation sits behind a `<details>` on each item. A cleaner working
 * down a list does not want an equation under every line; a manager arguing
 * with a number wants nothing else. A disclosure serves both and a
 * permanently expanded block serves neither.
 *
 * ── Every write is one call, and it cannot be fired twice ─────────────────
 *
 * `useAsyncAction` refuses a second run synchronously, which covers the double
 * click that `disabled` alone does not — both events arrive before React
 * re-renders. The server action's idempotency key covers what no button can:
 * a retry after a timeout replays the first answer rather than versioning the
 * plan twice. See `plan-actions.ts` for which key each act uses and why.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import type {
  ItemExplanation,
  PlanGrants,
} from '@/app/(app)/preparation/_lib/plan'
import {
  acknowledgeSectionAction,
  adjustItemAction,
  buildPlanAction,
  cancelPlanAction,
  completeSectionAction,
  recomputePlanAction,
  type PlanActionResult,
} from '@/app/(app)/preparation/_lib/plan-actions'
import { ActionError } from '@/components/booking/action-error'
import { useAsyncAction } from '@/components/ui/async-action'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/ui/cn'
import { Field } from '@/components/ui/field'
import { Textarea, TextInput } from '@/components/ui/input'
import type {
  CleanerItemView,
  CleanerPlanView,
  CleanerSectionView,
  PlanSectionKey,
} from '@/lib/preparation'

import { TaskStatusBadge } from './task-status'

export type PlanBoardProps = {
  bookingId: string
  view: CleanerPlanView
  version: number
  explanations: readonly ItemExplanation[]
  grants: PlanGrants
  /** False when row level security refused the booking row to this reader. */
  bookingReadable: boolean
}

type Submit = (call: () => Promise<PlanActionResult>) => Promise<void>

export function PlanBoard({
  bookingId,
  view,
  version,
  explanations,
  grants,
  bookingReadable,
}: PlanBoardProps) {
  const router = useRouter()
  const action = useAsyncAction<PlanActionResult>()
  const [failure, setFailure] = useState<PlanActionResult | null>(null)
  const [reason, setReason] = useState('')

  const sentences = new Map(
    explanations.map((entry) => [entry.key, entry.sentences]),
  )

  const submit: Submit = async (call) => {
    await action.run(async () => {
      const result = await call()
      setFailure(result.ok ? null : result)
      if (result.ok) router.refresh()
      return result
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <PlanHeader view={view} version={version} readable={bookingReadable} />

      {view.changeNotice && (
        <p
          role="status"
          className="rounded-lg border border-warning bg-surface px-4 py-3 text-sm font-semibold text-foreground"
        >
          {view.changeNotice}
        </p>
      )}

      {failure && !failure.ok && <ActionError error={failure.error} />}

      <div className="flex flex-col gap-4">
        {view.sections.map((section) => (
          <SectionCard
            key={section.key}
            section={section}
            bookingId={bookingId}
            version={version}
            grants={grants}
            sentences={sentences}
            pending={action.pending}
            onSubmit={submit}
          />
        ))}
      </div>

      <PlanFooter
        bookingId={bookingId}
        version={version}
        grants={grants}
        pending={action.pending}
        reason={reason}
        onReason={setReason}
        onSubmit={submit}
      />
    </div>
  )
}

/* ------------------------------------------------------- nothing built yet -- */

/**
 * The act the whole chain was missing.
 *
 * `buildPlan` has been written and tested for weeks and no screen called it,
 * which is why `work_plans` was empty in every deployment and the board said
 * "no plan built" for ever. This is the button.
 *
 * It refuses for a reader without `task.create` by not being rendered, and the
 * operation refuses again, and row level security refuses again. The sentence
 * beside it says what building actually does, because freezing a snapshot is
 * not something a person should discover after the fact: the rules in force
 * today are copied onto this stay and never re-read, so a policy change next
 * month cannot move this plan.
 */
export function BuildPlanPanel({
  bookingId,
  mayBuild,
}: {
  bookingId: string
  mayBuild: boolean
}) {
  const router = useRouter()
  const action = useAsyncAction<PlanActionResult>()
  const [failure, setFailure] = useState<PlanActionResult | null>(null)

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
      <h2 className="font-display text-lg font-bold text-foreground">
        עוד לא נבנתה תוכנית הכנה לשהייה הזו
      </h2>
      <p className="text-sm text-muted-foreground">
        בנייה מחשבת מהמדיניות של הנכס כמה מצעים, כמה מגבות, כמה מיטות, כמה זמן
        וכמה אנשים — ומקפיאה את החוקים שהיו בתוקף היום יחד עם התוכנית, כדי
        שתוכנית מהחודש הזה לא תשתנה כשהמדיניות תשתנה בחודש הבא.
      </p>

      {failure && !failure.ok && <ActionError error={failure.error} />}

      {mayBuild ? (
        <div>
          <Button
            disabled={action.pending}
            onClick={() =>
              void action.run(async () => {
                const result = await buildPlanAction({ bookingId })
                setFailure(result.ok ? null : result)
                if (result.ok) router.refresh()
                return result
              })
            }
          >
            {action.pending ? 'בונה…' : 'בנה תוכנית הכנה'}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          בניית תוכנית היא הרשאה שאין לך. פנה למי שמנהל את ההכנה בנכס.
        </p>
      )}
    </section>
  )
}

/* ------------------------------------------------------------- the head -- */

function PlanHeader({
  view,
  version,
  readable,
}: {
  view: CleanerPlanView
  version: number
  readable: boolean
}) {
  const where = [view.propertyLabel, view.unitLabel].filter(Boolean).join(' · ')

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-bold text-foreground">
          {where.length > 0 ? where : 'תוכנית ההכנה'}
        </h2>
        <p className="text-sm text-muted-foreground">
          גרסה {version}
          {view.bookingReference ? ` · הזמנה ${view.bookingReference}` : ''}
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <Fact
          term="מועד היעד — הגעת האורחים"
          value={when(view.deadlineAt ?? view.arrivalAt)}
        />
        {view.guestCount > 0 && (
          <Fact term="אורחים" value={String(view.guestCount)} />
        )}
        {view.eventTypeLabel && (
          <Fact term="סוג האירוח" value={view.eventTypeLabel} />
        )}
        <Fact term="צוות מומלץ" value={String(view.recommendedStaff)} />
      </dl>

      {view.specialRequests && (
        <div className="rounded-lg bg-muted px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            בקשה מיוחדת של האורח
          </p>
          <p className="text-sm text-foreground">{view.specialRequests}</p>
        </div>
      )}

      {/* Said out loud rather than rendered as a blank. `bookings_select`
          wants `booking.view`, which a cleaner does not hold, so the stay's own
          facts are genuinely unavailable to them — a different thing from a
          booking with nothing written on it. */}
      {!readable && (
        <p className="text-xs text-muted-foreground">
          פרטי השהייה עצמה — מועד ההגעה, סוג האירוח והבקשות המיוחדות — אינם
          פתוחים להרשאה שלך ולכן אינם מוצגים כאן. רשימת העבודה עצמה מלאה.
        </p>
      )}
    </section>
  )
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  )
}

/* ---------------------------------------------------------- the section -- */

function SectionCard({
  section,
  bookingId,
  version,
  grants,
  sentences,
  pending,
  onSubmit,
}: {
  section: CleanerSectionView
  bookingId: string
  version: number
  grants: PlanGrants
  sentences: ReadonlyMap<string, readonly string[]>
  pending: boolean
  onSubmit: Submit
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-surface px-4 py-4',
        section.changed ? 'border-warning' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-base font-bold text-foreground">
            {section.label}
          </h3>
          <TaskStatusBadge status={section.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {section.outstanding > 0
            ? `${section.outstanding} פריטים פתוחים`
            : 'הכול סומן'}{' '}
          · {section.minutes} דקות
        </p>
      </div>

      {section.changed && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted px-3 py-2">
          <p className="text-sm font-medium text-foreground">
            ההזמנה השתנתה — ההכנה עודכנה. אשר שראית את השינוי לפני שתמשיך.
          </p>
          {grants.acknowledge && (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                void onSubmit(() =>
                  acknowledgeSectionAction({
                    bookingId,
                    section: section.key,
                  }),
                )
              }
            >
              ראיתי
            </Button>
          )}
        </div>
      )}

      {section.sectionNote && (
        <p className="text-xs text-muted-foreground">
          נסגר עם פריטים חסרים: {section.sectionNote}
        </p>
      )}

      <ul className="flex flex-col divide-y divide-border">
        {section.items.map((item) => (
          <ItemRow
            key={item.itemId}
            item={item}
            sectionKey={section.key}
            bookingId={bookingId}
            version={version}
            grants={grants}
            sentences={sentences.get(`${section.key}:${item.itemId}`) ?? []}
            pending={pending}
            onSubmit={onSubmit}
          />
        ))}
      </ul>

      {grants.complete && section.status !== 'completed' && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              void onSubmit(() =>
                completeSectionAction({ bookingId, section: section.key }),
              )
            }
          >
            סמן את המקטע כהושלם
          </Button>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------- the item -- */

function ItemRow({
  item,
  sectionKey,
  bookingId,
  version,
  grants,
  sentences,
  pending,
  onSubmit,
}: {
  item: CleanerItemView
  sectionKey: PlanSectionKey
  bookingId: string
  version: number
  grants: PlanGrants
  sentences: readonly string[]
  pending: boolean
  onSubmit: Submit
}) {
  const [open, setOpen] = useState(false)

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-foreground">{item.label}</p>
        <p className="text-sm tabular-nums text-foreground">
          {item.completedCount} / {item.requiredCount}
          {item.requiresPhoto && (
            <span className="ms-2 text-xs text-muted-foreground">
              {item.photoCount > 0 ? 'צולם' : 'נדרש צילום'}
            </span>
          )}
        </p>
      </div>

      {item.instructions && (
        <p className="text-sm text-muted-foreground">{item.instructions}</p>
      )}

      {/* The three values, and never only the third. */}
      {item.adjustmentDelta !== 0 && (
        <p className="text-xs text-muted-foreground">
          חושב {item.calculatedCount} · שינוי ידני{' '}
          {item.adjustmentDelta > 0
            ? `+${item.adjustmentDelta}`
            : `−${Math.abs(item.adjustmentDelta)}`}{' '}
          · בפועל {item.requiredCount}
          {item.adjustmentReason ? ` — ${item.adjustmentReason}` : ''}
        </p>
      )}

      {sentences.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">איך חושבה הכמות</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {sentences.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </details>
      )}

      {grants.adjust &&
        (open ? (
          <AdjustForm
            item={item}
            sectionKey={sectionKey}
            bookingId={bookingId}
            version={version}
            pending={pending}
            onSubmit={onSubmit}
            onClose={() => setOpen(false)}
          />
        ) : (
          <div>
            <button
              type="button"
              className="text-xs text-primary underline-offset-4 hover:underline"
              onClick={() => setOpen(true)}
            >
              שנה את הכמות ידנית
            </button>
          </div>
        ))}
    </li>
  )
}

function AdjustForm({
  item,
  sectionKey,
  bookingId,
  version,
  pending,
  onSubmit,
  onClose,
}: {
  item: CleanerItemView
  sectionKey: PlanSectionKey
  bookingId: string
  version: number
  pending: boolean
  onSubmit: Submit
  onClose: () => void
}) {
  const [count, setCount] = useState(String(item.requiredCount))
  const [why, setWhy] = useState(item.adjustmentReason ?? '')

  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-lg bg-muted px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit(() =>
          adjustItemAction({
            bookingId,
            expectedVersion: version,
            section: sectionKey,
            itemId: item.itemId,
            finalCount: Number(count),
            reason: why,
          }),
        ).then(onClose)
      }}
    >
      <Field
        label="כמה באמת צריך"
        description={`החישוב אמר ${item.calculatedCount}. המספר המחושב נשמר בכל מקרה.`}
        required
      >
        <TextInput
          type="number"
          min={0}
          step={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
        />
      </Field>

      <Field label="למה" required>
        <Textarea
          rows={2}
          value={why}
          onChange={(event) => setWhy(event.target.value)}
        />
      </Field>

      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={pending || why.trim().length === 0}
        >
          שמור שינוי
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          ביטול
        </Button>
      </div>
    </form>
  )
}

/* ----------------------------------------------------------- the footer -- */

function PlanFooter({
  bookingId,
  version,
  grants,
  pending,
  reason,
  onReason,
  onSubmit,
}: {
  bookingId: string
  version: number
  grants: PlanGrants
  pending: boolean
  reason: string
  onReason: (value: string) => void
  onSubmit: Submit
}) {
  if (!grants.recompute && !grants.cancel) return null

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4">
      <h3 className="font-display text-base font-bold text-foreground">
        ההזמנה השתנתה?
      </h3>
      <p className="text-sm text-muted-foreground">
        עדכון מחשב את התוכנית מחדש מול אותם חוקים קפואים, פותח גרסה חדשה ומראה
        בדיוק מה השתנה. הגרסה הקודמת אינה נמחקת, וההתקדמות שכבר נרשמה נשמרת.
      </p>

      <Field label="סיבה" description="נשמרת יחד עם הגרסה החדשה.">
        <Textarea
          rows={2}
          value={reason}
          onChange={(event) => onReason(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        {grants.recompute && (
          <Button
            size="sm"
            disabled={pending || reason.trim().length === 0}
            onClick={() =>
              void onSubmit(() =>
                recomputePlanAction({
                  bookingId,
                  expectedVersion: version,
                  reason,
                }),
              )
            }
          >
            עדכן את התוכנית
          </Button>
        )}

        {grants.cancel && (
          <Button
            size="sm"
            variant="danger"
            disabled={pending || reason.trim().length === 0}
            onClick={() =>
              void onSubmit(() =>
                cancelPlanAction({
                  bookingId,
                  expectedVersion: version,
                  reason,
                }),
              )
            }
          >
            ההזמנה בוטלה — בטל את ההכנה שנותרה
          </Button>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ rendering -- */

/** An instant, in the property's own reading of the clock. */
function when(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return '—'

  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at)
}
