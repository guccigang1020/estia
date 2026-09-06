import type { Metadata } from 'next'
import Link from 'next/link'

import { ActionError } from '@/components/booking/action-error'
import { ConnectorCard } from '@/components/channels/connector-card'
import { SourceReport } from '@/components/channels/source-report'
import { SyncBadge } from '@/components/channels/sync-badge'
import { PlanLock } from '@/components/distribution/plan-lock'
import { EmptyState } from '@/components/states/empty-state'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireDistributionGrant } from '../agents/_lib/gate'
import { channelManagerState, type ChannelManagerState } from './_lib/manager'
import {
  channelPicture,
  connectionState,
  type ChannelPicture,
  type OtaSource,
} from './_lib/queries'

export const metadata: Metadata = { title: 'ערוצי הפצה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The channel health centre.
 *
 * ══ ONE SCREEN, TWO HONEST ANSWERS ═════════════════════════════════════════
 *
 * This route used to say one thing: nothing is connected, and here is what
 * *did* come from the channels. That report was true, is still true, and is
 * still here — as `SourceReport`, lower down the page. **ADD does not mean
 * REPLACE**, and the section it became reads exactly as it did.
 *
 * What is new above it is the channel manager's own view: every connector,
 * when each direction last actually ran, what is queued, and what is waiting
 * on a person. It is built from `src/lib/channels/**`, where the engines live
 * as pure functions, and it renders whatever the database honestly contains.
 *
 * ── Three states, and the first one is the truth today ────────────────────
 *
 *   1. **`not_provisioned`** — the channel tables have not been created in
 *      this deployment. Stated in one sentence, and DERIVED from the database
 *      rather than from a constant, so it disappears by itself the day the
 *      migration runs. A hard-coded "not connected" would keep saying so over
 *      a live integration, which is the failure the previous version of this
 *      screen argued against at length and which is not reintroduced here.
 *   2. **`ready` with no connectors** — the tables exist and nobody has
 *      connected a channel. That is a setup flow away, and the screen links to
 *      it rather than describing it.
 *   3. **`ready` with connectors** — the health centre proper.
 *
 * ── What this screen refuses to draw ──────────────────────────────────────
 *
 * A green tick over a channel whose last push was four hours ago. Health is
 * computed in `connectorHealth` from elapsed time and queue depth, never from
 * the absence of an error, because a channel manager that is broken looks
 * exactly like one that has nothing to do. Both are quiet, and only one of
 * them is selling the same Friday twice.
 *
 * GATING. `channel.manage`, mapped to the `channels` entitlement, so a Basic
 * organization gets the upgrade screen — the honest refusal for them, and not
 * a claim that the feature works for anybody else.
 */
export default async function ChannelsPage() {
  const [access, context] = await Promise.all([
    requireDistributionGrant('channel.manage'),
    shellContext(),
  ])

  if (access.kind === 'locked') {
    return (
      <PlanLock
        entitlement={access.entitlement}
        title="ערוצי הפצה אינם כלולים בחבילה שלך"
        body="ערוצי הפצה נועדו לסנכרן את היומן שלך עם Airbnb ו-Booking.com, כך שהזמנה בערוץ אחד חוסמת מיד את התאריכים בכל השאר."
      />
    )
  }

  if (!context || context.status !== 'ready') return null

  const { actor } = access
  const propertyId =
    context.selectedPropertyId === ALL_PROPERTIES
      ? null
      : context.selectedPropertyId

  let picture: ChannelPicture = {
    channels: [],
    totalBookings: 0,
    otaBookings: 0,
    readable: false,
  }
  let manager: ChannelManagerState = { kind: 'not_provisioned' }
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    const args = {
      db,
      actor,
      organizationId: actor.organizationId,
      propertyId,
    }

    const [loadedPicture, loadedManager] = await Promise.all([
      channelPicture(args),
      channelManagerState(args),
    ])

    picture = loadedPicture
    manager = loadedManager
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const legacy = connectionState(picture)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          ערוצי הפצה
        </h1>
        <p className="text-muted-foreground">
          Airbnb, Booking.com והשאר — מה מחובר, מתי באמת סונכרן, ומה ממתין
          להחלטה.
        </p>
      </header>

      {failure ? (
        <ActionError error={failure.error} />
      ) : (
        <>
          <ManagerSection state={manager} />

          <SourceReport
            rows={picture.channels.map((channel) => ({
              key: channel.source,
              label: OTA_LABEL[channel.source],
              bookingCount: channel.bookingCount,
              labels: channel.labels,
              revenueAgorot: channel.revenueAgorot,
            }))}
            totalBookings={picture.totalBookings}
            otaBookings={picture.otaBookings}
            readable={picture.readable}
          />

          {manager.kind === 'not_provisioned' && (
            <Card>
              <CardHeader>
                <CardTitle as="h2">מה צריך להיבנה כדי שזה יעבוד</CardTitle>
              </CardHeader>
              <p className="mt-2 text-sm text-muted-foreground">
                ״בקרוב״ זה משפט שאי אפשר לתכנן לפיו. אלה הדברים שחסרים בפועל:
              </p>
              <ol className="mt-3 flex list-inside list-decimal flex-col gap-2 text-sm text-foreground">
                {legacy.missing.map((piece) => (
                  <li key={piece}>{piece}</li>
                ))}
              </ol>
              {legacy.manualChannelBookings && (
                <p className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
                  עד שזה ייבנה — ההזמנות מהערוצים שמופיעות למעלה הן מה שהוקלד
                  ידנית, ורק הן. אם משהו הוזמן בערוץ ולא הוקלד כאן, המערכת חושבת
                  שהתאריכים פנויים.
                </p>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ the states -- */

function ManagerSection({ state }: { state: ChannelManagerState }) {
  if (state.kind === 'not_readable') {
    return (
      <div
        role="status"
        className="rounded-xl border border-border bg-surface px-4 py-4 text-sm text-muted-foreground sm:px-5"
      >
        אין לך הרשאה לנהל ערוצי הפצה, ולכן מצב החיבורים אינו מוצג. זו אינה טענה
        שאין חיבורים.
      </div>
    )
  }

  if (state.kind === 'not_provisioned') {
    return (
      <div
        role="status"
        className="flex flex-col gap-3 rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground sm:px-5"
      >
        <p className="font-display text-base font-bold">
          מנהל הערוצים אינו מותקן בהתקנה הזו, ואין סנכרון.
        </p>
        <p>
          המשמעות המעשית: הזמנה שנכנסת בערוץ <strong>אינה</strong> חוסמת את
          התאריכים אצלך, והזמנה שנכנסת אצלך <strong>אינה</strong> חוסמת אותם
          בערוץ. מי שמוכר בשני המקומות חייב להמשיך לעדכן ידנית.
        </p>
        <p>
          לא ציירנו כאן לוח מחוונים של חיבור שלא קיים. מסך שמראה ״מחובר״ מעל
          אינטגרציה שאיננה הוא בדיוק מה שגורם לאותו לילה להימכר פעמיים.
        </p>
      </div>
    )
  }

  if (state.connectors.length === 0) {
    return (
      <EmptyState
        illustration="calendar"
        title="לא חובר אף ערוץ"
        body="מנהל הערוצים מותקן ומוכן, ואף ערוץ לא חובר אליו עדיין. עד שיחובר ערוץ, היומן שלך והיומן שלו אינם מדברים זה עם זה."
        action={
          <Link
            href="/channels/setup"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            חיבור ערוץ
          </Link>
        }
      />
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-3">
          <SyncBadge state={state.fleet.worst} />
          <p className="text-sm text-foreground">
            {state.fleet.connectors} ערוצים מחוברים · {state.fleet.healthy}{' '}
            תקינים · {state.fleet.degraded + state.fleet.failing} דורשים תשומת
            לב
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link
            href="/channels/exceptions"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            {state.tally.open === 0
              ? 'אין חריגות פתוחות'
              : `${state.tally.open} חריגות פתוחות`}
          </Link>
          <Link
            href="/channels/setup"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            התאמות מודעות
          </Link>
        </div>
      </div>

      {state.tally.critical > 0 && (
        <div
          role="alert"
          className="rounded-xl border-2 border-danger bg-danger/10 px-4 py-4 text-sm sm:px-5"
        >
          <p className="font-display text-base font-bold text-danger">
            {state.tally.critical} חריגות קריטיות ממתינות להחלטה.
          </p>
          <p className="mt-1 text-foreground">
            חריגה קריטית פירושה שהזמנה קיימת בערוץ ואינה קיימת אצלך, או ששני
            הצדדים מחזיקים גרסאות שונות של אותה שהות. התאריכים שבמחלוקת אינם
            חסומים.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {state.connectors.map((view) => (
          <ConnectorCard
            key={view.connector.id}
            connector={view.connector}
            status={view.status}
          />
        ))}
      </div>
    </>
  )
}

/**
 * The channel names, as their own brands spell them.
 *
 * A total `Record` over `OTA_SOURCES`, so a source added to the booking
 * contract without a name here fails the typecheck rather than rendering
 * `other_channel` at a guesthouse owner. Kept here rather than folded into
 * `@/lib/channels`, because these are `BookingSource` values and the channel
 * module's own `CHANNEL_LABEL` is over `ChannelCode` — two vocabularies that
 * overlap and are not the same list. Collapsing them would be the first step
 * towards a channel that exists in one and not the other.
 */
const OTA_LABEL: Record<OtaSource, string> = {
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  other_channel: 'ערוץ אחר',
}
