import type { Metadata } from 'next'

import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { CaseTable } from '@/components/incidents/case-table'
import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'
import { ScreenFrame } from '@/components/shell-screens/screen'
import { EmptyState } from '@/components/states/empty-state'
import { Button } from '@/components/ui/button'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { CASE_TABLES, loadCaseRegister } from './_lib/queries'

export const metadata: Metadata = { title: 'תיקי נזק' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The damage case register.
 *
 * ── Why this is a second register beside `/incidents` ─────────────────────
 *
 * `/incidents` is the fault register: things that are broken. It reads
 * `public.tasks`, a cleaner can write to it in ten seconds from a landing, and
 * the question it answers is "has anybody picked this up".
 *
 * This is the case register: faults that cost money. It reads its own tables,
 * and the question it answers is "who is being waited on, and for how long".
 * They are not the same list with different columns — a fault becomes a case
 * only when there is something to settle, and most faults never do.
 *
 * ── The tables may not exist yet ──────────────────────────────────────────
 *
 * They are created by a migration this worker does not write. Until it runs the
 * screen renders `DomainGap` naming the seven, never an empty list — an empty
 * list would tell a business that the capability works and that they have never
 * had a damage case, which is the opposite of what is true.
 *
 * GATING. `requireGrant('incident.view')` refuses the route; the same grant is
 * checked per row against the property in `_lib/queries.ts`; row level security
 * refuses regardless of both. There is no money on this screen at all — see
 * `components/incidents/case-table.tsx`.
 */
export default async function CasesPage() {
  const [actor, context] = await Promise.all([
    requireGrant('incident.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId
  const propertyName =
    propertyId === null
      ? null
      : (context.properties.find((property) => property.id === propertyId)
          ?.name ?? null)

  let screen
  try {
    screen = await loadCaseRegister({
      db: await createClient(),
      actor,
      organizationId: context.workspace.organizationId,
      propertyId,
      now: new Date(),
    })
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="תיקי נזק" lead="">
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  const lead = propertyName
    ? `תיקי הנזק, האובדן והמחלוקות ב״${propertyName}״.`
    : 'תיקי הנזק, האובדן והמחלוקות בכל הנכסים שבטווח שלך.'

  if (screen.state === 'not_provisioned') {
    return (
      <ScreenFrame title="תיקי נזק" lead={lead} width="prose">
        <DomainGap
          title="אחסון תיקי הנזק עדיין לא קיים במסד הנתונים"
          body={
            <p>
              המודול בנוי: הוא יודע לתאר תיק, לצרף אליו ראיות בהפניה בלבד, לסרב
              לסגור תיק שיש בו שאלה פתוחה או כסף שאיש לא הכריע לגביו, ולחשב מה
              היה קורה לפיקדון — בלי לגעת בו. מה שחסר הוא הטבלאות עצמן. עד
              שייווצרו המסך לא יציג רשימה ריקה, כי רשימה ריקה הייתה אומרת שלעסק
              הזה לא היה מעולם נזק.
            </p>
          }
          missingTables={CASE_TABLES}
          alreadyBuilt={[
            <>
              המודול <GrantCode>src/lib/incidents</GrantCode> על כל בדיקותיו
            </>,
            <>
              ההרשאות <GrantCode>incident.view</GrantCode>,{' '}
              <GrantCode>incident.update</GrantCode> ו־
              <GrantCode>incident.resolve</GrantCode> שכבר שומרות על המסכים האלה
            </>,
            <>
              דיווח תקלה שכבר עובד היום דרך{' '}
              <GrantCode>incident.create</GrantCode> ופותח משימת תחזוקה — תיק
              נזק נפתח עליו, ולא במקומו
            </>,
            <>המסכים האלה — הם יתמלאו ביום שבו ההגירה תרוץ, ללא שינוי קוד</>,
          ]}
        />
      </ScreenFrame>
    )
  }

  const { rows, reachable } = screen.data
  const waiting = rows.filter((row) => row.waiting)

  return (
    <ScreenFrame
      title="תיקי נזק"
      lead={`${lead} ${reachable === 1 ? 'תיק אחד סה״כ' : `${reachable} תיקים סה״כ`}.`}
      banner={
        <nav aria-label="פירורי לחם" className="text-sm">
          <Link
            href="/incidents"
            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            ← לרשימת התקלות
          </Link>
        </nav>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          illustration="task"
          title="אין תיקי נזק"
          body="תיק נזק נפתח כשמשהו נשבר, נעלם או נשרף ויש על כך מה לברר — מי אחראי, כמה זה עולה, ומה קורה עם הפיקדון. רוב התקלות אינן מגיעות לכאן, וזה בסדר."
          action={
            <Button href="/incidents" variant="secondary">
              לרשימת התקלות
            </Button>
          }
        />
      ) : (
        <>
          {waiting.length > 0 && (
            <p
              // `alert`: a case waiting on somebody outside the business is the
              // state this register exists to expose. The deposit is released
              // on schedule whether or not the vendor ever quoted.
              role="alert"
              className="rounded-lg border border-danger bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="font-semibold text-danger">
                {waiting.length === 1
                  ? 'תיק אחד ממתין לתשובה'
                  : `${waiting.length} תיקים ממתינים לתשובה`}
              </span>{' '}
              — מאורח, מספק או לאישור. תיק שממתין ואיש אינו רודף אחריו נסגר בסוף
              מעצמו, והפיקדון כבר שוחרר.
            </p>
          )}

          <CaseTable
            rows={rows}
            caption="תיקי הנזק שבטווח שלך, הוותיקים ביותר תחילה"
          />
        </>
      )}
    </ScreenFrame>
  )
}
