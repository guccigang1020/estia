import type { Metadata } from 'next'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { firstParam } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { AgentStatusControl } from '@/components/distribution/agent-status-control'
import {
  AgentTable,
  type AgentRow,
} from '@/components/distribution/agent-table'
import { PlanLock } from '@/components/distribution/plan-lock'
import { EmptyState } from '@/components/states/empty-state'
import { resolveEmptyReason } from '@/components/states/empty-presets'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import {
  can,
  MEMBERSHIP_STATUSES,
  type MembershipStatus,
} from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../_lib/context'
import { requireDistributionGrant } from './_lib/gate'
import { AGENT_STATUS_LABEL } from './_lib/labels'
import {
  AGENT_PAGE_SIZE,
  agentProduction,
  agentResource,
  countAgents,
  listAgents,
  propertyNames,
  type AgentListItem,
} from './_lib/queries'

export const metadata: Metadata = { title: 'סוכנים' }

/** The one key this list reads out of the URL. */
const STATUS_KEY = 'status'

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The external sellers.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.agent_organization_settings`: who
 * each seller is, the three access ladders their record holds, the inventory
 * their membership reaches, the state of the relationship, and what they have
 * produced. It is the commercial relationship, not an identity system — an
 * agent is a member of this organization with a narrow role and a narrow reach,
 * which is why the status comes off the *membership* and not off the terms.
 *
 * THERE IS NO PRESET COLUMN, AND THERE CANNOT BE. `types.ts` enforces in the
 * type system that `AgentOrganizationSettings` carries no `type`, `preset` or
 * `model`: the four presets are starting positions that stop existing the moment
 * an owner edits one, and a stored type would be an invitation to write
 * `if (agent.type === 'senior')` somewhere that then silently contradicts every
 * manual edit. So the screen renders the three rungs, which is both the truth
 * and the more useful answer — "סוכן בכיר" does not tell an owner whether their
 * seller can read a guest's telephone number.
 *
 * SUSPENDING IS ON THIS SCREEN, and it is here for the reason `lifecycle.ts`
 * gives: it is the button an owner presses the moment they discover something,
 * and one that takes four navigations to reach has the same defect as one that
 * takes five minutes to apply. It takes effect on the agent's very next request
 * because an `Actor` is rebuilt from the database every time and `authorize()`
 * refuses a membership that is not `active` before it reads a grant. Nothing is
 * cached and nothing durable sits in their browser.
 *
 * GATING, AND THE REFUSAL THAT MUST NOT BE FLATTENED.
 * `requireDistributionGrant('agent.view')` is `requireGrant` with one branch
 * changed: `plan_does_not_include` renders an upgrade instead of redirecting to
 * a dashboard banner that says "you lack a permission". `agent.view` is mapped
 * to `agent_network`, which Basic buys as a paid add-on — telling a Basic owner
 * they lack a permission they in fact hold sends them to their administrator,
 * who cannot help, instead of to the add-on they were one click from.
 *
 * `can()` per row with `family: 'team'` and `assignedToUserId` — the same
 * resource `settingsResource` in `agents/operations.ts` builds — so an actor
 * scoped to `own_records` sees themselves and nobody else. `redact()` removes
 * the owner's internal note from a reader without `agent.manage`.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [access, context, params] = await Promise.all([
    requireDistributionGrant('agent.view'),
    shellContext(),
    searchParams,
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="רשת הסוכנים אינה כלולה בחבילה שלך"
        body="רשת סוכנים היא ערוץ מכירה שלם: סוכנים חיצוניים שרואים בדיוק את מה שהחלטת שיראו, מוכרים את המלאי שהקצית להם, ומקבלים עמלה שהמערכת מחשבת ועוקבת אחריה עד לתשלום."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const status = parseStatus(firstParam(params[STATUS_KEY]))

  let agents: readonly AgentListItem[] = []
  let total = 0
  let rows: AgentRow[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    ;[agents, total] = await Promise.all([
      listAgents({ db, actor, organizationId: actor.organizationId, status }),
      countAgents(db, actor.organizationId),
    ])

    // The property names behind every reach, in one query rather than one per
    // agent. A reach naming a property this reader cannot see simply has no
    // name, and the row falls back to the count — which is true.
    const names = await propertyNames(
      db,
      actor.organizationId,
      agents.flatMap((agent) => agent.inventoryPropertyIds),
    )

    rows = await Promise.all(
      agents.map(async (agent) => ({
        agent,
        production: await agentProduction(
          db,
          actor,
          actor.organizationId,
          agent.agentUserId,
        ),
        reachNames: agent.inventoryPropertyIds
          .map((id) => names.get(id))
          .filter((name): name is string => name !== undefined),
      })),
    )
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const emptyReason = resolveEmptyReason({
    visibleCount: rows.length,
    totalCount: total,
    hasActiveFilters: status !== null,
  })

  const suspended = rows.filter((row) => row.agent.status === 'suspended')

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          סוכנים
        </h1>
        <p className="text-muted-foreground">
          המוכרים החיצוניים של העסק.{' '}
          {total === 1 ? 'סוכן אחד רשום' : `${total} סוכנים רשומים`}. לכל סוכן
          דרגות הרשאה משלו — מה הוא רואה ביומן, איזה מחיר, ואילו פרטי אורח —
          ומלאי משלו למכירה. אין ״סוג סוכן״: מה שנשמר הוא הדרגות עצמן, וכל שינוי
          שלהן נכנס לתוקף בבקשה הבאה של הסוכן.
        </p>
      </header>

      <StatusFilter selected={status} />

      {failure ? (
        <ActionError error={failure.error} />
      ) : emptyReason ? (
        <EmptyState
          illustration={emptyReason === 'no_results' ? 'search' : 'team'}
          title={
            emptyReason === 'no_results'
              ? 'אין סוכנים במצב הזה'
              : 'עוד לא הוספת סוכנים'
          }
          body={
            emptyReason === 'no_results'
              ? `אין סוכן שמצבו ״${status === null ? '' : AGENT_STATUS_LABEL[status]}״. סוכנים אחרים קיימים במערכת — ניקוי הסינון יחזיר אותם.`
              : 'סוכן חיצוני הוא מוכר שמביא לך הזמנות ומקבל עמלה. הוא נכנס עם מספר הטלפון שלו, רואה רק את מה שהקצית לו, ומוכר רק את הנכסים שבחרת. ההזמנות שהוא מביא, העמלות שלו והייחוס נשמרים גם אחרי שהקשר איתו מסתיים.'
          }
          action={
            emptyReason === 'no_results' ? (
              <Button href="/agents" variant="secondary">
                נקה סינון
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {suspended.length > 0 && (
            <p
              role="status"
              className="rounded-lg border border-border-strong bg-accent-soft px-4 py-3 text-sm text-accent-foreground"
            >
              <span className="font-semibold">
                {suspended.length === 1
                  ? 'סוכן אחד מושעה'
                  : `${suspended.length} סוכנים מושעים`}
              </span>{' '}
              — הגישה שלהם חסומה כרגע, והעמלות שכבר נצברו להם עדיין עומדות
              לתשלום.
            </p>
          )}

          <AgentTable rows={rows} />

          <ManagementPanel rows={rows} actor={actor} />

          {agents.length === AGENT_PAGE_SIZE && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              מוצגים {AGENT_PAGE_SIZE} הסוכנים הראשונים. סנן לפי מצב כדי לראות
              סוכנים נוספים.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- parts -- */

/**
 * The status filter, as a real GET form.
 *
 * A `<form method="get">` with no client component behind it: this screen has
 * exactly one filter, and it works before hydration and with JavaScript
 * disabled because the browser's own submission produces the query string the
 * page parses. `StatusFilterBar` in the finance module adds a client-side
 * navigation on top of the same idea; a second copy of it here, generic over a
 * different vocabulary, would be a component for one caller.
 */
function StatusFilter({ selected }: { selected: MembershipStatus | null }) {
  return (
    <form
      method="get"
      action="/agents"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5"
      aria-label="סינון סוכנים"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="מצב הסוכן">
          <Select name={STATUS_KEY} defaultValue={selected ?? ''}>
            <option value="">כל המצבים</option>
            {MEMBERSHIP_STATUSES.map((status) => (
              <option key={status} value={status}>
                {AGENT_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm">
          סנן
        </Button>
        {selected !== null && (
          <Button href="/agents" variant="ghost" size="sm">
            נקה סינון
          </Button>
        )}
      </div>
    </form>
  )
}

/**
 * The status controls, one per agent this reader may actually manage.
 *
 * Placed below the table rather than inside a cell for a plain reason: each one
 * demands a written reason before it will do anything, and a textarea in a table
 * cell is unusable on a telephone. `can()` decides per agent, so a reader with
 * `agent.view` and no `agent.manage` sees the list and no controls at all —
 * which is the honest rendering of what they may do, and is not the enforcement:
 * `setAgentStatusAction` refuses on its own terms.
 */
function ManagementPanel({
  rows,
  actor,
}: {
  rows: readonly AgentRow[]
  actor: Parameters<typeof can>[0]
}) {
  const manageable = rows.filter((row) =>
    can(
      actor,
      'agent.manage',
      agentResource(actor.organizationId, row.agent.agentUserId),
    ),
  )

  if (manageable.length === 0) return null

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-bold text-foreground">
          שינוי מצב סוכן
        </h2>
        <p className="text-sm text-muted-foreground">
          השעיה נכנסת לתוקף מיד — הבקשה הבאה של הסוכן נבדקת מול השורה כפי שהיא
          עכשיו. שום דבר לא נמחק: ההזמנות, העמלות, הייחוס ויומן הביקורת נשמרים.
        </p>
      </div>

      <div className="flex flex-col gap-6">
        {manageable.map((row) => (
          <div
            key={row.agent.agentUserId}
            className="flex flex-col gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0"
          >
            <span className="font-semibold text-foreground">
              {row.agent.displayName ?? row.agent.phoneE164 ?? 'סוכן ללא שם'}
            </span>
            <AgentStatusControl
              agentUserId={row.agent.agentUserId}
              version={row.agent.version}
              status={row.agent.status}
              displayName={row.agent.displayName}
              phoneE164={row.agent.phoneE164}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * The status out of the URL, refusing anything that is not one.
 *
 * `MEMBERSHIP_STATUSES` is the contract's own tuple, so a status added to the
 * database and to the contract is filterable on the same commit and a
 * hand-edited URL cannot put an unknown value in front of a comparison.
 */
function parseStatus(raw: string | null): MembershipStatus | null {
  if (raw === null) return null
  return (MEMBERSHIP_STATUSES as readonly string[]).includes(raw)
    ? (raw as MembershipStatus)
    : null
}
