'use client'

/**
 * What a guest will actually be asked to do, for the configuration on screen.
 *
 * ── Why this is the most important panel on the screen ────────────────────
 *
 * A settings screen that cannot show its own consequence is how somebody turns
 * a confirmation requirement off without realising what it does. The list
 * below is not a description written beside the form and kept in step by hand:
 * it is `buildSteps` and `nextAction` from `src/lib/guest-journey/steps.ts` —
 * the same two functions the guest portal's first screen calls for a real
 * booking — over a journey shaped by the draft in the form right now.
 *
 * So it updates as the switches move, before anything is saved, and it cannot
 * drift from the portal. If it is wrong here it is wrong there.
 *
 * ── Why the preview journey is built here ─────────────────────────────────
 *
 * `fixtures.ts` has a builder for exactly this shape and it is deliberately
 * not used: that file is test support and starts from the quietest possible
 * journey on purpose, so a preview that inherited its assumptions would be a
 * preview of the tests rather than of the configuration. The stay below is a
 * plain unpaid booking nobody has touched, which is the state that shows every
 * step a guest will meet rather than the tail of one.
 *
 * ── Leaf imports only ─────────────────────────────────────────────────────
 *
 * `@/lib/guest-journey/steps`, `/reconfirmation`, `/presets`, `/types`, and
 * the payments module's `/resolver`. Never `@/lib/guest-journey`,
 * `@/lib/guest-journey/settings` or `@/lib/payments` — all three reach the
 * Postgres driver, and a Client Component that touches one takes every route
 * in the application down with `Can't resolve 'fs'`.
 */

import { Badge } from '@/components/ui/badge'
// Type-only: the compiler erases it, and `client:bundle` excludes `import
// type` for that reason. The value never crosses — it is resolved on the
// server and handed down as a plain object.
import type { GuestCollection } from '@/lib/guest-journey/collection'
import { DURING_STAY_TOPIC_LABEL } from '@/lib/guest-journey/presets'
import { compareTerms } from '@/lib/guest-journey/reconfirmation'
import { buildSteps, nextAction } from '@/lib/guest-journey/steps'
import {
  GUEST_ARRIVAL_RELEASE_LABEL,
  GUEST_REQUEST_CATEGORY_LABEL,
  type GuestJourney,
  type GuestJourneySettings,
} from '@/lib/guest-journey/types'
import { REQUIREMENT_LABEL } from '@/lib/payments/resolver'

/** A four-night stay, unpaid, nobody has looked at. The honest zero point. */
function previewJourney(settings: GuestJourneySettings): GuestJourney {
  return {
    settings,
    current: {
      bookingVersion: 1,
      status: 'pending',
      checkIn: '2026-01-01',
      checkOut: '2026-01-05',
      adults: 2,
      children: 0,
      infants: 0,
      totalAgorot: 1_000_000,
      currency: 'ILS',
      cancellationTerms: null,
      inStay: false,
    },
    confirmation: null,
    contract: {
      mode: settings.contractMode,
      template:
        settings.contractMode === 'disabled'
          ? null
          : { title: 'תנאי השהות', body: '' },
      signature: null,
    },
    details: { submittedAt: null, fields: {} },
    arrival: {
      released: false,
      checkInTime: null,
      addressNote: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      directions: null,
      mapUrl: null,
      parking: null,
      accessInstructions: null,
      accessCode: null,
    },
    stay: {
      inStay: false,
      wifiNetwork: null,
      wifiPassword: null,
      propertyGuide: null,
      houseRules: null,
      emergencyContact: null,
    },
    requests: [],
    checkout: {
      checkOutTime: null,
      instructions: null,
      declaredAt: null,
      enabled: settings.checkoutDeclarationEnabled,
    },
  }
}

/** What the guest meets once every required step is behind them. */
function afterwards(
  settings: GuestJourneySettings,
): { key: string; label: string; detail: string }[] {
  const lines: { key: string; label: string; detail: string }[] = [
    {
      key: 'arrival',
      label: 'פרטי ההגעה וקוד הכניסה',
      detail:
        settings.arrivalRelease === 'manual'
          ? 'לא ייחשפו מעצמם. מישהו מהצוות משחרר אותם לכל הזמנה בנפרד.'
          : settings.arrivalRelease === 'hours_before'
            ? `${GUEST_ARRIVAL_RELEASE_LABEL[settings.arrivalRelease]} — ${settings.arrivalReleaseHours} שעות`
            : GUEST_ARRIVAL_RELEASE_LABEL[settings.arrivalRelease],
    },
  ]

  if (settings.duringStayTopics.length > 0) {
    lines.push({
      key: 'stay',
      label: 'במהלך השהות',
      detail: settings.duringStayTopics
        .map(
          (topic) =>
            DURING_STAY_TOPIC_LABEL[
              topic as keyof typeof DURING_STAY_TOPIC_LABEL
            ] ?? topic,
        )
        .join(' · '),
    })
  }

  if (settings.requestsEnabled && settings.requestCategories.length > 0) {
    lines.push({
      key: 'requests',
      label: 'בקשות',
      detail: settings.requestCategories
        .map((category) => GUEST_REQUEST_CATEGORY_LABEL[category])
        .join(' · '),
    })
  }

  if (settings.checkoutDeclarationEnabled) {
    lines.push({
      key: 'checkout',
      label: 'יציאה',
      detail: 'האורח יכול להצהיר שיצא, והצוות רואה את זה מיד.',
    })
  }

  if (settings.reviewEnabled && settings.reviewUrl) {
    lines.push({
      key: 'review',
      label: 'ביקורת',
      detail: 'אחרי היציאה מוצגת בקשה לביקורת עם הקישור שהוגדר.',
    })
  }

  if (settings.rebookEnabled) {
    lines.push({
      key: 'rebook',
      label: 'הזמנה חוזרת',
      detail:
        'אחרי היציאה מוצעת שהות נוספת. תאריכים מוצגים רק אם הם באמת פנויים.',
    })
  }

  return lines
}

export function JourneyPreview({
  settings,
  collection,
}: {
  settings: GuestJourneySettings
  /** Resolved on the server by the payment module's own resolver. */
  collection: GuestCollection
}) {
  const journey = previewJourney(settings)
  const reconfirmation = compareTerms(null, journey.current, settings)
  const steps = buildSteps(journey, collection, reconfirmation)
  const next = nextAction(journey, collection, steps, reconfirmation)
  const requirements = collection.decision.requirements

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-foreground">
          מה האורח יתבקש לעשות, ובאיזה סדר
        </h3>

        {steps.length === 0 ? (
          <p className="rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
            שום דבר. עם ההגדרות האלה האורח פותח את הקישור ורואה את ההזמנה שלו,
            בלי אף שלב שנדרש ממנו. זו הגדרה תקינה ומלאה — כך עובד בית אירוח
            שמסכם הכול בטלפון.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((step, index) => (
              <li
                key={step.id}
                className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {index + 1}.
                  </span>
                  <span className="font-medium text-foreground">
                    {step.label}
                  </span>
                  {!step.required && <Badge>לא חובה</Badge>}
                  {step.status === 'blocked' && (
                    <Badge tone="accent">חסום</Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {step.description}
                </p>
              </li>
            ))}
          </ol>
        )}

        {/* The dominant action, said separately: a screen with four equally
            weighted buttons has no next action, it has a menu. */}
        <p className="text-sm text-muted-foreground">
          {next.label.length > 0 ? (
            <>
              הפעולה הראשונה שתוצג לו:{' '}
              <span className="font-medium text-foreground">{next.label}</span>
            </>
          ) : (
            'הפעולה הראשונה שתוצג לו נקבעת על ידי מדיניות הגבייה, ומוצגת בפאנל התשלום שבעמוד האורח.'
          )}
        </p>
      </section>

      {requirements.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-foreground">
            מה מתוך זה מגיע ממדיניות הגבייה
          </h3>
          <p className="text-sm text-muted-foreground">
            הדרישות האלה נקבעות בסעיף הגבייה שבהמשך העמוד, לא כאן. הן מוצגות כדי
            שהרשימה למעלה תהיה מובנת.
          </p>
          <ul className="flex flex-wrap gap-2">
            {requirements.map((requirement) => (
              <li key={requirement}>
                <Badge tone="brand">{REQUIREMENT_LABEL[requirement]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-foreground">
          ומה יקרה אחר כך
        </h3>
        <dl className="flex flex-col">
          {afterwards(settings).map((entry) => (
            <div
              key={entry.key}
              className="flex flex-col gap-0.5 border-b border-border py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <dt className="shrink-0 text-sm font-medium text-foreground">
                {entry.label}
              </dt>
              <dd className="text-sm text-muted-foreground sm:text-end">
                {entry.detail}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
