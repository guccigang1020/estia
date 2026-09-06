/**
 * Releasing a hold whose time has ALREADY run out — and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  `hold.release` already exists and releases ANY hold. This is not a second
 *  copy of it. It is the version that CHECKS the sentence its safety level is
 *  claimed from.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── Why this file exists at all ───────────────────────────────────────────
 *
 * `AUTOPILOT_ACTIONS['hold.release_expired']` rates itself `safe_internal`,
 * and the catalogue states the argument for that rating out loud: the hold has
 * ALREADY expired, so Autopilot is applying a decision the business's own
 * expiry policy made rather than making a commercial one. Releasing a hold
 * that has *not* expired is a different act — it is taking dates off a seller
 * mid-deal — and it is not in that catalogue at any level.
 *
 * `hold.release` cannot tell those two apart. It is deliberately tolerant of
 * an expired hold (tidying up must not be refused) and equally tolerant of a
 * live one, which is right for a person clicking a button beside the hold they
 * are looking at, and wrong for an automated planner that computed the id.
 * `execute/registry.ts` therefore withheld the binding rather than pointing
 * `holds.releaseExpired` at it, and that judgment was correct.
 *
 * This operation is what closes that gap: it refuses, by name and with the
 * remaining minutes in the sentence, every hold whose `expiresAt` is still in
 * the future — so a planning mistake produces a loud refusal in
 * `autopilot_actions.error_detail` rather than an agent's live hold quietly
 * disappearing at `safe_internal`.
 *
 * ── The clock is an argument, never a reading ─────────────────────────────
 *
 * `assertHoldHasExpired(hold, now)` is exported and pure. The whole safety
 * claim of this file is one comparison, and a comparison against a clock the
 * function reads for itself is one no test can stand on either side of. The
 * pipeline hands `now` down from `OperationContext`, so the operation and the
 * assertion see the same instant, and a test can put that instant one second
 * before an expiry and one second after it.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * A sweep. This releases ONE hold that the caller has already identified, and
 * there is no `releaseAllExpired` beside it. A batch would need one audit
 * event per hold to stay honest and one transaction across all of them to stay
 * atomic, and those two pull in opposite directions; until somebody needs it,
 * the loop belongs to the caller, where each hold is its own decision with its
 * own record.
 */

import { BusinessRuleError } from '../errors'
import { defineOperation, s, type Operation } from '../service'
import { formatRange } from './dates'
import { HOLD_REASON_LABEL, releaseHold } from './holds'
import type { HoldStore } from './repository'
import type { Hold } from './types'

/* --------------------------------------------------------------- schema -- */

const RELEASE_EXPIRED_INPUT = s.object({
  holdId: s.string({ label: 'החזקה', min: 1, max: 64 }),
})

export type ExpiredHoldRelease = {
  holdId: string
  unitId: string
  /** The hold's own expiry. Strictly in the past — the rule proved it. */
  expiredAt: string
  releasedAt: string
  /** The instant the expiry was judged against. Recorded, not inferred. */
  verifiedAt: string
}

/* ------------------------------------------------------------ the check -- */

const MINUTE_MS = 60_000

/**
 * Refuse anything that is not a hold whose time has already run out.
 *
 * Four refusals, and each one names the hold, because the caller is usually a
 * planner rather than a person: "ההחזקה כבר שוחררה" with no id in it is a line
 * somebody reads in an activity feed at midnight and cannot act on.
 *
 * The unreadable-expiry case is where this deliberately parts company with
 * `isHoldLive`. That function treats an unparseable `expiresAt` as expired,
 * and it is right to: it decides whether a hold BLOCKS anything, and the safe
 * reading of corrupt data is the one that frees inventory. This decides
 * whether to WRITE, on the sole ground that an expiry has passed — and an
 * expiry nobody can read is not evidence that it has. Same data, opposite safe
 * answer, so the two are not shared.
 */
export function assertHoldHasExpired(hold: Hold, now: Date): void {
  if (hold.convertedToBookingId !== null) {
    throw new BusinessRuleError({
      code: 'hold.release_expired.already_converted',
      message:
        `Hold ${hold.id} became booking ${hold.convertedToBookingId} and ` +
        'cannot be released as expired',
      userMessage:
        `ההחזקה ${hold.id} כבר הפכה להזמנה, ולכן אין מה לשחרר. ` +
        'אם ההזמנה עצמה שגויה, בטלו אותה — שחרור החזקה לא יבטל אותה.',
      publicDetails: { holdId: hold.id },
    })
  }

  if (hold.releasedAt !== null) {
    throw new BusinessRuleError({
      code: 'hold.release_expired.already_released',
      message: `Hold ${hold.id} was already released at ${hold.releasedAt}`,
      userMessage:
        `ההחזקה ${hold.id} כבר שוחררה, והתאריכים כבר חזרו למכירה. ` +
        'לא בוצע דבר.',
      publicDetails: { holdId: hold.id, releasedAt: hold.releasedAt },
    })
  }

  const expires = Date.parse(hold.expiresAt)
  if (Number.isNaN(expires)) {
    throw new BusinessRuleError({
      code: 'hold.release_expired.expiry_unreadable',
      message: `Hold ${hold.id} has an unreadable expiry: ${hold.expiresAt}`,
      userMessage:
        `לא ניתן לקרוא את מועד הפקיעה של ההחזקה ${hold.id}, ולכן אי אפשר ` +
        'לקבוע שתוקפה פג. שחררו אותה ידנית לאחר בדיקה.',
      publicDetails: { holdId: hold.id },
    })
  }

  if (expires > now.getTime()) {
    const minutes = Math.max(
      1,
      Math.ceil((expires - now.getTime()) / MINUTE_MS),
    )
    throw new BusinessRuleError({
      code: 'hold.release_expired.not_expired',
      message:
        `Hold ${hold.id} expires at ${hold.expiresAt}, which is after ` +
        `${now.toISOString()} — it has NOT expired and will not be released`,
      userMessage:
        `ההחזקה ${hold.id} עדיין בתוקף — היא תפוג רק בעוד ${minutes} דקות. ` +
        'שחרור אוטומטי מותר רק להחזקה שתוקפה כבר פג. אם צריך לשחרר אותה ' +
        'עכשיו, זו החלטה מסחרית ויש לבצע אותה ידנית.',
      publicDetails: { holdId: hold.id, expiresAt: hold.expiresAt },
    })
  }
}

/* ---------------------------------------------------------- the command -- */

export type HoldExpiryCommands = {
  releaseExpired: Operation<{ holdId: string }, Hold, ExpiredHoldRelease>
}

/**
 * Built against `HoldStore` rather than the whole `BookingRepository`.
 *
 * This needs to read one hold and write one hold. Taking the availability
 * source and the booking store as well would let a future edit here reach a
 * booking, which is precisely the widening the safety level does not cover.
 */
export function defineHoldExpiryCommands(repo: HoldStore): HoldExpiryCommands {
  const releaseExpired = defineOperation<
    { holdId: string },
    Hold,
    ExpiredHoldRelease
  >({
    name: 'hold.release_expired',
    permission: 'hold.release',
    resourceType: 'hold',
    input: RELEASE_EXPIRED_INPUT,

    async loadResource({ input, context }) {
      const hold = await repo.loadHold(
        context.actor.organizationId,
        input.holdId,
      )
      if (!hold) return null
      return {
        resource: { organizationId: hold.organizationId, unitId: hold.unitId },
        entity: hold,
      }
    },

    /**
     * The precondition, then the ordinary one.
     *
     * `assertHoldHasExpired` runs first because it is the stronger statement:
     * it settles that this hold is over. `releaseHold` is then called for its
     * refusals alone — the value is discarded here and rebuilt in `execute`,
     * so the check and the write cannot drift apart.
     */
    rule({ entity, now }) {
      assertHoldHasExpired(entity, now)
      releaseHold(entity, now)
    },

    async execute({ entity, now, tx }) {
      const hold = await repo.saveHold(releaseHold(entity, now), tx)
      return {
        holdId: hold.id,
        unitId: hold.unitId,
        expiredAt: entity.expiresAt,
        releasedAt: hold.releasedAt ?? now.toISOString(),
        verifiedAt: now.toISOString(),
      }
    },

    audit({ entity, result, context }) {
      return {
        resourceId: result.holdId,
        before: { releasedAt: null, expiresAt: entity.expiresAt },
        after: { releasedAt: result.releasedAt, reason: 'expired' },
        summary:
          `${context.auditActor.label} שחררה את ההחזקה על יחידה ${entity.unitId} ` +
          `לתאריכים ${formatRange(entity)} (${HOLD_REASON_LABEL[entity.reason]}) ` +
          'לאחר שתוקפה כבר פג',
      }
    },

    /**
     * `hold.released`, and deliberately not `hold.expired` as well.
     *
     * The hold stopped blocking anything at `expiresAt` — `isHoldLive` has said
     * so on every read since. Raising `hold.expired` now would date that moment
     * to whenever the sweep happened to run, and a subscriber counting expiries
     * would report them all at 03:14. One act, one event.
     */
    events({ entity, result }) {
      return [
        {
          name: 'hold.released',
          payload: {
            holdId: result.holdId,
            unitId: result.unitId,
            checkIn: entity.checkIn,
            checkOut: entity.checkOut,
            releasedBecause: 'expired',
            expiredAt: result.expiredAt,
          },
        },
      ]
    },
  })

  return { releaseExpired }
}
