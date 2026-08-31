import type { Metadata } from 'next'

import Link from 'next/link'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import {
  InviteMemberForm,
  type InvitableRole,
  type ScopeChoice,
} from '@/components/management/invite-member-form'
import { PageHeader } from '@/components/management/page-header'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../../_lib/guard'
import { knownRoleProfile } from '../../roles/_lib/catalogue'
import { listRoles } from '../../roles/_lib/queries'
import { listScopeChoices } from '../_lib/queries'

export const metadata: Metadata = { title: 'הזמנת חבר צוות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Admitting somebody to the business.
 *
 * GATING. `requireGrant('user.invite')` refuses the route. In the shipped role
 * set the owner, the administrator and the general manager hold it — and the
 * general manager holding it while *not* holding `user.edit` or `role.assign`
 * is deliberate and is written out in `roles.ts`: whoever runs the sellers must
 * not be able to change an administrator's membership.
 *
 * WHAT THE FORM IS GIVEN, AND WHY IT IS GIVEN THAT. Three things, all read
 * under row level security:
 *
 *   · the assignable roles, from `public.roles`, with what each one *grants*
 *     derived from the catalogue in code by `roleProfile`. That derivation is
 *     the point of the screen. An owner choosing a role from a dropdown is
 *     making the single most consequential decision in the product, and doing
 *     it on the strength of a Hebrew name is how a new receptionist ends up
 *     able to export every guest record. The count, the families and the
 *     sensitive actions are shown before the invitation is sent, and they are
 *     the same numbers `/roles` prints, because they come from the same call.
 *   · the properties this person may narrow to, and the teams. Narrowed by the
 *     same policies as everywhere else, so the chooser cannot offer reach the
 *     inviter does not themselves hold.
 *
 * ── The write path does not exist, and the screen says so ─────────────────
 *
 * `public.invitations` needs a `token_hash` and an expiry, and no module in
 * `src/lib` mints, hashes or delivers an invitation token. Writing the row
 * from a server action here would bypass `defineOperation` — authorization,
 * validation, transaction, audit event, idempotency — and would create a
 * membership with no audit row, which contradicts the audit screen shipped
 * beside it. So the submit is disabled, the reason is stated on screen rather
 * than discovered by clicking, and there is deliberately no server action in
 * this route: an action that always refuses is still an endpoint to reason
 * about, and there is nothing here for it to do.
 */
export default async function InviteMemberPage() {
  const actor = await requireGrant('user.invite')

  let roles: readonly InvitableRole[] = []
  let properties: readonly ScopeChoice[] = []
  let teams: readonly ScopeChoice[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  try {
    const db = await createClient()
    const [catalogue, choices] = await Promise.all([
      listRoles(db, actor.organizationId),
      listScopeChoices(db, actor.organizationId),
    ])

    roles = catalogue
      // Platform roles are ESTIA's own staff and `roles_insert` refuses any
      // row carrying `is_platform` inside a customer organization, so offering
      // one here would offer a choice the database will not accept.
      .filter((role) => !role.isPlatform)
      // The owner is transferred, never invited: `organization.transfer_ownership`
      // is its own grant and its own act. A second owner created by an
      // invitation form is not a feature, it is an accident.
      .filter((role) => role.code !== 'organization_owner')
      .map((role) => {
        // Checked rather than cast: `code` is a `text` column and the
        // catalogue in code is a separate artefact. A role this build has
        // never heard of is offered with no grant summary rather than
        // throwing on the whole form.
        const profile = role.grantsKnown ? knownRoleProfile(role.code) : null

        return {
          // The row's id, which is what `invitations.role_id` stores. The code
          // is a label a build knows; the row is the grant.
          id: role.id,
          code: role.code,
          name: role.name,
          description: role.description,
          grantCount: profile?.grantCount ?? 0,
          groupLabels: profile?.groups.map((group) => group.label) ?? [],
          sensitive: profile?.sensitive.map((grant) => grant) ?? [],
        }
      })

    properties = choices.properties
    teams = choices.teams
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <nav aria-label="פירורי לחם" className="text-sm">
        <Link
          href="/team"
          className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          ← חזרה לרשימת הצוות
        </Link>
      </nav>

      <PageHeader
        title="הזמנת חבר צוות"
        lede="הזמנה יוצרת לאדם חשבון משלו בארגון, עם תפקיד וטווח. מה שהתפקיד מקנה מוצג כאן לפני השליחה, ולא אחריה."
      />

      <Card>
        <CardHeader>
          <CardTitle as="h2">פרטי ההזמנה</CardTitle>
          <CardDescription>
            ההרשאות אינן שדה בטופס. הן נגזרות מהתפקיד שנבחר, באותה פונקציה שממנה
            נבנה ה-<code dir="ltr">Actor</code> בכל בקשה — כך שאין כאן מספר
            שמישהו צריך לתחזק בנפרד.
          </CardDescription>
        </CardHeader>

        <div className="mt-6">
          {failure ? (
            <DomainErrorPanel error={failure} correlationId={correlationId} />
          ) : (
            <InviteMemberForm
              roles={roles}
              properties={properties}
              teams={teams}
            />
          )}
        </div>
      </Card>
    </div>
  )
}
