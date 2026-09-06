/**
 * What happened to one row, in one word.
 *
 * The tone comes from `outcomes.ts`, which is a tested pure module rather than
 * a ternary inline here, because the interesting decision — that only `failed`
 * is loud, and that the idempotent skip is not a warning — is a product
 * decision and belongs somewhere it can be asserted.
 */

import { Badge } from '@/components/ui/badge'
import { RECORD_OUTCOME_LABEL, type RecordOutcome } from '@/lib/migration/types'

import { OUTCOME_MEANING, outcomeTone } from './outcomes'

export function OutcomeBadge({ outcome }: { outcome: RecordOutcome }) {
  return (
    <Badge tone={outcomeTone(outcome)} title={OUTCOME_MEANING[outcome]}>
      {RECORD_OUTCOME_LABEL[outcome]}
    </Badge>
  )
}
