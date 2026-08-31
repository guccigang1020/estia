/**
 * One library entry: why a business would want it, what it says, and what would
 * have to be true for it to work here.
 *
 * The three clauses are `RuleClauses` — the same component `/automations`
 * renders — because they are the same rules and a second copy of that markup
 * would be a second place for the THEN clause to stop naming the permission it
 * needs. What is different here is everything around them: a rationale in
 * business language, and the adoption path in place of the dry run.
 *
 * No `"use client"`: values in, markup out.
 */

import { Badge } from '@/components/ui/badge'
import type { AutomationTemplate, RuleReadiness } from '@/lib/automation'

import {
  ReadinessBadge,
  RuleClauses,
} from '../../automations/_components/rule-card'
import { adoptionSteps, type AdoptionStep } from '../_lib/adoption'

export function TemplateCard({
  template,
  readiness,
}: {
  template: AutomationTemplate
  readiness: RuleReadiness
}) {
  const { rule } = template
  const steps = adoptionSteps(template, readiness)

  return (
    <article className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-soft sm:p-6">
      <header className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="font-display text-lg font-bold tracking-tight text-foreground">
            {rule.name}
          </h3>
          <ReadinessBadge status={readiness.status} />
          {!rule.enabled && <Badge tone="neutral">נשלחת כבויה</Badge>}
        </div>
        {/* The rationale, not the description: this screen is read by somebody
            choosing, and "why would I want this" comes before "what does it
            do". The description is one line down, inside the clauses. */}
        <p className="text-sm leading-relaxed text-foreground">
          {template.rationale}
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {rule.description}
        </p>
      </header>

      <RuleClauses rule={rule} readiness={readiness} />

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold text-muted-foreground">
          מה צריך כדי שזה יעבוד כאן
        </h4>
        <ol className="flex flex-col gap-2">
          {steps.map((step) => (
            <StepLine key={step.title} step={step} />
          ))}
        </ol>
      </div>
    </article>
  )
}

/**
 * One precondition.
 *
 * The mark is a character and not a colour: `✓`, `✕` and `·` are legible with
 * no colour perception at all, and the sentence beside each one repeats the
 * state in words. The unknown state is a middle dot rather than a cross,
 * because "the product cannot answer this" and "you failed this" are different
 * and the second is an accusation.
 */
const MARK: Record<'true' | 'false' | 'null', string> = {
  true: '✓',
  false: '✕',
  null: '·',
}

const MARK_STYLE: Record<'true' | 'false' | 'null', string> = {
  true: 'bg-primary-soft text-primary',
  false: 'bg-muted text-danger ring-1 ring-danger/40',
  null: 'bg-muted text-muted-foreground',
}

function StepLine({ step }: { step: AdoptionStep }) {
  const key = String(step.met) as 'true' | 'false' | 'null'

  return (
    <li className="flex items-start gap-3 text-sm">
      <span
        aria-hidden="true"
        className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${MARK_STYLE[key]}`}
      >
        {MARK[key]}
      </span>
      <span className="min-w-0">
        <span className="font-semibold text-foreground">{step.title}</span>
        <span className="text-muted-foreground"> — {step.detail}</span>
      </span>
    </li>
  )
}
