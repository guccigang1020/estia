/**
 * `AuditWriter`, backed by `public.audit_events`.
 *
 * A mapping and nothing more, which is the point: `audit/pipeline.ts` has
 * already diffed, scrubbed and refused. By the time a record reaches here it
 * is known to have an actor label, an action, a resource type, a summary that
 * does not merely repeat the action, and no secrets at any depth. This file
 * adds no rules, because a second place that decided what an audit event may
 * contain would be a second answer to that question.
 *
 * ── The table is append-only ──────────────────────────────────────────────
 *
 * `audit_events_no_update` and `audit_events_no_delete` are statement-level
 * triggers that refuse both. There is deliberately no `version` column and no
 * `update` method here to match — an audit row that can be edited is not
 * evidence of anything.
 *
 * ── One policy worth knowing about ────────────────────────────────────────
 *
 * `audit_events_insert` additionally requires
 * `actor_user_id IS NULL OR actor_user_id = auth.uid()`. A person can only
 * write audit rows attributing actions to themselves, which is right: an
 * actor field a caller could set freely is a field an attacker can forge.
 *
 * The consequence is concrete. A `system` or `ai_agent` actor must carry
 * `actorUserId: null` — which `AuditActor` already documents as the rule
 * ("present for `user` and `platform_staff`; null for autonomous actions") —
 * and an `onBehalfOfUserId` may only ever name the signed-in user. A
 * background job with no session cannot satisfy this policy at all and needs
 * the admin client, which is one of the few genuinely correct uses of it.
 */

import type { AuditRecord, AuditWriter } from '../audit/pipeline'
import type { TransactionHandle } from '../service'
import type { Db } from './client'
import { clientFor, recordWrite } from './transaction'

export class SupabaseAuditWriter implements AuditWriter {
  constructor(private readonly db: Db) {}

  async write(record: AuditRecord, tx?: TransactionHandle): Promise<void> {
    const db = clientFor(tx, this.db)

    const { error } = await db.from('audit_events').insert({
      organization_id: record.organizationId,
      actor_user_id: record.actorUserId,
      actor_type: record.actorType,
      actor_label: record.actorLabel,
      on_behalf_of_user_id: record.onBehalfOfUserId,
      action: record.action,
      resource_type: record.resourceType,
      // `text`, not `uuid`: the column takes a resource id of any shape,
      // because not every audited resource is a row with a uuid primary key.
      resource_id: record.resourceId,
      property_id: record.propertyId,
      before: record.before,
      after: record.after,
      summary: record.summary,
      reason: record.reason,
      occurred_at: record.occurredAt.toISOString(),
      ip: record.ip,
      user_agent: record.userAgent,
      request_id: record.requestId,
    })

    // Rethrown, never swallowed. The service pipeline treats an audit failure
    // as a failure of the whole operation on purpose — a committed change with
    // no audit row is an untraceable change — and a writer that logged and
    // continued would quietly cancel that decision.
    if (error) throw error

    recordWrite(tx, `audit_events(${record.action})`)
  }
}
