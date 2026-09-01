/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The details the business asked for.
 *
 * ── The route exists only if something is being collected ─────────────────
 *
 * `notFound()` when both field lists are empty. A page that says "no details
 * are required" is a step with nothing in it, reachable by a guest who then
 * wonders what they missed.
 *
 * ── Special requests flow into operations through an event ────────────────
 *
 * The free-text `notes` field lands in `booking_guest_details.fields`, and the
 * preparation module reads it from there. This page deliberately does NOT
 * reach into `src/lib/preparation` to create a plan or a task: that module is
 * owned by another worker this wave, and a screen that writes into somebody
 * else's aggregate is how two modules come to disagree about what a booking
 * needs. The operational half of a guest request goes through `public.tasks`
 * — see the stay screen — which is the canonical engine for exactly that.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { DetailsForm } from '@/components/guest/details-form'
import {
  GUEST_DETAIL_FIELD_LABEL,
  type GuestDetailField,
} from '@/lib/guest-journey'
import { GuestLinkRefusedError } from '@/lib/guest-portal'

import { portalContext } from '../_lib/portal'

export default async function GuestDetailsPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let context
  try {
    context = await portalContext(token)
  } catch (cause) {
    if (cause instanceof GuestLinkRefusedError) notFound()
    throw cause
  }

  const { journey } = context
  const { requiredDetailFields, optionalDetailFields } = journey.settings

  if (requiredDetailFields.length === 0 && optionalDetailFields.length === 0) {
    notFound()
  }

  const submitted = journey.details.submittedAt !== null
  const filled = Object.entries(journey.details.fields).filter(
    ([, value]) => typeof value === 'string' && value.length > 0,
  ) as [GuestDetailField, string][]

  return (
    <main className="flex flex-col gap-5">
      <Link
        href={`/g/${token}`}
        className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        ← חזרה להזמנה
      </Link>

      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-bold text-foreground">
          פרטי האורחים
        </h1>
        <p className="text-sm text-muted-foreground">
          {submitted
            ? 'הפרטים נשמרו. אפשר לעדכן אותם כל עוד לא הגעתם.'
            : 'בית האירוח ביקש את הפרטים הבאים כדי להתכונן לקראתכם.'}
        </p>
      </header>

      {submitted && filled.length > 0 && (
        <dl className="flex flex-col rounded-xl border border-border bg-surface px-4 py-1">
          {filled.map(([field, value]) => (
            <div
              key={field}
              className="flex items-baseline justify-between gap-4 border-b border-border py-2.5 last:border-b-0"
            >
              <dt className="text-sm text-muted-foreground">
                {GUEST_DETAIL_FIELD_LABEL[field]}
              </dt>
              <dd className="text-end text-sm font-medium text-foreground">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <DetailsForm
        token={token}
        required={requiredDetailFields}
        optional={optionalDetailFields}
        initial={journey.details.fields}
      />
    </main>
  )
}
