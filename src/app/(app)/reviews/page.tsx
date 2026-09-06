import type { Metadata } from 'next'

import {
  FactRow,
  Panel,
  PanelNote,
  Row,
  RowList,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { Badge } from '@/components/ui/badge'
import {
  DIMENSION_LABEL,
  MIN_REVIEWS_TO_AVERAGE,
  REVIEW_DIMENSIONS,
  REVIEW_NOTE,
  SOURCE_LABEL,
  needsReplyFirst,
} from '@/lib/reviews'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireGrant } from '../_lib/guard'
import { loadReviewsScreen } from './_lib/queries'
import { RecordReview } from './record-review'
import { ReviewControls } from './review-controls'

export const metadata: Metadata = { title: 'ביקורות · ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What guests said, and what was done
 * about it.
 *
 * ══ THE SCREEN CANNOT EDIT A REVIEW AND CANNOT DELETE ONE ═══════════════════
 *
 * Reply, and hide with a stored reason. That is all, and the database enforces
 * it rather than trusting this file: `0066_guest_reviews.sql` refuses `delete`
 * to every role and has a trigger that rejects any UPDATE touching the guest's
 * words or scores.
 *
 * It matters because `/listings` reads these rows for `property.guest_rating`.
 * A rating a business could quietly curate would be marketing wearing the
 * clothes of data — worse than the `not_assessed` it replaced, because it
 * would be believed.
 *
 * ══ HIDDEN REVIEWS ARE COUNTED WHERE THE AVERAGE IS SHOWN ═══════════════════
 *
 * Always, and in the same panel. Hiding has legitimate uses — a review naming
 * a guest's medical details, a review about the wrong property — so the point
 * is not to prevent it. The point is that a business cannot look at its own
 * average without seeing what is not in it.
 *
 * ══ WHAT IS MISSING, AND WHOSE IT IS ════════════════════════════════════════
 *
 * The guest's own form. `guest_portal_submit_review` exists in 0066 and is the
 * door it needs, but `src/app/g/**` is another agent's work in this repository
 * and this screen does not reach into it. Until that form exists, reviews
 * arrive here by hand — which is not a placeholder: most guesthouses in this
 * market are sent a paragraph on WhatsApp and have nowhere to put it.
 *
 * GATING. `review.view` to read, `review.manage` to reply or hide. The
 * controls are not rendered without the second, rather than rendered and
 * refused — and row level security refuses underneath regardless.
 */
export default async function ReviewsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('review.view'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const canManage = context.actor.grants.has('review.manage')

  const propertyIds =
    context.selectedPropertyId === ALL_PROPERTIES
      ? context.properties.map((property) => property.id)
      : [context.selectedPropertyId]

  const db = await createClient()
  const screen = await loadReviewsScreen(db, actor.organizationId, propertyIds)

  const lead =
    'מה שאורחים כתבו, ומה נענה להם. אי אפשר לערוך ביקורת ואי אפשר למחוק אותה — ' +
    'אפשר להשיב, ואפשר להסתיר עם נימוק שנשמר.'

  if (screen.status === 'not_provisioned') {
    return (
      <ScreenFrame title="ביקורות" lead={lead} width="prose">
        <Panel title="הנתונים אינם זמינים">
          <PanelNote>טבלת הביקורות אינה קיימת בבסיס הנתונים הזה.</PanelNote>
        </Panel>
      </ScreenFrame>
    )
  }

  const { reviews, summary, reviewableStays } = screen
  const toAnswer = needsReplyFirst(reviews)

  return (
    <ScreenFrame title="ביקורות" lead={lead} width="prose">
      <Panel title="הממוצע">
        <RowList>
          <Row>
            <FactRow label="ציון ממוצע">
              {summary.average === null ? (
                <span className="flex items-center gap-2">
                  <Badge>אין מספיק</Badge>
                  <span className="text-xs text-muted-foreground">
                    {summary.counted} מתוך {MIN_REVIEWS_TO_AVERAGE} הדרושות
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm">{summary.average}</span>
                  <span className="text-xs text-muted-foreground">
                    מתוך 5 · {summary.counted} ביקורות
                  </span>
                </span>
              )}
            </FactRow>
          </Row>
          <Row>
            <FactRow label="ממתינות לתשובה">
              <span className="font-mono text-sm">{summary.awaitingReply}</span>
            </FactRow>
          </Row>
          <Row>
            <FactRow label="מוסתרות">
              <span className="font-mono text-sm">{summary.hidden}</span>
            </FactRow>
          </Row>
        </RowList>

        {summary.average === null && summary.counted > 0 && (
          <PanelNote>{REVIEW_NOTE.tooFew}</PanelNote>
        )}
        {summary.counted === 0 && summary.hidden === 0 && (
          <PanelNote>{REVIEW_NOTE.noReviews}</PanelNote>
        )}
        {summary.hidden > 0 && <PanelNote>{REVIEW_NOTE.hidden}</PanelNote>}
        <PanelNote>{REVIEW_NOTE.immutable}</PanelNote>
      </Panel>

      {Object.keys(summary.dimensionAverages).length > 0 && (
        <Panel
          title="לפי נושא"
          description="כל נושא ממוצע על האורחים שדירגו אותו בלבד. אורח שדילג על מיקום אינו נספר שם כאפס."
        >
          <RowList>
            {REVIEW_DIMENSIONS.filter(
              (dimension) => summary.dimensionAverages[dimension] !== undefined,
            ).map((dimension) => (
              <Row key={dimension}>
                <FactRow label={DIMENSION_LABEL[dimension]}>
                  <span className="font-mono text-sm">
                    {summary.dimensionAverages[dimension]}
                  </span>
                </FactRow>
              </Row>
            ))}
          </RowList>
        </Panel>
      )}

      <Panel
        title="לענות ראשון"
        count={toAnswer.length}
        description="הגרועה שלא נענתה קודמת, ואז הישנה. ביקורת של כוכב אחד שלא נענתה מהשבוע שעבר עולה הזמנות היום; חמישה כוכבים ממרץ הם נימוס."
      >
        {toAnswer.length === 0 ? (
          <PanelNote>אין ביקורות שממתינות לתשובה.</PanelNote>
        ) : (
          <RowList>
            {toAnswer.map((review) => (
              <Row key={review.id} className="flex-col items-stretch gap-1.5">
                <FactRow
                  label={`${review.overall} כוכבים · ${review.stayedAt}`}
                >
                  <span className="text-xs text-muted-foreground">
                    {SOURCE_LABEL[review.source]}
                  </span>
                </FactRow>
                {review.comment && <p className="text-sm">{review.comment}</p>}
                <ReviewControls
                  reviewId={review.id}
                  hasReply={review.hostReply !== null}
                  canManage={canManage}
                />
              </Row>
            ))}
          </RowList>
        )}
      </Panel>

      <Panel title="כל הביקורות" count={reviews.length}>
        {reviews.length === 0 ? (
          <PanelNote>{REVIEW_NOTE.noReviews}</PanelNote>
        ) : (
          <RowList>
            {reviews.map((review) => (
              <Row key={review.id} className="flex-col items-stretch gap-1.5">
                <FactRow
                  label={`${review.overall} כוכבים · ${review.stayedAt}`}
                >
                  <span className="flex items-center gap-2">
                    {review.status === 'hidden' && <Badge>מוסתרת</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {SOURCE_LABEL[review.source]}
                    </span>
                  </span>
                </FactRow>
                {review.comment && <p className="text-sm">{review.comment}</p>}
                {review.hostReply && (
                  <p className="text-sm text-muted-foreground">
                    התשובה שלכם: {review.hostReply}
                  </p>
                )}
              </Row>
            ))}
          </RowList>
        )}
      </Panel>

      <Panel
        title="שהיות שאפשר לרשום להן ביקורת"
        count={reviewableStays.length}
        description="רק שהיות שהסתיימו ושאין להן עדיין ביקורת. הרשימה נבנית מאותם סטטוסים שהמסד מקבל, כדי שהטופס לא יציע הזמנה שתידחה."
      >
        {reviewableStays.length === 0 ? (
          <PanelNote>אין שהיות שהסתיימו וממתינות לרישום ביקורת.</PanelNote>
        ) : (
          <RowList>
            {reviewableStays.slice(0, 10).map((stay) => (
              <Row key={stay.bookingId}>
                <FactRow label={stay.reference}>
                  <span className="text-xs text-muted-foreground">
                    יצא ב-{stay.checkOut}
                  </span>
                </FactRow>
              </Row>
            ))}
          </RowList>
        )}
        {canManage && <RecordReview stays={reviewableStays} />}
        <PanelNote>
          ביקורת שהגיעה בוואטסאפ נרשמת כאן ומסומנת כ״הוזנה ידנית״, כדי ששום דבר
          בהמשך לא יבלבל בינה לבין ביקורת שהאורח עצמו הגיש. הטופס של האורח עצמו
          שייך לפורטל האורח, ואינו במסך הזה.
        </PanelNote>
      </Panel>
    </ScreenFrame>
  )
}
