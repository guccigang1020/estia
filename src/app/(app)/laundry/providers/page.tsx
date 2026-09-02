import type { Metadata } from 'next'

import { LaundrySectionNav } from '@/components/laundry/section-nav'
import { LaundryShell } from '@/components/laundry/shell'
import { LaundryDatasetGap, LaundryPlanLock } from '@/components/laundry/states'
import { Badge } from '@/components/ui/badge'

import { CHANNEL_LABEL, weekdays } from '../_lib/labels'
import { loadProviders } from '../_lib/queries'
import { laundryView } from '../_lib/view'

export const metadata: Metadata = { title: 'ספקי כביסה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The outside companies.
 *
 * ══ THE ONE SCREEN THAT `laundry.view` DOES NOT OPEN ═════════════════════
 *
 * Gated on `laundry.provider_manage` rather than `laundry.view`, and that is
 * the only asymmetric gate in the section. A provider row carries a supplier's
 * name, a named contact, a telephone number and the terms of a commercial
 * relationship.
 *
 * The person this refuses is the housekeeping supervisor. 0035 gives them
 * `laundry.view`, `laundry.manage` and `laundry.order_create` — they see what
 * must be clean by Friday and they raise the run for it — and withholds
 * `laundry.order_send` and `laundry.provider_manage`. Raising a wash and
 * choosing who the business deals with are different acts. A cleaner holds none
 * of the five and is refused the whole section a step earlier.
 *
 * The refusal is triple, and each layer catches what the others cannot:
 *
 *   1. this gate, which redirects with `?denied=` before anything is read
 *   2. `loadProviders`, which returns `null` rather than `[]` for anybody
 *      without the grant — so a card elsewhere omits the provider row rather
 *      than printing a placeholder
 *   3. `laundry_providers_select` in `0029_laundry.sql`, which returns them no
 *      rows at all against a real database
 *
 * The third is the only one that holds against a hand-written query, and the
 * first two are the only ones that hold in the demo, which has no row level
 * security. Neither is redundant.
 *
 * ── No prices on this screen ──────────────────────────────────────────────
 *
 * `laundry_providers.price_list` exists and is deliberately not read here.
 * Comparing two providers on price is a real need and it belongs on a screen
 * built for that comparison, with the volume beside it; a price list rendered
 * as a column of numbers with no quantities against it is the kind of figure
 * somebody quotes in a negotiation and then cannot support.
 */
export default async function LaundryProvidersPage() {
  const view = await laundryView('laundry.provider_manage', 'providers')
  if (!view) return null

  const { vocabulary } = view
  const mode = view.context.settings.settings.mode

  if (view.locked) {
    return (
      <LaundryShell heading="ספקי כביסה" tagline={vocabulary.tagline}>
        <LaundryPlanLock
          entitlement={view.entitlement}
          mayReachBilling={view.mayReachBilling}
        />
      </LaundryShell>
    )
  }

  const { providers, gap } = await loadProviders(view.repo, view.actor)

  if (gap !== null) {
    return (
      <LaundryShell heading="ספקי כביסה" tagline={vocabulary.tagline}>
        <LaundryDatasetGap table={gap.table} detail={gap.detail} />
      </LaundryShell>
    )
  }

  // `null` here would mean the gate admitted somebody the query then refused,
  // which is a contradiction rather than an empty state — so it is reported
  // instead of rendered as "no providers".
  if (providers === null) {
    return (
      <LaundryShell heading="ספקי כביסה" tagline={vocabulary.tagline}>
        <p
          role="alert"
          className="rounded-xl border border-danger/40 bg-surface px-5 py-6 text-sm text-foreground"
        >
          המסך נפתח אך רשימת הספקים סורבה. זהו מצב שאינו אמור לקרות, ולכן הוא
          מדווח ולא מוצג כרשימה ריקה.
        </p>
      </LaundryShell>
    )
  }

  return (
    <LaundryShell heading="ספקי כביסה" tagline={vocabulary.tagline}>
      <LaundrySectionNav mode={mode} current="providers" />

      {providers.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface px-5 py-10 text-center text-sm text-muted-foreground">
          לא הוגדרו ספקים. ניתן לעבוד גם בלי — הזמנה בלי ספק היא מחזור כביסה
          פנימי.
        </p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-soft"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="font-display text-base font-bold text-foreground">
                  {provider.name}
                </h2>
                <Badge tone={provider.isActive ? 'brand' : 'neutral'}>
                  {provider.isActive ? 'פעיל' : 'לא פעיל'}
                </Badge>
              </div>

              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <Pair label="איש קשר" value={provider.contactName} />
                <Pair label="טלפון" value={provider.phone} />
                <Pair label="דוא״ל" value={provider.email} />
                <Pair
                  label="ערוץ ברירת מחדל"
                  value={CHANNEL_LABEL[provider.defaultChannel]}
                />
                <Pair
                  label="זמן טיפול"
                  value={`${provider.turnaroundHours} שעות`}
                />
                <Pair label="ימי איסוף" value={weekdays(provider.pickupDays)} />
                <Pair
                  label="ימי החזרה"
                  value={weekdays(provider.deliveryDays)}
                />
                <Pair
                  label="מינימום להזמנה"
                  value={
                    provider.minimumOrderUnits === 0
                      ? 'אין מינימום'
                      : `${provider.minimumOrderUnits} יחידות`
                  }
                />
              </dl>

              {provider.notes !== null && (
                <p className="rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
                  {provider.notes}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </LaundryShell>
  )
}

/**
 * A labelled fact, or an honest blank.
 *
 * `null` renders "לא הוזן" rather than an empty cell, because an empty cell in
 * a contact list reads as a rendering fault and sends somebody to look for the
 * number somewhere else.
 */
function Pair({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">{value ?? 'לא הוזן'}</dd>
    </div>
  )
}
