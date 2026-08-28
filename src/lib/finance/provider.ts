/**
 * The payment provider port.
 *
 * No processor has been chosen. That is not a reason to postpone the model —
 * it is the reason to write it as a port now, while nobody's API is in the
 * room to be leaked into the domain. What follows is a statement of what this
 * product needs from *any* processor, in the product's own vocabulary:
 *
 *   1. **Hand the payer a hosted page.** Card details never touch our server.
 *      The provider owns the form, we own the reference. This is the single
 *      most consequential line in the file: it is what keeps the business out
 *      of PCI scope, and it is why there is no `cardNumber` anywhere here.
 *   2. **Capture** an authorisation, in full or in part.
 *   3. **Refund** a capture, in full or in part.
 *   4. **Void** an authorisation that will never be captured.
 *   5. **Verify a webhook signature**, so an unsigned or badly signed callback
 *      is refused rather than trusted.
 *   6. **List transactions for a window**, which is what makes reconciliation
 *      possible at all. A provider that cannot be asked what it thinks
 *      happened cannot be checked, and an unverifiable ledger is a ledger.
 *
 * ── The rule that shapes every signature ──────────────────────────────────
 *
 * **These methods do not throw for a timeout.** They return
 * `outcome: 'unknown'`. A network call that dies after the request left and
 * before the answer came back has either charged the card or not, and an
 * exception says "it did not" — which is the lie that produces a double
 * charge on the retry. `unknown` is a first-class outcome of the port, it maps
 * onto the frozen `unknown` payment status, and `payments.ts` refuses to
 * collapse it into failure.
 *
 * They still throw for the things that genuinely are exceptions: a malformed
 * request, a refused credential. Those are `ExternalServiceError` with an
 * honest `dataOutcome`.
 *
 * ── What an implementation must guarantee ─────────────────────────────────
 *
 * Every mutating call takes an `idempotencyKey` and the implementation must
 * forward it to the provider. Our own two-phase key protects our database; the
 * provider's key protects the card. Both are required, and neither substitutes
 * for the other.
 */

import { ExternalServiceError } from '../errors'
import { fingerprint } from '../service/idempotency'
import type { Agorot } from '../booking/types'
import type { Currency } from './money'

// ── Results ───────────────────────────────────────────────────────────────

/**
 * What the provider did, as far as anyone can tell.
 *
 * Three values, not two. See the header — the third is the point of the file.
 */
export type ProviderOutcome = 'succeeded' | 'failed' | 'unknown'

/**
 * The provider's own event vocabulary, normalised.
 *
 * Every processor spells these differently (`charge.succeeded`,
 * `TRANSACTION_APPROVED`, `payment_intent.succeeded`). The adapter translates;
 * the domain only ever sees these seven. `chargeback` is here because a
 * chargeback is money leaving without a refund being requested, and a model
 * that cannot represent it will silently show the business as paid.
 */
export const PROVIDER_EVENT_TYPES = [
  'authorized',
  'captured',
  'partially_captured',
  'failed',
  'refunded',
  'partially_refunded',
  'voided',
  'chargeback',
] as const

export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number]

export interface ProviderResult {
  outcome: ProviderOutcome
  /** The provider's identifier. Present even for a failure, when there is one. */
  providerRef: string | null
  /** What the provider says it moved. Zero for a failure. */
  amountAgorot: Agorot
  /** The provider's own status string, kept verbatim for support. */
  providerStatus: string
  failureCode?: string
  /** English, for the log. Never shown to a guest — see `ExternalServiceError`. */
  failureMessage?: string
  occurredAt: Date
}

export interface ProviderTransaction {
  providerRef: string
  capturedAgorot: Agorot
  refundedAgorot: Agorot
  currency: Currency
  providerStatus: string
  occurredAt: Date
}

// ── Requests ──────────────────────────────────────────────────────────────

export interface HostedPageRequest {
  organizationId: string
  /** Our payment id, echoed back on every event about it. */
  paymentId: string
  amountAgorot: Agorot
  currency: Currency
  /** Shown to the payer on the provider's page. Hebrew. */
  description: string
  returnUrl: string
  /** Forwarded to the provider, so a retried page creation is one page. */
  idempotencyKey: string
  /**
   * `authorize_only` reserves without taking — the security-deposit case.
   * A provider that cannot do this cannot serve a business that holds
   * deposits, which is a selection criterion rather than a detail.
   */
  intent: 'immediate_capture' | 'authorize_only'
  metadata?: Readonly<Record<string, string>>
}

export interface HostedPage {
  providerRef: string
  url: string
  expiresAt: Date
}

export interface CaptureRequest {
  providerRef: string
  /** Partial captures are legitimate: a deposit deduction is one. */
  amountAgorot: Agorot
  idempotencyKey: string
}

export interface RefundRequest {
  providerRef: string
  amountAgorot: Agorot
  idempotencyKey: string
  /** English, for the provider's own record. */
  reason: string
}

export interface VoidRequest {
  providerRef: string
  idempotencyKey: string
}

export interface ProviderWebhookEvent {
  /** The provider's id for the delivery. Our duplicate guard keys on this. */
  eventId: string
  providerRef: string
  /** Our payment id, when the provider echoes metadata back. */
  paymentId: string | null
  type: ProviderEventType
  amountAgorot: Agorot
  providerStatus: string
  /**
   * When the provider says it happened — not when we received it.
   *
   * Deliveries arrive out of order routinely; this is the field that makes
   * that detectable, and it must come from the payload rather than from our
   * clock.
   */
  occurredAt: Date
}

export type WebhookVerification =
  | { valid: true; event: ProviderWebhookEvent }
  | { valid: false; reason: 'bad_signature' | 'malformed' | 'unknown_type' }

// ── The port ──────────────────────────────────────────────────────────────

export interface PaymentProvider {
  /** Stable machine name, stored on every payment it touched. */
  readonly id: string
  createHostedPage(request: HostedPageRequest): Promise<HostedPage>
  capture(request: CaptureRequest): Promise<ProviderResult>
  refund(request: RefundRequest): Promise<ProviderResult>
  void(request: VoidRequest): Promise<ProviderResult>
  /** Synchronous by design: it is a signature check, not a network call. */
  verifyWebhook(payload: string, signature: string): WebhookVerification
  listTransactions(window: {
    from: Date
    to: Date
  }): Promise<readonly ProviderTransaction[]>
}

// ── The fake ──────────────────────────────────────────────────────────────

/**
 * How the fake should behave for the next call.
 *
 * `timeout` is the interesting one and the reason the fake exists: it returns
 * `unknown` *and* records the movement internally, exactly like a real
 * processor that charged the card and then failed to tell us. A test that
 * reconciles against it is therefore testing the real hazard, not a stub that
 * politely did nothing.
 */
export type FakeBehaviour = 'succeed' | 'decline' | 'timeout'

interface FakeTransaction {
  providerRef: string
  paymentId: string
  authorizedAgorot: Agorot
  capturedAgorot: Agorot
  refundedAgorot: Agorot
  currency: Currency
  providerStatus: string
  occurredAt: Date
}

/**
 * An in-memory provider, for tests and for a development server.
 *
 * It is a faithful double rather than a stub: it keeps balances, refuses a
 * capture beyond the authorisation and a refund beyond the capture the way a
 * processor does, honours idempotency keys, and can be told to time out. What
 * it is not is secure — `sign` below is a fingerprint of the payload and the
 * secret, which proves the wiring and would not survive an attacker. A real
 * adapter uses HMAC-SHA256 through the platform's crypto, and the shape of
 * `verifyWebhook` is unchanged when it does.
 */
export class InMemoryPaymentProvider implements PaymentProvider {
  readonly id = 'in_memory'

  private readonly transactions = new Map<string, FakeTransaction>()
  private readonly idempotency = new Map<string, ProviderResult>()
  private sequence = 0

  /** What the next mutating call does. Set by a test before acting. */
  behaviour: FakeBehaviour = 'succeed'

  constructor(
    private readonly secret = 'test-secret',
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async createHostedPage(request: HostedPageRequest): Promise<HostedPage> {
    if (request.amountAgorot <= 0) {
      throw new ExternalServiceError({
        service: this.id,
        message: 'Refusing to create a hosted page for a non-positive amount',
        retryable: false,
        dataOutcome: 'not_saved',
      })
    }

    const existing = this.byIdempotency(request.idempotencyKey)
    const providerRef =
      existing?.providerRef ?? this.nextRef(request.idempotencyKey)

    if (!this.transactions.has(providerRef)) {
      this.transactions.set(providerRef, {
        providerRef,
        paymentId: request.paymentId,
        authorizedAgorot:
          request.intent === 'authorize_only' ? request.amountAgorot : 0,
        capturedAgorot: 0,
        refundedAgorot: 0,
        currency: request.currency,
        providerStatus: 'created',
        occurredAt: this.clock(),
      })
      this.idempotency.set(request.idempotencyKey, {
        outcome: 'succeeded',
        providerRef,
        amountAgorot: request.amountAgorot,
        providerStatus: 'created',
        occurredAt: this.clock(),
      })
    }

    return {
      providerRef,
      url: `https://pay.example.test/${providerRef}`,
      expiresAt: new Date(this.clock().getTime() + 30 * 60_000),
    }
  }

  /** Test affordance: the payer completed the hosted page. */
  settleHostedPage(providerRef: string, amountAgorot: Agorot): void {
    const transaction = this.require(providerRef)
    transaction.capturedAgorot += amountAgorot
    transaction.authorizedAgorot = 0
    transaction.providerStatus = 'captured'
    transaction.occurredAt = this.clock()
  }

  /** Test affordance: the card was reserved but not taken. */
  authorizeHostedPage(providerRef: string, amountAgorot: Agorot): void {
    const transaction = this.require(providerRef)
    transaction.authorizedAgorot = amountAgorot
    transaction.providerStatus = 'authorized'
    transaction.occurredAt = this.clock()
  }

  async capture(request: CaptureRequest): Promise<ProviderResult> {
    return this.mutate(request.idempotencyKey, request.providerRef, (t) => {
      if (request.amountAgorot > t.authorizedAgorot + t.capturedAgorot) {
        return this.declined(t, 'capture_exceeds_authorization')
      }
      t.authorizedAgorot = Math.max(
        0,
        t.authorizedAgorot - request.amountAgorot,
      )
      t.capturedAgorot += request.amountAgorot
      t.providerStatus =
        t.authorizedAgorot > 0 ? 'partially_captured' : 'captured'
      return this.succeeded(t, request.amountAgorot)
    })
  }

  async refund(request: RefundRequest): Promise<ProviderResult> {
    return this.mutate(request.idempotencyKey, request.providerRef, (t) => {
      if (request.amountAgorot > t.capturedAgorot - t.refundedAgorot) {
        return this.declined(t, 'refund_exceeds_capture')
      }
      t.refundedAgorot += request.amountAgorot
      t.providerStatus =
        t.refundedAgorot === t.capturedAgorot
          ? 'refunded'
          : 'partially_refunded'
      return this.succeeded(t, request.amountAgorot)
    })
  }

  async void(request: VoidRequest): Promise<ProviderResult> {
    return this.mutate(request.idempotencyKey, request.providerRef, (t) => {
      if (t.capturedAgorot > 0) return this.declined(t, 'already_captured')
      const released = t.authorizedAgorot
      t.authorizedAgorot = 0
      t.providerStatus = 'voided'
      return this.succeeded(t, released)
    })
  }

  verifyWebhook(payload: string, signature: string): WebhookVerification {
    if (signature !== this.sign(payload)) {
      return { valid: false, reason: 'bad_signature' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return { valid: false, reason: 'malformed' }
    }

    const body = parsed as Partial<Record<string, unknown>>
    const type = body.type
    if (
      typeof type !== 'string' ||
      !(PROVIDER_EVENT_TYPES as readonly string[]).includes(type)
    ) {
      return { valid: false, reason: 'unknown_type' }
    }
    if (
      typeof body.eventId !== 'string' ||
      typeof body.providerRef !== 'string' ||
      typeof body.amountAgorot !== 'number' ||
      typeof body.occurredAt !== 'string'
    ) {
      return { valid: false, reason: 'malformed' }
    }

    return {
      valid: true,
      event: {
        eventId: body.eventId,
        providerRef: body.providerRef,
        paymentId: typeof body.paymentId === 'string' ? body.paymentId : null,
        type: type as ProviderEventType,
        amountAgorot: body.amountAgorot,
        providerStatus:
          typeof body.providerStatus === 'string' ? body.providerStatus : type,
        occurredAt: new Date(body.occurredAt),
      },
    }
  }

  /** The signature a caller would receive on a delivery. Tests sign with this. */
  sign(payload: string): string {
    return fingerprint(`${this.secret}:${payload}`)
  }

  async listTransactions(window: {
    from: Date
    to: Date
  }): Promise<readonly ProviderTransaction[]> {
    return [...this.transactions.values()]
      .filter((t) => t.occurredAt >= window.from && t.occurredAt < window.to)
      .map((t) => ({
        providerRef: t.providerRef,
        capturedAgorot: t.capturedAgorot,
        refundedAgorot: t.refundedAgorot,
        currency: t.currency,
        providerStatus: t.providerStatus,
        occurredAt: t.occurredAt,
      }))
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private nextRef(seed: string): string {
    this.sequence += 1
    return `ref_${this.sequence}_${fingerprint(seed).slice(0, 8)}`
  }

  private byIdempotency(key: string): ProviderResult | undefined {
    return this.idempotency.get(key)
  }

  private require(providerRef: string): FakeTransaction {
    const transaction = this.transactions.get(providerRef)
    if (!transaction) {
      throw new ExternalServiceError({
        service: this.id,
        message: `Unknown provider reference ${providerRef}`,
        retryable: false,
        dataOutcome: 'not_saved',
      })
    }
    return transaction
  }

  /**
   * Run a mutation under the provider's own idempotency key.
   *
   * A `timeout` still performs the movement and then reports `unknown`. That
   * asymmetry is the whole hazard being modelled: the money moved and nobody
   * upstream knows it.
   */
  private async mutate(
    idempotencyKey: string,
    providerRef: string,
    change: (transaction: FakeTransaction) => ProviderResult,
  ): Promise<ProviderResult> {
    const replay = this.byIdempotency(idempotencyKey)
    if (replay) return replay

    const transaction = this.require(providerRef)

    if (this.behaviour === 'decline') {
      return this.declined(transaction, 'declined_by_issuer')
    }

    const result = change(transaction)

    if (this.behaviour === 'timeout') {
      // Deliberately not stored against the key: a provider that never
      // answered never told us the key was consumed either.
      return {
        outcome: 'unknown',
        providerRef,
        amountAgorot: result.amountAgorot,
        providerStatus: 'timeout',
        failureCode: 'gateway_timeout',
        failureMessage: 'The provider did not answer within the timeout',
        occurredAt: this.clock(),
      }
    }

    this.idempotency.set(idempotencyKey, result)
    return result
  }

  private succeeded(
    transaction: FakeTransaction,
    amountAgorot: Agorot,
  ): ProviderResult {
    return {
      outcome: 'succeeded',
      providerRef: transaction.providerRef,
      amountAgorot,
      providerStatus: transaction.providerStatus,
      occurredAt: this.clock(),
    }
  }

  private declined(transaction: FakeTransaction, code: string): ProviderResult {
    return {
      outcome: 'failed',
      providerRef: transaction.providerRef,
      amountAgorot: 0,
      providerStatus: 'declined',
      failureCode: code,
      failureMessage: `Provider declined: ${code}`,
      occurredAt: this.clock(),
    }
  }
}
