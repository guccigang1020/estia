/**
 * What the guest sees, and nothing more.
 *
 * The rule this component enforces at the last mile: **one action, and never
 * an action the policy does not require.** It renders `nextGuestAction`'s
 * answer and has no branch of its own that could add a second control — no
 * "or pay by card" beside the bank details, no upload box offered "in case",
 * no greyed-out button explaining what the guest cannot do.
 *
 * EXECUTION CONTEXT — SERVER COMPONENT. The action's live CTA and the upload
 * control are passed in as `payHref` and `uploadSlot`, because a guest portal
 * route owns those and this component must not invent either. Where one is
 * absent, nothing is rendered in its place: a payment link this product cannot
 * mint is a dead button, and a dead button on a payment page is worse than a
 * sentence saying somebody will be in touch.
 */

import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import type { GuestAction } from '@/lib/payments'

export function GuestCollectionPanel({
  action,
  guestInstructions,
  payHref,
  confirmSlot,
  signSlot,
  uploadSlot,
}: {
  action: GuestAction
  /** The organization's own message, above the action. Optional. */
  guestInstructions?: string | null
  /** The hosted page. Only ever used for `pay_live`. */
  payHref?: string | null
  /** The form that records `guest_confirmation`. Owned by the portal route. */
  confirmSlot?: ReactNode
  /** The contract flow. Owned by the portal route. */
  signSlot?: ReactNode
  /** The proof upload control. Owned by the portal route. */
  uploadSlot?: ReactNode
}) {
  return (
    <section
      dir="rtl"
      className="flex w-full flex-col gap-5 rounded-2xl border border-border bg-surface p-6 shadow-soft"
    >
      {guestInstructions !== null && guestInstructions !== undefined && (
        <p className="text-sm text-muted-foreground">{guestInstructions}</p>
      )}

      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold text-foreground">
          {action.title}
        </h2>
        <p className="text-sm text-foreground">{action.body}</p>
      </div>

      {/*
        The live call to action, and only when the organization actually has a
        provider — `liveAvailable` decided that upstream, from a column that
        cannot be true without a provider name. If the route could not mint a
        link, no button is rendered at all.
      */}
      {action.kind === 'pay_live' &&
        action.cta !== null &&
        (payHref ? (
          <Button href={payHref} size="lg" className="self-start">
            {action.cta}
          </Button>
        ) : (
          <p
            role="status"
            className="rounded-lg border border-border bg-muted px-4 py-3 text-sm"
          >
            קישור התשלום בהכנה. רענן את העמוד בעוד רגע, או פנה לבית האירוח.
          </p>
        ))}

      {action.kind === 'confirm_booking' && confirmSlot}
      {action.kind === 'sign_contract' && signSlot}

      {action.kind === 'manual_transfer' && (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {action.channels.map((channel) => (
              <li key={channel.channel} className="flex flex-col gap-1 py-3">
                <span className="text-sm font-semibold text-foreground">
                  {channel.label}
                </span>
                {channel.instructions !== null && (
                  // `whitespace-pre-line`: an IBAN block and a branch number
                  // are written on separate lines and must stay on them.
                  <span className="whitespace-pre-line text-sm text-muted-foreground">
                    {channel.instructions}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {action.offerProofUpload && uploadSlot}
        </>
      )}
    </section>
  )
}
