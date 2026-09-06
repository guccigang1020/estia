/**
 * One automation, as one sentence and one set of numbers.
 *
 * WHEN · IF · THEN is the whole vocabulary `src/lib/automation/types.ts`
 * allows, so it is the whole vocabulary this card renders — three labelled
 * clauses in that order, in Hebrew, with the frozen event name beside the
 * trigger for anybody who needs to match it against the catalogue.
 *
 * ── The numbers are the point, not the decoration ─────────────────────────
 *
 * The four counts come from `simulate()`, which ran the real engine over rows
 * that are really in this database, and the example lines under them are the
 * actual rows it matched. A card that only said "פעילה" would be a promise; a
 * card that says "התאימה ל-11 שורות, שלוש מהן כאן" is a claim somebody can
 * check by opening the bookings list, which is the only kind worth making about
 * software that will act on a business by itself.
 *
 * ── Nothing here is a silent grey badge ───────────────────────────────────
 *
 * A rule that cannot run says why, in a sentence, in Hebrew, with the two
 * conversations kept apart: a package is a conversation with whoever owns the
 * plan, a permission is a conversation with an administrator, and a fact the
 * trigger does not carry is a conversation with nobody — it is a rule that will
 * never fire, and it is stated as such. `Blocker.kind` is what keeps the three
 * visually distinct without the colour being the only signal.
 *
 * No `"use client"`: values in, markup out.
 */

import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import {
  AUTOMATION_ACTIONS,
  READINESS_LABEL,
  type RuleReadinessStatus,
} from '@/lib/automation'

import {
  actionGrantLabel,
  describeConditionInHebrew,
  triggerLabel,
} from '../_lib/labels'
import type { Blocker, RuleView } from '../_lib/rules'

/* -------------------------------------------------------------- badges --- */

/**
 * The readiness, as a word and a shape rather than as a colour.
 *
 * Every variant carries its own text, so the four states are distinguishable
 * with no colour perception at all. The border weight is the second signal.
 */
const READINESS_STYLE: Record<RuleReadinessStatus, string> = {
  ready: 'bg-primary-soft text-primary',
  partial: 'bg-accent-soft text-accent-strong',
  blocked: 'bg-muted text-danger ring-1 ring-danger/40',
  module_locked: 'bg-accent text-accent-foreground',
}

export function ReadinessBadge({ status }: { status: RuleReadinessStatus }) {
  return (
    <Badge className={READINESS_STYLE[status]}>{READINESS_LABEL[status]}</Badge>
  )
}

/* ------------------------------------------------------------- clauses --- */

/**
 * WHEN · IF · THEN, rendered once for both screens.
 *
 * `/automations` and `/templates` show the same three clauses about the same
 * rules and differ only in what they wrap them with — a dry run on one, an
 * adoption path on the other. Two copies of this markup would be two places for
 * the THEN clause to stop naming the permission it needs, which is the line
 * that does the most work on either screen.
 */
export function RuleClauses({
  rule,
  readiness,
}: {
  rule: RuleView['rule']
  readiness: RuleView['readiness']
}) {
  return (
    <dl className="flex flex-col gap-3 border-y border-border py-4 text-sm">
      <Clause term="מתי">
        <span className="text-foreground">{triggerLabel(rule.when)}</span>{' '}
        <code
          dir="ltr"
          className="inline-block rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {rule.when}
        </code>
      </Clause>

      <Clause term="בתנאי">
        {rule.conditions.length === 0 ? (
          <span className="text-muted-foreground">
            בכל פעם שהאירוע קורה — בלי תנאי מסנן.
          </span>
        ) : (
          <ul className="flex flex-col gap-1">
            {rule.conditions.map((condition, index) => (
              <li key={index} className="text-foreground">
                {describeConditionInHebrew(condition)}
              </li>
            ))}
          </ul>
        )}
      </Clause>

      <Clause term="ואז">
        <ul className="flex flex-col gap-2">
          {rule.actions.map((action, index) => {
            // Under a plan lock no action reaches its permission check —
            // `runAutomations` refuses the rule before the loop — so marking
            // one action refused and another fine would describe a comparison
            // the engine never makes. The card's own module sentence is the
            // whole answer, and `readiness.ts` takes the same precedence.
            const status =
              readiness.status === 'module_locked'
                ? 'ready'
                : (readiness.actions[index]?.status ?? 'ready')
            return (
              <li key={`${action.kind}-${index}`} className="flex flex-col">
                <span className="text-foreground">
                  {AUTOMATION_ACTIONS[action.kind].label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {action.note} · דורש{' '}
                  {actionGrantLabel(AUTOMATION_ACTIONS[action.kind].requires)}
                  {status !== 'ready' && (
                    <span className="font-semibold text-danger">
                      {' '}
                      — לא יתבצע
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </Clause>
    </dl>
  )
}

/* ---------------------------------------------------------------- card --- */

/**
 * `control` is a slot rather than a component this file imports.
 *
 * The switch is a client component that calls three server actions; the card
 * is values-in-markup-out and is rendered by `/templates` as well, which has no
 * write path and must not acquire one by importing this file. The page that
 * owns the wiring passes the control in, and a caller with nothing to pass —
 * a reader without `automation.manage`, or the templates screen — renders a
 * card with no switch rather than a switch that would be refused.
 *
 * ── The default badge is about the LIBRARY, not about this organization ────
 *
 * "כבויה כברירת מחדל" is a statement about how ESTIA ships the rule. Once a
 * business has decided for itself, that sentence is no longer the interesting
 * one and the switch below states the real one, so the badge stands down. A
 * card that said "off by default" beside a switch reading "דולק" would be two
 * true sentences arranged to read as a contradiction.
 */
export function RuleCard({
  view,
  control,
}: {
  view: RuleView
  control?: ReactNode
}) {
  const { rule, readiness, simulation } = view

  const showsShippedDefault =
    view.state === null ? !rule.enabled : view.state.source === 'shipped'

  return (
    <article className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="font-display text-lg font-bold tracking-tight text-foreground">
            {rule.name}
          </h3>
          <ReadinessBadge status={readiness.status} />
          {/* Stated because the library ships half its rules off on purpose:
              anything that speaks to a guest, spends money or issues a document
              is off until somebody approves the wording. A card that hid that
              would make a deliberate decision look like a bug. */}
          {!rule.enabled && showsShippedDefault && (
            <Badge tone="neutral">כבויה כברירת מחדל</Badge>
          )}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {rule.description}
        </p>
      </header>

      <RuleClauses rule={rule} readiness={readiness} />

      {control}

      {/* The dry run for this rule. Placed inside the card rather than in a
          separate table so the numbers cannot be read against the wrong rule. */}
      {view.triggerSimulated ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Count
              label="אירועים תואמים"
              value={simulation.matched}
              tone="plain"
            />
            <Count
              label="היו מתבצעות"
              value={simulation.wouldRun}
              tone="good"
            />
            <Count
              label="סוננו בתנאי"
              value={simulation.filtered}
              tone="plain"
            />
            <Count label="נחסמו" value={simulation.refused} tone="warn" />
          </div>

          {simulation.examples.length > 0 && (
            <div className="rounded-lg border border-border bg-muted px-4 py-3">
              <p className="text-xs font-semibold text-foreground">
                שורות אמיתיות שהכלל היה פועל עליהן
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {simulation.examples.map((example) => (
                  <li
                    key={example}
                    className="text-sm break-words text-muted-foreground"
                  >
                    {example}
                  </li>
                ))}
              </ul>
              {simulation.wouldRun > simulation.examples.length && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  ועוד {simulation.wouldRun - simulation.examples.length} שאינן
                  מוצגות כאן.
                </p>
              )}
            </div>
          )}

          {simulation.matched === 0 && (
            <p className="text-sm text-muted-foreground">
              אף שורה בנתונים שנקראו לא הגיעה למצב הזה. זו אמירה על העסק, לא על
              הכלל.
            </p>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          ההרצה היבשה אינה יכולה לשחזר את האירוע הזה מהנתונים הקיימים, ולכן אין
          לכלל הזה מספרים כאן — לא אפס אירועים, אלא אין דרך לספור.
        </p>
      )}

      {view.blockers.length > 0 && (
        <ul className="flex flex-col gap-2">
          {view.blockers.map((blocker, index) => (
            <BlockerLine key={index} blocker={blocker} />
          ))}
        </ul>
      )}
    </article>
  )
}

function Clause({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-xs font-semibold text-muted-foreground sm:w-16 sm:pt-0.5">
        {term}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

const COUNT_TONE = {
  plain: 'text-foreground',
  good: 'text-primary',
  warn: 'text-danger',
} as const

function Count({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: keyof typeof COUNT_TONE
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`font-display text-xl font-bold tabular-nums ${
          value === 0 ? 'text-muted-foreground' : COUNT_TONE[tone]
        }`}
      >
        {value}
      </span>
    </div>
  )
}

/** The Hebrew word for what kind of conversation this blocker is. */
const BLOCKER_TERM: Record<Blocker['kind'], string> = {
  plan: 'חבילה',
  permission: 'הרשאה',
  fact: 'נתון חסר',
  trigger: 'מגבלת ההדמיה',
}

const BLOCKER_STYLE: Record<Blocker['kind'], string> = {
  plan: 'border-accent-strong/40 bg-accent-soft',
  permission: 'border-border-strong bg-muted',
  fact: 'border-danger/40 bg-muted',
  trigger: 'border-border bg-muted',
}

function BlockerLine({ blocker }: { blocker: Blocker }) {
  return (
    <li
      className={`flex flex-col gap-1 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:gap-3 ${BLOCKER_STYLE[blocker.kind]}`}
    >
      <span className="shrink-0 text-xs font-semibold text-foreground sm:w-24 sm:pt-0.5">
        {BLOCKER_TERM[blocker.kind]}
      </span>
      <span className="min-w-0 text-muted-foreground">{blocker.message}</span>
    </li>
  )
}
