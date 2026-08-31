import type { Metadata } from 'next'

import Link from 'next/link'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import {
  Cell,
  DataTable,
  Row,
  RowHeader,
  Withheld,
} from '@/components/management/data-table'
import { Notice } from '@/components/management/notice'
import { PageHeader } from '@/components/management/page-header'
import { ModuleEmptyState } from '@/components/states/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../_lib/guard'
import {
  EMPLOYMENT_TYPE_LABEL,
  MEMBERSHIP_STATUS_LABEL,
  MEMBERSHIP_STATUS_MEANING,
  describeScopeSentence,
  hebrewDate,
  hebrewMoment,
  labelOr,
  membershipStatusTone,
} from './_lib/labels'
import {
  listMembers,
  membersNeedingAttention,
  type MemberListItem,
} from './_lib/queries'

export const metadata: Metadata = { title: 'צוות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The people in this organization.
 *
 * WHAT IS ON THIS SCREEN. Rows from `public.memberships` for the organization
 * the shell resolved, with the profile, the roles, the scope and the team of
 * each, read through the request-scoped Supabase client under row level
 * security. Every value is a column or a Hebrew name for one. The only
 * computed thing is the count of memberships that are not `active`, and that
 * is a count of the rows on screen.
 *
 * GATING, IN THREE PLACES, AND NONE OF THEM IS THE MENU.
 * `requireGrant('user.view')` refuses the route. `holdsGrant` refuses again in
 * `listMembers` before a query is issued. `redact()` removes the telephone
 * number without `user.edit`. And `memberships_select` refuses regardless of
 * all three.
 *
 * There is deliberately no scope narrowing on this list, and `_lib/queries.ts`
 * argues it at length: a person is not located in a property, `scopeReaches`
 * denies by default for a resource carrying no location, and asking the scope
 * question here would hand a property manager who genuinely holds `user.view`
 * an empty screen behind a menu entry that promised otherwise.
 * `memberships_select` carries no permission and no scope either, so this
 * matches the floor underneath it rather than inventing a stricter one.
 *
 * ── Status is the point of this screen ────────────────────────────────────
 *
 * `authorize()` refuses any actor whose membership is not `active` before it
 * looks at a single grant, and `loadWorkspaces` only lists organizations where
 * the membership is `active` — so an invited, pending, suspended or removed
 * person does not have a smaller product, they have no workspace at all. Four
 * different unfinished situations, four different people waiting on somebody,
 * and one word each on a roster would tell an administrator none of it. So the
 * word carries its meaning beside it, and the four are sorted to the top.
 *
 * ── A removed person is still on this screen, deliberately ────────────────
 *
 * `memberships` has no soft-delete columns, and the migration says why:
 * removal is a status change, because the bookings, tasks and payments a
 * person made must stay attributed to them. A roster that filtered `removed`
 * out would be hiding the record that makes the audit trail readable.
 */
export default async function TeamPage() {
  const actor = await requireGrant('user.view')

  let members: readonly MemberListItem[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  try {
    const db = await createClient()
    members = await listMembers({
      db,
      actor,
      organizationId: actor.organizationId,
    })
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const attention = membersNeedingAttention(members)
  // The control is offered only when the route behind it would admit them.
  const mayInvite = holdsGrant(actor, 'user.invite')
  const maySeeContact = holdsGrant(actor, 'user.edit')

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        title="צוות"
        lede="כל מי שיש לו חברות בארגון — התפקידים שהוא מחזיק, הטווח שבו הם חלים, ומאיזה רגע. הרשימה מוגבלת לחברויות שבטווח שלך, ומצב החברות אינו תווית: הוא ההבדל בין מי שיכול להיכנס למערכת לבין מי שלא."
        action={
          mayInvite ? (
            <Button href="/team/invite" size="sm">
              הזמנת חבר צוות
            </Button>
          ) : undefined
        }
      />

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : members.length === 0 ? (
        // No filter exists on this screen, so an empty roster can only mean
        // that no membership in this organization is within the reader's
        // reach. `no_results` would be a lie.
        <ModuleEmptyState
          module="team"
          reason="no_data"
          renderAction={
            mayInvite
              ? (label) => (
                  <Button href="/team/invite" size="sm">
                    {label}
                  </Button>
                )
              : undefined
          }
        />
      ) : (
        <>
          {attention.length > 0 && (
            <Notice title="חברויות שממתינות למישהו" tone="strong">
              {attention.length === 1
                ? 'חברות אחת ברשימה אינה פעילה'
                : `${attention.length} חברויות ברשימה אינן פעילות`}
              . מנוע ההרשאות דוחה כל בקשה של מי שחברותו אינה פעילה עוד לפני שהוא
              בודק הרשאה אחת, ולכן אלה אינם אנשים שרואים פחות — אלה אנשים שאין
              להם מרחב עבודה בכלל. הן מוצגות בראש הרשימה.
            </Notice>
          )}

          <DataTable
            caption="חברי הארגון, מצב החברות שלהם, תפקידיהם והטווח שבו הם חלים"
            columns={[
              'אדם',
              'מצב החברות',
              'תפקידים',
              'טווח',
              'צוות',
              'הצטרף',
              'פעיל לאחרונה',
            ]}
          >
            {members.map((member) => (
              <MemberRow
                key={member.membershipId}
                member={member}
                maySeeContact={maySeeContact}
              />
            ))}
          </DataTable>

          <Notice title="מה שאינו מוצג כאן, ולמה">
            כתובות דוא״ל אינן מופיעות במסך הזה כי הן אינן קיימות ב-
            <code dir="ltr">public.user_profiles</code> — הכתובת יושבת ב-
            <code dir="ltr">auth.users</code>, ששום שאילתה של לקוח אינה קוראת.
            מספרי טלפון מוצגים רק למי שמחזיק בהרשאה לערוך אנשים (
            <code dir="ltr">user.edit</code>), ולא לכל מי שרשאי לראות את הרשימה.
            ראו את{' '}
            <Link
              href="/roles"
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              מסך התפקידים
            </Link>{' '}
            כדי לראות מי מחזיק במה.
          </Notice>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

function MemberRow({
  member,
  maySeeContact,
}: {
  member: MemberListItem
  maySeeContact: boolean
}) {
  const joined = hebrewDate(member.joinedAt)
  const lastActive = hebrewMoment(member.lastActiveAt)

  return (
    <Row>
      <RowHeader>
        {/* A profile this reader cannot read stays unnamed. A uuid in a name
            column tells nobody anything. */}
        <span className="block">
          {member.fullName ?? 'אדם ללא פרופיל קריא'}
        </span>
        <span className="block text-xs font-normal text-muted-foreground">
          {member.employmentType === null
            ? 'סוג העסקה לא נרשם'
            : labelOr(EMPLOYMENT_TYPE_LABEL, member.employmentType)}
        </span>
        {maySeeContact ? (
          member.phone ? (
            <span
              dir="ltr"
              className="block text-xs font-normal text-muted-foreground"
            >
              {member.phone}
            </span>
          ) : null
        ) : (
          <Withheld label="טלפון מוסתר" />
        )}
      </RowHeader>

      <Cell>
        <Badge tone={membershipStatusTone(member.status)}>
          {MEMBERSHIP_STATUS_LABEL[member.status]}
        </Badge>
        <span className="mt-1.5 block max-w-72 text-xs leading-relaxed text-muted-foreground">
          {MEMBERSHIP_STATUS_MEANING[member.status]}
        </span>
      </Cell>

      <Cell>
        {member.roles.length === 0 ? (
          // Legitimate, and worth seeing: `InMemoryActorSource` and the
          // Supabase one both answer `[]` for a membership with no roles, and
          // such a person resolves to an actor holding nothing.
          <span className="text-xs text-muted-foreground">
            אין תפקיד — חברות בלי תפקיד אינה שגיאה, והיא מקנה אפס הרשאות
          </span>
        ) : (
          <ul className="flex flex-col gap-1">
            {member.roles.map((role) => (
              <li key={role.code}>
                <span className="font-medium">{role.name}</span>{' '}
                <span
                  dir="ltr"
                  className="font-mono text-xs text-muted-foreground"
                >
                  {role.code}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Cell>

      <Cell className="max-w-72 text-xs leading-relaxed text-muted-foreground">
        {describeScopeSentence(
          member.scope.scope,
          member.scope.names,
          member.scope.unresolvedCount,
        )}
      </Cell>

      <Cell className="text-muted-foreground">
        {member.teamName ?? '—'}
        {member.defaultPropertyName && (
          <span className="block text-xs">
            נוחת ב{member.defaultPropertyName}
          </span>
        )}
      </Cell>

      <Cell className="text-muted-foreground">
        {/* `memberships_joined_when_active`: only an active membership has a
            joining date, so its absence is a fact about the status. */}
        {joined ?? 'טרם הצטרף'}
        {member.invitedByName && (
          <span className="block text-xs">
            הוזמן על ידי {member.invitedByName}
          </span>
        )}
        {member.mfaEnforcedAt && (
          <span className="block text-xs">אימות דו-שלבי נאכף</span>
        )}
      </Cell>

      <Cell className="text-muted-foreground">{lastActive ?? 'מעולם לא'}</Cell>
    </Row>
  )
}
