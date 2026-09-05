import type { Metadata } from 'next'

import {
  ConsoleNotice,
  ConsolePage,
} from '@/components/platform/console-chrome'
import { HealthPanelCard } from '@/components/platform/health-panel'
import { loadPlatformHealth, type PlatformHealth } from '@/lib/platform'
import { toLogEntry } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'

import { requirePlatformGrant } from '../_lib/guard'

export const metadata: Metadata = { title: 'מצב המערכת · קונסולת ESTIA' }

/**
 * EXECUTION CONTEXT — SERVER COMPONENT. The console's landing page.
 *
 * ══ NOT ONE NUMBER ON THIS PAGE IS INVENTED ═══════════════════════════════
 *
 * Four panels are counted from rows: accounts, subscriptions and trials,
 * ESTIA's own actions over thirty days, and open support views. Five are not
 * connected to anything, and each of those says what is missing and why —
 * integrations, payment-provider health, the job queue, AI usage and security
 * events.
 *
 * Two of those five absences are different in kind and are worded differently
 * on purpose. Integrations, jobs and AI usage have no table in this database
 * at all: nothing is being withheld, the thing does not exist yet.
 * `payment_provider_events` and `payment_attempts` DO exist, per tenant, and
 * 0041 deliberately does not open them to platform staff — opening every
 * customer's payment traffic to answer "is the provider up" is the wrong
 * trade. A reader who is deciding where to go and look next needs to be able
 * to tell those apart.
 *
 * ── A failed read is not an empty panel ───────────────────────────────────
 *
 * `loadPlatformHealth` collects failures instead of throwing, and a panel that
 * could not be read is absent with its failure named rather than rendered with
 * zeros in it. Those are opposite statements about the business and they must
 * never look the same.
 *
 * GATING. `platform.organization.view`, which both platform roles hold. The
 * page reads nothing a support colleague may not see.
 */
export default async function PlatformHomePage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>
}) {
  await requirePlatformGrant('platform.organization.view')

  const { denied } = await searchParams
  const correlationId = crypto.randomUUID()

  let health: PlatformHealth = { panels: [], failures: [] }
  let failure: unknown = null

  try {
    health = await loadPlatformHealth(await createClient())
  } catch (error) {
    console.error(toLogEntry(error, correlationId))
    failure = error
  }

  return (
    <ConsolePage
      title="מצב המערכת"
      lede="מה שנספר משורות אמיתיות, ומה שאין לו מקור נתונים — בנפרד, ובמפורש. לוח שמציג מספר שלא נמדד גרוע מלוח שלא מציג כלום, כי מישהו יקבל לפיו החלטה."
    >
      {denied && (
        <ConsoleNotice title="המסך הזה אינו כלול בתפקיד שלך" tone="warning">
          חסרה לך ההרשאה <code dir="ltr">{denied}</code>. תפקיד תמיכה מחזיק{' '}
          <code dir="ltr">platform.organization.view</code> בלבד — צפייה
          בחשבונות, באנשים, בחבילות וביומן. השהיה, שינוי יכולות ופתיחת צפייה הם
          של מנהל-על.
        </ConsoleNotice>
      )}

      {failure !== null && (
        <ConsoleNotice title="מצב המערכת לא נטען" tone="warning">
          לא ניתן היה לקרוא את הנתונים שמאחורי הלוח. אין להסיק מכך ששום דבר לא
          קורה — פשוט לא ידוע מה קורה. מזהה מעקב:{' '}
          <code dir="ltr">{correlationId}</code>
        </ConsoleNotice>
      )}

      {health.failures.length > 0 && (
        <ConsoleNotice title="חלק מהלוחות לא נקראו" tone="warning">
          <ul className="list-inside list-disc">
            {health.failures.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <p className="mt-2">
            לוח שלא נקרא אינו מוצג כאן כלוח ריק. ההפרש בין &quot;אין מה
            לדווח&quot; לבין &quot;לא הצלחנו לקרוא&quot; הוא ההפרש שבגללו הדף
            הזה קיים.
          </p>
        </ConsoleNotice>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {health.panels.map((panel) => (
          <HealthPanelCard key={panel.key} panel={panel} />
        ))}
      </div>
    </ConsolePage>
  )
}
