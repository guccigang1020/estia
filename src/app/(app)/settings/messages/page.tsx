import type { Metadata } from 'next'

import {
  Panel,
  PanelNote,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { GUEST_MESSAGE_KINDS } from '@/lib/messaging/types'
import { createClient } from '@/lib/supabase/server'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { loadMessagesScreen } from './_lib/queries'
import { TemplateEditor } from './template-editor'

export const metadata: Metadata = { title: 'נוסחי הודעות · ESTIA' }

const KIND_LABEL: Record<string, string> = {
  payment_reminder: 'תזכורת תשלום',
  arrival_info: 'פרטי הגעה',
  review_request: 'בקשת ביקורת',
}

const KIND_WHEN: Record<string, string> = {
  payment_reminder: 'נשלחת כשנותרה יתרה לתשלום בהזמנה.',
  arrival_info: 'נשלחת לפני ההגעה, עם הכתובת והוראות הכניסה.',
  review_request: 'נשלחת אחרי שהאורח יצא.',
}

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The wording a business writes for its
 * own guests.
 *
 * ══ WHY THE SCREEN EXISTS ═══════════════════════════════════════════════════
 *
 * `compose.ts` writes good Hebrew and every business got the same Hebrew. A
 * guesthouse with a voice of its own could not change a word of what its
 * guests received. `message_templates` was named in the inbox's own
 * "missing tables" banner from the day the messaging module landed; 0071 is
 * that table and this is its screen.
 *
 * ══ EMPTY IS A WORKING STATE, NOT AN UNCONFIGURED ONE ═══════════════════════
 *
 * A business that never opens this screen has messages that work. That is why
 * deleting a template is offered plainly rather than guarded: removing one
 * restores the built-in text, so the destructive-looking action is the safe
 * one. It is the opposite of `guest_reviews`, where delete is refused to every
 * role — that is a record of what happened, and this is a setting.
 *
 * ══ ONE WORDING PER KIND HERE, AND PER-CHANNEL IS NOT OFFERED YET ═══════════
 *
 * The table supports a per-channel override (`channel` non-null wins over
 * `channel is null` — `resolveTemplate` owns that rule and is tested). The
 * screen deliberately only writes the all-channels row.
 *
 * Not an oversight: no provider is connected, so **no message has ever been
 * sent through any channel**. Offering a business a choice between wording for
 * SMS and wording for WhatsApp today would be asking it to tune something it
 * cannot observe. The storage is ready for the day a provider is wired; the
 * question is not worth asking before then.
 *
 * GATING. `template.manage`. The same grant guards `/templates`, which is the
 * AUTOMATION template library — one grant covering two unrelated kinds of
 * template is muddy, and worth separating when either grows.
 */
export default async function MessageTemplatesPage() {
  const [actor, context] = await Promise.all([
    requireGrant('template.manage'),
    shellContext(),
  ])

  if (!context || context.status !== 'ready') return null

  const db = await createClient()
  const screen = await loadMessagesScreen(db, actor.organizationId)

  const lead =
    'הנוסח שהאורחים שלכם מקבלים. בלי נוסח משלכם נשלח נוסח ברירת המחדל של ' +
    'המערכת — ולכן מחיקה כאן היא פעולה בטוחה, לא הרסנית.'

  if (screen.status === 'not_provisioned') {
    return (
      <ScreenFrame title="נוסחי הודעות" lead={lead} width="prose">
        <Panel title="הנתונים אינם זמינים">
          <PanelNote>טבלת הנוסחים אינה קיימת בבסיס הנתונים הזה.</PanelNote>
        </Panel>
      </ScreenFrame>
    )
  }

  const { templates } = screen

  return (
    <ScreenFrame title="נוסחי הודעות" lead={lead} width="prose">
      {GUEST_MESSAGE_KINDS.map((kind) => {
        // The all-channels row is the one this screen writes. See the header
        // on why the per-channel override is stored but not yet offered.
        const existing =
          templates.find((t) => t.kind === kind && t.channel === null) ?? null

        return (
          <Panel
            key={kind}
            title={KIND_LABEL[kind] ?? kind}
            description={KIND_WHEN[kind]}
          >
            {existing === null && (
              <PanelNote>
                אין נוסח משלכם, ולכן נשלח נוסח ברירת המחדל. זה מצב תקין ולא חסר.
              </PanelNote>
            )}
            {existing !== null && !existing.isActive && (
              <PanelNote>
                הנוסח שלכם כבוי — ההודעות נשלחות בנוסח ברירת המחדל. הטקסט נשמר
                ואפשר להדליק אותו שוב.
              </PanelNote>
            )}
            <TemplateEditor
              kind={kind}
              channel={null}
              existing={
                existing === null
                  ? null
                  : {
                      id: existing.id,
                      body: existing.body,
                      isActive: existing.isActive,
                    }
              }
            />
          </Panel>
        )
      })}

      <Panel title="מה המסך הזה לא עושה">
        <PanelNote>
          <strong>אינו שולח.</strong> אין ספק הודעות מחובר, ולכן כל הודעה נרשמת
          עם סטטוס ״לא מוגדר״ והטקסט נשמר כדי שאפשר יהיה להעתיק אותו לוואטסאפ
          ביד. הנוסח שתכתבו כאן ישמש ברגע שיחובר ספק.
        </PanelNote>
        <PanelNote>
          <strong>אינו מאפשר נוסח נפרד לכל ערוץ.</strong> המסד תומך בזה, ואין
          טעם לשאול אתכם לפני שנשלחה ולו הודעה אחת דרך ערוץ כלשהו — אי אפשר
          לכוונן מה שאי אפשר לראות.
        </PanelNote>
      </Panel>
    </ScreenFrame>
  )
}
