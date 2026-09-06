import type { Metadata } from 'next'

import {
  FactRow,
  Panel,
  PanelNote,
  RowList,
  Row,
  ScreenFrame,
} from '@/components/shell-screens/screen'
import { WebhookEndpointForm } from '@/components/webhooks/endpoint-form'
import { EndpointControls } from '@/components/webhooks/endpoint-controls'
import { createClient } from '@/lib/supabase/server'
import {
  WEBHOOK_DELIVERY_STATUS_LABEL,
  WEBHOOK_DISABLE_REASON_LABEL,
  WEBHOOK_ENDPOINT_STATUS_LABEL,
} from '@/lib/webhooks'

import { shellContext } from '../../_lib/context'
import { requireGrant } from '../../_lib/guard'
import { loadWebhookScreen } from './_lib/queries'

export const metadata: Metadata = { title: 'Webhooks · ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. Outbound webhooks, per organization.
 *
 * WHY THIS IS AN ORGANIZATION SCREEN AND NOT A PROPERTY ONE. A webhook is a
 * connection to another system, and the other system belongs to the business
 * rather than to one of its houses. A guesthouse with four properties has one
 * accounting system, not four. Events still carry `propertyId` so a receiver
 * can route on it.
 *
 * GATING. `requireGrant('integration.manage')` refuses the route, and row
 * level security asks for the same grant on every table behind it. The grant
 * is deliberately not split into view/manage: there is nothing useful to see
 * here without the ability to change it, and a read-only integrations role
 * would be a role that can read a delivery log full of business events while
 * being trusted with nothing.
 *
 * WHAT IS NOT ON THIS SCREEN. The signing secret. It is shown once by the
 * action that mints it and can never be read back — `_lib/queries.ts` has no
 * way to fetch one. That is why the form says "copy it now" rather than the
 * screen offering a reveal button that would have to lie.
 */
export default async function WebhooksSettingsPage() {
  const [actor, context] = await Promise.all([
    requireGrant('integration.manage'),
    shellContext(),
  ])

  const lead =
    'יעדים חיצוניים שמקבלים אירועים מ-ESTIA. כל מסירה חתומה, נשלחת ל-https בלבד, ' +
    'ונמסרת לפחות פעם אחת — כלומר ייתכן שיגיע עותק כפול, ולכן יש לכל מסירה מזהה.'

  const db = await createClient()
  const screen = await loadWebhookScreen(db, actor.organizationId)

  if (screen.status === 'not_provisioned') {
    return (
      <ScreenFrame title="Webhooks" lead={lead} width="prose">
        <Panel title="המודול טרם הותקן">
          <PanelNote>
            טבלאות ה-webhooks אינן קיימות בבסיס הנתונים הזה. זו מצב התקנה, לא
            תקלה — המיגרציה 0060 טרם רצה כאן.
          </PanelNote>
        </Panel>
      </ScreenFrame>
    )
  }

  const { endpoints } = screen

  return (
    <ScreenFrame title="Webhooks" lead={lead} width="prose">
      <Panel
        title="יעדים"
        count={endpoints.length}
        description="כל יעד מקבל רק את האירועים שנבחרו לו. יעד בלי אירועים לא מקבל דבר."
      >
        {endpoints.length === 0 ? (
          <PanelNote>
            אין עדיין יעדים. הוסיפו אחד למטה — תקבלו סוד חתימה שמוצג פעם אחת
            בלבד.
          </PanelNote>
        ) : (
          <RowList>
            {endpoints.map(({ endpoint, recent, failing }) => (
              <Row key={endpoint.id} className="flex-col items-stretch gap-2">
                <FactRow label="כתובת">
                  <span dir="ltr" className="font-mono text-xs">
                    {endpoint.url}
                  </span>
                </FactRow>
                <FactRow label="מצב">
                  {WEBHOOK_ENDPOINT_STATUS_LABEL[endpoint.status]}
                </FactRow>
                {endpoint.disabledReason !== null && (
                  <PanelNote>
                    {WEBHOOK_DISABLE_REASON_LABEL[endpoint.disabledReason]}
                  </PanelNote>
                )}
                <FactRow label="אירועים">
                  {endpoint.events.length === 0
                    ? 'אין — היעד לא יקבל דבר'
                    : endpoint.events.join(' · ')}
                </FactRow>
                <FactRow label="מסירה אחרונה שהצליחה">
                  {endpoint.lastSuccessAt === null
                    ? 'טרם'
                    : endpoint.lastSuccessAt.toLocaleString('he-IL')}
                </FactRow>
                {endpoint.consecutiveFailures > 0 && (
                  <FactRow label="כשלונות רצופים">
                    {endpoint.consecutiveFailures}
                  </FactRow>
                )}
                <FactRow label="20 המסירות האחרונות">
                  {recent.length === 0
                    ? 'אין מסירות עדיין'
                    : `${recent.length} מסירות, ${failing} מהן נכשלו`}
                </FactRow>
                {recent.length > 0 && (
                  <PanelNote>
                    {recent
                      .slice(0, 3)
                      .map(
                        (delivery) =>
                          `${delivery.eventName}: ${
                            WEBHOOK_DELIVERY_STATUS_LABEL[delivery.status]
                          }${
                            delivery.lastStatusCode === null
                              ? ''
                              : ` (${delivery.lastStatusCode})`
                          }`,
                      )
                      .join(' · ')}
                  </PanelNote>
                )}
                <EndpointControls
                  endpointId={endpoint.id}
                  status={endpoint.status}
                  expectedVersion={endpoint.version}
                />
              </Row>
            ))}
          </RowList>
        )}
      </Panel>

      <Panel
        title="הוספת יעד"
        description="רק https, ורק כתובת ציבורית. כתובת שמצביעה על רשת פנימית תידחה — כאן ושוב לפני כל שליחה."
      >
        <WebhookEndpointForm />
      </Panel>

      {context?.status === 'ready' && (
        <Panel title="איך מאמתים מסירה">
          <PanelNote>
            כל בקשה נושאת כותרת <code>Estia-Signature</code> בצורה{' '}
            <code dir="ltr">t=…,v1=…</code>. חשבו HMAC-SHA256 על המחרוזת{' '}
            <code dir="ltr">{'${t}.${body}'}</code> עם סוד החתימה, והשוו בהשוואה
            בזמן קבוע. דחו בקשה שהחותמת שלה רחוקה יותר מחמש דקות מהשעון שלכם.
          </PanelNote>
        </Panel>
      )}
    </ScreenFrame>
  )
}
