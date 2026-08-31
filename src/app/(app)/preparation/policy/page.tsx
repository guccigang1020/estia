import type { Metadata } from 'next'

import Link from 'next/link'

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { PolicyEditor } from '@/components/preparation/policy-editor'
import { EmptyState } from '@/components/states/empty-state'
import { can } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import type { PreparationCatalogue } from '@/lib/preparation'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  draftFromCatalogue,
  emptyDraft,
  hasUnrenderableCondition,
} from '../_lib/policy'
import { preparationWiring } from '../_lib/wiring'

export const metadata: Metadata = { title: 'מדיניות ההכנה' }

/** The query key that names the property being configured. */
const PROPERTY_PARAM = 'property'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Where the cleaner's numbers come from.
 *
 * WHAT WAS MISSING. `PropertyConfiguration` and `PreparationRule` — the beds,
 * their sleeping capacity, the linen each bed takes, and every quantity rule
 * that turns a party into towels and pillows — are read faithfully by the
 * engine and were referenced by no screen at all. `preparation_catalogues`
 * existed in 0021 and nothing had ever written a row into it. Since
 * `no-hardcoded-numbers.test.ts` proves the engine never invents a quantity,
 * that meant a business could not produce one, and the board next door could
 * only ever say "no plan has been built". This route is the missing half.
 *
 * GATING, AND WHY IT IS NOT THE BOARD'S GRANT. `/preparation` is
 * `task.view` — the grant a cleaner holds, and the whole point of that screen
 * is that she reaches her morning. This one is `requireGrant('checklist.manage')`,
 * which the cleaner preset deliberately does not carry: changing the rule that
 * says every bed needs fresh linen is a different act from ticking that the
 * linen is on. The same separation is in the database —
 * `preparation_catalogues_update` demands `checklist.manage` — and again in
 * `savePolicyAction`, which asserts it before reading anything, because a
 * Server Action is a POST reachable without the screen that rendered the form.
 *
 * THE PROPERTY IS CHOSEN, NEVER GUESSED. A catalogue is per property, and
 * picking "the first one" for somebody who holds four would let them edit a
 * house they did not mean to open — the charter's human-error rule, and the
 * expensive kind of mistake because nobody notices until a guest arrives. So a
 * reader with more than one property in scope gets a picker, and every entry in
 * it is checked with `can()` against that property before it is rendered as a
 * link. An item that would redirect on arrival is worse than no item.
 *
 * A STORED RULE THE FORM CANNOT DRAW IS NAMED, NOT DROPPED. `RuleCondition` is
 * a recursive union and the editor renders two of its leaves. A catalogue
 * written by an import could carry a nested `all`/`any`/`not`; those rule ids
 * are passed to the editor and said out loud above the form, because a
 * condition that vanished silently would leave the rule firing on every single
 * booking with nobody aware it had changed.
 *
 * THE READ FAILS ON ITS OWN. "This property has no policy yet" and "we could
 * not find out" are opposite messages, and only the second carries a
 * correlation id. The first is the state every property starts in.
 */
export default async function PreparationPolicyPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('checklist.manage'),
    shellContext(),
    searchParams,
  ])

  // `requireGrant` redirects when the context is not ready, so this narrows for
  // the type system rather than deciding anything.
  if (!context || context.status !== 'ready') return null

  /**
   * The properties this person may actually configure.
   *
   * The shell already narrowed to the membership's scope; `can()` is asked
   * again per row, which is the second floor `properties/_lib/load.ts` sets
   * out. A list built wrong is a bug; a list built wrong that offers a link
   * somebody is refused is the defect four screens shipped today.
   */
  const configurable = context.properties.filter((property) =>
    can(actor, 'checklist.manage', {
      organizationId: actor.organizationId,
      propertyId: property.id,
      family: 'operations',
    }),
  )

  const requested = firstParam(params[PROPERTY_PARAM])
  const fromShell =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  const selected =
    configurable.find((property) => property.id === requested) ??
    configurable.find((property) => property.id === fromShell) ??
    (configurable.length === 1 ? configurable[0] : null)

  if (configurable.length === 0) {
    return (
      <Shell>
        <EmptyState
          illustration="search"
          as="h2"
          title="אין נכס שאתה רשאי להגדיר לו מדיניות הכנה"
          body="מדיניות הכנה נקבעת לכל נכס בנפרד, וההרשאה לערוך אותה נבדקת מול הנכס עצמו. אין כרגע אף נכס בטווח שלך שאפשר להגדיר — זה מצב אמיתי ולא תקלת טעינה. פנה למי שמנהל את ההרשאות בארגון כדי להרחיב את הטווח."
        />
      </Shell>
    )
  }

  if (!selected) {
    return (
      <Shell>
        <PropertyPicker properties={configurable} />
      </Shell>
    )
  }

  let catalogue: PreparationCatalogue | null = null
  let version: number | null = null
  let readFailure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const { ports } = await preparationWiring()
    ;[catalogue, version] = await Promise.all([
      ports.loadCatalogue(actor.organizationId, selected.id),
      ports.catalogueVersion(actor.organizationId, selected.id),
    ])
  } catch (cause) {
    readFailure = toSafeResponse(cause, crypto.randomUUID())
  }

  const propertyName = selected.name ?? 'הנכס הנבחר'

  const draft =
    catalogue === null
      ? emptyDraft(selected.id, propertyName)
      : draftFromCatalogue(catalogue, selected.id, propertyName)

  const unrenderableRuleIds =
    catalogue === null
      ? []
      : [
          ...catalogue.rules,
          ...catalogue.eventTemplates.flatMap((template) => template.rules),
        ]
          .filter((rule) => hasUnrenderableCondition(rule.condition))
          .map((rule) => rule.id)

  return (
    <Shell>
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/preparation"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה ללוח ההכנות
        </Link>
      </nav>

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          מדיניות ההכנה של ״{propertyName}״
        </h1>
        <p className="max-w-prose text-muted-foreground">
          כאן נקבע כל מספר שמנקה מקבלת. המערכת אינה ממציאה כמויות — היא מכפילה,
          מחלקת, מוסיפה מרווח ומעגלת כלפי מעלה את מה שכתוב במסך הזה, ובלי
          מדיניות היא לא מפיקה כלום. שינוי כאן משפיע על תוכניות עתידיות בלבד:
          תוכנית שכבר נבנתה מחושבת מול צילום קפוא של החוקים שהיו בתוקף כשנבנתה,
          ולכן הזמנה מהחודש שעבר לא תזוז.
        </p>

        {catalogue === null && !readFailure && (
          <p
            role="status"
            className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
          >
            לנכס הזה עוד לא הוגדרה מדיניות הכנה. זה המצב שכל נכס מתחיל בו, לא
            תקלה. אפשר לתאר את הבית, לבדוק חבורה לדוגמה, ורק אז לשמור.
          </p>
        )}

        {configurable.length > 1 && (
          <p className="text-sm text-muted-foreground">
            מגדיר את ״{propertyName}״.{' '}
            <Link
              href="/preparation/policy"
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              בחר נכס אחר
            </Link>
            .
          </p>
        )}
      </header>

      {/* A failed read and an unconfigured property are opposite messages, and
          only the first carries a correlation id. */}
      {readFailure ? (
        <ActionError error={readFailure.error} />
      ) : (
        <PolicyEditor
          initial={draft}
          expectedVersion={version}
          propertyName={propertyName}
          unrenderableRuleIds={unrenderableRuleIds}
        />
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      {children}
    </div>
  )
}

/**
 * Which house is being configured.
 *
 * Rendered instead of the form, never above it: a person who has not chosen a
 * property has not chosen a policy either, and showing an editable form
 * pre-loaded with somebody's guess is how the wrong house gets edited.
 */
function PropertyPicker({
  properties,
}: {
  properties: readonly { id: string; name: string | null }[]
}) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          מדיניות הכנה
        </h1>
        <p className="max-w-prose text-muted-foreground">
          מדיניות ההכנה נקבעת לכל נכס בנפרד — המיטות, הכמויות ותבניות האירוע הן
          של הבית הזה ולא של הארגון. בחר את הנכס שברצונך להגדיר.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {properties.map((property) => (
          <li key={property.id}>
            <Link
              href={`/preparation/policy?${PROPERTY_PARAM}=${encodeURIComponent(property.id)}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 text-start shadow-soft transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="font-medium text-foreground">
                {/* A property whose name did not come back keeps its id rather
                    than a confident invention. A truncated uuid is unhelpful;
                    a wrong name is worse. */}
                {property.name ?? property.id}
              </span>
              <span aria-hidden="true" className="text-muted-foreground">
                ←
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
