/**
 * The webhooks module, in one import.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ═══════════════════════════════════════════
 *
 * `signature.ts` and `sender.ts`. Both import `node:crypto` or open sockets,
 * and this barrel must stay safe for a Client Component to import — the
 * settings screen needs `URL_REFUSAL_LABEL` and `checkWebhookUrl` to validate
 * beside the input field as somebody types, and pulling the signer in behind
 * them would drag the signing secret's whole neighbourhood into a browser
 * bundle. `scripts/client-bundle.mjs` enforces this; the argument is the same
 * one `fiscal/index.ts` makes about keeping its read side out.
 *
 * Import those two by path, from server code only.
 *
 * ══ AND THE EVENT NAMES ═════════════════════════════════════════════════════
 *
 * `DomainEventName` is not re-exported. It belongs to `contracts/events.ts`,
 * and a second import path for a frozen contract is how two modules come to
 * believe they are reading different catalogues — which `service/events.ts`
 * records actually happening, at a cost of fifteen events nobody could hear.
 */

export {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_DISABLE_REASONS,
  WEBHOOK_ENDPOINT_STATUSES,
  type AttemptOutcome,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookDisableReason,
  type WebhookEndpoint,
  type WebhookEndpointStatus,
} from './types'

export {
  MAX_URL_LENGTH,
  URL_REFUSAL_CODES,
  checkWebhookUrl,
  isBlockedAddress,
  type UrlRefusalCode,
  type UrlVerdict,
} from './url-safety'

export {
  FAILURES_BEFORE_DISABLE,
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_SECONDS,
  decideAfterAttempt,
  isRetryable,
  isSuccess,
  shouldDisableAfterFailures,
  type RetryDecision,
} from './retry'

export {
  buildEnvelope,
  endpointsFor,
  matches,
  serialiseEnvelope,
  type WebhookEnvelope,
} from './subscription'

export {
  URL_REFUSAL_LABEL,
  WEBHOOK_DELIVERY_STATUS_LABEL,
  WEBHOOK_DISABLE_REASON_LABEL,
  WEBHOOK_ENDPOINT_STATUS_LABEL,
} from './labels'
