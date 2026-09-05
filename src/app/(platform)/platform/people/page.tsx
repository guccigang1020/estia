import type { Metadata } from 'next'

import Link from 'next/link'

import {
  ConsoleNotice,
  ConsolePage,
  ConsoleTable,
} from '@/components/platform/console-chrome'
import { hebrewDate } from '@/components/platform/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toLogEntry } from '@/lib/errors'
import {
  MINIMUM_QUERY_LENGTH,
  PEOPLE_PAGE_SIZE,
  searchPeople,
  type PeopleSearch,
} from '@/lib/platform'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../../_lib/guard'

export const metadata: Metadata = { title: 'אנשים · קונסולת ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Finding a person across organizations.
 *
 * ══ THIS IS THE SCREEN MOST LIKELY TO LEAK, AND IT IS BUILT AROUND THAT ═══
 *
 * Every other console screen starts from an organization. This one starts from
 * a person and crosses tenants on purpose, because the support call it exists
 * for begins "someone rang, they cannot get in, they think their company is
 * called something like…".
 *
 * Three rules, all of them in the code rather than in a policy document:
 *
 *   1. **Nothing is read until something is asked.** With no query the page
 *      shows a form and makes no database call at all. Not the first page of
 *      everybody — nothing. Listing the entire user base is not a support
 *      action, and there is no screen state in which somebody meant to ask for
 *      it.
 *   2. **The result says when it was truncated.** A search that quietly cuts
 *      off teaches its reader that the person is not in the system.
 *   3. **The disclosure is name, phone, and where they are a member.** Not
 *      their email — `auth.users` is not opened by 0041 and is not read
 *      anywhere in this module. Not anything they did: a person's bookings and
 *      messages are their employer's records and no policy lets ESTIA staff
 *      near them.
 *
 * The justification is one thing, checked in one place:
 * `has_platform_permission('platform.organization.view')` inside the policies.
 * There is no membership fallback in this file or in the module behind it.
 *
 * ── Suspended and removed memberships are shown ───────────────────────────
 *
 * Deliberately. "I was removed and nobody told me" is one of the two calls
 * this screen answers, and a list filtered to active memberships answers it
 * with an empty result that reads as "you were never here".
 */
export default async function PlatformPeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requirePlatformGrant('platform.organization.view')

  const { q } = await searchParams
  const query = (q ?? '').trim()

  let result: PeopleSearch | null = null
  let failure: string | null = null

  if (query !== '') {
    const correlationId = crypto.randomUUID()
    try {
      result = await searchPeople(await createClient(), query)
    } catch (error) {
      console.error(toLogEntry(error, correlationId))
      failure = correlationId
    }
  }

  return (
    <ConsolePage
      title="אנשים"
      lede="חיפוש אדם לפי שם או טלפון, וההצגה של כל הארגונים שהוא חבר בהם. המסך הזה חוצה לקוחות בכוונה — וזו הסיבה שהוא לא קורא כלום עד ששואלים אותו משהו."
    >
      <form
        className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-5 shadow-soft"
        method="get"
      >
        <label className="flex min-w-64 flex-1 flex-col gap-1.5 text-sm">
          <span className="font-medium">שם או טלפון</span>
          <input
            name="q"
            defaultValue={query}
            minLength={MINIMUM_QUERY_LENGTH}
            placeholder="לפחות שתי אותיות"
            className="rounded-lg border border-border-strong bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </label>
        <Button type="submit">חיפוש</Button>
      </form>

      {failure !== null && (
        <ConsoleNotice title="החיפוש נכשל" tone="warning">
          לא ניתן היה לקרוא. אין להסיק מכך שהאדם אינו במערכת. מזהה מעקב:{' '}
          <code dir="ltr">{failure}</code>
        </ConsoleNotice>
      )}

      {result === null && failure === null && (
        <ConsoleNotice title="לא בוצעה עדיין שאילתה">
          הדף לא פנה למסד הנתונים. חיפוש ריק אינו מציג את כל המשתמשים — הצגה של
          כל בסיס המשתמשים אינה פעולת תמיכה, ואין מצב מסך שבו מישהו התכוון לבקש
          אותה.
        </ConsoleNotice>
      )}

      {result?.outcome === 'query_too_short' && (
        <ConsoleNotice title="השאילתה קצרה מדי">
          נדרשות לפחות {MINIMUM_QUERY_LENGTH} אותיות. לא בוצעה קריאה למסד
          הנתונים.
        </ConsoleNotice>
      )}

      {result?.outcome === 'results' && (
        <>
          {result.truncated && (
            <ConsoleNotice title="הרשימה נחתכה" tone="warning">
              מוצגות {PEOPLE_PAGE_SIZE} התוצאות הראשונות, ויש יותר. חידוד החיפוש
              עדיף על גלילה — רשימה שנחתכת בשקט מלמדת את הקורא שהאדם אינו קיים.
            </ConsoleNotice>
          )}

          {result.people.length === 0 ? (
            <ConsoleNotice title="אין תוצאות">
              אין פרופיל שתואם ל-&quot;{query}&quot;. שים לב:{' '}
              <code dir="ltr">user_profiles</code> אינו מכיל כתובות דוא״ל — הן
              חיות בסכימת <code dir="ltr">auth</code>, שאינה נקראת מכאן — ולכן
              חיפוש לפי דוא״ל לא יימצא גם אם האדם קיים.
            </ConsoleNotice>
          ) : (
            <ConsoleTable
              caption="אנשים ומקומות החברות שלהם"
              head={['אדם', 'טלפון', 'ארגון', 'מצב חברות', 'תפקידים', 'הצטרף']}
            >
              {result.people.flatMap((person) =>
                person.memberships.length === 0
                  ? [
                      <tr key={person.userId}>
                        <td className="px-4 py-3">
                          {person.displayName ?? (
                            <code dir="ltr" className="text-xs">
                              {person.userId}
                            </code>
                          )}
                        </td>
                        <td className="px-4 py-3" dir="ltr">
                          {person.phone ?? '—'}
                        </td>
                        <td
                          className="px-4 py-3 text-muted-foreground"
                          colSpan={4}
                        >
                          אין חברות באף ארגון. יש חשבון, ואין מקום עבודה — בדרך
                          כלל הרשמה שלא הושלמה או הזמנה שלא נענתה.
                        </td>
                      </tr>,
                    ]
                  : person.memberships.map((membership, index) => (
                      <tr key={`${person.userId}:${membership.membershipId}`}>
                        <td className="px-4 py-3">
                          {index === 0 ? (
                            (person.displayName ?? (
                              <code dir="ltr" className="text-xs">
                                {person.userId}
                              </code>
                            ))
                          ) : (
                            <span className="text-muted-foreground">↳</span>
                          )}
                        </td>
                        <td className="px-4 py-3" dir="ltr">
                          {index === 0 ? (person.phone ?? '—') : ''}
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/platform/organizations/${membership.organizationId}`}
                            className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            {membership.organizationName}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            tone={
                              membership.status === 'active'
                                ? 'neutral'
                                : 'accent'
                            }
                          >
                            {membership.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {membership.roles.length > 0
                            ? membership.roles.join(', ')
                            : '—'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          {hebrewDate(membership.joinedAt)}
                        </td>
                      </tr>
                    )),
              )}
            </ConsoleTable>
          )}
        </>
      )}
    </ConsolePage>
  )
}
