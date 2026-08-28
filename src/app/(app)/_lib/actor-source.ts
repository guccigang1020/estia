/**
 * EXECUTION CONTEXT — SERVER ONLY.
 *
 * The request-scoped binding of `ActorSource` for the app router.
 *
 * This file once carried its own 320-line implementation, written while
 * `src/lib` belonged to other engineers and explicitly labelled as something
 * to move later. `src/lib/persistence/actor.ts` is now that home, and two
 * implementations of the computation that decides what a person may see is
 * precisely the duplication that ends with the two answering differently. So
 * this is the binding and nothing else: it supplies the request-scoped client
 * and delegates every question.
 *
 * That client uses the publishable key and therefore runs as the signed-in
 * user under row level security — which is the point. Even a mistake in the
 * mapping cannot hand over another tenant's membership.
 *
 * **One behaviour changed in the consolidation, deliberately.** The old
 * implementation returned `null` whenever a query errored, folding a database
 * failure into "there is no membership here" and from there into "you have no
 * access". The shared implementation separates them: absence is `null`, a
 * failure throws. Somebody told that something went wrong can retry; somebody
 * silently locked out of their own organization files a support ticket nobody
 * can reproduce.
 */

import type {
  ActorSource,
  MembershipRow,
  MembershipScopeRow,
  RoleAssignment,
} from '@/lib/actor'
import type { EffectivePlan } from '@/lib/plans/plan'
import { SupabaseActorSource as SharedActorSource } from '@/lib/persistence/actor'
import { createClient } from '@/lib/supabase/server'

export class SupabaseActorSource implements ActorSource {
  private delegate: SharedActorSource | null = null

  /**
   * Built on first use rather than in a constructor, because creating the
   * client is asynchronous while every call site constructs this
   * synchronously. Cached for the life of the request, so resolving one actor
   * costs one client rather than four.
   */
  private async source(): Promise<SharedActorSource> {
    this.delegate ??= new SharedActorSource(await createClient())
    return this.delegate
  }

  async loadMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRow | null> {
    return (await this.source()).loadMembership(userId, organizationId)
  }

  async loadRoles(membershipId: string): Promise<readonly RoleAssignment[]> {
    return (await this.source()).loadRoles(membershipId)
  }

  async loadScope(membershipId: string): Promise<MembershipScopeRow | null> {
    return (await this.source()).loadScope(membershipId)
  }

  async loadPlan(organizationId: string): Promise<EffectivePlan | null> {
    return (await this.source()).loadPlan(organizationId)
  }
}
