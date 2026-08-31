import type { Metadata } from 'next'

import { ActionError } from '@/components/booking/action-error'
import { PlanLock } from '@/components/distribution/plan-lock'
import { Money } from '@/components/finance/money'
import { EmptyState } from '@/components/states/empty-state'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { toSafeResponse } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { ALL_PROPERTIES, shellContext } from '../_lib/context'
import { requireDistributionGrant } from '../agents/_lib/gate'
import {
  channelPicture,
  connectionState,
  type ChannelPicture,
  type OtaSource,
} from './_lib/queries'

export const metadata: Metadata = { title: 'ערוצי הפצה' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Airbnb and Booking.com — and the truth
 * about them.
 *
 * ══ NOTHING IS CONNECTED, AND THAT IS THE HEADLINE ═══════════════════════
 *
 * There is no channel integration in ESTIA. No connection record, no listing
 * mapping, no sync cursor, no inbound reservation handler. `channel.manage` is
 * in the permission catalogue and `channels` is an entitlement Pro carries, and
 * behind them is nothing.
 *
 * So this screen leads with that, in the first sentence, above everything else.
 * A channels dashboard drawn over an absent integration is the most dangerous
 * screen this product could ship: a business would read "Booking.com ✓" and stop
 * checking its own calendar, and the first thing that happens is the same night
 * sold twice. The specification says it in one line — a booking in one channel
 * must immediately block those dates everywhere else, otherwise double booking —
 * and the honest thing to say is that nothing here does that.
 *
 * WHAT IS SHOWN INSTEAD IS REAL. Bookings whose `source` says they came from an
 * OTA, counted per channel with the `source_channel` label somebody typed. Those
 * are genuine bookings a person entered by hand, and they are worth seeing: how
 * many, from where, and what they are worth. The screen is careful to say that
 * knowing about them is not the same as keeping calendars in step, because that
 * distinction *is* the double booking.
 *
 * WHAT WOULD HAVE TO EXIST is listed on the page rather than left as a roadmap
 * note, so an owner reading this knows what they are waiting for instead of
 * being told "coming soon".
 *
 * GATING. `channel.manage` is mapped to the `channels` entitlement, so a Basic
 * or Direct organization gets the upgrade screen — which is the honest refusal
 * for them, and is not a claim that the feature works for anybody else. A Pro
 * organization reaches this page and reads that nothing is connected, which is
 * the more useful truth.
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
  let failure: ReturnType<typeof toSafeResponse> | null = null

  try {
    const db = await createClient()
    picture = await channelPicture({
      db,
      actor,
      organizationId: actor.organizationId,
      propertyId,
    })
  } catch (cause) {
    failure = toSafeResponse(cause, crypto.randomUUID())
  }

  const state = connectionState(picture)

  return (
    <div className="mx-auto flex w-full max-w-shell flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          ערוצי הפצה
        </h1>
        <p className="text-muted-foreground">
          Airbnb, Booking.com והשאר — ומה המערכת באמת יודעת עליהם היום.
        </p>
      </header>

      {/* The headline, and it is a refusal to draw a dashboard. */}
      <div
        role="status"
        className="flex flex-col gap-3 rounded-xl border border-border-strong bg-accent-soft px-4 py-4 text-sm text-accent-foreground sm:px-5"
      >
        <p className="font-display text-base font-bold">
          אף ערוץ אינו מחובר, ואין סנכרון.
        </p>
        <p>
          לא קיים במערכת חיבור לאף ערוץ הפצה — לא ל-Airbnb, לא ל-Booking.com ולא
          לאחרים. המשמעות המעשית: הזמנה שנכנסת בערוץ <strong>אינה</strong> חוסמת
          את התאריכים אצלך, והזמנה שנכנסת אצלך <strong>אינה</strong> חוסמת אותם
          בערוץ. מי שמוכר בשני המקומות חייב להמשיך לעדכן ידנית.
        </p>
        <p>
          לא ציירנו כאן לוח מחוונים של חיבור שלא קיים. מסך שמראה ״מחובר״ מעל
          אינטגרציה שאיננה הוא בדיוק מה שגורם לאותו לילה להימכר פעמיים.
        </p>
      </div>

      {failure ? (
        <ActionError error={failure.error} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle as="h2">מה כן נרשם מהערוצים</CardTitle>
            </CardHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              הזמנות שמישהו הקליד ידנית וסימן שמקורן בערוץ. הן אמיתיות והן
              נספרות כאן — אבל הן לא הגיעו דרך חיבור, ואף אחת מהן לא חסמה
              תאריכים בערוץ שממנו באה.
            </p>

            {!picture.readable ? (
              <p className="mt-3 text-sm text-muted-foreground">
                אין לך הרשאה לראות הזמנות, ולכן אי אפשר להציג את הפילוח. זו אינה
                טענה שאין הזמנות מערוצים.
              </p>
            ) : picture.otaBookings === 0 ? (
              <EmptyState
                className="mt-4"
                illustration="calendar"
                title="לא נרשמה אף הזמנה ממקור ערוץ"
                body={`מתוך ${picture.totalBookings === 1 ? 'הזמנה אחת' : `${picture.totalBookings} הזמנות`} בטווח שלך, אף אחת לא סומנה כמגיעה מ-Airbnb, מ-Booking.com או מערוץ אחר. אם בפועל מגיעות אליך הזמנות מהערוצים, שווה לסמן את המקור בכל הזמנה — זה מה שיאפשר להשוות מאוחר יותר כמה עולה כל ערוץ.`}
              />
            ) : (
              <>
                <p className="mt-4 text-sm text-foreground">
                  {picture.otaBookings} מתוך {picture.totalBookings} ההזמנות
                  בטווח שלך סומנו כמגיעות מערוץ.
                </p>
                <ul className="mt-4 flex flex-col divide-y divide-border">
                  {picture.channels
                    .filter((channel) => channel.bookingCount > 0)
                    .map((channel) => (
                      <li
                        key={channel.source}
                        className="flex flex-wrap items-center justify-between gap-3 py-3"
                      >
                        <span className="flex flex-col gap-0.5">
                          <span className="font-semibold text-foreground">
                            {CHANNEL_LABEL[channel.source]}
                          </span>
                          {channel.labels.length > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {channel.labels.join(' · ')}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-4">
                          <span className="text-sm text-muted-foreground">
                            {channel.bookingCount === 1
                              ? 'הזמנה אחת'
                              : `${channel.bookingCount} הזמנות`}
                          </span>
                          <Money agorot={channel.revenueAgorot} emphasis />
                        </span>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">מה צריך להיבנה כדי שזה יעבוד</CardTitle>
            </CardHeader>
            <p className="mt-2 text-sm text-muted-foreground">
              ״בקרוב״ זה משפט שאי אפשר לתכנן לפיו. אלה ארבעת הדברים שחסרים
              בפועל:
            </p>
            <ol className="mt-3 flex list-inside list-decimal flex-col gap-2 text-sm text-foreground">
              {state.missing.map((piece) => (
                <li key={piece}>{piece}</li>
              ))}
            </ol>
            {state.manualChannelBookings && (
              <p className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
                עד שזה ייבנה — ההזמנות מהערוצים שמופיעות למעלה הן מה שהוקלד
                ידנית, ורק הן. אם משהו הוזמן בערוץ ולא הוקלד כאן, המערכת חושבת
                שהתאריכים פנויים.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

/**
 * The channel names, as their own brands spell them.
 *
 * A total `Record` over `OTA_SOURCES`, so a channel added to the contract
 * without a name here fails the typecheck rather than rendering `other_channel`
 * at a guesthouse owner. Not translated: Airbnb and Booking.com are proper
 * nouns and a Hebrew rendering of either would be a name nobody recognises.
 */
const CHANNEL_LABEL: Record<OtaSource, string> = {
  airbnb: 'Airbnb',
  booking_com: 'Booking.com',
  vrbo: 'Vrbo',
  // Expedia and every other OTA the contract does not name individually. The
  // vocabulary is `BOOKING_SOURCES` in `booking/types.ts` and is consumed, not
  // extended — a fifth channel is a migration on the `booking_source` enum and
  // a change to every exhaustive switch that reads it, which is not a screen's
  // decision to make.
  other_channel: 'ערוץ אחר',
}
