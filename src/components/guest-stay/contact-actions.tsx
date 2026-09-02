/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Reaching the business.
 *
 * Three of the four states end here: a hold that lapsed, a cancelled booking,
 * and any screen where the honest answer is that a person has to look at it.
 * So the control exists once rather than in each of them.
 *
 * ── A number this component invented would be worse than no number ────────
 *
 * `guest_portal_journey` projects no telephone and no address for the
 * business. There is `stay.emergencyContact`, which is free text for a guest
 * standing in a flooded bathroom at two in the morning and is not the office —
 * and it is withheld outside the stay anyway. So the details are a prop, and
 * with none supplied this renders a sentence and no button.
 *
 * That is deliberately unattractive. A screen that says "פנה לבית האירוח" with
 * nothing to press is a visible gap, and a visible gap gets a telephone number
 * configured. A `tel:` link built from a guess gets somebody a wrong number at
 * eleven at night and nobody ever finds out why.
 *
 * ── One primary, and the second is a link ─────────────────────────────────
 *
 * With both a telephone and an address, the call is the button and the mail is
 * a text link underneath. Two buttons of equal weight is the menu this product
 * does not put in front of a guest.
 */

import { Button } from '@/components/ui/button'

export type GuestContact = {
  /** As dialled. `tel:` is built from this with the spaces removed. */
  phone?: string | null
  email?: string | null
  /** What to call them, for the accessible name. */
  name?: string | null
}

export function ContactActions({
  contact,
  label,
}: {
  contact?: GuestContact
  label: string
}) {
  const phone = contact?.phone?.trim() || null
  const email = contact?.email?.trim() || null
  const who = contact?.name?.trim() || 'בית האירוח'

  if (phone === null && email === null) {
    return (
      <p className="rounded-lg border border-border bg-surface px-3 py-3 text-center text-sm text-muted-foreground">
        פנה לבית האירוח בערוץ שבו קיבלת את הקישור — שם יידעו לענות.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {phone !== null ? (
        <Button
          href={`tel:${phone.replace(/[\s-]/g, '')}`}
          size="lg"
          className="w-full"
          aria-label={`${label} — ${who}, ${phone}`}
        >
          {label}
        </Button>
      ) : (
        <Button
          href={`mailto:${email}`}
          size="lg"
          className="w-full"
          aria-label={`${label} — ${who}, ${email}`}
        >
          {label}
        </Button>
      )}

      {phone !== null && email !== null && (
        <a
          href={`mailto:${email}`}
          className="text-center text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {`שליחת דוא״ל ל${who}`}
        </a>
      )}
    </div>
  )
}
