/**
 * Why this booking is, or is not, confirmable.
 *
 * The charter's rule stated as a component: wherever the product says a
 * booking is or is not confirmed, it must be able to say why. So this renders
 * the decision's own checks — which requirements the policy names, which are
 * met, which are outstanding — rather than a badge somebody has to interpret.
 *
 * It takes a `CollectionDecision` and computes nothing. That is deliberate: a
 * component that re-derived a shortfall would be the second opinion
 * `resolver.ts` exists to prevent, and it would be the one people actually
 * read.
 *
 * EXECUTION CONTEXT — SERVER COMPONENT by default. No state, no effects.
 */

import { Badge } from '@/components/ui/badge'
import {
  COLLECTION_POLICY_LABEL,
  REQUIREMENT_LABEL,
  formatAgorot,
  type CollectionDecision,
} from '@/lib/payments'

export function PolicyExplanation({
  decision,
  heading = 'מה נדרש לפני אישור ההזמנה',
}: {
  decision: CollectionDecision
  heading?: string
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-foreground">{heading}</h3>
        <Badge tone={decision.confirmable ? 'brand' : 'neutral'}>
          {decision.confirmable ? 'כל הדרישות התקיימו' : 'יש דרישות פתוחות'}
        </Badge>
        <Badge tone="neutral">{COLLECTION_POLICY_LABEL[decision.policy]}</Badge>
      </div>

      {/*
        Where the answer came from. Two words, and they are the difference
        between "this is what we ask everybody" and "somebody decided this for
        this booking" — which is the first question in any argument about it.
      */}
      <p className="text-sm text-muted-foreground">
        {decision.source === 'booking_override'
          ? 'ההזמנה הזו חורגת מברירת המחדל של הארגון.'
          : 'ההזמנה הזו נוהגת לפי ברירת המחדל של הארגון.'}
      </p>

      {decision.overrideReason !== null && (
        <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          <span className="text-muted-foreground">סיבת החריגה: </span>
          {decision.overrideReason}
        </p>
      )}

      {decision.requirements.length === 0 ? (
        // Not an empty state and not a prompt to configure something. A great
        // many businesses confirm by telephone, and the product must say so
        // without implying that a step is missing.
        <p
          role="status"
          className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
        >
          אין דרישות לפני אישור. ההזמנה מאושרת על ידי הצוות, והתשלום מתבצע לפי
          הסיכום מול האורח.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {decision.checks.map((check) => (
            <li
              key={check.requirement}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span aria-hidden="true">{check.met ? '✓' : '•'}</span>
                {REQUIREMENT_LABEL[check.requirement]}
                <span className="sr-only">
                  {check.met ? 'התקיים' : 'טרם התקיים'}
                </span>
              </span>
              <span className="min-w-0 text-sm text-muted-foreground">
                {check.detail}
              </span>
            </li>
          ))}
        </ul>
      )}

      {decision.dueNowAgorot > 0 && (
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">נדרש לפני אישור</dt>
            <dd className="font-medium text-foreground">
              {formatAgorot(decision.dueNowAgorot)}
            </dd>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-3">
            <dt className="text-xs text-muted-foreground">נותר להשלים</dt>
            <dd className="font-medium text-foreground">
              {formatAgorot(decision.shortfallAgorot)}
            </dd>
          </div>
        </dl>
      )}

      {decision.balanceDueDaysBefore !== null && (
        <p className="text-sm text-muted-foreground">
          היתרה צפויה עד {decision.balanceDueDaysBefore} ימים לפני ההגעה.
        </p>
      )}
    </section>
  )
}
