import type { Metadata } from 'next'

import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { MergeForm, type MovingCount } from '@/components/guests/merge-form'
import { UndoMergeControl } from '@/components/guests/undo-merge'
import { GrantCode } from '@/components/shell-screens/domain-gap'
import {
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { holdsGrant } from '@/lib/authz/can'
import { toSafeResponse } from '@/lib/errors'
import { conflictsBetween, type MergeableGuest } from '@/lib/leads'
import {
  asNumber,
  asString,
  asStringOrNull,
  toRows,
  type Db,
} from '@/lib/persistence'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  DUPLICATE_SCAN_SIZE,
  duplicateScanWasTruncated,
  findDuplicateCandidates,
} from '../_lib/duplicates'
import { MOVED_TABLE_LABEL, listRecentMerges } from './_lib/history'

export const metadata: Metadata = { title: 'מיזוג פרופילי אורח' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Two rows that might be one person.
 *
 * ══ THE PRODUCT PROPOSES; A PERSON DECIDES ══════════════════════════════════
 *
 * 🔒 Nothing on this screen merges anything on its own, and nothing ever will.
 * ח40-09: a score above 0.85 produces a SUGGESTION and no more, because two
 * guests sharing a telephone number are frequently a family, and a business
 * that finds two stays merged onto the wrong person has lost the history of
 * both. §12.3 is explicit that the model does not run this either — the score
 * is a deterministic formula in `src/lib/leads/matching.ts` precisely so that a
 * decision which mixes two people's money can be reproduced and checked.
 *
 * ══ WHAT IS ALREADY IMPOSSIBLE, AND SO IS NOT LOOKED FOR ════════════════════
 *
 * `guests_organization_phone_idx` forbids two live guests from sharing a
 * normalised telephone number, so the strongest duplicate signal cannot occur.
 * `_lib/duplicates.ts` sets out what is left — a shared email, a telephone
 * whose last seven digits agree, a close name — and why a name alone can never
 * cross a threshold.
 *
 * GATING. `requireGrant('guest.view')` refuses the route: a list of "these two
 * are probably one person" is a summary of the customer list. The merge itself
 * needs `guest.update` AND `guest.delete` together (ח40-19), so the form is
 * shown only to somebody holding both — and refused again in the action, in
 * the operation, and inside the SECURITY DEFINER function.
 *
 * TWO MODES, ONE ROUTE. With no query parameters this lists candidates. With
 * `?survivor=…&merged=…` it is the two-column screen for that one pair. A
 * separate route would have been tidier and would also have meant a second
 * place to keep the gating right.
 */
export default async function MergeGuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ survivor?: string; merged?: string }>
}) {
  const [actor, context, params] = await Promise.all([
    requireGrant('guest.view'),
    shellContext(),
    searchParams,
  ])

  if (!context || context.status !== 'ready') return null

  const mayMerge =
    holdsGrant(actor, 'guest.update') && holdsGrant(actor, 'guest.delete')
  const db = await createClient()

  /* ---------------------------------------------------------- one pair -- */

  if (params.survivor && params.merged && params.survivor !== params.merged) {
    if (!mayMerge) {
      return (
        <ScreenFrame title="מיזוג פרופילי אורח" lead="הפעולה הזאת סגורה בפניך.">
          <PanelNote tone="attention">
            מיזוג פרופילים דורש גם <GrantCode>guest.update</GrantCode> וגם{' '}
            <GrantCode>guest.delete</GrantCode> — כי הוא עושה את שני הדברים האלה
            יחד. אין לך את שתיהן.
          </PanelNote>
        </ScreenFrame>
      )
    }

    const pair = await settle(() =>
      loadPair(db, actor.organizationId, params.survivor!, params.merged!),
    )

    if (!pair.ok) {
      return (
        <ScreenFrame
          title="מיזוג פרופילי אורח"
          lead="לא ניתן לטעון את הפרופילים."
        >
          <ActionError error={pair.error} />
        </ScreenFrame>
      )
    }

    if (pair.value === null) {
      return (
        <ScreenFrame title="מיזוג פרופילי אורח" lead="אחד הפרופילים לא נמצא.">
          <PanelNote>
            אחד משני הפרופילים אינו קיים בארגון הזה, או שהוא כבר מוזג. חזור{' '}
            <Link href="/guests/merge" className="text-primary underline">
              לרשימת הכפילויות
            </Link>{' '}
            כדי לראות את המצב הנוכחי.
          </PanelNote>
        </ScreenFrame>
      )
    }

    const { survivor, merged } = pair.value
    const moving = await settle(() =>
      countMoving(db, actor.organizationId, merged.id, actor),
    )

    return (
      <ScreenFrame
        title="מיזוג פרופילי אורח"
        lead={`כל ההיסטוריה של ״${merged.fullName}״ תעבור אל ״${survivor.fullName}״. הפרופיל שמוזג לא נמחק — הוא נשאר ומצביע על השורד.`}
      >
        <Panel
          title="שני הפרופילים, זה מול זה"
          description="לכל שדה שסותר — בורר. שדה שאין בו מחלוקת לא מוצג, כי אין בו החלטה."
        >
          {!moving.ok ? (
            <ActionError error={moving.error} />
          ) : (
            <MergeForm
              survivor={survivor}
              merged={merged}
              conflicts={conflictsBetween(
                survivor as unknown as MergeableGuest,
                merged as unknown as MergeableGuest,
              )}
              moving={moving.value}
            />
          )}
        </Panel>
      </ScreenFrame>
    )
  }

  /* --------------------------------------------------------- the list -- */

  const [candidates, truncated, history] = await Promise.all([
    settle(() => findDuplicateCandidates(db, actor, actor.organizationId)),
    settle(() => duplicateScanWasTruncated(db, actor.organizationId)),
    settle(() => listRecentMerges(db, actor, actor.organizationId, new Date())),
  ])

  return (
    <ScreenFrame
      title="כפילויות אפשריות"
      lead="שני כרטיסים שאולי הם אותו אדם. המערכת מציעה — היא לעולם לא ממזגת מעצמה, כי מיזוג שגוי מערבב את הכסף של שני אנשים ואת זה כמעט אי אפשר להתיר."
      banner={
        !mayMerge ? (
          <PanelNote tone="attention">
            אתה רואה את הרשימה אך לא יכול למזג: מיזוג דורש גם{' '}
            <GrantCode>guest.update</GrantCode> וגם{' '}
            <GrantCode>guest.delete</GrantCode> יחד.
          </PanelNote>
        ) : undefined
      }
    >
      <Panel
        title="זוגות לבדיקה"
        count={
          candidates.ok && candidates.value
            ? candidates.value.length
            : undefined
        }
        description="מספר הטלפון המנורמל כבר ייחודי במסד, ולכן שני כרטיסים חיים לא יכולים לחלוק אותו. מה שנשאר הוא אותו מייל, טלפון שנבדל רק בקידומת, ושם דומה — וכל אלה הם סימן, לא מסקנה."
      >
        {!candidates.ok ? (
          <ActionError error={candidates.error} />
        ) : candidates.value === null ? (
          <PanelNote tone="attention">
            נדרשת הרשאת <GrantCode>guest.view</GrantCode>.
          </PanelNote>
        ) : candidates.value.length === 0 ? (
          <PanelNote>
            לא נמצאו כפילויות אפשריות. זו תשובה אמיתית: כל כרטיס נראה כמו אדם
            אחר.
          </PanelNote>
        ) : (
          <RowList>
            {candidates.value.map((candidate) => (
              <Row
                key={`${candidate.left.id}:${candidate.right.id}`}
                className="flex-col items-stretch gap-2"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-foreground">
                    {candidate.left.fullName || 'ללא שם'}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-semibold text-foreground">
                    {candidate.right.fullName || 'ללא שם'}
                  </span>
                  <Badge tone={candidate.suggested ? 'accent' : 'neutral'}>
                    {candidate.suggested
                      ? `מוצע למיזוג · ${candidate.score.score}`
                      : `ייתכן שזה אותו אדם · ${candidate.score.score}`}
                  </Badge>
                </div>

                <p className="text-sm text-muted-foreground">
                  {explain(candidate.score)}
                  {!candidate.score.documentsCompared && (
                    <>
                      {' · '}
                      הציון חושב בלי מספרי מסמך מזהה — הם לא נקראים במסך הזה
                    </>
                  )}
                </p>

                {mayMerge && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      href={`/guests/merge?survivor=${candidate.left.id}&merged=${candidate.right.id}`}
                    >
                      השאר את ״{candidate.left.fullName || 'ללא שם'}״
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      href={`/guests/merge?survivor=${candidate.right.id}&merged=${candidate.left.id}`}
                    >
                      השאר את ״{candidate.right.fullName || 'ללא שם'}״
                    </Button>
                  </div>
                )}
              </Row>
            ))}
          </RowList>
        )}

        {truncated.ok && truncated.value && (
          <PanelNote tone="attention">
            הסריקה בדקה את {DUPLICATE_SCAN_SIZE} האורחים האחרונים בלבד, ויש יותר
            מזה בארגון. זו מגבלה של המסך הזה ולא של הנתונים — כפילות ישנה יותר
            לא תופיע כאן.
          </PanelNote>
        )}
      </Panel>

      {/* ------------------------------------------------------- history -- */}
      <Panel
        title="מיזוגים שבוצעו"
        count={history.ok && history.value ? history.value.length : undefined}
        description="מי החליט, מתי, איזה פרופיל שרד ומה עבר. הרשומה הזאת נכתבת רק על ידי המיזוג עצמו — אף אחד בארגון לא יכול ליצור אותה, לשנות אותה או למחוק אותה."
      >
        {!history.ok ? (
          <ActionError error={history.error} />
        ) : history.value === null || history.value.length === 0 ? (
          <PanelNote>עוד לא מוזג אף פרופיל בארגון הזה.</PanelNote>
        ) : (
          <RowList>
            {history.value.map((entry) => (
              <Row key={entry.id} className="flex-col items-stretch gap-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-foreground">
                    {entry.mergedName ?? 'פרופיל'} ←{' '}
                    {entry.survivorName ?? 'פרופיל'}
                  </span>
                  {entry.availability.kind === 'already_undone' && (
                    <Badge tone="neutral">בוטל</Badge>
                  )}
                  {entry.availability.kind === 'expired' && (
                    <Badge tone="neutral">חלון הביטול נסגר</Badge>
                  )}
                </div>

                <p className="text-sm text-muted-foreground">
                  {entry.performedByName ?? 'משתמש שאינו פתוח לצפייה'} ·{' '}
                  {new Date(entry.performedAt).toLocaleDateString('he-IL')}
                  {entry.moved.length > 0 && (
                    <>
                      {' · הועברו '}
                      {entry.moved
                        .map(
                          (item) =>
                            `${item.count} ${MOVED_TABLE_LABEL[item.table] ?? item.table}`,
                        )
                        .join(' · ')}
                    </>
                  )}
                </p>

                <p className="text-sm text-foreground">סיבה: {entry.reason}</p>

                {mayMerge && entry.availability.kind === 'available' && (
                  <UndoMergeControl
                    mergeId={entry.id}
                    daysLeft={entry.availability.daysLeft}
                  />
                )}
              </Row>
            ))}
          </RowList>
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

/** Why this pair is on the list, in the reader's words rather than as a number. */
function explain(score: {
  phone: number
  email: number
  name: number
}): string {
  const parts: string[] = []
  if (score.phone === 1) parts.push('אותו מספר טלפון')
  else if (score.phone > 0) parts.push('טלפון שנבדל רק בקידומת')
  if (score.email === 1) parts.push('אותה כתובת מייל')
  else if (score.email > 0) parts.push('אותו שם משתמש במייל, דומיין אחר')
  if (score.name >= 0.9) parts.push('שם כמעט זהה')
  else if (score.name >= 0.7) parts.push('שם דומה')
  return parts.length > 0 ? parts.join(' · ') : 'סימנים חלשים בלבד'
}

const MERGE_COLUMNS =
  'id, full_name, first_name, last_name, email, phone, phone_alt, language, version'

async function loadPair(
  db: Db,
  organizationId: string,
  survivorId: string,
  mergedId: string,
) {
  const { data, error } = await db
    .from('guests')
    .select(MERGE_COLUMNS)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .in('id', [survivorId, mergedId])

  if (error) throw error

  const rows = toRows(data)
  const survivorRow = rows.find((row) => asString(row, 'id') === survivorId)
  const mergedRow = rows.find((row) => asString(row, 'id') === mergedId)
  if (!survivorRow || !mergedRow) return null

  const shape = (row: (typeof rows)[number]) => ({
    id: asString(row, 'id'),
    fullName: asStringOrNull(row, 'full_name') ?? '',
    version: asNumber(row, 'version'),
    full_name: asStringOrNull(row, 'full_name'),
    first_name: asStringOrNull(row, 'first_name'),
    last_name: asStringOrNull(row, 'last_name'),
    email: asStringOrNull(row, 'email'),
    phone: asStringOrNull(row, 'phone'),
    phone_alt: asStringOrNull(row, 'phone_alt'),
    language: asStringOrNull(row, 'language'),
  })

  return { survivor: shape(survivorRow), merged: shape(mergedRow) }
}

/**
 * What is about to move, counted rather than estimated.
 *
 * Each table is asked for a count and each count is gated on the grant for
 * reading that table. A reader without `booking.view` is told the number is
 * withheld and why — never shown a zero, which here would read as "this
 * profile has no stays" and is the single most misleading thing that could sit
 * next to this button.
 */
async function countMoving(
  db: Db,
  organizationId: string,
  mergedGuestId: string,
  actor: Parameters<typeof holdsGrant>[0],
): Promise<readonly MovingCount[]> {
  const tables = [
    { table: 'bookings', label: 'הזמנות', grant: 'booking.view' },
    { table: 'conversations', label: 'שיחות', grant: 'message.view' },
    { table: 'guest_reviews', label: 'ביקורות', grant: 'review.view' },
    { table: 'leads', label: 'פניות', grant: 'lead.view' },
    { table: 'store_orders', label: 'הזמנות חנות', grant: 'order.view' },
    { table: 'guest_messages', label: 'הודעות שנשלחו', grant: 'message.view' },
  ] as const

  const counts = await Promise.all(
    tables.map(async (entry): Promise<MovingCount> => {
      if (!holdsGrant(actor, entry.grant)) {
        return { kind: 'withheld', label: entry.label, grant: entry.grant }
      }

      const { count, error } = await db
        .from(entry.table)
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('guest_id', mergedGuestId)

      if (error) throw error
      return { kind: 'known', label: entry.label, count: count ?? 0 }
    }),
  )

  return counts
}

/** Kept so the pair loader's shape stays honest against the domain type. */
export type { MergeableGuest }
