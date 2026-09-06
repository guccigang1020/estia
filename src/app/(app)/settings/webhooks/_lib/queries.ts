/**
 * EXECUTION CONTEXT — SERVER ONLY. What the webhooks screen reads.
 *
 * ══ IT CANNOT READ A SIGNING SECRET, AND THAT IS STRUCTURAL ═════════════════
 *
 * `WebhookRepository` has no method that returns one and `authenticated` holds
 * no privilege on `webhook_endpoint_secrets`, so this file could not fetch a
 * secret if it tried. The reason to restate it here is the one
 * `guest-guide/repository.ts` gives about door codes: an operator's screen is
 * rendered on a server, and its props are serialised into the HTML that
 * reaches a browser. A secret read here is a secret in the page's payload, and
 * no amount of `{hidden && …}` in a component undoes that.
 *
 * A secret is shown exactly once, by the action that created it, from the
 * operation's return value — never from a read.
 *
 * ══ THE TABLES MAY BE ABSENT, AND THAT IS A STATE ═══════════════════════════
 *
 * Demo mode declares the three tables empty, and a deployment mid-migration
 * has none of them. `42P01` from Postgres and `PGRST205` from PostgREST mean
 * "not provisioned"; everything else is rethrown. A `catch` that swallowed the
 * rest would turn a row-level-security refusal into "this feature is not
 * built", which is the most misleading sentence a screen can produce.
 */

import { WebhookRepository } from '@/lib/webhooks/repository'
import type { WebhookDelivery, WebhookEndpoint } from '@/lib/webhooks'
import type { Db } from '@/lib/persistence'

export const WEBHOOK_TABLES = [
  'webhook_endpoints',
  'webhook_endpoint_secrets',
  'webhook_deliveries',
] as const

export type WebhookScreen =
  | { readonly status: 'not_provisioned' }
  | {
      readonly status: 'ready'
      readonly endpoints: readonly EndpointView[]
    }

export interface EndpointView {
  readonly endpoint: WebhookEndpoint
  readonly recent: readonly WebhookDelivery[]
  /** Counted from `recent`, so the number and the list can never disagree. */
  readonly failing: number
}

function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42P01' || code === 'PGRST205'
}

export async function loadWebhookScreen(
  db: Db,
  organizationId: string,
): Promise<WebhookScreen> {
  const repository = new WebhookRepository(db)

  let endpoints: readonly WebhookEndpoint[]
  try {
    endpoints = await repository.endpoints(organizationId)
  } catch (error) {
    if (isMissingSchema(error)) return { status: 'not_provisioned' }
    throw error
  }

  const views = await Promise.all(
    endpoints.map(async (endpoint): Promise<EndpointView> => {
      // Bounded per endpoint. This answers "is it working and what broke",
      // and nobody reads page nine of a webhook log.
      const recent = await repository.recentDeliveries(
        organizationId,
        endpoint.id,
        20,
      )
      return {
        endpoint,
        recent,
        failing: recent.filter(
          (delivery) =>
            delivery.status === 'exhausted' || delivery.status === 'blocked',
        ).length,
      }
    }),
  )

  return { status: 'ready', endpoints: views }
}
