import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { JourneySettingsForm } from '@/components/journey-settings/journey-settings-form'
import { PresetPicker } from '@/components/journey-settings/preset-picker'
import { CollectionPolicyForm } from '@/components/payments/collection-policy-form'
import {
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { toSafeResponse } from '@/lib/errors'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { loadGuestJourneySettingsView } from './_lib/queries'

export const metadata: Metadata = { title: 'מסע האורח' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. What this business asks of a guest.
 *
 * ══ THE TABLE BEHIND THIS SCREEN HAD NO SCREEN ═══════════════════════════
 *
 * `guest_journey_settings` has driven the entire guest portal since migration
 * 0034 — whether there is a contract, which details are collected, when the
 * address and the door code are released, what may be asked for during a stay
 * — and until this page there was no way to create or change a row except with
 * hand-written SQL. A configurable product whose configuration is reachable
 * only through a database client is not configurable.
 *
 * ══ AN ORGANIZATION WITH NO ROW IS NOT UNCONFIGURED ══════════════════════
 *
 * It is running 0034's column defaults: the guest confirms, no money is
 * required before that, there is no contract, and the address is released the
 * moment they confirm. `effectiveSettings` reports that as `source: 'shipped'`
 * and the screen says it in words, then shows the same preview it would for a
 * saved row. An empty form implying a skipped setup step is how a business
 * decides the product is not for them.
 *
 * ══ THE PREVIEW IS THE REAL FUNCTIONS ════════════════════════════════════
 *
 * The last panel of the form calls `buildSteps` and `nextAction` from
 * `src/lib/guest-journey/steps.ts` — the same two the guest portal calls — over
 * a collection decision resolved by `resolveCollectionPolicy`, the payment
 * module's single implementation. Nothing on this screen re-derives what a
 * guest owes or what they are asked to do.
 *
 * ══ WHY THE COLLECTION PANEL IS THE PAYMENTS MODULE'S OWN FORM ═══════════
 *
 * `CollectionPolicyForm` writes `payment_collection_settings` through
 * `definePaymentPolicyOperations`, with its own audit trail. Rendering it here
 * rather than rebuilding it is the point of the one-resolver rule: there is one
 * form, one table and one operation for "what must a guest do before a booking
 * is confirmed", and this screen borrows it rather than growing an opinion.
 *
 * GATING. `requireGrant('organization.settings.edit')` refuses the route, both
 * actions assert the grant again before they write, the operations assert it
 * twice more — once before any read and once against the loaded scope — and
 * `guest_journey_settings_write` demands it at the database.
 */
export default async function GuestJourneySettingsPage() {
  const [, context] = await Promise.all([
    requireGrant('organization.settings.edit'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  let view
  try {
    view = await loadGuestJourneySettingsView(context.actor.organizationId)
  } catch (cause) {
    // A readable Hebrew refusal rather than a digest and a blank screen. The
    // same shape `/settings/payments` uses, and for the same reason: a settings
    // screen that 500s tells the reader nothing about what happened.
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="מסע האורח" lead="" width="prose">
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  const { effective, overrides } = view
  const record = effective.record

  return (
    <ScreenFrame
      title="מסע האורח"
      lead="מה בית האירוח מבקש מהאורח מרגע ההזמנה ועד אחרי היציאה. כל שלב אפשר לכבות, וכבוי הוא הגדרה שלמה ולא חוסר."
      width="prose"
    >
      <Panel
        title="תבנית התחלה"
        description="שלוש נקודות פתיחה נפוצות. אפשר להתעלם מהן לגמרי ולהגדיר הכול ידנית — הן כותבות אותן הגדרות בדיוק."
      >
        <PresetPicker
          current={effective.settings}
          expectedVersion={record?.version ?? null}
        />
      </Panel>

      {overrides.length > 0 && (
        <PanelNote>
          {overrides.length} נכסים מוגדרים בנפרד ואינם מושפעים מהמסך הזה. נכס עם
          הגדרות משלו דורס את ברירת המחדל של הארגון במלואה, ולא שדה-שדה.
        </PanelNote>
      )}

      <JourneySettingsForm
        initial={effective.settings}
        expectedVersion={record?.version ?? null}
        isShippedDefault={effective.source === 'shipped'}
        collection={view.collection}
      />

      <Panel
        title="גביית תשלום"
        description="מה נדרש מהאורח לפני שההזמנה מאושרת, וכמה. זו אותה הגדרה שבמסך הגבייה — נערכת גם כאן ונשמרת שם, כדי שלא יהיו לה שתי תשובות."
      >
        <CollectionPolicyForm initial={view.paymentSettings} />
      </Panel>
    </ScreenFrame>
  )
}
