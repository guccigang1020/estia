/**
 * What the case cost, what was decided, and what the money would have to do.
 *
 * ── Three numbers that are not the same number ────────────────────────────
 *
 * An estimate, a quote and an invoice. Every argument about a deposit is an
 * argument about which of the three the guest is being shown, so all three are
 * on screen as separate lines and the total is a sum of them — never a stored
 * figure, because a stored total is a figure that disagrees with the lines the
 * first time somebody corrects one.
 *
 * ── The settlement panel takes no money and says so ───────────────────────
 *
 * `planSettlement` is arithmetic: this much comes off the deposit, this much
 * has to be collected, this much goes back. Applying it is
 * `money_access_cancellation` — the most dangerous class of action in the
 * product — and it happens in `src/lib/payments` under `deposit.hold`,
 * `deposit.release` and `payment.capture`. The note under the figures is not
 * decoration: a reader must not be able to look at this panel and think the
 * deposit has been taken.
 *
 * No `"use client"`: numbers in, markup out.
 */

import type { CaseMoney } from '@/app/(app)/incidents/cases/_lib/queries'
import { FactRow, PanelNote, Withheld } from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import {
  COST_LINE_KIND_LABEL,
  LIABILITY_BASIS_LABEL,
  LIABILITY_OUTCOME_LABEL,
  SETTLEMENT_NOT_EXECUTED_NOTE,
  planSettlement,
  type CaseCostLine,
  type LiabilityDecision,
} from '@/lib/incidents'
import { formatAgorot } from '@/lib/payments/resolver'

export function CaseCosts({
  lines,
  money,
}: {
  lines: readonly CaseCostLine[]
  money: CaseMoney | null
}) {
  // Withheld rather than zeroed. A panel showing ₪0 to somebody without
  // `expense.view` is a lie about the case, not a redaction of it.
  if (money === null) {
    return (
      <PanelNote>
        <Withheld /> — עלויות התיק פתוחות למי שמחזיק בהרשאת ההוצאות. מצב התיק
        וההתקדמות בו מוצגים לך במלואם.
      </PanelNote>
    )
  }

  if (lines.length === 0) {
    return (
      <PanelNote>
        לא נרשמה עדיין עלות. רוב התיקים אינם עולים דבר, ותיק ללא עלות אפשר לסגור
        בלי הכרעה כספית.
      </PanelNote>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-border text-sm">
        {lines.map((line) => (
          <li
            key={line.id}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2.5"
          >
            <span className="flex flex-col">
              <span className="font-medium text-foreground">
                {line.description}
              </span>
              <span className="text-xs text-muted-foreground">
                {COST_LINE_KIND_LABEL[line.kind]}
                {line.incurredOn !== null && ` · ${line.incurredOn}`}
              </span>
            </span>
            <span className="tabular-nums font-medium text-foreground">
              {formatAgorot(line.amountAgorot)}
            </span>
          </li>
        ))}
      </ul>

      <dl className="flex flex-col">
        <FactRow label="סך כל השורות">
          <span className="tabular-nums">
            {formatAgorot(money.totalAgorot)}
          </span>
        </FactRow>
        <FactRow label="הערכה שטרם אושרה בחשבונית">
          <span className="tabular-nums">
            {formatAgorot(money.provisionalAgorot)}
          </span>
        </FactRow>
        <FactRow label="הסכום שנבחן">
          <span className="tabular-nums font-semibold">
            {formatAgorot(money.assessedAgorot)}
          </span>
        </FactRow>
      </dl>

      <p className="text-xs text-muted-foreground">
        ״הסכום שנבחן״ הוא מה שהתיק עלה בפועל כשיש חשבונית, ומה שהוערך כל עוד אין
        אחת. הערכה וחשבונית אינן נסכמות יחד — אחרת אותו נזק היה נספר פעמיים.
      </p>
    </div>
  )
}

export function CaseDecisions({
  decisions,
  mayReadMoney,
}: {
  decisions: readonly LiabilityDecision[]
  mayReadMoney: boolean
}) {
  if (decisions.length === 0) {
    return (
      <PanelNote tone="attention">
        טרם הוכרע מי נושא בעלות. תיק שנרשמו בו עלויות לא ייסגר עד שאדם יכריע —
        זו הנקודה שבה פיקדון נשמר או משוחרר, והיא חייבת לשאת שם.
      </PanelNote>
    )
  }

  const [current, ...superseded] = decisions

  return (
    <div className="flex flex-col gap-4">
      {current && (
        <Decision decision={current} mayReadMoney={mayReadMoney} current />
      )}

      {superseded.length > 0 && (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            הכרעות קודמות ({superseded.length})
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {superseded.map((decision) => (
              <Decision
                key={decision.id}
                decision={decision}
                mayReadMoney={mayReadMoney}
                current={false}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function Decision({
  decision,
  mayReadMoney,
  current,
}: {
  decision: LiabilityDecision
  mayReadMoney: boolean
  current: boolean
}) {
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-base font-bold text-foreground">
          {LIABILITY_OUTCOME_LABEL[decision.outcome]}
        </span>
        <Badge tone={current ? 'accent' : 'neutral'}>
          {current ? 'ההכרעה התקפה' : 'הוחלפה'}
        </Badge>
      </div>

      {/*
        The decider is printed first and always. A decision without a name on
        it cannot exist in this product — the column is `not null`, the type is
        `string`, and the domain refuses a system or an agent — and printing it
        is what makes that visible to the person reading six months later.
      */}
      <dl className="flex flex-col">
        <FactRow label="הכריע">
          <span dir="ltr" className="font-mono text-xs">
            {decision.decidedByUserId}
          </span>
        </FactRow>
        <FactRow label="מתי">
          <time dateTime={decision.decidedAt.toISOString()} dir="ltr">
            {decision.decidedAt.toLocaleString('he-IL', {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </time>
        </FactRow>
        <FactRow label="על סמך">
          {LIABILITY_BASIS_LABEL[decision.basis]}
        </FactRow>
      </dl>

      <blockquote className="border-s-2 border-border ps-3 text-sm text-foreground">
        {decision.rationale}
      </blockquote>

      {mayReadMoney ? (
        <dl className="flex flex-col">
          <FactRow label="סכום שנבחן">
            <span className="tabular-nums">
              {formatAgorot(decision.assessedTotalAgorot)}
            </span>
          </FactRow>
          <FactRow label="על האורח">
            <span className="tabular-nums">
              {formatAgorot(decision.guestChargeAgorot)}
            </span>
          </FactRow>
          <FactRow label="על הבעלים">
            <span className="tabular-nums">
              {formatAgorot(decision.ownerChargeAgorot)}
            </span>
          </FactRow>
          <FactRow label="נספג על ידי העסק">
            <span className="tabular-nums">
              {formatAgorot(decision.businessAbsorbedAgorot)}
            </span>
          </FactRow>
        </dl>
      ) : (
        <p className="text-sm">
          <Withheld /> — הסכומים פתוחים למי שמחזיק בהרשאת ההוצאות.
        </p>
      )}
    </article>
  )
}

/**
 * What applying the decision to a held deposit would look like.
 *
 * Rendered only when the reader may see payment information, and never
 * rendered as something that has happened.
 */
export function SettlementPreview({
  guestChargeAgorot,
  depositHeldAgorot,
}: {
  guestChargeAgorot: number
  depositHeldAgorot: number
}) {
  const plan = planSettlement({ guestChargeAgorot, depositHeldAgorot })

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col">
        <FactRow label="פיקדון מוחזק">
          <span className="tabular-nums">
            {formatAgorot(plan.depositHeldAgorot)}
          </span>
        </FactRow>
        <FactRow label="ייגבה מהפיקדון">
          <span className="tabular-nums">
            {formatAgorot(plan.fromDepositAgorot)}
          </span>
        </FactRow>
        <FactRow label="גבייה נוספת נדרשת">
          <span className="tabular-nums">
            {formatAgorot(plan.additionalCollectionAgorot)}
          </span>
        </FactRow>
        <FactRow label="יוחזר לאורח">
          <span className="tabular-nums">
            {formatAgorot(plan.releaseToGuestAgorot)}
          </span>
        </FactRow>
      </dl>

      <p
        // `status` and not `alert`: it is a true statement about what this
        // screen does, not a failure that just happened to the reader.
        role="status"
        className="rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
      >
        {SETTLEMENT_NOT_EXECUTED_NOTE}
      </p>
    </div>
  )
}
