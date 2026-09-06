import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import type { SearchParams } from '@/app/(auth)/_lib/search-params'
import { ActionError } from '@/components/booking/action-error'
import { DomainGap, GrantCode } from '@/components/shell-screens/domain-gap'
import {
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import {
  GUEST_BOOK_ENTRY_STATUSES,
  GUEST_BOOK_FIELD_LABEL,
  GUEST_BOOK_STATUS_LABEL,
  effectiveRequiredFields,
} from '@/lib/guest-book'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { RegisterTable } from './_components/register-table'
import {
  GUEST_BOOK_TABLES,
  loadGuestBook,
  parseGuestBookFilter,
} from './_lib/queries'

export const metadata: Metadata = { title: 'ספר אורחים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The register of stays.
 *
 * ══ THIS SCREEN CLAIMS NOTHING ABOUT COMPLIANCE ════════════════════════════
 *
 * Not in a heading, not in a help sentence, not in a tooltip. The exact fields
 * a particular hospitality business must record have not been externally
 * verified for this product, so the register is presented as what it actually
 * is: a configurable record the business keeps, whose required fields the
 * business chooses. The panel below says in as many words that establishing
 * what their own business must record is the operator's responsibility.
 *
 * That sentence is the honest one and it is also the useful one. A screen that
 * implied ESTIA had settled the question would leave an owner believing they
 * were covered by a checkbox an engineer chose.
 *
 * ══ OFF IS A COMPLETE STATE ════════════════════════════════════════════════
 *
 * The capability is off by default and most businesses will leave it off. Off
 * renders as an explanation, not as an empty table — an empty table would read
 * as "you have had no guests", which is both false and alarming.
 *
 * ══ GATING, AND A GAP NAMED RATHER THAN WORKED AROUND ══════════════════════
 *
 * `requireGrant('guest.view')` refuses the route today, `can()` re-checks every
 * row against its property, `redact()` withholds the name without
 * `guest.view_name`, and row level security refuses regardless of all three.
 *
 * `guest_book.view` and `guest_book.manage` are the grants this screen should
 * have — reading the historical register and reading today's arrivals are
 * genuinely different rights, and an accountant needs one without the other.
 * They are not in `src/lib/authz/permissions.ts`, which this worker may not
 * edit, so they are reported for the coordinator to add rather than invented
 * here. `guest.view` is the closest existing grant and is a strict
 * prerequisite either way, so gating on it is narrower than the final answer
 * and never wider.
 */
export default async function GuestBookPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('guest.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  const filter = parseGuestBookFilter(params)

  let screen
  try {
    screen = await loadGuestBook(
      await createClient(),
      actor,
      context.actor.organizationId,
      filter,
    )
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="ספר אורחים" lead="">
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  if (screen.state === 'not_provisioned') {
    return (
      <ScreenFrame
        title="ספר אורחים"
        lead="רישום השהיות שהעסק בוחר לנהל."
        width="shell"
      >
        <DomainGap
          title="אחסון ספר האורחים עדיין לא קיים במסד הנתונים"
          body={
            <p>
              המודול בנוי: הוא יודע לייצר רישום ממחזור החיים של הזמנה, ולהחזיק
              את רשימת השדות שהעסק בחר לדרוש. מה שחסר הוא הטבלאות עצמן. עד
              שייווצרו, המסך אומר זאת במפורש ולא מציג טבלה ריקה — טבלה ריקה
              הייתה נקראת כאילו לא היו אורחים.
            </p>
          }
          missingTables={GUEST_BOOK_TABLES}
          alreadyBuilt={[
            <>
              המודול <GrantCode>src/lib/guest-book</GrantCode> על כל בדיקותיו
            </>,
            <>
              ההרשאות <GrantCode>guest.view</GrantCode> ו־
              <GrantCode>guest.view_name</GrantCode> ששומרות על המסך ועל השם
            </>,
            <>המסך הזה, שיתמלא ביום שבו ההגירה תרוץ</>,
          ]}
        />
      </ScreenFrame>
    )
  }

  const view = screen.data
  const canSeeName = holdsGrant(actor, 'guest.view_name')
  const required = effectiveRequiredFields(view.config)

  if (!view.config.enabled) {
    return (
      <ScreenFrame
        title="ספר אורחים"
        lead="רישום השהיות שהעסק בוחר לנהל."
        width="prose"
      >
        <Panel
          title="ניהול ספר אורחים כבוי"
          description="זהו מצב תקין ומלא. עסק שאינו מנהל ספר אורחים אינו מקבל רישומים ואינו נדרש לשדות נוספים בשום מסך אחר."
        >
          <PanelNote>
            כשמפעילים את היכולת, כל הזמנה שמאושרת תיצור רישום, והוא יתעדכן בהגעה
            ובעזיבה. באחריות בית העסק לוודא מה עליו לתעד בפועל ולהגדיר את השדות
            הנדרשים בהתאם — המערכת אינה קובעת זאת עבורו.
          </PanelNote>
        </Panel>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      title="ספר אורחים"
      lead="כל שהייה שנרשמה, לפי תאריך הגעה. השדות הנדרשים הם הגדרה של בית העסק."
      banner={<FilterBar filter={view.filter} />}
    >
      <Panel
        title="השדות שהוגדרו כנדרשים"
        description="ההגדרה הזו היא בחירה של בית העסק. באחריותכם לוודא מה עליכם לתעד בפועל; המערכת אינה קובעת זאת עבורכם."
      >
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {required.map((field) => (
            <li key={field}>{GUEST_BOOK_FIELD_LABEL[field]}</li>
          ))}
        </ul>

        {view.config.fieldsReviewedAt === null && (
          <PanelNote>
            אף אחד עדיין לא אישר שהשדות האלה נבדקו מול הצרכים של בית העסק.
          </PanelNote>
        )}
      </Panel>

      <Panel
        title="הרישומים"
        count={view.entries.length}
        action={
          <Button href={exportHref(view.filter)} variant="secondary">
            ייצוא לקובץ
          </Button>
        }
      >
        {view.entries.length === 0 ? (
          <PanelNote>אין רישומים שתואמים את הסינון הנוכחי.</PanelNote>
        ) : (
          <>
            <RegisterTable entries={view.entries} canSeeName={canSeeName} />
            {view.truncated && (
              <PanelNote>
                {`מוצגים ${view.entries.length} הרישומים האחרונים. צמצמו את טווח התאריכים כדי לראות תקופה מוקדמת יותר.`}
              </PanelNote>
            )}
          </>
        )}
      </Panel>
    </ScreenFrame>
  )
}

/**
 * The filter, as links rather than as a form.
 *
 * Server-rendered anchors mean no Client Component on this screen at all, and
 * a filtered register that a person can bookmark and send to their accountant.
 */
function FilterBar({
  filter,
}: {
  filter: ReturnType<typeof parseGuestBookFilter>
}) {
  const base = '/guest-book'
  const query = (status: string | null): string => {
    const params = new URLSearchParams()
    if (filter.propertyId !== null) params.set('property', filter.propertyId)
    if (filter.from !== null) params.set('from', filter.from)
    if (filter.to !== null) params.set('to', filter.to)
    if (status !== null) params.set('status', status)
    const search = params.toString()
    return search === '' ? base : `${base}?${search}`
  }

  return (
    <nav
      aria-label="סינון הרישומים"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <a
        href={query(null)}
        className={
          filter.status === null ? 'font-semibold' : 'text-muted-foreground'
        }
      >
        הכול
      </a>
      {GUEST_BOOK_ENTRY_STATUSES.map((status) => (
        <a
          key={status}
          href={query(status)}
          className={
            filter.status === status ? 'font-semibold' : 'text-muted-foreground'
          }
        >
          {GUEST_BOOK_STATUS_LABEL[status]}
        </a>
      ))}
    </nav>
  )
}

/** The export carries the active filter, so the file matches the screen. */
function exportHref(filter: ReturnType<typeof parseGuestBookFilter>): string {
  const params = new URLSearchParams()
  if (filter.propertyId !== null) params.set('property', filter.propertyId)
  if (filter.status !== null) params.set('status', filter.status)
  if (filter.from !== null) params.set('from', filter.from)
  if (filter.to !== null) params.set('to', filter.to)
  const search = params.toString()
  return search === '' ? '/guest-book/export' : `/guest-book/export?${search}`
}
