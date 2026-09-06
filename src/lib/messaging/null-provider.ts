/**
 * The implementation this codebase ships for every guest channel.
 *
 * It refuses. It does not throw, it does not retry, it does not pretend to be
 * slow, and it names itself `none` so that a `guest_messages` row written today
 * is distinguishable from one written after somebody wires a real provider.
 *
 * ══ SUCCESS IS THE ONE ANSWER IT MUST NEVER GIVE ════════════════════════════
 *
 * A row saying `sent` for a message that does not exist would put a false
 * reassurance in the one table a business consults to find out what its guests
 * were not told. Worse than a missing feature is a feature that reports itself
 * working — the owner stops checking, and the first evidence is a guest
 * standing outside a locked door.
 *
 * ══ THE ABSENCE IS A STATE, AND IT IS THE ARGUMENT ══════════════════════════
 *
 * Every refusal becomes a row with `outcome = 'not_configured'`, and the count
 * of those rows is the strongest case for connecting a channel that this
 * product can make: a business cannot act on an integration it does not know
 * it is missing. `notifications/labels.ts` already writes that sentence in
 * Hebrew — `unsentSummary` — and it is reused rather than rewritten.
 *
 * ══ WHY THE MESSAGE IS STILL COMPOSED AND STILL STORED ══════════════════════
 *
 * Because the text is useful with no provider at all. `guest-journey/link.ts`
 * settled this argument for the guest link and it holds here: most guesthouses
 * in this market have WhatsApp open on the same telephone, and a composed
 * Hebrew message they can copy is a complete answer where a greyed-out button
 * is not. This module's job is to make sure the message EXISTS and that the
 * record never claims it was sent.
 */

import type { GuestChannel } from './types'
import {
  MessageProviderRegistry,
  type MessageProvider,
  type ProviderResult,
} from './provider'

/** The name written onto every row nothing sent. */
export const NULL_PROVIDER_NAME = 'none'

/**
 * English, diagnostic, per channel.
 *
 * Per channel rather than one shared sentence because the three gaps are three
 * different purchases — a WhatsApp Business number, an SMS gateway and a
 * transactional mail domain — and whoever reads this column is deciding which
 * one to make.
 */
const REASON: Record<GuestChannel, string> = {
  whatsapp: 'no WhatsApp Business provider is configured for this deployment',
  sms: 'no SMS gateway is configured for this deployment',
  email: 'no transactional email provider is configured for this deployment',
}

export class NullMessageProvider implements MessageProvider {
  readonly name = NULL_PROVIDER_NAME
  readonly configured = false

  constructor(readonly channel: GuestChannel) {}

  /**
   * Note what is absent: no logging, no counter, no side effect at all.
   *
   * The message carries a guest's real address and a portal URL. A console
   * line holding either outlives the stay and is readable by anybody with the
   * log — and the record this refusal produces is written by the operation,
   * with the address masked, which is the only place either belongs.
   */
  async send(): Promise<ProviderResult> {
    return {
      status: 'not_configured',
      provider: this.name,
      reason: REASON[this.channel],
    }
  }
}

export function nullProviderFor(channel: GuestChannel): MessageProvider {
  return new NullMessageProvider(channel)
}

/**
 * The registry this product ships with.
 *
 * Empty, so every channel falls through to the null provider. Written as a
 * function rather than a constant so that a deployment which one day has
 * credentials constructs its own rather than mutating a shared object — a
 * registry that can be added to at runtime is a registry whose contents depend
 * on import order.
 */
export function defaultMessageProviderRegistry(
  providers: readonly MessageProvider[] = [],
): MessageProviderRegistry {
  return new MessageProviderRegistry(providers, nullProviderFor)
}
