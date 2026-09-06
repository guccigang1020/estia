/**
 * The port a real WhatsApp, SMS or e-mail client would implement.
 *
 * ══ WHY THERE IS NO REAL PROVIDER IN THIS REPOSITORY ════════════════════════
 *
 * There is no WhatsApp Business account, no SMS gateway and no transactional
 * mail provider behind this product, and there is no credential for one
 * anywhere in the codebase. Half a client behind a missing key is worse than
 * none: it compiles, it looks finished, it is exercised by tests that mock the
 * very thing that does not exist, and the first person to discover it is a
 * guesthouse owner whose guests were never told anything.
 *
 * That decision has been taken here three times already, by three modules,
 * and this is the fourth statement of it rather than a new one:
 * `notifications/transport.ts` for staff channels, `website/ai.ts` for the
 * absent model provider, `channels/null-connector.ts` for the absent OTA
 * connectors. Every one of them declares the SHAPE and ships an implementation
 * that refuses and says why.
 *
 * ══ WHAT `send` MAY AND MAY NOT RETURN ══════════════════════════════════════
 *
 * There is no `delivered`. A provider that accepts a message can tell us it
 * accepted it; nothing in this product can tell us a guest read it. A status
 * this codebase could never honestly produce is one the union does not offer,
 * so nothing can accidentally write it.
 *
 * `not_configured` is not an error and is never thrown. It is the ordinary
 * state of this product, it becomes a row, and the row becomes a number a
 * business can act on: "היינו שולחים 14 הודעות לאורחים ואין ערוץ מחובר".
 *
 * ══ A PROVIDER MAY NEVER BREAK THE THING THAT CAUSED IT ═════════════════════
 *
 * `service/events.ts` states the rule — a failed WhatsApp message must not
 * undo a confirmed booking. `send` must therefore not throw. That is a promise
 * a port cannot enforce, so `operations.ts` wraps every call and turns a throw
 * into a `failed` outcome with the code `provider_threw`. The rule is written
 * here and kept there.
 */

import type { GuestChannel, GuestMessageKind } from './types'

/* -------------------------------------------------------------- messages -- */

/**
 * What a provider is handed.
 *
 * The address IS here, unlike `notifications/transport.ts`, and the difference
 * is not an inconsistency. A staff transport can look a colleague's telephone
 * number up from `user_profiles` because the recipient is a user of this
 * system. A guest is not: the address was read from `guests` under
 * `guest.view_phone` by the caller, and a provider that went back to the
 * database for it would be reading guest contact details with no grant behind
 * the read.
 *
 * What is NOT here is anything that would let a provider decide differently
 * from the operation: no consent flag, no quiet-hours window, no preference.
 * Those are settled before this shape is built. A provider sends or refuses.
 */
export interface OutboundGuestMessage {
  organizationId: string
  /** The row this attempt will be recorded against. */
  messageId: string
  channel: GuestChannel
  kind: GuestMessageKind
  /** The guest's real address. Never logged, never stored unmasked. */
  to: string
  /** Hebrew. `null` for the channels with no subject line. */
  subject: string | null
  /** Hebrew. The composed text, exactly as it will be stored. */
  body: string
  /** Ties this back to the request that caused it. */
  correlationId: string | null
}

/* ---------------------------------------------------------------- result -- */

export type ProviderResult =
  /** Handed to a provider that accepted it. Nothing further is known. */
  | { status: 'sent'; provider: string; providerMessageId: string | null }
  /** The provider refused or errored. `retryable` decides whether to try again. */
  | {
      status: 'failed'
      provider: string
      errorCode: string
      errorDetail: string | null
      retryable: boolean
    }
  /**
   * There is nothing behind this channel.
   *
   * `reason` is English and diagnostic. The Hebrew a person reads comes from
   * `notifications/labels.ts` — a provider's own words must never reach a
   * screen.
   */
  | { status: 'not_configured'; provider: string; reason: string }

/* ------------------------------------------------------------------ port -- */

export interface MessageProvider {
  /** A stable name written onto the row, so history says who was asked. */
  readonly name: string
  readonly channel: GuestChannel
  /**
   * Whether this provider can actually do anything.
   *
   * Read BEFORE `send` by the settings screen, so it can say what is connected
   * without sending anything to find out. Answered from configuration alone; a
   * provider that made a network call to decide would make a settings page
   * depend on a third party being up.
   */
  readonly configured: boolean
  /**
   * Deliver, or say why not.
   *
   * **Must not throw.** See the header.
   */
  send(message: OutboundGuestMessage): Promise<ProviderResult>
}

/* -------------------------------------------------------------- registry -- */

/**
 * Which provider serves which channel.
 *
 * An unregistered channel gets whatever `fallback` returns rather than an
 * error, because "nothing is connected" is the ordinary state of this product
 * and must never be a crash. Unlike `notifications`' registry there is no
 * channel pre-seeded with a working implementation: the in-app channel that
 * product finished has no guest equivalent, because a guest has no inbox here
 * to write into.
 *
 * The fallback is injected rather than imported, so this file declares the
 * port and nothing else and `null-provider.ts` depends on it one way round.
 * `defaultMessageProviderRegistry()` over there is what almost every caller
 * actually constructs.
 */
export class MessageProviderRegistry {
  private readonly providers = new Map<GuestChannel, MessageProvider>()

  constructor(
    providers: readonly MessageProvider[],
    private readonly fallback: (channel: GuestChannel) => MessageProvider,
  ) {
    for (const provider of providers) {
      this.providers.set(provider.channel, provider)
    }
  }

  for(channel: GuestChannel): MessageProvider {
    return this.providers.get(channel) ?? this.fallback(channel)
  }

  /** Which channels can actually deliver. What the settings screen reports. */
  configuredChannels(): readonly GuestChannel[] {
    return [...this.providers.values()]
      .filter((provider) => provider.configured)
      .map((provider) => provider.channel)
  }

  isConfigured(channel: GuestChannel): boolean {
    return this.for(channel).configured
  }
}
