/**
 * What the terms forms are allowed to offer, and why it is less than the
 * column permits.
 *
 * ── Two bases, not six ────────────────────────────────────────────────────
 *
 * `public.commission_base` has six members since 0018, and
 * `COMMISSION_BASES` in `contracts/states` names all six. `BASE_INCLUDES` in
 * `src/lib/agents/commission.ts` defines only two of them, and says so
 * explicitly: the other four — `gross_revenue`, `net_revenue`,
 * `net_of_direct_costs`, `net_contribution` — are finance and preparation
 * concepts that cannot be computed from a booking's price lines, and a base
 * absent from that table is **refused** rather than quietly treated as gross.
 *
 * So offering all six here would be offering four settings that make the
 * commission engine throw the next time a booking is priced. A capability that
 * cannot be sourced from real data is reported as absent with the reason, and
 * this constant is that report.
 *
 * ── Three rule kinds in the form, four in the operation ───────────────────
 *
 * `tiered` is a real arrangement, is stored, is rendered, and is accepted by
 * `agency.set_terms`. It is not *built* here: a tier ladder is a repeating
 * bracket editor with its own validity rule — the lowest bracket must start at
 * zero or small bookings silently pay nothing — and a half-built one is worse
 * than none. An agency already on a tiered rule keeps it; the form says so
 * rather than flattening it to a percentage behind the reader's back.
 */

import type { CommissionBase, CommissionCondition } from '@/lib/agents'

/** The bases `commission.ts` can actually compute. See the header. */
export const TERMS_BASES: readonly CommissionBase[] = [
  'stay_total',
  'accommodation_only',
]

/** The rule kinds this form builds. `tiered` is read-only here, on purpose. */
export const TERMS_RULE_KINDS = ['none', 'percentage', 'fixed'] as const

export type TermsRuleKind = (typeof TERMS_RULE_KINDS)[number]

export const TERMS_RULE_KIND_LABEL: Record<TermsRuleKind, string> = {
  none: 'ללא עמלה',
  percentage: 'אחוז מכל הזמנה',
  fixed: 'סכום קבוע לכל הזמנה',
}

/**
 * What a new agreement waits for before the commission becomes a debt.
 *
 * `commission.ts`: "Paying on `estimated` means paying for stays that never
 * happened." The column defaults to an empty list — eligible immediately, which
 * is a real arrangement somebody might choose — so the *screen's* default has
 * to be the safe one rather than the column's.
 */
export const DEFAULT_ELIGIBILITY: readonly CommissionCondition[] = [
  'stay_completed',
]
