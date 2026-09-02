/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The door, and until when.
 *
 * ── There is no condition in this file guarding a secret ──────────────────
 *
 * The access code is SQL NULL in the payload until `guest_arrival_released`
 * allows it — §9 of migration 0034 — and `guestAccessView` returns null when
 * there is neither a code nor instructions to give. So this component is safe
 * to render unconditionally, and that is the property worth protecting: if
 * somebody deleted the `if (!access) return null` below tomorrow, the page
 * would render an empty card rather than somebody's front door, because the
 * code is not in the object.
 *
 * That is the difference between gating in SQL and gating in a template, and
 * it is why the door code is the one value in this product whose disclosure
 * rule lives in the database.
 *
 * ── The window is the half that used to be missing ────────────────────────
 *
 * A code with no stated validity is a code a guest assumes works until they
 * leave — including at 11:05 on the departure morning, locked out, because the
 * lock rotated at check-out time. `מ-15:00 עד יום ב׳ 11:00` is built by the
 * domain from times the property already configured, and is simply absent when
 * it configured none. Nothing is guessed.
 *
 * ── Why the code is LTR and monospaced ────────────────────────────────────
 *
 * It is typed one character at a time into a keypad, outdoors, often in the
 * dark, often one-handed. Bidirectional reordering of a mixed string like
 * `4417#` loses a character, and a proportional font makes `l1I` and `0O` a
 * guess. The tracking is wide for the same reason.
 */

import type { GuestAccessView } from '@/lib/guest-journey/stay'

export function AccessCard({ access }: { access: GuestAccessView | null }) {
  // Null is the ordinary answer twice over: most properties have no smart
  // lock, and those that do are withheld until the policy allows it. Neither
  // case gets a card, and the guest is never told which of the two it was.
  if (!access) return null

  return (
    <section
      aria-labelledby="access-heading"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4"
    >
      <h2
        id="access-heading"
        className="font-display text-base font-bold text-foreground"
      >
        כניסה לנכס
      </h2>

      {access.code && (
        <div className="flex flex-col gap-1 rounded-xl border-2 border-primary bg-primary-soft px-4 py-4 text-center">
          <span className="text-xs font-medium text-primary">קוד כניסה</span>
          <span
            dir="ltr"
            className="font-mono text-3xl font-bold tracking-widest text-foreground"
          >
            {access.code}
          </span>
          {/* Under the code, where somebody standing at the door will actually
              read it — not in a footnote at the bottom of the page. */}
          {access.validity && (
            <span className="text-xs text-primary">{access.validity}</span>
          )}
        </div>
      )}

      {/* The manual fallback: the key box, meeting the host, ringing on
          arrival. These are the property's own words out of
          `guest_journey_content.access_instructions`, never a list this file
          keeps — a house with a key box under a plant pot and one with a
          neighbour holding the key have nothing in common to templatise. */}
      {access.instructions && (
        <p className="text-sm whitespace-pre-line text-muted-foreground">
          {access.instructions}
        </p>
      )}

      {/* Stated separately only when there is no code to hang it under, so the
          window is never lost on a property that meets its guests in person
          and still has a check-out time that matters. */}
      {access.manualOnly && access.validity && (
        <p className="text-xs text-muted-foreground">{access.validity}</p>
      )}
    </section>
  )
}
