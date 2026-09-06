/**
 * EXECUTION CONTEXT — SERVER ONLY. Registering, pausing and rotating.
 *
 * Four operations, each through `defineOperation` so each gets the same
 * authorization, validation, transaction, audit row and idempotency as
 * everything else. A plain server action would look identical on screen and
 * would skip all of it.
 *
 * ══ THE SECRET IS RETURNED ONCE, AND ONLY HERE ══════════════════════════════
 *
 * `register` and `rotateSecret` are the only functions in the product that
 * ever return a signing secret to a caller, and they return it exactly once —
 * in the operation's result, to the person who just asked for it. It is never
 * readable again: `WebhookRepository` has no method that selects it,
 * `authenticated` holds no privilege on the table, and the settings screen
 * therefore shows it once with "copy it now" and cannot show it later even if
 * somebody wanted it to.
 *
 * That is the whole reason rotation exists as a first-class operation rather
 * than "delete it and make another": the alternative to rotating is a
 * customer who lost their secret re-registering the endpoint, which changes
 * its id and silently orphans every delivery already queued against it.
 *
 * ══ THE URL IS CHECKED HERE AND CHECKED AGAIN AT SEND TIME ══════════════════
 *
 * `checkWebhookUrl` refuses at registration, where a person sees the message
 * and fixes their typo. `sender.ts` re-checks the resolved address before
 * every single request, where a violation is an attack rather than a mistake.
 * Neither replaces the other — see `url-safety.ts` on DNS rebinding.
 *
 * ══ THE EVENT NAMES ARE CHECKED AGAINST THE FROZEN CATALOGUE ════════════════
 *
 * `s.enumOf(DOMAIN_EVENTS)`, not `s.string()`. A subscription to an event
 * that does not exist looks identical to a working one on screen, delivers
 * nothing forever, and reads to the customer as the product being broken.
 * The database checks only the shape of a name; the catalogue is enforced
 * right here, at the boundary, where a refusal can carry a sentence.
 */

import { DOMAIN_EVENTS } from '../contracts/events'
import { BusinessRuleError, NotFoundError } from '../errors'
import { clientFor, type Db } from '../persistence'
import { defineOperation, s, type Operation } from '../service'
import { generateSigningSecret } from './signature'
import { checkWebhookUrl } from './url-safety'
import { URL_REFUSAL_LABEL } from './labels'
import type { WebhookEndpoint } from './types'

const ENDPOINTS = 'webhook_endpoints'
const SECRETS = 'webhook_endpoint_secrets'

/**
 * How long a rotated-out secret keeps verifying.
 *
 * Twenty-four hours. Long enough for a customer to deploy the new one during
 * a working day; short enough that a leaked secret is not accepted for a week.
 * A rotation with no overlap at all would mean every delivery failing until
 * the receiver is updated, which is why nobody would ever rotate.
 */
export const PREVIOUS_SECRET_GRACE_HOURS = 24

const REGISTER_INPUT = s.object({
  url: s.string({ label: 'כתובת', max: 2048 }),
  description: s.nullable(s.string({ label: 'תיאור', max: 200 })),
  events: s.arrayOf(s.enumOf(DOMAIN_EVENTS, { label: 'אירוע' }), {
    label: 'אירועים',
    min: 1,
  }),
})

const ENDPOINT_INPUT = s.object({
  endpointId: s.uuid({ label: 'יעד' }),
})

const SUBSCRIPTION_INPUT = s.object({
  endpointId: s.uuid({ label: 'יעד' }),
  events: s.arrayOf(s.enumOf(DOMAIN_EVENTS, { label: 'אירוע' }), {
    label: 'אירועים',
    min: 1,
  }),
})

type RegisterInput = {
  url: string
  description: string | null
  events: readonly string[]
}

export interface WebhookOperations {
  register: Operation<
    RegisterInput,
    null,
    { id: string; url: string; signingSecret: string }
  >
  setSubscription: Operation<
    { endpointId: string; events: readonly string[] },
    WebhookEndpoint,
    { id: string }
  >
  setPaused: Operation<{ endpointId: string }, WebhookEndpoint, { id: string }>
  rotateSecret: Operation<
    { endpointId: string },
    WebhookEndpoint,
    { id: string; signingSecret: string }
  >
}

function refuseUrl(url: string): string {
  const verdict = checkWebhookUrl(url)
  if (verdict.ok) return verdict.url
  throw new BusinessRuleError({
    code: `webhook_url_${verdict.reason}`,
    userMessage: URL_REFUSAL_LABEL[verdict.reason],
  })
}

export function defineWebhookOperations(options: {
  db: Db
  loadEndpoint: (
    organizationId: string,
    id: string,
  ) => Promise<WebhookEndpoint | null>
}): WebhookOperations {
  const loadResource = async ({
    input,
    context,
  }: {
    input: { endpointId: string }
    context: { actor: { organizationId: string } }
  }) => {
    const endpoint = await options.loadEndpoint(
      context.actor.organizationId,
      input.endpointId,
    )
    if (endpoint === null) return null
    return {
      resource: {
        organizationId: endpoint.organizationId,
      },
      entity: endpoint,
      version: endpoint.version,
    }
  }

  const register = defineOperation<
    RegisterInput,
    null,
    { id: string; url: string; signingSecret: string }
  >({
    name: 'webhook.register',
    permission: 'integration.manage',
    resourceType: 'webhook_endpoint',
    input: REGISTER_INPUT,

    async execute({ input, context, tx }) {
      const db = clientFor(tx, options.db)
      const organizationId = context.actor.organizationId

      // Normalised by the checker, not as typed. A check that passes one
      // string and stores a different one has checked nothing.
      const url = refuseUrl(input.url)

      const { data, error } = await db
        .from(ENDPOINTS)
        .insert({
          organization_id: organizationId,
          url,
          description: input.description,
          events: [...input.events],
          status: 'active',
          created_by: context.actor.userId,
          updated_by: context.actor.userId,
        })
        .select('id')
        .single()

      if (error) throw error
      const id = String((data as { id: string }).id)

      const signingSecret = generateSigningSecret()
      const { error: secretError } = await db.from(SECRETS).insert({
        endpoint_id: id,
        organization_id: organizationId,
        signing_secret: signingSecret,
        is_previous: false,
      })
      if (secretError) throw secretError

      return { id, url, signingSecret }
    },

    audit({ input, result }) {
      return {
        resourceId: result.id,
        summary:
          `רשם יעד webhook חדש (${input.events.length} אירועים). ` +
          'סוד החתימה הוצג פעם אחת ואינו ניתן לקריאה חוזרת.',
        after: {
          // The URL as stored — normalised, not as typed — and never the
          // secret. An audit row is read by more people than the screen that
          // created it.
          url: result.url,
          events: input.events.length,
        },
      }
    },
  })

  const setSubscription = defineOperation<
    { endpointId: string; events: readonly string[] },
    WebhookEndpoint,
    { id: string }
  >({
    name: 'webhook.subscribe',
    permission: 'integration.manage',
    resourceType: 'webhook_endpoint',
    input: SUBSCRIPTION_INPUT,
    requiresVersion: true,
    loadResource,

    async execute({ input, entity, context, tx }) {
      const db = clientFor(tx, options.db)
      const { error } = await db
        .from(ENDPOINTS)
        .update({
          events: [...input.events],
          updated_by: context.actor.userId,
        })
        .eq('id', entity.id)
        .eq('organization_id', entity.organizationId)

      if (error) throw error
      return { id: entity.id }
    },

    audit({ entity, input, result }) {
      return {
        resourceId: result.id,
        summary: `עדכן את המנוי של ${entity.url} ל-${input.events.length} אירועים.`,
        before: { events: entity.events.length },
        after: { events: input.events.length },
      }
    },
  })

  /**
   * Pause an active endpoint, or bring back one a person paused.
   *
   * It will NOT re-enable a `disabled` endpoint by accident: that state was
   * reached because the product turned it off, and the reason is recorded.
   * Re-enabling is the same call, but it clears `disabled_reason` explicitly
   * so the next failure starts a fresh streak rather than resuming an old one.
   */
  const setPaused = defineOperation<
    { endpointId: string },
    WebhookEndpoint,
    { id: string }
  >({
    name: 'webhook.set_paused',
    permission: 'integration.manage',
    resourceType: 'webhook_endpoint',
    input: ENDPOINT_INPUT,
    requiresVersion: true,
    loadResource,

    async execute({ entity, context, tx }) {
      const db = clientFor(tx, options.db)
      const next = entity.status === 'active' ? 'paused' : 'active'

      const { error } = await db
        .from(ENDPOINTS)
        .update({
          status: next,
          disabled_reason: null,
          consecutive_failures:
            next === 'active' ? 0 : entity.consecutiveFailures,
          updated_by: context.actor.userId,
        })
        .eq('id', entity.id)
        .eq('organization_id', entity.organizationId)

      if (error) throw error
      return { id: entity.id }
    },

    audit({ entity, result }) {
      const next = entity.status === 'active' ? 'הושהה' : 'הופעל'
      return {
        resourceId: result.id,
        summary: `${next} יעד ה-webhook ${entity.url}.`,
        before: { status: entity.status },
        after: { status: entity.status === 'active' ? 'paused' : 'active' },
      }
    },
  })

  const rotateSecret = defineOperation<
    { endpointId: string },
    WebhookEndpoint,
    { id: string; signingSecret: string }
  >({
    name: 'webhook.rotate_secret',
    permission: 'integration.manage',
    resourceType: 'webhook_endpoint',
    input: ENDPOINT_INPUT,
    requiresVersion: true,
    loadResource,

    async execute({ entity, tx, now }) {
      const db = clientFor(tx, options.db)

      // The old secret becomes `previous` with an expiry rather than being
      // deleted. Both sign every delivery for the grace window, so a receiver
      // that has not deployed the new one keeps verifying — which is the only
      // reason anybody ever rotates.
      const expiresAt = new Date(
        now.getTime() + PREVIOUS_SECRET_GRACE_HOURS * 60 * 60 * 1000,
      )

      const { error: ageError } = await db
        .from(SECRETS)
        .update({ is_previous: true, expires_at: expiresAt.toISOString() })
        .eq('endpoint_id', entity.id)
        .eq('organization_id', entity.organizationId)
        .eq('is_previous', false)

      if (ageError) throw ageError

      const signingSecret = generateSigningSecret()
      const { error } = await db.from(SECRETS).insert({
        endpoint_id: entity.id,
        organization_id: entity.organizationId,
        signing_secret: signingSecret,
        is_previous: false,
      })
      if (error) throw error

      return { id: entity.id, signingSecret }
    },

    audit({ entity, result }) {
      return {
        resourceId: result.id,
        summary:
          `החליף את סוד החתימה של ${entity.url}. ` +
          `הסוד הקודם ימשיך לאמת ${PREVIOUS_SECRET_GRACE_HOURS} שעות.`,
        // No secret, current or previous, in the audit row.
        after: { rotated: true, graceHours: PREVIOUS_SECRET_GRACE_HOURS },
      }
    },
  })

  return { register, setSubscription, setPaused, rotateSecret }
}

/** Raised by the screen when an endpoint id does not resolve. Exported so the
 *  action layer does not construct its own wording. */
export function endpointNotFound(): never {
  throw new NotFoundError('webhook_endpoint')
}
