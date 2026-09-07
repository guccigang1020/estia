/**
 * What the rules actually decided, on real events, in this business.
 *
 * ── Why this is not the dry run ───────────────────────────────────────────
 *
 * The panel above it reconstructs candidate events from rows that exist and
 * asks the engine what WOULD happen. It is a preview, and it says so. This one
 * is a record: every line here is an event the product genuinely raised, with
 * the rules that listened to it resolved against this organization's own
 * switches at the moment it happened. The dry run is what somebody reads before
 * deciding; this is what they read afterwards, and it is the thing that makes
 * the decision reversible.
 *
 * ── THE ONE SENTENCE THIS SCREEN MUST NOT LET SOMEBODY BELIEVE ────────────
 *
 * That a row here means something happened.
 *
 * It never does, whatever the organization has consented to. These rows are
 * `automation_runs` as the EVALUATION half wrote them — what each rule decided
 * — and the performing half stamps `performed_at` on the same row rather than
 * writing a new one. This panel does not read that column, so every word on it
 * is about a decision.
 *
 * So the header says it in full before the first row, the badge for the
 * strongest outcome reads "היה מבקש לפעול" rather than "פעל", and the action
 * list under each row is introduced as what WOULD have been done. The header
 * also states the two gates in the order a person meets them: consent, then a
 * handler for every action — because after consent a rule with one unhandled
 * action is refused whole, and somebody watching one rule work and another do
 * nothing needs to know why.
 *
 * A screen that let a row imply an engine would be the one dishonest thing in a
 * module built entirely around telling a zero from a silence.
 *
 * ── Empty is three different sentences ────────────────────────────────────
 *
 * "Nothing has happened yet" is one honest answer. So is "things happened and
 * no shipped rule listens to any of them" — the library covers fifteen of
 * roughly a hundred catalogue names. The panel cannot tell those apart from an
 * empty list, so it says so rather than picking one and sounding certain.
 *
 * No `"use client"`: values in, markup out.
 */

import { Badge } from '@/components/ui/badge'
import { AUTOMATION_ACTIONS } from '@/lib/automation'
import type {
  AutomationDecision,
  RecordedDecision,
} from '@/lib/automation/runs'
import type { AutomationActionKind } from '@/lib/automation/types'
import { isDomainEvent } from '@/lib/contracts/events'

import {
  DECISION_LABEL,
  DECISION_MEANING,
  DECISION_SOURCE_LABEL,
  triggerLabel,
} from '../_lib/labels'

/**
 * The decision, as a word and a shape rather than as a colour.
 *
 * Every variant carries its own text, so the three states are distinguishable
 * with no colour perception at all — the same rule `rule-card.tsx` follows.
 */
const DECISION_STYLE: Record<AutomationDecision, string> = {
  would_act: 'bg-primary-soft text-primary',
  skipped_conditions: 'bg-accent-soft text-accent-strong',
  skipped_disabled: 'bg-muted text-muted-foreground ring-1 ring-border-strong',
}

export type DecisionsPanelProps = {
  decisions: readonly RecordedDecision[]
  /** The ceiling on the read, stated rather than left to be discovered. */
  sample: number
  /** Hebrew name of the selected property, or null for the whole organization. */
  propertyName: string | null
  /** The rule names, so a row can say the rule rather than its id. */
  ruleNames: Readonly<Record<string, string>>
}

export function DecisionsPanel({
  decisions,
  sample,
  propertyName,
  ruleNames,
}: DecisionsPanelProps) {
  const wouldAct = decisions.filter(
    (decision) => decision.decision === 'would_act',
  ).length

  return (
    <section
      aria-labelledby="decisions-title"
      className="flex flex-col gap-5 rounded-xl border border-border-strong bg-surface p-5 shadow-soft sm:p-6"
    >
      <header className="flex flex-col gap-2">
        <h2
          id="decisions-title"
          className="font-display text-xl font-bold tracking-tight text-foreground"
        >
          מה הכללים החליטו
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          כל שורה כאן היא אירוע אמיתי שקרה בעסק, והכללים שמאזינים לו הוכרעו מול
          המתגים שלכם באותו רגע.{' '}
          {propertyName
            ? `מוצגות ההחלטות של ״${propertyName}״ ושל הארגון כולו.`
            : 'מוצגות ההחלטות של כל הנכסים שבטווח שלך.'}
        </p>

        {/* The absence, in full, before the first row. */}
        <p className="rounded-lg border border-border-strong bg-muted px-4 py-3 text-sm leading-relaxed text-foreground">
          <span className="font-semibold">
            הרישום הזה הוא החלטות, לא ביצוע.
          </span>{' '}
          ביצוע בפועל דורש אישור נפרד של אדם בשם מלא לכל ארגון. בלעדיו נרשמת
          ההחלטה בלבד: לא נשלחת הודעה, לא נפתחת משימה ולא מופקת חשבונית. גם אחרי
          אישור, פעולה שאין לה מבצע במערכת דוחה את הכלל כולו — ולא מבצעת את
          חציו. <span className="font-semibold">״היה מבקש לפעול״</span> פירושו
          שהכלל דלוק והתנאים שלו התקיימו — לא שמשהו קרה, וגם לא שההרשאה לפעולה
          נבדקה.
        </p>
      </header>

      {decisions.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          עדיין לא נרשמה אף החלטה. יש לכך שתי סיבות אפשריות והמסך הזה אינו יודע
          להבחין ביניהן: או שטרם קרה אירוע בעסק מאז שהרישום הופעל, או שהאירועים
          שקרו אינם מהסוגים שאחד מהכללים בספרייה מאזין להם — הספרייה מכסה חמישה
          עשר סוגי אירועים מתוך כמאה שהמוצר מכיר.
        </p>
      ) : (
        <>
          <p className="text-sm text-foreground">
            {decisions.length === 1
              ? 'החלטה אחת'
              : `${decisions.length} ההחלטות האחרונות`}
            {wouldAct > 0 && (
              <>
                {', '}
                <span className="font-semibold">
                  {wouldAct === 1
                    ? 'אחת מהן הייתה מבקשת לפעול'
                    : `${wouldAct} מהן היו מבקשות לפעול`}
                </span>
              </>
            )}
            .
          </p>

          <ul className="flex flex-col gap-3">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionRow
                  decision={decision}
                  ruleName={ruleNames[decision.templateId] ?? null}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        מוצגות עד {sample} ההחלטות האחרונות, מהחדשות ביותר. זו אינה היסטוריית
        הכללים המלאה של העסק.
      </p>
    </section>
  )
}

function DecisionRow({
  decision,
  ruleName,
}: {
  decision: RecordedDecision
  ruleName: string | null
}) {
  return (
    <article className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge className={DECISION_STYLE[decision.decision]}>
          {DECISION_LABEL[decision.decision]}
        </Badge>
        <h3 className="font-display text-base font-bold text-foreground">
          {/* The rule's own Hebrew name where the library still carries it. A
              row whose template has since left the library keeps its id, which
              names the missing entry instead of hiding it behind "כלל". */}
          {ruleName ?? decision.templateId}
        </h3>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        {DECISION_MEANING[decision.decision]}
      </p>

      {decision.reason !== null && (
        <p className="text-sm break-words text-foreground">
          <span className="text-muted-foreground">הסיבה: </span>
          {decision.reason}
        </p>
      )}

      {decision.wouldPerform.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-foreground">
            {decision.decision === 'would_act'
              ? 'מה היה מתבצע אילו הביצוע היה מופעל:'
              : 'מה הכלל הזה עושה כשהוא מוכרע לטובה:'}
          </p>
          <ul className="flex flex-col gap-0.5">
            {decision.wouldPerform.map((action, index) => (
              <li
                key={`${action.kind}-${index}`}
                className="text-sm break-words text-muted-foreground"
              >
                {actionLabel(action.kind)} — {action.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1.5">
          <dt>האירוע:</dt>
          <dd className="text-foreground">{eventLabel(decision.eventName)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>הוכרע לפי:</dt>
          <dd>{DECISION_SOURCE_LABEL[decision.source]}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>מתי:</dt>
          <dd>
            <time dateTime={decision.occurredAt}>
              {formatMoment(decision.occurredAt)}
            </time>
          </dd>
        </div>
      </dl>
    </article>
  )
}

/**
 * The Hebrew for the action kind, or the stored kind itself.
 *
 * The column holds whatever the recorder wrote, and a kind removed from
 * `AUTOMATION_ACTION_KINDS` since would have no entry. Showing the raw kind
 * says which one; "פעולה" would hide it.
 */
function actionLabel(kind: string): string {
  return AUTOMATION_ACTIONS[kind as AutomationActionKind]?.label ?? kind
}

/** Same argument as `triggerLabel`: the catalogue name beats a placeholder. */
function eventLabel(name: string): string {
  return isDomainEvent(name) ? triggerLabel(name) : name
}

/**
 * The moment, in the reader's own locale.
 *
 * `he-IL` is stated rather than left to the runtime: this renders on a server
 * whose locale is nobody's, and a date that silently came out American on some
 * deployments and Israeli on others is the kind of difference nobody reports
 * and everybody distrusts.
 */
function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
