/**
 * How sure Autopilot is about its own judgment — and never about the facts.
 *
 * `types.ts` puts `confidence` on the proposed action rather than on the
 * signal, and the wording here follows that line exactly: this badge describes
 * "an extra cleaner would probably fix this", not "there are probably six
 * towels". An arithmetic shortage is not a guess, and a badge that sat beside
 * one would teach a manager to distrust arithmetic.
 *
 * Three values and not a percentage, for the reason the vocabulary gives: a
 * number invites a threshold argument nobody can settle, and implies a
 * precision a heuristic over operational data does not have.
 *
 * ── The tone is not a verdict ────────────────────────────────────────────
 *
 * `low` renders `neutral` rather than in danger colours. Low confidence is not
 * an error — it is the system saying so honestly, and the policy engine
 * already refuses to let it execute anything external or material. Painting it
 * red would report a working refusal as a fault.
 *
 * No `'use client'`.
 */

import { Badge, type BadgeTone } from '@/components/ui/badge'
import type { AutopilotConfidence } from '@/lib/contracts/states'

import { CONFIDENCE_LABEL } from './labels'

const TONE: Record<AutopilotConfidence, BadgeTone> = {
  low: 'neutral',
  medium: 'neutral',
  high: 'brand',
}

export function ConfidenceBadge({
  confidence,
}: {
  confidence: AutopilotConfidence
}) {
  return (
    <Badge tone={TONE[confidence]}>
      {CONFIDENCE_LABEL[confidence]}
      <span className="sr-only"> — מתייחס לשיקול הדעת, לא לעובדות</span>
    </Badge>
  )
}
