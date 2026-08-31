import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { OwnerList } from '@/components/finance/owner-list'
import { PlanLock } from '@/components/finance/plan-lock'
import { EmptyState } from '@/components/states/empty-state'
import { authorize } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { listOwners, type OwnerListItem } from '../_lib/queries'
import { financeRepository } from '../_lib/wiring'

export const metadata: Metadata = { title: 'בעלי נכסים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. External property owners and their
 * statements.
 *
 * ── THE PLAN LOCK IS THE POINT, AND IT MUST READ AS ONE ──────────────────
 *
 * Every grant in the owner family — `owner.view`, `owner.manage`,
 * `owner_statement.view`, `owner_statement.issue`, `owner.view_commission` — is
 * mapped to the `owner_portal` entitlement in `ENTITLEMENT_FOR_GRANT`. On a
 * package that does not include it, nobody in the business holds any of them,
 * however their role is composed.
 *
 * `requireGrant('owner_statement.view')` would therefore be *correct* and would
 * read wrong: `authorize()` distinguishes `missing_permission` from
 * `plan_does_not_include`, and `guard.ts` collapses both into the same redirect
 * to the dashboard, whose banner says "המסך שביקשת דורש הרשאה שאין לך". That
 * sentence sends a finance manager to ask their administrator for a permission
 * that cannot exist on their plan, and the administrator finds no toggle.
 *
 * So the two halves are asked separately and neither is skipped.
 * `requireGrant('finance.view')` is the permission floor — `finance.view`
 * carries no entitlement, so its refusal is always about the role — and the
 * plan half is asked here with `authorize`, which names the missing feature.
 * The reasons are read from the engine rather than inferred; there is no second
 * rule about the owner portal anywhere in this file.
 *
 * ── WHAT AN OWNER IS, IN THIS SCHEMA ─────────────────────────────────────
 *
 * There is no `owners` table and no `owner_statements` table. An external owner
 * is a membership holding the `property_owner` role, scoped to the properties
 * they own, and that is what `listOwners` reads. A statement is a document the
 * schema cannot yet store, so the screen says it has not been issued and
 * explains what it would be built from, rather than rendering a document nobody
 * produced.
 *
 * REDACTION. The owner's name and email are withheld without `user.view`. The
 * properties are still named, because which properties the business manages for
 * an external owner is not the owner's personal data.
 */
export default async function OwnersPage() {
  const [actor, context] = await Promise.all([
    requireGrant('finance.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  // Asked of the engine, not decided here. `authorize` reports the plan
  // refusal separately from the permission one, which is the whole reason this
  // screen can tell a locked feature from a role that is missing a grant.
  const decision = authorize(actor, 'owner_statement.view', {
    organizationId: actor.organizationId,
    family: 'finance',
  })

  const locked =
    !decision.allowed && decision.reason === 'plan_does_not_include'

  let owners: readonly OwnerListItem[] = []
  let failure: ReturnType<typeof toSafeResponse> | null = null

  if (decision.allowed) {
    try {
      const { db } = await financeRepository()
      owners = await listOwners({
        db,
        actor,
        organizationId: actor.organizationId,
      })
    } catch (cause) {
      failure = toSafeResponse(cause, crypto.randomUUID())
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          בעלי נכסים
        </h1>
        <p className="max-w-prose text-muted-foreground">
          נכס שמנוהל עבור בעלים חיצוני מייצר שני דברים שאין להם קיצור דרך: גישה
          מוגבלת שמראה לו את הנכס שלו בלבד, ודוח תקופתי שמסביר מאיפה הגיע הסכום
          שהועבר אליו.
        </p>
      </header>

      {locked ? (
        <PlanLock
          entitlement="owner_portal"
          title="פורטל הבעלים אינו כלול בחבילה הנוכחית"
          body="זו אינה שאלה של הרשאה. כל ההרשאות שקשורות לבעלי נכסים — צפייה, ניהול, והפקת דוח — פתוחות רק בחבילה שכוללת את פורטל הבעלים, ולכן אף תפקיד בארגון לא יוכל לפתוח את המסך הזה עד שהחבילה תשתנה."
          includes={[
            'גישה נפרדת לכל בעלים, שרואה את הנכס שלו בלבד — לא הזמנות של נכסים אחרים ולא נתוני הארגון',
            'דוח בעלים תקופתי: הכנסה, ההוצאות שיוחסו לנכס, וחלק הבעלים לפי המפתח שהוקפא על כל הזמנה',
            'הפקה וסגירה של הדוח כמסמך, כך ששתי גרסאות לאותה תקופה אינן אפשריות',
          ]}
        />
      ) : !decision.allowed ? (
        // Held the plan, not the grant. A different sentence, and it names what
        // is actually missing rather than pointing at the package.
        <EmptyState
          illustration="team"
          title="אין לך הרשאה לצפות בבעלי הנכסים"
          body="החבילה של הארגון כוללת את פורטל הבעלים, אבל התפקיד שלך אינו כולל את ההרשאה owner_statement.view. מנהל בארגון יכול להוסיף אותה."
        />
      ) : failure ? (
        <ActionError error={failure.error} />
      ) : owners.length === 0 ? (
        <EmptyState
          illustration="team"
          title="אין בארגון בעלי נכסים חיצוניים"
          body="בעלים חיצוני הוא חבר בארגון שמחזיק את התפקיד ״בעל נכס״ ומוגבל לנכסים שלו. כשיתווסף אחד, הוא יופיע כאן עם הנכסים שבבעלותו והדוחות שהופקו לו."
        />
      ) : (
        <>
          <p
            role="status"
            className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground"
          >
            {owners.length === 1
              ? 'בעלים חיצוני אחד'
              : `${owners.length} בעלים חיצוניים`}
            . הרשימה נקראת מהחברויות בארגון ומהטווח שלהן, ולא מטבלה נפרדת של
            בעלים — כך שהגישה שמוצגת כאן היא בדיוק הגישה שהמערכת אוכפת.
          </p>

          <OwnerList owners={owners} />
        </>
      )}
    </div>
  )
}
