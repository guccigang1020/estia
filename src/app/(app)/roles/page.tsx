import type { Metadata } from 'next'

import { DomainErrorPanel } from '@/components/calendar/domain-error'
import { Notice } from '@/components/management/notice'
import { PageHeader } from '@/components/management/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { authorize, holdsGrant } from '@/lib/authz/can'
import type { Grant } from '@/lib/authz/permissions'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requireGrant } from '../_lib/guard'
import { CustomRolesPanel } from './_components/custom-roles-panel'
import { CustomRolesPlanLock } from './_components/plan-lock'
import {
  groupGrants,
  knownRoleProfile,
  ownerAdvantage,
  type RoleProfile,
} from './_lib/catalogue'
import { listCustomRoles, type CustomRoleRecord } from './_lib/custom-roles'
import { listRoles, type RoleRecord } from './_lib/queries'

export const metadata: Metadata = { title: 'תפקידים והרשאות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What each role actually grants.
 *
 * WHAT IS ON THIS SCREEN, AND WHERE IT COMES FROM. The names and descriptions
 * are rows in `public.roles`, seeded by the migrations and read under row
 * level security. Everything else — every grant listed under every role — is
 * **derived** by `_lib/catalogue.ts` from `grantsForSystemRole`, which is the
 * same function `SupabaseActorSource` resolves an actor through. So this
 * screen does not describe the permission model; it *is* the permission model,
 * asked the same question the engine is asked on every request.
 *
 * That is the only version of this screen worth showing a buyer. A
 * hand-maintained table of "what a receptionist can do" is a document that was
 * true once. `organization_owner` here is literally every non-platform grant
 * in the catalogue and `administrator` is that set minus `OWNER_ONLY`,
 * computed at render time — so a permission added next year appears under both
 * without anybody remembering this file exists.
 *
 * GATING. `requireGrant('role.assign')` refuses the route: this is the screen
 * that tells somebody exactly which grant to hand out to obtain any capability
 * in the product, and that is a map of the building. In the shipped role set
 * only the owner and the administrator hold it. Row level security refuses
 * independently — `roles_select` admits the global catalogue and the caller's
 * own organization's roles, and nothing else.
 *
 * A SYSTEM ROLE IS STILL NOT EDITABLE, and that is not a missing feature: the
 * grants of a system role live in code, not in a table, and a screen offering
 * to edit them would be offering to edit something it cannot write. 0069 says
 * the same thing at the database — `tg_roles_system_is_read_only` refuses an
 * UPDATE or a DELETE of one from any signed-in caller.
 *
 * WHAT IS NEW IS THE PANEL BELOW IT. `custom_roles` is sold in the Management
 * plan and `roles_insert` has always admitted a customer's own role; nothing
 * ever wrote one, so a paid feature had no code behind it. A custom role's
 * grants genuinely do live in `role_permissions` — there is no catalogue entry
 * to derive them from — so `_lib/custom-roles.ts` reads that table for exactly
 * those rows, and the panel renders them through the same `groupGrants` the
 * system roles go through.
 *
 * THE ESCALATION RULE IS VISIBLE ON THE SCREEN, not only enforced behind it.
 * The checkbox grid offers exactly the grants this reader holds, because a
 * role may never carry more than its author does — refused in the operation by
 * `assertGrantable` and again at the database by
 * `tg_role_permission_within_reach`.
 */
export default async function RolesPage() {
  const actor = await requireGrant('role.assign')

  let roles: readonly RoleRecord[] = []
  let customRoles: readonly CustomRoleRecord[] = []
  let failure: unknown = null
  const correlationId = crypto.randomUUID()

  // Asked of the engine, not of a plan lookup here. `ENTITLEMENT_FOR_GRANT`
  // maps `role.create` to `custom_roles`, so `plan_does_not_include` is the
  // engine's own answer and the panel below shows the upgrade argument for it
  // rather than a refusal that reads as a permission problem.
  const customRoleDecision = authorize(actor, 'role.create', {
    organizationId: actor.organizationId,
    family: 'team',
  })
  const planLocked =
    !customRoleDecision.allowed &&
    customRoleDecision.reason === 'plan_does_not_include'
  // Read off the decision rather than looked up again. The engine names the
  // feature it refused on, and a second lookup here could name a different one.
  const lockedEntitlement = customRoleDecision.allowed
    ? null
    : (customRoleDecision.entitlement ?? null)
  const mayCreateRoles = customRoleDecision.allowed
  const mayEditPermissions = holdsGrant(actor, 'permission.edit')

  try {
    const db = await createClient()
    const reads: [
      Promise<readonly RoleRecord[]>,
      Promise<readonly CustomRoleRecord[]>,
    ] = [
      listRoles(db, actor.organizationId),
      // Not read behind the plan lock. A business without the feature has no
      // custom roles by construction, and issuing a query whose only possible
      // answer is an empty list is a request that exists to be discarded.
      planLocked
        ? Promise.resolve([])
        : listCustomRoles(db, actor.organizationId),
    ]
    const [all, custom] = await Promise.all(reads)
    roles = all
    customRoles = custom
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  const advantage = ownerAdvantage()
  // The custom roles are listed and edited in their own panel below, so the
  // catalogue section stays what it is: the roles ESTIA ships with. Leaving a
  // customer's own role in it would put it under a heading whose whole claim
  // — "these are derived from the catalogue in code" — is false about it.
  const assignable = roles.filter(
    (role) => !role.isPlatform && role.grantsKnown,
  )
  const platform = roles.filter((role) => role.isPlatform)

  /**
   * Exactly what this reader holds, grouped, and nothing else.
   *
   * This is the checkbox list the panel offers. It is not the enforcement —
   * `assertGrantable` refuses in the operation and
   * `tg_role_permission_within_reach` refuses at the database — it is the
   * interface telling the truth about the rule rather than offering a hundred
   * boxes and rejecting eleven after the click. Platform grants are stripped
   * for the same reason 0002's trigger refuses them.
   */
  const grantable = groupGrants(
    [...actor.grants].filter(
      (grant) => !grant.startsWith('platform.') && holdsGrant(actor, grant),
    ),
  )

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <PageHeader
        title="תפקידים והרשאות"
        lede="תפקיד הוא שם על אוסף הרשאות, ותו לא. המנוע אינו יודע מה שמו של תפקיד — הוא מקבל אוסף הרשאות שטוח ועונה עליו. מה שמופיע כאן נגזר מאותו קטלוג שהמנוע קורא, ולא מתוארך בנפרד."
      />

      <Notice title="למה אפשר לסמוך על הרשימה הזאת" tone="strong">
        ההרשאות של כל תפקיד נגזרות ברגע ההצגה מ-
        <code dir="ltr">grantsForSystemRole</code> — אותה פונקציה שממנה נבנה ה-
        <code dir="ltr">Actor</code> בכל בקשה. ״בעל העסק״ הוא כל ההרשאות שאינן
        של הפלטפורמה, ו״מנהל מערכת״ הוא אותה קבוצה פחות{' '}
        <code dir="ltr">OWNER_ONLY</code>; שתיהן מחושבות ולא רשומות, כך שהרשאה
        שתתווסף למוצר בשנה הבאה תופיע כאן מעצמה. אין כאן טבלה שמישהו צריך לזכור
        לעדכן.
      </Notice>

      {failure ? (
        <DomainErrorPanel error={failure} correlationId={correlationId} />
      ) : (
        <>
          <section className="flex flex-col gap-4">
            <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
              תפקידים שניתן להקצות בארגון
            </h2>
            <ul className="flex flex-col gap-4">
              {assignable.map((role) => (
                <li key={role.id}>
                  <RoleCard role={role} />
                </li>
              ))}
            </ul>
          </section>

          {planLocked ? (
            <CustomRolesPlanLock
              entitlement={lockedEntitlement}
              // Checked before the link is rendered, never after. A general
              // manager holds `role.assign` and not
              // `organization.billing.manage`, and a link they cannot follow
              // lands them on the refusal this panel exists to avoid.
              mayReachBilling={holdsGrant(actor, 'organization.billing.manage')}
            />
          ) : (
            <CustomRolesPanel
              roles={customRoles}
              grantable={grantable}
              mayCreate={mayCreateRoles}
              mayEditPermissions={mayEditPermissions}
            />
          )}

          <section className="flex flex-col gap-4">
            <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
              תפקידי הפלטפורמה
            </h2>
            <Notice title="אלה אינם תפקידים של הארגון">
              שתי השורות האלה נזרעות ב-<code dir="ltr">public.roles</code> על
              ידי המיגרציה, ואינן ניתנות להקצאה בתוך ארגון של לקוח:{' '}
              <code dir="ltr">roles_insert</code> מסרב לכל שורה שבה{' '}
              <code dir="ltr">is_platform</code>. ההרשאות של צוות ESTIA אינן
              נגזרות מתפקיד אלא מהדגל{' '}
              <code dir="ltr">Actor.isPlatformStaff</code>, ולכן אין כאן רשימת
              הרשאות להציג — והמצאה של אחת הייתה תיאור של מודל שאינו קיים.
            </Notice>
            <ul className="flex flex-col gap-4">
              {platform.map((role) => (
                <li key={role.id}>
                  <RoleCard role={role} />
                </li>
              ))}
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl font-bold tracking-tight text-foreground">
              ההבדל בין בעל העסק למנהל המערכת
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              מחושב עכשיו, כהפרש בין שתי קבוצות ההרשאות ולא כרשימה שנכתבה בעבר.
              אלה{' '}
              {advantage.length === 1
                ? 'ההרשאה היחידה'
                : `${advantage.length} ההרשאות`}{' '}
              שבעל העסק מחזיק ומנהל המערכת אינו:
            </p>
            <GrantChips grants={advantage} />
          </section>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------- fragments -- */

function RoleCard({ role }: { role: RoleRecord }) {
  // `code` is a `text` column, and the catalogue in code is a separate
  // artefact that happens to agree with it. `knownRoleProfile` checks rather
  // than casts, so a row naming a code this build has never heard of renders
  // as "grants unknown" instead of throwing on the whole screen.
  const profile = role.grantsKnown ? knownRoleProfile(role.code) : null

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle as="h3">{role.name}</CardTitle>
          <CardDescription>
            <span dir="ltr" className="font-mono text-xs">
              {role.code}
            </span>
            {role.description ? ` · ${role.description}` : ''}
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {profile?.isDerived && <Badge tone="brand">נגזר מהקטלוג</Badge>}
          {role.isPlatform && <Badge tone="neutral">צוות ESTIA</Badge>}
          <Badge tone={role.memberCount > 0 ? 'accent' : 'neutral'}>
            {role.memberCount === 0
              ? 'אף אחד בארגון'
              : role.memberCount === 1
                ? 'אדם אחד'
                : `${role.memberCount} אנשים`}
          </Badge>
        </div>
      </div>

      {profile === null ? (
        <p className="text-sm text-muted-foreground">
          {/* The custom roles have their own panel now, so a row reaching this
              branch is a SYSTEM role whose `code` this build has never heard
              of — a deployment sitting between two migrations. Saying "grants
              unknown" is the true statement; rendering an empty list would say
              the role grants nothing, confidently and wrongly. */}
          תפקיד מערכת עם מזהה שהגרסה הזאת של המוצר אינה מכירה. ההרשאות של תפקידי
          מערכת נגזרות מהקטלוג שבקוד, ולקוד הזה אין ערך תואם — ולכן אין כאן
          רשימה להציג.
        </p>
      ) : role.isPlatform ? (
        <p className="text-sm text-muted-foreground">
          אין רשימת הרשאות לתפקיד הזה, כי הגישה של צוות ESTIA אינה נגזרת מתפקיד.
        </p>
      ) : (
        <RoleGrants profile={profile} />
      )}
    </Card>
  )
}

function RoleGrants({ profile }: { profile: RoleProfile }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {profile.grantCount} הרשאות, ב-{profile.groups.length} תחומים
        {profile.sensitive.length > 0 && (
          <>
            {' · '}
            <span className="font-medium text-foreground">
              {profile.sensitive.length} מהן דורשות אימות, נימוק או אישור לפני
              ביצוע
            </span>
          </>
        )}
      </p>

      {profile.sensitive.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold text-foreground">
            פעולות רגישות שהתפקיד מחזיק
          </h4>
          {/* `SENSITIVE_ACTIONS` is the catalogue's own set. A role holding one
              of these does not thereby get to perform it unattended — the
              service layer demands a fresh authentication, a stated reason or
              an approval — and saying so on the screen is what stops the list
              being read as "may do this quietly". */}
          <GrantChips grants={profile.sensitive} tone="accent" />
        </div>
      )}

      <details className="group">
        <summary className="cursor-pointer list-none rounded-lg px-2 py-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <span className="group-open:hidden">הצגת כל ההרשאות</span>
          <span className="hidden group-open:inline">הסתרת ההרשאות</span>
        </summary>

        <div className="mt-3 flex flex-col gap-3">
          {profile.groups.map((group) => (
            <div key={group.id} className="flex flex-col gap-1.5">
              <h4 className="text-xs font-semibold text-foreground">
                {group.label}
              </h4>
              <GrantChips grants={group.grants} />
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

/**
 * The grant strings themselves, unstyled into prose.
 *
 * Left in Latin and monospaced on purpose. These are the exact values passed
 * to `can()`, and a Hebrew paraphrase of `booking.amend_dates` would be
 * friendlier and would stop being the thing a reviewer can grep for.
 */
function GrantChips({
  grants,
  tone = 'neutral',
}: {
  grants: readonly Grant[]
  tone?: 'neutral' | 'accent'
}) {
  if (grants.length === 0) {
    return <p className="text-sm text-muted-foreground">אין.</p>
  }

  return (
    <ul className="flex flex-wrap gap-1.5">
      {grants.map((grant) => (
        <li key={grant}>
          <Badge tone={tone}>
            <span dir="ltr" className="font-mono text-[0.6875rem]">
              {grant}
            </span>
          </Badge>
        </li>
      ))}
    </ul>
  )
}
