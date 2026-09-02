/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The guest's first screen.
 *
 * ── What a guest gets, in order ───────────────────────────────────────────
 *
 *   1. Their own stay, so they can recognise it.
 *   2. If the booking moved since they agreed — the delta, before anything
 *      else asks them for something.
 *   3. ONE dominant action.
 *   4. The progress list, showing only steps this business actually requires.
 *   5. Quiet links to the rest.
 *
 * ── Who decides what the dominant action is ───────────────────────────────
 *
 * Not this file. `buildJourneyView` composes two authorities — the payment
 * collection module for what is REQUIRED, the journey settings for what the
 * portal can OFFER — and returns one answer. Where that answer is `collection`,
 * this page renders `GuestCollectionPanel` and plugs its own controls into the
 * panel's slots, rather than drawing a second button beside it. Two components
 * each deciding what to ask for is how a guest sees "אשר הזמנה" above
 * "שלם ₪2,000" and cannot tell which one the business wants first.
 *
 * ── What a guest must never see, and why it is not this file's job ────────
 *
 * No margin, no owner payout, no agent commission, no operating cost, no
 * internal note, no other booking, no other organization. This page could not
 * render any of them: `guest_portal_session` and `guest_portal_journey` are
 * hand-picked projections and none of those columns is in either. The safety
 * comes from there being nothing to leak, not from this file remembering.
 *
 * The one rule this file DOES have to keep is the one written at the top of
 * `journey.ts`: never a second query. A `from('bookings')` written here to
 * "just fetch the property" would walk straight around the projection.
 */

import { notFound } from 'next/navigation'

import { CheckoutDeclare } from '@/components/guest/checkout-declare'
import { ConfirmButton } from '@/components/guest/confirm-button'
import { JourneyProgress } from '@/components/guest/journey-progress'
import {
  NextActionCard,
  SecondaryLinks,
} from '@/components/guest/next-action-card'
import { ReconfirmNotice } from '@/components/guest/reconfirm-notice'
import { StaySummary } from '@/components/guest/stay-summary'
import { GuestCollectionPanel } from '@/components/payments/guest-collection-panel'
import { CancelledPanel } from '@/components/guest-stay/cancelled-panel'
import { HoldCountdown } from '@/components/guest-stay/hold-countdown'
import { HoldPanel } from '@/components/guest-stay/hold-panel'
import { PostStayPanel } from '@/components/guest-stay/post-stay-panel'
import { buildJourneyView } from '@/lib/guest-journey'
import { buildPostStayView } from '@/lib/guest-journey/post-stay'
import {
  UNDATED_GUEST_HOLD,
  cancelledPortalView,
  guestHoldView,
  guestPortalPhase,
  redactCancelledJourney,
  type GuestHold,
} from '@/lib/guest-journey/stay'
import { GuestLinkRefusedError } from '@/lib/guest-portal'

import { portalContext } from './_lib/portal'

export default async function GuestPortalPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let context
  try {
    context = await portalContext(token)
  } catch (cause) {
    // The layout already resolved this token and rendered its own refusal for
    // a bad one, so reaching here means the link went bad between the layout
    // and this segment — a revocation landing mid-request. `notFound()` rather
    // than a second copy of the refusal card: one place owns that wording.
    if (cause instanceof GuestLinkRefusedError) notFound()
    throw cause
  }

  const { session, journey, collection } = context
  const now = new Date()

  /**
   * The portal has five shapes, and only one of them is the booking-in-progress
   * screen below.
   *
   * Branching here rather than inside the sections is the whole point. A
   * cancelled stay that fell through to the ordinary render would show an
   * arrival link, a store and a confirm button for a booking that is not
   * happening — and `redactCancelledJourney` strips the address and the door
   * code from the data, but nothing would strip a call to action from the
   * layout. So `cancelled` returns its own panel and never reaches the rest of
   * this function.
   *
   * The ordering inside `guestPortalPhase` is load-bearing and is asserted in
   * `stay.test.ts`: an early departure — checked out on the third night of
   * five, so the calendar still says the stay is live — resolves to post-stay,
   * which is what keeps the wifi password off a house they have left.
   */
  const phase = guestPortalPhase(journey, now)

  if (phase === 'cancelled') {
    return (
      <CancelledPanel
        token={token}
        view={cancelledPortalView(redactCancelledJourney(journey))}
      />
    )
  }

  if (phase === 'hold') {
    // `releasedAt` and `convertedToBookingId` are permanently null and that is
    // correct rather than merely tolerated: a hold that was given back or
    // turned into a booking has a different `bookings.status`, and the phase
    // above resolves those before this branch runs. The expiry is the only one
    // of the three the projection has to carry.
    const hold: GuestHold = {
      ...UNDATED_GUEST_HOLD,
      expiresAt: journey.current.holdExpiresAt ?? null,
    }
    const view = guestHoldView(journey, hold, now)

    return (
      <HoldPanel
        token={token}
        view={view}
        bookingVersion={journey.current.bookingVersion}
      >
        {view.expiresAt !== null ? (
          <HoldCountdown
            expiresAt={view.expiresAt}
            initialRemainingMs={view.remainingMs ?? 0}
          />
        ) : null}
      </HoldPanel>
    )
  }

  if (phase === 'post_stay') {
    return <PostStayPanel view={buildPostStayView(journey)} />
  }

  const view = buildJourneyView(journey, collection)

  const confirmControl = (
    <ConfirmButton
      token={token}
      bookingVersion={journey.current.bookingVersion}
      reconfirm={view.reconfirmation.required}
      label={view.reconfirmation.required ? 'אישור מחדש' : 'אישור ההזמנה'}
    />
  )

  // Only links that lead somewhere the guest can actually use. A link to the
  // arrival page while the address is still withheld would waste a tap and
  // teach them the portal is unreliable.
  const links: { path: string; label: string }[] = []
  if (journey.contract.signature !== null) {
    links.push({ path: 'contract', label: 'החוזה שנחתם' })
  }
  if (journey.arrival.released && view.next.id !== 'arrival') {
    links.push({ path: 'arrival', label: 'פרטי הגעה' })
  }
  if (journey.current.inStay && view.next.id !== 'stay') {
    links.push({ path: 'stay', label: 'המדריך לשהות' })
  }
  if (journey.details.submittedAt !== null) {
    links.push({ path: 'details', label: 'הפרטים שמילאת' })
  }

  return (
    <main className="flex flex-col gap-6">
      <StaySummary
        session={session}
        arrivalTime={journey.arrival.checkInTime}
        checkOutTime={journey.checkout.checkOutTime}
      />

      {/* Before anything asks them for something. A guest told "confirm" above
          a price they never agreed to has been misled by layout alone. */}
      <ReconfirmNotice verdict={view.reconfirmation}>
        {confirmControl}
      </ReconfirmNotice>

      {/* The one dominant action. Exactly one of these three renders. */}
      {view.next.id === 'collection' ? (
        <GuestCollectionPanel
          action={collection.action}
          guestInstructions={collection.guestInstructions}
          // No payment link is minted anywhere in this product yet, and the
          // panel renders an honest sentence in place of a dead button when
          // this is absent. Passing a fabricated URL would be worse.
          payHref={null}
          confirmSlot={confirmControl}
          signSlot={
            <SecondaryLinks
              token={token}
              links={[{ path: 'contract', label: 'קריאה וחתימה על החוזה' }]}
            />
          }
          uploadSlot={
            // There is no file storage in this codebase — no bucket, no
            // `supabase.storage`. A file input that cannot upload is worse
            // than a sentence saying how to send the receipt instead.
            collection.proofUploadUnavailable ? (
              <p className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                שליחת אסמכתה דרך הקישור אינה זמינה עדיין. שלח את האישור ישירות
                לבית האירוח בוואטסאפ או בדוא״ל, ונעדכן את ההזמנה.
              </p>
            ) : null
          }
        />
      ) : view.reconfirmation.required ? null : view.next.id === 'confirm' ? (
        // The journey wants a confirmation the collection policy never asked
        // for — a business that takes no money in advance but still wants the
        // guest to agree. The card carries the control itself rather than
        // linking somewhere, because this page IS where confirming happens.
        <section
          aria-labelledby="next-action-heading"
          className="flex flex-col gap-3 rounded-2xl border-2 border-primary bg-surface-raised px-4 py-5 shadow-lift sm:px-5"
        >
          <h2
            id="next-action-heading"
            className="font-display text-lg font-bold text-foreground"
          >
            {view.next.label}
          </h2>
          <p className="text-sm text-muted-foreground">
            {view.next.description}
          </p>
          {confirmControl}
        </section>
      ) : (
        <NextActionCard action={view.next} token={token} />
      )}

      <JourneyProgress steps={view.steps} />

      {/* Leaving. Offered only while it means something — during the stay and
          just after it, never three weeks before arrival. */}
      {journey.checkout.enabled &&
        (journey.current.inStay ||
          journey.current.status === 'checkout_pending') && (
          <CheckoutDeclare
            token={token}
            declaredAt={journey.checkout.declaredAt}
          />
        )}

      <SecondaryLinks token={token} links={links} />

      <footer className="pt-2 text-center text-xs text-muted-foreground">
        <p>{session.organizationName}</p>
        <p className="mt-1">
          לשאלות, פנה ישירות לבית האירוח. הקישור הזה אישי להזמנה שלך.
        </p>
      </footer>
    </main>
  )
}
