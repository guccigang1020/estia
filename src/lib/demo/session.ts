/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * Who is signed in to the demo, and on which package.
 *
 * In the real product both of these are facts about the world: the person is
 * whoever holds a valid session, and the package is whatever the organization
 * is paying for. In the demo they are two cookies, because the entire point is
 * to walk the same organization as an owner, then as a cleaner, then as an
 * external agent, and watch the product change shape without signing in and
 * out three times.
 *
 * ── The cookie is a selection, not an authorization ───────────────────────
 *
 * This file resolves a *persona*, and a persona is only a `user_id` and a
 * label. It does not carry grants, and nothing downstream reads one from it.
 * The grants still come from the membership, the membership's roles and the
 * membership's scope, resolved by `resolveActor` exactly as they are for a
 * paying customer — see `src/app/(app)/_lib/context.ts`. Handing the engine a
 * grant set straight from a cookie would make the demo prove nothing about the
 * product, because the thing being demonstrated *is* the derivation.
 *
 * The same is true one level up: an unknown cookie value falls back to the
 * default rather than being trusted, which is the same rule `chooseWorkspace`
 * applies to `estia.workspace`. A demo is not a security boundary, but it is
 * also not a reason to write the one line that behaves differently.
 */

import { cookies } from 'next/headers'
import type { User } from '@supabase/supabase-js'

import type {
  ActorSource,
  MembershipRow,
  MembershipScopeRow,
  RoleAssignment,
} from '../actor'
import type { EffectivePlan } from '../plans/plan'

import type { DemoPersona, DemoPlan } from './types'

/* ----------------------------------------------------------------- names -- */

/** Which person the demo is being walked as. */
export const DEMO_PERSONA_COOKIE = 'estia.demo.persona'

/** Which package the organization is on. */
export const DEMO_PLAN_COOKIE = 'estia.demo.plan'

/**
 * The package a fresh visitor lands on.
 *
 * `pro`, deliberately, and not the cheapest. Somebody opening the demo for the
 * first time should see the product with everything switched on; the locks are
 * the interesting part precisely because you can see what they are hiding, and
 * that reads as a lock rather than as an empty product only if you have
 * already seen the screen full.
 */
export const DEFAULT_DEMO_PLAN = 'pro'

/* ------------------------------------------------------------ resolution -- */

/**
 * The persona named by the cookie, or the first one.
 *
 * Pure, and separate from the cookie read, so the fallback is testable without
 * a request. An empty persona list is a dataset that cannot be demonstrated,
 * and it throws rather than returning `undefined` for the shell to trip over
 * three frames later.
 */
export function resolvePersona(
  personas: readonly DemoPersona[],
  requested: string | undefined,
): DemoPersona {
  if (personas.length === 0) {
    throw new Error(
      'The demo dataset defines no personas, so there is nobody to be. ' +
        'DEMO_PERSONAS in src/lib/demo/dataset.ts must list at least one.',
    )
  }
  return personas.find((persona) => persona.id === requested) ?? personas[0]
}

/**
 * The plan named by the cookie, or `pro`.
 *
 * A dataset with no `pro` plan is a broken dataset rather than a reason to
 * silently pick another package: the difference between the plans is the thing
 * on display, and quietly demonstrating `basic` while the switcher says `pro`
 * would be the demo lying about its own state.
 */
export function resolvePlan(
  plans: readonly DemoPlan[],
  requested: string | undefined,
): DemoPlan {
  const match = plans.find((plan) => plan.code === requested)
  if (match) return match

  const fallback = plans.find((plan) => plan.code === DEFAULT_DEMO_PLAN)
  if (!fallback) {
    throw new Error(
      `The demo dataset defines no '${DEFAULT_DEMO_PLAN}' plan to fall back ` +
        `to. DEMO_PLANS in src/lib/demo/dataset.ts must include it.`,
    )
  }
  return fallback
}

/* --------------------------------------------------------------- reading -- */

/**
 * The dataset, loaded where it is used rather than at the top of the file.
 *
 * Both functions below are already async, so this costs nothing — and it keeps
 * the pure resolvers above loadable on their own. That matters more than it
 * sounds: the fallback rules are the part of this file with edge cases worth
 * testing, and a module-level import of a large fixture would make testing them
 * require the whole demo organization to exist first.
 */
async function catalogue() {
  return import('./dataset')
}

/** The persona this request is being walked as. */
export async function currentDemoPersona(): Promise<DemoPersona> {
  const { DEMO_PERSONAS } = await catalogue()
  const store = await cookies()
  return resolvePersona(DEMO_PERSONAS, store.get(DEMO_PERSONA_COOKIE)?.value)
}

/** The package this request sees the organization on. */
export async function currentDemoPlan(): Promise<DemoPlan> {
  const { DEMO_PLANS } = await catalogue()
  const store = await cookies()
  return resolvePlan(DEMO_PLANS, store.get(DEMO_PLAN_COOKIE)?.value)
}

/* ------------------------------------------------------------------ user -- */

/**
 * The persona, as the `User` the rest of the application already handles.
 *
 * Supabase's `User` has a great many fields and this product reads five of
 * them: `id`, `email`, `identities`, and `user_metadata.full_name`. The rest
 * are filled in with the shape a real user would carry rather than left off, so
 * that a screen reaching for one gets a plausible value instead of a crash —
 * and the cast is confined to this function, which is the only place in the
 * demo that manufactures an identity.
 *
 * `id` is the persona's `userId` and not a fresh one: it has to be the value in
 * `memberships.user_id`, because everything downstream — the workspace list,
 * the actor, the audit trail — finds this person by joining on it.
 */
export function demoUser(persona: DemoPersona): User {
  const createdAt = new Date(0).toISOString()
  return {
    id: persona.userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: persona.email,
    email_confirmed_at: createdAt,
    phone: '',
    confirmed_at: createdAt,
    last_sign_in_at: createdAt,
    app_metadata: { provider: 'demo', providers: ['demo'] },
    user_metadata: { full_name: persona.fullName, email: persona.email },
    identities: [],
    created_at: createdAt,
    updated_at: createdAt,
    is_anonymous: false,
  } satisfies User
}

/* ----------------------------------------------------------- actor source -- */

/**
 * The ordinary actor resolution, with the package coming from the switcher.
 *
 * Read what this class does *not* override. Membership, roles and scope are
 * delegated untouched, so the actor is still built the long way round —
 * membership → roles → grants → scope — by `resolveActor`, against rows in the
 * dataset. That derivation is the thing being demonstrated; short-circuiting it
 * by handing `can()` a grant set would leave the demo proving nothing about the
 * product, and every persona would then be a claim rather than a consequence.
 *
 * Only the plan is substituted, because the plan is the second axis of the demo
 * and a cookie is the only way to move along it without editing the database
 * between clicks.
 */
export class DemoActorSource implements ActorSource {
  constructor(
    private readonly delegate: ActorSource,
    private readonly plan: DemoPlan,
  ) {}

  loadMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRow | null> {
    return this.delegate.loadMembership(userId, organizationId)
  }

  loadRoles(membershipId: string): Promise<readonly RoleAssignment[]> {
    return this.delegate.loadRoles(membershipId)
  }

  loadScope(membershipId: string): Promise<MembershipScopeRow | null> {
    return this.delegate.loadScope(membershipId)
  }

  /**
   * The dataset's subscription, pointed at the package the switcher names.
   *
   * The subscription itself is the dataset's — its status, its interval, its
   * prices and its limits — because those are facts about this fictional
   * customer and the switcher has no opinion about them. What changes is the
   * entitlement set, which is what `Basic` and `Pro` actually differ by.
   *
   * The per-customer grants and revocations are cleared deliberately. They are
   * the mechanism for "Pro, but without the website", and leaving one in place
   * while the switcher says `basic` would show a Basic customer a Pro feature —
   * the demo contradicting its own caption, which is worse than a missing
   * feature because the viewer has no way to tell which half is true.
   */
  async loadPlan(organizationId: string): Promise<EffectivePlan | null> {
    const base = await this.delegate.loadPlan(organizationId)
    if (!base) {
      throw new Error(
        `The demo dataset has no live subscription for organization ` +
          `${organizationId}, so there is no package to switch between. Add ` +
          `an 'organization_subscriptions' row (and the 'plans' row it points ` +
          `at) to DEMO_DATASET in src/lib/demo/dataset.ts.`,
      )
    }

    return {
      plan: {
        ...base.plan,
        code: this.plan.code,
        name: this.plan.label,
        entitlements: this.plan.entitlements,
      },
      subscription: {
        ...base.subscription,
        entitlementGrants: [],
        entitlementRevocations: [],
      },
    }
  }
}
