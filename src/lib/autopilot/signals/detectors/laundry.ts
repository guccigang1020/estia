/**
 * Linen that will not be back in time.
 *
 * ── The words are the mode's, not this file's ─────────────────────────────
 *
 * `laundry/mode.ts` argues it at length and it applies with more force in an
 * alert than on a settings screen: a `simple` operation is one person and a
 * machine, and "ההזמנה לספק מאחרת" told to that person describes a company
 * they do not use, a van that does not come, and an operation they do not run.
 * `FORBIDDEN_IN_SIMPLE` names the words; `vocabularyFor` gives the ones that
 * are allowed. This detector composes its sentences from the vocabulary rather
 * than from literals, and its suite asserts that a `simple` organization's
 * signals contain none of the forbidden words.
 *
 * ── Not ordered, unconfirmed, late: three problems ────────────────────────
 *
 * Nobody started it, somebody started it and the other end has not agreed, and
 * the agreed time has passed. Three codes and three keys, because the person
 * who resolves the first does not resolve the others and a shared key would
 * close all three when they fixed one.
 */

import type { LaundryStatus } from '../../../contracts/states'
import type { Signal } from '../../types'
import { fact, type DetectorContext } from '../facts'
import { signalKey } from '../keys'
import { isModuleEnabled, laundryHasProvider, laundryWords } from '../modules'

export interface LaundryFacts {
  /** `null` when nothing has been raised for this requirement yet. */
  orderId: string | null
  propertyId: string | null
  label: string
  bookingId: string | null
  /** `null` when nothing exists yet. */
  status: LaundryStatus | null
  /** The instant the linen has to be back at the property. */
  requiredBy: string | null
  /** When the other end agreed. `null` where there is no other end. */
  confirmedAt: string | null
  /** When it is actually expected back. */
  expectedBackAt: string | null
  providerName: string | null
}

const TERMINAL: readonly LaundryStatus[] = ['completed', 'cancelled']
const BACK: readonly LaundryStatus[] = ['delivered_to_property', 'completed']

export function detectLaundry(
  batches: readonly LaundryFacts[],
  context: DetectorContext,
): Signal[] {
  if (!isModuleEnabled(context.modules, 'laundry')) return []

  const words = laundryWords(context.modules)
  const hasProvider = laundryHasProvider(context.modules)
  const signals: Signal[] = []

  for (const batch of batches) {
    if (batch.status !== null && TERMINAL.includes(batch.status)) continue

    if (batch.status === null && batch.requiredBy !== null) {
      signals.push(
        emit(
          batch,
          'laundry.not_started',
          `לא נפתחה ${words.batch}`,
          `נדרשת ${words.batch} ואיש לא פתח אותה.`,
          'at_risk',
          [
            fact('laundry.exists', words.batch, false, 'laundry'),
            fact(
              'laundry.required_by',
              'נדרש עד',
              batch.requiredBy,
              'laundry',
              batch.requiredBy,
            ),
          ],
        ),
      )
      continue
    }

    // Confirmation is only a question where there is somebody to confirm. A
    // one-person operation confirms nothing to itself, and asking it to would
    // be inventing a counterparty.
    if (hasProvider && batch.status !== null && batch.confirmedAt === null) {
      signals.push(
        emit(
          batch,
          'laundry.unconfirmed',
          `${words.batch} ללא אישור`,
          batch.providerName === null
            ? `אין אישור שהכביסה תחזור בזמן.`
            : `${batch.providerName} טרם אישר שהכביסה תחזור בזמן.`,
          'at_risk',
          [
            fact('laundry.status', 'סטטוס', batch.status, 'laundry'),
            fact('laundry.confirmed', 'אושר', false, 'laundry'),
          ],
        ),
      )
    }

    const late = isLate(batch, context)
    if (late !== null) {
      signals.push(
        emit(
          batch,
          'laundry.delivery_late',
          'הכביסה לא תחזור בזמן',
          'הכביסה נדרשת מוקדם יותר מהמועד שבו היא צפויה לחזור.',
          late,
          [
            fact(
              'laundry.required_by',
              'נדרש עד',
              batch.requiredBy,
              'laundry',
              batch.requiredBy ?? undefined,
            ),
            fact(
              'laundry.expected_back_at',
              'צפוי לחזור',
              batch.expectedBackAt,
              'laundry',
              batch.expectedBackAt ?? undefined,
            ),
            fact('laundry.status', 'סטטוס', batch.status, 'laundry'),
          ],
        ),
      )
    }
  }

  return signals
}

/**
 * Late, and how badly.
 *
 * Two ways to be late and both are checked. The expected return can already be
 * after the required-by — which is knowable days ahead and is the useful one,
 * because there is still time to do something. Or the required-by can simply
 * have passed with the linen not back, which is knowable only once it is too
 * late and is therefore critical rather than at risk.
 */
function isLate(
  batch: LaundryFacts,
  context: DetectorContext,
): Signal['risk'] | null {
  if (batch.requiredBy === null) return null
  if (batch.status !== null && BACK.includes(batch.status)) return null

  const required = new Date(batch.requiredBy).getTime()
  if (Number.isNaN(required)) return null

  if (context.now.getTime() > required) return 'critical'

  if (batch.expectedBackAt !== null) {
    const expected = new Date(batch.expectedBackAt).getTime()
    if (!Number.isNaN(expected) && expected > required) return 'at_risk'
  }
  return null
}

function emit(
  batch: LaundryFacts,
  code: string,
  headline: string,
  detail: string,
  risk: Signal['risk'],
  evidence: Signal['evidence'],
): Signal {
  // Keyed on the order where there is one and on the property where there is
  // not. A requirement nobody has acted on has no id of its own, and keying it
  // on nothing would collapse every unstarted batch at every property into a
  // single row.
  const resourceType = batch.orderId === null ? 'property' : 'laundry_order'
  const resourceId = batch.orderId ?? batch.propertyId

  return {
    code,
    domain: 'laundry',
    risk,
    resourceType,
    resourceId,
    propertyId: batch.propertyId,
    title: `${batch.label} — ${headline}`,
    detail,
    evidence,
    dedupeKey: signalKey({
      code,
      resourceType,
      resourceId,
      ...(batch.orderId === null && batch.bookingId !== null
        ? { aspect: batch.bookingId }
        : {}),
    }),
    ...(batch.requiredBy === null ? {} : { dueAt: batch.requiredBy }),
  }
}
