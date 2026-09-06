/**
 * The rule that makes a customer-composed role safe to allow at all.
 *
 *     A role may never carry a grant its author does not themselves hold.
 *
 * Without it, letting a customer compose roles is letting them compose
 * authority. The attack is not subtle and it does not need a bug anywhere
 * else: `permission.edit` is an ordinary grantable permission, so an owner may
 * put it into a custom role and hand that role to somebody who holds a tenth
 * of the catalogue. From that moment the holder can edit role grants — and if
 * nothing checks what they are writing, they can mint a role carrying
 * `organization.settings.edit`, `payment.refund` or
 * `organization.billing.manage`, have it assigned, and hold it.
 *
 * Row level security cannot express this on its own. `role_permissions_insert`
 * asks whether the caller holds `permission.edit`, and by the time the attack
 * runs the answer is yes. So the comparison is made twice, in the two places
 * that can make it:
 *
 *   · here, against the resolved `Actor`, so the refusal reaches the person as
 *     a Hebrew sentence naming exactly which grants they tried to hand out;
 *   · in `tg_role_permission_within_reach` (0069), against
 *     `public.has_permission()`, so it holds for a caller who never goes
 *     through this file at all.
 *
 * ── Why `holdsGrant` and not `actor.grants.has` ───────────────────────────
 *
 * `holdsGrant` is permission *and* plan. A business that has not bought the
 * agent network does not hold `agent.scope.manage` in any usable sense, and a
 * role minted with it would come alive the day they upgrade — a grant nobody
 * ever decided to hand out, appearing on somebody's account because of a
 * billing change. Asking the same question the engine asks on every request is
 * the only version of this that cannot drift.
 *
 * Nothing here reads a row. It is a function of the actor and the requested
 * list, which is what lets the tests beside it state the rule rather than a
 * fixture.
 */

import { BusinessRuleError } from '../errors'
import { holdsGrant, type Actor } from './can'
import { FIELD_PERMISSIONS, PERMISSIONS, type Grant } from './permissions'

/** Every string the engine understands, actions and field rights alike. */
const CATALOGUE: ReadonlySet<string> = new Set<string>([
  ...PERMISSIONS,
  ...FIELD_PERMISSIONS,
])

/**
 * Is this a grant at all?
 *
 * Checked rather than cast. The codes arrive from a form, and a `Grant` that
 * is merely asserted would let `permissions_role_id_fkey` be the thing that
 * refuses a typo — a foreign-key error where a sentence belongs.
 */
export function isGrant(value: string): value is Grant {
  return CATALOGUE.has(value)
}

/**
 * Why a requested grant list cannot be written, or `null` when it can.
 *
 * Three refusals rather than one, because they are three different
 * conversations. An unknown code is a bug or a stale form; a platform code is
 * somebody reaching for ESTIA's own authority; a grant beyond the author is
 * the escalation this file exists for, and it is the only one of the three
 * that a legitimate, careful person hits — which is why its message names the
 * grants instead of saying "not allowed".
 */
export type GrantRefusal =
  | { kind: 'unknown_grant'; codes: readonly string[] }
  | { kind: 'platform_grant'; codes: readonly string[] }
  | { kind: 'beyond_author'; codes: readonly Grant[] }

/**
 * The grants in `requested` that this actor cannot pass on.
 *
 * Reported all at once, never one at a time: somebody composing a role from a
 * wall of checkboxes must be told which of their choices are refused, not sent
 * back around the loop for each.
 */
export function grantsBeyondReach(
  actor: Actor,
  requested: readonly Grant[],
): readonly Grant[] {
  return requested.filter((grant) => !holdsGrant(actor, grant))
}

/** The first refusal that applies, in the order a reader would notice them. */
export function reviewGrants(
  actor: Actor,
  requested: readonly string[],
): GrantRefusal | null {
  const unknown = requested.filter((code) => !isGrant(code))
  if (unknown.length > 0) return { kind: 'unknown_grant', codes: unknown }

  // Mirrors `tg_role_permission_grantable` from 0002: a customer's role may
  // never hold a platform.* permission, whatever this layer believes. Named
  // separately from `beyond_author` because it stays refused even for ESTIA
  // staff acting inside a customer organization.
  const platform = requested.filter((code) => code.startsWith('platform.'))
  if (platform.length > 0) return { kind: 'platform_grant', codes: platform }

  const beyond = grantsBeyondReach(actor, requested as readonly Grant[])
  if (beyond.length > 0) return { kind: 'beyond_author', codes: beyond }

  return null
}

/** The refusal, in the words the person composing the role should read. */
export function describeGrantRefusal(refusal: GrantRefusal): string {
  const list = refusal.codes.join(', ')

  switch (refusal.kind) {
    case 'unknown_grant':
      return `הרשאות שאינן קיימות בקטלוג: ${list}. רענן את הדף ונסה שוב.`
    case 'platform_grant':
      return `הרשאות של צוות ESTIA אינן ניתנות להקצאה בתוך ארגון: ${list}.`
    case 'beyond_author':
      return (
        `אי אפשר לתת בתפקיד הרשאות שאינך מחזיק בעצמך: ${list}. ` +
        'תפקיד מותאם לעולם אינו מקנה יותר ממה שיש למי שיצר אותו.'
      )
  }
}

/**
 * Refuse the whole list, or return it typed.
 *
 * A `BusinessRuleError` and not an `AuthorizationError`, deliberately. The
 * person holds `permission.edit` — the engine's answer to "may you edit role
 * grants" is yes, and rendering this as a permission failure would send them
 * to an administrator to ask for a right they already have. What they hit is a
 * rule about the *content* of the write, and the message says so.
 */
export function assertGrantable(
  actor: Actor,
  requested: readonly string[],
): readonly Grant[] {
  const refusal = reviewGrants(actor, requested)

  if (refusal !== null) {
    throw new BusinessRuleError({
      code: refusal.kind,
      message: `role grants refused (${refusal.kind}): ${refusal.codes.join(', ')}`,
      userMessage: describeGrantRefusal(refusal),
      // Safe to return: these are grant strings the caller just sent, so the
      // list discloses nothing they did not already have.
      publicDetails: { codes: [...refusal.codes] },
    })
  }

  return requested as readonly Grant[]
}
