import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { GrantCode } from '@/components/shell-screens/domain-gap'
import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { MembershipStatus } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  MEMBERSHIP_STATUS_LABEL,
  SCOPE_KIND_LABEL,
  SECRET_COPY,
} from './_lib/labels'
import {
  listMemberSecurity,
  listOutstandingInvitations,
  loadAccountSecurity,
  loadSecretHoldings,
  mfaCoverage,
  type MemberSecurity,
  type OutstandingInvitation,
  type SecurityArgs,
} from './_lib/queries'

export const metadata: Metadata = { title: 'אבטחה וגישה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Access, credentials and what is not
 * shown.
 *
 * ══ NO SECRET IS RENDERED HERE, NOT EVEN MASKED ══════════════════════════
 *
 * `_lib/queries.ts` does not name a credential column in any `select`, so there
 * is nothing on this page to mask — masking is a decision taken in a component
 * and components get refactored. What the screen does instead is name each
 * credential the product holds, say what it is for, say how many exist and when
 * the newest was created, and say why it will not be shown. That is the brief:
 * if a value cannot be shown safely, say what it is and when it changed.
 *
 * ══ NO ACTION IS OFFERED THAT THIS PRODUCT CANNOT PERFORM ════════════════
 *
 * There is no session list and no "sign this device out", because Supabase owns
 * sessions in `auth.sessions`, that schema is not exposed, and no route in this
 * codebase can end another session on demand. Rendering a device list would be
 * the single most tempting fabrication on this screen and it would be a
 * fabrication.
 *
 * What *is* offered is real and is wired: `resetPasswordAction` in
 * `src/app/(auth)/actions.ts` ends every other session after a successful
 * password change — `signOut({ scope: 'others' })` — so changing the password
 * is genuinely how you evict a device, and the link goes to
 * `/forgot-password`, which exists. Signing this browser out lives on
 * `/account`, which exists. Nothing else is offered: there is no MFA
 * enrolment screen in this product, so there is no "enable two-factor" button,
 * and `mfa_enforced_at` is reported as the policy fact it is rather than dressed
 * as a toggle.
 *
 * GATING. `requireGrant('organization.settings.edit')` refuses the route. The
 * account panel is the reader's own record and needs nothing further; the team
 * and invitation panels need `user.view`, because a colleague's last-seen time
 * and an invitee's email address are exactly what that grant is about. Row
 * level security refuses underneath all of it.
 */
export default async function SecuritySettingsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('organization.settings.edit'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  const db = await createClient()
  const args: SecurityArgs = {
    db,
    actor,
    organizationId: context.workspace.organizationId,
  }

  const [account, members, invitations, secrets] = await Promise.all([
    settle(() => loadAccountSecurity(args)),
    settle(() => listMemberSecurity(args)),
    settle(() => listOutstandingInvitations(args)),
    settle(() => loadSecretHoldings(args)),
  ])

  const coverage =
    members.ok && members.value ? mfaCoverage(members.value) : null

  const providers = signInProviders(context.user)

  return (
    <ScreenFrame
      title="אבטחה וגישה"
      lead="מי יכול להיכנס לארגון הזה, במה מוגנת הכניסה, ומה המוצר מחזיק ולא יראה לך."
      width="prose"
    >
      {/* ------------------------------------------------- this account -- */}
      <Panel
        title="החשבון שלך"
        description="נקרא מהרשומה שלך עצמה בכל בקשה, ולא מעוגייה."
      >
        {!account.ok ? (
          <ActionError error={account.error} />
        ) : account.value === null ? (
          <PanelNote tone="attention">
            לא נמצאה רשומת חברות שלך בארגון הזה. זה מצב שאמור להיות בלתי אפשרי
            במסך שדרש הרשאת ניהול הגדרות, ולכן הוא מוצג כתקלה ולא כשדה ריק.
          </PanelNote>
        ) : (
          <dl className="flex flex-col">
            <FactRow label="אימייל">
              <span dir="ltr">{context.user.email}</span>
            </FactRow>
            {account.value.fullName && (
              <FactRow label="שם">{account.value.fullName}</FactRow>
            )}
            <FactRow label="אופן ההזדהות">
              <span dir="ltr">{providers}</span>
            </FactRow>
            <FactRow label="אימות כתובת המייל">
              {context.user.email_confirmed_at
                ? `אומת ב־${dateOf(context.user.email_confirmed_at)}`
                : 'לא אומת'}
            </FactRow>
            <FactRow label="גורם אימות שני">
              {/* The column's own comment: null means the requirement has not
                  been imposed, NOT that MFA is absent. Rendering "no second
                  factor" would be a claim about the account rather than about
                  the policy, and the product has no way to know the first. */}
              {account.value.mfaEnforcedAt
                ? `נדרש ממך מאז ${dateOf(account.value.mfaEnforcedAt)}`
                : 'לא נדרש ממך. זו קביעה על המדיניות בלבד — המוצר אינו יודע אם הגדרת גורם שני אצל ספק ההזדהות.'}
            </FactRow>
            <FactRow label="מספר לשחזור">
              {account.value.hasRecoveryPhone ? 'קיים בפרופיל' : 'לא הוזן מספר'}
            </FactRow>
            <FactRow label="החברות שלך">
              {MEMBERSHIP_STATUS_LABEL[
                account.value.membershipStatus as MembershipStatus
              ] ?? account.value.membershipStatus}
              {account.value.joinedAt
                ? ` · מאז ${dateOf(account.value.joinedAt)}`
                : ''}
            </FactRow>
            <FactRow label="פעילות אחרונה שנרשמה">
              {account.value.lastActiveAt
                ? dateTimeOf(account.value.lastActiveAt)
                : 'לא נרשמה'}
            </FactRow>
          </dl>
        )}
      </Panel>

      {/* ---------------------------------------------------- sessions -- */}
      <Panel
        title="חיבורים פעילים וסיסמה"
        description="מה שאפשר לעשות כאן באמת, ומה שאי אפשר."
      >
        <PanelNote>
          <span className="font-semibold text-foreground">
            אין כאן רשימת מכשירים, ובכוונה.
          </span>{' '}
          החיבורים מנוהלים אצל ספק ההזדהות בסכימת{' '}
          <span dir="ltr" className="font-mono text-xs">
            auth
          </span>
          , שאינה חשופה ל־API של המוצר. כפתור ״נתק מכשיר״ כאן היה נראה עובד ולא
          עושה דבר, ולכן הוא לא קיים.
        </PanelNote>

        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-foreground">
            מה שכן מנתק כל חיבור אחר: החלפת סיסמה. לאחר עדכון מוצלח המוצר מנתק
            את כל שאר החיבורים ומשאיר רק את הדפדפן שבו בוצע השינוי — זו פעולה
            שקיימת בקוד ורצה בפועל, לא הבטחה.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button href="/forgot-password" variant="secondary">
              שליחת קישור להחלפת סיסמה
            </Button>
            <Button href="/account" variant="ghost">
              יציאה מהדפדפן הזה
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            אין במוצר מסך להגדרת גורם אימות שני, ולכן אין כאן מתג כזה. הדרישה
            עצמה נרשמת בשדה{' '}
            <span dir="ltr" className="font-mono text-xs">
              user_profiles.mfa_enforced_at
            </span>{' '}
            ומוצגת למעלה.
          </p>
        </div>
      </Panel>

      {/* -------------------------------------------------------- team -- */}
      <Panel
        title="מי יכול לפעול בארגון"
        description="חברות פעילה היא מה שפותח את הדלת: מסד הנתונים עצמו מחזיר רק ארגונים שבהם החברות פעילה, כך שמושהה או מוסר נחסמים ברמת השורה ולא ברמת המסך."
        count={members.ok && members.value ? members.value.length : undefined}
      >
        {!members.ok ? (
          <ActionError error={members.error} />
        ) : members.value === null ? (
          <PanelNote>
            רשימת חברי הארגון סגורה לך — נדרשת <GrantCode>user.view</GrantCode>.
            שאר המסך אינו תלוי בה.
          </PanelNote>
        ) : members.value.length === 0 ? (
          <PanelNote>אין חברויות רשומות בארגון הזה.</PanelNote>
        ) : (
          <>
            {coverage && (
              <p className="mb-4 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
                גורם אימות שני נדרש מ־
                <span className="font-semibold tabular-nums text-foreground">
                  {coverage.enforced}
                </span>{' '}
                מתוך {coverage.active} החברים הפעילים.
              </p>
            )}
            <RowList>
              {members.value.map((member) => (
                <MemberRow key={member.membershipId} member={member} />
              ))}
            </RowList>
          </>
        )}
      </Panel>

      {/* ------------------------------------------------- invitations -- */}
      <Panel
        title="הזמנות פתוחות"
        description="דרך כניסה לארגון שאיש עדיין לא מימש. כל אחת כזו היא גישה עתידית שכדאי לסקור."
        count={
          invitations.ok && invitations.value
            ? invitations.value.length
            : undefined
        }
      >
        {!invitations.ok ? (
          <ActionError error={invitations.error} />
        ) : invitations.value === null ? (
          <PanelNote>
            הזמנות פתוחות סגורות לך — נדרשת <GrantCode>user.view</GrantCode>, כי
            הן נושאות כתובות מייל.
          </PanelNote>
        ) : invitations.value.length === 0 ? (
          <PanelNote>
            אין הזמנה פתוחה. הטבלה קיימת וריקה — כלומר איש אינו מחזיק קישור
            הצטרפות שטרם מומש, ולא שלא הצלחנו לקרוא אותה.
          </PanelNote>
        ) : (
          <RowList>
            {invitations.value.map((invitation) => (
              <InvitationRow key={invitation.id} invitation={invitation} />
            ))}
          </RowList>
        )}
      </Panel>

      {/* ----------------------------------------------------- secrets -- */}
      <Panel
        title="מה המוצר מחזיק ולא יוצג כאן"
        description="לא ממוסך, לא חתוך, לא ארבע ספרות אחרונות. העמודות האלה אינן נשלפות מהמסד למסך הזה בכלל — ערך שלא יוצא מהמסד לא ידלוף גם דרך לוג, מטמון או תקלה."
      >
        {!secrets.ok ? (
          <ActionError error={secrets.error} />
        ) : (
          <div className="flex flex-col gap-5">
            {secrets.value.map((holding) => {
              const copy = SECRET_COPY[holding.key]
              return (
                <div
                  key={holding.key}
                  className="flex flex-col gap-1 border-b border-border pb-4 last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold text-foreground">
                      {copy.title}
                    </span>
                    <span
                      dir="ltr"
                      className="font-mono text-xs text-muted-foreground"
                    >
                      {copy.column}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{copy.body}</p>
                  {holding.count !== null && (
                    <p className="text-sm text-foreground">
                      <span className="tabular-nums font-semibold">
                        {holding.count}
                      </span>{' '}
                      {copy.countNoun}
                      {holding.newestAt
                        ? ` · העדכני ביותר נוצר ב־${dateOf(holding.newestAt)}`
                        : ''}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </ScreenFrame>
  )
}

/* ------------------------------------------------------------- plumbing -- */

type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReturnType<typeof toSafeResponse>['error'] }

async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (cause) {
    return {
      ok: false,
      error: toSafeResponse(cause, crypto.randomUUID()).error,
    }
  }
}

/**
 * How this person signs in, from the session rather than from a guess.
 *
 * `app_metadata.providers` is what the auth server says. In demo mode it reads
 * `demo`, which is true and is better than pretending it says `email`.
 */
function signInProviders(user: { app_metadata?: Record<string, unknown> }) {
  const raw = user.app_metadata?.providers
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.filter((entry) => typeof entry === 'string').join(', ')
  }
  const single = user.app_metadata?.provider
  return typeof single === 'string' ? single : 'לא ידוע'
}

function dateOf(instant: string): string {
  return new Date(instant).toLocaleDateString('he-IL')
}

function dateTimeOf(instant: string): string {
  return new Date(instant).toLocaleString('he-IL')
}

/* ----------------------------------------------------------------- rows -- */

function MemberRow({ member }: { member: MemberSecurity }) {
  const active = member.status === 'active'

  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold text-foreground">
            {member.fullName ?? 'משתמש ללא שם בפרופיל'}
          </span>
          <Badge tone={active ? 'brand' : 'neutral'}>
            {MEMBERSHIP_STATUS_LABEL[member.status as MembershipStatus] ??
              member.status}
          </Badge>
          {member.mfaEnforcedAt && <Badge tone="accent">גורם שני נדרש</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {member.roles.length > 0
            ? member.roles.join(' · ')
            : 'לא הוקצה תפקיד — ולכן אין הרשאות'}
          {' · '}
          {member.scopeKind
            ? (SCOPE_KIND_LABEL[member.scopeKind] ?? member.scopeKind)
            : 'לא הוגדר טווח'}
        </p>
      </div>

      <div className="shrink-0 text-end text-sm text-muted-foreground">
        {member.lastActiveAt
          ? `נראה לאחרונה ${dateOf(member.lastActiveAt)}`
          : 'לא נרשמה פעילות'}
      </div>
    </Row>
  )
}

function InvitationRow({ invitation }: { invitation: OutstandingInvitation }) {
  return (
    <Row>
      <div className="flex min-w-0 flex-col gap-1">
        <span dir="ltr" className="font-semibold text-foreground">
          {invitation.email}
        </span>
        <p className="text-sm text-muted-foreground">
          {invitation.invitedByName
            ? `הוזמן על ידי ${invitation.invitedByName}`
            : 'המזמין אינו זמין לצפייה'}
          {invitation.createdAt ? ` · ${dateOf(invitation.createdAt)}` : ''}
        </p>
      </div>

      <div className="shrink-0 text-end text-sm">
        {invitation.expired ? (
          <span className="font-semibold text-muted-foreground">
            פגה ב־{dateOf(invitation.expiresAt)} — אינה ניתנת למימוש
          </span>
        ) : (
          <span className="font-semibold text-danger">
            תקפה עד {dateOf(invitation.expiresAt)}
          </span>
        )}
      </div>
    </Row>
  )
}
