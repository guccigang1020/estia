import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { ActionError } from '@/components/booking/action-error'
import { CollectionPolicyForm } from '@/components/payments/collection-policy-form'
import { GuestCollectionPanel } from '@/components/payments/guest-collection-panel'
import { ManualChannelsForm } from '@/components/payments/manual-channels-form'
import { PolicyExplanation } from '@/components/payments/policy-explanation'
import {
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { toSafeResponse } from '@/lib/errors'
import { formatAgorot, nextGuestAction } from '@/lib/payments'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import {
  PREVIEW_BOOKING_TOTAL_AGOROT,
  loadPaymentSettings,
} from './_lib/queries'

export const metadata: Metadata = { title: 'גבייה ותשלומים' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. How this business collects money.
 *
 * ══ THIS SCREEN IS FOR SOMEBODY WHO TAKES NO CARDS ═══════════════════════
 *
 * That is the majority of the businesses this product is for, and the screen
 * is built for them rather than for the exception. There is no "connect your
 * processor" banner, no disabled integration panel, no empty state implying a
 * setup step was skipped. A business whose answer is "we confirm by telephone
 * and take a bank transfer" saves that in two panels and is finished.
 *
 * Live processing is one switch inside the first panel. Off is the default and
 * off is complete.
 *
 * ══ THE PREVIEW IS THE REAL RESOLVER ═════════════════════════════════════
 *
 * The third panel shows what the current configuration does to a ₪10,000
 * booking with nothing paid — and it does it by calling
 * `resolveCollectionPolicy` and `nextGuestAction`, the same two functions the
 * guest portal calls. A preview computed any other way would be a second
 * opinion, and a second opinion that people trust is worse than none.
 *
 * GATING. `requireGrant('payment.policy_manage')` refuses the route, both
 * actions assert the grant again before they write, and
 * `payment_collection_settings_update` demands it at the database. Three
 * independent refusals. The grant deliberately carries no plan entitlement:
 * deciding how you take money is not a paid feature.
 */
export default async function PaymentSettingsPage() {
  const [, context] = await Promise.all([
    requireGrant('payment.policy_manage'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') redirect('/dashboard')

  let view
  try {
    view = await loadPaymentSettings(context.actor.organizationId)
  } catch (cause) {
    const safe = toSafeResponse(cause, crypto.randomUUID())
    return (
      <ScreenFrame title="גבייה ותשלומים" lead="">
        <ActionError error={safe.error} />
      </ScreenFrame>
    )
  }

  const preview = nextGuestAction({
    decision: view.preview,
    channels: view.channels,
  })

  return (
    <ScreenFrame
      title="גבייה ותשלומים"
      lead="כאן נקבע מה נדרש מהאורח לפני שהזמנה מאושרת, ואיך הכסף מגיע אליכם בפועל."
      width="prose"
    >
      <Panel
        title="מדיניות הגבייה"
        description="מה נדרש מהאורח לפני אישור, וכמה. אפשר לחרוג מזה בהזמנה בודדת."
      >
        <div className="mt-5">
          <CollectionPolicyForm initial={view.settings} />
        </div>
      </Panel>

      <Panel
        title="דרכי תשלום ידניות"
        description="העברה בנקאית, ביט, מזומן. אלה הדרכים שרוב בתי האירוח בישראל נגבים בהן, והן מטופלות כאן בדיוק כמו סליקה."
      >
        <div className="mt-5">
          <ManualChannelsForm channels={view.channels} />
        </div>
      </Panel>

      <Panel
        title="כך זה ייראה"
        description={`הדוגמה מחושבת על הזמנה של ${formatAgorot(PREVIEW_BOOKING_TOTAL_AGOROT)} שטרם שולמה — באותן פונקציות שמפעילות את עמוד האורח עצמו.`}
      >
        <div className="mt-5 flex flex-col gap-6">
          <PolicyExplanation decision={view.preview} />

          <div>
            <h3 className="mb-3 text-base font-semibold text-foreground">
              מה האורח יראה
            </h3>
            <GuestCollectionPanel
              action={preview}
              guestInstructions={view.preview.guestInstructions}
            />
          </div>

          {!view.preview.liveAvailable && (
            <PanelNote>
              סליקה מקוונת אינה פעילה, ולכן האורח לא יראה כפתור תשלום. זו הגדרה
              תקינה ומלאה — לא חוסר.
            </PanelNote>
          )}
        </div>
      </Panel>
    </ScreenFrame>
  )
}
