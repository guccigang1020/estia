import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { firstParam, type SearchParams } from '@/app/(auth)/_lib/search-params'
import { DoneStep } from '@/components/onboarding/done-step'
import { OrganizationStep } from '@/components/onboarding/organization-step'
import { PropertyStep } from '@/components/onboarding/property-step'
import { Stepper } from '@/components/onboarding/stepper'
import { UnitStep } from '@/components/onboarding/unit-step'
import { EmptyState } from '@/components/states/empty-state'
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createClient } from '@/lib/supabase/server'

import { requireContext } from '../_lib/guard'
import { loadProgress } from './_lib/queries'
import { isPropertyType, safeNextPath } from './_lib/schema'
import { strategy } from './_lib/signup'

export const metadata: Metadata = { title: 'הצטרפות' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The way into the product.
 *
 * WHY THIS ROUTE IS GATED ON NOTHING BUT A SESSION. Every other route under
 * the shell calls `requireGrant()`, and this one cannot: a person with no
 * workspace holds no grants anywhere, because grants are resolved through a
 * membership and they have none. `requireContext()` — a verified session — is
 * therefore the correct and only available gate here, and the actions below
 * refuse on their own terms regardless of what this page renders.
 *
 * WHICH STEP. Derived from the database on every request, never from a cookie
 * or from client state: no workspace → the organization; a workspace with no
 * property → the property; a property with no unit → the unit; otherwise the
 * handover. Refresh, the back button and a second device all agree, and an
 * abandoned signup resumes where it stopped instead of creating a second
 * organization.
 *
 * WHY IT CAN REFUSE BEFORE SHOWING A FORM. Creating an organization needs a
 * privileged path — `signup.ts` says why at length — and a deployment that has
 * neither `DATABASE_URL` nor a service role key cannot do it at all. Rendering
 * the form anyway would put somebody through four fields to reach a failure
 * that was knowable before they typed the first one.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [context, params] = await Promise.all([requireContext(), searchParams])
  const next = safeNextPath(firstParam(params.next))

  /* ------------------------------------------------- step one: no workspace */

  if (context.status === 'no_workspace') {
    if (strategy() === 'unavailable') {
      return (
        <Shell step="organization" next={next}>
          <EmptyState
            as="h2"
            illustration="property"
            title="לא ניתן ליצור מרחב עבודה בשרת הזה"
            body="יצירת ארגון היא הפעולה היחידה שכללי הבידוד בבסיס הנתונים אינם יכולים לאשר בעצמם, ולכן היא דורשת הגדרת שרת שחסרה כאן. פנה למנהל המערכת — אף נתון לא נשמר, ואין צורך לנסות שוב עד שההגדרה תתווסף."
          />
        </Shell>
      )
    }

    return (
      <Shell step="organization" next={next}>
        <Card>
          <CardHeader>
            <CardTitle as="h2">פרטי העסק</CardTitle>
            <CardDescription>
              זה הרגע שבו נוצר הארגון, החברות שלך בו כבעלים והמנוי — יחד, כפעולה
              אחת. אם משהו באמצע נכשל, שום דבר מהם לא נשאר.
            </CardDescription>
          </CardHeader>
          <div className="mt-6">
            <OrganizationStep />
          </div>
        </Card>
      </Shell>
    )
  }

  /* --------------------------------------- a workspace that cannot be used */

  if (context.status !== 'ready') {
    // A suspended membership or a missing subscription is not something a
    // signup wizard can repair, and pretending otherwise would send somebody
    // round a loop. The dashboard states what is wrong.
    redirect('/dashboard')
  }

  const progress = await loadProgress(context.actor.organizationId)

  /* ------------------------------------------------ already past onboarding */

  const supabase = await createClient()
  const { data: organization } = await supabase
    .from('organizations')
    .select('status, business_type')
    .eq('id', context.actor.organizationId)
    .maybeSingle()

  if (organization?.status === 'active' && progress.step === 'done') {
    // Finished. This route is a way in, not a place to live.
    redirect(next ?? '/dashboard')
  }

  const businessType = organization?.business_type
  const suggestedPropertyType = isPropertyType(businessType)
    ? businessType
    : 'other'

  /* ------------------------------------------------------ steps two to four */

  if (progress.step === 'property') {
    return (
      <Shell step="property" next={next}>
        <Card>
          <CardHeader>
            <CardTitle as="h2">הנכס הראשון</CardTitle>
            <CardDescription>
              הנכס הוא המקום עצמו — הכתובת, שעות הכניסה והיציאה ומדיניות הביטול.
              היחידות שנמכרות יושבות בתוכו.
            </CardDescription>
          </CardHeader>
          <div className="mt-6">
            <PropertyStep suggestedType={suggestedPropertyType} />
          </div>
        </Card>
      </Shell>
    )
  }

  if (progress.step === 'unit' && progress.propertyId) {
    return (
      <Shell step="unit" next={next}>
        <Card>
          <CardHeader>
            <CardTitle as="h2">היחידה הראשונה</CardTitle>
            <CardDescription>
              יחידה היא מה שנמכר בפועל, והיומן מוכרע לפיה. בלי יחידה אחת לפחות,
              מסך ההזמנות לא יוכל להציג שורה.
            </CardDescription>
          </CardHeader>
          <div className="mt-6">
            <UnitStep
              propertyId={progress.propertyId}
              propertyName={progress.propertyName}
            />
          </div>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell step="done" next={next}>
      <Card tone="featured">
        <CardHeader>
          <CardTitle as="h2">הכול מוכן</CardTitle>
          <CardDescription>
            נותר רק לסמן את ההצטרפות כהושלמה ולעבור לעבודה.
          </CardDescription>
        </CardHeader>
        <div className="mt-6">
          <DoneStep
            workspaceName={context.workspace.name}
            propertyName={progress.propertyName}
            next={next}
          />
        </div>
      </Card>
    </Shell>
  )
}

/* ---------------------------------------------------------------- frame -- */

function Shell({
  step,
  next,
  children,
}: {
  step: 'organization' | 'property' | 'unit' | 'done'
  next: string | null
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          נתחיל לעבוד
        </h1>
        <p className="max-w-prose text-muted-foreground">
          ארבעה שלבים קצרים, וכל אחד נשמר בנפרד. אפשר לעצור באמצע ולחזור — נמשיך
          בדיוק מהמקום שבו הפסקת.
        </p>
        {next && (
          <p className="text-sm text-muted-foreground">
            בסיום נחזיר אותך לדף שביקשת.
          </p>
        )}
      </header>

      <Stepper current={step} />

      {children}
    </div>
  )
}
