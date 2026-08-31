import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import {
  NewQuoteForm,
  type QuotableUnitOption,
} from '@/components/distribution/new-quote-form'
import { PlanLock } from '@/components/distribution/plan-lock'
import { can } from '@/lib/authz/can'
import { inventoryResource } from '@/lib/agents'
import { toSafeResponse } from '@/lib/errors'
import { asNumber, toRows } from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireDistributionGrant } from '../../agents/_lib/gate'
import { loadCalendarUnits } from '../../calendar/_lib/inventory'

export const metadata: Metadata = { title: 'הצעת מחיר חדשה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The `new-quote` quick-create.
 *
 * WHAT IT CREATES. A price, and — for somebody holding `hold.create` — a hold
 * on the dates. Not a document: there is no `quotes` table, and the form is
 * labelled for what it actually does rather than for what a route called
 * `/quotes/new` might suggest.
 *
 * THE UNIT LIST IS THE AGENT'S REACH, NOT THE BUSINESS'S INVENTORY.
 * `loadCalendarUnits` asks `can()` per unit with `family: 'inventory'`, which is
 * what makes the per-family override apply — an external seller's default scope
 * is `own_records` and a unit belongs to nobody in particular, so without the
 * family every unit would be refused. A property that was never assigned to this
 * seller simply is not in the list, and they are not told it exists: to them it
 * does not, which is `assertAgentReach`'s `NotFoundError` reasoning applied to a
 * dropdown.
 *
 * The list is then narrowed again by `quote.create`. Seeing free/busy and being
 * able to quote are two rungs on the same ladder, and a unit a seller may look
 * at but not price has no business being an option on a pricing form.
 *
 * THE HOLD DURATION COMES FROM THE AGENT'S OWN LIMITS. Read from
 * `agent_organization_settings.hold_default_minutes` for the signed-in person
 * when they have terms, and left absent for a staff member who has none — the
 * domain's `holdPolicyFor` then chooses, which is the right default and is not
 * a number this screen is entitled to invent.
 */
export default async function NewQuotePage() {
  const [access, context] = await Promise.all([
    requireDistributionGrant('quote.create'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="הוצאת הצעות מחיר אינה כלולה בחבילה שלך"
        body="הצעת מחיר מחשבת את המחיר מהתעריפים של היחידה ותופסת את התאריכים בזמן שהלקוח מחליט."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access

  let units: QuotableUnitOption[] = []
  let mayHold = false
  let defaultHoldMinutes: number | null = null
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()

    const calendarUnits = await loadCalendarUnits({
      db,
      actor,
      organizationId: actor.organizationId,
      selectedPropertyId: context.selectedPropertyId,
    })

    const quotable = calendarUnits.filter(
      (unit) =>
        unit.status === 'active' &&
        can(
          actor,
          'quote.create',
          inventoryResource({
            organizationId: actor.organizationId,
            propertyId: unit.propertyId,
            unitId: unit.id,
          }),
        ),
    )

    units = quotable.map((unit) => ({
      id: unit.id,
      label: `${unit.code} · ${unit.name}`,
      propertyName: unit.propertyName,
      maxGuests: unit.maxGuests,
    }))

    // `hold.create` is asked once, against the first unit this person may
    // quote. Asking per unit would be more precise and would produce a form
    // whose hold checkbox appears and disappears as the dropdown changes,
    // which reads as a bug — and the action re-asks per unit anyway, which is
    // the check that counts.
    mayHold =
      quotable.length > 0 &&
      can(
        actor,
        'hold.create',
        inventoryResource({
          organizationId: actor.organizationId,
          propertyId: quotable[0].propertyId,
          unitId: quotable[0].id,
        }),
      )

    defaultHoldMinutes = await holdDefaultFor(
      db,
      actor.organizationId,
      actor.userId,
    )
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/quotes"
          className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← להצעות המחיר
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          הצעת מחיר חדשה
        </h1>
        <p className="text-muted-foreground">
          המחיר מחושב מהתעריפים של היחידה עצמה — לא ממה שנשלח מהדפדפן — ומוצג
          שורה־שורה, כדי שתוכל לענות ללקוח למה זה הסכום הזה.
        </p>
      </header>

      {failure ? (
        <ActionError error={failure.error} />
      ) : (
        <NewQuoteForm
          units={units}
          mayHold={mayHold}
          defaultHoldMinutes={defaultHoldMinutes}
        />
      )}
    </div>
  )
}

/**
 * This person's own default hold duration, when they are an agent.
 *
 * `null` for a staff member with no agent terms, which is not a gap: the domain
 * has a default for every hold reason and `planHold` applies it. Substituting a
 * number here would be this screen deciding a policy that belongs to
 * `holds.ts`.
 */
async function holdDefaultFor(
  db: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  userId: string,
): Promise<number | null> {
  const { data, error } = await db
    .from('agent_organization_settings')
    .select('hold_default_minutes')
    .eq('organization_id', organizationId)
    .eq('agent_user_id', userId)
    .limit(1)

  // A read failure here is not worth failing the form over: the field is a
  // convenience, the domain still clamps whatever is submitted, and an agent
  // who cannot open the quote screen because their preference could not be
  // read is a worse outcome than one whose box starts empty.
  if (error) return null

  const rows = toRows(data)
  if (rows.length === 0) return null

  const value = rows[0]['hold_default_minutes']
  if (value === null || value === undefined) return null

  // Read through the mapper rather than cast: this is the one number the form
  // pre-fills, and `NaN` in a `type="number"` field is a control that silently
  // refuses to submit.
  return asNumber(rows[0], 'hold_default_minutes')
}
